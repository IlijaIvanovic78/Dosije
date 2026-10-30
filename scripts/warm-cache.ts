// Populates data/cache/ with every data call the agents' tools make for one institution (default: the demo case), so the
// demo runs offline with DATA_MODE=cache.
//
//   npx.cmd tsx scripts/warm-cache.ts "Infrastruktura železnice Srbije"            (cache first, fetch what is missing)
//   npx.cmd tsx scripts/warm-cache.ts "Infrastruktura železnice Srbije" --refresh   (DATA_MODE=live: refetch everything)

import { config } from "../src/config"

const args = process.argv.slice(2)
const refresh = args.includes("--refresh")
if (refresh) process.env.DATA_MODE = "live"
else if (!process.env.DATA_MODE || process.env.DATA_MODE === "cache") process.env.DATA_MODE = "auto"
const input = args.filter((a) => !a.startsWith("--")).join(" ").trim() || "Infrastruktura železnice Srbije"

const data = await import("../src/data")
const { pickHead, pickOthers } = await import("../src/data/analysis/vd")
const { pickFirmCandidates } = await import("../src/data/analysis/procurement")
const { lookupSupplierMb } = await import("../src/data/analysis/firms")

let ok = 0
let failed = 0
async function step<T>(label: string, fn: () => Promise<T>, soft = false): Promise<T | undefined> {
	const t0 = Date.now()
	try {
		const r = await fn()
		ok++
		console.log(`  ok    ${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s  ${label}`)
		return r
	} catch (err) {
		if (!soft) failed++
		console.log(`  ${soft ? "skip" : "FAIL"}  ${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s  ${label}: ${(err as Error).message.slice(0, 140)}`)
		return undefined
	}
}

console.log(`Warm cache: "${input}" · DATA_MODE=${process.env.DATA_MODE} (config: ${config.dataMode})`)
const ref = await step("razrešavač: institucija", () => data.resolveInstitution(input))
if (!ref) process.exit(1)
console.log(`  -> ${ref.name} (ACAS ${ref.acasId ?? "-"}, JN ${ref.jnId ?? "-"}, MB ${ref.mb ?? "-"})\n`)

// Kadrovik
const officials = (await step("acas: funkcioneri", () => data.acas.getOfficials({ acasId: ref.acasId, altIds: ref.acasAltIds, name: ref.name, nameCyr: ref.nameCyr }))) ?? []
const head = pickHead(officials)
const people = [head, ...pickOthers(officials, head, 2)].filter((o): o is NonNullable<typeof head> => !!o)
if (head) {
	await step(`paragraf: akti (${head.fullName})`, () => data.paragraf.findAppointmentActs(ref.name, head.fullName))
	await step(`acas: pretraga osobe (${head.fullName})`, () => data.acas.searchPerson(head.fullName))
}
// Imovina + Mediji · osoba + PEP
for (const p of people) {
	await step(`acas: imovina (${p.fullName})`, () => data.acas.getAssetReports(p.id, p.fullName))
	const pp = data.personNewsPlan(p.fullName, ref)
	await step(`vesti: ${p.fullName} + institucija (730 dana)`, () => data.news.searchNews(pp.query, pp.opts))
	await step(`pep: ${p.fullName}`, () => data.pep.matchPep(p.fullName))
}
// Nabavke + Firme
const links = (await step("integrity watch: veze institucije", () => data.iw.getLinksForAuthority({ name: ref.name, pib: ref.pib }))) ?? []
const inst = { name: ref.name, jnId: ref.jnId, pib: ref.pib }
const analysis = await step("jn: pregled + analiza nabavki", () => data.analysis.analyzeProcurement(inst, links))
for (const c of analysis ? pickFirmCandidates(analysis.candidates, config.budget.maxFirme, 2) : []) {
	const mb = lookupSupplierMb(c.pib)?.mb
	await step(`firma: ${c.name.slice(0, 40)} (PIB ${c.pib}${mb ? `, MB ${mb}` : ", MB nepoznat"})`, () => data.analysis.analyzeFirm(inst, { name: c.name, pib: c.pib, mb }))
}
// Revizor
const reports = (await step("dri: spisak izveštaja", () => data.dri.getReports({ name: ref.name, nameCyr: ref.nameCyr, aliases: ref.aliases }))) ?? []
const wanted = [
	...reports.filter((r) => /pravilnosti/i.test(r.kind ?? "") && !/odaziv|poslerevizion/i.test(r.kind ?? "")).slice(0, 3),
	...reports.filter((r) => /finansijska/i.test(r.kind ?? "")).slice(0, 1),
]
for (const r of wanted) await step(`dri: nalazi ${r.id} (${r.year}, ${r.kind})`, () => data.dri.getReportFindings(r))
// Mediji
const plan = data.institutionNewsPlan(ref)
const found = (await step(`vesti: ${plan.query} (${plan.opts.days} dana; nazivi: ${[plan.query, ...(plan.opts.aliases ?? [])].join(", ")})`, () => data.news.searchNews(plan.query, plan.opts))) ?? []
const recent = found.filter((n) => n.publishedAt && Date.now() - Date.parse(n.publishedAt) <= 90 * 86400e3)
const personPlan = head ? data.personNewsPlan(head.fullName, ref) : undefined
const personNews = personPlan ? ((await step(`vesti: ${head!.fullName} (ponovo za članke)`, () => data.news.searchNews(personPlan.query, personPlan.opts))) ?? []) : []
const articles = [...recent.filter((n) => /sindikat|ostavk/i.test(n.title)).slice(0, 1), ...personNews.filter((n) => /generaln\w*\s+direktor/i.test(n.title)).slice(0, 2)]
for (const a of [...new Map(articles.map((x) => [x.url, x])).values()]) await step(`vesti: članak ${a.url.slice(0, 70)}`, () => data.news.fetchArticle(a.url), true)

console.log(`\nGotovo: ${ok} uspešno, ${failed} neuspešno. Keš: data/cache/.`)
process.exit(failed ? 3 : 0)
