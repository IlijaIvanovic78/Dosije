// "Tim": agent lanes (name, what the agent does or why it was launched, its status; a thin track below). The Gantt bars
// live in gantt.js and are drawn over the track element of each row. Groups of launched agents fold away.

import { h, reconcile, createScheduler, avatar, truncate, ROLE_TEXT, TOOL_LABEL, ROLE_LABEL } from "./format.js"
import { state, on, now, openTasks, setFilter, CORE_ORDER, teamShown } from "./store.js"
import { focusDecisions } from "./inbox.js"
import { t, pl, getLang, onLang, tx, txLabel, agentName } from "./i18n.js"

const DYN_GROUPS = [
	{ id: "trijaza", label: "Trijaža", desc: "po jedan agent za svaku instituciju sa liste" },
	{ id: "firme", label: "Firme", desc: "po jedan agent za svakog pronađenog dobavljača" },
	{ id: "imovina", label: "Imovina", desc: "izveštaji o imovini svakog funkcionera" },
	{ id: "mediji", label: "Mediji · osobe", desc: "medijske objave o svakoj osobi iz dosijea" },
	{ id: "provera", label: "Provera", desc: "da li je vlasnik firme funkcioner ili PEP" },
]

const rows = new Map() // laneId -> { root, status, spawn, sig }
const headers = new Map()
const collapsed = new Set() // groups the user folded
let rerender = () => {}

let coreEl
let dynEl
let dynEmptyEl
let banner
let wrapEl

const classify = (info) => {
	if (info.group === "novinar" || (info.role === "human" && info.group !== "sistem")) return "human"
	if (info.group === "sistem") return "obs"
	return info.dynamic ? "dyn" : "core"
}

export function laneStatus(lane, now_) {
	if (classify(lane.info) === "human") {
		const n = openTasks().length
		return n ? { k: "wait", label: t("čeka Vas") } : { k: "idle", label: t("u timu") }
	}
	if (lane.left) return { k: "done", label: t("gotovo") }
	if (lane.openWait) return { k: "wait", label: t("čeka Vas") }
	if (lane.blockedUntil > now_) return { k: "blocked", label: t("blokirano") }
	let req = null
	for (const r of lane.reqs.values()) req = r
	if (req) return { k: "tool", label: `${req.source} · ${txLabel(req.label)} …` }
	let tool = null
	for (const seg of lane.tools.values()) tool = seg
	if (tool) return { k: "tool", label: TOOL_LABEL[tool.label] || truncate(tool.label, 28) }
	if (lane.openInf) return { k: "think", label: t("razmišlja") }
	if (lane.loopsOpen > 0) return { k: "work", label: t("radi") }
	if (lane.error) return { k: "error", label: t("greška") }
	if (lane.answered) return { k: "done", label: t("gotovo") }
	return { k: "idle", label: t("čeka") }
}

function spawnerName(info) {
	return agentName((info.spawnedBy && state.agents.get(info.spawnedBy)?.name) || "")
}

const FOUND_AS = { dobavljac: "dobavljač institucije", funkcioner: "funkcioner u instituciji", vlasnik: "vlasnik firme", pomenut: "pomenut u izvorima" }

/** Why a launched agent exists, from the record: which agent found which person or company, and in what role. */
export function spawnText(info) {
	if (info.group === "trijaza") return t("pokrenut za instituciju sa liste")
	const e = info.entityId ? state.entities.get(info.entityId) : null
	const by = agentName(e?.addedByName || spawnerName(info) || "Fabrika")
	const as = e?.role ? t(FOUND_AS[e.role] || ROLE_LABEL[e.role] || e.role) : e?.kind === "firma" ? t("firma") : t("osoba")
	return t("povod: {as} · pronašli: {by}", { as, by })
}

/** The line under an agent's name: its job for the core team, the reason it was launched for the others. */
function roleLine(info) {
	return info.dynamic ? spawnText(info) : ROLE_TEXT[info.group] || ""
}

function buildLane(lane) {
	const info = lane.info
	const kind = classify(info)
	const status = h("span", { class: "lane-status" }, t("čeka"))
	const spawn = h("span", { class: "lane-spawn" })
	const root = h(
		"div",
		{
			class: `lane ${kind}${info.dynamic ? " is-dyn" : ""}`,
			dataset: { lane: info.id },
			title: [agentName(info.name), tx(info.description), info.dynamic ? spawnText(info) : ""].filter(Boolean).join("\n"),
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
		h(
			"div",
			{ class: "lane-top" },
			h("i", { class: "adot" }),
			avatar(info),
			h("span", { class: "lane-id" }, h("span", { class: "lane-name" }, agentName(info.name)), h("span", { class: "lane-role" }, roleLine(info))),
			spawn,
			status,
		),
		h("div", { class: "lane-track" }),
	)
	const rec = { root, status, spawn, sig: "", spawnSig: "" }
	rows.set(info.id, rec)
	return rec
}

function updateLane(lane, tm) {
	const rec = rows.get(lane.id)
	if (!rec) return
	const st = laneStatus(lane, tm)
	const sig = st.k + st.label
	if (rec.sig !== sig) {
		rec.sig = sig
		rec.status.className = `lane-status ${st.k}`
		rec.status.textContent = st.label
		rec.root.dataset.state = st.k
	}
	const recent = state.live && lane.info.dynamic && lane.spawnT && tm - lane.spawnT < 10000
	const reacting = state.live && lane.reactT && tm - lane.reactT < 10000
	const note = reacting ? `${t("reaguje na nalaz")}${lane.reactFrom ? ` · ${agentName(lane.reactFrom)}` : ""}` : recent ? t("nov") : ""
	if (rec.spawnSig !== note) {
		rec.spawnSig = note
		rec.spawn.textContent = note
	}
	rec.root.classList.toggle("selected", state.filters.agentId === lane.id)
	rec.root.setAttribute("aria-pressed", String(state.filters.agentId === lane.id))
	const label = `${agentName(lane.info.name)}: ${st.label}`
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
	const open = openTasks().filter((k) => k.blocking)
	if (!open.length) {
		banner.hidden = true
		banner.dataset.sig = ""
		return
	}
	const n = open.length
	const who =
		n > 1
			? getLang() === "en"
				? `${n} agents are waiting for your decision`
				: `${n} ${pl(n, ["agent čeka", "agenta čekaju", "agenata čeka"])} Vašu odluku`
			: t("{agent} čeka Vašu odluku", { agent: open[0].fromAgentName })
	const sig = `${getLang()}|${who}`
	if (banner.dataset.sig !== sig) {
		banner.dataset.sig = sig
		banner.replaceChildren(h("span", null, h("b", null, `${who}.`), ` ${t("Ostali agenti nastavljaju.")}`), h("button", { class: "btn small wait", type: "button", onclick: () => focusDecisions(open[0].id) }, t("Odlučite")))
	}
	banner.hidden = false
}

function render() {
	const tm = now()
	// during a map only the agents that took part are shown (the case agents would sit idle)
	const idleInMap = (l) => state.runKind === "mapa" && !l.segs.length && !l.loopsOpen
	const all = teamShown() ? [...state.lanes.values()] : []
	// the journalist's lane only shows waits for the user: nothing waits for the user unless the server asks (config.asksUser)
	const human = state.config?.asksUser ? all.filter((l) => classify(l.info) === "human" && !idleInMap(l)) : []
	const core = all.filter((l) => classify(l.info) === "core" && !idleInMap(l)).sort(laneSort)
	const dyn = all.filter((l) => classify(l.info) === "dyn")

	for (const l of [...human, ...core, ...dyn]) if (!rows.has(l.id)) buildLane(l)

	reconcile(coreEl, [...human, ...core].map((l) => rows.get(l.id).root))

	const dynEls = []
	for (const g of DYN_GROUPS) {
		const members = dyn.filter((l) => l.info.group === g.id).sort((a, b) => a.joinedAt - b.joinedAt)
		if (!members.length) continue
		let hd = headers.get(g.id)
		if (!hd) {
			// a group header folds its agents away (their bars stay in the timeline data and come back unfolded)
			hd = {
				root: h(
					"button",
					{
						class: "lane-group",
						type: "button",
						"aria-expanded": "true",
						title: t("Sakrijte ili prikažite ovu grupu agenata"),
						onclick: () => {
							if (collapsed.has(g.id)) collapsed.delete(g.id)
							else collapsed.add(g.id)
							rerender()
						},
					},
					h("span", { class: "g-chev", "aria-hidden": "true" }, "▾"),
					h("span", { class: "g-label" }, t(g.label)),
					h("span", { class: "g-count" }, "0"),
					h("span", { class: "g-desc" }, t(g.desc)),
				),
				count: null,
			}
			hd.count = hd.root.querySelector(".g-count")
			headers.set(g.id, hd)
		}
		const label = `${members.length}`
		if (hd.count.textContent !== label) hd.count.textContent = label
		const folded = collapsed.has(g.id)
		hd.root.setAttribute("aria-expanded", String(!folded))
		dynEls.push(hd.root, ...(folded ? [] : members.map((l) => rows.get(l.id).root)))
	}
	reconcile(dynEl, dynEls)
	dynEmptyEl.hidden = dynEls.length > 0
	dynEl.hidden = dynEls.length === 0

	for (const l of all) if (rows.has(l.id)) updateLane(l, tm)
	wrapEl.classList.toggle("is-mapa", state.runKind === "mapa")
	renderBanner()
}

export function initLanes() {
	coreEl = document.getElementById("lanesCore")
	dynEl = document.getElementById("lanesDyn")
	dynEmptyEl = document.getElementById("dynEmpty")
	banner = document.getElementById("holdBanner")
	wrapEl = document.getElementById("ganttWrap")

	const schedule = createScheduler(render)
	rerender = schedule
	on("agents", schedule)
	on("view", schedule)
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
	onLang(() => {
		for (const r of rows.values()) r.root.remove()
		rows.clear()
		headers.clear()
		schedule()
	})
	setInterval(schedule, 400)
	schedule()
}

export function laneRows() {
	return [...document.querySelectorAll(".gantt-wrap .lane[data-lane]")]
}
