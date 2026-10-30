// npm test: one full scripted case in-process (real Mozaik runtime, cached data, no key) plus unit tests of the
// deterministic pieces. Run with DATA_MODE=cache, DEMO_SPEED=0.05, HUMAN_AUTO_APPROVE_MS=0.

import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

process.env.DATA_MODE = "cache"
process.env.DEMO_SPEED = "0.05"
process.env.HUMAN_AUTO_APPROVE_MS = "0"
process.env.DOSIJE_MODE = "scripted"

const { applyEntryDefaults } = await import("../src/config")
applyEntryDefaults("test")
const { boot, startCase, waitForDone, getSnapshot, submitAnswer, shutdown } = await import("../src/mozaik/boot")
const { bus } = await import("../src/mozaik/bus")
const { scrubText } = await import("../src/mozaik/gate")
const { computeStatus } = await import("../src/mozaik/state")
const { normClaim } = await import("../src/mozaik/util")
const { checkVd, analyzeVdChain } = await import("../src/data/analysis/vd")
const { isPublicSystem } = await import("../src/data/analysis/procurement")
type WireEvent = import("../src/shared/types").WireEvent

describe("deterministic pieces", () => {
	test("v.d. check: 17 months against a 12-month limit is over the limit", () => {
		const official = {
			id: "1",
			fullName: "Petar Petrović",
			position: "v.d. direktora",
			isActing: true,
			institutionName: "Primer d.o.o.",
			from: "2025-05-22",
			source: { kind: "acas" as const, title: "ACAS", url: "https://publicacas.acas.rs/", retrievedAt: "2026-10-30T00:00:00Z", official: true },
		}
		const check = checkVd(official, { legalType: "drustvo_kapitala_drzavno" }, "2026-10-30")
		assert.equal(check.months, 17)
		assert.equal(check.overLimit, true)
		assert.ok(check.rule?.maxMonths === 12)
		assert.ok(check.daysOver > 100)
		assert.equal(checkVd(official, { legalType: "ostalo" }, "2026-10-30").applicable, false, "no rule for the legal type: never assume a limit")
		const chain = analyzeVdChain([official, { ...official, id: "2", from: "2024-01-01", to: "2025-05-22" }], "2026-10-30")
		assert.equal(chain?.actingCount, 2)
	})

	test("PII scrub removes e-mails and phone numbers but keeps MB, PIB and dates", () => {
		const out = scrubText("Pišite na petar@primer.rs ili pozovite 011 3030 303, +381 64 123 4567. MB 07007060, PIB 109108420, 22.05.2025.")
		assert.ok(!out.includes("@"))
		assert.ok(!out.includes("3030"))
		assert.ok(!out.includes("123 4567"))
		assert.ok(out.includes("07007060") && out.includes("109108420") && out.includes("22.05.2025."))
	})

	test("claim values are compared after normalization", () => {
		assert.equal(normClaim("v.d. generalnog direktora"), normClaim("vd generalnog direktora"))
		assert.notEqual(normClaim("v.d. generalnog direktora"), normClaim("generalni direktor"))
	})

	test("status: official > two hosts > one", () => {
		const s = (url: string, official = false) => ({ kind: "vesti" as const, title: "x", url, retrievedAt: "", official })
		assert.equal(computeStatus([s("https://a.rs/1"), s("https://b.rs/2", true)]), "zvanicno")
		assert.equal(computeStatus([s("https://a.rs/1"), s("https://www.b.rs/2")]), "potvrdjeno")
		assert.equal(computeStatus([s("https://a.rs/1"), s("https://a.rs/2")]), "nepotvrdjeno")
	})

	test("state utilities and public systems are recognised", () => {
		assert.equal(isPublicSystem("EPS AD Beograd"), true)
		assert.equal(isPublicSystem("NIS A.D. NOVI SAD"), true)
		assert.equal(isPublicSystem("Fakultet tehničkih nauka"), true)
		assert.equal(isPublicSystem("ZGOP DOO"), false)
		assert.equal(isPublicSystem("INSTITUT GOŠA DOO BEOGRAD"), false)
	})
})

describe("full scripted case (IŽS, cached data)", () => {
	const events: WireEvent[] = []
	let answeredOwner = false
	let off: () => void

	before(async () => {
		off = bus.onWire((ev) => {
			events.push(ev)
			if (!answeredOwner && ev.type === "pitanje.za_coveka") {
				const task = (ev.payload as { task: { id: string; kind: string } }).task
				if (task.kind === "pitanje") {
					answeredOwner = true
					setTimeout(() => submitAnswer({ taskId: task.id, answer: "Petar Petrović" }), 0)
				}
			}
		})
		await boot()
	})

	after(async () => {
		off()
		await shutdown()
	})

	test("agents run concurrently, coordinate through shared state and the gate blocks unsourced claims", { timeout: 120_000 }, async () => {
		const { caseId } = await startCase("Infrastruktura železnice Srbije")
		const report = await waitForDone(100_000)
		assert.ok(report, "the dossier finished")
		const snap = getSnapshot()
		assert.equal(snap.status, "done")
		assert.equal(snap.caseId, caseId)

		assert.ok(snap.stats.peakConcurrentLoops >= 4, `peak concurrent loops ${snap.stats.peakConcurrentLoops}`)
		const dynamic = snap.agents.filter((a) => a.dynamic)
		assert.ok(dynamic.length >= 4, `dynamic agents ${dynamic.length}`)
		assert.ok(snap.stats.blockedClaims >= 1 && events.some((e) => e.type === "claim.blocked"), "an unsourced claim was blocked")

		const won = snap.conflicts.find((c) => c.rule === "zvanicni_izvor_ima_prednost")
		assert.ok(won, "a conflict was resolved in favour of the official source")
		const winner = snap.findings.find((f) => f.id === won.winnerFindingId)
		assert.ok(winner?.sources.some((s) => s.official), "the winner has an official source")
		const loser = snap.findings.find((f) => f.conflictId === won.id && f.id !== won.winnerFindingId)
		assert.equal(loser?.status, "demantovano")

		assert.ok(snap.findings.length >= 10)
		for (const f of snap.findings) assert.ok(f.sources.length >= 1, `finding ${f.id} has a source`)

		const vd = snap.findings.find((f) => f.signalCode === "VD_PREKO_ROKA")
		assert.ok(vd, "VD_PREKO_ROKA finding exists")
		assert.equal(vd.approval, "approved")
		assert.ok(snap.tasks.some((t) => t.kind === "odobrenje" && t.status === "approved"), "the approval task was resolved")
		assert.ok(snap.findings.some((f) => f.signalCode === "VD_LANAC"), "chain of acting heads reported")

		assert.ok(report.topSignals.length >= 3, `topSignals ${report.topSignals.length}`)
		assert.ok(report.markdown.includes("Šta još treba proveriti") && report.markdown.includes("Kako je nastao"))
		assert.ok(report.markdown.includes("signali za proveru"), "disclaimer present")
		assert.equal(events.at(-1)?.type === "dosije.zavrsen" || events.some((e) => e.type === "dosije.zavrsen"), true)
	})

	test("the journalist's answer cascades into new concurrent work (Provera + Mediji)", () => {
		const snap = getSnapshot()
		assert.ok(answeredOwner, "an owner question was asked")
		assert.ok(snap.entities.some((e) => e.kind === "osoba" && e.role === "vlasnik" && e.name === "Petar Petrović"), "owner entity added from the answer")
		assert.ok(snap.agents.some((a) => a.group === "provera" && a.name.includes("Petar Petrović")), "Provera agent spawned for the owner")
		assert.ok(snap.tasks.some((t) => t.kind === "pitanje" && t.status === "answered"))
	})

	test("a second case resets the shared state (initializeRuntime runs once)", { timeout: 120_000 }, async () => {
		const first = getSnapshot().caseId
		const { caseId } = await startCase("IŽS", "popis stanja")
		assert.notEqual(caseId, first)
		const mid = getSnapshot()
		assert.equal(mid.status, "running")
		assert.ok(mid.findings.every((f) => f.caseId === caseId))
		const report = await waitForDone(100_000)
		assert.ok(report && report.caseId === caseId)
		assert.ok(getSnapshot().findings.every((f) => f.caseId === caseId))
	})
})
