// Timeline (canvas, redrawn at most 4 times a second) on a shared time axis + concurrency chart (SVG).
// Overlapping bars across lanes are the visual proof that agents run concurrently.

import { state, on, laneEnd, activeCount, peakCount, isRunning } from "./store.js"
import { laneRows } from "./lanes.js"
import { s, parseIso, fmtDur, truncate } from "./format.js"

const RULER_H = 22
const PAD_L = 1
const PAD_R = 8
const BAR_H = 10
const MIN_FRAME_MS = 250 // 4 fps at most
const C = {
	inf: "#CFCBC2",
	tool: "#1F4E79",
	wait: "#B45309",
	tick: "#1C1B19",
	spawn: "#55534E",
	signal: "#B42318",
	axis: "#8A8780",
	grid: "#EFEDE7",
	rule: "#E6E3DC",
	paper: "#FBFAF7",
}
const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 3600]
const MONO = 'ui-monospace, "SF Mono", "Cascadia Mono", Consolas, monospace'

let wrap, canvas, ctx, dynEl, tip, teamEl
let dirty = true
let hits = []
let stripe = null
let sparkWrap, sparkSvg, sparkArea, sparkLine, sparkGrid, sparkMax, concLabel
let lastConc = ""

const markDirty = () => {
	dirty = true
}

function makeStripePattern(c) {
	const off = document.createElement("canvas")
	off.width = off.height = 8
	const x = off.getContext("2d")
	x.fillStyle = "rgba(180,83,9,.16)"
	x.fillRect(0, 0, 8, 8)
	x.strokeStyle = C.wait
	x.lineWidth = 1.5
	x.beginPath()
	for (const d of [-8, 0, 8]) {
		x.moveTo(d, 8)
		x.lineTo(d + 8, 0)
	}
	x.stroke()
	return c.createPattern(off, "repeat")
}

/** Shared time -> x mapping (the chart uses the same one so the axes line up). */
function axis(W) {
	const t0 = state.t0
	if (!t0) return null
	const end = laneEnd()
	const running = isRunning()
	const span = Math.max((end - t0) * (running ? 1.04 : 1.01), 15000)
	const innerW = Math.max(10, W - PAD_L - PAD_R)
	return { t0, end, span, innerW, X: (t) => PAD_L + ((t - t0) / span) * innerW }
}

function fmtTick(sec) {
	const m = Math.floor(sec / 60)
	const r = sec % 60
	return `${m}:${String(r).padStart(2, "0")}`
}

function resizeCanvas() {
	const r = canvas.getBoundingClientRect()
	const dpr = window.devicePixelRatio || 1
	const w = Math.max(1, Math.round(r.width * dpr))
	const h = Math.max(1, Math.round(r.height * dpr))
	if (canvas.width !== w || canvas.height !== h) {
		canvas.width = w
		canvas.height = h
		stripe = null
	}
	return { W: r.width, H: r.height, top: r.top, dpr }
}

function draw() {
	const { W, H, top, dpr } = resizeCanvas()
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
	ctx.clearRect(0, 0, W, H)
	hits = []
	const ax = axis(W)
	if (!ax) return
	const { X, end, span, innerW, t0 } = ax
	const running = isRunning()
	if (!stripe) stripe = makeStripePattern(ctx)

	// ruler + grid
	const spanSec = span / 1000
	let step = STEPS[STEPS.length - 1]
	for (const st of STEPS) {
		if ((st / spanSec) * innerW >= 56) {
			step = st
			break
		}
	}
	ctx.font = `10px ${MONO}`
	ctx.textBaseline = "middle"
	ctx.textAlign = "left"
	const nowX = X(end)
	ax.ticks = []
	for (let sec = 0; sec <= spanSec; sec += step) {
		const x = Math.round(X(t0 + sec * 1000)) + 0.5
		ax.ticks.push(x)
		ctx.fillStyle = C.axis
		if (!(x > nowX - 64 && x < nowX + 6)) ctx.fillText(fmtTick(sec), x + 3, RULER_H / 2 - 2)
		ctx.fillRect(x, RULER_H - 5, 1, 5)
	}
	ax.nx = Math.round(nowX) + 0.5
	ax.col = running ? C.signal : C.axis
	ctx.fillStyle = C.rule
	ctx.fillRect(0, RULER_H - 1, W, 1)

	// rows
	const dynRect = dynEl.getBoundingClientRect()
	const dynTop = dynRect.top - top
	const dynBottom = dynRect.bottom - top
	const teamRect = teamEl.getBoundingClientRect()
	const info = new Map()
	for (const el of laneRows()) {
		const tr = el.querySelector(".lane-track").getBoundingClientRect()
		const y0 = tr.top - top
		info.set(el.dataset.lane, { y0, h: tr.height, cy: y0 + tr.height / 2, inDyn: dynEl.contains(el), dim: el.classList.contains("dim") })
	}
	const clipBottomAll = Math.min(H, teamRect.bottom - top)

	for (const [id, r] of info) {
		const lane = state.lanes.get(id)
		if (!lane) continue
		const clipTop = r.inDyn ? Math.max(RULER_H, dynTop) : RULER_H
		const clipBottom = r.inDyn ? Math.min(dynBottom, clipBottomAll) : clipBottomAll
		if (r.y0 + r.h < clipTop || r.y0 > clipBottom) continue
		ctx.save()
		ctx.beginPath()
		ctx.rect(0, clipTop, W, clipBottom - clipTop)
		ctx.clip()
		if (r.dim) ctx.globalAlpha = 0.3
		drawRow(lane, r, ax, end)
		ctx.restore()
	}

	// now line: 1px red while running (gray end line afterwards); the rows draw their own segment so it never crosses text
	const nx = ax.nx
	const col = ax.col
	ctx.fillStyle = col
	ctx.fillRect(nx, RULER_H - 8, 1, 8)
	const label = running ? "sada" : "kraj"
	ctx.font = `10px system-ui, sans-serif`
	const lw = ctx.measureText(label).width + 6
	const lx = Math.min(nx - lw - 2, W - lw - 2)
	ctx.fillStyle = C.paper
	ctx.fillRect(lx, 2, lw, 12)
	ctx.fillStyle = col
	ctx.textAlign = "left"
	ctx.fillText(label, lx + 3, 8)
}

function drawRow(lane, r, ax, end) {
	const { X } = ax
	const { y0, cy } = r
	ctx.fillStyle = C.grid
	for (const x of ax.ticks) ctx.fillRect(x, y0 - 2, 1, r.h + 4)
	ctx.fillRect(PAD_L, Math.round(cy), ax.innerW, 1)

	// the journalist's open questions: amber hatched spans while waiting for her
	if (lane.info.group === "novinar") {
		for (const t of state.tasks.values()) {
			const a = parseIso(t.createdAt)
			if (!a) continue
			const b = t.status === "open" ? end : parseIso(t.answeredAt) || end
			const x1 = X(a)
			const w = Math.max(3, X(b) - x1)
			ctx.fillStyle = stripe || C.wait
			ctx.fillRect(x1, cy - BAR_H / 2, w, BAR_H)
			hits.push({ x: x1, y: cy - 7, w, h: 14, title: `${t.kind === "odobrenje" ? "Odobrenje" : "Pitanje"}: ${truncate(t.title, 60)}`, sub: `${t.status === "open" ? "čeka odgovor" : "odgovoreno"} · ${fmtDur(b - a)}` })
		}
	}

	for (const seg of lane.segs) {
		const x1 = X(seg.t0)
		const x2 = X(seg.t1 ?? end)
		if (x2 < PAD_L - 4) continue
		const w = Math.max(2, x2 - x1)
		const y = cy - BAR_H / 2
		if (seg.k === "wait") {
			ctx.fillStyle = stripe || C.wait
			ctx.fillRect(x1, y, w, BAR_H)
			ctx.strokeStyle = C.wait
			ctx.lineWidth = 1
			ctx.strokeRect(x1 + 0.5, y + 0.5, Math.max(1, w - 1), BAR_H - 1)
		} else {
			ctx.fillStyle = seg.k === "inf" ? C.inf : C.tool
			ctx.fillRect(x1, y, w, BAR_H)
		}
		hits.push({
			x: x1,
			y: cy - BAR_H / 2 - 3,
			w,
			h: BAR_H + 6,
			title: seg.k === "inf" ? "Razmišlja" : seg.k === "tool" ? `Alat: ${seg.label}` : "Čeka odluku novinara",
			sub: `${fmtDur((seg.t1 ?? end) - seg.t0)}${seg.t1 == null ? " · u toku" : ""}${seg.detail ? `\n${seg.detail}` : ""}`,
		})
	}

	for (const m of lane.marks) {
		const x = X(m.t)
		if (x < PAD_L - 6) continue
		if (m.k === "finding") {
			ctx.fillStyle = C.tick
			ctx.fillRect(Math.round(x) - 1, cy - 9, 2, 18)
			hits.push({ x: x - 4, y: cy - 10, w: 8, h: 20, title: "Nalaz", sub: m.label })
		} else if (m.k === "spawn") {
			ctx.beginPath()
			ctx.arc(x, cy, 4, 0, Math.PI * 2)
			ctx.fillStyle = C.paper
			ctx.fill()
			ctx.strokeStyle = C.spawn
			ctx.lineWidth = 1.25
			ctx.stroke()
			hits.push({ x: x - 6, y: cy - 6, w: 12, h: 12, title: "Pokrenut agent", sub: lane.info.name })
		} else if (m.k === "block") {
			ctx.strokeStyle = C.signal
			ctx.lineWidth = 1.5
			ctx.beginPath()
			ctx.moveTo(x - 3, cy - 3)
			ctx.lineTo(x + 3, cy + 3)
			ctx.moveTo(x + 3, cy - 3)
			ctx.lineTo(x - 3, cy + 3)
			ctx.stroke()
			hits.push({ x: x - 6, y: cy - 6, w: 12, h: 12, title: "Blokiran nalaz", sub: m.label })
		} else if (m.k === "edit") {
			ctx.fillStyle = C.axis
			ctx.fillRect(Math.round(x) - 1, y0 - 1, 2, 3)
			hits.push({ x: x - 4, y: y0 - 2, w: 8, h: 6, title: "Urednik", sub: m.label })
		} else if (m.k === "answer") {
			ctx.fillStyle = C.tool
			ctx.beginPath()
			ctx.arc(x, cy, 3, 0, Math.PI * 2)
			ctx.fill()
			hits.push({ x: x - 6, y: cy - 6, w: 12, h: 12, title: "Novinar", sub: m.label })
		}
	}

	ctx.fillStyle = ax.col
	ctx.fillRect(ax.nx, y0 - 3, 1, r.h + 6)
}

// ─── concurrency chart ────────────────────────────────────────────────────

function buildSpark() {
	sparkSvg = s("svg", { class: "spark-svg", preserveAspectRatio: "none" })
	sparkGrid = s("path", { class: "spark-grid" })
	sparkArea = s("path", { class: "spark-area" })
	sparkLine = s("path", { class: "spark-line" })
	sparkMax = s("text", { class: "spark-max", x: String(PAD_L + 2), y: "9" })
	sparkSvg.append(sparkGrid, sparkArea, sparkLine, sparkMax)
	sparkWrap.appendChild(sparkSvg)
}

function drawSpark() {
	const now = activeCount()
	const peak = peakCount()
	const label = `istovremeno aktivnih: ${now} (vrhunac ${peak})`
	if (label !== lastConc) {
		lastConc = label
		concLabel.textContent = label
	}
	const W = sparkWrap.clientWidth
	const H = sparkWrap.clientHeight
	if (!W || !H) return
	sparkSvg.setAttribute("viewBox", `0 0 ${W} ${H}`)
	sparkSvg.setAttribute("width", W)
	sparkSvg.setAttribute("height", H)
	const ax = axis(W)
	const series = state.series
	if (!ax || !series.length) {
		sparkLine.setAttribute("d", "")
		sparkArea.setAttribute("d", "")
		sparkGrid.setAttribute("d", "")
		sparkMax.textContent = ""
		return
	}
	const ymax = Math.max(4, peak)
	const base = H - 1
	const Y = (n) => base - (n / ymax) * (H - 12)
	let grid = ""
	for (const n of [Math.round(ymax / 2), ymax]) grid += `M${PAD_L},${Y(n).toFixed(1)}H${W - PAD_R}`
	sparkGrid.setAttribute("d", grid)
	sparkMax.textContent = String(ymax)
	sparkMax.setAttribute("y", String(Math.max(9, Y(ymax) - 2)))

	const x0 = ax.X(Math.max(series[0].t, ax.t0))
	let d = `M${x0.toFixed(1)},${Y(series[0].n).toFixed(1)}`
	for (let i = 1; i < series.length; i++) {
		d += `H${ax.X(Math.max(series[i].t, ax.t0)).toFixed(1)}V${Y(series[i].n).toFixed(1)}`
	}
	d += `H${ax.X(ax.end).toFixed(1)}`
	sparkLine.setAttribute("d", d)
	sparkArea.setAttribute("d", `${d}V${base}H${x0.toFixed(1)}Z`)
}

// ─── tooltip ──────────────────────────────────────────────────────────────

function onMove(e) {
	const r = canvas.getBoundingClientRect()
	const mx = e.clientX - r.left
	const my = e.clientY - r.top
	let hit = null
	for (let i = hits.length - 1; i >= 0; i--) {
		const k = hits[i]
		if (mx >= k.x - 1 && mx <= k.x + k.w + 1 && my >= k.y && my <= k.y + k.h) {
			hit = k
			break
		}
	}
	if (!hit || my < RULER_H) {
		tip.classList.remove("show")
		return
	}
	tip.replaceChildren()
	const t = document.createElement("div")
	t.className = "tip-title"
	t.textContent = hit.title
	tip.appendChild(t)
	if (hit.sub) {
		const sub = document.createElement("div")
		sub.className = "tip-sub"
		sub.textContent = hit.sub
		tip.appendChild(sub)
	}
	tip.classList.add("show")
	const tw = tip.offsetWidth
	const th = tip.offsetHeight
	let x = e.clientX + 14
	let y = e.clientY + 16
	if (x + tw > window.innerWidth - 8) x = e.clientX - tw - 14
	if (y + th > window.innerHeight - 8) y = e.clientY - th - 14
	tip.style.transform = `translate(${Math.max(8, x)}px, ${Math.max(8, y)}px)`
}

export function initGantt() {
	wrap = document.getElementById("ganttWrap")
	canvas = document.getElementById("gantt")
	ctx = canvas.getContext("2d")
	dynEl = document.getElementById("lanesDyn")
	teamEl = document.getElementById("teamPanel")
	tip = document.getElementById("tip")
	sparkWrap = document.getElementById("sparkPlot")
	concLabel = document.getElementById("concLabel")
	buildSpark()

	wrap.addEventListener("mousemove", onMove)
	wrap.addEventListener("mouseleave", () => tip.classList.remove("show"))
	dynEl.addEventListener("scroll", markDirty, { passive: true })
	teamEl.addEventListener("scroll", markDirty, { passive: true })
	window.addEventListener("resize", markDirty)
	new ResizeObserver(markDirty).observe(wrap)
	new ResizeObserver(markDirty).observe(teamEl)
	for (const t of ["lane", "agents", "snapshot", "filters", "tasks", "meta", "done", "mapa"]) on(t, markDirty)

	let last = -MIN_FRAME_MS
	const frame = (ts) => {
		requestAnimationFrame(frame)
		if (document.hidden) return
		if (ts - last < MIN_FRAME_MS) return
		if (!dirty && !isRunning()) return
		last = ts
		dirty = false
		draw()
		drawSpark()
	}
	requestAnimationFrame(frame)
}
