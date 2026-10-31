// startAgentLoop: one Mozaik loop of one agent. Every loop gets a FRESH context (Mozaik mutates the context in place,
// so two concurrent loops must never share one), its own tools (closures over {agentId, caseId}) and its own gate.

import { DeveloperMessageItem, ModelContext, type Agent, type InferenceInput } from "@mozaik-ai/core"
import { config } from "../config"
import { UrednikGate } from "./gate"
import { S, type ToolCtx } from "./domain"
import { runLoop } from "./runtime"
import { makeTools } from "./tools"
import { log, logError } from "./util"

/** A run started in English: the agents write everything the reader sees in English (the data and the rules stay as they are). */
const WRITE_IN_ENGLISH = `JEZIK ISTRAŽIVANJA: engleski. Sve što upisuješ za čitaoca piši na engleskom: naslov i tekst nalaza (add_finding), sažetak reda (upisi_red), lede, naslove u topSignals i toVerify (napisi_sazetak), odgovor kad završiš. Kad zadatak kaže da prepišeš gotov tekst iz alata (npr. pregled medija), prenesi ga verno na engleski, i opšte reči (npr. „kadrovska rešenja“ = "personnel decisions"); u engleskom tekstu nema srpskih ni ćiriličnih reči osim imena i naziva. Na srpskom (u originalu) ostaju: imena osoba, nazivi institucija i firmi, nazivi propisa i doslovni citati iz izvora (citat stavi pod navodnike). Vrednosti polja (section, severity, signalCode, kind, role, claim.predicate) ostaju tačno kako su zadate.`

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
	// the language the run was started in (the scripted agents write their fixed Serbian text)
	if (llm && state.lang === "en") context.addContextItem(DeveloperMessageItem.create(WRITE_IN_ENGLISH))
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
