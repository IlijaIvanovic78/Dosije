// EventSource with auto-reconnect; re-fetches /api/state after every reconnect.

import { api } from "./api.js"
import { applyEvent, applySnapshot, applyStats, setConn } from "./store.js"

let es = null
let hadError = false

function parse(e) {
	try {
		return JSON.parse(e.data)
	} catch {
		return null
	}
}

export function startStream() {
	if (es) es.close()
	es = new EventSource("/api/events")

	es.addEventListener("open", async () => {
		setConn("up")
		if (hadError) {
			hadError = false
			try {
				applySnapshot(await api.state())
			} catch (e) {
				console.warn("state re-fetch failed", e)
			}
		}
	})
	es.addEventListener("error", () => {
		hadError = true
		setConn("down")
		if (es.readyState === EventSource.CLOSED) setTimeout(startStream, 2000)
	})
	es.addEventListener("snapshot", (e) => applySnapshot(parse(e)))
	es.addEventListener("ev", (e) => applyEvent(parse(e)))
	es.addEventListener("stats", (e) => applyStats(parse(e)))
}
