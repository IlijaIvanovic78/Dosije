// Dosije UI bootstrap: wires the store, the SSE stream and every view together.

import { h } from "./js/format.js"
import { api } from "./js/api.js"
import { state, on, applySnapshot, setView, startFresh, resumeCase } from "./js/store.js"
import { startStream } from "./js/sse.js"
import { initLanes } from "./js/lanes.js"
import { initGantt } from "./js/gantt.js"
import { initDosije } from "./js/dosije.js"
import { initInbox, openInbox } from "./js/inbox.js"
import { initEventLog } from "./js/eventlog.js"
import { initReport } from "./js/report.js"
import { initMapa } from "./js/mapa.js"
import { initMetrics } from "./js/metrics.js"
import { initSearch } from "./js/search.js"
import { showNotice, clearNotice, finishCaseThen, caseBusy } from "./js/notice.js"
import { t, setLang, onLang, applyStatic } from "./js/i18n.js"
import { initHelp, initSources } from "./js/help.js"
import { initPanes } from "./js/panes.js"

const $ = (id) => document.getElementById(id)

/** The current institutions as small research cards: what it is, its name, and the action. */
function renderDemoChips() {
	const demos = state.config?.demoInstitutions || []
	$("heroChips").replaceChildren(
		...demos.map((d) =>
			h(
				"button",
				{ class: "example", type: "button", onclick: () => startCase(d.name), "aria-label": t("Istražite: {name}", { name: d.name }) },
				h("span", { class: "ex-kind" }, t(d.kind || "Javna institucija")),
				h("span", { class: "ex-name" }, d.name),
				h("span", { class: "ex-go", "aria-hidden": "true" }, `${t("Istražite")} →`),
			),
		),
	)
}

/** The side panel holds questions and approvals only when the server asks the user; otherwise it is the place to add a lead. */
function renderInboxButton() {
	const asks = !!state.config?.asksUser
	const label = $("inboxLabel")
	const text = asks ? "Sanduče" : "Dodajte trag"
	if (label.dataset.sr !== text) {
		label.dataset.sr = text
		label.textContent = t(text)
	}
	// a lead only makes sense while a case is open
	$("btnInbox").hidden = !asks && !(state.caseId && document.body.dataset.view === "case" && state.ui.view !== "mapa")
}

/** On the empty state, a case the server still holds stays one click away. */
function renderResume() {
	const el = $("heroResume")
	const show = !!state.caseId && state.ui.fresh
	el.hidden = !show
	if (!show) return
	const name = state.institution?.name || state.input
	const running = state.status === "running" || state.status === "finalizing"
	el.replaceChildren(
		h("span", { class: `stat ${running ? "running" : "done"}` }, h("i"), running ? t("istraživanje traje") : t("završeno")),
		h("span", { class: "resume-text" }, name),
		h("button", { class: "link-btn", type: "button", onclick: resumeCase }, `${running ? t("Pratite istraživanje") : t("Otvorite dosije")} →`),
	)
}

/** POST /api/dosije; a refusal stays visible under the top bar, with a one-click way out when a case is still running. */
async function doStart(value, focusValue) {
	const host = $("topNotice")
	clearNotice(host)
	try {
		await api.start(value, focusValue || undefined)
	} catch (e) {
		const actions = []
		if (e.status === 409 && caseBusy()) actions.push({ label: t("Završite dosije pa pokrenite novi"), onClick: () => finishCaseThen(host, () => doStart(value, focusValue)) })
		showNotice(host, { text: `${t("Dosije nije pokrenut.")} ${e.message}`, actions })
	}
}

let starting = false
async function startCase(inputValue) {
	const inst = $("inInst")
	const focus = $("inFocus")
	if (typeof inputValue === "string") inst.value = inputValue
	const value = inst.value.trim()
	if (!value) {
		inst.focus()
		inst.classList.add("invalid")
		return
	}
	// names only: a pasted link is refused here, before any request
	if (/^(https?:\/\/|www\.)|\.(rs|com|net|org|info)(\/|$)/i.test(value)) {
		inst.focus()
		inst.classList.add("invalid")
		showNotice($("topNotice"), { text: t("Upišite naziv institucije (ključne reči). Linkovi se ne prihvataju.") })
		return
	}
	clearNotice($("topNotice"))
	inst.classList.remove("invalid")
	if (starting) return
	starting = true
	const btn = $("btnStart")
	btn.disabled = true
	btn.textContent = t("Pronalazim instituciju…")
	try {
		// a closed focus box is not a focus: what was typed there waits until it is opened again
		await doStart(value, focusOpen ? focus.value.trim() : "")
	} finally {
		setTimeout(() => {
			starting = false
			btn.disabled = false
			btn.textContent = t("Pokrenite istraživanje")
		}, 900)
	}
}

function goHome() {
	clearNotice($("topNotice"))
	$("inInst").value = ""
	$("inFocus").value = ""
	toggleFocus(false)
	startFresh()
	$("inInst").focus()
}

/** The underline of the active tab slides to the tab that was chosen. */
function placeNavIndicator() {
	const active = document.querySelector('.nav-tab[aria-pressed="true"]')
	const ind = $("navInd")
	if (!active) return
	ind.style.width = `${active.offsetWidth - 24}px`
	ind.style.transform = `translateX(${active.offsetLeft + 12}px)`
	ind.classList.add("ready")
}

let lastView = ""
function renderView() {
	const hasCase = (!!state.caseId || state.ui.view === "mapa") && !state.ui.fresh
	document.body.dataset.view = hasCase ? "case" : "hero"
	const dosije = state.ui.view !== "mapa"
	$("btnNavDosije").setAttribute("aria-pressed", String(dosije))
	$("btnMapa").setAttribute("aria-pressed", String(!dosije))
	$("btnNew").hidden = !hasCase || !state.caseId || !dosije
	renderResume()
	renderInboxButton()
	placeNavIndicator()
	// a change of screen fades the new one in (not the first paint)
	const view = `${document.body.dataset.view}:${dosije ? "dosije" : "mapa"}`
	if (lastView && view !== lastView) {
		const main = $("main")
		main.classList.remove("view-in")
		void main.offsetWidth
		main.classList.add("view-in")
	}
	lastView = view
}

let focusOpen = false
function toggleFocus(open = !focusOpen) {
	focusOpen = open
	const box = $("focusBox")
	box.dataset.open = String(open)
	box.inert = !open
	$("btnFocusToggle").setAttribute("aria-expanded", String(open))
	if (open) setTimeout(() => $("inFocus").focus({ preventScroll: true }), 60)
}

async function boot() {
	$("caseForm").addEventListener("submit", (e) => {
		e.preventDefault()
		startCase()
	})
	$("inInst").addEventListener("input", (e) => e.target.classList.remove("invalid"))
	$("btnFocusToggle").addEventListener("click", () => toggleFocus())
	$("inFocus").addEventListener("keydown", (e) => {
		if (e.key === "Escape") {
			toggleFocus(false)
			$("btnFocusToggle").focus()
		}
	})
	$("btnNew").addEventListener("click", goHome)
	$("brandHome").addEventListener("click", () => {
		if (state.caseId) goHome()
		else setView("dosije")
	})
	$("btnNavDosije").addEventListener("click", () => setView("dosije"))
	window.addEventListener("resize", placeNavIndicator)
	document.fonts?.ready.then(placeNavIndicator)
	$("btnAddLead").addEventListener("click", () => {
		openInbox()
		const input = document.querySelector("#leadForm input[name=name]")
		document.getElementById("leadSection").scrollIntoView({ block: "start" })
		setTimeout(() => input?.focus({ preventScroll: true }), 40)
	})
	for (const b of document.querySelectorAll(".lang-btn")) b.addEventListener("click", () => setLang(b.dataset.lang))
	// before the static texts are translated, so the copies of the source cards are translated too
	initSources()
	applyStatic()
	initHelp()
	onLang(() => {
		renderDemoChips()
		renderResume()
		renderInboxButton()
		placeNavIndicator()
	})

	initMetrics()
	initLanes()
	initGantt()
	initSearch()
	initDosije()
	initInbox()
	initEventLog()
	initReport()
	initMapa()
	initPanes()

	on("snapshot", () => {
		renderDemoChips()
		renderView()
	})
	on("meta", renderView)
	on("view", renderView)
	renderView()

	try {
		state.config = await api.config()
		renderDemoChips()
		renderInboxButton()
	} catch (e) {
		console.warn("config unavailable", e)
	}
	try {
		applySnapshot(await api.state())
	} catch (e) {
		console.warn("state unavailable", e)
	}
	startStream()
}

boot()
