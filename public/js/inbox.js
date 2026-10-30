// "Sanduče": side panel with questions and approvals for the journalist, task history and the "Dodaj trag" form.

import { h, reconcile, createScheduler, parseIso, fmtClock, truncate, safeUrl, avatar, sourceLinks, SIGNAL_LABEL, SECTION_LABEL } from "./format.js"
import { state, on, openTasks, applySnapshot } from "./store.js"
import { api } from "./api.js"
import { toast, dismissToasts } from "./toast.js"
import { showNotice, clearNotice } from "./notice.js"

let root, backdrop, listEl, historyEl, historyCount, countEl, emptyEl, inboxBtn
const cardCache = new Map() // taskId -> { el }

export function openInbox() {
	root.classList.add("open")
	backdrop.classList.add("open")
	root.setAttribute("aria-hidden", "false")
	document.body.classList.add("inbox-open")
	dismissToasts(".toast.ask, .toast.approve")
	setTimeout(() => root.querySelector("textarea, .btn.primary, input")?.focus({ preventScroll: true }), 30)
}

export function closeInbox() {
	root.classList.remove("open")
	backdrop.classList.remove("open")
	root.setAttribute("aria-hidden", "true")
	document.body.classList.remove("inbox-open")
}

const isOpen = () => root.classList.contains("open")

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
		showNotice(host, { text: `Odgovor nije poslat. ${e.message}` })
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
			h("span", { class: "appr pending" }, "nacrt"),
		),
		draft.title ? h("h3", { class: "f-title" }, draft.title) : null,
		draft.text ? h("p", { class: "f-text" }, draft.text) : null,
		draft.sources?.length ? sourceLinks(draft.sources) : null,
	)
}

function buildTaskCard(task) {
	const approval = task.kind === "odobrenje"
	const agent = state.agents.get(task.fromAgentId) || { name: task.fromAgentName, group: "sistem" }
	const created = parseIso(task.createdAt)
	const card = h("article", { class: `task ${task.kind}${task.blocking ? " blocking" : ""}`, dataset: { id: task.id } })

	const parts = [
		h("div", { class: "task-head" }, avatar(agent), h("b", null, task.fromAgentName), h("span", { class: "task-time" }, created ? fmtClock(created) : ""), h("span", { class: `kind ${task.kind}` }, approval ? "odobrenje" : "pitanje")),
	]
	if (task.blocking) {
		parts.push(h("p", { class: "hold-line" }, h("b", null, `${task.fromAgentName} čeka tvoju odluku.`), " Ostali agenti nastavljaju."))
	}
	parts.push(h("h4", { class: "task-title" }, approval ? (task.findingDraft ? "Urednik predlaže signal za izveštaj" : `Urednik predlaže signal: ${task.title}`) : task.title))
	if (approval && task.findingDraft) parts.push(draftBlock(task.findingDraft))
	if (task.question) parts.push(h("p", { class: "task-q" }, task.question))
	if (task.hint) parts.push(h("p", { class: "task-hint" }, h("b", null, "Savet: "), task.hint))
	if (task.links?.length) {
		parts.push(
			h(
				"ul",
				{ class: "task-links" },
				task.links.map((l) => {
					const url = safeUrl(l.url)
					return url ? h("li", null, h("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, l.label)) : null
				}),
			),
		)
	}

	if (approval) {
		parts.push(
			h(
				"div",
				{ class: "task-actions" },
				h("button", { class: "btn primary", type: "button", onclick: () => send(task, { decision: "approve" }, card) }, "Ubaci u izveštaj"),
				h("button", { class: "btn", type: "button", onclick: () => send(task, { decision: "reject" }, card) }, "Odbaci"),
			),
		)
	} else {
		const ta = h("textarea", { rows: "2", placeholder: "Upiši odgovor (na primer ime vlasnika)", "aria-label": "Odgovor" })
		const submit = h("button", { class: "btn primary", type: "button", disabled: true, onclick: () => send(task, { answer: ta.value.trim() }, card) }, "Pošalji timu")
		ta.addEventListener("input", () => (submit.disabled = !ta.value.trim()))
		ta.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && ta.value.trim()) submit.click()
		})
		parts.push(h("div", { class: "task-answer" }, ta, h("div", { class: "task-actions" }, submit, h("button", { class: "btn", type: "button", onclick: () => send(task, { decision: "reject" }, card) }, "Preskoči"))))
	}
	card.append(...parts)
	return card
}

function historyItem(task) {
	const map = { approved: ["odobreno", "ok"], rejected: ["odbijeno", "no"], answered: ["odgovoreno", "ok"], expired: ["isteklo", "muted"] }
	const [label, cls] = map[task.status] || [task.status, "muted"]
	const at = parseIso(task.answeredAt)
	return h(
		"div",
		{ class: `hist ${cls}` },
		h("div", { class: "h-title" }, truncate(task.title, 90)),
		h("div", { class: "h-sub" }, `${task.fromAgentName} · ${label}${at ? ` · ${fmtClock(at)}` : ""}`, task.answer ? ` · „${truncate(task.answer, 80)}“` : ""),
	)
}

function render() {
	const open = openTasks().sort((a, b) => Number(b.blocking) - Number(a.blocking) || (parseIso(b.createdAt) || 0) - (parseIso(a.createdAt) || 0))
	const done = [...state.tasks.values()].filter((t) => t.status !== "open").sort((a, b) => (parseIso(b.answeredAt) || 0) - (parseIso(a.answeredAt) || 0))

	const els = open.map((t) => {
		let c = cardCache.get(t.id)
		if (!c) {
			c = { el: buildTaskCard(t) }
			cardCache.set(t.id, c)
		}
		return c.el
	})
	for (const id of [...cardCache.keys()]) if (!open.some((t) => t.id === id)) cardCache.delete(id)
	reconcile(listEl, els)
	emptyEl.hidden = els.length > 0

	historyEl.replaceChildren(...done.map(historyItem))
	historyCount.textContent = String(done.length)
	historyEl.parentElement.hidden = done.length === 0

	countEl.textContent = open.length ? String(open.length) : ""
	countEl.classList.toggle("wait", open.length > 0)
	inboxBtn.setAttribute("aria-label", open.length ? `Sanduče, ${open.length} ${open.length === 1 ? "otvoren zadatak" : "otvorenih zadataka"}` : "Sanduče")
	document.title = `${open.length ? `(${open.length}) ` : ""}Dosije · istraživački tim agenata`
}

export function initInbox() {
	root = document.getElementById("inbox")
	backdrop = document.getElementById("inboxBackdrop")
	listEl = document.getElementById("taskList")
	historyEl = document.getElementById("taskHistory")
	historyCount = document.getElementById("historyCount")
	countEl = document.getElementById("inboxCount")
	emptyEl = document.getElementById("inboxEmpty")
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
			showNotice(notice, { kind: "info", text: `Trag dodat: ${name}. Tim ga već proverava.` })
		} catch (err) {
			showNotice(notice, { text: `Trag nije dodat. ${err.message}` })
		} finally {
			submit.disabled = false
		}
	})

	const schedule = createScheduler(render)
	on("tasks", (e) => {
		schedule()
		const task = e?.task
		if (e?.isNew && task && task.status === "open") {
			const approval = task.kind === "odobrenje"
			toast({
				kind: approval ? "approve" : "ask",
				title: approval ? `${task.fromAgentName} čeka tvoje odobrenje` : `${task.fromAgentName} ima pitanje za tebe`,
				text: truncate(task.title, 110),
				ttl: approval ? 12000 : 6000,
				actions: [{ label: approval ? "Odluči" : "Odgovori", onClick: openInbox }],
			})
		}
	})
	on("snapshot", ({ newCase }) => {
		if (newCase) cardCache.clear()
		schedule()
	})
	schedule()
}
