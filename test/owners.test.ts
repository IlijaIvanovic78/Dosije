// npm test: the journalist's free-text answer to "Ko su vlasnici firme ...?" becomes person names plus a share attribute;
// fragments that are not names ("100%", "vlasnik", "ne znam") never become an entity, an agent or a search.

import assert from "node:assert/strict"
import { describe, test } from "node:test"

process.env.DATA_MODE = "cache"
process.env.DOSIJE_MODE = "scripted"

const { parseOwnerAnswer, describeOwners, MAX_OWNERS } = await import("../src/mozaik/owners")

const names = (answer: string) => parseOwnerAnswer(answer).map((o) => o.name)

describe("owner answers", () => {
	test("a name with its share: the share is an attribute, never part of the name", () => {
		assert.deepEqual(parseOwnerAnswer("Marko Marković, 100%"), [{ name: "Marko Marković", share: "100%" }])
		assert.deepEqual(parseOwnerAnswer("Marko Marković 100%"), [{ name: "Marko Marković", share: "100%" }])
		assert.deepEqual(parseOwnerAnswer("Marko Marković (100 %)"), [{ name: "Marko Marković", share: "100%" }])
		assert.deepEqual(parseOwnerAnswer("100% Marko Marković"), [{ name: "Marko Marković", share: "100%" }])
		assert.deepEqual(parseOwnerAnswer("Marko Marković - 100 odsto"), [{ name: "Marko Marković", share: "100%" }])
	})

	test("several owners with shares, separated by commas, semicolons, new lines or 'i'", () => {
		const two = [
			{ name: "Petar Petrović", share: "60%" },
			{ name: "Jovan Jovanović", share: "40%" },
		]
		assert.deepEqual(parseOwnerAnswer("Petar Petrović 60%, Jovan Jovanović 40%"), two)
		assert.deepEqual(parseOwnerAnswer("Petar Petrović 60%; Jovan Jovanović 40%"), two)
		assert.deepEqual(parseOwnerAnswer("Petar Petrović 60%\nJovan Jovanović 40%"), two)
		assert.deepEqual(parseOwnerAnswer("Petar Petrović (60%) i Jovan Jovanović (40%)"), two)
		assert.deepEqual(names("Ana Anić i Mila Milić"), ["Ana Anić", "Mila Milić"])
		assert.deepEqual(parseOwnerAnswer("Ana Anić i Mila Milić po 50%"), [
			{ name: "Ana Anić", share: "50%" },
			{ name: "Mila Milić", share: "50%" },
		])
	})

	test("words around the name are stripped: vlasnik, punctuation, decimal shares", () => {
		assert.deepEqual(names("Vlasnik je Marko Marković."), ["Marko Marković"])
		assert.deepEqual(names("vlasnik: Marko Marković"), ["Marko Marković"])
		assert.deepEqual(names("Marko Marković, vlasnik 100%"), ["Marko Marković"])
		assert.deepEqual(parseOwnerAnswer("Ana Anić 33,3% i Mila Milić 66,7%").map((o) => o.share), ["33,3%", "66,7%"])
		assert.deepEqual(names("marko marković i ana anić"), ["Marko Marković", "Ana Anić"], "typed in lower case")
		assert.deepEqual(names("Марко Марковић"), ["Marko Marković"], "Cyrillic is transliterated")
	})

	test("fragments that are not names are ignored: nothing is spawned or searched for '100%'", () => {
		assert.deepEqual(parseOwnerAnswer("100%"), [])
		assert.deepEqual(parseOwnerAnswer("100 %, 60%"), [])
		assert.deepEqual(parseOwnerAnswer("vlasnik"), [])
		assert.deepEqual(parseOwnerAnswer("Ne znam"), [])
		assert.deepEqual(parseOwnerAnswer("nepoznato"), [])
		assert.deepEqual(parseOwnerAnswer("nema podataka, 100%"), [])
		assert.deepEqual(parseOwnerAnswer(""), [])
		assert.deepEqual(names("Extra Auto Transport d.o.o"), [], "a firm is not a person")
		assert.deepEqual(names("Marko Marković, 100%, nepoznato, vlasnik"), ["Marko Marković"])
		for (const o of parseOwnerAnswer("Marko Marković, 100%")) assert.ok(!/\d|%/.test(o.name))
	})

	test("duplicates are merged, middle initials stay, at most MAX_OWNERS people", () => {
		assert.deepEqual(names("Marko Marković, Marko Marković 100%"), ["Marko Marković"])
		assert.deepEqual(names("Ivan A. Petrović"), ["Ivan A. Petrović"])
		assert.deepEqual(names("Ana-Marija Anić"), ["Ana-Marija Anić"])
		assert.equal(parseOwnerAnswer("Ana Anić, Bojan Bojić, Cica Cicić, Dana Danić, Emil Emilić").length, MAX_OWNERS)
		assert.deepEqual(parseOwnerAnswer("Marko Marković, Marko Marković 100%"), [{ name: "Marko Marković", share: "100%" }])
		assert.equal(describeOwners(parseOwnerAnswer("Petar Petrović 60%, Jovan Jovanović")), "Petar Petrović (60%), Jovan Jovanović")
	})
})

const { parseCompanyPage } = await import("../src/data/sources/companywall")

// the shape of a CompanyWall company page: <dt>label</dt><dd>value</dd> pairs, contacts next to the owners
const page = (mb: string, owners: string[]) => `
	<dl><dt class="col-sm-7">Naziv</dt><dd class="col-sm-5">ANTIKOR DOO</dd>
	<dt class="col-sm-7">PIB</dt><dd class="col-sm-5">100000571</dd>
	<dt class="col-sm-7">MB</dt><dd class="col-sm-5">${mb}</dd>
	<dt class="col-5"><i class="fas fa-phone"></i>Telefon</dt><dd class="col-7"><span>011123456</span></dd>
	<dt class="col-5"><i class="far fa-envelope"></i>E-mail</dt><dd class="col-7"><div><span>office@example.rs</span></div></dd></dl>
	<dl class="row">${owners.map((o) => `<dt class="col-sm-7">\n<i class="fas fa-user"></i>\n Vlasnik\n</dt>\n<dd class="col-sm-5" style="overflow:hidden">\n${o}    </dd>`).join("\n")}
	<dt class="col-sm-7"><i class="fas fa-user"></i> Direktor </dt><dd class="col-sm-5">MILOŠ TATOMIR</dd></dl>`

describe("CompanyWall owners", () => {
	test("people and companies with shares, the director; no contact data", () => {
		const r = parseCompanyPage(page("07007060", ["MILOŠ TATOMIR(33,34%)", "Dejan Živojinović(66,66%)", "MISTRAL INTERNATIONAL-FZCO(60,00%)", "TRIGLAV INT, D.O.O. 100,00%", "MESSER SE & CO. KGAA 85,89%"]), { mb: "07007060" })
		assert.deepEqual(r?.owners, [
			{ name: "Miloš Tatomir", share: "33,34%", kind: "osoba" },
			{ name: "Dejan Živojinović", share: "66,66%", kind: "osoba" },
			{ name: "MISTRAL INTERNATIONAL-FZCO", share: "60%", kind: "firma" },
			{ name: "TRIGLAV INT, D.O.O.", share: "100%", kind: "firma" },
			{ name: "MESSER SE & CO. KGAA", share: "85,89%", kind: "firma" },
		])
		assert.equal(r?.director, "Miloš Tatomir")
		assert.equal(r?.companyName, "ANTIKOR DOO")
		assert.equal(r?.mb, "07007060")
		assert.ok(!JSON.stringify(r).includes("011123456") && !JSON.stringify(r).includes("@"))
	})

	test("found by PIB when the MB is unknown; a page of another company is never used", () => {
		assert.equal(parseCompanyPage(page("07007060", ["Miloš Tatomir(100,00%)"]), { pib: "100000571" })?.mb, "07007060")
		assert.equal(parseCompanyPage(page("07007060", ["Miloš Tatomir(100,00%)"]), { mb: "21309192" }), null)
		assert.equal(parseCompanyPage(page("07007060", ["Miloš Tatomir(100,00%)"]), { pib: "110164390" }), null)
	})
})
