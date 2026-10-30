// "Sanduče": slide-over with questions and approvals for the journalist,
// task history and the "Dodaj trag" form.

import { h, reconcile, createScheduler, parseIso, fmtClock, truncate, safeUrl, sourceChipLabel, SIGNAL_LABEL, SECTION_LABEL } from "./format.js"
import { state, on, openTasks, applySnapshot } from "./store.js"
import { api } from "./api.js"
import { toast, dismissToasts } from "./toast.js"

let root, backdrop, listEl, historyEl, historyCount, countEl, btn, emptyEl
const cardCache = new Map() // taskId -> { el, status }

export function openInbox() {
	root.classList.add("open")
	backdrop.classList.add("open")
	root.setAttribute("aria-hidden", "false")
	document.body.classList.add("inbox-open")
	dismissToasts(".toast.ask, .toast.approve")
	setTimeout(() => root.querySelector("textarea, .btn.primary, input")?.focus({ preventScroll: true }), 280)
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
		toast({ kind: "error", title: "Odgovor nije poslat", text: e.message })
	}
}

function sourceList(sources) {
	if (!sources?.length) return null
	return h(
		"div",
		{ class: "f-sources" },
		sources.map((s) => {
			const url = safeUrl(s.url)
			const label = sourceChipLabel(s)
			return url ? h("a", { class: `src${s.official ? " official" : ""}`, href: url, target: "_blank", rel: "noopener noreferrer", title: s.title }, label, h("i", { class: "ext" }, "↗")) : h("span", { class: "src" }, label)
		}),
	)
}

function buildTaskCard(task) {
	const approval = task.kind === "odobrenje"
	const agent = state.agents.get(task.fromAgentId)
	const created = parseIso(task.createdAt)
	const draft = task.findingDraft
	const card = h("article", { class: `task ${task.kind}${task.blocking ? " blocking" : ""}`, dataset: { id: task.id } })

	const head = h(
		"div",
		{ class: "task-head" },
		h("span", { class: "avatar sm" }, agent?.emoji || "🤖"),
		h("div", { class: "task-who" }, h("b", null, task.fromAgentName), h("span", null, created ? fmtClock(created) : "")),
		h("span", { class: `kind-chip ${task.kind}` }, approval ? "Odobrenje" : "Pitanje"),
	)
	const parts = [head]
	if (task.blocking) {
		parts.push(h("div", { class: "hold" }, h("span", null, "⏸"), h("span", null, h("b", null, `${task.fromAgentName} čeka tvoju odluku`), ": ostali agenti nastavljaju da rade.")))
	}
	parts.push(h("h4", { class: "task-title" }, approval ? `Urednik predlaže signal: ${task.title}` : task.title))
	if (approval && draft) {
		parts.push(
			h(
				"div",
				{ class: `draft sev-${draft.severity || "signal"}` },
				h(
					"div",
					{ class: "f-top" },
					draft.section ? h("span", { class: "tag sect" }, SECTION_LABEL[draft.section] || draft.section) : null,
					draft.signalCode ? h("span", { class: `tag code ${draft.severity || "signal"}` }, `⚑ ${SIGNAL_LABEL[draft.signalCode] || draft.signalCode}`) : null,
				),
				draft.title ? h("div", { class: "dr-title" }, draft.title) : null,
				draft.text ? h("p", { class: "dr-text" }, draft.text) : null,
				sourceList(draft.sources),
			),
		)
	}
	if (task.question) parts.push(h("p", { class: "task-q" }, task.question))
	if (task.hint) parts.push(h("p", { class: "task-hint" }, "💡 ", task.hint))
	if (task.links?.length) {
		parts.push(
			h(
				"div",
				{ class: "task-links" },
				task.links.map((l) => {
					const url = safeUrl(l.url)
					return url ? h("a", { class: "link-chip", href: url, target: "_blank", rel: "noopener noreferrer" }, l.label, h("i", { class: "ext" }, "↗")) : null
				}),
			),
		)
	}

	if (approval) {
		parts.push(
			h(
				"div",
				{ class: "task-actions" },
				h("button", { class: "btn primary green", onclick: () => send(task, { decision: "approve" }, card) }, "✓ Ubaci u izveštaj"),
				h("button", { class: "btn danger", onclick: () => send(task, { decision: "reject" }, card) }, "Odbaci"),
			),
		)
	} else {
		const ta = h("textarea", { rows: "2", placeholder: "Upiši odgovor (npr. ime vlasnika)…", "aria-label": "Odgovor" })
		const submit = h("button", { class: "btn primary", disabled: true, onclick: () => send(task, { answer: ta.value.trim() }, card) }, "Pošalji timu")
		ta.addEventListener("input", () => (submit.disabled = !ta.value.trim()))
		ta.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && ta.value.trim()) submit.click()
		})
		parts.push(h("div", { class: "task-answer" }, ta, h("div", { class: "task-actions" }, submit, h("button", { class: "btn ghost", onclick: () => send(task, { decision: "reject" }, card) }, "Preskoči"))))
	}
	card.append(...parts)
	return card
}

function historyItem(task) {
	const map = { approved: ["✓", "odobreno", "ok"], rejected: ["✕", "odbijeno", "no"], answered: ["💬", "odgovoreno", "ok"], expired: ["⌛", "isteklo", "muted"] }
	const [ico, label, cls] = map[task.status] || ["•", task.status, "muted"]
	const at = parseIso(task.answeredAt)
	return h(
		"div",
		{ class: `hist ${cls}` },
		h("span", { class: "h-ico" }, ico),
		h("div", { class: "h-main" }, h("div", { class: "h-title" }, truncate(task.title, 90)), h("div", { class: "h-sub" }, `${task.fromAgentName} · ${label}${at ? ` · ${fmtClock(at)}` : ""}`, task.answer ? ` · «${truncate(task.answer, 80)}»` : "")),
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
	const blocking = open.filter((t) => t.blocking)

	historyEl.replaceChildren(...done.map(historyItem))
	historyCount.textContent = String(done.length)
	historyEl.parentElement.hidden = done.length === 0

	countEl.textContent = String(open.length)
	countEl.hidden = open.length === 0
	btn.classList.toggle("has-open", open.length > 0)
	btn.classList.toggle("urgent", blocking.length > 0)
	document.title = `${open.length ? `(${open.length}) ` : ""}Dosije · tim AI agenata`
}

export function initInbox() {
	root = document.getElementById("inbox")
	backdrop = document.getElementById("inboxBackdrop")
	listEl = document.getElementById("taskList")
	historyEl = document.getElementById("taskHistory")
	historyCount = document.getElementById("historyCount")
	countEl = document.getElementById("inboxCount")
	btn = document.getElementById("btnInbox")
	emptyEl = document.getElementById("inboxEmpty")

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
		submit.disabled = true
		try {
			await api.lead(name, kind)
			leadForm.elements.name.value = ""
			toast({ kind: "done", icon: "🔎", title: "Trag dodat", text: `${name}: tim ga već proverava.`, ttl: 4500 })
		} catch (err) {
			toast({ kind: "error", title: "Trag nije dodat", text: err.message })
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
				ttl: approval ? 14000 : 9000,
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
