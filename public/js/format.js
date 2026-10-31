// Small shared helpers: DOM builder, escaping, formatting, labels.

import { t, tx, getLang } from "./i18n.js"

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
	{ id: "novac", label: "Nabavke i novac" },
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

/** What a status means, said in words next to the colour (hover text and the finding's "Pouzdanost" line). */
export const STATUS_EXPLAIN = translated({
	zvanicno: "podatak iz zvaničnog registra ili dokumenta; tumačenje nije time potvrđeno",
	potvrdjeno: "isti podatak navode bar dva nezavisna izvora",
	nepotvrdjeno: "stoji na jednom nezvaničnom izvoru",
	demantovano: "navod se razlikuje od zvaničnog registra; prednost ima registar",
})

export const SEVERITY_LABEL = translated({ info: "informacija", paznja: "za pažnju", signal: "signal" })

export const SIGNAL_LABEL = translated({
	VD_PREKO_ROKA: "v.d. preko roka",
	VD_BLIZU_ROKA: "v.d. blizu roka",
	VD_LANAC: "lanac v.d.",
	IMENOVANJE_NEPOZNATO: "imenovanje nepoznato",
	BEZ_OBJAVE: "bez objave",
	KONCENTRACIJA: "udeo najvećih dobavljača",
	UGOVOR_VECI_OD_PRIHODA: "ugovor veći od prihoda",
	MLADA_FIRMA: "nova firma",
	MALO_ZAPOSLENIH: "malo zaposlenih",
	POLITICKA_VEZA: "politička veza",
	VLASNIK_FUNKCIONER: "vlasnik je funkcioner",
	DRI_NALAZ: "nalaz DRI",
	DRI_MISLJENJE: "mišljenje DRI",
	MEDIJSKI_NAVOD: "medijski navod",
	IMOVINA: "imovina",
	KONFLIKT_IZVORA: "neslaganje izvora",
})

export const SOURCE_LABEL = translated({
	acas: "ACAS",
	jnportal: "Portal javnih nabavki",
	integrity_watch: "Integrity Watch",
	apr: "APR",
	dri: "DRI",
	vesti: "Mediji",
	paragraf: "Službeni glasnik",
	zakon: "Propis",
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

/** What an agent's tool does, in words a reader understands (the timeline and the agent status show these, not the tool names). */
export const TOOL_LABEL = translated({
	acas_funkcioneri: "proverava funkcionere u registru ACAS",
	acas_imovina: "čita izveštaje o imovini (ACAS)",
	acas_pretraga_osobe: "traži osobu u registru ACAS",
	vd_provera: "računa rok za vršioca dužnosti",
	paragraf_akti: "traži akt o imenovanju u Službenom glasniku",
	jn_pregled: "preuzima ugovore sa Portala javnih nabavki",
	jn_ugovori_dobavljaca: "preuzima ugovore dobavljača",
	iw_veze: "proverava dobavljače u Integrity Watch",
	iw_veze_dobavljaca: "proverava firmu u Integrity Watch",
	dri_izvestaji: "traži izveštaje DRI",
	dri_nalazi: "čita izveštaj DRI",
	dri_srodni_nalazi: "traži srodne nalaze DRI",
	vesti_pretraga: "pretražuje medije",
	vest_tekst: "čita članak",
	vesti_imenovanje: "traži medijske objave o imenovanju",
	vesti_tema_revizije: "traži medijske objave o temi revizije",
	apr_firma: "čita profil firme u APR",
	firma_signali: "proverava profil firme i ugovore",
	firma_vlasnici: "traži vlasnike firme (CompanyWall)",
	pep_provera: "proverava liste politički izloženih osoba",
	trijaza_rukovodstvo: "proverava rukovodstvo",
	trijaza_nabavke: "proverava javne nabavke",
	trijaza_revizija: "proverava izveštaje DRI",
	upisi_red: "upisuje red u rang-listu",
	add_finding: "upisuje nalaz",
	add_entity: "dodaje osobu ili firmu",
	dosije_pregled: "pregleda dosije",
	napisi_sazetak: "piše sažetak",
	ask_human: "postavlja pitanje novinaru",
})

/** What each agent does: shown under its name and in its tooltip. Dynamic agents ("Firme · X") are keyed by their group. */
export const ROLE_TEXT = translated({
	kadrovik: "rukovodstvo, imenovanja i rok za v.d.",
	nabavke: "javne nabavke, ugovori i dobavljači",
	revizor: "izveštaji Državne revizorske institucije",
	mediji: "medijske objave i navodi",
	urednik: "spaja nalaze, proverava izvore, piše sažetak",
	firme: "profil firme, ugovori, vlasnici, veze",
	imovina: "imovina i prihodi funkcionera (ACAS)",
	provera: "da li je vlasnik funkcioner ili PEP",
	trijaza: "rukovodstvo, nabavke i revizija za poređenje",
	novinar: "Vi, kad agent nešto pita",
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
	const why = STATUS_EXPLAIN[status]
	return h("span", { class: `stat ${status}`, title: why ? `${STATUS_LABEL[status]}: ${why}` : null }, h("i"), STATUS_LABEL[status] || status)
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
					open ? t("prikažite manje") : t("prikažite još {n}", { n: rest }),
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

/** Line icons (20×20, drawn with the current color) for what each kind of agent looks into. */
const AGENT_ICON = {
	// leadership and appointments: a person in a tie
	kadrovik: '<circle cx="10" cy="6" r="3"/><path d="M4 17.5c.6-3.6 3-5.6 6-5.6s5.4 2 6 5.6"/><path d="m10 12 1.2 1.7L10 17l-1.2-3.3z"/>',
	// procurement: a receipt
	nabavke: '<path d="M5 2.5h10v15l-1.7-1.2-1.6 1.2-1.7-1.2-1.7 1.2-1.6-1.2L5 17.5z"/><path d="M7.5 6.5h5M7.5 9.5h5M7.5 12.5h3"/>',
	// audits: a document under a magnifier
	revizor: '<path d="M11.5 2.5H5v15h5"/><path d="M11.5 2.5 15 6v3"/><circle cx="13.2" cy="13.2" r="2.8"/><path d="m15.2 15.2 2.3 2.3"/>',
	// the media: a newspaper
	mediji: '<path d="M3 4.5h10.5v11a2 2 0 0 0 2 2H5a2 2 0 0 1-2-2z"/><path d="M13.5 8h3v7.5a2 2 0 0 1-2 2"/><path d="M5.8 7.5h5M5.8 10.5h5M5.8 13.5h3"/>',
	// the editor: a pen
	urednik: '<path d="M13.5 3.2 16.8 6.5 7.3 16H4v-3.3z"/><path d="m11.6 5.1 3.3 3.3"/>',
	// suppliers: a building
	firme: '<path d="M3 17.5h14"/><path d="M5 17.5V3.5h7v14"/><path d="M12 8h3v9.5"/><path d="M7.5 6.5h2M7.5 9.5h2M7.5 12.5h2"/>',
	// assets: a house
	imovina: '<path d="M3 9.5 10 3.5l7 6"/><path d="M5 8.2V17h10V8.2"/><path d="M8.5 17v-4.2h3V17"/>',
	// owner checks: a shield with a check
	provera: '<path d="M10 2.5 16 5v4.8c0 3.6-2.5 6.3-6 7.7-3.5-1.4-6-4.1-6-7.7V5z"/><path d="m7.3 10 1.9 1.9 3.6-3.8"/>',
	// triage of one institution: scales
	trijaza: '<path d="M10 3v14M6 17h8M4 6h12"/><path d="M4 6 2 11a2.1 2.1 0 0 0 4 0z"/><path d="m16 6-2 5a2.1 2.1 0 0 0 4 0z"/>',
	// the journalist
	novinar: '<circle cx="10" cy="7" r="3.2"/><path d="M3.8 17c.8-3.3 3.2-5.2 6.2-5.2s5.4 1.9 6.2 5.2"/>',
	sistem: '<circle cx="10" cy="10" r="3"/><path d="M10 2.5V5M10 15v2.5M2.5 10H5M15 10h2.5M4.7 4.7l1.8 1.8M13.5 13.5l1.8 1.8M4.7 15.3l1.8-1.8M13.5 6.5l1.8-1.8"/>',
}

/** The agent's icon on an earth-tone tile; the tint comes from the agent group (see styles.css). */
export function avatar(info, cls = "") {
	const group = info?.group || "sistem"
	const el = h("span", { class: `av ${cls}`.trim(), dataset: { g: group }, "aria-hidden": "true" })
	el.innerHTML = `<svg viewBox="0 0 20 20">${AGENT_ICON[group] || AGENT_ICON.sistem}</svg>`
	return el
}
