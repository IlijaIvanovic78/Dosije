// Participants on the Mozaik bus: the journalist (Novinar, human), the Fabrika spawner (human, handlers only), two
// observers (SSE most, Zapisničar) and the reaction handlers of the core agents.

import fs from "node:fs"
import path from "node:path"
import { createAgent, createHuman, type Agent, type SituationHandler } from "@mozaik-ai/core"
import * as data from "../data"
import type { ResolvedInstitution } from "../data/resolver"
import type { AgentGroup, AgentReaction, Entity, Finding, SignalCode, WireEvent } from "../shared/types"
import { coreMessage, createDynamicAgent, createTrijazaAgent, dynamicMessage, reactionMessage, trijazaMessage, type DynamicKind, type ReactionTrigger } from "./agents"
import { bus } from "./bus"
import { emit, ids, S, scheduleBudgetEvent } from "./domain"
import { handler } from "./handlers"
import { startAgentLoop } from "./loop"
import { checkMapaDone, failRow, startRow } from "./mapa"
import { join } from "./runtime"
import { todayIso } from "../data/analysis/vd"
import { log, logError, nowIso, slug } from "./util"

export const OUT_DIR = path.resolve(process.cwd(), "out")

// ─── core agents react to dosije.started: each starts its OWN loop at the same moment ───────────────

export function coreAgentHandlers(group: AgentGroup, agentRef: () => Agent): SituationHandler[] {
	const handlers = [
		handler(["dosije.started"], `${group}.dosije.started`, ({ event }) => {
			const state = S()
			const p = event.payload as { caseId: string }
			if (state.caseId !== p.caseId || !state.institutionRef) return
			startAgentLoop(agentRef(), coreMessage(group, state.institutionRef, state.focus, state.mentioned, todayIso()))
		}),
	]
	// cross-agent reaction: a finding of ANOTHER agent is the situation that starts a new loop of this one
	if (REACTIONS[group]) handlers.push(handler(["finding.added"], `${group}.finding.added`, ({ event }) => onFindingReaction(group, agentRef(), (event.payload as { finding: Finding }).finding)))
	return handlers
}

// ─── cross-agent reactions (finding.added of another agent -> a new loop with a fresh context) ───────────────────

/**
 * Mediji reacts to a Kadrovik finding about an acting head (VD_PREKO_ROKA, VD_LANAC): a targeted media check of the appointment and
 * of whether outlets say "v.d." or "direktor". Mediji also reacts to a Revizor DRI finding about procurement or acting heads: it reads
 * the shared state and searches the coverage of that audit topic for the institution. Revizor reacts to a Nabavke finding
 * (BEZ_OBJAVE, KONCENTRACIJA): it looks for an earlier DRI finding on the same topic and backs the finding up with a second official
 * source. Each fires at most once per case and trigger code (Mediji also once per person: the two Kadrovik codes concern the same
 * head; and once per audit topic for the Revizor trigger).
 */
interface ReactionRule {
	from: AgentGroup
	codes: SignalCode[]
}

const REACTIONS: Partial<Record<AgentGroup, ReactionRule[]>> = {
	mediji: [
		{ from: "kadrovik", codes: ["VD_PREKO_ROKA", "VD_LANAC"] },
		// the Revizor's DRI finding about procurement or acting heads: Mediji looks for coverage of that audit topic (once per topic)
		{ from: "revizor", codes: ["DRI_NALAZ"] },
	],
	revizor: [{ from: "nabavke", codes: ["BEZ_OBJAVE", "KONCENTRACIJA"] }],
}

/** The audit topic of a DRI finding when it is about acting heads or procurement (the two topics the media can be asked about). */
export function auditTopicOf(f: Pick<Finding, "title" | "text">): string | undefined {
	const t = `${f.title} ${f.text}`
	if (/vr[šs]ioc\w*\s+du[žz]nosti|(?:^|[^\p{L}])v\.\s?d\./iu.test(t)) return "vršioci dužnosti"
	if (/javn\w+\s+nabavk|pregovara[čc]k|nabavk/i.test(t)) return "javne nabavke"
	return undefined
}

function onFindingReaction(group: AgentGroup, agent: Agent, finding: Finding): void {
	const state = S()
	if (!finding.signalCode) return
	const from = state.agentInfo.get(finding.agentId)
	const rule = REACTIONS[group]?.find((r) => r.from === from?.group && r.codes.includes(finding.signalCode as SignalCode))
	if (!rule || !from) return
	if (!state.isRunning(finding.caseId) || !state.institutionRef) return
	if (finding.agentId === agent.getId()) return

	const keys = [`${group}:${finding.signalCode}`]
	let trigger: ReactionTrigger = { findingId: finding.id, agent: from.name, signalCode: finding.signalCode, title: finding.title }
	if (group === "mediji" && rule.from === "revizor") {
		const tema = auditTopicOf(finding)
		if (!tema) return
		trigger = { ...trigger, tema }
		keys.length = 0
		keys.push(`${group}:dri:${tema}`)
	} else if (group === "mediji") {
		const entity = finding.entityIds.map((id) => state.entities.get(id)).find((e) => e?.kind === "osoba")
		const person = entity?.name ?? finding.claim?.subject
		if (!person) return
		trigger = { ...trigger, person, position: typeof entity?.attrs.position === "string" ? entity.attrs.position : undefined }
		keys.push(`${group}:osoba:${slug(person)}`)
	}
	if (keys.some((k) => state.reacted.has(k))) return
	if (!startAgentLoop(agent, reactionMessage(group as "mediji" | "revizor", trigger, state.institutionRef))) return
	for (const k of keys) state.reacted.add(k)

	const info = state.agentInfo.get(agent.getId())
	const reaction: AgentReaction = { findingId: finding.id, fromAgentId: finding.agentId, fromAgent: from.name, signalCode: finding.signalCode, title: finding.title, ...(trigger.tema ? { tema: trigger.tema } : {}), at: nowIso() }
	if (info) info.reactions = [...(info.reactions ?? []), reaction]
	emit("agent.reakcija", agent.getId(), { agentId: agent.getId(), agentName: state.nameOf(agent.getId()), reaction })
	log("reakcija", `${state.nameOf(agent.getId())} ← ${from.name}: ${finding.signalCode} (${finding.title})`)
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
