// Source tools: thin wrappers over the data facade. Analysis is deterministic code (src/data/analysis); outputs are
// compact JSON (<= 4,000 chars) with ready-made `sources` the agent copies into add_finding. The data layer, not the
// model, decides which sources are official (see DosijeState.resolveSource).

import type { Tool } from "@mozaik-ai/core"
import * as data from "../../data"
import { pickFirmCandidates } from "../../data/analysis"
import { findFirmProfile, lookupSupplierMb } from "../../data/analysis/firms"
import type { Official } from "../../data/types"
import type { SourceRef } from "../../shared/types"
import { config } from "../../config"
import type { NewsSearchOptions } from "../../data/sources/news"
import { asciiFold, cyrToLat } from "../../data/translit"
import { n } from "../../shared/plural"
import { S, type ToolCtx } from "../domain"
import { clip } from "../util"
import { buildTool, srcOut, str, uniqueSources } from "./helpers"

function instRef() {
	const ref = S().institutionRef
	if (!ref) throw new Error("Nema aktivne institucije.")
	return ref
}

const nameKey = (s: string) => asciiFold(s).replace(/[^a-z0-9]+/g, " ").trim()
const looksLikePerson = (q: string) => /^\p{Lu}\p{L}+(?:\s+\p{Lu}\p{L}+(?:-\p{Lu}\p{L}+)?){1,2}$/u.test(q.trim())

/** Which media search an agent's request stands for: the case institution (with aliases), a person tied to it, or a free topic. */
function newsPlanFor(query: string, args: Record<string, unknown>): { query: string; opts: NewsSearchOptions } {
	const ref = S().institutionRef
	const inst = ref ? { slug: ref.slug, name: ref.name, shortName: ref.shortName } : undefined
	const tip = str(args.tip)
	const days = typeof args.days === "number" && args.days > 0 ? Math.round(args.days) : undefined
	const names = inst ? data.institutionNames(inst) : undefined
	const isInstitution = tip === "institucija" || (!tip && !!names && [names.query, ...names.aliases].some((a) => nameKey(a) === nameKey(query)))
	if (isInstitution && inst) return data.institutionNewsPlan(inst, days ?? 365)
	if ((tip === "osoba" || (!tip && looksLikePerson(query))) && inst) {
		const firms = Array.isArray(args.kontekst) ? args.kontekst.filter((x): x is string => typeof x === "string" && x.trim().length > 1).slice(0, 3) : []
		return data.personNewsPlan(query, inst, firms, days ?? 730)
	}
	return { query, opts: { days: days ?? 90, limit: 40, kind: "topic" } }
}

const jnInst = () => {
	const r = instRef()
	return { name: r.name, jnId: r.jnId, pib: r.pib }
}

const pct = (share: number) => Math.round(share * 1000) / 10

async function officialsOfInstitution(): Promise<Official[]> {
	const r = instRef()
	return data.acas.getOfficials({ acasId: r.acasId, name: r.name, nameCyr: r.nameCyr })
}

// ─── Kadrovik ────────────────────────────────────────────────────────────────

export function kadrovikTools(ctx: ToolCtx): Tool[] {
	return [
		buildTool(ctx, {
			name: "acas_funkcioneri",
			description: "Funkcioneri institucije iz registra ACAS (sadašnji i nedavni): ime, funkcija, od kada, ko je imenovao.",
			properties: {},
			handler: async () => {
				const r = instRef()
				const officials = await officialsOfInstitution()
				const generic = officials[0] ? { ...officials[0].source, publishedAt: undefined } : undefined
				const inOffice = new Set(data.analysis.currentOfficials(officials))
				const stale = data.analysis.supersededOpen(officials)
				return {
					institution: r.name,
					acasId: r.acasId,
					legalType: r.legalType,
					count: officials.length,
					officials: officials.slice(0, 14).map((o) => ({
						personId: o.id,
						name: o.fullName,
						position: o.position,
						acting: o.isActing,
						from: o.from,
						to: o.to,
						current: inOffice.has(o),
						appointedBy: o.appointedBy,
					})),
					napomena: stale.size ? `Bez datuma prestanka, ali zamenjeno kasnijim zapisom za istu funkciju (ne računa se kao tekuće): ${n(stale.size, "zapis")}.` : undefined,
					sources: generic ? [srcOut(generic)] : [],
				}
			},
		}),
		buildTool(ctx, {
			name: "vd_provera",
			description:
				"Proveri da li v.d. status prelazi zakonski maksimum za pravni oblik institucije. Vraća trajanje, propis, overLimit, objašnjenje i (za tekućeg čelnika) lanac uzastopnih v.d.",
			properties: { personId: { type: "string", description: "ACAS personId iz acas_funkcioneri" } },
			required: ["personId"],
			handler: async (args) => {
				const r = instRef()
				const officials = await officialsOfInstitution()
				const wanted = str(args.personId)
				const person = officials.find((o) => o.id === wanted && !o.to) ?? officials.find((o) => o.id === wanted)
				if (!person) return { ok: false, error: "personId nije među funkcionerima institucije." }
				const check = data.analysis.checkVd(person, { legalType: r.legalType })
				const head = data.analysis.pickHead(officials)
				const chain = head && head.id === person.id ? data.analysis.analyzeVdChain(officials) : null
				const { sources, ...rest } = check
				return {
					...rest,
					legalType: r.legalType,
					chain: chain
						? {
								actingCount: chain.actingCount,
								since: chain.since,
								totalMonths: chain.totalMonths,
								totalDays: chain.totalDays,
								gaps: chain.gaps,
								heads: chain.heads.map((h) => ({ name: h.name, from: h.from, to: h.to, months: h.months })),
								explanation: chain.explanation,
							}
						: null,
					sources: sources.map(srcOut),
				}
			},
		}),
		buildTool(ctx, {
			name: "paragraf_akti",
			description: "Akti o imenovanju/razrešenju iz Službenog glasnika za instituciju (samo naslovi akata, bez imena osoba).",
			properties: { personName: { type: "string" } },
			handler: async (args) => {
				const r = instRef()
				const acts = await data.paragraf.findAppointmentActs(r.name, str(args.personName))
				const sources = uniqueSources(acts.map((a) => a.source))
				return {
					count: acts.length,
					acts: acts.slice(0, 6).map((a) => ({ title: clip(a.title, 170), date: a.date, gazette: a.gazette, url: a.url })),
					napomena: acts.length
						? "Izvor sadrži samo naslove akata, ne i ime imenovanog; poklapanje znači da je akt tog tipa za instituciju objavljen u prozoru oko datuma stupanja na funkciju."
						: "Akt nije pronađen u sadržajima brojeva Službenog glasnika za traženi period.",
					sources: acts.length
						? sources.map(srcOut)
						: [
								srcOut({
									kind: "paragraf",
									title: "Paragraf – Službeni glasnik RS (sadržaji brojeva, pretraga akata)",
									url: "https://www.paragraf.rs/glasila/",
									retrievedAt: new Date().toISOString(),
									official: false,
								}),
							],
				}
			},
		}),
	]
}

// ─── Nabavke ─────────────────────────────────────────────────────────────────

function jnContractOut(c: import("../../data/types").Contract) {
	return {
		title: clip(c.title, 90),
		supplier: clip(c.supplierName.replace(/^Zajednička ponuda:\s*/i, "ZP: "), 70),
		valueRsd: c.valueRsd,
		signedAt: c.signedAt,
		procedure: c.procedureType ? clip(c.procedureType, 90) : undefined,
		withoutPublication: c.withoutPublication || undefined,
		url: c.url,
	}
}

export function nabavkeTools(ctx: ToolCtx): Tool[] {
	return [
		buildTool(ctx, {
			name: "jn_pregled",
			description:
				"Pregled javnih nabavki institucije sa Portala javnih nabavki: ukupna vrednost, koncentracija (bez državnih preduzeća), pregovarački postupci bez objavljivanja i rangirana lista dobavljača za proveru (kandidatiZaProveru).",
			properties: {},
			handler: async () => {
				const inst = jnInst()
				const links = await data.iw.getLinksForAuthority({ name: inst.name, pib: inst.pib }).catch(() => [])
				const a = await data.analysis.analyzeProcurement(inst, links)
				const picks = pickFirmCandidates(a.candidates, config.budget.maxFirme, 2)
				const nwp = a.withoutPublication
				S().registerSources(nwp.items.map((i) => i.source).filter((s): s is SourceRef => !!s))
				const largest = nwp.largest
				return {
					institution: a.institution,
					totalContracts: a.totalContracts,
					totalValueRsd: Math.round(a.totalValueRsd),
					period: a.period,
					contractsWithoutRsdValue: a.contractsWithoutRsdValue,
					hhiSviPonudjaci: a.hhi,
					javniSistemi: { iskljuceno: Math.round(a.publicSystemValueRsd), najveci: a.publicSystems.slice(0, 2).map((p) => `${clip(p.name, 28)} ${pct(p.share)}%`) },
					koncentracija: {
						triggered: a.concentration.triggered,
						topName: a.concentration.topName,
						topPib: a.nonPublic.topParticipants[0]?.pib,
						topValueRsd: a.nonPublic.topParticipants[0]?.participationValueRsd,
						topSharePct: pct(a.concentration.topShare),
						hhiBezJavnihSistema: a.concentration.hhi,
						vrednostBezJavnihSistema: Math.round(a.nonPublic.valueRsd),
						ucescePct: a.nonPublic.topParticipants.slice(1, 3).map((p) => `${clip(p.name, 24)} ${pct(p.share)}%`),
					},
					bezObjavljivanja: {
						count: nwp.count,
						saUgovorom: nwp.withContract,
						bezUgovora: nwp.withoutContract,
						valueRsd: Math.round(nwp.valueRsd),
						sharePct: Math.round(nwp.shareOfTotal * 10000) / 100,
						najveci: largest
							? { title: clip(largest.title, 100), supplier: clip(largest.supplier.replace(/^Zajednička ponuda:\s*/i, ""), 70), valueRsd: largest.valueRsd, signedAt: largest.signedAt, procedure: largest.procedureType ? clip(largest.procedureType.replace("Pregovarački postupak bez objavljivanja javnog poziva", "Pregovarački postupak bez objavljivanja"), 70) : undefined, url: largest.url }
							: undefined,
					},
					kandidatiZaProveru: picks.map((c, i) => ({
						rank: i + 1,
						name: clip(c.name, 30),
						pib: c.pib,
						mb: lookupSupplierMb(c.pib)?.mb,
						contracts: c.contracts,
						valueRsd: c.participationValueRsd,
						sharePct: pct(c.share),
						razlog: clip(
							[c.iwFlag ? "IW oznaka" : "", c.nwpContracts ? `pregovarački bez objave ×${c.nwpContracts}` : "", c.jointBids ? `zajedničkih ponuda ${c.jointBids}` : ""].filter(Boolean).join("; ") || "velika vrednost ugovora",
							80,
						),
					})),
					napomena: "Bez državnih preduzeća/javnih sistema (EPS, NIS, fakulteti). Vrednost zajedničke ponude nije vrednost jedne firme.",
					sources: [srcOut(a.source), ...uniqueSources(largest?.source ? [largest.source] : []).map(srcOut)],
				}
			},
		}),		buildTool(ctx, {
			name: "jn_ugovori_dobavljaca",
			description: "Najveći ugovori institucije sa jednim dobavljačem (po PIB-u; zajedničke ponude se računaju za svakog člana).",
			properties: { pib: { type: "string" }, mb: { type: "string" }, name: { type: "string" } },
			handler: async (args) => {
				const contracts = await data.jn.getContractsWithSupplier(jnInst(), { pib: str(args.pib), mb: str(args.mb), name: str(args.name) })
				const sole = contracts.filter((c) => !/^Zajednička ponuda/i.test(c.supplierName))
				return {
					count: contracts.length,
					soleCount: sole.length,
					soleValueRsd: Math.round(sole.reduce((s, c) => s + (c.valueRsd ?? 0), 0)),
					contracts: contracts.slice(0, 8).map(jnContractOut),
					sources: uniqueSources(contracts.slice(0, 3).map((c) => c.source)).map(srcOut),
				}
			},
		}),
		buildTool(ctx, {
			name: "iw_veze",
			description: "Dobavljači institucije koje baza Integrity Watch Srbija označava kao povezane sa javnim funkcionerom ili političkim subjektom (podatak zahteva proveru).",
			properties: {},
			handler: async () => {
				const inst = jnInst()
				const links = await data.iw.getLinksForAuthority({ name: inst.name, pib: inst.pib })
				const byPib = new Map<string, { supplierName: string; pib?: string; mb?: string; kinds: string[]; contracts: number; valueRsd?: number; detail: string; own: typeof links[number]["source"][] }>()
				for (const l of links) {
					const k = l.supplierPib ?? l.supplierName
					const e = byPib.get(k) ?? { supplierName: l.supplierName, pib: l.supplierPib, mb: l.supplierMb ?? lookupSupplierMb(l.supplierPib)?.mb, kinds: [], contracts: 0, valueRsd: l.valueRsd, detail: "", own: [] }
					e.kinds.push(l.linkType)
					e.contracts = Math.max(e.contracts, l.contracts ?? 0)
					e.valueRsd = Math.max(e.valueRsd ?? 0, l.valueRsd ?? 0) || undefined
					e.detail = clip(l.detail ?? "", 200)
					e.own.push(l.source)
					byPib.set(k, e)
				}
				return {
					count: byPib.size,
					// every link carries its own sources: several firms share the same generic Integrity Watch URL
					links: [...byPib.values()].map(({ own, ...rest }) => ({ ...rest, sources: uniqueSources(own).map(srcOut) })),
					napomena: "Otvoreni podaci ne imenuju funkcionera ni stranku. Prazan rezultat znači samo da nema oznake u bazi.",
					sources: uniqueSources(links.map((l) => l.source)).map(srcOut),
				}
			},
		}),
	]
}

// ─── Revizor ─────────────────────────────────────────────────────────────────

export function revizorTools(ctx: ToolCtx): Tool[] {
	return [
		buildTool(ctx, {
			name: "dri_izvestaji",
			description: "Spisak izveštaja Državne revizorske institucije o instituciji (naslov, godina, vrsta, id).",
			properties: {},
			handler: async () => {
				const r = instRef()
				const reports = await data.dri.getReports({ name: r.name, nameCyr: r.nameCyr })
				S().registerSources(reports.map((x) => x.source))
				return {
					total: reports.length,
					reports: reports.slice(0, 24).map((x) => ({ id: x.id, title: clip(x.title, 90), year: x.year, publishedAt: x.publishedAt, kind: x.kind, opinion: x.opinion })),
				}
			},
		}),
		buildTool(ctx, {
			name: "dri_nalazi",
			description: "Mišljenje revizora i doslovni izvodi ključnih nalaza iz jednog izveštaja DRI.",
			properties: { reportId: { type: "string" } },
			required: ["reportId"],
			handler: async (args) => {
				const r = instRef()
				const reports = await data.dri.getReports({ name: r.name, nameCyr: r.nameCyr })
				const report = reports.find((x) => x.id === str(args.reportId))
				if (!report) return { ok: false, error: "Izveštaj sa tim id nije pronađen." }
				const full = await data.dri.getReportFindings(report)
				const pdf: SourceRef = { ...full.source, title: `DRI – izveštaj (PDF): ${clip(full.title, 100)}`, url: full.url }
				return {
					id: full.id,
					title: clip(full.title, 160),
					year: full.year,
					publishedAt: full.publishedAt,
					kind: full.kind,
					opinion: full.opinion,
					excerpts: full.excerpts.slice(0, 5).map((e) => clip(e, 360)),
					sources: [srcOut({ ...full.source, publishedAt: full.source.publishedAt ?? full.publishedAt }), srcOut({ ...pdf, publishedAt: full.publishedAt })],
				}
			},
		}),
	]
}

// ─── Mediji ──────────────────────────────────────────────────────────────────

export function medijiTools(ctx: ToolCtx): Tool[] {
	return [
		buildTool(ctx, {
			name: "vesti_pretraga",
			description:
				"Precizna pretraga vesti (RSS izdanja, Google News latinica i ćirilica, GDELT). tip: institucija (ime institucije slučaja i njeni kratki nazivi; poslednjih 365 dana), osoba (puno ime; članak mora da pominje i instituciju ili firmu; 730 dana) ili tema. Vraća pregled (gotov tekst i do 12 izvora za nalaz 'Pregled medija') i članke za pojedinačne nalaze.",
			properties: {
				query: { type: "string", description: "ime institucije ili puno ime osobe" },
				days: { type: "number", description: "koliko dana unazad (365 za instituciju, 730 za osobu)" },
				tip: { type: "string", enum: ["institucija", "osoba", "tema"] },
				kontekst: { type: "array", items: { type: "string" }, description: "osoba: nazivi firmi (pored institucije slučaja) koje članak može da pominje" },
			},
			required: ["query"],
			max: 9000,
			handler: async (args) => {
				const query = str(args.query) ?? ""
				if (!query) return { ok: false, error: "query je obavezan" }
				const plan = newsPlanFor(query, args)
				const items = await data.news.searchNews(plan.query, plan.opts)
				S().registerSources(items.map((i) => i.source))
				const days = plan.opts.days ?? 365
				const ov = data.newsOverview(items, days, 12)
				const person = plan.opts.kind === "person"
				const dayMs = 86400e3
				const recent = items.filter((i) => i.publishedAt && Date.now() - Date.parse(i.publishedAt) <= 90 * dayMs).sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "")).slice(0, 6)
				// articles that state a function ("generalni direktor ...") are always shown: they feed the comparison with the official register
				const withRole = items.filter((i) => /generaln\w*\s+direktor/.test(asciiFold(i.title))).slice(0, 3)
				const shown = [...new Map([...items.filter((i) => !i.unresolved).slice(0, 5), ...recent.slice(0, 5), ...withRole].map((i) => [i.url, i])).values()].slice(0, 10)
				const topics = ov.topics.length ? `; najčešće teme: ${ov.topics.join(", ")}` : ""
				return {
					query: plan.query,
					tip: person ? "osoba" : plan.opts.kind === "institution" ? "institucija" : "tema",
					days,
					pregled: {
						naslov: `Pregled medija${person ? ` · ${plan.query}` : ""}: ${n(ov.total, "clanak")} u ${data.windowLabel(days)}`,
						tekst: `${n(ov.total, "clanak")} u ${data.windowLabel(days)}${topics}.`,
						ukupno: ov.total,
						izvori: ov.items.map((i) => ({
							kind: "vesti",
							title: clip(cyrToLat(`${i.outlet}: ${i.title}`), 110),
							url: i.url,
							publishedAt: i.publishedAt?.slice(0, 10),
							official: false,
						})),
					},
					clanci: shown.map((i) => ({
						outlet: cyrToLat(i.outlet),
						publishedAt: i.publishedAt?.slice(0, 10),
						nalazi: i.verified,
						title: clip(cyrToLat(i.title), 100),
						url: i.url,
						snippet: i.snippet ? clip(cyrToLat(i.snippet), 80) : undefined,
					})),
				}
			},
		}),
		buildTool(ctx, {
			name: "vest_tekst",
			description: "Tekst članka (do ~1800 znakova) za dati URL iz rezultata pretrage.",
			properties: { url: { type: "string" } },
			required: ["url"],
			handler: async (args) => {
				const url = str(args.url)
				if (!url) return { ok: false, error: "url je obavezan" }
				const a = await data.news.fetchArticle(url)
				return {
					title: clip(cyrToLat(a.title), 160),
					outlet: cyrToLat(a.outlet),
					publishedAt: a.publishedAt?.slice(0, 10),
					text: clip(cyrToLat(a.text), 1800),
					sources: [srcOut(a.source)],
				}
			},
		}),
	]
}

// ─── Firme ───────────────────────────────────────────────────────────────────

function profileOut(p: import("../../data/types").CompanyProfile) {
	return {
		mb: p.mb,
		name: clip(p.name, 90),
		founded: p.founded,
		municipality: p.municipality,
		activityCode: p.activityCode,
		legalForm: p.legalForm,
		status: p.status,
		revenueRsd: p.revenueRsd,
		revenueYear: p.revenueYear,
		employees: p.employees,
	}
}

export function firmeTools(ctx: ToolCtx): Tool[] {
	return [
		buildTool(ctx, {
			name: "apr_firma",
			description: "Profil firme iz APR otvorenih podataka (osnovana, opština, šifra delatnosti, prihod, zaposleni). Vlasnici i direktori nisu u otvorenim podacima.",
			properties: { mb: { type: "string" }, pib: { type: "string" }, name: { type: "string" } },
			handler: async (args) => {
				const m = await findFirmProfile({ mb: str(args.mb), pib: str(args.pib), name: str(args.name) })
				return {
					found: !!m.profile,
					basis: m.basis,
					profile: m.profile ? profileOut(m.profile) : undefined,
					candidates: m.candidates,
					napomena: "Vlasnici i direktori nisu dostupni iz otvorenih podataka (APR pretraga je iza reCAPTCHA).",
					sources: m.profile ? [srcOut(m.profile.source)] : [],
				}
			},
		}),
		buildTool(ctx, {
			name: "firma_signali",
			description:
				"Profil dobavljača + ugovori sa institucijom + signali: ugovor veći od godišnjeg prihoda, firma mlađa od 12 meseci pri prvom ugovoru, manje od 10 zaposlenih sa ugovorima preko 50 miliona RSD, veza u Integrity Watch.",
			properties: { name: { type: "string" }, pib: { type: "string" }, mb: { type: "string" } },
			required: ["name"],
			handler: async (args) => {
				const a = await data.analysis.analyzeFirm(jnInst(), { name: str(args.name) ?? "", pib: str(args.pib), mb: str(args.mb) })
				const biggest = a.contracts.biggest
				return {
					name: clip(a.name, 90),
					pib: a.pib,
					found: !!a.match.profile,
					matchBasis: a.match.basis,
					profile: a.match.profile ? profileOut(a.match.profile) : undefined,
					candidates: a.match.candidates,
					contracts: {
						count: a.contracts.count,
						soleCount: a.contracts.soleCount,
						jointCount: a.contracts.jointCount,
						soleValueRsd: a.contracts.soleValueRsd,
						jointValueRsd: a.contracts.jointValueRsd,
						first: a.contracts.first,
						last: a.contracts.last,
						biggest: biggest ? { title: clip(biggest.title, 100), valueRsd: biggest.valueRsd, signedAt: biggest.signedAt, url: biggest.url } : undefined,
					},
					signals: a.signals.map((s) => ({ code: s.code, label: s.label, severity: s.severity, detail: clip(s.detail, 430) })),
					napomena: "Prihod je 'ukupni prihodi' iz finansijskog izveštaja (APR, hiljade RSD x 1000). Signali su činjenice za proveru, ne zaključci.",
					sources: a.sources.map(srcOut),
				}
			},
		}),
		buildTool(ctx, {
			name: "iw_veze_dobavljaca",
			description: "Da li je dobavljač označen u bazi Integrity Watch Srbija (povezanost sa javnim funkcionerom ili političkim subjektom).",
			properties: { pib: { type: "string" }, name: { type: "string" } },
			handler: async (args) => {
				const links = await data.iw.getLinksForSupplier({ pib: str(args.pib), name: str(args.name) })
				return {
					count: links.length,
					links: links.slice(0, 4).map((l) => ({ supplierName: l.supplierName, linkType: l.linkType, contracts: l.contracts, valueRsd: l.valueRsd, detail: clip(l.detail ?? "", 220) })),
					sources: uniqueSources(links.map((l) => l.source)).map(srcOut),
				}
			},
		}),
	]
}

// ─── Imovina ─────────────────────────────────────────────────────────────────

export function imovinaTools(ctx: ToolCtx): Tool[] {
	return [
		buildTool(ctx, {
			name: "acas_imovina",
			description: "Izveštaji o imovini i prihodima funkcionera iz registra ACAS (najnovija 3, bez adresa).",
			properties: { personId: { type: "string" }, name: { type: "string" } },
			handler: async (args) => {
				const reports = await data.acas.getAssetReports(str(args.personId) ?? "", str(args.name))
				return {
					count: reports.length,
					reports: reports.map((r) => ({ reportDate: r.reportDate, reason: r.reason, summary: r.summary.slice(0, 6).map((l) => clip(l, 170)), url: r.source.url })),
					sources: uniqueSources(reports.map((r) => r.source)).map(srcOut),
				}
			},
		}),
	]
}

// ─── Provera ─────────────────────────────────────────────────────────────────

export function proveraTools(ctx: ToolCtx): Tool[] {
	return [
		buildTool(ctx, {
			name: "acas_pretraga_osobe",
			description: "Pretraga osobe po imenu u registru funkcionera ACAS. Poklapanje imena nije dokaz identiteta (imenjaci su česti).",
			properties: { name: { type: "string" } },
			required: ["name"],
			handler: async (args) => {
				const name = str(args.name) ?? ""
				const officials = await data.acas.searchPerson(name)
				const ids = new Set(officials.map((o) => o.id))
				return {
					name,
					totalFunctions: officials.length,
					distinctPersons: ids.size,
					matches: officials.slice(0, 8).map((o) => ({ personId: o.id, name: o.fullName, position: clip(o.position, 60), institution: clip(o.institutionName, 70), from: o.from, to: o.to, current: !o.to })),
					napomena: "Poklapanje imena nije dokaz identiteta.",
					sources: uniqueSources(officials.slice(0, 1).map((o) => ({ ...o.source, publishedAt: undefined }))).map(srcOut),
				}
			},
		}),
		buildTool(ctx, {
			name: "pep_provera",
			description: "Provera imena na listama politički eksponiranih osoba (OpenSanctions, KRIK). Poklapanje samo po imenu nije dokaz identiteta.",
			properties: { name: { type: "string" } },
			required: ["name"],
			handler: async (args) => {
				const name = str(args.name) ?? ""
				const matches = await data.pep.matchPep(name)
				return {
					name,
					count: matches.length,
					matches: matches.slice(0, 6).map((m) => ({ name: m.name, dataset: m.dataset, detail: clip(m.detail, 200), score: m.score, url: m.url })),
					napomena: "Poklapanje samo po imenu: proveriti identitet.",
					sources: uniqueSources(matches.slice(0, 4).map((m) => m.source)).map(srcOut),
				}
			},
		}),
	]
}
