// npm test: rules added with the live-path QA (docs/QA-live.md) that need no network: which official is the head, closed v.d. terms
// past the limit, a legal form without a rule, the city that stays in a generic name, all-caps transliteration.

import assert from "node:assert/strict"
import { describe, test } from "node:test"

process.env.DATA_MODE = "cache"

const { pickHead, pastActingOverLimit, earlierActingTerms, checkVd } = await import("../src/data/analysis/vd")
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
