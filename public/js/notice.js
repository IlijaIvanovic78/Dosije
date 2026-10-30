// Inline notices: a failed action leaves a message next to its control until it is dismissed or the action is retried.
// Text is always inserted as text. Used instead of toasts for errors (a toast disappears; a refusal must stay visible).

import { h } from "./format.js"
import { state } from "./store.js"
import { api } from "./api.js"

export function clearNotice(host) {
	if (host) host.replaceChildren()
}

/** Show one notice in `host` (replacing the previous one). actions: [{ label, onClick }]. */
export function showNotice(host, { text, kind = "error", actions = [] }) {
	if (!host) return
	const box = h(
		"div",
		{ class: `notice ${kind}`, role: kind === "error" ? "alert" : "status" },
		h("span", { class: "n-text" }, text),
		actions.length
			? h(
					"span",
					{ class: "n-actions" },
					actions.map((a) => h("button", { class: "btn small", type: "button", onclick: a.onClick }, a.label)),
				)
			: null,
		kind === "error" ? h("button", { class: "link-btn n-close", type: "button", onclick: () => clearNotice(host) }, "Zatvori") : null,
	)
	host.replaceChildren(box)
}

export const caseBusy = () => state.status === "running" || state.status === "finalizing"
export const mapBusy = () => state.mapa.status === "running"

function waitFor(cond, ms = 60000) {
	return new Promise((resolve, reject) => {
		const t0 = Date.now()
		const timer = setInterval(() => {
			if (cond()) {
				clearInterval(timer)
				resolve()
			} else if (Date.now() - t0 > ms) {
				clearInterval(timer)
				reject(new Error("Dosije se još završava. Pokušaj ponovo za nekoliko sekundi."))
			}
		}, 250)
	})
}

/** The one-click way out of the case/map exclusivity: close the running case, wait until it is done, then retry. */
export async function finishCaseThen(host, retry) {
	showNotice(host, { kind: "info", text: "Završavam dosije…" })
	try {
		try {
			await api.finish()
		} catch (e) {
			if (e.status !== 409) throw e // 409 = nothing to finish (already done)
		}
		await waitFor(() => !caseBusy())
		clearNotice(host)
		await retry()
	} catch (e) {
		showNotice(host, { text: e.message })
	}
}
