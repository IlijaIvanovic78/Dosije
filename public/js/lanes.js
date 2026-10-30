// "Tim": agent lanes (name + status text on top, a thin track below). The Gantt bars live in gantt.js
// and are drawn over the track element of each row.

import { h, reconcile, createScheduler, avatar, truncate } from "./format.js"
import { state, on, now, openTasks, setFilter, CORE_ORDER } from "./store.js"
import { openInbox } from "./inbox.js"
import { plural } from "./metrics.js"

const DYN_GROUPS = [
	{ id: "trijaza", label: "Trijaža" },
	{ id: "firme", label: "Firme" },
	{ id: "imovina", label: "Imovina" },
	{ id: "mediji", label: "Mediji · osobe" },
	{ id: "provera", label: "Provera" },
]

const rows = new Map() // laneId -> { root, status, spawn, sig }
const headers = new Map()

let coreEl
let dynEl
let dynEmptyEl
let banner

const classify = (info) => {
	if (info.group === "novinar" || (info.role === "human" && info.group !== "sistem")) return "human"
	if (info.group === "sistem") return "obs"
	return info.dynamic ? "dyn" : "core"
}

export function laneStatus(lane, t) {
	if (classify(lane.info) === "human") {
		const n = openTasks().length
		return n ? { k: "wait", label: "čeka tebe" } : { k: "idle", label: "u timu" }
	}
	if (lane.left) return { k: "done", label: "gotovo" }
	if (lane.openWait) return { k: "wait", label: "čeka tebe" }
	if (lane.blockedUntil > t) return { k: "blocked", label: "blokirano" }
	let req = null
	for (const r of lane.reqs.values()) req = r
	if (req) return { k: "tool", label: `${req.source} · ${req.label} …` }
	let tool = null
	for (const seg of lane.tools.values()) tool = seg
	if (tool) return { k: "tool", label: `alat: ${truncate(tool.label, 28)}` }
	if (lane.openInf) return { k: "think", label: "razmišlja" }
	if (lane.loopsOpen > 0) return { k: "work", label: "radi" }
	if (lane.error) return { k: "error", label: "greška" }
	if (lane.answered) return { k: "done", label: "gotovo" }
	return { k: "idle", label: "čeka" }
}

function spawnerName(info) {
	return (info.spawnedBy && state.agents.get(info.spawnedBy)?.name) || ""
}

function spawnText(info) {
	return `pokrenuo: ${info.group === "trijaza" ? "mapa.started" : "entity.added"} · ${spawnerName(info) || "Fabrika"}`
}

function buildLane(lane) {
	const info = lane.info
	const kind = classify(info)
	const status = h("span", { class: "lane-status" }, "čeka")
	const spawn = h("span", { class: "lane-spawn" })
	const root = h(
		"div",
		{
			class: `lane ${kind}${info.dynamic ? " is-dyn" : ""}`,
			dataset: { lane: info.id },
			title: [info.description || info.name, info.dynamic ? spawnText(info) : ""].filter(Boolean).join("\n"),
			tabindex: "0",
			role: "button",
			"aria-pressed": "false",
			onclick: () => setFilter("agentId", info.id),
			onkeydown: (e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault()
					setFilter("agentId", info.id)
				}
			},
		},
		h("div", { class: "lane-top" }, h("i", { class: "adot" }), avatar(info), h("span", { class: "lane-name" }, info.name), spawn, status),
		h("div", { class: "lane-track" }),
	)
	const rec = { root, status, spawn, sig: "", spawnSig: "" }
	rows.set(info.id, rec)
	return rec
}

function updateLane(lane, t) {
	const rec = rows.get(lane.id)
	if (!rec) return
	const st = laneStatus(lane, t)
	const sig = st.k + st.label
	if (rec.sig !== sig) {
		rec.sig = sig
		rec.status.className = `lane-status ${st.k}`
		rec.status.textContent = st.label
		rec.root.dataset.state = st.k
	}
	const recent = state.live && lane.info.dynamic && lane.spawnT && t - lane.spawnT < 10000
	const reacting = state.live && lane.reactT && t - lane.reactT < 10000
	const note = reacting ? `reaguje na nalaz${lane.reactFrom ? ` · ${lane.reactFrom}` : ""}` : recent ? spawnText(lane.info) : ""
	if (rec.spawnSig !== note) {
		rec.spawnSig = note
		rec.spawn.textContent = note
	}
	rec.root.classList.toggle("selected", state.filters.agentId === lane.id)
	rec.root.setAttribute("aria-pressed", String(state.filters.agentId === lane.id))
	const label = `${lane.info.name}: ${st.label}`
	if (rec.label !== label) {
		rec.label = label
		rec.root.setAttribute("aria-label", label)
	}
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
		banner.dataset.sig = ""
		return
	}
	const who = open.length > 1 ? `${open.length} ${plural(open.length, "agent čeka", "agenta čekaju", "agenata čeka")} tvoju odluku` : `${open[0].fromAgentName} čeka tvoju odluku`
	if (banner.dataset.sig !== who) {
		banner.dataset.sig = who
		banner.replaceChildren(h("span", null, h("b", null, `${who}.`), " Ostali agenti nastavljaju."), h("button", { class: "link-btn", type: "button", onclick: () => openInbox() }, "Odluči u sandučetu"))
	}
	banner.hidden = false
}

function render() {
	const t = now()
	// during a map only the agents that took part are shown (the case agents would sit idle)
	const idleInMap = (l) => state.runKind === "mapa" && !l.segs.length && !l.loopsOpen
	const all = [...state.lanes.values()]
	const human = all.filter((l) => classify(l.info) === "human" && !idleInMap(l))
	const core = all.filter((l) => classify(l.info) === "core" && !idleInMap(l)).sort(laneSort)
	const dyn = all.filter((l) => classify(l.info) === "dyn")

	for (const l of all) if (!rows.has(l.id) && classify(l.info) !== "obs") buildLane(l)

	reconcile(coreEl, [...human, ...core].map((l) => rows.get(l.id).root))

	const dynEls = []
	for (const g of DYN_GROUPS) {
		const members = dyn.filter((l) => l.info.group === g.id).sort((a, b) => a.joinedAt - b.joinedAt)
		if (!members.length) continue
		let hd = headers.get(g.id)
		if (!hd) {
			hd = { root: h("div", { class: "lane-group" }, h("span", null, g.label), h("span", { class: "g-count" }, "0")), count: null }
			hd.count = hd.root.querySelector(".g-count")
			headers.set(g.id, hd)
		}
		const label = `${members.length}`
		if (hd.count.textContent !== label) hd.count.textContent = label
		dynEls.push(hd.root, ...members.map((l) => rows.get(l.id).root))
	}
	reconcile(dynEl, dynEls)
	dynEmptyEl.hidden = dynEls.length > 0
	dynEl.hidden = dynEls.length === 0

	for (const l of all) updateLane(l, t)
	renderBanner()
}

export function initLanes() {
	coreEl = document.getElementById("lanesCore")
	dynEl = document.getElementById("lanesDyn")
	dynEmptyEl = document.getElementById("dynEmpty")
	banner = document.getElementById("holdBanner")

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
		}
		schedule()
	})
	setInterval(schedule, 400)
	schedule()
}

export function laneRows() {
	return [...document.querySelectorAll(".gantt-wrap .lane[data-lane]")]
}
