// ASCII Gantt of the agents' loops, shared by scripts/cli.ts and scripts/mapa.ts: one row per agent on a common time axis
// (~ inference, # tool call, ! waiting for the human). Overlapping rows are the visible proof that the agents ran at the same time.

import type { WireEvent } from "../../src/shared/types"

const CORE = ["Kadrovik", "Nabavke", "Revizor", "Mediji", "Urednik"]

export function gantt(evs: WireEvent[], start: number, end: number, dynOrder: string[] = ["Firme", "Imovina", "Mediji ·", "Provera"], core: string[] = CORE): string[] {
	const width = 72
	const span = Math.max(1, end - start)
	const rank: Record<string, number> = { ".": 0, "~": 1, "#": 2, "!": 3 }
	const lanes = new Map<string, { name: string; order: number; cells: string[]; first: number }>()
	const orderOf = (name: string) => {
		const c = core.indexOf(name)
		if (c >= 0) return c
		const d = dynOrder.findIndex((p) => name.startsWith(p))
		return 10 + (d < 0 ? 9 : d)
	}
	const lane = (id: string, name: string, t: number) => {
		let l = lanes.get(id)
		if (!l) {
			l = { name, order: orderOf(name), cells: Array(width).fill("."), first: t }
			lanes.set(id, l)
		}
		return l
	}
	const paint = (l: { cells: string[] }, from: number, to: number, glyph: string) => {
		const a = Math.max(0, Math.min(width - 1, Math.floor(((from - start) / span) * width)))
		const b = Math.max(a, Math.min(width - 1, Math.floor(((to - start) / span) * width)))
		for (let i = a; i <= b; i++) if (rank[glyph] > rank[l.cells[i]]) l.cells[i] = glyph
	}
	const open = new Map<string, { kind: string; t: number }>()
	for (const ev of evs) {
		if (!["inference.started", "inference.completed", "function_call.started", "function_call.completed", "interception.started", "interception.finished", "model.answer"].includes(ev.type)) continue
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const p = ev.payload as Record<string, any>
		const l = lane(ev.producerId, ev.producerName, ev.t)
		const key = (k: string) => `${ev.producerId}:${ev.loopId}:${k}`
		switch (ev.type) {
			case "inference.started":
				open.set(key("inf"), { kind: "~", t: ev.t })
				break
			case "inference.completed": {
				const o = open.get(key("inf"))
				if (o) paint(l, o.t, ev.t, "~")
				open.delete(key("inf"))
				break
			}
			case "function_call.started":
				open.set(key(`call:${p.callId}`), { kind: "#", t: ev.t })
				break
			case "function_call.completed": {
				const o = open.get(key(`call:${p.callId}`))
				if (o) paint(l, o.t, ev.t, "#")
				open.delete(key(`call:${p.callId}`))
				break
			}
			case "interception.started":
				open.set(key("int"), { kind: "!", t: ev.t })
				break
			case "interception.finished": {
				const o = open.get(key("int"))
				if (o && ev.t - o.t > 400) paint(l, o.t, ev.t, "!")
				open.delete(key("int"))
				break
			}
		}
	}
	const rows = [...lanes.values()].sort((a, b) => a.order - b.order || a.first - b.first)
	const out: string[] = []
	const tick = (frac: number) => `${((span * frac) / 1000).toFixed(0)}s`
	out.push(`${"".padEnd(LABEL_WIDTH + 1)}0s${" ".repeat(width / 2 - 4)}${tick(0.5)}${" ".repeat(width / 2 - tick(1).length - tick(0.5).length)}${tick(1)}`)
	for (const r of rows) out.push(`${label(r.name)} ${r.cells.join("")}`)
	return out
}

const LABEL_WIDTH = 30

/** A lane label of a fixed width: a longer name ends with "…" (a name is never cut silently: "Stegnjaja" is not "Stegnjaj"). */
export function label(name: string, width = LABEL_WIDTH): string {
	return name.length <= width ? name.padEnd(width) : `${name.slice(0, width - 1)}…`
}
