// Thin REST helpers. Every request names the interface language (X-Lang): the server writes its messages in it, and a new
// dossier or comparison is researched in it.

import { getLang } from "./i18n.js"

async function request(method, url, body) {
	const res = await fetch(url, {
		method,
		headers: { "x-lang": getLang(), ...(body ? { "content-type": "application/json" } : {}) },
		body: body ? JSON.stringify(body) : undefined,
	})
	if (!res.ok) {
		let msg = `${res.status} ${res.statusText}`
		try {
			const j = await res.json()
			if (j?.error) msg = j.error
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
	// the run is researched and reported in the language chosen now
	start: (input, focus) => request("POST", "/api/dosije", { input, focus: focus || undefined, lang: getLang() }),
	answer: (payload) => request("POST", "/api/odgovor", payload),
	lead: (name, kind) => request("POST", "/api/trag", { name, kind }),
	mapa: (institutions) => request("POST", "/api/mapa", institutions?.length ? { institutions, lang: getLang() } : { lang: getLang() }),
	finish: () => request("POST", "/api/zavrsi", {}),
	// the report as Markdown, in the language the case was started in
	reportMd: () => request("GET", "/api/report.md"),
}
