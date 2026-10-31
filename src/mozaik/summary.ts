// Ranking and the deterministic summary of a case. Used by the Urednik's tools (dosije_pregled), by the scripted final
// loop, as the fallback when the editor model fails to write a summary, and by the report.

import type { Lang } from "../shared/lang"
import { n, pluralIndex } from "../shared/plural"
import type { Finding, Section } from "../shared/types"
import type { DosijeState, Summary } from "./state"
import { clip } from "./util"

const SECTION_ORDER: Section[] = ["rukovodstvo", "novac", "firme", "revizija", "mediji"]

const CODE_WEIGHT: Record<string, number> = {
	VD_PREKO_ROKA: 12,
	VLASNIK_FUNKCIONER: 10,
	BEZ_OBJAVE: 9,
	VD_LANAC: 8,
	KONCENTRACIJA: 8,
	DRI_MISLJENJE: 6,
	DRI_NALAZ: 5,
	UGOVOR_VECI_OD_PRIHODA: 5,
	MLADA_FIRMA: 5,
	IMENOVANJE_NEPOZNATO: 5,
	POLITICKA_VEZA: 4,
	MALO_ZAPOSLENIH: 4,
	MEDIJSKI_NAVOD: 3,
	IMOVINA: 3,
}

export function findingScore(f: Finding): number {
	const sev = f.severity === "signal" ? 30 : f.severity === "paznja" ? 15 : 0
	return sev + (f.signalCode ? (CODE_WEIGHT[f.signalCode] ?? 2) : 0) + (f.status === "zvanicno" ? 3 : f.status === "potvrdjeno" ? 1 : 0)
}

/** A DRI finding older than this is history, not a current signal: it ranks below recent signals (see rankTier). */
export const DRI_STALE_YEARS = 5

/** The finding is a DRI finding/opinion whose DRI report was published more than DRI_STALE_YEARS before `now`. */
export function isStaleDri(f: Finding, now = Date.now()): boolean {
	if (f.signalCode !== "DRI_NALAZ" && f.signalCode !== "DRI_MISLJENJE") return false
	const published = f.sources.filter((s) => s.kind === "dri" && s.publishedAt).map((s) => Date.parse(s.publishedAt as string)).filter((t) => Number.isFinite(t))
	return published.length > 0 && Math.max(...published) < now - DRI_STALE_YEARS * 365.25 * 86400e3
}

/**
 * How much a finding can be relied on, the first key of every ranking: 0 official (zvanično; approved when it needed approval),
 * 1 confirmed by two independent sources, 2 unconfirmed, 3 "not found" findings (a missing appointment act is a gap, not a signal)
 * and DRI findings older than 5 years (they rank below recent signals and only fill the list when nothing else qualifies).
 */
export function rankTier(f: Finding): number {
	if (f.signalCode === "IMENOVANJE_NEPOZNATO" || isStaleDri(f)) return 3
	// an owner whose NAME is in the register of officials: the register is official, the identity is not (a namesake is
	// possible). Named on a PEP list too, it ranks with confirmed findings; named only by the register, with unconfirmed ones.
	if (f.signalCode === "VLASNIK_FUNKCIONER") return f.sources.some((s) => s.kind === "opensanctions" || s.kind === "krik") ? 1 : 2
	return f.status === "zvanicno" ? 0 : f.status === "potvrdjeno" ? 1 : 2
}

const byRank = (a: Finding, b: Finding) =>
	rankTier(a) - rankTier(b) || findingScore(b) - findingScore(a) || SECTION_ORDER.indexOf(a.section) - SECTION_ORDER.indexOf(b.section) || a.createdAt.localeCompare(b.createdAt)

/** Findings that may appear in the executive summary: not rejected, not waiting for approval, not refuted. Most reliable first. */
export function rankable(state: DosijeState): Finding[] {
	return state
		.findingList()
		.filter((f) => f.status !== "demantovano" && f.approval !== "pending" && f.approval !== "rejected" && !f.title.startsWith("Izvor nije odgovorio"))
		.sort(byRank)
}

/**
 * Top signals: official first, then confirmed, then unconfirmed, then "not found"; within a tier by severity and signal weight.
 * At most one finding per signalCode (several Integrity Watch flags are one kind of signal) and at most 2 per section for
 * leadership/money and 1 for the rest; the caps are relaxed only to reach 3 entries.
 */
/**
 * Findings the executive summary may name. An owner whose name only the register of officials carries (no PEP list) stays
 * in the dossier but not in the summary: next to it, a namesake is as likely as the official.
 */
export function summaryWorthy(f: Finding): boolean {
	return f.severity !== "info" && !(f.signalCode === "VLASNIK_FUNKCIONER" && rankTier(f) === 2)
}

export function pickTop(state: DosijeState, n = 5): Finding[] {
	const candidates = rankable(state).filter(summaryWorthy)
	return withRedFlag(selectTop(candidates, n), candidates, n)
}

/**
 * A red flag (severity "signal") of a kind the summary does not name yet gets a free place, or takes the last place from
 * a finding that is only "paznja": a serious kind of signal (six suppliers flagged by Integrity Watch) is not left out
 * because its source is unconfirmed. The order still puts it after the official findings. Old DRI findings and "not
 * found" findings never get in this way.
 */
export function withRedFlag(top: Finding[], candidates: Finding[], n = 5): Finding[] {
	const codes = new Set(top.map((f) => f.signalCode))
	const red = [...candidates].sort(byRank).find((f) => f.severity === "signal" && f.signalCode && !codes.has(f.signalCode) && rankTier(f) < 3 && !top.includes(f))
	if (!red) return top
	if (top.length < n) return [...top, red].sort(byRank)
	const weakest = [...top].sort(byRank).reverse().find((f) => f.severity !== "signal")
	return weakest ? [...top.filter((f) => f !== weakest), red].sort(byRank) : top
}

export function selectTop(ranked: Finding[], n = 5): Finding[] {
	const out: Finding[] = []
	const perSection = new Map<Section, number>()
	const codes = new Set<string>()
	const cap = (s: Section) => (s === "rukovodstvo" || s === "novac" ? 2 : 1)
	const take = (f: Finding) => {
		out.push(f)
		perSection.set(f.section, (perSection.get(f.section) ?? 0) + 1)
		if (f.signalCode) codes.add(f.signalCode)
	}
	const fresh = (f: Finding) => !out.includes(f) && !(f.signalCode && codes.has(f.signalCode))
	for (const f of ranked) if (out.length < n && fresh(f) && (perSection.get(f.section) ?? 0) < cap(f.section)) take(f)
	for (const f of ranked) if (out.length < n && fresh(f)) take(f)
	for (const f of ranked) if (out.length < Math.min(n, 3) && !out.includes(f)) take(f)
	// the caps decide WHO is in, the reliability tier decides the ORDER: an unconfirmed finding never stands above an official one
	return out.sort(byRank)
}

/** The same ordering for a list somebody else (an LLM) chose: official before unconfirmed, one finding per signalCode, at most n. */
export function orderTop(chosen: Finding[], n = 5): Finding[] {
	return selectTop(chosen.filter(summaryWorthy).sort(byRank), n)
}

/** A finding's title as a quotation inside a checklist sentence; a title that was shortened ("…") is not quoted at all. */
function quoted(f: Finding): string {
	return f.title.endsWith("…") ? `nalaz iz odeljka „${SECTION_LABEL[f.section]}“` : `„${f.title.replace(/[.\s]+$/u, "")}“`
}

const SECTION_LABEL: Record<Section, string> = { rukovodstvo: "Rukovodstvo", novac: "Novac i nabavke", firme: "Firme", revizija: "Revizija", mediji: "Mediji" }

/**
 * The checklist "Šta još treba proveriti". Every item is one complete sentence: long wording is rewritten shorter here, never
 * clipped (the quoted titles are whole by construction, see `quoted`).
 */
export function defaultToVerify(state: DosijeState): string[] {
	const out: string[] = []
	for (const t of state.openTasks()) out.push(`Odgovoriti na otvoreno pitanje agenta ${t.fromAgentName}: ${t.question.replace(/[.\s]+$/u, "")}.`)
	for (const f of state.findingList()) {
		if (f.approval === "pending") out.push(`Odlučiti o signalu koji čeka odobrenje: ${quoted(f)}.`)
	}
	for (const f of state.findingList()) {
		if (f.severity === "signal" && f.status === "nepotvrdjeno" && f.approval !== "pending" && f.signalCode !== "POLITICKA_VEZA") out.push(`Potvrditi iz drugog izvora: ${quoted(f)}.`)
	}
	for (const f of state.findingList()) {
		// a source that did not answer: say what to repeat (see sourceGap in inference/policies.ts)
		if (f.title.startsWith("Izvor nije odgovorio")) out.push(`Ponoviti pretragu ili ručno proveriti: ${f.title.replace(/^Izvor nije odgovorio:\s*/, "")} nije odgovorio (${f.sources[0]?.url ?? "stranica izvora"}).`)
	}
	const codes = new Set(state.findingList().map((f) => f.signalCode))
	if (codes.has("VD_PREKO_ROKA") || codes.has("VD_LANAC")) {
		out.push("Proveriti koji propis važi za ovu instituciju i postoji li akt o produženju ili novom imenovanju v.d.")
		out.push("Rešenje o imenovanju tražiti kod institucije: sadržaj Službenog glasnika navodi samo naslove akata, bez imena.")
	}
	if (codes.has("BEZ_OBJAVE")) out.push("Za svaki pregovarački postupak bez objavljivanja proveriti obrazloženje u odluci o pokretanju postupka.")
	if (codes.has("POLITICKA_VEZA")) out.push("Osnov oznake Integrity Watch tražiti od Transparentnosti Srbija: podaci ne imenuju funkcionera ni stranku.")
	out.push("Vlasnike i direktore firmi proveriti u APR pretrazi, koja zahteva ručni unos zbog reCAPTCHA.")
	out.push("Iznose ugovora proveriti na Portalu javnih nabavki pre citiranja, jer iznos posle aneksa može biti drugačiji.")
	return [...new Set(out)].slice(0, 14)
}

/** Up to three titles for the lede, whole: titles longer than 110 characters are skipped while enough short ones exist. */
export function leadHeads(titles: string[]): string[] {
	const short = titles.filter((t) => t.length <= 110 && !t.endsWith("…"))
	return (short.length >= 2 ? short : titles.filter((t) => !t.endsWith("…")).slice(0, 3)).slice(0, 3)
}

/** Plain Serbian lede. The institution's name is quoted after "o instituciji" so it never needs declension. */
export function buildLede(p: { institution: string; findings: number; signals: number; attention: number; conflicts: number; heads: string[]; lang?: Lang }): string {
	if (p.lang === "en") return buildLedeEn(p)
	const counts = [p.signals ? `${n(p.signals, "signal")}` : "", p.attention ? `${p.attention} za pažnju` : ""].filter(Boolean).join(" i ")
	const parts = [`Tim agenata je o instituciji „${p.institution}“ prikupio ${n(p.findings, "nalaz")}${counts ? `: ${counts}` : ""}.`]
	if (p.conflicts === 1) parts.push("Jedan konflikt između izvora rešen je u korist zvaničnog registra.")
	else if (p.conflicts > 1) parts.push(`${n(p.conflicts, "konflikt")} između izvora ${pluralIndex(p.conflicts) === 1 ? "rešena su" : "rešeno je"} u korist zvaničnog registra.`)
	if (p.heads.length) parts.push(`Najvažnije: ${p.heads.map((h, i) => `(${i + 1}) ${h.replace(/;\s*/g, ", ").replace(/[.\s]+$/u, "")}`).join("; ")}.`)
	parts.push("To su signali, ne zaključci; svaki nalaz nosi izvor i status.")
	return parts.join(" ")
}

function buildLedeEn(p: { institution: string; findings: number; signals: number; attention: number; conflicts: number; heads: string[] }): string {
	const plural = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`
	const counts = [p.signals ? plural(p.signals, "signal") : "", p.attention ? `${p.attention} notable` : ""].filter(Boolean).join(" and ")
	const parts = [`The team of agents collected ${plural(p.findings, "finding")} about “${p.institution}”${counts ? `: ${counts}` : ""}.`]
	if (p.conflicts === 1) parts.push("One conflict between sources was resolved in favour of the official register.")
	else if (p.conflicts > 1) parts.push(`${p.conflicts} conflicts between sources were resolved in favour of the official register.`)
	if (p.heads.length) parts.push(`The most important: ${p.heads.map((h, i) => `(${i + 1}) ${h.replace(/;\s*/g, ", ").replace(/[.\s]+$/u, "")}`).join("; ")}.`)
	parts.push("These are signals, not conclusions; every finding carries a source and a status.")
	return parts.join(" ")
}

export function defaultSummary(state: DosijeState): Summary {
	const all = state.findingList()
	const signals = all.filter((f) => f.severity === "signal").length
	const attention = all.filter((f) => f.severity === "paznja").length
	const official = all.filter((f) => f.status === "zvanicno").length
	const top = pickTop(state, 5)
	const name = state.institution?.name ?? "instituciji"
	const heads = leadHeads(top.map((f) => f.title))
	void official
	const lede = buildLede({ institution: name, findings: all.length, signals, attention, conflicts: state.conflicts.size, heads, lang: state.lang })
	return {
		lede,
		topSignals: top.map((f) => ({ findingId: f.id, headline: f.title })),
		toVerify: defaultToVerify(state),
	}
}
