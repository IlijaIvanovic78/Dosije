// Markdown dossier for the journalist: disclaimer, lede, top signals, sections, source conflicts, what rests on a single
// unofficial source, deduplicated sources and how the dossier was made (agents, events, peak concurrency, duration).
// Written in the language the case was started in (state.lang); the findings are already in it.

import { config } from "../config"
import { LEGAL_LABELS, LEGAL_LABELS_EN } from "../data/resolver"
import type { Lang } from "../shared/lang"
import { n } from "../shared/plural"
import type { ClaimStatus, DosijeReport, Finding, Section, Severity, SourceKind, SourceRef } from "../shared/types"
import type { DosijeState, Summary } from "./state"
import { findingScore } from "./summary"
import { hostOf, nowIso, normUrl } from "./util"

/** English count with its noun: "1 agent", "17 agents". */
const en = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`

const TEXT = {
	sr: {
		// the code `demantovano` is part of the contract; in every text it reads "odstupa od registra" (a different headline title is not a denial)
		status: { zvanicno: "zvanično", potvrdjeno: "potvrđeno", nepotvrdjeno: "nepotvrđeno", demantovano: "odstupa od registra" } as Record<ClaimStatus, string>,
		source: {
			acas: "ACAS registar",
			jnportal: "Portal javnih nabavki",
			integrity_watch: "Integrity Watch Srbija",
			apr: "APR",
			dri: "DRI",
			paragraf: "Službeni glasnik",
			zakon: "propis",
			opensanctions: "OpenSanctions",
			krik: "KRIK",
			companywall: "CompanyWall",
			novinar: "unos novinarke",
		} as Partial<Record<SourceKind, string>>,
		severity: { signal: "signal", paznja: "pažnja", info: "informacija" } as Record<Severity, string>,
		sections: [
			["rukovodstvo", "Rukovodstvo"],
			["novac", "Novac i nabavke"],
			["firme", "Firme"],
			["revizija", "Revizija (DRI)"],
			["mediji", "Mediji"],
		] as [Section, string][],
		groups: {} as Record<string, string>,
		title: "Dosije",
		institutionFallback: "institucija",
		disclaimer:
			"> **Ovo su signali, ne zaključci.** Dosije je napravio tim AI agenata iz javno dostupnih izvora (ACAS, Portal javnih nabavki, APR, DRI, mediji, Integrity Watch, CompanyWall). Svaki nalaz ima izvor i status: zvanično (zvaničan registar ili dokument), potvrđeno (dva nezavisna izvora) ili nepotvrđeno. Ništa ovde nije optužba niti dokaz nepravilnosti.",
		institution: "Institucija",
		generated: "Generisano",
		locale: "sr-RS",
		caseWord: "slučaj",
		focusWord: "fokus",
		overview: "Pregled",
		statusTable: "| Status nalaza | Broj |",
		mainSignals: "Glavni signali",
		noSignals: "_Nema nalaza koji su označeni kao signal._",
		sourceWord: "izvor",
		officialSource: "zvanični izvor",
		conflicts: "Konflikti izvora",
		unconfirmed: "Nepotvrđeno",
		allConfirmed: "_Svi nalazi imaju zvaničan izvor ili potvrdu iz dva nezavisna izvora._",
		sources: "Izvori",
		howMade: "Kako je nastao",
		code: "oznaka",
		approved: "odobrio novinar",
		pending: "čeka odluku novinara",
		addedBy: "dodao",
		merged: (k: number) => `spojeno iz ${k} nalaza`, // genitive: always "nalaza"
		team: (agents: number, fixed: number, dynamic: number, groups: string) =>
			`U izradi dosijea radilo je **${n(agents, "agent")}** na zajedničkoj Mozaik sabirnici događaja (${fixed} stalnih + ${n(dynamic, "pokrenutAgent")}${groups ? `: ${groups}` : ""}), bez čekanja na korisnika.`,
		peak: (s: { peakConcurrentLoops: number; totalLoops: number; inferences: number; toolCalls: number }) =>
			`- vrhunac istovremenih petlji: **${s.peakConcurrentLoops}** (${n(s.peakConcurrentLoops, "petlja")} u isto vreme); ukupno petlji: ${s.totalLoops}; zaključivanja: ${s.inferences}; pozivi alata: ${s.toolCalls}`,
		gate: (s: { interceptions: number; blockedClaims: number; conflicts: number }) =>
			`- interceptor Urednika: ${n(s.interceptions, "presretanje")}, ${n(s.blockedClaims, "blokiranaTvrdnja")} bez izvora; rešeno konflikata izvora: ${s.conflicts}`,
		reactions: "- agenti koji reaguju na nalaze drugih agenata",
		events: (events: number, duration: string) => `- Mozaik događaja: ${events}; trajanje: ${duration}`,
		mode: (tokens: number) =>
			`- režim: ${config.mode === "llm" ? `LLM (${config.model}, urednik ${config.editorModel}), ${tokens} tokena` : "skriptovani agenti (bez ključa): isti Mozaik runtime, alati, interceptor i stanje; zaključivanje je deterministično"}; podaci: ${config.dataMode === "cache" ? "keš" : config.dataMode === "live" ? "uživo" : "keš pa uživo"}`,
		legal: "- pravni oblik po kom se računa rok v.d.",
		closing: "*Sistem ne presuđuje: svaki nalaz nosi izvor i status (zvanično, potvrđeno ili nepotvrđeno).*",
	},
	en: {
		status: { zvanicno: "official", potvrdjeno: "confirmed", nepotvrdjeno: "unconfirmed", demantovano: "differs from the register" } as Record<ClaimStatus, string>,
		source: {
			acas: "ACAS register",
			jnportal: "Public Procurement Portal",
			integrity_watch: "Integrity Watch Serbia",
			apr: "APR",
			dri: "State Audit Institution",
			paragraf: "Official Gazette",
			zakon: "regulation",
			opensanctions: "OpenSanctions",
			krik: "KRIK",
			companywall: "CompanyWall",
			novinar: "journalist's input",
		} as Partial<Record<SourceKind, string>>,
		severity: { signal: "signal", paznja: "notable", info: "information" } as Record<Severity, string>,
		sections: [
			["rukovodstvo", "Leadership"],
			["novac", "Money and procurement"],
			["firme", "Companies"],
			["revizija", "Audit (State Audit Institution)"],
			["mediji", "Media"],
		] as [Section, string][],
		groups: { firme: "companies", imovina: "assets", mediji: "media about people", provera: "owner checks", trijaza: "triage" } as Record<string, string>,
		title: "Dossier",
		institutionFallback: "institution",
		disclaimer:
			"> **These are signals, not conclusions.** The dossier was made by a team of AI agents from publicly available sources (ACAS, Public Procurement Portal, APR, State Audit Institution, media, Integrity Watch, CompanyWall). Every finding has a source and a status: official (an official register or document), confirmed (two independent sources) or unconfirmed. Nothing here is an accusation or proof of wrongdoing.",
		institution: "Institution",
		generated: "Generated",
		locale: "en-GB",
		caseWord: "case",
		focusWord: "focus",
		overview: "Overview",
		statusTable: "| Finding status | Count |",
		mainSignals: "Main signals",
		noSignals: "_No findings are marked as signals._",
		sourceWord: "source",
		officialSource: "official source",
		conflicts: "Source conflicts",
		unconfirmed: "Unconfirmed",
		allConfirmed: "_Every finding has an official source or confirmation from two independent sources._",
		sources: "Sources",
		howMade: "How it was made",
		code: "code",
		approved: "approved by the journalist",
		pending: "awaiting the journalist's decision",
		addedBy: "added by",
		merged: (k: number) => `merged from ${k} findings`,
		team: (agents: number, fixed: number, dynamic: number, groups: string) =>
			`**${en(agents, "agent")}** worked on the dossier on a shared Mozaik event bus (${fixed} permanent + ${en(dynamic, "launched agent")}${groups ? `: ${groups}` : ""}), without waiting for the user.`,
		peak: (s: { peakConcurrentLoops: number; totalLoops: number; inferences: number; toolCalls: number }) =>
			`- most loops at once: **${s.peakConcurrentLoops}**; loops in total: ${s.totalLoops}; inferences: ${s.inferences}; tool calls: ${s.toolCalls}`,
		gate: (s: { interceptions: number; blockedClaims: number; conflicts: number }) =>
			`- the Editor's interceptor: ${en(s.interceptions, "interception")}, ${en(s.blockedClaims, "claim")} without a source blocked; source conflicts resolved: ${s.conflicts}`,
		reactions: "- agents reacting to other agents' findings",
		events: (events: number, duration: string) => `- Mozaik events: ${events}; duration: ${duration}`,
		mode: (tokens: number) =>
			`- mode: ${config.mode === "llm" ? `LLM (${config.model}, editor ${config.editorModel}), ${tokens} tokens` : "scripted agents (no key): the same Mozaik runtime, tools, interceptor and state; the reasoning is deterministic"}; data: ${config.dataMode === "cache" ? "cache" : config.dataMode === "live" ? "live" : "cache, then live"}`,
		legal: "- the legal form the acting-head limit is computed for",
		closing: "*The system does not judge: every finding carries a source and a status (official, confirmed or unconfirmed).*",
	},
} satisfies Record<Lang, unknown>

type Text = (typeof TEXT)["sr"]

/** Short, whole name of a source for the list of top signals: "ACAS registar", "Danas", never a clipped title. */
function sourceName(L: Text, s: SourceRef): string {
	return L.source[s.kind] ?? (s.title.includes(":") ? s.title.split(":")[0].trim() : hostOf(s.url))
}

export function formatDateSr(iso?: string): string {
	const m = iso ? /^(\d{4})-(\d{2})-(\d{2})/.exec(iso) : null
	return m ? `${m[3]}.${m[2]}.${m[1]}.` : ""
}

function formatDuration(ms: number): string {
	const s = Math.round(ms / 1000)
	return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`
}

function sourceLine(L: Text, s: SourceRef): string {
	const date = formatDateSr(s.publishedAt)
	return `- [${s.title.replace(/[\[\]]/g, "")}](${s.url})${date ? ` (${date})` : ""}${s.official ? ` · ${L.officialSource}` : ""}`
}

function findingBlock(L: Text, f: Finding): string[] {
	const meta = [
		`status: ${L.status[f.status]}`,
		L.severity[f.severity],
		f.signalCode ? `${L.code}: ${f.signalCode}` : "",
		f.approval === "approved" ? L.approved : f.approval === "pending" ? L.pending : "",
		`${L.addedBy} ${f.agentName}`,
		f.mergedFrom?.length ? L.merged(f.mergedFrom.length + 1) : "",
	].filter(Boolean)
	return [`### ${f.title}`, "", f.text, "", `*${meta.join(" · ")}*`, ...(f.note ? ["", `> ${f.note}`] : []), "", ...f.sources.map((s) => sourceLine(L, s)), ""]
}

export function buildReport(state: DosijeState, summary: Summary): DosijeReport {
	const L: Text = TEXT[state.lang]
	const inst = state.institution
	const findings = state.findingList()
	const stats = state.refreshStats()
	const bySection = (s: Section) => findings.filter((f) => f.section === s).sort((a, b) => findingScore(b) - findingScore(a) || a.createdAt.localeCompare(b.createdAt))
	const counts: Record<ClaimStatus, number> = { zvanicno: 0, potvrdjeno: 0, nepotvrdjeno: 0, demantovano: 0 }
	for (const f of findings) counts[f.status]++

	const lines: string[] = []
	lines.push(`# ${L.title}: ${inst?.name ?? L.institutionFallback}`, "")
	lines.push(L.disclaimer, "")
	const ids = [inst?.pib ? `PIB ${inst.pib}` : "", inst?.mb ? `MB ${inst.mb}` : "", inst?.acasId ? `ACAS ID ${inst.acasId}` : "", inst?.jnId ? `JN ID ${inst.jnId}` : ""].filter(Boolean).join(" · ")
	lines.push(
		`**${L.institution}:** ${inst?.name ?? ""} · ${inst?.legalType ?? ""}${ids ? ` · ${ids}` : ""}  `,
		`**${L.generated}:** ${new Date().toLocaleString(L.locale, { timeZone: "Europe/Belgrade" })} · ${L.caseWord} ${state.caseId}${state.focus ? ` · ${L.focusWord}: ${state.focus}` : ""}`,
		"",
	)

	lines.push(`## ${L.overview}`, "", summary.lede, "")
	lines.push(L.statusTable, "|---|---|", ...(Object.keys(L.status) as ClaimStatus[]).map((s) => `| ${L.status[s]} | ${counts[s]} |`), "")

	lines.push(`## ${L.mainSignals}`, "")
	if (summary.topSignals.length === 0) lines.push(L.noSignals, "")
	summary.topSignals.forEach((t, i) => {
		const f = state.findings.get(t.findingId)
		lines.push(`${i + 1}. **${t.headline}**${f ? ` (${L.status[f.status]}${f.sources[0] ? `; ${L.sourceWord}: ${sourceName(L, f.sources.find((s) => s.official) ?? f.sources[0])}` : ""})` : ""}`)
	})
	lines.push("")

	for (const [section, label] of L.sections) {
		const list = bySection(section)
		if (!list.length) continue
		lines.push(`## ${label}`, "")
		for (const f of list) lines.push(...findingBlock(L, f))
	}

	const conflicts = [...state.conflicts.values()]
	if (conflicts.length) {
		lines.push(`## ${L.conflicts}`, "")
		for (const c of conflicts) lines.push(`- **${c.subject}** (${c.predicate}): „${c.values[0]}“ ↔ „${c.values[1]}“. ${c.explanation}`)
		lines.push("")
	}

	// what rests on a single unofficial source (one article, a commercial register copy)
	const unconfirmed = findings.filter((f) => f.status === "nepotvrdjeno")
	lines.push(`## ${L.unconfirmed}`, "")
	if (!unconfirmed.length) lines.push(L.allConfirmed)
	for (const f of unconfirmed) lines.push(`- ${f.title}${f.sources[0] ? ` (${L.sourceWord}: ${sourceName(L, f.sources[0])})` : ""}`)
	lines.push("")

	const seen = new Map<string, SourceRef>()
	for (const f of findings) for (const s of f.sources) if (!seen.has(`${normUrl(s.url)}|${s.title}`)) seen.set(`${normUrl(s.url)}|${s.title}`, s)
	lines.push(`## ${L.sources}`, "")
	;[...seen.values()].forEach((s, i) => lines.push(`${i + 1}. [${s.title.replace(/[\[\]]/g, "")}](${s.url}) — ${hostOf(s.url)}${s.publishedAt ? `, ${formatDateSr(s.publishedAt)}` : ""}${s.official ? ` (${L.officialSource})` : ""}`))
	lines.push("")

	const agents = [...state.agentInfo.values()].filter((a) => a.group !== "novinar" && a.group !== "sistem")
	const dynamic = agents.filter((a) => a.dynamic)
	const byGroup = new Map<string, number>()
	for (const a of dynamic) byGroup.set(a.group, (byGroup.get(a.group) ?? 0) + 1)
	const reactions = agents.flatMap((a) => (a.reactions ?? []).map((r) => `${a.name} ← ${r.fromAgent} (${r.signalCode})`))
	const legal = state.institutionRef?.legalType ?? "ostalo"
	lines.push(`## ${L.howMade}`, "")
	lines.push(
		L.team(agents.length, agents.length - dynamic.length, dynamic.length, [...byGroup].map(([g, c]) => `${L.groups[g] ?? g} ×${c}`).join(", ")),
		"",
		L.peak(stats),
		L.gate(stats),
		...(reactions.length ? [`${L.reactions}: ${reactions.join("; ")}`] : []),
		L.events(stats.events, formatDuration(stats.elapsedMs)),
		L.mode(state.budget.tokens),
		`${L.legal}: ${inst ? ((state.lang === "en" ? LEGAL_LABELS_EN : LEGAL_LABELS)[legal] ?? inst.legalType) : ""}`,
		"",
		L.closing,
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
