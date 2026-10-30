// Run bar under the top bar: where the run is in its flow (the team investigates, you decide, the dossier is ready)
// and one quiet line of numbers that show the agents working at the same time.

import { h, fmtElapsed, fmtNum, createScheduler } from "./format.js"
import { state, on, activeCount, peakCount, openTasks, elapsedMs, runStatus } from "./store.js"
import { focusDecisions } from "./inbox.js"
import { openReport } from "./report.js"
import { t, pl, getLang, onLang } from "./i18n.js"

const isMapa = () => state.runKind === "mapa"
const CHECK = "✓"

let stepsEl, statsEl
let lastSig = ""
let lastNums = ""
let clockEls = []

function caseSteps(st, clock) {
	const open = openTasks().length
	const resolved = [...state.tasks.values()].filter((k) => k.status !== "open").length
	// every agent is idle and only the journalist's answers keep the case open: the investigation step is over
	const running = st === "running" && !(open && activeCount() === 0)
	const done = st === "done"
	const s1 = running
		? { state: "active", label: t("Tim istražuje"), sub: clock }
		: { state: st === "idle" ? "todo" : "done", label: t("Istraga"), sub: clock }
	let s2
	if (open) s2 = { state: "wait", label: t("Tvoje odluke"), sub: getLang() === "en" ? `${open} waiting` : `${open} ${pl(open, ["čeka", "čekaju", "čeka"])}`, onClick: () => focusDecisions() }
	else if (resolved) s2 = { state: "done", label: t("Tvoje odluke"), sub: getLang() === "en" ? `${resolved} resolved` : `${resolved} ${pl(resolved, ["rešena", "rešene", "rešeno"])}` }
	else s2 = { state: done ? "done" : "todo", label: t("Tvoje odluke"), sub: done ? t("nije bilo pitanja") : t("kad agent pita") }
	let s3
	if (done) s3 = { state: "done", label: t("Dosije je spreman"), sub: t("otvori izveštaj"), onClick: () => openReport() }
	else if (st === "finalizing") s3 = { state: "active", label: t("Dosije"), sub: t("urednik piše izveštaj") }
	else s3 = { state: "todo", label: t("Dosije"), sub: t("posle istrage") }
	return [s1, s2, s3]
}

function mapaSteps(clock) {
	const rows = [...state.mapa.rows.values()]
	const finished = rows.filter((r) => r.status === "done" || r.status === "error").length
	const done = state.mapa.status === "done"
	return [
		{ state: done ? "done" : "active", label: t("Trijaža institucija"), sub: `${finished}/${rows.length} · ${clock}` },
		{ state: done ? "done" : "todo", label: t("Rang lista"), sub: done ? t("gde prvo gledati") : t("posle trijaže") },
	]
}

function stats(st) {
	const done = st === "done"
	const active = activeCount()
	const peak = peakCount()
	const en = getLang() === "en"
	// [text before the number, number, text after, tone]
	const out = []
	if (done) out.push([en ? "peak" : "vrhunac", peak, en ? `${pl(peak, [], ["agent", "agents"])} at once` : `${pl(peak, ["agent", "agenta", "agenata"])} istovremeno`, ""])
	else out.push(["", active, en ? `${pl(active, [], ["agent", "agents"])} working at once` : `${pl(active, ["agent radi", "agenta rade", "agenata radi"])} istovremeno`, "is-live"], [en ? "peak" : "vrhunac", peak, "", "is-dim"])
	if (isMapa()) {
		const over = [...state.mapa.rows.values()].filter((r) => r.signals?.vdOver).length
		out.push(["", over, t("sa v.d. preko roka"), over ? "is-sig" : ""])
	} else {
		const nf = state.findings.size
		const signals = [...state.findings.values()].filter((f) => f.severity === "signal").length
		out.push(["", nf, pl(nf, ["nalaz", "nalaza", "nalaza"], ["finding", "findings"]), ""], ["", signals, pl(signals, ["signal", "signala", "signala"], ["signal", "signals"]), signals ? "is-sig" : ""])
	}
	const ev = Math.max(state.stats?.events ?? 0, state.eventCount)
	out.push(["", ev, en ? "Mozaik events" : `Mozaik ${pl(ev, ["događaj", "događaja", "događaja"])}`, "is-muted"])
	return out
}

function stepNode(s, i) {
	const inner = [h("span", { class: "step-n", "aria-hidden": "true" }, s.state === "done" ? CHECK : String(i + 1)), h("span", { class: "step-txt" }, h("b", null, s.label), h("small", { class: s.clock ? "js-clock" : null }, s.sub))]
	const body = s.onClick ? h("button", { class: "step-btn", type: "button", onclick: s.onClick }, ...inner) : h("span", { class: "step-btn" }, ...inner)
	return h("li", { class: `step is-${s.state}`, "aria-current": s.state === "active" || s.state === "wait" ? "step" : null }, body)
}

function update() {
	const st = runStatus()
	const clock = fmtElapsed(elapsedMs())
	const list = isMapa() ? mapaSteps("\u0000") : caseSteps(st, "\u0000")
	// the clock ticks every half second: it is patched in place, everything else rebuilds only when it changes
	for (const s of list) if (s.sub.includes("\u0000")) s.clock = true
	const sig = JSON.stringify([getLang(), list.map((s) => [s.state, s.label, s.sub, !!s.onClick])])
	if (sig !== lastSig) {
		lastSig = sig
		stepsEl.replaceChildren(...list.map(stepNode))
		clockEls = list.map((s, i) => (s.clock ? { el: stepsEl.children[i].querySelector("small"), tpl: s.sub } : null)).filter(Boolean)
	}
	const nums = stats(st)
	const numSig = JSON.stringify([getLang(), nums])
	if (numSig !== lastNums) {
		lastNums = numSig
		statsEl.replaceChildren(...nums.map(([pre, n, post, cls]) => h("span", { class: `rs-item ${cls}`.trim() }, pre ? `${pre} ` : null, h("b", null, fmtNum(n)), post ? ` ${post}` : null)))
	}
	for (const c of clockEls) {
		const text = c.tpl.replace("\u0000", clock)
		if (c.el.textContent !== text) c.el.textContent = text
	}
}

export function initMetrics() {
	const root = document.getElementById("statusLine")
	stepsEl = document.getElementById("runSteps")
	statsEl = document.getElementById("slMain")
	const schedule = createScheduler(() => {
		// the bar follows the run on screen: a finished case's steps would only confuse the map view
		root.hidden = document.body.dataset.view === "hero" || (state.ui.view === "mapa" && !isMapa())
		document.body.dataset.run = runStatus()
		update()
	})
	setInterval(schedule, 500)
	for (const ev of ["meta", "snapshot", "finding", "tasks", "mapa", "view"]) on(ev, schedule)
	onLang(() => {
		lastSig = lastNums = ""
		schedule()
	})
	schedule()
}
