// Claude through Mozaik's Anthropic endpoint, against a tiny fake of the Messages API: the request carries max_tokens (the
// API requires it and Mozaik's mapper leaves it out), automatic prompt caching and adaptive thinking with the effort.

import assert from "node:assert/strict"
import http from "node:http"
import { after, before, test } from "node:test"
import type { AddressInfo } from "node:net"

process.env.ANTHROPIC_API_KEY = "sk-ant-test-fake"

const { DeveloperMessageItem, ModelContext, UserMessageItem } = await import("@mozaik-ai/core")
const { ResilientInferenceRunner } = await import("../src/mozaik/inference/resilient")
type DosijeState = import("../src/mozaik/state").DosijeState

const bodies: Record<string, any>[] = []
let server: http.Server

before(async () => {
	server = http.createServer((req, res) => {
		let raw = ""
		req.on("data", (c) => (raw += c))
		req.on("end", () => {
			const body = JSON.parse(raw)
			bodies.push(body)
			res.writeHead(200, { "content-type": "application/json" })
			res.end(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: "radi" }], stop_reason: "end_turn", usage: { input_tokens: 40, output_tokens: 3, cache_read_input_tokens: 900 } }))
		})
	})
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
	process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(() => server.close())

test("a Claude request has max_tokens, automatic caching and adaptive thinking", async () => {
	let tokens = 0
	const runner = new ResilientInferenceRunner({ addTokens: (n: number) => (tokens += n) } as unknown as DosijeState)
	const context = ModelContext.create().addContextItem(DeveloperMessageItem.create("Ti si Kadrovik.")).addContextItem(UserMessageItem.create("Putevi Srbije"))
	const out = await runner.run({ model: "claude-sonnet-5-5", reasoningEffort: "low", context })
	assert.equal(bodies.length, 1)
	const body = bodies[0]
	assert.equal(body.max_tokens, 16_000)
	assert.deepEqual(body.cache_control, { type: "ephemeral" })
	assert.deepEqual(body.thinking, { type: "adaptive" })
	assert.equal(body.output_config?.effort, "low")
	assert.equal(body.system, "Ti si Kadrovik.")
	assert.ok(out.items.some((i) => (i as { content?: { text?: string } }).content?.text === "radi"))
	assert.equal(tokens, 43, "tokens read from the cache are not counted against the budget")
})
