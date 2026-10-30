// The Urednik's deterministic processors (reaction map in docs/ARCHITECTURE.md 5.3): finding status, dedupe/merge,
// conflicts (official source wins), approvals and answers from the journalist, loop tracking and completion detection
// (idle 2.5 s -> final Urednik loop -> dosije.zavrsen). Only the final summary is an agent loop.

import type { SituationHandler } from "@mozaik-ai/core"
import { config } from "../config"
import { cyrToLat } from "../data/translit"
import type { Conflict, Finding, Severity } from "../shared/types"
import {
	emit,
	ids,
	publishConflict,
	S,
	scheduleBudgetEvent,
	updateFinding,
	updateTask,
} from "./domain"
import { handler } from "./handlers"
import { startAgentLoop } from "./loop"
import { buildReport } from "./report"
import { leave } from "./runtime"
import { computeStatus, mergeSources } from "./state"
import { defaultSummary } from "./summary"
import { bus } from "./bus"
import { jaccard, log, logError, normClaim, nowIso, sleep } from "./util"

const SEVERITY_RANK: Record<Severity, number> = { info: 0, paznja: 1, signal: 2 }

// ─── dedupe / merge ──────────────────────────────────────────────────────────

function entityRelation(a: Finding, b: Finding): "same" | "conflict" | "unknown" {
	if (!a.entityIds.length || !b.entityIds.length) return "unknown"
	return a.entityIds.some((e) => b.entityIds.includes(e)) ? "same" : "conflict"
}

function sameClaim(a: Finding, b: Finding): boolean {
	if (!a.claim || !b.claim) return false
	return normClaim(a.claim.subject) === normClaim(b.claim.subject) && a.claim.predicate === b.claim.predicate && normClaim(a.claim.value) === normClaim(b.claim.value)
}

function isDuplicate(older: Finding, n: Finding): boolean {
	const rel = entityRelation(older, n)
	if (rel === "conflict") return false
	// same signal code + same first source URL (same entity, or at least a similar title: generic registry URLs are shared by many findings)
	const sharedUrl = older.sources.some((s) => n.sources.some((x) => x.url === s.url))
	if (older.signalCode && older.signalCode === n.signalCode && sharedUrl) {
		if (rel === "same" || jaccard(older.title, n.title) >= 0.85) return true
	}
	if (sameClaim(older, n)) return true
	if (older.section === n.section && (!older.signalCode || !n.signalCode || older.signalCode === n.signalCode) && jaccard(older.title, n.title) >= (rel === "same" ? 0.7 : 0.8)) return true
	return false
}

function mergeInto(older: Finding, n: Finding): void {
	const state = S()
	older.sources = mergeSources(older.sources, n.sources)
	if (older.status !== "demantovano") older.status = computeStatus(older.sources)
	if (SEVERITY_RANK[n.severity] > SEVERITY_RANK[older.severity]) older.severity = n.severity
	if (!older.claim && n.claim) older.claim = n.claim
	if (!older.signalCode && n.signalCode) older.signalCode = n.signalCode
	older.entityIds = [...new Set([...older.entityIds, ...n.entityIds])]
	older.mergedFrom = [...(older.mergedFrom ?? []), n.id, ...(n.mergedFrom ?? [])]
	older.note = `Spojeno iz ${older.mergedFrom.length + 1} nalaza (${[...new Set([older.agentName, n.agentName])].join(", ")}).`
	state.findings.delete(n.id)
	state.mergedAway.set(n.id, older.id)
	updateFinding(older, "merge")
}

// ─── conflicts ───────────────────────────────────────────────────────────────

function latestDate(f: Finding): string {
	return f.sources.map((s) => s.publishedAt ?? "").sort().pop() || f.createdAt
}

function describe(f: Finding): string {
	const s = f.sources.find((x) => x.official) ?? f.sources[0]
	if (!s) return f.agentName
	return cyrToLat(s.official ? s.title.split("–")[0].trim() || s.title : s.title.split(":")[0].trim() || s.title)
}

function resolveConflict(a: Finding, b: Finding): void {
	const state = S()
	const key = [a.id, b.id].sort().join("|")
	if (state.conflictPairs.has(key)) return
	state.conflictPairs.add(key)
	const officialA = a.sources.some((s) => s.official)
	const officialB = b.sources.some((s) => s.official)
	let winner: Finding
	let rule: Conflict["rule"]
	if (officialA !== officialB) {
		winner = officialA ? a : b
		rule = "zvanicni_izvor_ima_prednost"
	} else if (a.sources.length !== b.sources.length) {
		winner = a.sources.length > b.sources.length ? a : b
		rule = "vise_izvora"
	} else {
		winner = latestDate(a) >= latestDate(b) ? a : b
		rule = "noviji_datum"
	}
	const loser = winner === a ? b : a
	const wv = winner.claim?.value ?? ""
	const lv = loser.claim?.value ?? ""
	const explanation =
		rule === "zvanicni_izvor_ima_prednost"
			? `${describe(winner)} (zvanični izvor) navodi „${wv}“, a ${describe(loser)} navodi „${lv}“. Zvanični izvor ima prednost; drugi navod je označen kao demantovan i treba ga proveriti.`
			: rule === "vise_izvora"
				? `Nijedan ili oba nalaza imaju zvanični izvor. Navod „${wv}“ ima više izvora (${winner.sources.length} prema ${loser.sources.length}) od navoda „${lv}“.`
				: `Izvori su izjednačeni po zvaničnosti i broju. Noviji navod „${wv}“ ima prednost nad starijim „${lv}“; proveriti ručno.`
	const conflict: Conflict = {
		id: state.nextConflictId(),
		caseId: winner.caseId,
		subject: winner.claim?.subject ?? loser.claim?.subject ?? "",
		predicate: winner.claim?.predicate ?? "drugo",
		findingIds: [winner.id, loser.id],
		values: [wv, lv],
		winnerFindingId: winner.id,
		rule,
		explanation,
		resolvedBy: ids.urednik,
		at: nowIso(),
	}
	loser.status = "demantovano"
	loser.conflictId = conflict.id
	loser.note =
		rule === "zvanicni_izvor_ima_prednost"
			? `Zvanični izvor ima prednost: ${describe(winner)} navodi „${wv}“, ovaj nalaz navodi „${lv}“.`
			: `Konflikt izvora: prednost ima navod „${wv}“.`
	winner.conflictId = conflict.id
	publishConflict(conflict)
	updateFinding(loser, "conflict")
	updateFinding(winner, "conflict")
}

const isRefuted = (f: Finding): boolean => f.status === "demantovano"

function detectConflicts(f: Finding): void {
	const state = S()
	if (!f.claim || f.status === "demantovano") return
	const subject = normClaim(f.claim.subject)
	const value = normClaim(f.claim.value)
	for (const other of state.findingList()) {
		if (other.id === f.id || !other.claim || other.status === "demantovano") continue
		if (other.claim.predicate !== f.claim.predicate || normClaim(other.claim.subject) !== subject) continue
		if (normClaim(other.claim.value) === value) continue
		resolveConflict(other, f)
		if (isRefuted(f)) return
	}
}

export function processFinding(findingId: string): void {
	const state = S()
	const f = state.findings.get(findingId)
	if (!f || !state.isCurrent(f.caseId)) return
	const computed = computeStatus(f.sources)
	if (f.status !== computed && f.status !== "demantovano") {
		f.status = computed
		updateFinding(f, "status")
	}
	for (const older of state.findingList()) {
		if (older.id === f.id) break
		if (older.status === "demantovano" && !sameClaim(older, f)) continue
		if (isDuplicate(older, f)) {
			mergeInto(older, f)
			detectConflicts(older)
			return
		}
	}
	detectConflicts(f)
}

// ─── answers from the journalist ─────────────────────────────────────────────

function onAnswer(p: { taskId?: string; decision?: "approve" | "reject"; answer?: string }): void {
	const state = S()
	const task = p.taskId ? state.tasks.get(p.taskId) : undefined
	if (!task || task.status !== "open" || !state.isCurrent(task.caseId)) return
	const answer = typeof p.answer === "string" && p.answer.trim() ? p.answer.trim().slice(0, 300) : undefined
	if (task.kind === "odobrenje") {
		const approve = p.decision === "approve"
		updateTask(task.id, { status: approve ? "approved" : "rejected", answer, answeredAt: nowIso() })
		state.pendingApprovals.get(task.id)?.(approve ? "approve" : "reject")
		return
	}
	if (p.decision === "reject" || !answer) {
		updateTask(task.id, { status: "rejected", answeredAt: nowIso() })
		maybeLeave(task.fromAgentId)
		return
	}
	updateTask(task.id, { status: "answered", answer, answeredAt: nowIso() })
	const agent = state.agents.get(task.fromAgentId)
	const started = agent ? startAgentLoop(agent, `Novinarka je odgovorila na pitanje "${task.question}": ${answer}`) : false
	if (!started) maybeLeave(task.fromAgentId)
}

// ─── loops, leaving agents ───────────────────────────────────────────────────

export function maybeLeave(agentId: string): void {
	const state = S()
	const info = state.agentInfo.get(agentId)
	const agent = state.agents.get(agentId)
	if (!info?.dynamic || !agent) return
	if (state.loopsOf(agentId) > 0) return
	if ([...state.tasks.values()].some((t) => t.status === "open" && t.fromAgentId === agentId)) return
	leaveNow(agentId)
}

function leaveNow(agentId: string, sync = false): void {
	const state = S()
	const info = state.agentInfo.get(agentId)
	const agent = state.agents.get(agentId)
	if (!info || !agent) return
	state.agents.delete(agentId)
	info.leftAt = nowIso()
	const doLeave = () => {
		try {
			leave(agent)
		} catch (err) {
			logError(`leave ${info.name}`, err)
		}
	}
	// leave() publishes participant.left to every participant: never inside a fan-out unless the caller asks for it
	if (sync) doLeave()
	else setImmediate(doLeave)
}

export function leaveAllDynamic(sync = false): void {
	const state = S()
	for (const [id, info] of [...state.agentInfo]) if (info.dynamic && state.agents.has(id)) leaveNow(id, sync)
}

function onLoopStarted(p: { loopId?: string }, producerId: string): void {
	const state = S()
	if (!p.loopId || state.staleLoops.has(p.loopId)) return
	state.loopStarted(p.loopId, producerId)
	scheduleBudgetEvent()
}

function onLoopEnded(p: { loopId?: string }, producerId: string): void {
	const state = S()
	if (!p.loopId || state.staleLoops.has(p.loopId)) return
	state.loopEnded(p.loopId)
	maybeLeave(producerId)
}

// ─── completion ──────────────────────────────────────────────────────────────

let watch: NodeJS.Timeout | undefined
let graceStartedAt: number | undefined
let finalizing = false

export function stopCompletionWatch(): void {
	if (watch) clearInterval(watch)
	watch = undefined
	graceStartedAt = undefined
}

export function startCompletionWatch(): void {
	stopCompletionWatch()
	finalizing = false
	const generation = S().generation
	watch = setInterval(() => {
		try {
			tick(generation)
		} catch (err) {
			logError("completion", err)
		}
	}, 250)
	watch.unref?.()
}

const STALL_MS = 360_000

function tick(generation: number): void {
	const state = S()
	if (state.generation !== generation || state.status !== "running") {
		if (state.generation !== generation) stopCompletionWatch()
		return
	}
	const now = Date.now()
	for (const [loopId, l] of state.activeLoops) {
		const waiting = [...state.tasks.values()].some((t) => t.status === "open" && t.blocking && t.fromAgentId === l.agentId)
		if (!waiting && now - l.lastEventAt > STALL_MS) {
			log("completion", `petlja ${loopId} (${state.nameOf(l.agentId)}) je zaglavljena: prisilno zatvaram`)
			state.loopEnded(loopId)
			maybeLeave(l.agentId)
		}
	}
	if (state.activeLoops.size > 0 || state.pendingSpawns > 0 || state.pendingApprovals.size > 0) {
		graceStartedAt = undefined
		return
	}
	if (now - state.lastActivityAt < config.idleMs) return
	const questions = state.openTasks().filter((t) => t.kind === "pitanje")
	if (questions.length > 0 && config.questionGraceMs > 0) {
		graceStartedAt ??= now
		if (now - graceStartedAt < config.questionGraceMs) return
	}
	void finalizeCase("idle")
}

export async function finalizeCase(reason: "idle" | "zatvori"): Promise<void> {
	const state = S()
	if (state.status !== "running" || finalizing) return
	finalizing = true
	stopCompletionWatch()
	const generation = state.generation
	const alive = () => state.generation === generation
	try {
		state.status = "finalizing"
		for (const [taskId, settle] of [...state.pendingApprovals]) {
			updateTask(taskId, { status: "rejected", answer: "Dosije je zatvoren pre odluke.", answeredAt: nowIso() })
			settle("reject")
		}
		for (const t of state.openTasks()) updateTask(t.id, { status: "expired", answeredAt: nowIso() })

		if (reason === "zatvori") {
			const deadline = Date.now() + 8000
			while (state.activeLoops.size > 0 && Date.now() < deadline && alive()) await sleep(50)
		}
		if (!alive()) return

		const urednik = state.agents.get(ids.urednik)
		const message = `Dosije za ${state.institution?.name ?? "instituciju"} je prikupljen: ${state.findings.size} nalaza, ${state.entities.size} entiteta, ${state.conflicts.size} konflikata. Napiši završni sažetak.`
		if (urednik && startAgentLoop(urednik, message, { editor: true })) {
			const deadline = Date.now() + (config.mode === "llm" ? 150_000 : 30_000)
			while (state.loopsOf(ids.urednik) > 0 && Date.now() < deadline && alive()) await sleep(50)
		}
		if (!alive()) return

		const summary = state.summary ?? defaultSummary(state)
		state.finishedAtMs = Date.now()
		state.report = buildReport(state, summary)
		state.status = "done"
		state.refreshStats()
		leaveAllDynamic()
		emit("dosije.zavrsen", ids.urednik, { caseId: state.caseId, report: structuredClone(state.report) })
		bus.emitStats(state.stats, state.budget)
		log("dosije", `završen (${reason}): ${state.findings.size} nalaza, vrhunac ${state.stats.peakConcurrentLoops} petlji, ${Math.round(state.stats.elapsedMs / 1000)} s`)
	} catch (err) {
		logError("finalize", err)
		if (alive() && state.status !== "done") {
			state.finishedAtMs = Date.now()
			state.report = buildReport(state, defaultSummary(state))
			state.status = "done"
			emit("dosije.zavrsen", ids.urednik, { caseId: state.caseId, report: structuredClone(state.report) })
		}
	}
}

// ─── handlers ────────────────────────────────────────────────────────────────

export function urednikHandlers(): SituationHandler[] {
	return [
		handler(["finding.added"], "urednik.finding", ({ event }) => processFinding((event.payload as { finding: Finding }).finding.id)),
		handler(["message_received.started"], "urednik.loop+", ({ event }) => onLoopStarted(event.payload as { loopId?: string }, event.producerId)),
		handler(["model.answer"], "urednik.loop-", ({ event }) => onLoopEnded(event.payload as { loopId?: string }, event.producerId)),
		handler(["odgovor.coveka"], "urednik.odgovor", ({ event }) => onAnswer(event.payload as { taskId?: string; decision?: "approve" | "reject"; answer?: string })),
		handler(["dosije.zatvori"], "urednik.zatvori", () => {
			void finalizeCase("zatvori")
		}),
	]
}
