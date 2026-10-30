// Dosije UI bootstrap: wires the store, the SSE stream and every view together.

import { h } from "./js/format.js"
import { api } from "./js/api.js"
import { state, on, applySnapshot } from "./js/store.js"
import { startStream } from "./js/sse.js"
import { initLanes } from "./js/lanes.js"
import { initGantt } from "./js/gantt.js"
import { initDosije } from "./js/dosije.js"
import { initInbox } from "./js/inbox.js"
import { initEventLog } from "./js/eventlog.js"
import { initReport } from "./js/report.js"
import { initMapa } from "./js/mapa.js"
import { initMetrics } from "./js/metrics.js"
import { initSearch } from "./js/search.js"
import { showNotice, clearNotice, finishCaseThen, caseBusy } from "./js/notice.js"

const $ = (id) => document.getElementById(id)

function renderMode() {
	const c = state.config
	const el = $("modeText")
	if (state.conn !== "up") {
		el.className = `mode-text ${state.conn === "down" ? "down" : ""}`
		el.textContent = state.conn === "down" ? "veza prekinuta, povezujem…" : "povezujem…"
		el.title = "Veza sa serverom (SSE)"
		return
	}
	el.className = "mode-text"
	if (!c) {
		el.textContent = ""
		return
	}
	const dm = { cache: "keš", live: "uživo", auto: "auto" }[c.dataMode] || c.dataMode
	el.textContent = c.mode === "llm" ? `OpenAI · ${c.model}` : `bez ključa · ${dm}`
	el.title =
		c.mode === "llm"
			? `Radnici: ${c.model} · urednik: ${c.editorModel} · podaci: ${dm}${c.searchProviders?.length ? ` · pretraga vesti: ${c.searchProviders.join(", ")}` : ""}`
			: `Nije podešen API ključ: agenti rade po skripti, ali sa istim alatima, kapijom i događajima · podaci: ${dm}`
}

function renderDemoChips() {
	const demos = state.config?.demoInstitutions || []
	$("heroChips").replaceChildren(...demos.map((d) => h("button", { class: "demo-btn", type: "button", onclick: () => startCase(d.name) }, d.name)))
}

/** POST /api/dosije; a refusal stays visible under the top bar, with a one-click way out when a case is still running. */
async function doStart(value, focusValue) {
	const host = $("topNotice")
	clearNotice(host)
	try {
		await api.start(value, focusValue || undefined)
	} catch (e) {
		const actions = []
		if (e.status === 409 && caseBusy()) actions.push({ label: "Završi dosije pa pokreni novi", onClick: () => finishCaseThen(host, () => doStart(value, focusValue)) })
		showNotice(host, { text: `Dosije nije pokrenut. ${e.message}`, actions })
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
	inst.classList.remove("invalid")
	if (starting) return
	starting = true
	const btn = $("btnStart")
	btn.disabled = true
	btn.textContent = "Pokrećem…"
	try {
		await doStart(value, focus.value.trim())
	} finally {
		setTimeout(() => {
			starting = false
			btn.disabled = false
			btn.textContent = "Napravi dosije"
		}, 900)
	}
}

function renderView() {
	const hasCase = (!!state.caseId || state.ui.view === "mapa") && !state.ui.fresh
	document.body.dataset.view = hasCase ? "case" : "hero"
}

async function boot() {
	$("caseForm").addEventListener("submit", (e) => {
		e.preventDefault()
		startCase()
	})
	$("inInst").addEventListener("input", (e) => e.target.classList.remove("invalid"))

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
		renderMode()
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
