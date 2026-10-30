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
// Maximum 155. Every contribution produces a short Serbian reason with its points, so a score can always be explained.

import { n } from "../../shared/plural"
import type { MapaSignals } from "../../shared/types"

export const PRIORITY_MAX = 155

/** Points per supplier shared with another institution, and the cap per institution. */
export const SHARED_SUPPLIER_POINTS = 5
export const SHARED_SUPPLIER_MAX = 10

export interface PriorityResult {
	score: number
	reasons: string[]
}

const pct = (share: number): string => `${(Math.round(share * 1000) / 10).toLocaleString("sr-RS")}%`

export function scoreSignals(s: MapaSignals): PriorityResult {
	let score = 0
	const reasons: string[] = []
	const add = (points: number, text: string) => {
		score += points
		reasons.push(`${text} (+${points})`)
	}

	if (s.vdOver && s.vdMonths !== undefined && s.vdLimitMonths !== undefined) {
		const over = Math.max(0, s.vdMonths - s.vdLimitMonths)
		add(40 + Math.min(20, over), `v.d. ${n(s.vdMonths, "mesec")}, zakonski rok ${s.vdLimitMonths}`)
	}
	if (s.vdChainMonths !== undefined && s.vdChainMonths >= 24) {
		add(15, `lanac v.d. ${n(s.vdChainMonths, "mesec")}${s.vdChainCount ? ` (${n(s.vdChainCount, "uzastopniVd")})` : ""}`)
	}
	if (s.nwpShare !== undefined && s.nwpShare > 0.05) add(15, `bez objave javnog poziva ${pct(s.nwpShare)} vrednosti`)
	if (s.nwpCount !== undefined && s.nwpCount >= 5) add(5, `${n(s.nwpCount, "postupak")} bez objave javnog poziva`)
	if (s.topSupplierShare !== undefined && s.topSupplierShare > 0.4) add(10, `najveći dobavljač ${pct(s.topSupplierShare)} vrednosti`)
	if (s.iwFlags) add(Math.min(15, 3 * s.iwFlags), `${n(s.iwFlags, "dobavljac")} ${s.iwFlags % 10 === 1 && s.iwFlags % 100 !== 11 ? "označen" : "označeno"} u Integrity Watch`)
	if (s.driQualified) add(Math.min(20, 10 * s.driQualified), `${n(s.driQualified, "driMisljenje")}`)
	if (s.driReports !== undefined && s.driReports >= 5) add(5, `DRI: ${n(s.driReports, "izvestaj")}`)
	let sharedPoints = 0
	for (const sh of s.sharedSuppliers ?? []) {
		const points = Math.min(SHARED_SUPPLIER_POINTS, SHARED_SUPPLIER_MAX - sharedPoints)
		if (points <= 0) break
		sharedPoints += points
		add(points, `Isti dobavljač u ${n(sh.institutions, "institucija")}: ${sh.name}`)
	}
	return { score, reasons }
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
