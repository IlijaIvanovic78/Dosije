// npm test: "Mapa prioriteta" in-process (real Mozaik runtime, committed cache, no key): one Trijaža agent per institution of
// the preset, all at the same time; plus the deterministic scoring and the case/map mutual exclusion.
// Run with DATA_MODE=cache, DEMO_SPEED=0.05.

import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

process.env.DATA_MODE = "cache"
process.env.DEMO_SPEED = "0.05"
process.env.HUMAN_AUTO_APPROVE_MS = "0"
process.env.DOSIJE_MODE = "scripted"

const { applyEntryDefaults } = await import("../src/config")
applyEntryDefaults("test")
const { ApiError, boot, getMapa, getSnapshot, shutdown, startCase, startMapa, waitForDone, waitForMapa } = await import("../src/mozaik/boot")
const { bus } = await import("../src/mozaik/bus")
const { loadMapaPreset } = await import("../src/mozaik/mapa")
const { scoreSignals } = await import("../src/data/analysis/priority")
type WireEvent = import("../src/shared/types").WireEvent
type MapaRow = import("../src/shared/types").MapaRow

describe("priority score (deterministic)", () => {
	test("adds up the documented components", () => {
		const r = scoreSignals({ vdOver: true, vdMonths: 17, vdLimitMonths: 12, vdChainMonths: 77, vdChainCount: 4, nwpShare: 0.001, nwpCount: 10, iwFlags: 8, driReports: 21, driQualified: 1 })
		// 40 + 5 (months over) + 15 (chain) + 5 (>= 5 negotiated) + 15 (IW, capped) + 10 (one qualified opinion) + 5 (>= 5 reports)
		assert.equal(r.score, 95)
		assert.equal(r.reasons.length, 6)
	})

	test("caps and thresholds", () => {
		const r = scoreSignals({ vdOver: true, vdMonths: 155, vdLimitMonths: 12, nwpShare: 0.2, topSupplierShare: 0.5, driQualified: 5 })
		assert.equal(r.score, 40 + 20 + 15 + 10 + 20)
		assert.equal(scoreSignals({ vdOver: false, vdMonths: 6, vdLimitMonths: 12, vdChainMonths: 23, nwpShare: 0.05, nwpCount: 4, topSupplierShare: 0.4, driReports: 4 }).score, 0, "nothing at or below the thresholds")
		assert.equal(scoreSignals({}).score, 0, "unknown signals never score")
	})
})

describe("Mapa prioriteta (scripted agents, cached preset)", () => {
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

	test("a case and a map exclude each other (409)", { timeout: 120_000 }, async () => {
		const first = await startMapa()
		assert.ok(first.mapaId.startsWith("map-"))
		await assert.rejects(startCase("Infrastruktura železnice Srbije"), (err) => err instanceof ApiError && err.status === 409)
		await assert.rejects(startMapa(), (err) => err instanceof ApiError && err.status === 409, "a second map while one runs")
		const view = await waitForMapa(100_000)
		assert.equal(view.status, "done")

		await startCase("Infrastruktura železnice Srbije")
		await assert.rejects(startMapa(), (err) => err instanceof ApiError && err.status === 409 && /Dosije je u toku/.test(err.message))
		assert.ok(await waitForDone(100_000), "the case finished")
	})

	test("one Trijaža agent per institution runs at the same time and the ranking is sorted", { timeout: 120_000 }, async () => {
		events.length = 0
		const preset = loadMapaPreset()
		assert.ok(preset.length >= 6, "preset has the transport sector list")
		const { mapaId, institutions } = await startMapa()
		assert.equal(institutions.length, preset.length)
		const view = await waitForMapa(100_000)
		assert.equal(view.status, "done")
		assert.equal(view.id, mapaId)
		assert.equal(view.rows.length, preset.length)

		for (const row of view.rows) {
			assert.equal(row.status, "done", `${row.name}: ${row.status} ${row.error ?? ""}`)
			assert.ok(row.sources.length >= 1, `${row.name} has sources`)
			assert.ok(row.agentId, `${row.name} has an agent`)
			assert.ok(row.summary, `${row.name} has a summary`)
			assert.ok(row.signals.vdMonths !== undefined || row.signals.contracts !== undefined, `${row.name} has figures`)
		}
		const scores = view.rows.map((r) => r.score)
		assert.deepEqual(scores, [...scores].sort((a, b) => b - a), "ranking sorted by score, highest first")

		const done = events.find((e) => e.type === "mapa.zavrsena")
		assert.ok(done, "mapa.zavrsena was published")
		const ranking = (done.payload as { ranking: MapaRow[] }).ranking
		assert.deepEqual(ranking.map((r) => r.slug), view.rows.map((r) => r.slug))
		assert.ok(events.filter((e) => e.type === "mapa.red").length >= preset.length * 4, "rows are upserted as the tools answer")

		const snap = getSnapshot()
		assert.ok(snap.stats.peakConcurrentLoops >= 4, `peak concurrent loops ${snap.stats.peakConcurrentLoops}`)
		const triage = snap.agents.filter((a) => a.group === "trijaza")
		assert.equal(triage.length, preset.length)
		assert.ok(triage.every((a) => a.dynamic && a.name.startsWith("Trijaža · ")))
		assert.equal(snap.mapa?.status, "done")
		assert.deepEqual(getMapa().rows.map((r) => r.slug), view.rows.map((r) => r.slug))
	})

	test("an unknown institution becomes an error row, the rest of the map still finishes", { timeout: 120_000 }, async () => {
		await startMapa(["Srbijavoz", "Nepostojeća institucija XYZ"])
		const view = await waitForMapa(100_000)
		assert.equal(view.status, "done")
		const bad = view.rows.find((r) => r.name.startsWith("Nepostojeća"))
		assert.equal(bad?.status, "error")
		assert.ok(bad?.error)
		assert.equal(view.rows.find((r) => r.slug === "srbijavoz")?.status, "done")
		assert.equal(view.rows.at(-1)?.status, "error", "errors rank last")
	})
})
