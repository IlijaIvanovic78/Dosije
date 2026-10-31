// Boot: initialize the Mozaik runtime ONCE per process, join the fixed participants (observers first, so they see every
// event before anyone reacts to it) and the core agents, then startCase() for every new dossier. "New case" resets the
// case inside DosijeState: initializeRuntime cannot run twice.

import fs from "node:fs"
import path from "node:path"
import { type Agent } from "@mozaik-ai/core"
import { config, editorModelLabel, modelLabel } from "../config"
import * as data from "../data"
import { LEGAL_LABELS, LEGAL_LABELS_EN, type ResolvedInstitution } from "../data/resolver"
import type { Lang } from "../shared/lang"
import { n } from "../shared/plural"
import type { AgentInfo, DosijeReport, DosijeSnapshot, InstitutionView, MapaView, RuntimeConfigView } from "../shared/types"
import { finalizeActivities, forgetActivities, installActivityBridge } from "./activity"
import { CORE_AGENTS, OBSERVERS, createCoreAgent } from "./agents"
import { bus } from "./bus"
import * as domain from "./domain"
import { ids, S } from "./domain"
import { ResilientInferenceRunner } from "./inference/resilient"
import { ScriptedInferenceRunner } from "./inference/scripted"
import { loadMapaPreset, normalizeInstitutions, startMapaWatch } from "./mapa"
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

const EXAMPLES_FILE = path.resolve(process.cwd(), "data", "static", "examples.json")

/** The institutions offered on the start screen ("Aktuelne institucije"): name as typed, plus what kind of body it is. */
function loadExamples(): RuntimeConfigView["demoInstitutions"] {
	try {
		const raw = JSON.parse(fs.readFileSync(EXAMPLES_FILE, "utf8")) as { slug?: string; name?: string; kind?: string }[]
		return raw
			.filter((r) => typeof r?.name === "string" && r.name.trim())
			.map((r) => ({ slug: r.slug || slug(r.name as string), name: (r.name as string).trim(), ...(r.kind ? { kind: r.kind } : {}) }))
	} catch {
		return []
	}
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
		demoInstitutions: loadExamples(),
		mapaPreset: loadMapaPreset(),
		asksUser: config.askHuman || config.approvals,
	}
}

export function boot(): Promise<void> {
	booted ??= doBoot()
	return booted
}

async function doBoot(): Promise<void> {
	installSafetyNet()
	installActivityBridge()
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
	log("boot", `Mozaik runtime spreman: ${n(state.participants.size, "ucesnik")}, režim ${config.mode}${config.mode === "llm" ? ` (${config.provider}, ${config.model})` : ""}, podaci ${config.dataMode}`)
}

function institutionView(ref: ResolvedInstitution, lang: Lang): InstitutionView {
	return {
		name: ref.name,
		nameCyr: ref.nameCyr,
		slug: ref.slug,
		legalType: (lang === "en" ? LEGAL_LABELS_EN : LEGAL_LABELS)[ref.legalType],
		pib: ref.pib,
		mb: ref.mb,
		acasId: ref.acasId,
		jnId: ref.jnId,
	}
}

function teardownCase(): void {
	const state = S()
	stopCompletionWatch()
	// a case or map that is replaced (or was never finished) leaves no request "u_toku" behind
	finalizeActivities(null, state.mapa.id && state.caseId === null ? "prekinuto: mapa zamenjena novom" : "prekinuto: dosije zamenjen novim")
	forgetActivities()
	for (const loopId of state.activeLoops.keys()) state.staleLoops.add(loopId)
	state.activeLoops.clear()
	for (const settle of [...state.pendingApprovals.values()]) settle("reject")
	leaveAllDynamic(true)
}

const MAPA_RUNNING = "Poređenje institucija je u toku: sačekajte da se završi pre nego što pokrenete dosije."
const CASE_RUNNING = "Dosije je u toku: sačekajte da se završi (ili ga zatvorite) pre nego što pokrenete poređenje institucija."

export async function startCase(input: string, focus?: string, lang: Lang = "sr"): Promise<{ caseId: string; institution: InstitutionView }> {
	await boot()
	const state = S()
	if (state.mapaRunning()) throw new ApiError(409, MAPA_RUNNING)
	const ref = await data.resolveInstitution(input)
	if (state.mapaRunning()) throw new ApiError(409, MAPA_RUNNING)
	teardownCase()
	const caseId = `dos-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
	const view = institutionView(ref, lang)
	const mentioned = (ref.mentionedOfficials ?? []).map((m) => m.name)
	state.resetCase({ caseId, input, focus: focus?.trim() || undefined, institution: view, ref, mentioned, lang })
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

/**
 * "Mapa prioriteta": the Novinar publishes mapa.started; the Fabrika reacts by resolving every institution and spawning one
 * Trijaža agent each (see participants.ts). There is no orchestrator here: this function only opens the run.
 */
export async function startMapa(input?: unknown, lang: Lang = "sr"): Promise<{ mapaId: string; institutions: { slug: string; name: string }[] }> {
	await boot()
	const state = S()
	if (state.status === "running" || state.status === "finalizing") throw new ApiError(409, CASE_RUNNING)
	if (state.mapaRunning()) throw new ApiError(409, "Poređenje institucija je već u toku.")
	let institutions: { slug: string; name: string }[]
	try {
		institutions = normalizeInstitutions(input)
	} catch (err) {
		throw new ApiError(400, (err as Error).message)
	}
	teardownCase()
	const mapaId = `map-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
	state.resetMapa(mapaId, institutions, lang)
	bus.emitSnapshot(state.snapshot(configView()))
	domain.emit("mapa.started", ids.novinar, { mapaId, institutions })
	startMapaWatch()
	log("mapa", `${mapaId}: ${institutions.map((i) => i.name).join(", ")}`)
	return { mapaId, institutions }
}

export function getMapa(): MapaView {
	return S().mapaView() ?? { id: null, status: "idle", rows: [] }
}

export async function waitForMapa(timeoutMs = 300_000): Promise<MapaView> {
	const state = S()
	const deadline = Date.now() + timeoutMs
	while (state.mapa.status === "running" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
	return getMapa()
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
	if (task.kind === "pitanje" && !decision && !answer) throw new ApiError(400, "Upišite odgovor ili kliknite „Preskočite“.")
	domain.emit("odgovor.coveka", ids.novinar, { taskId, decision, answer })
}

export function addLead(body: { name?: unknown; kind?: unknown }): void {
	const state = S()
	if (state.status !== "running" || !state.caseId) throw new ApiError(409, "Nema aktivnog dosijea.")
	const name = typeof body.name === "string" ? body.name.trim().slice(0, 80) : ""
	if (name.length < 2) throw new ApiError(400, "Upišite ime ili naziv.")
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

/** Nobody is looking any more (the page was closed): stop the case or map in progress and forget it. */
export function discardRun(): void {
	const state = S()
	if (state.caseId === null && !state.mapa.id) return
	const what = state.caseId ? `dosije ${state.institution?.name ?? state.caseId}` : "mapa prioriteta"
	teardownCase()
	state.resetIdle()
	bus.emitSnapshot(state.snapshot(configView()))
	log("server", `stranica je zatvorena: ${what} je odbačen(a)`)
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
