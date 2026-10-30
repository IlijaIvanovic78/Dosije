// Appointment acts from the Službeni glasnik RS, read from the public issue tables of contents on paragraf.rs
// (robots.txt allows /glasila/, the pages are free "BESPLATNO" listings, no login).
//
// Limits (see docs/data-sources/legal.md): a listing gives only the TITLE of an act, e.g.
// "Rešenje o imenovanju vršioca dužnosti generalnog direktora ... Infrastruktura železnice Srbije", never the
// person's name (the act text is behind the paid Paragraf Lex / Službeni glasnik subscription). So the person is
// used only to pick the date window (taken from the ACAS register); a match proves that SOME act of that type for
// that institution was published in that window, not who it names. The date returned is the gazette issue date.

import { SRC, shortInstitution } from "../activity"
import { cached, cacheKey } from "../cache"
import { getText, HttpError } from "../http"
import { asciiFold, normalizeName, nameSimilarity } from "../translit"
import type { AppointmentAct, Official } from "../types"
import { getOfficials, searchPerson } from "./acas"

const SOURCE = "paragraf"
const ISSUE_URL = (year: number, n: number) => `https://www.paragraf.rs/glasila/rs/sluzbeni-glasnik-republike-srbije-${n}-${year}.html`
const MAX_ISSUE_NUMBER = 170
const DAYS_BEFORE = 3
const DAYS_AFTER = 21
const MAX_DATES = 4
const DAY_MS = 86_400_000

interface IssueData {
	n: number
	year: number
	exists: boolean
	date?: string // ISO, gazette issue date
	acts: string[] // only appointment/dismissal-type titles
}

const PERSONNEL_ACT = /IMENOVANJ|POSTAVLJENJ|RAZRE[ŠS]ENJ|PRESTAN|VR[ŠS]IOC|SMENJIV|RASPOREĐIV/i

function decode(s: string): string {
	return s
		.replace(/&quot;/g, '"')
		.replace(/&amp;/g, "&")
		.replace(/&#0?39;/g, "'")
		.replace(/&nbsp;/g, " ")
}

function parseIssue(html: string, year: number, n: number): IssueData {
	const title = /<title>[^<]*?broj\s+(\d+)\/(\d{4})\s+od\s+(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(html)
	if (!title) return { n, year, exists: false, acts: [] }
	const date = `${title[5]}-${title[4].padStart(2, "0")}-${title[3].padStart(2, "0")}`
	const acts: string[] = []
	for (const m of html.matchAll(/<li>([\s\S]*?)<\/li>/g)) {
		const text = decode(m[1].replace(/<[^>]+>/g, " "))
			.replace(/\(\s*"Sl\. glasnik RS"[^)]*\)/g, "")
			.replace(/\s+/g, " ")
			.trim()
		if (text && PERSONNEL_ACT.test(text) && /^(REŠENJE|RESENJE|ODLUKA|ZAKLJUČAK|ZAKLJUCAK)/i.test(text)) acts.push(text)
	}
	return { n, year, exists: true, date, acts }
}

async function issue(year: number, n: number): Promise<IssueData> {
	const env = await cached(SOURCE, cacheKey("sg", year, n), async () => {
		try {
			return parseIssue(await getText(ISSUE_URL(year, n)), year, n)
		} catch (err) {
			if (err instanceof HttpError && err.status === 404) return { n, year, exists: false, acts: [] } satisfies IssueData
			throw err
		}
	}, { activity: { ...SRC.sg, action: "dokument", label: `Službeni glasnik br. ${n}/${year}`, url: ISSUE_URL(year, n), after: (d, h) => h.items(d.acts.length) } })
	return env.data
}

/** Smallest issue number of `year` whose date is >= targetIso (binary search; issue dates grow with the number). */
async function firstIssueOnOrAfter(year: number, targetIso: string): Promise<number> {
	let lo = 1
	let hi = MAX_ISSUE_NUMBER
	while (lo < hi) {
		const mid = Math.floor((lo + hi) / 2)
		const d = await issue(year, mid)
		if (d.exists && d.date && d.date < targetIso) lo = mid + 1
		else hi = mid
	}
	return lo
}

async function issuesBetween(fromIso: string, toIso: string): Promise<IssueData[]> {
	const out: IssueData[] = []
	const y0 = Number(fromIso.slice(0, 4))
	const y1 = Number(toIso.slice(0, 4))
	for (let year = y0; year <= y1; year++) {
		const start = year === y0 ? fromIso : `${year}-01-01`
		let n = await firstIssueOnOrAfter(year, start)
		for (let guard = 0; guard < 30; guard++, n++) {
			const d = await issue(year, n)
			if (!d.exists || !d.date || d.date > toIso) break
			out.push(d)
		}
	}
	return out
}

function shiftDays(iso: string, days: number): string {
	return new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)
}

function institutionTokens(name: string): string[] {
	return normalizeName(name).split(" ").filter((t) => t.length > 2)
}

function sentenceCase(title: string): string {
	const lower = title.toLowerCase()
	const cased = lower.charAt(0).toUpperCase() + lower.slice(1)
	return cased
		.replace(/"([^"]+)"/g, (_m, q: string) => `"${q.replace(/(^|[\s\-])(\p{L})/gu, (_x, p: string, c: string) => p + c.toUpperCase())}"`)
		.replace(/,\s+(\p{L})([\p{L} ]*)$/u, (_m, c: string, rest: string) => `, ${c.toUpperCase()}${rest}`)
}

function keyDates(officials: Official[]): string[] {
	const dates = new Set<string>()
	for (const o of [...officials].sort((a, b) => (b.from ?? "").localeCompare(a.from ?? ""))) {
		if (o.from) dates.add(o.from)
		if (o.to) dates.add(o.to)
		if (dates.size >= MAX_DATES * 2) break
	}
	return [...dates].sort().reverse().slice(0, MAX_DATES)
}

export async function findAppointmentActs(institutionName: string, personName?: string): Promise<AppointmentAct[]> {
	const env = await cached(SOURCE, cacheKey("acts", institutionName, personName), async () => {
		let officials: Official[]
		if (personName) {
			officials = (await searchPerson(personName)).filter((o) => nameSimilarity(o.institutionName, institutionName) >= 0.6)
		} else {
			officials = (await getOfficials({ name: institutionName })).filter((o) => o.isActing)
		}
		const tokens = institutionTokens(institutionName)
		if (!tokens.length) return []

		const seen = new Set<string>()
		const acts: AppointmentAct[] = []
		for (const date of keyDates(officials)) {
			const issues = await issuesBetween(shiftDays(date, -DAYS_BEFORE), shiftDays(date, DAYS_AFTER))
			for (const iss of issues) {
				for (const raw of iss.acts) {
					const folded = asciiFold(raw)
					if (!tokens.every((t) => folded.includes(t))) continue
					const key = `${iss.year}/${iss.n}/${raw}`
					if (seen.has(key)) continue
					seen.add(key)
					acts.push({
						title: sentenceCase(raw),
						date: iss.date,
						gazette: `Službeni glasnik RS, br. ${iss.n}/${iss.year}`,
						url: ISSUE_URL(iss.year, iss.n),
						source: {
							kind: "paragraf",
							title: `Paragraf Lex – Službeni glasnik RS, br. ${iss.n}/${iss.year} (sadržaj broja)`,
							url: ISSUE_URL(iss.year, iss.n),
							retrievedAt: new Date().toISOString(),
							publishedAt: iss.date,
							official: false,
						},
					})
				}
			}
		}
		return acts.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))
	}, {
		activity: {
			...SRC.sg,
			action: "pretraga",
			label: `akti o imenovanju: ${shortInstitution(institutionName)}${personName ? ` (${personName})` : ""}`,
			url: "https://www.paragraf.rs/glasila/",
			after: (d, h) => {
				h.items(d.length)
				const issues = [...new Set(d.map((a) => /br\. (\d+\/\d{4})/.exec(a.gazette ?? "")?.[1]).filter((x): x is string => !!x))].slice(0, 3)
				if (issues.length) h.label(`akti o imenovanju: ${shortInstitution(institutionName)} · Sl. glasnik br. ${issues.join(", ")}`)
			},
		},
	})
	return env.data
}
