// Status line under the top bar: one quiet sentence instead of metric tiles, plus the budget on the right.

import { h, fmtElapsed, fmtNum, createScheduler } from "./format.js"
import { state, on, activeCount, peakCount, openTasks, elapsedMs, runStatus } from "./store.js"

const isMapa = () => state.runKind === "mapa"
const mapaRows = () => [...state.mapa.rows.values()]

/** Serbian plural: pick one / few / many form for n. */
export function plural(n, one, few, many) {
	const a = n % 10
	const b = n % 100
	if (a === 1 && b !== 11) return one
	if (a >= 2 && a <= 4 && !(b >= 12 && b <= 14)) return few
	return many
}

let root, main, budget
let lastMain = ""
let lastBudget = ""

function compute() {
	const st = runStatus()
	const word = { running: "U toku", finalizing: "Završava se", done: "Završeno" }[st] || "Spremno"
	const active = activeCount()
	const peak = peakCount()
	const parts = [word, fmtElapsed(elapsedMs())]
	const nodes = []
	const verb = plural(active, "radi", "rade", "radi")
	parts.push(`${active} ${plural(active, "agent", "agenta", "agenata")} ${verb} istovremeno (vrhunac ${peak})`)
	let right
	if (isMapa()) {
		const rows = mapaRows()
		const done = rows.filter((r) => r.status === "done" || r.status === "error").length
		const over = rows.filter((r) => r.signals?.vdOver).length
		parts.push(`${done}/${rows.length} institucija gotovo`)
		nodes.push({ t: `${over} sa v.d. preko roka`, cls: over ? "sig" : "" })
		const b = state.budget
		right = `petlje ${b?.loops ?? 0}/${b?.maxLoops ?? 0} · alati ${b?.toolCalls ?? 0}/${b?.maxToolCalls ?? 0}`
	} else {
		const signals = [...state.findings.values()].filter((f) => f.severity === "signal").length
		const open = openTasks().length
		const nf = state.findings.size
		parts.push(`${nf} ${plural(nf, "nalaz", "nalaza", "nalaza")}`)
		nodes.push({ t: `${signals} ${plural(signals, "signal", "signala", "signala")}`, cls: signals ? "sig" : "" })
		nodes.push({ t: `${open} ${plural(open, "pitanje", "pitanja", "pitanja")}`, cls: open ? "wait" : "" })
		const b = state.budget
		right = `firme ${b?.firme ?? 0}/${b?.maxFirme ?? 0} · osobe ${b?.osobe ?? 0}/${b?.maxOsobe ?? 0} · alati ${b?.toolCalls ?? 0}/${b?.maxToolCalls ?? 0}`
	}
	const ev = Math.max(state.stats?.events ?? 0, state.eventCount)
	return { lead: parts, nodes, tail: `${fmtNum(ev)} ${plural(ev, "događaj", "događaja", "događaja")}`, right }
}

function update() {
	const v = compute()
	const sig = JSON.stringify([v.lead, v.nodes, v.tail])
	if (sig !== lastMain) {
		lastMain = sig
		const out = []
		const push = (text, cls) => {
			if (out.length) out.push(h("span", { class: "sep" }, " · "))
			out.push(h("span", { class: cls || null }, text))
		}
		v.lead.forEach((t, i) => push(t, i === 0 ? "state" : ""))
		v.nodes.forEach((n) => push(n.t, n.cls))
		push(v.tail)
		main.replaceChildren(...out)
	}
	if (v.right !== lastBudget) {
		lastBudget = v.right
		budget.textContent = v.right
	}
}

export function initMetrics() {
	root = document.getElementById("statusLine")
	main = document.getElementById("slMain")
	budget = document.getElementById("slBudget")
	const schedule = createScheduler(() => {
		root.hidden = document.body.dataset.view === "hero"
		update()
	})
	setInterval(schedule, 500)
	for (const t of ["meta", "snapshot", "finding", "tasks", "mapa", "view"]) on(t, schedule)
	schedule()
}
