// Small shared helpers: DOM builder, escaping, formatting, labels.

import { t, tx, agentName, getLang } from "./i18n.js"

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
	const s = (ms / 1000).toFixed(1)
	return `${getLang() === "en" ? s : s.replace(".", ",")} s`
}

export function fmtNum(n) {
	return Number(n || 0).toLocaleString(getLang() === "en" ? "en-US" : "sr-RS")
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

/** Label tables are written in Serbian; reading a key returns the text in the current language (see i18n.js). */
const translated = (table) => new Proxy(table, { get: (o, k) => (typeof o[k] === "string" ? t(o[k]) : o[k]) })

export const SECTION_LABEL = translated(Object.fromEntries(SECTIONS.map((x) => [x.id, x.label])))

export const STATUS_LABEL = translated({
	zvanicno: "Zvanično",
	potvrdjeno: "Potvrđeno",
	nepotvrdjeno: "Nepotvrđeno",
	demantovano: "Odstupa od registra",
})

export const SEVERITY_LABEL = translated({ info: "info", paznja: "pažnja", signal: "signal" })

export const SIGNAL_LABEL = translated({
	VD_PREKO_ROKA: "v.d. preko roka",
	VD_BLIZU_ROKA: "v.d. blizu roka",
	VD_LANAC: "lanac v.d.",
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
})

export const SOURCE_LABEL = translated({
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
	companywall: "CompanyWall",
	novinar: "Novinar",
})

export const RULE_LABEL = translated({
	zvanicni_izvor_ima_prednost: "prednost zvaničnom izvoru",
	vise_izvora: "prednost nalazu sa više izvora",
	noviji_datum: "prednost novijem podatku",
})

export const ROLE_LABEL = translated({
	institucija: "institucija",
	funkcioner: "funkcioner",
	dobavljac: "dobavljač",
	vlasnik: "vlasnik",
	pomenut: "pomenut",
})

/** News sources are titled "Outlet: headline" (or "Outlet – headline"): split into both parts. */
export function splitSourceTitle(src) {
	const title = String(src.title || "").trim()
	const m = title.match(/^(.{2,40}?)(?:\s[–—-]\s|:\s)(.+)$/)
	if (m) return { outlet: m[1], headline: m[2] }
	return { outlet: domainOf(src.url) || SOURCE_LABEL[src.kind] || src.kind, headline: title }
}

export function sourceChipLabel(src) {
	const base = src.kind === "vesti" ? truncate(splitSourceTitle(src).outlet, 22) : SOURCE_LABEL[src.kind] || src.kind
	const d = fmtDate(src.publishedAt || src.retrievedAt)
	return d ? `${base} · ${d}` : base
}

/** "ACAS · publicacas.acas.rs · 22.05.2025" */
export function sourceLine(src) {
	const base = src.kind === "vesti" ? truncate(splitSourceTitle(src).outlet, 28) : SOURCE_LABEL[src.kind] || src.kind
	return [base, domainOf(src.url), fmtDate(src.publishedAt || src.retrievedAt)].filter(Boolean).join(" · ")
}

export function statusTag(status) {
	return h("span", { class: `stat ${status}` }, h("i"), STATUS_LABEL[status] || status)
}

const SOURCE_LIST_MIN = 4 // this many sources or more: one per line
const SOURCE_LIST_SHOWN = 5
const expandedSources = new Set() // keys (finding ids) whose full list is open

function sourceItem(src) {
	const url = safeUrl(src.url)
	const title = `${tx(src.title)}${src.official ? ` (${t("zvanični izvor")})` : ""}`
	const { outlet, headline } = src.kind === "vesti" ? splitSourceTitle(src) : { outlet: SOURCE_LABEL[src.kind] || src.kind, headline: src.title }
	const date = fmtDate(src.publishedAt || src.retrievedAt)
	const meta = [truncate(outlet, 26), date].filter(Boolean).join(" · ")
	const text = h("span", { class: "sl-text" }, h("span", { class: "sl-meta" }, meta), " · ", tx(headline))
	return h("li", null, url ? h("a", { class: `src${src.official ? " official" : ""}`, href: url, target: "_blank", rel: "noopener noreferrer", title }, text) : h("span", { class: "src", title }, text))
}

/** Sources as quiet links. 1-3: inline (label, domain, date). 4+: a compact list, first five, "prikaži još N". */
export function sourceLinks(sources, key) {
	const list = sources || []
	if (list.length < SOURCE_LIST_MIN) {
		return h(
			"div",
			{ class: "f-sources" },
			list.map((src) => {
				const url = safeUrl(src.url)
				const label = sourceLine(src)
				const title = `${tx(src.title)}${src.official ? ` (${t("zvanični izvor")})` : ""}`
				return url ? h("a", { class: `src${src.official ? " official" : ""}`, href: url, target: "_blank", rel: "noopener noreferrer", title }, label) : h("span", { class: "src", title }, label)
			}),
		)
	}
	const ul = h("ul", { class: "src-list" })
	const box = h("div", { class: "f-sources list" }, h("div", { class: "src-count" }, t("Izvori ({n})", { n: list.length })), ul)
	const render = () => {
		const open = key && expandedSources.has(key)
		const shown = open ? list : list.slice(0, SOURCE_LIST_SHOWN)
		ul.replaceChildren(...shown.map(sourceItem))
		box.querySelector(".src-more")?.remove()
		if (list.length > SOURCE_LIST_SHOWN) {
			const rest = list.length - SOURCE_LIST_SHOWN
			box.append(
				h(
					"button",
					{
						class: "link-btn src-more",
						type: "button",
						"aria-expanded": String(!!open),
						onclick: () => {
							if (!key) return
							if (expandedSources.has(key)) expandedSources.delete(key)
							else expandedSources.add(key)
							render()
						},
					},
					open ? t("prikaži manje") : t("prikaži još {n}", { n: rest }),
				),
			)
		}
	}
	if (!key) key = `local-${Math.random()}`
	render()
	return box
}

export function domainOf(url) {
	try {
		return new URL(url).hostname.replace(/^www\./, "")
	} catch {
		return ""
	}
}

/** Two letters for the avatar: "Kadrovik" -> "KA"; "Firme · ZGOP" -> "FZ" (group + entity). */
export function initials(name) {
	const str = String(name || "")
	const [head, ...rest] = str.split("·").map((x) => x.trim())
	const letters = (x) => [...(x.match(/\p{L}/gu) || [])]
	if (rest.length) {
		const a = letters(head)[0]
		const b = letters(rest.join(" "))[0]
		if (a && b) return (a + b).toUpperCase()
	}
	const l = letters(head)
	return ((l[0] || "?") + (l[1] || "")).toUpperCase()
}

/** Round initials avatar; the tint comes from the agent group (see styles.css). */
export function avatar(info, cls = "") {
	const name = agentName(info?.name || "")
	return h("span", { class: `av ${cls}`.trim(), dataset: { g: info?.group || "sistem" }, "aria-hidden": "true" }, initials(name))
}
