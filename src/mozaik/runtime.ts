import { defineRuntime } from "@mozaik-ai/core"
import type { DosijeState } from "./state"

export const { initializeRuntime, resolveRuntime, resolveParticipant, join, leave, sendMessage, sendEvent, runLoop } = defineRuntime<DosijeState>()
