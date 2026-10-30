// Probe for the APR index: name + MB lookups for well-known companies, index load time.
//   npx.cmd tsx scripts/probe-apr.ts

import { findInstitutionCompany, getCompany } from "../src/data/sources/apr"
import type { CompanyProfile } from "../src/data/types"

// expectMb: matični broj (MB) known independently of the index (only where the team knows it)
const CASES: { name: string; expectMb?: string; expectEmployees?: number }[] = [
	{ name: "Infrastruktura železnice Srbije a.d.", expectMb: "21127094" },
	{ name: "Telekom Srbija a.d.", expectMb: "17162543", expectEmployees: 9152 },
	{ name: "Železnice Srbije a.d." },
	{ name: "Javno preduzeće Elektroprivreda Srbije", expectMb: "20053658" },
	{ name: "Srbijagas" },
	{ name: "Pošta Srbije" },
	{ name: "Naftna industrija Srbije a.d.", expectMb: "20084693" },
	{ name: "Air Serbia a.d. Beograd" },
	{ name: "Putevi Srbije" },
	{ name: "Koridori Srbije d.o.o." },
	{ name: "Aerodrom Nikola Tesla a.d." },
	{ name: "Galenika a.d." },
]

function line(p: CompanyProfile | null): string {
	if (!p) return "null"
	const rev = p.revenueRsd !== undefined ? `${(p.revenueRsd / 1e6).toFixed(0)}M RSD (${p.revenueYear})` : "n/a"
	return `MB ${p.mb} | ${p.name.slice(0, 70)} | osn. ${p.founded ?? "?"} | ${p.municipality ?? "?"} | KD ${p.activityCode ?? "?"} | ${p.legalForm ?? "?"} | ${p.status ?? "?"} | prihod ${rev} | zaposleni ${p.employees ?? "n/a"}`
}

async function main() {
	const t0 = performance.now()
	await getCompany({ mb: "21127094" })
	console.log(`index load + first lookup: ${(performance.now() - t0).toFixed(0)} ms`)

	let t1 = performance.now()
	for (let i = 0; i < 200; i++) await getCompany({ mb: "17162543" })
	console.log(`200 MB lookups: ${(performance.now() - t1).toFixed(1)} ms`)

	t1 = performance.now()
	await findInstitutionCompany("Primer koji sigurno ne postoji d.o.o.")
	console.log(`first fuzzy name lookup (builds token index): ${(performance.now() - t1).toFixed(0)} ms`)
	console.log("")

	for (const c of CASES) {
		const t = performance.now()
		const strict = await getCompany({ name: c.name })
		const lenient = strict ?? (await findInstitutionCompany(c.name))
		const ms = (performance.now() - t).toFixed(0)
		console.log(`# ${c.name}  [${strict ? "name>=0.8" : lenient ? "lenient" : "no match"}, ${ms} ms]`)
		console.log(`  by name: ${line(lenient)}`)
		if (lenient) {
			const byMb = await getCompany({ mb: lenient.mb })
			console.log(`  by MB:   ${byMb?.name === lenient.name ? "same record" : "MISMATCH " + line(byMb)}`)
		}
		if (c.expectMb) {
			const byExpected = await getCompany({ mb: c.expectMb })
			console.log(`  expected MB ${c.expectMb}: ${byExpected ? "found: " + byExpected.name.slice(0, 60) : "NOT FOUND"}${lenient && lenient.mb !== c.expectMb ? "  <-- name lookup returned a different MB" : ""}`)
		}
		if (c.expectEmployees !== undefined && lenient) {
			console.log(`  employees ${lenient.employees} (expected ${c.expectEmployees}): ${lenient.employees === c.expectEmployees ? "OK" : "DIFFERENT"}`)
		}
	}

	console.log("")
	console.log("PIB only:", await getCompany({ pib: "100002532" }))
	console.log("unknown MB:", await getCompany({ mb: "99999999" }))
	console.log("short MB 7 digits padded:", (await getCompany({ mb: "7036540" }))?.mb)
	console.log("ambiguous short name 'Telekom':", (await getCompany({ name: "Telekom" }))?.name ?? null)
	const ixs = await getCompany({ mb: "21127094" })
	console.log("\nSourceRef:", JSON.stringify(ixs?.source, null, 1))
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})

