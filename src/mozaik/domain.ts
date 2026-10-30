// Domain operations: every mutation of the shared case (finding, entity, task, conflict) followed by the matching Mozaik
// event, sent by the participant that caused it. Tools, the gate, the Urednik processors and the REST layer all use these.

import { SemanticEvent } from "@mozaik-ai/core"
import type {
	AgentGroup,
	Claim,
	ClaimPredicate,
	Conflict,
	Entity,
	EntityKind,
	EntityRole,
	Finding,
	HumanTask,
	Section,
	Severity,
	SignalCode,
	SourceRef,
} from "../shared/types"
import { resolveRuntime, sendEvent } from "./runtime"
import { computeStatus, type DosijeState } from "./state"
import { clip, logError, nowIso, slug } from "./util"

export const S = (): DosijeState => resolveRuntime().state

/** Participant ids of the fixed participants (set in boot). */
export const ids = { novinar: "", fabrika: "", sseMost: "", zapisnicar: "", urednik: "" }

export interface ToolCtx {
	agentId: string
	agentName: string
	group: AgentGroup
	caseId: string
	entityId?: string
}

/** Publish an event from `producerId`. Falls back to a plain publish when the sender already left the runtime. */
export function emit(type: string, producerId: string, payload: unknown): void {
	const event = SemanticEvent.create(type, producerId, payload)
	try {
		sendEvent(event, producerId)
	} catch {
		try {
			resolveRuntime().publish(event)
		} catch (err) {
			logError(`emit ${type}`, err)
		}
	}
}

const SECTIONS: Section[] = ["rukovodstvo", "novac", "firme", "revizija", "mediji"]
const SEVERITIES: Severity[] = ["info", "paznja", "signal"]
const SIGNALS: SignalCode[] = [
	"VD_PREKO_ROKA",
	"VD_BLIZU_ROKA",
	"VD_LANAC",
	"IMENOVANJE_NEPOZNATO",
	"BEZ_OBJAVE",
	"KONCENTRACIJA",
	"UGOVOR_VECI_OD_PRIHODA",
	"MLADA_FIRMA",
	"MALO_ZAPOSLENIH",
	"POLITICKA_VEZA",
	"VLASNIK_FUNKCIONER",
	"DRI_NALAZ",
	"DRI_MISLJENJE",
	"MEDIJSKI_NAVOD",
	"IMOVINA",
	"KONFLIKT_IZVORA",
]
const PREDICATES: ClaimPredicate[] = ["funkcija", "datum_imenovanja", "organ_imenovanja", "vlasnik", "vrednost", "datum_osnivanja", "status", "drugo"]

/** The signal codes whose findings need the journalist's blocking approval (UrednikGate). */
export const APPROVAL_CODES: SignalCode[] = ["VD_PREKO_ROKA", "VLASNIK_FUNKCIONER"]

export interface FindingArgs {
	section?: unknown
	title?: unknown
	text?: unknown
	severity?: unknown
	signalCode?: unknown
	sources?: unknown
	entityIds?: unknown
	claim?: unknown
	/** id of another agent's finding that this one corroborates with an independent source (cross-agent reaction) */
	potkrepljuje?: unknown
	_approval?: unknown
}

/** "12.10.2026.." -> "12.10.2026." (a date that ends in a full stop followed by the sentence's own full stop); "..." stays. */
export function fixPunct(s: string): string {
	return s.replace(/(?<=[\p{L}\p{N}])\.\.(?!\.)/gu, ".")
}

export function parseSources(state: DosijeState, raw: unknown): SourceRef[] {
	if (!Array.isArray(raw)) return []
	const out: SourceRef[] = []
	for (const item of raw) {
		if (!item || typeof item !== "object") continue
		const s = state.resolveSource(item as Partial<SourceRef>)
		if (s) out.push(s)
	}
	return out
}

export function parseClaim(raw: unknown): Claim | undefined {
	if (!raw || typeof raw !== "object") return undefined
	const c = raw as Record<string, unknown>
	const subject = typeof c.subject === "string" ? c.subject.trim() : ""
	const value = typeof c.value === "string" ? c.value.trim() : ""
	if (!subject || !value) return undefined
	const predicate = PREDICATES.includes(c.predicate as ClaimPredicate) ? (c.predicate as ClaimPredicate) : "drugo"
	return { subject: clip(subject, 120), predicate, value: clip(value, 200) }
}

export function addFinding(ctx: ToolCtx, args: FindingArgs): { ok: boolean; findingId?: string; error?: string } {
	const state = S()
	if (!state.isCurrent(ctx.caseId)) return { ok: false, error: "Slučaj je zatvoren ili zamenjen novim." }
	const section = args.section as Section
	const severity = (args.severity as Severity) ?? "info"
	if (!SECTIONS.includes(section)) return { ok: false, error: `section mora biti jedan od: ${SECTIONS.join(", ")}` }
	if (!SEVERITIES.includes(severity)) return { ok: false, error: `severity mora biti jedan od: ${SEVERITIES.join(", ")}` }
	const title = typeof args.title === "string" ? fixPunct(clip(args.title, 180)) : ""
	const text = typeof args.text === "string" ? fixPunct(clip(args.text, 900)) : ""
	if (!title || !text) return { ok: false, error: "title i text su obavezni" }
	const sources = parseSources(state, args.sources)
	if (sources.length === 0) return { ok: false, error: "ODBIJENO: nalaz mora imati bar jedan http(s) izvor" }
	const signalCode = SIGNALS.includes(args.signalCode as SignalCode) ? (args.signalCode as SignalCode) : undefined
	let entityIds = Array.isArray(args.entityIds) ? args.entityIds.filter((e): e is string => typeof e === "string" && state.entities.has(e)) : []
	if (entityIds.length === 0 && ctx.entityId && state.entities.has(ctx.entityId)) entityIds = [ctx.entityId]
	const approval = args._approval === "approved" ? "approved" : args._approval === "pending" ? "pending" : "not_required"
	const target = typeof args.potkrepljuje === "string" ? state.findings.get(state.mergedAway.get(args.potkrepljuje) ?? args.potkrepljuje) : undefined
	const now = nowIso()
	const finding: Finding = {
		id: state.nextFindingId(),
		caseId: ctx.caseId,
		section,
		title,
		text,
		status: computeStatus(sources),
		severity,
		signalCode,
		sources,
		entityIds,
		claim: parseClaim(args.claim),
		corroborates: target && target.agentId !== ctx.agentId ? target.id : undefined,
		agentId: ctx.agentId,
		agentName: ctx.agentName,
		createdAt: now,
		updatedAt: now,
		approval,
	}
	state.findings.set(finding.id, finding)
	state.touch()
	emit("finding.added", ctx.agentId, { finding: structuredClone(finding) })
	return { ok: true, findingId: finding.id }
}

export function entityIdFor(kind: EntityKind, name: string, attrs: Record<string, unknown> = {}): string {
	if (kind === "firma") {
		const key = (typeof attrs.mb === "string" && attrs.mb) || (typeof attrs.pib === "string" && attrs.pib) || slug(name)
		return `firma:${key}`
	}
	return `${kind}:${slug(name)}`
}

function cleanAttrs(raw: unknown): Entity["attrs"] {
	const out: Entity["attrs"] = {}
	if (!raw || typeof raw !== "object") return out
	for (const [k, v] of Object.entries(raw as Record<string, unknown>).slice(0, 16)) {
		if (typeof v === "string") out[k] = clip(v, 160)
		else if (typeof v === "number" || typeof v === "boolean" || v === null) out[k] = v
	}
	return out
}

export function addEntity(
	ctx: { agentId: string; agentName: string; caseId: string },
	args: { kind?: unknown; name?: unknown; role?: unknown; attrs?: unknown; sources?: unknown },
): { ok: boolean; entityId?: string; duplicate?: boolean; error?: string; entity?: Entity } {
	const state = S()
	if (!state.isCurrent(ctx.caseId)) return { ok: false, error: "Slučaj je zatvoren ili zamenjen novim." }
	const kind = args.kind as EntityKind
	if (kind !== "osoba" && kind !== "firma" && kind !== "institucija") return { ok: false, error: "kind mora biti osoba ili firma" }
	const name = typeof args.name === "string" ? clip(args.name, 120) : ""
	if (name.length < 2) return { ok: false, error: "name je obavezan" }
	const attrs = cleanAttrs(args.attrs)
	const id = entityIdFor(kind, name, attrs)
	const existing = state.entities.get(id)
	if (existing) return { ok: true, entityId: id, duplicate: true, entity: existing }
	const roles: EntityRole[] = ["institucija", "funkcioner", "dobavljac", "vlasnik", "pomenut"]
	const role = roles.includes(args.role as EntityRole) ? (args.role as EntityRole) : kind === "firma" ? "dobavljac" : kind === "institucija" ? "institucija" : "pomenut"
	const entity: Entity = {
		id,
		caseId: ctx.caseId,
		kind,
		name,
		role,
		attrs,
		addedBy: ctx.agentId,
		addedByName: ctx.agentName,
		addedAt: nowIso(),
		sources: parseSources(state, args.sources),
	}
	state.entities.set(id, entity)
	state.touch()
	emit("entity.added", ctx.agentId, { entity: structuredClone(entity) })
	return { ok: true, entityId: id, duplicate: false, entity }
}

export function askHuman(
	ctx: ToolCtx,
	args: { question?: unknown; title?: unknown; hint?: unknown; links?: unknown; entityName?: unknown },
): { ok: boolean; taskId?: string; error?: string } {
	const state = S()
	if (!state.isCurrent(ctx.caseId)) return { ok: false, error: "Slučaj je zatvoren ili zamenjen novim." }
	const question = typeof args.question === "string" ? clip(args.question, 500) : ""
	if (question.length < 5) return { ok: false, error: "question je obavezan" }
	const dupe = [...state.tasks.values()].find((t) => t.kind === "pitanje" && t.status === "open" && t.fromAgentId === ctx.agentId && t.question === question)
	if (dupe) return { ok: true, taskId: dupe.id }
	let entityId = ctx.entityId
	if (typeof args.entityName === "string") {
		const wanted = slug(args.entityName)
		const found = [...state.entities.values()].find((e) => slug(e.name) === wanted)
		if (found) entityId = found.id
	}
	const links = Array.isArray(args.links)
		? args.links
				.filter((l): l is { label: string; url: string } => !!l && typeof l === "object" && typeof (l as { url?: unknown }).url === "string" && /^https?:\/\//i.test((l as { url: string }).url))
				.map((l) => ({ label: clip(String(l.label ?? l.url), 80), url: l.url }))
				.slice(0, 4)
		: undefined
	const task: HumanTask = {
		id: state.nextTaskId(),
		caseId: ctx.caseId,
		kind: "pitanje",
		title: typeof args.title === "string" && args.title.trim() ? clip(args.title, 120) : clip(question, 90),
		question,
		hint: typeof args.hint === "string" && args.hint.trim() ? clip(args.hint, 400) : undefined,
		links: links?.length ? links : undefined,
		fromAgentId: ctx.agentId,
		fromAgentName: ctx.agentName,
		entityId,
		blocking: false,
		status: "open",
		createdAt: nowIso(),
	}
	state.tasks.set(task.id, task)
	state.touch()
	emit("pitanje.za_coveka", ctx.agentId, { task: structuredClone(task) })
	return { ok: true, taskId: task.id }
}

export function updateTask(taskId: string, patch: Partial<HumanTask>): HumanTask | undefined {
	const state = S()
	const task = state.tasks.get(taskId)
	if (!task) return undefined
	const updated: HumanTask = { ...task, ...patch }
	state.tasks.set(taskId, updated)
	state.touch()
	emit("task.updated", ids.urednik, { task: structuredClone(updated) })
	return updated
}

export function publishConflict(conflict: Conflict): void {
	const state = S()
	state.conflicts.set(conflict.id, conflict)
	emit("conflict.resolved", ids.urednik, { conflict: structuredClone(conflict) })
}

export function updateFinding(finding: Finding, reason: "merge" | "conflict" | "approval" | "status"): void {
	const state = S()
	finding.updatedAt = nowIso()
	state.findings.set(finding.id, finding)
	state.touch()
	emit("finding.updated", ids.urednik, { finding: structuredClone(finding), reason })
}

let budgetTimer: NodeJS.Timeout | undefined

/** Coalesced budget.updated event (counters change very often). */
export function scheduleBudgetEvent(): void {
	if (budgetTimer) return
	budgetTimer = setTimeout(() => {
		budgetTimer = undefined
		try {
			emit("budget.updated", ids.urednik, { budget: { ...S().budget } })
		} catch (err) {
			logError("budget.updated", err)
		}
	}, 120)
	budgetTimer.unref?.()
}
