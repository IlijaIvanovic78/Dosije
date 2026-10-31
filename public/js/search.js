// "Pretraga izvora uživo": every public-source request an agent makes (izvor.upit), newest on top: who asked which source,
// for what, and what came back.
// Two events share an id (u_toku, then ok / kes / greska); the store upserts them, this view only renders.

import { h, reconcile, avatar, parseIso, fmtClock, fmtDur, fmtDate, safeUrl, TOOL_LABEL } from "./format.js"
import { state, on, setFilter, isDone, teamShown } from "./store.js"
import { t, tx, txLabel, agentName, pl, onLang } from "./i18n.js"

const VISIBLE_CAP = 150
const rowsById = new Map() // id -> { el, sig }
let listEl
let countEl
let filterEl
let emptySig = ""

const ACTION = { pretraga: "pretraga", preuzimanje: "preuzimanje podataka", dokument: "dokument" }

/** A request still "u_toku" once the run is done never got its final event: show it as interrupted, not as running. */
const effStatus = (a) => (a.status === "u_toku" && isDone() ? "prekinuto" : a.status)

/** The result in words; timing and cache dates stay in the hover text. */
function statusNode(a, status) {
	const n = a.items != null ? `${a.items} ${pl(a.items, ["rezultat", "rezultata", "rezultata"], ["result", "results"])}` : ""
	if (status === "u_toku") return h("span", { class: "rs pending" }, t("u toku"))
	if (status === "prekinuto") return h("span", { class: "rs interrupted", title: t("Zahtev nije završen pre kraja istraživanja.") }, t("prekinuto"))
	if (status === "greska") return h("span", { class: "rs err", title: a.error ? tx(a.error) : null }, t("izvor nije odgovorio"))
	if (status === "kes") return h("span", { class: "rs cache", title: a.cachedAt ? t("Ranije preuzet odgovor izvora, od {d}.", { d: fmtDate(a.cachedAt) }) : t("Ranije preuzet odgovor izvora.") }, n ? t("{n}, sačuvano", { n }) : t("sačuvano"))
	return h("span", { class: "rs ok", title: a.ms != null ? t("Odgovor za {d}", { d: fmtDur(a.ms) }) : null }, n || t("gotovo"))
}

function buildRow(a, status) {
	const info = state.agents.get(a.agentId) || { name: a.agentName, group: "sistem" }
	const url = safeUrl(a.url)
	const text = txLabel(a.label)
	const label = url ? h("a", { class: "lbl", href: url, target: "_blank", rel: "noopener noreferrer" }, text) : h("span", { class: "lbl" }, text)
	// most labels already say what was done ("pretraga: …", "funkcioneri: …"); the action word only fills in when they do not
	const said = /^[\p{L}][\p{L} ]{1,30}:\s/u.test(text)
	const time = a.t0 || parseIso(a.at) || Date.now()
	return h(
		"div",
		{ class: `srow ${status}`, dataset: { agent: a.agentId }, title: [TOOL_LABEL[a.tool] || a.tool, a.ms != null ? fmtDur(a.ms) : ""].filter(Boolean).join(" · ") },
		h("span", { class: "rt" }, fmtClock(time)),
		avatar(info),
		h("span", { class: "rx" }, h("span", { class: "r-who" }, h("b", null, agentName(a.agentName)), " → ", h("span", { class: "rsrc" }, a.source)), said ? null : h("span", { class: "act" }, `${t(ACTION[a.action] || a.action)}: `), label),
		statusNode(a, status),
	)
}

function render() {
	const filter = state.filters.agentId
	const all = teamShown() ? [...state.acts.values()].reverse() : []
	const list = (filter ? all.filter((a) => a.agentId === filter) : all).slice(0, VISIBLE_CAP)
	const open = all.filter((a) => effStatus(a) === "u_toku").length
	const total = state.acts.size
	countEl.textContent = total ? `${total} ${pl(total, ["zahtev", "zahteva", "zahteva"], ["request", "requests"])}${open ? ` · ${open} ${t("u toku")}` : ""}` : ""
	const fsig = filter || ""
	if (filterEl.dataset.sig !== fsig) {
		filterEl.dataset.sig = fsig
		filterEl.hidden = !filter
		if (filter) {
			const who = agentName(state.agents.get(filter)?.name) || "?"
			filterEl.replaceChildren(`${t("samo")}: ${who} · `, h("button", { class: "link-btn", type: "button", onclick: () => setFilter("agentId", filter) }, t("prikažite sve")))
		}
	}

	const els = []
	const keep = new Set()
	for (const a of list) {
		keep.add(a.id)
		const status = effStatus(a)
		const sig = `${status}|${a.ms}|${a.items}|${a.cachedAt}|${a.error}|${a.url}|${txLabel(a.label)}`
		let rec = rowsById.get(a.id)
		if (!rec) {
			rec = { el: buildRow(a, status), sig }
			if (state.live) rec.el.classList.add("enter")
			rowsById.set(a.id, rec)
		} else if (rec.sig !== sig) {
			const fresh = buildRow(a, status)
			rec.el.replaceChildren(...fresh.childNodes)
			rec.el.className = fresh.className
			rec.sig = sig
		}
		els.push(rec.el)
	}
	for (const id of [...rowsById.keys()]) if (!keep.has(id)) rowsById.delete(id)
	if (!els.length) {
		const msg =
			filter && total
				? t("Nema upita za izabranog agenta.")
				: state.caseId || (state.mapa.id && state.runKind === "mapa")
					? t("Čekam prve upite agenata prema izvorima…")
					: t("Ovde se vidi svaki upit koji agenti šalju javnim izvorima: ko pita, koji izvor i šta je vraćeno.")
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
	for (const ev of ["source", "filters", "agents", "meta", "view"]) on(ev, schedule)
	on("snapshot", ({ newCase }) => {
		if (newCase) rowsById.clear()
		schedule()
	})
	onLang(() => {
		rowsById.clear()
		filterEl.dataset.sig = "x"
		schedule()
	})
	render()
}
