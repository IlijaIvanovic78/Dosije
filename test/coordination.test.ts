// npm test: the coordination added after the jury feedback, in-process on the real Mozaik runtime with cached data and no key:
// owner answers with a share, Mediji <- Revizor, the neutral appointment check, clean DRI findings, live-search finalization,
// and the cross-institution supplier links of the Mapa prioriteta ("mapa.veza"). Run with DATA_MODE=cache, DEMO_SPEED=0.05.

import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

process.env.DATA_MODE = "cache"
process.env.DEMO_SPEED = "0.05"
process.env.HUMAN_AUTO_APPROVE_MS = "0"
process.env.DOSIJE_MODE = "scripted"
// these cases test the owner question and the Provera cascade it starts (off in the app: owners come from CompanyWall)
process.env.DOSIJE_ASK_HUMAN = "1"
process.env.DOSIJE_COMPANYWALL = "0"

const { applyEntryDefaults } = await import("../src/config")
applyEntryDefaults("test")
const { boot, startCase, startMapa, waitForDone, waitForMapa, getSnapshot, submitAnswer, shutdown } = await import("../src/mozaik/boot")
const { bus } = await import("../src/mozaik/bus")
const { finalizeActivities } = await import("../src/mozaik/activity")
const { trackActivity, withActivityContext } = await import("../src/data/activity")
const { isStaleDri } = await import("../src/mozaik/summary")
const { scoreSignals } = await import("../src/data/analysis/priority")
type WireEvent = import("../src/shared/types").WireEvent
type Finding = import("../src/shared/types").Finding
type SourceActivity = import("../src/shared/types").SourceActivity
type MapaRow = import("../src/shared/types").MapaRow
type MapaVeza = import("../src/shared/types").MapaVeza

const upits = (events: WireEvent[]) => events.filter((e) => e.type === "izvor.upit")
const act = (e: WireEvent) => e.payload as SourceActivity
function byRequest(events: WireEvent[]) {
	const groups = new Map<string, WireEvent[]>()
	for (const e of upits(events)) groups.set(act(e).id, [...(groups.get(act(e).id) ?? []), e])
	return groups
}
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))

describe("full case: owner answer 'Marko Marković, 100%', Mediji <- Revizor, neutral appointment check", () => {
	const events: WireEvent[] = []
	let off: () => void
	let answered = false
	let caseId = ""

	before(async () => {
		off = bus.onWire((ev) => {
			events.push(ev)
			if (!answered && ev.type === "pitanje.za_coveka") {
				const task = (ev.payload as { task: { id: string; kind: string } }).task
				if (task.kind === "pitanje") {
					answered = true
					setTimeout(() => submitAnswer({ taskId: task.id, answer: "Marko Marković, 100%" }), 0)
				}
			}
		})
		await boot()
	})

	after(async () => {
		off()
		await shutdown()
	})

	test("the owner is one person with the share as an attribute: nothing is spawned or searched for '100%'", { timeout: 120_000 }, async () => {
		caseId = (await startCase("Infrastruktura železnice Srbije")).caseId
		assert.ok(await waitForDone(100_000), "the dossier finished")
		const snap = getSnapshot()
		assert.ok(answered, "an owner question was asked")
		// owners the journalist entered (CompanyWall owners from a local cache may sit next to them)
		const owners = snap.entities.filter((e) => e.kind === "osoba" && e.role === "vlasnik" && e.sources.some((src) => src.kind === "novinar"))
		assert.deepEqual(owners.map((e) => e.name), ["Marko Marković"])
		assert.equal(owners[0].attrs.udeo, "100%")
		assert.ok(snap.entities.every((e) => !/\d|%/.test(e.name) || e.kind === "firma" || e.kind === "institucija"), "no entity named after a share")
		assert.ok(snap.agents.every((a) => !/100|%/.test(a.name)), `no agent for '100%': ${snap.agents.map((a) => a.name).filter((x) => /100|%/.test(x)).join(", ")}`)
		assert.equal(snap.agents.filter((a) => a.group === "provera").length, 1, "one Provera agent, for Marko Marković")
		assert.ok(upits(events).every((e) => !/100\s?%/.test(act(e).label)), "no live search for the share")
	})

	test("Mediji reads the shared state and searches coverage of a DRI audit topic (Mediji <- Revizor)", () => {
		const reactions = events.filter((e) => e.type === "agent.reakcija").map((e) => e.payload as { agentName: string; reaction: { fromAgent: string; signalCode: string; tema?: string; findingId: string } })
		const mine = reactions.filter((r) => r.agentName === "Mediji" && r.reaction.fromAgent === "Revizor")
		assert.ok(mine.length >= 1, "Mediji reacted to a Revizor finding")
		assert.ok(mine.every((r) => r.reaction.signalCode === "DRI_NALAZ" && ["javne nabavke", "vršioci dužnosti"].includes(r.reaction.tema ?? "")), JSON.stringify(mine))
		assert.equal(new Set(mine.map((r) => r.reaction.tema)).size, mine.length, "once per audit topic")

		const start = events.find((e) => e.type === "message_received.started" && e.producerName === "Mediji" && String((e.payload as { content: string }).content).startsWith("Povod: nalaz Revizor: "))
		assert.ok(start, "a Mediji loop started with 'Povod: nalaz Revizor: ...'")
		assert.match((start.payload as { content: string }).content, /Tema revizije: (javne nabavke|vršioci dužnosti)\./)
		const tools = events.filter((e) => e.type === "function_call.started" && e.loopId === start.loopId).map((e) => (e.payload as { name: string }).name)
		assert.deepEqual(tools.slice(0, 2), ["dosije_pregled", "vesti_tema_revizije"], "reads the shared state, then searches the topic")

		const snap = getSnapshot()
		const found = snap.findings.filter((f) => f.agentName === "Mediji" && f.title.startsWith("Mediji o temi revizije "))
		assert.ok(found.length >= 1, "a finding with the coverage of the audit topic")
		for (const f of found) {
			assert.ok(f.sources.length >= 1 && f.sources.every((s) => s.kind === "vesti" && /^https?:\/\//.test(s.url)), `${f.title}: real articles as sources`)
			assert.equal(f.severity, "info")
			assert.ok(/ne potvrđuju niti pobijaju nalaz DRI/.test(f.text), "neutral wording")
		}
	})

	test("'Imenovanje u medijima': the aggregate is neutral and never carries the claim; the mark against the register comes from one article", () => {
		const added = events.filter((e) => e.type === "finding.added").map((e) => (e.payload as { finding: Finding }).finding)
		const aggregate = added.find((f) => f.agentName === "Mediji" && f.title.startsWith("Imenovanje u medijima: "))
		assert.ok(aggregate, "the aggregate finding exists")
		assert.equal(aggregate.severity, "info")
		assert.equal(aggregate.signalCode, undefined)
		assert.equal(aggregate.claim, undefined, "no claim on the aggregate")
		assert.ok(aggregate.sources.length >= 1 && aggregate.sources.every((s) => s.kind === "vesti"))
		assert.match(aggregate.text, /čiji naslov ili uvod pominje osobu/)
		const snap = getSnapshot()
		const marked = snap.findings.filter((f) => f.status === "demantovano")
		assert.ok(marked.length >= 1, "a specific article is marked as differing from the register")
		for (const f of marked) {
			assert.equal(f.sources.length, 1, `${f.title}: one specific article`)
			assert.ok(!f.title.startsWith("Imenovanje u medijima"), "never the aggregate")
		}
		assert.ok(["potvrdjeno", "nepotvrdjeno"].includes(snap.findings.find((f) => f.id === aggregate.id)?.status ?? "potvrdjeno"), "the aggregate has a status from its sources")
	})

	test("DRI findings: no neutral or positive statements, no PDF artifacts, no cut-off quotes; the top signals hold no old DRI finding", () => {
		const snap = getSnapshot()
		const dri = snap.findings.filter((f) => f.section === "revizija")
		assert.ok(dri.length >= 4)
		for (const f of dri) {
			const all = `${f.title} ${f.text}`
			assert.ok(!/obračunalo i platilo svoju obavezu|zatezne kamate i uplatilo/.test(all), `positive statement in ${f.title}`)
			assert.ok(!/\bPage \d+\b/.test(all), `PDF artifact in ${f.title}`)
			assert.ok(!/„[^“]*…“/.test(f.text), `a cut-off quote in ${f.title}`)
		}
		const top = (snap.report?.topSignals ?? []).map((t) => snap.findings.find((f) => f.id === t.findingId) as Finding)
		assert.ok(top.length >= 3)
		assert.ok(top.every((f) => !isStaleDri(f)), `old DRI finding in the top signals: ${top.map((f) => f.title).join(" | ")}`)
	})

	test("live search: every request ends with a final event, nothing is in flight after 'Završeno'", () => {
		const finished = events.findIndex((e) => e.type === "dosije.zavrsen")
		assert.ok(finished > 0)
		const groups = byRequest(events)
		for (const [id, pair] of groups) {
			assert.ok(pair.length >= 2, `request ${id} has a final event`)
			assert.equal(act(pair.at(-1) as WireEvent).status === "u_toku", false, `request ${id} ends in flight`)
			assert.equal(act(pair[0]).status, "u_toku")
		}
		const open = new Set([...groups].filter(([, pair]) => act(pair.at(-1) as WireEvent).status === "u_toku").map(([id]) => id))
		assert.equal(open.size, 0)
	})

	test("a request still 'u_toku' when the case ends is finished with an error event and is not published twice", async () => {
		const agent = getSnapshot().agents.find((a) => a.group === "kadrovik") as { id: string; name: string }
		let release!: () => void
		const gate = new Promise<void>((r) => (release = r))
		const live = { agentId: agent.id, agentName: agent.name, tool: "acas_funkcioneri", caseId, alive: () => true }
		const label = `spora pretraga ${Date.now()}`
		const pending = withActivityContext(live, () => trackActivity({ source: "ACAS", kind: "acas", action: "pretraga", label }, () => gate))
		await tick()
		const mine = () => upits(events).filter((e) => act(e).label === label)
		assert.equal(mine().length, 1)
		assert.equal(act(mine()[0]).status, "u_toku")

		assert.equal(finalizeActivities(caseId, "prekinuto: dosije završen"), 1)
		assert.equal(mine().length, 2)
		assert.equal(act(mine()[1]).status, "greska")
		assert.equal(act(mine()[1]).error, "prekinuto: dosije završen")
		assert.equal(act(mine()[1]).id, act(mine()[0]).id)

		release()
		await pending
		await tick()
		assert.equal(mine().length, 2, "the late result of the real request is not published a second time")
		assert.equal(finalizeActivities(caseId, "prekinuto: dosije završen"), 0)
	})
})

describe("Mapa prioriteta: the same supplier among the top suppliers of 2+ institutions", () => {
	const events: WireEvent[] = []
	let off: () => void

	before(async () => {
		off = bus.onWire((ev) => events.push(ev))
		await boot()
	})

	after(async () => {
		off()
		await shutdown()
	})

	test("the Urednik publishes mapa.veza and the affected rows show the shared supplier and its points", { timeout: 120_000 }, async () => {
		const { mapaId } = await startMapa()
		const view = await waitForMapa(100_000)
		assert.equal(view.status, "done")

		const veze = events.filter((e) => e.type === "mapa.veza")
		assert.ok(veze.length >= 1, "at least one supplier is a top supplier of 2+ institutions of the preset")
		assert.ok(veze.every((e) => e.producerName === "Urednik"))
		for (const e of veze) {
			const p = e.payload as { mapaId: string; veza: MapaVeza }
			assert.equal(p.mapaId, mapaId)
			const v = p.veza
			assert.ok(v.supplier.name && /^\d{8,9}$/.test(v.supplier.pib ?? ""), "name and PIB")
			assert.ok(v.institutions.length >= 2)
			assert.ok(v.institutions.every((i) => i.slug && i.name && i.rank >= 1 && i.share > 0))
			assert.equal(v.points, 5)
			assert.equal(v.line, `Isti dobavljač u ${v.institutions.length} ${v.institutions.length < 5 ? "institucije" : "institucija"}: ${v.supplier.name}`)
			// the affected rows carry the supplier (shared state) and the reason line with its points
			for (const i of v.institutions) {
				const row = view.rows.find((r) => r.slug === i.slug) as MapaRow
				const shared = row.signals.sharedSuppliers?.find((s) => s.pib === v.supplier.pib)
				assert.ok(shared, `${row.name} lists ${v.supplier.name}`)
				assert.equal(shared.institutions, v.institutions.length)
				assert.ok(row.reasons.includes(`${v.line} (+5)`), `${row.name}: ${row.reasons.join(" | ")}`)
			}
		}
		// the points are part of the score, computed by the documented function from the row's signals
		for (const row of view.rows) {
			assert.equal(row.score, scoreSignals(row.signals).score, `${row.name}: score = scoreSignals(signals)`)
			assert.ok(!row.signals.topSuppliers || row.signals.topSuppliers.every((s) => /^\d{8,9}$/.test(s.pib ?? "")))
		}
		assert.ok(view.rows.some((r) => (r.signals.topSuppliers?.length ?? 0) > 0), "the triage tools put their top suppliers into the shared state")
		const scores = view.rows.map((r) => r.score)
		assert.deepEqual(scores, [...scores].sort((a, b) => b - a), "ranking sorted by score")

		const done = events.find((e) => e.type === "mapa.zavrsena")
		assert.ok(done)
		const ranking = (done.payload as { ranking: MapaRow[] }).ranking
		assert.ok(ranking.some((r) => r.reasons.some((x) => x.startsWith("Isti dobavljač u "))), "the final ranking carries the line")
		assert.deepEqual(ranking.map((r) => [r.slug, r.score]), view.rows.map((r) => [r.slug, r.score]))
	})

	test("live search of the map: no request is left in flight after the map ends", () => {
		const groups = byRequest(events)
		assert.ok(groups.size >= 6)
		for (const [id, pair] of groups) assert.notEqual(act(pair.at(-1) as WireEvent).status, "u_toku", `request ${id} ends in flight`)
	})
})
