import type { Tool } from "@mozaik-ai/core"
import { config } from "../../config"
import { withActivityContext } from "../../data/activity"
import { CacheMissError } from "../../data/cache"
import type { SourceRef } from "../../shared/types"
import { S, type ToolCtx } from "../domain"
import { clip, errorMessage, hashString, seeded, sleep } from "../util"

export const MAX_OUTPUT = 4000
/** Upper bound of one source tool call; the portal crawl has its own 75 s budget inside, so this only catches a hung request. */
export const TOOL_TIMEOUT_MS = 150_000

type Json = unknown

function arrayPaths(node: Json, path: (string | number)[] = [], out: { path: (string | number)[]; len: number }[] = []): typeof out {
	if (Array.isArray(node)) {
		if (node.length > 1) out.push({ path, len: JSON.stringify(node).length })
		node.forEach((v, i) => arrayPaths(v, [...path, i], out))
	} else if (node && typeof node === "object") {
		for (const [k, v] of Object.entries(node)) arrayPaths(v, [...path, k], out)
	}
	return out
}

function at(root: Json, path: (string | number)[]): unknown {
	let cur: unknown = root
	for (const p of path) cur = (cur as Record<string | number, unknown>)[p]
	return cur
}

function shortenStrings(node: Json, max: number): void {
	if (Array.isArray(node)) node.forEach((v, i) => (typeof v === "string" && v.length > max ? (node[i] = `${v.slice(0, max - 1)}…`) : shortenStrings(v, max)))
	else if (node && typeof node === "object") {
		const obj = node as Record<string, unknown>
		for (const [k, v] of Object.entries(obj)) {
			if (typeof v === "string" && v.length > max) obj[k] = `${v.slice(0, max - 1)}…`
			else shortenStrings(v, max)
		}
	}
}

/** Compact JSON for the model, at most `max` characters: trims the biggest arrays first, then long strings. */
export function fit(value: unknown, max = MAX_OUTPUT): string {
	let s = JSON.stringify(value) ?? "null"
	if (s.length <= max) return s
	const clone = JSON.parse(s) as Json
	let truncated = false
	for (let i = 0; i < 80 && s.length > max; i++) {
		const arrays = arrayPaths(clone).sort((a, b) => b.len - a.len)
		if (arrays.length === 0) break
		const arr = at(clone, arrays[0].path) as unknown[]
		arr.length = Math.max(1, arr.length - Math.max(1, Math.ceil(arr.length / 4)))
		truncated = true
		s = JSON.stringify(clone)
	}
	for (const limit of [400, 240, 160, 100]) {
		if (s.length <= max) break
		shortenStrings(clone, limit)
		truncated = true
		s = JSON.stringify(clone)
	}
	if (truncated && clone && typeof clone === "object" && !Array.isArray(clone)) {
		;(clone as Record<string, unknown>).skraceno = true
		s = JSON.stringify(clone)
	}
	return s.length <= max ? s : `${s.slice(0, max - 20)}…(skraćeno)`
}

export function friendlyError(err: unknown): string {
	if (err instanceof CacheMissError) return "Nema keširanih podataka za ovaj upit (DATA_MODE=cache). Probaj drugi upit ili preskoči ovaj korak."
	return `Izvor trenutno nije dostupan: ${clip(errorMessage(err), 200)}`
}

export function srcOut(s: SourceRef): Record<string, unknown> {
	S().registerSources([s])
	return { kind: s.kind, title: clip(s.title, 190), url: s.url, publishedAt: s.publishedAt, official: s.official }
}

export function uniqueSources(list: (SourceRef | undefined)[]): SourceRef[] {
	const seen = new Set<string>()
	const out: SourceRef[] = []
	for (const s of list) {
		if (!s || seen.has(s.url)) continue
		seen.add(s.url)
		out.push(s)
	}
	return out
}

const latencyCounters = new Map<string, number>()

/** The simulated latency of one tool call: spent inside the live-search activities of cache hits, the rest before the tool returns. */
export interface LatencyPlan {
	take(): Promise<void>
	drain(): Promise<void>
}

/**
 * Scripted mode with cached data: simulate the 150-600 ms a real source call takes (seeded, scaled by DEMO_SPEED).
 * The pause happens INSIDE the activity window (u_toku -> kes), so the live feed shows the request in progress; the total
 * per tool call stays what it was.
 */
export function planLatency(agentId: string): LatencyPlan | undefined {
	if (config.mode !== "scripted" || config.dataMode === "live") return undefined
	const n = (latencyCounters.get(agentId) ?? 0) + 1
	latencyCounters.set(agentId, n)
	const rnd = seeded(hashString(`${agentId}:${n}`))
	const total = (150 + rnd() * 450) * config.demoSpeed
	let remaining = total
	const spend = async (ms: number) => {
		remaining = Math.max(0, remaining - ms)
		if (ms >= 1) await sleep(ms)
	}
	return {
		take: () => spend(Math.min(remaining, total * 0.7)),
		drain: () => spend(remaining),
	}
}

export interface ToolSpec {
	name: string
	description: string
	properties: Record<string, unknown>
	required?: string[]
	/** pure bookkeeping tools (no external source) skip the simulated source latency */
	local?: boolean
	/** hard limit of one call in ms (default TOOL_TIMEOUT_MS) */
	timeoutMs?: number
	/** output limit in characters (default MAX_OUTPUT) */
	max?: number
	handler: (args: Record<string, unknown>) => Promise<unknown> | unknown
}

export function buildTool(ctx: ToolCtx, spec: ToolSpec): Tool {
	return {
		type: "function",
		name: spec.name,
		description: spec.description,
		parameters: { type: "object", properties: spec.properties, required: spec.required ?? [], additionalProperties: true },
		strict: false,
		invoke: async (args: unknown) => {
			try {
				const state = S()
				const isAlive = () => (ctx.group === "trijaza" ? state.mapaRunning(ctx.caseId) : state.isCurrent(ctx.caseId))
				if (!isAlive()) return fit({ ok: false, error: ctx.group === "trijaza" ? "Mapa je zatvorena ili zamenjena novom." : "Slučaj je zatvoren ili zamenjen novim." })
				const latency = spec.local ? undefined : planLatency(ctx.agentId)
				// every public-source request the handler makes is attributed to this agent and tool (live search, "izvor.upit")
				const work = withActivityContext(
					{ agentId: ctx.agentId, agentName: ctx.agentName, tool: spec.name, caseId: ctx.caseId, alive: isAlive, simulate: latency?.take },
					async () => {
						const result = await spec.handler(args && typeof args === "object" ? (args as Record<string, unknown>) : {})
						await latency?.drain()
						return result
					},
				)
				// no tool call may hang the dossier: a source that does not answer in time is reported as such and the loop goes on
				const limit = spec.local ? 0 : (spec.timeoutMs ?? TOOL_TIMEOUT_MS)
				let timer: NodeJS.Timeout | undefined
				const out = limit
					? await Promise.race([
							work,
							new Promise<never>((_, reject) => {
								timer = setTimeout(() => reject(new Error(`izvor nije odgovorio u roku od ${Math.round(limit / 1000)} s`)), limit)
							}),
						]).finally(() => clearTimeout(timer))
					: await work
				return fit(out, spec.max)
			} catch (err) {
				return fit({ ok: false, error: friendlyError(err) })
			}
		},
	}
}

export const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined)
