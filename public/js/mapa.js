// "Mapa prioriteta": a list of institutions triaged by parallel "Trijaža" agents, shown as a live ranking table
// ("gde prvo gledati"). Rows are re-sorted in place as scores arrive; the left "Tim" column shows the agents.

import { h, createScheduler, sourceLinks, truncate, fmtNum, fmtElapsed } from "./format.js"
import { state, on, setView, activeCount, peakCount, elapsedMs } from "./store.js"
import { api } from "./api.js"
import { showNotice, clearNotice, finishCaseThen, caseBusy } from "./notice.js"
import { t, tx, pl, getLang, langKey, onLang, onTx } from "./i18n.js"

const MAX_SCORE = 100 // bar scale: at least 100 points, or the highest score on screen
const rows = new Map() // slug -> { root, parts, sig }
const open = new Set()
const order = new Map() // slug -> first-seen index (stable tie-break)
let el = {}
let dirty = false
let editing = false

const pct = (share) => `${(Math.round(share * 1000) / 10).toLocaleString(getLang() === "en" ? "en-US" : "sr-RS")}%`

function mapaRunning() {
	return state.runKind === "mapa" && state.mapa.status === "running"
}

/** Signal chips of a row: [text, tone] (tone: signal = red, paznja = amber, info = gray). */
export function chipsOf(s = {}) {
	const out = []
	if (s.vdMonths !== undefined && s.vdLimitMonths !== undefined) out.push([t("v.d. {m}/{lim} mes.", { m: s.vdMonths, lim: s.vdLimitMonths }), s.vdOver ? "signal" : "info"])
	if (s.vdChainMonths !== undefined && s.vdChainMonths >= 24) out.push([t("lanac v.d. {m} mes.", { m: s.vdChainMonths }), "signal"])
	if (s.nwpCount) out.push([`${t("bez objave")} ${s.nwpCount}${s.nwpShare !== undefined ? ` · ${pct(s.nwpShare)}` : ""}`, s.nwpShare > 0.05 ? "signal" : "paznja"])
	if (s.iwFlags) out.push([`IW ${s.iwFlags}`, "paznja"])
	if (s.driReports) out.push([`DRI ${s.driReports}${s.driQualified ? ` · ${t("{n} sa rezervom", { n: s.driQualified })}` : ""}`, s.driQualified ? "paznja" : "info"])
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
		stat: h("span", { class: "stat idle" }, h("i"), t("čeka")),
		toggle: h("button", { class: "link-btn mtoggle", type: "button", "aria-expanded": "false" }, t("Detalji")),
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
	if (r.status === "error") nodes.push(h("p", { class: "m-err" }, `${t("Greška")}: ${tx(r.error) || t("trijaža nije uspela")}`))
	if (r.alternatives?.length && r.resolvedName)
		nodes.push(h("p", { class: "m-sum" }, t("Naziv odgovara i drugim ustanovama ({list}); izabrana je {name}.", { list: r.alternatives.join("; "), name: r.resolvedName })))
	if (r.summary) nodes.push(h("p", { class: "m-sum" }, tx(r.summary)))
	if (r.reasons?.length) nodes.push(h("ul", { class: "m-reasons" }, r.reasons.map((x) => h("li", null, tx(x)))))
	else if (r.status !== "error") nodes.push(h("p", { class: "m-none" }, r.status === "done" ? t("Nijedan signal nije prešao prag; ocena 0.") : t("Agent još proverava izvore…")))
	if (r.sources?.length) nodes.push(sourceLinks(r.sources))
	const busy = mapaRunning()
	nodes.push(
		h(
			"div",
			{ class: "m-actions" },
			h("button", { class: "btn small primary", type: "button", disabled: busy, title: busy ? t("Sačekaj da se mapa završi") : t("Pokreće pun dosije za ovu instituciju"), onclick: () => openDosije(r) }, t("Otvori dosije")),
			r.resolvedName && r.resolvedName !== r.name ? h("span", { class: "m-resolved" }, `${t("razrešeno kao")}: ${r.resolvedName}`) : null,
		),
	)
	return nodes
}

async function openDosije(r) {
	clearNotice(el.notice)
	try {
		await api.start(r.resolvedName || r.name)
		setView("dosije")
	} catch (e) {
		showNotice(el.notice, { text: `${t("Dosije nije pokrenut.")} ${e.message}` })
	}
}

/** Suppliers shared by several institutions: from "mapa.veza" events, or (after a page load) from the rows' sharedSuppliers. */
function vezeList() {
	const out = []
	const seen = new Set()
	for (const v of state.mapa.veze.values()) {
		seen.add(v.key)
		out.push({ key: v.key, name: v.supplier?.name || v.key, n: v.institutions?.length || 0, slugs: new Set((v.institutions || []).map((i) => i.slug)), line: v.line })
	}
	const derived = new Map()
	for (const r of state.mapa.rows.values()) {
		for (const s of r.signals?.sharedSuppliers || []) {
			const key = s.pib || String(s.name).toLowerCase()
			if (seen.has(key)) continue
			const d = derived.get(key) || { key, name: s.name, n: s.institutions, slugs: new Set(), line: "" }
			d.slugs.add(r.slug)
			derived.set(key, d)
		}
	}
	return [...out, ...derived.values()].filter((v) => v.n >= 2)
}

function vezaLine(v) {
	if (getLang() === "en") return `Same supplier in ${v.n} institutions: ${v.name}`
	return v.line || `Isti dobavljač u ${v.n} ${pl(v.n, ["instituciji", "institucije", "institucija"])}: ${v.name}`
}

function updateRow(rec, r, rank, max, shared) {
	const busy = mapaRunning()
	const sig = JSON.stringify([langKey(), r, rank, max, open.has(r.slug), busy, shared.map((v) => v.key)])
	if (rec.sig === sig) return
	rec.sig = sig
	const p = rec.parts
	const [cls, text] = STATUS[r.status] || STATUS.queued
	rec.root.dataset.status = r.status
	rec.root.classList.toggle("open", open.has(r.slug))
	// a provisional rank appears as soon as the row has a score; it only becomes firm when the row is done
	p.rk.textContent = rank ? String(rank) : "·"
	p.rk.classList.toggle("prov", !!rank && r.status !== "done")
	p.name.textContent = r.name
	const picked = r.alternatives?.length && r.resolvedName ? `→ ${r.resolvedName}` : ""
	p.sub.textContent = r.status === "error" ? "" : picked || (r.summary ? "" : r.status === "running" ? t("agent proverava izvore") : r.status === "queued" ? t("u redu") : "")
	p.num.textContent = fmtNum(r.score)
	p.bar.style.width = `${Math.min(100, (r.score / max) * 100)}%`
	const chips = chipsOf(r.signals)
	for (const v of shared) chips.push([t("isti dobavljač: {name}", { name: truncate(v.name, 24) }), "paznja"])
	p.chips.replaceChildren(...chips.map(([txt, tone]) => h("span", { class: `chip ${tone}`, title: txt }, txt)))
	p.stat.className = `stat ${cls}`
	p.stat.replaceChildren(h("i"), t(text))
	p.toggle.textContent = open.has(r.slug) ? t("Sakrij") : t("Detalji")
	p.toggle.setAttribute("aria-expanded", String(open.has(r.slug)))
	p.toggle.setAttribute("aria-label", `${open.has(r.slug) ? t("Sakrij detalje") : t("Detalji")}: ${r.name}`)
	p.detail.hidden = !open.has(r.slug)
	if (open.has(r.slug)) p.detail.replaceChildren(...detailNodes(r))
}

function renderTable() {
	const list = sortedRows()
	const max = Math.max(MAX_SCORE, ...list.map((r) => r.score))
	const els = []
	let rank = 0
	const veze = vezeList()
	const vezaSig = veze.map((v) => `${v.key}:${v.n}:${getLang()}`).join("|")
	if (el.veza.dataset.sig !== vezaSig) {
		el.veza.dataset.sig = vezaSig
		el.veza.hidden = veze.length === 0
		el.veza.replaceChildren(...veze.map((v) => h("div", null, vezaLine(v))))
	}
	for (const r of list) {
		let rec = rows.get(r.slug)
		if (!rec) {
			rec = buildRow(r.slug)
			rows.set(r.slug, rec)
		}
		const ranked = r.status !== "error" && (r.status === "done" || r.score > 0)
		if (ranked) rank++
		updateRow(rec, r, ranked ? rank : 0, max, veze.filter((v) => v.slugs.has(r.slug)))
		els.push(rec.root)
	}
	for (const [slug, rec] of rows) {
		if (!state.mapa.rows.has(slug)) {
			rec.root.remove()
			rows.delete(slug)
		}
	}
	if (!els.length) {
		el.rows.replaceChildren(h("div", { class: "empty-line" }, t("Još nema mape. Pokreni je dugmetom iznad: institucije se pojavljuju ovde, a Trijaža agenti rade u koloni „Tim“.")))
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
	el.status.replaceChildren(h("i"), t({ idle: "čeka", running: "u toku", done: "završeno" }[status]))

	el.input.disabled = live
	el.run.disabled = live
	el.run.textContent = live ? t("Mapa radi…") : list.length ? t("Pokreni ponovo") : t("Pokreni mapu")
	const compact = list.length > 0 && !editing
	el.form.classList.toggle("compact", compact)
	el.edit.hidden = !compact || live
	if (!dirty && !live && document.activeElement !== el.input) {
		const preset = (state.config?.mapaPreset || []).map((p) => p.name).join("\n")
		if (preset && el.input.value !== preset) el.input.value = preset
	}
	let text = ""
	if (list.length && state.runKind === "mapa") {
		const n = activeCount()
		const peak = peakCount()
		if (live) text = getLang() === "en" ? `${done}/${list.length} done · ${n} ${pl(n, [], ["agent", "agents"])} working at once` : `${done}/${list.length} gotovo · ${n} ${pl(n, ["agent", "agenta", "agenata"])} ${pl(n, ["radi", "rade", "radi"])} istovremeno`
		else text = getLang() === "en" ? `${done}/${list.length} done · peak: ${peak} ${pl(peak, [], ["agent", "agents"])} at once · ${fmtElapsed(elapsedMs())}` : `${done}/${list.length} gotovo · vrhunac: ${peak} ${pl(peak, ["agent", "agenta", "agenata"])} istovremeno · ${fmtElapsed(elapsedMs())}`
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
		if (err.status === 409 && caseBusy()) actions.push({ label: t("Završi dosije pa pokreni mapu"), onClick: () => finishCaseThen(el.notice, () => startMapa(names)) })
		showNotice(el.notice, { text: `${t("Mapa nije pokrenuta.")} ${err.message}`, actions })
	}
}

export function initMapa() {
	el = {
		btn: document.getElementById("btnMapa"),
		panel: document.getElementById("mapaPanel"),
		dosije: document.getElementById("dosijePanel"),
		form: document.getElementById("mapaForm"),
		input: document.getElementById("mapaInput"),
		run: document.getElementById("btnMapaRun"),
		preset: document.getElementById("btnMapaPreset"),
		edit: document.getElementById("btnMapaEdit"),
		notice: document.getElementById("mapaNotice"),
		veza: document.getElementById("mapaVeza"),
		rows: document.getElementById("mapaRows"),
		status: document.getElementById("mapaStatus"),
		progress: document.getElementById("mapaProgress"),
	}
	el.btn.addEventListener("click", () => setView("mapa"))
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
	for (const ev of ["mapa", "view", "snapshot", "meta", "agents"]) on(ev, schedule)
	on("snapshot", ({ newCase }) => {
		if (newCase) {
			for (const rec of rows.values()) rec.root.remove()
			rows.clear()
			order.clear()
			open.clear()
		}
		schedule()
	})
	onTx(schedule)
	onLang(() => {
		for (const rec of rows.values()) rec.sig = ""
		schedule()
	})
	setInterval(() => {
		if (state.ui.view === "mapa" && mapaRunning()) renderChrome()
	}, 500)
	schedule()
}
