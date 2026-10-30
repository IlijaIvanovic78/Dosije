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
import { initMetrics } from "./js/metrics.js"
import { toast } from "./js/toast.js"

const $ = (id) => document.getElementById(id)

function renderBadges() {
	const c = state.config
	const box = $("badges")
	const conn = state.conn === "up" ? ["up", "uživo"] : state.conn === "down" ? ["down", "veza prekinuta, povezujem…"] : ["wait", "povezujem…"]
	const nodes = []
	if (c) {
		const llm = c.mode === "llm"
		nodes.push(h("span", { class: `badge-pill ${llm ? "llm" : "scripted"}`, title: llm ? `Radnici: ${c.model} · urednik: ${c.editorModel}` : "Nije podešen API ključ: agenti rade po skripti, ali sa istim alatima, gate-om i događajima" }, h("i"), llm ? `OpenAI · ${c.model}` : "Bez ključa · skriptovani agenti"))
		const dm = { cache: "keš", live: "uživo", auto: "auto" }[c.dataMode] || c.dataMode
		nodes.push(h("span", { class: "badge-pill data", title: c.searchProviders?.length ? `Pretraga vesti: ${c.searchProviders.join(", ")}` : "" }, `Podaci: ${dm}`))
	}
	nodes.push(h("span", { class: `badge-pill conn ${conn[0]}`, title: "Veza sa serverom (SSE)" }, h("i"), conn[1]))
	box.replaceChildren(...nodes)
}

function renderDemoChips() {
	const demos = state.config?.demoInstitutions || []
	for (const target of [$("demoChips"), $("heroChips")]) {
		target.replaceChildren(
			...demos.map((d) =>
				h("button", { class: "chip-demo", type: "button", onclick: () => startCase(d.name) }, h("span", null, "▶"), d.name),
			),
		)
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
		inst.classList.remove("shake")
		void inst.offsetWidth
		inst.classList.add("shake")
		return
	}
	if (starting) return
	starting = true
	const btn = $("btnStart")
	btn.disabled = true
	btn.classList.add("busy")
	btn.textContent = "Pokrećem tim…"
	try {
		await api.start(value, focus.value.trim())
	} catch (e) {
		toast({ kind: "error", title: "Dosije nije pokrenut", text: e.message })
	} finally {
		setTimeout(() => {
			starting = false
			btn.disabled = false
			btn.classList.remove("busy")
			btn.textContent = "Napravi dosije"
		}, 900)
	}
}

function renderView() {
	const hasCase = !!state.caseId
	document.body.dataset.view = hasCase ? "case" : "hero"
	$("metrics").classList.toggle("open", hasCase)
}

async function boot() {
	$("caseForm").addEventListener("submit", (e) => {
		e.preventDefault()
		startCase()
	})

	initMetrics()
	initLanes()
	initGantt()
	initDosije()
	initInbox()
	initEventLog()
	initReport()

	on("conn", renderBadges)
	on("snapshot", () => {
		renderBadges()
		renderDemoChips()
		renderView()
	})
	on("meta", renderView)
	renderBadges()
	renderView()

	try {
		state.config = await api.config()
		renderBadges()
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
