// npm test: one full scripted case in-process (real Mozaik runtime, cached data, no key) plus unit tests of the
// deterministic pieces. Run with DATA_MODE=cache, DEMO_SPEED=0.05, HUMAN_AUTO_APPROVE_MS=0.

import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

process.env.DATA_MODE = "cache"
process.env.DEMO_SPEED = "0.05"
process.env.HUMAN_AUTO_APPROVE_MS = "0"
process.env.DOSIJE_MODE = "scripted"
// these cases test the owner question and the Provera cascade it starts (off in the app: owners come from CompanyWall)
process.env.DOSIJE_ASK_HUMAN = "1"
process.env.DOSIJE_COMPANYWALL = "0"
// and the blocking approval of a sensitive signal (off in the app: signals go in on their sources)
process.env.DOSIJE_APPROVALS = "1"

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
		assert.ok(report.markdown.includes("## Nepotvrđeno") && report.markdown.includes("Kako je nastao"))
		assert.ok(report.markdown.includes("Ovo su signali, ne zaključci"), "disclaimer present")
		// link targets aside (URLs), the report never tells the reader to verify anything
		const prose = report.markdown.replace(/\]\([^)]*\)/g, "]")
		assert.ok(!/proveriti|za proveru/i.test(prose), `the report tells the reader to verify: ${/.{0,60}(proveriti|za proveru).{0,40}/i.exec(prose)?.[0]}`)
		assert.equal(events.at(-1)?.type === "dosije.zavrsen" || events.some((e) => e.type === "dosije.zavrsen"), true)
	})

	test("the journalist's answer cascades into new concurrent work (Provera + Mediji)", () => {
		const snap = getSnapshot()
		assert.ok(answeredOwner, "an owner question was asked")
		assert.ok(snap.entities.some((e) => e.kind === "osoba" && e.role === "vlasnik" && e.name === "Petar Petrović"), "owner entity added from the answer")
		assert.ok(snap.agents.some((a) => a.group === "provera" && a.name.includes("Petar Petrović")), "Provera agent spawned for the owner")
		assert.ok(snap.tasks.some((t) => t.kind === "pitanje" && t.status === "answered"))
	})

	test("agents react to each other: Mediji to a Kadrovik finding, Revizor to a Nabavke finding", () => {
		const snap = getSnapshot()
		const reactions = events.filter((e) => e.type === "agent.reakcija").map((e) => e.payload as { agentName: string; reaction: { fromAgent: string; signalCode: string; findingId: string; tema?: string } })
		const mediji = reactions.find((r) => r.agentName === "Mediji" && r.reaction.fromAgent === "Kadrovik")
		const revizor = reactions.find((r) => r.agentName === "Revizor")
		assert.ok(mediji && ["VD_PREKO_ROKA", "VD_LANAC"].includes(mediji.reaction.signalCode), "Mediji reacted to a Kadrovik acting-head finding")
		assert.ok(revizor && revizor.reaction.fromAgent === "Nabavke" && ["BEZ_OBJAVE", "KONCENTRACIJA"].includes(revizor.reaction.signalCode), "Revizor reacted to a Nabavke finding")
		assert.ok(reactions.some((r) => r.agentName === "Mediji" && r.reaction.fromAgent === "Revizor" && r.reaction.signalCode === "DRI_NALAZ" && r.reaction.tema), "Mediji reacted to a Revizor DRI finding (audit topic)")
		const perKey = new Map<string, number>()
		for (const r of reactions) perKey.set(`${r.agentName}:${r.reaction.signalCode}:${r.reaction.tema ?? ""}`, (perKey.get(`${r.agentName}:${r.reaction.signalCode}:${r.reaction.tema ?? ""}`) ?? 0) + 1)
		assert.ok([...perKey.values()].every((c) => c === 1), `each reaction fires once per trigger code: ${[...perKey].join(", ")}`)

		// a new loop of the existing core agent, started by the finding: the first message names it, the lane is visible in the timeline
		const starts = events.filter((e) => e.type === "message_received.started")
		const povod = (agent: string, from: string) => starts.find((e) => e.producerName === agent && String((e.payload as { content: string }).content).startsWith(`Povod: nalaz ${from}: `))
		assert.ok(povod("Mediji", "Kadrovik"), "Mediji loop started with 'Povod: nalaz Kadrovik: ...'")
		assert.ok(povod("Revizor", "Nabavke"), "Revizor loop started with 'Povod: nalaz Nabavke: ...'")
		assert.ok(snap.agents.find((a) => a.name === "Mediji")?.reactions?.length, "AgentInfo of Mediji lists the reaction")
		assert.ok(povod("Mediji", "Revizor"), "Mediji loop started with 'Povod: nalaz Revizor: ...'")
		assert.ok(snap.agents.find((a) => a.name === "Revizor")?.reactions?.length, "AgentInfo of Revizor lists the reaction")

		// Revizor's corroboration: DRI report AND the procurement source, so it stands on two official sources
		const corroboration = snap.findings.find((f) => f.agentName === "Revizor" && f.title.startsWith("DRI je u izveštaju "))
		assert.ok(corroboration, "Revizor added a corroboration finding")
		assert.ok(corroboration.sources.some((s) => s.kind === "dri") && corroboration.sources.some((s) => s.kind === "jnportal"), "sources: DRI report + procurement portal")
		const backed = snap.findings.find((f) => f.id === corroboration.corroborates)
		assert.ok(backed && backed.agentName === "Nabavke" && backed.note?.includes("Potkrepljeno"), "the Nabavke finding says it was corroborated")
		assert.equal(corroboration.status, "zvanicno")
		assert.ok(!/izveštaj\w* za 2025\. godinu|DRI 2025/.test(`${corroboration.title} ${corroboration.text}`), "publication year is not an audited period")

		// Mediji's targeted check: a finding about the appointment with real articles (or merged into the claim of an older finding)
		// (the Urednik may merge it into an older finding with the same claim, so look at what Mediji added)
		const added = events.filter((e) => e.type === "finding.added").map((e) => (e.payload as { finding: import("../src/shared/types").Finding }).finding)
		const media = added.find((f) => f.agentName === "Mediji" && f.title.startsWith("Imenovanje u medijima: "))
		assert.ok(media && media.sources.length >= 1 && media.sources.every((s) => s.kind === "vesti"), "Mediji added a finding about the coverage of the appointment")
	})

	test("wording: a different headline is 'odstupa od registra', not a denial; DRI period; press outlets; punctuation", async () => {
		const snap = getSnapshot()
		const conflict = snap.conflicts.find((c) => c.rule === "zvanicni_izvor_ima_prednost")
		assert.ok(conflict)
		assert.match(conflict.explanation, /^Zvanični registar \(ACAS\) navodi «v\.d\. generalnog direktora»; .+ navodi «.+»\. Prednost ima zvanični registar\.$/)
		const loser = snap.findings.find((f) => f.conflictId === conflict.id && f.id !== conflict.winnerFindingId)
		assert.match(loser?.note ?? "", /^Zvanični registar \(ACAS\) navodi «v\.d\. generalnog direktora»; ovaj izvor navodi «.+»\. Prednost ima zvanični registar\.$/)
		const md = getSnapshot().report?.markdown ?? ""
		assert.ok(md.includes("odstupa od registra") && !/demantovan/i.test(md) && !md.includes("~~"), "report wording")
		assert.ok(!/raspadsistema\.com \(/.test(md) && !/serbiantimes/.test(md), "press review: original outlet only, no tabloid micro-sites")
		assert.ok(!/[\p{L}\p{N}]\.\.(?!\.)/u.test(md), "no double full stops")
		for (const item of getSnapshot().report?.toVerify ?? []) assert.ok(/[.!?]$/.test(item) && !item.includes("…"), `checklist item is a whole sentence: ${item}`)
		assert.ok(snap.findings.filter((f) => f.section === "revizija").every((f) => !/DRI 2025 ·/.test(f.title)), "no 'DRI 2025' for a report that was merely published in 2025")
		assert.ok(snap.findings.some((f) => /^DRI izveštaj od 25\.07\.2025\. · /.test(f.title)), "published-only reports say 'izveštaj od <datum>'")
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
