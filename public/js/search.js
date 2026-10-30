// "Pretraga uživo": every public-source request an agent makes (izvor.upit), newest on top.
// Two events share an id (u_toku, then ok / kes / greska); the store upserts them, this view only renders.

import { h, reconcile, avatar, parseIso, fmtClock, fmtDur, fmtDate, safeUrl } from "./format.js"
import { state, on, setFilter } from "./store.js"
import { plural } from "./metrics.js"

const VISIBLE_CAP = 150
const rowsById = new Map() // id -> { el, sig }
let listEl
let countEl
let filterEl
let emptySig = ""

const ACTION = { pretraga: "pretraga", preuzimanje: "preuzimanje", dokument: "dokument" }

function statusNode(a) {
	if (a.status === "u_toku") return h("span", { class: "rs pending" }, "…")
	if (a.status === "greska") return h("span", { class: "rs err", title: a.error || "greška" }, "greška")
	if (a.status === "kes") {
		const d = a.cachedAt ? fmtDate(a.cachedAt).slice(0, 6) : ""
		return h("span", { class: "rs cache", title: a.cachedAt ? `iz keša, preuzeto ${fmtDate(a.cachedAt)}` : "iz keša" }, `keš${d ? ` ${d}` : ""}${a.items != null ? ` · ${a.items}` : ""}`)
	}
	const parts = ["✓"]
	if (a.ms != null) parts.push(fmtDur(a.ms))
	let txt = parts.join(" ")
	if (a.items != null) txt += ` · ${a.items}`
	return h("span", { class: "rs ok" }, txt)
}

function buildRow(a) {
	const info = state.agents.get(a.agentId) || { name: a.agentName, group: "sistem" }
	const url = safeUrl(a.url)
	const label = url ? h("a", { class: "lbl", href: url, target: "_blank", rel: "noopener noreferrer" }, a.label) : h("span", { class: "lbl" }, a.label)
	const t = a.t0 || parseIso(a.at) || Date.now()
	const el = h(
		"div",
		{ class: `srow ${a.status}`, dataset: { agent: a.agentId }, title: `${a.agentName} · ${a.tool}${a.error ? ` · ${a.error}` : ""}` },
		h("span", { class: "rt" }, fmtClock(t)),
		avatar(info),
		h("b", { class: "rsrc", title: a.source }, a.source),
		h("span", { class: "rx" }, h("span", { class: "act" }, `${ACTION[a.action] || a.action} · `), label),
		statusNode(a),
	)
	return el
}

function render() {
	const filter = state.filters.agentId
	const all = [...state.acts.values()].reverse()
	const list = (filter ? all.filter((a) => a.agentId === filter) : all).slice(0, VISIBLE_CAP)
	const open = all.filter((a) => a.status === "u_toku").length
	const total = state.acts.size
	countEl.textContent = total ? `${total} ${plural(total, "zahtev", "zahteva", "zahteva")}${open ? ` · ${open} u toku` : ""}` : ""
	const fsig = filter || ""
	if (filterEl.dataset.sig !== fsig) {
		filterEl.dataset.sig = fsig
		filterEl.hidden = !filter
		if (filter) {
			const who = state.agents.get(filter)?.name || "?"
			filterEl.replaceChildren(`samo: ${who} · `, h("button", { class: "link-btn", type: "button", onclick: () => setFilter("agentId", filter) }, "prikaži sve"))
		}
	}

	const els = []
	const keep = new Set()
	for (const a of list) {
		keep.add(a.id)
		const sig = `${a.status}|${a.ms}|${a.items}|${a.cachedAt}|${a.error}|${a.url}|${a.label}`
		let rec = rowsById.get(a.id)
		if (!rec) {
			rec = { el: buildRow(a), sig }
			if (state.live) rec.el.classList.add("enter")
			rowsById.set(a.id, rec)
		} else if (rec.sig !== sig) {
			const fresh = buildRow(a)
			rec.el.replaceChildren(...fresh.childNodes)
			rec.el.className = fresh.className
			rec.sig = sig
		}
		els.push(rec.el)
	}
	for (const id of [...rowsById.keys()]) if (!keep.has(id)) rowsById.delete(id)
	if (!els.length) {
		const msg = filter && total ? "Nema upita za izabranog agenta." : state.caseId || (state.mapa.id && state.runKind === "mapa") ? "Čekam prve upite agenata prema javnim izvorima." : "Upiti prema javnim izvorima pojaviće se ovde dok agenti rade."
		if (emptySig !== msg || !listEl.querySelector(".empty-line")) {
			emptySig = msg
			reconcile(listEl, [h("div", { class: "empty-line" }, msg)])
		}
		return
	}
	emptySig = ""
	reconcile(listEl, els)
}

export function initSearch() {
	listEl = document.getElementById("liveList")
	countEl = document.getElementById("liveCount")
	filterEl = document.getElementById("liveFilter")
	let timer = null
	const schedule = () => {
		if (timer) return
		timer = setTimeout(() => {
			timer = null
			try {
				render()
			} catch (e) {
				console.error(e)
			}
		}, 120)
	}
	for (const t of ["source", "filters", "agents", "meta"]) on(t, schedule)
	on("snapshot", ({ newCase }) => {
		if (newCase) rowsById.clear()
		schedule()
	})
	render()
}
