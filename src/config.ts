// Runtime configuration. Reads .env (dotenv) once; every value can be overridden by an environment variable.
// Mode: scripted (no key, deterministic agents) unless a provider key exists. DOSIJE_MODE=scripted|llm forces it.

import "dotenv/config"
import { getDataMode } from "./data/cache"
import type { DataMode } from "./data/cache"

export type Provider = "openai" | "anthropic" | "gemini" | "none"
export type EntryPoint = "server" | "cli" | "test"

export interface Config {
	mode: "llm" | "scripted"
	provider: Provider
	model: string
	editorModel: string
	reasoning: string | undefined
	llmConcurrency: number
	dataMode: DataMode
	demoSpeed: number
	humanAutoApproveMs: number
	/** what happens to an unanswered approval when humanAutoApproveMs elapses: auto-approve (CLI, tests, explicit env) or expire (UI) */
	approvalTimeoutAction: "approve" | "expire"
	/** agents may ask the journalist for data no source has (ask_human); off by default: a missing fact is written as missing */
	askHuman: boolean
	/** sensitive signals wait for the journalist's approval; off by default: they go in on their sources (zvanično / nepotvrđeno) */
	approvals: boolean
	port: number
	idleMs: number
	questionGraceMs: number
	budget: {
		maxFirme: number
		maxOsobe: number
		maxLoops: number
		maxToolCalls: number
		maxToolCallsPerLoop: number
		maxTokens: number
	}
}

function num(name: string, fallback: number): number {
	const raw = process.env[name]
	if (raw === undefined || raw.trim() === "") return fallback
	const n = Number(raw)
	return Number.isFinite(n) ? n : fallback
}

function detectProvider(): Provider {
	if (process.env.OPENAI_API_KEY?.trim()) return "openai"
	if (process.env.ANTHROPIC_API_KEY?.trim()) return "anthropic"
	if (process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim()) return "gemini"
	return "none"
}

const DEFAULT_MODELS: Record<Provider, { worker: string; editor: string }> = {
	openai: { worker: "gpt-5.4-mini", editor: "gpt-5.4" },
	anthropic: { worker: "claude-haiku-4-5", editor: "claude-sonnet-4-6" },
	gemini: { worker: "gemini-3.5-flash", editor: "gemini-3.1-pro-preview" },
	none: { worker: "gpt-5.4-mini", editor: "gpt-5.4" },
}

function loadConfig(): Config {
	const forced = process.env.DOSIJE_MODE?.trim().toLowerCase()
	const provider = detectProvider()
	const mode: Config["mode"] = forced === "scripted" ? "scripted" : forced === "llm" ? "llm" : provider === "none" ? "scripted" : "llm"
	const defaults = DEFAULT_MODELS[provider]
	const reasoningRaw = (process.env.DOSIJE_REASONING ?? "low").trim().toLowerCase()
	return {
		mode,
		provider,
		model: process.env.DOSIJE_MODEL?.trim() || defaults.worker,
		editorModel: process.env.DOSIJE_EDITOR_MODEL?.trim() || defaults.editor,
		reasoning: reasoningRaw === "" ? undefined : reasoningRaw,
		llmConcurrency: Math.max(1, num("LLM_CONCURRENCY", 8)),
		dataMode: getDataMode(),
		demoSpeed: Math.max(0, num("DEMO_SPEED", 1)),
		humanAutoApproveMs: Math.max(0, num("HUMAN_AUTO_APPROVE_MS", 180_000)),
		approvalTimeoutAction: process.env.HUMAN_AUTO_APPROVE_MS === undefined ? "expire" : "approve",
		askHuman: /^(1|true|da)$/i.test(process.env.DOSIJE_ASK_HUMAN?.trim() ?? ""),
		approvals: /^(1|true|da)$/i.test(process.env.DOSIJE_APPROVALS?.trim() ?? ""),
		port: num("PORT", 3000),
		idleMs: num("DOSIJE_IDLE_MS", 2500),
		questionGraceMs: Math.max(0, num("DOSIJE_QUESTION_GRACE_MS", 30_000)),
		budget: {
			maxFirme: num("DOSIJE_MAX_FIRME", 8),
			maxOsobe: num("DOSIJE_MAX_OSOBE", 6),
			maxLoops: num("DOSIJE_MAX_LOOPS", 40),
			maxToolCalls: num("DOSIJE_MAX_TOOL_CALLS", 400),
			maxToolCallsPerLoop: num("DOSIJE_MAX_TOOL_CALLS_PER_LOOP", 24),
			maxTokens: num("DOSIJE_MAX_TOKENS", 1_500_000),
		},
	}
}

export const config: Config = loadConfig()

/** Entry-point specific defaults, applied only when the matching environment variable is not set. */
export function applyEntryDefaults(entry: EntryPoint): void {
	if (process.env.HUMAN_AUTO_APPROVE_MS === undefined) {
		config.humanAutoApproveMs = entry === "cli" ? 4000 : entry === "test" ? 0 : 180_000
		config.approvalTimeoutAction = entry === "server" ? "expire" : "approve"
	}
	if (process.env.DOSIJE_QUESTION_GRACE_MS === undefined && entry !== "server") config.questionGraceMs = 0
}

export function modelLabel(): string {
	return config.mode === "llm" ? config.model : "skriptovano"
}

export function editorModelLabel(): string {
	return config.mode === "llm" ? config.editorModel : "skriptovano"
}
