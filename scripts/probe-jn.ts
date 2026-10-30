// Live probe + cache warmer for Portal javnih nabavki and Integrity Watch Srbija (demo institution: IŽS).
// PowerShell: $env:DATA_MODE="live"; npx.cmd tsx scripts/probe-jn.ts      (refreshes data/cache/jnportal and integrity_watch)
//             $env:DATA_MODE="cache"; npx.cmd tsx scripts/probe-jn.ts     (proves the offline path)

import { getDataMode } from "../src/data/cache"
import { getLinksForAuthority, getLinksForSupplier } from "../src/data/sources/integrityWatch"
import { findAuthority, getContracts, getContractsWithSupplier, getSummary } from "../src/data/sources/jnportal"

const QUERY = process.argv[2] ?? "Infrastruktura železnice Srbije"
const rsd = (n?: number) => (n === undefined ? "-" : `${Math.round(n).toLocaleString("en-US")}`)
const short = (s: string, n = 48) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

async function main() {
	console.log(`DATA_MODE=${getDataMode()} query="${QUERY}"`)
	const t0 = Date.now()
	const lap = (label: string) => console.log(`  (${label}: ${((Date.now() - t0) / 1000).toFixed(1)} s)`)

	console.log("\n== findAuthority")
	const auths = await findAuthority(QUERY)
	for (const a of auths.slice(0, 5)) console.log(` ${a.id} | ${a.name} | PIB ${a.pib ?? "-"} | ${a.source.url.slice(0, 90)}`)
	const auth = auths[0]
	if (!auth) throw new Error("no authority found")
	const inst = { jnId: auth.id, name: auth.name, pib: auth.pib }
	lap("findAuthority")

	console.log("\n== getContracts")
	const contracts = await getContracts(inst)
	const withPib = contracts.filter((c) => c.supplierPib).length
	console.log(` ${contracts.length} contracts, ${withPib} with supplier PIB, ${contracts.filter((c) => c.withoutPublication).length} without publication`)
	for (const c of contracts.slice(0, 3)) console.log(` ${c.signedAt} | ${short(c.supplierName, 30)} | ${c.supplierPib} | ${rsd(c.valueRsd)} | ${short(c.title, 50)} | ${c.url}`)
	lap("getContracts")

	console.log("\n== getSummary")
	const sum = await getSummary(inst)
	console.log(` ${sum.institution}: ${sum.totalContracts} contracts, ${rsd(sum.totalValueRsd)} RSD (without VAT), period ${sum.period.from}..${sum.period.to}, HHI ${sum.hhi}`)
	console.log(` byYear: ${sum.byYear.map((y) => `${y.year}:${y.contracts}/${rsd(y.valueRsd / 1e6)}M`).join("  ")}`)
	console.log(" topSuppliers:")
	for (const s of sum.topSuppliers) console.log(`  ${(s.share * 100).toFixed(1).padStart(5)}% | ${rsd(s.valueRsd).padStart(16)} | ${String(s.contracts).padStart(3)} | PIB ${s.pib ?? "-"} | ${short(s.name, 70)}`)
	console.log(" topContracts:")
	for (const c of sum.topContracts.slice(0, 5)) console.log(`  ${rsd(c.valueRsd).padStart(16)} | ${c.signedAt} | ${short(c.supplierName, 36)} | ${short(c.title, 50)}`)
	console.log(` withoutPublication (${sum.withoutPublication.length}):`)
	for (const c of sum.withoutPublication)
		console.log(`  ${c.signedAt ?? `(objavljeno ${c.source.publishedAt})`} | ${rsd(c.valueRsd).padStart(12)} | ${short(c.supplierName, 50)} | ${short(c.title, 60)} | ${c.procedureType?.replace("Pregovarački postupak bez objavljivanja javnog poziva", "PPBOJP")}`)
	lap("getSummary")

	console.log("\n== getContractsWithSupplier (top 15)")
	for (const s of sum.topSuppliers) {
		const hits = await getContractsWithSupplier(inst, { pib: s.pib, name: s.name })
		const total = hits.reduce((n, c) => n + (c.valueRsd ?? 0), 0)
		console.log(` ${String(hits.length).padStart(3)} contracts | ${rsd(total).padStart(16)} | PIB ${s.pib} | ${short(s.name, 50)}`)
	}
	const byName = await getContractsWithSupplier(inst, { name: "Trnex" })
	console.log(` by name "Trnex": ${byName.length} contracts`)
	lap("getContractsWithSupplier")

	console.log("\n== Integrity Watch: getLinksForAuthority")
	const links = await getLinksForAuthority({ name: auth.name, pib: auth.pib })
	console.log(` ${links.length} links`)
	for (const l of links) console.log(`  ${l.linkType} | ${short(l.supplierName, 40)} | PIB ${l.supplierPib} | MB ${l.supplierMb ?? "-"} | ${l.contracts} ugovora | ${rsd(l.valueRsd)} RSD`)
	lap("IW authority")

	console.log("\n== Integrity Watch: getLinksForSupplier (IŽS top 15 suppliers)")
	const seen = new Set<string>()
	for (const s of sum.topSuppliers) {
		const key = s.pib ?? s.name
		if (seen.has(key)) continue
		seen.add(key)
		const ls = await getLinksForSupplier({ pib: s.pib, name: s.name })
		const kinds = [...new Set(ls.map((l) => l.linkType))].join(", ") || "nema veze u bazi"
		console.log(` PIB ${s.pib} | ${short(s.name, 40)} | ${ls.length} links | ${kinds}`)
	}
	for (const l of links) {
		if (!l.supplierPib || seen.has(l.supplierPib)) continue
		seen.add(l.supplierPib)
		const ls = await getLinksForSupplier({ pib: l.supplierPib })
		console.log(` PIB ${l.supplierPib} | ${short(l.supplierName, 40)} | ${ls.length} links across ${new Set(ls.map((x) => x.contractingAuthority)).size} authorities`)
	}
	lap("IW supplier")
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
