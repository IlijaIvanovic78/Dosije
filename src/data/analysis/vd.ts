// Deterministic analysis of acting heads (v.d.): legal limit check for one person and the chain of acting heads.
// Pure functions over ACAS officials + the rule table. They state facts and "signals for verification", never verdicts.

import { n } from "../../shared/plural"
import type { SourceRef } from "../../shared/types"
import { monthsBetween, ruleFor } from "../rules/vdRules"
import type { LegalType, Official, VdRule } from "../types"

export function todayIso(): string {
	return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Belgrade", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())
}

export function formatDate(iso?: string): string {
	const m = iso ? /^(\d{4})-(\d{2})-(\d{2})/.exec(iso) : null
	return m ? `${m[3]}.${m[2]}.${m[1]}.` : (iso ?? "nepoznat datum")
}

function parse(iso: string): number {
	const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
	if (!m) return Number.NaN
	return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

export function daysBetween(fromIso: string, toIso: string): number {
	return Math.round((parse(toIso) - parse(fromIso)) / 86_400_000)
}

export function addMonthsIso(iso: string, months: number): string {
	const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
	if (!m) return iso
	const total = Number(m[2]) - 1 + months
	const y = Number(m[1]) + Math.floor(total / 12)
	const mo = ((total % 12) + 12) % 12
	const day = Math.min(Number(m[3]), new Date(Date.UTC(y, mo + 1, 0)).getUTCDate())
	return new Date(Date.UTC(y, mo, day)).toISOString().slice(0, 10)
}

export function monthsLabel(months: number): string {
	return n(months, "mesec")
}

export function daysLabel(days: number): string {
	return n(days, "dan")
}

export function ruleSource(rule: VdRule): SourceRef {
	return {
		kind: "zakon",
		title: `${rule.law}, ${rule.article}`,
		url: rule.url,
		retrievedAt: new Date().toISOString(),
		official: true,
	}
}

export interface VdCheck {
	person: string
	personId: string
	position: string
	isActing: boolean
	appointedBy?: string
	from?: string
	today: string
	months: number
	days: number
	applicable: boolean // false when the person is not acting or no rule exists for the legal type
	rule?: { id: string; law: string; article: string; maxMonths: number; extensionMonths?: number; summary: string }
	alsoPossible: { id: string; law: string; article: string; maxMonths: number }[]
	overLimit: boolean
	daysOver: number
	nearLimit: boolean
	limitDate?: string
	explanation: string
	sources: SourceRef[]
}

export function checkVd(official: Official, inst: { legalType: LegalType }, today = todayIso()): VdCheck {
	const base = {
		person: official.fullName,
		personId: official.id,
		position: official.position,
		isActing: official.isActing,
		appointedBy: official.appointedBy,
		from: official.from,
		today,
		months: 0,
		days: 0,
		alsoPossible: [] as VdCheck["alsoPossible"],
		overLimit: false,
		daysOver: 0,
		nearLimit: false,
		sources: [official.source],
	}
	if (!official.isActing) {
		return { ...base, applicable: false, explanation: `${official.fullName} u registru ACAS nije vođen/a kao vršilac dužnosti (${official.position}); provera roka za v.d. se ne primenjuje.` }
	}
	if (!official.from) {
		return { ...base, applicable: false, explanation: "ACAS ne navodi datum stupanja na funkciju, pa se trajanje v.d. statusa ne može izračunati." }
	}
	const { months, days } = monthsBetween(official.from, official.to ?? today)
	const rule = ruleFor(inst.legalType)
	const withTime = { ...base, months, days }
	if (!rule) {
		return {
			...withTime,
			applicable: false,
			explanation: `${official.fullName} je v.d. od ${formatDate(official.from)} (${monthsLabel(months)} i ${daysLabel(days)}), ali za pravni oblik ustanove nema proverenog propisa o najdužem trajanju v.d. statusa: rok nije proveren.`,
		}
	}
	const alsoPossible = [ruleFor(inst.legalType === "drustvo_kapitala_drzavno" ? "javno_preduzece" : inst.legalType === "javno_preduzece" ? "drustvo_kapitala_drzavno" : inst.legalType)]
		.filter((r): r is VdRule => !!r && r.id !== rule.id)
		.map((r) => ({ id: r.id, law: r.law, article: r.article, maxMonths: r.maxMonths }))
	const limitDate = addMonthsIso(official.from, rule.maxMonths + (rule.extensionMonths ?? 0))
	const overLimit = !official.to && (months > rule.maxMonths + (rule.extensionMonths ?? 0) || (months === rule.maxMonths + (rule.extensionMonths ?? 0) && days > 0))
	const daysOver = overLimit ? Math.max(0, daysBetween(limitDate, today)) : 0
	const nearLimit = !official.to && !overLimit && months >= rule.maxMonths - 2
	const explanation = overLimit
		? `Prema ACAS, ${official.fullName} je ${official.position.toLowerCase().startsWith("v.d.") ? "" : "na funkciji "}${official.position} od ${formatDate(official.from)}, što je ${monthsLabel(months)} i ${daysLabel(days)}. ${rule.law}, ${rule.article}, propisuje najviše ${monthsLabel(rule.maxMonths + (rule.extensionMonths ?? 0))}; rok je istekao ${formatDate(limitDate)} (pre ${daysLabel(daysOver)}). Signal za proveru: treba utvrditi koji propis važi za ovu instituciju i postoji li novo rešenje o imenovanju.`
		: `${official.fullName} je v.d. od ${formatDate(official.from)} (${monthsLabel(months)} i ${daysLabel(days)}); ${rule.law}, ${rule.article}, propisuje najviše ${monthsLabel(rule.maxMonths + (rule.extensionMonths ?? 0))}.`
	return {
		...withTime,
		applicable: true,
		rule: { id: rule.id, law: rule.law, article: rule.article, maxMonths: rule.maxMonths, extensionMonths: rule.extensionMonths, summary: rule.summary },
		alsoPossible,
		overLimit,
		daysOver,
		nearLimit,
		limitDate,
		explanation,
		sources: [official.source, ruleSource(rule)],
	}
}

// ─── head of the institution + chain of acting heads ────────────────────────

const HEAD_POSITION = /(direktor|predsednik|na[čc]elnik|ministar)/i
const NOT_HEAD = /(skup[šs]tin|odbor|[čc]lan|zamenik|pomo[ćc]nik|savet|komisij|sekretar|izvr[šs]n|sektor|slu[žz]b|odeljenj|jedinic|v\.?d\.?\s+na[čc]elnik\w*\s+(uprav|odeljenj|slu))/i

export function isHeadPosition(position: string): boolean {
	return HEAD_POSITION.test(position) && !NOT_HEAD.test(position)
}

/** 3 = mayor / minister / municipality head, 2 = director or president of the body, 1 = načelnik (of a department), 0 = not a head. */
export function headRank(position: string): number {
	if (!isHeadPosition(position)) return 0
	if (/ministar|gradona[čc]elnik|predsednik\s+op[šs]tin/i.test(position)) return 3
	if (/direktor|predsednik/i.test(position)) return 2
	return 1
}

// One person holds these roles at a time; the register sometimes never closes the earlier record when a successor is entered
// (Srbija Kargo: "v.d. generalnog direktora" from 2017 without an end date next to the one from 2025).
const SINGULAR_ROLE = /(direktor|predsednik|na[čc]elnik|zamenik)/i

const samePosition = (a: Official, b: Official) => a.position.trim().toLowerCase() === b.position.trim().toLowerCase()

/** Records without an end date that a later record for the same single-holder role has replaced (the register did not close them). */
export function supersededOpen(officials: Official[]): Set<Official> {
	const out = new Set<Official>()
	for (const o of officials) {
		if (o.to || !o.from || !SINGULAR_ROLE.test(o.position)) continue
		const successor = officials.some((p) => p !== o && !!p.from && p.from > o.from! && (isHeadPosition(o.position) ? headRank(p.position) >= headRank(o.position) : samePosition(o, p)))
		if (successor) out.add(o)
	}
	return out
}

/** Officials in office now: no end date and not replaced by a later record of the same role. */
export function currentOfficials(officials: Official[]): Official[] {
	const stale = supersededOpen(officials)
	return officials.filter((o) => !o.to && !stale.has(o))
}

/** Head = the current official with the latest start among direktor / predsednik / načelnik (not "član", "skupštine"...). */
export function pickHead(officials: Official[]): Official | undefined {
	const current = currentOfficials(officials)
	const latest = (list: Official[]) => [...list].sort((a, b) => (b.from ?? "").localeCompare(a.from ?? ""))[0]
	const heads = current.filter((o) => isHeadPosition(o.position))
	if (heads.length) {
		const best = Math.max(...heads.map((o) => headRank(o.position)))
		return latest(heads.filter((o) => headRank(o.position) === best))
	}
	// a board chair is not the head: with no director in the register the head is unknown (never guessed)
	return undefined
}

export function pickOthers(officials: Official[], head: Official | undefined, n = 2): Official[] {
	return currentOfficials(officials)
		.filter((o) => o.id !== head?.id)
		.slice(0, n)
}

export interface PastVd {
	name: string
	position: string
	from: string
	to: string
	months: number
	days: number
	maxMonths: number
	law: string
	article: string
}

/** Finished terms of acting heads that lasted longer than the limit for this legal form (facts from the register's dates, newest first). */
export function pastActingOverLimit(officials: Official[], legalType: LegalType): { terms: PastVd[]; rule?: VdRule } {
	const rule = ruleFor(legalType)
	if (!rule) return { terms: [] }
	const max = rule.maxMonths + (rule.extensionMonths ?? 0)
	const seen = new Set<string>()
	const terms: PastVd[] = []
	for (const o of officials) {
		if (!o.isActing || !o.from || !o.to || !isHeadPosition(o.position)) continue
		const key = `${o.fullName}|${o.from}|${o.to}`
		if (seen.has(key)) continue
		seen.add(key)
		const { months, days } = monthsBetween(o.from, o.to)
		if (months > max) terms.push({ name: o.fullName, position: o.position, from: o.from, to: o.to, months, days, maxMonths: max, law: rule.law, article: rule.article })
	}
	return { terms: terms.sort((a, b) => b.from.localeCompare(a.from)), rule }
}
/** Earlier acting terms of the same person in a head position, before the current record (the laws for public enterprises and health care allow one acting mandate). */
export function earlierActingTerms(officials: Official[], head: Official): { from: string; to?: string }[] {
	const seen = new Set<string>()
	const out: { from: string; to?: string }[] = []
	for (const o of officials) {
		if (o.id !== head.id || o === head || !o.isActing || !o.from || !isHeadPosition(o.position)) continue
		if (head.from && o.from >= head.from) continue
		const key = `${o.from}|${o.to ?? ""}`
		if (seen.has(key)) continue
		seen.add(key)
		out.push({ from: o.from, to: o.to })
	}
	return out.sort((a, b) => a.from.localeCompare(b.from))
}
export interface VdChain {
	heads: { name: string; personId: string; position: string; from?: string; to?: string; months: number; days: number; acting: boolean; endInferred?: boolean }[]
	actingCount: number
	onlyActing: boolean
	since?: string
	totalMonths: number
	totalDays: number
	gaps: { from: string; to: string; days: number }[]
	currentName?: string
	explanation: string
	sources: SourceRef[]
}

/** Chain of consecutive acting heads from the ACAS history. null when there is nothing to report (fewer than 2 heads or any non-acting head). */
export function analyzeVdChain(officials: Official[], today = todayIso(), legalType?: LegalType): VdChain | null {
	const heads = officials
		.filter((o) => isHeadPosition(o.position) && o.from)
		.sort((a, b) => (a.from ?? "").localeCompare(b.from ?? ""))
	if (heads.length < 2) return null
	const onlyActing = heads.every((h) => h.isActing)
	if (!onlyActing) return null
	const stale = supersededOpen(heads)
	const rows = heads.map((h, i) => {
		// a record the register never closed ends where the next head starts
		const endInferred = stale.has(h)
		const to = endInferred ? heads.slice(i + 1).find((x) => (x.from ?? "") > (h.from ?? ""))?.from : h.to
		const { months, days } = monthsBetween(h.from as string, to ?? today)
		return { name: h.fullName, personId: h.id, position: h.position, from: h.from, to, months, days, acting: h.isActing, endInferred }
	})
	const since = rows[0].from
	const total = monthsBetween(since as string, today)
	const gaps: VdChain["gaps"] = []
	for (let i = 1; i < rows.length; i++) {
		const prevEnd = rows[i - 1].to
		const start = rows[i].from
		if (prevEnd && start) {
			const days = daysBetween(prevEnd, start)
			if (days > 30) gaps.push({ from: prevEnd, to: start, days })
		}
	}
	const current = rows.find((r) => !r.to)
	const list = rows.map((r) => `${r.name} (${formatDate(r.from)} do ${r.to ? formatDate(r.to) : "danas"}${r.endInferred ? ", kraj nije upisan u registru: uzet je početak sledećeg v.d." : ""})`).join("; ")
	const gapText = gaps.length ? ` U registru postoje prekidi duži od 30 dana: ${gaps.map((g) => `${daysLabel(g.days)} (${formatDate(g.from)} do ${formatDate(g.to)})`).join("; ")}.` : ""
	const explanation = `Prema ACAS registru, od ${formatDate(since)} (${monthsLabel(total.months)}) instituciju vode isključivo vršioci dužnosti: ${n(rows.length, "uzastopniVd")} na čelu institucije, ${list}.${gapText} Činjenični obrazac za proveru, ne zaključak o kršenju propisa: ${legalType === "drustvo_kapitala_drzavno" ? "Zakon o upravljanju privrednim društvima u vlasništvu RS (76/2023) primenjuje se tek od 15.09.2024, a registar" : "registar"} sadrži samo funkcionere koji su podneli prijavu.`
	return {
		heads: rows,
		actingCount: rows.length,
		onlyActing,
		since,
		totalMonths: total.months,
		totalDays: total.days,
		gaps,
		currentName: current?.name,
		explanation,
		sources: [heads[heads.length - 1].source],
	}
}
