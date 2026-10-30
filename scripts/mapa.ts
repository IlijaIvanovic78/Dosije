// Headless "Mapa prioriteta": npm run mapa -- ["Institucija 1" "Institucija 2" ...]   (default: data/static/mapa-preset.json)
// Prints a compact live log (one "Trijaža · <institucija>" agent per institution, all at the same time), the final ranking
// "gde prvo gledati" and the ASCII Gantt of the agents (overlapping rows = real concurrency).

import { applyEntryDefaults, config } from "../src/config"
import { n } from "../src/shared/plural"
import type { MapaRow, WireEvent } from "../src/shared/types"
import { gantt } from "./lib/gantt"

applyEntryDefaults("cli")

const names = process.argv.slice(2).filter((a) => !a.startsWith("--"))

const { boot, startMapa, waitForMapa, getSnapshot, shutdown } = await import("../src/mozaik/boot")
const { bus } = await import("../src/mozaik/bus")
const { signalChips, PRIORITY_MAX } = await import("../src/data/analysis/priority")

const C = { dim: "\x1b[2m", reset: "\x1b[0m", cyan: "\x1b[36m", violet: "\x1b[35m", green: "\x1b[32m", amber: "\x1b[33m", red: "\x1b[31m", bold: "\x1b[1m" }
const color = process.stdout.isTTY ? C : (Object.fromEntries(Object.keys(C).map((k) => [k, ""])) as typeof C)

const t0 = { v: 0 }
const rel = (t: number) => `+${((t - t0.v) / 1000).toFixed(1).padStart(5)}s`
const events: WireEvent[] = []
const lastStatus = new Map<string, string>()

function short(v: unknown, n = 60): string {
	const s = typeof v === "string" ? v : JSON.stringify(v)
	return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

function line(ev: WireEvent): string | undefined {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const p = ev.payload as Record<string, any>
	const who = ev.producerName.padEnd(30).slice(0, 30)
	const head = `${color.dim}${rel(ev.t)}${color.reset} ${who}`
	switch (ev.type) {
		case "mapa.started":
			return `${head} ${color.bold}mapa.started${color.reset} ${p.institutions.map((i: { name: string }) => i.name).join(", ")}`
		case "participant.joined":
			return p.info?.group === "trijaza" ? `${head} ${color.green}◆ pokrenut${color.reset} (${p.info.description})` : undefined
		case "function_call.started":
			return ev.producerName.startsWith("Trijaža") ? `${head} ${color.cyan}alat${color.reset} ${p.name} ${color.dim}${short(p.args, 60)}${color.reset}` : undefined
		case "mapa.red": {
			const row = p.row as MapaRow
			const key = `${row.status}:${row.score}`
			if (lastStatus.get(row.slug) === key) return undefined
			lastStatus.set(row.slug, key)
			const st = row.status === "done" ? `${color.green}gotovo${color.reset}` : row.status === "error" ? `${color.red}greška${color.reset}` : row.status === "running" ? `${color.violet}radi…${color.reset}` : "čeka"
			return `${head} ${color.bold}red${color.reset} ${row.name.padEnd(32).slice(0, 32)} ${st} ocena ${String(row.score).padStart(3)} ${color.dim}${signalChips(row.signals).join(" · ")}${color.reset}`
		}
		case "mapa.veza":
			return `${head} ${color.violet}↔ mapa.veza${color.reset} ${p.veza.line} ${color.dim}(${p.veza.institutions.map((i: { name: string; rank: number }) => `${i.name} #${i.rank}`).join(", ")}; +${p.veza.points} za svaku)${color.reset}`
		case "mapa.zavrsena":
			return `${head} ${color.bold}${color.green}mapa.zavrsena${color.reset}`
		case "model.answer":
			return ev.producerName.startsWith("Trijaža") ? `${head} ${color.dim}završio: ${short(p.text, 70)}${color.reset}` : undefined
		default:
			return undefined
	}
}

bus.onWire((ev) => {
	events.push(ev)
	if (!t0.v && ev.type === "mapa.started") t0.v = ev.t
	const l = t0.v ? line(ev) : undefined
	if (l) console.log(l)
})

function table(rows: MapaRow[]): string[] {
	const out: string[] = []
	const max = Math.max(PRIORITY_MAX, ...rows.map((r) => r.score))
	out.push(`${"#".padStart(2)}  ${"Institucija".padEnd(34)} ${"ocena".padStart(5)}  ${"".padEnd(20)}  signali`)
	rows.forEach((r, i) => {
		const bar = "█".repeat(Math.round((r.score / max) * 20)).padEnd(20, "·")
		const chips = r.status === "error" ? `greška: ${r.error ?? ""}` : signalChips(r.signals).join(" · ")
		out.push(`${String(i + 1).padStart(2)}  ${r.name.padEnd(34).slice(0, 34)} ${String(r.score).padStart(5)}  ${bar}  ${chips}`)
		// the cross-institution lines ("Isti dobavljač u N institucije: ...") are always shown
		const shared = r.reasons.filter((x) => x.startsWith("Isti dobavljač"))
		for (const reason of [...r.reasons.filter((x) => !x.startsWith("Isti dobavljač")).slice(0, 4), ...shared]) out.push(`${"".padEnd(4)}${color.dim}- ${reason}${color.reset}`)
		if (r.summary) out.push(`${"".padEnd(4)}${color.dim}${short(r.summary, 150)}${color.reset}`)
	})
	return out
}

console.log(`${color.bold}Mapa prioriteta${color.reset} · režim ${config.mode}${config.mode === "llm" ? ` (${config.model})` : " (skriptovani agenti)"} · podaci ${config.dataMode} · DEMO_SPEED ${config.demoSpeed}`)
await boot()
try {
	const { mapaId, institutions } = await startMapa(names.length ? names : undefined)
	console.log(`${color.dim}mapa ${mapaId}: ${n(institutions.length, "institucija")}, jedan agent „Trijaža“ po instituciji${color.reset}\n`)
} catch (err) {
	console.error(`Greška: ${(err as Error).message}`)
	await shutdown()
	process.exit(1)
}

const view = await waitForMapa(config.mode === "llm" ? 900_000 : 600_000)
const snap = getSnapshot()
if (view.status !== "done") {
	console.error("Mapa nije završena na vreme.")
	await shutdown()
	process.exit(2)
}

console.log(`\n${color.bold}Gde prvo gledati${color.reset} (ocena je kod, ne mišljenje; signali za proveru, ne zaključci)`)
for (const l of table(view.rows)) console.log(l)

const start = events.find((e) => e.type === "mapa.started")?.t ?? events[0]?.t ?? Date.now()
const end = events.at(-1)?.t ?? Date.now()
console.log(`\n${color.bold}Gantt${color.reset} (${color.violet}~${color.reset} zaključivanje, ${color.cyan}#${color.reset} alat, . pauza)`)
for (const row of gantt(events, start, end, ["Trijaža"], [])) console.log(row)

const s = snap.stats
const agents = snap.agents.filter((a) => a.group === "trijaza")
console.log(`\n${color.bold}Statistika${color.reset}`)
console.log(`  vrhunac: ${color.bold}${n(s.peakConcurrentLoops, "petlja")}${color.reset} istovremeno · petlji ukupno: ${s.totalLoops} · ${n(agents.length, "agent")} Trijaža`)
console.log(`  pozivi alata: ${s.toolCalls} · zaključivanja: ${s.inferences} · Mozaik događaja: ${s.events} · trajanje: ${(s.elapsedMs / 1000).toFixed(1)} s`)
console.log(`  institucija: ${view.rows.length} (gotovo ${view.rows.filter((r) => r.status === "done").length}, greška ${view.rows.filter((r) => r.status === "error").length})`)
console.log(`  veze među institucijama (isti dobavljač): ${events.filter((e) => e.type === "mapa.veza").length}`)
console.log(`\nTrag događaja: out/trace-${view.id}.jsonl`)
await shutdown()
process.exit(0)
