// File cache for every public-data response. The committed cache under data/cache/
// is what makes the demo run without internet and without the state websites
// being up. Only normalized, PII-free data is cached.
//
// DATA_MODE:
//   auto  (default) cache first; on a miss fetch live and write the cache
//   cache  cache only; a miss throws CacheMissError
//   live   always fetch live and refresh the cache

import crypto from "node:crypto"
import { appendFileSync } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { hasActivityContext, isNestedActivity, trackActivity, type ActivityDescriptor, type ActivityHandle } from "./activity"
import { slugify } from "./translit"

export type DataMode = "auto" | "cache" | "live"

export const CACHE_DIR = path.resolve(process.cwd(), "data", "cache")

/** DATA_MODE, or DATA_MODE_<SOURCE> (e.g. DATA_MODE_DRI=live) to refresh one source while the rest stays on the cache. */
export function getDataMode(source?: string): DataMode {
	const override = source ? process.env[`DATA_MODE_${source.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`] : undefined
	const m = (override ?? process.env.DATA_MODE ?? "auto").toLowerCase()
	return m === "cache" || m === "live" ? m : "auto"
}

export interface CacheEnvelope<T> {
	source: string
	key: string
	retrievedAt: string
	meta?: Record<string, unknown>
	data: T
}

export class CacheMissError extends Error {
	constructor(source: string, key: string) {
		super(`cache miss: ${source}/${key} (DATA_MODE=cache)`)
	}
}

/** Filesystem-safe cache key from arbitrary parts (Cyrillic ok). Long keys get a hash suffix. */
export function cacheKey(...parts: (string | number | undefined)[]): string {
	const raw = parts.filter((p) => p !== undefined && p !== "").join("__")
	const slug = slugify(raw, 120) || "empty"
	if (slug.length <= 90) return slug
	const hash = crypto.createHash("sha1").update(raw).digest("hex").slice(0, 10)
	return `${slug.slice(0, 80)}-${hash}`
}

function filePath(source: string, key: string): string {
	return path.join(CACHE_DIR, source, `${key}.json`)
}

export async function readCache<T>(source: string, key: string): Promise<CacheEnvelope<T> | null> {
	try {
		const parsed = JSON.parse(await fs.readFile(filePath(source, key), "utf8")) as CacheEnvelope<T>
		// CACHE_TRACE=<file>: list every cache file a run reads, to find files no code path uses any more (scripts/prune-cache.ts)
		if (process.env.CACHE_TRACE) appendFileSync(process.env.CACHE_TRACE, `${source}/${key}.json\n`)
		return parsed
	} catch {
		return null
	}
}

export async function writeCache<T>(source: string, key: string, data: T, meta?: Record<string, unknown>): Promise<CacheEnvelope<T>> {
	const envelope: CacheEnvelope<T> = { source, key, retrievedAt: new Date().toISOString(), meta, data }
	const file = filePath(source, key)
	await fs.mkdir(path.dirname(file), { recursive: true })
	await fs.writeFile(file, JSON.stringify(envelope, null, 1), "utf8")
	return envelope
}

/** Live-search descriptor of one cached request (see data/activity.ts); `after` refines the label / item count from the data. */
export interface CacheActivity<T> extends ActivityDescriptor {
	after?: (data: T, h: ActivityHandle) => void
}

function settle<T>(act: CacheActivity<T>, data: T, h: ActivityHandle): void {
	try {
		act.after?.(data, h)
	} catch {
		// labels are cosmetic
	}
}

/**
 * Cache-aware fetch. `source` is the adapter name ("acas", "jnportal", "apr", ...),
 * `key` must be deterministic from the inputs (use cacheKey()).
 *
 * With `activity` (and inside a tool's activity context) the call is one live-search request: a cache hit emits
 * u_toku/kes, a live fetch u_toku/ok (or greska). Cache hits inside the fetcher of another activity stay silent.
 */
export async function cached<T>(
	source: string,
	key: string,
	fetcher: () => Promise<T>,
	opts: { mode?: DataMode; meta?: Record<string, unknown>; activity?: CacheActivity<T> } = {},
): Promise<CacheEnvelope<T> & { fromCache: boolean }> {
	const mode = opts.mode ?? getDataMode(source)
	const act = opts.activity
	if (!act || !hasActivityContext()) {
		if (mode !== "live") {
			const hit = await readCache<T>(source, key)
			if (hit) return { ...hit, fromCache: true }
			if (mode === "cache") throw new CacheMissError(source, key)
		}
		const data = await fetcher()
		const envelope = await writeCache(source, key, data, opts.meta)
		return { ...envelope, fromCache: false }
	}
	if (mode !== "live") {
		const hit = await readCache<T>(source, key)
		if (hit) {
			const result = { ...hit, fromCache: true }
			if (isNestedActivity()) return result
			return trackActivity(act, (h) => {
				h.cached(hit.retrievedAt)
				settle(act, hit.data, h)
				return result
			})
		}
		if (mode === "cache") {
			return trackActivity(act, () => {
				throw new CacheMissError(source, key)
			})
		}
	}
	return trackActivity(act, async (h) => {
		const data = await fetcher()
		const envelope = await writeCache(source, key, data, opts.meta)
		settle(act, data, h)
		return { ...envelope, fromCache: false }
	})
}
