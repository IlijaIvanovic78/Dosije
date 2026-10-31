// DosijeState: the shared state of the Mozaik runtime. Every agent, tool, gate and processor reads and writes the case
// through these methods; each mutation is followed by the matching domain event, sent by the participant that caused it
// (see domain.ts). `initializeRuntime` can run once per process, so "new case" means resetCase(), never a new runtime.

import { RuntimeState, type Agent } from "@mozaik-ai/core"
import { config } from "../config"
import type {
	AgentInfo,
	Budget,
	CaseStatus,
	ClaimStatus,
	Conflict,
	DosijeReport,
	DosijeSnapshot,
	Entity,
	Finding,
	HumanTask,
	InstitutionView,
	MapaRow,
	MapaSignals,
	MapaStatus,
	MapaView,
	RunStats,
	RuntimeConfigView,
	SourceRef,
} from "../shared/types"
import type { ResolvedInstitution } from "../data/resolver"
import type { Lang } from "../shared/lang"
import { clipWords } from "../shared/text"
import { hostOf, isHttpUrl, normUrl } from "./util"

export interface LoopInfo {
	agentId: string
	startedAt: number
	lastEventAt: number
	kind: string
}

export type ApprovalDecision = "approve" | "reject" | "expired"
export type ApprovalResolver = (decision: ApprovalDecision) => void

export interface Summary {
	lede: string
	topSignals: { findingId: string; headline: string }[]
	toVerify: string[]
}

export function freshBudget(): Budget {
	const b = config.budget
	return {
		maxFirme: b.maxFirme,
		firme: 0,
		maxOsobe: b.maxOsobe,
		osobe: 0,
		maxLoops: b.maxLoops,
		loops: 0,
		maxToolCalls: b.maxToolCalls,
		toolCalls: 0,
		maxTokens: b.maxTokens,
		tokens: 0,
		exhausted: false,
	}
}

export function freshStats(): RunStats {
	return { activeLoops: 0, peakConcurrentLoops: 0, totalLoops: 0, inferences: 0, toolCalls: 0, interceptions: 0, blockedClaims: 0, conflicts: 0, events: 0, elapsedMs: 0 }
}

/** any official source -> zvanicno; >= 2 distinct hosts -> potvrdjeno; otherwise nepotvrdjeno. */
export function computeStatus(sources: SourceRef[]): ClaimStatus {
	if (sources.some((s) => s.official)) return "zvanicno"
	const hosts = new Set(sources.map((s) => hostOf(s.url)).filter(Boolean))
	return hosts.size >= 2 ? "potvrdjeno" : "nepotvrdjeno"
}

export function mergeSources(a: SourceRef[], b: SourceRef[]): SourceRef[] {
	const seen = new Map<string, SourceRef>()
	for (const s of [...a, ...b]) {
		const k = normUrl(s.url)
		const prev = seen.get(k)
		if (!prev) seen.set(k, s)
		else if (s.official && !prev.official) seen.set(k, s)
	}
	return [...seen.values()]
}

/** What the three triage tools of one institution fetched in this loop (figures come from here, never from the model). */
export interface TriageRecord {
	called: Set<string>
	ok: Set<string>
	signals: MapaSignals
	gaps: string[]
}

/** "Mapa prioriteta": separate from the case; one run replaces the other (the REST layer enforces mutual exclusion). */
export class MapaState {
	id: string | null = null
	status: MapaStatus = "idle"
	startedAt?: string
	finishedAt?: string
	rows = new Map<string, MapaRow>()
	refs = new Map<string, ResolvedInstitution>()
	triage = new Map<string, TriageRecord>()
	agentSlug = new Map<string, string>()
	/** supplier key (PIB) -> the institutions it was published for in "mapa.veza" (the Urednik publishes a link once per change) */
	links = new Map<string, string>()
}

/** Highest score first; finished rows before failed ones; then by name. */
export function rankRows(rows: MapaRow[]): MapaRow[] {
	const rank = (r: MapaRow) => (r.status === "error" ? 0 : 1)
	return [...rows].sort((a, b) => rank(b) - rank(a) || b.score - a.score || a.name.localeCompare(b.name, "sr"))
}

export class DosijeState extends RuntimeState {
	mapa = new MapaState()
	caseId: string | null = null
	generation = 0
	status: CaseStatus = "idle"
	input?: string
	focus?: string
	/** the language of the run (case or map), chosen when it started: the agents write in it, the report follows it */
	lang: Lang = "sr"
	institution?: InstitutionView
	institutionRef?: ResolvedInstitution
	mentioned: string[] = []

	findings = new Map<string, Finding>()
	mergedAway = new Map<string, string>()
	entities = new Map<string, Entity>()
	conflicts = new Map<string, Conflict>()
	tasks = new Map<string, HumanTask>()
	conflictPairs = new Set<string>()
	report?: DosijeReport
	summary?: Summary

	budget: Budget = freshBudget()
	stats: RunStats = freshStats()

	agentInfo = new Map<string, AgentInfo>()
	names = new Map<string, string>()
	agents = new Map<string, Agent>()
	activeLoops = new Map<string, LoopInfo>()
	staleLoops = new Set<string>()
	pendingApprovals = new Map<string, ApprovalResolver>()
	pendingSpawns = 0
	spawned = new Set<string>()
	/** cross-agent reactions already started in this case ("mediji:VD_LANAC", ...): each fires at most once */
	reacted = new Set<string>()
	knownSources = new Map<string, SourceRef>()
	lastActivityAt = Date.now()
	startedAtMs = 0
	finishedAtMs = 0

	private counters = { finding: 0, task: 0, conflict: 0 }

	// ─── case lifecycle ────────────────────────────────────────────────────

	resetCase(args: { caseId: string; input: string; focus?: string; institution: InstitutionView; ref: ResolvedInstitution; mentioned?: string[]; lang?: Lang }): void {
		this.generation++
		this.caseId = args.caseId
		this.lang = args.lang ?? "sr"
		this.status = "running"
		this.input = args.input
		this.focus = args.focus
		this.institution = args.institution
		this.institutionRef = args.ref
		this.mentioned = args.mentioned ?? []
		this.clearRun()
	}

	/** Everything that belongs to one run (case or map): case data, budget, stats, loops, spawned agents. */
	private clearRun(): void {
		this.findings.clear()
		this.mergedAway.clear()
		this.entities.clear()
		this.conflicts.clear()
		this.tasks.clear()
		this.conflictPairs.clear()
		this.report = undefined
		this.summary = undefined
		this.budget = freshBudget()
		this.stats = freshStats()
		this.activeLoops.clear()
		this.pendingApprovals.clear()
		this.pendingSpawns = 0
		this.spawned.clear()
		this.reacted.clear()
		for (const info of this.agentInfo.values()) delete info.reactions
		this.knownSources.clear()
		this.counters = { finding: 0, task: 0, conflict: 0 }
		this.startedAtMs = Date.now()
		this.finishedAtMs = 0
		this.stats.startedAt = new Date(this.startedAtMs).toISOString()
		this.lastActivityAt = Date.now()
		for (const id of [...this.agents.keys()]) {
			if (this.agentInfo.get(id)?.dynamic) this.agents.delete(id)
		}
		for (const [id, info] of [...this.agentInfo]) {
			if (info.dynamic) this.agentInfo.delete(id)
		}
	}

	/** Drop the case and the map (a one-time search whose page was closed): back to the empty start state. */
	resetIdle(): void {
		this.generation++
		this.caseId = null
		this.status = "idle"
		this.input = undefined
		this.focus = undefined
		this.institution = undefined
		this.institutionRef = undefined
		this.mentioned = []
		this.lang = "sr"
		this.clearRun()
		this.mapa = new MapaState()
	}

	// ─── map lifecycle ("Mapa prioriteta") ─────────────────────────────────

	/** A map replaces whatever case is on screen (the two are mutually exclusive); the previous map's rows are dropped. */
	resetMapa(mapaId: string, institutions: { slug: string; name: string }[], lang: Lang = "sr"): void {
		this.generation++
		this.lang = lang
		this.caseId = null
		this.status = "idle"
		this.input = undefined
		this.focus = undefined
		this.institution = undefined
		this.institutionRef = undefined
		this.mentioned = []
		this.clearRun()
		const m = new MapaState()
		m.id = mapaId
		m.status = "running"
		m.startedAt = new Date(this.startedAtMs).toISOString()
		for (const i of institutions) m.rows.set(i.slug, { slug: i.slug, name: i.name, status: "queued", score: 0, signals: {}, reasons: [], sources: [] })
		this.mapa = m
	}

	mapaRunning(mapaId?: string | null): boolean {
		return this.mapa.status === "running" && (mapaId === undefined || this.mapa.id === mapaId)
	}

	mapaView(): MapaView | undefined {
		const m = this.mapa
		if (!m.id) return undefined
		return { id: m.id, status: m.status, startedAt: m.startedAt, finishedAt: m.finishedAt, rows: structuredClone(rankRows([...m.rows.values()])) }
	}

	isCurrent(caseId: string | null | undefined): boolean {
		return !!caseId && this.caseId === caseId
	}

	isRunning(caseId?: string): boolean {
		return this.status === "running" && (caseId === undefined || this.caseId === caseId)
	}

	touch(): void {
		this.lastActivityAt = Date.now()
	}

	nextFindingId(): string {
		return `f${++this.counters.finding}`
	}
	nextTaskId(): string {
		return `t${++this.counters.task}`
	}
	nextConflictId(): string {
		return `k${++this.counters.conflict}`
	}

	// ─── participants ──────────────────────────────────────────────────────

	registerAgentInfo(info: AgentInfo): void {
		this.agentInfo.set(info.id, info)
		this.names.set(info.id, info.name)
	}

	nameOf(id: string): string {
		return this.names.get(id) ?? id
	}

	// ─── sources (data layer owns the official flag) ───────────────────────

	registerSources(list: SourceRef[] | undefined): void {
		for (const s of list ?? []) if (s && isHttpUrl(s.url)) this.knownSources.set(normUrl(s.url), s)
	}

	/** Known sources keep the data layer's title/official flag; unknown ones are accepted but never official. */
	resolveSource(input: Partial<SourceRef>): SourceRef | null {
		if (!input || !isHttpUrl(input.url)) return null
		const known = this.knownSources.get(normUrl(input.url))
		// the data layer owns url + official; the model only supplies the display title and date
		if (known) return { ...known, title: typeof input.title === "string" && input.title.trim() ? clipWords(input.title, 200) : known.title, publishedAt: input.publishedAt ?? known.publishedAt }
		const kind = input.kind && typeof input.kind === "string" ? input.kind : "vesti"
		return {
			kind,
			title: clipWords(String(input.title ?? input.url), 200),
			url: input.url.trim(),
			retrievedAt: input.retrievedAt ?? new Date().toISOString(),
			publishedAt: input.publishedAt,
			official: false,
		}
	}

	// ─── loops and stats ───────────────────────────────────────────────────

	loopStarted(loopId: string, agentId: string, kind = "loop"): void {
		const now = Date.now()
		this.activeLoops.set(loopId, { agentId, startedAt: now, lastEventAt: now, kind })
		this.stats.totalLoops++
		this.budget.loops++
		this.stats.peakConcurrentLoops = Math.max(this.stats.peakConcurrentLoops, this.activeLoops.size)
		this.stats.activeLoops = this.activeLoops.size
		this.touch()
	}

	loopEnded(loopId: string): boolean {
		const had = this.activeLoops.delete(loopId)
		this.stats.activeLoops = this.activeLoops.size
		this.touch()
		return had
	}

	loopsOf(agentId: string): number {
		let n = 0
		for (const l of this.activeLoops.values()) if (l.agentId === agentId) n++
		return n
	}

	addTokens(n: number): void {
		if (!Number.isFinite(n) || n <= 0) return
		this.budget.tokens += Math.round(n)
		this.refreshExhausted()
	}

	refreshExhausted(): void {
		this.budget.exhausted = this.budget.tokens >= this.budget.maxTokens || this.budget.toolCalls >= this.budget.maxToolCalls
	}

	refreshStats(): RunStats {
		this.stats.activeLoops = this.activeLoops.size
		const end = this.finishedAtMs || Date.now()
		this.stats.elapsedMs = this.startedAtMs ? Math.max(0, end - this.startedAtMs) : 0
		if (this.finishedAtMs) this.stats.finishedAt = new Date(this.finishedAtMs).toISOString()
		return this.stats
	}

	// ─── queries ───────────────────────────────────────────────────────────

	findingList(): Finding[] {
		return [...this.findings.values()]
	}

	openTasks(): HumanTask[] {
		return [...this.tasks.values()].filter((t) => t.status === "open")
	}

	snapshot(view: RuntimeConfigView): DosijeSnapshot {
		this.refreshStats()
		return {
			caseId: this.caseId,
			status: this.status,
			input: this.input,
			focus: this.focus,
			institution: this.institution,
			findings: structuredClone(this.findingList()),
			entities: structuredClone([...this.entities.values()]),
			conflicts: structuredClone([...this.conflicts.values()]),
			tasks: structuredClone([...this.tasks.values()]),
			agents: structuredClone([...this.agentInfo.values()]),
			budget: { ...this.budget },
			stats: { ...this.stats },
			report: this.report,
			mapa: this.mapaView(),
			config: view,
		}
	}
}
