// Status line under the top bar: one quiet sentence instead of metric tiles, plus the budget on the right.

import { h, fmtElapsed, fmtNum, createScheduler } from "./format.js"
import { state, on, activeCount, peakCount, openTasks, elapsedMs, runStatus } from "./store.js"
import { t, pl, getLang, onLang } from "./i18n.js"

const isMapa = () => state.runKind === "mapa"
const mapaRows = () => [...state.mapa.rows.values()]

let main, budget
let lastMain = ""
let partEls = []
let lastBudget = ""

function compute() {
	const st = runStatus()
	const done = st === "done"
	const word = { running: t("U toku"), finalizing: t("Završava se"), done: t("Završeno") }[st] || t("Spremno")
	const active = activeCount()
	const peak = peakCount()
	const parts = [word, fmtElapsed(elapsedMs())]
	const nodes = []
	if (done) {
		// nothing is "working" any more: report the peak instead of a live count of zero
		parts.push(getLang() === "en" ? `peak: ${peak} ${pl(peak, [], ["agent", "agents"])} at once` : `vrhunac: ${peak} ${pl(peak, ["agent", "agenta", "agenata"])} istovremeno`)
	} else {
		parts.push(
			getLang() === "en"
				? `${active} ${pl(active, [], ["agent", "agents"])} working at once (peak ${peak})`
				: `${active} ${pl(active, ["agent", "agenta", "agenata"])} ${pl(active, ["radi", "rade", "radi"])} istovremeno (vrhunac ${peak})`,
		)
	}
	let right
	let tail = ""
	if (isMapa()) {
		const rows = mapaRows()
		const finished = rows.filter((r) => r.status === "done" || r.status === "error").length
		const over = rows.filter((r) => r.signals?.vdOver).length
		parts.push(t("{done}/{n} institucija gotovo", { done: finished, n: rows.length }))
		nodes.push({ t: t("{n} sa v.d. preko roka", { n: over }), cls: over ? "sig" : "" })
		const b = state.budget
		right = `${t("petlje")} ${b?.loops ?? 0}/${b?.maxLoops ?? 0} · ${t("alati")} ${b?.toolCalls ?? 0}/${b?.maxToolCalls ?? 0}`
	} else {
		const signals = [...state.findings.values()].filter((f) => f.severity === "signal").length
		const open = openTasks().length
		const nf = state.findings.size
		parts.push(`${nf} ${pl(nf, ["nalaz", "nalaza", "nalaza"], ["finding", "findings"])}`)
		nodes.push({ t: `${signals} ${pl(signals, ["signal", "signala", "signala"], ["signal", "signals"])}`, cls: signals ? "sig" : "" })
		if (!done || open) nodes.push({ t: `${open} ${pl(open, ["pitanje", "pitanja", "pitanja"], ["question", "questions"])}`, cls: open ? "wait" : "" })
		const b = state.budget
		right = `${t("firme")} ${b?.firme ?? 0}/${b?.maxFirme ?? 0} · ${t("osobe")} ${b?.osobe ?? 0}/${b?.maxOsobe ?? 0} · ${t("alati")} ${b?.toolCalls ?? 0}/${b?.maxToolCalls ?? 0}`
	}
	if (!done) {
		const ev = Math.max(state.stats?.events ?? 0, state.eventCount)
		tail = `${fmtNum(ev)} ${pl(ev, ["događaj", "događaja", "događaja"], ["event", "events"])}`
	}
	return { lead: parts, nodes, tail, right }
}

function update() {
	const v = compute()
	// parts: [text, class, quiet]; the clock and the event counter tick all the time, so they stay out of the live region
	const parts = [...v.lead.map((p, i) => [p, i === 0 ? "state" : "", i === 1]), ...v.nodes.map((n) => [n.t, n.cls, false])]
	if (v.tail) parts.push([v.tail, "", true])
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
	const root = document.getElementById("statusLine")
	main = document.getElementById("slMain")
	budget = document.getElementById("slBudget")
	const schedule = createScheduler(() => {
		root.hidden = document.body.dataset.view === "hero"
		update()
	})
	setInterval(schedule, 500)
	for (const ev of ["meta", "snapshot", "finding", "tasks", "mapa", "view"]) on(ev, schedule)
	onLang(schedule)
	schedule()
}
