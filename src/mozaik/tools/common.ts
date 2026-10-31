// Tools every worker agent has (add_finding, add_entity, ask_human, dosije_pregled) and the Urednik's napisi_sazetak.

import type { Tool } from "@mozaik-ai/core"
import { config } from "../../config"
import type { Finding } from "../../shared/types"
import * as domain from "../domain"
import { fixPunct, S, type ToolCtx } from "../domain"
import type { Summary } from "../state"
import { defaultSummary, defaultToVerify, orderTop, pickTop, rankable, summaryWorthy, withRedFlag } from "../summary"
import { clip } from "../util"
import { buildTool, str } from "./helpers"

const SOURCE_SCHEMA = {
	type: "array",
	description: "Najmanje jedan izvor; prepiši objekte iz polja sources koje vraćaju alati.",
	items: {
		type: "object",
		properties: {
			kind: { type: "string", description: "acas | jnportal | integrity_watch | apr | dri | vesti | paragraf | zakon | opensanctions | krik | companywall | novinar" },
			title: { type: "string" },
			url: { type: "string", description: "javni http(s) URL" },
			publishedAt: { type: "string" },
			official: { type: "boolean" },
		},
		required: ["kind", "title", "url"],
	},
}

function brief(f: Finding) {
	return { id: f.id, section: f.section, severity: f.severity, signalCode: f.signalCode, status: f.status, title: f.title, agent: f.agentName }
}

export function commonTools(ctx: ToolCtx): Tool[] {
	const tools = [
		buildTool(ctx, {
			name: "add_finding",
			local: true,
			description:
				"Upiši nalaz u zajednički Dosije. Svaki nalaz mora imati izvor (sources). Status (zvanično/potvrđeno/nepotvrđeno) određuje Urednik prema izvorima. Vraća {ok, findingId}.",
			properties: {
				section: { type: "string", enum: ["rukovodstvo", "novac", "firme", "revizija", "mediji"] },
				title: { type: "string", description: "kratak naslov, do 120 znakova" },
				text: { type: "string", description: "1-3 rečenice, neutralno, bez optužbi" },
				severity: { type: "string", enum: ["info", "paznja", "signal"] },
				signalCode: {
					type: "string",
					enum: [
						"VD_PREKO_ROKA",
						"VD_BLIZU_ROKA",
						"VD_LANAC",
						"IMENOVANJE_NEPOZNATO",
						"BEZ_OBJAVE",
						"KONCENTRACIJA",
						"UGOVOR_VECI_OD_PRIHODA",
						"MLADA_FIRMA",
						"MALO_ZAPOSLENIH",
						"POLITICKA_VEZA",
						"VLASNIK_FUNKCIONER",
						"DRI_NALAZ",
						"DRI_MISLJENJE",
						"MEDIJSKI_NAVOD",
						"IMOVINA",
						"KONFLIKT_IZVORA",
					],
				},
				sources: SOURCE_SCHEMA,
				potkrepljuje: { type: "string", description: "samo kod reakcije na tuđi nalaz: id nalaza drugog agenta (iz poruke 'Povod') koji ovaj nalaz potkrepljuje nezavisnim izvorom" },
				entityIds: { type: "array", items: { type: "string" }, description: "id-jevi entiteta na koje se nalaz odnosi (npr. osoba:ime-prezime)" },
				claim: {
					type: "object",
					description:
						"Samo za proverljive pojedinačne činjenice o osobi ili firmi koje Urednik poredi sa drugim izvorima: funkcija osobe, datum ili organ imenovanja, vlasnik, datum osnivanja. Subject je ime osobe ili firme. Za sve ostalo (nalazi revizije, ugovori, ocene) izostavi claim.",
					properties: {
						subject: { type: "string" },
						predicate: { type: "string", enum: ["funkcija", "datum_imenovanja", "organ_imenovanja", "vlasnik", "vrednost", "datum_osnivanja", "status", "drugo"] },
						value: { type: "string" },
					},
				},
			},
			required: ["section", "title", "text", "severity", "sources"],
			handler: (args) => domain.addFinding(ctx, args),
		}),
		buildTool(ctx, {
			name: "add_entity",
			local: true,
			description: "Dodaj osobu ili firmu u Dosije. Novi entitet automatski pokreće posebnog agenta (firma: provera dobavljača; osoba: imovina i mediji). Vraća {ok, entityId, duplicate}.",
			properties: {
				kind: { type: "string", enum: ["osoba", "firma"] },
				name: { type: "string" },
				role: { type: "string", enum: ["funkcioner", "dobavljac", "vlasnik", "pomenut"] },
				attrs: { type: "object", description: "npr. pib, mb, position, from, personId, valueRsd, contracts" },
				sources: SOURCE_SCHEMA,
			},
			required: ["kind", "name"],
			handler: (args) => {
				if (args.kind !== "osoba" && args.kind !== "firma") return { ok: false, error: "kind mora biti osoba ili firma" }
				const r = domain.addEntity(ctx, args)
				return { ok: r.ok, entityId: r.entityId, duplicate: r.duplicate, error: r.error }
			},
		}),
		buildTool(ctx, {
			name: "ask_human",
			local: true,
			description:
				"Postavi pitanje novinarki kad podatak nije dostupan iz otvorenih izvora (npr. vlasnici firme). Ne blokira: nastavi sa radom; odgovor stiže kasnije kao nova poruka. Vraća {ok, taskId}.",
			properties: {
				question: { type: "string" },
				title: { type: "string" },
				hint: { type: "string" },
				links: { type: "array", items: { type: "object", properties: { label: { type: "string" }, url: { type: "string" } } } },
				entityName: { type: "string" },
			},
			required: ["question"],
			handler: (args) => {
				// the inbox must stay readable: at most 3 open questions per case, whatever the model decides
				const state = S()
				const asked = [...state.tasks.values()].filter((t) => t.caseId === ctx.caseId && t.kind === "pitanje").length
				if (asked >= 3) return { ok: false, error: "Limit pitanja za ovaj dosije je dostignut (3). Ne postavljaj novo pitanje; navedi u nalazu da podatak nedostaje." }
				return domain.askHuman(ctx, args)
			},
		}),
		buildTool(ctx, {
			name: "dosije_pregled",
			local: true,
			description: ctx.group === "urednik" ? "Rangiran pregled dosijea za završni sažetak (id nalaza, težina, status)." : "Kratak pregled onoga što su drugi agenti već našli (da ne dupliraš).",
			properties: {},
			handler: () => {
				const state = S()
				const all = state.findingList()
				const counts = {
					nalaza: all.length,
					signala: all.filter((f) => f.severity === "signal").length,
					pazni: all.filter((f) => f.severity === "paznja").length,
					entiteta: state.entities.size,
					otvorenihPitanja: state.openTasks().length,
					konflikata: state.conflicts.size,
				}
				if (ctx.group === "urednik") {
					return {
						institucija: state.institution?.name,
						counts,
						nalazi: rankable(state)
							.slice(0, 12)
							.map((f) => ({ ...brief(f), approval: f.approval })),
						preporucenTopSignala: pickTop(state, 5).map((f) => ({ id: f.id, title: f.title })),
						predlogZaProveru: defaultToVerify(state),
						konflikti: [...state.conflicts.values()].map((c) => ({ id: c.id, subject: c.subject, values: c.values, winner: c.winnerFindingId })),
						otvoreniZadaci: state.openTasks().map((t) => ({ id: t.id, kind: t.kind, from: t.fromAgentName, question: clip(t.question, 120) })),
					}
				}
				return {
					institucija: state.institution?.name,
					counts,
					poslednjiNalazi: all.slice(-15).map(brief),
					entiteti: [...state.entities.values()].slice(0, 20).map((e) => ({ id: e.id, name: clip(e.name, 50), kind: e.kind, role: e.role })),
				}
			},
		}),
	]
	// without DOSIJE_ASK_HUMAN the journalist is never asked for data: a missing fact is written into the dossier as missing
	return config.askHuman ? tools : tools.filter((t) => t.name !== "ask_human")
}

export function urednikTools(ctx: ToolCtx): Tool[] {
	const dosije = commonTools(ctx).find((t) => t.name === "dosije_pregled") as Tool
	return [
		dosije,
		buildTool(ctx, {
			name: "napisi_sazetak",
			local: true,
			description: "Upiši završni sažetak dosijea: lede (2-3 rečenice), topSignals (3-5 nalaza: findingId + kratak naslov) i toVerify (konkretni koraci za ručnu proveru).",
			properties: {
				lede: { type: "string" },
				topSignals: { type: "array", items: { type: "object", properties: { findingId: { type: "string" }, headline: { type: "string" } } } },
				toVerify: { type: "array", items: { type: "string" } },
			},
			required: ["lede", "topSignals", "toVerify"],
			handler: (args) => {
				const state = S()
				const fallback = defaultSummary(state)
				const lede = str(args.lede) ? fixPunct(clip(String(args.lede), 900)) : fallback.lede
				// the model proposes, the ranking rules decide: official before unconfirmed, one finding per signalCode, refuted/rejected never
				const proposed: { f: Finding; headline: string }[] = []
				const allowed = new Set(rankable(state).map((f) => f.id))
				const raw = Array.isArray(args.topSignals) ? args.topSignals : []
				for (const item of raw) {
					const id = typeof item === "string" ? item : str((item as { findingId?: unknown })?.findingId)
					const f = id ? state.findings.get(id) : undefined
					if (!f || !allowed.has(f.id) || proposed.some((p) => p.f.id === f.id)) continue
					const headline = typeof item === "object" && str((item as { headline?: unknown }).headline) ? clip(String((item as { headline: string }).headline), 180) : f.title
					proposed.push({ f, headline })
				}
				const headlineOf = new Map(proposed.map((p) => [p.f.id, p.headline]))
				const chosen = orderTop(
					proposed.map((p) => p.f),
					5,
				)
				for (const f of pickTop(state, 5)) {
					if (chosen.length >= 3) break
					if (!chosen.includes(f)) chosen.push(f)
				}
				// a kind of red flag the model left out gets its place by the same rule as the deterministic summary
				const top: Summary["topSignals"] = withRedFlag(
					chosen,
					rankable(state).filter(summaryWorthy),
					5,
				).map((f) => ({ findingId: f.id, headline: headlineOf.get(f.id) ?? f.title }))
				const verify = (Array.isArray(args.toVerify) ? args.toVerify : []).filter((v): v is string => typeof v === "string" && v.trim().length > 3 && v.length <= 260).map(fixPunct)
				state.summary = { lede, topSignals: top, toVerify: verify.length ? verify.slice(0, 14) : fallback.toVerify }
				return { ok: true, topSignals: top.length, toVerify: state.summary.toVerify.length }
			},
		}),
	]
}
