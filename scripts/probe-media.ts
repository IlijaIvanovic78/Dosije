// Live probe + cache warmer for the DRI and media adapters.
//   PowerShell:  $env:DATA_MODE="live"; npx.cmd tsx scripts/probe-media.ts     (refreshes data/cache/dri and data/cache/vesti)
//                $env:DATA_MODE="cache"; npx.cmd tsx scripts/probe-media.ts    (proves the offline path)

import { getReportFindings, getReports } from "../src/data/sources/dri"
import { availableProviders, fetchArticle, searchNews } from "../src/data/sources/news"
import { getDataMode } from "../src/data/cache"
import type { NewsItem } from "../src/data/types"

const INST = { name: "Infrastruktura železnice Srbije a.d.", nameCyr: "Инфраструктура железнице Србије а.д." }
const UNION_STRIKE_URL = "https://www.danas.rs/vesti/ekonomija/sindikat-nezavisnost-zahteva-ostavke-celnika-infrastrukture-zeleznice-srbije-u-roku-od-48-sati/"
const MAX_FINDINGS = 12

const short = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s)
const day = (s?: string) => (s ? s.slice(0, 10) : "?")

async function probeDri() {
	console.log("\n=== DRI ===")
	const reports = await getReports(INST)
	console.log(`reports: ${reports.length}`)
	// primary audits first, then response / post-audit reports, newest first
	const primary = (k?: string) => (/^(finansijska|revizija pravilnosti|revizija svrsishodnosti)/.test(k ?? "") ? 0 : 1)
	const ranked = [...reports].sort((a, b) => primary(a.kind) - primary(b.kind) || (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""))
	for (const r of ranked.slice(0, MAX_FINDINGS)) {
		try {
			const f = await getReportFindings(r)
			console.log(`- ${f.id} ${day(f.publishedAt)} [${f.year}] ${f.kind} | opinion: ${f.opinion ?? "-"} | excerpts: ${f.excerpts.length} | ${short(f.title, 90)}`)
			if (f.excerpts[0]) console.log(`    "${short(f.excerpts[0], 160)}"`)
		} catch (err) {
			console.log(`- ${r.id} ${r.kind}: FAILED ${String(err).slice(0, 120)}`)
		}
	}
	// the rest: warm the cache without printing (cache mode just reads)
	for (const r of ranked.slice(MAX_FINDINGS)) await getReportFindings(r).catch(() => undefined)
}

async function probeNews() {
	console.log("\n=== NEWS ===")
	console.log("providers:", availableProviders().join(", "))
	const queries: [string, number][] = [
		["Infrastruktura železnice Srbije", 90],
		["Zoran Jevtić", 730],
		["Jevtić Infrastruktura železnice generalni direktor", 730],
	]
	const results = new Map<string, NewsItem[]>()
	for (const [q, days] of queries) {
		const t0 = Date.now()
		const items = await searchNews(q, { days, limit: 25 })
		results.set(q, items)
		const byProvider: Record<string, number> = {}
		for (const i of items) byProvider[i.provider] = (byProvider[i.provider] ?? 0) + 1
		console.log(`\n"${q}" (${days} d): ${items.length} items in ${Date.now() - t0} ms ${JSON.stringify(byProvider)}`)
		for (const i of items.slice(0, 8)) console.log(`  ${day(i.publishedAt)} ${i.outlet} | ${short(i.title, 90)}`)
	}

	const all = new Map<string, NewsItem>()
	for (const items of results.values()) for (const i of items) all.set(i.url, i)
	const urls = new Map<string, string>()
	urls.set(UNION_STRIKE_URL, "(a) sindikat traži ostavke (raspadsistema.com -> Danas)")
	for (const i of all.values()) if (/novi generalni direktor|нови генерални директор|generalni direktor/i.test(i.title)) urls.set(i.url, "(b) 'generalni direktor'")
	for (const i of all.values()) if (/^(Direktor Infrastrukture|Директор Инфраструктуре)|imenovan za vršioca/i.test(i.title) && !urls.has(i.url)) urls.set(i.url, "(b) direktor / v.d. (2025)")
	// recent IŽS coverage; skip aggregators (naslovi.net), Cyrillic re-posts and Tanjug (answers 403 to our bot)
	const recent = results.get("Infrastruktura železnice Srbije")!.filter(
		(x) => /^2026-(08|09|10)/.test(x.publishedAt ?? "") && !/raspadsistema|naslovi|tanjug|dnevnik|nspm|KRIK/i.test(x.outlet) && /infrastruktur/i.test(x.title),
	)
	for (const i of recent) {
		if (!urls.has(i.url)) urls.set(i.url, "(c) nedavni IŽS")
	}
	for (const i of all.values()) if (/Hapšeni zbog mita|Ko je Zoran Jevtić/i.test(i.title) && !urls.has(i.url)) urls.set(i.url, "(c) kontekst")

	console.log("\n--- articles ---")
	for (const [url, label] of urls) {
		if (/tanjug\.rs/.test(url)) {
			console.log(`${label}\n  SKIP (tanjug.rs answers 403 to bots; the headline is in the search results) ${url}`)
			continue
		}
		try {
			const a = await fetchArticle(url)
			console.log(`${label}\n  ${day(a.publishedAt)} ${a.outlet} | ${short(a.title, 100)} | ${a.text.length} chars\n  ${a.url}`)
		} catch (err) {
			console.log(`${label}\n  FAILED ${url}\n  ${String(err).slice(0, 110).replace(/\s+/g, " ")}`)
		}
	}
}

console.log(`DATA_MODE=${getDataMode()}`)
await probeDri()
await probeNews()



