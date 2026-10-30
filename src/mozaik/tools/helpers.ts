import type { Tool } from "@mozaik-ai/core"
import { config } from "../../config"
import { CacheMissError } from "../../data/cache"
import type { SourceRef } from "../../shared/types"
import { S, type ToolCtx } from "../domain"
import { clip, errorMessage, hashString, seeded, sleep } from "../util"

export const MAX_OUTPUT = 4000

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
	return { kind: s.kind, title: clip(s.title, 140), url: s.url, publishedAt: s.publishedAt, official: s.official }
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

/** Scripted mode with cached data: simulate the 150-600 ms a real source call takes (seeded, scaled by DEMO_SPEED). */
export async function sourceLatency(agentId: string): Promise<void> {
	if (config.mode !== "scripted" || config.dataMode === "live") return
	const n = (latencyCounters.get(agentId) ?? 0) + 1
	latencyCounters.set(agentId, n)
	const rnd = seeded(hashString(`${agentId}:${n}`))
	const ms = (150 + rnd() * 450) * config.demoSpeed
	if (ms >= 1) await sleep(ms)
}

export interface ToolSpec {
	name: string
	description: string
	properties: Record<string, unknown>
	required?: string[]
	/** pure bookkeeping tools (no external source) skip the simulated source latency */
	local?: boolean
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
				if (!state.isCurrent(ctx.caseId)) return fit({ ok: false, error: "Slučaj je zatvoren ili zamenjen novim." })
				if (!spec.local) await sourceLatency(ctx.agentId)
				const out = await spec.handler(args && typeof args === "object" ? (args as Record<string, unknown>) : {})
				return fit(out)
			} catch (err) {
				return fit({ ok: false, error: friendlyError(err) })
			}
		},
	}
}

export const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined)
