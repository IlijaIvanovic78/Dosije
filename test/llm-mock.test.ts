// LLM mode without a key: a tiny fake of OpenAI's Responses API drives the REAL LLM code path (ResilientInferenceRunner ->
// Mozaik OpenAIResponses endpoint -> JSON tool arguments -> DefaultFunctionCallRunner -> gate -> state). The fake answers
// with the same deterministic policies the scripted mode uses, one tool call per request, like a model that follows the
// prompts. Proves the LLM path is wired correctly (retries, semaphore, token accounting, failure messages).

import assert from "node:assert/strict"
import http from "node:http"
import { after, before, test } from "node:test"
import type { AddressInfo } from "node:net"

process.env.DOSIJE_MODE = "llm"
// this case also tests the blocking approval of a sensitive signal (off in the app)
process.env.DOSIJE_APPROVALS = "1"
process.env.OPENAI_API_KEY = "sk-test-fake"
// the models of the fake, whatever a local .env sets (dotenv does not override variables that are already set)
process.env.DOSIJE_MODEL = "gpt-5.4-mini"
process.env.DOSIJE_EDITOR_MODEL = "gpt-5.4"
process.env.DATA_MODE = "cache"
process.env.HUMAN_AUTO_APPROVE_MS = "0"
process.env.LLM_CONCURRENCY = "3"

const { applyEntryDefaults, config } = await import("../src/config")
applyEntryDefaults("test")
const { boot, startCase, waitForDone, getSnapshot, shutdown } = await import("../src/mozaik/boot")
const { policyFor } = await import("../src/mozaik/inference/policies")
type Gen = AsyncGenerator<{ tool: string; args: Record<string, unknown> }, string, { text: string; json: unknown; blocked: boolean }>

const conversations = new Map<string, Gen>()
let requests = 0
let maxParallel = 0
let parallel = 0
let flaky = 0

function respond(body: { model: string; input: Record<string, any>[] }): Record<string, unknown> {
	const dev = body.input.find((i) => i.role === "developer")?.content?.[0]?.text ?? ""
	const user = body.input.find((i) => i.role === "user")?.content?.[0]?.text ?? ""
	const group = /\[\[agent:(\w+)\]\]/.exec(dev)?.[1] ?? ""
	const key = `${group}|${user}|${body.model}`
	let gen = conversations.get(key)
	const outputs = body.input.filter((i) => i.type === "function_call_output")
	if (!gen) {
		const policy = policyFor(group)
		if (!policy) return { id: "r", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: `nepoznata grupa ${group}` }] }] }
		gen = policy({ group, message: user }) as Gen
		conversations.set(key, gen)
	}
	const last = outputs.at(-1)?.output?.[0]?.text as string | undefined
	let json: unknown
	try {
		json = last ? JSON.parse(last) : undefined
	} catch {
		json = undefined
	}
	return { gen, last, json } as never
}

let server: http.Server

before(async () => {
	server = http.createServer((req, res) => {
		let raw = ""
		req.on("data", (c) => (raw += c))
		req.on("end", async () => {
			requests++
			parallel++
			maxParallel = Math.max(maxParallel, parallel)
			try {
				// one transient 500 and one 429 to exercise the retry path
				if (requests === 3 || requests === 7) {
					flaky++
					res.writeHead(requests === 3 ? 500 : 429, { "content-type": "application/json" })
					res.end(JSON.stringify({ error: { message: "transient", type: "server_error" } }))
					return
				}
				const body = JSON.parse(raw)
				const ctx = respond(body) as unknown as { gen: Gen; last?: string; json?: unknown }
				await new Promise((r) => setTimeout(r, 15))
				if (!ctx.gen) {
					res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(ctx))
					return
				}
				const step = await ctx.gen.next({ text: ctx.last ?? "", json: ctx.json, blocked: /^(ODBIJENO|BUDŽET|Novinar je|Dosije je zatvoren)/.test(ctx.last ?? "") })
				const usage = { input_tokens: 1200, output_tokens: 60, total_tokens: 1260 }
				const output = step.done
					? [{ type: "message", role: "assistant", content: [{ type: "output_text", text: step.value }] }]
					: [{ type: "function_call", call_id: `call_${requests}`, name: step.value.tool, arguments: JSON.stringify(step.value.args) }]
				res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: `resp_${requests}`, object: "response", model: body.model, output, usage }))
			} catch (err) {
				res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: String(err) } }))
			} finally {
				parallel--
			}
		})
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	process.env.OPENAI_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
	await boot()
})

after(async () => {
	server.close()
	await shutdown()
})

test("LLM mode end to end against a fake Responses API", { timeout: 240_000 }, async () => {
	assert.equal(config.mode, "llm")
	await startCase("Infrastruktura železnice Srbije")
	const report = await waitForDone(220_000)
	assert.ok(report, "the dossier finished")
	const snap = getSnapshot()
	assert.equal(snap.config.mode, "llm")
	assert.equal(snap.config.model, "gpt-5.4-mini")
	assert.ok(snap.findings.length >= 10, `findings ${snap.findings.length}`)
	assert.ok(snap.stats.peakConcurrentLoops >= 4, `peak ${snap.stats.peakConcurrentLoops}`)
	assert.ok(snap.budget.tokens > 0, "token usage was accounted")
	assert.ok(maxParallel <= 3, `semaphore limits parallel calls (saw ${maxParallel})`)
	assert.ok(flaky >= 2, "transient errors were injected")
	assert.ok(snap.stats.blockedClaims >= 1)
	assert.ok(snap.findings.some((f) => f.signalCode === "VD_PREKO_ROKA" && f.approval === "approved"))
	assert.ok(report.topSignals.length >= 3)
	assert.ok(!report.markdown.includes("Agent nije uspeo"), "no loop failed")
})
