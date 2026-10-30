// DRI (Državna revizorska institucija, https://www.dri.rs): audit reports per auditee + PDF excerpts.
//
// How the site works (no JSON API is reachable: /audits/searchsubjects answers 403 to non-browser clients):
//  - https://www.dri.rs/izvestaji renders ALL ~2,000 auditees as checkbox filters (value = subject id, with a report counter);
//  - https://www.dri.rs/izvestaji?subjects=<id>[&page=N] lists that auditee's reports (20 per page, server-rendered HTML);
//  - https://www.dri.rs/izvestaj/<reportId> is the report page, which links the PDF under /storage/...
// getReports() maps the institution name to subject ids, then crawls the listing pages.
// getReportFindings() downloads the PDF, extracts text with unpdf and keeps a few verbatim excerpts (cached; the PDF is not).

import { extractText, getDocumentProxy } from "unpdf"
import { SRC, shortInstitution, trackActivity } from "../activity"
import { cached, cacheKey, readCache } from "../cache"
import { getBuffer, getText } from "../http"
import { asciiFold, cyrToLat, normalizeName, sameWord } from "../translit"
import type { AuditReport } from "../types"

const SOURCE = "dri"
const BASE = "https://www.dri.rs"
const MAX_EXCERPT = 400

interface Subject {
	id: string
	label: string
	reports: number
}

const ENTITIES: Record<string, string> = { "&quot;": '"', "&amp;": "&", "&lt;": "<", "&gt;": ">", "&#039;": "'", "&apos;": "'", "&nbsp;": " ", "&laquo;": "«", "&raquo;": "»" }

function decodeEntities(s: string): string {
	return s
		.replace(/&(quot|amp|lt|gt|apos|nbsp|laquo|raquo|#039);/g, (m) => ENTITIES[m] ?? m)
		.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
}

// cyrToLat maps Љ/Њ/Џ to "Lj"/"Nj"/"Dž" even inside ALL-CAPS words ("ZAKLjUČAK"); fix those
function latinize(s: string): string {
	return cyrToLat(s)
		.replace(/(?<=[A-ZČĆŠŽĐ])Lj|Lj(?=[A-ZČĆŠŽĐ])/g, "LJ")
		.replace(/(?<=[A-ZČĆŠŽĐ])Nj|Nj(?=[A-ZČĆŠŽĐ])/g, "NJ")
		.replace(/(?<=[A-ZČĆŠŽĐ])Dž|Dž(?=[A-ZČĆŠŽĐ])/g, "DŽ")
}

function clean(s: string): string {
	return decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim()
}

function isoFromDri(d: string | undefined): string | undefined {
	const m = d?.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/)
	return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : undefined
}

function absoluteUrl(href: string): string {
	return new URL(decodeEntities(href).trim(), BASE + "/").href
}

// ── subject (auditee) lookup ────────────────────────────────────────────────

function parseSubjects(html: string): Subject[] {
	const out: Subject[] = []
	const re = /<label[^>]*>([\s\S]*?)<\/label>\s*<span class="search-audits-counter[^>]*>(\d+)<\/span>\s*<input value="(\d+)"[^>]*name="subjects"/g
	let m: RegExpExecArray | null
	while ((m = re.exec(html))) out.push({ id: m[3], label: clean(m[1]), reports: Number(m[2]) })
	return out
}

function tokens(s: string): string[] {
	return asciiFold(s).replace(/[^a-z0-9]+/g, " ").split(" ").filter((t) => t.length > 1)
}

// equal up to a Serbian case ending ("železnice" ~ "železnica"); "srbija" must not match "srbijavoz" or "srbijavode"
const sameToken = sameWord

function matchSubjects(subjects: Subject[], inst: { name: string; nameCyr?: string }): Subject[] {
	const wanted = tokens(normalizeName(inst.name || inst.nameCyr || ""))
	if (wanted.length === 0) return []
	const scored = subjects
		.map((s) => {
			const labelTokens = tokens(s.label)
			const hit = wanted.filter((w) => labelTokens.some((l) => sameToken(w, l))).length
			const quoted = s.label.match(/[„"“«]([^„"“”«»]+)[”"“»]/)?.[1]
			const quotedTokens = quoted ? tokens(normalizeName(quoted)) : []
			// DRI sometimes splits a brand name: „СРБИЈА ВОЗ" is Srbijavoz
			const exact = quoted ? quotedTokens.join(" ") === wanted.join(" ") || quotedTokens.join("") === wanted.join("") : false
			return { s, hit: exact ? 1 : hit / wanted.length, extra: labelTokens.length - wanted.length, exact }
		})
		.filter((x) => x.hit === 1 && x.s.reports > 0)
	const exact = scored.filter((x) => x.exact)
	const pool = exact.length > 0 ? exact : scored
	return pool.sort((a, b) => a.extra - b.extra || b.s.reports - a.s.reports).slice(0, 4).map((x) => x.s)
}

// ── report listing ──────────────────────────────────────────────────────────

function classify(title: string, tag: string): string {
	const t = (tag + " " + title).toLowerCase()
	const ti = title.toLowerCase()
	if (/ревизији одазивног извештаја/.test(ti)) return "revizija odazivnog izveštaja"
	if (/послеревизион/.test(tag.toLowerCase())) return "poslerevizioni izveštaj"
	if (/одазивн/.test(tag.toLowerCase())) return "odazivni izveštaj"
	if (/послеревизион/.test(ti)) return "poslerevizioni izveštaj"
	if (/одазивни извештај|отклањању неправилности|спровођењу препорука/.test(ti)) return "odazivni izveštaj"
	if (/финансијских извештаја и правилности/.test(t)) return "finansijska revizija i revizija pravilnosti"
	if (/финансијских извештаја/.test(t)) return "finansijska revizija"
	if (/правилности и сврсисходности/.test(t)) return "revizija pravilnosti i svrsishodnosti"
	if (/правилности/.test(t)) return "revizija pravilnosti"
	if (/сврсисходности/.test(t)) return "revizija svrsishodnosti"
	return "izveštaj o reviziji"
}

// year = audited period for primary audits ("za 2018. godinu"), otherwise the publication year
function reportYear(title: string, kind: string, publishedAt?: string): number | undefined {
	const m = title.match(/за\s+(20\d\d)\.?\s+годин/i)
	if (m && /^(finansijska|revizija pravilnosti|revizija svrsishodnosti)/.test(kind)) return Number(m[1])
	return publishedAt ? Number(publishedAt.slice(0, 4)) : undefined
}

interface ListedReport {
	id: string
	title: string
	publishedAt?: string
	tag: string
	pdf?: string
}

function parseListing(html: string): { reports: ListedReport[]; hasNext: boolean } {
	const reports: ListedReport[] = []
	for (const block of html.split("revision-wrapper").slice(1)) {
		const h = block.match(/href="\/izvestaj\/(\d+)"[^>]*>([\s\S]*?)<\/a>/)
		if (!h) continue
		const tag = clean(block.match(/<span class="audit-topic"><\/span>([\s\S]*?)<\/div>/)?.[1] ?? "")
		const pdf = block.match(/href="([^"]+\.pdf)"/i)?.[1]
		reports.push({
			id: h[1],
			title: clean(h[2]),
			publishedAt: isoFromDri(block.match(/audit-latest-change">([^<]*)/)?.[1]),
			tag,
			pdf: pdf ? absoluteUrl(pdf) : undefined,
		})
	}
	return { reports, hasNext: /rel="next"/.test(html) }
}

async function pdfFromReportPage(id: string): Promise<string | undefined> {
	const html = await getText(`${BASE}/izvestaj/${id}`)
	const docs = html.slice(Math.max(0, html.indexOf("single-doc")))
	const href = docs.match(/<a href="([^"]+\.pdf)"/i)?.[1]
	return href ? absoluteUrl(href) : undefined
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function crawlSubject(subject: Subject): Promise<ListedReport[]> {
	const all: ListedReport[] = []
	for (let page = 1; page <= 15; page++) {
		const pageUrl = `${BASE}/izvestaji?subjects=${subject.id}${page > 1 ? `&page=${page}` : ""}`
		const { reports, hasNext } = await trackActivity({ ...SRC.dri, action: "preuzimanje", label: `spisak izveštaja, strana ${page}`, url: pageUrl }, async (h) => {
			const parsed = parseListing(await getText(pageUrl, { timeoutMs: 40000 }))
			h.items(parsed.reports.length)
			return parsed
		})
		all.push(...reports)
		if (!hasNext || reports.length === 0) break
		await sleep(300)
	}
	return all
}

/** Audit reports where the institution is the auditee (newest first). No excerpts: use getReportFindings. */
export async function getReports(inst: { name: string; nameCyr?: string }): Promise<AuditReport[]> {
	const key = cacheKey("reports", normalizeName(inst.name || inst.nameCyr || ""))
	const env = await cached<AuditReport[]>(SOURCE, key, async () => {
		const index = parseSubjects(await getText(`${BASE}/izvestaji`, { timeoutMs: 60000 }))
		const subjects = matchSubjects(index, inst)
		const retrievedAt = new Date().toISOString()
		const byId = new Map<string, AuditReport>()
		for (const subject of subjects) {
			for (const r of await crawlSubject(subject)) {
				if (byId.has(r.id)) continue
				const page = `${BASE}/izvestaj/${r.id}`
				let pdf = r.pdf
				if (!pdf) {
					await sleep(300)
					pdf = await pdfFromReportPage(r.id).catch(() => undefined)
				}
				const kind = classify(r.title, r.tag)
				byId.set(r.id, {
					id: r.id,
					title: latinize(r.title),
					year: reportYear(r.title, kind, r.publishedAt),
					publishedAt: r.publishedAt,
					kind,
					url: pdf ?? page,
					excerpts: [],
					source: {
						kind: "dri",
						title: `DRI: ${latinize(r.title).slice(0, 140)}`,
						url: page,
						retrievedAt,
						publishedAt: r.publishedAt,
						official: true,
					},
				})
			}
		}
		return [...byId.values()].sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""))
	}, { activity: { ...SRC.dri, action: "pretraga", label: `DRI izveštaji: ${shortInstitution(inst.name || inst.nameCyr || "")}`, url: `${BASE}/izvestaji`, after: (d, h) => h.items(d.length) } })
	return env.data
}

/** "Izveštaj o reviziji pravilnosti poslovanja" without the auditee's name (which makes DRI titles 300 characters long). */
function shortReportTitle(title: string): string {
	const head = title.split(/\s+(?:Akcionarsk|Društv|Javn\w+ preduze|Preduze|Ustanov|Republi|Grad |Opštin)/i)[0].trim()
	return head.length > 64 ? `${head.slice(0, 63).trimEnd()}…` : head
}

// ── PDF findings ────────────────────────────────────────────────────────────

type OpinionKind = "pozitivno mišljenje" | "mišljenje sa rezervom" | "negativno mišljenje" | "uzdržavanje od mišljenja"

const OPINION_HEADING =
	/^(Мишљење са резервом|Квалификовано мишљење|Негативно мишљење|Позитивно мишљење|Уздржавање од изражавања мишљења|Одбијање изражавања мишљења|Мишљење)\s+(о|на|за)\s+(финансијским извештајима|правилности)/im

function opinionFromHeading(h: string, after: string): OpinionKind {
	const x = h.toLowerCase()
	if (/резервом|квалификован/.test(x)) return "mišljenje sa rezervom"
	if (/негативн/.test(x)) return "negativno mišljenje"
	if (/уздржавање|одбијање/.test(x)) return "uzdržavanje od mišljenja"
	if (/позитивн/.test(x)) return "pozitivno mišljenje"
	// plain "Mišljenje o ..." is the unqualified form unless the next lines say otherwise
	const next = after.slice(0, 1200)
	if (/осим за ефекте|са резервом/i.test(next)) return "mišljenje sa rezervom"
	if (/не дају истинит|нису у складу/i.test(next)) return "negativno mišljenje"
	return "pozitivno mišljenje"
}

function findOpinion(raw: string): { opinion?: OpinionKind; sentence?: string } {
	const head = raw.slice(0, Math.floor(raw.length * 0.6))
	const m = OPINION_HEADING.exec(head)
	if (!m) return {}
	const after = head.slice(m.index)
	const opinion = opinionFromHeading(m[1], after)
	const flat = after.replace(/\s+/g, " ")
	const s = flat.match(/По нашем мишљењу[\s\S]*?\.(?=\s+[А-ЯЂЈЉЊЋЏШЧЖ])/)
	return { opinion, sentence: s?.[0] }
}

/** Drops running page headers (identical long lines repeated on many pages) and page numbers, and marks short heading lines as sentence ends. */
function flatten(raw: string): string {
	const lines = raw.replace(/\u00ad/g, "").split(/\r?\n/).map((l) => l.trim())
	const freq = new Map<string, number>()
	for (const l of lines) if (l.length >= 30) freq.set(l, (freq.get(l) ?? 0) + 1)
	const kept = lines.filter((l) => l && !/^\d{1,3}$/.test(l) && (freq.get(l) ?? 0) < 4)
	const out: string[] = []
	for (let i = 0; i < kept.length; i++) {
		let l = kept[i]
		const next = kept[i + 1]
		if (next && l.length < 35 && !/[.;,:)\-]$/.test(l) && /^[А-ЯЂЈЉЊЋЏШЧЖA-Z]/.test(next)) l += "."
		out.push(l)
	}
	return out.join(" ").replace(/(\p{L})- (\p{Ll})/gu, "$1$2").replace(/\s+/g, " ").trim()
}

const TOC_PAGE_REF = /\s\d{1,3}\s+(?=[IVX]+\s|[А-ЯЂЈЉЊЋЏШЧЖ]{2,}|Налаз|Закључак|\d\.)/g

function tokenSet(s: string): Set<string> {
	return new Set(tokens(s).filter((t) => t.length > 3))
}

function tooSimilar(a: string, b: string): boolean {
	const ta = tokenSet(a)
	const tb = tokenSet(b)
	if (ta.size === 0 || tb.size === 0) return false
	let inter = 0
	for (const t of ta) if (tb.has(t)) inter++
	return inter / Math.min(ta.size, tb.size) > 0.7
}

// no split after "197." / "2018." (ordinals); a leading enumerator ("9. Društvo ...") is dropped from the next sentence
function splitSentences(text: string): string[] {
	return text
		.split(/(?<=\D[.!?]|;)\s+(?=(?:\d{1,2}\.\s+)?[А-ЯЂЈЉЊЋЏШЧЖA-Z„"«–-])/)
		.map((s) => s.replace(/^\d{1,2}\.\s+/, ""))
		.map(cutAtStray)
}

/** Table residue often follows a sentence in lowercase ("... nabavkama. nepravilnosti. (Preporuka broj 6)"): cut there. */
function cutAtStray(s: string): string {
	const m = /[а-яђјљњћџшчж]{6,}\.\s+(?=[а-яђјљњћџшчж])/.exec(s.slice(100))
	return m ? s.slice(0, 100 + m.index + m[0].trimEnd().length) : s
}

const MONEY = /(милион|милијард|хиљад[аеу]\s+динар|динар|евра|EUR)/i
const NEGATIVE = /(није у складу|нису у складу|није поступ|нису поступ|није успоставил|није документовал|није спровел|није извршил|неправилност|нису спровођен|без спровођења|несврсисходн|прецењен|потцењен|нису вршен|није вршен)/i

function scoreSentence(s: string): number {
	let score = 0
	if (MONEY.test(s) && /\d/.test(s)) score += 3
	if (NEGATIVE.test(s)) score += 3
	if (/вршиоца дужности|в\.\s?д\./i.test(s)) score += NEGATIVE.test(s) ? 6 : 1
	if (/преговарачк|без објављивања|јавн\w+ набавк/i.test(s)) score += 2
	if (/препоруч|препорук/i.test(s)) score += 1
	if (/Друштво|Акционарско друштво/.test(s)) score += 1
	if (/\d+\s?%/.test(s)) score += 2
	if (/\d/.test(s) && /(није|нису|недовољно|ризик)/i.test(s)) score += 1
	if (/\.{4,}/.test(s) || /Закона о|Службени гласник/.test(s) && s.length < 90) score -= 5
	if (/^[IVX]+\s/.test(s) || /\s\d{1,3}$/.test(s)) score -= 6
	if (/одазивн/i.test(s)) score -= 4
	if (/Резиме и препоруке|Садржај|Скраћенице/.test(s)) score -= 6
	return score
}

function trimExcerpt(s: string): string {
	const t = s.trim()
	if (t.length <= MAX_EXCERPT) return t
	const cut = t.slice(0, MAX_EXCERPT - 1)
	const at = Math.max(cut.lastIndexOf("; "), cut.lastIndexOf(", "), cut.lastIndexOf(" "))
	return cut.slice(0, at > 200 ? at : cut.length).replace(/[,;:\s]+$/, "") + "…"
}

function pickExcerpts(flat: string, opinionSentence?: string): string[] {
	const out: string[] = []
	const add = (s: string) => {
		const e = trimExcerpt(s)
		if (e.length < 60 || out.some((o) => tooSimilar(o, e))) return
		out.push(e)
	}
	if (opinionSentence) add(opinionSentence)

	const sentences = splitSentences(flat.slice(0, Math.min(flat.length, 90000))).map((s, i) => ({ s: s.trim(), i, score: scoreSentence(s) }))
	const pass = (minScore: number, maxChars: number, want: number) => {
		const candidates = sentences
			.filter((c) => c.s.length >= 80 && c.s.length <= 700 && c.score >= minScore && !/\.{4,}/.test(c.s) && (c.s.match(TOC_PAGE_REF)?.length ?? 0) < 2)
			.filter((c) => c.i < sentences.length * (maxChars / 90000) || maxChars >= 90000)
			.map((c) => ({ ...c, score: c.score + (c.s.length <= MAX_EXCERPT ? 2 : 0) }))
			.sort((a, b) => b.score - a.score || a.i - b.i)
		const chosen: { s: string; i: number }[] = []
		for (const c of candidates) {
			if (chosen.length >= want) break
			if (chosen.some((x) => Math.abs(x.i - c.i) < 2 || tooSimilar(x.s, c.s)) || out.some((o) => tooSimilar(o, c.s))) continue
			chosen.push(c)
		}
		for (const c of chosen.sort((a, b) => a.i - b.i)) add(c.s)
	}
	pass(4, 90000, 5)
	// performance audits ("revizija svrsishodnosti") rarely use the "Društvo nije ..." wording: relax on the summary part
	if (out.length < 3) pass(2, 40000, 5 - out.length)
	return out.slice(0, 6)
}
async function pdfUrlFor(report: AuditReport): Promise<string> {
	if (/\.pdf($|\?)/i.test(report.url)) return report.url
	const pdf = await pdfFromReportPage(report.id)
	if (!pdf) throw new Error(`DRI report ${report.id}: no PDF link on the report page`)
	return pdf
}

async function extractReportText(url: string): Promise<string> {
	const buf = await getBuffer(url, { timeoutMs: 90000 })
	const pdf = await getDocumentProxy(new Uint8Array(buf))
	const { text } = await extractText(pdf, { mergePages: true })
	return text as string
}

/** Opinions that are already cached for these reports (report id -> opinion). Never downloads a PDF. */
export function getCachedOpinions(reports: AuditReport[]): Promise<Map<string, string>> {
	return trackActivity({ ...SRC.dri, action: "dokument", label: `mišljenja revizora iz već obrađenih PDF-ova (${reports.length} izveštaja)`, url: `${BASE}/izvestaji` }, async (h) => {
		const out = new Map<string, string>()
		let latest: string | undefined
		for (const r of reports) {
			const hit = await readCache<Pick<AuditReport, "opinion">>(SOURCE, cacheKey("findings", r.id))
			if (hit?.data?.opinion) out.set(r.id, hit.data.opinion)
			if (hit && (!latest || hit.retrievedAt > latest)) latest = hit.retrievedAt
		}
		h.cached(latest)
		h.items(out.size)
		return out
	})
}

/** Downloads the PDF, extracts the opinion and 3-6 short verbatim excerpts (Latin script). Cached per report id. */
export async function getReportFindings(report: AuditReport): Promise<AuditReport> {
	const env = await cached<Pick<AuditReport, "opinion" | "excerpts">>(SOURCE, cacheKey("findings", report.id), async () => {
		const raw = await extractReportText(await pdfUrlFor(report))
		const { opinion, sentence } = findOpinion(raw)
		const excerpts = pickExcerpts(flatten(raw), sentence ? flatten(sentence) : undefined).map(latinize)
		return { opinion, excerpts }
	}, { activity: { ...SRC.dri, action: "dokument", label: `PDF: ${shortReportTitle(report.title)}${report.year ? ` (${report.year})` : ""}`, url: report.url, after: (d, h) => h.items(d.excerpts?.length) } })
	return { ...report, opinion: env.data.opinion ?? report.opinion, excerpts: env.data.excerpts }
}







