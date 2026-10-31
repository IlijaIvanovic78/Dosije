// Messages between the server (main thread, sessions.ts) and one visitor's engine (a worker thread, engine.ts).
// Calls go in and come back as a result with the same id; the live stream comes out already serialized, so the server
// writes it to the browsers as it is. Permits are the limits all sessions share (permits.ts).

import type { MessagePort } from "node:worker_threads"

export type EngineOp = "config" | "state" | "mapa" | "report" | "startCase" | "startMapa" | "answer" | "lead" | "finish"

export type ToEngine = { t: "call"; id: number; op: EngineOp; args: Record<string, unknown> } | { t: "permit.granted"; id: number }

export type FromEngine =
	| { t: "ready" }
	| { t: "result"; id: number; ok: true; value: unknown }
	| { t: "result"; id: number; ok: false; status?: number; message: string }
	/** a wire event (JSON); `type` lets the server reset its replay when a new run starts */
	| { t: "ev"; type: string; json: string }
	| { t: "push"; event: "snapshot" | "stats"; json: string }
	| { t: "permit.acquire"; id: number; key: string }
	| { t: "permit.release"; id: number }

/** workerData of a session worker */
export interface SessionWorkerData {
	dosijeSession: string
	/** its end of the channel to the data worker (shared.ts) */
	dataPort?: MessagePort
}
