// Thin REST helpers. Error messages come from the server in Serbian: in English they are translated before they are shown.

import { getLang, txNow } from "./i18n.js"

async function request(method, url, body) {
	const res = await fetch(url, {
		method,
		headers: body ? { "content-type": "application/json" } : undefined,
		body: body ? JSON.stringify(body) : undefined,
	})
	if (!res.ok) {
		let msg = `${res.status} ${res.statusText}`
		try {
			const j = await res.json()
			if (j?.error) msg = await txNow(j.error)
		} catch {}
		const err = new Error(msg)
		err.status = res.status
		throw err
	}
	const type = res.headers.get("content-type") || ""
	return type.includes("json") ? res.json() : res.text()
}

export const api = {
	config: () => request("GET", "/api/config"),
	state: () => request("GET", "/api/state"),
	start: (input, focus) => request("POST", "/api/dosije", { input, focus: focus || undefined }),
	answer: (payload) => request("POST", "/api/odgovor", payload),
	lead: (name, kind) => request("POST", "/api/trag", { name, kind }),
	mapa: (institutions) => request("POST", "/api/mapa", institutions?.length ? { institutions } : {}),
	finish: () => request("POST", "/api/zavrsi", {}),
	// the report as Markdown; in English the server machine-translates it (the agents write in Serbian)
	reportMd: () => request("GET", `/api/report.md${getLang() === "en" ? "?lang=en" : ""}`),
}
