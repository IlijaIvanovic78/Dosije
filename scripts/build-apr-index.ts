// Downloads the APR open data (companies + financial statements), joins them by matični broj
// and writes a compact gzipped index to data/static/apr-index.json.gz (committed, works offline).
//
//   npx.cmd tsx scripts/build-apr-index.ts            download (unless data/raw/apr/*.json exist) and build
//   npx.cmd tsx scripts/build-apr-index.ts --refresh  force a new download

import fs from "node:fs"
import path from "node:path"
import zlib from "node:zlib"
import { httpRequest } from "../src/data/http"
import { aprNormalize } from "../src/data/sources/aprNames"
import { cyrToLat } from "../src/data/translit"

const ROOT = process.cwd()
const CA_FILE = path.join("certs", "apr-chain.pem")
const RAW_DIR = path.join(ROOT, "data", "raw", "apr")
const OUT_FILE = path.join(ROOT, "data", "static", "apr-index.json.gz")

export const COMPANIES_URL = "https://openapi.apr.gov.rs/api/opendata/companies"
export const FINANCIALS_URL = "https://openapi.apr.gov.rs/api/opendata/companies/financial-statements"

interface RawCompany {
	PoslovnoIme: string
	NazivOpstine?: string
	NazivStatus?: string
	DatumOsnivanja?: string
	NazivPravneForme?: string
	SifraDelatnosti?: string
}
interface RawFinancial {
	GodinaFi?: number
	UkupniPrihodi?: number
	ProsecanBrojZaposlenih?: number
}
interface RawDump<T> {
	DatumPreseka: string
	Podaci: Record<string, T>
}

async function download(url: string, file: string): Promise<void> {
	const t0 = Date.now()
	const res = await httpRequest(url, { caFile: CA_FILE, timeoutMs: 180_000, retries: 3 })
	fs.mkdirSync(path.dirname(file), { recursive: true })
	fs.writeFileSync(file, res.buffer)
	console.log(`downloaded ${url} -> ${path.relative(ROOT, file)} (${(res.buffer.length / 1e6).toFixed(1)} MB, ${Date.now() - t0} ms)`)
}

function normalizeMb(raw: string): string {
	const digits = raw.trim()
	return /^\d+$/.test(digits) ? digits.padStart(8, "0") : digits
}

function titleCase(s: string): string {
	return s.toLowerCase().replace(/(^|[\s\-(])(\p{L})/gu, (_, p: string, c: string) => p + c.toUpperCase())
}

function latinLabel(s: string | undefined): string | undefined {
	const t = s?.trim()
	return t ? cyrToLat(t) : undefined
}

function intern(list: string[], map: Map<string, number>, value: string | undefined): number {
	if (value === undefined) return -1
	let i = map.get(value)
	if (i === undefined) {
		i = list.length
		list.push(value)
		map.set(value, i)
	}
	return i
}

async function main() {
	const refresh = process.argv.includes("--refresh")
	const companiesFile = path.join(RAW_DIR, "companies.json")
	const financialsFile = path.join(RAW_DIR, "financial-statements.json")
	if (refresh || !fs.existsSync(companiesFile)) await download(COMPANIES_URL, companiesFile)
	if (refresh || !fs.existsSync(financialsFile)) await download(FINANCIALS_URL, financialsFile)

	const companies = JSON.parse(fs.readFileSync(companiesFile, "utf8")) as RawDump<RawCompany>
	const financials = JSON.parse(fs.readFileSync(financialsFile, "utf8")) as RawDump<RawFinancial>

	const fin = new Map<string, RawFinancial>()
	for (const [k, v] of Object.entries(financials.Podaci)) fin.set(normalizeMb(k), v)

	const municipalities: string[] = []
	const legalForms: string[] = []
	const statuses: string[] = []
	const munMap = new Map<string, number>()
	const formMap = new Map<string, number>()
	const statusMap = new Map<string, number>()

	// row: [name, founded, municipalityIdx, activityCode, legalFormIdx, statusIdx, revenueRsd|null, revenueYear|null, employees|null]
	const rows: Record<string, unknown[]> = {}
	const names: Record<string, string | string[]> = {}
	let withFin = 0
	let matchedFin = 0

	for (const [rawMb, c] of Object.entries(companies.Podaci)) {
		const mb = normalizeMb(rawMb)
		const name = latinLabel(c.PoslovnoIme)?.replace(/\s+/g, " ")
		if (!name) continue
		const f = fin.get(mb)
		if (f) matchedFin++
		const hasRevenue = f && typeof f.UkupniPrihodi === "number"
		if (hasRevenue) withFin++
		rows[mb] = [
			name,
			c.DatumOsnivanja ?? "",
			intern(municipalities, munMap, c.NazivOpstine ? titleCase(cyrToLat(c.NazivOpstine.trim())) : undefined),
			c.SifraDelatnosti?.trim() ?? "",
			intern(legalForms, formMap, latinLabel(c.NazivPravneForme)),
			intern(statuses, statusMap, latinLabel(c.NazivStatus)),
			// RGFI amounts are in thousands of RSD
			hasRevenue ? Math.round(f.UkupniPrihodi! * 1000) : null,
			f?.GodinaFi ?? null,
			typeof f?.ProsecanBrojZaposlenih === "number" ? f.ProsecanBrojZaposlenih : null,
		]
		const key = aprNormalize(name)
		if (!key) continue
		const prev = names[key]
		if (prev === undefined) names[key] = mb
		else if (Array.isArray(prev)) prev.push(mb)
		else names[key] = [prev, mb]
	}

	const index = {
		version: 1,
		builtAt: new Date().toISOString(),
		companiesDate: companies.DatumPreseka,
		financialsDate: financials.DatumPreseka,
		units: "revenueRsd = UkupniPrihodi (AOP 1043) x 1000 (RGFI reports are in thousands of RSD)",
		fields: ["name", "founded", "municipalityIdx", "activityCode", "legalFormIdx", "statusIdx", "revenueRsd", "revenueYear", "employees"],
		municipalities,
		legalForms,
		statuses,
		rows,
		names,
	}

	const json = JSON.stringify(index)
	const gz = zlib.gzipSync(json, { level: 9 })
	fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true })
	fs.writeFileSync(OUT_FILE, gz)

	console.log(`companies: ${Object.keys(rows).length}, with financials: ${withFin} (financial rows matched ${matchedFin} of ${fin.size}; ${fin.size - matchedFin} not in register file)`)
	console.log(`name keys: ${Object.keys(names).length}`)
	console.log(`json ${(json.length / 1e6).toFixed(1)} MB -> gz ${(gz.length / 1e6).toFixed(2)} MB at ${path.relative(ROOT, OUT_FILE)}`)
	console.log(`companies cut-off ${companies.DatumPreseka}, financials cut-off ${financials.DatumPreseka}`)
	if (gz.length > 15e6) console.warn("WARNING: index is larger than 15 MB, drop fields")
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
