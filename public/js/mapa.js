// "Mapa prioriteta": a list of institutions triaged by parallel "Trijaža" agents, shown as a live ranking table
// ("gde prvo gledati"). Rows are re-sorted in place as scores arrive; the left "Tim" column shows the agents.

import { h, createScheduler, sourceLinks, fmtNum, fmtElapsed } from "./format.js"
import { state, on, setView, activeCount, peakCount, elapsedMs } from "./store.js"
import { api } from "./api.js"
import { showNotice, clearNotice, finishCaseThen, caseBusy } from "./notice.js"

const MAX_SCORE = 100 // bar scale: at least 100 points, or the highest score on screen
const rows = new Map() // slug -> { root, parts, sig }
const open = new Set()
const order = new Map() // slug -> first-seen index (stable tie-break)
let el = {}
let dirty = false
let editing = false

const pct = (share) => `${(Math.round(share * 1000) / 10).toLocaleString("sr-RS")}%`

function mapaRunning() {
	return state.runKind === "mapa" && state.mapa.status === "running"
}

/** Signal chips of a row: [text, tone] (tone: signal = red, paznja = amber, info = gray). */
export function chipsOf(s = {}) {
	const out = []
	if (s.vdMonths !== undefined && s.vdLimitMonths !== undefined) out.push([`v.d. ${s.vdMonths}/${s.vdLimitMonths} mes.`, s.vdOver ? "signal" : "info"])
	if (s.vdChainMonths !== undefined && s.vdChainMonths >= 24) out.push([`lanac v.d. ${s.vdChainMonths} mes.`, "signal"])
	if (s.nwpCount) out.push([`bez objave ${s.nwpCount}${s.nwpShare !== undefined ? ` · ${pct(s.nwpShare)}` : ""}`, s.nwpShare > 0.05 ? "signal" : "paznja"])
	if (s.iwFlags) out.push([`IW ${s.iwFlags}`, "paznja"])
	if (s.driReports) out.push([`DRI ${s.driReports}${s.driQualified ? ` · ${s.driQualified} sa rezervom` : ""}`, s.driQualified ? "paznja" : "info"])
	return out
}

const STATUS = {
	queued: ["idle", "čeka"],
	running: ["running", "radi"],
	done: ["done", "gotovo"],
	error: ["error", "greška"],
}

function sortedRows() {
	const list = [...state.mapa.rows.values()]
	for (const r of list) if (!order.has(r.slug)) order.set(r.slug, order.size)
	const rank = (r) => (r.status === "error" ? 0 : 1)
	return list.sort((a, b) => rank(b) - rank(a) || b.score - a.score || order.get(a.slug) - order.get(b.slug))
}

function buildRow(slug) {
	const parts = {
		rk: h("span", { class: "rk" }, "·"),
		name: h("b", { class: "mn" }),
		sub: h("small", { class: "ms" }),
		num: h("span", { class: "num" }, "0"),
		bar: h("i"),
		chips: h("div", { class: "mchips" }),
		stat: h("span", { class: "stat idle" }, h("i"), "čeka"),
		toggle: h("button", { class: "link-btn mtoggle", type: "button", "aria-expanded": "false" }, "Detalji"),
		detail: h("div", { class: "mdetail" }),
	}
	const main = h(
		"div",
		{ class: "mrow-main" },
		parts.rk,
		h("div", { class: "mname" }, parts.name, parts.sub),
		h("div", { class: "mscore" }, parts.num, h("div", { class: "bar" }, parts.bar)),
		parts.chips,
		parts.stat,
		parts.toggle,
	)
	const root = h("div", { class: "mrow", dataset: { slug }, role: "row" }, main, parts.detail)
	const toggle = () => {
		if (open.has(slug)) open.delete(slug)
		else open.add(slug)
		rows.get(slug).sig = ""
		schedule()
	}
	parts.toggle.addEventListener("click", toggle)
	main.addEventListener("dblclick", toggle)
	return { root, parts, sig: "" }
}

function detailNodes(r) {
	const nodes = []
	if (r.status === "error") nodes.push(h("p", { class: "m-err" }, `Greška: ${r.error || "trijaža nije uspela"}`))
	if (r.summary) nodes.push(h("p", { class: "m-sum" }, r.summary))
	if (r.reasons?.length) nodes.push(h("ul", { class: "m-reasons" }, r.reasons.map((x) => h("li", null, x))))
	else if (r.status !== "error") nodes.push(h("p", { class: "m-none" }, r.status === "done" ? "Nijedan signal nije prešao prag; ocena 0." : "Agent još proverava izvore…"))
	if (r.sources?.length) nodes.push(sourceLinks(r.sources))
	const busy = mapaRunning()
	nodes.push(
		h(
			"div",
			{ class: "m-actions" },
			h("button", { class: "btn small primary", type: "button", disabled: busy, title: busy ? "Sačekaj da se mapa završi" : "Pokreće pun dosije za ovu instituciju", onclick: () => openDosije(r) }, "Otvori dosije"),
			r.resolvedName && r.resolvedName !== r.name ? h("span", { class: "m-resolved" }, `razrešeno kao: ${r.resolvedName}`) : null,
		),
	)
	return nodes
}

async function openDosije(r) {
	try {
		await api.start(r.name)
		setView("dosije")
	} catch (e) {
		showNotice(el.notice, { text: `Dosije nije pokrenut. ${e.message}` })
	}
}

function updateRow(rec, r, rank, max) {
	const busy = mapaRunning()
	const sig = JSON.stringify([r, rank, max, open.has(r.slug), busy])
	if (rec.sig === sig) return
	rec.sig = sig
	const p = rec.parts
	const [cls, text] = STATUS[r.status] || STATUS.queued
	rec.root.dataset.status = r.status
	rec.root.classList.toggle("open", open.has(r.slug))
	p.rk.textContent = r.status === "done" ? String(rank) : "·"
	p.name.textContent = r.name
	p.sub.textContent = r.status === "error" ? "" : r.summary ? "" : r.status === "running" ? "agent proverava izvore" : r.status === "queued" ? "u redu" : ""
	p.num.textContent = fmtNum(r.score)
	p.bar.style.width = `${Math.min(100, (r.score / max) * 100)}%`
	p.chips.replaceChildren(...chipsOf(r.signals).map(([t, tone]) => h("span", { class: `chip ${tone}` }, t)))
	p.stat.className = `stat ${cls}`
	p.stat.replaceChildren(h("i"), text)
	p.toggle.textContent = open.has(r.slug) ? "Sakrij" : "Detalji"
	p.toggle.setAttribute("aria-expanded", String(open.has(r.slug)))
	p.toggle.setAttribute("aria-label", `${open.has(r.slug) ? "Sakrij detalje" : "Detalji"}: ${r.name}`)
	p.detail.hidden = !open.has(r.slug)
	if (open.has(r.slug)) p.detail.replaceChildren(...detailNodes(r))
}

function renderTable() {
	const list = sortedRows()
	const max = Math.max(MAX_SCORE, ...list.map((r) => r.score))
	const els = []
	let rank = 0
	for (const r of list) {
		let rec = rows.get(r.slug)
		if (!rec) {
			rec = buildRow(r.slug)
			rows.set(r.slug, rec)
		}
		if (r.status === "done") rank++
		updateRow(rec, r, rank, max)
		els.push(rec.root)
	}
	for (const [slug, rec] of rows) {
		if (!state.mapa.rows.has(slug)) {
			rec.root.remove()
			rows.delete(slug)
		}
	}
	if (!els.length) {
		el.rows.replaceChildren(h("div", { class: "empty-line" }, "Još nema mape. Pokreni je dugmetom iznad: institucije se pojavljuju ovde, a Trijaža agenti rade u koloni „Tim“."))
		return
	}
	const cur = [...el.rows.children]
	const same = cur.length === els.length && cur.every((n, i) => n === els[i])
	if (!same) el.rows.replaceChildren(...els)
}

function renderChrome() {
	const view = state.ui.view === "mapa"
	el.panel.hidden = !view
	el.dosije.hidden = view
	el.btn.classList.toggle("active", view)
	el.btn.setAttribute("aria-pressed", String(view))

	const mapa = state.mapa
	const list = [...mapa.rows.values()]
	const done = list.filter((r) => r.status === "done" || r.status === "error").length
	const live = mapaRunning()
	const status = mapa.status === "idle" || !mapa.id ? "idle" : live ? "running" : "done"
	el.status.className = `stat ${status}`
	el.status.replaceChildren(h("i"), { idle: "čeka", running: "u toku", done: "završeno" }[status])

	el.input.disabled = live
	el.run.disabled = live
	el.run.textContent = live ? "Mapa radi…" : list.length ? "Pokreni ponovo" : "Pokreni mapu"
	const compact = list.length > 0 && !editing
	el.form.classList.toggle("compact", compact)
	el.edit.hidden = !compact || live
	if (!dirty && !live && document.activeElement !== el.input) {
		const preset = (state.config?.mapaPreset || []).map((p) => p.name).join("\n")
		if (preset && el.input.value !== preset) el.input.value = preset
	}
	let text = ""
	if (list.length && state.runKind === "mapa") {
		text = live ? `${done}/${list.length} gotovo · ${activeCount()} agenata radi istovremeno` : `${done}/${list.length} gotovo · vrhunac ${peakCount()} agenata istovremeno · ${fmtElapsed(elapsedMs())}`
	}
	el.progress.textContent = text
}

function render() {
	renderChrome()
	if (state.ui.view === "mapa") renderTable()
}
const schedule = createScheduler(render)

async function run(e) {
	e?.preventDefault()
	const names = el.input.value
		.split(/\r?\n/)
		.map((s) => s.trim())
		.filter(Boolean)
	if (!names.length) {
		el.input.focus()
		return
	}
	await startMapa(names)
}

/** POST /api/mapa; a refusal stays visible under the form, with a one-click way out when a case is still running. */
async function startMapa(names) {
	clearNotice(el.notice)
	el.run.disabled = true
	try {
		await api.mapa(names)
		dirty = false
		editing = false
	} catch (err) {
		el.run.disabled = false
		const actions = []
		if (err.status === 409 && caseBusy()) actions.push({ label: "Završi dosije pa pokreni mapu", onClick: () => finishCaseThen(el.notice, () => startMapa(names)) })
		showNotice(el.notice, { text: `Mapa nije pokrenuta. ${err.message}`, actions })
	}
}

export function initMapa() {
	el = {
		btn: document.getElementById("btnMapa"),
		panel: document.getElementById("mapaPanel"),
		dosije: document.getElementById("dosijePanel"),
		back: document.getElementById("btnMapaBack"),
		form: document.getElementById("mapaForm"),
		input: document.getElementById("mapaInput"),
		run: document.getElementById("btnMapaRun"),
		preset: document.getElementById("btnMapaPreset"),
		edit: document.getElementById("btnMapaEdit"),
		notice: document.getElementById("mapaNotice"),
		rows: document.getElementById("mapaRows"),
		status: document.getElementById("mapaStatus"),
		progress: document.getElementById("mapaProgress"),
	}
	el.btn.addEventListener("click", () => setView(state.ui.view === "mapa" ? "dosije" : "mapa"))
	el.back.addEventListener("click", () => setView("dosije"))
	el.form.addEventListener("submit", run)
	el.input.addEventListener("input", () => {
		dirty = true
	})
	el.edit.addEventListener("click", () => {
		editing = true
		schedule()
		el.input.focus()
	})
	el.preset.addEventListener("click", () => {
		editing = true
		dirty = false
		el.input.value = (state.config?.mapaPreset || []).map((p) => p.name).join("\n")
	})
	for (const t of ["mapa", "view", "snapshot", "meta", "agents"]) on(t, schedule)
	on("snapshot", ({ newCase }) => {
		if (newCase) {
			for (const rec of rows.values()) rec.root.remove()
			rows.clear()
			order.clear()
			open.clear()
		}
		schedule()
	})
	setInterval(() => {
		if (state.ui.view === "mapa" && mapaRunning()) renderChrome()
	}, 500)
	schedule()
}
