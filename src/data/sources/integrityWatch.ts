// Integrity Watch Srbija (Transparentnost Srbija): open CSV of public-procurement contracts 2021 -> 2026
// with flags for suppliers linked to public officials or to political parties.
// Datasets (all public, see docs/data-sources/integrity-watch.md):
//   data/downloadable_csv_xls/contracts_full.csv   ~100 MB, one row per contract lot, 19 columns
//   data/companies_close_to_parties.csv            pib, company_name, source (media article used for the link)
//   data/companies_income.json                     MBR (matični broj) + PIB for companies with party links
// The big CSV is downloaded to data/raw/iw/ (gitignored) and reduced to a compact index that is committed to data/cache/integrity_watch/.

import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { parse } from "csv-parse"
import { parse as parseSync } from "csv-parse/sync"
import { cached, cacheKey, getDataMode, readCache } from "../cache"
import { getBuffer, getJson, getText } from "../http"
import { nameSimilarity, normalizeName } from "../translit"
import type { IntegrityWatchLink } from "../types"
import type { SourceRef } from "../../shared/types"

const SOURCE = "integrity_watch"
const IW = "https://integritywatchserbia.org.rs"
const CSV_URL = `${IW}/data/downloadable_csv_xls/contracts_full.csv`
const PARTIES_URL = `${IW}/data/companies_close_to_parties.csv`
const INCOME_URL = `${IW}/data/companies_income.json`
const RAW_DIR = path.resolve(process.cwd(), "data", "raw", "iw")
const RAW_CSV = path.join(RAW_DIR, "contracts_full.csv")

type Kind = "official" | "political"

interface IwItem {
	tenderId: string
	contractNo: string
	date: string
	valueRsd?: number
	title: string
}

/** One supplier flagged for one contracting authority. */
interface IwPair {
	authority: string
	pib: string
	name: string
	kinds: Kind[]
	contracts: number
	valueRsd: number // only contracts where the flagged firm is the sole supplier (RSD)
	joint: number // contracts where it bid together with other firms
	jointValueRsd: number
	first?: string
	last?: string
	top: IwItem[]
}

interface IwIndex {
	version: 1
	csvRows: number
	flaggedRows: number
	years: string[]
	pairs: IwPair[]
	mbByPib: Record<string, string>
	parties: Record<string, { name: string; source: string }>
}

const LINK_TYPES: Record<Kind, string> = {
	official: "povezanost sa javnim funkcionerom",
	political: "povezanost sa političkim subjektom",
}

function pibList(cell: string | undefined): string[] {
	return cell && cell !== "[]" ? (cell.match(/\d{6,}/g) ?? []) : []
}

function splitPibs(cell: string): string[] {
	return cell
		.split(/[,;\s]+/)
		.map((p) => p.trim())
		.filter(Boolean)
}

async function downloadRaw(force: boolean): Promise<string> {
	if (!force && fs.existsSync(RAW_CSV)) return RAW_CSV
	await fsp.mkdir(RAW_DIR, { recursive: true })
	const buf = await getBuffer(CSV_URL, { timeoutMs: 600000, retries: 1 })
	await fsp.writeFile(RAW_CSV, buf)
	return RAW_CSV
}

async function buildIndex(): Promise<string> {
	const file = await downloadRaw(getDataMode() === "live")

	const parties: IwIndex["parties"] = {}
	const partyRows = parseSync(await getText(PARTIES_URL), { skip_empty_lines: true, relax_column_count: true }) as string[][]
	for (const [pib, name, source] of partyRows.slice(1)) {
		if (pib && /^\d+$/.test(pib)) parties[pib] = { name: name ?? "", source: source ?? "" }
	}
	const mbByPib: IwIndex["mbByPib"] = {}
	try {
		const income = await getJson<{ MBR?: string; PIB?: string }[]>(INCOME_URL)
		for (const c of income) if (c.PIB && c.MBR) mbByPib[String(c.PIB)] = String(c.MBR)
	} catch {
		// MB is a nice-to-have
	}

	const pairs = new Map<string, IwPair>()
	const singleNames = new Map<string, Map<string, number>>()
	const years = new Set<string>()
	let csvRows = 0
	let flaggedRows = 0

	const stream = fs.createReadStream(file).pipe(parse({ columns: true, relax_quotes: true, relax_column_count: true, skip_empty_lines: true }))
	for await (const r of stream as AsyncIterable<Record<string, string>>) {
		csvRows++
		if (r.Year) years.add(r.Year)
		const officials = pibList(r.ContractorCompaniesRealtedToPublicOfficial)
		const political = pibList(r.ContractorCompaniesWithPoliticalRelations)
		const ids = splitPibs(r.ContractorIDs ?? "")
		if (ids.length === 1 && r.ContractorsNames) {
			const m = singleNames.get(ids[0]) ?? new Map()
			m.set(r.ContractorsNames, (m.get(r.ContractorsNames) ?? 0) + 1)
			singleNames.set(ids[0], m)
		}
		if (officials.length === 0 && political.length === 0) continue
		flaggedRows++

		const names = (r.ContractorsNames ?? "").split(", ")
		const value = r.Currency === "RSD" && r.LotContractedValue ? Number(r.LotContractedValue) : undefined
		const flagged = new Map<string, Kind[]>()
		for (const p of officials) flagged.set(p, [...(flagged.get(p) ?? []), "official"])
		for (const p of political) flagged.set(p, [...(flagged.get(p) ?? []), "political"])
		for (const [pib, kinds] of flagged) {
			const idx = ids.indexOf(pib)
			const name = ids.length === 1 ? r.ContractorsNames : ids.length === names.length && idx >= 0 ? names[idx] : ""
			const key = `${r.OfficialName}|${pib}`
			const pair =
				pairs.get(key) ??
				({ authority: r.OfficialName, pib, name, kinds: [], contracts: 0, valueRsd: 0, joint: 0, jointValueRsd: 0, top: [] } satisfies IwPair)
			if (!pair.name && name) pair.name = name
			for (const k of kinds) if (!pair.kinds.includes(k)) pair.kinds.push(k)
			pair.contracts++
			const sole = ids.length === 1
			if (sole) pair.valueRsd += value ?? 0
			else {
				pair.joint++
				pair.jointValueRsd += value ?? 0
			}
			if (r.ContractDate) {
				if (!pair.first || r.ContractDate < pair.first) pair.first = r.ContractDate
				if (!pair.last || r.ContractDate > pair.last) pair.last = r.ContractDate
			}
			pair.top.push({ tenderId: r.TenderId, contractNo: r.ContractNo, date: r.ContractDate, valueRsd: value, title: (r.TenderName ?? "").slice(0, 120) })
			pair.top.sort((a, b) => (b.valueRsd ?? 0) - (a.valueRsd ?? 0))
			if (pair.top.length > 5) pair.top.length = 5
			pairs.set(key, pair)
		}
	}

	for (const p of pairs.values()) {
		if (!p.name) {
			const m = singleNames.get(p.pib)
			p.name = m ? [...m.entries()].sort((a, b) => b[1] - a[1])[0][0] : parties[p.pib]?.name || `PIB ${p.pib}`
		}
		p.valueRsd = Math.round(p.valueRsd * 100) / 100
		p.jointValueRsd = Math.round(p.jointValueRsd * 100) / 100
	}
	const flaggedPibs = new Set([...pairs.values()].map((p) => p.pib))
	const index: IwIndex = {
		version: 1,
		csvRows,
		flaggedRows,
		years: [...years].filter((y) => /^\d{4}$/.test(y)).sort(),
		pairs: [...pairs.values()],
		mbByPib: Object.fromEntries(Object.entries(mbByPib).filter(([pib]) => flaggedPibs.has(pib) || parties[pib])),
		parties,
	}
	return JSON.stringify(index)
}

interface LoadedIndex {
	index: IwIndex
	retrievedAt: string
}

let indexPromise: Promise<LoadedIndex> | null = null

function loadIndex(): Promise<LoadedIndex> {
	indexPromise ??= cached<string>(SOURCE, "index", buildIndex, { meta: { csv: CSV_URL, note: "flagged suppliers only" } })
		.then((env) => ({ index: JSON.parse(env.data) as IwIndex, retrievedAt: env.retrievedAt }))
		.catch((err) => {
			indexPromise = null
			throw err
		})
	return indexPromise
}

// ─── links ───────────────────────────────────────────────────────────────────

function money(n: number): string {
	return `${Math.round(n).toLocaleString("en-US")} RSD`
}

function sourceFor(kind: Kind, retrievedAt: string, what: string): SourceRef {
	return {
		kind: "integrity_watch",
		title: `Integrity Watch Srbija – ${what}`,
		url: kind === "political" ? `${IW}/companies.php?l=sr` : `${IW}/?l=sr`,
		retrievedAt,
		official: false,
	}
}

function linksFromPair(p: IwPair, idx: IwIndex, retrievedAt: string): IntegrityWatchLink[] {
	const mb = idx.mbByPib[p.pib]
	return p.kinds.map((kind) => {
		const parts: string[] = []
		if (kind === "official")
			parts.push("Integrity Watch označava ponuđača kao firmu povezanu sa javnim funkcionerom (ime funkcionera nije deo otvorenih podataka)")
		else {
			parts.push("Integrity Watch označava ponuđača kao kompaniju povezanu sa političkim subjektom")
			const party = idx.parties[p.pib]
			if (party?.source) parts.push(`izvor povezivanja: ${party.source}`)
		}
		parts.push(`označenih ugovora kod naručioca: ${p.contracts}`)
		if (p.joint > 0) parts.push(`od toga u zajedničkoj ponudi: ${p.joint} (vrednost cele ponude ${money(p.jointValueRsd)}, nije pripisana firmi)`)
		if (p.first && p.last) parts.push(`period: ${p.first} do ${p.last}`)
		const biggest = p.top[0]
		if (biggest?.valueRsd) parts.push(`najveći: ${biggest.contractNo} (${biggest.date}, ${money(biggest.valueRsd)})`)
		return {
			supplierName: p.name,
			supplierPib: p.pib,
			supplierMb: mb,
			contractingAuthority: p.authority,
			linkType: LINK_TYPES[kind],
			detail: parts.join("; "),
			contracts: p.contracts,
			valueRsd: p.joint === p.contracts ? undefined : p.valueRsd,
			source: sourceFor(kind, retrievedAt, `${p.name} / ${p.authority}`),
		}
	})
}

function partyOnlyLink(pib: string, idx: IwIndex, retrievedAt: string): IntegrityWatchLink {
	const party = idx.parties[pib]
	return {
		supplierName: party.name,
		supplierPib: pib,
		supplierMb: idx.mbByPib[pib],
		linkType: LINK_TYPES.political,
		detail: `Integrity Watch označava kompaniju kao povezanu sa političkim subjektom; izvor povezivanja: ${party.source}`,
		source: sourceFor("political", retrievedAt, party.name),
	}
}

/** Derived results are cached too, but a miss in DATA_MODE=cache falls back to the committed index. */
async function derived<T>(key: string, compute: () => Promise<T>): Promise<T> {
	if (getDataMode() === "cache") {
		const hit = await readCache<T>(SOURCE, key)
		return hit ? hit.data : compute()
	}
	return (await cached(SOURCE, key, compute)).data
}

const byWeight = (a: IwPair, b: IwPair) => b.valueRsd + b.jointValueRsd - (a.valueRsd + a.jointValueRsd)

function sameAuthority(a: string, b: string): boolean {
	return normalizeName(a) === normalizeName(b) || nameSimilarity(a, b) >= 0.85
}

export async function getLinksForAuthority(inst: { name: string; pib?: string }): Promise<IntegrityWatchLink[]> {
	return derived(cacheKey("authority", inst.name), async () => {
		const { index, retrievedAt } = await loadIndex()
		return index.pairs
			.filter((p) => sameAuthority(p.authority, inst.name))
			.sort(byWeight)
			.flatMap((p) => linksFromPair(p, index, retrievedAt))
	})
}

export async function getLinksForSupplier(s: { pib?: string; mb?: string; name?: string }): Promise<IntegrityWatchLink[]> {
	const keyPart = s.pib ?? s.mb ?? s.name
	if (!keyPart) return []
	return derived(cacheKey("supplier", keyPart), async () => {
		const { index, retrievedAt } = await loadIndex()
		let pib = s.pib?.replace(/\D/g, "")
		if (!pib && s.mb) pib = Object.entries(index.mbByPib).find(([, mb]) => mb === s.mb)?.[0]
		const pairs = pib
			? index.pairs.filter((p) => p.pib === pib)
			: index.pairs.filter((p) => !!s.name && nameSimilarity(p.name, s.name) >= 0.9)
		const links = [...pairs].sort(byWeight).flatMap((p) => linksFromPair(p, index, retrievedAt))
		if (links.length === 0 && pib && index.parties[pib]) links.push(partyOnlyLink(pib, index, retrievedAt))
		return links
	})
}
