// npm run qa [-- --no-links] [--only <slug>] [--write-docs]
// Full scripted case for each institution of the Mapa preset (DATA_MODE=cache, no key, no network for data) and then the checks
// the dossier has to pass: every finding has an http(s) source, every source URL works, every datum belongs to the institution,
// no duplicates, no empty section without a reason, correct Serbian number agreement. Console table + out/qa.md (docs/QA.md only with
// --write-docs, so a plain run leaves tracked files alone). Exit code 1 on errors.

process.env.DATA_MODE = "cache"
process.env.DOSIJE_MODE = "scripted"
process.env.DEMO_SPEED ??= "0.02"
process.env.HUMAN_AUTO_APPROVE_MS = "0"

import fs from "node:fs"
import path from "node:path"
import type { Finding, Section } from "../src/shared/types"

// dynamic imports: static ones are hoisted above the environment settings and would read the wrong data mode
const { applyEntryDefaults } = await import("../src/config")
const { FORMS, plural } = await import("../src/shared/plural")
applyEntryDefaults("test")

const args = process.argv.slice(2)
const skipLinks = args.includes("--no-links")
const writeDocs = args.includes("--write-docs")
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : undefined

const boot = await import("../src/mozaik/boot")
const data = await import("../src/data")
const { loadMapaPreset } = await import("../src/mozaik/mapa")
const { titleNamesInstitution } = await import("../src/data/sources/dri")
const { buildMatcher, wordsOf, nameTokens } = await import("../src/data/newsMatch")
const { nameSimilarity, sameWord, hasCyrillic } = await import("../src/data/translit")

// ─── what was fixed in this iteration (kept with the script: QA.md is generated) ─────────────────────────────

const FIXED: string[] = [
	"Agenti reaguju jedni na druge: Mediji na nalaz Kadrovika o v.d. (VD_PREKO_ROKA, VD_LANAC) ciljanom proverom medija o imenovanju i nazivu funkcije („v.d.“ ili „direktor“), Revizor na nalaz Nabavke (BEZ_OBJAVE, KONCENTRACIJA) potragom za ranijim nalazom DRI iste teme, sa izvorom izveštaja i izvorom Portala u istom nalazu. Svaka reakcija se pokreće najviše jednom po slučaju i oznaci, kao nova petlja istog agenta (poruka „Povod: nalaz …“, događaj `agent.reakcija`).",
	"Rang glavnih signala: zvanični (odobreni) prvi, zatim potvrđeni, pa nepotvrđeni; „akt o imenovanju nije pronađen“ je uvek ispod; najviše jedan nalaz po signalCode (više Integrity Watch oznaka je jedan signal). Pre: nepotvrđena IW oznaka je bila #1.",
	"Status `demantovano` se u svim tekstovima i izveštaju piše „odstupa od registra“; naslov u medijima koji drugačije naziva funkciju nije demant. Beleška: „Zvanični registar (ACAS) navodi «v.d. generalnog direktora»; ovaj izvor navodi «generalni direktor». Prednost ima zvanični registar.“ Bez precrtavanja u izveštaju.",
	"DRI: revidirani period se piše samo kad ga navodi naslov izveštaja („finansijski izveštaji za 2018.“); inače „izveštaj objavljen 25.07.2025.“ (godina objave više nije „revizija za 2025. godinu“). Naslovi izvora DRI su kratki i celi.",
	"Linkovi: ACAS nema javnu rutu za ustanovu ili osobu (samo pretraga i `funkcionerIzvestajDetails/<id>`, proveren u pregledaču), pa izvor nosi uput u naslovu („ACAS registar – pretraga: <naziv>“); Integrity Watch nema stranicu dobavljača („Integrity Watch Srbija – pretraga: <firma>“). Medijski članak koji IW navodi kao osnov povezivanja prikazuje se samo ako članak zaista pominje firmu.",
	"Tekst: dvostruke tačke posle datuma, stavke liste „Šta još treba proveriti“ su cele rečenice (skraćena formulacija umesto seckanja), naslovi DRI nalaza se završavaju na granici izraza, izvor „raspadsistema.com (Danas)“ je samo „Danas“, imena u CLI Ganttu se ne seku („Stegnjaja“, ne „Stegnjaj“). Pregled medija ne uključuje tabloidne mikro-sajtove kad ima bar 5 članaka iz poznatih izdanja (`src/data/sources/news.ts`).",
	"`npm run qa` i `npm test` ne menjaju keš ni praćene fajlove: izveštaj ide u out/qa.md (docs/QA.md samo uz `--write-docs`), a u `DATA_MODE=cache` ništa se ne upisuje u data/cache; negativni rezultati (promašaj razrešavača, prazne pretrage nepoznatih imena) se ne keširaju.",
	"Vesti: pretraga sada koristi tačne fraze na latinici i ćirilici, oba izdanja Google News (sr-Latn i sr) i kratke nazive (IŽS, Srbija voz); članak mora da pominje instituciju (sve značajne reči, sa padežima) u naslovu ili opisu, a članak o osobi i osobu i instituciju/firmu (naslov, opis ili preuzeti tekst). Imenjaci, sportske vesti i čitulje se odbacuju, a ponovljene vesti i agregatori se spajaju (ostaje originalno izdanje). Pre: 0-4 članka po dosijeu, sada 12 meseci istorije i do 12 izvora u nalazu „Pregled medija“.",
	"Vesti: „Železnice Srbije“ više ne hvata članke o „Infrastrukturi železnice Srbije“ (pominjanje unutar duže institucije se ne računa).",
	"DRI: izveštaj ulazi u dosije samo ako naslov imenuje instituciju (i stari naziv „Srbija voz“); zajedničke revizije bez imena institucije u naslovu su izbačene. Vrsta revizije se određuje po prvom pominjanju u naslovu (izveštaji o merama ispravljanja više nisu „finansijska revizija“).",
	"Portal javnih nabavki: Srbijavoz je imao samo 349 ugovora (od 2023); ugovori pod starim nazivom „Србија Воз а.д.“ dodati su preko aliasa, a svi ugovori se zadržavaju samo ako tender pripada šifri naručioca (CAId).",
	"ACAS: zapisi bez datuma prestanka koje je zamenio kasniji zapis za istu funkciju (Srbija Kargo: v.d. od 2017. pored v.d. od 2025.) više se ne računaju kao tekući, niti kvare lanac v.d.",
	"Gramatika: jedinstven pomoćnik za množinu (1 ugovor, 3 ugovora, 7 ugovora) u politikama, rezimeu, izveštaju, razlozima Mape i CLI ispisu; naslovi izvora se seku na granici reči.",
	"Naslovi DRI nalaza su sada naslovi („DRI 2022 · javne nabavke: …“), a doslovan izvod je u tekstu; izvodi koji su ostatak tabele („Preporuka broj …“, „Rezime datih preporuka“) se ne koriste.",
	"Nalaz o sindikatu/ostavkama i ostali pojedinačni medijski nalazi traže da NASLOV imenuje instituciju (članak koji je samo pominje usput ulazi samo u pregled).",
	"Dobavljač koji se pojavljuje samo u zajedničkim ponudama nema naziv na Portalu („PIB 100003172“): u naslovu nalaza se prikazuje naziv iz APR.",
	"Portal javnih nabavki vraća HTTP 500 na direktan link ako posetilac nije prethodno otvorio početnu stranicu (sesija); provera linkova se ponaša kao taj posetilac, a lista „Šta još treba proveriti“ sadrži napomenu o tome.",
	"Keš: obrisani nekorišćeni fajlovi (stari ključevi pretrage vesti i članci na koje se više ne poziva ništa, DRI izvodi zajedničkih revizija, stari ključ Integrity Watch naručioca, izveštaji o imovini osoba koje više nisu u izboru); `CACHE_TRACE` + `scripts/prune-cache.ts` nalaze takve fajlove.",
]

// ─── helpers ───────────────────────────────────────────────────────────────────────────────────────────

type Level = "greška" | "upozorenje"
interface Issue {
	level: Level
	inst: string
	check: string
	message: string
}

const issues: Issue[] = []
const report = (level: Level, inst: string, check: string, message: string) => issues.push({ level, inst, check, message })

const SECTIONS: Section[] = ["rukovodstvo", "novac", "firme", "revizija", "mediji"]
const isHttp = (u: unknown): u is string => typeof u === "string" && /^https?:\/\/\S+$/i.test(u)
const pad = (s: unknown, n: number) => String(s).padEnd(n).slice(0, n)
const rpad = (s: unknown, n: number) => String(s).padStart(n)

interface CaseResult {
	name: string
	slug: string
	findings: Finding[]
	markdown: string
	lede: string
	toVerify: string[]
	top: Finding[]
	bySection: Record<Section, number>
	articles: number
	urls: Set<string>
	attribution: Record<string, string>
	emptyReasons: Partial<Record<Section, string>>
}

// ─── run the six cases ───────────────────────────────────────────────────────────────────────────────

await boot.boot()
const preset = loadMapaPreset().filter((p) => !only || p.slug === only)
const results: CaseResult[] = []
const refs = new Map<string, Awaited<ReturnType<typeof data.resolveInstitution>>>()

for (const p of preset) {
	const t0 = Date.now()
	await boot.startCase(p.name)
	const rep = await boot.waitForDone(120_000)
	const snap = boot.getSnapshot()
	if (!rep) {
		report("greška", p.name, "tok", "dosije nije završen na vreme")
		continue
	}
	const ref = await data.resolveInstitution(p.name)
	refs.set(p.slug, ref)
	const bySection = Object.fromEntries(SECTIONS.map((s) => [s, 0])) as Record<Section, number>
	for (const f of snap.findings) bySection[f.section]++
	const urls = new Set<string>()
	const articleUrls = new Set<string>()
	for (const f of snap.findings) for (const s of f.sources) if (isHttp(s.url)) (urls.add(s.url), s.kind === "vesti" && articleUrls.add(s.url))
	results.push({
		name: ref.name,
		slug: p.slug,
		findings: snap.findings,
		markdown: rep.markdown,
		lede: rep.lede,
		toVerify: rep.toVerify,
		top: rep.topSignals.map((t) => snap.findings.find((f) => f.id === t.findingId)).filter((f): f is Finding => !!f),
		bySection,
		articles: articleUrls.size,
		urls,
		attribution: {},
		emptyReasons: {},
	})
	console.log(`  ${pad(ref.name, 36)} ${snap.findings.length} nalaza, ${((Date.now() - t0) / 1000).toFixed(1)} s`)
}

// the map (reasons are generated text too)
let mapaTexts: string[] = []
if (!only) {
	try {
		await boot.startMapa()
		const view = await boot.waitForMapa(120_000)
		mapaTexts = view.rows.flatMap((r) => [...r.reasons, r.summary ?? ""]).filter(Boolean)
	} catch (err) {
		report("upozorenje", "Mapa", "tok", `mapa nije pokrenuta: ${(err as Error).message}`)
	}
}

// ─── checks: findings and sources ────────────────────────────────────────────────────────────────

for (const r of results) {
	// every finding has a working-looking source
	for (const f of r.findings) {
		if (!f.sources.some((s) => isHttp(s.url))) report("greška", r.name, "izvor", `nalaz bez http(s) izvora: ${f.title}`)
		const seen = new Set<string>()
		for (const s of f.sources) {
			if (seen.has(s.url)) report("upozorenje", r.name, "duplikat", `isti izvor dvaput u nalazu „${f.title}“: ${s.url}`)
			seen.add(s.url)
			// a hard cut leaves exactly the limit's length and no ellipsis
			if ([140, 200].includes(s.title.length) && !/[…).]$/.test(s.title)) report("upozorenje", r.name, "naslov izvora", `naslov izvora iseckan usred reči: ${s.title}`)
		}
	}
	// duplicates: same title, same text
	const titles = new Map<string, number>()
	for (const f of r.findings) titles.set(f.title.trim().toLowerCase(), (titles.get(f.title.trim().toLowerCase()) ?? 0) + 1)
	for (const [t, c] of titles) if (c > 1) report("upozorenje", r.name, "duplikat", `${c}× isti naslov nalaza: ${t}`)
	// the ranking of "Glavni signali": official first, an unconfirmed or "not found" finding never first while a better one exists, one per signalCode
	const rank = (f: Finding) => (f.signalCode === "IMENOVANJE_NEPOZNATO" ? 3 : f.status === "zvanicno" ? 0 : f.status === "potvrdjeno" ? 1 : 2)
	for (let i = 1; i < r.top.length; i++) if (rank(r.top[i]) < rank(r.top[i - 1])) report("greška", r.name, "rang", `„${r.top[i].title}“ (${r.top[i].status}) je ispod slabijeg nalaza`)
	const codes = r.top.map((f) => f.signalCode).filter(Boolean)
	if (new Set(codes).size < codes.length && r.top.length > 3) report("greška", r.name, "rang", `isti signalCode više puta u glavnim signalima: ${codes.join(", ")}`)
	if (r.top[0] && rank(r.top[0]) >= 2 && r.findings.some((f) => f.severity !== "info" && rank(f) < 2 && f.approval !== "rejected" && f.status !== "demantovano")) report("greška", r.name, "rang", `prvi signal je nepotvrđen: ${r.top[0].title}`)
	// the press review
	const review = r.findings.find((f) => f.section === "mediji" && /^Pregled medija:/.test(f.title))
	if (!review) report("upozorenje", r.name, "mediji", "nema nalaza „Pregled medija“ (nema dovoljno članaka koji imenuju instituciju)")
	else if (review.sources.length < 10) report("upozorenje", r.name, "mediji", `„Pregled medija“ ima ${review.sources.length} izvora (cilj 10-12)`)
}

// ─── checks: attribution (the data belongs to THIS institution) ─────────────────────────────────────

for (const r of results) {
	const ref = refs.get(r.slug)!
	const note = (key: string, text: string) => (r.attribution[key] = text)
	const inst = { name: ref.name, jnId: ref.jnId, pib: ref.pib }

	// ACAS
	try {
		const officials = await data.acas.getOfficials({ acasId: ref.acasId, name: ref.name, nameCyr: ref.nameCyr })
		const bad = officials.filter((o) => !titleNamesInstitution(o.institutionName, ref.name))
		const stale = data.analysis.supersededOpen(officials)
		for (const o of bad) report("greška", r.name, "ACAS", `funkcioner „${o.fullName}“ vodi se pod drugom institucijom: ${o.institutionName}`)
		const heads = data.analysis.currentOfficials(officials).filter((o) => data.analysis.isHeadPosition(o.position))
		if (heads.length > 1) report("upozorenje", r.name, "ACAS", `${heads.length} tekućih zapisa za čelnika: ${heads.map((h) => h.fullName).join(", ")}`)
		note("ACAS", `${officials.length} funkcionera, ${bad.length ? `${bad.length} tuđih` : "svi pod nazivom institucije"}${stale.size ? `; ${stale.size} zastarelih zapisa bez datuma prestanka se ignoriše` : ""}`)
		if (officials.length === 0) r.emptyReasons.rukovodstvo = "ACAS nema funkcionere za instituciju"
	} catch (err) {
		report("greška", r.name, "ACAS", `provera nije moguća: ${(err as Error).message}`)
	}

	// Portal javnih nabavki
	try {
		const s = await data.jn.getSummary(inst)
		const contracts = await data.jn.getContracts(inst)
		const okName = titleNamesInstitution(s.institution, ref.name)
		if (!okName) report("greška", r.name, "JN", `naručilac na Portalu je „${s.institution}“, a institucija je „${ref.name}“`)
		const badUrl = contracts.filter((c) => c.url && !/^https:\/\/jnportal\.ujn\.gov\.rs\/tender-eo\/\d+$/.test(c.url))
		if (badUrl.length) report("greška", r.name, "JN", `${badUrl.length} ugovora sa neispravnim linkom, npr. ${badUrl[0].url}`)
		note("JN", `${contracts.length} ugovora, naručilac „${s.institution}“ ${okName ? "odgovara" : "NE odgovara"}; ${s.period.from?.slice(0, 4) ?? "?"}-${s.period.to?.slice(0, 4) ?? "?"}`)
		if (contracts.length === 0) r.emptyReasons.novac = "Portal javnih nabavki nema ugovore naručioca"
	} catch (err) {
		report("greška", r.name, "JN", `provera nije moguća: ${(err as Error).message}`)
		r.emptyReasons.novac = `Portal javnih nabavki nije dostupan u kešu (${(err as Error).message})`
	}

	// APR (the institution itself) and the suppliers the Firme agents checked
	try {
		const company = ref.mb ? await data.apr.getCompany({ mb: ref.mb }) : null
		if (company) {
			const okName = titleNamesInstitution(company.name, ref.name)
			const okPib = !company.pib || !ref.pib || company.pib === ref.pib
			if (!okName) report("greška", r.name, "APR", `APR firma „${company.name}“ ne odgovara instituciji „${ref.name}“`)
			if (!okPib) report("greška", r.name, "APR", `PIB u APR (${company.pib}) razlikuje se od PIB-a institucije (${ref.pib})`)
		}
		let checked = 0
		let mismatched = 0
		// the Firme agent's profile finding names the APR company: "Prema APR (otvoreni podaci): <APR naziv> je osnovana ..."
		for (const f of r.findings.filter((x) => x.section === "firme" && /^.+: \d+ ugovor/.test(x.title))) {
			const supplier = f.title.split(": ")[0].replace(/…$/, "")
			const aprName = /Prema APR \(otvoreni podaci\): (.+?) je osnovana/.exec(f.text)?.[1]
			if (!aprName) continue
			checked++
			if (/^(PIB|MB) \d+$/.test(supplier)) continue
			// every distinctive word of the supplier's name must appear in the (usually longer) registered APR name
			const aprWords = wordsOf(aprName)
			const tokens = nameTokens(supplier)
			const contained = tokens.length > 0 && tokens.every((t) => aprWords.some((w) => sameWord(t, w)))
			if (!contained && nameSimilarity(aprName, supplier) < 0.5) {
				mismatched++
				report("greška", r.name, "APR", `dobavljač „${supplier}“ upareno sa APR firmom „${aprName}“`)
			}
		}
		note("APR", `${company ? `institucija „${company.name}“` : "institucija nije u APR"}; ${checked} dobavljača sa APR profilom${mismatched ? `, ${mismatched} sumnjivih` : ", nazivi se poklapaju"}`)
	} catch (err) {
		report("upozorenje", r.name, "APR", `provera nije moguća: ${(err as Error).message}`)
	}

	// DRI
	try {
		const reports = await data.dri.getReports({ name: ref.name, nameCyr: ref.nameCyr })
		const bad = reports.filter((x) => !titleNamesInstitution(x.title, ref.name))
		for (const b of bad) report("greška", r.name, "DRI", `izveštaj ${b.id} ne imenuje instituciju u naslovu: ${b.title.slice(0, 100)}`)
		note("DRI", `${reports.length} izveštaja, svi imenuju instituciju u naslovu${bad.length ? ` (osim ${bad.length})` : ""}`)
		if (reports.length === 0) r.emptyReasons.revizija = "DRI nema izveštaje čiji naslov imenuje instituciju"
		else if (r.bySection.revizija === 0) r.emptyReasons.revizija = "DRI izveštaji postoje, ali PDF izvodi nisu u kešu"
	} catch (err) {
		report("greška", r.name, "DRI", `provera nije moguća: ${(err as Error).message}`)
	}

	// Integrity Watch
	try {
		const links = await data.iw.getLinksForAuthority({ name: ref.name, pib: ref.pib })
		const bad = links.filter((l) => l.contractingAuthority && !titleNamesInstitution(l.contractingAuthority, ref.name))
		for (const b of bad) report("greška", r.name, "IW", `oznaka za „${b.supplierName}“ vodi se kod naručioca „${b.contractingAuthority}“`)
		note("IW", `${links.length} oznaka${bad.length ? `, ${bad.length} tuđih` : ", svi naručioci odgovaraju"}`)
	} catch (err) {
		report("upozorenje", r.name, "IW", `provera nije moguća: ${(err as Error).message}`)
	}

	// news
	try {
		const plan = data.institutionNewsPlan(ref)
		const items = await data.news.searchNews(plan.query, plan.opts)
		const names = [plan.query, ...(plan.opts.aliases ?? [])]
		const matcher = buildMatcher({ kind: "institution", names, exclude: plan.opts.exclude })
		let bad = 0
		for (const i of items) {
			const text = wordsOf(`${i.title} . ${i.snippet ?? ""}`)
			if (i.verified === "tekst") continue
			if (!matcher.subject(text)) {
				bad++
				report("greška", r.name, "vesti", `članak ne pominje instituciju u naslovu/opisu: ${i.outlet}: ${i.title}`)
			}
		}
		const old = items.filter((i) => i.publishedAt && Date.now() - Date.parse(i.publishedAt) > 366 * 86400e3)
		for (const o of old) report("greška", r.name, "vesti", `članak stariji od 12 meseci: ${o.publishedAt} ${o.title}`)
		const unresolved = items.filter((i) => i.unresolved)
		if (unresolved.length) report("upozorenje", r.name, "vesti", `${unresolved.length} članaka sa nerazrešenim Google linkom`)
		note("vesti", `${items.length} članaka u 12 meseci (${items.filter((i) => i.verified === "tekst").length} potvrđeno tekstom), ${bad ? `${bad} sumnjivih` : "svi pominju instituciju"}`)
		if (r.articles === 0) r.emptyReasons.mediji = items.length ? "članci postoje, ali nijedan nije dospeo u nalaze" : "nijedan članak u poslednjih 12 meseci ne imenuje instituciju"
	} catch (err) {
		report("upozorenje", r.name, "vesti", `provera nije moguća: ${(err as Error).message}`)
		r.emptyReasons.mediji = "pretraga vesti nije u kešu"
	}

	for (const s of SECTIONS) {
		if (r.bySection[s] === 0) report("upozorenje", r.name, "prazan odeljak", `${s}: ${r.emptyReasons[s] ?? "nema nalaza (razlog nije utvrđen)"}`)
	}
}

// ─── checks: grammar ─────────────────────────────────────────────────────────────────────────────────

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const GRAMMAR = (Object.entries(FORMS) as [string, readonly [string, string, string]][]).map(([key, forms]) => {
	const alts = [...new Set(forms)].sort((a, b) => b.length - a.length).map(esc).join("|")
	return { key, forms, re: new RegExp(`(?<![\\d.,/-])(\\d+(?:\\.\\d{3})*)\\s+(${alts})(?![\\p{L}])`, "giu") }
})

function grammarIssues(text: string): string[] {
	const out: string[] = []
	for (const g of GRAMMAR) {
		for (const m of text.matchAll(g.re)) {
			const value = Number(m[1].replace(/\./g, ""))
			const expected = plural(value, g.forms)
			if (m[2].toLowerCase() !== expected.toLowerCase()) out.push(`„${m[0]}“ (treba „${value} ${expected}“)`)
		}
	}
	for (const m of text.matchAll(/\b\w+\((?:a|i|e|ova)\)(?!\w)/g)) out.push(`„${m[0]}“ (zagrada umesto oblika)`)
	for (const m of text.matchAll(/undefined|\bNaN\b|\[object Object\]|\bnull\b/g)) out.push(`„${m[0]}“ u tekstu`)
	for (const m of text.matchAll(/[\p{L}\p{N}]\.\.(?!\.)/gu)) out.push(`„${m[0]}“ (dvostruka tačka)`)
	return out
}

const grammar: { inst: string; where: string; problem: string }[] = []
for (const r of results) {
	const check = (where: string, text: string) => {
		for (const p of grammarIssues(text)) grammar.push({ inst: r.name, where, problem: p })
	}
	for (const f of r.findings) {
		check(`nalaz „${f.title.slice(0, 50)}“`, `${f.title}\n${f.text}`)
		if (hasCyrillic(f.title) || hasCyrillic(f.text)) report("upozorenje", r.name, "pismo", `ćirilica u nalazu: ${f.title.slice(0, 70)}`)
	}
	check("sažetak", r.lede)
	for (const t of r.toVerify) {
		check("za proveru", t)
		// every checklist item is a complete sentence (shortened wording, never a clipped one)
		if (!/[.!?]$/.test(t) || t.includes("…")) report("greška", r.name, "lista za proveru", `stavka nije cela rečenica: ${t}`)
	}
	check("izveštaj", r.markdown)
	// wording rules of the report: a headline that differs from the register is "odstupa od registra", never struck through or "demantovano"
	if (r.markdown.includes("~~")) report("greška", r.name, "izveštaj", "precrtan naslov (~~) u izveštaju")
	if (/demantovan/i.test(r.markdown)) report("greška", r.name, "izveštaj", "reč „demantovano“ u izveštaju (treba: odstupa od registra)")
	if (/raspadsistema\.com \(/i.test(r.markdown)) report("greška", r.name, "izveštaj", "izvor „raspadsistema.com (…)“ umesto izdanja")
}
for (const t of mapaTexts) for (const p of grammarIssues(t)) grammar.push({ inst: "Mapa", where: "razlog/rezime", problem: p })
for (const g of grammar) report("greška", g.inst, "gramatika", `${g.where}: ${g.problem}`)

// ─── checks: links ───────────────────────────────────────────────────────────────────────────────────

type LinkKind = "ok" | "blokira" | "greška" | "upozorenje"
interface LinkResult {
	url: string
	kind: LinkKind
	note: string
}
const linkResults = new Map<string, LinkResult>()

const UA = "Mozilla/5.0 (compatible; DosijeQA/0.1; link check for a journalism research tool)"

// The procurement portal answers HTTP 500 to a deep link opened without a session (a visitor who has not opened the home page yet);
// a visitor who has (the usual case for a journalist who works with the portal) gets the page. The check behaves like that visitor.
let portalCookie: Promise<string> | undefined
function portalSession(): Promise<string> {
	portalCookie ??= fetch("https://jnportal.ujn.gov.rs/", { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(12_000) })
		.then((r) => r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; "))
		.catch(() => "")
	return portalCookie
}

async function once(url: string): Promise<LinkResult> {
	const target = url.replace(/#.*$/, "")
	try {
		const cookie = new URL(target).host === "jnportal.ujn.gov.rs" ? await portalSession() : ""
		const res = await fetch(target, { method: "GET", redirect: "follow", headers: { ...(cookie ? { Cookie: cookie } : {}), "User-Agent": UA, Accept: "text/html,application/pdf,*/*;q=0.5", "Accept-Language": "sr-RS,sr;q=0.9,en;q=0.5" }, signal: AbortSignal.timeout(12_000) })
		const type = res.headers.get("content-type") ?? ""
		let head = ""
		if (res.ok && /html/i.test(type) && res.body) {
			const reader = res.body.getReader()
			const dec = new TextDecoder()
			while (head.length < 60_000) {
				const { value, done } = await reader.read()
				if (done) break
				head += dec.decode(value, { stream: true })
			}
			await reader.cancel().catch(() => undefined)
		} else await res.body?.cancel().catch(() => undefined)
		if ([401, 403, 429, 451, 999].includes(res.status)) return { url, kind: "blokira", note: `HTTP ${res.status}: blokira botove` }
		if (res.status === 404 || res.status === 410) return { url, kind: "greška", note: `HTTP ${res.status}: stranica ne postoji` }
		if (res.status >= 500) return { url, kind: "upozorenje", note: `HTTP ${res.status}` }
		if (res.status >= 400) return { url, kind: "upozorenje", note: `HTTP ${res.status}` }
		const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1]?.replace(/\s+/g, " ").trim() ?? ""
		if (/(^|\b)(404|not found|page not found|stranica nije pronađena|stranica ne postoji|nije pronađen)(\b|$)/i.test(title)) return { url, kind: "greška", note: `meka 404 (naslov: ${title.slice(0, 60)})` }
		return { url, kind: "ok", note: `HTTP ${res.status}` }
	} catch (err) {
		const e = err as { cause?: { code?: string }; name?: string; message?: string }
		const code = e.cause?.code ?? ""
		if (/ENOTFOUND|EAI_AGAIN/.test(code)) return { url, kind: "greška", note: "DNS: domen ne postoji" }
		if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/.test(code)) return { url, kind: "greška", note: `TLS: ${code}` }
		if (e.name === "TimeoutError" || e.name === "AbortError") return { url, kind: "upozorenje", note: "isteklo vreme (12 s)" }
		return { url, kind: "upozorenje", note: code || e.message || "mrežna greška" }
	}
}

async function checkLink(url: string): Promise<LinkResult> {
	let r = await once(url)
	if (r.kind === "upozorenje") {
		await new Promise((x) => setTimeout(x, 5000))
		r = await once(url)
	}
	return r
}

const allUrls = [...new Set(results.flatMap((r) => [...r.urls]))]
if (!skipLinks && allUrls.length) {
	const perHost = new Map<string, number>()
	const queue = [...allUrls]
	const waitHost = async (host: string) => {
		while ((perHost.get(host) ?? 0) >= 1) await new Promise((x) => setTimeout(x, 80))
		perHost.set(host, (perHost.get(host) ?? 0) + 1)
	}
	let done = 0
	await Promise.all(
		Array.from({ length: 6 }, async () => {
			while (queue.length) {
				const url = queue.shift() as string
				const host = new URL(url).host
				await waitHost(host)
				try {
					linkResults.set(url, await checkLink(url))
					// politeness: the pause is part of the host's turn (the procurement portal answers 500 when it is rate limiting)
					await new Promise((x) => setTimeout(x, host.includes("jnportal") ? 1500 : 250 + Math.random() * 150))
				} finally {
					perHost.set(host, (perHost.get(host) ?? 1) - 1)
				}
				if (++done % 40 === 0) console.log(`  linkovi: ${done}/${allUrls.length}`)
			}
		}),
	)
	const bySource = (url: string) => results.filter((r) => r.urls.has(url)).map((r) => r.slug)
	for (const l of linkResults.values()) {
		if (l.kind === "greška") report("greška", bySource(l.url).join(", "), "link", `${l.url} -> ${l.note}`)
		else if (l.kind === "upozorenje") report("upozorenje", bySource(l.url).join(", "), "link", `${l.url} -> ${l.note}`)
	}
}

// ─── output ──────────────────────────────────────────────────────────────────────────────────────────

const errors = issues.filter((i) => i.level === "greška")
const warnings = issues.filter((i) => i.level === "upozorenje")
const count = (inst: string, level: Level) => issues.filter((i) => i.inst === inst && i.level === level).length

console.log("")
console.log(`${pad("institucija", 34)} ${rpad("nalaza", 6)} ${rpad("ruk.", 5)} ${rpad("novac", 6)} ${rpad("firme", 6)} ${rpad("rev.", 5)} ${rpad("mediji", 7)} ${rpad("članaka", 8)} ${rpad("linkova", 8)} ${rpad("greške", 7)} ${rpad("upoz.", 6)}`)
for (const r of results) {
	console.log(
		`${pad(r.name, 34)} ${rpad(r.findings.length, 6)} ${rpad(r.bySection.rukovodstvo, 5)} ${rpad(r.bySection.novac, 6)} ${rpad(r.bySection.firme, 6)} ${rpad(r.bySection.revizija, 5)} ${rpad(r.bySection.mediji, 7)} ${rpad(r.articles, 8)} ${rpad(r.urls.size, 8)} ${rpad(count(r.name, "greška"), 7)} ${rpad(count(r.name, "upozorenje"), 6)}`,
	)
}
const kinds = { ok: 0, blokira: 0, greška: 0, upozorenje: 0 } as Record<LinkKind, number>
for (const l of linkResults.values()) kinds[l.kind]++
console.log("")
console.log(skipLinks ? "Linkovi: preskočeno (--no-links)" : `Linkovi: ${allUrls.length} jedinstvenih URL-ova: ${kinds.ok} radi, ${kinds.blokira} blokira botove, ${kinds.upozorenje} upozorenja, ${kinds["greška"]} grešaka`)
console.log(`Gramatika: ${grammar.length ? `${grammar.length} problema` : "bez problema"}`)
for (const w of warnings.filter((x) => x.check !== "link").slice(0, 40)) console.log(`  upozorenje [${w.inst} · ${w.check}] ${w.message}`)
for (const e of errors.slice(0, 60)) console.log(`  GREŠKA     [${e.inst} · ${e.check}] ${e.message}`)
console.log(`\nUkupno: ${errors.length} grešaka, ${warnings.length} upozorenja`)

// docs/QA.md
const md: string[] = []
const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Belgrade" }).format(new Date())
md.push("# QA izveštaj", "", `Generisano skriptom \`npm run qa\` (scripts/qa.ts) · datum: ${today} · režim: \`DATA_MODE=cache\`, skriptovani agenti, bez ključa.`, "")
md.push("Skripta pokreće pun dosije za svaku institucije iz Mape prioriteta i proverava: izvor za svaki nalaz, dostupnost svakog linka, da svaki podatak pripada toj instituciji, duplikate, prazne odeljke i gramatiku brojeva.", "")
md.push("## Nalazi po odeljcima", "", "| institucija | nalaza | rukovodstvo | novac | firme | revizija | mediji | članaka | jedinstvenih linkova |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|")
for (const r of results) md.push(`| ${r.name} | ${r.findings.length} | ${r.bySection.rukovodstvo} | ${r.bySection.novac} | ${r.bySection.firme} | ${r.bySection.revizija} | ${r.bySection.mediji} | ${r.articles} | ${r.urls.size} |`)
md.push("", "## Linkovi", "")
if (skipLinks) md.push("_Provera linkova preskočena (`--no-links`)._")
else {
	md.push(`${allUrls.length} jedinstvenih URL-ova iz svih izvora nalaza (GET, 12 s, jedan zahtev po domenu, pauza 0,25-1,5 s): **${kinds.ok} radi**, ${kinds.blokira} blokira botove (401/403/429: prijavljeno, nije greška), ${kinds.upozorenje} upozorenja (isteklo vreme, 5xx), **${kinds["greška"]} grešaka** (404/410, DNS, TLS, meka 404).`, "")
	const blocked = [...linkResults.values()].filter((l) => l.kind === "blokira")
	if (blocked.length) {
		md.push("Blokiraju botove (link je javan, ali sajt odbija automatski zahtev):", "")
		for (const l of blocked) md.push(`- ${l.url} (${l.note})`)
		md.push("")
	}
	for (const l of [...linkResults.values()].filter((x) => x.kind === "greška" || x.kind === "upozorenje")) md.push(`- **${l.kind}**: ${l.url}: ${l.note}`)
}
md.push("", "## Precizost: podatak pripada instituciji", "", "| institucija | ACAS | Portal javnih nabavki | APR | DRI | Integrity Watch | Vesti |", "|---|---|---|---|---|---|---|")
for (const r of results) md.push(`| ${r.name} | ${["ACAS", "JN", "APR", "DRI", "IW", "vesti"].map((k) => (r.attribution[k] ?? "-").replace(/\|/g, "/")).join(" | ")} |`)
md.push("", "## Upozorenja", "")
const w2 = warnings.filter((w) => w.check !== "link")
if (w2.length === 0) md.push("_Nema._")
for (const w of w2) md.push(`- **${w.inst}** · ${w.check}: ${w.message}`)
md.push("", "## Greške", "")
if (errors.length === 0) md.push("_Nema: sve provere prolaze._")
for (const e of errors) md.push(`- **${e.inst}** · ${e.check}: ${e.message}`)
md.push("", "## Gramatika", "", grammar.length ? `${grammar.length} problema (vidi greške).` : "Provereni su naslovi i tekstovi nalaza, sažetak, lista za proveru, izveštaj i razlozi Mape: bez grešaka u slaganju broja sa imenicom (1 ugovor, 3 ugovora, 7 ugovora; mesec/meseca/meseci; nalaz/nalaza; ...).")
md.push("", "## Pronađeno i ispravljeno u ovoj iteraciji", "")
for (const f of FIXED) md.push(`- ${f}`)
md.push("")
// the run must not modify tracked files: the report goes to out/qa.md, docs/QA.md is only rewritten on request
const target = writeDocs ? path.resolve(process.cwd(), "docs", "QA.md") : path.resolve(process.cwd(), "out", "qa.md")
fs.mkdirSync(path.dirname(target), { recursive: true })
fs.writeFileSync(target, md.join("\n"), "utf8")
console.log(`Zapisano: ${path.relative(process.cwd(), target).replace(/\\/g, "/")}`)

await boot.shutdown()
process.exit(errors.length ? 1 : 0)
