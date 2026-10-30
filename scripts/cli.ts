// Headless run: npm run cli -- "Infrastruktura železnice Srbije" [--focus "..."] [--owner "Petar Petrović"] [--pretraga]
// --pretraga also prints every public-source request of the agents (live search, "izvor.upit") as one compact line.
// Prints compact live log lines, then an ASCII Gantt per agent (shows the agents really ran at the same time) and stats,
// and writes out/dosije-<slug>.md. --owner answers the first owner question automatically (shows the Provera cascade).

import fs from "node:fs"
import path from "node:path"
import { applyEntryDefaults, config } from "../src/config"
import type { WireEvent } from "../src/shared/types"
import { gantt } from "./lib/gantt"

applyEntryDefaults("cli")

const args = process.argv.slice(2)
function flag(name: string): string | undefined {
	const i = args.indexOf(`--${name}`)
	if (i < 0) return undefined
	const v = args[i + 1]
	args.splice(i, 2)
	return v
}
const showSearch = args.includes("--pretraga")
if (showSearch) args.splice(args.indexOf("--pretraga"), 1)
const focus = flag("focus")
const owner = flag("owner")
const input = args.join(" ").trim() || "Infrastruktura železnice Srbije"

const { boot, startCase, waitForDone, getSnapshot, submitAnswer, caseSlug, shutdown } = await import("../src/mozaik/boot")
const { bus } = await import("../src/mozaik/bus")

const t0Holder = { t0: 0 }
const hhmmss = (t: number) => new Date(t).toISOString().slice(11, 23)
const rel = (t: number) => `+${((t - t0Holder.t0) / 1000).toFixed(1).padStart(5)}s`

const events: WireEvent[] = []
const C = { dim: "\x1b[2m", reset: "\x1b[0m", cyan: "\x1b[36m", violet: "\x1b[35m", green: "\x1b[32m", amber: "\x1b[33m", red: "\x1b[31m", bold: "\x1b[1m" }
const color = process.stdout.isTTY ? C : (Object.fromEntries(Object.keys(C).map((k) => [k, ""])) as typeof C)

function short(v: unknown, n = 60): string {
	const s = typeof v === "string" ? v : JSON.stringify(v)
	return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

function line(ev: WireEvent): string | undefined {
	const p = ev.payload as Record<string, any>
	const who = ev.producerName.padEnd(26).slice(0, 26)
	const head = `${color.dim}${rel(ev.t)}${color.reset} ${who}`
	switch (ev.type) {
		case "participant.joined":
			return p.info?.dynamic ? `${head} ${color.green}◆ pokrenut${color.reset} (${p.info.description})` : undefined
		case "participant.left":
			return p.info?.dynamic ? `${head} ${color.dim}← završio${color.reset}` : undefined
		case "function_call.started":
			return `${head} ${color.cyan}alat${color.reset} ${p.name} ${color.dim}${short(p.args, 70)}${color.reset}`
		case "entity.added":
			return `${head} ${color.green}entitet${color.reset} ${p.entity.kind}/${p.entity.role}: ${short(p.entity.name, 50)}`
		case "finding.added":
			return `${head} ${p.finding.severity === "signal" ? color.red : p.finding.severity === "paznja" ? color.amber : ""}nalaz${color.reset} [${p.finding.section}/${p.finding.status}] ${short(p.finding.title, 78)}`
		case "finding.updated":
			return `${head} ${color.violet}urednik: ${p.reason}${color.reset} ${short(p.finding.title, 70)}`
		case "conflict.resolved":
			return `${head} ${color.violet}⚖ konflikt${color.reset} ${p.conflict.subject}: „${p.conflict.values[0]}“ vs „${p.conflict.values[1]}“ (${p.conflict.rule})`
		case "claim.blocked":
			return `${head} ${color.red}✖ blokirano${color.reset} ${short(p.title, 60)}: ${short(p.reason, 70)}`
		case "pitanje.za_coveka":
			return `${head} ${color.amber}${p.task.blocking ? "⏸ čeka novinara" : "? pitanje"}${color.reset} ${short(p.task.question, 90)}`
		case "task.updated":
			return `${head} zadatak ${p.task.id} → ${p.task.status}`
		case "dosije.started":
			return `${head} ${color.bold}dosije.started${color.reset} ${p.institution.name}`
		case "dosije.zatvori":
			return `${head} dosije.zatvori`
		case "dosije.zavrsen":
			return `${head} ${color.bold}${color.green}dosije.zavrsen${color.reset}`
		case "model.answer":
			return `${head} ${color.dim}završio petlju: ${short(p.text, 90)}${color.reset}`
		case "izvor.upit": {
			if (!showSearch || p.status === "u_toku") return undefined
			const secs = typeof p.ms === "number" ? ` ${(p.ms / 1000).toFixed(1).replace(".", ",")} s` : ""
			const items = typeof p.items === "number" ? ` · ${p.items}` : ""
			const state =
				p.status === "greska" ? `${color.red}greška: ${short(p.error ?? "", 50)}${color.reset}` : p.status === "kes" ? `${color.amber}keš${secs}${color.reset}${items}` : `${color.green}ok${secs}${color.reset}${items}`
			return `${color.dim}${rel(ev.t)}${color.reset} ${color.cyan}izvor${color.reset}  ${String(p.agentName).padEnd(22).slice(0, 22)} ${p.source} · ${short(p.label, 70)} · ${state}`
		}
		default:
			return undefined
	}
}

bus.onWire((ev) => {
	events.push(ev)
	if (!t0Holder.t0 && ev.type === "dosije.started") t0Holder.t0 = ev.t
	const l = t0Holder.t0 ? line(ev) : undefined
	if (l) console.log(l)
	if (owner && ev.type === "pitanje.za_coveka") {
		const task = (ev.payload as { task: { id: string; kind: string; fromAgentName: string } }).task
		if (task.kind === "pitanje" && !answered) {
			answered = true
			setTimeout(() => {
				try {
					submitAnswer({ taskId: task.id, answer: owner })
					console.log(`${color.amber}  → novinar odgovara: „${owner}“${color.reset}`)
				} catch (err) {
					console.log(`  odgovor nije prihvaćen: ${(err as Error).message}`)
				}
			}, 1200)
		}
	}
})
let answered = false

// ─── run ─────────────────────────────────────────────────────────────────────

console.log(`${color.bold}Dosije${color.reset} · režim ${config.mode}${config.mode === "llm" ? ` (${config.model})` : " (skriptovani agenti)"} · podaci ${config.dataMode} · DEMO_SPEED ${config.demoSpeed}`)
await boot()
try {
	const { caseId } = await startCase(input, focus)
	console.log(`${color.dim}slučaj ${caseId}${color.reset}\n`)
} catch (err) {
	console.error(`Greška: ${(err as Error).message}`)
	await shutdown()
	process.exit(1)
}
const report = await waitForDone(config.mode === "llm" ? 900_000 : 300_000)
const snap = getSnapshot()
if (!report) {
	console.error("Dosije nije završen na vreme.")
	await shutdown()
	process.exit(2)
}

const start = events.find((e) => e.type === "dosije.started")?.t ?? events[0]?.t ?? Date.now()
const end = events.at(-1)?.t ?? Date.now()
console.log(`\n${color.bold}Gantt${color.reset} (${color.violet}~${color.reset} zaključivanje, ${color.cyan}#${color.reset} alat, ${color.amber}!${color.reset} čeka novinara, . pauza)`)
for (const row of gantt(events, start, end)) console.log(row)

const s = snap.stats
const agents = snap.agents.filter((a) => a.group !== "novinar" && a.group !== "sistem")
console.log(`\n${color.bold}Statistika${color.reset}`)
console.log(`  vrhunac istovremenih petlji: ${color.bold}${s.peakConcurrentLoops}${color.reset} · petlji ukupno: ${s.totalLoops} · agenata: ${agents.length} (pokrenutih: ${agents.filter((a) => a.dynamic).length})`)
console.log(`  pozivi alata: ${s.toolCalls} · zaključivanja: ${s.inferences} · interceptor: ${s.interceptions} · blokirano bez izvora: ${s.blockedClaims} · konflikata: ${s.conflicts}`)
console.log(`  nalaza: ${snap.findings.length} (signala: ${snap.findings.filter((f) => f.severity === "signal").length}) · entiteta: ${snap.entities.length} · zadataka: ${snap.tasks.length} · Mozaik događaja: ${s.events}`)
if (showSearch) console.log(`  izvori: ${s.activities ?? 0} upita${s.activitiesDropped ? ` (+${s.activitiesDropped} preko ograničenja, nisu prikazani)` : ""}`)
console.log(`  trajanje: ${(s.elapsedMs / 1000).toFixed(1)} s`)

const outDir = path.resolve(process.cwd(), "out")
fs.mkdirSync(outDir, { recursive: true })
const file = path.join(outDir, `dosije-${caseSlug()}.md`)
fs.writeFileSync(file, report.markdown, "utf8")
console.log(`\nIzveštaj: ${file}\nTrag događaja: ${path.join(outDir, `trace-${snap.caseId}.jsonl`)}`)
await shutdown()
process.exit(0)
