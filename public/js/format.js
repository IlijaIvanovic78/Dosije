// Small shared helpers: DOM builder, escaping, formatting, labels.

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }

export function esc(s) {
	return String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c])
}

export function safeUrl(u) {
	if (typeof u !== "string") return null
	return /^https?:\/\//i.test(u.trim()) ? u.trim() : null
}

function appendKids(el, kids) {
	for (const k of kids) {
		if (k == null || k === false) continue
		if (Array.isArray(k)) appendKids(el, k)
		else if (k instanceof Node) el.appendChild(k)
		else el.appendChild(document.createTextNode(String(k)))
	}
}

/** Tiny DOM builder. Strings are always inserted as text, never as HTML. */
export function h(tag, props, ...kids) {
	const el = document.createElement(tag)
	if (props) {
		for (const [k, v] of Object.entries(props)) {
			if (v == null || v === false) continue
			if (k === "class") el.className = v
			else if (k === "text") el.textContent = v
			else if (k === "dataset") Object.assign(el.dataset, v)
			else if (k === "vars") for (const [n, val] of Object.entries(v)) el.style.setProperty(n, val)
			else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v)
			else if (v === true) el.setAttribute(k, "")
			else el.setAttribute(k, v)
		}
	}
	appendKids(el, kids)
	return el
}

const SVG_NS = "http://www.w3.org/2000/svg"
export function s(tag, props, ...kids) {
	const el = document.createElementNS(SVG_NS, tag)
	if (props) for (const [k, v] of Object.entries(props)) if (v != null) el.setAttribute(k, v)
	for (const k of kids) if (k) el.appendChild(k)
	return el
}

/** Make `parent` contain exactly `els`, in order, touching the DOM only where needed. */
export function reconcile(parent, els) {
	let cursor = parent.firstChild
	for (const el of els) {
		if (el === cursor) {
			cursor = cursor.nextSibling
			continue
		}
		parent.insertBefore(el, cursor)
	}
	while (cursor) {
		const next = cursor.nextSibling
		parent.removeChild(cursor)
		cursor = next
	}
}

/** Coalesce many calls into one requestAnimationFrame callback. */
export function createScheduler(fn) {
	let queued = false
	return function schedule() {
		if (queued) return
		queued = true
		requestAnimationFrame(() => {
			queued = false
			try {
				fn()
			} catch (e) {
				console.error(e)
			}
		})
	}
}

export const pad2 = (n) => String(n).padStart(2, "0")

export function parseIso(v) {
	if (!v) return null
	const t = Date.parse(v)
	return Number.isFinite(t) ? t : null
}

export function fmtClock(ms) {
	const d = new Date(ms)
	return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

export function fmtClockMs(ms) {
	return `${fmtClock(ms)}.${String(new Date(ms).getMilliseconds()).padStart(3, "0")}`
}

export function fmtDate(v) {
	const t = typeof v === "number" ? v : parseIso(v)
	if (t == null) return ""
	const d = new Date(t)
	return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}`
}

export function fmtElapsed(ms) {
	const sec = Math.max(0, Math.floor(ms / 1000))
	return `${Math.floor(sec / 60)}:${pad2(sec % 60)}`
}

export function fmtDur(ms) {
	if (ms < 1000) return `${Math.round(ms)} ms`
	return `${(ms / 1000).toFixed(1).replace(".", ",")} s`
}

export function fmtNum(n) {
	return Number(n || 0).toLocaleString("sr-RS")
}

export function truncate(str, n) {
	const t = String(str ?? "")
	return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

export function jsonShort(v, n = 240) {
	try {
		return truncate(typeof v === "string" ? v : JSON.stringify(v), n)
	} catch {
		return ""
	}
}

export const SECTIONS = [
	{ id: "rukovodstvo", label: "Rukovodstvo" },
	{ id: "novac", label: "Novac" },
	{ id: "firme", label: "Firme" },
	{ id: "revizija", label: "Revizija" },
	{ id: "mediji", label: "Mediji" },
]
export const SECTION_LABEL = Object.fromEntries(SECTIONS.map((x) => [x.id, x.label]))

export const STATUS_LABEL = {
	zvanicno: "ZVANIČNO",
	potvrdjeno: "POTVRĐENO",
	nepotvrdjeno: "NEPOTVRĐENO",
	demantovano: "DEMANTOVANO",
}

export const SEVERITY_LABEL = { info: "info", paznja: "pažnja", signal: "signal" }

export const SIGNAL_LABEL = {
	VD_PREKO_ROKA: "v.d. preko roka",
	VD_BLIZU_ROKA: "v.d. blizu roka",
	IMENOVANJE_NEPOZNATO: "imenovanje nepoznato",
	BEZ_OBJAVE: "bez objave",
	KONCENTRACIJA: "koncentracija dobavljača",
	UGOVOR_VECI_OD_PRIHODA: "ugovor veći od prihoda",
	MLADA_FIRMA: "mlada firma",
	MALO_ZAPOSLENIH: "malo zaposlenih",
	POLITICKA_VEZA: "politička veza",
	VLASNIK_FUNKCIONER: "vlasnik je funkcioner",
	DRI_NALAZ: "nalaz DRI",
	DRI_MISLJENJE: "mišljenje DRI",
	MEDIJSKI_NAVOD: "medijski navod",
	IMOVINA: "imovina",
	KONFLIKT_IZVORA: "konflikt izvora",
}

export const SOURCE_LABEL = {
	acas: "ACAS",
	jnportal: "Portal JN",
	integrity_watch: "Integrity Watch",
	apr: "APR",
	dri: "DRI",
	vesti: "Vesti",
	paragraf: "Sl. glasnik",
	zakon: "Zakon",
	opensanctions: "OpenSanctions",
	krik: "KRIK",
	novinar: "Novinar",
}

export const RULE_LABEL = {
	zvanicni_izvor_ima_prednost: "prednost zvaničnom izvoru",
	vise_izvora: "prednost nalazu sa više izvora",
	noviji_datum: "prednost novijem podatku",
}

export const ROLE_LABEL = {
	institucija: "institucija",
	funkcioner: "funkcioner",
	dobavljac: "dobavljač",
	vlasnik: "vlasnik",
	pomenut: "pomenut",
}

export function sourceChipLabel(src) {
	const base = src.kind === "vesti" ? truncate(String(src.title || "Vesti").split(/\s[–—-]\s/)[0], 22) : SOURCE_LABEL[src.kind] || src.kind
	const d = fmtDate(src.publishedAt || src.retrievedAt)
	return d ? `${base} · ${d}` : base
}
