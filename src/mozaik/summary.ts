// Ranking and the deterministic summary of a case. Used by the Urednik's tools (dosije_pregled), by the scripted final
// loop, as the fallback when the editor model fails to write a summary, and by the report.

import { n } from "../shared/plural"
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

/** Findings that may appear in the executive summary: not rejected, not waiting for approval, not refuted. */
export function rankable(state: DosijeState): Finding[] {
	return state
		.findingList()
		.filter((f) => f.status !== "demantovano" && f.approval !== "pending" && f.approval !== "rejected")
		.sort((a, b) => findingScore(b) - findingScore(a) || SECTION_ORDER.indexOf(a.section) - SECTION_ORDER.indexOf(b.section) || a.createdAt.localeCompare(b.createdAt))
}

/** Top signals: highest score first, at most 2 per section for leadership/money and 1 for the rest, then filled up. */
export function pickTop(state: DosijeState, n = 5): Finding[] {
	const ranked = rankable(state).filter((f) => f.severity !== "info")
	const out: Finding[] = []
	const perSection = new Map<Section, number>()
	const cap = (s: Section) => (s === "rukovodstvo" || s === "novac" ? 2 : 1)
	for (const f of ranked) {
		if (out.length >= n) break
		if ((perSection.get(f.section) ?? 0) >= cap(f.section)) continue
		out.push(f)
		perSection.set(f.section, (perSection.get(f.section) ?? 0) + 1)
	}
	for (const f of ranked) {
		if (out.length >= n) break
		if (!out.includes(f)) out.push(f)
	}
	return out
}

export function defaultToVerify(state: DosijeState): string[] {
	const out: string[] = []
	for (const t of state.openTasks()) out.push(`Otvoreno pitanje (${t.fromAgentName}): ${clip(t.question, 160)}`)
	for (const f of state.findingList()) {
		if (f.approval === "pending") out.push(`Signal čeka tvoju odluku: ${clip(f.title, 140)}`)
	}
	for (const f of state.findingList()) {
		if (f.severity === "signal" && f.status === "nepotvrdjeno" && f.approval !== "pending" && f.signalCode !== "POLITICKA_VEZA") out.push(`Potvrditi iz drugog izvora: ${clip(f.title, 140)}`)
	}
	const codes = new Set(state.findingList().map((f) => f.signalCode))
	if (codes.has("VD_PREKO_ROKA") || codes.has("VD_LANAC")) {
		out.push("Koji propis važi za ovu instituciju (javno preduzeće ili društvo kapitala) i postoji li akt o produženju ili novom imenovanju v.d. (traži se kod osnivača/Vlade).")
		out.push("Rešenje o imenovanju u Službenom glasniku: lista brojeva sadrži samo naslove akata, ne i imena; pun tekst je u pretplati ili kod institucije.")
	}
	if (codes.has("BEZ_OBJAVE")) out.push("Za svaki pregovarački postupak bez objavljivanja: obrazloženje i pravni osnov u odluci o pokretanju postupka (Portal javnih nabavki).")
	if (codes.has("POLITICKA_VEZA")) out.push("Integrity Watch označava firme, ali otvoreni podaci ne imenuju funkcionera ni stranku: tražiti osnov oznake od Transparentnosti Srbija.")
	out.push("Vlasnici i direktori proverenih firmi: APR pretraga (pretraga2.apr.gov.rs) zahteva ručnu proveru (reCAPTCHA).")
	out.push("Vrednosti ugovora proveriti na stranici ugovora na Portalu javnih nabavki pre citiranja (iznosi posle aneksa mogu se razlikovati od iznosa pri potpisivanju).")
	return [...new Set(out)].slice(0, 14)
}

export function defaultSummary(state: DosijeState): Summary {
	const all = state.findingList()
	const signals = all.filter((f) => f.severity === "signal").length
	const attention = all.filter((f) => f.severity === "paznja").length
	const official = all.filter((f) => f.status === "zvanicno").length
	const top = pickTop(state, 5)
	const name = state.institution?.name ?? "instituciji"
	const heads = top.slice(0, 3).map((f) => clip(f.title, 90))
	const lede =
		`U dosijeu o ${name} tim agenata je prikupio ${n(all.length, "nalaz")} (signala za proveru: ${signals}, pažnje: ${attention}, sa zvaničnim izvorom: ${official}). ` +
		(heads.length ? `Najvažnije za proveru: ${heads.join("; ")}. ` : "") +
		"To su signali za verifikaciju, ne zaključci; odluku donosi novinar."
	return {
		lede,
		topSignals: top.map((f) => ({ findingId: f.id, headline: clip(f.title, 110) })),
		toVerify: defaultToVerify(state),
	}
}
