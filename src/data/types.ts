// Normalized data types returned by the source adapters in src/data/sources/*.
// Adapters translate raw public APIs (ACAS, Portal javnih nabavki, APR, DRI, RSS...)
// into these shapes. Agents' tools only ever see these shapes, never raw responses.
//
// Rules for every adapter:
//  - every returned record carries a SourceRef (public URL + retrievedAt + official flag)
//  - NO personal contact data (phone, e-mail, home address) is ever returned or cached
//  - dates are ISO strings (YYYY-MM-DD or full ISO datetime)
//  - money is RSD as a number (no formatting)

import type { SourceRef } from "../shared/types"

export type LegalType =
	| "javno_preduzece" // Zakon o javnim preduzećima
	| "drustvo_kapitala_drzavno" // privredno društvo u (većinskom) vlasništvu države, e.g. "a.d."
	| "zdravstvena_ustanova"
	| "organ_drzavne_uprave"
	| "lokalna_samouprava"
	| "ostalo"

export interface InstitutionRef {
	query: string // what the user typed
	slug: string // cache key, e.g. "infrastruktura-zeleznice-srbije"
	name: string // official name, Latin script
	nameCyr: string // official name, Cyrillic script (ACAS & data.gov.rs search only Cyrillic)
	shortName?: string // e.g. "IŽS"
	aliases?: string[] // other names of the same body found in the registers (searched in the media and accepted as the institution)
	legalType: LegalType
	pib?: string
	mb?: string // matični broj
	acasId?: string // ACAS institution identifier
	acasAltIds?: string[] // other register entries of the same body (renamed / re-registered); officials are merged
	jnId?: string // Portal javnih nabavki contracting-authority identifier
	municipality?: string
	sources: SourceRef[]
}

/** A public official (funkcioner) from the ACAS register. */
export interface Official {
	id: string // ACAS person (or function) identifier
	fullName: string // Latin script
	fullNameCyr?: string
	position: string // Latin script, e.g. "v.d. generalnog direktora"
	positionCyr?: string
	isActing: boolean // v.d. (vršilac dužnosti)
	institutionName: string
	from?: string // start date of the function
	to?: string // end date (undefined = still in office)
	appointedBy?: string // e.g. "Vlada Republike Srbije"
	source: SourceRef
}

export interface AssetReport {
	personId: string
	fullName: string
	reportDate?: string
	reason?: string // e.g. "stupanje na funkciju", "godišnji izveštaj"
	summary: string[] // short human-readable lines (real estate, vehicles, income...) — no addresses
	incomes?: { source: string; amountRsd?: number; period?: string }[]
	source: SourceRef
}

export interface AppointmentAct {
	title: string // e.g. "Rešenje o imenovanju vršioca dužnosti generalnog direktora ..."
	date?: string
	gazette?: string // e.g. "Službeni glasnik RS, br. 45/2025"
	url: string
	source: SourceRef
}

export interface Contract {
	id: string
	title: string
	supplierName: string
	supplierPib?: string
	supplierMb?: string
	valueRsd?: number // without VAT when known
	valueRsdWithVat?: number
	signedAt?: string
	procedureType?: string // Latin, e.g. "Pregovarački postupak bez objavljivanja javnog poziva"
	withoutPublication: boolean
	cpv?: string
	url?: string // public page on the portal
	source: SourceRef
}

export interface SupplierAggregate {
	name: string
	pib?: string
	mb?: string
	contracts: number
	valueRsd: number
	share: number // 0..1 of the institution's total contract value
	firstContractAt?: string
	lastContractAt?: string
}

/** What part of an authority's contract history an analysis covers (big authorities are capped to the most recent contracts). */
export interface ProcurementCoverage {
	/** contracts the portal lists for the authority */
	total: number
	/** contracts read and analysed */
	analyzed: number
	truncated: boolean
	/** signing date of the oldest contract read: the analysed period starts here */
	from?: string
	/** procedure types are known only for part of the contracts (the crawl of procedures ran out of time) */
	proceduresPartial?: boolean
}

export interface ProcurementSummary {
	coverage?: ProcurementCoverage
	institution: string
	totalContracts: number
	totalValueRsd: number
	period: { from?: string; to?: string }
	byYear: { year: number; contracts: number; valueRsd: number }[]
	topSuppliers: SupplierAggregate[] // top 15 by value
	topContracts: Contract[] // top 10 by value
	withoutPublication: Contract[] // all negotiated procedures without publication
	hhi?: number // Herfindahl-Hirschman index of supplier shares (0..10000)
	source: SourceRef
}

/** A row from the Integrity Watch Srbija dataset that links a supplier to an official / party. */
export interface IntegrityWatchLink {
	supplierName: string
	supplierPib?: string
	supplierMb?: string
	contractingAuthority?: string
	linkType: string // as given by the dataset, e.g. "povezanost sa funkcionerom", "politička veza"
	linkedPerson?: string
	detail?: string
	contracts?: number
	valueRsd?: number
	/** the media article the dataset cites as the basis of a party link; unverified until the article is read (see analysis/firms.ts) */
	basisUrl?: string
	source: SourceRef
}

export interface CompanyProfile {
	mb: string
	pib?: string
	name: string
	founded?: string
	municipality?: string
	activityCode?: string
	activityName?: string
	legalForm?: string
	status?: string
	revenueRsd?: number
	revenueYear?: number
	employees?: number
	source: SourceRef
}

export interface AuditReport {
	id: string
	title: string
	year?: number
	publishedAt?: string
	kind?: string // e.g. "finansijska revizija", "revizija pravilnosti", "revizija svrsishodnosti"
	/** audited period, ONLY when the title states it ("za 2018. godinu" -> "2018"); `year` may be the publication year */
	period?: string
	url: string // PDF or report page
	opinion?: string // e.g. "mišljenje sa rezervom"
	excerpts: string[] // short verbatim excerpts of key findings (empty in list views)
	source: SourceRef
}

export interface NewsItem {
	id: string
	title: string
	url: string
	outlet: string // e.g. "N1", "Danas", "raspadsistema.com"
	publishedAt?: string
	snippet?: string
	matched: string[] // subject names found in title/snippet/text
	provider: string // "rss:n1" | "google-news-rss" | "gdelt" | "serper" | "brave"
	/** where the subject was found: the headline, the feed snippet, or the article text fetched to verify it */
	verified?: "naslov" | "opis" | "tekst"
	/** relevance (higher = more relevant); searchNews returns items ordered by it, then by recency */
	score?: number
	/** the Google News redirect link could not be resolved to the outlet's own URL */
	unresolved?: boolean
	source: SourceRef
}

export interface ArticleText {
	url: string
	title: string
	outlet: string
	publishedAt?: string
	text: string // plain text, max ~6000 chars
	source: SourceRef
}

export interface PepMatch {
	name: string
	dataset: "opensanctions" | "krik" | "acas"
	detail: string
	url?: string
	score: number // 0..1 name match confidence
	source: SourceRef
}

export interface VdRule {
	id: string
	legalType: LegalType
	law: string // e.g. "Zakon o javnim preduzećima"
	article: string // e.g. "čl. 52"
	maxMonths: number
	extensionMonths?: number
	summary: string // Serbian, one sentence
	url: string
}
