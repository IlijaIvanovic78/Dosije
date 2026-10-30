// APR (Agencija za privredne registre) open data: company profile by matični broj or by name.
// Data comes from data/static/apr-index.json.gz, built by scripts/build-apr-index.ts from the two public
// datasets on data.gov.rs (companies + financial statements). The index is committed, so lookups work
// offline for any company. APR exposes no per-company endpoint, so there is no live fallback.

import fs from "node:fs/promises"
import path from "node:path"
import zlib from "node:zlib"
import type { SourceRef } from "../../shared/types"
import type { CompanyProfile } from "../types"
import { nameSimilarity } from "../translit"
import { aprNormalize } from "./aprNames"

export const APR_INDEX_FILE = path.resolve(process.cwd(), "data", "static", "apr-index.json.gz")

const COMPANIES_PAGE = "https://data.gov.rs/sr/datasets/api-za-registar-privrednikh-drushtava/"
const FINANCIALS_PAGE = "https://data.gov.rs/sr/datasets/api-za-registar-finansijskikh-izveshtaja-baza-fi-za-privredna-drushtva/"
const MIN_SIMILARITY = 0.8

type Row = [
	name: string,
	founded: string,
	municipalityIdx: number,
	activityCode: string,
	legalFormIdx: number,
	statusIdx: number,
	revenueRsd: number | null,
	revenueYear: number | null,
	employees: number | null,
]

interface RawIndex {
	companiesDate: string
	financialsDate: string
	municipalities: string[]
	legalForms: string[]
	statuses: string[]
	rows: Record<string, Row>
	names: Record<string, string | string[]>
}

interface Loaded {
	raw: RawIndex
	keys: string[]
	keyTokens: string[][]
	postings?: Map<string, number[]>
}

let loading: Promise<Loaded | null> | undefined

function loadIndex(): Promise<Loaded | null> {
	loading ??= (async () => {
		try {
			const buf = await fs.readFile(APR_INDEX_FILE)
			const raw = JSON.parse(zlib.gunzipSync(buf).toString("utf8")) as RawIndex
			const keys = Object.keys(raw.names)
			return { raw, keys, keyTokens: keys.map((k) => k.split(" ")) }
		} catch (err) {
			console.warn(`[apr] index not available (${APR_INDEX_FILE}): run "npx.cmd tsx scripts/build-apr-index.ts". ${(err as Error).message}`)
			return null
		}
	})()
	return loading
}

function postingsOf(idx: Loaded): Map<string, number[]> {
	if (!idx.postings) {
		const postings = new Map<string, number[]>()
		idx.keyTokens.forEach((tokens, i) => {
			for (const t of new Set(tokens)) {
				const list = postings.get(t)
				if (list) list.push(i)
				else postings.set(t, [i])
			}
		})
		idx.postings = postings
	}
	return idx.postings
}

function normalizeMb(mb: string): string | null {
	const digits = mb.replace(/\s+/g, "")
	return /^\d{1,8}$/.test(digits) ? digits.padStart(8, "0") : null
}

function isActive(idx: Loaded, row: Row): boolean {
	return idx.raw.statuses[row[5]] === "Aktivan"
}

function toProfile(idx: Loaded, mb: string): CompanyProfile | null {
	const row = idx.raw.rows[mb]
	if (!row) return null
	const [name, founded, munIdx, activityCode, formIdx, statusIdx, revenueRsd, revenueYear, employees] = row
	const hasFinancials = revenueRsd !== null || employees !== null
	const date = hasFinancials ? idx.raw.financialsDate : idx.raw.companiesDate
	const source: SourceRef = {
		kind: "apr",
		title: `APR – otvoreni podaci: ${name} (MB ${mb}, presek ${date})`,
		url: hasFinancials ? FINANCIALS_PAGE : COMPANIES_PAGE,
		retrievedAt: `${date}T00:00:00.000Z`,
		publishedAt: date,
		official: true,
	}
	const profile: CompanyProfile = { mb, name, source }
	if (founded) profile.founded = founded
	if (munIdx >= 0) profile.municipality = idx.raw.municipalities[munIdx]
	if (activityCode) profile.activityCode = activityCode
	if (formIdx >= 0) profile.legalForm = idx.raw.legalForms[formIdx]
	if (statusIdx >= 0) profile.status = idx.raw.statuses[statusIdx]
	if (revenueRsd !== null) profile.revenueRsd = revenueRsd
	if (revenueRsd !== null && revenueYear !== null) profile.revenueYear = revenueYear
	if (employees !== null) profile.employees = employees
	return profile
}

interface Candidate {
	mb: string
	score: number
	active: boolean
	formOk: boolean
}

/** Legal form the user wrote in the query ("a.d.", "d.o.o.", "JP"), as it appears in the register. */
function legalFormHint(name: string): string | null {
	if (/(^|\s)a\s?\.?\s?d\.?(\s|$)|akcionarsko|акционарско/i.test(name)) return "Akcionarsko društvo"
	if (/d\s?\.?\s?o\s?\.?\s?o\.?(\s|$)|sa ograni[čc]enom|са ограниченом/i.test(name)) return "Društvo sa ograničenom odgovornošću"
	if (/(^|\s)j\s?\.?\s?p\.?(\s|$)|javno preduze[ćc]e|јавно предузеће/i.test(name)) return "Javno preduzeće"
	return null
}

function makeCandidate(idx: Loaded, mb: string, score: number, hint: string | null): Candidate {
	const row = idx.raw.rows[mb]
	return { mb, score, active: isActive(idx, row), formOk: !hint || idx.raw.legalForms[row[4]] === hint }
}

function mbsOfKey(idx: Loaded, keyIdx: number): string[] {
	const v = idx.raw.names[idx.keys[keyIdx]]
	return Array.isArray(v) ? v : [v]
}

/** Best candidate only if it is clearly ahead: no other company with the same score and activity status. */
function pickClear(cands: Candidate[], margin = 0): Candidate | null {
	if (cands.length === 0) return null
	cands.sort((a, b) => b.score - a.score || Number(b.active) - Number(a.active) || Number(b.formOk) - Number(a.formOk))
	const [top, second] = cands
	if (!second) return top
	if (top.score > second.score * (1 + margin)) return top
	if (top.score === second.score && (top.active !== second.active || top.formOk !== second.formOk)) return top
	return null
}

function rareTokens(idx: Loaded, tokens: string[], n: number): string[] {
	const postings = postingsOf(idx)
	return [...new Set(tokens)].sort((a, b) => (postings.get(a)?.length ?? 0) - (postings.get(b)?.length ?? 0)).slice(0, n)
}

function findByName(idx: Loaded, name: string, lenient: boolean): string | null {
	const qn = aprNormalize(name)
	if (!qn) return null
	const hint = legalFormHint(name)
	const qTokens = qn.split(" ")
	const qSet = new Set(qTokens)

	// 1) exact normalized match
	const exact = idx.raw.names[qn]
	if (exact !== undefined) {
		const mbs = Array.isArray(exact) ? exact : [exact]
		return pickClear(mbs.map((mb) => makeCandidate(idx, mb, 1, hint)))?.mb ?? null
	}

	// 2) token-set similarity >= 0.8 (the two rarest query tokens cover every possible >= 0.8 match)
	const postings = postingsOf(idx)
	const probe = rareTokens(idx, qTokens, 2).filter((t) => postings.has(t))
	if (probe.length === 0) return null
	const keyIdxs = new Set<number>()
	for (const t of probe) for (const i of postings.get(t)!) keyIdxs.add(i)

	const pre: { i: number; sim: number }[] = []
	for (const i of keyIdxs) {
		const ct = new Set(idx.keyTokens[i])
		let inter = 0
		for (const t of ct) if (qSet.has(t)) inter++
		const sim = inter / Math.max(qSet.size, ct.size)
		if (sim >= MIN_SIMILARITY) pre.push({ i, sim })
	}
	pre.sort((a, b) => b.sim - a.sim)
	const cands: Candidate[] = []
	for (const { i } of pre.slice(0, 30)) {
		const score = nameSimilarity(qn, idx.keys[i])
		if (score < MIN_SIMILARITY) continue
		for (const mb of mbsOfKey(idx, i)) cands.push(makeCandidate(idx, mb, score, hint))
	}
	const clear = pickClear(cands)
	if (clear) return clear.mb
	if (cands.length > 0 || !lenient || qSet.size < 2) return null

	// 3) lenient (institution lookup): official names are often longer than what people type
	//    ("Telekom Srbija" vs "Preduzeće za telekomunikacije Telekom Srbija ..."). The query must appear
	//    as a contiguous phrase in the company name, only active companies with the legal form the user
	//    wrote (if any), and the shortest name must be clearly ahead of the runner-up.
	const rare = rareTokens(idx, qTokens, 1)[0]
	const contain: Candidate[] = []
	for (const i of postings.get(rare) ?? []) {
		if (!` ${idx.keys[i]} `.includes(` ${qn} `)) continue
		for (const mb of mbsOfKey(idx, i)) {
			const c = makeCandidate(idx, mb, qSet.size / new Set(idx.keyTokens[i]).size, hint)
			if (c.active && c.formOk) contain.push(c)
		}
	}
	return pickClear(contain, 0.25)?.mb ?? null
}

/**
 * Company profile from the APR open data. By `mb` directly; by `name` only on a clear best match
 * (token similarity >= 0.8). A PIB alone returns null: the open data has no PIB and there is no legal
 * PIB -> MB mapping.
 */
export async function getCompany(q: { mb?: string; pib?: string; name?: string }): Promise<CompanyProfile | null> {
	const idx = await loadIndex()
	if (!idx) return null
	if (q.mb) {
		const mb = normalizeMb(q.mb)
		const profile = mb ? toProfile(idx, mb) : null
		if (profile) return profile
	}
	if (q.name) {
		const mb = findByName(idx, q.name, false)
		return mb ? toProfile(idx, mb) : null
	}
	return null
}

export interface CompanyCandidate {
	profile: CompanyProfile
	score: number // 0..1.1, higher is better
	match: "exact" | "contains" | "similar"
}

/**
 * Ranked name candidates for a company name (several companies can share a name; the caller decides).
 * Ranking: normalized-name equality, then "every query token is in the name", then token similarity >= 0.6.
 * Small tie-breaks: same municipality as `opts.municipality`, active status.
 */
export async function searchCompanies(name: string, limit = 5, opts: { municipality?: string } = {}): Promise<CompanyCandidate[]> {
	const idx = await loadIndex()
	if (!idx) return []
	const qn = aprNormalize(name)
	if (!qn) return []
	const qTokens = qn.split(" ")
	const qSet = new Set(qTokens)
	const hint = legalFormHint(name)
	const wantMun = opts.municipality ? aprNormalize(opts.municipality) : ""

	const scored = new Map<string, CompanyCandidate>()
	const add = (mb: string, base: number, match: CompanyCandidate["match"]) => {
		const row = idx.raw.rows[mb]
		if (!row) return
		const profile = toProfile(idx, mb)
		if (!profile) return
		let score = base
		if (isActive(idx, row)) score += 0.01
		if (hint && idx.raw.legalForms[row[4]] === hint) score += 0.01
		if (wantMun && profile.municipality && aprNormalize(profile.municipality) === wantMun) score += 0.02
		const prev = scored.get(mb)
		if (!prev || prev.score < score) scored.set(mb, { profile, score, match })
	}

	const exact = idx.raw.names[qn]
	if (exact !== undefined) for (const mb of Array.isArray(exact) ? exact : [exact]) add(mb, 1, "exact")

	const postings = postingsOf(idx)
	const probe = rareTokens(idx, qTokens, 2).filter((t) => postings.has(t))
	const keyIdxs = new Set<number>()
	for (const t of probe) for (const i of (postings.get(t) ?? []).slice(0, 4000)) keyIdxs.add(i)
	for (const i of keyIdxs) {
		const ct = new Set(idx.keyTokens[i])
		let inter = 0
		for (const t of qSet) if (ct.has(t)) inter++
		const sim = inter / Math.max(qSet.size, ct.size)
		const containsAll = inter === qSet.size
		if (!containsAll && sim < 0.6) continue
		const base = containsAll ? 0.7 + 0.25 * sim : sim * 0.9
		for (const mb of mbsOfKey(idx, i)) add(mb, base, containsAll ? "contains" : "similar")
	}
	return [...scored.values()].sort((a, b) => b.score - a.score).slice(0, Math.max(1, limit))
}

/** Like getCompany by name, but also accepts a shorter name contained in the official one (active companies only). */
export async function findInstitutionCompany(name: string): Promise<CompanyProfile | null> {
	const idx = await loadIndex()
	if (!idx) return null
	const mb = findByName(idx, name, true)
	return mb ? toProfile(idx, mb) : null
}
