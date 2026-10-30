// Live search bridge: the data layer reports every public-source request of a tool (src/data/activity.ts); here each report
// becomes a real Mozaik SemanticEvent "izvor.upit", produced by the agent that made the request, so every participant
// sees it, the SSE bridge forwards it and the Zapisničar writes it to the trace. Two events per request (same id).
// A request still "u_toku" when its case or map ends (or is replaced) is finished here with a final event, so the UI never
// shows a request in flight after "Završeno".

import { setActivitySink, type ActivityContext } from "../data/activity"
import type { SourceActivity } from "../shared/types"
import { emit, S } from "./domain"
import { logError, nowIso } from "./util"

/** Requests per case (or map) that are published; the rest is dropped silently and only counts in stats. */
export const MAX_ACTIVITIES_PER_CASE = 400

/** Requests whose "u_toku" was dropped by the cap: their final event is dropped too. */
const dropped = new Set<string>()

/** Published "u_toku" events that have no final event yet. */
const inflight = new Map<string, { ctx: ActivityContext; activity: SourceActivity }>()

/** Requests finished by finalizeActivities(): the late result of the real request is not published a second time. */
const closed = new Set<string>()

function publish(ctx: ActivityContext, activity: SourceActivity): void {
	try {
		if (ctx.alive && !ctx.alive()) {
			dropped.delete(activity.id)
			inflight.delete(activity.id)
			return
		}
		if (closed.has(activity.id)) {
			if (activity.status !== "u_toku") closed.delete(activity.id)
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
			inflight.set(activity.id, { ctx, activity })
		} else {
			if (dropped.delete(activity.id)) return
			inflight.delete(activity.id)
		}
		emit("izvor.upit", ctx.agentId, activity)
	} catch (err) {
		logError("izvor.upit", err)
	}
}

/**
 * Finishes every request that is still "u_toku" with a final event (status "greska", the given reason), so the feed has no open
 * requests once the case or map is over. `runId` limits it to one case/map; without it every open request is finished.
 * Returns how many requests were finished.
 */
export function finalizeActivities(runId: string | null | undefined, error: string): number {
	let count = 0
	for (const [id, f] of [...inflight]) {
		if (runId && f.ctx.caseId !== runId) continue
		inflight.delete(id)
		closed.add(id)
		try {
			const started = Date.parse(f.activity.at)
			emit("izvor.upit", f.ctx.agentId, { ...f.activity, status: "greska", error, ms: Number.isFinite(started) ? Math.max(0, Date.now() - started) : undefined, at: nowIso() } satisfies SourceActivity)
			count++
		} catch (err) {
			logError("izvor.upit (završetak)", err)
		}
	}
	return count
}

/** Requests of the previous run that are still open count as dropped (their case is no longer current, so late results are ignored anyway). */
export function forgetActivities(): void {
	closed.clear()
	dropped.clear()
}

export function installActivityBridge(): void {
	setActivitySink(publish)
}
