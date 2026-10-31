// One visitor's session: the whole Mozaik engine (runtime, agents, DosijeState, bus) in a worker thread of its own.
// The engine holds one case per process (initializeRuntime runs once, the state is a singleton), and a worker has its
// own copy of every module, so each visitor gets a complete engine that no other visitor can touch. The server
// (sessions.ts) calls it over the message port and writes its live stream to that visitor's pages (protocol.ts).

import { parentPort, workerData } from "node:worker_threads"
import { applyEntryDefaults } from "../config"
import { ApiError, addLead, boot, closeCase, configView, getMapa, getReport, getSnapshot, startCase, startMapa, submitAnswer } from "../mozaik/boot"
import { bus } from "../mozaik/bus"
import { S } from "../mozaik/domain"
import { logError } from "../mozaik/util"
import { asLang } from "../shared/lang"
import type { EngineOp, FromEngine, SessionWorkerData, ToEngine } from "./protocol"

applyEntryDefaults("server")

const port = parentPort
if (!port) throw new Error("engine.ts runs only as a session worker (src/session/sessions.ts)")
const { dosijeSession: label } = workerData as SessionWorkerData

// every log line names its session
for (const level of ["log", "warn", "error"] as const) {
	const write = console[level].bind(console)
	console[level] = (...args: unknown[]) => write(`[${label}]`, ...args)
}

const send = (m: FromEngine) => port.postMessage(m)
const str = (v: unknown) => (typeof v === "string" ? v : undefined)

const ops: Record<EngineOp, (a: Record<string, unknown>) => unknown> = {
	config: () => configView(),
	state: () => getSnapshot(),
	mapa: () => getMapa(),
	report: () => getReport() ?? null,
	startCase: (a) => startCase(String(a.input ?? ""), str(a.focus), asLang(a.lang)).then(({ caseId }) => ({ caseId })),
	startMapa: (a) => startMapa(a.institutions, asLang(a.lang)).then(({ mapaId }) => ({ mapaId })),
	answer: (a) => (submitAnswer(a), { ok: true }),
	lead: (a) => (addLead(a), { ok: true }),
	finish: () => (closeCase(), { ok: true }),
}

port.on("message", (m: ToEngine) => {
	if (m.t !== "call") return
	Promise.resolve()
		.then(() => ops[m.op](m.args))
		.then(
			(value) => send({ t: "result", id: m.id, ok: true, value }),
			(err: unknown) => send({ t: "result", id: m.id, ok: false, status: err instanceof ApiError ? err.status : undefined, message: (err as Error)?.message ?? String(err) }),
		)
})

bus.onWire((ev) => send({ t: "ev", type: ev.type, json: JSON.stringify(ev) }))
bus.onSnapshot((snap) => send({ t: "push", event: "snapshot", json: JSON.stringify(snap) }))
bus.onStats((s) => send({ t: "push", event: "stats", json: JSON.stringify(s) }))

// the live counters while a case or a map runs (the server drops them when no page is open)
setInterval(() => {
	try {
		const state = S()
		if (state.status === "running" || state.status === "finalizing" || state.mapa.status === "running")
			send({ t: "push", event: "stats", json: JSON.stringify({ stats: state.refreshStats(), budget: state.budget }) })
	} catch {
		// runtime not ready yet
	}
}, 1000).unref()

boot().then(
	() => send({ t: "ready" }),
	(err) => {
		logError("start", err)
		process.exit(1)
	},
)
