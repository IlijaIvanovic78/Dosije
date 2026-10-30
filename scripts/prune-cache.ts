// Lists (and with --delete removes) cache files that no run reads any more, so the committed cache stays coherent.
//   CACHE_TRACE=out/cache-trace.txt  <run the cases / npm run qa / npm test / npm run mapa>
//   npx.cmd tsx scripts/prune-cache.ts out/cache-trace.txt [--sources vesti,integrity_watch] [--delete]
// Only the listed sources are touched (default: vesti: old news queries and articles); everything else is just reported.
// A news article stays when a cached search result still links to it (the agents may read it).

import fs from "node:fs"
import path from "node:path"

const args = process.argv.slice(2)
const traceFile = args.find((a) => !a.startsWith("--"))
if (!traceFile) {
	console.error("usage: prune-cache.ts <trace file> [--sources a,b] [--delete]")
	process.exit(2)
}
const del = args.includes("--delete")
const sources = (args.includes("--sources") ? args[args.indexOf("--sources") + 1] : "vesti").split(",")
const root = path.resolve(process.cwd(), "data", "cache")
const used = new Set(fs.readFileSync(traceFile, "utf8").split(/\r?\n/).filter(Boolean))

// articles still linked from a search result that is itself in use
const linked = new Set<string>()
for (const f of used) {
	if (!f.startsWith("vesti/search-")) continue
	const env = JSON.parse(fs.readFileSync(path.join(root, f), "utf8")) as { data: { url: string }[] }
	for (const i of env.data) linked.add(i.url)
}

let removed = 0
let kept = 0
for (const source of fs.readdirSync(root)) {
	for (const file of fs.readdirSync(path.join(root, source))) {
		const rel = `${source}/${file}`
		if (used.has(rel)) {
			kept++
			continue
		}
		if (source === "vesti" && file.startsWith("article-")) {
			const env = JSON.parse(fs.readFileSync(path.join(root, rel), "utf8")) as { data: { url: string } }
			if (linked.has(env.data.url)) {
				kept++
				continue
			}
		}
		const act = del && sources.includes(source)
		console.log(`${act ? "obrisan " : "nekorišćen"} ${rel}`)
		if (act) {
			fs.rmSync(path.join(root, rel))
			removed++
		}
	}
}
console.log(`\nzadržano ${kept}, ${del ? `obrisano ${removed}` : "ništa nije obrisano (dodaj --delete)"}`)
