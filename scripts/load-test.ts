// Load test against a running server: N visitors at once, each the way a browser is (own cookie, the WebSocket, then a
// dossier). Checks that every visitor finishes their OWN case (no one replaced another's), and prints the time per
// visitor and what /api/health saw (sessions, memory, shared LLM / per-host permits).
//   npm run load -- --url http://localhost:3000 --users 20 [--timeout 600] [--mapa 2]
// --mapa N: the first N visitors start the institution comparison instead of a dossier.

import WebSocket from "ws"

const args = process.argv.slice(2)
const flag = (name: string, fallback: string) => {
	const i = args.indexOf(`--${name}`)
	return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const BASE = flag("url", "http://localhost:3000").replace(/\/$/, "")
const USERS = Number(flag("users", "20"))
const TIMEOUT_MS = Number(flag("timeout", "600")) * 1000
const MAPA = Number(flag("mapa", "0"))

interface Result {
	user: number
	kind: "dosije" | "mapa"
	input: string
	ok: boolean
	ms: number
	events: number
	findings: number
	error?: string
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function visitor(user: number, inputs: string[]): Promise<Result> {
	const kind = user < MAPA ? "mapa" : "dosije"
	const input = kind === "mapa" ? "(preset)" : inputs[user % inputs.length]
	const t0 = Date.now()
	const result: Result = { user, kind, input, ok: false, ms: 0, events: 0, findings: 0 }
	let ws: WebSocket | undefined
	try {
		const home = await fetch(`${BASE}/`)
		if (!home.ok) throw new Error(`početna: HTTP ${home.status}`)
		const cookie = (home.headers.get("set-cookie") ?? "").split(";")[0]
		if (!cookie) throw new Error("server nije dao kolačić")
		const headers = { cookie, "content-type": "application/json" }

		let status = "idle"
		let caseId: string | null = null
		let institution = ""
		let mapaStatus = "idle"
		ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/api/ws`, { headers: { cookie } })
		// the page learns the end of a run from its events, like public/js/store.js
		const onEvent = (ev: { type: string; payload?: any }) => {
			result.events++
			if (ev.type === "finding.added") result.findings++
			if (ev.type === "dosije.zavrsen") status = "done"
			if (ev.type === "mapa.zavrsena") mapaStatus = "done"
		}
		ws.on("message", (raw) => {
			const msg = JSON.parse(String(raw)) as { e: string; d: any }
			if (msg.e === "ev") onEvent(msg.d)
			if (msg.e === "evs") for (const ev of msg.d) onEvent(ev)
			if (msg.e === "snapshot") {
				status = msg.d.status
				caseId = msg.d.caseId
				institution = msg.d.institution?.name ?? ""
				mapaStatus = msg.d.mapa?.status ?? mapaStatus
			}
		})
		await new Promise<void>((resolve, reject) => {
			ws!.once("open", () => resolve())
			ws!.once("error", reject)
			ws!.once("unexpected-response", (_req, res) => reject(new Error(`WebSocket: HTTP ${res.statusCode}`)))
		})

		const body = kind === "mapa" ? { lang: "sr" } : { input, lang: "sr" }
		const started = await fetch(`${BASE}/api/${kind === "mapa" ? "mapa" : "dosije"}`, { method: "POST", headers, body: JSON.stringify(body) })
		const startedBody = (await started.json()) as { caseId?: string; mapaId?: string; error?: string }
		if (!started.ok) throw new Error(`start: HTTP ${started.status} ${startedBody.error ?? ""}`)
		const myId = startedBody.caseId ?? startedBody.mapaId

		const deadline = t0 + TIMEOUT_MS
		for (;;) {
			if (Date.now() > deadline) throw new Error(`nije završeno za ${TIMEOUT_MS / 1000} s (status ${kind === "mapa" ? mapaStatus : status})`)
			if (kind === "dosije" && caseId && caseId !== myId) throw new Error(`tuđi slučaj na stranici: ${caseId} (${institution}), moj je ${myId}`)
			if (kind === "dosije" && status === "done" && caseId === myId) break
			if (kind === "mapa" && mapaStatus === "done") break
			await sleep(500)
		}
		if (kind === "dosije") {
			const report = await fetch(`${BASE}/api/report.md`, { headers })
			const md = await report.text()
			if (!report.ok || md.length < 200) throw new Error(`izveštaj: HTTP ${report.status}, ${md.length} znakova`)
		} else {
			const mapa = (await (await fetch(`${BASE}/api/mapa`, { headers })).json()) as { id: string; rows: unknown[] }
			if (mapa.id !== myId || !mapa.rows.length) throw new Error(`mapa: ${mapa.id} (moja ${myId}), ${mapa.rows.length} redova`)
		}
		result.ok = true
	} catch (err) {
		result.error = (err as Error).message
	} finally {
		ws?.close()
		result.ms = Date.now() - t0
	}
	return result
}

const health: { t: number; sessions: number; rssMb: number; shared: Record<string, { active: number; waiting: number }> }[] = []
const t0 = Date.now()
const poll = setInterval(async () => {
	try {
		const h = (await (await fetch(`${BASE}/api/health`)).json()) as (typeof health)[number]
		health.push({ ...h, t: Date.now() - t0 })
	} catch {
		// the server is busy; the next sample counts
	}
}, 2000)

const config = (await (await fetch(`${BASE}/api/config`)).json()) as { mode: string; demoInstitutions: { name: string }[] }
const inputs = ["Infrastruktura železnice Srbije", ...config.demoInstitutions.map((d) => d.name)]
console.log(`${USERS} posetilaca na ${BASE} (režim ${config.mode}); institucije: ${inputs.join(" · ")}`)

const results = await Promise.all(Array.from({ length: USERS }, (_, i) => sleep(i * 150).then(() => visitor(i, inputs))))
clearInterval(poll)

for (const r of results)
	console.log(`${r.ok ? "OK  " : "GREŠKA"} #${String(r.user).padStart(2)} ${r.kind.padEnd(6)} ${(r.ms / 1000).toFixed(1).padStart(6)} s  ${String(r.events).padStart(5)} događaja  ${String(r.findings).padStart(3)} nalaza  ${r.input}${r.error ? `  → ${r.error}` : ""}`)
const ok = results.filter((r) => r.ok)
const times = ok.map((r) => r.ms).sort((a, b) => a - b)
const peak = health.reduce((m, h) => (h.rssMb > m.rssMb ? h : m), { rssMb: 0, sessions: 0 } as (typeof health)[number])
const peakLlm = Math.max(0, ...health.map((h) => h.shared?.llm?.active ?? 0))
const peakWait = Math.max(0, ...health.map((h) => h.shared?.llm?.waiting ?? 0))
console.log(
	`\n${ok.length}/${USERS} uspešno · medijana ${((times[Math.floor(times.length / 2)] ?? 0) / 1000).toFixed(1)} s, najduže ${((times.at(-1) ?? 0) / 1000).toFixed(1)} s · ` +
		`najviše ${Math.max(0, ...health.map((h) => h.sessions))} sesija, ${peak.rssMb} MB RSS · LLM: najviše ${peakLlm} paralelno, ${peakWait} na čekanju`,
)
process.exit(ok.length === USERS ? 0 : 1)
