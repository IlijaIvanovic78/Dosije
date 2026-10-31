// Razrešavač: what the journalist typed (institution name, alias such as "IŽS", acronym such as "RTS") -> InstitutionRef.
// Names only: a news link is refused.
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
	/** the typed name matched several bodies and this one was picked (resolveInstitution with pickBest) */
	chosen?: { from: string; alternatives: string[] }
}

export const LEGAL_LABELS: Record<LegalType, string> = {
	javno_preduzece: "Javno preduzeće",
	drustvo_kapitala_drzavno: "Društvo kapitala u državnom vlasništvu (a.d./d.o.o.)",
	zdravstvena_ustanova: "Zdravstvena ustanova",
	organ_drzavne_uprave: "Organ državne uprave",
	lokalna_samouprava: "Lokalna samouprava",
	ostalo: "Ostalo (pravni oblik nije utvrđen)",
}

/** The same in English, for a run started in English. */
export const LEGAL_LABELS_EN: Record<LegalType, string> = {
	javno_preduzece: "Public enterprise",
	drustvo_kapitala_drzavno: "State-owned company (a.d./d.o.o.)",
	zdravstvena_ustanova: "Health care institution",
	organ_drzavne_uprave: "State administration body",
	lokalna_samouprava: "Local self-government",
	ostalo: "Other (legal form not established)",
}

function key(s: string): string {
	return asciiFold(s)
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
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
const UNIT = /\b(ogranak|ogranka|pogon|filijala|odeljenje|sektor|telo za centralizovane|radna jedinica|podruznica|sluzba|ekspozitura|regionalni centar|podrucna jedinica|odsek)\b/

const POSITION_FIRST = /^(direktor|predsednik|clan|zamenik|sekretar|v\.?\s?d\.?|vrsilac)\b/

/** "Ministarstvo zdravlja - Uprava za biomedicinu": a part of the body the query names, written after a dash. */
function isSubUnit(name: string, qt: string[]): boolean {
	const dash = name.split(/\s[-–—]\s/)
	if (dash.length < 2) return false
	const head = coreTokens(dash[0])
	return qt.every((q) => head.some((x) => sameWord(q, x)))
}

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

// normalizeName drops a seat city at the end of a name ("Naučno tehnološki park Niš" -> "naucno tehnoloski park"), so two
// bodies that differ only by their city would look like one entered twice. The city is kept aside to tell them apart.
const SEAT = /\s(beograd|novi sad|nis|kragujevac|subotica)(?=\s)/g

/** The seat city a name ends with, after at least one word of its own ("Grad Novi Sad" yes, "NIS" alone no). */
function seatOf(name: string): string | undefined {
	const s = ` ${asciiFold(name).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `
	const all = [...s.matchAll(SEAT)].filter((m) => (m.index ?? 0) > 0)
	return all.at(-1)?.[1]
}

function matchAll<T extends { name: string }>(hits: T[], query: string): Match<T>[] {
	const qt = coreTokens(query)
	const unitWanted = UNIT.test(asciiFold(query))
	const qSeat = seatOf(query)
	const out: Match<T>[] = []
	for (const hit of hits) {
		const t = coreTokens(hit.name)
		if (qt.length === 0 || !qt.every((q) => t.some((x) => sameWord(q, x)))) continue
		// "... Novi Sad" is not the body of the same name in Niš
		const seat = seatOf(hit.name)
		if (qSeat && seat && seat !== qSeat) continue
		// a function, not a body ("Direktor Republičkog fonda ..." is a stray register entry)
		if (POSITION_FIRST.test(asciiFold(hit.name))) continue
		if (!unitWanted && (UNIT.test(asciiFold(hit.name)) || isSubUnit(hit.name, qt) || (/ - /.test(hit.name) && t.length > qt.length + 3))) continue
		// "MINISTARSTVO FINANSIJA - PORESKA UPRAVA": the body itself, filed under its parent; the part after the dash is its name
		const tail = coreTokens(hit.name.split(/\s[-–—]\s/).pop() ?? "")
		const own = /\s[-–—]\s/.test(hit.name) && qt.every((q) => tail.some((x) => sameWord(q, x))) ? tail : t
		const extra = own.filter((x) => !qt.some((q) => sameWord(q, x)))
		out.push({ hit, extra, identity: extra.sort().join(" ") })
	}
	return out
}
/** The closest group of matches: fewest identifying extra words; several distinct identities at that level means "ambiguous". */
function contenders<T extends { name: string }>(matches: Match<T>[]): { top: Match<T>[]; identities: string[] } {
	if (matches.length === 0) return { top: [], identities: [] }
	const best = Math.min(...matches.map((m) => (m.identity ? m.identity.split(" ").length : 0)))
	const top = matches.filter((m) => (m.identity ? m.identity.split(" ").length : 0) === best)
	// the same name in two cities is two bodies (the science parks of Niš and Beograd), not one body entered twice
	const seats = new Set(top.map((m) => seatOf(m.hit.name)).filter(Boolean))
	const identity = (m: Match<T>) => (seats.size > 1 ? `${m.identity} @${seatOf(m.hit.name) ?? ""}`.trim() : m.identity)
	return { top, identities: [...new Set(top.map(identity))] }
}

export class AmbiguousInstitutionError extends Error {
	constructor(
		public readonly query: string,
		public readonly candidates: string[],
	) {
		super(`Naziv „${query}“ odgovara većem broju ustanova: ${candidates.join("; ")}. Upišite pun naziv ustanove.`)
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

// ─── acronyms ("RTS", "NBS", "RGZ") ──────────────────────────────────────────

// words an acronym skips ("Republički fond za penzijsko i invalidsko osiguranje" = PIO)
const ACRONYM_SKIP = new Set(["i", "u", "za", "na", "od", "sa", "o", "a", "iz", "pri"])

/** "RTS", "rts", "RFZO": one word, 2-6 letters, typed in capitals (or short and nearly vowel-less, like "rts"). */
export function looksLikeAcronym(q: string): boolean {
	const s = q.trim()
	if (!/^\p{L}{2,6}$/u.test(s)) return false
	if (s === s.toUpperCase() && s !== s.toLowerCase()) return true
	return s.length <= 4 && (asciiFold(s).match(/[aeiou]/g) ?? []).length <= 1
}

export interface AcronymPhrase {
	/** the words the acronym stands for, as written in the register ("Radio Televizija Srbije") */
	phrase: string
	/** register entries that contain it (the same body is often entered several times) */
	entries: number
	/** a national or provincial body ("... Srbije", "Republički ...", "... Vojvodine") */
	national: boolean
}

// what may stand before the spelled-out name (its legal form) and after it (legal form, seat)
const ACRONYM_PREFIX = new Set(["jp", "jkp", "jmu", "rdu", "javno", "javna", "javni", "komunalno", "preduzece", "ustanova", "medijska", "radiodifuzna", "zdravstvena", "akcionarsko", "drustvo", "ad", "doo", "d", "o"])
const ACRONYM_SUFFIX = new Set(["ad", "doo", "d", "o", "jp", "beograd", "novi", "sad", "nis", "kragujevac", "subotica", "pancevo", "zrenjanin", "cacak", "kraljevo", "leskovac", "valjevo", "vranje", "sabac", "uzice", "smederevo", "sombor", "pozarevac", "kikinda", "krusevac", "jagodina", "zemun", "vracar", "savski", "venac", "stari", "grad"])
// a body of the whole country or province: what a journalist means by a bare acronym
const NATIONAL = /\b(srbije|srbija|republick\w*|republike|vojvodine|nacionaln\w*|drzavn\w*|ministarstv\w*|vlad[ae]|narodn\w*|skupstin\w*|agencij\w*)\b/

/**
 * Names whose initials, over consecutive words, spell the acronym: "Radiodifuzna ustanova Radio Televizija Srbije" -> "Radio
 * Televizija Srbije" for RTS. The spelled-out words must be the name itself: only a legal form may stand before them and
 * only a legal form or the seat after them ("Medicinska škola Požarevac" is not "Ministarstvo spoljnih poslova" for MSP just
 * because both spell it, but a word in the middle of a longer name never counts). Units (ogranak, služba) are skipped.
 * Most likely first: national bodies, then the phrase that the most register entries share, then the shortest.
 */
export function acronymPhrases(acr: string, names: string[]): AcronymPhrase[] {
	const want = asciiFold(acr).toLowerCase()
	const found = new Map<string, AcronymPhrase>()
	for (const name of names) {
		if (UNIT.test(asciiFold(name))) continue
		const words = name.split(/[\s\-–—,.;:"„“”'()/]+/).filter((w) => /\p{L}/u.test(w))
		const folded = words.map((w) => asciiFold(w).toLowerCase())
		const sig = words.map((w, i) => ({ i, c: folded[i][0], w: folded[i] })).filter((x) => x.c && !ACRONYM_SKIP.has(x.w))
		for (let s = 0; s + want.length <= sig.length; s++) {
			if (sig.slice(s, s + want.length).map((x) => x.c).join("") !== want) continue
			const from = sig[s].i
			const to = sig[s + want.length - 1].i
			if (!folded.slice(0, from).every((w) => ACRONYM_PREFIX.has(w)) || !folded.slice(to + 1).every((w) => ACRONYM_SUFFIX.has(w))) continue
			// the legal form and the seat are not part of an acronym ("Srbijagas Novi Sad" is no SNS)
			if (ACRONYM_PREFIX.has(folded[from]) || ACRONYM_SUFFIX.has(folded[to])) continue
			const phrase = words.slice(from, to + 1).join(" ")
			const k = key(phrase)
			const hit = found.get(k) ?? { phrase, entries: 0, national: NATIONAL.test(k) }
			hit.entries++
			found.set(k, hit)
		}
	}
	const proper = (p: AcronymPhrase) => Number(/^\p{Lu}/u.test(p.phrase))
	return [...found.values()].sort((a, b) => Number(b.national) - Number(a.national) || proper(b) - proper(a) || b.entries - a.entries || a.phrase.length - b.phrase.length)
}

/** The phrase an acronym most likely stands for, from the whole ACAS register; undefined when nothing spells it. */
async function expandAcronym(acr: string): Promise<string | undefined> {
	const all = await acas.allInstitutions().catch(() => [] as { id: string; name: string }[])
	return acronymPhrases(acr, all.map((o) => o.name))[0]?.phrase
}

async function latestHeadStart(id: string, name: string): Promise<{ id: string; head?: string; last: string }> {
	const officials = await acas.getOfficials({ acasId: id, name }).catch(() => [] as Official[])
	const head = pickHead(officials)
	const last = officials.reduce((m, o) => (((o.to ?? "9999-12-31") > m ? (o.to ?? "9999-12-31") : m)), "")
	return { id, head: head?.from ?? (head ? "0000" : undefined), last: officials.length ? last : "" }
}

async function resolveDynamic(query: string): Promise<ResolvedInstitution> {
	// v2: bodies that differ only by their seat city are no longer merged; answers cached before that are not reused
	const env = await cached<ResolvedInstitution | null>("resolver", cacheKey("institution", "v2", key(query)), async () => {
		// a known short name, else an acronym spelled out from the register ("RTS" -> "Radio Televizija Srbije", not "Galerija RTS")
		const expanded = loadAbbreviations().get(key(query)) ?? (looksLikeAcronym(query) ? await expandAcronym(query) : undefined) ?? query
		const restored = await apr.restoreDiacritics(expanded).catch(() => expanded)
		const variants = [...new Set([restored, expanded, query])]
		const primary = restored

		// ACAS: diacritic-tolerant only in part, so ask with every spelling and merge
		let failed = 0
		const soft = <T,>(p: Promise<T[]>): Promise<T[]> => p.catch(() => (failed++, [] as T[]))
		const acasAll = new Map<string, Awaited<ReturnType<typeof acas.findInstitution>>[number]>()
		for (const hits of await Promise.all(variants.map((v) => soft(acas.findInstitution(v))))) for (const h of hits) acasAll.set(h.id, h)
		// the register search stops at 100 rows: a body named exactly like the query can be cut off behind its own branches
		// ("Poreska uprava" behind its hundred filijale), so the full register list is asked for that exact name too
		const wantCore = coreTokens(primary).sort().join(" ")
		for (const o of await acas.allInstitutions().catch(() => [] as { id: string; name: string }[])) {
			if (!acasAll.has(o.id) && coreTokens(o.name).sort().join(" ") === wantCore) acasAll.set(o.id, { id: o.id, name: o.name, nameCyr: latToCyr(o.name), source: acasSource(o.name) })
		}
		const acasMatches = contenders(matchAll([...acasAll.values()], primary))
		// the same body filed under its abbreviation ("JP EPS Beograd"): its records join the history and may hold the current head
		for (const abbr of abbreviationsFor(primary)) {
			const hits = await soft(acas.findInstitution(abbr))
			const exact = contenders(matchAll(hits, abbr)).top.filter((m) => m.identity === "")
			for (const m of exact) if (!acasMatches.top.some((x) => x.hit.id === m.hit.id)) acasMatches.top.push({ ...m, fromAbbreviation: true } as (typeof acasMatches.top)[number])
		}
		// a query made only of generic words ("Dom zdravlja", "Opsta bolnica") names hundreds of bodies: never pick one, unless
		// every match is that very name and its own branches were already dropped ("Ministarstvo zdravlja", "Poreska uprava")
		const queryWords = nameTokens(primary)
		const onlyItself = (() => {
			const all = matchAll([...acasAll.values()], primary)
			return all.length > 0 && all.every((m) => m.identity === "")
		})()
		if (queryWords.length > 0 && queryWords.every((w) => GENERIC_WORDS.has(w)) && !onlyItself) {
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
			if (failed >= variants.length + jnQueries.length) throw new Error("Izvori (ACAS, Portal javnih nabavki) nisu odgovorili; pokušajte ponovo za nekoliko minuta.")
			const near = [...acasAll.values(), ...jnAll.values()].filter((h) => nameSimilarity(h.name, primary) >= 0.34).slice(0, 5).map((h) => h.name)
			if (near.length) throw new AmbiguousInstitutionError(query, [...new Set(near)])
			return null
		}
		const name = nameHit?.name ?? jnBest?.name ?? aprHit?.name ?? query
		// an acronym nothing spelled out is taken only by a body that carries it as a word of its name
		if (expanded === query && looksLikeAcronym(query) && !nameTokens(name).includes(asciiFold(query).toLowerCase())) return null
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
		throw new Error(`Institucija „${query}“ nije pronađena u ACAS, na Portalu javnih nabavki ni u APR. Proverite naziv (probajte i sa č, ć, š, ž, đ).`)
	}
	return { ...env.data, query }
}
const CITIES: Record<string, string> = {
	beograd: "Beograd", "novi sad": "Novi Sad", nis: "Niš", kragujevac: "Kragujevac", subotica: "Subotica", pancevo: "Pančevo", zrenjanin: "Zrenjanin",
	cacak: "Čačak", kraljevo: "Kraljevo", leskovac: "Leskovac", valjevo: "Valjevo", vranje: "Vranje", sabac: "Šabac", uzice: "Užice",
	smederevo: "Smederevo", sombor: "Sombor", pozarevac: "Požarevac", kikinda: "Kikinda", krusevac: "Kruševac", jagodina: "Jagodina",
}

/** A bare city name is the city: "Beograd" -> "Grad Beograd", "Niš" -> "Grad Niš" (but "NIS" in capitals is the oil company). */
function cityBody(query: string): string | undefined {
	const q = query.trim()
	const city = CITIES[key(q)]
	if (!city || (q.length <= 4 && q === q.toUpperCase())) return undefined
	return `Grad ${city}`
}

export async function resolveByName(query: string): Promise<ResolvedInstitution> {
	const name = cityBody(query) ?? query
	const s = matchStatic(name)
	if (s) return { ...(await fromStatic(s, query)), query }
	return { ...(await resolveDynamic(name.trim())), query }
}

/** "Elektroprivreda Srbije (EPS)": the name without the bracket first, then as typed, then the bracket alone (an abbreviation). */
function nameVariants(q: string): string[] {
	const m = /^(.+?)\s*\(([^()]+)\)\s*$/.exec(q)
	if (!m) return [q]
	return [...new Set([m[1].trim(), q, m[2].trim()])].filter((v) => v.length >= 2)
}

/**
 * Several bodies match the name: the most likely one is the body itself (not a branch, a unit or "Telo za centralizovane
 * nabavke"), named with the fewest words beyond the query; a candidate that is itself ambiguous is skipped.
 */
async function pickAmong(query: string, err: AmbiguousInstitutionError, opts: { nationalOnly?: boolean } = {}): Promise<ResolvedInstitution> {
	const base = nameVariants(query)[0]
	const qt = coreTokens(base)
	const whole = err.candidates.filter((c) => !UNIT.test(asciiFold(c)) && !isSubUnit(c, qt) && !/ - /.test(c))
	// a generic name ("Klinički centar", "Pošta") means the national body first ("Klinički centar Srbije", "Pošta Srbije")
	const isNational = (c: string) => NATIONAL.test(key(c))
	const national = (c: string) => Number(isNational(c) && !isNational(base))
	const ranked = (whole.length ? whole : err.candidates)
		.map((c) => ({ c, extra: coreTokens(c).filter((x) => !qt.some((q) => sameWord(q, x))).length, sim: nameSimilarity(c, base) }))
		.sort((a, b) => a.extra - b.extra || national(b.c) - national(a.c) || b.sim - a.sim || a.c.length - b.c.length)
	// the dossier takes only a clear giant (a national body on top); anything less stays the list of candidates
	if (opts.nationalOnly && !(ranked[0] && isNational(ranked[0].c))) throw err
	for (const { c } of ranked.slice(0, opts.nationalOnly ? 1 : 4)) {
		try {
			const ref = await resolveByName(c)
			const same = new Set([qt.join(" "), coreTokens(c).join(" "), coreTokens(ref.name).join(" ")])
			const alternatives = new Map<string, string>()
			for (const x of err.candidates) {
				const k = coreTokens(x).join(" ")
				if (!same.has(k) && !alternatives.has(k)) alternatives.set(k, x)
			}
			return { ...ref, query, chosen: { from: query, alternatives: [...alternatives.values()].slice(0, 5) } }
		} catch {
			// this candidate is ambiguous or unknown too: try the next one
		}
	}
	throw err
}

async function resolveNamed(q: string, pickBest: boolean): Promise<ResolvedInstitution> {
	let first: unknown
	let ambiguous: AmbiguousInstitutionError | undefined
	for (const v of nameVariants(q)) {
		try {
			return { ...(await resolveByName(v)), query: q }
		} catch (err) {
			first ??= err
			if (err instanceof AmbiguousInstitutionError) ambiguous ??= err
		}
	}
	if (pickBest && ambiguous) return pickAmong(q, ambiguous)
	// the dossier too takes the national body when the name clearly means it ("Pošta" -> "Pošta Srbije")
	if (ambiguous) return pickAmong(q, ambiguous, { nationalOnly: true }).catch(() => Promise.reject(first))
	throw first
}

const RESOLVE_TIMEOUT_MS = 75_000

/** pickBest: a name that matches several bodies resolves to the most likely one instead of failing (Mapa prioriteta). */
export async function resolveInstitution(query: string, opts: { pickBest?: boolean } = {}): Promise<ResolvedInstitution> {
	const q = query.trim()
	if (!q) throw new Error("Upišite naziv institucije.")
	// names only: a news link is not taken (the article text is not searched for institutions)
	if (/^(https?:\/\/|www\.)|\.(rs|com|net|org|info)(\/|$)/i.test(q)) throw new Error("Upišite naziv institucije (ključne reči). Linkovi se ne prihvataju.")
	const work = resolveNamed(q, !!opts.pickBest)
	// the registers must answer: a hung lookup is an error message, not a frozen page
	let timer: NodeJS.Timeout | undefined
	const limit = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error("Registri (ACAS, Portal javnih nabavki) ne odgovaraju na vreme. Pokušajte ponovo za nekoliko minuta.")), RESOLVE_TIMEOUT_MS)
	})
	work.catch(() => undefined)
	return Promise.race([work, limit]).finally(() => clearTimeout(timer))
}

