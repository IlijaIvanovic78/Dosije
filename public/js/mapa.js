// "Mapa prioriteta": a list of institutions triaged by parallel "Trijaža" agents, shown as a live ranking table
// ("gde prvo gledati"). Rows re-sort with a FLIP animation as scores arrive; the left "Tim uživo" column shows the agents.

import { h, createScheduler, safeUrl, sourceChipLabel, fmtNum, fmtElapsed } from "./format.js"
import { state, on, setView, activeCount, peakCount, elapsedMs } from "./store.js"
import { api } from "./api.js"
import { toast } from "./toast.js"

const MAX_SCORE = 100 // bar scale: at least 100 points, or the highest score on screen
const rows = new Map() // slug -> { root, parts, sig }
const open = new Set()
const order = new Map() // slug -> first-seen index (stable tie-break)
let el = {}
let dirty = false

const pct = (share) => `${(Math.round(share * 1000) / 10).toLocaleString("sr-RS")}%`

function mapaRunning() {
	return state.runKind === "mapa" && state.mapa.status === "running"
}

/** Signal chips of a row: [text, tone] (tone: signal = red, paznja = amber, info = blue). */
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
	running: ["think", "radi…"],
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
		pill: h("span", { class: "pill idle" }, "čeka"),
		toggle: h("button", { class: "link-btn mtoggle", type: "button", "aria-expanded": "false" }, "Detalji ▾"),
		detail: h("div", { class: "mdetail" }),
	}
	const main = h(
		"div",
		{ class: "mrow-main" },
		parts.rk,
		h("div", { class: "mname" }, parts.name, parts.sub),
		h("div", { class: "mscore" }, parts.num, h("div", { class: "bar" }, parts.bar)),
		parts.chips,
		parts.pill,
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
	if (r.sources?.length) {
		nodes.push(
			h(
				"div",
				{ class: "f-sources" },
				r.sources.map((src) => {
					const url = safeUrl(src.url)
					const cls = `src${src.official ? " official" : ""}`
					const label = sourceChipLabel(src)
					return url ? h("a", { class: cls, href: url, target: "_blank", rel: "noopener noreferrer", title: src.title }, label, h("i", { class: "ext" }, "↗")) : h("span", { class: cls, title: src.title }, label)
				}),
			),
		)
	}
	const busy = mapaRunning()
	nodes.push(
		h(
			"div",
			{ class: "m-actions" },
			h("button", { class: "btn small primary", type: "button", disabled: busy, title: busy ? "Sačekaj da se mapa završi" : "Pokreće pun dosije za ovu instituciju", onclick: () => openDosije(r) }, "Otvori dosije →"),
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
		toast({ kind: "error", title: "Dosije nije pokrenut", text: e.message })
	}
}

function updateRow(rec, r, rank, max) {
	const busy = mapaRunning()
	const sig = JSON.stringify([r, rank, max, open.has(r.slug), busy])
	if (rec.sig === sig) return
	rec.sig = sig
	const p = rec.parts
	const [pillClass, pillText] = STATUS[r.status] || STATUS.queued
	rec.root.dataset.status = r.status
	rec.root.classList.toggle("open", open.has(r.slug))
	p.rk.textContent = r.status === "done" ? String(rank) : "·"
	p.name.textContent = r.name
	p.sub.textContent = r.status === "error" ? "" : r.summary ? "" : r.status === "running" ? "agent proverava izvore" : r.status === "queued" ? "u redu" : ""
	p.num.textContent = fmtNum(r.score)
	p.bar.style.width = `${Math.min(100, (r.score / max) * 100)}%`
	p.bar.dataset.tone = r.score >= 80 ? "hi" : r.score >= 50 ? "mid" : "lo"
	p.chips.replaceChildren(...chipsOf(r.signals).map(([text, tone]) => h("span", { class: `tag code ${tone}` }, text)))
	p.pill.className = `pill ${pillClass}`
	p.pill.textContent = pillText
	p.toggle.textContent = open.has(r.slug) ? "Sakrij ▴" : "Detalji ▾"
	p.toggle.setAttribute("aria-expanded", String(open.has(r.slug)))
	p.detail.hidden = !open.has(r.slug)
	if (open.has(r.slug)) p.detail.replaceChildren(...detailNodes(r))
}

function renderTable() {
	const list = sortedRows()
	const max = Math.max(MAX_SCORE, ...list.map((r) => r.score))
	const before = new Map()
	for (const [slug, rec] of rows) if (rec.root.isConnected) before.set(slug, rec.root.getBoundingClientRect().top)

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
		el.rows.replaceChildren(h("div", { class: "empty-list" }, "Još nema mape. Pokreni je dugmetom iznad: institucije se pojavljuju ovde, a Trijaža agenti rade u koloni „Tim uživo“."))
		return
	}
	// reorder the DOM, then FLIP: every row slides from its old position to the new one
	const cur = [...el.rows.children]
	const same = cur.length === els.length && cur.every((n, i) => n === els[i])
	if (!same) {
		el.rows.replaceChildren(...els)
		for (const [slug, rec] of rows) {
			const was = before.get(slug)
			if (was === undefined) continue
			const dy = was - rec.root.getBoundingClientRect().top
			if (Math.abs(dy) < 2) continue
			rec.root.style.transition = "none"
			rec.root.style.transform = `translateY(${dy}px)`
			rec.root.classList.add("moving")
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					rec.root.style.transition = ""
					rec.root.style.transform = ""
				})
			})
			setTimeout(() => rec.root.classList.remove("moving"), 700)
		}
	}
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
	el.status.className = `status-pill ${status}`
	el.status.replaceChildren(h("i"), { idle: "čeka", running: "u toku", done: "završeno" }[status])

	el.input.disabled = live
	el.run.disabled = live
	el.run.textContent = live ? "Mapa radi…" : "Pokreni mapu"
	el.run.classList.toggle("busy", live)
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
		el.input.classList.remove("shake")
		void el.input.offsetWidth
		el.input.classList.add("shake")
		return
	}
	el.run.disabled = true
	try {
		await api.mapa(names)
		dirty = false
	} catch (err) {
		toast({ kind: "error", title: "Mapa nije pokrenuta", text: err.message })
		el.run.disabled = false
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
	el.preset.addEventListener("click", () => {
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
