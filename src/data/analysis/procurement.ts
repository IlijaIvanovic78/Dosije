// Deterministic procurement analysis on top of the Portal javnih nabavki adapter and Integrity Watch:
// concentration (without state utilities / public systems), participation value per PIB across joint bids,
// negotiated procedures without publication and a ranked list of suppliers worth a per-firm check.
//
// Joint bids: the portal lists every bid as its own bidder (jnportal.ts). To credit each member of a consortium we
// read the compact contract store that jnportal.ts caches (data/cache/jnportal/contracts-<id>.json, format in
// docs/data-sources/jnportal.md). If the store is not readable the analysis degrades to the adapter's top suppliers.

import type { SourceRef } from "../../shared/types"
import { cacheKey, readCache } from "../cache"
import * as iw from "../sources/integrityWatch"
import * as jn from "../sources/jnportal"
import { asciiFold, normalizeName } from "../translit"
import type { Contract, IntegrityWatchLink, ProcurementSummary } from "../types"

interface StoredContract {
	id: string
	tenderId: number
	contractNo: string
	title: string
	supplierName: string
	supplierPib?: string
	pibs: string[]
	valueRsd?: number
	signedAt?: string
	procedureTypeId?: number
	procedureType?: string
}

interface Store {
	contracts: StoredContract[]
}

export interface InstLike {
	name: string
	jnId?: string
	pib?: string
}

const PUBLIC_SYSTEM = new RegExp(
	[
		"^eps\\b",
		"\\beps (ad|a d)\\b",
		"elektroprivreda srbije",
		"elektromreza srbije",
		"^nis\\b",
		"naftna industrija srbije",
		"telekom srbija",
		"srbijagas",
		"srbijavoz",
		"srbija voz",
		"srbija kargo",
		"zeleznice srbije",
		"posta srbije",
		"putevi srbije",
		"javno preduzece",
		"^jp\\b",
		"vojvodinasume",
		"srbijasume",
		"aerodrom nikola tesla",
		"air serbia",
		"^fakultet",
		"\\bfakultet\\b",
		"univerzitet",
		"republicki zavod",
		"ministarstvo",
		"elektrodistribucija",
		"gradska toplana",
		"vodovod i kanalizacija",
		"direkcija za",
	].join("|"),
)

/** State utilities, public enterprises, faculties and ministries: excluded from per-firm checks and from the concentration signal. */
export function isPublicSystem(name: string): boolean {
	const raw = asciiFold(name)
	const n = ` ${raw.replace(/[^a-z0-9]+/g, " ").trim()} `.trim()
	if (PUBLIC_SYSTEM.test(n)) return true
	if (/\binstitut\b/.test(n) && !/\b(doo|d o o)\b/.test(raw.replace(/[^a-z0-9.]+/g, " ")) && !/\bdoo\b/.test(n)) return true
	return false
}

export interface SupplierRow {
	pib?: string
	name: string
	contracts: number
	soleContracts: number
	soleValueRsd: number
	jointBids: number
	jointValueRsd: number // whole value of the joint bids the firm took part in (not attributed to the firm alone)
	participationValueRsd: number // soleValueRsd + jointValueRsd
	nwpContracts: number
	nwpValueRsd: number
	first?: string
	last?: string
	publicSystem: boolean
}

export interface Candidate {
	pib: string
	name: string
	score: number
	reasons: string[]
	contracts: number
	soleValueRsd: number
	participationValueRsd: number
	jointBids: number
	share: number // participation value / total contract value (0..1)
	iwFlag: boolean
	nwpContracts: number
}

export interface NegotiatedItem {
	title: string
	supplier: string
	valueRsd?: number
	signedAt?: string
	procedureType?: string
	status: "ugovor" | "bez_ugovora"
	url?: string
	source?: SourceRef
}

export interface ProcurementAnalysis {
	institution: string
	totalContracts: number
	totalValueRsd: number
	period: { from?: string; to?: string }
	byYear: { year: number; contracts: number; valueRsd: number }[]
	contractsWithoutRsdValue: number
	hhi?: number
	publicSystems: { name: string; valueRsd: number; share: number }[]
	publicSystemValueRsd: number
	nonPublic: {
		valueRsd: number
		hhi: number
		topParticipants: { name: string; pib?: string; participationValueRsd: number; share: number; soleValueRsd: number; jointBids: number }[]
		topBidders: { name: string; valueRsd: number; share: number }[]
	}
	concentration: { triggered: boolean; topName?: string; topShare: number; top3Share: number; hhi: number; reason: string }
	withoutPublication: {
		count: number
		withContract: number
		withoutContract: number
		valueRsd: number
		shareOfTotal: number
		largest?: NegotiatedItem
		items: NegotiatedItem[]
	}
	candidates: Candidate[]
	suppliers: SupplierRow[]
	degraded: boolean
	summary: ProcurementSummary
	source: SourceRef
}

const round = (n: number, d = 0) => Math.round(n * 10 ** d) / 10 ** d

function splitNames(supplierName: string): string[] {
	return supplierName
		.replace(/^Zajednička ponuda:\s*/i, "")
		.split(/,\s+/)
		.map((s) => s.trim())
		.filter(Boolean)
}

async function loadStore(inst: InstLike): Promise<Store | null> {
	try {
		let id = inst.jnId
		if (!id) id = (await jn.findAuthority(inst.pib ?? inst.name))[0]?.id
		if (!id) return null
		const env = await readCache<string>("jnportal", cacheKey("contracts", id))
		if (!env?.data) return null
		return JSON.parse(env.data) as Store
	} catch {
		return null
	}
}

function money(n: number): string {
	if (n >= 1e9) return `${round(n / 1e9, 2).toLocaleString("sr-RS")} mlrd RSD`
	if (n >= 1e6) return `${round(n / 1e6, 1).toLocaleString("sr-RS")} mil. RSD`
	return `${Math.round(n).toLocaleString("sr-RS")} RSD`
}

export { money as formatRsd }

function toNegotiated(c: Contract): NegotiatedItem {
	const noContract = c.id.startsWith("postupak-")
	return {
		title: c.title,
		supplier: c.supplierName,
		valueRsd: c.valueRsd,
		signedAt: c.signedAt,
		procedureType: c.procedureType,
		status: noContract ? "bez_ugovora" : "ugovor",
		url: c.url,
		source: c.source,
	}
}

/** Candidates for per-firm checks: the biggest participants by value (reserveTop), then the best journalistic score (IW flag, negotiated winner, value). */
export function pickFirmCandidates(candidates: Candidate[], n: number, reserveTop = 2): Candidate[] {
	const byValue = [...candidates].sort((a, b) => b.participationValueRsd - a.participationValueRsd).slice(0, reserveTop)
	const out = [...byValue]
	for (const c of candidates) {
		if (out.length >= n) break
		if (!out.includes(c)) out.push(c)
	}
	return out.slice(0, n)
}

export async function analyzeProcurement(inst: InstLike, links?: IntegrityWatchLink[]): Promise<ProcurementAnalysis> {
	const summary = await jn.getSummary(inst)
	const store = await loadStore(inst)
	const iwLinks = links ?? (await iw.getLinksForAuthority({ name: inst.name, pib: inst.pib }).catch(() => [] as IntegrityWatchLink[]))
	const iwByPib = new Map<string, IntegrityWatchLink[]>()
	for (const l of iwLinks) if (l.supplierPib) iwByPib.set(l.supplierPib, [...(iwByPib.get(l.supplierPib) ?? []), l])

	const total = summary.totalValueRsd
	const rows = new Map<string, SupplierRow>()
	const bidders = new Map<string, { name: string; valueRsd: number; publicSystem: boolean }>()
	const rowFor = (pib: string | undefined, name: string): SupplierRow => {
		const key = pib ?? `n:${normalizeName(name)}`
		let r = rows.get(key)
		if (!r) {
			r = {
				pib,
				name,
				contracts: 0,
				soleContracts: 0,
				soleValueRsd: 0,
				jointBids: 0,
				jointValueRsd: 0,
				participationValueRsd: 0,
				nwpContracts: 0,
				nwpValueRsd: 0,
				publicSystem: isPublicSystem(name),
			}
			rows.set(key, r)
		}
		return r
	}
	let withoutRsd = 0
	const degraded = !store

	if (store) {
		const named = new Map<string, { name: string; at: string; sole: boolean }>()
		for (const c of store.contracts) {
			const v = c.valueRsd ?? 0
			if (c.valueRsd === undefined) withoutRsd++
			const names = splitNames(c.supplierName)
			const joint = c.pibs.length > 1
			const mapped = joint && names.length === c.pibs.length
			const members = joint
				? c.pibs.map((pib, i) => ({ pib, name: mapped ? names[i] : i === 0 && names[0] ? names[0] : `PIB ${pib}`, certain: mapped || i === 0 }))
				: [{ pib: c.pibs[0] as string | undefined, name: c.supplierName, certain: true }]
			const bidKey = c.pibs.length ? [...c.pibs].sort().join("+") : normalizeName(c.supplierName)
			const bid = bidders.get(bidKey) ?? { name: c.supplierName, valueRsd: 0, publicSystem: false }
			bid.valueRsd += v
			bid.publicSystem = joint ? names.every((n) => isPublicSystem(n)) : isPublicSystem(c.supplierName)
			if (c.signedAt) bid.name = c.supplierName
			bidders.set(bidKey, bid)
			for (const m of members) {
				if (m.pib && m.certain) {
					const prev = named.get(m.pib)
					if (!joint) {
						if (!prev || !prev.sole || (c.signedAt ?? "") >= prev.at) named.set(m.pib, { name: m.name, at: c.signedAt ?? "", sole: true })
					} else if (!prev) named.set(m.pib, { name: m.name, at: c.signedAt ?? "", sole: false })
				}
				const r = rowFor(m.pib, m.name)
				r.contracts++
				if (joint) {
					r.jointBids++
					r.jointValueRsd += v
				} else {
					r.soleContracts++
					r.soleValueRsd += v
				}
				if (c.procedureTypeId === 6) {
					r.nwpContracts++
					r.nwpValueRsd += v
				}
				if (c.signedAt) {
					if (!r.first || c.signedAt < r.first) r.first = c.signedAt
					if (!r.last || c.signedAt > r.last) r.last = c.signedAt
				}
			}
		}
		for (const r of rows.values()) {
			if (r.pib && named.has(r.pib)) r.name = (named.get(r.pib) as { name: string }).name
			r.publicSystem = isPublicSystem(r.name)
			r.participationValueRsd = r.soleValueRsd + r.jointValueRsd
		}
	} else {
		for (const s of summary.topSuppliers) {
			const joint = /^Zajednička ponuda/i.test(s.name)
			const r = rowFor(s.pib, s.name)
			r.contracts += s.contracts
			if (joint) {
				r.jointBids += s.contracts
				r.jointValueRsd += s.valueRsd
			} else {
				r.soleContracts += s.contracts
				r.soleValueRsd += s.valueRsd
			}
			r.participationValueRsd = r.soleValueRsd + r.jointValueRsd
			r.first = s.firstContractAt
			r.last = s.lastContractAt
			bidders.set(s.pib ?? s.name, { name: s.name, valueRsd: s.valueRsd, publicSystem: isPublicSystem(s.name) })
		}
	}

	const suppliers = [...rows.values()].sort((a, b) => b.participationValueRsd - a.participationValueRsd)

	const publicBidders = [...bidders.values()].filter((b) => b.publicSystem)
	const publicValue = publicBidders.reduce((s, b) => s + b.valueRsd, 0)
	const nonPublicBidders = [...bidders.values()].filter((b) => !b.publicSystem).sort((a, b) => b.valueRsd - a.valueRsd)
	const nonPublicTotal = nonPublicBidders.reduce((s, b) => s + b.valueRsd, 0)
	const hhiNonPublic = nonPublicTotal > 0 ? Math.round(nonPublicBidders.reduce((s, b) => s + ((b.valueRsd / nonPublicTotal) * 100) ** 2, 0)) : 0

	const nonPublicRows = suppliers.filter((r) => !r.publicSystem && r.participationValueRsd > 0)
	const topParticipants = nonPublicRows.slice(0, 5).map((r) => ({
		name: r.name,
		pib: r.pib,
		participationValueRsd: round(r.participationValueRsd),
		share: nonPublicTotal > 0 ? r.participationValueRsd / nonPublicTotal : 0,
		soleValueRsd: round(r.soleValueRsd),
		jointBids: r.jointBids,
	}))
	const top = topParticipants[0]
	const top3Share = topParticipants.slice(0, 3).reduce((s, p) => s + p.share, 0)
	const triggered = (top?.share ?? 0) > 0.25 || hhiNonPublic > 1500
	const reason = top
		? `Bez državnih preduzeća i javnih sistema (${money(publicValue)} izuzeto), firma ${top.name} učestvuje (samostalno ili u zajedničkim ponudama) u ugovorima vrednosti ${money(top.participationValueRsd)}, što je ${round(top.share * 100, 1).toLocaleString("sr-RS")}% preostale vrednosti (${money(nonPublicTotal)}); HHI po ponuđačima: ${hhiNonPublic}. Vrednost zajedničke ponude nije vrednost koja pripada pojedinačnoj firmi.`
		: "Nema dovoljno podataka o dobavljačima."
	const concentration = { triggered, topName: top?.name, topShare: top?.share ?? 0, top3Share, hhi: hhiNonPublic, reason }

	const nwpAll = summary.withoutPublication
	const nwpItems = nwpAll.map(toNegotiated)
	const nwpValue = nwpAll.reduce((s, c) => s + (c.valueRsd ?? 0), 0)
	const largest = [...nwpItems].sort((a, b) => (b.valueRsd ?? -1) - (a.valueRsd ?? -1))[0]

	// candidates for per-firm checks
	const candidates: Candidate[] = []
	for (const r of suppliers) {
		if (!r.pib || r.publicSystem) continue
		if (/^PIB \d+$/.test(r.name) && r.participationValueRsd < 1e8) continue
		const links = iwByPib.get(r.pib) ?? []
		const kinds = new Set(links.map((l) => l.linkType))
		const official = [...kinds].some((k) => /funkcioner/i.test(k))
		const political = [...kinds].some((k) => /politi[čc]k/i.test(k))
		const reasons: string[] = []
		let score = 7 * Math.log10(1 + r.participationValueRsd / 1e6)
		if (official) {
			score += 25
			reasons.push("označen u Integrity Watch Srbija kao povezan sa javnim funkcionerom")
		}
		if (political) {
			score += 20
			reasons.push("označen u Integrity Watch Srbija kao povezan sa političkim subjektom")
		}
		if (r.nwpContracts > 0) {
			score += 8 * Math.min(r.nwpContracts, 3)
			reasons.push(`dobitnik pregovaračkog postupka bez objavljivanja (${r.nwpContracts})`)
		}
		if (r.participationValueRsd > 0) reasons.push(`učešće u ugovorima: ${money(r.participationValueRsd)}${r.jointBids ? ` (od toga ${r.jointBids} zajedničkih ponuda)` : ""}`)
		candidates.push({
			pib: r.pib,
			name: r.name,
			score: round(score, 1),
			reasons,
			contracts: r.contracts,
			soleValueRsd: round(r.soleValueRsd),
			participationValueRsd: round(r.participationValueRsd),
			jointBids: r.jointBids,
			share: total > 0 ? r.participationValueRsd / total : 0,
			iwFlag: official || political,
			nwpContracts: r.nwpContracts,
		})
	}
	candidates.sort((a, b) => b.score - a.score)

	return {
		institution: summary.institution,
		totalContracts: summary.totalContracts,
		totalValueRsd: summary.totalValueRsd,
		period: summary.period,
		byYear: summary.byYear,
		contractsWithoutRsdValue: withoutRsd,
		hhi: summary.hhi,
		publicSystems: publicBidders
			.sort((a, b) => b.valueRsd - a.valueRsd)
			.slice(0, 5)
			.map((b) => ({ name: b.name, valueRsd: round(b.valueRsd), share: total > 0 ? b.valueRsd / total : 0 })),
		publicSystemValueRsd: round(publicValue),
		nonPublic: {
			valueRsd: round(nonPublicTotal),
			hhi: hhiNonPublic,
			topParticipants,
			topBidders: nonPublicBidders.slice(0, 3).map((b) => ({ name: b.name, valueRsd: round(b.valueRsd), share: nonPublicTotal > 0 ? b.valueRsd / nonPublicTotal : 0 })),
		},
		concentration,
		withoutPublication: {
			count: nwpAll.length,
			withContract: nwpItems.filter((i) => i.status === "ugovor").length,
			withoutContract: nwpItems.filter((i) => i.status === "bez_ugovora").length,
			valueRsd: round(nwpValue),
			shareOfTotal: total > 0 ? nwpValue / total : 0,
			largest,
			items: nwpItems,
		},
		candidates,
		suppliers: suppliers.slice(0, 40),
		degraded,
		summary,
		source: summary.source,
	}
}

