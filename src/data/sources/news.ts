// News search and article text. Free providers are always on: outlet RSS feeds (+ raspadsistema.com data.json),
// Google News RSS (Latin and Cyrillic, two language editions, exact-phrase queries) and GDELT DOC 2.0. Serper.dev
// (SERPER_API_KEY) and Brave Search News (BRAVE_API_KEY) are optional and skipped silently without a key.
// Precision comes first (src/data/newsMatch.ts): an institution article must name the institution, a person article must
// name the person AND the institution / firm. Search engines match the full text but give no snippet, so a candidate whose
// headline does not carry the name is verified against the article text. Only the final merged result / the extracted
// article is cached (feeds change all the time, so they are never cached on their own).

import crypto from "node:crypto"
import { XMLParser } from "fast-xml-parser"
import { trackActivity, type ActivityDescriptor } from "../activity"
import { cached, cacheKey, getDataMode, readCache } from "../cache"
import { getText, httpRequest } from "../http"
import { buildMatcher, dropRepeats, isNoiseTitle, isOriginalOutlet, normalizeUrl, wordsOf, type Matcher, type SubjectKind } from "../newsMatch"
import { clipWords } from "../../shared/text"
import { cyrToLat, hasCyrillic, latToCyr } from "../translit"
import type { ArticleText, NewsItem } from "../types"

const SOURCE = "vesti"
const MAX_ARTICLE_CHARS = 6000
const VERIFY_TIMEOUT_MS = 12000
const VERIFY_BUDGET_MS = 35_000
const RESOLVE_BUDGET_MS = 60_000

// ── outlet feeds (every URL below was verified to return items, Oct 2026) ───────────────────────

interface Feed {
	outlet: string
	provider: string
	url: string
}

const FEEDS: Feed[] = [
	{ outlet: "N1", provider: "rss:n1", url: "https://n1info.rs/feed/" },
	{ outlet: "Danas", provider: "rss:danas", url: "https://www.danas.rs/feed/" },
	{ outlet: "Nova.rs", provider: "rss:nova", url: "https://nova.rs/feed/" },
	{ outlet: "Vreme", provider: "rss:vreme", url: "https://www.vreme.com/feed/" },
	{ outlet: "Insajder", provider: "rss:insajder", url: "https://insajder.net/feed" },
	{ outlet: "021.rs", provider: "rss:021", url: "https://www.021.rs/rss/all" },
	{ outlet: "RTS", provider: "rss:rts", url: "https://www.rts.rs/page/stories/sr/rss.html" },
	{ outlet: "Južne vesti", provider: "rss:juznevesti", url: "https://www.juznevesti.com/feed/" },
	{ outlet: "KRIK", provider: "rss:krik", url: "https://www.krik.rs/feed/" },
	{ outlet: "CINS", provider: "rss:cins", url: "https://www.cins.rs/feed/" },
	{ outlet: "Istinomer", provider: "rss:istinomer", url: "https://www.istinomer.rs/feed/" },
]
const RASPADSISTEMA_URL = "https://raspadsistema.com/data.json"

export function availableProviders(): string[] {
	const out = ["rss", "google-news-rss", "gdelt"]
	if (process.env.SERPER_API_KEY) out.push("serper")
	if (process.env.BRAVE_API_KEY) out.push("brave")
	return out
}

// ── text helpers ────────────────────────────────────────────────────────────

const NAMED: Record<string, string> = {
	nbsp: " ", amp: "&", quot: '"', lt: "<", gt: ">", apos: "'", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", ndash: "–",
	mdash: "—", hellip: "…", laquo: "«", raquo: "»", bdquo: "„", scaron: "š", Scaron: "Š", ccaron: "č", Ccaron: "Č", zcaron: "ž",
	Zcaron: "Ž", cacute: "ć", Cacute: "Ć", dstrok: "đ", Dstrok: "Đ",
}

function decodeEntities(s: string): string {
	return s
		.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
		.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
		.replace(/&([a-zA-Z]+);/g, (m, n) => NAMED[n] ?? m)
}

function plain(html: string): string {
	return decodeEntities(html.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim()
}

function toIso(s: string | undefined): string | undefined {
	if (!s) return undefined
	// Serbian pages write the day first (12.06.2026.); Date.parse would read that as 6 December
	const dmy = /^\s*(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})\.?(?:\s+(\d{1,2}):(\d{2}))?/.exec(s)
	const t = dmy ? new Date(+dmy[3], +dmy[2] - 1, +dmy[1], +(dmy[4] ?? 0), +(dmy[5] ?? 0)).getTime() : Date.parse(s)
	return Number.isNaN(t) ? undefined : notFuture(new Date(t).toISOString())
}

/**
 * A date in the future was misread: day and month swapped (12.06.2026. read as 6 December). Swapped back when that gives
 * a past date, otherwise dropped. Also mends dates already in the cache from before this check.
 */
function notFuture(iso: string | undefined, now = Date.now()): string | undefined {
	if (!iso) return iso
	const t = Date.parse(iso)
	if (Number.isNaN(t) || t <= now + 86400e3) return iso
	const d = new Date(t)
	const swapped = new Date(d.getFullYear(), d.getDate() - 1, d.getMonth() + 1, d.getHours(), d.getMinutes())
	return d.getDate() <= 12 && swapped.getTime() <= now ? swapped.toISOString() : undefined
}

function relativeDate(s: string | undefined, now = Date.now()): string | undefined {
	if (!s) return undefined
	const abs = toIso(s)
	if (abs) return abs
	const m = s.toLowerCase().match(/(\d+)\s*(minut|min|sat|hour|h\b|dan|day|nedelj|week|mesec|month|god|year)/)
	if (!m) return undefined
	const n = Number(m[1])
	const unit = m[2]
	const ms = /^(minut|min)/.test(unit) ? 60e3 : /^(sat|hour|h)/.test(unit) ? 3600e3 : /^(dan|day)/.test(unit) ? 86400e3 : /^(nedelj|week)/.test(unit) ? 7 * 86400e3 : /^(mesec|month)/.test(unit) ? 30 * 86400e3 : 365 * 86400e3
	return new Date(now - n * ms).toISOString()
}

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", textNodeName: "#text", processEntities: true, trimValues: true })
const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v])
const txt = (v: any): string => (v == null ? "" : typeof v === "object" ? String(v["#text"] ?? "") : String(v))

interface RawItem {
	title: string
	url: string
	outlet: string
	publishedAt?: string
	snippet?: string
	provider: string
}

const isEngine = (p: string) => !p.startsWith("rss:")
const itemId = (url: string) => crypto.createHash("sha1").update(normalizeUrl(url)).digest("hex").slice(0, 12)

// ── provider: outlet RSS ────────────────────────────────────────────────────

async function fetchFeed(feed: Feed): Promise<RawItem[]> {
	const body = await getText(feed.url, { timeoutMs: 15000, retries: 1, headers: { Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5" } })
	const doc: any = xml.parse(body)
	const channelItems = arr<any>(doc?.rss?.channel?.item)
	if (channelItems.length > 0) {
		return channelItems.map((i) => ({
			title: txt(i.title),
			url: txt(i.link).trim(),
			outlet: feed.outlet,
			publishedAt: toIso(txt(i.pubDate) || txt(i["dc:date"])),
			snippet: txt(i.description) || txt(i["content:encoded"]).slice(0, 600),
			provider: feed.provider,
		}))
	}
	return arr<any>(doc?.feed?.entry).map((e) => {
		const link = arr<any>(e.link).find((l) => l["@_rel"] !== "self") ?? arr<any>(e.link)[0]
		return {
			title: txt(e.title),
			url: String(link?.["@_href"] ?? ""),
			outlet: feed.outlet,
			publishedAt: toIso(txt(e.published) || txt(e.updated)),
			snippet: txt(e.summary) || txt(e.content).slice(0, 600),
			provider: feed.provider,
		}
	})
}

async function fetchRaspadSistema(): Promise<RawItem[]> {
	const data = (await httpRequest(RASPADSISTEMA_URL, { timeoutMs: 15000, retries: 1 })).json<{ feed?: any[] }>()
	return (data.feed ?? [])
		.filter((x) => x.title && x.url)
		.map((x) => ({
			title: String(x.title),
			url: String(x.url),
			// the aggregator is not the publisher: credit the original outlet ("Danas"), as the finding's source title does
			outlet: x.src ? String(x.src) : "raspadsistema.com",
			publishedAt: toIso(x.t),
			snippet: [x.body, x.role && `Funkcija: ${x.role}`].filter(Boolean).join(" "),
			provider: "rss:raspadsistema",
		}))
}

// ── provider: Google News RSS ───────────────────────────────────────────────

/** Google News edition: "sr-Latn" (Latin) and "sr" (Cyrillic) return different result sets for the same query. */
type Edition = "sr-Latn" | "sr"

async function fetchGoogleNews(q: string, days: number, hl: Edition): Promise<RawItem[]> {
	const url = `https://news.google.com/rss/search?q=${encodeURIComponent(`${q} when:${Math.max(1, Math.round(days))}d`)}&hl=${hl}&gl=RS&ceid=RS:${hl}`
	const doc: any = xml.parse(await getText(url, { timeoutMs: 25000, retries: 1 }))
	return arr<any>(doc?.rss?.channel?.item).map((i) => {
		const outlet = txt(i.source) || "Google News"
		const title = txt(i.title).replace(new RegExp(`\\s+-\\s+${outlet.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), "")
		return { title, url: txt(i.link).trim(), outlet, publishedAt: toIso(txt(i.pubDate)), provider: "google-news-rss" }
	})
}

const gnCache = new Map<string, string>()
// one resolution per link at a time, and at most a few requests to Google at once across all searches of the process: the endpoint
// throttles bursts (five parallel searches used to push one search past two minutes)
const gnInflight = new Map<string, Promise<string>>()
let gnActive = 0
const gnQueue: (() => void)[] = []

async function gnSlot<T>(fn: () => Promise<T>): Promise<T> {
	if (gnActive >= 5) await new Promise<void>((r) => gnQueue.push(r))
	gnActive++
	try {
		return await fn()
	} finally {
		gnActive--
		gnQueue.shift()?.()
	}
}

/** Google News article links are opaque; resolve through the same endpoint the news.google.com page uses. */
function resolveGoogleNewsUrl(link: string): Promise<string> {
	if (!/^https?:\/\/news\.google\.com\/(rss\/)?articles\//.test(link)) return Promise.resolve(link)
	const hit = gnCache.get(link)
	if (hit) return Promise.resolve(hit)
	let p = gnInflight.get(link)
	if (!p) {
		p = gnSlot(() => resolveGoogleNewsUrlOnce(link)).finally(() => gnInflight.delete(link))
		gnInflight.set(link, p)
	}
	return p
}

// after a 429 the endpoint is left alone for a while: more requests only prolong the block, and every dossier would wait for them
let gnBlockedUntil = 0

async function resolveGoogleNewsUrlOnce(link: string): Promise<string> {
	if (Date.now() < gnBlockedUntil) return link
	try {
		const id = new URL(link).pathname.split("/").pop()!
		const page = (await httpRequest(`https://news.google.com/rss/articles/${id}?hl=sr&gl=RS&ceid=RS:sr`, { timeoutMs: 10000, retries: 0 })).text()
		const sg = page.match(/data-n-a-sg="([^"]+)"/)?.[1]
		const ts = page.match(/data-n-a-ts="([^"]+)"/)?.[1]
		if (!sg || !ts) return link
		const inner = JSON.stringify(["garturlreq", [["X", "X", ["X", "X"], null, null, 1, 1, "US:en", null, 1, null, null, null, null, null, 0, 1], "X", "X", 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0], id, Number(ts), sg])
		const res = await httpRequest("https://news.google.com/_/DotsSplashUi/data/batchexecute", {
			method: "POST",
			body: "f.req=" + encodeURIComponent(JSON.stringify([[["Fbv4je", inner, null, "generic"]]])),
			headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
			timeoutMs: 10000,
			retries: 0,
		})
		const m = res.text().match(/garturlres\\",\\"(https?:[^"\\]+)/)
		if (m) {
			gnCache.set(link, m[1])
			return m[1]
		}
	} catch (err) {
		if ((err as { status?: number })?.status === 429) gnBlockedUntil = Date.now() + 10 * 60_000
		// keep the Google link
	}
	return link
}

const isGoogleLink = (url: string) => /^https?:\/\/news\.google\.com\//.test(url)

// ── provider: GDELT DOC 2.0 (rolling 3 months, one request per 5 s) ─────────────────────────────

let gdeltNext = 0

async function fetchGdelt(q: string, days: number): Promise<RawItem[]> {
	const span = days <= 1 ? "24h" : days <= 60 ? `${Math.round(days)}d` : "3months"
	const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(q)}&mode=artlist&format=json&maxrecords=75&sort=datedesc&timespan=${span}`
	for (let attempt = 0; attempt < 2; attempt++) {
		const wait = gdeltNext - Date.now()
		if (wait > 0) await new Promise((r) => setTimeout(r, wait))
		gdeltNext = Date.now() + 5500
		try {
			const res = await httpRequest(url, { timeoutMs: 15000, retries: 0 })
			const body = res.text().trim()
			if (!body.startsWith("{")) return []
			const data = JSON.parse(body) as { articles?: { url: string; title: string; seendate: string; domain: string }[] }
			return (data.articles ?? []).map((a) => {
				const d = a.seendate?.match(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)/)
				return {
					title: a.title,
					url: a.url,
					outlet: a.domain.replace(/^www\./, ""),
					publishedAt: d ? `${d[1]}-${d[2]}-${d[3]}T${d[4]}:${d[5]}:${d[6]}Z` : undefined,
					provider: "gdelt",
				}
			})
		} catch (err: any) {
			if (err?.status === 429) {
				gdeltNext = Date.now() + 7000
				continue
			}
			throw err
		}
	}
	return []
}

// ── optional providers ──────────────────────────────────────────────────────

async function fetchSerper(q: string, days: number): Promise<RawItem[]> {
	const key = process.env.SERPER_API_KEY
	if (!key) return []
	const tbs = days <= 1 ? "qdr:d" : days <= 7 ? "qdr:w" : days <= 31 ? "qdr:m" : days <= 366 ? "qdr:y" : undefined
	const res = await httpRequest("https://google.serper.dev/news", {
		method: "POST",
		headers: { "X-API-KEY": key, "Content-Type": "application/json" },
		body: { q, gl: "rs", hl: "sr", num: 20, ...(tbs ? { tbs } : {}) },
		timeoutMs: 20000,
	})
	const data = res.json<{ news?: { title: string; link: string; snippet?: string; date?: string; source?: string }[] }>()
	return (data.news ?? []).map((n) => ({
		title: n.title,
		url: n.link,
		outlet: n.source ?? new URL(n.link).hostname.replace(/^www\./, ""),
		publishedAt: relativeDate(n.date),
		snippet: n.snippet,
		provider: "serper",
	}))
}

async function fetchBrave(q: string, days: number): Promise<RawItem[]> {
	const key = process.env.BRAVE_API_KEY
	if (!key) return []
	const to = new Date()
	const from = new Date(to.getTime() - days * 86400e3)
	const day = (d: Date) => d.toISOString().slice(0, 10)
	const url =
		// no country param: Brave has no "rs" country code and answers 422; the query and search_lang keep it Serbian
		`https://api.search.brave.com/res/v1/news/search?q=${encodeURIComponent(q)}&search_lang=sr&count=20` +
		`&freshness=${day(from)}to${day(to)}`
	const res = await httpRequest(url, { headers: { "X-Subscription-Token": key, Accept: "application/json" }, timeoutMs: 20000 })
	const data = res.json<{ results?: { title: string; url: string; description?: string; page_age?: string; age?: string; meta_url?: { hostname?: string }; source?: string }[] }>()
	return (data.results ?? []).map((r) => ({
		title: r.title,
		url: r.url,
		outlet: r.meta_url?.hostname?.replace(/^www\./, "") ?? new URL(r.url).hostname.replace(/^www\./, ""),
		publishedAt: toIso(r.page_age) ?? relativeDate(r.age),
		snippet: r.description,
		provider: "brave",
	}))
}

// ── search ──────────────────────────────────────────────────────────────────

export interface NewsSearchOptions {
	days?: number
	limit?: number
	/** institution: main name is `query`; person: full name; topic: free words that must all appear */
	kind?: SubjectKind
	/** other names of the same institution ("IŽS", "Srbija voz") */
	aliases?: string[]
	/** person: institution / firm names; the article must name one of them too */
	context?: string[]
	/** longer institution names that contain this one; mentions inside them do not count */
	exclude?: string[]
}

/** Source label of a merged search (what a cached result stands for). */
export function searchSourceLabel(): string {
	return `Vesti (${["RSS", "Google News", "GDELT", process.env.SERPER_API_KEY ? "Serper" : "", process.env.BRAVE_API_KEY ? "Brave" : ""].filter(Boolean).join(", ")})`
}

/** "Srbija Kargo" or, for the Cyrillic variant of the query, "Srbija Kargo (ćirilica)". */
function variantLabel(v: string): string {
	return hasCyrillic(v) ? `pretraga: ${cyrToLat(v)} (ćirilica)` : `pretraga: ${v}`
}

/** One provider request of a live search ("N1 (RSS)", "Google News", "GDELT", ...) as a live-search activity. */
function tracked(desc: Omit<ActivityDescriptor, "kind">, run: () => Promise<RawItem[]>): Promise<RawItem[]> {
	return trackActivity({ ...desc, kind: "vesti" }, async (h) => {
		const items = await run()
		h.items(items.length)
		return items
	})
}

const unique = <T>(list: T[]): T[] => [...new Set(list)]
const scripts = (name: string): string[] => unique([hasCyrillic(name) ? cyrToLat(name) : name, hasCyrillic(name) ? name : latToCyr(name)])

async function mapLimit<T, R>(list: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const out = new Array<R>(list.length)
	let next = 0
	await Promise.all(
		Array.from({ length: Math.min(limit, list.length) }, async () => {
			while (next < list.length) {
				const i = next++
				out[i] = await fn(list[i], i)
			}
		}),
	)
	return out
}

interface Candidate {
	raw: RawItem
	title: string
	snippet?: string
	/** the subject is named in the headline / snippet */
	hit: "naslov" | "opis" | null
	/** a search engine matched the query in the full text; the article text decides */
	needsText: boolean
}

function classify(raw: RawItem, m: Matcher, kind: SubjectKind): Candidate | null {
	const title = plain(raw.title).replace(/^[:\-–—\s]+/, "")
	const snippet = raw.snippet ? plain(raw.snippet).slice(0, 400) : undefined
	if (!title) return null
	const tw = wordsOf(title)
	const sw = snippet ? wordsOf(snippet) : []
	const all = [...tw, "_", ...sw]
	const inTitle = m.subject(tw)
	const inSnippet = !inTitle && sw.length > 0 && m.subject(sw)
	const subjectHit = inTitle || inSnippet
	if (kind === "person" && isNoiseTitle(title) && !m.context(tw)) return null
	const ok = subjectHit && m.context(all)
	if (ok) return { raw, title, snippet, hit: inTitle ? "naslov" : "opis", needsText: false }
	// a person named without the institution in the headline, or an engine hit whose headline does not carry the name
	if (kind !== "topic" && (isEngine(raw.provider) || subjectHit)) return { raw, title, snippet, hit: null, needsText: true }
	return null
}

/** The sentence of an article around the first mention (what the finding quotes as the reason the article counts). */
function excerptAround(text: string, m: Matcher): string | undefined {
	const sentences = text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter((s) => s.length > 25)
	const hit = sentences.find((s) => m.subject(wordsOf(s))) ?? sentences[0]
	return hit ? clipWords(hit, 240) : undefined
}

function relevance(c: Candidate, verified: NewsItem["verified"], m: Matcher, nameMatchers: Matcher[]): number {
	const tier = verified === "naslov" ? 3 : verified === "opis" ? 2 : 1
	const tw = wordsOf(c.title)
	const lead = m.subject(tw.slice(0, 5)) ? 1 : 0
	const aliasHits = Math.min(2, nameMatchers.filter((x) => x.subject(tw)).length)
	const ctxTitle = m.spec.kind === "person" && m.context(tw) ? 1 : 0
	const original = isOriginalOutlet(c.raw.outlet) || c.raw.provider.startsWith("rss:") ? 1 : 0
	return tier * 10 + lead * 3 + aliasHits + ctxTitle * 2 + original
}

async function liveSearch(query: string, kind: SubjectKind, days: number, limit: number, aliases: string[], context: string[], exclude: string[]): Promise<NewsItem[]> {
	const names = unique([query.trim(), ...aliases.map((a) => a.trim())].filter(Boolean))
	const matcher = buildMatcher({ kind, names, context, exclude })
	if (matcher.tokens.length === 0) return []
	const nameMatchers = names.map((n) => buildMatcher({ kind, names: [n], exclude }))
	const retrievedAt = new Date().toISOString()
	const cutoff = Date.now() - days * 86400e3
	const what = query.trim()

	const jobs: Promise<RawItem[]>[] = []
	const labels: string[] = []
	const job = (label: string, p: Promise<RawItem[]>) => {
		labels.push(label)
		jobs.push(p)
	}

	for (const feed of FEEDS) job(feed.provider, tracked({ source: `${feed.outlet} (RSS)`, action: "preuzimanje", label: `feed: ${what}`, url: feed.url }, () => fetchFeed(feed)))
	job("rss:raspadsistema", tracked({ source: "raspadsistema.com", action: "preuzimanje", label: `feed: ${what}`, url: "https://raspadsistema.com/" }, fetchRaspadSistema))

	// Google News: exact phrase for every name, Latin and Cyrillic, in both language editions (they return different items)
	const gn = new Map<string, { q: string; hl: Edition; label: string }>()
	const addGn = (q: string, hl: Edition, label: string) => gn.set(`${hl}|${q}`, { q, hl, label })
	const phrase = (v: string) => (kind === "topic" && matcher.tokens.length > 3 ? v : `"${v}"`)
	for (const name of names) for (const v of scripts(name)) for (const hl of ["sr-Latn", "sr"] as const) addGn(phrase(v), hl, variantLabel(v))
	if (kind === "person") {
		// the bare name is dominated by namesakes: also ask for the name together with the institution / firm
		for (const c of context.slice(0, 2)) for (const v of scripts(query)) for (const cv of scripts(c).filter((x) => hasCyrillic(x) === hasCyrillic(v))) addGn(`"${v}" "${cv}"`, "sr-Latn", `pretraga: ${cyrToLat(v)} + ${cyrToLat(cv)}`)
	}
	for (const { q, hl, label } of gn.values()) {
		const gnUrl = `https://news.google.com/search?q=${encodeURIComponent(`${q} when:${Math.max(1, Math.round(days))}d`)}&hl=${hl}&gl=RS&ceid=RS:${hl}`
		job(`google-news-rss(${hl},${q})`, tracked({ source: "Google News", action: "pretraga", label, url: gnUrl }, () => fetchGoogleNews(q, days, hl)))
	}
	job(
		"gdelt",
		(async () => {
			const out: RawItem[] = []
			// GDELT is best effort: it rate-limits to one request per 5 s (often 429), so the whole provider gets a time budget
			const work = (async () => {
				for (const v of scripts(query)) out.push(...(await tracked({ source: "GDELT", action: "pretraga", label: variantLabel(v) }, () => fetchGdelt(phrase(v), days)).catch(() => [])))
			})()
			await Promise.race([work, new Promise((r) => setTimeout(r, 9000))])
			return out
		})(),
	)
	if (process.env.SERPER_API_KEY) for (const v of scripts(query)) job("serper", tracked({ source: "Serper", action: "pretraga", label: variantLabel(v) }, () => fetchSerper(v, days)))
	if (process.env.BRAVE_API_KEY) for (const v of scripts(query)) job("brave", tracked({ source: "Brave", action: "pretraga", label: variantLabel(v) }, () => fetchBrave(v, days)))

	const settled = await Promise.allSettled(jobs)
	if (process.env.NEWS_DEBUG) settled.forEach((r, i) => console.error(`  [news] ${labels[i]}: ${r.status === "fulfilled" ? `${r.value.length} items` : `FAILED ${String(r.reason).slice(0, 100)}`}`))
	const raw = settled.flatMap((r) => (r.status === "fulfilled" ? r.value : []))

	// 1. window, links, duplicates of the same link
	const seenLink = new Set<string>()
	const inWindow = raw
		.filter((r) => r.title && r.url && /^https?:/.test(r.url))
		.filter((r) => !r.publishedAt || Date.parse(r.publishedAt) >= cutoff)
		.filter((r) => {
			const k = isGoogleLink(r.url) ? r.url : normalizeUrl(r.url)
			if (seenLink.has(k)) return false
			seenLink.add(k)
			return true
		})

	// 2. precision: the headline / snippet names the subject (and, for a person, the institution or firm)
	const candidates = inWindow.map((r) => classify(r, matcher, kind)).filter((c): c is Candidate => !!c)
	const sure = candidates.filter((c) => !c.needsText)
	const byDate = (a: Candidate, b: Candidate) => (b.raw.publishedAt ?? "").localeCompare(a.raw.publishedAt ?? "")
	const verifyCap = kind === "person" ? 30 : sure.length >= 25 ? 0 : 20
	const toVerify = candidates.filter((c) => c.needsText).sort(byDate).slice(0, verifyCap)
	if (process.env.NEWS_DEBUG) console.error(`  [news] raw=${raw.length} window=${inWindow.length} sure=${sure.length} toVerify=${toVerify.length}`)

	// 3. resolve Google News redirect links (only for what can still count)
	// (own time budget: a throttled Google endpoint must not hold the whole dossier; what is left unresolved ranks last and stays out of the overview)
	const resolveDeadline = Date.now() + RESOLVE_BUDGET_MS
	const resolved = await mapLimit([...sure, ...toVerify], 4, async (c) => {
		if (c.raw.provider !== "google-news-rss" || Date.now() > resolveDeadline) return c
		const url = await resolveGoogleNewsUrl(c.raw.url)
		return url === c.raw.url ? c : { ...c, raw: { ...c.raw, url } }
	})
	const sureResolved = resolved.slice(0, sure.length)
	const verifyResolved = resolved.slice(sure.length)

	const items = new Map<string, NewsItem>()
	const add = (c: Candidate, verified: NonNullable<NewsItem["verified"]>, snippet: string | undefined, publishedAt: string | undefined) => {
		const url = c.raw.url
		const key = normalizeUrl(url)
		if (items.has(key)) return
		const title = c.title
		const words = wordsOf(`${title} . ${snippet ?? ""}`)
		const matchedNames = names.filter((_, i) => nameMatchers[i].subject(words))
		items.set(key, {
			id: itemId(url),
			title,
			url,
			outlet: c.raw.outlet,
			publishedAt,
			snippet,
			matched: matchedNames.length ? matchedNames : [query.trim()],
			provider: c.raw.provider,
			verified,
			score: relevance(c, verified, matcher, nameMatchers),
			unresolved: isGoogleLink(url) || undefined,
			source: { kind: "vesti", title: clipWords(`${c.raw.outlet}: ${title}`, 200), url, retrievedAt, publishedAt, official: false },
		})
	}
	for (const c of sureResolved) add(c, c.hit ?? "naslov", c.snippet, c.raw.publishedAt)

	// 4. verification against the article text (headline did not carry the name)
	if (toVerify.length > 0) {
		const deadline = Date.now() + VERIFY_BUDGET_MS
		await trackActivity({ source: "članci", kind: "vesti", action: "dokument", label: `provera teksta članaka (${verifyResolved.length})` }, async (h) => {
			let passed = 0
			await mapLimit(verifyResolved, 3, async (c) => {
				if (Date.now() > deadline || isGoogleLink(c.raw.url) || items.has(normalizeUrl(c.raw.url))) return
				try {
					const a = await extractArticle(c.raw.url, { timeoutMs: VERIFY_TIMEOUT_MS, retries: 0 })
					const ws = wordsOf(`${a.title} . ${a.text}`)
					if (!matcher.subject(ws) || !matcher.context(ws)) return
					const when = c.raw.publishedAt ?? toIso(a.publishedAt)
					if (when && Date.parse(when) < cutoff) return
					passed++
					add(c, "tekst", excerptAround(a.text, matcher), when)
				} catch {
					// blocked, paywalled or gone: an unverified candidate is dropped, never guessed
				}
			})
			h.items(passed)
		})
	}

	// 5. one story once (aggregator copies lose to the original outlet), relevance first, then recency
	const ranked = dropRepeats([...items.values()]).sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""))
	return ranked.slice(0, limit)
}

// ── outlet quality ──────────────────────────────────────────────────────────

/**
 * Press reviews prefer established outlets. The list is deliberately small and public: national and regional news media with an
 * editorial office, news agencies, investigative newsrooms and the business press (matched on the article's host). When at least
 * MIN_ESTABLISHED articles come from these, articles from any OTHER domain are dropped (tabloid micro-sites and click-bait
 * aggregators such as serbiantimes.info); with fewer, unknown domains stay so that a small institution still gets a review.
 * An article is never altered, only kept or dropped. Not on the list does not mean "false": it means "not vetted by us".
 */
const ESTABLISHED_HOSTS = [
	"n1info.rs", "danas.rs", "nova.rs", "vreme.com", "insajder.net", "021.rs", "rts.rs", "juznevesti.com", "krik.rs", "cins.rs", "istinomer.rs",
	"tanjug.rs", "beta.rs", "fonet.rs", "b92.net", "rtv.rs", "blic.rs", "politika.rs", "novosti.rs", "kurir.rs", "mondo.rs", "telegraf.rs", "nin.rs",
	"nedeljnik.rs", "euronews.rs", "ekapija.com", "biznis.rs", "bloombergadria.com", "novaekonomija.rs", "slobodnaevropa.org", "balkans.aljazeera.net",
	"balkaninsight.com", "dnevnik.rs", "glas-javnosti.rs", "cenzolovka.rs",
]
export const MIN_ESTABLISHED = 5

const hostOfUrl = (url: string): string => {
	try {
		return new URL(url).hostname.replace(/^www\./, "").toLowerCase()
	} catch {
		return ""
	}
}

export function isEstablishedOutlet(item: { outlet: string; url: string }): boolean {
	const host = hostOfUrl(item.url)
	if (host && ESTABLISHED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return true
	// a Google News link that could not be resolved has no host to judge: the outlet name decides
	return isOriginalOutlet(item.outlet)
}

export function preferEstablished<T extends { outlet: string; url: string }>(items: T[]): T[] {
	const known = items.filter(isEstablishedOutlet)
	return known.length >= MIN_ESTABLISHED ? known : items
}

/** "raspadsistema.com (Danas)" (older cache files) is just "Danas". */
export function cleanOutlet(outlet: string): string {
	return outlet.replace(/^raspadsistema\.com \((.+)\)$/i, "$1")
}

function tidyItem(i: NewsItem): NewsItem {
	const outlet = cleanOutlet(i.outlet)
	const publishedAt = notFuture(i.publishedAt)
	if (outlet === i.outlet && publishedAt === i.publishedAt && !/^raspadsistema\.com \(/i.test(i.source.title)) return i
	return { ...i, outlet, publishedAt, source: { ...i.source, publishedAt: notFuture(i.source.publishedAt), title: i.source.title.replace(/^raspadsistema\.com \((.+?)\):/i, "$1:") } }
}

export async function searchNews(query: string, opts: NewsSearchOptions = {}): Promise<NewsItem[]> {
	const days = opts.days ?? 30
	const limit = opts.limit ?? 60
	const kind = opts.kind ?? "topic"
	const aliases = unique(opts.aliases ?? [])
	const context = unique(opts.context ?? [])
	const exclude = unique(opts.exclude ?? [])
	const key = cacheKey("search", query, kind, `d${days}`, `l${limit}`, aliases.length ? `a-${aliases.join(" ")}` : "", context.length ? `c-${context.join(" ")}` : "", exclude.length ? `x-${exclude.join(" ")}` : "")
	const env = await cached<NewsItem[]>(SOURCE, key, () => liveSearch(query, kind, days, limit, aliases, context, exclude), {
		meta: { query, kind, days, limit, aliases, context, exclude },
		skipWrite: (d) => d.length === 0,
		activity: {
			source: searchSourceLabel(),
			kind: "vesti",
			action: "pretraga",
			label: `vesti: ${query.trim()} (${days} dana)`,
			url: `https://news.google.com/search?q=${encodeURIComponent(query.trim())}&hl=sr&gl=RS&ceid=RS:sr`,
			after: (d, h) => h.items(d.length),
		},
	})
	return preferEstablished(env.data.map(tidyItem))
}

// ── article text ────────────────────────────────────────────────────────────

const OUTLET_NAMES: Record<string, string> = {
	"n1info.rs": "N1", "danas.rs": "Danas", "nova.rs": "Nova.rs", "vreme.com": "Vreme", "insajder.net": "Insajder", "021.rs": "021.rs",
	"rts.rs": "RTS", "juznevesti.com": "Južne vesti", "raspadsistema.com": "raspadsistema.com", "tanjug.rs": "Tanjug", "krik.rs": "KRIK",
	"cins.rs": "CINS", "istinomer.rs": "Istinomer", "novaekonomija.rs": "Nova Ekonomija", "b92.net": "B92", "rtv.rs": "RTV",
}

function outletFromUrl(url: string): string {
	const host = new URL(url).hostname.replace(/^www\./, "")
	return OUTLET_NAMES[host] ?? host
}

function hostOutlet(url: string): string {
	try {
		return outletFromUrl(url)
	} catch {
		return "članak"
	}
}

function shortTitle(title: string): string {
	return clipWords(title, 70)
}

function metaContent(html: string, names: string[]): string | undefined {
	const content = String.raw`content=(?:"([^"]*)"|'([^']*)')`
	for (const n of names) {
		const key = String.raw`(?:property|name|itemprop)=["']${n}["']`
		const a = new RegExp(`<meta[^>]+${key}[^>]*?${content}`, "i").exec(html)
		const b = new RegExp(`<meta[^>]+${content}[^>]*?${key}`, "i").exec(html)
		const v = a?.[1] ?? a?.[2] ?? b?.[1] ?? b?.[2]
		if (v) return decodeEntities(v).trim()
	}
	return undefined
}
function jsonLdNodes(html: string): any[] {
	const out: any[] = []
	const walk = (n: any) => {
		if (!n || typeof n !== "object") return
		if (Array.isArray(n)) return n.forEach(walk)
		out.push(n)
		if (n["@graph"]) walk(n["@graph"])
	}
	for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
		try {
			walk(JSON.parse(m[1].trim()))
		} catch {
			// ignore malformed JSON-LD
		}
	}
	return out
}

const BOILERPLATE = /^(pratite nas|pročitajte i|procitajte i|pogledajte i|foto:|izvor:|podeli|facebook|twitter|komentari|copyright|©|pretplati|prijavi|ostavite komentar|tagovi|povezane vesti|pročitaj|procitaj|video:|snimak:|\(foto|\(video|saznajte|ukoliko želite|newsletter)/i

function paragraphs(html: string): string[] {
	const cleaned = html
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<(script|style|noscript|svg|iframe|form|nav|aside|button|footer|figure|figcaption|select|template)\b[\s\S]*?<\/\1>/gi, " ")
	const out: string[] = []
	for (const m of cleaned.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
		const t = plain(m[1])
		if (t.length < 40 || BOILERPLATE.test(t) || out[out.length - 1] === t) continue
		out.push(t)
	}
	return out
}

function mainText(html: string, ld: any[]): string {
	const body = html.replace(/^[\s\S]*?<body[^>]*>/i, "")
	const articles = [...body.matchAll(/<article\b[\s\S]*?<\/article>/gi)].map((m) => paragraphs(m[0]).join("\n\n"))
	let best = articles.sort((a, b) => b.length - a.length)[0] ?? ""
	if (best.length < 300) {
		const container = body.match(/<(div|section|main)\b[^>]+(?:class|id)=["'][^"']*(?:article|content|entry|post|single|story|text-body|vest)[^"']*["'][\s\S]*/i)?.[0] ?? body
		const alt = paragraphs(container).join("\n\n")
		if (alt.length > best.length) best = alt
	}
	if (best.length < 200) {
		const body2 = ld.map((n) => n.articleBody).find((b) => typeof b === "string" && b.length > 200)
		if (body2) best = plain(body2)
	}
	if (best.length > MAX_ARTICLE_CHARS) {
		const cut = best.slice(0, MAX_ARTICLE_CHARS)
		const at = cut.lastIndexOf("\n\n")
		best = (at > MAX_ARTICLE_CHARS * 0.6 ? cut.slice(0, at) : cut).trim()
	}
	return best
}

/** Downloads an article page and extracts title, date, outlet and main text (max 6000 chars). Google News links are resolved first. Not cached. */
async function extractArticle(url: string, fetchOpts: { timeoutMs?: number; retries?: number } = {}): Promise<ArticleText> {
	const finalUrl = await resolveGoogleNewsUrl(url)
	const html = await getText(finalUrl, { timeoutMs: fetchOpts.timeoutMs ?? 25000, retries: fetchOpts.retries ?? 1, headers: { Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5" } })
	const ld = jsonLdNodes(html)
	const ldArticle = ld.find((n) => /Article|NewsArticle|Report/i.test(String(n["@type"])) && (n.datePublished || n.headline)) ?? ld.find((n) => n.datePublished)

	const rawTitle =
		metaContent(html, ["og:title", "twitter:title"]) ?? (typeof ldArticle?.headline === "string" ? ldArticle.headline : undefined) ??
		plain(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "")
	const siteName = metaContent(html, ["og:site_name", "application-name"])
	const outlet = OUTLET_NAMES[new URL(finalUrl).hostname.replace(/^www\./, "")] ?? siteName ?? outletFromUrl(finalUrl)
	const title = decodeEntities(rawTitle).replace(new RegExp(`\\s*[|–—-]\\s*(${[outlet, siteName].filter(Boolean).map((s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\s*$`, "i"), "").trim()

	const published =
		metaContent(html, ["article:published_time", "og:article:published_time", "datePublished", "pubdate", "publishdate", "DC.date.issued", "date"]) ??
		(typeof ldArticle?.datePublished === "string" ? ldArticle.datePublished : undefined) ??
		html.match(/<time\b[^>]+datetime=["']([^"']+)["']/i)?.[1]
	const publishedAt = toIso(published) ?? published?.slice(0, 10)

	const text = mainText(html, ld)
	if (text.length < 80) throw new Error(`fetchArticle: no article text extracted from ${finalUrl}`)
	return {
		url: finalUrl,
		title,
		outlet,
		publishedAt,
		text,
		source: { kind: "vesti", title: clipWords(`${outlet}: ${title}`, 200), url: finalUrl, retrievedAt: new Date().toISOString(), publishedAt, official: false },
	}
}

/**
 * Does the article at `url` name the subject (any of `names`: all distinctive tokens, in order, case endings allowed)?
 * In DATA_MODE=cache only an article that is already cached can be read (nothing is fetched and no request is shown); an article
 * that cannot be read is "no", never a guess.
 */
export async function articleNamesSubject(url: string, names: string[]): Promise<boolean> {
	try {
		const article = getDataMode(SOURCE) === "cache" ? (await readCache<ArticleText>(SOURCE, cacheKey("article", url)))?.data : await fetchArticle(url)
		if (!article) return false
		const matcher = buildMatcher({ kind: "institution", names })
		return matcher.subject(wordsOf(`${article.title} . ${article.text}`))
	} catch {
		return false
	}
}

/** Cached `extractArticle`: the text the agents read for a claim. */
export async function fetchArticle(url: string): Promise<ArticleText> {
	const env = await cached<ArticleText>(SOURCE, cacheKey("article", url), () => extractArticle(url), {
		activity: {
			source: hostOutlet(url),
			kind: "vesti",
			action: "dokument",
			label: `članak: ${hostOutlet(url)}`,
			url,
			after: (d, h) => h.label(`članak: ${cyrToLat(d.outlet)} – ${cyrToLat(shortTitle(d.title))}`),
		},
	})
	const publishedAt = notFuture(env.data.publishedAt)
	return publishedAt === env.data.publishedAt ? env.data : { ...env.data, publishedAt, source: { ...env.data.source, publishedAt } }
}
