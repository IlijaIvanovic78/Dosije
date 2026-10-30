// News search and article text. Free providers are always on: outlet RSS feeds (+ raspadsistema.com data.json),
// Google News RSS and GDELT DOC 2.0. Serper.dev (SERPER_API_KEY) and Brave Search News (BRAVE_API_KEY) are optional
// and skipped silently without a key. Results are merged, deduplicated and filtered for relevance.
// Only the final merged result / the extracted article is cached (feeds change all the time, so they are never cached on their own).

import crypto from "node:crypto"
import { XMLParser } from "fast-xml-parser"
import { trackActivity, type ActivityDescriptor } from "../activity"
import { cached, cacheKey } from "../cache"
import { getText, httpRequest } from "../http"
import { asciiFold, cyrToLat, hasCyrillic, latToCyr, normalizeName, sameWord } from "../translit"
import type { ArticleText, NewsItem } from "../types"

const SOURCE = "vesti"
const MAX_ARTICLE_CHARS = 6000

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

const STOP = new Set(["ad", "doo", "jp", "pd", "od", "kd", "za", "na", "u", "i", "o", "po", "sa", "iz", "od", "do", "the", "of"])

function queryTokens(query: string): string[] {
	const folded = asciiFold(normalizeName(query) || query).replace(/[^a-z0-9]+/g, " ")
	return [...new Set(folded.split(" ").filter((t) => t.length > 1 && !STOP.has(t)))]
}

// inflected forms match ("jevtića" ~ "jevtić"); other words sharing a prefix do not ("srbije" !~ "srbijavoz")
function tokenHit(token: string, words: string[]): boolean {
	return words.some((w) => sameWord(token, w))
}

function matchedTokens(text: string, tokens: string[]): string[] {
	const words = asciiFold(text).replace(/[^a-z0-9]+/g, " ").split(" ").filter(Boolean)
	return tokens.filter((t) => tokenHit(t, words))
}

function requiredHits(n: number, engine: boolean): number {
	if (engine) return n <= 2 ? 1 : Math.ceil(n * 0.5)
	return n <= 3 ? n : Math.ceil(n * 0.6)
}

// outlet feeds are unfiltered, so every token must match; search engines already matched the query on the full text,
// so a partial match is accepted only if it contains the longest (most distinctive) query token
function enough(item: NewsItem, tokens: string[]): boolean {
	const engine = !item.provider.startsWith("rss:")
	if (item.matched.length < requiredHits(tokens.length, engine)) return false
	if (!engine || item.matched.length === tokens.length) return true
	const longest = [...tokens].sort((a, b) => b.length - a.length)[0]
	return item.matched.includes(longest)
}

function normalizeUrl(raw: string): string {
	try {
		const u = new URL(raw)
		const keep = [...u.searchParams.entries()].filter(([k]) => !/^(utm_|fbclid|gclid|ref|source|amp)/i.test(k))
		const q = keep.length ? "?" + keep.map(([k, v]) => `${k}=${v}`).join("&") : ""
		return (u.hostname.replace(/^(www|m|amp)\./, "") + u.pathname.replace(/\/(amp\/?)?$/, "").replace(/\/+$/, "") + q).toLowerCase()
	} catch {
		return raw.toLowerCase()
	}
}

function titleKey(title: string): string {
	return asciiFold(title).replace(/\s+-\s+[^-]+$/, "").replace(/[^a-z0-9]+/g, " ").trim()
}

function titleSimilar(a: string, b: string): boolean {
	const ta = new Set(titleKey(a).split(" ").filter((t) => t.length > 2))
	const tb = new Set(titleKey(b).split(" ").filter((t) => t.length > 2))
	if (ta.size < 3 || tb.size < 3) return titleKey(a) === titleKey(b)
	let inter = 0
	for (const t of ta) if (tb.has(t)) inter++
	return inter / Math.min(ta.size, tb.size) >= 0.85 && inter / Math.max(ta.size, tb.size) >= 0.7
}

function sameOutlet(a: string, b: string): boolean {
	return asciiFold(a).replace(/[^a-z0-9]+/g, "") === asciiFold(b).replace(/[^a-z0-9]+/g, "")
}

function closeInTime(a?: string, b?: string): boolean {
	return !a || !b || Math.abs(Date.parse(a) - Date.parse(b)) <= 4 * 86400e3
}

function toIso(s: string | undefined): string | undefined {
	if (!s) return undefined
	const t = Date.parse(s)
	return Number.isNaN(t) ? undefined : new Date(t).toISOString()
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

function makeItem(
	p: { title: string; url: string; outlet: string; publishedAt?: string; snippet?: string; provider: string },
	tokens: string[],
	retrievedAt: string,
): NewsItem {
	const title = plain(p.title).replace(/^[:\-–—\s]+/, "")
	const snippet = p.snippet ? plain(p.snippet).slice(0, 400) : undefined
	return {
		id: crypto.createHash("sha1").update(normalizeUrl(p.url)).digest("hex").slice(0, 12),
		title,
		url: p.url,
		outlet: p.outlet,
		publishedAt: p.publishedAt,
		snippet: snippet || undefined,
		matched: matchedTokens(`${title} ${snippet ?? ""}`, tokens),
		provider: p.provider,
		source: { kind: "vesti", title: `${p.outlet}: ${title}`.slice(0, 200), url: p.url, retrievedAt, publishedAt: p.publishedAt, official: false },
	}
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
			outlet: x.src ? `raspadsistema.com (${x.src})` : "raspadsistema.com",
			publishedAt: toIso(x.t),
			snippet: [x.body, x.role && `Funkcija: ${x.role}`].filter(Boolean).join(" "),
			provider: "rss:raspadsistema",
		}))
}

// ── provider: Google News RSS ───────────────────────────────────────────────

function engineQuery(query: string, tokens: string[]): string {
	return tokens.length <= 3 ? `"${query.trim()}"` : query.trim()
}

async function fetchGoogleNews(q: string, days: number, hl: string): Promise<RawItem[]> {
	const url = `https://news.google.com/rss/search?q=${encodeURIComponent(`${q} when:${Math.max(1, Math.round(days))}d`)}&hl=${hl}&gl=RS&ceid=RS:${hl}`
	const doc: any = xml.parse(await getText(url, { timeoutMs: 25000, retries: 1 }))
	return arr<any>(doc?.rss?.channel?.item).map((i) => {
		const outlet = txt(i.source) || "Google News"
		const title = txt(i.title).replace(new RegExp(`\\s+-\\s+${outlet.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), "")
		return { title, url: txt(i.link).trim(), outlet, publishedAt: toIso(txt(i.pubDate)), provider: "google-news-rss" }
	})
}

const gnCache = new Map<string, string>()

/** Google News article links are opaque; resolve through the same endpoint the news.google.com page uses. */
async function resolveGoogleNewsUrl(link: string): Promise<string> {
	if (!/^https?:\/\/news\.google\.com\/(rss\/)?articles\//.test(link)) return link
	const hit = gnCache.get(link)
	if (hit) return hit
	try {
		const id = new URL(link).pathname.split("/").pop()!
		const page = (await httpRequest(`https://news.google.com/rss/articles/${id}?hl=sr&gl=RS&ceid=RS:sr`, { timeoutMs: 20000, retries: 1 })).text()
		const sg = page.match(/data-n-a-sg="([^"]+)"/)?.[1]
		const ts = page.match(/data-n-a-ts="([^"]+)"/)?.[1]
		if (!sg || !ts) return link
		const inner = JSON.stringify(["garturlreq", [["X", "X", ["X", "X"], null, null, 1, 1, "US:en", null, 1, null, null, null, null, null, 0, 1], "X", "X", 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0], id, Number(ts), sg])
		const res = await httpRequest("https://news.google.com/_/DotsSplashUi/data/batchexecute", {
			method: "POST",
			body: "f.req=" + encodeURIComponent(JSON.stringify([[["Fbv4je", inner, null, "generic"]]])),
			headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
			timeoutMs: 20000,
			retries: 1,
		})
		const m = res.text().match(/garturlres\\",\\"(https?:[^"\\]+)/)
		if (m) {
			gnCache.set(link, m[1])
			return m[1]
		}
	} catch {
		// keep the Google link
	}
	return link
}

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
		`https://api.search.brave.com/res/v1/news/search?q=${encodeURIComponent(q)}&country=rs&search_lang=sr&count=20` +
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

const PROVIDER_RANK = (p: string) => (p.startsWith("rss:") ? 0 : p === "serper" || p === "brave" ? 1 : p === "google-news-rss" ? 2 : 3)

export async function searchNews(query: string, opts: { days?: number; limit?: number } = {}): Promise<NewsItem[]> {
	const days = opts.days ?? 30
	const limit = opts.limit ?? 25
	const env = await cached<NewsItem[]>(SOURCE, cacheKey("search", query, `d${days}`, `l${limit}`), async () => {
		const tokens = queryTokens(query)
		if (tokens.length === 0) return []
		const lat = hasCyrillic(query) ? cyrToLat(query) : query
		const cyr = hasCyrillic(query) ? query : latToCyr(query)
		const variants = [...new Set([lat, cyr])]
		const retrievedAt = new Date().toISOString()
		const cutoff = Date.now() - days * 86400e3

		const jobs: Promise<RawItem[]>[] = []
		const labels: string[] = []
		const job = (label: string, p: Promise<RawItem[]>) => {
			labels.push(label)
			jobs.push(p)
		}
		const what = query.trim()
		for (const feed of FEEDS) job(feed.provider, tracked({ source: `${feed.outlet} (RSS)`, action: "preuzimanje", label: `feed: ${what}`, url: feed.url }, () => fetchFeed(feed)))
		job("rss:raspadsistema", tracked({ source: "raspadsistema.com", action: "preuzimanje", label: `feed: ${what}`, url: "https://raspadsistema.com/" }, fetchRaspadSistema))
		for (const v of variants) {
			const gnUrl = `https://news.google.com/search?q=${encodeURIComponent(`${engineQuery(v, tokens)} when:${Math.max(1, Math.round(days))}d`)}&hl=sr&gl=RS&ceid=RS:sr`
			job(`google-news-rss(${hasCyrillic(v) ? "cyr" : "lat"})`, tracked({ source: "Google News", action: "pretraga", label: variantLabel(v), url: gnUrl }, () => fetchGoogleNews(engineQuery(v, tokens), days, "sr")))
		}
		job(
			"gdelt",
			(async () => {
				const out: RawItem[] = []
				// GDELT is best effort: it rate-limits to one request per 5 s (often 429), so the whole provider gets a time budget
				const work = (async () => {
					for (const v of variants) {
						out.push(...(await tracked({ source: "GDELT", action: "pretraga", label: variantLabel(v) }, () => fetchGdelt(tokens.length <= 3 ? `"${v}"` : v, days)).catch(() => [])))
					}
				})()
				await Promise.race([work, new Promise((r) => setTimeout(r, 16000))])
				return out
			})(),
		)
		if (process.env.SERPER_API_KEY) for (const v of variants) job("serper", tracked({ source: "Serper", action: "pretraga", label: variantLabel(v) }, () => fetchSerper(v, days)))
		if (process.env.BRAVE_API_KEY) for (const v of variants) job("brave", tracked({ source: "Brave", action: "pretraga", label: variantLabel(v) }, () => fetchBrave(v, days)))

		const settled = await Promise.allSettled(jobs)
		if (process.env.NEWS_DEBUG) settled.forEach((r, i) => console.error(`  [news] ${labels[i]}: ${r.status === "fulfilled" ? `${r.value.length} items` : `FAILED ${String(r.reason).slice(0, 100)}`}`))
		const raw = settled.flatMap((r) => (r.status === "fulfilled" ? r.value : []))

		const relevant = raw
			.filter((r) => r.title && r.url && /^https?:/.test(r.url))
			.filter((r) => !r.publishedAt || Date.parse(r.publishedAt) >= cutoff)
			.map((r) => makeItem(r, tokens, retrievedAt))
			.filter((i) => enough(i, tokens))
			.sort((a, b) => PROVIDER_RANK(a.provider) - PROVIDER_RANK(b.provider) || (b.snippet?.length ?? 0) - (a.snippet?.length ?? 0))

		if (process.env.NEWS_DEBUG) console.error(`  [news] raw=${raw.length} relevant=${relevant.length}`)
		// resolve Google News redirect links only for what survives the relevance filter
		const resolved = await Promise.all(
			relevant.map(async (i) => {
				if (i.provider !== "google-news-rss") return i
				const url = await resolveGoogleNewsUrl(i.url)
				return url === i.url ? i : { ...i, id: crypto.createHash("sha1").update(normalizeUrl(url)).digest("hex").slice(0, 12), url, source: { ...i.source, url } }
			}),
		)

		const kept: NewsItem[] = []
		const seen = new Set<string>()
		for (const i of resolved.sort((a, b) => PROVIDER_RANK(a.provider) - PROVIDER_RANK(b.provider) || (b.snippet?.length ?? 0) - (a.snippet?.length ?? 0))) {
			const key = normalizeUrl(i.url)
			if (seen.has(key)) continue
			// the same story from different outlets is kept (independent sources); only the same outlet repeating a title is merged
			const dup = kept.find((k) => titleSimilar(k.title, i.title) && sameOutlet(k.outlet, i.outlet) && closeInTime(k.publishedAt, i.publishedAt))
			if (dup) continue
			seen.add(key)
			kept.push(i)
		}
		return kept.sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "")).slice(0, limit)
	}, {
		activity: {
			source: searchSourceLabel(),
			kind: "vesti",
			action: "pretraga",
			label: `vesti: ${query.trim()} (${days} dana)`,
			url: `https://news.google.com/search?q=${encodeURIComponent(query.trim())}&hl=sr&gl=RS&ceid=RS:sr`,
			after: (d, h) => h.items(d.length),
		},
	})
	return env.data
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
	const t = title.replace(/\s+/g, " ").trim()
	return t.length > 70 ? `${t.slice(0, 69).trimEnd()}…` : t
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

/** Fetches an article page and extracts title, date, outlet and main text (max 6000 chars). Google News links are resolved first. */
export async function fetchArticle(url: string): Promise<ArticleText> {
	const env = await cached<ArticleText>(SOURCE, cacheKey("article", url), async () => {
		const finalUrl = await resolveGoogleNewsUrl(url)
		const html = await getText(finalUrl, { timeoutMs: 25000, retries: 1, headers: { Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5" } })
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
			source: { kind: "vesti", title: `${outlet}: ${title}`.slice(0, 200), url: finalUrl, retrievedAt: new Date().toISOString(), publishedAt, official: false },
		}
	}, {
		activity: {
			source: hostOutlet(url),
			kind: "vesti",
			action: "dokument",
			label: `članak: ${hostOutlet(url)}`,
			url,
			after: (d, h) => h.label(`članak: ${cyrToLat(d.outlet)} – ${cyrToLat(shortTitle(d.title))}`),
		},
	})
	return env.data
}








