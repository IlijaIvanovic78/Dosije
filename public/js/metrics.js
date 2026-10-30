// Metrics strip: the big "agents working at the same time" number, counters and budget bars.

import { h, fmtElapsed, fmtNum } from "./format.js"
import { state, on, activeCount, peakCount, openTasks, elapsedMs } from "./store.js"

const items = []
let heroValue, heroDots, heroLabel, budgetEl
const bars = new Map()

function stat(id, label, get, opts = {}) {
	const v = h("div", { class: "m-val" }, "0")
	const el = h("div", { class: `m-stat ${opts.cls || ""}`, title: opts.title || "" }, v, h("div", { class: "m-lab" }, label))
	items.push({ id, el, v, get, cur: 0, text: opts.text })
	return el
}

function budgetBar(label, get) {
	const fill = h("i")
	const num = h("b", null, "0/0")
	const el = h("div", { class: "bud" }, h("span", { class: "b-lab" }, label), h("div", { class: "b-track" }, fill), num)
	bars.set(label, { fill, num, get, sig: "" })
	return el
}

function tweened(it) {
	const target = it.get()
	if (it.text) {
		const txt = it.text(target)
		if (it.v.textContent !== txt) it.v.textContent = txt
		return false
	}
	let moving = false
	if (it.cur !== target) {
		const d = target - it.cur
		it.cur = Math.abs(d) < 0.6 ? target : it.cur + d * 0.4
		moving = it.cur !== target
		const txt = fmtNum(Math.round(it.cur))
		if (it.v.textContent !== txt) {
			it.v.textContent = txt
			it.el.classList.remove("bump")
			void it.el.offsetWidth
			it.el.classList.add("bump")
		}
	}
	return moving
}

let heroCur = 0
let dotsSig = ""

function update() {
	for (const it of items) tweened(it)
	const active = activeCount()
	if (heroCur !== active) {
		heroCur = active
		heroValue.textContent = String(active)
		heroValue.classList.remove("bump")
		void heroValue.offsetWidth
		heroValue.classList.add("bump")
	}
	const dots = Math.min(Math.max(active, peakCount(), 5), 14)
	const sig = `${dots}|${Math.min(active, 14)}`
	if (sig !== dotsSig) {
		dotsSig = sig
		const arr = []
		for (let i = 0; i < dots; i++) arr.push(h("i", { class: i < active ? "on" : "" }))
		heroDots.replaceChildren(...arr)
	}
	heroLabel.classList.toggle("live", active > 0)

	const b = state.budget
	for (const [, bar] of bars) {
		const [val, max] = bar.get(b)
		const sig2 = `${val}/${max}`
		if (sig2 !== bar.sig) {
			bar.sig = sig2
			bar.num.textContent = sig2
			const pct = max ? Math.min(100, (val / max) * 100) : 0
			bar.fill.style.width = `${pct}%`
			bar.fill.parentElement.classList.toggle("hot", pct >= 85)
		}
	}
}

export function initMetrics() {
	const root = document.getElementById("metricsInner")
	heroValue = h("div", { class: "hero-num" }, "0")
	heroDots = h("div", { class: "hero-dots" })
	heroLabel = h("div", { class: "hero-lab" }, h("i", { class: "live-dot" }), "agenata radi istovremeno")
	const hero = h("div", { class: "m-hero" }, heroValue, h("div", { class: "hero-side" }, heroLabel, heroDots))

	const grid = h(
		"div",
		{ class: "m-grid" },
		stat("peak", "vrhunac paralelnosti", () => peakCount(), { title: "Najviše agenata sa otvorenom petljom u isto vreme" }),
		stat("findings", "nalaza", () => state.findings.size),
		stat("signals", "signala", () => [...state.findings.values()].filter((f) => f.severity === "signal").length, { cls: "red" }),
		stat("open", "otvorenih pitanja", () => openTasks().length, { cls: "amber" }),
		stat("tools", "poziva alata", () => state.stats?.toolCalls ?? 0),
		stat("events", "Mozaik događaja", () => Math.max(state.stats?.events ?? 0, state.eventCount)),
		stat("time", "proteklo vreme", () => elapsedMs(), { text: (ms) => fmtElapsed(ms) }),
	)
	budgetEl = h(
		"div",
		{ class: "m-budget" },
		budgetBar("Firme", (b) => [b?.firme ?? 0, b?.maxFirme ?? 0]),
		budgetBar("Osobe", (b) => [b?.osobe ?? 0, b?.maxOsobe ?? 0]),
		budgetBar("Alati", (b) => [b?.toolCalls ?? 0, b?.maxToolCalls ?? 0]),
	)
	root.append(hero, grid, budgetEl)

	setInterval(update, 150)
	for (const t of ["meta", "snapshot", "finding", "tasks"]) on(t, update)
	update()
}
