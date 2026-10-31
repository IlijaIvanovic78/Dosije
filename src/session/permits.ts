// Limits shared by every session on the server. Each session runs in its own worker thread, so the semaphores in
// resilient.ts (LLM_CONCURRENCY) and data/http.ts (requests per host) only limit that one session; 20 sessions would
// mean 20 times the parallel LLM calls and 20 times the load on each public register. The main thread holds the shared
// counters (sessions.ts) and grants a permit over the worker's message port. Outside a session worker (CLI, tests)
// there is nothing to share and a permit is granted at once.

import { parentPort, workerData } from "node:worker_threads"
import type { FromEngine, SessionWorkerData, ToEngine } from "./protocol"

const port = parentPort && (workerData as Partial<SessionWorkerData> | null)?.dosijeSession ? parentPort : null
const waiting = new Map<number, () => void>()
let nextId = 0

port?.on("message", (m: ToEngine) => {
	if (m.t !== "permit.granted") return
	const grant = waiting.get(m.id)
	waiting.delete(m.id)
	grant?.()
})

const post = (m: FromEngine) => port?.postMessage(m)

/** Waits for a shared permit ("llm", "host:<host>") and returns the function that gives it back (safe to call twice). */
export async function sharedPermit(key: string): Promise<() => void> {
	if (!port) return () => {}
	const id = ++nextId
	await new Promise<void>((resolve) => {
		waiting.set(id, resolve)
		post({ t: "permit.acquire", id, key })
	})
	let released = false
	return () => {
		if (released) return
		released = true
		post({ t: "permit.release", id })
	}
}
