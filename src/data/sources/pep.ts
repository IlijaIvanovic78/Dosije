// PEP cross-check: OpenSanctions open bulk data (Serbian persons from the "peps" collection) and the profile
// index of KRIK's politician-asset database (names + links only, nothing copied from the profiles).
//
// OpenSanctions bulk data is free for non-commercial use under CC BY-NC 4.0 (attribution required):
// https://www.opensanctions.org/licensing/. The full "peps" CSV is ~180 MB, so it is streamed once, filtered to
// country "rs", written to data/raw/ (gitignored) and reduced to a compact list under data/cache/pep/ (committed).
// Phone, e-mail and address columns are never read into the compact list.
// Notes: docs/data-sources/legal.md

import fs from "node:fs"
import path from "node:path"
import { Readable } from "node:stream"
import { parse } from "csv-parse"
import { SRC, trackActivity } from "../activity"
import { cached, cacheKey } from "../cache"
import { getJson, getText, USER_AGENT } from "../http"
import { asciiFold } from "../translit"
import type { PepMatch } from "../types"

const SOURCE = "pep"
const OS_INDEX = "https://data.opensanctions.org/datasets/latest/peps/index.json"
const OS_ENTITY_URL = (id: string) => `https://www.opensanctions.org/entities/${id}/`
const KRIK_ROOT = "https://imovinapoliticara.krik.rs/"
const RAW_DIR = path.resolve(process.cwd(), "data", "raw")
const MIN_SCORE = 0.85

interface OsEntry {
	id: string
	name: string
	aliases: string[]
	birthYear?: string
	datasets: string[]
}

interface OsList {
	version: string
	total: number // Serbian persons found
	entries: OsEntry[]
}

interface KrikProfile {
	slugName: string // ASCII name from the profile URL, e.g. "Aleksandar Sapic"
	label: string // as shown on the index page, e.g. "Adrijana Mesarović Srpska napredna stranka"
	url: string
}

async function downloadOpenSanctionsRs(): Promise<OsList> {
	const index = await getJson<{ version: string; resources: { name: string; url: string }[] }>(OS_INDEX)
	const csv = index.resources.find((r) => r.name === "targets.simple.csv")
	if (!csv) throw new Error("OpenSanctions peps index has no targets.simple.csv")
	const res = await fetch(csv.url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(15 * 60_000) })
	if (!res.ok || !res.body) throw new Error(`OpenSanctions download failed: HTTP ${res.status}`)

	fs.mkdirSync(RAW_DIR, { recursive: true })
	const rawFile = fs.createWriteStream(path.join(RAW_DIR, "opensanctions-peps-rs.csv"), "utf8")
	rawFile.write("id,schema,name,aliases,birth_date,countries,dataset\n")
	const q = (s: string) => `"${s.replace(/"/g, '""')}"`

	const entries: OsEntry[] = []
	const parser = Readable.fromWeb(res.body as never).pipe(parse({ columns: true, relax_quotes: true, relax_column_count: true, skip_empty_lines: true }))
	for await (const row of parser as AsyncIterable<Record<string, string>>) {
		if (row.schema !== "Person") continue
		if (!(row.countries ?? "").split(";").includes("rs")) continue
		const aliases = (row.aliases ?? "").split(";").map((a) => a.trim()).filter(Boolean)
		const datasets = (row.dataset ?? "").split(";").map((d) => d.trim()).filter(Boolean)
		rawFile.write([row.id, row.schema, row.name, row.aliases, row.birth_date, row.countries, row.dataset].map((v) => q(v ?? "")).join(",") + "\n")
		entries.push({
			id: row.id,
			name: row.name,
			aliases: aliases.slice(0, 6),
			birthYear: /^\d{4}/.test(row.birth_date ?? "") ? row.birth_date.slice(0, 4) : undefined,
			datasets,
		})
	}
	await new Promise<void>((resolve) => rawFile.end(resolve))
	return { version: index.version, total: entries.length, entries }
}

async function downloadKrikIndex(): Promise<KrikProfile[]> {
	const html = await getText(KRIK_ROOT)
	const out: KrikProfile[] = []
	const seen = new Set<string>()
	for (const m of html.matchAll(/<a href="(profil\.php\?id=(\d+)&(?:amp;)?ime=([^"&]+))">([\s\S]*?)<\/a>/g)) {
		if (seen.has(m[2])) continue
		seen.add(m[2])
		const label = /id="ime"[^>]*>\s*([^<]*?)\s*</.exec(m[4])?.[1] ?? ""
		out.push({
			slugName: decodeURIComponent(m[3]).replace(/[-_]+/g, " ").trim(),
			label: label.replace(/\s+/g, " "),
			url: KRIK_ROOT + m[1].replace(/&amp;/g, "&"),
		})
	}
	return out
}

let osMemo: Promise<OsList> | undefined
let krikMemo: Promise<KrikProfile[]> | undefined

// what the bulk lists cost: a download counts as live for the call that waited for it (see matchPep)
const lists = { downloads: 0, at: undefined as string | undefined }

function osList(): Promise<OsList> {
	osMemo ??= cached(SOURCE, cacheKey("opensanctions", "rs"), downloadOpenSanctionsRs, {
		activity: { ...SRC.pep, action: "preuzimanje", label: "OpenSanctions: lista PEP za Srbiju", url: "https://www.opensanctions.org/datasets/peps/" },
	}).then((e) => {
		if (!e.fromCache) lists.downloads++
		lists.at = !lists.at || e.retrievedAt > lists.at ? e.retrievedAt : lists.at
		return e.data
	})
	return osMemo
}

function krikList(): Promise<KrikProfile[]> {
	krikMemo ??= cached(SOURCE, cacheKey("krik", "profiles"), downloadKrikIndex, {
		activity: { ...SRC.pep, action: "preuzimanje", label: "KRIK: spisak profila političara", url: KRIK_ROOT },
	}).then((e) => {
		if (!e.fromCache) lists.downloads++
		lists.at = !lists.at || e.retrievedAt > lists.at ? e.retrievedAt : lists.at
		return e.data
	})
	return krikMemo
}

function tokens(s: string): string[] {
	return asciiFold(s)
		.split(/[^a-z0-9]+/)
		.filter(Boolean)
}

/** 1 = same words in any order; 0.9 = same first and last word with extra middle names; otherwise 0. */
function nameScore(query: string[], candidate: string[]): number {
	if (query.length < 2 || candidate.length < 2) return 0
	const a = new Set(query)
	const b = new Set(candidate)
	if (a.size === b.size && [...a].every((t) => b.has(t))) return 1
	const [qf, ql] = [query[0], query[query.length - 1]]
	const [cf, cl] = [candidate[0], candidate[candidate.length - 1]]
	if ((qf === cf && ql === cl) || (qf === cl && ql === cf)) return 0.9
	return 0
}

export function matchPep(fullName: string): Promise<PepMatch[]> {
	const url = `https://www.opensanctions.org/search/?q=${encodeURIComponent(fullName.trim())}&scope=peps`
	return trackActivity({ ...SRC.pep, action: "pretraga", label: `PEP liste: ${fullName.trim()}`, url }, async (h) => {
		const before = lists.downloads
		const matches = await matchPepLists(fullName)
		if (lists.downloads === before) h.cached(lists.at)
		h.items(matches.length)
		return matches
	})
}

async function matchPepLists(fullName: string): Promise<PepMatch[]> {
	const q = tokens(fullName)
	if (q.length < 2) return []
	const [os, krik] = await Promise.all([osList(), krikList()])
	const matches: PepMatch[] = []

	for (const e of os.entries) {
		let best = 0
		for (const n of [e.name, ...e.aliases]) best = Math.max(best, nameScore(q, tokens(n)))
		if (best < MIN_SCORE) continue
		const datasets = e.datasets.join("; ")
		matches.push({
			name: e.name,
			dataset: "opensanctions",
			detail: `Srpski PEP prema OpenSanctions${e.birthYear ? ` (rođen/a ${e.birthYear}.)` : ""}; izvori: ${datasets || "nepoznato"}. Podudaranje samo po imenu: proveriti identitet.`,
			url: OS_ENTITY_URL(e.id),
			score: best,
			source: {
				kind: "opensanctions",
				title: `OpenSanctions – Politically Exposed Persons: ${e.name}`,
				url: OS_ENTITY_URL(e.id),
				retrievedAt: new Date().toISOString(),
				official: false,
			},
		})
	}

	for (const p of krik) {
		const best = nameScore(q, tokens(p.slugName))
		if (best < MIN_SCORE) continue
		matches.push({
			name: p.slugName,
			dataset: "krik",
			detail: `Profil u KRIK bazi imovine političara${p.label ? `: ${p.label}` : ""}. Podudaranje samo po imenu: proveriti identitet.`,
			url: p.url,
			score: best,
			source: {
				kind: "krik",
				title: "KRIK – Baza imovine političara",
				url: p.url,
				retrievedAt: new Date().toISOString(),
				official: false,
			},
		})
	}

	return matches.sort((a, b) => b.score - a.score).slice(0, 10)
}
