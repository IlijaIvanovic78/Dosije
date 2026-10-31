// HTTP + WebSocket/SSE + REST. Serves public/ and implements the contract at the bottom of src/shared/types.ts:
//   WS /api/ws and GET /api/events (SSE fallback): snapshot, ev, stats · GET /api/config · GET /api/state · GET /api/report.md
//   GET /api/mapa · POST /api/dosije · /api/mapa · /api/odgovor · /api/trag · /api/zavrsi · GET /api/health (no session)
// The live stream goes over a WebSocket: a browser keeps at most six HTTP/1.1 connections per server, and SSE streams of a
// few open tabs used to take all six, so every other request (start a case, the state) waited forever.
//
// Every visitor (the dosije_sid cookie) has a session of their own: a complete engine in its own worker thread
// (src/session/). This thread only routes requests and the live stream; it never runs agents itself.

import crypto from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { WebSocketServer, type WebSocket } from "ws"
import { applyEntryDefaults, config, editorModelLabel, modelLabel } from "./config"
import { availableProviders } from "./data/sources/news"
import { logError } from "./mozaik/util"
import { RequestError, SessionPool, type LiveClient, type Session } from "./session/sessions"
import { asLang, messageIn } from "./shared/lang"
import type { DosijeReport } from "./shared/types"

applyEntryDefaults("server")

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public")

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
	".woff": "font/woff",
	".txt": "text/plain; charset=utf-8",
	".md": "text/markdown; charset=utf-8",
	".map": "application/json; charset=utf-8",
}

const pool = new SessionPool()

// ─── the visitor's session ───────────────────────────────────────────────────────────────────────────

const SID_COOKIE = "dosije_sid"
const SID_RE = new RegExp(`(?:^|;\\s*)${SID_COOKIE}=([A-Za-z0-9_-]{32})(?:;|$)`)

/** The visitor's session id from the cookie, or a new one (192 random bits) that the response sets. */
function visitor(req: http.IncomingMessage): { sid: string; cookie?: string } {
	const sid = SID_RE.exec(req.headers.cookie ?? "")?.[1]
	if (sid) return { sid }
	const fresh = crypto.randomBytes(24).toString("base64url")
	return { sid: fresh, cookie: `${SID_COOKIE}=${fresh}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 3600}` }
}

const full = () => `Server je pun: svih ${config.sessions.max} mesta za istovremeno korišćenje je zauzeto. Pokušajte ponovo za minut.`

function claim(sid: string): Session {
	const session = pool.claim(sid)
	if (!session) throw new RequestError(503, full())
	return session
}

// ─── live stream ─────────────────────────────────────────────────────────────────────────────────────

const WS_PING_MS = 20_000
const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 })
// a visitor whose first request is the WebSocket gets the cookie in the handshake
const handshakeCookies = new WeakMap<http.IncomingMessage, string>()
wss.on("headers", (headers, req) => {
	const cookie = handshakeCookies.get(req)
	if (cookie) headers.push(`Set-Cookie: ${cookie}`)
})

function onWebSocket(ws: WebSocket, session: Session): void {
	let closed = false
	const c: LiveClient = {
		send(event, json) {
			if (ws.readyState === ws.OPEN) ws.send(`{"e":${JSON.stringify(event)},"d":${json}}`)
		},
		// the replay goes as one message: thousands of small frames would only slow the first paint
		replay: (events) => c.send("evs", `[${events.join(",")}]`),
		close: () => ws.close(1001, "session closed"),
		isClosed: () => closed,
	}
	let alive = true
	ws.on("pong", () => (alive = true))
	// a page that stopped answering (sleeping laptop, killed tab) is dropped
	const ping = setInterval(() => {
		if (!alive) return ws.terminate()
		alive = false
		ws.ping()
	}, WS_PING_MS)
	ws.on("close", () => {
		closed = true
		clearInterval(ping)
		session.detach(c)
	})
	ws.on("error", () => ws.terminate())
	session.attach(c).catch(() => ws.close(1011, "session unavailable"))
}

function sseClient(req: http.IncomingMessage, res: http.ServerResponse, session: Session): void {
	res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store, no-transform", connection: "keep-alive", "x-accel-buffering": "no" })
	res.write("retry: 1500\n\n")
	let closed = false
	const write = (frames: string) => {
		try {
			res.write(frames)
		} catch {
			// the close handler detaches it
		}
	}
	const c: LiveClient = {
		send: (event, json) => write(`event: ${event}\ndata: ${json}\n\n`),
		replay: (events) => write(events.map((ev) => `event: ev\ndata: ${ev}\n\n`).join("")),
		close: () => res.end(),
		isClosed: () => closed,
	}
	const heartbeat = setInterval(() => {
		try {
			res.write(": ping\n\n")
		} catch {
			clearInterval(heartbeat)
		}
	}, 15_000)
	req.on("close", () => {
		closed = true
		clearInterval(heartbeat)
		session.detach(c)
	})
	session.attach(c).catch(() => res.end())
}

// ─── REST ────────────────────────────────────────────────────────────────────────────────────────────

function json(res: http.ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
	res.end(JSON.stringify(body))
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = []
	let size = 0
	for await (const ch of req) {
		size += (ch as Buffer).length
		if (size > 1_000_000) throw new RequestError(413, "Zahtev je prevelik.")
		chunks.push(ch as Buffer)
	}
	try {
		const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")
		return parsed && typeof parsed === "object" ? parsed : {}
	} catch {
		throw new RequestError(400, "Telo zahteva nije ispravan JSON.")
	}
}

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, pathname: string, sid: string): Promise<boolean> {
	const method = req.method ?? "GET"
	if (method === "GET") {
		if (pathname === "/api/health") return json(res, 200, { ok: true, ...pool.status(), rssMb: Math.round(process.memoryUsage().rss / 2 ** 20) }), true
		if (pathname === "/api/config") return json(res, 200, await claim(sid).call("config")), true
		if (pathname === "/api/state") return json(res, 200, await claim(sid).call("state")), true
		if (pathname === "/api/mapa") return json(res, 200, await claim(sid).call("mapa")), true
		if (pathname === "/api/report.md") {
			const report = await claim(sid).call<DosijeReport | null>("report")
			if (!report) {
				res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
				res.end("Izveštaj još nije spreman.")
				return true
			}
			// the report is written in the language the case was started in
			res.writeHead(200, { "content-type": "text/markdown; charset=utf-8", "content-disposition": `attachment; filename="dosije-${report.caseId}.md"`, "cache-control": "no-store" })
			res.end(report.markdown)
			return true
		}
		if (pathname === "/api/events") return sseClient(req, res, claim(sid)), true
		return false
	}
	if (method !== "POST" || !pathname.startsWith("/api/")) return false

	const body = await readBody(req)
	if (pathname === "/api/dosije") {
		const input = String(body.input ?? "").trim()
		if (!input) throw new RequestError(400, "Upišite naziv institucije.")
		const focus = typeof body.focus === "string" ? body.focus.trim().slice(0, 200) : undefined
		try {
			return json(res, 200, await claim(sid).call("startCase", { input: input.slice(0, 400), focus, lang: asLang(body.lang) })), true
		} catch (err) {
			if (err instanceof RequestError) throw err
			throw new RequestError(422, (err as Error).message)
		}
	}
	if (pathname === "/api/mapa") return json(res, 200, await claim(sid).call("startMapa", { institutions: body.institutions, lang: asLang(body.lang) })), true
	if (pathname === "/api/odgovor") return await claim(sid).call("answer", body), json(res, 200, { ok: true }), true
	if (pathname === "/api/trag") return await claim(sid).call("lead", body), json(res, 200, { ok: true }), true
	if (pathname === "/api/zavrsi") return await claim(sid).call("finish"), json(res, 200, { ok: true }), true
	return false
}

// ─── static files ────────────────────────────────────────────────────────────────────────────────────

/** The start page when every place is taken: says so in both languages and checks again on its own. */
function fullPage(res: http.ServerResponse): void {
	res.writeHead(503, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "retry-after": "20" })
	res.end(`<!doctype html><html lang="sr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="20"><title>Dosije · server je pun</title>
<style>body{font:16px/1.5 system-ui,sans-serif;background:#f6f4ef;color:#1d1b16;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}
main{max-width:34rem}h1{font-size:1.4rem;margin:0 0 .5rem}p{margin:.4rem 0}.en{color:#5c574c}
@media (prefers-color-scheme:dark){body{background:#17160f;color:#eeeae0}.en{color:#a8a294}}</style></head>
<body><main><h1>Dosije je trenutno pun</h1>
<p>Svih ${config.sessions.max} mesta za istovremeno korišćenje je zauzeto. Stranica će se sama osvežiti za 20 sekundi.</p>
<p class="en">Dosije is full right now: all ${config.sessions.max} places are taken. This page reloads by itself in 20 seconds.</p></main></body></html>`)
}

function serveStatic(res: http.ServerResponse, pathname: string): void {
	let rel: string
	try {
		rel = decodeURIComponent(pathname)
	} catch {
		res.writeHead(400).end("Bad request")
		return
	}
	if (rel.endsWith("/")) rel += "index.html"
	const file = path.normalize(path.join(PUBLIC_DIR, rel))
	if (!file.startsWith(PUBLIC_DIR)) {
		res.writeHead(403).end("Forbidden")
		return
	}
	fs.stat(file, (err, stat) => {
		if (err || !stat.isFile()) {
			res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
			res.end("Nije pronađeno.")
			return
		}
		res.writeHead(200, { "content-type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-cache" })
		fs.createReadStream(file).pipe(res)
	})
}

const server = http.createServer((req, res) => {
	const url = new URL(req.url ?? "/", "http://localhost")
	// messages to the browser in the language of its interface (the X-Lang header)
	const lang = asLang(req.headers["x-lang"])
	const { sid, cookie } = visitor(req)
	if (cookie) res.setHeader("set-cookie", cookie)
	handleApi(req, res, url.pathname, sid)
		.then((handled) => {
			if (handled) return
			if (url.pathname.startsWith("/api/")) return json(res, 404, { error: messageIn(lang, "Nepoznata ruta.") })
			if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: messageIn(lang, "Metod nije dozvoljen.") })
			// a new visitor learns at the door that every place is taken, not after the page has loaded
			if ((url.pathname === "/" || url.pathname === "/index.html") && !pool.get(sid) && !pool.hasRoom()) return fullPage(res)
			serveStatic(res, url.pathname)
		})
		.catch((err) => {
			if (err instanceof RequestError) return json(res, err.status, { error: messageIn(lang, err.message) })
			logError("http", err)
			if (!res.headersSent) json(res, 500, { error: messageIn(lang, "Interna greška servera.") })
		})
})

server.on("upgrade", (req, socket, head) => {
	const url = new URL(req.url ?? "/", "http://localhost")
	if (url.pathname !== "/api/ws") return socket.destroy()
	const { sid, cookie } = visitor(req)
	const session = pool.claim(sid)
	// full: the page keeps retrying (and falls back to SSE, which gets the same answer) until a place frees up
	if (!session) return socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
	if (cookie) handshakeCookies.set(req, cookie)
	wss.handleUpgrade(req, socket, head, (ws) => onWebSocket(ws, session))
})

function main(): void {
	pool.start()
	server.on("error", (err: NodeJS.ErrnoException) => {
		if (err.code === "EADDRINUSE") console.error(`\nPort ${config.port} je zauzet. Pokreni sa drugim: PORT=3001 npm run start (PowerShell: $env:PORT=3001; npm.cmd start)\n`)
		else logError("server", err)
		process.exit(1)
	})
	server.listen(config.port, () => {
		const llm = config.mode === "llm"
		const providers = availableProviders().join(", ") || "nema"
		const { max, warm, memoryMb } = config.sessions
		console.log("")
		console.log("  ┌────────────────────────────────────────────────────────────┐")
		console.log("  │  DOSIJE · tim Mozaik agenata pravi dosije o instituciji     │")
		console.log("  └────────────────────────────────────────────────────────────┘")
		console.log(`  Otvori:   http://localhost:${config.port}`)
		console.log(`  Režim:    ${llm ? `LLM · ${config.provider} · ${modelLabel()} (urednik ${editorModelLabel()}, reasoning ${config.reasoning ?? "-"}, do ${config.llmConcurrency} paralelnih poziva po sesiji, ${config.shared.llmConcurrency} ukupno)` : "bez ključa · skriptovani agenti (isti Mozaik runtime, alati i interceptor; model je zamenjen skriptom)"}`)
		console.log(`  Sesije:   do ${max} posetilaca istovremeno, svaki sa svojim engineom u svom workeru (do ${memoryMb} MB; ${warm} spremno unapred)`)
		console.log(`  Podaci:   ${config.dataMode === "cache" ? "samo keš (DATA_MODE=cache)" : config.dataMode === "live" ? "uvek uživo (DATA_MODE=live)" : "keš pa uživo (DATA_MODE=auto)"}`)
		console.log(`  Vesti:    ${providers}`)
		console.log(config.approvals ? `  Odluka:   novinar odlučuje o osetljivim signalima do ${Math.round(config.humanAutoApproveMs / 1000)} s${config.approvalTimeoutAction === "approve" ? " (zatim se automatski odobravaju)" : " (zatim ističu)"}` : "  Odluka:   bez čekanja na korisnika: signal ulazi sa svojim izvorima (zvanično ili nepotvrđeno)")
		console.log("")
	})
}

function stop(): void {
	console.log("\nGasim server…")
	pool.shutdown()
	wss.close()
	const force = setTimeout(() => process.exit(0), 2000)
	force.unref?.()
	server.close(() => process.exit(0))
	server.closeAllConnections?.()
}

process.on("SIGINT", stop)
process.on("SIGTERM", stop)

try {
	main()
} catch (err) {
	logError("start", err)
	process.exit(1)
}
