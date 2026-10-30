// Participants on the Mozaik bus: the journalist (Novinar, human), the Fabrika spawner (human, handlers only), two
// observers (SSE most, Zapisničar) and the reaction handlers of the core agents.

import fs from "node:fs"
import path from "node:path"
import { createAgent, createHuman, type Agent, type SituationHandler } from "@mozaik-ai/core"
import * as data from "../data"
import type { ResolvedInstitution } from "../data/resolver"
import type { AgentGroup, Entity, WireEvent } from "../shared/types"
import { coreMessage, createDynamicAgent, createTrijazaAgent, dynamicMessage, trijazaMessage, type DynamicKind } from "./agents"
import { bus } from "./bus"
import { ids, S, scheduleBudgetEvent } from "./domain"
import { handler } from "./handlers"
import { startAgentLoop } from "./loop"
import { checkMapaDone, failRow, startRow } from "./mapa"
import { join } from "./runtime"
import { todayIso } from "../data/analysis/vd"
import { logError } from "./util"

export const OUT_DIR = path.resolve(process.cwd(), "out")

// ─── core agents react to dosije.started: each starts its OWN loop at the same moment ───────────────

export function coreAgentHandlers(group: AgentGroup, agentRef: () => Agent): SituationHandler[] {
	return [
		handler(["dosije.started"], `${group}.dosije.started`, ({ event }) => {
			const state = S()
			const p = event.payload as { caseId: string }
			if (state.caseId !== p.caseId || !state.institutionRef) return
			startAgentLoop(agentRef(), coreMessage(group, state.institutionRef, state.focus, state.mentioned, todayIso()))
		}),
	]
}

// ─── Fabrika: spawns dynamic agents on entity.added, within the budget ──────────────────────────────

function spawn(kind: DynamicKind, entity: Entity, spawnedBy: string): void {
	const state = S()
	const key = `${kind}:${entity.id}`
	if (state.spawned.has(key)) return
	state.spawned.add(key)
	state.pendingSpawns++
	const caseId = entity.caseId
	setImmediate(() => {
		try {
			if (!state.isRunning(caseId)) return
			const { agent, info } = createDynamicAgent(kind, entity, spawnedBy)
			state.registerAgentInfo(info)
			state.agents.set(info.id, agent)
			join(agent)
			startAgentLoop(agent, dynamicMessage(kind, entity, state.institutionRef as NonNullable<typeof state.institutionRef>))
		} catch (err) {
			logError(`fabrika ${key}`, err)
		} finally {
			state.pendingSpawns--
			state.touch()
		}
	})
}

function onEntityAdded(entity: Entity, producerId: string): void {
	const state = S()
	if (!state.isRunning(entity.caseId)) return
	const b = state.budget
	if (b.loops + state.pendingSpawns >= b.maxLoops - 2) return
	const kinds: DynamicKind[] = []
	if (entity.kind === "firma") {
		if (b.firme >= b.maxFirme) return
		b.firme++
		kinds.push("firme")
	} else if (entity.kind === "osoba") {
		if (b.osobe >= b.maxOsobe) return
		b.osobe++
		if (entity.role === "funkcioner") kinds.push("imovina", "mediji")
		else if (entity.role === "vlasnik") kinds.push("provera", "mediji")
		else kinds.push("mediji")
	} else return
	scheduleBudgetEvent()
	for (const kind of kinds) spawn(kind, entity, producerId)
}

// ─── Fabrika on mapa.started: resolve every institution, then spawn one "Trijaža" agent each, all in the same moment ───

const RESOLVE_TIMEOUT_MS = 90_000

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${what}: isteklo vreme`)), ms)
		timer.unref?.()
	})
	return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

async function onMapaStarted(p: { mapaId: string; institutions: { slug: string; name: string }[] }): Promise<void> {
	const state = S()
	if (!state.mapaRunning(p.mapaId)) return
	type Resolved = { inst: { slug: string; name: string }; ref: ResolvedInstitution; error?: undefined } | { inst: { slug: string; name: string }; error: string; ref?: undefined }
	const resolved = await Promise.all(
		p.institutions.map(async (inst): Promise<Resolved> => {
			try {
				return { inst, ref: await withTimeout(data.resolveInstitution(inst.name), RESOLVE_TIMEOUT_MS, "Razrešavanje institucije") }
			} catch (err) {
				return { inst, error: err instanceof Error ? err.message : String(err) }
			}
		}),
	)
	if (!state.mapaRunning(p.mapaId)) return
	for (const r of resolved) {
		if (r.ref) {
			const { ref } = r
			setImmediate(() => spawnTrijaza(p.mapaId, r.inst.slug, ref))
		} else failRow(r.inst.slug, r.error ?? "Institucija nije pronađena.", ids.fabrika)
	}
	setImmediate(() => checkMapaDone())
}

function spawnTrijaza(mapaId: string, slug: string, ref: ResolvedInstitution): void {
	const state = S()
	try {
		if (!state.mapaRunning(mapaId)) return
		const { agent, info } = createTrijazaAgent(ref, ids.novinar)
		state.registerAgentInfo(info)
		state.agents.set(info.id, agent)
		state.mapa.refs.set(slug, ref)
		join(agent)
		startRow(slug, info.id, ref.name)
		if (!startAgentLoop(agent, trijazaMessage(ref))) failRow(slug, "Trijaža se nije pokrenula (budžet petlji).", ids.fabrika)
	} catch (err) {
		logError(`fabrika trijaža ${slug}`, err)
		failRow(slug, "Trijaža se nije pokrenula.", ids.fabrika)
	}
}

export function createFabrika() {
	return createHuman({
		name: "Fabrika",
		capabilities: ["spawn"],
		handlers: [
			handler(["entity.added"], "fabrika.entity", ({ event }) => onEntityAdded((event.payload as { entity: Entity }).entity, event.producerId)),
			handler(["mapa.started"], "fabrika.mapa", ({ event }) => onMapaStarted(event.payload as { mapaId: string; institutions: { slug: string; name: string }[] })),
		],
	})
}

export function createNovinar() {
	return createHuman({ name: "Novinar", capabilities: ["dosije.started", "odgovor.coveka", "entity.added", "dosije.zatvori", "mapa.started"], handlers: [] })
}

// ─── observers ──────────────────────────────────────────────────────────────

export function createSseMost() {
	return createAgent({
		name: "SSE most",
		capabilities: ["observer"],
		instruction: "Posmatrač: prosleđuje događaje pregledaču.",
		tools: [],
		handlers: [handler("*", "sse-most", ({ event }) => void bus.ingest(event, S()))],
	})
}

class Trace {
	private stream?: fs.WriteStream
	private current = "boot"
	private buffered: string[] = []

	write(caseId: string | null, wire: WireEvent): void {
		const line = JSON.stringify({ caseId, ...wire })
		if (!caseId) {
			this.buffered.push(line)
			if (this.buffered.length > 500) this.buffered.shift()
			return
		}
		if (!this.stream || this.current !== caseId) {
			this.stream?.end()
			fs.mkdirSync(OUT_DIR, { recursive: true })
			this.current = caseId
			this.stream = fs.createWriteStream(path.join(OUT_DIR, `trace-${caseId}.jsonl`), { flags: "a", encoding: "utf8" })
			this.stream.on("error", (err) => logError("zapisničar", err))
			for (const l of this.buffered) this.stream.write(`${l}\n`)
			this.buffered = []
		}
		this.stream.write(`${line}\n`)
	}

	close(): Promise<void> {
		const s = this.stream
		this.stream = undefined
		return new Promise((resolve) => (s ? s.end(resolve) : resolve()))
	}
}

export const trace = new Trace()

export function createZapisnicar() {
	return createAgent({
		name: "Zapisničar",
		capabilities: ["observer"],
		instruction: "Posmatrač: upisuje svaki događaj u out/trace-<caseId>.jsonl.",
		tools: [],
		handlers: [
			handler("*", "zapisnicar", ({ event }) => {
				const wire = bus.wireOf(event)
				if (wire) trace.write(S().caseId ?? S().mapa.id, wire)
			}),
		],
	})
}
