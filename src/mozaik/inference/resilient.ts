// ResilientInferenceRunner: the LLM mode runner. Wraps Mozaik's supportedModels (endpoint.infer), adds a concurrency
// semaphore (LLM_CONCURRENCY per session, under LLM_CONCURRENCY_TOTAL shared by all sessions on the server), retries on 429/5xx/timeouts (3 attempts, backoff), a 90 s timeout and token
// accounting. It NEVER throws: Mozaik's runLoop does not catch errors, so an exception here would be an unhandled
// rejection that kills the process. On final failure the loop ends with a "Agent nije uspeo: ..." message.

import { AnthropicMessages, ModelMessageItem, SemanticEvent, supportedModels, type Endpoint, type InferenceInput, type InferenceOutput, type InferenceRunner } from "@mozaik-ai/core"
import { config } from "../../config"
import { sharedPermit } from "../../session/permits"
import type { DosijeState } from "../state"
import { clip, errorMessage, log, sleep } from "../util"
import { ScriptedInferenceRunner } from "./scripted"

type GenerativeModelLike = (typeof supportedModels)[number]

const TIMEOUT_MS = 90_000
const ATTEMPTS = 3
const BACKOFF_MS = [1500, 4000, 9000]

export class Semaphore {
	private waiting: (() => void)[] = []
	private active = 0
	constructor(private readonly limit: number) {}

	async acquire(): Promise<void> {
		if (this.active < this.limit) {
			this.active++
			return
		}
		await new Promise<void>((resolve) => this.waiting.push(resolve))
	}

	release(): void {
		const next = this.waiting.shift()
		if (next) next()
		else this.active = Math.max(0, this.active - 1)
	}
}

export function failure(reason: string): InferenceOutput {
	return { items: [ModelMessageItem.rehydrate({ text: `Agent nije uspeo: ${clip(reason, 240)}` })], tokenUsage: undefined, rowResponse: null }
}

function statusOf(err: unknown): number | undefined {
	const e = err as { status?: number; statusCode?: number; response?: { status?: number }; code?: string | number }
	const s = e?.status ?? e?.statusCode ?? e?.response?.status
	if (typeof s === "number") return s
	const m = /\b(4\d\d|5\d\d)\b/.exec(errorMessage(err))
	return m ? Number(m[1]) : undefined
}

/** The account has no credits or its quota is used up, an error that does not pass, so retrying only wastes time.
 *  OpenAI answers 429 (insufficient_quota), Anthropic 402 (billing_error) or 400 ("credit balance is too low"). */
export function outOfCredits(err: unknown): boolean {
	const status = statusOf(err)
	const msg = errorMessage(err)
	if (status === 429) return /no credits|insufficient[_ ]quota|exceeded your current quota|billing/i.test(msg)
	if (status === 402) return true
	return status === 400 && /credit balance is too low/i.test(msg)
}

// Claude: the API requires max_tokens, which Mozaik's mapper sends only when the input sets it, and thinking counts
// toward it. 16k stays under the SDK's limit for a request without streaming.
const CLAUDE_MAX_TOKENS = 16_000
const claudeEndpoints = new Map<string, Endpoint>()

/** Mozaik's Anthropic endpoint with max_tokens and automatic prompt caching (one top-level cache_control): every
 *  agent loop sends its whole conversation again on each step, and the repeated prefix is then read at a tenth of the price. */
function claudeEndpoint(entry: GenerativeModelLike): Endpoint {
	let endpoint = claudeEndpoints.get(entry.specification.name)
	if (!endpoint) {
		const mapper = entry.endpoint.endpointMapper
		endpoint = new AnthropicMessages({
			toRequest: (input) => {
				const request = mapper.toRequest(input)
				request.max_tokens ??= Math.min(CLAUDE_MAX_TOKENS, entry.specification.maxOutputTokens)
				request.cache_control = { type: "ephemeral" }
				return request
			},
			toResponse: (response) => mapper.toResponse(response),
		})
		claudeEndpoints.set(entry.specification.name, endpoint)
	}
	return endpoint
}

function retryable(err: unknown): boolean {
	if (outOfCredits(err)) return false
	const status = statusOf(err)
	if (status === 429 || (status !== undefined && status >= 500)) return true
	const msg = errorMessage(err).toLowerCase()
	return /timeout|timed out|econnreset|etimedout|enotfound|eai_again|socket hang up|fetch failed|network|overloaded|rate limit/.test(msg)
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
	let timer: NodeJS.Timeout | undefined
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`timeout nakon ${Math.round(ms / 1000)} s`)), ms)
	})
	try {
		return await Promise.race([p, timeout])
	} finally {
		if (timer) clearTimeout(timer)
	}
}

export class ResilientInferenceRunner implements InferenceRunner {
	private readonly semaphore: Semaphore
	// once the provider says the account has no credits, the agents go on with the scripted policies: the same tools, the
	// same public data and the same gate, only the model is replaced. A demo never ends with an empty dossier.
	private scripted: ScriptedInferenceRunner | undefined

	constructor(
		private readonly state: DosijeState,
		private readonly models: GenerativeModelLike[] = supportedModels,
	) {
		this.semaphore = new Semaphore(config.llmConcurrency)
	}

	async run(input: InferenceInput): Promise<InferenceOutput> {
		if (this.scripted) return this.scripted.run(input)
		try {
			return await this.runInner(input)
		} catch (err) {
			return failure(errorMessage(err))
		}
	}

	async *stream(input: InferenceInput) {
		yield SemanticEvent.create("inference.output", input.model, await this.run(input))
	}

	private async runInner(input: InferenceInput): Promise<InferenceOutput> {
		const entry = this.models.find((m) => m.specification.name === input.model)
		if (!entry) return failure(`model „${input.model}“ nije podržan`)
		const spec = entry.specification
		if (input.tools?.length && !spec.supportsFunctionCalling) return failure(`model „${spec.name}“ ne podržava pozive alata`)
		const request: InferenceInput = { ...input }
		if (request.reasoningEffort && !(spec.supportsReasoningEffort && spec.supportedReasoningEfforts.includes(request.reasoningEffort))) delete request.reasoningEffort
		const endpoint = spec.provider === "anthropic" ? claudeEndpoint(entry) : entry.endpoint

		let lastErr: unknown
		for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
			await this.semaphore.acquire()
			// on the server the limit of this session sits under one shared by all sessions (LLM_CONCURRENCY_TOTAL)
			const releaseShared = await sharedPermit("llm")
			try {
				const out = await withTimeout(endpoint.infer(request), TIMEOUT_MS)
				const usage = out.tokenUsage
				if (usage) this.state.addTokens(usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0))
				const usable = out.items?.some((i) => i.type === "function_call" || (i.type === "message" && (i as { role?: string }).role === "assistant"))
				if (!usable) return { ...out, items: [...(out.items ?? []), ModelMessageItem.rehydrate({ text: "Agent nije uspeo: model nije vratio ni poziv alata ni odgovor." })] }
				return out
			} catch (err) {
				lastErr = err
				if (!retryable(err) || attempt === ATTEMPTS - 1) break
				log("llm", `pokušaj ${attempt + 1}/${ATTEMPTS} nije uspeo (${clip(errorMessage(err), 120)}), ponavljam`)
			} finally {
				releaseShared()
				this.semaphore.release()
			}
			await sleep(BACKOFF_MS[attempt] * (0.8 + Math.random() * 0.4))
		}
		if (outOfCredits(lastErr)) {
			if (!this.scripted) log("llm", `nalog nema kredita (${clip(errorMessage(lastErr), 80)}): agenti nastavljaju sa skriptovanim politikama`)
			this.scripted ??= new ScriptedInferenceRunner()
			return this.scripted.run(input)
		}
		return failure(errorMessage(lastErr))
	}
}
