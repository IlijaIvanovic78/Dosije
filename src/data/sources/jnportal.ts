// Portal javnih nabavki (https://jnportal.ujn.gov.rs): public part, no login.
// The SPA-like site is ASP.NET + DevExtreme grids. Every grid is served by an undocumented JSON endpoint
//   GET /api/searchgrid/<GridName>/get?filter=<json>&sort=<json>&skip=&take=&requireTotalCount=true
// authorised by a per-visitor session: cookie ASP.NET_SessionId + header UserToken (hidden input #uiUserToken on any page).
// Details and caveats: docs/data-sources/jnportal.md

import { SRC, shortInstitution, trackActivity } from "../activity"
import { cached, cacheKey, readCache, writeCache } from "../cache"
import { getJson, HttpError, USER_AGENT } from "../http"
import { institutionNames } from "../newsPlan"
import { clipWords } from "../../shared/text"
import { cyrToLat, latToCyr, nameSimilarity, normalizeName } from "../translit"
import type { Contract, ProcurementCoverage, ProcurementSummary, SupplierAggregate } from "../types"
import type { SourceRef } from "../../shared/types"

const BASE = "https://jnportal.ujn.gov.rs"
const SOURCE = "jnportal"
const PAGE = 100 // the server silently caps `take` at 100
const DELAY_MS = 450

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface AuthorityRef {
	id: string
	name: string
	pib?: string
	mb?: string
	source: SourceRef
}

interface InstLike {
	jnId?: string
	name: string
	pib?: string
}

// ─── session + grid API ──────────────────────────────────────────────────────

interface Session {
	cookie: string
	token: string
}

let sessionPromise: Promise<Session> | null = null

async function openSession(): Promise<Session> {
	let lastErr: unknown
	const started = Date.now()
	for (let i = 0; i < 6 && (i === 0 || Date.now() - started < 30_000); i++) {
		try {
			// global fetch on purpose: http.ts keeps only the last Set-Cookie header, the portal needs ASP.NET_SessionId
			const res = await fetch(`${BASE}/`, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(20000) })
			const html = await res.text()
			if (res.ok) {
				const token = /id="uiUserToken"[^>]*value="([^"]+)"/.exec(html)?.[1]
				const cookie = res.headers
					.getSetCookie()
					.map((c) => c.split(";")[0])
					.join("; ")
				if (token && cookie) return { token, cookie }
			} else lastErr = new Error(`HTTP ${res.status}`)
		} catch (err) {
			lastErr = err
		}
		// the portal's TrafficGuard answers 500 on session creation when it is rate limiting
		await sleep(3000 * (i + 1))
	}
	throw new Error(`jnportal: sesija nije otvorena (${String(lastErr)})`)
}

function getSession(): Promise<Session> {
	sessionPromise ??= openSession().catch((err) => {
		sessionPromise = null
		throw err
	})
	return sessionPromise
}

interface GridResponse<T> {
	data: T[]
	totalCount?: number
}

async function grid<T>(name: string, params: Record<string, string>): Promise<GridResponse<T>> {
	const qs = new URLSearchParams(params).toString()
	let lastErr: unknown
	for (let attempt = 0; attempt < 3; attempt++) {
		const s = await getSession()
		try {
			return await getJson<GridResponse<T>>(`${BASE}/api/searchgrid/${name}/get?${qs}`, {
				headers: { UserToken: s.token, Cookie: s.cookie, "Content-Type": "application/json" },
				retries: 0,
				timeoutMs: 30000,
			})
		} catch (err) {
			lastErr = err
			if (err instanceof HttpError && (err.status === 401 || err.status === 403 || err.status >= 500)) {
				sessionPromise = null
				await sleep(2000 * (attempt + 1))
				continue
			}
			throw err
		}
	}
	throw lastErr
}

/** Raw grid access for probes and the QA script (attribution checks). */
export { grid as rawGrid }

export interface CrawlLimits {
	/** stop after this many rows (the grid is sorted newest first, so what is kept is the most recent part) */
	maxRows?: number
	/** epoch ms after which no further page is requested */
	deadline?: number
}

export interface Crawl<T> {
	rows: T[]
	/** rows the grid holds for this filter */
	total: number
	/** the crawl stopped before the last page (row cap or time budget) */
	truncated: boolean
}

/** One live activity per page of a crawl ("ugovori, strana 3/16"); no events outside a tool's activity context. */
async function gridAll<T>(name: string, filter: unknown, sort: unknown, what = "podaci", limits: CrawlLimits = {}): Promise<Crawl<T>> {
	const rows: T[] = []
	let total = Number.POSITIVE_INFINITY
	let truncated = false
	const maxRows = limits.maxRows ?? Number.POSITIVE_INFINITY
	for (let skip = 0, page = 0; skip < total && page < 400; skip += PAGE, page++) {
		if (rows.length >= maxRows || (limits.deadline && Date.now() > limits.deadline)) {
			truncated = true
			break
		}
		const res = await trackActivity({ ...SRC.jn, action: "preuzimanje", label: `${what}, strana ${page + 1}`, url: `${BASE}/ugovori` }, async (h) => {
			const r = await grid<T>(name, {
				filter: JSON.stringify(filter),
				sort: JSON.stringify(sort),
				skip: String(skip),
				take: String(PAGE),
				requireTotalCount: "true",
			})
			h.items(r.data.length)
			if (r.totalCount) h.label(`${what}, strana ${page + 1}/${Math.max(1, Math.ceil(Math.min(r.totalCount, Number.isFinite(maxRows) ? maxRows : r.totalCount) / PAGE))}`)
			return r
		})
		total = res.totalCount ?? res.data.length
		if (res.data.length === 0) break
		rows.push(...res.data)
		await sleep(DELAY_MS)
	}
	return { rows: rows.slice(0, Number.isFinite(maxRows) ? maxRows : undefined), total: Number.isFinite(total) ? total : rows.length, truncated }
}
// ─── raw shapes (only the fields we use) ─────────────────────────────────────

interface RawContractor {
	Id: number // = ContractCAId in the other grids
	Name: string
	IdentificationNumber: string // PIB
	City?: string
	IsContractingAuthority?: boolean
	IsContractingEntity?: boolean
}

interface RawLotContract {
	TenderId: number
	TenderName: string
	LotId: number
	LotTitle?: string
	LotNo?: number | null
	ContractNo: string
	ContractDate: string
	LotContractedValue: number
	LotContractedValueVAT: number
	FinalValue: number
	Currency: string
	ContractorIDs: string
	ContractorsNames: string
}

interface RawTender {
	Id: number
	ReferenceNumber?: string
	Name: string
	ProcedureType: string
	ProcedureTypeId: number
	CPVExtended?: string
	NoticePublishDate?: string
	TenderStatus?: string
	NegotiatedProcedureLegalBaseArticle?: string | null
}

// ─── normalized store (what is cached, as one compact JSON string) ───────────

interface StoredContract {
	id: string
	tenderId: number
	contractNo: string
	title: string
	supplierName: string
	supplierPib?: string
	pibs: string[]
	valueRsd?: number
	valueRsdWithVat?: number
	finalValueRsd?: number
	foreign?: { currency: string; value: number }
	signedAt?: string
	procedureTypeId?: number
	procedureType?: string
	cpv?: string
}

interface StoredProcedure {
	tenderId: number
	refNo?: string
	title: string
	publishedAt?: string
	status?: string
	legalBasis?: string
	cpv?: string
}

export type Coverage = ProcurementCoverage

interface Store {
	authority: { id: string; name: string; pib?: string }
	totalTenders: number
	/** absent in older cache files = the whole history was read */
	coverage?: Coverage
	contracts: StoredContract[]
	negotiated: StoredProcedure[]
}

const PROCEDURE_NAMES: Record<number, string> = {
	1: "Otvoreni postupak",
	2: "Restriktivni postupak",
	3: "Konkurentni postupak sa pregovaranjem",
	4: "Konkurentni dijalog",
	5: "Partnerstvo za inovacije",
	6: "Pregovarački postupak bez objavljivanja javnog poziva",
	7: "Pregovarački postupak sa objavljivanjem javnog poziva",
	11: "Nabavka izuzeta od primene ZJN",
	27: "Izmena ugovora zaključenog po prethodno važećem ZJN",
	29: "Postupak nabavki ispod praga - mikro nabavke",
}
const NEGOTIATED_NO_PUBLICATION = 6

const isoDate = (s?: string | null) => (s ? s.slice(0, 10) : undefined)
const cpvCode = (s?: string) => s?.match(/^\d{8}/)?.[0]
const clip = clipWords

function procedureLabel(id: number | undefined, raw?: string, article?: string | null): string | undefined {
	const base = raw ? cyrToLat(raw) : id !== undefined ? PROCEDURE_NAMES[id] : undefined
	if (!base) return undefined
	const art = article ? cyrToLat(article).trim() : ""
	return art ? `${base} (${art})` : base
}

function buildStore(auth: { id: string; name: string; pib?: string }, lots: RawLotContract[], tenders: RawTender[], coverage?: Coverage): Store {
	const tenderById = new Map(tenders.map((t) => [t.Id, t]))
	const seen = new Map<string, number>()
	const contracts: StoredContract[] = lots.map((l) => {
		const t = tenderById.get(l.TenderId)
		const pibs = (l.ContractorIDs ?? "")
			.split(/[,;\s]+/)
			.map((p) => p.trim())
			.filter(Boolean)
		const names = cyrToLat((l.ContractorsNames ?? "").trim())
		const joint = pibs.length > 1 && !/^Grupa/i.test(names)
		const baseId = `${l.TenderId}-${l.LotId}`
		const n = (seen.get(baseId) ?? 0) + 1
		seen.set(baseId, n)
		const lot = l.LotTitle && l.LotNo != null && cyrToLat(l.LotTitle) !== cyrToLat(l.TenderName) ? ` – ${cyrToLat(l.LotTitle)}` : ""
		const rsd = l.Currency === "РСД"
		return {
			id: n === 1 ? baseId : `${baseId}-${n}`,
			tenderId: l.TenderId,
			contractNo: l.ContractNo,
			title: clip(cyrToLat(l.TenderName.trim()) + lot, 300),
			supplierName: joint ? `Zajednička ponuda: ${names}` : names,
			supplierPib: pibs[0],
			pibs,
			valueRsd: rsd ? l.LotContractedValue : undefined,
			valueRsdWithVat: rsd ? l.LotContractedValueVAT : undefined,
			finalValueRsd: rsd ? l.FinalValue : undefined,
			foreign: rsd ? undefined : { currency: cyrToLat(l.Currency), value: l.LotContractedValue },
			signedAt: isoDate(l.ContractDate),
			procedureTypeId: t?.ProcedureTypeId,
			procedureType: t ? procedureLabel(t.ProcedureTypeId, t.ProcedureType, t.NegotiatedProcedureLegalBaseArticle) : undefined,
			cpv: cpvCode(t?.CPVExtended),
		}
	})
	const negotiated: StoredProcedure[] = tenders
		.filter((t) => t.ProcedureTypeId === NEGOTIATED_NO_PUBLICATION)
		.map((t) => ({
			tenderId: t.Id,
			refNo: t.ReferenceNumber,
			title: clip(cyrToLat(t.Name.trim()), 300),
			publishedAt: isoDate(t.NoticePublishDate),
			status: t.TenderStatus ? cyrToLat(t.TenderStatus) : undefined,
			legalBasis: t.NegotiatedProcedureLegalBaseArticle ? cyrToLat(t.NegotiatedProcedureLegalBaseArticle).trim() : undefined,
			cpv: cpvCode(t.CPVExtended),
		}))
	return { authority: auth, totalTenders: tenders.length, coverage, contracts, negotiated }
}

// ─── authority lookup ────────────────────────────────────────────────────────

function authorityUrl(name: string): string {
	return `${BASE}/ugovori?initFilter=${encodeURIComponent(JSON.stringify(["OfficialName", "=", latToCyr(name)]))}`
}

function authoritySource(name: string, retrievedAt: string): SourceRef {
	return {
		kind: "jnportal",
		title: `Portal javnih nabavki – ugovori naručioca: ${name}`,
		url: authorityUrl(name),
		retrievedAt,
		official: true,
	}
}

function toAuthority(r: RawContractor, retrievedAt: string): AuthorityRef {
	const name = cyrToLat(r.Name.trim())
	return { id: String(r.Id), name, pib: r.IdentificationNumber || undefined, source: authoritySource(name, retrievedAt) }
}

interface AuthorityIndex {
	[id: string]: { id: string; name: string; pib?: string }
}

async function readIndex(): Promise<AuthorityIndex> {
	return (await readCache<AuthorityIndex>(SOURCE, "authority-index"))?.data ?? {}
}

// read-modify-write of one file: calls must not interleave (parallel lookups once overwrote the whole index with a partial copy)
let indexLock: Promise<unknown> = Promise.resolve()

function remember(a: { id: string; name: string; pib?: string }): Promise<void> {
	const run = async () => {
		const idx = await readIndex()
		if (idx[a.id]?.name === a.name && idx[a.id]?.pib === a.pib) return
		idx[a.id] = { id: a.id, name: a.name, pib: a.pib }
		await writeCache(SOURCE, "authority-index", idx)
	}
	const next = indexLock.then(run, run)
	indexLock = next.catch(() => undefined)
	return next
}

export async function findAuthority(nameOrPib: string): Promise<AuthorityRef[]> {
	const q = nameOrPib.trim()
	if (!q) return []
	// cacheKey folds diacritics: "Pošta" and "Posta" are different searches (Пошта / Поста) and must not share a file
	const exact = /[čćšžđČĆŠŽĐ]/.test(q) ? `d${[...q].reduce((h, ch) => ((h * 33) ^ ch.codePointAt(0)!) >>> 0, 5381).toString(36)}` : undefined
	const env = await cached(SOURCE, cacheKey("authority", q, exact), async () => {
		const isPib = /^\d{8,9}$/.test(q)
		const cyr = latToCyr(q)
		const run = (filter: unknown) =>
			grid<RawContractor>("ContractorsPublic", { filter: JSON.stringify(filter), skip: "0", take: "50", requireTotalCount: "true" })
		let rows: RawContractor[]
		if (isPib) rows = (await run(["IdentificationNumber", "=", q])).data
		else {
			rows = (await run(["Name", "contains", cyr])).data
			if (rows.length === 0) {
				const words = cyr.split(/\s+/).filter((w) => w.length > 3)
				if (words.length > 1) {
					const f: unknown[] = []
					for (const w of words) f.push(["Name", "contains", w], "and")
					f.pop()
					rows = (await run(f)).data
				}
			}
		}
		return rows
			.filter((r) => r.IsContractingAuthority || r.IsContractingEntity)
			.map((r): RawContractor => ({ Id: r.Id, Name: r.Name, IdentificationNumber: r.IdentificationNumber, City: r.City }))
	}, { skipWrite: (d) => d.length === 0, activity: { ...SRC.jn, action: "pretraga", label: `naručilac: ${q}`, url: `${BASE}/ugovori`, after: (d, h) => h.items(d.length) } })
	const out = env.data.map((r) => toAuthority(r, env.retrievedAt))
	if (!/^\d{8,9}$/.test(q)) out.sort((a, b) => nameSimilarity(b.name, q) - nameSimilarity(a.name, q))
	for (const a of out.slice(0, 5)) await remember(a)
	return out.slice(0, 10)
}

/** How much and how recently an authority published contracts (one request): tells a live registration from an old, renamed one. */
export async function authorityActivity(a: { name: string }): Promise<{ total: number; latest: string }> {
	const res = await grid<{ ContractDate?: string }>("VContracts", {
		filter: JSON.stringify(["OfficialName", "=", latToCyr(a.name)]),
		sort: JSON.stringify([{ selector: "ContractDate", desc: true }]),
		skip: "0",
		take: "1",
		requireTotalCount: "true",
	})
	return { total: res.totalCount ?? res.data.length, latest: res.data[0]?.ContractDate?.slice(0, 10) ?? "" }
}

async function resolveAuthority(inst: InstLike): Promise<{ id: string; name: string; pib?: string }> {
	const idx = await readIndex()
	const known = Object.values(idx)
	if (inst.jnId) {
		const hit = idx[inst.jnId]
		if (hit) return hit
		const cand = (await findAuthority(inst.pib ?? inst.name)).find((a) => a.id === inst.jnId)
		if (cand) return { id: cand.id, name: cand.name, pib: cand.pib }
		return { id: inst.jnId, name: inst.name, pib: inst.pib }
	}
	if (inst.pib) {
		const hit = known.find((k) => k.pib === inst.pib)
		if (hit) return hit
		const [first] = await findAuthority(inst.pib)
		if (first) return { id: first.id, name: first.name, pib: first.pib }
	}
	const hit = known.filter((k) => nameSimilarity(k.name, inst.name) >= 0.85).sort((a, b) => nameSimilarity(b.name, inst.name) - nameSimilarity(a.name, inst.name))[0]
	if (hit) return hit
	const cands = await findAuthority(inst.name)
	const best = cands[0]
	if (!best || nameSimilarity(best.name, inst.name) < 0.5) throw new Error(`Portal javnih nabavki: naručilac nije pronađen (${inst.name})`)
	return { id: best.id, name: best.name, pib: best.pib }
}

// ─── contracts ───────────────────────────────────────────────────────────────

interface Loaded {
	store: Store
	retrievedAt: string
	/** this call read the committed/previous copy (or the in-memory copy of an earlier call) instead of crawling the portal */
	fromCache?: boolean
}

const memo = new Map<string, Promise<Loaded>>()

// newest first: a capped crawl keeps the most recent contracts. LotId makes paging stable for contracts signed on one day.
const LOT_SORT = [
	{ selector: "ContractDate", desc: true },
	{ selector: "LotId", desc: true },
]

/** Authorities with more contracts than this are analysed on their most recent ones (EPS: tens of thousands). */
export const MAX_CONTRACTS = 1500
/** Time budget of one authority's crawl (contracts, then procedures). */
export const CRAWL_BUDGET_MS = 60_000

/** Name without legal form and city ("Друштво са ограниченом одговорношћу "Путеви Србије" Београд" -> "Путеви Србије"). */
function coreNameCyr(cyr: string): string {
	const word = "(?<![\\p{L}])"
	const end = "(?![\\p{L}])"
	return cyr
		.replace(/[„“”"'`]/g, " ")
		.replace(new RegExp(`${word}(друштво са ограниченом одговорношћу|акционарско друштво|јавно предузеће|јп|доо|ад|а\\.д\\.|д\\.о\\.о\\.|београд)${end}`, "giu"), " ")
		.replace(/\s+/g, " ")
		.trim()
}

async function fetchStore(auth: { id: string; name: string; pib?: string }, otherNames: string[] = []): Promise<string> {
	const started = Date.now()
	const contractDeadline = started + CRAWL_BUDGET_MS * 0.6
	const cyrName = latToCyr(auth.name)
	let byName = await gridAll<RawLotContract>("VContracts", ["OfficialName", "=", cyrName], LOT_SORT, "ugovori", { maxRows: MAX_CONTRACTS, deadline: contractDeadline })
	let viaContains = false
	if (byName.rows.length === 0) {
		byName = await gridAll<RawLotContract>("VContracts", ["OfficialName", "contains", cyrName], LOT_SORT, "ugovori", { maxRows: MAX_CONTRACTS, deadline: contractDeadline })
		viaContains = true
	}
	let lots = byName.rows
	let total = byName.total
	let truncated = byName.truncated
	const key = (l: RawLotContract) => `${l.TenderId}|${l.LotId}|${l.ContractNo}`
	const olderNameRows = new Set<string>()

	// A renamed authority (e.g. "Javno preduzeće Putevi Srbije" -> "Društvo sa ograničenom odgovornošću Putevi Srbije", or
	// "Srbija Voz" -> "Srbijavoz") keeps its CAId, but older contracts carry the old OfficialName. They are older than what the new
	// name holds, so they are read only while the cap and the time budget leave room, and only when the tender belongs to THIS CAId.
	const cores = [...new Set([coreNameCyr(cyrName), ...otherNames.map((n) => coreNameCyr(latToCyr(n)))].filter((c) => c.length >= 8))]
	for (const [i, core] of cores.entries()) {
		if (lots.length >= MAX_CONTRACTS || Date.now() > contractDeadline) break
		const probe = await grid<RawLotContract>("VContracts", { filter: JSON.stringify(["OfficialName", "contains", core]), skip: "0", take: "1", requireTotalCount: "true" })
		const probeTotal = probe.totalCount ?? 0
		if (probeTotal === 0 || (i === 0 && probeTotal <= lots.length)) continue
		const have = new Set(lots.map(key))
		const more = await gridAll<RawLotContract>("VContracts", ["OfficialName", "contains", core], LOT_SORT, `ugovori (raniji naziv: ${cyrToLat(core)})`, { maxRows: MAX_CONTRACTS - lots.length, deadline: contractDeadline })
		const fresh = more.rows.filter((l) => !have.has(key(l)))
		for (const l of fresh) olderNameRows.add(key(l))
		lots = [...lots, ...fresh]
		total = Math.max(total, probeTotal)
		truncated ||= more.truncated
	}

	// procedures (type of procedure per contract) of the same period only: from the oldest tender among the contracts read
	const minTender = lots.length ? Math.min(...lots.map((l) => l.TenderId)) : 0
	const tenderDeadline = Math.max(Date.now() + 15_000, started + CRAWL_BUDGET_MS)
	const tendersCrawl = await gridAll<RawTender>(
		"TendersAll",
		minTender ? [["CAId", "=", Number(auth.id)], "and", ["Id", ">=", minTender]] : ["CAId", "=", Number(auth.id)],
		[{ selector: "Id", desc: true }],
		"postupci nabavki",
		{ deadline: tenderDeadline },
	)
	const tenders = tendersCrawl.rows
	// negotiated procedures without a public call: asked for directly (a few rows), so the list is complete for the whole analysed
	// period even when the crawl above stopped early
	const nwp = await gridAll<RawTender>(
		"TendersAll",
		[["CAId", "=", Number(auth.id)], "and", ["ProcedureTypeId", "=", NEGOTIATED_NO_PUBLICATION], ...(truncated && minTender ? ["and", ["Id", ">=", minTender]] : [])],
		[{ selector: "Id", desc: true }],
		"pregovarački postupci",
		{ maxRows: 300 },
	).catch(() => ({ rows: [] as RawTender[] }))
	const allTenders = [...new Map([...tenders, ...nwp.rows].map((t) => [t.Id, t])).values()]

	if (olderNameRows.size > 0 || viaContains) {
		const mine = new Set(allTenders.map((t) => t.Id))
		// a lot found by (partial) name that belongs to another body's tender is not this authority's contract
		if (mine.size > 0 && !tendersCrawl.truncated) lots = lots.filter((l) => mine.has(l.TenderId) || (!olderNameRows.has(key(l)) && !viaContains))
	}

	const dates = lots.map((l) => l.ContractDate?.slice(0, 10)).filter((d): d is string => !!d).sort()
	const coverage: Coverage = { total: Math.max(total, lots.length), analyzed: lots.length, truncated, from: dates[0], proceduresPartial: tendersCrawl.truncated || undefined }
	return JSON.stringify(buildStore(auth, lots, allTenders, coverage))
}
async function load(inst: InstLike): Promise<Loaded> {
	const auth = await resolveAuthority(inst)
	const key = cacheKey("contracts", auth.id)
	let p = memo.get(key)
	const first = !p
	if (!p) {
		p = (async () => {
			const env = await cached<string>(SOURCE, key, () => fetchStore(auth, institutionNames({ name: auth.name }).aliases), { meta: { authority: auth } })
			const store = JSON.parse(env.data) as Store
			await remember(store.authority)
			return { store, retrievedAt: env.retrievedAt, fromCache: env.fromCache }
		})()
		p.catch(() => memo.delete(key))
		memo.set(key, p)
	}
	const loaded = await p
	return { ...loaded, fromCache: first ? loaded.fromCache : true }
}

/** One live-search request for the contracts of an institution: a crawl (per-page activities inside) or a read of the cache. */
function loadTracked<T>(inst: InstLike, desc: { label: string; action?: "pretraga" | "preuzimanje" }, use: (l: Loaded) => T, after?: (result: T, l: Loaded) => { items?: number; label?: string }): Promise<T> {
	return trackActivity({ ...SRC.jn, action: desc.action ?? "preuzimanje", label: desc.label, url: authorityUrl(inst.name) }, async (h) => {
		const l = await load(inst)
		if (l.fromCache) h.cached(l.retrievedAt)
		const result = use(l)
		const extra = after?.(result, l)
		if (extra?.items !== undefined) h.items(extra.items)
		if (extra?.label) h.label(extra.label)
		return result
	})
}

function contractUrl(tenderId: number): string {
	return `${BASE}/tender-eo/${tenderId}`
}

function toContract(c: StoredContract, l: Loaded): Contract {
	const url = contractUrl(c.tenderId)
	const foreign = c.foreign ? ` [ugovor u ${c.foreign.currency}: ${c.foreign.value.toLocaleString("en-US")} bez PDV; nije preračunato u RSD]` : ""
	return {
		id: c.id,
		title: c.title + foreign,
		supplierName: c.supplierName,
		supplierPib: c.supplierPib,
		valueRsd: c.valueRsd,
		valueRsdWithVat: c.valueRsdWithVat,
		signedAt: c.signedAt,
		procedureType: c.procedureType,
		withoutPublication: c.procedureTypeId === NEGOTIATED_NO_PUBLICATION,
		cpv: c.cpv,
		url,
		source: {
			kind: "jnportal",
			title: `Portal javnih nabavki – ${l.store.authority.name}: ugovor ${c.contractNo}`,
			url,
			retrievedAt: l.retrievedAt,
			publishedAt: c.signedAt,
			official: true,
		},
	}
}

/** A negotiated procedure that has no published contract (yet): shown explicitly, never with an invented supplier. */
function procedureOnly(p: StoredProcedure, l: Loaded): Contract {
	const url = contractUrl(p.tenderId)
	const basis = p.legalBasis ? ` (${p.legalBasis})` : ""
	return {
		id: `postupak-${p.tenderId}`,
		title: p.title,
		supplierName: `(nema objavljenog ugovora; status postupka: ${p.status ?? "nepoznat"})`,
		procedureType: `${PROCEDURE_NAMES[NEGOTIATED_NO_PUBLICATION]}${basis}`,
		withoutPublication: true,
		cpv: p.cpv,
		url,
		signedAt: undefined,
		source: {
			kind: "jnportal",
			title: `Portal javnih nabavki – ${l.store.authority.name}: postupak ${p.refNo ?? p.tenderId}`,
			url,
			retrievedAt: l.retrievedAt,
			publishedAt: p.publishedAt,
			official: true,
		},
	}
}

const count = (n: number) => n.toLocaleString("sr-RS")

export async function getContracts(inst: InstLike): Promise<Contract[]> {
	return loadTracked(
		inst,
		{ label: `ugovori naručioca: ${shortInstitution(inst.name)}` },
		(l) => l.store.contracts.map((c) => toContract(c, l)),
		(r) => ({ items: r.length, label: `ugovori naručioca: ${shortInstitution(inst.name)} (${count(r.length)})` }),
	)
}

// ─── summary ─────────────────────────────────────────────────────────────────

const round2 = (n: number) => Math.round(n * 100) / 100
const byValueDesc = (a: Contract, b: Contract) => (b.valueRsd ?? -1) - (a.valueRsd ?? -1)

export function getSummary(inst: InstLike): Promise<ProcurementSummary> {
	return loadTracked(
		inst,
		{ label: `ugovori naručioca: ${shortInstitution(inst.name)}` },
		(l) => summarize(l),
		(r) => ({ items: r.totalContracts, label: `ugovori naručioca: ${shortInstitution(inst.name)} (${count(r.totalContracts)})` }),
	)
}

function summarize(l: Loaded): ProcurementSummary {
	const all = l.store.contracts
	const contracts = all.map((c) => toContract(c, l))
	const total = all.reduce((s, c) => s + (c.valueRsd ?? 0), 0)

	const years = new Map<number, { contracts: number; valueRsd: number }>()
	const suppliers = new Map<string, SupplierAggregate>()
	for (const c of all) {
		if (c.signedAt) {
			const y = Number(c.signedAt.slice(0, 4))
			const e = years.get(y) ?? { contracts: 0, valueRsd: 0 }
			e.contracts++
			e.valueRsd += c.valueRsd ?? 0
			years.set(y, e)
		}
		const key = c.pibs.length ? [...c.pibs].sort().join("+") : normalizeName(c.supplierName)
		const s = suppliers.get(key) ?? { name: c.supplierName, pib: c.supplierPib, contracts: 0, valueRsd: 0, share: 0 }
		s.contracts++
		s.valueRsd += c.valueRsd ?? 0
		if (c.signedAt) {
			if (!s.firstContractAt || c.signedAt < s.firstContractAt) s.firstContractAt = c.signedAt
			if (!s.lastContractAt || c.signedAt >= s.lastContractAt) {
				s.lastContractAt = c.signedAt
				s.name = c.supplierName // the supplier's name as of its latest contract
			}
		}
		suppliers.set(key, s)
	}
	const aggs = [...suppliers.values()].map((s) => ({ ...s, valueRsd: round2(s.valueRsd), share: total > 0 ? s.valueRsd / total : 0 }))
	aggs.sort((a, b) => b.valueRsd - a.valueRsd)
	const hhi = Math.round(aggs.reduce((s, a) => s + (a.share * 100) ** 2, 0))

	const withContract = new Set(all.filter((c) => c.procedureTypeId === NEGOTIATED_NO_PUBLICATION).map((c) => c.tenderId))
	const withoutPublication = [
		...contracts.filter((c) => c.withoutPublication),
		...l.store.negotiated.filter((p) => !withContract.has(p.tenderId)).map((p) => procedureOnly(p, l)),
	].sort((a, b) => (b.signedAt ?? b.source.publishedAt ?? "").localeCompare(a.signedAt ?? a.source.publishedAt ?? ""))

	const dates = all.map((c) => c.signedAt).filter((d): d is string => !!d).sort()
	return {
		institution: l.store.authority.name,
		coverage: l.store.coverage ?? { total: all.length, analyzed: all.length, truncated: false, from: all.map((c) => c.signedAt).filter((d): d is string => !!d).sort()[0] },
		totalContracts: all.length,
		totalValueRsd: round2(total),
		period: { from: dates[0], to: dates[dates.length - 1] },
		byYear: [...years.entries()].sort((a, b) => a[0] - b[0]).map(([year, v]) => ({ year, contracts: v.contracts, valueRsd: round2(v.valueRsd) })),
		topSuppliers: aggs.slice(0, 15),
		topContracts: [...contracts].sort(byValueDesc).slice(0, 10),
		withoutPublication,
		hhi,
		source: authoritySource(l.store.authority.name, l.retrievedAt),
	}
}

// ─── by supplier ─────────────────────────────────────────────────────────────

export function getContractsWithSupplier(inst: InstLike, supplier: { pib?: string; mb?: string; name?: string }): Promise<Contract[]> {
	const who = supplier.name?.trim() || (supplier.pib ? `PIB ${supplier.pib}` : supplier.mb ? `MB ${supplier.mb}` : "dobavljač")
	return loadTracked(
		inst,
		{ label: `ugovori dobavljača: ${who}`, action: "pretraga" },
		(l) => contractsWithSupplier(l, supplier),
		(r) => ({ items: r.length }),
	)
}

function contractsWithSupplier(l: Loaded, supplier: { pib?: string; mb?: string; name?: string }): Contract[] {
	const pib = supplier.pib?.replace(/\D/g, "")
	const name = supplier.name?.trim()
	const wanted = name ? normalizeName(name).split(" ").filter(Boolean) : []
	const nameMatches = (c: StoredContract) => {
		if (wanted.length === 0 || (wanted.length === 1 && wanted[0].length < 5)) return false
		// every member of a joint bid is tested on its own; all words of the wanted name must be present
		return c.supplierName
			.replace(/^Zajednička ponuda:\s*/i, "")
			.split(/,\s+/)
			.some((part) => {
				const words = new Set(normalizeName(part).split(" "))
				return wanted.every((w) => words.has(w))
			})
	}
	// the portal has no MB (matični broj); with only an MB nothing can be matched safely
	const hits = l.store.contracts.filter((c) => (pib ? c.pibs.includes(pib) : nameMatches(c)))
	return hits.map((c) => toContract(c, l)).sort(byValueDesc)
}
