// Live stream from the server: a WebSocket (/api/ws), with SSE (/api/events) only as a fallback when WebSockets cannot
// connect. Browsers keep at most six HTTP/1.1 connections per server; SSE streams of a few open tabs used to take all six,
// so every other request (start a case, a map, the state) waited forever ("povezujem…"). A WebSocket does not count
// toward those six. The server sends the snapshot and the replay of the current run on every (re)connect.

import { applyEvent, applySnapshot, applyStats, setConn } from "./store.js"

const RETRY_MS = 1500
const WS_FAILS_BEFORE_SSE = 3
const SSE_HIDDEN_GRACE_MS = 15000

let ws = null
let es = null
let wsFails = 0
let retryTimer = null
let hiddenTimer = null

function parse(text) {
	try {
		return JSON.parse(text)
	} catch {
		return null
	}
}

function dispatch(event, data) {
	if (data == null) return
	if (event === "snapshot") applySnapshot(data)
	else if (event === "ev") applyEvent(data)
	else if (event === "evs") for (const ev of data) applyEvent(ev)
	else if (event === "stats") applyStats(data)
}

function retry() {
	clearTimeout(retryTimer)
	retryTimer = setTimeout(startStream, RETRY_MS)
}

function startWs() {
	const sock = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/ws`)
	ws = sock
	let opened = false
	sock.addEventListener("open", () => {
		if (sock !== ws) return
		opened = true
		wsFails = 0
		setConn("up")
	})
	sock.addEventListener("message", (m) => {
		if (sock !== ws) return
		const msg = parse(m.data)
		if (msg) dispatch(msg.e, msg.d)
	})
	sock.addEventListener("close", () => {
		if (sock !== ws) return
		ws = null
		if (!opened) wsFails++
		setConn("down")
		retry()
	})
}

function startSse() {
	const src = new EventSource("/api/events")
	es = src
	src.addEventListener("open", () => src === es && setConn("up"))
	src.addEventListener("error", () => {
		if (src !== es) return
		setConn("down")
		if (src.readyState === EventSource.CLOSED) {
			es = null
			if (!document.hidden) retry()
		}
	})
	for (const event of ["snapshot", "ev", "stats"]) src.addEventListener(event, (e) => src === es && dispatch(event, parse(e.data)))
}

export function startStream() {
	clearTimeout(retryTimer)
	if (ws) {
		const old = ws
		ws = null
		old.close()
	}
	if (es) {
		es.close()
		es = null
	}
	if (typeof WebSocket !== "undefined" && wsFails < WS_FAILS_BEFORE_SSE) startWs()
	else startSse()
}

// only the SSE fallback holds one of the six HTTP connections: a hidden tab gives it back and reconnects when shown
document.addEventListener("visibilitychange", () => {
	clearTimeout(hiddenTimer)
	if (document.hidden) {
		if (es)
			hiddenTimer = setTimeout(() => {
				if (!es) return
				es.close()
				es = null
				setConn("paused")
			}, SSE_HIDDEN_GRACE_MS)
	} else if (!ws && !es) startStream()
})
