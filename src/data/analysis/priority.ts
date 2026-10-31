// "Mapa prioriteta": deterministic priority score of one institution ("where to look first") from the signals the triage
// tools fetched. The score is plain code, never a model's opinion; it ranks where a human should start, it does not judge.
//
//   signal                                                                   points
//   acting head (v.d.) past the legal limit                                  +40, plus min(20, months over the limit)
//   consecutive acting heads for >= 24 months (chain)                        +15
//   negotiated procedures without publication, share of contract value > 5%  +15
//   ... and at least 5 such procedures                                       +5
//   top supplier (without public systems / state utilities) share > 40%      +10
//   Integrity Watch Srbija flagged suppliers                                 +3 each, at most 15
//   DRI qualified / adverse / disclaimer opinions                            +10 each, at most 20
//   at least 5 DRI reports                                                   +5
//   the same supplier among the top suppliers of 2+ institutions of the map  +5 each (of the row's suppliers), at most 10
//     (cross-institution link: the triage agents put their top suppliers into the shared state, the Urednik finds the overlap,
//      publishes "mapa.veza" and adds this contribution and the line "Isti dobavljač u N institucije: <naziv>" to the row)
//
// Maximum 155. Every contribution produces a short reason with its points (in the run's language), so a score can always be
// explained.

import type { Lang } from "../../shared/lang"
import { n } from "../../shared/plural"
import type { MapaSignals } from "../../shared/types"

export const PRIORITY_MAX = 155

/** Points per supplier shared with another institution, and the cap per institution. */
export const SHARED_SUPPLIER_POINTS = 5
export const SHARED_SUPPLIER_MAX = 10

/** The four areas a score is made of, for the ranking bars: leadership (acting heads), procurement (incl. Integrity Watch), audit (DRI), shared suppliers. */
export type PriorityArea = "rukovodstvo" | "nabavke" | "revizija" | "veze"

export interface PriorityResult {
	score: number
	reasons: string[]
	parts: Record<PriorityArea, number>
}

const pct = (share: number, lang: Lang = "sr"): string => `${(Math.round(share * 1000) / 10).toLocaleString(lang === "en" ? "en-GB" : "sr-RS")}%`
const en = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`

/** "Isti dobavljač u 2 institucije: X" / "The same supplier in 2 institutions: X" */
export function sharedSupplierLine(institutions: number, name: string, lang: Lang = "sr"): string {
	return lang === "en" ? `The same supplier in ${institutions} institutions: ${name}` : `Isti dobavljač u ${n(institutions, "institucija")}: ${name}`
}

export function scoreSignals(s: MapaSignals, lang: Lang = "sr"): PriorityResult {
	const E = lang === "en"
	let score = 0
	const reasons: string[] = []
	const parts: Record<PriorityArea, number> = { rukovodstvo: 0, nabavke: 0, revizija: 0, veze: 0 }
	let area: PriorityArea = "rukovodstvo"
	const add = (points: number, text: string) => {
		score += points
		parts[area] += points
		reasons.push(`${text} (+${points})`)
	}

	if (s.vdOver && s.vdMonths !== undefined && s.vdLimitMonths !== undefined) {
		const over = Math.max(0, s.vdMonths - s.vdLimitMonths)
		add(40 + Math.min(20, over), E ? `acting head for ${en(s.vdMonths, "month")}, legal limit ${s.vdLimitMonths}` : `v.d. ${n(s.vdMonths, "mesec")}, zakonski rok ${s.vdLimitMonths}`)
	}
	if (s.vdChainMonths !== undefined && s.vdChainMonths >= 24) {
		add(15, E ? `acting heads in a row for ${en(s.vdChainMonths, "month")}${s.vdChainCount ? ` (${s.vdChainCount} acting heads)` : ""}` : `lanac v.d. ${n(s.vdChainMonths, "mesec")}${s.vdChainCount ? ` (${n(s.vdChainCount, "uzastopniVd")})` : ""}`)
	}
	area = "nabavke"
	if (s.nwpShare !== undefined && s.nwpShare > 0.05) add(15, E ? `${pct(s.nwpShare, lang)} of the value without a published call` : `bez objave javnog poziva ${pct(s.nwpShare)} vrednosti`)
	if (s.nwpCount !== undefined && s.nwpCount >= 5) add(5, E ? `${en(s.nwpCount, "procedure")} without a published call` : `${n(s.nwpCount, "postupak")} bez objave javnog poziva`)
	if (s.topSupplierShare !== undefined && s.topSupplierShare > 0.4) add(10, E ? `the biggest supplier has ${pct(s.topSupplierShare, lang)} of the value` : `najveći dobavljač ${pct(s.topSupplierShare)} vrednosti`)
	if (s.iwFlags) add(Math.min(15, 3 * s.iwFlags), E ? `${en(s.iwFlags, "supplier")} flagged in Integrity Watch` : `${n(s.iwFlags, "dobavljac")} ${s.iwFlags % 10 === 1 && s.iwFlags % 100 !== 11 ? "označen" : "označeno"} u Integrity Watch`)
	area = "revizija"
	if (s.driQualified) add(Math.min(20, 10 * s.driQualified), E ? `${en(s.driQualified, "qualified or adverse audit opinion")}` : `${n(s.driQualified, "driMisljenje")}`)
	if (s.driReports !== undefined && s.driReports >= 5) add(5, E ? `State Audit Institution: ${en(s.driReports, "report")}` : `DRI: ${n(s.driReports, "izvestaj")}`)
	area = "veze"
	let sharedPoints = 0
	for (const sh of s.sharedSuppliers ?? []) {
		const points = Math.min(SHARED_SUPPLIER_POINTS, SHARED_SUPPLIER_MAX - sharedPoints)
		if (points <= 0) break
		sharedPoints += points
		add(points, sharedSupplierLine(sh.institutions, sh.name, lang))
	}
	return { score, reasons, parts }
}

/** Short signal chips for tables and logs, e.g. "v.d. 17/12 mes.", "bez objave 10 · 0,1%", "IW 8", "DRI 21 · 1 sa rezervom". */
export function signalChips(s: MapaSignals): string[] {
	const chips: string[] = []
	if (s.vdMonths !== undefined && s.vdLimitMonths !== undefined && (s.vdOver || s.vdMonths > 0)) chips.push(`v.d. ${s.vdMonths}/${s.vdLimitMonths} mes.`)
	if (s.vdChainMonths !== undefined && s.vdChainMonths >= 24) chips.push(`lanac v.d. ${s.vdChainMonths} mes.`)
	if (s.nwpCount) chips.push(`bez objave ${s.nwpCount}${s.nwpShare !== undefined ? ` · ${pct(s.nwpShare)}` : ""}`)
	if (s.iwFlags) chips.push(`IW ${s.iwFlags}`)
	if (s.driReports) chips.push(`DRI ${s.driReports}${s.driQualified ? ` · ${s.driQualified} sa rezervom` : ""}`)
	if (s.sharedSuppliers?.length) chips.push(`isti dobavljač ${s.sharedSuppliers.length}`)
	return chips
}
