// Small HTTP helper shared by all source adapters: timeouts, retries with backoff,
// per-host concurrency limits (be polite to public servers) and optional extra CA
// certificates for servers that send an incomplete TLS chain (e.g. APR).

import fs from "node:fs"
import https from "node:https"
import tls from "node:tls"
import { sharedPermit } from "../session/permits"

export const USER_AGENT =
	"Mozilla/5.0 (compatible; DosijeBot/0.1; investigative research tool for journalists; +https://github.com/)"

export interface HttpOptions {
	method?: "GET" | "POST"
	headers?: Record<string, string>
	body?: string | Record<string, unknown> | unknown[] // objects/arrays are sent as JSON
	timeoutMs?: number // default 20000
	retries?: number // default 2 (network errors, 429, 5xx)
	caFile?: string // path to an extra PEM bundle, e.g. "certs/apr-chain.pem"
}

export interface HttpResponse {
	status: number
	headers: Record<string, string>
	buffer: Buffer
	text(): string
	json<T = unknown>(): T
}

export class HttpError extends Error {
	constructor(
		public readonly status: number,
		public readonly url: string,
		public readonly bodySnippet: string,
	) {
		super(`HTTP ${status} for ${url}: ${bodySnippet.slice(0, 200)}`)
	}
}

const MAX_PER_HOST = 4
const inflight = new Map<string, number>()
const waiters = new Map<string, Array<() => void>>()

async function acquire(host: string): Promise<void> {
	const n = inflight.get(host) ?? 0
	if (n < MAX_PER_HOST) {
		inflight.set(host, n + 1)
		return
	}
	await new Promise<void>((resolve) => {
		const q = waiters.get(host) ?? []
		q.push(resolve)
		waiters.set(host, q)
	})
	inflight.set(host, (inflight.get(host) ?? 0) + 1)
}

function release(host: string): void {
	inflight.set(host, Math.max(0, (inflight.get(host) ?? 1) - 1))
	const next = waiters.get(host)?.shift()
	if (next) next()
}

const caCache = new Map<string, string[]>()
function caBundle(caFile: string): string[] {
	let bundle = caCache.get(caFile)
	if (!bundle) {
		bundle = [...tls.rootCertificates, fs.readFileSync(caFile, "utf8")]
		caCache.set(caFile, bundle)
	}
	return bundle
}

function makeResponse(status: number, headers: Record<string, string>, buffer: Buffer): HttpResponse {
	return {
		status,
		headers,
		buffer,
		text: () => buffer.toString("utf8"),
		json: <T>() => JSON.parse(buffer.toString("utf8")) as T,
	}
}

function requestWithCa(url: string, opts: HttpOptions, body: string | undefined, headers: Record<string, string>): Promise<HttpResponse> {
	return new Promise((resolve, reject) => {
		const req = https.request(
			url,
			{ method: opts.method ?? "GET", headers, ca: caBundle(opts.caFile!), timeout: opts.timeoutMs ?? 20000 },
			(res) => {
				const chunks: Buffer[] = []
				res.on("data", (c: Buffer) => chunks.push(c))
				res.on("end", () => {
					const h: Record<string, string> = {}
					for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) h[k] = Array.isArray(v) ? v.join(", ") : String(v)
					resolve(makeResponse(res.statusCode ?? 0, h, Buffer.concat(chunks)))
				})
				res.on("error", reject)
			},
		)
		req.on("timeout", () => req.destroy(new Error(`timeout after ${opts.timeoutMs ?? 20000}ms`)))
		req.on("error", reject)
		if (body !== undefined) req.write(body)
		req.end()
	})
}

async function once(url: string, opts: HttpOptions): Promise<HttpResponse> {
	const headers: Record<string, string> = {
		"User-Agent": USER_AGENT,
		Accept: "application/json, text/html;q=0.9, */*;q=0.8",
		"Accept-Language": "sr-RS,sr;q=0.9,en;q=0.6",
		...opts.headers,
	}
	let body: string | undefined
	if (opts.body !== undefined) {
		if (typeof opts.body === "string") body = opts.body
		else {
			body = JSON.stringify(opts.body)
			headers["Content-Type"] ??= "application/json"
		}
	}
	if (opts.caFile) return requestWithCa(url, opts, body, headers)

	const res = await fetch(url, {
		method: opts.method ?? (body !== undefined ? "POST" : "GET"),
		headers,
		body,
		redirect: "follow",
		signal: AbortSignal.timeout(opts.timeoutMs ?? 20000),
	})
	const h: Record<string, string> = {}
	res.headers.forEach((v, k) => (h[k] = v))
	return makeResponse(res.status, h, Buffer.from(await res.arrayBuffer()))
}

/** Low-level request. Throws HttpError for non-2xx after retries. */
export async function httpRequest(url: string, opts: HttpOptions = {}): Promise<HttpResponse> {
	const host = new URL(url).host
	const retries = opts.retries ?? 2
	let lastError: unknown
	for (let attempt = 0; attempt <= retries; attempt++) {
		await acquire(host)
		// on the server the per-host limit of this session sits under one shared by all sessions (HTTP_PER_HOST_TOTAL)
		const releaseShared = await sharedPermit(`host:${host}`)
		try {
			const res = await once(url, opts)
			if (res.status >= 200 && res.status < 300) return res
			const retryable = res.status === 429 || res.status >= 500
			lastError = new HttpError(res.status, url, res.text().slice(0, 500))
			if (!retryable) throw lastError
		} catch (err) {
			lastError = err
			if (err instanceof HttpError && !(err.status === 429 || err.status >= 500)) throw err
		} finally {
			releaseShared()
			release(host)
		}
		if (attempt < retries) await new Promise((r) => setTimeout(r, 600 * 2 ** attempt + Math.random() * 300))
	}
	throw lastError
}

export async function getJson<T = unknown>(url: string, opts: HttpOptions = {}): Promise<T> {
	return (await httpRequest(url, opts)).json<T>()
}

export async function getText(url: string, opts: HttpOptions = {}): Promise<string> {
	return (await httpRequest(url, opts)).text()
}

export async function getBuffer(url: string, opts: HttpOptions = {}): Promise<Buffer> {
	return (await httpRequest(url, opts)).buffer
}

export async function postJson<T = unknown>(url: string, body: HttpOptions["body"], opts: HttpOptions = {}): Promise<T> {
	return (await httpRequest(url, { ...opts, method: "POST", body })).json<T>()
}
