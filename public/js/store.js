// Client-side shared state. The wire protocol is reduced here into plain data
// (domain maps + per-agent lane timelines); views subscribe and re-render in rAF.

import { parseIso, jsonShort } from "./format.js"

export const CORE_ORDER = ["kadrovik", "nabavke", "revizor", "mediji", "urednik"]

/** The team column belongs to the run on screen: the map view before any map shows no agents of an earlier dossier. */
export const teamShown = () => !(state.ui.view === "mapa" && state.runKind !== "mapa")

export const state = {
	config: null,
	conn: "connecting",
	live: false, // true after the first snapshot: cards animate in only when live

	caseId: null,
	status: "idle",
	input: "",
	focus: "",
	institution: null,
	findings: new Map(),
	entities: new Map(),
	conflicts: new Map(),
	tasks: new Map(),
	agents: new Map(),
	budget: null,
	stats: null,
	report: null,

	// "Poređenje institucija" (separate from the case): runKind says which run the lanes / Gantt / metrics belong to
	runKind: "case",
	mapa: { id: null, status: "idle", startedAt: null, finishedAt: null, rows: new Map(), veze: new Map() }, // veze: shared suppliers ("mapa.veza")
	ui: { view: "dosije", fresh: false }, // right column: "dosije" | "mapa"; fresh = client-side "Novi dosije" (empty state shown)

	lanes: new Map(),
	acts: new Map(), // live search: request id -> SourceActivity (+ t0), in order of first appearance
	loops: new Map(), // loopId -> { agentId, t }
	active: 0,
	peak: 0,
	series: [], // [{ t, n }] active agents over time
	t0: null,
	tEnd: null,
	offset: null, // server clock - client clock (ms)
	eventCount: 0,
	lastEvent: null,

	filters: { agentId: null, entityId: null, section: "all" },
	replay: false, // true while applyEvent handles a replayed (not live) event
}

const seen = new Set()
let wasDisconnected = false
let syncUntil = 0 // until this wall-clock time, incoming events are the replay that follows a snapshot
const listeners = {}

export function on(topic, fn) {
	;(listeners[topic] ||= new Set()).add(fn)
	return () => listeners[topic].delete(fn)
}

function emit(topic, data) {
	const set = listeners[topic]
	if (!set) return
	for (const fn of set) {
		try {
			fn(data)
		} catch (e) {
			console.error(`[store:${topic}]`, e)
		}
	}
}

export function now() {
	return Date.now() + (state.offset ?? 0)
}

function syncClock(t) {
	const o = t - Date.now()
	if (state.offset == null || o > state.offset) state.offset = o
}

export const openTasks = () => [...state.tasks.values()].filter((t) => t.status === "open")

/** Status of the run on screen: the case, or the map when the lanes belong to a map. */
export function runStatus() {
	return state.runKind === "mapa" ? state.mapa.status : state.status
}

export const isRunning = () => runStatus() === "running" || runStatus() === "finalizing"
export const isDone = () => runStatus() === "done"

export function setView(view) {
	if (view === "mapa") state.ui.fresh = false
	if (state.ui.view === view) {
		emit("view", view)
		return
	}
	state.ui.view = view
	emit("view", view)
}

/** "Novi dosije": back to the empty state on this screen only (the server keeps its state). */
export function startFresh() {
	state.ui.fresh = true
	state.ui.view = "dosije"
	clearFilters()
	emit("view", "dosije")
}

/** Back from the empty state to the case the server still holds. */
export function resumeCase() {
	state.ui.fresh = false
	state.ui.view = "dosije"
	emit("view", "dosije")
}

export function laneEnd() {
	if (isDone() && state.tEnd) return state.tEnd
	return now()
}

export function elapsedMs() {
	if (!state.t0) return 0
	return Math.max(0, laneEnd() - state.t0)
}

export function activeCount() {
	if (runStatus() === "idle") return 0
	if (state.loops.size === 0 && state.stats && runStatus() === "running") return state.stats.activeLoops || 0
	return state.active
}

export function peakCount() {
	return Math.max(state.peak, state.stats?.peakConcurrentLoops || 0)
}

// ─── lanes ────────────────────────────────────────────────────────────────

function newLane(info) {
	return {
		id: info.id,
		info,
		segs: [],
		marks: [],
		openInf: null,
		openWait: null,
		tools: new Map(),
		reqs: new Map(), // open source requests (izvor.upit u_toku) by id
		intercepts: new Set(),
		loopsOpen: 0,
		answered: false,
		error: false,
		left: false,
		blockedUntil: 0,
		reactT: 0,
		reactFrom: "",
		spawnT: 0,
		findings: 0,
		joinedAt: parseIso(info.joinedAt) || Date.now(),
	}
}

function ensureLane(info) {
	state.agents.set(info.id, info)
	let lane = state.lanes.get(info.id)
	if (!lane) {
		lane = newLane(info)
		state.lanes.set(info.id, lane)
	} else {
		lane.info = info
	}
	return lane
}

function stubInfo(ev) {
	const name = ev.producerName || ev.producerId
	const lower = String(name).toLowerCase()
	const dyn = name.includes("·")
	let group = "sistem"
	for (const g of CORE_ORDER) if (lower.startsWith(g)) group = g
	if (lower === "novinar") group = "novinar"
	if (lower.startsWith("firme")) group = "firme"
	else if (lower.startsWith("imovina")) group = "imovina"
	else if (lower.startsWith("provera")) group = "provera"
	else if (lower.startsWith("trijaž")) group = "trijaza"
	return {
		id: ev.producerId,
		name,
		role: group === "novinar" ? "human" : "agent",
		group,
		dynamic: dyn,
		sources: [],
		emoji: "",
		description: "",
		joinedAt: new Date(ev.t).toISOString(),
	}
}

function laneFor(ev, create) {
	const lane = state.lanes.get(ev.producerId)
	if (lane || !create) return lane
	return ensureLane(stubInfo(ev))
}

function closeSeg(seg, t) {
	if (seg && seg.t1 == null) seg.t1 = t
}

function closeAll(lane, t) {
	closeSeg(lane.openInf, t)
	closeSeg(lane.openWait, t)
	for (const seg of lane.tools.values()) closeSeg(seg, t)
	lane.openInf = lane.openWait = null
	lane.tools.clear()
	lane.reqs.clear()
	lane.intercepts.clear()
}

function hasBlockingTask(agentId) {
	for (const t of state.tasks.values()) if (t.status === "open" && t.blocking && t.fromAgentId === agentId) return true
	return false
}

function refreshWait(lane, t) {
	const waiting = lane.intercepts.size > 0 && hasBlockingTask(lane.id)
	if (waiting && !lane.openWait) {
		lane.openWait = { k: "wait", t0: t, t1: null, label: "čeka novinara", detail: "Interception: čeka odluku novinara" }
		lane.segs.push(lane.openWait)
	} else if (!waiting && lane.openWait) {
		closeSeg(lane.openWait, t)
		lane.openWait = null
	}
}

function refreshActive(t) {
	const ids = new Set()
	for (const l of state.loops.values()) ids.add(l.agentId)
	const n = ids.size
	state.active = n
	if (n > state.peak) state.peak = n
	const last = state.series[state.series.length - 1]
	if (!last || last.n !== n) {
		state.series.push({ t, n })
		if (state.series.length > 6000) state.series.splice(0, 1000)
	}
}

// ─── reset / snapshot ─────────────────────────────────────────────────────

function resetDerived(keepAgents = false) {
	state.loops.clear()
	if (keepAgents) {
		for (const lane of state.lanes.values()) {
			Object.assign(lane, newLane(lane.info), { joinedAt: lane.joinedAt })
		}
	} else {
		state.lanes.clear()
		state.agents.clear()
	}
	state.acts.clear()
	state.series = []
	state.active = 0
	state.peak = 0
	state.t0 = null
	state.tEnd = null
	state.eventCount = 0
	state.lastEvent = null
	state.filters = { agentId: null, entityId: null, section: "all" }
	seen.clear()
}

// Searches are one-time: a case or map that is still running survives a page reload, a finished one does not. The first
// snapshot of a page marks a finished run "stale": it is shown as the empty start state, and its replayed events are dropped,
// until the server starts another run.
let firstSnapshot = true
let staleRun = null
let serverRun = null
const runKeyOf = (snap) => snap.caseId || snap.mapa?.id || null
const isFinished = (snap) => (snap.caseId ? snap.status === "done" : snap.mapa?.id ? snap.mapa.status === "done" : false)
const isStale = () => !!staleRun && serverRun === staleRun

function withoutRun(snap) {
	return {
		...snap,
		caseId: null,
		status: "idle",
		input: "",
		focus: "",
		institution: null,
		findings: [],
		entities: [],
		conflicts: [],
		tasks: [],
		report: null,
		mapa: undefined,
		stats: undefined,
		budget: undefined,
		agents: (snap.agents || []).filter((a) => !a.dynamic),
	}
}

export function applySnapshot(snap) {
	if (!snap) return
	serverRun = runKeyOf(snap)
	if (firstSnapshot) {
		firstSnapshot = false
		if (serverRun && isFinished(snap)) staleRun = serverRun
	}
	if (isStale()) snap = withoutRun(snap)
	syncUntil = Date.now() + 2500
	const prevMapa = state.mapa.id
	const newCase = snap.caseId !== state.caseId || (!snap.caseId && (snap.mapa?.id || null) !== prevMapa)
	if (newCase) {
		resetDerived()
		state.ui.fresh = false
	}
	if (snap.mapa) {
		state.mapa = { id: snap.mapa.id, status: snap.mapa.status, startedAt: snap.mapa.startedAt || null, finishedAt: snap.mapa.finishedAt || null, veze: new Map(), rows: new Map((snap.mapa.rows || []).map((r) => [r.slug, r])) }
	}
	state.runKind = snap.caseId ? "case" : snap.mapa?.id ? "mapa" : "case"
	if (newCase && snap.caseId) state.ui.view = "dosije"
	else if (newCase && snap.mapa?.id && (state.live || snap.mapa.status === "running")) state.ui.view = "mapa"
	state.caseId = snap.caseId
	state.status = snap.status || "idle"
	state.input = snap.input || ""
	state.focus = snap.focus || ""
	state.institution = snap.institution || null
	state.findings = new Map((snap.findings || []).map((f) => [f.id, f]))
	state.entities = new Map((snap.entities || []).map((e) => [e.id, e]))
	state.conflicts = new Map((snap.conflicts || []).map((c) => [c.id, c]))
	state.tasks = new Map((snap.tasks || []).map((t) => [t.id, t]))
	state.budget = snap.budget || state.budget
	state.stats = snap.stats || state.stats
	state.report = snap.report || null
	if (snap.config) state.config = snap.config

	for (const a of snap.agents || []) {
		const lane = ensureLane(a)
		if (a.leftAt) lane.left = true
	}
	const t0 = parseIso(snap.stats?.startedAt)
	if (t0) state.t0 = t0
	const t1 = parseIso(snap.stats?.finishedAt)
	if (t1) state.tEnd = t1
	if (isDone()) for (const lane of state.lanes.values()) lane.answered = true

	if (!newCase && wasDisconnected) {
		// events were missed: do not leave segments hanging open forever
		const t = now()
		for (const lane of state.lanes.values()) {
			closeAll(lane, t)
			lane.loopsOpen = 0
		}
		state.loops.clear()
		refreshActive(t)
	}
	wasDisconnected = false
	for (const lane of state.lanes.values()) refreshWait(lane, now())
	state.live = true
	emit("snapshot", { newCase })
	emit("agents")
	emit("tasks", { initial: true })
	emit("meta")
	emit("mapa")
	emit("view", state.ui.view)
}

export function setConn(c) {
	if (c === "down" || c === "paused") wasDisconnected = true
	state.conn = c
	emit("conn", c)
}

export function applyStats(p) {
	if (!p) return
	if (p.stats) state.stats = p.stats
	if (p.budget) state.budget = p.budget
	const t0 = parseIso(p.stats?.startedAt)
	if (t0 && !state.t0) state.t0 = t0
	emit("meta")
}

export function setFilter(key, value) {
	const cur = state.filters[key]
	state.filters[key] = cur === value ? (key === "section" ? "all" : null) : value
	emit("filters", key)
}

export function setFilterValue(key, value) {
	state.filters[key] = value
	emit("filters", key)
}

export function clearFilters() {
	state.filters.agentId = null
	state.filters.entityId = null
	emit("filters", "all")
}

// ─── events ───────────────────────────────────────────────────────────────

export function applyEvent(ev) {
	if (!ev || typeof ev.seq !== "number" || seen.has(ev.seq)) return
	if (isStale()) return
	seen.add(ev.seq)
	// right after a snapshot the server replays history: those events must never raise toasts
	state.replay = Date.now() < syncUntil
	syncClock(ev.t)
	state.eventCount++
	state.lastEvent = ev
	const p = ev.payload || {}
	const t = ev.t

	switch (ev.type) {
		case "participant.joined": {
			const info = p.info || (p.manifest && stubInfo({ producerId: p.manifest.id, producerName: p.manifest.name, t }))
			if (!info) break
			const existed = state.lanes.has(info.id)
			const lane = ensureLane(info)
			lane.left = false
			if (info.dynamic && !existed) {
				lane.joinedAt = t
				lane.spawnT = t
				lane.marks.push({ k: "spawn", t, from: info.spawnedBy })
			}
			emit("agents", { spawned: info.dynamic && !existed ? info.id : null })
			break
		}
		case "participant.left": {
			const id = p.info?.id || p.manifest?.id || ev.producerId
			const lane = state.lanes.get(id)
			if (lane) {
				lane.left = true
				closeAll(lane, t)
				for (const [lid, l] of state.loops) if (l.agentId === id) state.loops.delete(lid)
				lane.loopsOpen = 0
				refreshActive(t)
			}
			emit("agents")
			break
		}
		case "message_received.started": {
			const lane = laneFor(ev, true)
			if (ev.loopId || p.loopId) {
				state.loops.set(ev.loopId || p.loopId, { agentId: ev.producerId, t })
				lane.loopsOpen++
				lane.answered = false
				lane.error = false
				// a cross-agent reaction: the loop's first message is "Povod: nalaz <agent>: <title>"
				const povod = String(p.content || "").match(/^Povod:\s*nalaz\s+(.+?):\s/)
				if (povod || /^Povod:/.test(String(p.content || ""))) {
					lane.reactT = t
					lane.reactFrom = povod ? povod[1] : ""
				}
				refreshActive(t)
			}
			emit("lane", lane.id)
			break
		}
		case "inference.started": {
			const lane = laneFor(ev, true)
			closeSeg(lane.openInf, t)
			lane.openInf = { k: "inf", t0: t, t1: null, label: "razmišlja", detail: p.model ? `model: ${p.model}` : "" }
			lane.segs.push(lane.openInf)
			emit("lane", lane.id)
			break
		}
		case "inference.completed": {
			const lane = laneFor(ev, true)
			if (lane.openInf) {
				if (p.tokens) lane.openInf.detail += ` · ${p.tokens.input}→${p.tokens.output} tokena`
				closeSeg(lane.openInf, t)
				lane.openInf = null
			}
			emit("lane", lane.id)
			break
		}
		case "function_call.started": {
			const lane = laneFor(ev, true)
			const seg = { k: "tool", t0: t, t1: null, label: p.name || "alat", detail: jsonShort(p.args, 260), callId: p.callId }
			lane.segs.push(seg)
			lane.tools.set(p.callId || `c${t}`, seg)
			emit("lane", lane.id)
			break
		}
		case "function_call.completed": {
			const lane = laneFor(ev, true)
			const seg = lane.tools.get(p.callId)
			if (seg) {
				closeSeg(seg, t)
				lane.tools.delete(p.callId)
			}
			emit("lane", lane.id)
			break
		}
		case "interception.started": {
			const lane = laneFor(ev, true)
			lane.intercepts.add(ev.loopId || p.loopId || "x")
			refreshWait(lane, t)
			emit("lane", lane.id)
			break
		}
		case "interception.finished": {
			const lane = laneFor(ev, true)
			lane.intercepts.delete(ev.loopId || p.loopId || "x")
			refreshWait(lane, t)
			emit("lane", lane.id)
			break
		}
		case "model.answer": {
			const lane = laneFor(ev, true)
			const id = ev.loopId || p.loopId
			if (id && state.loops.delete(id)) lane.loopsOpen = Math.max(0, lane.loopsOpen - 1)
			if (lane.loopsOpen === 0) {
				closeAll(lane, t)
				lane.answered = true
			}
			if (/^Agent nije uspeo/i.test(p.text || "")) lane.error = true
			refreshActive(t)
			emit("lane", lane.id)
			break
		}
		case "agent.reakcija": {
			const lane = state.lanes.get(p.agentId) || laneFor(ev, false)
			if (lane && p.reaction) {
				lane.reactT = t
				lane.reactFrom = p.reaction.fromAgent || ""
			}
			emit("lane", lane?.id)
			break
		}
		case "izvor.upit": {
			if (!p.id) break
			const prev = state.acts.get(p.id)
			const act = { ...p, t0: prev ? prev.t0 : parseIso(p.at) || t }
			state.acts.set(p.id, act)
			if (!prev && state.acts.size > 400) state.acts.delete(state.acts.keys().next().value)
			const lane = state.lanes.get(p.agentId) || laneFor(ev, true)
			if (p.status === "u_toku") lane.reqs.set(p.id, act)
			else lane.reqs.delete(p.id)
			emit("source", act)
			emit("lane", lane.id)
			break
		}
		case "mapa.started": {
			if (p.mapaId && p.mapaId !== state.mapa.id) {
				resetDerived(true)
				state.caseId = null
				state.status = "idle"
				state.findings.clear()
				state.entities.clear()
				state.conflicts.clear()
				state.tasks.clear()
				state.report = null
				state.mapa = { id: p.mapaId, status: "running", startedAt: new Date(t).toISOString(), finishedAt: null, veze: new Map(), rows: new Map((p.institutions || []).map((i) => [i.slug, { slug: i.slug, name: i.name, status: "queued", score: 0, signals: {}, reasons: [], sources: [] }])) }
				seen.add(ev.seq)
				state.eventCount = 1
				state.lastEvent = ev
				emit("snapshot", { newCase: true })
			}
			state.runKind = "mapa"
			state.ui.fresh = false
			state.mapa.status = "running"
			state.t0 = t
			state.tEnd = null
			if (state.live) state.ui.view = "mapa"
			emit("meta")
			emit("agents")
			emit("mapa")
			emit("view", state.ui.view)
			break
		}
		case "mapa.red": {
			const row = p.row
			if (!row) break
			if (p.mapaId && !state.mapa.id) state.mapa.id = p.mapaId
			state.mapa.rows.set(row.slug, row)
			const lane = row.agentId ? state.lanes.get(row.agentId) : null
			if (lane && row.status === "done") {
				lane.marks.push({ k: "finding", t, id: row.slug, label: `${row.name}: ${row.score}`, sev: row.score >= 60 ? "signal" : "info" })
				lane.findings++
			}
			emit("mapa", { slug: row.slug })
			break
		}
		case "mapa.veza": {
			if (p.veza?.key) state.mapa.veze.set(p.veza.key, p.veza)
			emit("mapa", { veza: true })
			break
		}
		case "mapa.zavrsena": {
			state.mapa.status = "done"
			state.mapa.finishedAt = new Date(t).toISOString()
			for (const row of p.ranking || []) state.mapa.rows.set(row.slug, row)
			state.tEnd = t
			for (const lane of state.lanes.values()) {
				closeAll(lane, t)
				lane.loopsOpen = 0
				lane.answered = true
			}
			state.loops.clear()
			refreshActive(t)
			emit("meta")
			emit("mapa", { done: true })
			emit("lane")
			break
		}
		case "dosije.started": {
			state.runKind = "case"
			state.ui.fresh = false
			state.ui.view = "dosije"
			emit("view", "dosije")
			if (p.caseId && p.caseId !== state.caseId) {
				resetDerived(true)
				state.caseId = p.caseId
				state.findings.clear()
				state.entities.clear()
				state.conflicts.clear()
				state.tasks.clear()
				state.report = null
				seen.add(ev.seq)
				state.eventCount = 1
				state.lastEvent = ev
				emit("snapshot", { newCase: true })
			}
			state.t0 = t
			state.tEnd = null
			state.status = "running"
			state.input = p.input || state.input
			state.focus = p.focus || ""
			state.institution = p.institution || state.institution
			emit("meta")
			emit("agents")
			break
		}
		case "entity.added": {
			if (p.entity) state.entities.set(p.entity.id, p.entity)
			emit("entities", p.entity)
			break
		}
		case "finding.added": {
			const f = p.finding
			if (!f) break
			state.findings.set(f.id, f)
			const lane = state.lanes.get(f.agentId || ev.producerId)
			if (lane) {
				lane.marks.push({ k: "finding", t, id: f.id, label: f.title, sev: f.severity })
				lane.findings++
			}
			emit("finding", { id: f.id, kind: "new" })
			break
		}
		case "finding.updated": {
			const f = p.finding
			if (!f) break
			for (const gone of f.mergedFrom || []) {
				if (gone !== f.id && state.findings.delete(gone)) emit("finding", { id: gone, kind: "remove" })
			}
			state.findings.set(f.id, f)
			const lane = laneFor(ev, false)
			if (lane) lane.marks.push({ k: "edit", t, label: `${p.reason}: ${f.title}` })
			emit("finding", { id: f.id, kind: "update", reason: p.reason })
			break
		}
		case "conflict.resolved": {
			if (p.conflict) state.conflicts.set(p.conflict.id, p.conflict)
			const lane = laneFor(ev, false)
			if (lane) lane.marks.push({ k: "edit", t, label: `konflikt: ${p.conflict?.subject || ""}` })
			emit("conflict", p.conflict)
			break
		}
		case "claim.blocked": {
			const lane = state.lanes.get(p.agentId) || laneFor(ev, false)
			if (lane) {
				lane.blockedUntil = t + 4000
				lane.marks.push({ k: "block", t, label: `blokirano: ${p.title}` })
			}
			emit("lane", lane?.id)
			break
		}
		case "pitanje.za_coveka": {
			if (!p.task) break
			state.tasks.set(p.task.id, p.task)
			const lane = state.lanes.get(p.task.fromAgentId)
			if (lane) refreshWait(lane, t)
			emit("tasks", { task: p.task, isNew: !state.replay }) // replayed history after a page load must not toast
			emit("lane", lane?.id)
			break
		}
		case "task.updated": {
			if (!p.task) break
			state.tasks.set(p.task.id, p.task)
			const lane = state.lanes.get(p.task.fromAgentId)
			if (lane) refreshWait(lane, t)
			emit("tasks", { task: p.task, isNew: false })
			emit("lane", lane?.id)
			break
		}
		case "odgovor.coveka": {
			const lane = [...state.lanes.values()].find((l) => l.info.group === "novinar") || laneFor(ev, false)
			if (lane) lane.marks.push({ k: "answer", t, label: p.decision ? (p.decision === "approve" ? "odobreno" : "odbijeno") : "odgovor poslat" })
			const task = state.tasks.get(p.taskId)
			if (task && task.status === "open") {
				const updated = { ...task, status: p.decision === "approve" ? "approved" : p.decision === "reject" ? "rejected" : "answered", answer: p.answer ?? task.answer, answeredAt: new Date(t).toISOString() }
				state.tasks.set(task.id, updated)
				const al = state.lanes.get(task.fromAgentId)
				if (al) refreshWait(al, t)
				emit("tasks", { task: updated, isNew: false })
			}
			emit("lane", lane?.id)
			break
		}
		case "budget.updated": {
			if (p.budget) state.budget = p.budget
			emit("meta")
			break
		}
		case "dosije.zatvori": {
			if (state.status === "running") state.status = "finalizing"
			emit("meta")
			break
		}
		case "dosije.zavrsen": {
			state.status = "done"
			state.tEnd = t
			state.report = p.report || state.report
			for (const lane of state.lanes.values()) {
				closeAll(lane, t)
				lane.loopsOpen = 0
				lane.answered = true
			}
			state.loops.clear()
			refreshActive(t)
			emit("meta")
			emit("done", p.report)
			emit("lane")
			break
		}
		default:
			break
	}

	emit("event", ev)
}
