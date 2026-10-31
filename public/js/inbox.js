// The journalist's decisions. Open questions and approvals render inline at the top of the dossier ("Čeka tvoju
// odluku", one card open at a time); the "Sanduče" side panel lists them compactly, keeps the history of decisions
// and the "Dodajte trag" form.

import { h, reconcile, createScheduler, parseIso, fmtClock, truncate, safeUrl, avatar, sourceLinks, SIGNAL_LABEL, SECTION_LABEL } from "./format.js"
import { state, on, openTasks, applySnapshot, resumeCase, setView } from "./store.js"
import { api } from "./api.js"
import { toast, dismissToasts } from "./toast.js"
import { showNotice, clearNotice } from "./notice.js"
import { t, tx, agentName, pl, getLang, onLang } from "./i18n.js"

let root, backdrop, listEl, historyEl, historyCount, openCountEl, countEl, emptyEl, inboxBtn, dock, dockList, dockTitle
const cardCache = new Map() // taskId -> { el }
let expandedId = null
let schedule = () => {}

export function openInbox() {
	root.classList.add("open")
	backdrop.classList.add("open")
	root.setAttribute("aria-hidden", "false")
	document.body.classList.add("inbox-open")
	setTimeout(() => root.querySelector(".open-row .btn, #leadForm input")?.focus({ preventScroll: true }), 30)
}

export function closeInbox() {
	root.classList.remove("open")
	backdrop.classList.remove("open")
	root.setAttribute("aria-hidden", "true")
	document.body.classList.remove("inbox-open")
}

const isOpen = () => root.classList.contains("open")

const sortedOpen = () => openTasks().sort((a, b) => Number(b.blocking) - Number(a.blocking) || (parseIso(a.createdAt) || 0) - (parseIso(b.createdAt) || 0))

/** Bring the decision cards into view (opening `taskId` when given) and focus its first control. */
export function focusDecisions(taskId) {
	closeInbox()
	dismissToasts(".toast.ask, .toast.approve")
	if (state.ui.fresh) resumeCase()
	if (state.ui.view !== "dosije") setView("dosije")
	if (taskId && state.tasks.get(taskId)?.status === "open") expandedId = taskId
	render()
	if (dock.hidden) return
	dock.scrollIntoView({ block: "start", behavior: "smooth" })
	const card = dockList.querySelector(".task.expanded")
	setTimeout(() => card?.querySelector("textarea, .btn.primary")?.focus({ preventScroll: true }), 350)
}

async function send(task, payload, card) {
	const buttons = card.querySelectorAll("button, textarea")
	buttons.forEach((b) => (b.disabled = true))
	card.classList.add("sending")
	try {
		await api.answer({ taskId: task.id, ...payload })
		card.classList.add("sent")
		setTimeout(async () => {
			if (state.tasks.get(task.id)?.status === "open") {
				try {
					applySnapshot(await api.state())
				} catch {}
			}
		}, 1800)
	} catch (e) {
		buttons.forEach((b) => (b.disabled = false))
		card.classList.remove("sending")
		let host = card.querySelector(".notice-host")
		if (!host) {
			host = h("div", { class: "notice-host" })
			card.append(host)
		}
		showNotice(host, { text: `${t("Odgovor nije poslat.")} ${e.message}` })
		// "already resolved" (409) or "no such task" (404): the screen is out of date, refresh it
		if (e.status === 409 || e.status === 404) {
			try {
				applySnapshot(await api.state())
			} catch {}
		}
	}
}

function draftBlock(draft) {
	const sev = draft.severity || "signal"
	return h(
		"div",
		{ class: `draft finding sev-${sev}` },
		h(
			"div",
			{ class: "f-meta" },
			draft.section ? h("span", { class: "sect" }, SECTION_LABEL[draft.section] || draft.section) : null,
			draft.signalCode ? h("span", { class: `code ${sev}` }, SIGNAL_LABEL[draft.signalCode] || draft.signalCode) : null,
			h("span", { class: "appr pending" }, t("nacrt")),
		),
		draft.text ? h("p", { class: "f-text" }, tx(draft.text)) : null,
		draft.sources?.length ? sourceLinks(draft.sources) : null,
	)
}

function buildTaskCard(task) {
	const approval = task.kind === "odobrenje"
	const agent = state.agents.get(task.fromAgentId) || { name: task.fromAgentName, group: "sistem" }
	const created = parseIso(task.createdAt)
	const card = h("article", { class: `task ${task.kind}${task.blocking ? " blocking" : ""}`, dataset: { id: task.id } })

	const head = h(
		"button",
		{
			class: "task-head",
			type: "button",
			"aria-expanded": "false",
			onclick: () => {
				expandedId = expandedId === task.id ? null : task.id
				render()
			},
		},
		avatar(agent),
		h("b", null, agentName(task.fromAgentName)),
		h("span", { class: `kind ${task.kind}` }, approval ? t("traži odobrenje") : t("ima pitanje")),
		h("span", { class: "task-time" }, created ? fmtClock(created) : ""),
		h("span", { class: "task-chev", "aria-hidden": "true" }),
	)
	// an approval shows the draft's own title here; the draft below carries its text and sources
	const title = h("h4", { class: "task-title" }, approval ? tx(task.findingDraft?.title) || `${t("Urednik predlaže signal")}: ${tx(task.title)}` : tx(task.title))

	const body = []
	if (task.blocking) body.push(h("p", { class: "hold-line" }, h("b", null, `${t("{agent} je pauziran dok ne odlučite", { agent: agentName(task.fromAgentName) })}.`)))
	if (approval && task.findingDraft) body.push(draftBlock(task.findingDraft))
	if (task.question) body.push(h("p", { class: "task-q" }, tx(task.question)))
	if (task.hint) body.push(h("p", { class: "task-hint" }, h("b", null, `${t("Savet")}: `), tx(task.hint)))
	if (task.links?.length) {
		body.push(
			h(
				"ul",
				{ class: "task-links" },
				task.links.map((l) => {
					const url = safeUrl(l.url)
					return url ? h("li", null, h("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, `${l.label} ↗`)) : null
				}),
			),
		)
	}

	if (approval) {
		body.push(
			h(
				"div",
				{ class: "task-actions" },
				h("button", { class: "btn primary", type: "button", onclick: () => send(task, { decision: "approve" }, card) }, t("Ubacite u izveštaj")),
				h("button", { class: "btn", type: "button", onclick: () => send(task, { decision: "reject" }, card) }, t("Odbacite")),
			),
		)
	} else {
		const ta = h("textarea", { rows: "2", placeholder: t("Upišite odgovor (na primer ime vlasnika)"), "aria-label": t("Odgovor") })
		const submit = h("button", { class: "btn primary", type: "button", disabled: true, onclick: () => send(task, { answer: ta.value.trim() }, card) }, t("Pošaljite timu"))
		ta.addEventListener("input", () => (submit.disabled = !ta.value.trim()))
		ta.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && ta.value.trim()) submit.click()
		})
		body.push(h("div", { class: "task-answer" }, ta, h("div", { class: "task-actions" }, submit, h("button", { class: "btn", type: "button", onclick: () => send(task, { decision: "reject" }, card) }, t("Preskočite")), h("span", { class: "task-kbd" }, t("Ctrl+Enter šalje")))))
	}
	card.append(head, title, h("div", { class: "task-body" }, ...body))
	return card
}

/** Compact row in the side panel: the full card lives on the dossier. */
function openRow(task) {
	const agent = state.agents.get(task.fromAgentId) || { name: task.fromAgentName, group: "sistem" }
	return h(
		"div",
		{ class: `open-row${task.blocking ? " blocking" : ""}` },
		avatar(agent),
		h("div", { class: "or-main" }, h("div", { class: "or-title" }, truncate(tx(task.title), 90)), h("div", { class: "or-sub" }, `${agentName(task.fromAgentName)} · ${task.kind === "odobrenje" ? t("traži odobrenje") : t("ima pitanje")}`)),
		h("button", { class: "btn small primary", type: "button", onclick: () => focusDecisions(task.id) }, task.kind === "odobrenje" ? t("Odlučite") : t("Odgovorite")),
	)
}

function historyItem(task) {
	const map = { approved: ["odobreno", "ok"], rejected: ["odbijeno", "no"], answered: ["odgovoreno", "ok"], expired: ["isteklo", "muted"] }
	const [labelSr, cls] = map[task.status] || [task.status, "muted"]
	const label = t(labelSr)
	const at = parseIso(task.answeredAt)
	return h(
		"div",
		{ class: `hist ${cls}` },
		h("div", { class: "h-title" }, truncate(tx(task.title), 90)),
		h("div", { class: "h-sub" }, `${agentName(task.fromAgentName)} · ${label}${at ? ` · ${fmtClock(at)}` : ""}`, task.answer ? ` · „${truncate(task.answer, 80)}“` : ""),
	)
}

function dockHeading(open) {
	const n = open.length
	if (n === 1) return open[0].kind === "odobrenje" ? t("{agent} traži Vaše odobrenje", { agent: agentName(open[0].fromAgentName) }) : t("{agent} ima pitanje za Vas", { agent: agentName(open[0].fromAgentName) })
	return getLang() === "en" ? `${n} decisions are waiting for you` : `${n} ${pl(n, ["odluka čeka", "odluke čekaju", "odluka čeka"])} na Vas`
}

function render() {
	const open = sortedOpen()
	const done = [...state.tasks.values()].filter((k) => k.status !== "open").sort((a, b) => (parseIso(b.answeredAt) || 0) - (parseIso(a.answeredAt) || 0))

	if (!open.some((k) => k.id === expandedId)) expandedId = open[0]?.id ?? null
	const els = open.map((k) => {
		let c = cardCache.get(k.id)
		if (!c) {
			c = { el: buildTaskCard(k) }
			cardCache.set(k.id, c)
		}
		const exp = k.id === expandedId
		c.el.classList.toggle("expanded", exp)
		c.el.querySelector(".task-head").setAttribute("aria-expanded", String(exp))
		return c.el
	})
	for (const id of [...cardCache.keys()]) if (!open.some((k) => k.id === id)) cardCache.delete(id)
	reconcile(dockList, els)
	dock.hidden = els.length === 0
	const heading = els.length ? dockHeading(open) : ""
	if (dockTitle.textContent !== heading) dockTitle.textContent = heading

	reconcile(listEl, open.map(openRow))
	emptyEl.hidden = open.length > 0
	openCountEl.textContent = String(open.length)
	// agents ask nothing unless the server is set to (config.asksUser): the panel is then only for adding a lead
	const asks = !!state.config?.asksUser || open.length > 0
	root.querySelector(".inbox-open").hidden = !asks
	const sub = asks ? "Pitanja agenata, Vaše odluke i tragovi koje dodajete timu." : "Trag koji dodate odmah dobija svog agenta."
	const subEl = root.querySelector(".inbox-sub")
	if (subEl.dataset.sr !== sub) {
		subEl.dataset.sr = sub
		subEl.textContent = t(sub)
	}

	historyEl.replaceChildren(...done.map(historyItem))
	historyCount.textContent = String(done.length)
	historyEl.parentElement.hidden = done.length === 0

	countEl.textContent = open.length ? String(open.length) : ""
	inboxBtn.classList.toggle("has-open", open.length > 0)
	inboxBtn.setAttribute("aria-label", open.length ? t("Sanduče, {n} otvorenih zadataka", { n: open.length }) : t("Sanduče"))
	document.title = `${open.length ? `(${open.length}) ` : ""}Dosije · ${t("istraživanje javnih institucija")}`
}

/** Is the decision dock on screen right now? (then a toast would only repeat it) */
function dockVisible() {
	if (document.body.dataset.view !== "case" || state.ui.view !== "dosije" || state.ui.fresh) return false
	// the dock sits right under the dossier header (which is always rendered): on screen unless scrolled past it
	const r = document.querySelector("#dosijePanel .doc-head").getBoundingClientRect()
	return r.bottom > -40 && r.bottom < window.innerHeight - 120
}

export function initInbox() {
	root = document.getElementById("inbox")
	backdrop = document.getElementById("inboxBackdrop")
	listEl = document.getElementById("taskList")
	historyEl = document.getElementById("taskHistory")
	historyCount = document.getElementById("historyCount")
	openCountEl = document.getElementById("openCount")
	countEl = document.getElementById("inboxCount")
	emptyEl = document.getElementById("inboxEmpty")
	dock = document.getElementById("decisionDock")
	dockList = document.getElementById("dockList")
	dockTitle = document.getElementById("dockTitle")
	const btn = document.getElementById("btnInbox")
	inboxBtn = btn

	btn.addEventListener("click", () => (isOpen() ? closeInbox() : openInbox()))
	backdrop.addEventListener("click", closeInbox)
	document.getElementById("inboxClose").addEventListener("click", closeInbox)
	document.addEventListener("keydown", (e) => {
		if (e.key === "Escape" && isOpen()) closeInbox()
	})

	const leadForm = document.getElementById("leadForm")
	leadForm.addEventListener("submit", async (e) => {
		e.preventDefault()
		const name = leadForm.elements.name.value.trim()
		const kind = leadForm.elements.kind.value
		if (!name) return
		const submit = leadForm.querySelector("button[type=submit]")
		const notice = document.getElementById("leadNotice")
		submit.disabled = true
		clearNotice(notice)
		try {
			await api.lead(name, kind)
			leadForm.elements.name.value = ""
			showNotice(notice, { kind: "info", text: t("Trag dodat: {name}. Tim ga već proverava.", { name }) })
		} catch (err) {
			showNotice(notice, { text: `${t("Trag nije dodat.")} ${err.message}` })
		} finally {
			submit.disabled = false
		}
	})

	schedule = createScheduler(render)
	on("tasks", (e) => {
		schedule()
		const task = e?.task
		if (!e?.isNew || !task || task.status !== "open") return
		// decide after the dock has rendered: a question already on screen needs no toast
		setTimeout(() => {
			if (dockVisible() || state.tasks.get(task.id)?.status !== "open") return
			const approval = task.kind === "odobrenje"
			toast({
				kind: approval ? "approve" : "ask",
				title: approval ? t("{agent} čeka Vaše odobrenje", { agent: agentName(task.fromAgentName) }) : t("{agent} ima pitanje za Vas", { agent: agentName(task.fromAgentName) }),
				text: truncate(tx(task.title), 110),
				ttl: approval ? 12000 : 6000,
				actions: [{ label: approval ? t("Odlučite") : t("Odgovorite"), onClick: () => focusDecisions(task.id) }],
			})
		}, 150)
	})
	on("snapshot", ({ newCase }) => {
		if (newCase) {
			cardCache.clear()
			expandedId = null
		}
		schedule()
	})
	onLang(() => {
		cardCache.clear()
		schedule()
	})
	schedule()
}
