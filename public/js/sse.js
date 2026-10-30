// EventSource with auto-reconnect; re-fetches /api/state after every reconnect.
// Browsers allow about six connections per server over HTTP/1.1 and every open tab keeps one stream open, so a tab
// that stays in the background gives its stream back and reconnects (snapshot + replay) when it is shown again.

import { api } from "./api.js"
import { applyEvent, applySnapshot, applyStats, setConn } from "./store.js"

const HIDDEN_GRACE_MS = 15000

let es = null
let hadError = false
let hiddenTimer = null

function parse(e) {
	try {
		return JSON.parse(e.data)
	} catch {
		return null
	}
}

export function startStream() {
	if (es) es.close()
	const src = new EventSource("/api/events")
	es = src

	src.addEventListener("open", async () => {
		if (src !== es) return
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
	src.addEventListener("error", () => {
		if (src !== es) return
		hadError = true
		setConn("down")
		// a hidden tab reconnects when it is shown again
		if (src.readyState === EventSource.CLOSED && !document.hidden) setTimeout(() => src === es && startStream(), 2000)
	})
	src.addEventListener("snapshot", (e) => applySnapshot(parse(e)))
	src.addEventListener("ev", (e) => applyEvent(parse(e)))
	src.addEventListener("stats", (e) => applyStats(parse(e)))
}

function pause() {
	if (!es) return
	es.close()
	es = null
	hadError = true // the reconnect re-fetches the state
	setConn("paused")
}

document.addEventListener("visibilitychange", () => {
	clearTimeout(hiddenTimer)
	if (document.hidden) hiddenTimer = setTimeout(pause, HIDDEN_GRACE_MS)
	else if (!es || es.readyState === EventSource.CLOSED) startStream()
})
