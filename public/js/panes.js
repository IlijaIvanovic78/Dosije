// Phones and narrow windows: the board is one column there, and the agent team used to sit under the whole dossier
// (dozens of screens down). A switch under the run bar shows one pane at a time: the dossier (or the comparison) or the
// agent team. A run opens on the team at work; when it ends, the dossier opens at the top, on its result. In between
// the visitor switches freely. Wide screens show both columns and never see the switch (styles.css).

import { state, on, isRunning, isDone, activeCount } from "./store.js"
import { t, onLang } from "./i18n.js"
import { h } from "./format.js"

const ONE_COLUMN = window.matchMedia("(max-width: 1020px)")

let el
let pane = "doc"
let lastRun = null
let lastRunning = false
const scrollOf = { doc: 0, team: 0 }
let queued = false

function setPane(next) {
	if (next === pane) return
	const main = document.getElementById("main")
	scrollOf[pane] = main.scrollTop
	pane = next
	document.body.dataset.pane = pane
	render()
	// each pane comes back where the visitor left it
	if (ONE_COLUMN.matches) main.scrollTop = scrollOf[pane]
	// the Gantt and the run bar measure themselves on resize; a pane that was hidden has to be measured again
	window.dispatchEvent(new Event("resize"))
}

function render() {
	queued = false
	const mapa = state.ui.view === "mapa"
	const running = isRunning()
	const findings = mapa ? 0 : state.findings.size
	const working = running ? activeCount() : 0
	el.docLbl.textContent = mapa ? t("Poređenje") : t("Dosije")
	el.docBadge.textContent = findings ? String(findings) : ""
	el.docBadge.hidden = !findings
	// "12 radi"; the smallest phones show only the number (styles.css)
	el.teamBadge.replaceChildren(...(working ? [String(working), h("span", { class: "ps-unit" }, ` ${t("radi")}`)] : []))
	el.teamBadge.hidden = !working
	el.team.classList.toggle("is-live", running)
	for (const b of [el.doc, el.team]) {
		const selected = b.dataset.pane === pane
		b.setAttribute("aria-selected", String(selected))
		b.tabIndex = selected ? 0 : -1
	}
}

function schedule() {
	if (queued) return
	queued = true
	requestAnimationFrame(render)
}

/** A new run opens on the team; a run that ended opens on its result. */
function follow() {
	const run = state.runKind === "mapa" ? state.mapa.id : state.caseId
	const running = isRunning()
	if (run && run !== lastRun && running) {
		scrollOf.doc = scrollOf.team = 0
		setPane("team")
	} else if (lastRunning && !running && isDone()) {
		scrollOf.doc = 0
		setPane("doc")
	}
	lastRun = run
	lastRunning = running
	schedule()
}

export function initPanes() {
	const root = document.getElementById("paneSwitch")
	el = {
		doc: root.querySelector('[data-pane="doc"]'),
		team: root.querySelector('[data-pane="team"]'),
		docLbl: root.querySelector('[data-pane="doc"] .ps-lbl'),
		docBadge: root.querySelector('[data-pane="doc"] .ps-badge'),
		teamBadge: root.querySelector('[data-pane="team"] .ps-badge'),
	}
	document.body.dataset.pane = pane
	for (const b of [el.doc, el.team]) b.addEventListener("click", () => setPane(b.dataset.pane))
	root.addEventListener("keydown", (e) => {
		if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return
		const next = pane === "doc" ? "team" : "doc"
		setPane(next)
		el[next].focus()
	})
	// a tap on an agent filters the dossier to its findings: on one column, show them
	on("filters", (key) => {
		if (key === "agentId" && state.filters.agentId && ONE_COLUMN.matches && pane === "team") setPane("doc")
	})
	for (const topic of ["meta", "snapshot", "view"]) on(topic, follow)
	for (const topic of ["lane", "finding", "agents"]) on(topic, schedule)
	onLang(schedule)
	follow()
}
