import { asciiFold } from "../data/translit"
import { clipWords } from "../shared/text"

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export function log(scope: string, ...args: unknown[]): void {
	console.log(`[${new Date().toISOString().slice(11, 23)}] ${scope}`, ...args)
}

export function logError(scope: string, err: unknown): void {
	console.error(`[${new Date().toISOString().slice(11, 23)}] ${scope}`, err instanceof Error ? (err.stack ?? err.message) : err)
}

export const nowIso = () => new Date().toISOString()

/** Deterministic PRNG (mulberry32) so scripted runs look alike. */
export function seeded(seed: number): () => number {
	let a = seed >>> 0
	return () => {
		a = (a + 0x6d2b79f5) >>> 0
		let t = a
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

export function hashString(s: string): number {
	let h = 2166136261
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i)
		h = Math.imul(h, 16777619)
	}
	return h >>> 0
}

/** Word-boundary clip with an ellipsis (see shared/text.ts). */
export const clip = clipWords

export function hostOf(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, "").toLowerCase()
	} catch {
		return ""
	}
}

export function isHttpUrl(url: unknown): url is string {
	if (typeof url !== "string") return false
	try {
		const u = new URL(url.trim())
		return u.protocol === "http:" || u.protocol === "https:"
	} catch {
		return false
	}
}

export function normUrl(url: string): string {
	return url.trim().replace(/\/+$/, "")
}

/** Lowercase ASCII, letters and digits only: "v.d. generalnog direktora" and "vd generalnog direktora" compare equal. */
export function normClaim(s: string): string {
	return asciiFold(s).replace(/[^a-z0-9]+/g, "")
}

export function tokens(s: string): string[] {
	return asciiFold(s)
		.split(/[^a-z0-9]+/)
		.filter((t) => t.length > 2)
}

export function jaccard(a: string, b: string): number {
	const ta = new Set(tokens(a))
	const tb = new Set(tokens(b))
	if (ta.size === 0 || tb.size === 0) return 0
	let inter = 0
	for (const t of ta) if (tb.has(t)) inter++
	return inter / (ta.size + tb.size - inter)
}

export function slug(s: string, max = 60): string {
	return asciiFold(s)
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, max)
}

export function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message
	return String(err)
}
