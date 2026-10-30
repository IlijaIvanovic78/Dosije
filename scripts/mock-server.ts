// Dependency-free mock of the Dosije backend, for UI development only.
// Serves public/ and replays a scripted case over SSE with clearly FICTIONAL data.
//
//   npx.cmd tsx scripts/mock-server.ts            (http://localhost:3001)
//   MOCK_SPEED=2 MOCK_PORT=3002 npx.cmd tsx scripts/mock-server.ts

import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type {
	AgentGroup,
	AgentInfo,
	Budget,
	CaseStatus,
	Claim,
	ClaimStatus,
	Conflict,
	DosijeReport,
	DosijeSnapshot,
	Entity,
	Finding,
	HumanTask,
	InstitutionView,
	RunStats,
	RuntimeConfigView,
	Section,
	Severity,
	SignalCode,
	SourceKind,
	SourceRef,
	WireEvent,
} from "../src/shared/types"

const PORT = Number(process.env.MOCK_PORT || 3001)
const SPEED = Math.max(0.1, Number(process.env.MOCK_SPEED || 1))
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public")

const CONFIG: RuntimeConfigView = {
	mode: "scripted",
	model: "gpt-5.4-mini",
	editorModel: "gpt-5.4",
	dataMode: "cache",
	searchProviders: ["google-news-rss", "gdelt"],
	demoInstitutions: [{ slug: "javno-preduzece-primer", name: "Javno preduzeće Primer" }],
}

const INSTITUTION: InstitutionView = {
	name: "Javno preduzeće Primer",
	nameCyr: "Јавно предузеће Пример",
	slug: "javno-preduzece-primer",
	legalType: "Javno preduzeće",
	pib: "100000001",
	mb: "20000001",
	acasId: "9001",
	jnId: "5001",
}

// ─── participants ───────────────────────────────────────────────────────────

type Who = { id: string; name: string }

function agent(id: string, name: string, group: AgentGroup, emoji: string, description: string, sources: SourceKind[], role: "agent" | "human" = "agent"): AgentInfo {
	return { id, name, role, group, dynamic: false, sources, emoji, description, joinedAt: new Date().toISOString() }
}

const NOVINAR = agent("p-novinar", "Novinar", "novinar", "✍️", "Novinar: odgovara na pitanja i odobrava signale", [], "human")
const FABRIKA = agent("p-fabrika", "Fabrika", "sistem", "🏭", "Pokreće nove agente kad se pojavi entitet", [], "human")
const SSE_MOST = agent("p-sse", "SSE most", "sistem", "📡", "Prosleđuje događaje pregledaču", [])
const ZAPISNICAR = agent("p-zapis", "Zapisničar", "sistem", "🗒️", "Upisuje trag događaja", [])
const KADROVIK = agent("a-kadrovik", "Kadrovik", "kadrovik", "🧑‍💼", "Ko vodi instituciju i na kom osnovu", ["acas", "paragraf", "zakon"])
const NABAVKE = agent("a-nabavke", "Nabavke", "nabavke", "🛒", "Javne nabavke i dobavljači", ["jnportal", "integrity_watch"])
const REVIZOR = agent("a-revizor", "Revizor", "revizor", "🔎", "Nalazi Državne revizorske institucije", ["dri"])
const MEDIJI = agent("a-mediji", "Mediji", "mediji", "📰", "Šta pišu mediji", ["vesti"])
const UREDNIK = agent("a-urednik", "Urednik", "urednik", "📝", "Spaja nalaze, rešava konflikte, piše sažetak", [])
const BASE_AGENTS = [NOVINAR, KADROVIK, NABAVKE, REVIZOR, MEDIJI, UREDNIK, FABRIKA, SSE_MOST, ZAPISNICAR]

// ─── case state ─────────────────────────────────────────────────────────────

class Abort extends Error {}

interface Case {
	id: string
	run: number
	input: string
	focus: string
	status: CaseStatus
	startedAt: number
	finishedAt?: number
	findings: Map<string, Finding>
	entities: Map<string, Entity>
	conflicts: Map<string, Conflict>
	tasks: Map<string, HumanTask>
	agents: Map<string, AgentInfo>
	loops: Map<string, string>
	budget: Budget
	stats: RunStats
	report?: DosijeReport
	approvals: Map<string, (d: "approve" | "reject") => void>
	answers: Map<string, (a: { answer?: string; skipped: boolean }) => void>
	spawned: Promise<void>[]
	rush: boolean
	counter: number
}

let seq = 0
let current: Case | null = null
let runCounter = 0
let statsTimer: NodeJS.Timeout | null = null
const clients = new Set<http.ServerResponse>()

function freshBudget(): Budget {
	return { maxFirme: 8, firme: 0, maxOsobe: 6, osobe: 0, maxLoops: 40, loops: 0, maxToolCalls: 400, toolCalls: 0, maxTokens: 1_500_000, tokens: 0, exhausted: false }
}

function freshStats(): RunStats {
	return { activeLoops: 0, peakConcurrentLoops: 0, totalLoops: 0, inferences: 0, toolCalls: 0, interceptions: 0, blockedClaims: 0, conflicts: 0, events: 0, elapsedMs: 0 }
}

function idleSnapshot(): DosijeSnapshot {
	return {
		caseId: null,
		status: "idle",
		findings: [],
		entities: [],
		conflicts: [],
		tasks: [],
		agents: BASE_AGENTS,
		budget: freshBudget(),
		stats: freshStats(),
		config: CONFIG,
	}
}

function snapshot(): DosijeSnapshot {
	const c = current
	if (!c) return idleSnapshot()
	refreshStats(c)
	return {
		caseId: c.id,
		status: c.status,
		input: c.input,
		focus: c.focus || undefined,
		institution: INSTITUTION,
		findings: [...c.findings.values()],
		entities: [...c.entities.values()],
		conflicts: [...c.conflicts.values()],
		tasks: [...c.tasks.values()],
		agents: [...c.agents.values()],
		budget: c.budget,
		stats: c.stats,
		report: c.report,
		config: CONFIG,
	}
}

function refreshStats(c: Case) {
	c.stats.activeLoops = c.loops.size
	c.stats.startedAt = new Date(c.startedAt).toISOString()
	if (c.finishedAt) c.stats.finishedAt = new Date(c.finishedAt).toISOString()
	c.stats.elapsedMs = (c.finishedAt ?? Date.now()) - c.startedAt
}

function send(res: http.ServerResponse, event: string, data: unknown) {
	res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

function broadcast(event: string, data: unknown) {
	for (const res of clients) send(res, event, data)
}

function emit(c: Case, type: string, who: Who, payload: unknown, loopId?: string): WireEvent {
	const ev: WireEvent = { seq: ++seq, t: Date.now(), type, producerId: who.id, producerName: who.name, loopId, payload }
	c.stats.events++
	if (type === "inference.started") c.stats.inferences++
	if (type === "function_call.started") {
		c.stats.toolCalls++
		c.budget.toolCalls++
	}
	if (type === "interception.started") c.stats.interceptions++
	if (type === "claim.blocked") c.stats.blockedClaims++
	if (type === "conflict.resolved") c.stats.conflicts++
	if (type === "inference.completed") c.budget.tokens += 300 + Math.floor(Math.random() * 1100)
	broadcast("ev", ev)
	return ev
}

// ─── scripting helpers ──────────────────────────────────────────────────────

const rnd = (a: number, b: number) => a + Math.random() * (b - a)

function sleep(c: Case, ms: number): Promise<void> {
	const d = (ms * rnd(0.85, 1.2)) / SPEED / (c.rush ? 25 : 1)
	return new Promise((resolve, reject) => {
		setTimeout(() => (current === c && c.run === runCounter ? resolve() : reject(new Abort())), d)
	})
}

const nid = (c: Case, p: string) => `${p}${++c.counter}`
const iso = () => new Date().toISOString()

function src(kind: SourceKind, title: string, slug: string, opts: { official?: boolean; published?: string } = {}): SourceRef {
	return { kind, title, url: `https://example.org/${slug}`, retrievedAt: iso(), publishedAt: opts.published, official: opts.official ?? ["acas", "jnportal", "apr", "dri", "paragraf", "zakon"].includes(kind) }
}

function joined(c: Case, a: AgentInfo, by: Who = a) {
	emit(c, "participant.joined", by, { manifest: { id: a.id, name: a.name, role: a.role, capabilities: [] }, info: a })
}

function left(c: Case, a: AgentInfo) {
	a.leftAt = iso()
	emit(c, "participant.left", a, { manifest: { id: a.id, name: a.name, role: a.role, capabilities: [] }, info: a })
}

function budgetEvent(c: Case) {
	emit(c, "budget.updated", UREDNIK, { budget: c.budget })
}

type GateResult = "pass" | "redirect"

interface Step {
	think: number
	tool: string
	args?: Record<string, unknown>
	run?: number
	gate?: () => Promise<GateResult>
	effect?: () => void | Promise<void>
	output?: string
}

async function runLoop(c: Case, who: AgentInfo, content: string, steps: Step[], answer: string) {
	const loopId = nid(c, "L")
	c.loops.set(loopId, who.id)
	c.budget.loops++
	c.stats.totalLoops++
	c.stats.peakConcurrentLoops = Math.max(c.stats.peakConcurrentLoops, new Set(c.loops.values()).size)
	emit(c, "message_received.started", who, { loopId, content }, loopId)
	try {
		for (const step of steps) {
			emit(c, "inference.started", who, { loopId, model: CONFIG.model, items: 3 + Math.floor(Math.random() * 6) }, loopId)
			await sleep(c, step.think)
			emit(c, "inference.completed", who, { loopId, kind: "tool_call", toolName: step.tool, tokens: { input: 900 + Math.floor(Math.random() * 1400), output: 40 + Math.floor(Math.random() * 120) } }, loopId)
			emit(c, "interception.started", who, { loopId, nextStateId: "function_call", toolName: step.tool }, loopId)
			const result = step.gate ? await step.gate() : "pass"
			await sleep(c, 30)
			emit(c, "interception.finished", who, { loopId, nextStateId: result === "pass" ? "function_call" : "inference", rewritten: false }, loopId)
			if (result === "redirect") continue
			const callId = nid(c, "call")
			emit(c, "function_call.started", who, { loopId, callId, name: step.tool, args: step.args ?? {} }, loopId)
			await sleep(c, step.run ?? 1000)
			await step.effect?.()
			emit(c, "function_call.completed", who, { loopId, callId, output: step.output ?? `{"ok":true}` }, loopId)
			if (c.stats.toolCalls % 8 === 0) budgetEvent(c)
		}
		emit(c, "inference.started", who, { loopId, model: CONFIG.model, items: 12 }, loopId)
		await sleep(c, 700)
		emit(c, "inference.completed", who, { loopId, kind: "message", text: answer }, loopId)
	} finally {
		c.loops.delete(loopId)
	}
	emit(c, "model.answer", who, { loopId, text: answer }, loopId)
}

// ─── domain helpers ─────────────────────────────────────────────────────────

function statusFor(sources: SourceRef[]): ClaimStatus {
	if (sources.some((s) => s.official)) return "zvanicno"
	return sources.length >= 2 ? "potvrdjeno" : "nepotvrdjeno"
}

interface FindingSpec {
	section: Section
	title: string
	text: string
	severity: Severity
	signalCode?: SignalCode
	sources: SourceRef[]
	entityIds?: string[]
	claim?: Claim
	approval?: Finding["approval"]
	status?: ClaimStatus
}

function addFinding(c: Case, who: AgentInfo, spec: FindingSpec): Finding {
	const f: Finding = {
		id: nid(c, "f"),
		caseId: c.id,
		section: spec.section,
		title: spec.title,
		text: spec.text,
		status: spec.status ?? statusFor(spec.sources),
		severity: spec.severity,
		signalCode: spec.signalCode,
		sources: spec.sources,
		entityIds: spec.entityIds ?? [],
		claim: spec.claim,
		agentId: who.id,
		agentName: who.name,
		createdAt: iso(),
		updatedAt: iso(),
		approval: spec.approval ?? "not_required",
	}
	c.findings.set(f.id, f)
	emit(c, "finding.added", who, { finding: f })
	return f
}

function addEntity(c: Case, who: Who, e: { kind: Entity["kind"]; name: string; role?: Entity["role"]; attrs?: Entity["attrs"]; sources?: SourceRef[] }): Entity {
	const slug = e.name.toLowerCase().replace(/d/g, "dj").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
	const entity: Entity = {
		id: `${e.kind}:${slug}`,
		caseId: c.id,
		kind: e.kind,
		name: e.name,
		role: e.role,
		attrs: e.attrs ?? {},
		addedBy: who.id,
		addedByName: who.name,
		addedAt: iso(),
		sources: e.sources ?? [],
	}
	if (c.entities.has(entity.id)) return c.entities.get(entity.id) as Entity
	c.entities.set(entity.id, entity)
	if (e.kind === "firma") c.budget.firme++
	if (e.kind === "osoba") c.budget.osobe++
	emit(c, "entity.added", who, { entity })
	budgetEvent(c)
	onEntityAdded(c, who, entity)
	return entity
}

// ─── Fabrika: spawn agents on entity.added ──────────────────────────────────

type DynKind = "firme" | "imovina" | "mediji" | "provera"

const DYN_META: Record<DynKind, { emoji: string; prefix: string; sources: SourceKind[]; description: string }> = {
	firme: { emoji: "🏢", prefix: "Firme", sources: ["apr", "jnportal", "integrity_watch"], description: "Proverava dobavljača: APR, ugovori, signali" },
	imovina: { emoji: "🏠", prefix: "Imovina", sources: ["acas"], description: "Izveštaji o imovini funkcionera" },
	mediji: { emoji: "📰", prefix: "Mediji", sources: ["vesti"], description: "Pomeni osobe u medijima" },
	provera: { emoji: "🕵️", prefix: "Provera", sources: ["acas", "opensanctions"], description: "Da li je osoba funkcioner ili PEP" },
}

function onEntityAdded(c: Case, producer: Who, entity: Entity) {
	const kinds: DynKind[] = []
	if (entity.kind === "firma") kinds.push("firme")
	if (entity.kind === "osoba" && entity.role === "funkcioner") kinds.push("imovina", "mediji")
	if (entity.kind === "osoba" && entity.role === "vlasnik") kinds.push("provera", "mediji")
	if (entity.kind === "osoba" && (entity.role === "pomenut" || !entity.role)) kinds.push("mediji")
	for (const kind of kinds) {
		const p = spawn(c, producer, entity, kind).catch((e) => {
			if (!(e instanceof Abort)) console.error(e)
		})
		c.spawned.push(p)
	}
}

async function spawn(c: Case, producer: Who, entity: Entity, kind: DynKind) {
	await sleep(c, 250)
	const m = DYN_META[kind]
	const info: AgentInfo = {
		id: `d-${kind}-${entity.id.replace(/[^a-z0-9]+/gi, "-")}`,
		name: `${m.prefix} · ${entity.name}`,
		role: "agent",
		group: kind,
		dynamic: true,
		entityId: entity.id,
		sources: m.sources,
		emoji: m.emoji,
		description: m.description,
		spawnedBy: producer.id,
		joinedAt: iso(),
	}
	if (c.agents.has(info.id)) return
	c.agents.set(info.id, info)
	joined(c, info, FABRIKA)
	await sleep(c, 300)
	const script = dynamicScript(c, info, entity, kind)
	await runLoop(c, info, script.content, script.steps, script.answer)
	if (script.afterLoop) await script.afterLoop()
	left(c, info)
}

function dynamicScript(c: Case, who: AgentInfo, entity: Entity, kind: DynKind): { content: string; steps: Step[]; answer: string; afterLoop?: () => Promise<void> } {
	const name = entity.name
	if (kind === "firme") return firmScript(c, who, entity)
	if (kind === "imovina") {
		return {
			content: `Proveri izveštaje o imovini za: ${name}`,
			answer: "Izveštaj o imovini pronađen i unet u dosije.",
			steps: [
				{ think: 800, tool: "acas_imovina", args: { name }, run: 1900, output: `{"reports":2}` },
				{
					think: 900,
					tool: "add_finding",
					args: { section: "rukovodstvo", title: "Izveštaj o imovini podnet" },
					run: 250,
					effect: () => {
						addFinding(c, who, {
							section: "rukovodstvo",
							title: `${name}: izveštaj o imovini i prihodima podnet`,
							text: "U registru imovine postoje izveštaji za 2024. i 2025. godinu. Sadržaj izveštaja nije analiziran.",
							severity: "info",
							signalCode: "IMOVINA",
							sources: [src("acas", "ACAS · Registar imovine (primer)", "acas/imovina/petar-petrovic", { published: "2025-06-01" })],
							entityIds: [entity.id],
						})
					},
				},
			],
		}
	}
	if (kind === "provera") {
		return {
			content: `Proveri da li je osoba funkcioner ili PEP: ${name}`,
			answer: "Provera završena: nema podudaranja.",
			steps: [
				{ think: 800, tool: "acas_pretraga_osobe", args: { name }, run: 1700, output: `{"officials":[]}` },
				{ think: 700, tool: "pep_provera", args: { name }, run: 1500, output: `{"matches":[]}` },
				{
					think: 900,
					tool: "add_finding",
					args: { section: "firme", title: "Provera vlasnika" },
					run: 250,
					effect: () => {
						addFinding(c, who, {
							section: "firme",
							title: `Vlasnik ${name}: nema podudaranja u registru funkcionera`,
							text: "U ACAS registru i PEP bazi nema osobe sa tačno tim imenom. Podudaranje imena nije dokaz o odsustvu veze, preporučuje se ručna provera.",
							severity: "info",
							sources: [src("acas", "ACAS · Pretraga funkcionera (primer)", "acas/pretraga"), src("opensanctions", "OpenSanctions · PEP provera (primer)", "pep/provera", { official: false })],
							entityIds: [entity.id],
						})
					},
				},
			],
		}
	}
	// mediji · osoba
	const dupSource = src("vesti", "Primer Vesti – Sindikat traži ostavku rukovodstva", "vesti/primer-vesti/ostavka", { published: "2026-10-27" })
	return {
		content: `Pretraži medije za osobu: ${name}`,
		answer: "Pretraga medija završena.",
		steps: [
			{ think: 900, tool: "vesti_pretraga", args: { query: name, days: 90 }, run: 2300, output: `{"items":5}` },
			...(entity.role === "funkcioner"
				? ([
						{
							think: 800,
							tool: "add_finding",
							args: { section: "mediji", title: "Sindikat traži ostavku rukovodstva" },
							run: 250,
							effect: () => mergeDuplicate(c, who, dupSource),
						},
						{
							think: 700,
							tool: "add_finding",
							args: { section: "mediji", title: "Intervju" },
							run: 250,
							effect: () => {
								addFinding(c, who, {
									section: "mediji",
									title: `${name} u intervjuu: "nema nepravilnosti u nabavkama"`,
									text: "U intervjuu za lokalni portal navodi da su svi postupci sprovedeni u skladu sa zakonom. Izjava nije proverena prema dokumentaciji.",
									severity: "info",
									signalCode: "MEDIJSKI_NAVOD",
									sources: [src("vesti", "Lokalni Portal – Intervju (primer)", "vesti/lokalni-portal/intervju", { published: "2026-10-12" })],
									entityIds: [entity.id],
								})
							},
						},
					] as Step[])
				: []),
		],
	}
}

// Urednik merges the duplicate into the earlier media finding about the union.
async function mergeDuplicate(c: Case, who: AgentInfo, dupSource: SourceRef) {
	const findBase = () => [...c.findings.values()].find((f) => f.title.startsWith("Sindikat traži ostavku") && f.agentId === MEDIJI.id)
	for (let i = 0; i < 60 && !findBase(); i++) await sleep(c, 300)
	const base = findBase()
	const dup = addFinding(c, who, {
		section: "mediji",
		title: "Sindikat traži ostavku rukovodstva Javnog preduzeća Primer",
		text: "Sindikat je saopštio da traži ostavku rukovodstva zbog stanja u preduzeću.",
		severity: "paznja",
		signalCode: "MEDIJSKI_NAVOD",
		sources: [dupSource],
	})
	if (!base) return
	await sleep(c, 700)
	const merged: Finding = { ...base, sources: [...base.sources, dupSource], mergedFrom: [dup.id], updatedAt: iso(), status: "potvrdjeno", note: "Spojeno: dva nezavisna izvora o istom navodu." }
	c.findings.delete(dup.id)
	c.findings.set(merged.id, merged)
	emit(c, "finding.updated", UREDNIK, { finding: merged, reason: "merge" })
}

function firmScript(c: Case, who: AgentInfo, entity: Entity): { content: string; steps: Step[]; answer: string; afterLoop?: () => Promise<void> } {
	const name = entity.name
	const profiles: Record<string, FindingSpec[]> = {
		"Primer Gradnja d.o.o.": [
			{
				section: "firme",
				title: "Primer Gradnja: osnovana pre ugovora, ugovori veći od prihoda",
				text: "Firma je osnovana 8 meseci pre prvog ugovora, a ukupna vrednost ugovora premašuje prihod iz poslednjeg finansijskog izveštaja. Signal za proveru, ne zaključak.",
				severity: "signal",
				signalCode: "UGOVOR_VECI_OD_PRIHODA",
				sources: [src("apr", "APR · Finansijski izveštaj 2025 (primer)", "apr/primer-gradnja", { published: "2026-04-30" }), src("jnportal", "Portal JN · Ugovori (primer)", "jn/primer-gradnja")],
			},
			{
				section: "firme",
				title: "Primer Gradnja: firma mlađa od godinu dana u trenutku prvog ugovora",
				text: "Datum osnivanja u APR je 11.02.2024; prvi ugovor sa preduzećem potpisan je 14.10.2024.",
				severity: "signal",
				signalCode: "MLADA_FIRMA",
				sources: [src("apr", "APR · Osnovni podaci (primer)", "apr/primer-gradnja/osnovni")],
			},
		],
		"Probni Inženjering d.o.o.": [
			{
				section: "firme",
				title: "Probni Inženjering: 6 zaposlenih, ugovori preko 60 miliona RSD",
				text: "Prema APR podacima firma ima 6 zaposlenih, a ukupna vrednost ugovora sa preduzećem je 62 miliona RSD.",
				severity: "paznja",
				signalCode: "MALO_ZAPOSLENIH",
				sources: [src("apr", "APR · Broj zaposlenih (primer)", "apr/probni-inzenjering")],
			},
		],
		"Uzorak Trans d.o.o.": [
			{ section: "firme", title: "Uzorak Trans: bez signala u dostupnim podacima", text: "Profil firme i ugovori nisu pokazali neuobičajene obrasce.", severity: "info", sources: [src("apr", "APR · Osnovni podaci (primer)", "apr/uzorak-trans")] },
		],
		"Test Servis d.o.o.": [
			{
				section: "firme",
				title: "Test Servis: navodna veza sa bivšim zaposlenim",
				text: "Jedan portal navodi da je osnivač ranije radio u preduzeću. Navod nije potvrđen u registrima.",
				severity: "paznja",
				signalCode: "POLITICKA_VEZA",
				sources: [src("vesti", "Primer Vesti – Ko su dobavljači (primer)", "vesti/primer-vesti/dobavljaci", { published: "2026-09-02" })],
				status: "nepotvrdjeno",
			},
		],
		"Demo Prevoz d.o.o.": [
			{ section: "firme", title: "Demo Prevoz: redovan dobavljač od 2019.", text: "Ugovori u periodu 2019–2025, ravnomerno raspoređeni, bez pregovaračkih postupaka.", severity: "info", sources: [src("jnportal", "Portal JN · Ugovori (primer)", "jn/demo-prevoz")] },
		],
		"Fiktivna Oprema d.o.o.": [
			{
				section: "firme",
				title: "Fiktivna Oprema: ugovor veći od godišnjeg prihoda",
				text: "Najveći ugovor (41 milion RSD) veći je od prihoda firme iz 2025. (29 miliona RSD).",
				severity: "paznja",
				signalCode: "UGOVOR_VECI_OD_PRIHODA",
				sources: [src("apr", "APR · Finansijski izveštaj (primer)", "apr/fiktivna-oprema"), src("jnportal", "Portal JN · Ugovor (primer)", "jn/fiktivna-oprema")],
			},
		],
	}
	const specs = profiles[name] ?? [{ section: "firme" as Section, title: `${name}: osnovni podaci o dobavljaču`, text: "Firma je pronađena u APR i ima ugovore sa preduzećem. Nema posebnih signala.", severity: "info" as Severity, sources: [src("apr", "APR · Osnovni podaci (primer)", `apr/${entity.id}`)] }]
	const steps: Step[] = [
		{ think: 700, tool: "apr_firma", args: { name }, run: 1300, output: `{"name":"${name}"}` },
		{ think: 800, tool: "firma_signali", args: { name }, run: 1600, output: `{"signals":${specs.filter((s) => s.severity !== "info").length}}` },
	]
	if (name === "Primer Gradnja d.o.o.") {
		steps.push({
			think: 800,
			tool: "ask_human",
			args: { question: `Ko je vlasnik firme ${name}?`, entityName: name },
			run: 300,
			output: `{"ok":true,"taskId":"pending"}`,
			effect: () => askOwner(c, who, entity),
		})
	}
	for (const spec of specs) {
		steps.push({
			think: 800,
			tool: "add_finding",
			args: { section: spec.section, title: spec.title, severity: spec.severity },
			run: 250,
			effect: () => {
				addFinding(c, who, { ...spec, entityIds: [entity.id] })
			},
		})
	}
	if (name === "Probni Inženjering d.o.o.") steps.splice(2, 0, { think: 700, tool: "iw_veze_dobavljaca", args: { name }, run: 1400, output: `{"links":0}` })
	return {
		content: `Proveri dobavljača: ${name}`,
		steps,
		answer: `Provera dobavljača ${name} završena.`,
		afterLoop: name === "Primer Gradnja d.o.o." ? () => waitForOwnerAnswer(c, who, entity) : undefined,
	}
}

// ─── questions (non-blocking) ───────────────────────────────────────────────

let ownerTaskId: string | null = null

function askOwner(c: Case, who: AgentInfo, entity: Entity) {
	const task: HumanTask = {
		id: nid(c, "t"),
		caseId: c.id,
		kind: "pitanje",
		title: `Ko je vlasnik firme ${entity.name}?`,
		question: `APR otvoreni podaci ne sadrže vlasnike (pretraga je iza reCAPTCHA). Možeš li da proveriš ko je vlasnik firme ${entity.name} (PIB 100234567, primer) i da upišeš ime?`,
		hint: "Otvori APR pretragu, nađi firmu po nazivu ili PIB-u i prepiši ime vlasnika. Ako nije dostupno, klikni Preskoči.",
		links: [
			{ label: "APR pretraga privrednih subjekata (primer)", url: "https://example.org/apr/pretraga?q=Primer%20Gradnja" },
			{ label: "Portal JN: ugovori firme (primer)", url: "https://example.org/jn/primer-gradnja" },
		],
		fromAgentId: who.id,
		fromAgentName: who.name,
		entityId: entity.id,
		blocking: false,
		status: "open",
		createdAt: iso(),
	}
	c.tasks.set(task.id, task)
	ownerTaskId = task.id
	emit(c, "pitanje.za_coveka", who, { task })
}

async function waitForOwnerAnswer(c: Case, who: AgentInfo, entity: Entity) {
	const taskId = ownerTaskId
	if (!taskId) return
	const outcome = await new Promise<{ answer?: string; skipped: boolean }>((resolve) => {
		c.answers.set(taskId, resolve)
		// the demo does not hang forever when the question is ignored (or the case is closed early)
		const deadline = Date.now() + 45_000 / SPEED
		const poll = setInterval(() => {
			if (c.rush || current !== c || Date.now() > deadline) {
				clearInterval(poll)
				resolve({ skipped: true })
			}
		}, 250)
	})
	c.answers.delete(taskId)
	const task = c.tasks.get(taskId)
	if (task && task.status === "open") {
		const expired: HumanTask = { ...task, status: "expired" }
		c.tasks.set(taskId, expired)
		emit(c, "task.updated", UREDNIK, { task: expired })
	}
	if (outcome.skipped || !outcome.answer) return
	const ownerName = outcome.answer.replace(/\s+/g, " ").trim().slice(0, 60)
	await runLoop(
		c,
		who,
		`Odgovor novinara: ${ownerName}`,
		[
			{
				think: 700,
				tool: "add_entity",
				args: { kind: "osoba", name: ownerName, role: "vlasnik" },
				run: 250,
				effect: () => {
					addEntity(c, who, { kind: "osoba", name: ownerName, role: "vlasnik", sources: [src("novinar", "Novinar · APR pretraga", "novinar/odgovor", { official: false })] })
				},
			},
			{
				think: 800,
				tool: "add_finding",
				args: { section: "firme", title: "Vlasnik firme" },
				run: 250,
				effect: () => {
					addFinding(c, who, {
						section: "firme",
						title: `Vlasnik firme ${entity.name}, prema novinaru: ${ownerName}`,
						text: "Podatak je uneo novinar nakon ručne provere u APR pretrazi. Sistem ga nije nezavisno potvrdio.",
						severity: "paznja",
						sources: [src("novinar", "Novinar · ručna provera u APR", "novinar/apr-provera", { official: false })],
						entityIds: [entity.id],
						status: "nepotvrdjeno",
					})
				},
			},
		],
		"Vlasnik upisan, pokrenuta provera osobe.",
	)
}

// ─── core agent scripts ─────────────────────────────────────────────────────

function kadrovikLoop(c: Case) {
	const who = KADROVIK
	const steps: Step[] = [
		{ think: 1100, tool: "acas_funkcioneri", args: {}, run: 1500, output: `{"officials":[{"name":"Petar Petrović","position":"v.d. direktora"}]}` },
		{
			think: 700,
			tool: "add_entity",
			args: { kind: "osoba", name: "Petar Petrović", role: "funkcioner" },
			run: 250,
			effect: () => {
				addEntity(c, who, {
					kind: "osoba",
					name: "Petar Petrović",
					role: "funkcioner",
					attrs: { position: "v.d. direktora", since: "2025-05-22" },
					sources: [src("acas", "ACAS · Registar funkcionera (primer)", "acas/registar/9001", { published: "2025-05-22" })],
				})
			},
		},
		{
			think: 900,
			tool: "add_finding",
			args: { section: "rukovodstvo", title: "Petar Petrović: v.d. direktora" },
			run: 250,
			effect: () => {
				addFinding(c, who, {
					section: "rukovodstvo",
					title: "Petar Petrović obavlja funkciju v.d. direktora",
					text: "Prema registru funkcionera ACAS, Petar Petrović je od 22.05.2025. vršilac dužnosti direktora Javnog preduzeća Primer.",
					severity: "info",
					sources: [src("acas", "ACAS · Registar funkcionera (primer)", "acas/registar/9001", { published: "2025-05-22" })],
					entityIds: ["osoba:petar-petrovic"],
					claim: { subject: "Petar Petrović", predicate: "funkcija", value: "v.d. direktora" },
				})
			},
		},
		{ think: 900, tool: "paragraf_akti", args: { personName: "Petar Petrović" }, run: 1400, output: `{"acts":1}` },
		{
			think: 800,
			tool: "add_finding",
			args: { section: "rukovodstvo", title: "Rešenje o imenovanju" },
			run: 250,
			effect: () => {
				addFinding(c, who, {
					section: "rukovodstvo",
					title: "Imenovan rešenjem Vlade, bez objavljenog konkursa",
					text: "U Službenom glasniku objavljeno je rešenje o imenovanju v.d. direktora. Konkurs za izbor direktora nije pronađen u dostupnim izvorima.",
					severity: "paznja",
					signalCode: "IMENOVANJE_NEPOZNATO",
					sources: [src("paragraf", "Službeni glasnik · Rešenje o imenovanju (primer)", "paragraf/resenje-2025", { published: "2025-05-22" })],
					entityIds: ["osoba:petar-petrovic"],
				})
			},
		},
		{ think: 900, tool: "vd_provera", args: { personId: "osoba:petar-petrovic" }, run: 1300, output: `{"overLimit":true,"months":17,"rule":"Zakon o javnim preduzećima, čl. 52 (max 1 godina)"}` },
		{
			think: 1000,
			tool: "add_finding",
			args: { section: "rukovodstvo", severity: "signal", signalCode: "VD_PREKO_ROKA", title: "v.d. direktora duže od zakonskog roka" },
			run: 300,
			gate: () => requestApproval(c, who),
			effect: () => {
				addFinding(c, who, {
					section: "rukovodstvo",
					title: "v.d. direktora na funkciji duže od zakonskog maksimuma",
					text: "Petar Petrović je vršilac dužnosti 17 meseci, a zakonski maksimum za javna preduzeća je godinu dana. Signal za proveru: potrebno je utvrditi da li je rok produžen važećim aktom.",
					severity: "signal",
					signalCode: "VD_PREKO_ROKA",
					sources: [src("acas", "ACAS · Registar funkcionera (primer)", "acas/registar/9001", { published: "2025-05-22" }), src("zakon", "Zakon o javnim preduzećima, čl. 52 (primer)", "zakon/jp-52")],
					entityIds: ["osoba:petar-petrovic"],
					approval: "approved",
					claim: { subject: "Petar Petrović", predicate: "datum_imenovanja", value: "2025-05-22" },
				})
			},
		},
	]
	return runLoop(c, who, "Istraži rukovodstvo institucije: ko, od kada, na kom osnovu.", steps, "Rukovodstvo obrađeno, nalazi uneti.")
}

function requestApproval(c: Case, who: AgentInfo): Promise<GateResult> {
	const task: HumanTask = {
		id: nid(c, "t"),
		caseId: c.id,
		kind: "odobrenje",
		title: "v.d. direktora na funkciji duže od zakonskog maksimuma",
		question: "Nalaz imenuje osobu i tvrdi da je zakonski rok prekoračen. Da li da uđe u izveštaj?",
		fromAgentId: who.id,
		fromAgentName: who.name,
		entityId: "osoba:petar-petrovic",
		findingDraft: {
			section: "rukovodstvo",
			title: "v.d. direktora na funkciji duže od zakonskog maksimuma",
			text: "Petar Petrović je vršilac dužnosti 17 meseci, a zakonski maksimum za javna preduzeća je godinu dana. Signal za proveru: potrebno je utvrditi da li je rok produžen važećim aktom.",
			severity: "signal",
			signalCode: "VD_PREKO_ROKA",
			sources: [src("acas", "ACAS · Registar funkcionera (primer)", "acas/registar/9001", { published: "2025-05-22" }), src("zakon", "Zakon o javnim preduzećima, čl. 52 (primer)", "zakon/jp-52")],
		},
		blocking: true,
		status: "open",
		createdAt: iso(),
	}
	c.tasks.set(task.id, task)
	emit(c, "pitanje.za_coveka", who, { task })
	return new Promise<GateResult>((resolve) => {
		c.approvals.set(task.id, (d) => resolve(d === "approve" ? "pass" : "redirect"))
	})
}

function nabavkeLoop(c: Case) {
	const who = NABAVKE
	const firms = ["Primer Gradnja d.o.o.", "Probni Inženjering d.o.o.", "Uzorak Trans d.o.o.", "Test Servis d.o.o.", "Demo Prevoz d.o.o.", "Fiktivna Oprema d.o.o."]
	const values = [214, 98, 77, 61, 55, 41]
	const jnSource = src("jnportal", "Portal javnih nabavki · Pregled (primer)", "jn/pregled/5001", { published: "2026-10-01" })
	const steps: Step[] = [{ think: 900, tool: "jn_pregled", args: {}, run: 2000, output: `{"contracts":1537,"negotiatedWithoutPublication":10}` }]
	firms.forEach((name, i) => {
		steps.push({
			think: 450,
			tool: "add_entity",
			args: { kind: "firma", name, role: "dobavljac" },
			run: 220,
			effect: () => {
				addEntity(c, who, { kind: "firma", name, role: "dobavljac", attrs: { valueRsd: values[i] * 1_000_000, contracts: 12 - i }, sources: [jnSource] })
			},
		})
		if (i === 2) {
			steps.push({
				think: 800,
				tool: "add_finding",
				args: { section: "novac", title: "Pregovarački postupci bez objave", severity: "signal" },
				run: 250,
				effect: () => {
					addFinding(c, who, {
						section: "novac",
						title: "10 pregovaračkih postupaka bez objavljivanja poziva",
						text: "U poslednjih pet godina preduzeće je sprovelo 10 pregovaračkih postupaka bez objavljivanja poziva za podnošenje ponuda, ukupne vrednosti 1,2 milijarde RSD.",
						severity: "signal",
						signalCode: "BEZ_OBJAVE",
						sources: [jnSource],
					})
				},
			})
		}
	})
	steps.push(
		{ think: 700, tool: "iw_veze", args: {}, run: 1600, output: `{"links":2}` },
		{
			think: 900,
			tool: "add_finding",
			args: { section: "novac", title: "Koncentracija dobavljača", severity: "paznja" },
			run: 250,
			gate: async () => {
				await sleep(c, 400)
				emit(c, "claim.blocked", UREDNIK, { agentId: who.id, agentName: who.name, title: "Tri firme imaju 62% vrednosti ugovora", reason: "Nalaz nema nijedan izvor (http/https). Dodaj izvor ili odustani od tvrdnje." })
				return "redirect"
			},
		},
		{
			think: 800,
			tool: "add_finding",
			args: { section: "novac", title: "Koncentracija dobavljača (sa izvorom)", severity: "paznja" },
			run: 250,
			effect: () => {
				addFinding(c, who, {
					section: "novac",
					title: "Tri firme imaju 62% vrednosti ugovora",
					text: "Tri najveća dobavljača čine 62% ukupne vrednosti ugovora u poslednje tri godine. Koncentracija sama po sebi nije nepravilnost, ali je razlog za dalju proveru.",
					severity: "paznja",
					signalCode: "KONCENTRACIJA",
					sources: [jnSource, src("integrity_watch", "Integrity Watch Srbija · Dobavljači (primer)", "iw/dobavljaci", { official: false })],
				})
			},
		},
	)
	return runLoop(c, who, "Pregledaj javne nabavke i najveće dobavljače.", steps, "Nabavke obrađene, firme prosleđene Fabrici.")
}

function revizorLoop(c: Case) {
	const who = REVIZOR
	const dri = (slug: string, title: string, date: string) => src("dri", title, `dri/${slug}`, { published: date })
	const steps: Step[] = [
		{ think: 1000, tool: "dri_izvestaji", args: {}, run: 1800, output: `{"reports":19}` },
		{ think: 800, tool: "dri_nalazi", args: { reportId: "dri-2025-17" }, run: 2200, output: `{"excerpts":6}` },
		{
			think: 900,
			tool: "add_finding",
			args: { section: "revizija", title: "Mišljenje s rezervom" },
			run: 250,
			effect: () => {
				addFinding(c, who, {
					section: "revizija",
					title: "Revizija finansijskih izveštaja: mišljenje s rezervom",
					text: "DRI je za 2024. godinu izrazila mišljenje s rezervom zbog neusaglašenih potraživanja i nedostatka evidencije o osnovnim sredstvima.",
					severity: "paznja",
					signalCode: "DRI_MISLJENJE",
					sources: [dri("izvestaj-2025-17", "DRI · Izveštaj o reviziji (primer)", "2025-12-04")],
				})
			},
		},
		{
			think: 900,
			tool: "add_finding",
			args: { section: "revizija", title: "Nabavke bez sprovedenog postupka", severity: "signal" },
			run: 250,
			effect: () => {
				addFinding(c, who, {
					section: "revizija",
					title: "DRI: nabavke vrednosti 140 miliona RSD bez sprovedenog postupka",
					text: "U izveštaju se navodi da su dobra i usluge vrednosti 140 miliona RSD nabavljeni bez sprovedenog postupka javne nabavke.",
					severity: "signal",
					signalCode: "DRI_NALAZ",
					sources: [dri("izvestaj-2025-17", "DRI · Izveštaj o reviziji, str. 41 (primer)", "2025-12-04")],
				})
			},
		},
		{
			think: 800,
			tool: "add_finding",
			args: { section: "revizija", title: "Preporuke DRI" },
			run: 250,
			effect: () => {
				addFinding(c, who, {
					section: "revizija",
					title: "Od 9 preporuka DRI sprovedeno 4",
					text: "Prema odgovoru preduzeća, od devet preporuka iz prethodnog izveštaja sprovedene su četiri, dve su u toku, a tri nisu sprovedene.",
					severity: "info",
					sources: [dri("izvestaj-2024-09", "DRI · Izveštaj o sprovođenju preporuka (primer)", "2024-11-20")],
				})
			},
		},
	]
	return runLoop(c, who, "Pronađi nalaze Državne revizorske institucije.", steps, "Nalazi revizije uneti.")
}

function medijiLoop(c: Case) {
	const who = MEDIJI
	const steps: Step[] = [
		{ think: 1000, tool: "vesti_pretraga", args: { query: "Javno preduzeće Primer", days: 90 }, run: 2400, output: `{"items":14}` },
		{ think: 700, tool: "vest_tekst", args: { url: "https://example.org/vesti/primer-vesti/novi-direktor" }, run: 1800, output: `{"chars":3200}` },
		{
			think: 900,
			tool: "add_finding",
			args: { section: "mediji", title: "Novi generalni direktor" },
			run: 250,
			effect: () => {
				const f = addFinding(c, who, {
					section: "mediji",
					title: "Mediji: Petar Petrović je \"generalni direktor\"",
					text: "Portal navodi da je Petar Petrović novi generalni direktor preduzeća.",
					severity: "paznja",
					signalCode: "MEDIJSKI_NAVOD",
					sources: [src("vesti", "Primer Vesti – Novi direktor preuzeo dužnost", "vesti/primer-vesti/novi-direktor", { published: "2025-05-26" })],
					claim: { subject: "Petar Petrović", predicate: "funkcija", value: "generalni direktor" },
					entityIds: ["osoba:petar-petrovic"],
				})
				setTimeout(() => resolveConflict(c, f), 1200 / SPEED)
			},
		},
		{ think: 800, tool: "vesti_pretraga", args: { query: "sindikat ostavka Primer", days: 30 }, run: 2000, output: `{"items":6}` },
		{
			think: 900,
			tool: "add_finding",
			args: { section: "mediji", title: "Sindikat traži ostavku" },
			run: 250,
			effect: () => {
				addFinding(c, who, {
					section: "mediji",
					title: "Sindikat traži ostavku rukovodstva",
					text: "Reprezentativni sindikat je zatražio ostavku rukovodstva preduzeća; o tome su izvestila dva nezavisna medija.",
					severity: "paznja",
					signalCode: "MEDIJSKI_NAVOD",
					sources: [src("vesti", "Primer Vesti – Sindikat traži ostavku", "vesti/primer-vesti/sindikat", { published: "2026-10-26" }), src("vesti", "Nezavisni Dnevnik – Ostavke u preduzeću", "vesti/nezavisni-dnevnik/ostavke", { published: "2026-10-27" })],
				})
			},
		},
		{
			think: 800,
			tool: "add_finding",
			args: { section: "mediji", title: "Navod o ugovoru bez tendera" },
			run: 250,
			effect: () => {
				addFinding(c, who, {
					section: "mediji",
					title: "Navod: ugovor od 5 milijardi RSD dodeljen bez tendera",
					text: "Jedan blog navodi da je ugovor od 5 milijardi RSD dodeljen bez tendera. Navod nije potvrđen u Portalu javnih nabavki.",
					severity: "paznja",
					signalCode: "MEDIJSKI_NAVOD",
					sources: [src("vesti", "Blog Primer – Ugovor veka", "vesti/blog-primer/ugovor", { published: "2026-09-18" })],
				})
			},
		},
	]
	return runLoop(c, who, "Pretraži medije o instituciji.", steps, "Medijski pomeni uneti.")
}

// Urednik: official source beats the media claim.
function resolveConflict(c: Case, mediaFinding: Finding) {
	const official = [...c.findings.values()].find((f) => f.claim?.subject === "Petar Petrović" && f.claim.predicate === "funkcija" && f.agentId === KADROVIK.id)
	if (!official || current !== c) return
	const conflict: Conflict = {
		id: nid(c, "k"),
		caseId: c.id,
		subject: "Petar Petrović",
		predicate: "funkcija",
		findingIds: [official.id, mediaFinding.id],
		values: [official.claim?.value ?? "", mediaFinding.claim?.value ?? ""],
		winnerFindingId: official.id,
		rule: "zvanicni_izvor_ima_prednost",
		explanation: "Registar funkcionera (ACAS) vodi Petra Petrovića kao v.d. direktora; medijski naziv ne menja zvaničan status.",
		resolvedBy: UREDNIK.id,
		at: iso(),
	}
	c.conflicts.set(conflict.id, conflict)
	emit(c, "conflict.resolved", UREDNIK, { conflict })
	const loser: Finding = { ...mediaFinding, status: "demantovano", conflictId: conflict.id, updatedAt: iso(), note: "Zvanični izvor ima prednost: u registru je v.d., ne generalni direktor." }
	const winner: Finding = { ...official, conflictId: conflict.id, updatedAt: iso() }
	c.findings.set(loser.id, loser)
	c.findings.set(winner.id, winner)
	emit(c, "finding.updated", UREDNIK, { finding: loser, reason: "conflict" })
	emit(c, "finding.updated", UREDNIK, { finding: winner, reason: "conflict" })
}

// ─── finalization ───────────────────────────────────────────────────────────

function buildReport(c: Case): DosijeReport {
	const all = [...c.findings.values()]
	const signals = all.filter((f) => f.severity === "signal").slice(0, 5)
	const labels: Record<ClaimStatus, string> = { zvanicno: "zvanično", potvrdjeno: "potvrđeno", nepotvrdjeno: "nepotvrđeno", demantovano: "demantovano" }
	const sections: [Section, string][] = [["rukovodstvo", "Rukovodstvo"], ["novac", "Novac i nabavke"], ["firme", "Firme"], ["revizija", "Revizija"], ["mediji", "Mediji"]]
	const toVerify = [
		"Da li je rok za v.d. direktora produžen važećim aktom Vlade?",
		"Vlasnička struktura firme Primer Gradnja d.o.o. (APR pretraga zahteva ručnu proveru).",
		"Navod o ugovoru od 5 milijardi RSD nije potvrđen u Portalu javnih nabavki.",
	]
	const lede = `U dosijeu o ${INSTITUTION.name} tim je prikupio ${all.length} nalaza, od kojih je ${all.filter((f) => f.severity === "signal").length} označeno kao signal za proveru. Najvažnije: v.d. direktora duže od zakonskog roka, pregovarački postupci bez objave i nalazi DRI. Ovo su signali, ne zaključci.`
	const lines: string[] = [
		`# Dosije: ${INSTITUTION.name}`,
		"",
		`> Generisano ${new Date().toLocaleString("sr-RS")} · slučaj ${c.id} · **primer sa izmišljenim podacima (mock)**`,
		"",
		"## Pregled",
		"",
		lede,
		"",
		"| Status | Broj nalaza |",
		"|---|---|",
		...(Object.keys(labels) as ClaimStatus[]).map((s) => `| ${labels[s]} | ${all.filter((f) => f.status === s).length} |`),
		"",
		"## Glavni signali",
		"",
		...(signals.length ? signals.map((f, i) => `${i + 1}. **${f.title}** (${labels[f.status]})`) : ["_Nema signala._"]),
		"",
	]
	for (const [id, label] of sections) {
		const list = all.filter((f) => f.section === id)
		if (!list.length) continue
		lines.push(`## ${label}`, "")
		for (const f of list) {
			lines.push(`### ${f.title}`, "", f.text, "", `*Status: ${labels[f.status]} · dodao ${f.agentName}*`, "")
			for (const s of f.sources) lines.push(`- [${s.title}](${s.url})${s.publishedAt ? ` (${s.publishedAt})` : ""}`)
			lines.push("")
		}
	}
	lines.push("## Šta još proveriti", "", ...toVerify.map((t) => `- ${t}`), "", "---", "", "*Sistem ne presuđuje: prikazuje signale za proveru, odluka ostaje na čoveku.*", "")
	return {
		caseId: c.id,
		generatedAt: iso(),
		lede,
		topSignals: signals.slice(0, 4).map((f) => ({ findingId: f.id, headline: f.title })),
		toVerify,
		markdown: lines.join("\n"),
	}
}

async function finalize(c: Case) {
	c.status = "finalizing"
	const who = UREDNIK
	let report: DosijeReport | undefined
	await runLoop(
		c,
		who,
		"Završni pregled dosijea i sažetak.",
		[
			{ think: 800, tool: "dosije_pregled", args: {}, run: 600, output: `{"findings":${c.findings.size}}` },
			{
				think: 1200,
				tool: "napisi_sazetak",
				args: { lede: "…", topSignals: ["…"], toVerify: ["…"] },
				run: 900,
				effect: () => {
					report = buildReport(c)
				},
			},
		],
		"Sažetak je napisan.",
	)
	await sleep(c, 300)
	c.report = report ?? buildReport(c)
	c.finishedAt = Date.now()
	c.status = "done"
	refreshStats(c)
	emit(c, "dosije.zavrsen", who, { caseId: c.id, report: c.report })
	broadcast("stats", { stats: c.stats, budget: c.budget })
}

async function scenario(c: Case) {
	for (const a of BASE_AGENTS) {
		c.agents.set(a.id, { ...a, joinedAt: iso() })
	}
	for (const a of BASE_AGENTS) {
		joined(c, c.agents.get(a.id) as AgentInfo)
		await sleep(c, 40)
	}
	emit(c, "message.sent", NOVINAR, { message: `Napravi dosije: ${c.input}` })
	emit(c, "dosije.started", NOVINAR, { caseId: c.id, input: c.input, focus: c.focus || undefined, institution: INSTITUTION })
	const core = [kadrovikLoop, nabavkeLoop, revizorLoop, medijiLoop].map(async (fn, i) => {
		await sleep(c, 60 * i)
		return fn(c)
	})
	await Promise.all(core)
	// spawned agents may spawn more (owner answer -> Provera); wait until the queue is stable
	let seen = 0
	while (seen < c.spawned.length) {
		const batch = c.spawned.slice(seen)
		seen = c.spawned.length
		await Promise.all(batch)
	}
	await sleep(c, 900)
	await finalize(c)
}

function startCase(input: string, focus: string): Case {
	const run = ++runCounter
	if (current) {
		current.rush = true
		for (const resolve of current.approvals.values()) resolve("reject")
		for (const resolve of current.answers.values()) resolve({ skipped: true })
	}
	ownerTaskId = null
	const c: Case = {
		id: `dos-${Date.now().toString(36)}`,
		run,
		input,
		focus,
		status: "running",
		startedAt: Date.now(),
		findings: new Map(),
		entities: new Map(),
		conflicts: new Map(),
		tasks: new Map(),
		agents: new Map(BASE_AGENTS.map((a) => [a.id, { ...a }])),
		loops: new Map(),
		budget: freshBudget(),
		stats: freshStats(),
		approvals: new Map(),
		answers: new Map(),
		spawned: [],
		rush: false,
		counter: 0,
	}
	current = c
	broadcast("snapshot", snapshot())
	if (statsTimer) clearInterval(statsTimer)
	statsTimer = setInterval(() => {
		if (current !== c) return
		refreshStats(c)
		broadcast("stats", { stats: c.stats, budget: c.budget })
	}, 1000)
	setTimeout(() => {
		scenario(c).catch((e) => {
			if (!(e instanceof Abort)) console.error("scenario failed:", e)
		})
	}, 200)
	return c
}

// ─── REST ───────────────────────────────────────────────────────────────────

function json(res: http.ServerResponse, status: number, body: unknown) {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
	res.end(JSON.stringify(body))
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = []
	for await (const ch of req) chunks.push(ch as Buffer)
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")
	} catch {
		return {}
	}
}

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<boolean> {
	const method = req.method || "GET"
	if (method === "GET" && pathname === "/api/config") return json(res, 200, CONFIG), true
	if (method === "GET" && pathname === "/api/state") return json(res, 200, snapshot()), true
	if (method === "GET" && pathname === "/api/report.md") {
		if (!current?.report) {
			res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
			res.end("Izveštaj još nije spreman.")
			return true
		}
		res.writeHead(200, { "content-type": "text/markdown; charset=utf-8", "content-disposition": `attachment; filename="dosije-${current.id}.md"` })
		res.end(current.report.markdown)
		return true
	}
	if (method === "GET" && pathname === "/api/events") {
		res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" })
		res.write("retry: 1500\n\n")
		send(res, "snapshot", snapshot())
		clients.add(res)
		const ka = setInterval(() => res.write(": ping\n\n"), 15000)
		req.on("close", () => {
			clearInterval(ka)
			clients.delete(res)
		})
		return true
	}
	if (method !== "POST") return false

	const body = await readBody(req)
	if (pathname === "/api/dosije") {
		const input = String(body.input ?? "").trim()
		if (!input) return json(res, 400, { error: "Upiši instituciju ili link vesti." }), true
		const c = startCase(input.slice(0, 300), String(body.focus ?? "").trim().slice(0, 200))
		return json(res, 200, { caseId: c.id }), true
	}
	const c = current
	if (pathname === "/api/odgovor") {
		const taskId = String(body.taskId ?? "")
		const task = c?.tasks.get(taskId)
		if (!c || !task) return json(res, 404, { error: "Zadatak ne postoji." }), true
		if (task.status !== "open") return json(res, 409, { error: "Zadatak je već rešen." }), true
		const decision = body.decision === "approve" || body.decision === "reject" ? body.decision : undefined
		const answer = typeof body.answer === "string" ? body.answer.trim() : undefined
		emit(c, "odgovor.coveka", NOVINAR, { taskId, decision, answer })
		const status: HumanTask["status"] = task.kind === "odobrenje" ? (decision === "approve" ? "approved" : "rejected") : decision === "reject" || !answer ? "rejected" : "answered"
		const updated: HumanTask = { ...task, status, answer, answeredAt: iso() }
		c.tasks.set(taskId, updated)
		emit(c, "task.updated", UREDNIK, { task: updated })
		if (task.kind === "odobrenje") c.approvals.get(taskId)?.(decision === "approve" ? "approve" : "reject")
		else c.answers.get(taskId)?.({ answer, skipped: status !== "answered" })
		return json(res, 200, { ok: true }), true
	}
	if (pathname === "/api/trag") {
		const name = String(body.name ?? "").trim().slice(0, 80)
		const kind = body.kind === "firma" ? "firma" : "osoba"
		if (!c || c.status !== "running") return json(res, 409, { error: "Nema aktivnog dosijea." }), true
		if (!name) return json(res, 400, { error: "Upiši ime ili naziv." }), true
		addEntity(c, NOVINAR, { kind, name, role: kind === "firma" ? "dobavljac" : "pomenut", sources: [src("novinar", "Novinar · trag", "novinar/trag", { official: false })] })
		return json(res, 200, { ok: true }), true
	}
	if (pathname === "/api/zavrsi") {
		if (!c || c.status === "done") return json(res, 409, { error: "Nema aktivnog dosijea." }), true
		emit(c, "dosije.zatvori", NOVINAR, { caseId: c.id })
		c.status = "finalizing"
		c.rush = true
		for (const [id, resolve] of c.approvals) {
			resolve("reject")
			const t = c.tasks.get(id)
			if (t && t.status === "open") {
				const u: HumanTask = { ...t, status: "rejected", answeredAt: iso() }
				c.tasks.set(id, u)
				emit(c, "task.updated", UREDNIK, { task: u })
			}
		}
		for (const resolve of c.answers.values()) resolve({ skipped: true })
		return json(res, 200, { ok: true }), true
	}
	return false
}

// ─── static files ───────────────────────────────────────────────────────────

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".md": "text/markdown; charset=utf-8",
}

function serveStatic(res: http.ServerResponse, pathname: string) {
	let rel = decodeURIComponent(pathname)
	if (rel.endsWith("/")) rel += "index.html"
	const file = path.normalize(path.join(PUBLIC_DIR, rel))
	if (!file.startsWith(PUBLIC_DIR)) {
		res.writeHead(403).end("Forbidden")
		return
	}
	fs.readFile(file, (err, data) => {
		if (err) {
			res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found")
			return
		}
		res.writeHead(200, { "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream", "cache-control": "no-store" })
		res.end(data)
	})
}

const server = http.createServer(async (req, res) => {
	try {
		const url = new URL(req.url || "/", "http://localhost")
		if (url.pathname.startsWith("/api/")) {
			if (await handleApi(req, res, url.pathname)) return
			json(res, 404, { error: "Nepoznata ruta." })
			return
		}
		serveStatic(res, url.pathname)
	} catch (e) {
		console.error(e)
		if (!res.headersSent) json(res, 500, { error: "Greška servera." })
		else res.end()
	}
})

process.on("unhandledRejection", (e) => {
	if (!(e instanceof Abort)) console.error("unhandledRejection", e)
})

server.listen(PORT, () => {
	console.log(`Dosije mock server: http://localhost:${PORT}  (MOCK_SPEED=${SPEED})`)
	console.log("Skriptovani događaji sa izmišljenim podacima; samo za razvoj UI-ja.")
})
