// ACAS (Agencija za sprečavanje korupcije): public register of officials and asset reports.
//
// The register UI (https://publicacas.acas.rs, an Angular SPA) talks to an unauthenticated JSON API under
// https://publicacas.acas.rs/acasPublicNew. Search values must be Cyrillic. The raw responses contain
// officials' phone numbers, e-mails, schooling and (in asset reports) addresses: every mapper below picks
// fields explicitly, so none of that ever reaches the return values or the cache.
// Endpoint notes: docs/data-sources/acas.md

import { n } from "../../shared/plural"
import { SRC, shortInstitution } from "../activity"
import { cached, cacheKey } from "../cache"
import { getJson } from "../http"
import { asciiFold, cyrToLat, latToCyr, nameSimilarity } from "../translit"
import type { SourceRef } from "../../shared/types"
import type { AssetReport, Official } from "../types"

const SOURCE = "acas"
const API = "https://publicacas.acas.rs/acasPublicNew"
const REGISTER_URL = "https://publicacas.acas.rs/#/acas/funkcioner"
const reportUrl = (reportId: number | string) => `https://publicacas.acas.rs/#/acas/funkcionerIzvestajDetails/${reportId}`

const MAX_OFFICIALS = 300
const MAX_REPORTS_WITH_DETAILS = 3

interface SearchPage<T> {
	results?: T[]
	total?: number
}

interface RawOrganization {
	id: number
	naziv: string
}

interface RawFunction {
	id: number
	organizacijaId: number
	organizacijaNaziv: string
	funkcijaNaziv: string
	funkcionerId: number
	funkcionerIme: string
	funkcionerPrezime: string
	datumStupanja: number | null
	datumPrestanka: number | null
	organizacijaImenovanjaNaziv: string | null
}

interface RawReport {
	id: number
	tipPrijavljivanja?: string | null
	datumPodnosenja?: string | null
	datumPodnosenjaDate?: number | null
	zasticenOdObjavljivanja?: boolean | null
}

type RawRow = Record<string, unknown>

async function api<T>(path: string, params: Record<string, string | number | boolean>): Promise<T> {
	const url = new URL(API + path)
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))
	return getJson<T>(url.toString(), { headers: { Accept: "application/json" } })
}

const belgradeDate = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Belgrade", year: "numeric", month: "2-digit", day: "2-digit" })

function isoDate(ms: number | null | undefined): string | undefined {
	if (ms === null || ms === undefined || !Number.isFinite(ms)) return undefined
	return belgradeDate.format(new Date(ms))
}

function str(v: unknown): string {
	return typeof v === "string" ? v.replace(/\s+/g, " ").trim() : typeof v === "number" ? String(v) : ""
}

/** ACAS stores some names in ALL CAPS; make them readable. Mixed-case names are kept as they are. */
function tidyName(s: string): string {
	const t = s.replace(/\s+/g, " ").trim()
	if (!t || t !== t.toUpperCase() || t === t.toLowerCase()) return t
	return t.toLowerCase().replace(/(^|[\s\-(])(\p{L})/gu, (_m, p: string, c: string) => p + c.toUpperCase())
}

/** cyrToLat, but ALL-CAPS Cyrillic words keep upper-case digraphs (ЊЕ -> NJE, not NjE). */
function latin(s: string): string {
	return s.replace(/[\u0400-\u04FF]+/g, (w) => {
		const l = cyrToLat(w)
		return w.length > 1 && w === w.toUpperCase() ? l.toUpperCase() : l
	})
}

function positionLatin(cyr: string): string {
	const l = latin(cyr).trim().toLowerCase()
	return isActingTitle(cyr) ? l : l.charAt(0).toUpperCase() + l.slice(1)
}

function isActingTitle(position: string): boolean {
	return /(^|[\s,(])[вv]\.?\s?[дd]\.?(?=[\s,)]|$)|вршилац\s+дужности|vršilac\s+dužnosti/i.test(position)
}

function toOfficial(f: RawFunction): Official {
	const cyrName = tidyName(`${str(f.funkcionerIme)} ${str(f.funkcionerPrezime)}`)
	const position = str(f.funkcijaNaziv)
	const from = isoDate(f.datumStupanja)
	const appointer = str(f.organizacijaImenovanjaNaziv)
	const institution = str(f.organizacijaNaziv)
	const source: SourceRef = {
		kind: "acas",
		title: `ACAS – Registar funkcionera: ${latin(institution)}`,
		url: REGISTER_URL,
		retrievedAt: new Date().toISOString(),
		publishedAt: from,
		official: true,
	}
	return {
		id: String(f.funkcionerId),
		fullName: latin(cyrName),
		fullNameCyr: cyrName,
		position: positionLatin(position),
		positionCyr: position,
		isActing: isActingTitle(position),
		institutionName: latin(institution),
		from,
		to: isoDate(f.datumPrestanka),
		appointedBy: appointer ? latin(appointer) : undefined,
		source,
	}
}

// ─── Institutions ───────────────────────────────────────────────────────────

const ORG_NOISE = /^(а\.?д\.?|ј\.?п\.?|д\.?о\.?о\.?|београд|нови|сад|ниш|крагујевац)$/iu

function institutionQueries(nameCyr: string): string[] {
	const full = nameCyr.replace(/\s+/g, " ").trim()
	const tokens = full.split(" ").filter((t) => !ORG_NOISE.test(t))
	const queries = [full, tokens.join(" ")]
	for (let n = tokens.length - 1; n >= 2 && queries.length < 5; n--) queries.push(tokens.slice(0, n).join(" "))
	return [...new Set(queries.filter(Boolean))]
}

export async function findInstitution(name: string): Promise<{ id: string; name: string; nameCyr: string; source: SourceRef }[]> {
	const nameCyr = latToCyr(name).replace(/\s+/g, " ").trim()
	if (!nameCyr) return []
	const env = await cached(SOURCE, cacheKey("institution", nameCyr), async () => {
		let found: RawOrganization[] = []
		for (const q of institutionQueries(nameCyr)) {
			const page = await api<SearchPage<RawOrganization>>("/organizacija/search", { page: 1, limit: 20, naziv: q })
			if (page.results?.length) {
				found = page.results
				break
			}
		}
		const retrievedAt = new Date().toISOString()
		return found
			.map((o) => ({
				id: String(o.id),
				name: latin(str(o.naziv)),
				nameCyr: str(o.naziv),
				score: nameSimilarity(nameCyr, str(o.naziv)),
			}))
			.sort((a, b) => b.score - a.score)
			.map(({ score: _score, ...o }) => ({
				...o,
				source: {
					kind: "acas" as const,
					title: `ACAS – Registar funkcionera: ${o.name}`,
					url: REGISTER_URL,
					retrievedAt,
					official: true,
				},
			}))
	}, { activity: { ...SRC.acas, action: "pretraga", label: `pretraga ustanove: ${name}`, url: REGISTER_URL, after: (d, h) => h.items(d.length) } })
	return env.data
}

// ─── Officials ──────────────────────────────────────────────────────────────

async function functionsBy(params: Record<string, string | number | boolean>, limit = MAX_OFFICIALS): Promise<RawFunction[]> {
	const out: RawFunction[] = []
	const pageSize = Math.min(limit, 200)
	for (let page = 1; out.length < limit; page++) {
		const res = await api<SearchPage<RawFunction>>("/funkcijaFunkcionera/search", {
			page,
			limit: pageSize,
			sorting: "datumStupanja:desc",
			...params,
		})
		const rows = res.results ?? []
		out.push(...rows)
		if (rows.length < pageSize || out.length >= (res.total ?? 0)) break
	}
	return out.slice(0, limit)
}

export async function getOfficials(inst: { acasId?: string; name: string; nameCyr?: string }): Promise<Official[]> {
	let orgId = inst.acasId
	if (!orgId) {
		const matches = await findInstitution(inst.nameCyr || inst.name)
		orgId = matches[0]?.id
	}
	if (!orgId) return []
	const id = orgId
	const env = await cached(SOURCE, cacheKey("officials", id), async () => (await functionsBy({ organizacijaId: id })).map(toOfficial), {
		activity: { ...SRC.acas, action: "pretraga", label: `funkcioneri: ${shortInstitution(inst.name)}`, url: REGISTER_URL, after: (d, h) => h.items(d.length) },
	})
	return env.data
}

// ─── Person search ──────────────────────────────────────────────────────────

function nameTokens(s: string): string[] {
	return asciiFold(s)
		.split(/[^a-z0-9]+/)
		.filter(Boolean)
}

export async function searchPerson(fullName: string): Promise<Official[]> {
	const cyr = latToCyr(fullName).replace(/\s+/g, " ").trim()
	const words = cyr.split(" ").filter(Boolean)
	if (words.length < 2) return []
	const env = await cached(SOURCE, cacheKey("person", cyr), async () => {
		const first = words[0]
		const last = words[words.length - 1]
		const batches = await Promise.all([
			functionsBy({ funkcionerIme: first, funkcionerPrezime: last }, 100),
			functionsBy({ funkcionerIme: last, funkcionerPrezime: first }, 100),
		])
		const wanted = nameTokens(cyr)
		const seen = new Set<number>()
		const out: Official[] = []
		for (const f of batches.flat()) {
			if (seen.has(f.id)) continue
			seen.add(f.id)
			const have = nameTokens(`${f.funkcionerIme} ${f.funkcionerPrezime}`)
			if (wanted.every((t) => have.includes(t))) out.push(toOfficial(f))
		}
		return out
	}, { activity: { ...SRC.acas, action: "pretraga", label: `pretraga osobe: ${fullName.trim()}`, url: REGISTER_URL, after: (d, h) => h.items(d.length) } })
	return env.data
}

// ─── Asset reports (imovina) ────────────────────────────────────────────────

const REASONS: Record<string, string> = {
	STUPANJE_NA_JAVNU_FUNKCIJU: "stupanje na javnu funkciju",
	PRESTANAK_JAVNE_FUNKCIJE: "prestanak javne funkcije",
	PROMENE_U_TOKU_VRSENJA_FUNKCIJE: "promene u toku vršenja funkcije",
	PROMENE_POSLE_PRESTANKA_FUNKCIJE: "promene posle prestanka funkcije",
	REDOVNI: "redovni izveštaj",
	NEPOZNAT: "nepoznat osnov podnošenja",
}

const money = new Intl.NumberFormat("sr-RS")

async function detailRows(entity: string, obrazacId: number): Promise<RawRow[]> {
	const res = await api<SearchPage<RawRow>>(`/${entity}/search`, { page: 1, limit: 100, obrazacId, deleted: false })
	return res.results ?? []
}

function groupCount(items: string[]): string {
	const counts = new Map<string, number>()
	for (const i of items) if (i) counts.set(i, (counts.get(i) ?? 0) + 1)
	return [...counts].map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)).join(", ")
}

function lowerLatin(s: string): string {
	return latin(s).toLowerCase()
}

function more(list: string[], max = 6): string {
	return list.length > max ? `${list.slice(0, max).join("; ")}; …(+${list.length - max})` : list.join("; ")
}

async function summarizeReport(report: RawReport, fullName: string): Promise<{ summary: string[]; incomes: NonNullable<AssetReport["incomes"]> }> {
	const summary: string[] = []
	const incomes: NonNullable<AssetReport["incomes"]> = []
	const [prihodi, nepokretna, vozila, pravoKoriscenja, akcije, udeli, delatnost] = [
		await detailRows("prihodBudzeta", report.id),
		await detailRows("nepokretnaImovina", report.id),
		await detailRows("imovinaRegistracija", report.id),
		await detailRows("imovinaPravoKoriscenja", report.id),
		await detailRows("imovinaAkcije", report.id),
		await detailRows("imovinaUdeli", report.id),
		await detailRows("imovinaDelatnost", report.id),
	]

	for (const p of prihodi) {
		const amount = typeof p.iznosPrihoda === "number" ? p.iznosPrihoda : Number(p.iznosPrihoda)
		const currency = str(p.valutaSifra) || "RSD"
		const where = str(p.organizacijaNaziv)
		const role = str(p.funkcijaNaziv).replace(/^-$/, "")
		const intervalRaw = lowerLatin(str(p.intervalPrihodaString) || str(p.intervalPrihodaOstalo))
		const interval = intervalRaw === "ostalo" ? "" : intervalRaw
		const rawPeriod = str(p.periodObavljanja)
		const openEnded = /^\d{1,2}\.\d{1,2}\.\d{4}\.?\s*-$/.exec(rawPeriod)
		const period = openEnded ? `od ${rawPeriod.replace(/\s*-$/, "")}` : rawPeriod
		const sourceLabel = [role && positionLatin(role), latin(where)].filter(Boolean).join(", ") || "prihod od javne funkcije"
		incomes.push({
			source: sourceLabel,
			amountRsd: Number.isFinite(amount) && currency === "RSD" ? amount : undefined,
			period: [interval, period].filter(Boolean).join(", ") || undefined,
		})
		if (Number.isFinite(amount)) {
			summary.push(`Prihod od javne funkcije (${sourceLabel}): ${money.format(amount)} ${currency}${interval ? ` ${interval}` : ""}${period ? `, ${period}` : ""}`)
		}
	}

	if (nepokretna.length) {
		const kinds = groupCount(nepokretna.map((n) => lowerLatin(str(n.vrstaString) || str(n.vrstaOstalo))))
		summary.push(`Nepokretna imovina: ${n(nepokretna.length, "stavka")} (${kinds})`)
		const buildings = nepokretna
			.filter((n) => !/њива|шума|ливада|воћњак|земљиште|njiva|šuma|livada|voćnjak|zemljište/i.test(str(n.vrstaString) || str(n.vrstaOstalo)))
			.map((n) => [lowerLatin(str(n.vrstaString) || str(n.vrstaOstalo)), latin(str(n.povrsina)).slice(0, 24)].filter(Boolean).join(" "))
		if (buildings.length) summary.push(`Objekti: ${more(buildings)}`)
	} else summary.push("Nepokretna imovina: nije prijavljena")

	if (vozila.length) {
		const items = vozila.map((v) => {
			const kind = lowerLatin(str(v.vrstaString) || str(v.vrstaOstalo))
			const model = v.javniPodatak === false ? "" : latin(str(v.markaTip))
			return [kind, model, str(v.godina)].filter(Boolean).join(" ")
		})
		summary.push(`Pokretna imovina (registrovana): ${vozila.length} (${more(items)})`)
	}

	if (pravoKoriscenja.length) {
		summary.push(`Pravo korišćenja nepokretnosti: ${n(pravoKoriscenja.length, "stavka")}`)
	}

	const stakes = [...akcije, ...udeli].map((a) => {
		const company = latin(str(a.pravnoLiceNaziv) || str(a.nazivPravnogLica) || str(a.naziv))
		const pct = str(a.procenatUdela)
		return [company, pct ? `${pct}%` : ""].filter(Boolean).join(" ")
	})
	if (stakes.length) summary.push(`Akcije i udeli u privrednim društvima: ${stakes.length} (${more(stakes)})`)

	if (delatnost.length) {
		const items = delatnost.map((d) =>
			[latin(str(d.nazivPreduzetnika)), latin(str(d.pravnoLiceNaziv)), latin(str(d.nazivDelatnosti))].filter(Boolean).join(" / "),
		)
		summary.push(`Samostalna delatnost / povezana privredna društva: ${more(items)}`)
	}

	if (summary.length === 0) summary.push(`Izveštaj postoji u registru ACAS (${fullName}), bez prijavljenih stavki.`)
	return { summary, incomes }
}

function reportDate(r: RawReport): string | undefined {
	const fromMs = isoDate(r.datumPodnosenjaDate)
	if (fromMs) return fromMs
	const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(str(r.datumPodnosenja))
	return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : undefined
}

export async function getAssetReports(personId: string, fullName?: string): Promise<AssetReport[]> {
	let id = personId.trim()
	if (!/^\d+$/.test(id)) {
		const people = fullName ? await searchPerson(fullName) : []
		const ids = [...new Set(people.map((p) => p.id))]
		if (ids.length !== 1) return []
		id = ids[0]
	}
	const pid = id
	const env = await cached(SOURCE, cacheKey("assets", pid), async () => {
		const reports = await api<RawReport[]>(`/obrazacPrijavaImovineIPrihoda/getAllByFunkcionerId/${pid}`, {})
		const latest = [...reports].sort((a, b) => (b.datumPodnosenjaDate ?? 0) - (a.datumPodnosenjaDate ?? 0)).slice(0, MAX_REPORTS_WITH_DETAILS)
		let name = fullName?.trim() ?? ""
		if (!name) {
			const person = await api<{ ime?: string; prezime?: string }>(`/funkcioner/${pid}`, {})
			name = latin(tidyName(` ${str(person.prezime)}`))
		}
		const out: AssetReport[] = []
		for (const r of latest) {
			const reason = REASONS[str(r.tipPrijavljivanja)] ?? (lowerLatin(str(r.tipPrijavljivanja)).replace(/_/g, " ") || undefined)
			const base = {
				personId: pid,
				fullName: name,
				reportDate: reportDate(r),
				reason,
				source: {
					kind: "acas" as const,
					title: `ACAS – Izveštaj o imovini i prihodima funkcionera${reportDate(r) ? ` (${reportDate(r)})` : ""}`,
					url: reportUrl(r.id),
					retrievedAt: new Date().toISOString(),
					publishedAt: reportDate(r),
					official: true,
				},
			}
			if (r.zasticenOdObjavljivanja) {
				out.push({ ...base, summary: ["Izveštaj je zaštićen od objavljivanja (podaci nisu javni)."] })
				continue
			}
			const { summary, incomes } = await summarizeReport(r, base.fullName)
			out.push({ ...base, summary, incomes: incomes.length ? incomes : undefined })
			await new Promise((res) => setTimeout(res, 150))
		}
		return out
	}, { activity: { ...SRC.acas, action: "pretraga", label: `izveštaji o imovini: ${fullName?.trim() || `funkcioner ${pid}`}`, url: REGISTER_URL, after: (d, h) => h.items(d.length) } })
	return env.data
}
