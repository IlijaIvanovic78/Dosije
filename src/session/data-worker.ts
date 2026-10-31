// The data worker: the one copy of the big read-only tables all sessions share (see shared.ts). The server hands it one
// end of a MessageChannel per session; the session worker holds the other end and calls it directly, so lookups never
// pass through the main thread.

import { parentPort, type MessagePort } from "node:worker_threads"
import * as apr from "../data/sources/apr"

const FNS: Record<string, (...args: never[]) => Promise<unknown>> = {
	"apr.getCompany": apr.getCompany,
	"apr.searchCompanies": apr.searchCompanies,
	"apr.findInstitutionCompany": apr.findInstitutionCompany,
	"apr.restoreDiacritics": apr.restoreDiacritics,
}

function serve(port: MessagePort): void {
	port.on("message", ({ id, fn, args }: { id: number; fn: string; args: never[] }) => {
		Promise.resolve()
			.then(() => {
				const f = FNS[fn]
				if (!f) throw new Error(`data worker: nepoznata funkcija ${fn}`)
				return f(...args)
			})
			.then(
				(value) => port.postMessage({ id, ok: true, value }),
				(err: unknown) => port.postMessage({ id, ok: false, message: (err as Error)?.message ?? String(err) }),
			)
	})
}

parentPort?.on("message", (m: { t: "port"; port: MessagePort }) => {
	if (m.t === "port") serve(m.port)
})

// load the index and the diacritics vocabulary now, so the first visitor does not wait for them
void apr.restoreDiacritics("Posta Srbije").catch(() => {})
