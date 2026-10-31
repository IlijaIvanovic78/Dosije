// UrednikGate: the Mozaik InterceptionHandler of every loop (one instance per loop).
// Policies, in order: (0) stale / closed case, (1) budget, (2) PII scrub, (3) source gate (+ claim.blocked),
// (4) blocking approval of sensitive signals. Only THIS loop is suspended while it waits for the journalist: Mozaik awaits
// handle() inside this agent's loop only, every other loop keeps running. The gate never throws.

import {
	FunctionCallItem,
	FunctionCallOutputItem,
	ModelMessageItem,
	type ExecutableTransition,
	type InferenceInput,
	type InterceptionHandler,
} from "@mozaik-ai/core"
import { config } from "../config"
import { n } from "../shared/plural"
import type { AgentGroup, Finding, HumanTask } from "../shared/types"
import { rewrittenInputs } from "./bus"
import { APPROVAL_CODES, emit, ids, parseClaim, parseSources, S, scheduleBudgetEvent, updateTask } from "./domain"
import type { ApprovalDecision } from "./state"
import { clip, isHttpUrl, logError, nowIso } from "./util"

export interface GateCtx {
	agentId: string
	agentName: string
	group: AgentGroup
	caseId: string
	entityId?: string
}

type FunctionCallTransition = Extract<ExecutableTransition, { nextStateId: "function_call" }>

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g
const PHONE_INTL = /(?:\+|00)\s?381[\s().-]*\d(?:[\s().-]*\d){6,10}/g
const PHONE_LOCAL = /\b(?:0[1-3]\d|06\d)[\s/-]\d{3,4}[\s-]?\d{2,4}\b/g
const PHONE_LABEL = /\b(?:tel|telefon|mob|mobilni|fax)\.?\s*:?\s*[+\d][\d\s()/.-]{5,}/gi

export function scrubText(s: string): string {
	return s
		.replace(EMAIL, "[e-mail uklonjen]")
		.replace(PHONE_LABEL, "[telefon uklonjen]")
		.replace(PHONE_INTL, "[telefon uklonjen]")
		.replace(PHONE_LOCAL, "[telefon uklonjen]")
}

function scrubValue(value: unknown, key = ""): unknown {
	if (typeof value === "string") return key === "url" ? value : scrubText(value)
	if (Array.isArray(value)) return value.map((v) => scrubValue(v, key))
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, scrubValue(v, k)]))
	return value
}

export class UrednikGate implements InterceptionHandler {
	private calls = 0
	private skipped = 0
	private rejected = new Set<string>()

	constructor(private readonly ctx: GateCtx) {}

	/** The run this loop belongs to is still the current one: the open case, or (Trijaža) the running map. */
	private live(): boolean {
		const state = S()
		if (this.ctx.group === "trijaza") return state.mapaRunning(this.ctx.caseId)
		return state.isCurrent(this.ctx.caseId) && (this.ctx.group === "urednik" || state.status === "running")
	}

	/**
	 * Mozaik calls this exactly once per transition. Only calls that need an editorial intervention are intercepted
	 * (so interception.started on the bus means the Urednik really acted); plain calls are just counted here.
	 */
	isSatisfiedBy(transition: ExecutableTransition): boolean {
		if (transition.nextStateId !== "function_call") return false
		try {
			const state = S()
			const { call } = transition.input
			const isEditor = this.ctx.group === "urednik"
			if (!this.live()) return true
			this.calls++
			if (!isEditor) {
				state.refreshExhausted()
				if (this.calls > config.budget.maxToolCallsPerLoop || state.budget.exhausted) return true
			}
			let args: Record<string, unknown> = {}
			try {
				const parsed = JSON.parse(call.args)
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>
			} catch {}
			if ("_approval" in args) return true
			if (call.name === "add_finding" || call.name === "add_entity" || call.name === "ask_human") {
				if (JSON.stringify(scrubValue(args)) !== JSON.stringify(args)) return true
			}
			if (call.name === "add_finding") {
				const rawSources = Array.isArray(args.sources) ? args.sources : []
				if (!rawSources.some((s) => s && typeof s === "object" && isHttpUrl((s as { url?: unknown }).url))) return true
				const code = args.signalCode as string | undefined
				if (config.approvals && args.severity === "signal" && code && APPROVAL_CODES.includes(code as never)) return true
			}
			this.countCall()
			return false
		} catch (err) {
			logError(`gate.isSatisfiedBy ${this.ctx.agentId}`, err)
			return false
		}
	}

	async handle(transition: ExecutableTransition): Promise<ExecutableTransition> {
		try {
			if (transition.nextStateId !== "function_call") return transition
			return await this.run(transition)
		} catch (err) {
			logError(`gate ${this.ctx.agentId}`, err)
			return transition
		}
	}

	private skip(t: FunctionCallTransition, text: string): ExecutableTransition {
		const { call, inferenceInput } = t.input
		inferenceInput.context.addContextItems([call, FunctionCallOutputItem.create(call.callId, text)])
		return { nextStateId: "inference", input: inferenceInput }
	}

	private endLoop(t: FunctionCallTransition, answer: string): ExecutableTransition {
		const { call, inferenceInput } = t.input
		inferenceInput.context.addContextItems([call, FunctionCallOutputItem.create(call.callId, answer)])
		return { nextStateId: "model_message", input: { answer: ModelMessageItem.rehydrate({ text: answer }) } }
	}

	private rewrite(t: FunctionCallTransition, args: Record<string, unknown>): ExecutableTransition {
		const { call, inferenceInput } = t.input
		const input: FunctionCallTransition["input"] = {
			call: FunctionCallItem.rehydrate({ callId: call.callId, name: call.name, args: JSON.stringify(args) }),
			inferenceInput,
		}
		rewrittenInputs.add(input)
		return { nextStateId: "function_call", input }
	}

	private async run(t: FunctionCallTransition): Promise<ExecutableTransition> {
		const state = S()
		const { call } = t.input
		const { group } = this.ctx
		const isEditor = group === "urednik"

		// (0) stale or closed case
		if (!this.live()) return this.endLoop(t, "Dosije je zatvoren: završi rad jednom rečenicom.")

		// (1) budget (calls were counted in isSatisfiedBy)
		if (!isEditor) {
			const overLoop = this.calls > config.budget.maxToolCallsPerLoop
			state.refreshExhausted()
			if (overLoop || state.budget.exhausted) {
				this.skipped++
				const text = overLoop
					? `BUDŽET: ovaj agent je iskoristio ${n(config.budget.maxToolCallsPerLoop, "pozivAlata")}. Završi sada jednom kratkom rečenicom šta si uradio.`
					: "BUDŽET: tim je iskoristio ukupan budžet (pozivi alata ili tokeni). Završi sada jednom kratkom rečenicom šta si uradio."
				return this.skipped >= 3 ? this.endLoop(t, "Budžet je iskorišćen; agent završava rad.") : this.skip(t, text)
			}
		}

		let args: Record<string, unknown>
		try {
			const parsed = JSON.parse(call.args)
			args = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
		} catch {
			this.countCall()
			return t
		}

		let changed = false
		// a model must never be able to grant itself an approval
		if ("_approval" in args) {
			delete args._approval
			changed = true
		}

		// (2) PII scrub
		if (call.name === "add_finding" || call.name === "add_entity" || call.name === "ask_human") {
			const scrubbed = scrubValue(args) as Record<string, unknown>
			if (JSON.stringify(scrubbed) !== JSON.stringify(args)) {
				args = scrubbed
				changed = true
			}
		}

		if (call.name === "add_finding") {
			// (3) source gate
			const rawSources = Array.isArray(args.sources) ? args.sources : []
			const valid = rawSources.filter((s) => s && typeof s === "object" && isHttpUrl((s as { url?: unknown }).url))
			if (valid.length === 0) {
				const title = typeof args.title === "string" ? clip(args.title, 140) : "(bez naslova)"
				const reason = "Nalaz nema nijedan važeći http(s) izvor. Dodaj izvor iz polja sources koje vraćaju alati ili odustani od tvrdnje."
				emit("claim.blocked", ids.urednik, { agentId: this.ctx.agentId, agentName: this.ctx.agentName, title, reason })
				return this.skip(t, `ODBIJENO: nalaz „${title}“ ne sme u Dosije. ${reason}`)
			}

			// (4) blocking approval of sensitive signals (only with DOSIJE_APPROVALS=1; otherwise the signal goes in on its sources:
			// official sources make it "zvanično", anything else stays "nepotvrđeno")
			const code = args.signalCode as string | undefined
			if (config.approvals && args.severity === "signal" && code && APPROVAL_CODES.includes(code as never)) {
				const title = typeof args.title === "string" ? clip(args.title, 160) : "Signal"
				const key = `${code}:${title}`
				if (this.rejected.has(key)) return this.skip(t, "Novinar je već odbio ovaj signal: ne ubacuj ga ponovo. Nastavi sa ostalim zadacima.")
				const decision = await this.awaitApproval(args, title)
				if (decision === "reject") {
					this.rejected.add(key)
					return this.skip(t, "Novinar je odbio ovaj signal: ne ubacuj ga u izveštaj. Nastavi sa ostalim zadacima ili završi.")
				}
				args._approval = decision === "approve" ? "approved" : "pending"
				changed = true
			}
		}

		this.countCall()
		return changed ? this.rewrite(t, args) : t
	}

	private countCall(): void {
		const state = S()
		state.budget.toolCalls++
		if (state.budget.toolCalls % 8 === 0) scheduleBudgetEvent()
	}

	/** Creates the blocking HumanTask, publishes the question and waits (only this loop) for the journalist. */
	private awaitApproval(args: Record<string, unknown>, title: string): Promise<ApprovalDecision> {
		const state = S()
		const sources = parseSources(state, args.sources)
		const entityIds = Array.isArray(args.entityIds) ? args.entityIds.filter((e): e is string => typeof e === "string" && state.entities.has(e)) : []
		const draft: Partial<Finding> = {
			section: args.section as Finding["section"],
			title,
			text: typeof args.text === "string" ? clip(args.text, 900) : "",
			severity: "signal",
			signalCode: args.signalCode as Finding["signalCode"],
			sources,
			entityIds,
			claim: parseClaim(args.claim),
		}
		const task: HumanTask = {
			id: state.nextTaskId(),
			caseId: this.ctx.caseId,
			kind: "odobrenje",
			title,
			question: `Urednik predlaže signal: „${title}“. Ubaciti u izveštaj?`,
			hint: "Signal imenuje osobu ili tvrdi da je rok prekoračen. Proveri tekst i izvore pre odluke; sistem ne presuđuje.",
			fromAgentId: this.ctx.agentId,
			fromAgentName: this.ctx.agentName,
			entityId: entityIds[0] ?? this.ctx.entityId,
			findingDraft: draft,
			blocking: true,
			status: "open",
			createdAt: nowIso(),
		}
		state.tasks.set(task.id, task)
		state.touch()
		emit("pitanje.za_coveka", this.ctx.agentId, { task: structuredClone(task) })

		return new Promise<ApprovalDecision>((resolve) => {
			let timer: NodeJS.Timeout | undefined
			const settle = (d: ApprovalDecision) => {
				if (!state.pendingApprovals.delete(task.id)) return
				if (timer) clearTimeout(timer)
				resolve(d)
			}
			state.pendingApprovals.set(task.id, settle)
			timer = setTimeout(() => {
				if (!state.pendingApprovals.has(task.id)) return
				if (config.approvalTimeoutAction === "approve") {
					updateTask(task.id, { status: "approved", answer: "Automatski odobreno (HUMAN_AUTO_APPROVE_MS): novinar nije stigao da odluči.", answeredAt: nowIso() })
					settle("approve")
				} else {
					updateTask(task.id, { status: "expired", answeredAt: nowIso() })
					settle("expired")
				}
			}, config.humanAutoApproveMs)
		})
	}
}
