// Live search: every request an agent's tool makes to a public source becomes a SourceActivity ("izvor.upit" on the Mozaik
// bus, see src/mozaik/activity.ts). The data layer knows nothing about Mozaik: the tool handler runs inside an
// AsyncLocalStorage context {agentId, agentName, tool}, adapters wrap their requests in trackActivity(), and a sink
// installed at boot publishes the events. Outside a context (CLI probes, warm-cache, resolver) everything is a no-op.
// Nothing in this file ever throws into the caller.

import { AsyncLocalStorage } from "node:async_hooks"
import type { SourceActivity } from "../shared/types"

export interface ActivityContext {
	agentId: string
	agentName: string
	tool: string
	caseId?: string
	/** false when the case (or map) this request belongs to is closed or replaced: the bridge then drops the events */
	alive?: () => boolean
	/** scripted mode: the pause that stands in for network latency, awaited inside the activity window of a cache hit */
	simulate?: () => Promise<void>
}

interface Store extends ActivityContext {
	nested: boolean
}

export type ActivitySink = (ctx: ActivityContext, activity: SourceActivity) => void

export interface ActivityDescriptor {
	source: string
	kind: SourceActivity["kind"]
	action: SourceActivity["action"]
	label: string
	url?: string
}

export interface ActivityHandle {
	/** rows / results returned, when known */
	items(n: number | undefined): void
	/** the data came from the cache (or a local copy); `at` is when that copy was fetched */
	cached(at?: string): void
	/** a more precise label once the result is known ("… (1.537)") */
	label(text: string): void
}

/** The adapters' source labels, shared so every call site spells them the same way. */
export const SRC = {
	acas: { source: "ACAS", kind: "acas" },
	jn: { source: "Portal javnih nabavki", kind: "jnportal" },
	iw: { source: "Integrity Watch", kind: "integrity_watch" },
	apr: { source: "APR", kind: "apr" },
	dri: { source: "DRI", kind: "dri" },
	sg: { source: "Službeni glasnik", kind: "paragraf" },
	pep: { source: "OpenSanctions / KRIK", kind: "opensanctions" },
	cw: { source: "CompanyWall", kind: "companywall" },
} as const satisfies Record<string, Pick<ActivityDescriptor, "source" | "kind">>

/** Institution name as people say it, for labels: "Infrastruktura železnice Srbije a.d." -> "Infrastruktura železnice Srbije". */
export function shortInstitution(name: string): string {
	return name.replace(/\s+(a\.d\.|d\.o\.o\.|ad|doo|j\.p\.|jp)(\s+.*)?$/i, "").trim() || name
}

const als = new AsyncLocalStorage<Store>()
let sink: ActivitySink | undefined
let seq = 0

export function setActivitySink(fn: ActivitySink | undefined): void {
	sink = fn
}

export function withActivityContext<T>(ctx: ActivityContext, fn: () => T): T {
	return als.run({ ...ctx, nested: false }, fn)
}

export function hasActivityContext(): boolean {
	return !!sink && !!als.getStore()
}

/** True inside another activity (a request made by the fetcher of a bigger one): its cache hits are not worth an event. */
export function isNestedActivity(): boolean {
	return als.getStore()?.nested ?? false
}

const NOOP: ActivityHandle = { items() {}, cached() {}, label() {} }

export function shortError(err: unknown): string {
	const e = err as { message?: unknown; status?: unknown; name?: unknown } | null
	const msg = typeof e?.message === "string" ? e.message : String(err)
	if (/^cache miss/i.test(msg)) return "nema u kešu"
	if (typeof e?.status === "number") return `HTTP ${e.status}`
	if (/timeout|timed out|aborted/i.test(msg)) return "isteklo vreme"
	if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|fetch failed/i.test(msg)) return "veza nije uspela"
	const flat = msg.replace(/\s+/g, " ").trim()
	return flat.length > 120 ? `${flat.slice(0, 119)}…` : flat
}

/**
 * Emits "u_toku", runs `fn`, then emits the final event with the same id: "ok" (live), "kes" (when `fn` called
 * `handle.cached()`) or "greska" (the error is rethrown unchanged). The id is unique per request.
 */
export async function trackActivity<T>(desc: ActivityDescriptor, fn: (h: ActivityHandle) => Promise<T> | T): Promise<T> {
	const store = als.getStore()
	if (!sink || !store) return fn(NOOP)
	const id = `q${(++seq).toString(36)}`
	const started = Date.now()
	let label = desc.label
	let items: number | undefined
	let cached = false
	let cachedAt: string | undefined
	const handle: ActivityHandle = {
		items(n) {
			if (typeof n === "number" && Number.isFinite(n)) items = n
		},
		cached(at) {
			cached = true
			cachedAt = at
		},
		label(text) {
			if (text) label = text
		},
	}
	const emit = (status: SourceActivity["status"], extra: Partial<SourceActivity> = {}): void => {
		try {
			sink?.(store, {
				id,
				agentId: store.agentId,
				agentName: store.agentName,
				tool: store.tool,
				source: desc.source,
				kind: desc.kind,
				action: desc.action,
				label,
				...(desc.url ? { url: desc.url } : {}),
				status,
				...extra,
				at: new Date().toISOString(),
			})
		} catch {
			// a broken sink must never break a data request
		}
	}
	emit("u_toku")
	try {
		const result = await als.run({ ...store, nested: true }, () => fn(handle))
		if (cached && !store.nested && store.simulate) {
			try {
				await store.simulate()
			} catch {
				// pacing only
			}
		}
		emit(cached ? "kes" : "ok", {
			ms: Date.now() - started,
			...(items !== undefined ? { items } : {}),
			...(cached && cachedAt ? { cachedAt } : {}),
		})
		return result
	} catch (err) {
		emit("greska", { ms: Date.now() - started, error: shortError(err) })
		throw err
	}
}
