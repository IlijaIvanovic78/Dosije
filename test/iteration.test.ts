// Unit tests of the deterministic pieces added in the jury-feedback iteration: ranking of the top signals, DRI period wording,
// press outlet quality, read-only cache in DATA_MODE=cache, punctuation helpers and the clause-based titles.

import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { describe, test } from "node:test"

process.env.DATA_MODE = "cache"
process.env.DOSIJE_MODE = "scripted"

const { pickTop, orderTop, rankTier } = await import("../src/mozaik/summary")
const { outOfCredits } = await import("../src/mozaik/inference/resilient")
const { fixPunct } = await import("../src/mozaik/domain")
const { auditedPeriod, reportSourceTitle } = await import("../src/data/sources/dri")
const { driLabels, driTitle } = await import("../src/mozaik/inference/policies")
const { preferEstablished, isEstablishedOutlet, cleanOutlet, MIN_ESTABLISHED } = await import("../src/data/sources/news")
const { writeCache, CACHE_DIR } = await import("../src/data/cache")
const { clauseHeadline } = await import("../src/shared/text")
const { label } = await import("../scripts/lib/gantt")
type Finding = import("../src/shared/types").Finding
type DosijeState = import("../src/mozaik/state").DosijeState

let seq = 0
function finding(p: Partial<Finding> & Pick<Finding, "title" | "section">): Finding {
	const id = `f${++seq}`
	return {
		id,
		caseId: "c",
		text: "t",
		status: "zvanicno",
		severity: "signal",
		sources: [],
		entityIds: [],
		agentId: "a",
		agentName: "Agent",
		createdAt: `2026-10-30T10:00:${String(seq).padStart(2, "0")}Z`,
		updatedAt: "",
		approval: "not_required",
		...p,
	}
}
const stateOf = (list: Finding[]) => ({ findingList: () => list }) as unknown as DosijeState

describe("ranking of the top signals", () => {
	// the real bug: for Srbijagas an unconfirmed Integrity Watch flag was #1 and "act not found" #5
	const list = [
		finding({ title: "IW 1", section: "firme", signalCode: "POLITICKA_VEZA", status: "nepotvrdjeno" }),
		finding({ title: "IW 2", section: "firme", signalCode: "POLITICKA_VEZA", status: "nepotvrdjeno" }),
		finding({ title: "IW 3", section: "firme", signalCode: "POLITICKA_VEZA", status: "nepotvrdjeno" }),
		finding({ title: "Akt nije pronađen", section: "rukovodstvo", severity: "paznja", signalCode: "IMENOVANJE_NEPOZNATO", status: "zvanicno" }),
		finding({ title: "v.d. preko roka", section: "rukovodstvo", signalCode: "VD_PREKO_ROKA", status: "zvanicno", approval: "approved" }),
		finding({ title: "Postupci bez objave", section: "novac", signalCode: "BEZ_OBJAVE", status: "zvanicno" }),
		finding({ title: "DRI nalaz", section: "revizija", severity: "paznja", signalCode: "DRI_NALAZ", status: "zvanicno" }),
		finding({ title: "Medijski navod", section: "mediji", severity: "paznja", signalCode: "MEDIJSKI_NAVOD", status: "nepotvrdjeno" }),
		finding({ title: "Medijski navod, 2 izvora", section: "mediji", severity: "paznja", signalCode: "MEDIJSKI_NAVOD", status: "potvrdjeno" }),
	]

	test("official first, then confirmed; unconfirmed and 'not found' never first; one finding per signalCode", () => {
		const top = pickTop(stateOf(list), 5)
		assert.equal(top[0].title, "v.d. preko roka")
		assert.ok(top.every((f, i) => i === 0 || rankTier(f) >= rankTier(top[i - 1])), "ordered by reliability tier")
		const codes = top.map((f) => f.signalCode)
		assert.equal(new Set(codes).size, codes.length, `one per code: ${codes.join(", ")}`)
		assert.ok(top.filter((f) => f.signalCode === "POLITICKA_VEZA").length <= 1)
		assert.ok(top.findIndex((f) => f.signalCode === "IMENOVANJE_NEPOZNATO") !== 0)
		const unconfirmedAt = top.findIndex((f) => f.status === "nepotvrdjeno")
		assert.ok(unconfirmedAt === -1 || unconfirmedAt > top.findIndex((f) => f.status === "zvanicno"))
	})

	test("an unconfirmed finding may lead only when nothing better exists; a model's own list is re-ordered by the same rules", () => {
		const onlyWeak = list.filter((f) => f.status === "nepotvrdjeno")
		assert.ok(pickTop(stateOf(onlyWeak), 5).length >= 2)
		const proposed = [list[0], list[7], list[4], list[5]]
		const ordered = orderTop(proposed, 5)
		assert.equal(ordered[0].title, "v.d. preko roka")
		assert.ok(ordered.indexOf(list[0]) > ordered.indexOf(list[5]), "official before the unconfirmed flag")
	})

	test("a name match with the register of officials ranks by how well it is backed, not as an official fact", () => {
		const src = (kind: string) => ({ kind, title: kind, url: "https://x", retrievedAt: "2026-10-31", official: kind === "acas" }) as Finding["sources"][number]
		const onlyRegister = finding({ title: "Ime vlasnika se poklapa", section: "firme", signalCode: "VLASNIK_FUNKCIONER", sources: [src("acas")] })
		const alsoPep = finding({ title: "Ime vlasnika se poklapa, PEP", section: "firme", signalCode: "VLASNIK_FUNKCIONER", sources: [src("acas"), src("opensanctions")] })
		assert.equal(rankTier(onlyRegister), 2, "a namesake is possible: ranked with unconfirmed findings")
		assert.equal(rankTier(alsoPep), 1, "named on a PEP list too: ranked with confirmed findings")
		const vd = finding({ title: "v.d. preko roka", section: "rukovodstvo", signalCode: "VD_PREKO_ROKA" })
		const top = pickTop(stateOf([vd, onlyRegister, alsoPep]), 5)
		assert.ok(!top.includes(onlyRegister), "a register-only name match stays out of the summary")
		assert.ok(top.includes(alsoPep), "a name match backed by a PEP list may be in it")
		assert.ok(!orderTop([vd, onlyRegister], 5).includes(onlyRegister), "also when the editor model proposes it")
	})

	test("a kind of red flag is not left out of a full summary because its source is unconfirmed", () => {
		// PIO Fond: five official findings fill the summary, six Integrity Watch flags would not show at all
		const official = [
			finding({ title: "Ugovor veći od prihoda", section: "firme", signalCode: "UGOVOR_VECI_OD_PRIHODA" }),
			finding({ title: "Bez objave", section: "novac", severity: "paznja", signalCode: "BEZ_OBJAVE" }),
			finding({ title: "Koncentracija", section: "novac", severity: "paznja", signalCode: "KONCENTRACIJA" }),
			finding({ title: "DRI nalaz", section: "revizija", severity: "paznja", signalCode: "DRI_NALAZ" }),
			finding({ title: "Nema izveštaja o imovini", section: "rukovodstvo", severity: "paznja", signalCode: "IMOVINA" }),
		]
		const flags = [1, 2, 3].map((k) => finding({ title: `IW ${k}`, section: "firme", signalCode: "POLITICKA_VEZA", status: "nepotvrdjeno" }))
		const top = pickTop(stateOf([...official, ...flags]), 5)
		assert.equal(top.length, 5)
		assert.equal(top.filter((f) => f.signalCode === "POLITICKA_VEZA").length, 1, `one flag in: ${top.map((f) => f.title).join(", ")}`)
		assert.equal(top.at(-1)?.signalCode, "POLITICKA_VEZA", "it still comes after the official findings")
		assert.ok(top.some((f) => f.signalCode === "UGOVOR_VECI_OD_PRIHODA"), "a red official finding keeps its place")
	})
})

describe("LLM provider without credits", () => {
	test("an account without credits is told apart from a rate limit that passes", () => {
		const err = (status: number, message: string) => Object.assign(new Error(message), { status })
		assert.equal(outOfCredits(err(429, "You have no credits remaining. Add credits to continue using the API")), true)
		assert.equal(outOfCredits(err(429, "You exceeded your current quota, please check your plan and billing details.")), true)
		assert.equal(outOfCredits(err(429, "Rate limit reached for requests")), false, "a rate limit is retried, not given up")
		assert.equal(outOfCredits(err(500, "billing service unavailable")), false)
		assert.equal(outOfCredits(err(400, "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.")), true)
		assert.equal(outOfCredits(err(402, "billing_error")), true)
		assert.equal(outOfCredits(err(400, "max_tokens: Field required")), false, "a bad request is not a missing credit")
	})
})

describe("DRI: audited period vs publication date", () => {
	test("the period is read from the title only", () => {
		assert.equal(auditedPeriod("Izveštaj o reviziji finansijskih izveštaja Akcionarskog društva Infrastruktura železnice Srbije za 2018. godinu", "finansijska revizija"), "2018")
		assert.equal(auditedPeriod("Izveštaj o reviziji pravilnosti poslovanja društva za 2021. i 2022. godinu", "revizija pravilnosti"), "2021–2022")
		assert.equal(auditedPeriod("Izveštaj o reviziji pravilnosti i svrsishodnosti poslovanja Pravilnost i efikasnost preduzetih mera Akcionarskog društva", "revizija pravilnosti i svrsishodnosti"), undefined)
		assert.equal(auditedPeriod("Odazivni izveštaj za 2018. godinu", "odazivni izveštaj"), undefined, "only primary audits have a period")
	})

	test("labels: 'finansijski izveštaji za 2018.' or 'izveštaj objavljen 25.07.2025.', never the publication year as a period", () => {
		const audited = driLabels({ kind: "finansijska revizija", period: "2018", publishedAt: "2019-12-04" })
		assert.equal(audited.title, "za 2018.")
		assert.match(audited.text, /^finansijski izveštaji za 2018\., izveštaj objavljen 04\.12\.2019\.$/)
		const published = driLabels({ kind: "revizija pravilnosti i svrsishodnosti", publishedAt: "2025-07-25" })
		assert.equal(published.title, "izveštaj od 25.07.2025.")
		assert.ok(published.text.includes("izveštaj objavljen 25.07.2025."))
		assert.ok(!/2025\. godin/.test(published.text))
		assert.match(driTitle(published.title, "revizija pravilnosti", "Društvo nije u skladu sa propisom o javnim nabavkama, što je utvrđeno u postupku."), /^DRI izveštaj od 25\.07\.2025\. · javne nabavke: /)
		assert.equal(reportSourceTitle({ kind: "revizija pravilnosti", period: "2022", publishedAt: "2023-07-12" }), "DRI – revizija pravilnosti za 2022., izveštaj objavljen 12.07.2023.")
	})
})

describe("press outlets", () => {
	const item = (outlet: string, url: string) => ({ outlet, url })
	const known = ["https://www.danas.rs/a", "https://n1info.rs/b", "https://nova.rs/c", "https://www.rts.rs/d", "https://www.021.rs/e"].map((u) => item("x", u))
	const tabloid = item("Serbiantimes.info", "https://serbiantimes.info/odbili-da-potpisu")

	test("with 5 or more articles from known outlets, other domains are dropped", () => {
		assert.equal(MIN_ESTABLISHED, 5)
		const kept = preferEstablished([...known, tabloid])
		assert.equal(kept.length, 5)
		assert.ok(!kept.includes(tabloid))
	})
	test("with fewer, unknown domains stay (a small institution still gets a review)", () => {
		const few = [...known.slice(0, 2), tabloid]
		assert.equal(preferEstablished(few).length, 3)
		assert.ok(isEstablishedOutlet(item("Danas", "https://news.google.com/rss/articles/abc")), "an unresolved link is judged by the outlet name")
		assert.ok(!isEstablishedOutlet(tabloid))
	})
	test("the aggregator is not the outlet", () => {
		assert.equal(cleanOutlet("raspadsistema.com (Danas)"), "Danas")
		assert.equal(cleanOutlet("N1"), "N1")
	})
})

describe("DATA_MODE=cache never writes into data/cache", () => {
	test("writeCache is a no-op", async () => {
		const key = `readonly-check-${Date.now()}`
		await writeCache("vesti", key, { junk: true })
		assert.equal(fs.existsSync(path.join(CACHE_DIR, "vesti", `${key}.json`)), false)
	})
})

describe("text helpers", () => {
	test("a date followed by the sentence's own full stop is not doubled", () => {
		assert.equal(fixPunct("Izveštaj je od 12.10.2026.. Proveriti."), "Izveštaj je od 12.10.2026. Proveriti.")
		assert.equal(fixPunct("Sadržaj... ostaje"), "Sadržaj... ostaje")
	})
	test("a long sentence is shortened at a clause boundary, not cut in the middle of a phrase", () => {
		const s = "Društvo je u dva postupka javne nabavke procenjene vrednosti 560 miliona dinara i ugovorene vrednosti 521,54 miliona dinara objavilo obaveštenja kasno"
		const t = clauseHeadline(s, 100)
		assert.equal(t, "Društvo je u dva postupka javne nabavke procenjene vrednosti 560 miliona dinara")
		assert.equal(clauseHeadline("Kratka rečenica.", 100), "Kratka rečenica")
	})
	test("a lane label never cuts a name silently", () => {
		assert.equal(label("Mediji · Bojan Stegnjaja").trim(), "Mediji · Bojan Stegnjaja")
		assert.ok(label("Mediji · Neko Sa Veoma Dugačkim Imenom i Prezimenom", 30).endsWith("…"))
	})
})
