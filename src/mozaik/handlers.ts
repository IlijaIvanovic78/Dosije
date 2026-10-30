import { SituationSpecification, type SituationContext, type SituationHandler } from "@mozaik-ai/core"
import { logError } from "./util"

/** Matches events by type; "*" matches every event. */
export class EventTypeSpec extends SituationSpecification {
	private readonly types: Set<string> | "*"

	constructor(types: string[] | "*") {
		super()
		this.types = types === "*" ? "*" : new Set(types)
	}

	isSatisfiedBy(context: SituationContext): boolean {
		return this.types === "*" || this.types.has(context.event.type)
	}
}

/**
 * Situation processors are not awaited by Mozaik and async errors are swallowed (or become unhandled rejections), so
 * every processor body runs inside try/catch and logs instead of throwing.
 */
export function handler(types: string[] | "*", name: string, fn: (context: SituationContext) => void | Promise<void>): SituationHandler {
	return {
		specification: new EventTypeSpec(types),
		processor: {
			apply(context) {
				try {
					const result = fn(context)
					if (result && typeof (result as Promise<void>).catch === "function") (result as Promise<void>).catch((err) => logError(`processor ${name}`, err))
				} catch (err) {
					logError(`processor ${name}`, err)
				}
			},
		},
	}
}
