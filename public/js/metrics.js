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
let partEls = []
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
	// parts: [text, class, quiet]; the clock and the event counter tick all the time, so they stay out of the live region
	const parts = [...v.lead.map((t, i) => [t, i === 0 ? "state" : "", i === 1]), ...v.nodes.map((n) => [n.t, n.cls, false]), [v.tail, "", true]]
	const shape = parts.map((p) => `${p[1]}|${p[2]}`).join(",")
	if (shape !== lastMain) {
		lastMain = shape
		const out = []
		partEls = parts.map((p, i) => {
			const el = h("span", { class: p[1] || null, "aria-hidden": p[2] ? "true" : null })
			if (i) out.push(h("span", { class: "sep", "aria-hidden": "true" }, " · "))
			out.push(el)
			return el
		})
		main.replaceChildren(...out)
	}
	// update in place: only a changed text is announced, not the whole line
	parts.forEach((p, i) => {
		if (partEls[i].textContent !== p[0]) partEls[i].textContent = p[0]
	})
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
