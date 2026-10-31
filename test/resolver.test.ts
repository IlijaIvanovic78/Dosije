// npm test: acronyms are spelled out from the register names ("RTS" is Radio televizija Srbije, not "Galerija RTS"), and only
// the words of a body's own name count (a legal form before, the seat after).

import assert from "node:assert/strict"
import { describe, test } from "node:test"

process.env.DATA_MODE = "cache"
process.env.DOSIJE_MODE = "scripted"

const { acronymPhrases, looksLikeAcronym, resolveInstitution } = await import("../src/data/resolver")

// a slice of the ACAS register, as names
const REGISTER = [
	"Galerija RTS",
	"Sportska gimnazija, Beograd",
	"Radiodifuzna ustanova Radio Televizija Srbije",
	"RDU Radio televizija Srbije",
	"Radio televizija Srbije, Beograd",
	"JP Radio televizija Srbije, Služba domaće nabavke",
	"JP Radio-televizija Šabac",
	"Ustanova za rekreativni turizam Sjenica",
	"Ministarstvo spoljnih poslova",
	"Medicinska škola Požarevac",
	"JP Srbijagas Novi Sad",
	"Republički fond za zdravstveno osiguranje",
]

describe("acronyms", () => {
	test("RTS is the national broadcaster, never a gallery that carries the letters", () => {
		const [first] = acronymPhrases("RTS", REGISTER)
		assert.equal(first.phrase.toLowerCase(), "radio televizija srbije")
		assert.equal(first.entries, 3, "the branch (Služba domaće nabavke) is not counted")
		assert.ok(!acronymPhrases("RTS", REGISTER).some((p) => /galerija|turizam/i.test(p.phrase)))
	})

	test("a national body comes before a local one that spells the same; words in between ('za', 'i') are skipped", () => {
		assert.equal(acronymPhrases("MSP", REGISTER)[0].phrase, "Ministarstvo spoljnih poslova")
		assert.equal(acronymPhrases("RFZO", REGISTER)[0].phrase, "Republički fond za zdravstveno osiguranje")
	})

	test("the seat and the legal form are not letters of the acronym", () => {
		assert.deepEqual(acronymPhrases("SNS", REGISTER), [])
	})

	test("what looks like an acronym", () => {
		for (const q of ["RTS", "rts", "RFZO", "NBS"]) assert.ok(looksLikeAcronym(q), q)
		for (const q of ["Srbijavoz", "Pošta Srbije", "Beograd"]) assert.ok(!looksLikeAcronym(q), q)
	})

	test("a news link is refused: names only", async () => {
		await assert.rejects(resolveInstitution("https://www.rts.rs/lat/vesti/123"), /Linkovi se ne prihvataju/)
		await assert.rejects(resolveInstitution("www.danas.rs/drustvo"), /Linkovi se ne prihvataju/)
	})
})
