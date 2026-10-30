// Live Gantt (canvas, ~10 fps) on a shared time axis + concurrency sparkline (SVG).
// Overlapping bars across lanes are the visual proof that agents run concurrently.

import { state, on, laneEnd, activeCount, peakCount } from "./store.js"
import { laneRows } from "./lanes.js"
import { s, parseIso, fmtDur, truncate } from "./format.js"

const RULER_H = 26
const PAD_L = 8
const PAD_R = 14
const COLORS = {
	inf: "#a78bfa",
	tool: "#38bdf8",
	wait: "#ffb547",
	finding: "#ffffff",
	spawn: "#3ddc97",
	block: "#ff5d6c",
	edit: "#c4b5fd",
	answer: "#7aa2ff",
	now: "#7aa2ff",
}
const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 3600]

let wrap, canvas, ctx, dynEl, tip
let dirty = true
let hits = []
let stripe = null
let sparkWrap, sparkSvg, sparkArea, sparkLine, sparkGrid, sparkDot, sparkNowEl, sparkPeakEl, sparkLastNow = -1, sparkLastPeak = -1

const markDirty = () => {
	dirty = true
}

function makeStripePattern(c) {
	const off = document.createElement("canvas")
	off.width = off.height = 10
	const x = off.getContext("2d")
	x.fillStyle = "rgba(255,181,71,.22)"
	x.fillRect(0, 0, 10, 10)
	x.strokeStyle = "rgba(255,181,71,.95)"
	x.lineWidth = 3
	x.beginPath()
	for (const d of [-10, 0, 10]) {
		x.moveTo(d, 10)
		x.lineTo(d + 10, 0)
	}
	x.stroke()
	return c.createPattern(off, "repeat")
}

/** Shared time -> x mapping (the sparkline uses the same one so the axes line up). */
function axis(W) {
	const t0 = state.t0
	if (!t0) return null
	const end = laneEnd()
	const running = state.status === "running" || state.status === "finalizing"
	const span = Math.max((end - t0) * (running ? 1.03 : 1.01), 15000)
	const innerW = Math.max(10, W - PAD_L - PAD_R)
	return { t0, end, span, innerW, X: (t) => PAD_L + ((t - t0) / span) * innerW }
}

function rrect(x, y, w, h, r) {
	ctx.beginPath()
	if (ctx.roundRect) ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2))
	else ctx.rect(x, y, w, h)
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
	return { W: r.width, H: r.height, top: r.top, left: r.left, dpr }
}

function draw() {
	const { W, H, top, dpr } = resizeCanvas()
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
	ctx.clearRect(0, 0, W, H)
	hits = []
	const ax = axis(W)
	if (!ax) {
		ctx.fillStyle = "rgba(139,151,179,.55)"
		ctx.font = "11px ui-monospace, Consolas, monospace"
		ctx.fillText("vremenska osa počinje kad krene dosije", PAD_L, RULER_H + 24)
		return
	}
	const { X, end, span, innerW, t0 } = ax
	const running = state.status === "running" || state.status === "finalizing"
	if (!stripe) stripe = makeStripePattern(ctx)
	const phase = (performance.now() / 60) % 10
	if (stripe && stripe.setTransform) stripe.setTransform(new DOMMatrix().translate(-phase, 0))

	// ruler + grid
	const spanSec = span / 1000
	let step = STEPS[STEPS.length - 1]
	for (const st of STEPS) {
		if ((st / spanSec) * innerW >= 62) {
			step = st
			break
		}
	}
	ctx.font = "10px ui-monospace, Consolas, monospace"
	ctx.textBaseline = "middle"
	for (let sec = 0; sec <= spanSec; sec += step) {
		const x = Math.round(X(t0 + sec * 1000)) + 0.5
		ctx.fillStyle = "rgba(120,140,190,.07)"
		ctx.fillRect(x, RULER_H, 1, H - RULER_H)
		ctx.fillStyle = "rgba(139,151,179,.8)"
		ctx.fillText(fmtTick(sec), x + 4, RULER_H / 2)
		ctx.fillStyle = "rgba(139,151,179,.35)"
		ctx.fillRect(x, RULER_H - 6, 1, 6)
	}
	ctx.fillStyle = "rgba(120,140,190,.18)"
	ctx.fillRect(0, RULER_H - 1, W, 1)

	// rows
	const dynRect = dynEl.getBoundingClientRect()
	const dynTop = dynRect.top - top
	const dynBottom = dynRect.bottom - top
	const info = new Map()
	for (const el of laneRows()) {
		const tr = el.querySelector(".lane-track").getBoundingClientRect()
		const y0 = tr.top - top
		const inDyn = dynEl.contains(el)
		info.set(el.dataset.lane, { y0, h: tr.height, cy: y0 + tr.height / 2, inDyn, dim: el.classList.contains("dim") })
	}

	// spawn connectors (spawner row -> new row)
	ctx.save()
	ctx.beginPath()
	ctx.rect(0, RULER_H, W, H - RULER_H)
	ctx.clip()
	ctx.setLineDash([3, 3])
	ctx.lineWidth = 1
	ctx.strokeStyle = "rgba(61,220,151,.45)"
	for (const lane of state.lanes.values()) {
		for (const m of lane.marks) {
			if (m.k !== "spawnOut") continue
			const a = info.get(lane.id)
			const b = info.get(m.to)
			if (!a || !b) continue
			let y2 = b.cy
			if (b.inDyn) y2 = Math.min(Math.max(y2, dynTop), dynBottom)
			const x = Math.round(X(m.t)) + 0.5
			ctx.beginPath()
			ctx.moveTo(x, a.cy + 6)
			ctx.lineTo(x, y2)
			ctx.stroke()
		}
	}
	ctx.restore()

	for (const [id, r] of info) {
		const lane = state.lanes.get(id)
		if (!lane) continue
		const clipTop = r.inDyn ? Math.max(RULER_H, dynTop) : RULER_H
		const clipBottom = r.inDyn ? dynBottom : H
		if (r.y0 + r.h < clipTop || r.y0 > clipBottom) continue
		ctx.save()
		ctx.beginPath()
		ctx.rect(0, clipTop, W, clipBottom - clipTop)
		ctx.clip()
		if (r.dim) ctx.globalAlpha = 0.28
		drawRow(lane, r, ax, end, running)
		ctx.restore()
	}

	// now line
	const nx = Math.round(X(end)) + 0.5
	const grad = ctx.createLinearGradient(0, RULER_H, 0, H)
	grad.addColorStop(0, running ? "rgba(122,162,255,.95)" : "rgba(139,151,179,.6)")
	grad.addColorStop(1, running ? "rgba(122,162,255,.25)" : "rgba(139,151,179,.15)")
	ctx.fillStyle = grad
	ctx.fillRect(nx, RULER_H - 2, 1.5, H - RULER_H + 2)
	const label = running ? "sada" : "kraj"
	ctx.font = "600 9.5px system-ui, sans-serif"
	const lw = ctx.measureText(label).width + 10
	const lx = Math.min(nx - lw / 2, W - lw - 2)
	ctx.fillStyle = running ? "#7aa2ff" : "#46506b"
	rrect(lx, 3, lw, 15, 7)
	ctx.fill()
	ctx.fillStyle = running ? "#0a1020" : "#dbe3f5"
	ctx.textBaseline = "middle"
	ctx.fillText(label, lx + 5, 11)
}

function drawRow(lane, r, ax, end, running) {
	const { X } = ax
	const { y0, h, cy } = r
	const barH = Math.max(8, Math.min(14, h - 18))
	ctx.fillStyle = "rgba(255,255,255,.035)"
	ctx.fillRect(PAD_L, Math.round(cy), ax.innerW, 1)

	// the journalist's open questions: thin amber spans while waiting for her
	if (lane.info.group === "novinar") {
		for (const t of state.tasks.values()) {
			const a = parseIso(t.createdAt)
			if (!a) continue
			const b = t.status === "open" ? end : parseIso(t.answeredAt) || end
			const x1 = X(a)
			const w = Math.max(3, X(b) - x1)
			ctx.fillStyle = "rgba(255,181,71,.22)"
			rrect(x1, cy - 4, w, 8, 3)
			ctx.fill()
			ctx.strokeStyle = "rgba(255,181,71,.7)"
			ctx.lineWidth = 1
			ctx.stroke()
			hits.push({ x: x1, y: cy - 6, w, h: 12, title: `${t.kind === "odobrenje" ? "Odobrenje" : "Pitanje"}: ${truncate(t.title, 60)}`, sub: `${t.status === "open" ? "čeka odgovor" : "odgovoreno"} · ${fmtDur(b - a)}` })
		}
	}

	for (const seg of lane.segs) {
		const x1 = X(seg.t0)
		const x2 = X(seg.t1 ?? end)
		if (x2 < PAD_L - 4) continue
		const w = Math.max(2.5, x2 - x1)
		const y = cy - barH / 2
		if (seg.k === "wait") {
			ctx.fillStyle = stripe || "#ffb547"
			rrect(x1, y - 1, w, barH + 2, 3)
			ctx.fill()
			ctx.strokeStyle = COLORS.wait
			ctx.lineWidth = 1.2
			ctx.stroke()
		} else {
			const c = seg.k === "inf" ? COLORS.inf : COLORS.tool
			ctx.fillStyle = c
			ctx.globalAlpha *= seg.k === "inf" ? 0.88 : 0.95
			rrect(x1, y, w, barH, 3)
			ctx.fill()
			ctx.globalAlpha /= seg.k === "inf" ? 0.88 : 0.95
			if (seg.t1 == null && running) {
				ctx.fillStyle = "rgba(255,255,255,.75)"
				ctx.fillRect(x2 - 2, y, 2, barH)
			}
		}
		hits.push({
			x: x1,
			y: cy - barH / 2 - 2,
			w,
			h: barH + 4,
			title: seg.k === "inf" ? "Inferencija" : seg.k === "tool" ? `Alat: ${seg.label}` : "Čeka novinara (interception)",
			sub: `${fmtDur((seg.t1 ?? end) - seg.t0)}${seg.t1 == null ? " · u toku" : ""}${seg.detail ? `\n${seg.detail}` : ""}`,
		})
	}

	const markY = y0 + 8
	for (const m of lane.marks) {
		const x = X(m.t)
		if (x < PAD_L - 6) continue
		if (m.k === "finding") {
			ctx.fillStyle = "#fff"
			ctx.beginPath()
			ctx.arc(x, markY, 3.4, 0, Math.PI * 2)
			ctx.fill()
			if (m.sev === "signal") {
				ctx.strokeStyle = "#ff5d6c"
				ctx.lineWidth = 1.6
				ctx.stroke()
			}
			hits.push({ x: x - 6, y: markY - 6, w: 12, h: 12, title: "Nalaz", sub: m.label })
		} else if (m.k === "spawn") {
			diamond(x, cy, 5.5, COLORS.spawn, true)
			hits.push({ x: x - 7, y: cy - 7, w: 14, h: 14, title: "Pokrenut agent", sub: lane.info.name })
		} else if (m.k === "spawnOut") {
			diamond(x, y0 + r.h - 9, 3.8, COLORS.spawn, false)
		} else if (m.k === "block") {
			ctx.strokeStyle = COLORS.block
			ctx.lineWidth = 2
			ctx.beginPath()
			ctx.moveTo(x - 3.5, markY - 3.5)
			ctx.lineTo(x + 3.5, markY + 3.5)
			ctx.moveTo(x + 3.5, markY - 3.5)
			ctx.lineTo(x - 3.5, markY + 3.5)
			ctx.stroke()
			hits.push({ x: x - 6, y: markY - 6, w: 12, h: 12, title: "Blokiran nalaz", sub: m.label })
		} else if (m.k === "edit") {
			ctx.strokeStyle = COLORS.edit
			ctx.lineWidth = 1.8
			ctx.beginPath()
			ctx.arc(x, markY, 3.6, 0, Math.PI * 2)
			ctx.stroke()
			hits.push({ x: x - 6, y: markY - 6, w: 12, h: 12, title: "Urednik", sub: m.label })
		} else if (m.k === "answer") {
			ctx.fillStyle = COLORS.answer
			ctx.beginPath()
			ctx.arc(x, cy, 4.2, 0, Math.PI * 2)
			ctx.fill()
			ctx.strokeStyle = "#0d1322"
			ctx.lineWidth = 1.5
			ctx.stroke()
			hits.push({ x: x - 7, y: cy - 7, w: 14, h: 14, title: "Novinar", sub: m.label })
		}
	}
}

function diamond(x, y, r, color, fill) {
	ctx.beginPath()
	ctx.moveTo(x, y - r)
	ctx.lineTo(x + r, y)
	ctx.lineTo(x, y + r)
	ctx.lineTo(x - r, y)
	ctx.closePath()
	if (fill) {
		ctx.fillStyle = color
		ctx.fill()
		ctx.strokeStyle = "#0d1322"
		ctx.lineWidth = 1.2
		ctx.stroke()
	} else {
		ctx.strokeStyle = color
		ctx.lineWidth = 1.4
		ctx.stroke()
	}
}

// ─── sparkline ────────────────────────────────────────────────────────────

function buildSpark() {
	sparkSvg = s("svg", { class: "spark-svg", preserveAspectRatio: "none" })
	const defs = s("defs")
	const g = s("linearGradient", { id: "sparkGrad", x1: "0", y1: "0", x2: "0", y2: "1" })
	g.append(s("stop", { offset: "0", "stop-color": "#7aa2ff", "stop-opacity": ".55" }), s("stop", { offset: "1", "stop-color": "#7aa2ff", "stop-opacity": ".02" }))
	defs.append(g)
	sparkGrid = s("path", { class: "spark-grid" })
	sparkArea = s("path", { class: "spark-area", fill: "url(#sparkGrad)" })
	sparkLine = s("path", { class: "spark-line" })
	sparkDot = s("circle", { class: "spark-dot", r: "3.5" })
	sparkSvg.append(defs, sparkGrid, sparkArea, sparkLine, sparkDot)
	sparkWrap.appendChild(sparkSvg)
}

function drawSpark() {
	const W = sparkWrap.clientWidth
	const H = sparkWrap.clientHeight
	if (!W || !H) return
	sparkSvg.setAttribute("viewBox", `0 0 ${W} ${H}`)
	sparkSvg.setAttribute("width", W)
	sparkSvg.setAttribute("height", H)
	const now = activeCount()
	const peak = peakCount()
	if (sparkNowEl && sparkLastNow !== now) {
		sparkNowEl.textContent = String(now)
		sparkLastNow = now
	}
	if (sparkPeakEl && sparkLastPeak !== peak) {
		sparkPeakEl.textContent = String(peak)
		sparkLastPeak = peak
	}
	const ax = axis(W)
	const series = state.series
	if (!ax || !series.length) {
		sparkLine.setAttribute("d", "")
		sparkArea.setAttribute("d", "")
		sparkGrid.setAttribute("d", "")
		sparkDot.setAttribute("r", "0")
		return
	}
	const ymax = Math.max(4, peak)
	const base = H - 5
	const Y = (n) => base - (n / ymax) * (H - 14)
	let grid = ""
	for (let n = 1; n <= ymax; n += ymax > 10 ? Math.ceil(ymax / 5) : 1) grid += `M${PAD_L},${Y(n).toFixed(1)}H${W - PAD_R + 4}`
	sparkGrid.setAttribute("d", grid)

	const x0 = ax.X(Math.max(series[0].t, ax.t0))
	let d = `M${x0.toFixed(1)},${Y(series[0].n).toFixed(1)}`
	for (let i = 1; i < series.length; i++) {
		const x = ax.X(Math.max(series[i].t, ax.t0)).toFixed(1)
		d += `H${x}V${Y(series[i].n).toFixed(1)}`
	}
	const xe = ax.X(ax.end)
	d += `H${xe.toFixed(1)}`
	sparkLine.setAttribute("d", d)
	sparkArea.setAttribute("d", `${d}V${base}H${x0.toFixed(1)}Z`)
	const last = series[series.length - 1].n
	sparkDot.setAttribute("cx", xe.toFixed(1))
	sparkDot.setAttribute("cy", Y(last).toFixed(1))
	sparkDot.setAttribute("r", state.status === "done" ? "0" : "3.5")
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
	tip = document.getElementById("tip")
	sparkWrap = document.getElementById("sparkPlot")
	sparkNowEl = document.getElementById("sparkNow")
	sparkPeakEl = document.getElementById("sparkPeak")
	buildSpark()

	wrap.addEventListener("mousemove", onMove)
	wrap.addEventListener("mouseleave", () => tip.classList.remove("show"))
	dynEl.addEventListener("scroll", markDirty, { passive: true })
	window.addEventListener("resize", markDirty)
	new ResizeObserver(markDirty).observe(wrap)
	for (const t of ["lane", "agents", "snapshot", "filters", "tasks", "meta", "done"]) on(t, markDirty)

	let last = 0
	const frame = (ts) => {
		requestAnimationFrame(frame)
		if (document.hidden) return
		const running = state.status === "running" || state.status === "finalizing"
		if (ts - last < 95) return
		if (!dirty && !running) return
		last = ts
		dirty = false
		draw()
		drawSpark()
	}
	requestAnimationFrame(frame)
}
