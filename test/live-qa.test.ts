// npm test: rules added with the live-path QA (docs/QA-live.md) that need no network: which official is the head, closed v.d. terms
// past the limit, a legal form without a rule, the city that stays in a generic name, all-caps transliteration.

import assert from "node:assert/strict"
import { describe, test } from "node:test"

process.env.DATA_MODE = "cache"

const { pickHead, pastActingOverLimit, earlierActingTerms, checkVd } = await import("../src/data/analysis/vd")
const { endedByReport } = await import("../src/data/analysis/ended")
const { normalizeName, cyrToLat } = await import("../src/data/translit")
const { mediaName } = await import("../src/data/newsPlan")
const { guessLegalType } = await import("../src/data/resolver")
const { ruleFor } = await import("../src/data/rules/vdRules")

const src = { kind: "acas" as const, title: "ACAS", url: "https://publicacas.acas.rs/", retrievedAt: "", official: true }
const o = (id: string, name: string, position: string, from: string, to?: string) => ({
	id,
	fullName: name,
	position,
	isActing: /^v\.d\./.test(position),
	institutionName: "X",
	from,
	to,
	source: src,
})

describe("head of the institution", () => {
	test("the mayor is the head, not the newest deputy or assistant; a board chair is never the head", () => {
		const grad = [
			o("1", "Vuk Raonić", "Pomoćnik gradonačelnika", "2025-11-28"),
			o("2", "Žarko Mićin", "Gradonačelnik", "2025-02-24"),
			o("3", "Đurađ Jakšić", "Zamenik gradonačelnika", "2025-02-24"),
			o("4", "Milica Vučićević", "v.d. načelnika uprave", "2025-12-01"),
		]
		assert.equal(pickHead(grad)?.fullName, "Žarko Mićin")
		assert.equal(pickHead([o("1", "Tihomir Vejnović", "Predsednik nadzornog odbora", "2025-06-25")]), undefined)
	})

	test("the director of a provincial fund or a branch is not the head of the institution", () => {
		const pio = [o("1", "Slavko Imrić", "Direktor pokrajinskog fonda za penzijsko i invalidsko osiguranje", "2012-02-07"), o("2", "Danilo Vujičić", "v.d. predsednik upravnog odbora", "2024-09-27")]
		assert.equal(pickHead(pio), undefined, "only a unit head and a board chair: the head is unknown")
		assert.equal(pickHead([o("1", "Svetlana Milijić", "Direktor filijale", "2013-11-01")]), undefined)
		assert.equal(pickHead([o("1", "Ana Anić", "Direktor", "2020-01-01"), o("2", "Pera Perić", "Direktor regionalnog centra", "2024-01-01")])?.fullName, "Ana Anić")
	})

	test("a head's own report on leaving closes the function the register left open (EPS)", () => {
		const head = o("1", "Miroslav Tomašević", "v.d. generalnog direktora", "2022-03-03")
		const report = (reason: string, source: string, period: string) => ({ personId: "1", fullName: "Miroslav Tomašević", reportDate: "2023-07-12", reason, summary: [], incomes: [{ source, period }], source: src })
		const ended = endedByReport(head, [report("prestanak javne funkcije", "V.f. direktora, JP EPS Beograd", "mesečno, 04.03.2022. - 15.06.2023.")])
		assert.equal(ended?.to, "2023-06-15")
		assert.equal(endedByReport(head, [report("redovni izveštaj", "V.f. direktora, JP EPS Beograd", "mesečno, 04.03.2022. - 15.06.2023.")]), undefined, "only a report on leaving")
		assert.equal(endedByReport(head, [report("prestanak javne funkcije", "Član skupštine društva, D.o.o. Park Palić", "mesečno, 11.05.2022. - 15.06.2023.")]), undefined, "another function")
		assert.equal(endedByReport(head, [report("prestanak javne funkcije", "Direktor, JP Neko", "mesečno, 01.01.2019. - 15.06.2021.")]), undefined, "an earlier function")
	})

	test("the minister heads a ministry; acting assistants are checked on their own", () => {
		const list = [o("1", "Vladimir Batalović", "v.d. pomoćnika ministra", "2025-11-01"), o("2", "Aleksandra Sofronijević", "Ministar", "2025-04-16"), o("3", "Neko Neki", "Državni sekretar", "2025-05-01")]
		assert.equal(pickHead(list)?.fullName, "Aleksandra Sofronijević")
		const check = checkVd(list[0], { legalType: "organ_drzavne_uprave" }, "2026-10-30")
		assert.equal(check.rule?.maxMonths, 6)
		assert.equal(check.rule?.extensionMonths, 3)
		assert.equal(check.overLimit, true, "12 months > 6 + 3")
	})
})

describe("acting terms", () => {
	test("a closed v.d. term longer than the health-care limit is reported, a short one is not", () => {
		const list = [
			o("1", "Vesna Turkulov", "Direktor", "2024-12-06"),
			o("2", "Vesna Turkulov", "v.d. direktora", "2024-08-29", "2024-12-06"),
			o("3", "Edita Stokić", "v.d. direktora", "2019-02-21", "2024-08-29"),
			o("3", "Edita Stokić", "v.d. direktora", "2019-02-21", "2024-08-29"),
		]
		const past = pastActingOverLimit(list, "zdravstvena_ustanova")
		assert.deepEqual(past.terms.map((t) => [t.name, t.months]), [["Edita Stokić", 66]])
		assert.equal(pastActingOverLimit(list, "lokalna_samouprava").terms.length, 0, "no rule, no claim")
	})

	test("the same person acting again is found for the current head only", () => {
		const list = [o("1", "T. P.", "v.d. direktora", "2026-06-10"), o("1", "T. P.", "v.d. direktora", "2025-12-10", "2026-06-10")]
		assert.deepEqual(earlierActingTerms(list, list[0]).map((t) => t.from), ["2025-12-10"])
		assert.equal(ruleFor("lokalna_samouprava"), undefined)
	})
})

describe("names", () => {
	test("a generic name keeps its city, a distinctive one drops it", () => {
		assert.equal(normalizeName("Dom zdravlja Novi Sad"), "dom zdravlja novi sad")
		assert.equal(normalizeName("Grad Novi Sad"), "grad novi sad")
		assert.equal(normalizeName("JP Srbijagas Novi Sad"), "srbijagas")
		assert.equal(normalizeName("ADA SYSTEM DOO NOVI SAD"), "ada system")
	})

	test("the media name has no JP prefix and no registry seat, but keeps a city that is part of the name", () => {
		assert.equal(mediaName('JP "Pošta Srbije" Beograd'), "Pošta Srbije")
		assert.equal(mediaName("JP Srbijagas Novi Sad"), "Srbijagas")
		assert.equal(mediaName("Dom zdravlja Novi Sad"), "Dom zdravlja Novi Sad")
		assert.equal(mediaName("JKP Vodovod i kanalizacija Novi Sad"), "Vodovod i kanalizacija Novi Sad")
	})

	test("all-caps Cyrillic keeps upper-case digraphs", () => {
		assert.equal(cyrToLat("ДОМ ЗДРАВЉА"), "DOM ZDRAVLJA")
		assert.equal(cyrToLat("Дом здравља Његош"), "Dom zdravlja Njegoš")
	})

	test("legal type from the name", () => {
		assert.equal(guessLegalType("Dom zdravlja Novi Sad", true), "zdravstvena_ustanova")
		assert.equal(guessLegalType("Grad Novi Sad", true), "lokalna_samouprava")
		assert.equal(guessLegalType("JKP Gradska čistoća Beograd", true), "javno_preduzece")
		assert.equal(guessLegalType("Ministarstvo zdravlja", true), "organ_drzavne_uprave")
		assert.equal(guessLegalType("Republički fond za zdravstveno osiguranje", true), "ostalo")
	})
})
