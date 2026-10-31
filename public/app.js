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

const $ = (id) => document.getElementById(id)

/** What kind of institution each demo is (shown under its name on the start screen). */
const DEMO_KIND = {
	"infrastruktura-zeleznice-srbije": "Državno preduzeće · železnička infrastruktura",
	srbijavoz: "Državno preduzeće · putnički prevoz",
	"univerzitetski-klinicki-centar-vojvodine": "Zdravstvena ustanova",
	"grad-novi-sad": "Lokalna samouprava",
}

const STUCK_MS = 8000
let connSince = Date.now()
let lastConn = null
let stuckTimer = null

/** The top bar only speaks up when the connection to the server is in trouble. */
function renderMode() {
	const el = $("modeText")
	if (state.conn !== lastConn) {
		lastConn = state.conn
		connSince = Date.now()
		clearTimeout(stuckTimer)
		if (state.conn !== "up") stuckTimer = setTimeout(renderMode, STUCK_MS + 100)
	}
	if (state.conn === "up") {
		el.hidden = true
		el.textContent = ""
		return
	}
	// still not connected after a while: say what usually causes it
	const stuck = Date.now() - connSince > STUCK_MS
	el.hidden = false
	el.className = `conn-text ${state.conn === "down" || stuck ? "down" : ""}`
	el.textContent = stuck ? t("nema veze sa serverom") : state.conn === "down" ? t("veza prekinuta, povezujem…") : t("povezujem…")
	el.title = stuck ? t("Proveri da li server radi (npm start) i zatvori višak tabova sa Dosijeom: pregledač drži najviše 6 veza ka istom serveru.") : t("Veza sa serverom (SSE)")
}

const BUILDING_ICON =
	'<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M3 17h14M4.5 17V8.5L10 4.5l5.5 4V17"/><path d="M8 17v-4h4v4M7.5 9.5h1M11.5 9.5h1"/></svg>'

function exampleIcon() {
	const el = h("span", { class: "ex-icon" })
	el.innerHTML = BUILDING_ICON
	return el
}

function renderDemoChips() {
	const demos = state.config?.demoInstitutions || []
	$("heroChips").replaceChildren(
		...demos.map((d, i) =>
			h(
				"button",
				{ class: "example", type: "button", onclick: () => startCase(d.name) },
				exampleIcon(),
				h("span", { class: "ex-name" }, d.name),
				DEMO_KIND[d.slug] ? h("span", { class: "ex-kind" }, t(DEMO_KIND[d.slug])) : null,
				i === 0 ? h("span", { class: "ex-tag" }, t("najbolji demo")) : null,
				h("span", { class: "ex-go", "aria-hidden": "true" }, "→"),
			),
		),
	)
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
		h("span", { class: `stat ${running ? "running" : "done"}` }, h("i"), running ? t("u toku") : t("završeno")),
		h("span", { class: "resume-text" }, h("b", null, name)),
		h("button", { class: "link-btn", type: "button", onclick: resumeCase }, `${t("Vrati se na dosije")} →`),
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
		if (e.status === 409 && caseBusy()) actions.push({ label: t("Završi dosije pa pokreni novi"), onClick: () => finishCaseThen(host, () => doStart(value, focusValue)) })
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
		showNotice($("topNotice"), { text: t("Upiši naziv institucije (ključne reči). Linkovi se ne prihvataju.") })
		return
	}
	clearNotice($("topNotice"))
	inst.classList.remove("invalid")
	if (starting) return
	starting = true
	const btn = $("btnStart")
	btn.disabled = true
	btn.textContent = t("Pokrećem…")
	try {
		await doStart(value, focus.value.trim())
	} finally {
		setTimeout(() => {
			starting = false
			btn.disabled = false
			btn.textContent = t("Pokreni istragu")
		}, 900)
	}
}

function goHome() {
	clearNotice($("topNotice"))
	$("inInst").value = ""
	$("inFocus").value = ""
	startFresh()
	$("inInst").focus()
}

function renderView() {
	const hasCase = (!!state.caseId || state.ui.view === "mapa") && !state.ui.fresh
	document.body.dataset.view = hasCase ? "case" : "hero"
	const dosije = state.ui.view !== "mapa"
	$("btnNavDosije").setAttribute("aria-pressed", String(dosije))
	$("btnNew").hidden = !hasCase || !state.caseId || !dosije
	renderResume()
}

function toggleFocus(open) {
	const input = $("inFocus")
	const btn = $("btnFocusToggle")
	input.hidden = !open
	btn.hidden = open
	btn.setAttribute("aria-expanded", String(open))
	if (open) input.focus()
}

async function boot() {
	$("caseForm").addEventListener("submit", (e) => {
		e.preventDefault()
		startCase()
	})
	$("inInst").addEventListener("input", (e) => e.target.classList.remove("invalid"))
	$("btnFocusToggle").addEventListener("click", () => toggleFocus(true))
	$("inFocus").addEventListener("blur", (e) => {
		if (!e.target.value.trim()) toggleFocus(false)
	})
	$("btnNew").addEventListener("click", goHome)
	$("brandHome").addEventListener("click", () => {
		if (state.caseId) goHome()
		else setView("dosije")
	})
	$("btnNavDosije").addEventListener("click", () => setView("dosije"))
	$("btnHeroMapa").addEventListener("click", () => setView("mapa"))
	$("btnAddLead").addEventListener("click", () => {
		openInbox()
		const input = document.querySelector("#leadForm input[name=name]")
		document.getElementById("leadSection").scrollIntoView({ block: "start" })
		setTimeout(() => input?.focus({ preventScroll: true }), 40)
	})
	for (const b of document.querySelectorAll(".lang-btn")) b.addEventListener("click", () => setLang(b.dataset.lang))
	applyStatic()
	onLang(() => {
		renderMode()
		renderDemoChips()
		renderResume()
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

	on("conn", renderMode)
	on("snapshot", () => {
		renderMode()
		renderDemoChips()
		renderView()
	})
	on("meta", renderView)
	on("view", renderView)
	renderMode()
	renderView()

	try {
		state.config = await api.config()
		renderDemoChips()
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
