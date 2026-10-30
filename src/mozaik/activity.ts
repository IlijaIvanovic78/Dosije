// Live search bridge: the data layer reports every public-source request of a tool (src/data/activity.ts); here each report
// becomes a real Mozaik SemanticEvent "izvor.upit", produced by the agent that made the request, so every participant
// sees it, the SSE bridge forwards it and the Zapisničar writes it to the trace. Two events per request (same id).

import { setActivitySink, type ActivityContext } from "../data/activity"
import type { SourceActivity } from "../shared/types"
import { emit, S } from "./domain"
import { logError } from "./util"

/** Requests per case (or map) that are published; the rest is dropped silently and only counted in stats. */
export const MAX_ACTIVITIES_PER_CASE = 400

/** Requests whose "u_toku" was dropped by the cap: their final event is dropped too. */
const dropped = new Set<string>()

function publish(ctx: ActivityContext, activity: SourceActivity): void {
	try {
		if (ctx.alive && !ctx.alive()) {
			dropped.delete(activity.id)
			return
		}
		const stats = S().stats
		if (activity.status === "u_toku") {
			if ((stats.activities ?? 0) >= MAX_ACTIVITIES_PER_CASE) {
				dropped.add(activity.id)
				stats.activitiesDropped = (stats.activitiesDropped ?? 0) + 1
				return
			}
			stats.activities = (stats.activities ?? 0) + 1
		} else if (dropped.delete(activity.id)) return
		emit("izvor.upit", ctx.agentId, activity)
	} catch (err) {
		logError("izvor.upit", err)
	}
}

export function installActivityBridge(): void {
	setActivitySink(publish)
}
