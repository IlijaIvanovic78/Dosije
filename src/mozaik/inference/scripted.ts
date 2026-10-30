// ScriptedInferenceRunner: the no-key mode. Mozaik's official `inferenceRunnerConfig.runner` extension point is replaced
// by deterministic per-group policies; everything else (runtime, loops, tools, gate, events, shared state) is identical to
// LLM mode. The runner reads the `[[agent:<group>]]` marker of the developer message and the function_call_output items
// of the context, emits exactly one FunctionCallItem per inference and never throws.

import { randomUUID } from "node:crypto"
import { FunctionCallItem, ModelMessageItem, SemanticEvent, type ContextItem, type InferenceInput, type InferenceOutput, type InferenceRunner } from "@mozaik-ai/core"
import { config } from "../../config"
import { errorMessage, hashString, logError, seeded, sleep } from "../util"
import { failure } from "./resilient"
import { policyFor, type Policy, type Step, type ToolResult } from "./policies"

interface Run {
	gen: AsyncGenerator<Step, string, ToolResult>
	rnd: () => number
	createdAt: number
}

const BLOCKED = /^(ODBIJENO|BUDŽET|Novinar je|Dosije je zatvoren|Budžet je|Error)/

function textOf(item: ContextItem | undefined): string {
	const content = (item as { content?: { text?: string } } | undefined)?.content
	return content?.text ?? ""
}

function lastToolResult(items: ContextItem[]): ToolResult | undefined {
	for (let i = items.length - 1; i >= 0; i--) {
		const item = items[i] as { type?: string; output?: { text?: string } }
		if (item.type !== "function_call_output") continue
		const text = item.output?.text ?? ""
		let json: unknown
		try {
			json = JSON.parse(text)
		} catch {
			json = undefined
		}
		return { text, json, blocked: BLOCKED.test(text) }
	}
	return undefined
}

export class ScriptedInferenceRunner implements InferenceRunner {
	private runs = new Map<string, Run>()

	async run(input: InferenceInput): Promise<InferenceOutput> {
		const key = input.context.id
		try {
			const items = input.context.getItems()
			let run = this.runs.get(key)
			if (!run) {
				run = this.start(input, items)
				this.runs.set(key, run)
				this.prune()
			}
			const ms = (500 + run.rnd() * 1100) * config.demoSpeed
			if (ms >= 1) await sleep(ms)
			else await Promise.resolve()
			const last = lastToolResult(items)
			const step = await run.gen.next(last as ToolResult)
			if (step.done) {
				this.runs.delete(key)
				return { items: [ModelMessageItem.rehydrate({ text: step.value })], tokenUsage: undefined, rowResponse: null }
			}
			const call = FunctionCallItem.rehydrate({ callId: `call_${randomUUID().slice(0, 12)}`, name: step.value.tool, args: JSON.stringify(step.value.args) })
			return { items: [call], tokenUsage: undefined, rowResponse: null }
		} catch (err) {
			this.runs.delete(key)
			logError("scripted", err)
			return failure(errorMessage(err))
		}
	}

	async *stream(input: InferenceInput) {
		yield SemanticEvent.create("inference.output", input.model, await this.run(input))
	}

	private start(input: InferenceInput, items: ContextItem[]): Run {
		const dev = items.find((i) => (i as { role?: string }).role === "developer")
		const user = items.find((i) => (i as { role?: string }).role === "user")
		const developer = textOf(dev)
		const group = /\[\[agent:(\w+)\]\]/.exec(developer)?.[1] ?? "unknown"
		const who = /Ti si ([^,\n]+?)(?:,|\.|\n)/.exec(developer)?.[1] ?? group
		const policy: Policy | undefined = policyFor(group)
		if (!policy) throw new Error(`nema skriptovane politike za grupu „${group}“`)
		const message = textOf(user)
		void input
		return { gen: policy({ group, message }), rnd: seeded(hashString(`${who}:${message.length}`)), createdAt: Date.now() }
	}

	private prune(): void {
		const cutoff = Date.now() - 15 * 60_000
		for (const [k, r] of this.runs) if (r.createdAt < cutoff) this.runs.delete(k)
	}
}
