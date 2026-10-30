// Precision rules of the news search, kept free of network code so they are easy to test:
//  - an institution article must name the institution (all distinctive tokens, in order, inflection-aware) or one of its aliases;
//  - a person article must name the full name AND the institution / firm it is about;
//  - occurrences inside a longer institution name do not count ("Infrastruktura železnice Srbije" is not "Železnice Srbije");
//  - near-identical titles are one story; aggregator copies lose against the original outlet.

import { asciiFold, normalizeName, sameWord } from "./translit"
import { FORMS, plural } from "../shared/plural"
import type { NewsItem } from "./types"

export type SubjectKind = "institution" | "person" | "topic"

const STOP = new Set(["ad", "doo", "jp", "pd", "od", "kd", "za", "na", "u", "i", "o", "po", "sa", "iz", "do", "the", "of"])

export function wordsOf(text: string): string[] {
	return asciiFold(text).replace(/[^a-z0-9]+/g, " ").split(" ").filter(Boolean)
}

/** Distinctive tokens of a name, in order: legal forms, cities and one-letter initials are dropped. */
export function nameTokens(name: string, opts: { person?: boolean } = {}): string[] {
	const folded = opts.person ? asciiFold(name) : asciiFold(normalizeName(name) || name)
	const tokens = folded.replace(/[^a-z0-9]+/g, " ").split(" ").filter((t) => t.length > 1 && !STOP.has(t))
	return [...new Set(tokens)]
}

/** Start/end word index of the tokens appearing in order, with at most `gap` filler words between neighbours. */
export function findOrdered(ws: string[], tokens: string[], gap = 0, from = 0): [number, number] | null {
	if (tokens.length === 0) return null
	for (let i = from; i < ws.length; i++) {
		if (!sameWord(tokens[0], ws[i])) continue
		let pos = i
		let ok = true
		for (let k = 1; k < tokens.length && ok; k++) {
			let found = -1
			for (let g = 1; g <= 1 + gap && pos + g < ws.length; g++) {
				if (sameWord(tokens[k], ws[pos + g])) {
					found = pos + g
					break
				}
			}
			if (found < 0) ok = false
			else pos = found
		}
		if (ok) return [i, pos]
	}
	return null
}

/** All tokens within a window of words, in any order ("Jevtić Zoran", "Zoran Jevtića"). */
export function findUnordered(ws: string[], tokens: string[], window: number): boolean {
	if (tokens.length === 0) return false
	for (let i = 0; i < ws.length; i++) {
		if (!tokens.some((t) => sameWord(t, ws[i]))) continue
		const covered = new Set<number>()
		for (let j = i; j < Math.min(ws.length, i + window); j++) tokens.forEach((t, k) => sameWord(t, ws[j]) && covered.add(k))
		if (covered.size === tokens.length) return true
	}
	return false
}

export interface MatchSpec {
	kind: SubjectKind
	/** main name first, then aliases ("IŽS", "Srbija voz") */
	names: string[]
	/** person: institution / firm names; at least one must be named as well */
	context?: string[]
	/** longer names that contain the subject name; occurrences inside them are ignored */
	exclude?: string[]
}

export interface Matcher {
	spec: MatchSpec
	/** words of the title + snippet (or an article text) name the subject */
	subject(ws: string[]): boolean
	/** words name the institution / firm the person must be tied to (always true for other kinds) */
	context(ws: string[]): boolean
	/** the main name's distinctive tokens, for diagnostics */
	tokens: string[]
}

export function buildMatcher(spec: MatchSpec): Matcher {
	const person = spec.kind === "person"
	const names = spec.names.map((n) => nameTokens(n, { person })).filter((t) => t.length > 0)
	const contexts = (spec.context ?? []).map((n) => nameTokens(n)).filter((t) => t.length > 0)
	const exclusions = (spec.exclude ?? []).map((n) => nameTokens(n)).filter((t) => t.length > 1)

	const masked = (ws: string[]): string[] => {
		if (exclusions.length === 0) return ws
		const out = [...ws]
		for (const ex of exclusions) {
			let from = 0
			for (;;) {
				const hit = findOrdered(out, ex, 1, from)
				if (!hit) break
				for (let i = hit[0]; i <= hit[1]; i++) out[i] = "_"
				from = hit[1] + 1
			}
		}
		return out
	}

	const gapFor = (tokens: string[]) => (tokens.length >= 3 ? 1 : 0)
	const subject = (ws: string[]): boolean => {
		const w = masked(ws)
		if (spec.kind === "person") return names.some((t) => findUnordered(w, t, t.length + 1))
		if (spec.kind === "institution") return names.some((t) => !!findOrdered(w, t, gapFor(t)))
		// topic: every token of the (single) query somewhere in the text
		return names.some((t) => t.every((tok) => w.some((x) => sameWord(tok, x))))
	}
	const context = (ws: string[]): boolean => {
		if (spec.kind !== "person" || contexts.length === 0) return true
		const w = masked(ws)
		return contexts.some((t) => !!findOrdered(w, t, gapFor(t)) || (t.length > 1 && findUnordered(w, t, t.length + 2)))
	}
	return { spec, subject, context, tokens: names[0] ?? [] }
}

// ── noise ───────────────────────────────────────────────────────────────────

/** Sports and obituary headlines: a person's namesake is far more likely there than the official. */
const NOISE = /\b(preminu\w*|in memoriam|komemorativ\w*|osmrtnic\w*|sahran\w*|fudbal\w*|futsal\w*|kosark\w*|rukomet\w*|odbojk\w*|utakmic\w*|prvenstv\w*|golman\w*|trener\w*)\b/

export function isNoiseTitle(title: string): boolean {
	return NOISE.test(asciiFold(title))
}

// ── urls, titles, outlets ───────────────────────────────────────────────────

export function normalizeUrl(raw: string): string {
	try {
		const u = new URL(raw)
		const keep = [...u.searchParams.entries()].filter(([k]) => !/^(utm_|fbclid|gclid|ref|source|amp)/i.test(k))
		const q = keep.length ? "?" + keep.map(([k, v]) => `${k}=${v}`).join("&") : ""
		return (u.hostname.replace(/^(www|m|amp)\./, "") + u.pathname.replace(/\/(amp\/?)?$/, "").replace(/\/+$/, "") + q).toLowerCase()
	} catch {
		return raw.toLowerCase()
	}
}

export function titleKey(title: string): string {
	return asciiFold(title).replace(/\s+-\s+[^-]+$/, "").replace(/[^a-z0-9]+/g, " ").trim()
}

export function titleSimilar(a: string, b: string): boolean {
	const ta = new Set(titleKey(a).split(" ").filter((t) => t.length > 2))
	const tb = new Set(titleKey(b).split(" ").filter((t) => t.length > 2))
	if (ta.size < 3 || tb.size < 3) return titleKey(a) === titleKey(b)
	let inter = 0
	for (const t of ta) if (tb.has(t)) inter++
	return inter / Math.min(ta.size, tb.size) >= 0.85 && inter / Math.max(ta.size, tb.size) >= 0.7
}

const foldOutlet = (s: string) => asciiFold(s).replace(/[^a-z0-9]+/g, "")

export function sameOutlet(a: string, b: string): boolean {
	return foldOutlet(a) === foldOutlet(b)
}

export function closeInTime(a?: string, b?: string, days = 4): boolean {
	return !a || !b || Math.abs(Date.parse(a) - Date.parse(b)) <= days * 86400e3
}

const AGGREGATORS = ["googlenews", "msn", "newsbreak", "yahoo", "flipboard", "groundnews", "pressreader", "bing", "smartnews", "dailyhunt", "newsnow", "naslovinet", "naslovi"]
const AGGREGATOR_HOSTS = /(^|\.)(news\.google\.com|msn\.com|newsbreak\.com|yahoo\.com|flipboard\.com|ground\.news|pressreader\.com|bing\.com|smartnews\.com|newsnow\.co\.uk|naslovi\.net)$/

export function isAggregator(outlet: string, url: string): boolean {
	if (AGGREGATORS.includes(foldOutlet(outlet))) return true
	try {
		return AGGREGATOR_HOSTS.test(new URL(url).hostname)
	} catch {
		return false
	}
}

/** Outlets that publish their own reporting (or the wire copy first): preferred when several outlets carry one story. */
const ORIGINALS = new Set(
	["N1", "Danas", "Nova.rs", "Nova", "Vreme", "Insajder", "021.rs", "RTS", "Južne vesti", "KRIK", "CINS", "Istinomer", "Nova Ekonomija", "B92", "RTV", "Tanjug", "Beta", "Blic", "Kurir", "Politika", "Novosti", "Večernje novosti", "Mondo", "Telegraf", "NIN", "Radar", "Glas javnosti", "Nedeljnik", "Forbes Srbija", "Euronews Srbija", "eKapija", "Biznis.rs", "Bloomberg Adria", "Radio Slobodna Evropa", "Slobodna Evropa", "Al Jazeera Balkans", "BIRN", "Balkan Insight", "Politika Online", "Dnevnik", "Radio-televizija Vojvodine", "RTV Vojvodina", "Juzne vesti", "JuGmedia", "Infoera"].map(foldOutlet),
)

export function isOriginalOutlet(outlet: string): boolean {
	return ORIGINALS.has(foldOutlet(outlet))
}

/** Within one story: original outlet > anything but an aggregator > earliest publication > longer snippet. */
function betterCopy(a: NewsItem, b: NewsItem): NewsItem {
	const rank = (i: NewsItem) => (isAggregator(i.outlet, i.url) ? 0 : isOriginalOutlet(i.outlet) ? 2 : 1)
	if (rank(a) !== rank(b)) return rank(a) > rank(b) ? a : b
	if (a.publishedAt && b.publishedAt && a.publishedAt !== b.publishedAt) return a.publishedAt < b.publishedAt ? a : b
	return (a.snippet?.length ?? 0) >= (b.snippet?.length ?? 0) ? a : b
}

/**
 * Drops repeats of one story: the same outlet repeating a title, and aggregator copies of a story an original outlet carries.
 * The same wire story in two different (non-aggregator) outlets stays: they are independent sources for the status.
 */
export function dropRepeats(items: NewsItem[]): NewsItem[] {
	const kept: NewsItem[] = []
	const seenUrl = new Map<string, number>()
	for (const item of items) {
		const key = normalizeUrl(item.url)
		const at = seenUrl.get(key)
		if (at !== undefined) {
			kept[at] = betterCopy(kept[at], item)
			continue
		}
		const idx = kept.findIndex(
			(k) => titleSimilar(k.title, item.title) && closeInTime(k.publishedAt, item.publishedAt) && (sameOutlet(k.outlet, item.outlet) || isAggregator(k.outlet, k.url) || isAggregator(item.outlet, item.url)),
		)
		if (idx >= 0) {
			kept[idx] = betterCopy(kept[idx], item)
			seenUrl.set(normalizeUrl(kept[idx].url), idx)
			continue
		}
		seenUrl.set(key, kept.length)
		kept.push(item)
	}
	return kept
}

// ── overview ("Pregled medija") ─────────────────────────────────────────────

const TOPICS: [string, RegExp][] = [
	["nesreće i bezbednost", /nesre[cć]|udes|iskliz|pogin|povre[dđ]|po[zž]ar|bezbednost|sudar|stradal/],
	["javne nabavke i ugovori", /ugovor|nabavk|tender|miliona|milijard|dinara|dodel|anex|aneks/],
	["rukovodstvo i kadrovska rešenja", /direktor|ostavk|imenovan|smen[ae]|razre[sš]en|v\.? ?d\.? |vr[sš]ilac|upravni odbor|nadzorni odbor/],
	["radovi i izgradnja", /pruga|pruge|prugu|rekonstrukcij|radovi|izgradnj|deonic|autoput|obilaznic|\bmost\w*|tunel|brza pruga|stanic/],
	["sindikat i zaposleni", /sindikat|[sš]trajk|radnic|zaposlen|zarad|plat[ae]|otpu[sš]t/],
	["saobraćaj i vozovi", /\bvoz\w*|red vo[zž]nje|putni[ck]|kasnjenj|karta|karte|saobra[cć]aj|prevoz|teretn|kargo|naplat|putarin/],
	["revizija i istrage", /revizij|tu[zž]ila[sš]t|istrag|nadzor|kontrol|krivi[cč]n|policij|uhap[sš]/],
	["finansije i budžet", /bud[zž]et|kredit|subvencij|finansir|gubitak|dug|zadu[zž]/],
]

export function topicsOf(titles: string[], max = 3): string[] {
	const counts = TOPICS.map(([label, re]) => ({ label, n: titles.filter((t) => re.test(asciiFold(t))).length }))
	const minimum = titles.length >= 6 ? 2 : 1
	return counts
		.filter((c) => c.n >= minimum)
		.sort((a, b) => b.n - a.n)
		.slice(0, max)
		.map((c) => c.label)
}

export function windowLabel(days: number): string {
	if (days <= 400) {
		const months = Math.max(1, Math.round(days / 30.4))
		return `poslednjih ${months} ${plural(months, FORMS.mesec)}`
	}
	const years = Math.max(1, Math.round(days / 365))
	return years === 1 ? "poslednju godinu" : `poslednje ${years} ${plural(years, FORMS.godina)}`
}

export interface NewsOverview {
	total: number
	days: number
	topics: string[]
	/** the most relevant distinct articles (one per story, at most two per outlet) */
	items: NewsItem[]
}

/** The `max` most relevant distinct articles: relevance, then recency; repeated stories and over-represented outlets are skipped. */
export function newsOverview(items: NewsItem[], days: number, max = 12): NewsOverview {
	const usable = items.filter((i) => !i.unresolved)
	const ranked = [...usable].sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""))
	const picked: NewsItem[] = []
	const perOutlet = new Map<string, number>()
	for (const i of ranked) {
		if (picked.length >= max) break
		if (picked.some((p) => titleSimilar(p.title, i.title))) continue
		const o = foldOutlet(i.outlet)
		if ((perOutlet.get(o) ?? 0) >= 2) continue
		perOutlet.set(o, (perOutlet.get(o) ?? 0) + 1)
		picked.push(i)
	}
	const distinct = dropStories(usable)
	return { total: distinct.length, days, topics: topicsOf(distinct.map((i) => i.title)), items: picked.sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "")) }
}

/** One representative per story (title similarity across outlets), used for counting "N članaka". */
function dropStories(items: NewsItem[]): NewsItem[] {
	const out: NewsItem[] = []
	for (const i of items) if (!out.some((p) => titleSimilar(p.title, i.title) && closeInTime(p.publishedAt, i.publishedAt, 7))) out.push(i)
	return out
}
