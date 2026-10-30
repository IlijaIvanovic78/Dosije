// npm test: live search ("izvor.upit"). A scripted case on cached data must show every public-source request of the tools as
// two Mozaik events (u_toku, then ok | kes | greska) attributed to the agent that caused it; plus the cap, the stale-case
// rule and the Mapa prioriteta. Run with DATA_MODE=cache, DEMO_SPEED=0.05, HUMAN_AUTO_APPROVE_MS=0.

import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { after, before, describe, test } from "node:test"

process.env.DATA_MODE = "cache"
process.env.DEMO_SPEED = "0.05"
process.env.HUMAN_AUTO_APPROVE_MS = "0"
process.env.DOSIJE_MODE = "scripted"

const { applyEntryDefaults } = await import("../src/config")
applyEntryDefaults("test")
const { boot, startCase, startMapa, waitForDone, waitForMapa, getSnapshot, shutdown } = await import("../src/mozaik/boot")
const { bus } = await import("../src/mozaik/bus")
const { MAX_ACTIVITIES_PER_CASE } = await import("../src/mozaik/activity")
const { trackActivity, withActivityContext, hasActivityContext } = await import("../src/data/activity")
type WireEvent = import("../src/shared/types").WireEvent
type SourceActivity = import("../src/shared/types").SourceActivity

const upits = (events: WireEvent[]) => events.filter((e) => e.type === "izvor.upit")
const payload = (e: WireEvent) => e.payload as SourceActivity

function byRequest(events: WireEvent[]) {
	const groups = new Map<string, WireEvent[]>()
	for (const e of upits(events)) groups.set(payload(e).id, [...(groups.get(payload(e).id) ?? []), e])
	return groups
}

describe("live search: tracking primitives", () => {
	test("outside an activity context everything is a no-op and never throws", async () => {
		assert.equal(hasActivityContext(), false)
		assert.equal(await trackActivity({ source: "ACAS", kind: "acas", action: "pretraga", label: "x" }, async () => 42), 42)
		await assert.rejects(trackActivity({ source: "ACAS", kind: "acas", action: "pretraga", label: "x" }, async () => Promise.reject(new Error("boom"))), /boom/)
	})
})

describe("live search: scripted case (IŽS, cached data)", () => {
	const events: WireEvent[] = []
	let off: () => void
	let caseId = ""

	before(async () => {
		off = bus.onWire((ev) => events.push(ev))
		await boot()
	})

	after(async () => {
		off()
		await shutdown()
	})

	test("every tool request is a u_toku + final pair, attributed to the agent and tool, with a Serbian label", { timeout: 120_000 }, async () => {
		caseId = (await startCase("Infrastruktura železnice Srbije")).caseId
		assert.ok(await waitForDone(100_000), "the dossier finished")

		const all = upits(events)
		assert.ok(all.length >= 20, `izvor.upit events: ${all.length}`)

		const groups = byRequest(events)
		for (const [id, pair] of groups) {
			assert.equal(pair.length, 2, `request ${id} has exactly two events`)
			const [start, end] = pair
			assert.equal(payload(start).status, "u_toku", `request ${id} starts with u_toku`)
			assert.ok(["ok", "kes", "greska"].includes(payload(end).status), `request ${id} ends with ${payload(end).status}`)
			assert.ok(start.seq < end.seq)
		}

		const agents = new Map(getSnapshot().agents.map((a) => [a.id, a.name]))
		for (const e of all) {
			const a = payload(e)
			assert.ok(a.agentId && a.agentName && a.tool && a.source, `activity ${a.id} has agent, tool and source`)
			assert.ok(a.label.trim().length > 3, `activity ${a.id} has a label`)
			assert.equal(e.producerId, a.agentId, "the producer of the event is the agent that made the request")
			assert.equal(agents.get(a.agentId), a.agentName)
			assert.ok(!/token|session|apikey|api_key|X-API-KEY/i.test(a.url ?? ""), "no credentials in a public URL")
			if (a.status === "kes") assert.ok(a.ms !== undefined && (a.items === undefined || a.items >= 0))
		}

		const sources = new Set(all.map((e) => payload(e).source))
		for (const wanted of ["ACAS", "Portal javnih nabavki", "DRI"]) assert.ok(sources.has(wanted), `source ${wanted} appears: ${[...sources].join(", ")}`)
		assert.ok([...sources].some((s) => /vesti|news|rss|gdelt/i.test(s)), "a news source appears")

		const kes = all.map(payload).filter((a) => a.status === "kes")
		assert.ok(kes.length >= 10)
		assert.ok(kes.filter((a) => a.source === "ACAS").every((a) => !!a.cachedAt), "cache hits carry the time the cached copy was fetched")
		assert.ok(
			kes.some((a) => (a.ms ?? 0) >= 2),
			"the simulated latency is inside the activity window (u_toku -> kes spans it)",
		)
		assert.ok(all.map(payload).some((a) => /^funkcioneri: Infrastruktura železnice Srbije$/.test(a.label)))
		assert.ok(all.map(payload).some((a) => /^ugovori naručioca: Infrastruktura železnice Srbije \(1\.537\)$/.test(a.label)))
		assert.equal(getSnapshot().stats.activities, groups.size, "the stats count the published requests")
	})

	test("the Zapisničar writes the activities to the trace", async () => {
		await shutdown()
		const file = path.resolve(process.cwd(), "out", `trace-${caseId}.jsonl`)
		const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type: string })
		assert.ok(lines.filter((l) => l.type === "izvor.upit").length >= 40)
	})

	test("requests of a closed case are dropped, and a case publishes at most 400 requests", async () => {
		const before = upits(events).length
		const stale = { agentId: "ghost", agentName: "Ghost", tool: "t", caseId: "old", alive: () => false }
		await withActivityContext(stale, () => trackActivity({ source: "ACAS", kind: "acas", action: "pretraga", label: "zastarelo" }, async () => 1))
		assert.equal(upits(events).length, before, "stale case: nothing published")

		const agent = getSnapshot().agents.find((a) => a.group === "kadrovik")!
		const live = { agentId: agent.id, agentName: agent.name, tool: "acas_funkcioneri", caseId: caseId, alive: () => true }
		await withActivityContext(live, async () => {
			for (let i = 0; i < MAX_ACTIVITIES_PER_CASE + 20; i++) {
				await trackActivity({ source: "ACAS", kind: "acas", action: "pretraga", label: `provera ${i}` }, async () => i)
			}
		})
		const groups = byRequest(events)
		assert.equal(groups.size, MAX_ACTIVITIES_PER_CASE, "capped at 400 requests per case")
		for (const pair of groups.values()) assert.equal(pair.length, 2, "a request is never published half")
		assert.ok((getSnapshot().stats.activitiesDropped ?? 0) > 0, "dropped requests are counted in the stats")
	})
})

describe("live search: Mapa prioriteta", () => {
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

	test("the Trijaža agents publish their requests too", { timeout: 120_000 }, async () => {
		await startMapa(["Infrastruktura železnice Srbije", "Srbijavoz"])
		const map = await waitForMapa(100_000)
		assert.equal(map.status, "done")
		const all = upits(events).map(payload)
		assert.ok(all.length >= 6, `izvor.upit events: ${all.length}`)
		assert.ok(all.every((a) => a.agentName.startsWith("Trijaža")), "attributed to the triage agents")
		assert.ok(["trijaza_rukovodstvo", "trijaza_nabavke", "trijaza_revizija"].every((t) => all.some((a) => a.tool === t)), "every triage tool made requests")
	})
})
