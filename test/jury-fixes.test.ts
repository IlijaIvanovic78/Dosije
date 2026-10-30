// npm test: deterministic pieces behind the jury-feedback fixes: DRI excerpt hygiene, stale DRI findings in the top signals,
// the appointment filter of the media check, the cross-institution supplier links of the Mapa prioriteta, live-search finalization.

import assert from "node:assert/strict"
import { describe, test } from "node:test"

process.env.DATA_MODE = "cache"
process.env.DOSIJE_MODE = "scripted"

const { cleanDriExcerpt, driFindingExcerpts, opinionQuote, stripPdfArtifacts, describesIssue } = await import("../src/mozaik/driText")
const { pickTop, isStaleDri, rankTier } = await import("../src/mozaik/summary")
const { appointmentLabel, namesPerson } = await import("../src/mozaik/tools/sources")
const { computeLinks } = await import("../src/mozaik/mapa")
const { MapaState } = await import("../src/mozaik/state")
const { scoreSignals, SHARED_SUPPLIER_MAX, PRIORITY_MAX } = await import("../src/data/analysis/priority")
const { auditTopicOf } = await import("../src/mozaik/participants")
type Finding = import("../src/shared/types").Finding
type DosijeState = import("../src/mozaik/state").DosijeState
type MapaRow = import("../src/shared/types").MapaRow
type MapaSupplier = import("../src/shared/types").MapaSupplier

describe("DRI excerpts: only irregularities and recommendations, whole sentences, no PDF artifacts", () => {
	const positive =
		"U skladu sa ovim odredbama Zakona i Pravilnika, Društvo je obračunalo i platilo svoju obavezu po osnovu zapošljavanja osoba sa invaliditetom koje nije zaposlilo uplatom sredstava na propisani uplatni račun budžeta Republike Srbije u ukupnom iznosu od 101.279.910 dinara."
	const irregular =
		"Društvo je u dva postupka javne nabavke procenjene vrednosti 560 miliona dinara i ugovorene vrednosti 521,54 miliona dinara, obaveštenja o dodeli ugovora objavilo u roku od 38 dana u jednom postupku, što nije u skladu sa članom 109 stav 1 Zakona o javnim nabavkama."

	test("neutral and positive compliance statements are dropped, irregularities and recommendations are kept", () => {
		assert.equal(cleanDriExcerpt(positive), undefined)
		assert.equal(cleanDriExcerpt("Za tri meseca revidiranog perioda za koje je izvršena uplata sa zakašnjenjem, Društvo je obračunalo u visini zatezne kamate i uplatilo iznos od 28 hiljada dinara."), undefined)
		assert.equal(cleanDriExcerpt("Za uređenje oblasti koje su bile predmet revizije nisu date preporuke jer je Društvo otklonilo sve nepravilnosti utvrđene u reviziji sprovedenoj u 2020. godini."), undefined, "a corrected irregularity is not a finding")
		assert.equal(cleanDriExcerpt("U Izveštaju su date odgovarajuće preporuke subjektima revizije u cilju otklanjanja utvrđenih nesvrsishodnosti."), undefined, "recommendation boilerplate")
		assert.equal(cleanDriExcerpt(irregular), irregular)
		const recommendation = "Za otklanjanje navedene nepravilnosti, data je preporuka Nadzornom odboru Javnog preduzeća „Putevi Srbije“ da pokrene inicijativu za imenovanje direktora Preduzeća u skladu sa Zakonom o javnim preduzećima."
		assert.equal(cleanDriExcerpt(recommendation), recommendation)
		assert.ok(describesIssue("Društvo nije uspostavilo dovoljno efikasan sistem zapošljavanja osoba sa invaliditetom jer ne uređuje način biranja."))
		assert.ok(describesIssue("Društvo je iskazalo precenjene rashode i potcenjen gubitak ranijih godina u iznosu od 145.461 hiljadu dinara."))
		assert.ok(!describesIssue("Društvo je u 2022. godini zaključilo ugovore u vrednosti od 5 miliona dinara bez PDV-a."))
		assert.deepEqual(driFindingExcerpts([positive, irregular, irregular]), [irregular], "filtered and without repeats")
	})

	test("a quote is a whole sentence: a cut-off sentence is dropped, a cut-off tail is removed at the sentence boundary", () => {
		const cut =
			"Od 33 uzorkovana postupaka javnih nabavki, Društvo je u 2022. godini dokumentovalo način utvrđivanja procenjene vrednosti za 26 postupaka, dok za sedam postupaka nije dokumentovalo da je procenjena vrednost objektivna i zasnovana na…"
		assert.equal(cleanDriExcerpt(cut), undefined, "no sentence boundary: nothing is quoted half")
		const withTail =
			"Imenovano lice koje je vršilo funkciju vršioca dužnosti direktora Društva tokom 2019. godine, više od dve godine obavljalo je funkciju vršioca dužnosti direktora Društva, što nije u skladu sa Zakonom o javnim preduzećima. 1.3.1. Društvo je u 2019. godini zaključivalo ugovore o isplati stipendija i kredita učenicima, donelo Odluku o visini stipendija i kredita učenicima, kao i odluke o isplati…"
		const quote = cleanDriExcerpt(withTail) as string
		assert.ok(quote.endsWith("Zakonom o javnim preduzećima."), quote)
		assert.ok(!quote.includes("…") && !quote.includes("1.3.1"))
		// ordinals ("člana 36. stav 8.") are not sentence ends
		const ordinal = "Prilikom sprovođenja tri pregovaračka postupka bez objavljivanja poziva Društvo je uputilo poziv samo jednom ponuđaču, što nije u skladu sa članom 36. stav 8. Zakona o javnim nabavkama. Sledeća rečenica."
		assert.ok((cleanDriExcerpt(ordinal) as string).endsWith("Zakona o javnim nabavkama."))
	})

	test("page headers and 'Page N' artifacts of the PDF text are removed", () => {
		// a marker near the start follows a running header: the header goes with it
		assert.equal(stripPdfArtifacts("Sektor za reviziju organizacija obaveznog socijalnog osiguranja Page 11 hiljada dinara za usluge"), "hiljada dinara za usluge")
		assert.equal(stripPdfArtifacts("Tekst - 12 - nastavak"), "Tekst nastavak")
		// the real artifact: a sentence that starts after the header is a fragment and is not quoted
		const withHeader =
			"Sektor za reviziju organizacija obaveznog socijalnog osiguranja Page 11 hiljada dinara na osnovu faktura za izvršene kompjuterske usluge za koje nije sačinjen pisani ugovor, što nije u skladu sa članom 56. stav 2. Zakona o budžetskom sistemu."
		assert.equal(cleanDriExcerpt(withHeader), undefined)
		// the priority label of a recommendation table is not part of the sentence
		const prio = "PRIORITET 11 1) Imenovano lice više od 20 meseci obavlja funkciju vršioca dužnosti direktora „Koridori Srbije“ d. o. o., Beograd, što nije u skladu sa članom 52 stav 2 Zakona o javnim preduzećima, kojim je propisano da period obavljanja funkcije vršioca dužnosti direktora ne može biti duži od jedne godine. (Napomena 2.1) 2) Društvo nije evidentiralo sadašnju vrednost vozila…"
		const q = cleanDriExcerpt(prio) as string
		assert.ok(q.startsWith("Imenovano lice") && q.endsWith("od jedne godine."), q)
		// later in the text the marker ends the usable part
		const first = "Društvo nije dostavilo dokaze o sprovedenim preporukama internih revizora u propisanom roku, zbog čega nije moguće utvrditi da li su preporuke sprovedene u celosti niti u kom obimu."
		assert.equal(cleanDriExcerpt(`${first} Page 12 Sektor za reviziju Društvo nije vodilo evidenciju o imovini.`), first)
	})

	test("the opinion sentence is quoted only when it is whole", () => {
		assert.equal(opinionQuote(["Po našem mišljenju, osim za efekte pitanja opisanih u delu izveštaja Osnov za mišljenje sa rezervom, finansijski izveštaji daju istinit i objektivan prikaz na dan 31. decembra 2018.…"]), undefined)
		const whole = "Po našem mišljenju, osim za efekte pitanja opisanih u delu izveštaja Osnov za mišljenje sa rezervom, finansijski izveštaji daju istinit i objektivan prikaz finansijskog položaja društva."
		assert.equal(opinionQuote([irregular, whole]), whole)
		assert.equal(cleanDriExcerpt(whole), undefined, "the opinion is not an irregularity excerpt")
	})
})

let seq = 0
function finding(p: Partial<Finding> & Pick<Finding, "title" | "section">): Finding {
	const id = `g${++seq}`
	return { id, caseId: "c", text: "t", status: "zvanicno", severity: "paznja", sources: [], entityIds: [], agentId: "a", agentName: "Agent", createdAt: `2026-10-30T10:00:${String(seq).padStart(2, "0")}Z`, updatedAt: "", approval: "not_required", ...p }
}
const stateOf = (list: Finding[]) => ({ findingList: () => list }) as unknown as DosijeState
const dri = (publishedAt: string) => [{ kind: "dri" as const, title: "DRI", url: `https://www.dri.rs/izvestaj/${publishedAt}`, retrievedAt: "", publishedAt, official: true }]

describe("top signals: DRI findings older than 5 years rank below recent signals", () => {
	const now = Date.now()
	const old = finding({ title: "DRI 2019 nalaz", section: "revizija", signalCode: "DRI_NALAZ", sources: dri("2019-12-04") })
	const recent = finding({ title: "DRI 2024 nalaz", section: "revizija", signalCode: "DRI_NALAZ", sources: dri("2025-07-25") })
	const others = [
		finding({ title: "v.d. preko roka", section: "rukovodstvo", severity: "signal", signalCode: "VD_PREKO_ROKA" }),
		finding({ title: "Bez objave", section: "novac", signalCode: "BEZ_OBJAVE" }),
		finding({ title: "Koncentracija", section: "novac", signalCode: "KONCENTRACIJA" }),
		finding({ title: "Politička veza", section: "firme", signalCode: "POLITICKA_VEZA", status: "nepotvrdjeno" }),
		finding({ title: "Medijski navod", section: "mediji", signalCode: "MEDIJSKI_NAVOD", status: "nepotvrdjeno" }),
	]

	test("staleness is read from the DRI source date", () => {
		assert.equal(isStaleDri(old, now), true)
		assert.equal(isStaleDri(recent, now), false)
		assert.equal(isStaleDri(finding({ title: "x", section: "firme", signalCode: "POLITICKA_VEZA", sources: dri("2010-01-01") }), now), false, "only DRI findings")
		assert.equal(isStaleDri(finding({ title: "x", section: "revizija", signalCode: "DRI_NALAZ", sources: [] }), now), false, "no date: not judged")
		assert.equal(rankTier(old), 3)
		assert.equal(rankTier(recent), 0)
	})

	test("a recent, even unconfirmed, signal stands above an old official DRI finding", () => {
		const top = pickTop(stateOf([old, recent, ...others]), 5)
		assert.ok(top.includes(recent))
		assert.ok(!top.includes(old), `old DRI finding is not in the top: ${top.map((f) => f.title).join(", ")}`)
		const ranked = pickTop(stateOf([old, others[3], others[4]]), 5)
		assert.ok(ranked.indexOf(old) === -1 || ranked.indexOf(old) > ranked.indexOf(others[3]), "stale DRI below the unconfirmed recent signal")
	})

	test("when nothing else qualifies the old DRI finding still appears", () => {
		const only = pickTop(stateOf([old]), 5)
		assert.deepEqual(only.map((f) => f.title), ["DRI 2019 nalaz"])
	})
})

describe("Mediji <- Revizor: which DRI findings concern procurement or acting heads", () => {
	test("audit topic of a finding", () => {
		assert.equal(auditTopicOf({ title: "DRI za 2022. · javne nabavke: Društvo je u dva postupka javne nabavke", text: "Prema izveštaju DRI" }), "javne nabavke")
		assert.equal(auditTopicOf({ title: "DRI za 2019. · vršioci dužnosti: Imenovano lice", text: "obavljalo je funkciju vršioca dužnosti direktora" }), "vršioci dužnosti")
		assert.equal(auditTopicOf({ title: "DRI za 2018. · finansijski izveštaji: Društvo je iskazalo precenjene rashode", text: "iznos od 145.461 hiljadu dinara" }), undefined)
	})
})

describe("media check of an appointment: only articles that are about the appointment", () => {
	const person = "Zoran Jevtić"
	const label = (title: string, snippet?: string) => appointmentLabel({ title, snippet }, person)

	test("the headline or lead must name the person AND an appointment/function word", () => {
		const gen = label('Zoran Jevtić novi generalni direktor "Infrastrukture železnice Srbije"')
		assert.deepEqual([gen.relevant, gen.naziv, gen.fraza], [true, "direktor", "generalni direktor"])
		const vd = label("Zoran Jevtić imenovan za vršioca dužnosti direktora „Infrastrukture železnice Srbije“")
		assert.deepEqual([vd.relevant, vd.naziv], [true, "v.d."])
		const lead = label("Direktor Infrastrukture železnice Srbije: Stanica Prokop je bezbedna", 'Generalni direktor "Infrastrukture" Zoran Jevtić je povodom informacija u javnosti rekao')
		assert.equal(lead.relevant, true, "the lead names the person with the function")
		assert.equal(namesPerson("Zorana Jevtića su imenovali", person), true, "inflected, either order")
		// about something else: no person, or no appointment/function word, or only the surname
		assert.equal(label("Čačilend: jeftinije karte za voz od Beograda do Čačka", "Infrastruktura železnice Srbije objavila cene karata").relevant, false)
		assert.equal(label("Forbes: modernizacija pruge Beograd–Niš ide dalje", "direktor građevinske kompanije kaže").relevant, false, "a function word without the person")
		assert.equal(label("Zoran Jevtić obišao gradilište nove stanice").relevant, false, "the person without an appointment/function word")
		assert.equal(label("Jevtić: izvršeno testiranje brze pruge", "Na trasi brze pruge je izvršeno testiranje").relevant, false, "only the surname")
	})
})

describe("Mapa prioriteta: the same supplier among the top suppliers of 2+ institutions", () => {
	const sup = (name: string, pib: string, rank: number, share = 0.2): MapaSupplier => ({ name, pib, rank, valueRsd: 1_000_000, share })
	function mapaWith(top: Record<string, MapaSupplier[]>): InstanceType<typeof MapaState> {
		const m = new MapaState()
		m.id = "map-test"
		m.status = "running"
		for (const [slug, suppliers] of Object.entries(top)) {
			m.rows.set(slug, { slug, name: `Institucija ${slug.toUpperCase()}`, status: "done", score: 0, signals: {}, reasons: [], sources: [] } as MapaRow)
			m.triage.set(slug, { called: new Set(), ok: new Set(["nabavke"]), signals: { topSuppliers: suppliers }, gaps: [] })
		}
		return m
	}

	test("a supplier listed by 2+ institutions becomes a link; one listed by a single institution does not", () => {
		const m = mapaWith({
			a: [sup("ZGOP DOO", "112519168", 1), sup("Samo A doo", "100000001", 2)],
			b: [sup("Neko drugi", "100000002", 1), sup("ZGOP DOO", "112519168", 4)],
			c: [sup("PIB 112519168", "112519168", 3), sup("Samo C doo", "100000003", 1)],
		})
		const links = computeLinks(m)
		assert.equal(links.length, 1)
		const v = links[0]
		assert.equal(v.key, "112519168")
		assert.deepEqual(v.supplier, { name: "ZGOP DOO", pib: "112519168" }, "an unnamed bidder is shown under the name another institution uses")
		assert.deepEqual(v.institutions.map((i) => [i.slug, i.rank]), [["a", 1], ["c", 3], ["b", 4]])
		assert.equal(v.line, "Isti dobavljač u 3 institucije: ZGOP DOO")
		assert.equal(v.points, 5)
	})

	test("an institution whose triage failed does not take part", () => {
		const m = mapaWith({ a: [sup("ZGOP DOO", "112519168", 1)], b: [sup("ZGOP DOO", "112519168", 2)] })
		;(m.rows.get("b") as MapaRow).status = "error"
		assert.equal(computeLinks(m).length, 0)
	})

	test("the points are documented and capped in priority.ts, and the row gets the line", () => {
		const one = scoreSignals({ sharedSuppliers: [{ name: "ZGOP DOO", pib: "112519168", institutions: 3, with: ["B", "C"] }] })
		assert.equal(one.score, 5)
		assert.deepEqual(one.reasons, ["Isti dobavljač u 3 institucije: ZGOP DOO (+5)"])
		const many = scoreSignals({ sharedSuppliers: ["A", "B", "C", "D"].map((name) => ({ name, institutions: 2, with: ["X"] })) })
		assert.equal(many.score, SHARED_SUPPLIER_MAX, "at most +10 per institution")
		assert.equal(many.reasons.length, 2)
		assert.equal(PRIORITY_MAX, 155)
		assert.equal(scoreSignals({}).score, 0)
	})
})
