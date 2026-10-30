// Toasts (bottom right). Text is always inserted as text.

import { h } from "./format.js"

const MAX = 4

export function dismissToasts(selector = ".toast") {
	for (const el of document.querySelectorAll(`#toasts ${selector}`)) {
		el.classList.add("leaving")
		setTimeout(() => el.remove(), 260)
	}
}

export function toast({ kind = "info", title, text, actions = [], ttl = 7000, icon } = {}) {
	const host = document.getElementById("toasts")
	if (!host) return null
	const icons = { info: "ℹ️", ask: "📥", approve: "⏸", done: "✅", error: "⚠️" }
	const el = h(
		"div",
		{ class: `toast ${kind}`, role: "status" },
		h("div", { class: "t-ico" }, icon || icons[kind] || "ℹ️"),
		h(
			"div",
			{ class: "t-main" },
			h("div", { class: "t-title" }, title),
			text ? h("div", { class: "t-text" }, text) : null,
			actions.length
				? h(
						"div",
						{ class: "t-actions" },
						actions.map((a) =>
							h(
								"button",
								{
									class: "btn small",
									onclick: () => {
										close()
										a.onClick?.()
									},
								},
								a.label,
							),
						),
					)
				: null,
		),
		h("button", { class: "t-x", "aria-label": "Zatvori", onclick: () => close() }, "×"),
	)
	let timer = null
	function close() {
		clearTimeout(timer)
		if (!el.isConnected) return
		el.classList.add("leaving")
		setTimeout(() => el.remove(), 260)
	}
	host.appendChild(el)
	while (host.children.length > MAX) host.firstChild.remove()
	if (ttl) timer = setTimeout(close, ttl)
	return { el, close }
}
