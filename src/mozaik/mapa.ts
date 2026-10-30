// "Mapa prioriteta": the map's domain operations. Rows are changed only here; every change is followed by a `mapa.red`
// event (upsert), and when the last row is finished the Urednik publishes `mapa.zavrsena` with the ranking. Figures and
// the score come from what the triage tools fetched (code); the model only adds a short neutral summary.

import fs from "node:fs"
import path from "node:path"
import { scoreSignals } from "../data/analysis/priority"
import { n } from "../shared/plural"
import type { MapaRow, MapaSignals, SourceRef } from "../shared/types"
import { bus } from "./bus"
import { emit, ids, S } from "./domain"
import { mergeSources, rankRows, type TriageRecord } from "./state"
import { log, logError, nowIso, slug } from "./util"

export const MAPA_MAX = 8
export const TRIAGE_TOOLS = ["rukovodstvo", "nabavke", "revizija"] as const
export type TriagePart = (typeof TRIAGE_TOOLS)[number]

const PRESET_FILE = path.resolve(process.cwd(), "data", "static", "mapa-preset.json")
const MAPA_TIMEOUT_MS = Math.max(5_000, Number(process.env.MAPA_TIMEOUT_MS) || 600_000)

export interface MapaInstitution {
	slug: string
	name: string
}

export function loadMapaPreset(): MapaInstitution[] {
	try {
		const raw = JSON.parse(fs.readFileSync(PRESET_FILE, "utf8")) as { slug?: string; name?: string }[]
		return raw.filter((r) => typeof r?.name === "string" && r.name.trim()).map((r) => ({ slug: r.slug || slug(r.name as string), name: (r.name as string).trim() }))
	} catch {
		return []
	}
}

/** The institutions of a map: the preset when nothing is given; otherwise cleaned names (deduplicated, at most MAPA_MAX). */
export function normalizeInstitutions(raw: unknown): MapaInstitution[] {
	if (raw === undefined || raw === null || (Array.isArray(raw) && raw.length === 0)) return loadMapaPreset().slice(0, MAPA_MAX)
	if (!Array.isArray(raw)) throw new RangeError("Spisak institucija mora biti niz naziva.")
	const out = new Map<string, MapaInstitution>()
	for (const item of raw) {
		const name = typeof item === "string" ? item : typeof (item as { name?: unknown })?.name === "string" ? (item as { name: string }).name : ""
		const clean = name.replace(/\s+/g, " ").trim().slice(0, 120)
		const s = slug(clean)
		if (clean.length >= 2 && s && !out.has(s)) out.set(s, { slug: s, name: clean })
	}
	if (out.size === 0) throw new RangeError("Upiši bar jednu instituciju.")
	if (out.size > MAPA_MAX) throw new RangeError(`Najviše ${MAPA_MAX} institucija po mapi.`)
	return [...out.values()]
}

// ─── rows ────────────────────────────────────────────────────────────────────

function publish(row: MapaRow, producerId: string): void {
	const state = S()
	state.touch()
	emit("mapa.red", producerId, { mapaId: state.mapa.id, row: structuredClone(row) })
}

export function rowOfAgent(agentId: string): MapaRow | undefined {
	const m = S().mapa
	const slugOf = m.agentSlug.get(agentId)
	return slugOf ? m.rows.get(slugOf) : undefined
}

const isTerminal = (r: MapaRow) => r.status === "done" || r.status === "error"

/** The Fabrika has resolved the institution and spawned its triage agent. */
export function startRow(slugOf: string, agentId: string, resolvedName: string): void {
	const m = S().mapa
	const row = m.rows.get(slugOf)
	if (!row || isTerminal(row)) return
	row.status = "running"
	row.agentId = agentId
	row.resolvedName = resolvedName
	m.agentSlug.set(agentId, slugOf)
	m.triage.set(slugOf, { called: new Set(), ok: new Set(), signals: {}, gaps: [] })
	publish(row, ids.fabrika)
}

export function failRow(slugOf: string, error: string, producerId: string): void {
	const row = S().mapa.rows.get(slugOf)
	if (!row || isTerminal(row)) return
	row.status = "error"
	row.error = error
	row.score = 0
	row.reasons = []
	publish(row, producerId)
}

/** A triage tool finished: merge its figures and sources into the row, recompute the score and publish the row. */
export function recordTriage(slugOf: string, part: TriagePart, result: { ok: boolean; signals?: MapaSignals; sources?: SourceRef[] }, producerId: string): void {
	const m = S().mapa
	const row = m.rows.get(slugOf)
	const t = m.triage.get(slugOf)
	if (!row || !t || isTerminal(row)) return
	t.called.add(part)
	if (result.ok) {
		t.ok.add(part)
		Object.assign(t.signals, result.signals)
	} else if (!t.gaps.includes(part)) t.gaps.push(part)
	refreshRow(row, t)
	row.sources = mergeSources(row.sources, result.sources ?? []).slice(0, 12)
	publish(row, producerId)
}

function refreshRow(row: MapaRow, t: TriageRecord): void {
	row.signals = { ...t.signals }
	const { score, reasons } = scoreSignals(row.signals)
	row.score = score
	row.reasons = [...reasons, ...t.gaps.map((g) => `nema podataka: ${g}`)]
}

export function triageComplete(slugOf: string): boolean {
	const t = S().mapa.triage.get(slugOf)
	return !!t && TRIAGE_TOOLS.every((p) => t.called.has(p))
}

/** upisi_red: the row is finished (done when at least one source answered, otherwise error). */
export function finishRow(slugOf: string, summary: string | undefined, producerId: string): { ok: boolean; error?: string } {
	const m = S().mapa
	const row = m.rows.get(slugOf)
	const t = m.triage.get(slugOf)
	if (!row || !t) return { ok: false, error: "Red ne postoji u tekućoj mapi." }
	if (isTerminal(row)) return { ok: true }
	if (t.ok.size === 0) {
		failRow(slugOf, "Nijedan izvor nije odgovorio (rukovodstvo, nabavke, revizija).", producerId)
		return { ok: true }
	}
	row.status = "done"
	if (summary) row.summary = summary
	publish(row, producerId)
	return { ok: true }
}

/**
 * A triage loop ended. If the agent did not write its row, finish it from the figures the tools fetched (when all three
 * ran) or mark it as an error. Then check whether the map is complete.
 */
export function mapaLoopEnded(agentId: string): void {
	try {
		const row = rowOfAgent(agentId)
		if (row && !isTerminal(row)) {
			if (triageComplete(row.slug)) finishRow(row.slug, undefined, ids.urednik)
			else failRow(row.slug, "Trijaža nije završena: agent je prekinuo rad pre nego što je proverio sve izvore.", ids.urednik)
		}
		checkMapaDone()
	} catch (err) {
		logError("mapa loop end", err)
	}
}

/** Every row finished and no triage loop still running -> `mapa.zavrsena` (published by the Urednik). */
export function checkMapaDone(): boolean {
	const state = S()
	const m = state.mapa
	if (m.status !== "running") return false
	if ([...m.rows.values()].some((r) => !isTerminal(r))) return false
	for (const l of state.activeLoops.values()) if (state.agentInfo.get(l.agentId)?.group === "trijaza") return false
	m.status = "done"
	m.finishedAt = nowIso()
	state.finishedAtMs = Date.now()
	state.refreshStats()
	stopMapaWatch()
	const ranking = structuredClone(rankRows([...m.rows.values()]))
	emit("mapa.zavrsena", ids.urednik, { mapaId: m.id, ranking })
	bus.emitStats(state.stats, state.budget)
	log("mapa", `završena: ${n(ranking.length, "institucija")}, vrhunac ${n(state.stats.peakConcurrentLoops, "petlja")}, ${Math.round(state.stats.elapsedMs / 1000)} s`)
	return true
}

// ─── watchdog ────────────────────────────────────────────────────────────────

let watch: NodeJS.Timeout | undefined

export function stopMapaWatch(): void {
	if (watch) clearInterval(watch)
	watch = undefined
}

/** A map that does not finish in MAPA_TIMEOUT_MS is closed: unfinished rows become errors, so the UI never hangs. */
export function startMapaWatch(): void {
	stopMapaWatch()
	const state = S()
	const generation = state.generation
	watch = setInterval(() => {
		try {
			if (state.generation !== generation || state.mapa.status !== "running") return stopMapaWatch()
			if (Date.now() - state.startedAtMs < MAPA_TIMEOUT_MS) return
			for (const row of state.mapa.rows.values()) failRow(row.slug, "Vreme za trijažu je isteklo.", ids.urednik)
			for (const loopId of state.activeLoops.keys()) state.staleLoops.add(loopId)
			state.activeLoops.clear()
			checkMapaDone()
		} catch (err) {
			logError("mapa watchdog", err)
		}
	}, 1000)
	watch.unref?.()
}
