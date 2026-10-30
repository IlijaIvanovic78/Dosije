// Razrešavač: what the journalist typed (institution name, alias such as "IŽS", or a news URL) -> InstitutionRef.
// Static tables (data/static/institutions.json + aliases.json) cover the demo institution offline; everything else is
// resolved from ACAS + Portal javnih nabavki + APR (cached, so a repeated query is free).

import fs from "node:fs"
import path from "node:path"
import type { SourceRef } from "../shared/types"
import { cached, cacheKey } from "./cache"
import { searchName } from "./names"
import { pickHead } from "./analysis/vd"
import { nameTokens } from "./newsMatch"
import { mediaName } from "./newsPlan"
import * as acas from "./sources/acas"
import * as apr from "./sources/apr"
import * as jn from "./sources/jnportal"
import * as news from "./sources/news"
import { asciiFold, GENERIC_WORDS, latToCyr, nameSimilarity, normalizeName, sameWord, slugify } from "./translit"
import type { InstitutionRef, LegalType, Official } from "./types"

const STATIC_DIR = path.resolve(process.cwd(), "data", "static")

interface StaticInstitution {
	slug: string
	name: string
	nameCyr: string
	shortName?: string
	officialName?: string
	legalType: LegalType
	pib?: string
	mb?: string
	acasId?: string
	acasAltIds?: string[]
	aliases?: string[]
	jnId?: string
	municipality?: string
	/** verified for "Mapa prioriteta" only: not offered as a demo chip */
	mapaOnly?: boolean
}

export interface MentionedOfficial {
	name: string
	personId: string
	position: string
	current: boolean
}

export interface ResolvedInstitution extends InstitutionRef {
	officialName?: string
	article?: { url: string; title: string; outlet: string; publishedAt?: string }
	mentionedOfficials?: MentionedOfficial[]
}

export const LEGAL_LABELS: Record<LegalType, string> = {
	javno_preduzece: "Javno preduzeće",
	drustvo_kapitala_drzavno: "Društvo kapitala u državnom vlasništvu (a.d./d.o.o.)",
	zdravstvena_ustanova: "Zdravstvena ustanova",
	organ_drzavne_uprave: "Organ državne uprave",
	lokalna_samouprava: "Lokalna samouprava",
	ostalo: "Ostalo (pravni oblik nije utvrđen)",
}

function key(s: string): string {
	return asciiFold(s)
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
}

function stem(s: string): string {
	return key(s)
		.split(" ")
		.map((t) => (t.length > 5 ? t.slice(0, 5) : t))
		.join(" ")
}

function readJson<T>(file: string, fallback: T): T {
	try {
		return JSON.parse(fs.readFileSync(path.join(STATIC_DIR, file), "utf8")) as T
	} catch {
		return fallback
	}
}

let staticTable: StaticInstitution[] | undefined
let aliasTable: Map<string, string> | undefined

function institutions(): StaticInstitution[] {
	staticTable ??= readJson<StaticInstitution[]>("institutions.json", [])
	return staticTable
}

function aliases(): Map<string, string> {
	if (!aliasTable) {
		aliasTable = new Map()
		for (const [k, slug] of Object.entries(readJson<Record<string, string>>("aliases.json", {}))) aliasTable.set(key(k), slug)
		for (const i of institutions()) {
			aliasTable.set(key(i.name), i.slug)
			aliasTable.set(key(normalizeName(i.name)), i.slug)
			if (i.shortName) aliasTable.set(key(i.shortName), i.slug)
			if (i.officialName) aliasTable.set(key(i.officialName), i.slug)
		}
	}
	return aliasTable
}

export function listStaticInstitutions(): { slug: string; name: string }[] {
	return institutions()
		.filter((i) => !i.mapaOnly)
		.map((i) => ({ slug: i.slug, name: i.name.replace(/\s+a\.d\.$/i, "") }))
}

export { searchName }

const ACAS_URL = "https://publicacas.acas.rs/#/acas/funkcioner"

function acasSource(name: string): SourceRef {
	return { kind: "acas", title: acas.registerTitle(name), url: ACAS_URL, retrievedAt: new Date().toISOString(), official: true }
}

function jnSource(name: string): SourceRef {
	return {
		kind: "jnportal",
		title: `Portal javnih nabavki – ugovori naručioca: ${name}`,
		url: `https://jnportal.ujn.gov.rs/ugovori?initFilter=${encodeURIComponent(JSON.stringify(["OfficialName", "=", latToCyr(name)]))}`,
		retrievedAt: new Date().toISOString(),
		official: true,
	}
}

async function fromStatic(s: StaticInstitution, query: string): Promise<ResolvedInstitution> {
	const sources: SourceRef[] = []
	if (s.acasId) sources.push(acasSource(s.name))
	if (s.jnId) sources.push(jnSource(searchName(s.name)))
	if (s.mb) {
		const p = await apr.getCompany({ mb: s.mb }).catch(() => null)
		if (p) sources.push(p.source)
	}
	const { officialName, mapaOnly: _mapaOnly, ...rest } = s
	return { ...rest, query, officialName, sources }
}

function matchStatic(query: string): StaticInstitution | undefined {
	const k = key(query)
	const slug = aliases().get(k) ?? aliases().get(key(normalizeName(query)))
	if (slug) return institutions().find((i) => i.slug === slug)
	return institutions().find((i) => nameSimilarity(i.name, query) >= 0.85)
}

/** The legal type from the registry name; a name that says nothing ("Republicki fond ...") is asked again with the names the other registers use. */
function legalTypeOf(name: string, others: (string | undefined)[], fromAcas: boolean): LegalType {
	const own = guessLegalType(name, fromAcas)
	if (own !== "ostalo") return own
	const more = others.filter((x): x is string => !!x).map((x) => guessLegalType(x, fromAcas)).find((x) => x !== "ostalo")
	return more ?? "ostalo"
}

export function guessLegalType(name: string, fromAcas: boolean): LegalType {
	const n = asciiFold(name)
	if (/\b(dom zdravlja|bolnica|klinicki centar|klinicko bolnicki|zdravstveni centar|apoteka|institut za javno zdravlje|institut za|klinika|zavod za zdravstvenu zastitu|zdravstvena ustanova|zavod za hitnu)\b/.test(n) && !/\b(jkp|jp)\b/.test(n)) return "zdravstvena_ustanova"
	if (/\b(jp|javno preduzece|javno komunalno|jkp)\b/.test(n)) return "javno_preduzece"
	if (/\b(opstina|grad |gradska uprava|skupstina opstine|skupstina grada|mesna zajednica)\b/.test(`${n} `) || /^grad /.test(n)) return "lokalna_samouprava"
	if (/\b(ministarstvo|republicki zavod|uprava za|direkcija za|agencija za|poreska uprava|republicka direkcija)\b/.test(n)) return "organ_drzavne_uprave"
	if (fromAcas && /(^|\s)(a\.?d\.?|d\.?o\.?o\.?)(\s|$)/.test(n)) return "drustvo_kapitala_drzavno"
	return "ostalo"
}

const CITY = /\b(novi sad|beograd|nis|kragujevac|subotica|pancevo|zrenjanin|cacak|kraljevo|leskovac|valjevo|vranje|sabac|uzice|smederevo|sombor|pozarevac|kikinda|krusevac|jagodina)\s*$/

/** The registered company must be in the city the query names ("... Novi Sad"): the APR name match ignores a trailing city. */
function inQueriedCity(profile: { name: string; municipality?: string }, query: string): boolean {
	const city = CITY.exec(asciiFold(query).replace(/[^a-z0-9]+/g, " ").trim())?.[1]
	if (!city) return true
	const hay = ` ${asciiFold(profile.name).replace(/[^a-z0-9]+/g, " ")} ${asciiFold(profile.municipality ?? "").replace(/[^a-z0-9]+/g, " ")} `
	return hay.includes(` ${city} `)
}

// APR registers the full legal name ("Akcionarsko drustvo za zeleznicki prevoz putnika Srbijavoz Beograd"), so a short
// query needs the ranked search; accept it only when exactly one company contains every query token (and sits in the named city)
async function findCompanyForInstitution(query: string) {
	const direct = await apr.findInstitutionCompany(query).catch(() => null)
	if (direct && inQueriedCity(direct, query)) return direct
	const candidates = await apr.searchCompanies(query, 8).catch(() => [])
	const strong = candidates.filter((c) => (c.match === "exact" || c.match === "contains") && inQueriedCity(c.profile, query))
	return strong.length === 1 ? strong[0].profile : null
}
// ─── name matching across the registers ──────────────────────────────────────

// words that describe the body or its legal form, not which body it is: "Univerzitetski klinicki centar Vojvodine" is "Klinicki centar Vojvodine"
const DESCRIPTORS = new Set(["univerzitetski", "opsta", "javno", "komunalno", "preduzece", "jkp", "jp", "ad", "doo", "drustvo", "akcionarsko", "drzavna"])
// organisational parts of a body, never the body itself (unless the query asks for them)
const UNIT = /\b(ogranak|ogranka|pogon|filijala|odeljenje|sektor|telo za centralizovane|radna jedinica|podruznica|sluzba)\b/

const coreTokens = (name: string): string[] => {
	const t = nameTokens(name)
	const core = t.filter((x) => !DESCRIPTORS.has(x))
	return core.length ? core : t
}

interface Match<T> {
	hit: T
	extra: string[]
	identity: string
}

function matchAll<T extends { name: string }>(hits: T[], query: string): Match<T>[] {
	const qt = coreTokens(query)
	const unitWanted = UNIT.test(asciiFold(query))
	const out: Match<T>[] = []
	for (const hit of hits) {
		const t = coreTokens(hit.name)
		if (qt.length === 0 || !qt.every((q) => t.some((x) => sameWord(q, x)))) continue
		if (!unitWanted && (UNIT.test(asciiFold(hit.name)) || (/ - /.test(hit.name) && t.length > qt.length + 3))) continue
		const extra = t.filter((x) => !qt.some((q) => sameWord(q, x)))
		out.push({ hit, extra, identity: extra.sort().join(" ") })
	}
	return out
}
/** The closest group of matches: fewest identifying extra words; several distinct identities at that level means "ambiguous". */
function contenders<T extends { name: string }>(matches: Match<T>[]): { top: Match<T>[]; identities: string[] } {
	if (matches.length === 0) return { top: [], identities: [] }
	const best = Math.min(...matches.map((m) => (m.identity ? m.identity.split(" ").length : 0)))
	const top = matches.filter((m) => (m.identity ? m.identity.split(" ").length : 0) === best)
	return { top, identities: [...new Set(top.map((m) => m.identity))] }
}

export class AmbiguousInstitutionError extends Error {
	constructor(
		public readonly query: string,
		public readonly candidates: string[],
	) {
		super(`Naziv „${query}“ odgovara većem broju ustanova: ${candidates.join("; ")}. Upiši pun naziv ustanove.`)
	}
}

function loadAbbreviations(): Map<string, string> {
	return new Map(Object.entries(readJson<Record<string, string>>("abbreviations.json", {})).map(([k, v]) => [key(k), v]))
}

/** Short names journalists (and the register) use for this body: ACAS files the general director of EPS under "JP EPS Beograd". */
function abbreviationsFor(name: string): string[] {
	const want = coreTokens(name).sort().join(" ")
	return [...loadAbbreviations().entries()].filter(([k, v]) => !k.includes(" ") && coreTokens(v).sort().join(" ") === want).map(([k]) => k)
}

async function latestHeadStart(id: string, name: string): Promise<{ id: string; head?: string; last: string }> {
	const officials = await acas.getOfficials({ acasId: id, name }).catch(() => [] as Official[])
	const head = pickHead(officials)
	const last = officials.reduce((m, o) => (((o.to ?? "9999-12-31") > m ? (o.to ?? "9999-12-31") : m)), "")
	return { id, head: head?.from ?? (head ? "0000" : undefined), last: officials.length ? last : "" }
}

async function resolveDynamic(query: string): Promise<ResolvedInstitution> {
	const env = await cached<ResolvedInstitution | null>("resolver", cacheKey("institution", key(query)), async () => {
		const expanded = loadAbbreviations().get(key(query)) ?? query
		const restored = await apr.restoreDiacritics(expanded).catch(() => expanded)
		const variants = [...new Set([restored, expanded, query])]
		const primary = restored

		// ACAS: diacritic-tolerant only in part, so ask with every spelling and merge
		let failed = 0
		const soft = <T,>(p: Promise<T[]>): Promise<T[]> => p.catch(() => (failed++, [] as T[]))
		const acasAll = new Map<string, Awaited<ReturnType<typeof acas.findInstitution>>[number]>()
		for (const hits of await Promise.all(variants.map((v) => soft(acas.findInstitution(v))))) for (const h of hits) acasAll.set(h.id, h)
		const acasMatches = contenders(matchAll([...acasAll.values()], primary))
		// the same body filed under its abbreviation ("JP EPS Beograd"): its records join the history and may hold the current head
		for (const abbr of abbreviationsFor(primary)) {
			const hits = await soft(acas.findInstitution(abbr))
			const exact = contenders(matchAll(hits, abbr)).top.filter((m) => m.identity === "")
			for (const m of exact) if (!acasMatches.top.some((x) => x.hit.id === m.hit.id)) acasMatches.top.push({ ...m, fromAbbreviation: true } as (typeof acasMatches.top)[number])
		}
		// a query made only of generic words ("Dom zdravlja", "Opsta bolnica") names hundreds of bodies: never pick one
		const queryWords = nameTokens(primary)
		if (queryWords.length > 0 && queryWords.every((w) => GENERIC_WORDS.has(w))) {
			const names = [...new Set(matchAll([...acasAll.values()], primary).map((m) => m.hit.name))].sort((a, b) => a.length - b.length)
			throw new AmbiguousInstitutionError(query, (names.length ? names : [...new Set([...acasAll.values()].map((h) => h.name))]).slice(0, 6))
		}
		if (acasMatches.identities.length > 1) {
			throw new AmbiguousInstitutionError(query, acasMatches.top.slice(0, 6).map((m) => m.hit.name))
		}

		let acasBest: (typeof acasMatches.top)[number]["hit"] | undefined
		let acasAlt: string[] = []
		// the name shown: the live entry named like the query (the abbreviation entry may hold the head but is not the name)
		let nameHit: typeof acasBest
		if (acasMatches.top.length === 1) acasBest = acasMatches.top[0].hit
		else if (acasMatches.top.length > 1) {
			// the same body entered several times (renamed, re-registered): the entry with the newest head is the live one, the others
			// only contribute their history
			const ranked = (await Promise.all(acasMatches.top.slice(0, 5).map((m) => latestHeadStart(m.hit.id, m.hit.name)))).sort(
				(a, b) => (b.head ?? "").localeCompare(a.head ?? "") || b.last.localeCompare(a.last),
			)
			acasBest = acasMatches.top.find((m) => m.hit.id === ranked[0].id)?.hit
			nameHit = ranked.map((r) => acasMatches.top.find((m) => m.hit.id === r.id)).find((m) => m && !(m as { fromAbbreviation?: boolean }).fromAbbreviation)?.hit
			acasAlt = ranked.slice(1).filter((r) => r.last).map((r) => r.id)
		}

		nameHit ??= acasBest
		const canonical = nameHit?.name ?? primary
		const jnQueries = [...new Set([canonical, ...variants].map((v) => searchName(v)))]
		const jnAll = new Map<string, Awaited<ReturnType<typeof jn.findAuthority>>[number]>()
		for (const hits of await Promise.all(jnQueries.map((v) => soft(jn.findAuthority(v))))) for (const h of hits) jnAll.set(h.id, h)
		const jnMatches = contenders(matchAll([...jnAll.values()], canonical).length ? matchAll([...jnAll.values()], canonical) : matchAll([...jnAll.values()], primary))
		let jnBest = jnMatches.top[0]?.hit
		if (jnMatches.top.length > 1) {
			const ranked = await Promise.all(jnMatches.top.slice(0, 4).map(async (m) => ({ m, act: await jn.authorityActivity(m.hit).catch(() => ({ total: 0, latest: "" })) })))
			ranked.sort((a, b) => b.act.latest.localeCompare(a.act.latest) || b.act.total - a.act.total)
			jnBest = ranked[0].m.hit
		}

		const aprHit = (await findCompanyForInstitution(canonical)) ?? (canonical !== primary ? await findCompanyForInstitution(primary) : null)

		if (!acasBest && !jnBest && !aprHit) {
			if (failed >= variants.length + jnQueries.length) throw new Error("Izvori (ACAS, Portal javnih nabavki) nisu odgovorili; pokušaj ponovo za nekoliko minuta.")
			const near = [...acasAll.values(), ...jnAll.values()].filter((h) => nameSimilarity(h.name, primary) >= 0.34).slice(0, 5).map((h) => h.name)
			if (near.length) throw new AmbiguousInstitutionError(query, [...new Set(near)])
			return null
		}
		const name = nameHit?.name ?? jnBest?.name ?? aprHit?.name ?? query
		const sources: SourceRef[] = []
		if (nameHit ?? acasBest) sources.push((nameHit ?? acasBest)!.source)
		if (jnBest) sources.push(jnBest.source)
		if (aprHit) sources.push(aprHit.source)
		const names = [...abbreviationsFor(primary).map((a) => a.toUpperCase()), nameHit?.name, jnBest?.name, aprHit?.name, ...acasMatches.top.map((m) => m.hit.name), ...(expanded !== query ? [query.toUpperCase()] : nameTokens(query).length >= 2 ? [expanded] : [])]
		const own = new Set([key(normalizeName(name)), key(normalizeName(searchName(name)))])
		const aliasSet = new Map<string, string>()
		for (const n of names) {
			// the media name: no JP/JKP prefix, and no seat city unless the city is part of the name ("Dom zdravlja Novi Sad")
			const nm = n ? mediaName(n) : ""
			const k = nm ? key(normalizeName(nm)) : ""
			// the same name in another spelling or legal form is not an alias ("J.P.Srbijagas", "Javno komunalno preduzece ...")
			const LEGAL_FORM = new Set(["jkp", "jp", "ad", "doo", "javno", "komunalno", "preduzece", "drustvo", "akcionarsko", "d", "o"])
			const noLegal = (x: string) => nameTokens(x).filter((w) => !LEGAL_FORM.has(w)).sort().join(" ")
			const sameCore = !!nm && noLegal(nm) === noLegal(name)
			if (nm && k && !own.has(k) && !sameCore && !aliasSet.has(k)) aliasSet.set(k, nm)
		}
		// the media also write the registered form ("JKP Vodovod i kanalizacija Novi Sad"): searched as an alias next to the plain name
		const registered = searchName(name).replace(/["„“”]/g, " ").replace(/\s+/g, " ").trim()
		if (mediaName(name).toLowerCase() !== registered.toLowerCase() && !aliasSet.has(key(registered))) aliasSet.set(key(registered), registered)
		return {
			query,
			slug: slugify(name),
			name,
			nameCyr: nameHit?.nameCyr ?? latToCyr(name),
			legalType: legalTypeOf(name, [jnBest?.name, aprHit?.name], !!acasBest),
			pib: jnBest?.pib,
			mb: aprHit?.mb,
			acasId: acasBest?.id,
			acasAltIds: acasAlt.length ? acasAlt : undefined,
			aliases: aliasSet.size ? [...aliasSet.values()].slice(0, 4) : undefined,
			jnId: jnBest?.id,
			municipality: aprHit?.municipality,
			sources,
		}
	}, { skipWrite: (d) => d === null })
	if (!env.data) {
		throw new Error(`Institucija ,${query}" nije pronađena u ACAS, na Portalu javnih nabavki ni u APR. Proveri naziv (probaj i sa č, ć, š, ž, đ) ili probaj link vesti.`)
	}
	return { ...env.data, query }
}
export async function resolveByName(query: string): Promise<ResolvedInstitution> {
	const s = matchStatic(query)
	if (s) return fromStatic(s, query)
	return resolveDynamic(query.trim())
}

function ngrams(title: string): string[] {
	const words = title
		.replace(/[„“”"',:;()–—-]/g, " ")
		.split(/\s+/)
		.filter(Boolean)
	const out: string[] = []
	for (let n = Math.min(5, words.length); n >= 2; n--) {
		for (let i = 0; i + n <= words.length; i++) {
			const gram = words.slice(i, i + n)
			if (gram.some((w) => /^\p{Lu}/u.test(w))) out.push(gram.join(" "))
		}
	}
	return out
}

function mentionedIn(text: string, officials: Official[]): MentionedOfficial[] {
	const hay = ` ${stem(text)} `
	const seen = new Set<string>()
	const out: MentionedOfficial[] = []
	for (const o of officials) {
		if (seen.has(o.id)) continue
		const parts = stem(o.fullName).split(" ").filter(Boolean)
		if (parts.length >= 2 && parts.every((p) => hay.includes(` ${p}`))) {
			seen.add(o.id)
			out.push({ name: o.fullName, personId: o.id, position: o.position, current: !o.to })
		}
	}
	return out.sort((a, b) => Number(b.current) - Number(a.current))
}

async function resolveUrl(url: string): Promise<ResolvedInstitution> {
	const article = await news.fetchArticle(url)
	const text = `${article.title}\n${article.text}`
	const hay = ` ${stem(text)} `
	let ref: ResolvedInstitution | undefined

	for (const i of institutions()) {
		const names = [i.name, searchName(i.name), i.shortName, i.officialName].filter((x): x is string => !!x)
		const aliasKeys = [...aliases().entries()].filter(([, slug]) => slug === i.slug).map(([k]) => k)
		const hit = [...names, ...aliasKeys].some((n) => {
			const st = stem(n)
			return st.length >= 8 && hay.includes(` ${st} `)
		})
		if (hit || (i.shortName && new RegExp(`\\b${i.shortName}\\b`).test(text))) {
			ref = await fromStatic(i, url)
			break
		}
	}
	if (!ref) {
		let tries = 0
		for (const gram of ngrams(article.title)) {
			if (tries++ >= 6) break
			const hits = await acas.findInstitution(gram).catch(() => [])
			if (hits[0] && nameSimilarity(hits[0].name, gram) >= 0.6) {
				ref = await resolveDynamic(hits[0].name).catch(() => undefined)
				if (ref) break
			}
		}
	}
	if (!ref) throw new Error("U članku nije pronađena poznata institucija. Upiši naziv institucije ručno.")

	const officials = await acas.getOfficials({ acasId: ref.acasId, altIds: ref.acasAltIds, name: ref.name, nameCyr: ref.nameCyr }).catch(() => [] as Official[])
	return {
		...ref,
		query: url,
		article: { url: article.url, title: article.title, outlet: article.outlet, publishedAt: article.publishedAt },
		mentionedOfficials: mentionedIn(text, officials),
	}
}

const RESOLVE_TIMEOUT_MS = 75_000

export async function resolveInstitution(query: string): Promise<ResolvedInstitution> {
	const q = query.trim()
	if (!q) throw new Error("Upiši instituciju ili link vesti.")
	const work = /^https?:\/\//i.test(q) ? resolveUrl(q) : resolveByName(q)
	// the registers must answer: a hung lookup is an error message, not a frozen page
	let timer: NodeJS.Timeout | undefined
	const limit = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error("Registri (ACAS, Portal javnih nabavki) ne odgovaraju na vreme. Pokušaj ponovo za nekoliko minuta.")), RESOLVE_TIMEOUT_MS)
	})
	work.catch(() => undefined)
	return Promise.race([work, limit]).finally(() => clearTimeout(timer))
}

