// The phases of the run (the agents collect, the Editor writes the summary, the dossier is ready), shown in the middle of
// the top bar when it has room, otherwise in a slim bar under it. The counts (agents at work, findings, signals) live in
// the team and dossier panels, so they are not repeated here.

import { h, createScheduler } from "./format.js"
import { state, on, activeCount, openTasks, runStatus } from "./store.js"
import { focusDecisions } from "./inbox.js"
import { openReport } from "./report.js"
import { t, onLang } from "./i18n.js"

const isMapa = () => state.runKind === "mapa"
const CHECK = "✓"

let stepsEl, slot, bar
let lastSig = ""

function caseSteps(st) {
	const open = openTasks().length
	const resolved = [...state.tasks.values()].filter((k) => k.status !== "open").length
	const done = st === "done"
	const finalizing = st === "finalizing"
	// every agent is idle and only the journalist's answers keep the case open: collecting is over
	const collecting = st === "running" && !(open && activeCount() === 0)
	const s1 = { state: collecting ? "active" : st === "idle" ? "todo" : "done", label: t("Prikupljanje podataka"), tip: t("Agenti istovremeno pretražuju izvore i upisuju nalaze.") }
	const s2 = open
		? { state: "wait", label: t("Vaše odluke"), onClick: () => focusDecisions() }
		: { state: done || resolved ? "done" : "todo", label: t("Vaše odluke") }
	const s3 = { state: done ? "done" : finalizing ? "active" : "todo", label: t("Sažetak urednika"), tip: t("Urednik spaja nalaze, rangira signale i piše sažetak.") }
	const s4 = done ? { state: "done", label: t("Dosije je spreman"), tip: t("otvorite izveštaj"), onClick: () => openReport() } : { state: "todo", label: t("Dosije je spreman") }
	// nothing waits for the user unless the server asks (config.asksUser): no "Vaše odluke" step then
	return state.config?.asksUser ? [s1, s2, s3, s4] : [s1, s3, s4]
}

function mapaSteps() {
	const done = state.mapa.status === "done"
	return [
		{ state: done ? "done" : "active", label: t("Provera institucija"), tip: t("Za svaku instituciju poseban agent proverava rukovodstvo, nabavke i reviziju.") },
		{ state: done ? "done" : "todo", label: t("Rang-lista") },
	]
}

function stepNode(s, i) {
	const inner = [h("span", { class: "step-n", "aria-hidden": "true" }, s.state === "done" ? CHECK : String(i + 1)), h("span", { class: "step-txt" }, h("b", null, s.label))]
	const body = s.onClick ? h("button", { class: "step-btn", type: "button", onclick: s.onClick, title: s.tip || null }, ...inner) : h("span", { class: "step-btn", title: s.tip || null }, ...inner)
	return h("li", { class: `step is-${s.state}`, "aria-current": s.state === "active" || s.state === "wait" ? "step" : null }, body)
}

/** In the top bar when the steps fit between the tabs and the buttons; otherwise in the bar under it. */
function place() {
	const shown = document.body.dataset.view !== "hero" && !(state.ui.view === "mapa" && !isMapa())
	if (!shown) {
		slot.hidden = true
		bar.hidden = true
		return
	}
	if (stepsEl.parentElement !== slot) slot.append(stepsEl)
	slot.hidden = false
	bar.hidden = true
	if (stepsEl.scrollWidth > slot.clientWidth + 1) {
		bar.append(stepsEl)
		slot.hidden = true
		bar.hidden = false
	}
}

function update() {
	const st = runStatus()
	const list = isMapa() ? mapaSteps() : caseSteps(st)
	const sig = JSON.stringify([document.body.dataset.view, state.ui.view, state.runKind, list.map((s) => [s.state, s.label, !!s.onClick, s.tip])])
	if (sig === lastSig) return
	lastSig = sig
	stepsEl.replaceChildren(...list.map(stepNode))
	place()
}

export function initMetrics() {
	bar = document.getElementById("statusLine")
	slot = document.getElementById("topSteps")
	stepsEl = document.getElementById("runSteps")
	const schedule = createScheduler(() => {
		document.body.dataset.run = runStatus()
		update()
	})
	setInterval(schedule, 500)
	for (const ev of ["meta", "snapshot", "finding", "tasks", "mapa", "view"]) on(ev, schedule)
	window.addEventListener("resize", () => {
		lastSig = ""
		schedule()
	})
	onLang(() => {
		lastSig = ""
		schedule()
	})
	schedule()
}
