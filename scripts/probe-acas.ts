// Warms the cache for the demo case (Infrastruktura železnice Srbije a.d.) and prints compact summaries.
//   $env:DATA_MODE="live"; npx.cmd tsx scripts/probe-acas.ts     (fetch everything, refresh data/cache/{acas,paragraf,pep})
//   $env:DATA_MODE="cache"; npx.cmd tsx scripts/probe-acas.ts    (prove the offline path works)

import { getDataMode } from "../src/data/cache"
import { monthsBetween, ruleFor } from "../src/data/rules/vdRules"
import { findInstitution, getAssetReports, getOfficials, searchPerson } from "../src/data/sources/acas"
import { findAppointmentActs } from "../src/data/sources/paragraf"
import { matchPep } from "../src/data/sources/pep"
import type { Official } from "../src/data/types"

const INSTITUTION = "Infrastruktura železnice Srbije a.d."
const MAIN_PERSON = "Zoran Jevtić"
let failures = 0

async function step<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
	const t = Date.now()
	try {
		const out = await fn()
		console.log(`\n== ${label} (${Date.now() - t} ms)`)
		return out
	} catch (err) {
		failures++
		console.log(`\n== ${label} FAILED: ${err instanceof Error ? err.message : String(err)}`)
		return undefined
	}
}

function line(o: Official): string {
	return `${o.id} | ${o.fullName} | ${o.position}${o.isActing ? " [v.d.]" : ""} | ${o.from ?? "?"} -> ${o.to ?? "danas"} | postavio: ${o.appointedBy ?? "?"}`
}

console.log(`DATA_MODE=${getDataMode()}`)

const institutions = await step("acas.findInstitution", () => findInstitution(INSTITUTION))
if (institutions) for (const i of institutions) console.log(`${i.id} | ${i.name} | ${i.nameCyr}`)
const inst = institutions?.[0]

const officials = inst
	? await step("acas.getOfficials", () => getOfficials({ acasId: inst.id, name: inst.name, nameCyr: inst.nameCyr }))
	: undefined
if (officials) for (const o of officials) console.log(line(o))

const jevtic = officials?.find((o) => o.fullName === MAIN_PERSON && !o.to)
if (jevtic?.from) {
	const rule = ruleFor("drustvo_kapitala_drzavno")
	const today = new Date().toISOString().slice(0, 10)
	const d = monthsBetween(jevtic.from, today)
	console.log(`   v.d. ${d.months} mes. ${d.days} d. (limit ${rule?.maxMonths} mes., ${rule?.article})`)
}

// Current officials plus the recent acting directors (they are the ones the dossier compares).
const wanted = (officials ?? []).filter((o) => !o.to || o.isActing)
const byId = new Map(wanted.map((o) => [o.id, o]))
for (const o of byId.values()) {
	const reports = await step(`acas.getAssetReports ${o.fullName}`, () => getAssetReports(o.id, o.fullName))
	if (!reports) continue
	if (!reports.length) console.log("   (nema izveštaja u registru)")
	for (const r of reports) {
		console.log(`   ${r.reportDate ?? "?"} | ${r.reason ?? "?"} | ${r.source.url}`)
		for (const s of r.summary) console.log(`      - ${s.slice(0, 200)}`)
	}
}

const same = await step(`acas.searchPerson ${MAIN_PERSON}`, () => searchPerson(MAIN_PERSON))
if (same) for (const o of same) console.log(`${line(o)} | ${o.institutionName}`)

const acts = await step("paragraf.findAppointmentActs", () => findAppointmentActs(INSTITUTION, MAIN_PERSON))
if (acts) {
	if (!acts.length) console.log("(nema pronađenih akata)")
	for (const a of acts) console.log(`${a.date} | ${a.gazette} | ${a.title.slice(0, 120)} | ${a.url}`)
}

const pep = await step(`pep.matchPep ${MAIN_PERSON}`, () => matchPep(MAIN_PERSON))
if (pep) {
	if (!pep.length) console.log("(nema podudaranja)")
	for (const m of pep) console.log(`${m.dataset} | ${m.name} | ${m.score} | ${m.url}`)
}

console.log(`\nDone, ${failures} failed step(s).`)
process.exit(failures ? 1 : 0)
