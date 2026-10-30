// Shared contracts for Dosije. The Mozaik backend, the data layer and the
// frontend (plain JS in public/) all follow these shapes. Every SSE/REST payload
// the UI receives is described here.

// ─── Sources ────────────────────────────────────────────────────────────────

export type SourceKind =
	| "acas" // Agencija za sprečavanje korupcije: registar funkcionera, imovina
	| "jnportal" // Portal javnih nabavki
	| "integrity_watch" // Integrity Watch Srbija (Transparentnost Srbija)
	| "apr" // Agencija za privredne registre (otvoreni podaci)
	| "dri" // Državna revizorska institucija
	| "vesti" // media (RSS, Google News, GDELT, Serper, Brave)
	| "paragraf" // Službeni glasnik / propisi
	| "zakon" // fixed legal rule table
	| "opensanctions" // PEP lists
	| "krik" // KRIK baza imovine političara
	| "novinar"; // information entered by the human journalist

export interface SourceRef {
	kind: SourceKind;
	title: string; // human readable, e.g. "ACAS – Registar funkcionera: Infrastruktura železnice Srbije"
	url: string; // public URL a journalist can open (prefer the public page over an internal API URL)
	retrievedAt: string; // ISO datetime when the data was fetched
	publishedAt?: string; // ISO date of the document / article, if known
	official: boolean; // true for state registers and official documents
}

// ─── Dosije (the shared case file on Mozaik RuntimeState) ──────────────────

export type ClaimStatus = "zvanicno" | "potvrdjeno" | "nepotvrdjeno" | "demantovano";
export type Section = "rukovodstvo" | "novac" | "firme" | "revizija" | "mediji";
export type Severity = "info" | "paznja" | "signal"; // signal = red flag that needs human verification

export type SignalCode =
	| "VD_PREKO_ROKA" // acting head (v.d.) longer than the legal maximum
	| "VD_BLIZU_ROKA"
	| "VD_LANAC" // the institution has been run only by consecutive acting heads
	| "IMENOVANJE_NEPOZNATO"
	| "BEZ_OBJAVE" // negotiated procedures without publication
	| "KONCENTRACIJA" // supplier concentration
	| "UGOVOR_VECI_OD_PRIHODA" // contracts larger than the supplier's annual revenue
	| "MLADA_FIRMA" // supplier founded shortly before the contract
	| "MALO_ZAPOSLENIH" // few employees, large contracts
	| "POLITICKA_VEZA" // Integrity Watch link to an official / party
	| "VLASNIK_FUNKCIONER" // owner matches an official / PEP
	| "DRI_NALAZ" // audit irregularity
	| "DRI_MISLJENJE" // qualified / adverse audit opinion
	| "MEDIJSKI_NAVOD" // media allegation (unverified)
	| "IMOVINA"
	| "KONFLIKT_IZVORA";

export type ClaimPredicate =
	| "funkcija"
	| "datum_imenovanja"
	| "organ_imenovanja"
	| "vlasnik"
	| "vrednost"
	| "datum_osnivanja"
	| "status"
	| "drugo";

/** Structured claim used by the Urednik to detect conflicts between findings. */
export interface Claim {
	subject: string; // e.g. "Zoran Jevtić"
	predicate: ClaimPredicate; // e.g. "funkcija"
	value: string; // e.g. "v.d. generalnog direktora"
}

export interface Finding {
	id: string;
	caseId: string;
	section: Section;
	title: string; // short headline
	text: string; // 1-3 sentences, neutral journalistic language, no accusations
	status: ClaimStatus; // computed by the Urednik from the sources (official > 2 independent > 1)
	severity: Severity;
	signalCode?: SignalCode;
	sources: SourceRef[]; // >= 1, enforced by the Urednik interception gate
	entityIds: string[];
	claim?: Claim;
	agentId: string;
	agentName: string;
	createdAt: string;
	updatedAt: string;
	approval: "not_required" | "pending" | "approved" | "rejected";
	mergedFrom?: string[]; // ids of duplicate findings merged into this one
	conflictId?: string;
	note?: string; // editor's note, e.g. "Zvanični izvor ima prednost"
}

export type EntityKind = "institucija" | "osoba" | "firma";
export type EntityRole = "institucija" | "funkcioner" | "dobavljac" | "vlasnik" | "pomenut";

export interface Entity {
	id: string; // stable: "firma:<mb|pib|slug>", "osoba:<slug>", "institucija:<slug>"
	caseId: string;
	kind: EntityKind;
	name: string;
	role?: EntityRole;
	attrs: Record<string, string | number | boolean | null>; // pib, mb, position, valueRsd, contracts...
	addedBy: string; // participant id (agent or the journalist)
	addedByName: string;
	addedAt: string;
	sources: SourceRef[];
}

export interface HumanTask {
	id: string;
	caseId: string;
	kind: "pitanje" | "odobrenje"; // question (non-blocking) | approval (an agent loop is suspended)
	title: string;
	question: string;
	hint?: string;
	links?: { label: string; url: string }[];
	fromAgentId: string;
	fromAgentName: string;
	entityId?: string;
	findingDraft?: Partial<Finding>; // for "odobrenje": the finding waiting for approval
	blocking: boolean; // true = the asking agent's loop is paused inside a Mozaik InterceptionHandler
	status: "open" | "answered" | "approved" | "rejected" | "expired";
	answer?: string;
	createdAt: string;
	answeredAt?: string;
}

export interface Conflict {
	id: string;
	caseId: string;
	subject: string;
	predicate: ClaimPredicate;
	findingIds: [string, string];
	values: [string, string];
	winnerFindingId: string;
	rule: "zvanicni_izvor_ima_prednost" | "vise_izvora" | "noviji_datum";
	explanation: string; // Serbian, shown in the UI
	resolvedBy: string; // Urednik agent id
	at: string;
}

export type AgentGroup =
	| "kadrovik"
	| "nabavke"
	| "revizor"
	| "mediji"
	| "urednik"
	| "firme"
	| "imovina"
	| "provera"
	| "trijaza" // Mapa prioriteta: one triage agent per institution
	| "novinar"
	| "sistem";

/** UI metadata for every participant (agents, the journalist, observers). */
export interface AgentInfo {
	id: string;
	name: string; // e.g. "Kadrovik", "Firme · Energoprojekt", "Novinar"
	role: "agent" | "human";
	group: AgentGroup;
	dynamic: boolean; // spawned at runtime by a factory reacting to entity.added
	entityId?: string;
	sources: SourceKind[];
	emoji: string;
	description: string; // one line, Serbian
	spawnedBy?: string; // participant id whose event caused the spawn
	joinedAt: string;
	leftAt?: string;
}

/**
 * Live search: one public-source request made by an agent's tool (published on the Mozaik bus as "izvor.upit",
 * producer = the agent). Shown in the UI as "Pretraga uživo" and as the agent's current activity.
 */
export interface SourceActivity {
	id: string; // stable per request: the "u_toku" event and the final event share it
	agentId: string;
	agentName: string;
	tool: string; // e.g. "acas_funkcioneri"
	source: string; // human label: "ACAS", "Portal javnih nabavki", "APR", "DRI", "Google News", "N1 (RSS)", "GDELT", ...
	kind: SourceKind | "web";
	action: "pretraga" | "preuzimanje" | "dokument"; // search query | data/listing download | document (PDF, article)
	label: string; // Serbian, human-readable: "funkcioneri: Infrastruktura železnice Srbije", "ugovori, strana 3/16", "PDF: Izveštaj o reviziji … 2023"
	url?: string; // public URL when meaningful (never an URL with credentials)
	status: "u_toku" | "ok" | "kes" | "greska";
	ms?: number; // duration (for "kes": time to read the cache, plus simulated latency in scripted mode)
	items?: number; // results / rows returned when known
	cachedAt?: string; // for "kes": when the cached copy was fetched (ISO)
	error?: string; // short, for "greska"
	at: string; // ISO time of this event
}

export interface Budget {
	maxFirme: number;
	firme: number;
	maxOsobe: number;
	osobe: number;
	maxLoops: number;
	loops: number;
	maxToolCalls: number;
	toolCalls: number;
	maxTokens: number;
	tokens: number;
	exhausted: boolean;
}

export interface RunStats {
	activeLoops: number;
	peakConcurrentLoops: number;
	totalLoops: number;
	inferences: number;
	toolCalls: number;
	interceptions: number;
	blockedClaims: number;
	conflicts: number;
	events: number;
	activities?: number; // live-search requests published ("izvor.upit"), at most 400 per case
	activitiesDropped?: number; // requests over that cap (not published)
	startedAt?: string;
	finishedAt?: string;
	elapsedMs: number;
}

export interface DosijeReport {
	caseId: string;
	generatedAt: string;
	lede: string; // 2-3 sentence overview, Serbian
	topSignals: { findingId: string; headline: string }[]; // 3-5
	toVerify: string[]; // "šta još treba proveriti"
	markdown: string; // full exportable report
}

export interface InstitutionView {
	name: string;
	nameCyr?: string;
	slug: string;
	legalType: string;
	pib?: string;
	mb?: string;
	acasId?: string;
	jnId?: string;
}

export type CaseStatus = "idle" | "running" | "finalizing" | "done";

// ─── Mapa prioriteta (a list of institutions triaged in parallel; separate from the case) ──────────────

export type MapaStatus = "idle" | "running" | "done";
export type MapaRowStatus = "queued" | "running" | "done" | "error";

/** Figures the triage tools fetched (all optional: a source can be unavailable). Shares are fractions 0..1. */
export interface MapaSignals {
	vdMonths?: number; // months the current head has been acting (v.d.)
	vdLimitMonths?: number; // legal maximum applied by the v.d. check
	vdOver?: boolean;
	vdChainMonths?: number; // consecutive acting heads: months since the first one
	vdChainCount?: number;
	contracts?: number;
	valueRsd?: number;
	nwpCount?: number; // negotiated procedures without a public call
	nwpValueRsd?: number;
	nwpShare?: number; // of the total contract value
	topSupplierName?: string; // top supplier without public systems / state utilities
	topSupplierShare?: number; // of the value without public systems
	iwFlags?: number; // suppliers flagged by Integrity Watch Srbija
	driReports?: number;
	driQualified?: number; // qualified / adverse / disclaimer opinions among the opinions already extracted
	driKnown?: number; // reports whose opinion is known
}

export interface MapaRow {
	slug: string;
	name: string;
	resolvedName?: string; // what the resolver matched (official name)
	status: MapaRowStatus;
	agentId?: string;
	score: number; // deterministic, see src/data/analysis/priority.ts
	signals: MapaSignals;
	reasons: string[]; // short Serbian phrases, each with its points
	summary?: string; // 1-2 neutral sentences from the triage agent
	sources: SourceRef[];
	error?: string;
}

export interface MapaView {
	id: string | null;
	status: MapaStatus;
	startedAt?: string;
	finishedAt?: string;
	rows: MapaRow[]; // sorted by score, highest first
}

export interface RuntimeConfigView {
	mode: "llm" | "scripted";
	model: string;
	editorModel: string;
	dataMode: "auto" | "cache" | "live";
	searchProviders: string[]; // e.g. ["google-news-rss", "gdelt", "serper"]
	demoInstitutions: { slug: string; name: string }[];
	mapaPreset?: { slug: string; name: string }[]; // default list of "Mapa prioriteta"
}

export interface DosijeSnapshot {
	caseId: string | null;
	status: CaseStatus;
	input?: string;
	focus?: string;
	institution?: InstitutionView;
	findings: Finding[];
	entities: Entity[];
	conflicts: Conflict[];
	tasks: HumanTask[];
	agents: AgentInfo[];
	budget: Budget;
	stats: RunStats;
	report?: DosijeReport;
	mapa?: MapaView; // present once a map has been started (separate from the case)
	config: RuntimeConfigView;
}

// ─── Wire protocol (server -> browser over SSE) ──────────────────────────────
//
// GET /api/events  (text/event-stream)
//   event: snapshot   data: DosijeSnapshot          (sent on connect and after a new case starts)
//   event: ev         data: WireEvent               (every Mozaik event, sanitized)
//   event: stats      data: { stats: RunStats, budget: Budget }   (~1/s while running)
//
// Every Mozaik SemanticEvent on the bus is forwarded by an observer participant
// (the SSE bridge). Built-in loop events are sanitized (no full contexts, no tool
// functions); custom domain events carry the full objects below.

export interface WireEvent {
	seq: number; // monotonically increasing
	t: number; // epoch ms (event.occurredAt)
	type: string; // Mozaik event type
	producerId: string;
	producerName: string;
	loopId?: string;
	payload: unknown; // see WirePayloads
}

export interface WirePayloads {
	// built-in Mozaik events (sanitized)
	"participant.joined": { manifest: { id: string; name: string; role: string; capabilities: string[] }; info: AgentInfo | null };
	"participant.left": { manifest: { id: string; name: string; role: string; capabilities: string[] }; info: AgentInfo | null };
	"message.sent": { message: string };
	"message_received.started": { loopId: string; content: string };
	"inference.started": { loopId: string; model: string; items: number };
	"inference.completed": { loopId: string; kind: "tool_call" | "message"; toolName?: string; text?: string; tokens?: { input: number; output: number } };
	"function_call.started": { loopId: string; callId: string; name: string; args: Record<string, unknown> };
	"function_call.completed": { loopId: string; callId: string; output: string };
	"model.answer": { loopId: string; text: string };
	"interception.started": { loopId: string; nextStateId: string; toolName?: string };
	"interception.finished": { loopId: string; nextStateId: string; rewritten: boolean };

	// custom domain events
	"dosije.started": { caseId: string; input: string; focus?: string; institution: InstitutionView };
	"entity.added": { entity: Entity };
	"finding.added": { finding: Finding };
	"finding.updated": { finding: Finding; reason: "merge" | "conflict" | "approval" | "status" };
	"conflict.resolved": { conflict: Conflict };
	"claim.blocked": { agentId: string; agentName: string; title: string; reason: string };
	"pitanje.za_coveka": { task: HumanTask };
	"odgovor.coveka": { taskId: string; decision?: "approve" | "reject"; answer?: string };
	"task.updated": { task: HumanTask };
	"budget.updated": { budget: Budget };
	"dosije.zatvori": { caseId: string };
	"dosije.zavrsen": { caseId: string; report: DosijeReport };
	// live search: one event when a source request starts and one when it ends (same id; the UI upserts by id)
	"izvor.upit": SourceActivity;
	"mapa.started": { mapaId: string; institutions: { slug: string; name: string }[] };
	"mapa.red": { mapaId: string; row: MapaRow }; // upsert, every time a row changes
	"mapa.zavrsena": { mapaId: string; ranking: MapaRow[] }; // sorted by score, highest first
}

// ─── REST ────────────────────────────────────────────────────────────────────
//
// GET  /api/config                 -> RuntimeConfigView
// GET  /api/state                  -> DosijeSnapshot
// POST /api/dosije   {input, focus?}            -> { caseId }     start a new case (input = name or news URL)
// POST /api/odgovor  {taskId, decision?, answer?} -> { ok }        journalist answers / approves
// POST /api/trag     {name, kind: "osoba"|"firma"} -> { ok }       journalist adds a lead (entity.added by the human)
// POST /api/zavrsi   {}                          -> { ok }         finish now (dosije.zatvori)
// GET  /api/report.md                            -> text/markdown  the report
// POST /api/mapa     {institutions?: string[]}  -> { mapaId }     start a "Mapa prioriteta" (default: the preset list); 409 while a case runs
// GET  /api/mapa                                 -> MapaView       the current map
