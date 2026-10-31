// "Dosije": the case file as a document: institution header, main signals, entities, section tabs, finding rows.

import { h, reconcile, createScheduler, parseIso, fmtClock, fmtDate, fmtElapsed, fmtNum, truncate, statusTag, sourceLinks, splitSourceTitle, SECTIONS, SECTION_LABEL, STATUS_LABEL, STATUS_EXPLAIN, SIGNAL_LABEL, RULE_LABEL, ROLE_LABEL, SOURCE_LABEL } from "./format.js"
import { state, on, setFilter, clearFilters, elapsedMs, peakCount } from "./store.js"
import { showNotice, clearNotice } from "./notice.js"
import { openReport, downloadReport } from "./report.js"
import { api } from "./api.js"
import { t, tx, agentName, pl, getLang, langKey, onLang } from "./i18n.js"

const SEV_RANK = { signal: 3, paznja: 2, info: 1 }
const STATUS_RANK = { zvanicno: 4, potvrdjeno: 3, nepotvrdjeno: 2, demantovano: 1 }
const SECTION_RANK = { rukovodstvo: 5, novac: 4, firme: 3, revizija: 2, mediji: 1 }
const cards = new Map() // findingId -> { el, sig }
const fresh = new Map() // id -> timestamp (fade in / highlight)
const chipCache = new Map()
let el = {}
let lastInst = ""
let lastSignals = ""
let lastTabs = ""
let lastDone = ""

function findingSig(f) {
	// the shown text is part of the signature (a fixed label follows the interface language)
	return [tx(f.title), tx(f.text), f.status, f.severity, f.approval, f.updatedAt, tx(f.note), f.conflictId, f.mergedFrom?.length, f.sources?.length, f.signalCode, langKey()].join("|")
}

function shortSource(f) {
	const src = f?.sources?.[0]
	if (!src) return t("izvor")
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
	const first = official ? t("Zvanični registar ({src})", { src: shortSource(winner) }) : shortSource(winner)
	const second = f.id === other?.id ? t("ovaj izvor") : f.id === winner?.id ? shortSource(other) : t("drugi izvor")
	const verdict = RULE_WINNER[c.rule] ? t(RULE_WINNER[c.rule]) : RULE_LABEL[c.rule] || ""
	return h("div", { class: "note conflict" }, h("b", null, `${t("Neslaganje izvora")}: `), `${t("{first} navodi „{a}“; {second} navodi „{b}“.", { first, a: tx(winnerVal), second, b: tx(otherVal) })} ${verdict}`)
}

function approvalNote(f) {
	if (f.approval === "pending") return h("span", { class: "appr pending" }, t("čeka odobrenje novinara"))
	if (f.approval === "approved") return h("span", { class: "appr" }, t("odobrio novinar"))
	if (f.approval === "rejected") return h("span", { class: "appr rejected" }, t("odbio novinar"))
	return null
}

function cardChildren(f) {
	const created = parseIso(f.createdAt)
	const merged = f.mergedFrom?.length
	const code = f.signalCode ? SIGNAL_LABEL[f.signalCode] || f.signalCode : f.severity === "signal" ? t("signal") : f.severity === "paznja" ? t("za pažnju") : ""
	const conflict = conflictNote(f)
	return [
		h("div", { class: "f-meta" }, h("span", { class: "sect" }, SECTION_LABEL[f.section] || f.section), code ? h("span", { class: `code ${f.severity}` }, code) : null, statusTag(f.status), approvalNote(f)),
		h("h3", { class: "f-title" }, tx(f.title)),
		h("p", { class: "f-text" }, tx(f.text)),
		conflict,
		f.note && !conflict ? h("div", { class: "note" }, h("b", null, `${t("Napomena urednika")}: `), tx(f.note)) : null,
		sourceLinks(f.sources, f.id),
		// how far it can be relied on: the status in words, next to the coloured pill above
		STATUS_EXPLAIN[f.status] ? h("div", { class: "f-trust" }, h("b", null, `${t("Pouzdanost")}: `), `${STATUS_LABEL[f.status]}, ${STATUS_EXPLAIN[f.status]}.`) : null,
		h("div", { class: "f-foot" }, t("upisao: {a}", { a: agentName(f.agentName) || "agent" }), created ? ` · ${fmtClock(created)}` : "", merged ? ` · ${t("spojeno iz {n} nalaza", { n: merged + 1 })}` : ""),
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
	// "verify" is the "Nepotvrđeno" tab: findings without an official source or a second independent one
	if (sec === "verify") list = list.filter((f) => f.status === "nepotvrdjeno")
	else if (sec !== "all") list = list.filter((f) => f.section === sec)
	if (state.filters.entityId) list = list.filter((f) => aboutEntity(f, state.filters.entityId))
	const done = state.status === "done"
	return list.sort((a, b) => (done ? (SEV_RANK[b.severity] || 0) - (SEV_RANK[a.severity] || 0) : 0) || (parseIso(b.createdAt) || 0) - (parseIso(a.createdAt) || 0))
}

function renderInst() {
	const i = state.institution
	const status = state.status
	const sig = JSON.stringify([i, status, state.focus, state.input, langKey()])
	if (sig === lastInst) return
	lastInst = sig
	const statusLabel = t({ idle: "čeka", running: "istraživanje traje", finalizing: "urednik piše sažetak", done: "završeno" }[status] || status)
	const ids = []
	if (i) {
		for (const [lab, v] of [["PIB", i.pib], ["MB", i.mb], ["ACAS", i.acasId], ["JN", i.jnId]]) if (v) ids.push(`${lab} ${v}`)
	}
	// the name once, in Latin script; a finished case needs no status pill (the done card says it)
	const nodes = [
		h("div", { class: "eyebrow" }, t("Dosije"), status === "done" ? null : h("span", { class: `stat ${status}` }, h("i"), statusLabel)),
		h("h2", { class: "serif-title" }, i?.name || state.input || t("Pronalazim instituciju u registrima…")),
		i?.legalType ? h("div", { class: "inst-legal" }, tx(i.legalType)) : null,
		ids.length ? h("div", { class: "meta-line" }, ids.join(" · ")) : null,
		state.focus ? h("div", { class: "meta-sub" }, h("b", null, `${t("Fokus")}: `), state.focus) : null,
	]
	el.inst.replaceChildren(...nodes.filter(Boolean))
}

/** The first sentence of a finding: why it is on the list. */
function whyOf(f) {
	const text = String(tx(f.text) || "").trim()
	const m = /^(.{40,220}?[.!?])(s|$)/.exec(text)
	return m ? m[1] : truncate(text, 200)
}

/** The person or company a finding is about, when the record says so. */
function subjectOf(f) {
	for (const id of f.entityIds || []) {
		const e = state.entities.get(id)
		if (e && e.kind !== "institucija") return e.name
	}
	const owner = state.agents.get(f.agentId)
	const e = owner?.entityId ? state.entities.get(owner.entityId) : null
	return e && e.kind !== "institucija" ? e.name : f.claim?.subject || ""
}

/** Is a finding about this entity: it names it, or the agent that wrote it works on it (Firme · X, Provera · Y). */
function aboutEntity(f, entityId) {
	if (f.entityIds?.includes(entityId)) return true
	return state.agents.get(f.agentId)?.entityId === entityId
}

function sourceName(src) {
	return src.kind === "vesti" ? splitSourceTitle(src).outlet : SOURCE_LABEL[src.kind] || src.kind
}

/** One main signal: the headline, why it matters, whom it concerns, where it comes from and when, and its status. */
function signalRow(n, id, title, f) {
	const src = f?.sources?.find((x) => x.official) || f?.sources?.[0]
	const date = src ? fmtDate(src.publishedAt || src.retrievedAt) : ""
	const who = f ? subjectOf(f) : ""
	const meta = f ? [SECTION_LABEL[f.section], who, src ? sourceName(src) : "", date].filter(Boolean) : []
	return h(
		"li",
		null,
		h(
			"button",
			{ class: "sig-row", type: "button", onclick: () => focusFinding(id), title: t("Prikažite nalaz sa svim izvorima") },
			h("span", { class: "sig-n" }, String(n)),
			h("span", { class: "sig-body" }, h("span", { class: "sig-title" }, tx(title)), f ? h("span", { class: "sig-why" }, whyOf(f)) : null, meta.length ? h("span", { class: "sig-meta" }, meta.join(" · ")) : null),
			f ? statusTag(f.status) : null,
		),
	)
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
	if (code === "POLITICKA_VEZA" && members.every((m) => m.sources?.some((s) => s.kind === "integrity_watch"))) return t("Integrity Watch Srbija: {n} dobavljača označeno ({list})", { n, list })
	const label = SIGNAL_LABEL[code] || code
	return t("{label}: {n} nalaza ({list})", { label: `${label[0].toUpperCase()}${label.slice(1)}`, n, list })
}

let ledeOpen = false

/** The report lede: small and calm, three lines, "više" expands (the numbered list carries the hierarchy). */
function ledeBlock(text) {
	const long = text.length > 230
	const p = h("p", { class: `lede${long && !ledeOpen ? " clamp" : ""}` }, tx(text))
	if (!long) return h("div", { class: "lede-box" }, p)
	return h(
		"div",
		{ class: "lede-box" },
		p,
		h(
			"button",
			{
				class: "link-btn lede-more",
				type: "button",
				"aria-expanded": String(ledeOpen),
				onclick: () => {
					ledeOpen = !ledeOpen
					lastSignals = ""
					renderSignals()
				},
			},
			ledeOpen ? t("manje") : t("više"),
		),
	)
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
		sig = `done|${langKey()}|${ledeOpen}|${report.generatedAt}|${report.topSignals.length}|${report.topSignals.map((s) => state.findings.get(s.findingId)?.status).join("")}`
		count = report.topSignals.length
		nodes = [
			report.lede ? ledeBlock(report.lede) : null,
			report.topSignals.length
				? h("ol", { class: "sig-list" }, report.topSignals.map((s, i) => signalRow(i + 1, s.findingId, s.headline, state.findings.get(s.findingId))))
				: h("p", { class: "empty-line" }, t("Pravila nisu istakla nijedan signal. Svi nalazi su u listi ispod.")),
		]
	} else {
		// live ranking: official sources first, then leadership > money > firms > audit > media, then newest
		const { rows, total } = liveSignalRows()
		count = total
		sig = `live|${langKey()}|${rows.map((r) => `${r.key}:${r.status}:${r.title}:${r.members.length}:${expandedGroups.has(r.key)}`).join(",")}|${state.status}`
		nodes = rows.length
			? [h("ol", { class: "sig-list" }, rows.map((r, i) => (r.members.length > 1 ? groupRow(i + 1, r) : signalRow(i + 1, r.members[0].id, r.title, r.members[0]))))]
			: [h("p", { class: "empty-line" }, state.status === "idle" ? t("Nema aktivnog dosijea.") : t("Agenti traže prve signale…"))]
	}
	if (sig === lastSignals) return
	lastSignals = sig
	el.signalsCount.textContent = String(count)
	el.signalsBody.replaceChildren(...nodes.filter(Boolean))
}

/** How the record links a person or company to the institution, in plain words (never a judgement). */
function relationOf(e) {
	const a = e.attrs || {}
	if (e.role === "funkcioner") return [t("funkcioner u instituciji"), a.position ? tx(String(a.position)) : ""].filter(Boolean).join(" · ")
	if (e.role === "vlasnik") return [t("vlasnik firme"), a.firma, a.udeo].filter(Boolean).join(" · ")
	if (e.role === "dobavljac") {
		const n = Number(a.contracts) || 0
		return [t("dobavljač institucije"), n ? `${fmtNum(n)} ${pl(n, ["ugovor", "ugovora", "ugovora"], ["contract", "contracts"])}` : ""].filter(Boolean).join(" · ")
	}
	if (e.role === "pomenut") return t("pomenut u izvorima")
	return ROLE_LABEL[e.role] || ""
}

/** People and companies as two short lists: who they are, how the record links them, how many findings concern them. */
function renderEntities() {
	const list = [...state.entities.values()].filter((e) => e.kind !== "institucija")
	const all = [...state.findings.values()]
	const rows = new Map()
	for (const e of list) {
		const n = all.filter((f) => aboutEntity(f, e.id)).length
		let c = chipCache.get(e.id)
		const sig = `${e.name}|${e.role}|${JSON.stringify(e.attrs)}|${n}|${langKey()}`
		if (!c || c.sig !== sig) {
			const node = h(
				"button",
				{
					class: `ent ${e.kind}${state.live && fresh.has(e.id) ? " enter" : ""}`,
					type: "button",
					title: t("Prikažite samo nalaze o: {name}", { name: e.name }),
					onclick: () => setFilter("entityId", e.id),
				},
				h("span", { class: "e-main" }, h("span", { class: "e-name" }, e.name), h("span", { class: "e-rel" }, relationOf(e))),
				h("span", { class: "e-count" }, n ? `${fmtNum(n)} ${pl(n, ["nalaz", "nalaza", "nalaza"], ["finding", "findings"])}` : t("bez nalaza")),
			)
			node.addEventListener("animationend", () => node.classList.remove("enter"))
			c = { sig, node, n }
			chipCache.set(e.id, c)
		}
		c.node.classList.toggle("active", state.filters.entityId === e.id)
		c.node.setAttribute("aria-pressed", String(state.filters.entityId === e.id))
		rows.set(e.id, c)
	}
	el.entitiesWrap.hidden = list.length === 0
	el.entitiesCount.textContent = String(list.length)
	const group = (kind, label) => {
		const members = list.filter((e) => e.kind === kind).sort((x, y) => rows.get(y.id).n - rows.get(x.id).n || x.name.localeCompare(y.name))
		if (!members.length) return null
		return h("div", { class: "ent-group" }, h("h4", null, t(label), h("span", { class: "count" }, String(members.length))), h("ul", { class: "ent-list" }, members.map((e) => h("li", null, rows.get(e.id).node))))
	}
	const sig = `${langKey()}|${list.map((e) => `${e.id}:${rows.get(e.id).sig}`).join(",")}`
	if (el.entities.dataset.sig === sig) return
	el.entities.dataset.sig = sig
	el.entities.replaceChildren(
		h("div", { class: "ent-groups" }, group("osoba", "Osobe"), group("firma", "Firme")),
		h("p", { class: "ent-note" }, t("Veza je onakva kakva je zabeležena u izvoru i sama po sebi nije nalaz o nepravilnosti. Klik prikazuje nalaze o toj osobi ili firmi.")),
	)
}

function counts() {
	const c = { all: state.findings.size }
	for (const s of SECTIONS) c[s.id] = 0
	let unconfirmed = 0
	for (const f of state.findings.values()) {
		c[f.section] = (c[f.section] || 0) + 1
		if (f.status === "nepotvrdjeno") unconfirmed++
	}
	c.verify = unconfirmed
	return c
}

function renderTabs() {
	const c = counts()
	const active = state.filters.section
	const sig = `${getLang()}|${active}|${JSON.stringify(c)}`
	if (sig === lastTabs) return
	lastTabs = sig
	const defs = [{ id: "all", label: t("Sve") }, ...SECTIONS.map((s) => ({ id: s.id, label: t(s.label) })), { id: "verify", label: t("Nepotvrđeno") }]
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
		parts.push(h("button", { class: "fchip", type: "button", onclick: () => setFilter("agentId", state.filters.agentId) }, `${t("Agent")}: ${agentName(a?.name) || "?"} ×`))
	}
	if (state.filters.entityId) {
		const e = state.entities.get(state.filters.entityId)
		parts.push(h("button", { class: "fchip", type: "button", onclick: () => setFilter("entityId", state.filters.entityId) }, `${truncate(e?.name || "?", 30)} ×`))
	}
	el.filterBar.hidden = !parts.length
	if (parts.length) el.filterBar.replaceChildren(h("span", { class: "f-lab" }, `${t("Filter")}:`), ...parts, h("button", { class: "link-btn", type: "button", onclick: clearFilters }, t("uklonite sve")))
}

function renderFindings() {
	const list = visibleFindings()
	const els = list.map((f) => ensureCard(f).el)
	for (const id of [...cards.keys()]) if (!state.findings.has(id)) cards.delete(id)
	const hl = state.filters.agentId
	for (const f of list) {
		const c = cards.get(f.id)
		c.el.classList.toggle("dimmed", !!hl && f.agentId !== hl)
	}
	const tm = Date.now()
	for (const [id, ts] of fresh) if (tm - ts > 4000) fresh.delete(id)
	if (!els.length) {
		const msg =
			state.status === "idle"
				? t("Nema aktivnog dosijea.")
				: state.filters.section === "verify" && state.findings.size
					? t("Nema nepotvrđenih nalaza: svi imaju zvaničan izvor ili potvrdu iz dva izvora.")
					: state.findings.size
						? t("Nema nalaza za izabrani filter.")
						: t("Nalazi će se pojaviti ovde čim ih agenti dodaju, svaki sa izvorom i statusom.")
		reconcile(el.findList, [h("div", { class: "empty-line" }, msg)])
		return
	}
	reconcile(el.findList, els)
}

function renderActions() {
	// once the case is done the "Dosije je spreman" card carries the report actions
	el.btnReport.hidden = !state.report || state.status === "done"
	const live = state.status === "running" || state.status === "finalizing"
	el.btnFinish.hidden = !live
	el.btnFinish.disabled = state.status === "finalizing"
}

const CHECK_ICON = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 10.5 8.5 14 15 6.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'

/** The end of the flow: what the team did, then open the report or download it as a PDF. */
function renderDone() {
	const report = state.report
	const show = state.status === "done" && !!report
	const agents = [...state.lanes.values()].filter((l) => l.info.role !== "human" && l.info.group !== "sistem").length
	const nf = state.findings.size
	const peak = peakCount()
	const time = fmtElapsed(elapsedMs())
	const sig = JSON.stringify([show, getLang(), agents, nf, peak, time, report?.generatedAt])
	if (sig === lastDone) return
	lastDone = sig
	el.done.hidden = !show
	if (!show) return
	const summary =
		getLang() === "en"
			? `The research finished in ${time}. ${agents} ${pl(agents, [], ["agent", "agents"])} in total, up to ${peak} of them at once, collected ${nf} ${pl(nf, [], ["finding", "findings"])}.`
			: `Istraživanje je završeno za ${time}. Ukupno ${agents} ${pl(agents, ["agent", "agenta", "agenata"])}, od kojih ${pl(peak, [`je do ${peak} radio`, `su do ${peak} radila`, `je do ${peak} radilo`])} istovremeno, ${pl(agents, ["prikupio je", "prikupili su", "prikupili su"])} ${nf} ${pl(nf, ["nalaz", "nalaza", "nalaza"])}.`
	const pdf = h("button", { class: "btn", type: "button" }, h("span", null, t("Preuzmite PDF")))
	pdf.addEventListener("click", () => downloadReport(pdf))
	const icon = h("span", { class: "done-icon" })
	icon.innerHTML = CHECK_ICON
	el.done.replaceChildren(
		icon,
		h(
			"div",
			{ class: "done-main" },
			h("h3", { class: "done-title" }, t("Dosije je spreman")),
			h("p", { class: "done-text" }, summary),
			h(
				"div",
				{ class: "done-actions" },
				h("button", { class: "btn primary", type: "button", onclick: () => openReport() }, t("Otvorite izveštaj")),
				pdf,
			),
		),
	)
}

function render() {
	renderInst()
	renderSignals()
	renderEntities()
	renderTabs()
	renderFilterBar()
	renderFindings()
	renderActions()
	renderDone()
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
		btnReport: document.getElementById("btnReport"),
		btnFinish: document.getElementById("btnFinish"),
		notice: document.getElementById("docNotice"),
		done: document.getElementById("doneCard"),
	}
	el.btnReport.addEventListener("click", () => openReport())
	el.btnFinish.addEventListener("click", async () => {
		el.btnFinish.disabled = true
		clearNotice(el.notice)
		try {
			await api.finish()
		} catch (e) {
			el.btnFinish.disabled = false
			showNotice(el.notice, { text: `${t("Dosije nije završen.")} ${e.message}` })
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
	for (const ev of ["conflict", "meta", "tasks", "filters", "done", "agents"]) on(ev, schedule)
	onLang(() => {
		cards.clear()
		chipCache.clear()
		fresh.clear()
		lastInst = lastSignals = lastTabs = lastDone = ""
		schedule()
	})
	on("snapshot", ({ newCase }) => {
		if (newCase) {
			cards.clear()
			chipCache.clear()
			fresh.clear()
			expandedGroups.clear()
			lastInst = lastSignals = lastTabs = lastDone = ""
		}
		schedule()
	})
	schedule()
}
