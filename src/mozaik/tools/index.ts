import type { Tool } from "@mozaik-ai/core"
import type { ToolCtx } from "../domain"
import { commonTools, urednikTools } from "./common"
import { firmeTools, imovinaTools, kadrovikTools, medijiTools, nabavkeTools, proveraTools, revizorTools } from "./sources"

/** Tools of one loop. Built per loop: every tool is a closure over {agentId, caseId} (and the entity the agent works on). */
export function makeTools(ctx: ToolCtx): Tool[] {
	switch (ctx.group) {
		case "kadrovik":
			return [...kadrovikTools(ctx), ...commonTools(ctx)]
		case "nabavke":
			return [...nabavkeTools(ctx), ...commonTools(ctx)]
		case "revizor":
			return [...revizorTools(ctx), ...commonTools(ctx)]
		case "mediji":
			return [...medijiTools(ctx), ...commonTools(ctx)]
		case "firme":
			return [...firmeTools(ctx), ...commonTools(ctx)]
		case "imovina":
			return [...imovinaTools(ctx), ...commonTools(ctx)]
		case "provera":
			return [...proveraTools(ctx), ...commonTools(ctx)]
		case "urednik":
			return urednikTools(ctx)
		default:
			return commonTools(ctx)
	}
}
