// startAgentLoop: one Mozaik loop of one agent. Every loop gets a FRESH context (Mozaik mutates the context in place,
// so two concurrent loops must never share one), its own tools (closures over {agentId, caseId}) and its own gate.

import { DeveloperMessageItem, ModelContext, type Agent, type InferenceInput } from "@mozaik-ai/core"
import { config } from "../config"
import { UrednikGate } from "./gate"
import { S, type ToolCtx } from "./domain"
import { runLoop } from "./runtime"
import { makeTools } from "./tools"
import { log, logError } from "./util"

export interface LoopOptions {
	/** the final summary loop of the Urednik: uses the editor model, ignores the loop budget and runs while the case is finalizing */
	editor?: boolean
}

export function startAgentLoop(agent: Agent, message: string, opts: LoopOptions = {}): boolean {
	const state = S()
	const agentId = agent.getId()
	const info = state.agentInfo.get(agentId)
	// a Trijaža loop belongs to the running map (its "case id" is the map id), every other loop to the open case
	const trijaza = info?.group === "trijaza"
	if (!info || (trijaza ? !state.mapaRunning() : !state.caseId)) return false
	if (!opts.editor && !trijaza && state.status !== "running") return false
	if (!opts.editor && state.budget.loops >= state.budget.maxLoops) {
		log("loop", `budžet petlji iscrpljen (${state.budget.maxLoops}): ${info.name} se ne pokreće`)
		return false
	}
	const ctx: ToolCtx = { agentId, agentName: info.name, group: info.group, caseId: (trijaza ? state.mapa.id : state.caseId) as string, entityId: info.entityId }
	const context = ModelContext.create().addContextItem(DeveloperMessageItem.create(agent.getDeveloperMessage()))
	const llm = config.mode === "llm"
	const input: InferenceInput = {
		model: llm ? (opts.editor ? config.editorModel : config.model) : "skriptovano",
		reasoningEffort: llm ? config.reasoning : undefined,
		tools: makeTools(ctx),
		context,
	}
	try {
		runLoop(agentId, message, input, new UrednikGate(ctx))
		return true
	} catch (err) {
		logError(`runLoop ${info.name}`, err)
		return false
	}
}
