// Per-firm signals for a supplier of an institution: APR profile + contracts with the institution + Integrity Watch.
// The signals are deterministic, factual observations for verification (never accusations).

import fs from "node:fs"
import path from "node:path"
import type { Severity, SignalCode, SourceRef } from "../../shared/types"
import { SRC, trackActivity } from "../activity"
import * as apr from "../sources/apr"
import * as iw from "../sources/integrityWatch"
import * as jn from "../sources/jnportal"
import * as news from "../sources/news"
import { monthsBetween } from "../rules/vdRules"
import type { CompanyProfile, Contract, IntegrityWatchLink } from "../types"
import { asciiFold, nameSimilarity, normalizeName } from "../translit"
import { formatRsd, type InstLike } from "./procurement"
import { daysLabel, formatDate, monthsLabel } from "./vd"

const SUPPLIER_MB_FILE = path.resolve(process.cwd(), "data", "static", "supplier-mb.json")

interface MbEntry {
	mb: string
	name?: string
	basis?: string
}

let mbTable: Map<string, MbEntry> | undefined

export function supplierMbTable(): Map<string, MbEntry> {
	if (!mbTable) {
		mbTable = new Map()
		try {
			const raw = JSON.parse(fs.readFileSync(SUPPLIER_MB_FILE, "utf8")) as Record<string, string | MbEntry>
			for (const [pib, v] of Object.entries(raw)) {
				if (pib.startsWith("_")) continue
				mbTable.set(pib, typeof v === "string" ? { mb: v } : v)
			}
		} catch {
			// no table: firms are then resolved by name only when the match is clear
		}
	}
	return mbTable
}

export function lookupSupplierMb(pib?: string): MbEntry | undefined {
	return pib ? supplierMbTable().get(pib.replace(/\D/g, "")) : undefined
}

function legalFormOf(name: string): string | null {
	if (/(^|\s)a\s?\.?\s?d\.?(\s|$)|akcionarsko/i.test(name)) return "Akcionarsko društvo"
	if (/d\s?\.?\s?o\s?\.?\s?o\.?(\s|$)|sa ograni[čc]enom/i.test(name)) return "Društvo sa ograničenom odgovornošću"
	return null
}

export interface FirmMatch {
	profile: CompanyProfile | null
	basis: string
	candidates?: { mb: string; name: string; municipality?: string; score: number }[]
}

const FORM_WORDS = new Set(["doo", "ad", "ado", "d", "o", "a", "drustvo", "sa", "ogranicenom", "odgovornoscu", "akcionarsko", "dd", "ltd"])

function seatTokens(name: string): string[] {
	return asciiFold(name)
		.replace(/[^a-z0-9]+/g, " ")
		.split(" ")
		.filter((t) => t && !FORM_WORDS.has(t))
}

/**
 * Registered names often put the activity in front of the brand ("DRUŠTVO ZA SPOLJNU I UNUTRAŠNJU TRGOVINU MEDICOM DOO ŠABAC"), so the
 * supplier's trade name is not a token-set match. A company is accepted when the supplier's whole name (brand, legal form and the
 * seat written in it) is the END of the registered name, or its brand starts the name and its seat ends it, and it is the ONLY such
 * active company of a compatible legal form. Anything less clear stays "not found".
 */
function pickBySeat(name: string, hint: string | null, cands: { profile: CompanyProfile }[]): { profile: CompanyProfile } | null {
	const q = seatTokens(name)
	if (q.length < 2) return null
	const brand = q.slice(0, -1)
	const seat = q[q.length - 1]
	const ok = cands.filter(({ profile }) => {
		if (profile.status && profile.status !== "Aktivan") return false
		if (hint && profile.legalForm && profile.legalForm !== hint) return false
		const c = seatTokens(profile.name)
		const suffix = c.length >= q.length && q.every((t, i) => c[c.length - q.length + i] === t)
		const brandPrefixSeatSuffix = brand.length >= 2 && brand.every((t, i) => c[i] === t) && c[c.length - 1] === seat
		return suffix || brandPrefixSeatSuffix
	})
	return ok.length === 1 ? ok[0] : null
}
/** MB given -> curated PIB->MB table -> clear name match with a compatible legal form. Never guesses between several companies. */
export function findFirmProfile(q: { pib?: string; mb?: string; name?: string }): Promise<FirmMatch> {
	const who = q.name?.trim() || (q.mb ? `MB ${q.mb}` : q.pib ? `PIB ${q.pib}` : "firma")
	// the APR open data is a local, committed snapshot: reported as a cache read dated by the snapshot
	return trackActivity({ ...SRC.apr, action: "pretraga", label: `dobavljač u APR: ${who}`, url: apr.APR_OPEN_DATA_URL }, async (h) => {
		const m = await matchFirmProfile(q)
		h.cached(m.profile?.source.retrievedAt)
		h.items(m.profile ? 1 : m.candidates?.length ?? 0)
		return m
	})
}

async function matchFirmProfile(q: { pib?: string; mb?: string; name?: string }): Promise<FirmMatch> {
	if (q.mb) {
		const p = await apr.getCompany({ mb: q.mb })
		if (p) return { profile: p, basis: "matični broj naveden u upitu" }
	}
	const entry = lookupSupplierMb(q.pib)
	if (entry) {
		const p = await apr.getCompany({ mb: entry.mb })
		if (p) return { profile: p, basis: `MB iz proverene tabele (data/static/supplier-mb.json): ${entry.basis ?? "ručno upareno"}` }
	}
	if (q.name) {
		const p = await apr.getCompany({ name: q.name })
		const hint = legalFormOf(q.name)
		if (p && (!hint || !p.legalForm || p.legalForm === hint)) {
			return { profile: p, basis: "jasno poklapanje naziva u APR (PIB nije u otvorenim podacima APR); proveriti MB" }
		}
		const wide = await apr.searchCompanies(q.name, 12)
		const seat = pickBySeat(q.name, hint, wide)
		if (seat) return { profile: seat.profile, basis: "naziv, pravni oblik i sedište poklapaju se samo sa jednom firmom u APR (PIB nije u otvorenim podacima APR); proveriti MB" }
		const cands = wide.slice(0, 3)
		return {
			profile: null,
			basis: "nije pouzdano pronađen u APR",
			candidates: cands.map((c) => ({ mb: c.profile.mb, name: c.profile.name, municipality: c.profile.municipality, score: Math.round(c.score * 100) / 100 })),
		}
	}
	return { profile: null, basis: "nije pouzdano pronađen u APR" }
}

export interface FirmSignal {
	code: SignalCode
	label: string
	detail: string
	severity: Severity
}

export interface FirmAnalysis {
	name: string
	pib?: string
	match: FirmMatch
	contracts: {
		count: number
		soleCount: number
		jointCount: number
		soleValueRsd: number
		jointValueRsd: number
		first?: string
		last?: string
		biggest?: { title: string; valueRsd?: number; signedAt?: string; url?: string; supplier: string }
	}
	iwLinks: IntegrityWatchLink[]
	signals: FirmSignal[]
	sources: SourceRef[]
}

const isJoint = (c: Contract) => /^Zajednička ponuda/i.test(c.supplierName)

export async function analyzeFirm(inst: InstLike, query: { pib?: string; mb?: string; name: string }): Promise<FirmAnalysis> {
	const q = { ...query, pib: query.pib?.replace(/\D/g, "") || undefined, mb: query.mb?.replace(/\D/g, "") || undefined }
	const [match, contracts, iwLinks] = await Promise.all([
		findFirmProfile(q),
		// the name is only used for matching when there is no PIB (it is passed along for the live-search label)
		jn.getContractsWithSupplier(inst, { pib: q.pib, name: q.name }).catch(() => [] as Contract[]),
		iw.getLinksForSupplier({ pib: q.pib, mb: q.mb, name: q.name }).catch(() => [] as IntegrityWatchLink[]),
	])
	const profile = match.profile
	const sole = contracts.filter((c) => !isJoint(c))
	const joint = contracts.filter(isJoint)
	const soleValue = sole.reduce((s, c) => s + (c.valueRsd ?? 0), 0)
	const jointValue = joint.reduce((s, c) => s + (c.valueRsd ?? 0), 0)
	const dates = contracts.map((c) => c.signedAt).filter((d): d is string => !!d).sort()
	const biggest = [...contracts].sort((a, b) => (b.valueRsd ?? -1) - (a.valueRsd ?? -1))[0]

	const signals: FirmSignal[] = []
	if (profile?.revenueRsd !== undefined && profile.revenueYear) {
		const year = String(profile.revenueYear)
		const bigSole = [...sole].sort((a, b) => (b.valueRsd ?? 0) - (a.valueRsd ?? 0))[0]
		const inYear = sole.filter((c) => c.signedAt?.startsWith(year)).reduce((s, c) => s + (c.valueRsd ?? 0), 0)
		if (bigSole?.valueRsd && bigSole.valueRsd > profile.revenueRsd) {
			signals.push({
				code: "UGOVOR_VECI_OD_PRIHODA",
				label: "Ugovor veći od godišnjeg prihoda",
				severity: "paznja",
				detail: `Najveći samostalni ugovor sa institucijom (${formatDate(bigSole.signedAt)}) vredi ${formatRsd(bigSole.valueRsd)}, više od ukupnih prihoda firme za ${year}. godinu prema APR (${formatRsd(profile.revenueRsd)}). Ugovor može trajati više godina; signal za proveru.`,
			})
		} else if (inYear > profile.revenueRsd) {
			signals.push({
				code: "UGOVOR_VECI_OD_PRIHODA",
				label: "Ugovori u jednoj godini veći od prihoda",
				severity: "paznja",
				detail: `Samostalni ugovori potpisani ${year}. godine vrede ${formatRsd(inYear)}, više od ukupnih prihoda firme za ${year}. prema APR (${formatRsd(profile.revenueRsd)}). Signal za proveru.`,
			})
		}
	}
	if (profile?.founded && dates[0] && dates[0] >= profile.founded) {
		const gap = monthsBetween(profile.founded, dates[0])
		if (gap.months < 12) {
			signals.push({
				code: "MLADA_FIRMA",
				label: "Firma mlađa od godinu dana pri prvom ugovoru",
				severity: "paznja",
				detail: `Prema APR firma je osnovana ${formatDate(profile.founded)}, a prvi ugovor sa institucijom je iz ${formatDate(dates[0])} (${monthsLabel(gap.months)} i ${daysLabel(gap.days)} kasnije).`,
			})
		}
	}
	const valueForSize = soleValue > 0 ? soleValue : jointValue
	if (profile?.employees !== undefined && profile.employees < 10 && valueForSize > 50_000_000) {
		signals.push({
			code: "MALO_ZAPOSLENIH",
			label: "Malo zaposlenih, veliki ugovori",
			severity: "paznja",
			detail: `Prema APR broj zaposlenih u firmi je ${profile.employees}, a ugovori sa institucijom vrede ${formatRsd(valueForSize)}${soleValue > 0 ? "" : " (vrednost zajedničkih ponuda, nije samo ova firma)"}.`,
		})
	}
	// Integrity Watch lists a supplier for every authority it is flagged at: only flags at THIS institution are a signal
	// here; flags elsewhere are context (the party link is a property of the firm, so it is still worth a mention).
	const sameAuthority = (a?: string) => !!a && (normalizeName(a) === normalizeName(inst.name) || nameSimilarity(a, inst.name) >= 0.85)
	const here = iwLinks.filter((l) => sameAuthority(l.contractingAuthority))
	const elsewhere = iwLinks.filter((l) => !sameAuthority(l.contractingAuthority))
	if (here.length > 0) {
		const kinds = [...new Set(here.map((l) => l.linkType))].join(" i ")
		const contractsHere = Math.max(...here.map((l) => l.contracts ?? 0))
		const soleValue = Math.max(0, ...here.map((l) => l.valueRsd ?? 0))
		// the dataset cites a media article as the basis of a party link; it is shown only if the article really names the firm
		const names = [...new Set([...here.map((l) => l.supplierName), profile?.name, q.name].filter((x): x is string => !!x && !/^(PIB|MB) \d+$/.test(x)))]
		let basis: string | undefined
		for (const url of [...new Set(here.map((l) => l.basisUrl).filter((u): u is string => !!u))]) {
			if (await news.articleNamesSubject(url, names)) {
				basis = url
				break
			}
		}
		signals.push({
			code: "POLITICKA_VEZA",
			label: "Označen u bazi Integrity Watch Srbija",
			severity: "signal",
			detail: `Baza Integrity Watch Srbija (Transparentnost Srbija) označava firmu kao: ${kinds}. Označenih ugovora kod ove institucije: ${contractsHere}${soleValue > 0 ? `, vrednost samostalnih ugovora ${formatRsd(soleValue)}` : ""}. ${basis ? `Osnov povezivanja koji navodi baza (članak pominje firmu): ${basis}. ` : ""}Otvoreni podaci ne imenuju funkcionera ni stranku; podatak zahteva proveru.`,
		})
	} else if (elsewhere.length > 0) {
		const kinds = [...new Set(elsewhere.map((l) => l.linkType))].join(" i ")
		signals.push({
			code: "POLITICKA_VEZA",
			label: "Označen u bazi Integrity Watch Srbija kod drugih naručilaca",
			severity: "paznja",
			detail: `Baza Integrity Watch Srbija označava firmu kao: ${kinds}, ali kod drugih naručilaca (${[...new Set(elsewhere.map((l) => l.contractingAuthority).filter(Boolean))].slice(0, 2).join("; ")}), ne kod ove institucije. Podatak zahteva proveru.`,
		})
	}
	const sources: SourceRef[] = []
	if (profile) sources.push(profile.source)
	if (biggest) sources.push(biggest.source)
	for (const l of (here.length ? here : elsewhere).slice(0, 2)) sources.push(l.source)

	return {
		name: profile?.name ?? q.name,
		pib: q.pib,
		match,
		contracts: {
			count: contracts.length,
			soleCount: sole.length,
			jointCount: joint.length,
			soleValueRsd: Math.round(soleValue),
			jointValueRsd: Math.round(jointValue),
			first: dates[0],
			last: dates[dates.length - 1],
			biggest: biggest ? { title: biggest.title, valueRsd: biggest.valueRsd, signedAt: biggest.signedAt, url: biggest.url, supplier: biggest.supplierName } : undefined,
		},
		iwLinks,
		signals,
		sources,
	}
}

