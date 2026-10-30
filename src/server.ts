// HTTP + SSE + REST (node:http only). Serves public/ and implements the contract at the bottom of src/shared/types.ts:
//   GET /api/events (SSE: snapshot, ev, stats) · GET /api/config · GET /api/state · GET /api/report.md
//   POST /api/dosije · /api/odgovor · /api/trag · /api/zavrsi

import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { applyEntryDefaults, config, editorModelLabel, modelLabel } from "./config"
import { ApiError, addLead, boot, closeCase, configView, getReport, getSnapshot, shutdown, startCase, submitAnswer } from "./mozaik/boot"
import { bus } from "./mozaik/bus"
import { S } from "./mozaik/domain"
import { logError } from "./mozaik/util"
import type { WireEvent } from "./shared/types"

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

const clients = new Set<http.ServerResponse>()

// Events of the current case, replayed after the snapshot on (re)connect so a page reload rebuilds the live Gantt.
const HISTORY_MAX = 8000
let history: WireEvent[] = []

function sse(res: http.ServerResponse, event: string, data: unknown): void {
	try {
		res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
	} catch {
		clients.delete(res)
	}
}

function broadcast(event: string, data: unknown): void {
	for (const res of clients) sse(res, event, data)
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
	res.end(JSON.stringify(body))
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = []
	let size = 0
	for await (const ch of req) {
		size += (ch as Buffer).length
		if (size > 1_000_000) throw new ApiError(413, "Zahtev je prevelik.")
		chunks.push(ch as Buffer)
	}
	try {
		const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")
		return parsed && typeof parsed === "object" ? parsed : {}
	} catch {
		throw new ApiError(400, "Telo zahteva nije ispravan JSON.")
	}
}

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<boolean> {
	const method = req.method ?? "GET"
	if (method === "GET") {
		if (pathname === "/api/config") return json(res, 200, configView()), true
		if (pathname === "/api/state") return json(res, 200, getSnapshot()), true
		if (pathname === "/api/report.md") {
			const report = getReport()
			if (!report) {
				res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
				res.end("Izveštaj još nije spreman.")
				return true
			}
			res.writeHead(200, { "content-type": "text/markdown; charset=utf-8", "content-disposition": `attachment; filename="dosije-${report.caseId}.md"`, "cache-control": "no-store" })
			res.end(report.markdown)
			return true
		}
		if (pathname === "/api/events") {
			res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store, no-transform", connection: "keep-alive", "x-accel-buffering": "no" })
			res.write("retry: 1500\n\n")
			sse(res, "snapshot", getSnapshot())
			for (const ev of history) sse(res, "ev", ev)
			clients.add(res)
			const heartbeat = setInterval(() => {
				try {
					res.write(": ping\n\n")
				} catch {
					clearInterval(heartbeat)
				}
			}, 15_000)
			req.on("close", () => {
				clearInterval(heartbeat)
				clients.delete(res)
			})
			return true
		}
		return false
	}
	if (method !== "POST" || !pathname.startsWith("/api/")) return false

	const body = await readBody(req)
	if (pathname === "/api/dosije") {
		const input = String(body.input ?? "").trim()
		if (!input) throw new ApiError(400, "Upiši instituciju ili link vesti.")
		try {
			const { caseId } = await startCase(input.slice(0, 400), typeof body.focus === "string" ? body.focus.trim().slice(0, 200) : undefined)
			return json(res, 200, { caseId }), true
		} catch (err) {
			if (err instanceof ApiError) throw err
			throw new ApiError(422, (err as Error).message)
		}
	}
	if (pathname === "/api/odgovor") return submitAnswer(body), json(res, 200, { ok: true }), true
	if (pathname === "/api/trag") return addLead(body), json(res, 200, { ok: true }), true
	if (pathname === "/api/zavrsi") return closeCase(), json(res, 200, { ok: true }), true
	return false
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
	handleApi(req, res, url.pathname)
		.then((handled) => {
			if (handled) return
			if (url.pathname.startsWith("/api/")) return json(res, 404, { error: "Nepoznata ruta." })
			if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "Metod nije dozvoljen." })
			serveStatic(res, url.pathname)
		})
		.catch((err) => {
			if (err instanceof ApiError) return json(res, err.status, { error: err.message })
			logError("http", err)
			if (!res.headersSent) json(res, 500, { error: "Interna greška servera." })
		})
})

bus.onWire((ev) => {
	if (ev.type === "dosije.started") history = []
	history.push(ev)
	if (history.length > HISTORY_MAX) history.splice(0, history.length - HISTORY_MAX)
	broadcast("ev", ev)
})
bus.onSnapshot((snap) => broadcast("snapshot", snap))

const statsTimer = setInterval(() => {
	if (clients.size === 0) return
	try {
		const state = S()
		if (state.status === "running" || state.status === "finalizing") broadcast("stats", { stats: state.refreshStats(), budget: state.budget })
	} catch {
		// runtime not ready yet
	}
}, 1000)
statsTimer.unref?.()
bus.onStats(({ stats, budget }) => broadcast("stats", { stats, budget }))

async function main(): Promise<void> {
	await boot()
	server.on("error", (err: NodeJS.ErrnoException) => {
		if (err.code === "EADDRINUSE") console.error(`\nPort ${config.port} je zauzet. Pokreni sa drugim: PORT=3001 npm run start (PowerShell: $env:PORT=3001; npm.cmd start)\n`)
		else logError("server", err)
		process.exit(1)
	})
	server.listen(config.port, () => {
		const llm = config.mode === "llm"
		const providers = configView().searchProviders.join(", ") || "nema"
		console.log("")
		console.log("  ┌────────────────────────────────────────────────────────────┐")
		console.log("  │  DOSIJE · tim Mozaik agenata pravi dosije o instituciji     │")
		console.log("  └────────────────────────────────────────────────────────────┘")
		console.log(`  Otvori:   http://localhost:${config.port}`)
		console.log(`  Režim:    ${llm ? `LLM · ${config.provider} · ${modelLabel()} (urednik ${editorModelLabel()}, reasoning ${config.reasoning ?? "-"}, do ${config.llmConcurrency} paralelnih poziva)` : "bez ključa · skriptovani agenti (isti Mozaik runtime, alati i interceptor; model je zamenjen skriptom)"}`)
		console.log(`  Podaci:   ${config.dataMode === "cache" ? "samo keš (DATA_MODE=cache)" : config.dataMode === "live" ? "uvek uživo (DATA_MODE=live)" : "keš pa uživo (DATA_MODE=auto)"}`)
		console.log(`  Vesti:    ${providers}`)
		console.log(`  Odluka:   novinar odlučuje o osetljivim signalima do ${Math.round(config.humanAutoApproveMs / 1000)} s${config.approvalTimeoutAction === "approve" ? " (zatim se automatski odobravaju)" : " (zatim ističu)"}`)
		console.log("")
	})
}

function stop(): void {
	console.log("\nGasim server…")
	clearInterval(statsTimer)
	for (const res of clients) {
		try {
			res.end()
		} catch {
			// ignore
		}
	}
	clients.clear()
	const force = setTimeout(() => process.exit(0), 2000)
	force.unref?.()
	server.close(() => {
		void shutdown().finally(() => process.exit(0))
	})
	server.closeAllConnections?.()
}

process.on("SIGINT", stop)
process.on("SIGTERM", stop)

main().catch((err) => {
	logError("start", err)
	process.exit(1)
})
