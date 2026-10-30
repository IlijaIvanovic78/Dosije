// Boot: initialize the Mozaik runtime ONCE per process, join the fixed participants (observers first, so they see every
// event before anyone reacts to it) and the core agents, then startCase() for every new dossier. "New case" resets the
// case inside DosijeState: initializeRuntime cannot run twice.

import { type Agent } from "@mozaik-ai/core"
import { config, editorModelLabel, modelLabel } from "../config"
import * as data from "../data"
import { LEGAL_LABELS, listStaticInstitutions, type ResolvedInstitution } from "../data/resolver"
import type { AgentInfo, DosijeReport, DosijeSnapshot, InstitutionView, RuntimeConfigView } from "../shared/types"
import { CORE_AGENTS, OBSERVERS, createCoreAgent } from "./agents"
import { bus } from "./bus"
import * as domain from "./domain"
import { ids, S } from "./domain"
import { ResilientInferenceRunner } from "./inference/resilient"
import { ScriptedInferenceRunner } from "./inference/scripted"
import { coreAgentHandlers, createFabrika, createNovinar, createSseMost, createZapisnicar, trace } from "./participants"
import { initializeRuntime, join, sendMessage } from "./runtime"
import { DosijeState } from "./state"
import { finalizeCase, leaveAllDynamic, startCompletionWatch, stopCompletionWatch, urednikHandlers } from "./urednik"
import { log, logError, nowIso, slug } from "./util"

export class ApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message)
	}
}

let booted: Promise<void> | undefined
let safetyNet = false

function installSafetyNet(): void {
	if (safetyNet) return
	safetyNet = true
	// the Mozaik loop visitor prints this warning for EVERY loop when no cloud key is set; telemetry is optional, so keep the log clean
	const warn = console.warn.bind(console)
	console.warn = (...a: unknown[]) => {
		if (typeof a[0] === "string" && a[0].startsWith("mozaik cloud: no API key")) return
		warn(...a)
	}
	process.on("unhandledRejection", (reason) => logError("unhandledRejection (agent runtime)", reason))
	process.on("uncaughtException", (err) => logError("uncaughtException", err))
}

export function configView(): RuntimeConfigView {
	let providers: string[] = []
	try {
		providers = data.news.availableProviders()
	} catch {
		providers = []
	}
	return {
		mode: config.mode,
		model: modelLabel(),
		editorModel: editorModelLabel(),
		dataMode: config.dataMode,
		searchProviders: providers,
		demoInstitutions: listStaticInstitutions(),
	}
}

export function boot(): Promise<void> {
	booted ??= doBoot()
	return booted
}

async function doBoot(): Promise<void> {
	installSafetyNet()
	const state = new DosijeState()
	const runner = config.mode === "llm" ? new ResilientInferenceRunner(state) : new ScriptedInferenceRunner()
	initializeRuntime({ state, inferenceRunnerConfig: { runner } })

	const registerInfo = (base: Omit<AgentInfo, "joinedAt" | "id">, id: string): AgentInfo => {
		const info: AgentInfo = { ...base, id, joinedAt: nowIso() }
		state.registerAgentInfo(info)
		return info
	}
	const observer = (name: string) => OBSERVERS.find((o) => o.name === name) as Omit<AgentInfo, "joinedAt">

	// observers first: they process every event before any other participant reacts to it
	const sse = createSseMost()
	ids.sseMost = sse.getId()
	registerInfo(observer("SSE most"), sse.getId())
	join(sse)
	const zap = createZapisnicar()
	ids.zapisnicar = zap.getId()
	registerInfo(observer("Zapisničar"), zap.getId())
	join(zap)

	const novinar = createNovinar()
	ids.novinar = novinar.getId()
	registerInfo(observer("Novinar"), novinar.getId())
	join(novinar)
	const fabrika = createFabrika()
	ids.fabrika = fabrika.getId()
	registerInfo(observer("Fabrika"), fabrika.getId())
	join(fabrika)

	for (const meta of CORE_AGENTS) {
		const { agent, info } = createCoreAgent(meta)
		state.registerAgentInfo(info)
		state.agents.set(info.id, agent)
		if (meta.group === "urednik") {
			ids.urednik = info.id
			agent.setHandlers(urednikHandlers())
		} else {
			const ref = (): Agent => agent
			agent.setHandlers(coreAgentHandlers(meta.group, ref))
		}
		join(agent)
	}
	log("boot", `Mozaik runtime spreman: ${state.participants.size} učesnika, režim ${config.mode}${config.mode === "llm" ? ` (${config.provider}, ${config.model})` : ""}, podaci ${config.dataMode}`)
}

function institutionView(ref: ResolvedInstitution): InstitutionView {
	return {
		name: ref.name,
		nameCyr: ref.nameCyr,
		slug: ref.slug,
		legalType: LEGAL_LABELS[ref.legalType],
		pib: ref.pib,
		mb: ref.mb,
		acasId: ref.acasId,
		jnId: ref.jnId,
	}
}

function teardownCase(): void {
	const state = S()
	stopCompletionWatch()
	for (const loopId of state.activeLoops.keys()) state.staleLoops.add(loopId)
	state.activeLoops.clear()
	for (const settle of [...state.pendingApprovals.values()]) settle("reject")
	leaveAllDynamic(true)
}

export async function startCase(input: string, focus?: string): Promise<{ caseId: string; institution: InstitutionView }> {
	await boot()
	const state = S()
	const ref = await data.resolveInstitution(input)
	teardownCase()
	const caseId = `dos-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
	const view = institutionView(ref)
	const mentioned = (ref.mentionedOfficials ?? []).map((m) => m.name)
	state.resetCase({ caseId, input, focus: focus?.trim() || undefined, institution: view, ref, mentioned })
	state.registerSources(ref.sources)
	bus.emitSnapshot(state.snapshot(configView()))

	sendMessage(`Napravi dosije: ${input}${focus ? ` (fokus: ${focus})` : ""}`, ids.novinar)
	domain.emit("dosije.started", ids.novinar, { caseId, input, focus: state.focus, institution: view })
	domain.addEntity(
		{ agentId: ids.novinar, agentName: "Novinar", caseId },
		{
			kind: "institucija",
			name: ref.name,
			role: "institucija",
			attrs: { pib: ref.pib ?? null, mb: ref.mb ?? null, acasId: ref.acasId ?? null, jnId: ref.jnId ?? null, legalType: ref.legalType },
			sources: ref.sources,
		},
	)
	startCompletionWatch()
	log("dosije", `slučaj ${caseId}: ${ref.name} (${view.legalType})${focus ? `, fokus: ${focus}` : ""}`)
	return { caseId, institution: view }
}

// ─── REST helpers (the journalist's actions, published on her behalf) ───────────────────────────────

export function submitAnswer(body: { taskId?: unknown; decision?: unknown; answer?: unknown }): void {
	const state = S()
	const taskId = typeof body.taskId === "string" ? body.taskId : ""
	const task = state.tasks.get(taskId)
	if (!task) throw new ApiError(404, "Zadatak ne postoji.")
	if (task.status !== "open") throw new ApiError(409, "Zadatak je već rešen.")
	const decision = body.decision === "approve" || body.decision === "reject" ? body.decision : undefined
	const answer = typeof body.answer === "string" && body.answer.trim() ? body.answer.trim().slice(0, 300) : undefined
	if (task.kind === "odobrenje" && !decision) throw new ApiError(400, "Za odobrenje pošalji decision: approve ili reject.")
	if (task.kind === "pitanje" && !decision && !answer) throw new ApiError(400, "Upiši odgovor ili klikni Preskoči.")
	domain.emit("odgovor.coveka", ids.novinar, { taskId, decision, answer })
}

export function addLead(body: { name?: unknown; kind?: unknown }): void {
	const state = S()
	if (state.status !== "running" || !state.caseId) throw new ApiError(409, "Nema aktivnog dosijea.")
	const name = typeof body.name === "string" ? body.name.trim().slice(0, 80) : ""
	if (name.length < 2) throw new ApiError(400, "Upiši ime ili naziv.")
	const kind = body.kind === "firma" ? "firma" : "osoba"
	const r = domain.addEntity(
		{ agentId: ids.novinar, agentName: "Novinar", caseId: state.caseId },
		{ kind, name, role: kind === "firma" ? "dobavljac" : "pomenut", attrs: kind === "firma" ? { ručno: true } : {} },
	)
	if (!r.ok) throw new ApiError(400, r.error ?? "Trag nije dodat.")
}

export function closeCase(): void {
	const state = S()
	if (!state.caseId || state.status === "done" || state.status === "idle") throw new ApiError(409, "Nema aktivnog dosijea.")
	domain.emit("dosije.zatvori", ids.novinar, { caseId: state.caseId })
}

export function getSnapshot(): DosijeSnapshot {
	return S().snapshot(configView())
}

export function getReport(): DosijeReport | undefined {
	return S().report
}

export function caseSlug(): string {
	return slug(S().institution?.name ?? "dosije", 50) || "dosije"
}

export async function waitForDone(timeoutMs = 300_000): Promise<DosijeReport | undefined> {
	const state = S()
	const deadline = Date.now() + timeoutMs
	while (state.status !== "done" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
	return state.report
}

export async function shutdown(): Promise<void> {
	stopCompletionWatch()
	await trace.close()
}

export { finalizeCase }
