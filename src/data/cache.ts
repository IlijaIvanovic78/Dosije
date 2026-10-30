// File cache for every public-data response. The committed cache under data/cache/
// is what makes the demo run without internet and without the state websites
// being up. Only normalized, PII-free data is cached.
//
// DATA_MODE:
//   auto  (default) cache first; on a miss fetch live and write the cache
//   cache  cache only; a miss throws CacheMissError
//   live   always fetch live and refresh the cache

import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { slugify } from "./translit"

export type DataMode = "auto" | "cache" | "live"

export const CACHE_DIR = path.resolve(process.cwd(), "data", "cache")

export function getDataMode(): DataMode {
	const m = (process.env.DATA_MODE ?? "auto").toLowerCase()
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
		return JSON.parse(await fs.readFile(filePath(source, key), "utf8")) as CacheEnvelope<T>
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

/**
 * Cache-aware fetch. `source` is the adapter name ("acas", "jnportal", "apr", ...),
 * `key` must be deterministic from the inputs (use cacheKey()).
 */
export async function cached<T>(
	source: string,
	key: string,
	fetcher: () => Promise<T>,
	opts: { mode?: DataMode; meta?: Record<string, unknown> } = {},
): Promise<CacheEnvelope<T> & { fromCache: boolean }> {
	const mode = opts.mode ?? getDataMode()
	if (mode !== "live") {
		const hit = await readCache<T>(source, key)
		if (hit) return { ...hit, fromCache: true }
		if (mode === "cache") throw new CacheMissError(source, key)
	}
	const data = await fetcher()
	const envelope = await writeCache(source, key, data, opts.meta)
	return { ...envelope, fromCache: false }
}
