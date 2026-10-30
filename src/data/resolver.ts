// Razrešavač: what the journalist typed (institution name, alias such as "IŽS", or a news URL) -> InstitutionRef.
// Static tables (data/static/institutions.json + aliases.json) cover the demo institution offline; everything else is
// resolved from ACAS + Portal javnih nabavki + APR (cached, so a repeated query is free).

import fs from "node:fs"
import path from "node:path"
import type { SourceRef } from "../shared/types"
import { cached, cacheKey } from "./cache"
import * as acas from "./sources/acas"
import * as apr from "./sources/apr"
import * as jn from "./sources/jnportal"
import * as news from "./sources/news"
import { asciiFold, latToCyr, nameSimilarity, normalizeName, slugify } from "./translit"
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
	jnId?: string
	municipality?: string
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
	return institutions().map((i) => ({ slug: i.slug, name: i.name.replace(/\s+a\.d\.$/i, "") }))
}

/** Name without the legal-form suffix, e.g. "Infrastruktura železnice Srbije a.d." -> "Infrastruktura železnice Srbije". */
export function searchName(name: string): string {
	return name.replace(/\s+(a\.d\.|d\.o\.o\.|ad|doo|j\.p\.|jp)(\s+.*)?$/i, "").trim()
}

const ACAS_URL = "https://publicacas.acas.rs/#/acas/funkcioner"

function acasSource(name: string): SourceRef {
	return { kind: "acas", title: `ACAS – Registar funkcionera: ${name}`, url: ACAS_URL, retrievedAt: new Date().toISOString(), official: true }
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
	const { officialName, ...rest } = s
	return { ...rest, query, officialName, sources }
}

function matchStatic(query: string): StaticInstitution | undefined {
	const k = key(query)
	const slug = aliases().get(k) ?? aliases().get(key(normalizeName(query)))
	if (slug) return institutions().find((i) => i.slug === slug)
	return institutions().find((i) => nameSimilarity(i.name, query) >= 0.85)
}

export function guessLegalType(name: string, fromAcas: boolean): LegalType {
	const n = asciiFold(name)
	if (/\b(dom zdravlja|bolnica|klinicki centar|zdravstveni centar|apoteka|institut za javno zdravlje|klinika)\b/.test(n)) return "zdravstvena_ustanova"
	if (/\b(opstina|grad |gradska|gradsko|skupstina opstine|mesna zajednica)\b/.test(n + " ")) return "lokalna_samouprava"
	if (/\b(ministarstvo|republicki zavod|uprava za|direkcija za|agencija za|poreska uprava)\b/.test(n)) return "organ_drzavne_uprave"
	if (/\b(jp|javno preduzece|javno komunalno|jkp)\b/.test(n)) return "javno_preduzece"
	if (fromAcas && /(^|\s)(a\.?d\.?|d\.?o\.?o\.?)(\s|$)/.test(n)) return "drustvo_kapitala_drzavno"
	return "ostalo"
}

async function resolveDynamic(query: string): Promise<ResolvedInstitution> {
	const env = await cached<ResolvedInstitution | null>("resolver", cacheKey("institution", key(query)), async () => {
		const [acasHits, jnHits, aprHit] = await Promise.all([
			acas.findInstitution(query).catch(() => []),
			jn.findAuthority(searchName(query)).catch(() => []),
			apr.findInstitutionCompany(query).catch(() => null),
		])
		const acasBest = acasHits.find((h) => nameSimilarity(h.name, query) >= 0.5)
		const jnBest = jnHits.find((h) => nameSimilarity(h.name, query) >= 0.5)
		if (!acasBest && !jnBest && !aprHit) return null
		const name = acasBest?.name ?? jnBest?.name ?? aprHit?.name ?? query
		const sources: SourceRef[] = []
		if (acasBest) sources.push(acasBest.source)
		if (jnBest) sources.push(jnBest.source)
		if (aprHit) sources.push(aprHit.source)
		return {
			query,
			slug: slugify(name),
			name,
			nameCyr: acasBest?.nameCyr ?? latToCyr(name),
			legalType: guessLegalType(name, !!acasBest),
			pib: jnBest?.pib,
			mb: aprHit?.mb,
			acasId: acasBest?.id,
			jnId: jnBest?.id,
			municipality: aprHit?.municipality,
			sources,
		}
	}).catch(() => null)
	if (!env?.data) {
		throw new Error(`Institucija „${query}“ nije pronađena u ACAS, na Portalu javnih nabavki ni u APR. Proveri naziv ili probaj link vesti.`)
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

	const officials = await acas.getOfficials({ acasId: ref.acasId, name: ref.name, nameCyr: ref.nameCyr }).catch(() => [] as Official[])
	return {
		...ref,
		query: url,
		article: { url: article.url, title: article.title, outlet: article.outlet, publishedAt: article.publishedAt },
		mentionedOfficials: mentionedIn(text, officials),
	}
}

export async function resolveInstitution(query: string): Promise<ResolvedInstitution> {
	const q = query.trim()
	if (!q) throw new Error("Upiši instituciju ili link vesti.")
	if (/^https?:\/\//i.test(q)) return resolveUrl(q)
	return resolveByName(q)
}

