// "Dosije" panel: institution card, main signals, entity chips, section tabs, finding cards.

import { h, reconcile, createScheduler, parseIso, fmtClock, truncate, safeUrl, sourceChipLabel, SECTIONS, SECTION_LABEL, STATUS_LABEL, SIGNAL_LABEL, RULE_LABEL, ROLE_LABEL, SOURCE_LABEL } from "./format.js"
import { state, on, openTasks, setFilter, clearFilters } from "./store.js"
import { openInbox } from "./inbox.js"
import { openReport } from "./report.js"
import { api } from "./api.js"
import { toast } from "./toast.js"

const SEV_RANK = { signal: 3, paznja: 2, info: 1 }
const STATUS_RANK = { zvanicno: 4, potvrdjeno: 3, nepotvrdjeno: 2, demantovano: 1 }
const SECTION_RANK = { rukovodstvo: 5, novac: 4, firme: 3, revizija: 2, mediji: 1 }
const cards = new Map() // findingId -> { el, sig }
const fresh = new Map() // id -> timestamp (animate entry)
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
	return src.kind === "vesti" ? truncate(String(src.title || "Vesti").split(/\s[–—-]\s/)[0], 20) : SOURCE_LABEL[src.kind] || src.kind
}

function conflictBox(f) {
	const c = f.conflictId ? state.conflicts.get(f.conflictId) : null
	if (!c) return null
	const [a, b] = c.findingIds
	return h(
		"div",
		{ class: "conflict" },
		h(
			"div",
			{ class: "c-head" },
			h("span", { class: "c-ico" }, "⚖"),
			h("b", null, "Konflikt rešen: "),
			h("span", { class: "c-side" }, `${shortSource(state.findings.get(a))} «${c.values[0]}»`),
			" vs ",
			h("span", { class: "c-side" }, `${shortSource(state.findings.get(b))} «${c.values[1]}»`),
			h("span", { class: "c-rule" }, ` → ${RULE_LABEL[c.rule] || c.rule}`),
		),
		c.explanation ? h("div", { class: "c-exp" }, c.explanation) : null,
	)
}

function sourceChips(f) {
	return h(
		"div",
		{ class: "f-sources" },
		(f.sources || []).map((src) => {
			const url = safeUrl(src.url)
			const cls = `src${src.official ? " official" : ""}`
			const label = sourceChipLabel(src)
			return url ? h("a", { class: cls, href: url, target: "_blank", rel: "noopener noreferrer", title: src.title }, label, h("i", { class: "ext" }, "↗")) : h("span", { class: cls, title: src.title }, label)
		}),
	)
}

function approvalChip(f) {
	if (f.approval === "pending") return h("span", { class: "tag appr pending" }, "⏸ čeka odobrenje novinara")
	if (f.approval === "approved") return h("span", { class: "tag appr approved" }, "✓ odobrio novinar")
	if (f.approval === "rejected") return h("span", { class: "tag appr rejected" }, "✕ odbio novinar")
	return null
}

function cardChildren(f) {
	const created = parseIso(f.createdAt)
	const merged = f.mergedFrom?.length
	const codeTag = f.signalCode
		? h("span", { class: `tag code ${f.severity}` }, `⚑ ${SIGNAL_LABEL[f.signalCode] || f.signalCode}`)
		: f.severity !== "info"
			? h("span", { class: `tag code ${f.severity}` }, f.severity === "signal" ? "signal" : "pažnja")
			: null
	return [
		h("div", { class: "f-bar" }),
		h(
			"div",
			{ class: "f-body" },
			h("div", { class: "f-top" }, h("span", { class: "tag sect" }, SECTION_LABEL[f.section] || f.section), codeTag, approvalChip(f), h("span", { class: `badge ${f.status}` }, STATUS_LABEL[f.status] || f.status)),
			h("h3", { class: "f-title" }, f.title),
			h("p", { class: "f-text" }, f.text),
			conflictBox(f),
			f.note ? h("div", { class: "f-note" }, "✎ ", f.note) : null,
			sourceChips(f),
			h("div", { class: "f-foot" }, h("span", null, `dodao ${f.agentName || "agent"}`, created ? ` · ${fmtClock(created)}` : ""), merged ? h("span", { class: "merged" }, `⛙ spojeno iz ${merged + 1} nalaza`) : null),
		),
	]
}

function ensureCard(f) {
	const sig = findingSig(f)
	let c = cards.get(f.id)
	if (!c) {
		const root = h("article", { class: "finding", dataset: { id: f.id } })
		root.addEventListener("animationend", (e) => {
			if (e.target === root) root.classList.remove("enter", "pulse")
		})
		c = { el: root, sig: "" }
		cards.set(f.id, c)
		if (state.live && fresh.has(f.id)) root.classList.add("enter")
	}
	if (c.sig !== sig) {
		const wasBuilt = c.sig !== ""
		c.sig = sig
		const keep = ["enter", "hl", "dimmed", "flash"].filter((k) => c.el.classList.contains(k)).join(" ")
		c.el.className = `finding sev-${f.severity} st-${f.status} ${keep}`
		c.el.dataset.agent = f.agentId || ""
		c.el.replaceChildren(...cardChildren(f))
		if (wasBuilt) {
			c.el.classList.remove("pulse")
			void c.el.offsetWidth
			c.el.classList.add("pulse")
		}
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
		for (const [lab, v] of [["PIB", i.pib], ["MB", i.mb], ["ACAS ID", i.acasId], ["JN ID", i.jnId]]) if (v) ids.push(h("span", { class: "id-chip" }, h("i", null, lab), h("b", null, v)))
	}
	const nodes = [
		h(
			"div",
			{ class: "inst-main" },
			h("div", { class: "inst-icon" }, "🏛"),
			h(
				"div",
				{ class: "inst-text" },
				h("h2", { class: "inst-name" }, i?.name || state.input || "Učitavam instituciju…"),
				i?.nameCyr ? h("div", { class: "inst-cyr" }, i.nameCyr) : null,
				h("div", { class: "inst-meta" }, i?.legalType ? h("span", { class: "legal" }, i.legalType) : null, ids),
			),
			h("span", { class: `status-pill ${status}` }, h("i"), statusLabel),
		),
		state.focus ? h("div", { class: "inst-focus" }, h("b", null, "Fokus: "), state.focus) : null,
		state.input && i && state.input !== i.name ? h("div", { class: "inst-focus muted" }, h("b", null, "Upit: "), truncate(state.input, 140)) : null,
	]
	el.inst.replaceChildren(...nodes.filter(Boolean))
}

function signalRow(id, title, f) {
	return h("button", { class: "sig-row", onclick: () => focusFinding(id) }, h("i", { class: "sig-dot" }), h("span", { class: "sig-title" }, title), f ? h("span", { class: `badge mini ${f.status}` }, STATUS_LABEL[f.status]) : null, h("span", { class: "sig-go" }, "›"))
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
		nodes = [report.lede ? h("p", { class: "lede" }, report.lede) : null, h("div", { class: "sig-list" }, report.topSignals.map((s) => signalRow(s.findingId, s.headline, state.findings.get(s.findingId))))]
	} else {
		// live ranking: official sources first, then leadership > money > firms > audit > media, then newest
		const list = [...state.findings.values()]
			.filter((f) => f.severity === "signal" && f.status !== "demantovano" && f.approval !== "rejected")
			.sort((a, b) => (STATUS_RANK[b.status] || 0) - (STATUS_RANK[a.status] || 0) || (SECTION_RANK[b.section] || 0) - (SECTION_RANK[a.section] || 0) || (parseIso(b.createdAt) || 0) - (parseIso(a.createdAt) || 0))
		count = list.length
		sig = `live|${list.map((f) => f.id + f.status + f.title).join(",")}|${state.status}`
		nodes = list.length
			? [h("div", { class: "sig-list" }, list.slice(0, 5).map((f) => signalRow(f.id, f.title, f)))]
			: [state.status === "idle" ? h("div", { class: "empty-note" }, "Nema aktivnog dosijea.") : h("div", { class: "empty-note shimmer" }, "Agenti traže prve signale za proveru…")]
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
					title: `${e.kind === "firma" ? "firma" : "osoba"}${e.role ? ` · ${ROLE_LABEL[e.role] || e.role}` : ""} · klik filtrira nalaze`,
					onclick: () => setFilter("entityId", e.id),
				},
				h("span", { class: "e-ico" }, e.kind === "firma" ? "🏢" : "👤"),
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
				{ class: `tab${active === d.id ? " active" : ""}${d.id === "verify" ? " verify" : ""}`, role: "tab", "aria-selected": String(active === d.id), onclick: () => setFilter("section", d.id === active ? "all" : d.id) },
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
		parts.push(h("button", { class: "fchip", onclick: () => setFilter("agentId", state.filters.agentId) }, `${a?.emoji || "🤖"} Agent: ${a?.name || "?"} `, h("b", null, "×")))
	}
	if (state.filters.entityId) {
		const e = state.entities.get(state.filters.entityId)
		parts.push(h("button", { class: "fchip", onclick: () => setFilter("entityId", state.filters.entityId) }, `${e?.kind === "firma" ? "🏢" : "👤"} ${truncate(e?.name || "?", 30)} `, h("b", null, "×")))
	}
	el.filterBar.hidden = !parts.length
	if (parts.length) el.filterBar.replaceChildren(h("span", { class: "f-lab" }, "Filter:"), ...parts, h("button", { class: "link-btn", onclick: clearFilters }, "ukloni sve"))
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
		c.el.classList.toggle("hl", !!hl && f.agentId === hl)
		c.el.classList.toggle("dimmed", !!hl && f.agentId !== hl)
	}
	const t = Date.now()
	for (const [id, ts] of fresh) if (t - ts > 4000) fresh.delete(id)
	if (!els.length) {
		const msg = state.status === "idle" ? "Nema aktivnog dosijea." : state.findings.size ? "Nema nalaza za izabrani filter." : "Nalazi će se pojaviti ovde čim ih agenti dodaju, svaki sa izvorom i statusom."
		reconcile(el.findList, [h("div", { class: "empty-list" }, msg)])
		return
	}
	reconcile(el.findList, els)
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
			h("h4", null, "Otvorena pitanja za tebe", h("span", { class: "count" }, String(tasks.length))),
			tasks.length
				? tasks.map((t) => h("button", { class: "v-item task", onclick: () => openInbox() }, h("span", { class: "v-ico" }, t.kind === "odobrenje" ? "⏸" : "❓"), h("span", { class: "v-text" }, h("b", null, t.fromAgentName), `: ${truncate(t.title || t.question, 120)}`), h("span", { class: "v-go" }, "Otvori ›")))
				: h("div", { class: "empty-note" }, "Nema otvorenih pitanja."),
		),
		h(
			"section",
			{ class: "v-block" },
			h("h4", null, "Nepotvrđeni nalazi", h("span", { class: "count" }, String(unconfirmed.length))),
			unconfirmed.length
				? unconfirmed.map((f) => h("button", { class: "v-item", onclick: () => focusFinding(f.id) }, h("span", { class: "badge mini nepotvrdjeno" }, "NEPOTVRĐENO"), h("span", { class: "v-text" }, f.title), h("span", { class: "v-go" }, "Prikaži ›")))
				: h("div", { class: "empty-note" }, "Svi nalazi imaju potvrdu ili zvaničan izvor."),
		),
	]
	if (toVerify.length || state.status === "done") {
		blocks.push(
			h(
				"section",
				{ class: "v-block" },
				h("h4", null, "Preporuka urednika: šta još proveriti", h("span", { class: "count" }, String(toVerify.length))),
				toVerify.length ? h("ul", { class: "v-list" }, toVerify.map((t) => h("li", null, t))) : h("div", { class: "empty-note" }, "Nema dodatnih preporuka."),
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
	c.el.scrollIntoView({ behavior: "smooth", block: "center" })
	c.el.classList.remove("flash")
	void c.el.offsetWidth
	c.el.classList.add("flash")
	setTimeout(() => c.el.classList.remove("flash"), 2200)
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
	}
	el.btnReport.addEventListener("click", () => openReport())
	el.btnFinish.addEventListener("click", async () => {
		el.btnFinish.disabled = true
		try {
			await api.finish()
		} catch (e) {
			el.btnFinish.disabled = false
			toast({ kind: "error", title: "Nije uspelo", text: e.message })
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
			lastInst = lastSignals = lastVerify = lastTabs = ""
		}
		schedule()
	})
	schedule()
}
