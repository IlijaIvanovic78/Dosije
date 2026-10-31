// Serbian -> English for everything the server writes (findings, agent messages, the summary, map reasons, the report):
// the agents and rules work in Serbian, and the English page shows a machine translation made with the same LLM key
// (the worker model). Batched, deduplicated and cached in memory for the life of the process. Without a key the text
// stays Serbian (translationAvailable() is false).

import { config } from "./config"
import { logError } from "./mozaik/util"

const MAX_BATCH_ITEMS = 40
const MAX_BATCH_CHARS = 7000
const PARALLEL = 6
const TIMEOUT_MS = 60_000
const CACHE_MAX = 20_000

const cache = new Map<string, string>()
const inflight = new Map<string, Promise<string>>()

const PROMPT = `You translate an investigative-journalism tool from Serbian to English.
Translate every string of the JSON array "texts" from Serbian (Latin or Cyrillic) to natural, neutral English.
Rules: keep names of people, companies, institutions and media outlets exactly as written (do not translate or transliterate them);
keep numbers, dates, amounts, currency (RSD), percentages, URLs, e-mail-like strings, Markdown syntax, emoji and {placeholders} unchanged;
translate legal and register terms the usual way (v.d. = acting, "vršilac dužnosti" = acting head, "javna nabavka" = public procurement,
"Državna revizorska institucija" = State Audit Institution, "nepotvrđeno" = unconfirmed, "zvanično" = official);
the tool's agents are named: Kadrovik = Personnel, Nabavke = Procurement, Revizor = Auditor, Mediji = Media, Urednik = Editor,
Novinar/Novinarka = Journalist, Firme = Companies, Imovina = Assets, Provera = Check, Trijaža = Triage, Fabrika = Factory;
a string that is already English or has nothing to translate is returned unchanged.
Answer with JSON only: {"texts": [...]} with exactly the same number of items in the same order.`

export function translationAvailable(): boolean {
	return config.provider !== "none"
}

function needsTranslation(s: string): boolean {
	return /[A-Za-zА-Яа-яčćšžđČĆŠŽĐ]{2}/.test(s)
}

/** Serbian strings -> English, same order. A string that cannot be translated comes back unchanged. */
export async function translateTexts(texts: string[]): Promise<string[]> {
	if (!translationAvailable()) return texts
	const todo = [...new Set(texts.filter((s) => needsTranslation(s) && !cache.has(s) && !inflight.has(s)))]
	const batches: string[][] = []
	let cur: string[] = []
	let chars = 0
	for (const s of todo) {
		if (cur.length && (cur.length >= MAX_BATCH_ITEMS || chars + s.length > MAX_BATCH_CHARS)) {
			batches.push(cur)
			cur = []
			chars = 0
		}
		cur.push(s)
		chars += s.length
	}
	if (cur.length) batches.push(cur)
	for (const batch of batches) {
		const job = runLimited(() => translateBatch(batch))
		batch.forEach((s, i) =>
			inflight.set(
				s,
				job.then((out) => out[i] ?? s).finally(() => inflight.delete(s)),
			),
		)
	}
	return Promise.all(texts.map(async (s) => (needsTranslation(s) ? cache.get(s) ?? (await inflight.get(s)) ?? s : s)))
}

let running = 0
const waiting: (() => void)[] = []

async function runLimited<T>(fn: () => Promise<T>): Promise<T> {
	if (running >= PARALLEL) await new Promise<void>((r) => waiting.push(r))
	running++
	try {
		return await fn()
	} finally {
		running--
		waiting.shift()?.()
	}
}

async function translateBatch(batch: string[]): Promise<string[]> {
	try {
		const out = await callModel(batch)
		if (out.length !== batch.length) throw new Error(`model returned ${out.length} of ${batch.length} strings`)
		if (cache.size > CACHE_MAX) cache.clear()
		batch.forEach((s, i) => cache.set(s, typeof out[i] === "string" && out[i].trim() ? out[i] : s))
		return batch.map((s) => cache.get(s) ?? s)
	} catch (err) {
		// not cached: the next request for the same text tries again
		logError("prevod", err)
		return batch
	}
}

function parseTexts(raw: string): string[] {
	const json = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)
	const parsed = JSON.parse(json) as { texts?: unknown }
	return Array.isArray(parsed.texts) ? parsed.texts.map((x) => (typeof x === "string" ? x : String(x ?? ""))) : []
}

async function post(url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
	const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) })
	const text = await res.text()
	if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
	return JSON.parse(text)
}

async function callModel(batch: string[]): Promise<string[]> {
	const user = JSON.stringify({ texts: batch })
	if (config.provider === "openai") {
		const body: Record<string, unknown> = {
			model: config.model,
			messages: [
				{ role: "system", content: PROMPT },
				{ role: "user", content: user },
			],
			response_format: { type: "json_object" },
		}
		if (/^(gpt-5|o\d)/.test(config.model)) body.reasoning_effort = "low"
		const r = (await post("https://api.openai.com/v1/chat/completions", { authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body)) as { choices?: { message?: { content?: string } }[] }
		return parseTexts(r.choices?.[0]?.message?.content ?? "")
	}
	if (config.provider === "anthropic") {
		const r = (await post(
			"https://api.anthropic.com/v1/messages",
			{ "x-api-key": process.env.ANTHROPIC_API_KEY ?? "", "anthropic-version": "2023-06-01" },
			{ model: config.model, max_tokens: 8000, system: PROMPT, messages: [{ role: "user", content: user }] },
		)) as { content?: { type: string; text?: string }[] }
		return parseTexts(r.content?.find((c) => c.type === "text")?.text ?? "")
	}
	const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || ""
	const r = (await post(
		`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:generateContent`,
		{ "x-goog-api-key": key },
		{ systemInstruction: { parts: [{ text: PROMPT }] }, contents: [{ role: "user", parts: [{ text: user }] }], generationConfig: { responseMimeType: "application/json" } },
	)) as { candidates?: { content?: { parts?: { text?: string }[] } }[] }
	return parseTexts(r.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "")
}

const reports = new Map<string, Promise<string>>()

/**
 * A Markdown document (the report), line by line. The heading / list / quote marker stays out of the text sent to the model,
 * so a finding's title and text are the same strings the page already translated (cache hits).
 */
export function translateMarkdown(md: string): Promise<string> {
	let job = reports.get(md)
	if (!job) {
		job = (async () => {
			const lines = md.split("\n")
			const parts = lines.map((l) => /^(\s*(?:#{1,6}\s+|[-*]\s+|\d+\.\s+|>\s*)?)(.*)$/.exec(l) as RegExpExecArray)
			const idx = lines.map((l, i) => (needsTranslation(parts[i][2]) && !/^\s*\|?[\s:|-]+\|?\s*$/.test(l) ? i : -1)).filter((i) => i >= 0)
			const out = await translateTexts(idx.map((i) => parts[i][2]))
			idx.forEach((li, k) => (lines[li] = parts[li][1] + out[k]))
			return lines.join("\n")
		})()
		if (reports.size > 20) reports.clear()
		reports.set(md, job)
		job.catch(() => reports.delete(md))
	}
	return job
}
