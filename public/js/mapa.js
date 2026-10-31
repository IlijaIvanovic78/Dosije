// "Poređenje institucija": a list of institutions triaged by parallel "Trijaža" agents, shown as a live ranking table
// ("gde prvo gledati"). Rows are re-sorted in place as scores arrive; the left "Tim" column shows the agents.

import { h, createScheduler, sourceLinks, truncate, fmtNum, fmtElapsed } from "./format.js"
import { state, on, setView, activeCount, peakCount, elapsedMs } from "./store.js"
import { api } from "./api.js"
import { showNotice, clearNotice, finishCaseThen, caseBusy } from "./notice.js"
import { t, tx, pl, getLang, langKey, onLang } from "./i18n.js"

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
	if (s.vdMonths !== undefined && s.vdLimitMonths !== undefined) out.push([t("v.d. {m} mes. (rok {lim})", { m: s.vdMonths, lim: s.vdLimitMonths }), s.vdOver ? "signal" : "info"])
	if (s.vdChainMonths !== undefined && s.vdChainMonths >= 24) out.push([t("niz v.d. {m} mes.", { m: s.vdChainMonths }), "signal"])
	if (s.nwpCount) out.push([`${t("bez objave")}: ${s.nwpCount}${s.nwpShare !== undefined ? ` (${pct(s.nwpShare)})` : ""}`, s.nwpShare > 0.05 ? "signal" : "paznja"])
	if (s.iwFlags) out.push([`Integrity Watch: ${s.iwFlags}`, "paznja"])
	if (s.driReports) out.push([`DRI: ${s.driReports}${s.driQualified ? `, ${t("{n} sa rezervom", { n: s.driQualified })}` : ""}`, s.driQualified ? "paznja" : "info"])
	return out
}

const STATUS = {
	queued: ["idle", "čeka"],
	running: ["running", "proverava"],
	done: ["done", "gotovo"],
	error: ["error", "nije provereno"],
}

// the four areas of a score, in the order of the criteria strip above the table
const AREAS = [
	{ id: "rukovodstvo", label: "Rukovodstvo", re: /v\.d\.|lanac|acting head/i },
	{ id: "nabavke", label: "Nabavke", re: /bez objave|dobavlja[čc]|integrity watch|ozna[čc]en|published call|supplier/i },
	{ id: "revizija", label: "Revizija", re: /DRI|mi[šs]ljen|revizij|audit/i },
	{ id: "veze", label: "Zajednički dobavljači", re: /isti dobavlja|same supplier/i },
]
const areaOf = (reason) => (AREAS.find((a) => a.id === "veze" && a.re.test(reason)) || AREAS.find((a) => a.re.test(reason)))?.id

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
		bar: h("div", { class: "bar", role: "img" }, ...AREAS.map((a) => h("i", { dataset: { area: a.id } }))),
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
		h("div", { class: "mscore" }, parts.num, parts.bar),
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
	parts.toggle.addEventListener("click", (e) => {
		e.stopPropagation()
		toggle()
	})
	main.addEventListener("click", toggle)
	return { root, parts, sig: "" }
}

/** The details of one institution: why it got its score, area by area, with the sources and a way into its full dossier. */
function detailNodes(r) {
	const nodes = []
	if (r.status === "error") nodes.push(h("p", { class: "m-err" }, `${t("Institucija nije proverena")}: ${tx(r.error) || t("provera nije uspela")}`))
	if (r.alternatives?.length && r.resolvedName)
		nodes.push(h("p", { class: "m-sum" }, t("Naziv odgovara i drugim ustanovama ({list}); izabrana je {name}.", { list: r.alternatives.join("; "), name: r.resolvedName })))
	if (r.summary) nodes.push(h("p", { class: "m-sum" }, tx(r.summary)))
	const reasons = r.reasons || []
	if (reasons.length) {
		const gaps = reasons.filter((x) => /^nema podataka/i.test(x))
		nodes.push(
			h(
				"div",
				{ class: "m-areas" },
				AREAS.map((a) => {
					const mine = reasons.filter((x) => !gaps.includes(x) && areaOf(x) === a.id)
					const pts = r.parts?.[a.id] ?? 0
					return h(
						"div",
						{ class: "m-area", dataset: { area: a.id } },
						h("h5", null, t(a.label), h("span", null, t("{n} b.", { n: fmtNum(pts) }))),
						mine.length ? h("ul", { class: "m-reasons" }, mine.map((x) => h("li", null, tx(x)))) : h("p", { class: "m-none" }, t("nijedan signal iznad praga")),
					)
				}),
			),
		)
		if (gaps.length) nodes.push(h("p", { class: "m-none" }, gaps.map((g) => tx(g)).join(" · ")))
	} else if (r.status !== "error") nodes.push(h("p", { class: "m-none" }, r.status === "done" ? t("Nijedan signal nije prešao prag: ocena je 0.") : t("Agent još proverava izvore…")))
	if (r.sources?.length) nodes.push(sourceLinks(r.sources))
	const busy = mapaRunning()
	nodes.push(
		h(
			"div",
			{ class: "m-actions" },
			h("button", { class: "btn small primary", type: "button", disabled: busy, title: busy ? t("Sačekajte da se poređenje završi") : t("Pokreće pun dosije za ovu instituciju"), onclick: () => openDosije(r) }, t("Otvorite pun dosije")),
			r.resolvedName && r.resolvedName !== r.name ? h("span", { class: "m-resolved" }, `${t("u registrima")}: ${r.resolvedName}`) : null,
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
	p.sub.textContent = r.status === "error" ? "" : picked || (r.summary ? "" : r.status === "running" ? t("agent proverava izvore") : r.status === "queued" ? t("čeka na red") : "")
	p.num.replaceChildren(fmtNum(r.score), h("small", null, t("bodova")))
	// the bar is the score split by area, on a common scale for all rows
	const parts = r.parts || { rukovodstvo: r.score, nabavke: 0, revizija: 0, veze: 0 }
	for (const seg of p.bar.children) seg.style.width = `${Math.min(100, ((parts[seg.dataset.area] || 0) / max) * 100)}%`
	p.bar.setAttribute("aria-label", AREAS.map((a) => `${t(a.label)} ${parts[a.id] || 0}`).join(", "))
	p.bar.title = AREAS.filter((a) => parts[a.id]).map((a) => `${t(a.label)}: ${parts[a.id]}`).join(" · ") || t("bez bodova")
	const chips = chipsOf(r.signals)
	for (const v of shared) chips.push([t("isti dobavljač: {name}", { name: truncate(v.name, 28) }), "paznja"])
	p.chips.replaceChildren(...chips.map(([txt, tone]) => h("span", { class: `chip ${tone}`, title: txt }, txt)))
	p.stat.className = `stat ${cls}`
	p.stat.replaceChildren(h("i"), t(text))
	p.toggle.textContent = open.has(r.slug) ? t("Sakrijte") : t("Detalji")
	p.toggle.setAttribute("aria-expanded", String(open.has(r.slug)))
	p.toggle.setAttribute("aria-label", `${open.has(r.slug) ? t("Sakrijte detalje") : t("Detalji")}: ${r.name}`)
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
		el.rows.replaceChildren(h("div", { class: "empty-line" }, t("Rang-lista se pojavljuje ovde. Pokrenite poređenje: institucije se rangiraju čim ih agenti provere, a njihov rad pratite u koloni „Tim agenata“.")))
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
	el.status.replaceChildren(h("i"), t({ idle: "nije pokrenuto", running: "provera traje", done: "rang-lista je gotova" }[status]))

	el.run.disabled = live
	el.run.textContent = live ? t("Provera traje…") : list.length ? t("Pokrenite ponovo") : t("Pokrenite poređenje")
	const compact = list.length > 0 && !editing
	el.form.classList.toggle("compact", compact)
	el.edit.hidden = !compact || live
	// the list starts with the current institutions (the preset) until the user changes it
	if (!dirty && !live && !names.length) {
		names = (state.config?.mapaPreset || []).map((p) => p.name)
		renderList()
	}
	for (const inp of el.list.querySelectorAll("input")) inp.disabled = live
	const summary = compact ? t("Upoređuje se {n}: {list}", { n: `${list.length} ${pl(list.length, ["institucija", "institucije", "institucija"], ["institution", "institutions"])}`, list: list.map((r) => r.resolvedName || r.name).join(", ") }) : ""
	if (el.summary.textContent !== summary) el.summary.textContent = summary
	el.summary.hidden = !compact
	let text = ""
	if (list.length && state.runKind === "mapa") {
		const n = activeCount()
		const peak = peakCount()
		if (live) text = getLang() === "en" ? `${done} of ${list.length} checked · ${n} ${pl(n, [], ["agent", "agents"])} working now` : `${done} od ${list.length} provereno · ${n} ${pl(n, ["agent radi", "agenta rade", "agenata radi"])} sada`
		else text = getLang() === "en" ? `${done} of ${list.length} checked · at most ${peak} ${pl(peak, [], ["agent", "agents"])} at once · ${fmtElapsed(elapsedMs())}` : `${done} od ${list.length} provereno · najviše ${peak} ${pl(peak, ["agent", "agenta", "agenata"])} istovremeno · ${fmtElapsed(elapsedMs())}`
	}
	el.progress.textContent = text
}

function render() {
	renderChrome()
	if (state.ui.view === "mapa") renderTable()
}
const schedule = createScheduler(render)

// ─── the list of institutions: one field per name (at most 8), or one box to paste a whole list ───

const MAX_INST = 8
let names = []
let pasting = false

function cleanNames(list) {
	return [...new Set(list.map((x) => x.trim()).filter(Boolean))].slice(0, MAX_INST)
}

function readList() {
	return pasting ? el.input.value.split(/\r?\n/) : [...el.list.querySelectorAll("input")].map((i) => i.value)
}

function renderList(focusIndex) {
	const shown = names.length ? names : [""]
	el.list.replaceChildren(
		...shown.map((name, i) => {
			const input = h("input", { type: "text", value: name, title: name || null, placeholder: i === 0 ? t("npr. Srbijavoz") : t("još jedna institucija"), "aria-label": t("Institucija {n}", { n: i + 1 }), spellcheck: "false" })
			input.addEventListener("input", () => {
				dirty = true
				names = readList()
				input.title = input.value
			})
			input.addEventListener("keydown", (e) => {
				// Enter in the last field adds the next one (Ctrl+Enter starts the map)
				if (e.key !== "Enter" || e.ctrlKey || e.metaKey) return
				e.preventDefault()
				addRow(i + 1)
			})
			return h(
				"li",
				{ class: "inst-row" },
				h("span", { class: "inst-n", "aria-hidden": "true" }, String(i + 1)),
				input,
				h("button", { class: "inst-x", type: "button", title: t("Uklonite"), "aria-label": t("Uklonite instituciju {n}", { n: i + 1 }), onclick: () => removeRow(i) }, "×"),
			)
		}),
	)
	el.add.hidden = pasting || shown.length >= MAX_INST
	if (focusIndex !== undefined) el.list.querySelectorAll("input")[focusIndex]?.focus()
}

function addRow(at) {
	names = readList()
	if (names.length >= MAX_INST) return
	names.splice(at ?? names.length, 0, "")
	dirty = true
	renderList(at ?? names.length - 1)
}

function removeRow(i) {
	names = readList()
	names.splice(i, 1)
	dirty = true
	renderList()
}

function togglePaste() {
	if (pasting) {
		names = cleanNames(el.input.value.split(/\r?\n/))
		pasting = false
	} else {
		el.input.value = cleanNames(readList()).join("\n")
		pasting = true
	}
	el.input.hidden = !pasting
	el.list.hidden = pasting
	el.paste.textContent = pasting ? t("Prikažite kao listu") : t("Nalepite listu")
	renderList()
	if (pasting) el.input.focus()
}

async function run(e) {
	e?.preventDefault()
	const list = cleanNames(readList())
	if (!list.length) {
		;(pasting ? el.input : el.list.querySelector("input"))?.focus()
		return
	}
	await startMapa(list)
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
		if (err.status === 409 && caseBusy()) actions.push({ label: t("Završite dosije pa pokrenite poređenje"), onClick: () => finishCaseThen(el.notice, () => startMapa(names)) })
		showNotice(el.notice, { text: `${t("Poređenje nije pokrenuto.")} ${err.message}`, actions })
	}
}

export function initMapa() {
	el = {
		btn: document.getElementById("btnMapa"),
		panel: document.getElementById("mapaPanel"),
		dosije: document.getElementById("dosijePanel"),
		form: document.getElementById("mapaForm"),
		input: document.getElementById("mapaInput"),
		list: document.getElementById("mapaList"),
		add: document.getElementById("btnMapaAdd"),
		paste: document.getElementById("btnMapaPaste"),
		summary: document.querySelector("#mapaForm .mapa-form-head").appendChild(h("span", { class: "mapa-summary", hidden: true })),
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
	el.input.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) run(e)
	})
	el.add.addEventListener("click", () => addRow())
	el.paste.addEventListener("click", togglePaste)
	el.edit.addEventListener("click", () => {
		editing = true
		names = [...state.mapa.rows.values()].map((r) => r.name)
		renderList(0)
		schedule()
	})
	el.preset.addEventListener("click", () => {
		editing = true
		dirty = true
		names = (state.config?.mapaPreset || []).map((p) => p.name)
		if (pasting) el.input.value = names.join("\n")
		renderList()
		schedule()
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
	onLang(() => {
		for (const rec of rows.values()) rec.sig = ""
		schedule()
	})
	setInterval(() => {
		if (state.ui.view === "mapa" && mapaRunning()) renderChrome()
	}, 500)
	schedule()
}
