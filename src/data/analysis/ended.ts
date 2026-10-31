// A function the register of officials keeps open although it has ended: the official's own asset report on leaving it
// ("prestanak javne funkcije") gives the end date in the income line of that function. EPS: ACAS lists "v.d. generalnog
// direktora" from 03.03.2022 without an end, while the report of 12.07.2023 says "V.f. direktora, JP EPS Beograd ...
// 04.03.2022. - 15.06.2023.".

import { getAssetReports } from "../sources/acas"
import type { AssetReport, Official } from "../types"
import { daysBetween, pickHead } from "./vd"

const RANGE = /(\d{1,2})\.(\d{1,2})\.(\d{4})\.?\s*[-–]\s*(\d{1,2})\.(\d{1,2})\.(\d{4})/
// the income line names the function: director, acting (v.d. / v.f.), president, minister, head of a body
const FUNCTION_WORDS = /direktor|(^|[^a-z])v\.?\s?[df]\.?(?=[^a-z]|$)|predsednik|ministar|na[čc]elnik/i
// the report's start of the function and the register's may differ by some days, never by months
const SAME_START_DAYS = 62

const iso = (y: string, m: string, d: string) => `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`

/** The end of an open function according to the official's report on leaving it, or undefined when no report says so. */
export function endedByReport(o: Official, reports: AssetReport[]): { to: string; report: AssetReport } | undefined {
	if (o.to || !o.from) return undefined
	for (const r of reports) {
		if (!/prestanak/i.test(r.reason ?? "") || !r.reportDate || r.reportDate < o.from) continue
		for (const income of r.incomes ?? []) {
			const m = RANGE.exec(income.period ?? "")
			if (!m || !FUNCTION_WORDS.test(income.source)) continue
			const start = iso(m[3], m[2], m[1])
			const end = iso(m[6], m[5], m[4])
			if (Math.abs(daysBetween(start, o.from)) > SAME_START_DAYS || end < o.from) continue
			return { to: end, report: r }
		}
	}
	return undefined
}

/**
 * The officials with the head's function closed when the head's own report on leaving says it ended (the record gets that
 * end date and the report as `endedBy`); then the next head is looked at, at most twice. Without reports nothing changes.
 */
export async function closeEndedHeads(officials: Official[]): Promise<Official[]> {
	let list = officials
	for (let round = 0; round < 2; round++) {
		const head = pickHead(list)
		if (!head) break
		const reports = await getAssetReports(head.id, head.fullName).catch(() => [] as AssetReport[])
		const ended = endedByReport(head, reports)
		if (!ended) break
		list = list.map((o) => (o === head ? { ...o, to: ended.to, endedBy: { ...ended.report.source, publishedAt: ended.report.reportDate } } : o))
	}
	return list
}
