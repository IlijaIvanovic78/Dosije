// Thin REST helpers.

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
			if (j?.error) msg = j.error
		} catch {}
		throw new Error(msg)
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
	reportMd: () => request("GET", "/api/report.md"),
}
