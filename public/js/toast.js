// Toasts (bottom right): white, hairline, small shadow. Text is always inserted as text.

import { h } from "./format.js"
import { t } from "./i18n.js"

const MAX = 2

export function dismissToasts(selector = ".toast") {
	for (const el of document.querySelectorAll(`#toasts ${selector}`)) el.remove()
}

export function toast({ kind = "info", title, text, actions = [], ttl = 7000 } = {}) {
	const host = document.getElementById("toasts")
	if (!host) return null
	let timer = null
	function close() {
		clearTimeout(timer)
		el.remove()
	}
	const el = h(
		"div",
		{ class: `toast ${kind}`, role: "status" },
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
									class: "link-btn",
									type: "button",
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
		h("button", { class: "t-x", type: "button", "aria-label": t("Zatvorite"), onclick: () => close() }, "×"),
	)
	host.appendChild(el)
	while (host.children.length > MAX) (host.querySelector(".toast:not(.approve)") || host.firstChild).remove()
	if (ttl) timer = setTimeout(close, ttl)
	return { el, close }
}
