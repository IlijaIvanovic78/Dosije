// Event bridge: every Mozaik SemanticEvent is turned into a sanitized WireEvent exactly once (sequence number,
// producer name, no full contexts, no tool functions). The SSE bridge, the Zapisničar and the CLI all consume these.

import type { SemanticEvent } from "@mozaik-ai/core"
import type { DosijeState } from "./state"
import type { AgentInfo, Budget, DosijeSnapshot, RunStats, WireEvent } from "../shared/types"
import { clip } from "./util"

type Listener<T> = (data: T) => void

/** `input` objects of transitions that the gate rewrote (PII scrub, approval flag): lets interception.finished say rewritten:true. */
export const rewrittenInputs = new WeakSet<object>()

class Bus {
	private seq = 0
	private wire = new Set<Listener<WireEvent>>()
	private snapshots = new Set<Listener<DosijeSnapshot>>()
	private statsListeners = new Set<Listener<{ stats: RunStats; budget: Budget }>>()
	private cache = new WeakMap<SemanticEvent, WireEvent | null>()

	onWire(fn: Listener<WireEvent>): () => void {
		this.wire.add(fn)
		return () => this.wire.delete(fn)
	}
	onSnapshot(fn: Listener<DosijeSnapshot>): () => void {
		this.snapshots.add(fn)
		return () => this.snapshots.delete(fn)
	}
	onStats(fn: Listener<{ stats: RunStats; budget: Budget }>): () => void {
		this.statsListeners.add(fn)
		return () => this.statsListeners.delete(fn)
	}

	emitSnapshot(snapshot: DosijeSnapshot): void {
		for (const fn of this.snapshots) safe(fn, snapshot)
	}
	emitStats(stats: RunStats, budget: Budget): void {
		for (const fn of this.statsListeners) safe(fn, { stats, budget })
	}

	wireOf(event: SemanticEvent): WireEvent | null | undefined {
		return this.cache.get(event)
	}

	/** Called by the SSE bridge participant for every event on the bus. Returns null for events of a stale case. */
	ingest(event: SemanticEvent, state: DosijeState): WireEvent | null {
		const existing = this.cache.get(event)
		if (existing !== undefined) return existing
		const payload = (event.payload ?? {}) as Record<string, unknown>
		const loopId = typeof payload.loopId === "string" ? payload.loopId : undefined
		if (loopId && state.staleLoops.has(loopId)) {
			this.cache.set(event, null)
			return null
		}
		state.stats.events++
		if (loopId) {
			const l = state.activeLoops.get(loopId)
			if (l) l.lastEventAt = Date.now()
		}
		switch (event.type) {
			case "inference.started":
				state.stats.inferences++
				break
			case "function_call.started":
				state.stats.toolCalls++
				break
			case "interception.started":
				state.stats.interceptions++
				break
			case "claim.blocked":
				state.stats.blockedClaims++
				break
			case "conflict.resolved":
				state.stats.conflicts++
				break
		}
		const wire: WireEvent = {
			seq: ++this.seq,
			t: event.occurredAt.getTime(),
			type: event.type,
			producerId: event.producerId,
			producerName: state.nameOf(event.producerId),
			loopId,
			payload: sanitize(event, payload, state),
		}
		this.cache.set(event, wire)
		for (const fn of this.wire) safe(fn, wire)
		return wire
	}
}

function safe<T>(fn: Listener<T>, data: T): void {
	try {
		fn(data)
	} catch (err) {
		console.error("[bus] listener failed:", err)
	}
}

export const bus = new Bus()

// ─── sanitizing ──────────────────────────────────────────────────────────────

function shrink(value: unknown, depth = 0): unknown {
	if (typeof value === "string") return value.length > 300 ? `${value.slice(0, 299)}…` : value
	if (Array.isArray(value)) return depth > 3 ? `[${value.length}]` : value.slice(0, 12).map((v) => shrink(v, depth + 1))
	if (value && typeof value === "object") {
		if (depth > 3) return "{…}"
		return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, shrink(v, depth + 1)]))
	}
	return value
}

function parseArgs(raw: unknown): Record<string, unknown> {
	if (typeof raw !== "string") return {}
	try {
		const parsed = JSON.parse(raw)
		return parsed && typeof parsed === "object" ? (shrink(parsed) as Record<string, unknown>) : {}
	} catch {
		return { raw: clip(raw, 200) }
	}
}

function infoOf(state: DosijeState, id: string): AgentInfo | null {
	const info = state.agentInfo.get(id)
	return info ? structuredClone(info) : null
}

function sanitize(event: SemanticEvent, p: Record<string, unknown>, state: DosijeState): unknown {
	const loopId = p.loopId as string | undefined
	switch (event.type) {
		case "participant.joined":
		case "participant.left": {
			const m = p as unknown as { id: string; name: string; role: string; capabilities?: readonly string[] }
			return { manifest: { id: m.id, name: m.name, role: m.role, capabilities: [...(m.capabilities ?? [])] }, info: infoOf(state, m.id) }
		}
		case "message.sent":
			return { message: String(p.message ?? "") }
		case "message_received.started":
			return { loopId, content: String(p.content ?? "") }
		case "message_received.completed": {
			const ctx = p.context as { items?: unknown[] } | undefined
			return { loopId, items: ctx?.items?.length ?? 0 }
		}
		case "inference.started": {
			const ctx = p.context as { items?: unknown[] } | undefined
			return { loopId, model: String(p.model ?? ""), items: ctx?.items?.length ?? 0 }
		}
		case "inference.completed": {
			const items = (p.items as Record<string, unknown>[] | undefined) ?? []
			const call = items.find((i) => i.type === "function_call")
			const message = items.find((i) => i.type === "message")
			const usage = p.tokenUsage as { inputTokens?: number; outputTokens?: number } | undefined
			const tokens = usage ? { input: usage.inputTokens ?? 0, output: usage.outputTokens ?? 0 } : undefined
			if (call) return { loopId, kind: "tool_call", toolName: String(call.name ?? ""), tokens }
			const text = (message?.content as { text?: string } | undefined)?.text
			return { loopId, kind: "message", text: text ? clip(text, 400) : undefined, tokens }
		}
		case "function_call.started": {
			const call = p.call as { callId?: string; name?: string; args?: string } | undefined
			return { loopId, callId: call?.callId ?? "", name: call?.name ?? "", args: parseArgs(call?.args) }
		}
		case "function_call.completed": {
			const out = p.output as { text?: string } | undefined
			return { loopId, callId: String(p.callId ?? ""), output: clip(out?.text ?? "", 1500) }
		}
		case "model.answer": {
			const answer = p.answer as { content?: { text?: string } } | undefined
			return { loopId, text: answer?.content?.text ?? "" }
		}
		case "interception.started": {
			const input = p.input as { call?: { name?: string } } | undefined
			return { loopId, nextStateId: String(p.nextStateId ?? ""), toolName: input?.call?.name }
		}
		case "interception.finished":
			return { loopId, nextStateId: String(p.nextStateId ?? ""), rewritten: !!p.input && typeof p.input === "object" && rewrittenInputs.has(p.input as object) }
		default:
			// custom domain events carry plain, already clone-safe objects
			return event.payload
	}
}
