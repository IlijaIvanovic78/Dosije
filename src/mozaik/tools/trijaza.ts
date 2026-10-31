// Tools of a "Trijaža · <institucija>" agent (Mapa prioriteta). Three deterministic triage tools wrap the same adapters and
// analysis functions the case agents use; upisi_red writes the row. Figures and the score are computed in code from what the
// tools fetched in this loop; the model only adds a short neutral summary. Outputs are compact JSON (<= 2,500 chars).

import type { Tool } from "@mozaik-ai/core"
import * as data from "../../data"
import type { MapaSignals, MapaSupplier, SourceRef } from "../../shared/types"
import { S, type ToolCtx } from "../domain"
import { scrubText } from "../gate"
import { finishRow, recordTriage, triageComplete, type TriagePart } from "../mapa"
import { clip } from "../util"
import { buildTool, friendlyError, srcOut, str, uniqueSources } from "./helpers"

const MAX = 2500
const pct = (share: number) => Math.round(share * 1000) / 10

function target(ctx: ToolCtx) {
	const state = S()
	const slug = state.mapa.agentSlug.get(ctx.agentId)
	const ref = slug ? state.mapa.refs.get(slug) : undefined
	if (!slug || !ref) throw new Error("Trijaža nema dodeljenu instituciju.")
	return { slug, ref }
}

/** Runs one triage step: the figures go to the row (code), a failure is recorded as a gap, never invented. */
async function step(ctx: ToolCtx, part: TriagePart, run: (ref: ReturnType<typeof target>["ref"]) => Promise<{ out: Record<string, unknown>; signals: MapaSignals; sources: SourceRef[] }>) {
	const { slug, ref } = target(ctx)
	try {
		const r = await run(ref)
		recordTriage(slug, part, { ok: true, signals: r.signals, sources: r.sources }, ctx.agentId)
		return { ...r.out, sources: r.sources.map(srcOut) }
	} catch (err) {
		recordTriage(slug, part, { ok: false }, ctx.agentId)
		return { ok: false, error: friendlyError(err) }
	}
}

const MISSING = /sa rezervom|negativno|uzdržavanje/i

/** Suppliers that count as "top" for the cross-institution link: the 8 biggest participants (without public systems). */
export const TOP_SUPPLIERS = 8

/** Top suppliers with their rank among ALL non-public participants; only those with a real PIB can be matched across institutions. */
export function topSuppliersOf(a: { suppliers: { name: string; pib?: string; participationValueRsd: number; publicSystem: boolean }[]; nonPublic: { valueRsd: number } }): MapaSupplier[] {
	const base = a.nonPublic.valueRsd
	return a.suppliers
		.filter((s) => !s.publicSystem && s.participationValueRsd > 0)
		.slice(0, TOP_SUPPLIERS)
		.map((s, i) => ({ name: clip(s.name, 60), pib: s.pib, rank: i + 1, valueRsd: Math.round(s.participationValueRsd), share: base > 0 ? s.participationValueRsd / base : 0 }))
		.filter((s) => !!s.pib && /^\d{8,9}$/.test(s.pib))
}

export function trijazaTools(ctx: ToolCtx): Tool[] {
	return [
		buildTool(ctx, {
			name: "trijaza_rukovodstvo",
			max: MAX,
			description: "Rukovodstvo institucije iz registra ACAS: ko je čelnik (funkcija, od kada), da li je v.d. i da li prelazi zakonski rok, i lanac uzastopnih v.d.",
			properties: {},
			handler: () =>
				step(ctx, "rukovodstvo", async (ref) => {
					const officials = await data.analysis.closeEndedHeads(await data.acas.getOfficials({ acasId: ref.acasId, altIds: ref.acasAltIds, name: ref.name, nameCyr: ref.nameCyr }))
					const head = data.analysis.pickHead(officials)
					const signals: MapaSignals = {}
					const sources: SourceRef[] = []
					const generic = officials[0] ? { ...officials[0].source, publishedAt: undefined } : undefined
					if (!head) {
						if (generic) sources.push(generic)
						// the register still shows a head whose own report on leaving says the function ended
						const ended = officials.find((o) => o.endedBy && data.analysis.isHeadPosition(o.position))
						if (ended?.endedBy) sources.push(ended.endedBy)
						return {
							out: {
								institution: ref.name,
								officials: officials.length,
								head: null,
								zavrseno: ended?.to ? { position: ended.position, to: ended.to, reportDate: ended.endedBy?.publishedAt } : undefined,
								napomena: ended?.to
									? `U registru nema tekućeg čelnika: zapis „${ended.position}“ nema datum kraja, ali izveštaj o imovini o prestanku funkcije navodi kraj ${ended.to}.`
									: "U registru nema tekućeg čelnika (direktor, predsednik, načelnik).",
							},
							signals,
							sources,
						}
					}
					const check = data.analysis.checkVd(head, { legalType: ref.legalType })
					const rule = data.rules.ruleFor(ref.legalType)
					const chain = head.isActing ? data.analysis.analyzeVdChain(officials) : null
					if (check.applicable && rule) {
						signals.vdMonths = check.months
						signals.vdLimitMonths = rule.maxMonths + (rule.extensionMonths ?? 0)
						signals.vdOver = check.overLimit
					}
					if (chain) {
						signals.vdChainMonths = chain.totalMonths
						signals.vdChainCount = chain.actingCount
					}
					sources.push(...check.sources)
					const heads = data.analysis.currentOfficials(officials).filter((o) => data.analysis.isHeadPosition(o.position)).length
					return {
						out: {
							institution: ref.name,
							officials: officials.length,
							head: { position: head.position, acting: head.isActing, from: head.from, appointedBy: head.appointedBy },
							vd: check.applicable
								? { months: check.months, days: check.days, limitMonths: signals.vdLimitMonths, overLimit: check.overLimit, nearLimit: check.nearLimit, rule: `${check.rule?.law}, ${check.rule?.article}` }
								: { applicable: false, reason: clip(check.explanation, 160) },
							chain: chain ? { actingCount: chain.actingCount, since: chain.since, totalMonths: chain.totalMonths } : null,
							napomena: heads > 1 ? "U registru ima više tekućih zapisa za direktora: podaci možda nisu ažurni." : undefined,
						},
						signals,
						sources,
					}
				}),
		}),
		buildTool(ctx, {
			name: "trijaza_nabavke",
			max: MAX,
			description:
				"Javne nabavke institucije (Portal javnih nabavki + Integrity Watch): broj i vrednost ugovora, pregovarački postupci bez objavljivanja (broj, vrednost, udeo), udeo najvećeg dobavljača (bez državnih preduzeća) i broj dobavljača sa oznakom Integrity Watch.",
			properties: {},
			handler: () =>
				step(ctx, "nabavke", async (ref) => {
					const inst = { name: ref.name, jnId: ref.jnId, pib: ref.pib }
					const links = await data.iw.getLinksForAuthority({ name: inst.name, pib: inst.pib }).catch(() => [])
					const a = await data.analysis.analyzeProcurement(inst, links)
					const nwp = a.withoutPublication
					const flagged = new Set(links.map((l) => l.supplierPib ?? l.supplierName))
					const signals: MapaSignals = {
						contracts: a.totalContracts,
						valueRsd: Math.round(a.totalValueRsd),
						nwpCount: nwp.count,
						nwpValueRsd: Math.round(nwp.valueRsd),
						nwpShare: nwp.shareOfTotal,
						iwFlags: flagged.size,
					}
					if (a.concentration.topName) {
						signals.topSupplierName = clip(a.concentration.topName, 60)
						signals.topSupplierShare = a.concentration.topShare
					}
					// the top suppliers go into the shared state: the Urednik compares them across the institutions of the map
					const topSuppliers = topSuppliersOf(a)
					signals.topSuppliers = topSuppliers
					const largest = nwp.largest
					return {
						out: {
							institution: a.institution,
							contracts: a.totalContracts,
							valueRsd: Math.round(a.totalValueRsd),
							period: a.period,
							bezObjavljivanja: {
								count: nwp.count,
								saUgovorom: nwp.withContract,
								valueRsd: Math.round(nwp.valueRsd),
								sharePct: pct(nwp.shareOfTotal),
								najveci: largest ? { title: clip(largest.title, 80), valueRsd: largest.valueRsd, signedAt: largest.signedAt } : undefined,
							},
							najveciDobavljac: a.concentration.topName ? { name: clip(a.concentration.topName, 40), sharePct: pct(a.concentration.topShare), napomena: "udeo u vrednosti bez državnih preduzeća" } : null,
							najveciDobavljaci: topSuppliers.slice(0, 5).map((s) => ({ rank: s.rank, name: clip(s.name, 30), pib: s.pib, sharePct: pct(s.share) })),
							integrityWatch: { oznacenihDobavljaca: flagged.size },
						},
						signals,
						sources: uniqueSources([a.source, links[0]?.source, largest?.source]),
					}
				}),
		}),
		buildTool(ctx, {
			name: "trijaza_revizija",
			max: MAX,
			description:
				"Izveštaji Državne revizorske institucije o instituciji: spisak (broj, najnoviji) i mišljenja revizora tamo gde su već izvučena. PDF-ovi se ne preuzimaju.",
			properties: {},
			handler: () =>
				step(ctx, "revizija", async (ref) => {
					const reports = await data.dri.getReports({ name: ref.name, nameCyr: ref.nameCyr, aliases: ref.aliases })
					const opinions = await data.dri.getCachedOpinions(reports)
					const qualified = [...opinions.values()].filter((o) => MISSING.test(o))
					const withOpinion = reports.filter((r) => opinions.has(r.id))
					const signals: MapaSignals = { driReports: reports.length, driQualified: qualified.length, driKnown: opinions.size }
					const shown = uniqueSources([...reports.slice(0, 3).map((r) => r.source), ...withOpinion.slice(0, 3).map((r) => r.source)])
					const sources = shown.length
						? shown
						: [{ kind: "dri" as const, title: "DRI – spisak izveštaja o reviziji", url: "https://www.dri.rs/izvestaji", retrievedAt: new Date().toISOString(), official: true }]
					return {
						out: {
							total: reports.length,
							newest: reports.slice(0, 5).map((r) => ({ id: r.id, title: clip(r.title, 80), period: r.period, publishedAt: r.publishedAt, kind: r.kind, opinion: opinions.get(r.id) })),
							misljenjaPoznata: opinions.size,
							saRezervomIliNegativna: qualified.length,
							napomena: "Mišljenje je poznato samo za izveštaje čiji je PDF već obrađen; ostali nisu preuzimani.",
						},
						signals,
						sources,
					}
				}),
		}),
		buildTool(ctx, {
			name: "upisi_red",
			local: true,
			max: 600,
			description:
				"Upiši red institucije u poređenje institucija. Poziva se tek posle sva tri alata (trijaza_rukovodstvo, trijaza_nabavke, trijaza_revizija). Brojke i ocenu računa kod iz podataka alata; ti dodaješ samo sažetak od 1-2 rečenice.",
			properties: { summary: { type: "string", description: "1-2 neutralne rečenice (signali, bez optužbi, bez imena osoba)" } },
			required: ["summary"],
			handler: (args) => {
				const { slug } = target(ctx)
				if (!triageComplete(slug)) return { ok: false, error: "ODBIJENO: prvo pozovi sva tri alata: trijaza_rukovodstvo, trijaza_nabavke i trijaza_revizija." }
				const summary = str(args.summary)
				const r = finishRow(slug, summary ? clip(scrubText(summary), 420) : undefined, ctx.agentId)
				const row = S().mapa.rows.get(slug)
				return { ok: r.ok, status: row?.status, score: row?.score, error: r.error }
			},
		}),
	]
}
