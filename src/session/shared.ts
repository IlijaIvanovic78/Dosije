// Read-only data every session needs that is big enough to keep only once: the APR register index (134k companies,
// ~100 MB as objects, more while it is parsed). Twenty sessions with a copy each would spend 2 GB on the same table.
// In a session worker the calls go over a MessagePort to the one data worker (data-worker.ts); anywhere else (CLI,
// tests, the data worker itself), or when that port is gone or does not answer, they run in place.

import { workerData, type MessagePort } from "node:worker_threads"

const TIMEOUT_MS = 30_000

type Reply = { id: number; ok: true; value: unknown } | { id: number; ok: false; message: string }
interface Pending {
	resolve: (v: unknown) => void
	reject: (e: Error) => void
	local: () => Promise<unknown>
	timer: NodeJS.Timeout
}

const port = (workerData as { dataPort?: MessagePort } | null)?.dataPort ?? null
let open = port !== null
const pending = new Map<number, Pending>()
let nextId = 0

/** The data worker is gone or did not answer: the call runs here instead; the caller just waits for it. */
function inPlace(p: Pending): void {
	clearTimeout(p.timer)
	p.local().then(p.resolve, p.reject)
}

port?.on("message", (m: Reply) => {
	const p = pending.get(m.id)
	if (!p) return
	pending.delete(m.id)
	clearTimeout(p.timer)
	if (m.ok) p.resolve(m.value)
	else p.reject(new Error(m.message))
})
port?.on("close", () => {
	open = false
	for (const p of pending.values()) inPlace(p)
	pending.clear()
})
// the session's own message port keeps the worker alive; this one must not keep a finished worker from exiting
port?.unref()

/** `fn` in the data worker when there is one (`args` must be cloneable), else `local()` here. */
export function viaDataWorker<T>(fn: string, args: unknown[], local: () => Promise<T>): Promise<T> {
	if (!port || !open) return local()
	return new Promise<T>((resolve, reject) => {
		const id = ++nextId
		const p: Pending = {
			resolve: resolve as (v: unknown) => void,
			reject,
			local,
			timer: setTimeout(() => {
				pending.delete(id)
				inPlace(p)
			}, TIMEOUT_MS),
		}
		p.timer.unref?.()
		pending.set(id, p)
		port.postMessage({ id, fn, args })
	})
}
