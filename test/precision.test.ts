// npm test: the precision and language rules that need no network: news matching, DRI title attribution, Serbian plurals,
// headline and word-boundary clipping, head of an institution when the register left a stale record open.

import assert from "node:assert/strict"
import { describe, test } from "node:test"

process.env.DATA_MODE = "cache"

const { buildMatcher, wordsOf, dropRepeats, newsOverview, isNoiseTitle } = await import("../src/data/newsMatch")
const { institutionNames } = await import("../src/data/newsPlan")
const { titleNamesInstitution } = await import("../src/data/sources/dri")
const { n, plural, FORMS } = await import("../src/shared/plural")
const { clipWords, headline } = await import("../src/shared/text")
const { pickHead, currentOfficials, analyzeVdChain } = await import("../src/data/analysis/vd")
const { driTitle } = await import("../src/mozaik/inference/policies")
const { sameWord } = await import("../src/data/translit")
type NewsItem = import("../src/data/types").NewsItem

const item = (p: Partial<NewsItem> & { title: string; url: string; outlet: string }): NewsItem => ({
	id: p.url,
	matched: [],
	provider: "google-news-rss",
	source: { kind: "vesti", title: p.title, url: p.url, retrievedAt: "", official: false },
	...p,
})

describe("Serbian plurals", () => {
	test("one / few / many", () => {
		assert.equal(n(1, "ugovor"), "1 ugovor")
		assert.equal(n(3, "ugovor"), "3 ugovora")
		assert.equal(n(7, "ugovor"), "7 ugovora")
		assert.equal(n(11, "mesec"), "11 meseci")
		assert.equal(n(21, "mesec"), "21 mesec")
		assert.equal(n(22, "mesec"), "22 meseca")
		assert.equal(n(112, "dan"), "112 dana")
		assert.equal(n(1, "blokiranaTvrdnja"), "1 blokirana tvrdnja")
		assert.equal(n(2, "blokiranaTvrdnja"), "2 blokirane tvrdnje")
		assert.equal(n(5, "blokiranaTvrdnja"), "5 blokiranih tvrdnji")
		assert.equal(n(21, "agent"), "21 agent")
		assert.equal(n(5, "agent"), "5 agenata")
		assert.equal(n(1537, "ugovor", "1.537"), "1.537 ugovora")
		assert.equal(plural(0, FORMS.clanak), "članaka")
		assert.equal(plural(13, FORMS.petlja), "petlji")
		assert.equal(plural(4, FORMS.firma), "firme")
	})
})

describe("news precision", () => {
	const izs = buildMatcher({ kind: "institution", names: ["Infrastruktura železnice Srbije", "IŽS"] })
	test("an institution article names the institution (inflected, any script) or its alias", () => {
		assert.ok(izs.subject(wordsOf("Direktor Infrastrukture železnice Srbije: Prokop je bezbedan")))
		assert.ok(izs.subject(wordsOf("Инфраструктура железнице Србије саопштила")))
		assert.ok(izs.subject(wordsOf("IŽS ruši stanice u Crepaji")))
		assert.ok(!izs.subject(wordsOf("Železnice Srbije kupuju nove vozove")))
		assert.ok(!izs.subject(wordsOf("Infrastruktura puteva u Srbiji i železnice")), "tokens scattered over a sentence do not count")
	})
	test("a longer institution name does not count as the shorter one", () => {
		const zs = buildMatcher({ kind: "institution", names: ["Železnice Srbije"], exclude: ["Infrastruktura železnice Srbije"] })
		assert.ok(!zs.subject(wordsOf("Infrastruktura železnice Srbije objavila tender")))
		assert.ok(zs.subject(wordsOf("Železnice Srbije i Infrastruktura železnice Srbije")))
		assert.deepEqual(institutionNames({ slug: "zeleznice-srbije", name: "Železnice Srbije a.d." }).exclude.includes("Infrastruktura železnice Srbije"), true)
	})
	test("a person article needs the full name AND the institution or firm", () => {
		const p = buildMatcher({ kind: "person", names: ["Zoran Jevtić"], context: ["Infrastruktura železnice Srbije", "IŽS"] })
		const text = wordsOf("Zoran Jevtić imenovan za direktora Infrastrukture železnice Srbije")
		assert.ok(p.subject(text) && p.context(text))
		const namesake = wordsOf("Zoran Jevtić pobedio na turniru u Nišu")
		assert.ok(p.subject(namesake) && !p.context(namesake), "namesake without the institution is not accepted")
		assert.ok(!p.subject(wordsOf("Zoran Marković: železnice")), "first name alone is not the person")
		assert.ok(p.subject(wordsOf("rekao je Jevtić Zoran")))
		assert.ok(isNoiseTitle("Preminuo Zoran Jevtić"))
	})
	test("inflection: fleeting a and case endings", () => {
		assert.ok(sameWord("petar", "petra"))
		assert.ok(sameWord("jevtic", "jevtica"))
		assert.ok(!sameWord("srbija", "srbijavoz"))
	})
	test("aggregator copies lose to the original outlet; one story is counted once", () => {
		const day = "2026-10-10T08:00:00.000Z"
		const items = [
			item({ title: "Pruga Niš-Brestovac prošla ispitivanja", url: "https://naslovi.net/2026-10-10/euronews/x", outlet: "Naslovi.net", publishedAt: day, score: 31 }),
			item({ title: "Pruga Niš-Brestovac prošla ispitivanja", url: "https://www.tanjug.rs/ekonomija/1", outlet: "tanjug.rs", publishedAt: day, score: 31 }),
			item({ title: "Nešto sasvim drugo o ugovoru od 470 miliona dinara", url: "https://www.021.rs/a", outlet: "021.rs", publishedAt: "2026-09-03T08:00:00.000Z", score: 31 }),
		]
		const kept = dropRepeats(items)
		assert.equal(kept.length, 2)
		assert.ok(kept.every((i) => i.outlet !== "Naslovi.net"))
		const ov = newsOverview(items, 365)
		assert.equal(ov.total, 2)
		assert.ok(ov.items.length <= 12)
	})
})

describe("DRI titles", () => {
	test("the title must name the institution, including the old brand spelling", () => {
		assert.ok(titleNamesInstitution("Izveštaj o reviziji finansijskih izveštaja Akcionarskog društva za železnički prevoz putnika „Srbija voz“, Beograd za 2019. godinu", "Srbijavoz a.d. Beograd"))
		assert.ok(titleNamesInstitution("Pravilnost poslovanja Koridora Srbije društvo sa ograničenom odgovornošću Beograd", "Koridori Srbije d.o.o."))
		assert.ok(!titleNamesInstitution("Izveštaj o reviziji svrsishodnosti poslovanja „Upravljanje bezbednosnim rizicima na prelazima preko pruge“", "Infrastruktura železnice Srbije a.d."))
		assert.ok(!titleNamesInstitution("Poslerevizioni izveštaj Infrastruktura železnice Srbije", "Železnice Srbije a.d."), "IŽS reports are not ŽS reports")
	})
	test("finding titles are headlines, not excerpts cut mid-word", () => {
		const t = driTitle(2022, "revizija pravilnosti", "Društvo je u dva postupka javne nabavke procenjene vrednosti 560 miliona dinara obaveštenja o dodeli ugovora objavilo u roku od 38 dana u jednom postupku, odnosno u roku od 349 dana u drugom postupku, što nije u skladu sa članom 109 Zakona o javnim nabavkama.")
		assert.match(t, /^DRI 2022 · javne nabavke: /)
		assert.ok(t.length <= 130)
		assert.equal(clipWords("Infrastruktura železnice Srbije objavila javni poziv", 30), "Infrastruktura železnice…")
		assert.equal(headline("Kratka rečenica o nalazu.", 90), "Kratka rečenica o nalazu")
	})
})

describe("head of the institution", () => {
	const src = { kind: "acas" as const, title: "ACAS", url: "https://publicacas.acas.rs/", retrievedAt: "", official: true }
	const o = (id: string, name: string, position: string, from: string, to?: string) => ({ id, fullName: name, position, isActing: /^v\.d\./.test(position), institutionName: "Srbija Kargo a.d.", from, to, source: src })
	test("a record the register never closed does not make a second head or break the chain", () => {
		const list = [
			o("1", "Dušan Đukić", "v.d. generalnog direktora", "2025-06-18"),
			o("2", "Nataša Mlinar-Ležaja", "v.d. generalnog direktora", "2024-07-11", "2025-06-18"),
			o("3", "Dušan Garibović", "v.d. generalnog direktora", "2017-09-21"),
			o("4", "Ljiljana Đorđević", "Predsednik skupštine", "2021-02-25"),
			o("5", "Gorjana Joksović", "Predsednik skupštine", "2016-09-29"),
		]
		assert.equal(pickHead(list)?.fullName, "Dušan Đukić")
		assert.deepEqual(currentOfficials(list).map((x) => x.id), ["1", "4"])
		const chain = analyzeVdChain(list, "2026-10-30")
		assert.equal(chain?.actingCount, 3)
		assert.equal(chain?.heads.filter((h) => !h.to).length, 1, "only the latest head is still open")
		assert.ok(chain?.heads[0].endInferred)
	})
})
