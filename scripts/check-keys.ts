// Verifies the provider keys in .env with one minimal real request each. Never prints a key.
// Usage: npm run check-keys

import "dotenv/config"

type Result = { name: string; ok: boolean; detail: string }

async function timed<T>(fn: () => Promise<T>): Promise<{ value?: T; ms: number; error?: string }> {
	const t0 = Date.now()
	try {
		return { value: await fn(), ms: Date.now() - t0 }
	} catch (err) {
		return { ms: Date.now() - t0, error: err instanceof Error ? err.message : String(err) }
	}
}

async function checkOpenAI(model: string): Promise<Result> {
	const key = process.env.OPENAI_API_KEY
	if (!key) return { name: `OpenAI (${model})`, ok: false, detail: "nema ključa" }
	const r = await timed(async () => {
		const res = await fetch("https://api.openai.com/v1/responses", {
			method: "POST",
			headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
			body: JSON.stringify({ model, input: "Odgovori jednom rečju: radi?", max_output_tokens: 16, reasoning: { effort: "low" } }),
			signal: AbortSignal.timeout(30_000),
		})
		const body = (await res.json()) as { error?: { message?: string }; usage?: { total_tokens?: number } }
		if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.error?.message ?? "greška"}`)
		return body.usage?.total_tokens ?? 0
	})
	return r.error
		? { name: `OpenAI (${model})`, ok: false, detail: r.error.slice(0, 160) }
		: { name: `OpenAI (${model})`, ok: true, detail: `${r.ms} ms, ${r.value} tokena` }
}

async function checkSerper(): Promise<Result> {
	const key = process.env.SERPER_API_KEY
	if (!key) return { name: "Serper.dev", ok: false, detail: "nema ključa (opciono)" }
	const r = await timed(async () => {
		const res = await fetch("https://google.serper.dev/news", {
			method: "POST",
			headers: { "X-API-KEY": key, "Content-Type": "application/json" },
			body: JSON.stringify({ q: "Infrastruktura železnice Srbije", gl: "rs", hl: "sr", num: 5 }),
			signal: AbortSignal.timeout(20_000),
		})
		const body = (await res.json()) as { news?: unknown[]; message?: string }
		if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.message ?? "greška"}`)
		return body.news?.length ?? 0
	})
	return r.error ? { name: "Serper.dev", ok: false, detail: r.error.slice(0, 160) } : { name: "Serper.dev", ok: true, detail: `${r.ms} ms, ${r.value} vesti` }
}

async function checkBrave(): Promise<Result> {
	const key = process.env.BRAVE_API_KEY
	if (!key) return { name: "Brave Search", ok: false, detail: "nema ključa (opciono)" }
	const r = await timed(async () => {
		// Brave has no "rs" country code (422); Serbian results come from the query and search_lang
		const url = `https://api.search.brave.com/res/v1/news/search?${new URLSearchParams({ q: "Infrastruktura železnice Srbije", search_lang: "sr", count: "5" })}`
		const res = await fetch(url, { headers: { "X-Subscription-Token": key, Accept: "application/json" }, signal: AbortSignal.timeout(20_000) })
		const body = (await res.json()) as { results?: unknown[]; error?: { detail?: string } }
		if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.error?.detail ?? "greška"}`)
		return body.results?.length ?? 0
	})
	return r.error ? { name: "Brave Search", ok: false, detail: r.error.slice(0, 160) } : { name: "Brave Search", ok: true, detail: `${r.ms} ms, ${r.value} vesti` }
}

const worker = process.env.DOSIJE_MODEL || "gpt-5.4-mini"
const editor = process.env.DOSIJE_EDITOR_MODEL || "gpt-5.4"
const results = await Promise.all([checkOpenAI(worker), ...(editor !== worker ? [checkOpenAI(editor)] : []), checkSerper(), checkBrave()])
for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.name.padEnd(26)} ${r.detail}`)
process.exit(results.some((r) => !r.ok && !r.detail.includes("opciono")) ? 1 : 0)
