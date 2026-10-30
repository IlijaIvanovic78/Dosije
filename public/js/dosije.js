// "Dosije": the case file as a document: institution header, main signals, entities, section tabs, finding rows.

import { h, reconcile, createScheduler, parseIso, fmtClock, truncate, statusTag, sourceLinks, splitSourceTitle, SECTIONS, SECTION_LABEL, STATUS_LABEL, SIGNAL_LABEL, RULE_LABEL, ROLE_LABEL, SOURCE_LABEL } from "./format.js"
import { state, on, openTasks, setFilter, clearFilters, startFresh } from "./store.js"
import { showNotice, clearNotice } from "./notice.js"
import { openInbox } from "./inbox.js"
import { openReport } from "./report.js"
import { api } from "./api.js"

const SEV_RANK = { signal: 3, paznja: 2, info: 1 }
const STATUS_RANK = { zvanicno: 4, potvrdjeno: 3, nepotvrdjeno: 2, demantovano: 1 }
const SECTION_RANK = { rukovodstvo: 5, novac: 4, firme: 3, revizija: 2, mediji: 1 }
const cards = new Map() // findingId -> { el, sig }
const fresh = new Map() // id -> timestamp (fade in / highlight)
const chipCache = new Map()
let el = {}
let lastInst = ""
let lastSignals = ""
let lastVerify = ""
let lastTabs = ""

function findingSig(f) {
	return [f.title, f.text, f.status, f.severity, f.approval, f.updatedAt, f.note, f.conflictId, f.mergedFrom?.length, f.sources?.length, f.signalCode].join("|")
}

function shortSource(f) {
	const src = f?.sources?.[0]
	if (!src) return "izvor"
	return src.kind === "vesti" ? truncate(splitSourceTitle(src).outlet, 20) : SOURCE_LABEL[src.kind] || src.kind
}

const RULE_WINNER = {
	zvanicni_izvor_ima_prednost: "Prednost ima zvanični registar.",
	vise_izvora: "Prednost ima nalaz sa više izvora.",
	noviji_datum: "Prednost ima noviji podatak.",
}

/** "Zvanični registar (ACAS) navodi «A»; ovaj izvor navodi «B». Prednost ima zvanični registar." */
function conflictNote(f) {
	const c = f.conflictId ? state.conflicts.get(f.conflictId) : null
	if (!c) return null
	const idx = c.findingIds.indexOf(c.winnerFindingId)
	const wi = idx < 0 ? 0 : idx
	const winner = state.findings.get(c.findingIds[wi])
	const other = state.findings.get(c.findingIds[1 - wi])
	const winnerVal = c.values[wi]
	const otherVal = c.values[1 - wi]
	const official = c.rule === "zvanicni_izvor_ima_prednost"
	const first = official ? `Zvanični registar (${shortSource(winner)})` : shortSource(winner)
	const second = f.id === other?.id ? "ovaj izvor" : f.id === winner?.id ? shortSource(other) : "drugi izvor"
	return h("div", { class: "note conflict" }, h("b", null, "Neslaganje izvora: "), `${first} navodi „${winnerVal}“; ${second} navodi „${otherVal}“. ${RULE_WINNER[c.rule] || RULE_LABEL[c.rule] || ""}`)
}

function approvalNote(f) {
	if (f.approval === "pending") return h("span", { class: "appr pending" }, "čeka odobrenje novinara")
	if (f.approval === "approved") return h("span", { class: "appr" }, "odobrio novinar")
	if (f.approval === "rejected") return h("span", { class: "appr rejected" }, "odbio novinar")
	return null
}

function cardChildren(f) {
	const created = parseIso(f.createdAt)
	const merged = f.mergedFrom?.length
	const code = f.signalCode ? SIGNAL_LABEL[f.signalCode] || f.signalCode : f.severity === "signal" ? "signal" : f.severity === "paznja" ? "pažnja" : ""
	const conflict = conflictNote(f)
	return [
		h("div", { class: "f-meta" }, h("span", { class: "sect" }, SECTION_LABEL[f.section] || f.section), code ? h("span", { class: `code ${f.severity}` }, code) : null, statusTag(f.status), approvalNote(f)),
		h("h3", { class: "f-title" }, f.title),
		h("p", { class: "f-text" }, f.text),
		conflict,
		f.note && !conflict ? h("div", { class: "note" }, h("b", null, "Napomena urednika: "), f.note) : null,
		sourceLinks(f.sources, f.id),
		h("div", { class: "f-foot" }, `dodao ${f.agentName || "agent"}`, created ? ` · ${fmtClock(created)}` : "", merged ? ` · spojeno iz ${merged + 1} nalaza` : ""),
	]
}

function ensureCard(f) {
	const sig = findingSig(f)
	let c = cards.get(f.id)
	if (!c) {
		const root = h("article", { class: "finding", dataset: { id: f.id } })
		root.addEventListener("animationend", (e) => {
			if (e.target === root && e.animationName === "hlfade") root.classList.remove("is-new", "flash")
		})
		c = { el: root, sig: "" }
		cards.set(f.id, c)
		if (state.live && fresh.has(f.id)) root.classList.add("is-new")
	}
	if (c.sig !== sig) {
		c.sig = sig
		const keep = ["is-new", "dimmed", "flash"].filter((k) => c.el.classList.contains(k)).join(" ")
		c.el.className = `finding sev-${f.severity} st-${f.status} ${keep}`
		c.el.dataset.agent = f.agentId || ""
		c.el.replaceChildren(...cardChildren(f).filter(Boolean))
	}
	return c
}

function visibleFindings() {
	const sec = state.filters.section
	let list = [...state.findings.values()]
	if (sec !== "all" && sec !== "verify") list = list.filter((f) => f.section === sec)
	if (state.filters.entityId) list = list.filter((f) => f.entityIds?.includes(state.filters.entityId))
	const done = state.status === "done"
	return list.sort((a, b) => (done ? (SEV_RANK[b.severity] || 0) - (SEV_RANK[a.severity] || 0) : 0) || (parseIso(b.createdAt) || 0) - (parseIso(a.createdAt) || 0))
}

function renderInst() {
	const i = state.institution
	const status = state.status
	const sig = JSON.stringify([i, status, state.focus, state.input])
	if (sig === lastInst) return
	lastInst = sig
	const statusLabel = { idle: "čeka", running: "u toku", finalizing: "završava se", done: "završeno" }[status] || status
	const ids = []
	if (i) {
		for (const [lab, v] of [["PIB", i.pib], ["MB", i.mb], ["ACAS", i.acasId], ["JN", i.jnId]]) if (v) ids.push(`${lab} ${v}`)
	}
	const nodes = [
		h("div", { class: "label" }, "Dosije ", h("span", { class: `stat ${status}` }, h("i"), statusLabel)),
		h("h2", { class: "serif-title" }, i?.name || state.input || "Učitavam instituciju…"),
		i?.nameCyr ? h("div", { class: "inst-cyr" }, i.nameCyr) : null,
		i?.legalType ? h("div", { class: "inst-legal" }, i.legalType) : null,
		ids.length ? h("div", { class: "meta-line" }, ids.join(" · ")) : null,
		state.focus ? h("div", { class: "meta-sub" }, h("b", null, "Fokus: "), state.focus) : null,
		state.input && i && state.input !== i.name ? h("div", { class: "meta-sub" }, h("b", null, "Upit: "), truncate(state.input, 140)) : null,
	]
	el.inst.replaceChildren(...nodes.filter(Boolean))
}

function signalRow(n, id, title, f) {
	return h("li", null, h("button", { class: "sig-row", type: "button", onclick: () => focusFinding(id) }, h("span", { class: "sig-n" }, String(n)), h("span", { class: "sig-title" }, title), f ? statusTag(f.status) : null))
}

const expandedGroups = new Set() // signal codes whose grouped row is open
const LEGAL_FORMS = /\b(d\.?o\.?o\.?|a\.?d\.?|beograd|novi sad|doo|ad)\b\.?/gi

/** "KBV DATACOM d.o.o. Beograd" -> "KBV Datacom": drop legal forms, soften all-caps words (3 letters or fewer stay). */
function shortName(name) {
	const words = String(name || "")
		.replace(LEGAL_FORMS, " ")
		.split(/\s+/)
		.filter(Boolean)
		.map((w) => (w.length > 3 && w === w.toUpperCase() && /\p{L}/u.test(w) ? w[0] + w.slice(1).toLowerCase() : w))
	return words.join(" ") || String(name || "")
}

function memberName(f) {
	for (const id of f.entityIds || []) {
		const e = state.entities.get(id)
		if (e && e.kind !== "institucija") return shortName(e.name)
	}
	return shortName(String(f.title || "").split(":")[0])
}

function groupTitle(code, members) {
	const n = members.length
	const names = [...new Set(members.map(memberName))]
	const shown = names.slice(0, 3)
	const rest = names.length - shown.length
	const list = `${shown.join(", ")}${rest > 0 ? `, +${rest}` : ""}`
	if (code === "POLITICKA_VEZA" && members.every((m) => m.sources?.some((s) => s.kind === "integrity_watch"))) return `Integrity Watch Srbija: ${n} dobavljača označeno (${list})`
	const label = SIGNAL_LABEL[code] || code
	return `${label[0].toUpperCase()}${label.slice(1)}: ${n} nalaza (${list})`
}

/** Live signals: findings sharing a signalCode collapse into one row (when 2 or more); max 5 rows. */
function liveSignalRows() {
	const list = [...state.findings.values()].filter((f) => f.severity === "signal" && f.status !== "demantovano" && f.approval !== "rejected")
	const byCode = new Map()
	for (const f of list) if (f.signalCode) (byCode.get(f.signalCode) || byCode.set(f.signalCode, []).get(f.signalCode)).push(f)
	const rows = []
	for (const f of list) {
		const group = f.signalCode ? byCode.get(f.signalCode) : null
		if (group && group.length >= 2) {
			if (group[0] !== f) continue
			const members = [...group].sort((a, b) => (parseIso(a.createdAt) || 0) - (parseIso(b.createdAt) || 0))
			const weakest = members.reduce((w, m) => ((STATUS_RANK[m.status] || 0) < (STATUS_RANK[w.status] || 0) ? m : w), members[0])
			rows.push({ key: f.signalCode, members, status: weakest.status, section: members[0].section, t: Math.max(...members.map((m) => parseIso(m.createdAt) || 0)), title: groupTitle(f.signalCode, members) })
		} else {
			rows.push({ key: f.id, members: [f], status: f.status, section: f.section, t: parseIso(f.createdAt) || 0, title: f.title })
		}
	}
	rows.sort((a, b) => (STATUS_RANK[b.status] || 0) - (STATUS_RANK[a.status] || 0) || (SECTION_RANK[b.section] || 0) - (SECTION_RANK[a.section] || 0) || b.t - a.t)
	return { rows: rows.slice(0, 5), total: list.length }
}

function groupRow(n, row) {
	const open = expandedGroups.has(row.key)
	const btn = h(
		"button",
		{
			class: "sig-row group",
			type: "button",
			"aria-expanded": String(open),
			onclick: () => {
				if (expandedGroups.has(row.key)) expandedGroups.delete(row.key)
				else expandedGroups.add(row.key)
				lastSignals = ""
				renderSignals()
			},
		},
		h("span", { class: "sig-n" }, String(n)),
		h("span", { class: "sig-title" }, row.title),
		statusTag(row.status),
		h("span", { class: "sig-chev", "aria-hidden": "true" }, open ? "−" : "+"),
	)
	const li = h("li", null, btn)
	if (open) {
		li.append(
			h(
				"ul",
				{ class: "sig-sub" },
				row.members.map((f) => h("li", null, h("button", { class: "sig-row sub", type: "button", onclick: () => focusFinding(f.id) }, h("span", { class: "sig-title" }, f.title), statusTag(f.status)))),
			),
		)
	}
	return li
}

function renderSignals() {
	const report = state.report
	const done = state.status === "done" && report
	let sig
	let nodes
	let count
	if (done) {
		sig = `done|${report.generatedAt}|${report.topSignals.length}|${report.topSignals.map((s) => state.findings.get(s.findingId)?.status).join("")}`
		count = report.topSignals.length
		nodes = [report.lede ? h("p", { class: "lede" }, report.lede) : null, h("ol", { class: "sig-list" }, report.topSignals.map((s, i) => signalRow(i + 1, s.findingId, s.headline, state.findings.get(s.findingId))))]
	} else {
		// live ranking: official sources first, then leadership > money > firms > audit > media, then newest
		const { rows, total } = liveSignalRows()
		count = total
		sig = `live|${rows.map((r) => `${r.key}:${r.status}:${r.title}:${r.members.length}:${expandedGroups.has(r.key)}`).join(",")}|${state.status}`
		nodes = rows.length
			? [h("ol", { class: "sig-list" }, rows.map((r, i) => (r.members.length > 1 ? groupRow(i + 1, r) : signalRow(i + 1, r.members[0].id, r.title, r.members[0]))))]
			: [h("p", { class: "empty-line" }, state.status === "idle" ? "Nema aktivnog dosijea." : "Agenti traže prve signale za proveru…")]
	}
	if (sig === lastSignals) return
	lastSignals = sig
	el.signalsCount.textContent = String(count)
	el.signalsBody.replaceChildren(...nodes.filter(Boolean))
}

function renderEntities() {
	const list = [...state.entities.values()].filter((e) => e.kind !== "institucija")
	const chips = list.map((e) => {
		let c = chipCache.get(e.id)
		const sig = `${e.name}|${e.role}`
		if (!c || c.sig !== sig) {
			const node = h(
				"button",
				{
					class: `ent ${e.kind}${state.live && fresh.has(e.id) ? " enter" : ""}`,
					type: "button",
					title: `${e.name} · ${e.kind === "firma" ? "firma" : "osoba"}${e.role ? ` · ${ROLE_LABEL[e.role] || e.role}` : ""} · klik filtrira nalaze`,
					onclick: () => setFilter("entityId", e.id),
				},
				h("span", { class: "e-name" }, truncate(e.name, 34)),
				e.role && e.role !== "pomenut" ? h("span", { class: "e-role" }, ROLE_LABEL[e.role] || e.role) : null,
			)
			node.addEventListener("animationend", () => node.classList.remove("enter"))
			c = { sig, node }
			chipCache.set(e.id, c)
		}
		c.node.classList.toggle("active", state.filters.entityId === e.id)
		return c.node
	})
	el.entitiesWrap.hidden = chips.length === 0
	el.entitiesCount.textContent = String(chips.length)
	reconcile(el.entities, chips)
}

function counts() {
	const c = { all: state.findings.size }
	for (const s of SECTIONS) c[s.id] = 0
	let unconfirmed = 0
	for (const f of state.findings.values()) {
		c[f.section] = (c[f.section] || 0) + 1
		if (f.status === "nepotvrdjeno") unconfirmed++
	}
	c.verify = openTasks().length + unconfirmed + (state.report?.toVerify?.length || 0)
	return c
}

function renderTabs() {
	const c = counts()
	const active = state.filters.section
	const sig = `${active}|${JSON.stringify(c)}`
	if (sig === lastTabs) return
	lastTabs = sig
	const defs = [{ id: "all", label: "Sve" }, ...SECTIONS, { id: "verify", label: "Šta još proveriti" }]
	el.tabs.replaceChildren(
		...defs.map((d) =>
			h(
				"button",
				{ class: `tab${active === d.id ? " active" : ""}`, type: "button", role: "tab", "aria-selected": String(active === d.id), onclick: () => setFilter("section", d.id === active ? "all" : d.id) },
				d.label,
				h("span", { class: "count" }, String(c[d.id] ?? 0)),
			),
		),
	)
}

function renderFilterBar() {
	const parts = []
	if (state.filters.agentId) {
		const a = state.agents.get(state.filters.agentId)
		parts.push(h("button", { class: "fchip", type: "button", onclick: () => setFilter("agentId", state.filters.agentId) }, `Agent: ${a?.name || "?"} ×`))
	}
	if (state.filters.entityId) {
		const e = state.entities.get(state.filters.entityId)
		parts.push(h("button", { class: "fchip", type: "button", onclick: () => setFilter("entityId", state.filters.entityId) }, `${truncate(e?.name || "?", 30)} ×`))
	}
	el.filterBar.hidden = !parts.length
	if (parts.length) el.filterBar.replaceChildren(h("span", { class: "f-lab" }, "Filter:"), ...parts, h("button", { class: "link-btn", type: "button", onclick: clearFilters }, "ukloni sve"))
}

function renderFindings() {
	const verify = state.filters.section === "verify"
	el.findList.hidden = verify
	el.verifyPanel.hidden = !verify
	if (verify) {
		renderVerify()
		return
	}
	const list = visibleFindings()
	const els = list.map((f) => ensureCard(f).el)
	for (const id of [...cards.keys()]) if (!state.findings.has(id)) cards.delete(id)
	const hl = state.filters.agentId
	for (const f of list) {
		const c = cards.get(f.id)
		c.el.classList.toggle("dimmed", !!hl && f.agentId !== hl)
	}
	const t = Date.now()
	for (const [id, ts] of fresh) if (t - ts > 4000) fresh.delete(id)
	if (!els.length) {
		const msg = state.status === "idle" ? "Nema aktivnog dosijea." : state.findings.size ? "Nema nalaza za izabrani filter." : "Nalazi će se pojaviti ovde čim ih agenti dodaju, svaki sa izvorom i statusom."
		reconcile(el.findList, [h("div", { class: "empty-line" }, msg)])
		return
	}
	reconcile(el.findList, els)
}

function verifyRow(label, text, go, onclick) {
	return h("button", { class: "v-item", type: "button", onclick }, h("span", { class: "v-tag" }, label), h("span", { class: "v-text" }, text), h("span", { class: "v-go" }, go))
}

function renderVerify() {
	const tasks = openTasks()
	const unconfirmed = [...state.findings.values()].filter((f) => f.status === "nepotvrdjeno")
	const toVerify = state.report?.toVerify || []
	const sig = JSON.stringify([tasks.map((t) => t.id), unconfirmed.map((f) => f.id + f.title), toVerify])
	if (sig === lastVerify) return
	lastVerify = sig
	const blocks = [
		h(
			"section",
			{ class: "v-block" },
			h("h4", { class: "sec-title sm" }, "Otvorena pitanja za tebe", h("span", { class: "count" }, String(tasks.length))),
			tasks.length ? tasks.map((t) => verifyRow(t.kind === "odobrenje" ? "odobrenje" : "pitanje", `${t.fromAgentName}: ${truncate(t.title || t.question, 120)}`, "otvori", () => openInbox())) : h("p", { class: "empty-line" }, "Nema otvorenih pitanja."),
		),
		h(
			"section",
			{ class: "v-block" },
			h("h4", { class: "sec-title sm" }, "Nepotvrđeni nalazi", h("span", { class: "count" }, String(unconfirmed.length))),
			unconfirmed.length ? unconfirmed.map((f) => verifyRow("nepotvrđeno", f.title, "prikaži", () => focusFinding(f.id))) : h("p", { class: "empty-line" }, "Svi nalazi imaju potvrdu ili zvaničan izvor."),
		),
	]
	if (toVerify.length || state.status === "done") {
		blocks.push(
			h(
				"section",
				{ class: "v-block" },
				h("h4", { class: "sec-title sm" }, "Preporuka urednika: šta još proveriti", h("span", { class: "count" }, String(toVerify.length))),
				toVerify.length ? h("ul", { class: "v-list" }, toVerify.map((t) => h("li", null, t))) : h("p", { class: "empty-line" }, "Nema dodatnih preporuka."),
			),
		)
	}
	el.verifyPanel.replaceChildren(...blocks)
}

function renderActions() {
	el.btnReport.hidden = !state.report
	const live = state.status === "running" || state.status === "finalizing"
	el.btnFinish.hidden = !live
	el.btnFinish.disabled = state.status === "finalizing"
	el.btnFresh.hidden = state.status !== "done"
}

function render() {
	renderInst()
	renderSignals()
	renderEntities()
	renderTabs()
	renderFilterBar()
	renderFindings()
	renderActions()
}

export function focusFinding(id) {
	if (!state.findings.has(id)) return
	state.filters.section = "all"
	state.filters.entityId = null
	lastTabs = ""
	render()
	const c = cards.get(id)
	if (!c) return
	c.el.scrollIntoView({ block: "center" })
	c.el.classList.remove("flash")
	void c.el.offsetWidth
	c.el.classList.add("flash")
}

export function initDosije() {
	el = {
		inst: document.getElementById("instCard"),
		signalsBody: document.getElementById("signalsBody"),
		signalsCount: document.getElementById("signalsCount"),
		entities: document.getElementById("entities"),
		entitiesWrap: document.getElementById("entitiesWrap"),
		entitiesCount: document.getElementById("entitiesCount"),
		tabs: document.getElementById("tabs"),
		filterBar: document.getElementById("filterBar"),
		findList: document.getElementById("findList"),
		verifyPanel: document.getElementById("verifyPanel"),
		btnReport: document.getElementById("btnReport"),
		btnFinish: document.getElementById("btnFinish"),
		btnFresh: document.getElementById("btnFresh"),
		notice: document.getElementById("docNotice"),
	}
	el.btnReport.addEventListener("click", () => openReport())
	el.btnFresh.addEventListener("click", () => {
		clearNotice(el.notice)
		clearNotice(document.getElementById("topNotice"))
		document.getElementById("inInst").value = ""
		document.getElementById("inFocus").value = ""
		startFresh()
		document.getElementById("inInst").focus()
	})
	el.btnFinish.addEventListener("click", async () => {
		el.btnFinish.disabled = true
		clearNotice(el.notice)
		try {
			await api.finish()
		} catch (e) {
			el.btnFinish.disabled = false
			showNotice(el.notice, { text: `Dosije nije završen. ${e.message}` })
		}
	})

	const schedule = createScheduler(render)
	on("finding", (e) => {
		if (e.kind === "new") fresh.set(e.id, Date.now())
		schedule()
	})
	on("entities", (e) => {
		if (e?.id) fresh.set(e.id, Date.now())
		schedule()
	})
	for (const t of ["conflict", "meta", "tasks", "filters", "done", "agents"]) on(t, schedule)
	on("snapshot", ({ newCase }) => {
		if (newCase) {
			cards.clear()
			chipCache.clear()
			fresh.clear()
			expandedGroups.clear()
			lastInst = lastSignals = lastVerify = lastTabs = ""
		}
		schedule()
	})
	schedule()
}
