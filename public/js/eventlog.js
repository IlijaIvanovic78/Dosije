// Bottom drawer "Ispod haube: Mozaik događaji": live log of the raw wire events.

import { h, createScheduler, fmtClockMs, fmtNum, truncate, jsonShort } from "./format.js"
import { state, on, setFilterValue } from "./store.js"
import { t, getLang, onLang } from "./i18n.js"

const CAP = 2000
const CATS = [
	{ id: "loop", label: "petlja" },
	{ id: "tool", label: "alati" },
	{ id: "source", label: "izvori" },
	{ id: "domain", label: "domen" },
	{ id: "intercept", label: "interception" },
]

let drawer, list, lineEl, rateEl, stateEl, agentSel, hintEl
const enabled = new Set(CATS.map((c) => c.id))
let queue = []
let hover = false
let stick = true
let stamps = []
let agentSig = ""

export function categoryOf(type) {
	if (type === "izvor.upit") return "source"
	if (type.startsWith("function_call")) return "tool"
	if (type.startsWith("interception")) return "intercept"
	if (type.startsWith("inference") || type.startsWith("message") || type === "model.answer") return "loop"
	return "domain"
}

function colorClass(type) {
	if (type === "claim.blocked") return "t-err"
	if (type === "izvor.upit") return "t-tool"
	if (type.startsWith("function_call")) return "t-tool"
	if (type.startsWith("interception")) return "t-int"
	if (type.startsWith("inference") || type.startsWith("message") || type === "model.answer") return "t-loop"
	if (type === "pitanje.za_coveka" || type === "odgovor.coveka" || type === "task.updated") return "t-human"
	if (type.startsWith("finding") || type === "conflict.resolved" || type === "entity.added") return "t-find"
	return "t-dom"
}

export function describe(ev) {
	const p = ev.payload || {}
	switch (ev.type) {
		case "participant.joined":
			return `${p.info?.name || p.manifest?.name || "?"} se pridružio (${p.info?.group || p.manifest?.role || ""})`
		case "participant.left":
			return `${p.info?.name || p.manifest?.name || "?"} je izašao`
		case "message.sent":
			return truncate(p.message, 120)
		case "message_received.started":
			return truncate(p.content, 120)
		case "inference.started":
			return `${p.model || "model"} · ${p.items ?? "?"} stavki`
		case "inference.completed":
			return p.kind === "tool_call" ? `→ poziva ${p.toolName}${p.tokens ? ` · ${p.tokens.input}/${p.tokens.output} tok.` : ""}` : `poruka: ${truncate(p.text, 100)}`
		case "function_call.started":
			return `${p.name}(${jsonShort(p.args, 110)})`
		case "function_call.completed":
			return truncate(p.output, 130)
		case "model.answer":
			return truncate(p.text, 130)
		case "interception.started":
			return `${p.nextStateId || ""}${p.toolName ? ` · ${p.toolName}` : ""}`
		case "interception.finished":
			return `→ ${p.nextStateId || ""}${p.rewritten ? " (prepisano)" : ""}`
		case "dosije.started":
			return `${p.institution?.name || p.input}${p.focus ? ` · fokus: ${p.focus}` : ""}`
		case "entity.added":
			return `${p.entity?.kind}${p.entity?.role ? `/${p.entity.role}` : ""} · ${p.entity?.name}`
		case "finding.added":
			return `[${p.finding?.section}] ${p.finding?.title}`
		case "finding.updated":
			return `${p.reason}: ${p.finding?.title}`
		case "conflict.resolved":
			return `${p.conflict?.subject}: ${p.conflict?.rule}`
		case "claim.blocked":
			return `${p.agentName}: ${p.title} (${p.reason})`
		case "pitanje.za_coveka":
			return `${p.task?.kind}${p.task?.blocking ? " · blokira petlju" : ""} · ${p.task?.title}`
		case "odgovor.coveka":
			return p.decision ? `odluka: ${p.decision}` : `odgovor: ${truncate(p.answer, 100)}`
		case "task.updated":
			return `${p.task?.title} → ${p.task?.status}`
		case "izvor.upit":
			return `${p.source} · ${p.action} · ${p.label} → ${p.status}${p.ms != null ? ` (${p.ms} ms)` : ""}`
		case "budget.updated":
			return `alati ${p.budget?.toolCalls}/${p.budget?.maxToolCalls} · petlje ${p.budget?.loops}/${p.budget?.maxLoops}`
		case "dosije.zatvori":
			return "novinar zatvara dosije"
		case "dosije.zavrsen":
			return "dosije je završen"
		default:
			return jsonShort(p, 120)
	}
}

function visible(row) {
	if (!enabled.has(row.dataset.cat)) return false
	const a = state.filters.agentId
	return !a || row.dataset.agent === a
}

function buildRow(ev) {
	const cat = categoryOf(ev.type)
	const row = h(
		"div",
		{ class: `ev ${colorClass(ev.type)}`, dataset: { cat, agent: ev.producerId || "" } },
		h("span", { class: "ts" }, fmtClockMs(ev.t)),
		h("span", { class: "ty" }, ev.type),
		h("span", { class: "pr" }, ev.producerName || ev.producerId || ""),
		h("span", { class: "dt" }, describe(ev)),
	)
	row._ev = ev
	row.addEventListener("click", () => {
		const open = row.classList.toggle("open")
		const existing = row.querySelector("pre")
		if (open && !existing) {
			let json = ""
			try {
				json = JSON.stringify({ seq: ev.seq, loopId: ev.loopId, payload: ev.payload }, null, 2)
			} catch {}
			row.appendChild(h("pre", null, truncate(json, 6000)))
		}
	})
	row.hidden = !visible(row)
	return row
}

function scrollEnd() {
	list.scrollTop = list.scrollHeight
}

function flush() {
	if (queue.length) {
		const frag = document.createDocumentFragment()
		for (const ev of queue) frag.appendChild(buildRow(ev))
		queue = []
		list.appendChild(frag)
		while (list.childElementCount > CAP) list.firstElementChild.remove()
		if (stick && !hover) scrollEnd()
	}
	// collapsed state: one friendly line, no raw event types
	lineEl.textContent = t("Ispod haube: {n} Mozaik događaja", { n: fmtNum(Math.max(state.eventCount, state.stats?.events ?? 0)) })
	stateEl.hidden = !(hover || !stick)
	stateEl.textContent = hover ? t("pauzirano dok je miš iznad") : t("na kraj ↓")
	stateEl.classList.toggle("link", !hover && !stick)
	syncAgents()
}

function syncAgents() {
	const lanes = [...state.lanes.values()]
	const sig = `${getLang()}|${lanes.map((l) => l.id).join(",")}|${state.filters.agentId}`
	if (sig === agentSig) return
	agentSig = sig
	agentSel.replaceChildren(h("option", { value: "" }, t("Svi agenti")), ...lanes.map((l) => h("option", { value: l.id }, l.info.name)))
	agentSel.value = state.filters.agentId || ""
}

function applyFilters() {
	for (const row of list.children) row.hidden = !visible(row)
	if (stick) scrollEnd()
}

function setOpen(open) {
	drawer.classList.toggle("collapsed", !open)
	drawer.querySelector(".drawer-toggle").setAttribute("aria-expanded", String(open))
	hintEl.textContent = open ? t("sakrij") : t("prikaži")
	try {
		localStorage.setItem("dosije.drawer", open ? "1" : "0")
	} catch {}
	if (open) requestAnimationFrame(scrollEnd)
}

export function initEventLog() {
	drawer = document.getElementById("drawer")
	list = document.getElementById("evList")
	lineEl = document.getElementById("evLine")
	rateEl = document.getElementById("evRate")
	stateEl = document.getElementById("evState")
	agentSel = document.getElementById("evAgent")
	hintEl = document.getElementById("evHint")

	const chips = document.getElementById("evChips")
	const buildChips = () => {
		chips.replaceChildren(
			...CATS.map((c) => {
				const on_ = enabled.has(c.id)
				const b = h(
					"button",
					{
						class: `fchip toggle${on_ ? " on" : ""} c-${c.id}`,
						type: "button",
						"aria-pressed": String(on_),
						onclick: () => {
							if (enabled.has(c.id)) enabled.delete(c.id)
							else enabled.add(c.id)
							b.classList.toggle("on", enabled.has(c.id))
							b.setAttribute("aria-pressed", String(enabled.has(c.id)))
							applyFilters()
						},
					},
					t(c.label),
				)
				return b
			}),
		)
	}
	buildChips()
	onLang(() => {
		buildChips()
		hintEl.textContent = drawer.classList.contains("collapsed") ? t("prikaži") : t("sakrij")
		agentSig = ""
		flush()
	})
	agentSel.addEventListener("change", () => {
		setFilterValue("agentId", agentSel.value || null)
	})

	let saved = null
	try {
		saved = localStorage.getItem("dosije.drawer")
	} catch {}
	setOpen(saved === "1")
	drawer.querySelector(".drawer-toggle").addEventListener("click", () => setOpen(drawer.classList.contains("collapsed")))

	list.addEventListener("mouseenter", () => {
		hover = true
		flush()
	})
	list.addEventListener("mouseleave", () => {
		hover = false
		if (stick) scrollEnd()
		flush()
	})
	list.addEventListener("scroll", () => {
		stick = list.scrollHeight - list.scrollTop - list.clientHeight < 28
	}, { passive: true })
	stateEl.addEventListener("click", () => {
		stick = true
		scrollEnd()
	})

	const schedule = createScheduler(flush)
	on("event", (ev) => {
		queue.push(ev)
		stamps.push(performance.now())
		schedule()
	})
	on("snapshot", ({ newCase }) => {
		if (newCase) {
			list.replaceChildren()
			queue = []
			schedule()
		}
	})
	on("filters", () => {
		agentSig = ""
		const sel = state.filters.agentId || ""
		applyFilters()
		agentSel.value = sel
		schedule()
	})
	on("agents", schedule)
	setInterval(() => {
		const tm = performance.now()
		stamps = stamps.filter((s) => tm - s < 2000)
		const r = (stamps.length / 2).toFixed(stamps.length < 20 ? 1 : 0)
		rateEl.textContent = `${getLang() === "en" ? r : r.replace(".", ",")}/s`
	}, 500)
}
