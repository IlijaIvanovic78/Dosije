// Markdown dossier for the journalist: disclaimer, lede, top signals, sections, source conflicts, "what still needs to be
// verified", deduplicated sources and how the dossier was made (agents, events, peak concurrency, duration).

import { config } from "../config"
import { LEGAL_LABELS } from "../data/resolver"
import type { ClaimStatus, DosijeReport, Finding, Section, Severity, SourceRef } from "../shared/types"
import type { DosijeState, Summary } from "./state"
import { findingScore } from "./summary"
import { hostOf, nowIso, normUrl } from "./util"

const STATUS_LABEL: Record<ClaimStatus, string> = { zvanicno: "zvanično", potvrdjeno: "potvrđeno", nepotvrdjeno: "nepotvrđeno", demantovano: "demantovano" }
const SEVERITY_LABEL: Record<Severity, string> = { signal: "signal za proveru", paznja: "pažnja", info: "informacija" }
const SECTIONS: [Section, string][] = [
	["rukovodstvo", "Rukovodstvo"],
	["novac", "Novac i nabavke"],
	["firme", "Firme"],
	["revizija", "Revizija (DRI)"],
	["mediji", "Mediji"],
]

export function formatDateSr(iso?: string): string {
	const m = iso ? /^(\d{4})-(\d{2})-(\d{2})/.exec(iso) : null
	return m ? `${m[3]}.${m[2]}.${m[1]}.` : ""
}

function formatDuration(ms: number): string {
	const s = Math.round(ms / 1000)
	return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`
}

function sourceLine(s: SourceRef): string {
	const date = formatDateSr(s.publishedAt)
	return `- [${s.title.replace(/[\[\]]/g, "")}](${s.url})${date ? ` (${date})` : ""}${s.official ? " · zvanični izvor" : ""}`
}

function findingBlock(f: Finding): string[] {
	const title = f.status === "demantovano" ? `~~${f.title}~~` : f.title
	const meta = [
		`status: ${STATUS_LABEL[f.status]}`,
		SEVERITY_LABEL[f.severity],
		f.signalCode ? `oznaka: ${f.signalCode}` : "",
		f.approval === "approved" ? "odobrio novinar" : f.approval === "pending" ? "čeka odluku novinara" : "",
		`dodao ${f.agentName}`,
		f.mergedFrom?.length ? `spojeno iz ${f.mergedFrom.length + 1} nalaza` : "",
	].filter(Boolean)
	return [`### ${title}`, "", f.text, "", `*${meta.join(" · ")}*`, ...(f.note ? ["", `> ${f.note}`] : []), "", ...f.sources.map(sourceLine), ""]
}

export function buildReport(state: DosijeState, summary: Summary): DosijeReport {
	const inst = state.institution
	const findings = state.findingList()
	const stats = state.refreshStats()
	const bySection = (s: Section) => findings.filter((f) => f.section === s).sort((a, b) => findingScore(b) - findingScore(a) || a.createdAt.localeCompare(b.createdAt))
	const counts: Record<ClaimStatus, number> = { zvanicno: 0, potvrdjeno: 0, nepotvrdjeno: 0, demantovano: 0 }
	for (const f of findings) counts[f.status]++

	const lines: string[] = []
	lines.push(`# Dosije: ${inst?.name ?? "institucija"}`, "")
	lines.push(
		"> **Ovo su signali za proveru, ne zaključci.** Dosije je napravio tim AI agenata iz javno dostupnih izvora (ACAS, Portal javnih nabavki, APR, DRI, mediji, Integrity Watch). Svaki nalaz ima izvor i status; ništa ovde nije optužba niti dokaz nepravilnosti. Pre objavljivanja proveri izvore i traži odgovor institucije. Odluku donosi novinar.",
		"",
	)
	const ids = [inst?.pib ? `PIB ${inst.pib}` : "", inst?.mb ? `MB ${inst.mb}` : "", inst?.acasId ? `ACAS ID ${inst.acasId}` : "", inst?.jnId ? `JN ID ${inst.jnId}` : ""].filter(Boolean).join(" · ")
	lines.push(
		`**Institucija:** ${inst?.name ?? ""}${inst?.nameCyr ? ` (${inst.nameCyr})` : ""} · ${inst?.legalType ?? ""}${ids ? ` · ${ids}` : ""}  `,
		`**Generisano:** ${new Date().toLocaleString("sr-RS", { timeZone: "Europe/Belgrade" })} · slučaj ${state.caseId}${state.focus ? ` · fokus: ${state.focus}` : ""}`,
		"",
	)

	lines.push("## Pregled", "", summary.lede, "")
	lines.push("| Status nalaza | Broj |", "|---|---|", ...(Object.keys(STATUS_LABEL) as ClaimStatus[]).map((s) => `| ${STATUS_LABEL[s]} | ${counts[s]} |`), "")

	lines.push("## Glavni signali", "")
	if (summary.topSignals.length === 0) lines.push("_Nema nalaza koji su označeni kao signal._", "")
	summary.topSignals.forEach((t, i) => {
		const f = state.findings.get(t.findingId)
		lines.push(`${i + 1}. **${t.headline}**${f ? ` (${STATUS_LABEL[f.status]}${f.sources[0] ? `; izvor: ${f.sources[0].title.split("–").pop()?.trim() ?? ""}` : ""})` : ""}`)
	})
	lines.push("")

	for (const [section, label] of SECTIONS) {
		const list = bySection(section)
		if (!list.length) continue
		lines.push(`## ${label}`, "")
		for (const f of list) lines.push(...findingBlock(f))
	}

	const conflicts = [...state.conflicts.values()]
	if (conflicts.length) {
		lines.push("## Konflikti izvora", "")
		for (const c of conflicts) lines.push(`- **${c.subject}** (${c.predicate}): „${c.values[0]}“ ↔ „${c.values[1]}“. ${c.explanation}`)
		lines.push("")
	}

	lines.push("## Šta još treba proveriti", "", ...summary.toVerify.map((t) => `- [ ] ${t}`), "")

	const seen = new Map<string, SourceRef>()
	for (const f of findings) for (const s of f.sources) if (!seen.has(`${normUrl(s.url)}|${s.title}`)) seen.set(`${normUrl(s.url)}|${s.title}`, s)
	lines.push("## Izvori", "")
	;[...seen.values()].forEach((s, i) => lines.push(`${i + 1}. [${s.title.replace(/[\[\]]/g, "")}](${s.url}) — ${hostOf(s.url)}${s.publishedAt ? `, ${formatDateSr(s.publishedAt)}` : ""}${s.official ? " (zvanični izvor)" : ""}`))
	lines.push("")

	const agents = [...state.agentInfo.values()].filter((a) => a.group !== "novinar" && a.group !== "sistem")
	const dynamic = agents.filter((a) => a.dynamic)
	const byGroup = new Map<string, number>()
	for (const a of dynamic) byGroup.set(a.group, (byGroup.get(a.group) ?? 0) + 1)
	lines.push("## Kako je nastao", "")
	lines.push(
		`Dosije je napravilo **${agents.length} agenata** na zajedničkoj Mozaik sabirnici događaja (5 stalnih + ${dynamic.length} pokrenutih tokom rada${dynamic.length ? `: ${[...byGroup].map(([g, n]) => `${g} ×${n}`).join(", ")}` : ""}), uz novinara kao člana tima.`,
		"",
		`- vrhunac istovremenih petlji: **${stats.peakConcurrentLoops}**; ukupno petlji: ${stats.totalLoops}; zaključivanja: ${stats.inferences}; pozivi alata: ${stats.toolCalls}`,
		`- interceptor Urednika: ${stats.interceptions} presretanja, ${stats.blockedClaims} blokiranih tvrdnji bez izvora, ${stats.conflicts} konflikata izvora rešeno`,
		`- Mozaik događaja: ${stats.events}; trajanje: ${formatDuration(stats.elapsedMs)}`,
		`- režim: ${config.mode === "llm" ? `LLM (${config.model}, urednik ${config.editorModel}), ${state.budget.tokens} tokena` : "skriptovani agenti (bez ključa): isti Mozaik runtime, alati, interceptor i stanje; zaključivanje je deterministično"}; podaci: ${config.dataMode === "cache" ? "keš" : config.dataMode === "live" ? "uživo" : "keš pa uživo"}`,
		`- pravni oblik za proveru roka v.d.: ${inst ? (LEGAL_LABELS[state.institutionRef?.legalType ?? "ostalo"] ?? inst.legalType) : ""}`,
		"",
		"*Sistem ne presuđuje: prikazuje signale za proveru, odluka ostaje na čoveku.*",
		"",
	)

	return {
		caseId: state.caseId ?? "",
		generatedAt: nowIso(),
		lede: summary.lede,
		topSignals: summary.topSignals,
		toVerify: summary.toVerify,
		markdown: lines.join("\n"),
	}
}
