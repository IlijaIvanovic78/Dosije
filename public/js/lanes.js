// "Tim uživo": agent lanes (labels + status pills). The Gantt bars live in gantt.js
// and are drawn over the track column of the same rows.

import { h, reconcile, createScheduler, SOURCE_LABEL, truncate } from "./format.js"
import { state, on, now, openTasks, setFilter, CORE_ORDER } from "./store.js"
import { openInbox } from "./inbox.js"

const DYN_GROUPS = [
	{ id: "trijaza", label: "Trijaža" },
	{ id: "firme", label: "Firme" },
	{ id: "imovina", label: "Imovina" },
	{ id: "mediji", label: "Mediji · osobe" },
	{ id: "provera", label: "Provera" },
]

const rows = new Map() // laneId -> { root, pill, from, sub }
const headers = new Map()
const obsChips = new Map()

let coreEl
let dynEl
let dynEmptyEl
let obsEl
let banner

const classify = (info) => {
	if (info.group === "novinar" || (info.role === "human" && info.group !== "sistem")) return "human"
	if (info.group === "sistem") return "obs"
	return info.dynamic ? "dyn" : "core"
}

export function laneStatus(lane, t) {
	if (classify(lane.info) === "human") {
		const n = openTasks().length
		return n ? { k: "wait", label: `čeka te: ${n}` } : { k: "idle", label: "u timu" }
	}
	if (lane.left) return { k: "done", label: "gotovo ✓" }
	if (lane.openWait) return { k: "wait", label: "čeka novinara ⏸" }
	if (lane.blockedUntil > t) return { k: "blocked", label: "blokirano" }
	let tool = null
	for (const seg of lane.tools.values()) tool = seg
	if (tool) return { k: "tool", label: `alat: ${truncate(tool.label, 18)}` }
	if (lane.openInf) return { k: "think", label: "razmišlja" }
	if (lane.loopsOpen > 0) return { k: "work", label: "radi" }
	if (lane.error) return { k: "error", label: "greška" }
	if (lane.answered) return { k: "done", label: "gotovo ✓" }
	return { k: "idle", label: "čeka" }
}

function spawnerName(info) {
	return (info.spawnedBy && state.agents.get(info.spawnedBy)?.name) || ""
}

function buildLane(lane) {
	const info = lane.info
	const kind = classify(info)
	const chips = (info.sources || []).slice(0, 3).map((k) => h("span", { class: "chip-src" }, SOURCE_LABEL[k] || k))
	const pill = h("span", { class: "pill idle" }, "čeka")
	const from = info.dynamic && spawnerName(info) ? h("span", { class: "from", title: "pokrenuo" }, `← ${spawnerName(info)}`) : null
	const ring = h("i", { class: "ring" })
	const root = h(
		"div",
		{
			class: `lane ${kind}${info.dynamic ? " is-dyn" : ""}`,
			dataset: { lane: info.id },
			title: info.description || info.name,
			onclick: () => setFilter("agentId", info.id),
		},
		h(
			"div",
			{ class: "lane-label" },
			h("div", { class: "avatar" }, h("span", { class: "emoji" }, info.emoji || "🤖"), ring),
			h(
				"div",
				{ class: "lane-text" },
				h("div", { class: "lane-name" }, h("span", { class: "n" }, info.name), chips.length ? h("span", { class: "chips" }, chips) : null),
				h("div", { class: "lane-sub" }, pill, from),
			),
		),
		h("div", { class: "lane-track" }),
	)
	const rec = { root, pill, ring, from, kindSig: "" }
	rows.set(info.id, rec)

	if (info.dynamic && lane.spawnT && state.live && now() - lane.spawnT < 9000) {
		const text = `← pokrenuo: ${info.group === "trijaza" ? "mapa.started" : "entity.added"} · ${spawnerName(info) || "Fabrika"}`
		const note = h("div", { class: "spawn-note" }, text)
		root.classList.add("entering")
		root.querySelector(".lane-track").appendChild(note)
		setTimeout(() => {
			note.remove()
			root.classList.remove("entering")
		}, 7500)
	}
	return rec
}

function updateLane(lane, t) {
	const rec = rows.get(lane.id)
	if (!rec) return
	const st = laneStatus(lane, t)
	const sig = st.k + st.label
	if (rec.kindSig !== sig) {
		rec.kindSig = sig
		rec.pill.className = `pill ${st.k}`
		rec.pill.textContent = st.label
		const active = st.k === "think" || st.k === "tool" || st.k === "work" || st.k === "wait"
		rec.root.classList.toggle("active", active)
		rec.root.dataset.state = st.k
	}
	rec.root.classList.toggle("selected", state.filters.agentId === lane.id)
	rec.root.classList.toggle("dim", !!state.filters.agentId && state.filters.agentId !== lane.id)
}

function laneSort(a, b) {
	const ia = CORE_ORDER.indexOf(a.info.group)
	const ib = CORE_ORDER.indexOf(b.info.group)
	return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.info.name.localeCompare(b.info.name)
}

function renderBanner() {
	const open = openTasks().filter((t) => t.blocking)
	if (!open.length) {
		banner.hidden = true
		return
	}
	const t = open[0]
	const waiting = new Set(open.map((x) => x.fromAgentId))
	let others = 0
	const ids = new Set()
	for (const l of state.loops.values()) if (!waiting.has(l.agentId)) ids.add(l.agentId)
	others = ids.size
	const who = open.length > 1 ? `${open.length} agenta čekaju` : `${t.fromAgentName} čeka`
	const tail = others ? `ostali agenti nastavljaju da rade (${others} aktivno)` : "ostali agenti nastavljaju da rade"
	const sig = `${who}|${tail}`
	if (banner.dataset.sig !== sig) {
		banner.dataset.sig = sig
		banner.replaceChildren(
			h("span", { class: "hold-ico" }, "⏸"),
			h("span", { class: "hold-text" }, h("b", null, `${who} tvoju odluku`), `: ${tail}`),
			h("button", { class: "btn small amber", onclick: () => openInbox() }, "Odluči →"),
		)
	}
	banner.hidden = false
}

function render() {
	const t = now()
	const all = [...state.lanes.values()]
	const human = all.filter((l) => classify(l.info) === "human")
	const core = all.filter((l) => classify(l.info) === "core").sort(laneSort)
	const dyn = all.filter((l) => classify(l.info) === "dyn")
	const obs = all.filter((l) => classify(l.info) === "obs")

	for (const l of all) if (!rows.has(l.id) && classify(l.info) !== "obs") buildLane(l)

	reconcile(coreEl, [...human, ...core].map((l) => rows.get(l.id).root))

	const wasAtBottom = dynEl.scrollHeight - dynEl.scrollTop - dynEl.clientHeight < 70
	const dynEls = []
	for (const g of DYN_GROUPS) {
		const members = dyn.filter((l) => l.info.group === g.id).sort((a, b) => a.joinedAt - b.joinedAt)
		if (!members.length) continue
		let hd = headers.get(g.id)
		if (!hd) {
			hd = { root: h("div", { class: "lane-group" }, h("span", { class: "g-name" }, g.label), h("span", { class: "g-count" }, "0"), h("i")), count: null }
			hd.count = hd.root.querySelector(".g-count")
			headers.set(g.id, hd)
		}
		const label = `(${members.length})`
		if (hd.count.textContent !== label) hd.count.textContent = label
		dynEls.push(hd.root, ...members.map((l) => rows.get(l.id).root))
	}
	const prevCount = dynEl.querySelectorAll(".lane").length
	reconcile(dynEl, dynEls)
	dynEmptyEl.hidden = dynEls.length > 0
	const newCount = dynEl.querySelectorAll(".lane").length
	if (newCount > prevCount && wasAtBottom) dynEl.scrollTo({ top: dynEl.scrollHeight, behavior: "smooth" })

	const chips = []
	for (const l of obs) {
		let c = obsChips.get(l.id)
		if (!c) {
			c = h("span", { class: "obs-chip", title: l.info.description || l.info.name }, h("span", null, l.info.emoji || "👁"), h("b", null, l.info.name), h("i", { class: "obs-dot" }))
			c._dot = c.querySelector(".obs-dot")
			obsChips.set(l.id, c)
		}
		const fresh = t - l.pulseAt < 700
		c.classList.toggle("pulse", fresh)
		chips.push(c)
	}
	obsEl.hidden = chips.length === 0
	if (chips.length) reconcile(obsEl.querySelector(".obs-list"), chips)

	for (const l of all) updateLane(l, t)
	renderBanner()
}

export function initLanes() {
	coreEl = document.getElementById("lanesCore")
	dynEl = document.getElementById("lanesDyn")
	dynEmptyEl = document.getElementById("dynEmpty")
	obsEl = document.getElementById("lanesObs")
	banner = document.getElementById("holdBanner")
	obsEl.append(h("span", { class: "obs-label" }, "Posmatrači"), h("div", { class: "obs-list" }))

	const schedule = createScheduler(render)
	on("agents", schedule)
	on("lane", schedule)
	on("tasks", schedule)
	on("filters", schedule)
	on("snapshot", ({ newCase }) => {
		if (newCase) {
			for (const r of rows.values()) r.root.remove()
			rows.clear()
			headers.clear()
			obsChips.clear()
		}
		schedule()
	})
	setInterval(schedule, 350)
	schedule()
}

export function laneRows() {
	return [...document.querySelectorAll(".gantt-wrap .lane[data-lane]")]
}
