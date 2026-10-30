// Legal limits for acting heads (v.d.). Article numbers and wording verified against the law texts on
// paragraf.rs (free full text) on 2026-10-30; quoted provisions and notes: docs/data-sources/legal.md.
// LegalTypes without a rule here ("lokalna_samouprava", "ostalo") return undefined from ruleFor(): the system
// must then say that no limit was checked, never assume one.

import type { LegalType, VdRule } from "../types"

export const VD_RULES: VdRule[] = [
	{
		id: "ZJP_52",
		legalType: "javno_preduzece",
		law: 'Zakon o javnim preduzećima ("Sl. glasnik RS", br. 15/2016 i 88/2019)',
		article: "čl. 52 st. 1-3",
		maxMonths: 12,
		summary:
			"Vršilac dužnosti direktora javnog preduzeća može se imenovati do imenovanja direktora po javnom konkursu; period obavljanja funkcije ne može biti duži od jedne godine, a isto lice ne može biti dva puta imenovano za vršioca dužnosti.",
		url: "https://www.paragraf.rs/propisi/zakon_o_javnim_preduzecima.html",
	},
	{
		id: "ZUPD_23",
		legalType: "drustvo_kapitala_drzavno",
		law: 'Zakon o upravljanju privrednim društvima koja su u vlasništvu Republike Srbije ("Sl. glasnik RS", br. 76/2023)',
		article: "čl. 23 st. 2",
		maxMonths: 12,
		summary:
			"Do imenovanja direktora društva kapitala po javnom konkursu imenuje se vršilac dužnosti direktora, bez konkursa, a najduže na period do godinu dana. (Za društvo kapitala u 100% državnom vlasništvu čl. 52 Zakona o javnim preduzećima, preko njegovog čl. 53 st. 2, takođe propisuje najviše godinu dana.)",
		url: "https://www.paragraf.rs/propisi/zakon-o-upravljanju-privrednim-drustvima-koja-su-u-vlasnistvu-republike-srbije.html",
	},
	{
		id: "ZZZ_117",
		legalType: "zdravstvena_ustanova",
		law: 'Zakon o zdravstvenoj zaštiti ("Sl. glasnik RS", br. 25/2019, 92/2023 - autentično tumačenje i 29/2025 - odluka US)',
		article: "čl. 117 st. 1",
		maxMonths: 6,
		summary:
			"Osnivač imenuje vršioca dužnosti direktora zdravstvene ustanove na period ne duži od šest meseci, koji može imati samo jedan mandat.",
		url: "https://www.paragraf.rs/propisi/zakon_o_zdravstvenoj_zastiti.html",
	},
	{
		id: "ZDS_67A",
		legalType: "organ_drzavne_uprave",
		law: 'Zakon o državnim službenicima ("Sl. glasnik RS", br. 79/2005 i kasnije izmene, poslednja 80/2026)',
		article: "čl. 67a st. 1 i 4",
		maxMonths: 6,
		extensionMonths: 3,
		summary:
			"Do postavljenja državnog službenika na položaj može biti postavljen vršilac dužnosti na ukupni period do najviše šest meseci; ako se konkurs ne okonča postavljenjem ili ne uspe, status se može produžiti najduže još tri meseca.",
		url: "https://www.paragraf.rs/propisi/zakon_o_drzavnim_sluzbenicima.html",
	},
]

export function ruleFor(legalType: LegalType): VdRule | undefined {
	return VD_RULES.find((r) => r.legalType === legalType)
}

function parseDay(iso: string): { y: number; m: number; d: number } {
	const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
	if (!m) throw new Error(`monthsBetween: not an ISO date: ${iso}`)
	return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) }
}

/** Whole calendar months from `fromIso` to `toIso` plus the remaining days (0/0 if `toIso` is not after `fromIso`). */
export function monthsBetween(fromIso: string, toIso: string): { months: number; days: number } {
	const a = parseDay(fromIso)
	const b = parseDay(toIso)
	const start = Date.UTC(a.y, a.m - 1, a.d)
	const end = Date.UTC(b.y, b.m - 1, b.d)
	if (end <= start) return { months: 0, days: 0 }

	let months = (b.y - a.y) * 12 + (b.m - a.m)
	if (b.d < a.d) months--
	// Anniversary day clamped to the target month's length (31 Jan + 1 month = 28/29 Feb).
	const total = a.m - 1 + months
	const y = a.y + Math.floor(total / 12)
	const mo = ((total % 12) + 12) % 12
	const anniversary = Date.UTC(y, mo, Math.min(a.d, new Date(Date.UTC(y, mo + 1, 0)).getUTCDate()))
	return { months, days: Math.round((end - anniversary) / 86_400_000) }
}
