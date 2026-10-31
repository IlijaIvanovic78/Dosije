// CompanyWall (https://www.companywall.rs): commercial business directory that republishes the APR register. Its public
// company page shows the owners (with shares) and the director, which the APR open data does not carry and the APR
// search hides behind reCAPTCHA. Not an official register: every owner found here is marked unofficial (verify in APR).
//
//   GET /pretraga?n=<MB>       search page; links the company page /firma/<slug>/<id>
//   GET /firma/<slug>/<id>     company page; owners and director are <dt>Vlasnik</dt><dd>NAME(60,00%)</dd> pairs
// The page is accepted only when it shows the same matični broj. Only owner names, shares and the director are read:
// the phone, e-mail and address on the same page are never parsed, returned or cached.

import type { SourceRef } from "../../shared/types"
import { SRC } from "../activity"
import { cached, cacheKey } from "../cache"
import { getText, HttpError } from "../http"

const BASE = "https://www.companywall.rs"
const SOURCE = "companywall"

// the site allows about 5 requests, then answers 429 for ~30 s (measured Oct 2026): one request at a time, at most
// WINDOW_MAX per minute, and on a 429 one wait for the block to pass before giving up
const GAP_MS = 1500
const WINDOW_MS = 60_000
const WINDOW_MAX = 5
const RATE_LIMIT_WAIT_MS = 35_000
let queue: Promise<unknown> = Promise.resolve()
const sent: number[] = []

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitForSlot(): Promise<void> {
	for (;;) {
		const now = Date.now()
		while (sent.length && now - sent[0] >= WINDOW_MS) sent.shift()
		const gap = sent.length ? sent[sent.length - 1] + GAP_MS - now : 0
		const full = sent.length >= WINDOW_MAX ? sent[0] + WINDOW_MS - now : 0
		const wait = Math.max(gap, full)
		if (wait <= 0) break
		await sleep(wait)
	}
	sent.push(Date.now())
}

function politeGet(url: string): Promise<string> {
	const run = async (): Promise<string> => {
		for (let attempt = 0; ; attempt++) {
			await waitForSlot()
			try {
				return await getText(url, { timeoutMs: 15_000, retries: 0 })
			} catch (err) {
				if (attempt >= 1 || !(err instanceof HttpError) || (err.status !== 429 && err.status < 500)) throw err
				await sleep(RATE_LIMIT_WAIT_MS)
			}
		}
	}
	const next = queue.then(run, run)
	queue = next.catch(() => undefined)
	return next
}

export interface CompanyOwner {
	name: string
	/** as published, e.g. "60%" or "33,34%" */
	share?: string
	kind: "osoba" | "firma"
}

export interface CompanyOwners {
	mb: string
	companyName: string
	owners: CompanyOwner[]
	director?: string
	source: SourceRef
}

function decode(s: string): string {
	return s
		.replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
		.replace(/&quot;/g, '"')
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
}

const text = (html: string) => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim()

// an owner that is a company, a fund or a public body, not a person
const ENTITY = /\b(d\.?\s?o\.?\s?o|a\.?\s?d|doo|ad|ado|llc|llp|ltd|limited|plc|gmbh|ag|se|kgaa|kg|co|s\.?a|s\.?p\.?a|s\.?r\.?l|sarl|sas|inc|corp|b\.?v|n\.?v|kft|zrt|fzco|fze|pte|pty|holding|group|fond|fund|republika|grad|opstina|opština|autonomna|pokrajina|preduzeće|preduzece|društvo|drustvo|banka|bank|osiguranje|investments?|capital|trust|zadruga|international)\b/i

/** "DANIJELA PADEŽANIN" -> "Danijela Padežanin" (people only: a company keeps its registered spelling). */
function personName(name: string): string {
	if (name !== name.toLocaleUpperCase("sr")) return name
	return name.toLocaleLowerCase("sr").replace(/(^|[\s-])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toLocaleUpperCase("sr"))
}

function parseOwner(raw: string): CompanyOwner | null {
	// "NAME(60,00%)" for people, "TRIGLAV INT, D.O.O. 100,00%" (no bracket) for companies
	const m = /^(.+?)\s*\(?\s*(\d{1,3}(?:[.,]\d{1,2})?)\s*%\s*\)?$/.exec(raw)
	const name = (m ? m[1] : raw).trim().replace(/[,;]$/, "")
	if (name.length < 3) return null
	const share = m ? `${m[2].replace(/[.,]00$/, "")}%` : undefined
	const kind = ENTITY.test(name) || /&|\d/.test(name) ? "firma" : "osoba"
	return { name: kind === "osoba" ? personName(name) : name, share, kind }
}

/** Owners and director from a company page; null when the page is about another company (other MB, or other PIB). */
export function parseCompanyPage(html: string, id: { mb?: string; pib?: string }): Omit<CompanyOwners, "source"> | null {
	const pairs = [...html.matchAll(/<dt[^>]*>\s*(?:<i[^>]*><\/i>)?\s*([^<]{2,40}?)\s*<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/g)].map((m) => ({ label: text(m[1]), value: text(m[2]).replace(/\s*Prikaži sve$/i, "") }))
	const pageMb = pairs.find((p) => p.label === "MB")?.value.replace(/\D/g, "")
	const pagePib = pairs.find((p) => p.label === "PIB")?.value.replace(/\D/g, "")
	if (!pageMb || (id.mb ? pageMb !== id.mb : !id.pib || pagePib !== id.pib)) return null
	const owners = pairs
		.filter((p) => /^Vlasni(k|ci)$/i.test(p.label))
		.map((p) => parseOwner(p.value))
		.filter((o): o is CompanyOwner => !!o)
	const director = pairs.find((p) => /^Direktor$/i.test(p.label))?.value
	const companyName = pairs.find((p) => p.label === "Naziv")?.value ?? ""
	return { mb: pageMb, companyName, owners, director: director ? personName(director) : undefined }
}

/** Owners of a company by matični broj, or by PIB when the MB is unknown (search, then the company page). Throws when the site does not answer. */
export async function getOwners(q: { mb?: string; pib?: string; name?: string }): Promise<CompanyOwners | null> {
	// DOSIJE_COMPANYWALL=0 turns the source off (tests of the journalist-answer path; or when the site must not be used)
	if (process.env.DOSIJE_COMPANYWALL === "0") return null
	const mb = q.mb?.replace(/\D/g, "") || undefined
	const pib = q.pib?.replace(/\D/g, "") || undefined
	const id = mb && mb.length >= 6 ? mb : pib && pib.length === 9 ? pib : undefined
	if (!id) return null
	const env = await cached<CompanyOwners | null>(
		SOURCE,
		cacheKey("owners", id === mb ? id : `pib-${id}`),
		async () => {
			const search = await politeGet(`${BASE}/pretraga?n=${id}`)
			const links = [...new Set([...search.matchAll(/href="(\/firma\/[^"?#]+)"/g)].map((m) => m[1]))].slice(0, 2)
			for (const link of links) {
				const url = `${BASE}${link}`
				const page = parseCompanyPage(await politeGet(url), id === mb ? { mb } : { pib })
				if (!page) continue
				const retrievedAt = new Date().toISOString()
				const source: SourceRef = { kind: "companywall", title: `CompanyWall – ${page.companyName || q.name || `MB ${page.mb}`} (MB ${page.mb}): vlasnička struktura`, url, retrievedAt, official: false }
				return { ...page, source }
			}
			return null
		},
		{
			skipWrite: (d) => d === null,
			activity: { ...SRC.cw, action: "pretraga", label: `vlasnici: ${q.name?.trim() || (id === mb ? `MB ${id}` : `PIB ${id}`)}`, url: `${BASE}/pretraga?n=${id}`, after: (d, h) => h.items(d?.owners.length ?? 0) },
		},
	)
	return env.data
}
