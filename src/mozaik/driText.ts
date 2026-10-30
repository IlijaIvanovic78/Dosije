// DRI excerpts as the agents may quote them. The DRI adapter extracts verbatim sentences from the PDF (some truncated at 400
// characters, some with page headers); this layer, which the Revizor's tools and policy use, keeps only what is worth a
// finding and makes every quote a whole sentence:
//  - only excerpts that describe an irregularity or a recommendation ("nije u skladu", "nepravilnost", "preporuk", ...);
//    neutral or positive compliance statements ("Društvo je obračunalo i platilo svoju obavezu ...") are dropped;
//  - page headers and "Page N" artifacts of the PDF text are removed;
//  - a quote ends at a sentence boundary: a sentence that was cut off ("… zasnovana na…") is dropped, never quoted half.

import { asciiFold } from "../data/translit"

export const MAX_QUOTE = 420
const MIN_QUOTE = 60

const PAGE = /(?:^|\s)(?:Page|Strana|Stranica|Str\.|Страна)\s*\d{1,3}(?:\s*(?:of|od|\/)\s*\d{1,3})?(?=\s|$|[.,;:])/iu
const PAGE_DASH = /(?:^|\s)[-–—]\s?\d{1,3}\s?[-–—](?=\s|$)/gu

/** Removes soft hyphens, "Page 11" / "Strana 11" / "- 11 -" and the running header in front of a page marker. */
export function stripPdfArtifacts(raw: string): string {
	let s = raw.replace(/\u00ad/g, "").replace(/\s+/g, " ").trim()
	s = s.replace(PAGE_DASH, " ")
	const m = PAGE.exec(s)
	if (m) {
		// a header ("Sektor za reviziju ... Page 11") stands in FRONT of the continuation of a sentence: both are cut away;
		// later in the text the marker ends the usable part
		s = m.index < 140 ? s.slice(m.index + m[0].length) : s.slice(0, m.index)
	}
	// the priority label of a recommendation table in front of the sentence ("PRIORITET 11 1) Imenovano lice ...")
	s = s.replace(/^(?:PRIORITET|Prioritet)\s+\d+\s*(?:\([^)]{1,12}\)\s*)?(?:\d+\)\s*)?/u, "").replace(/^[-–•]\s+/u, "")
	return s.replace(/\s+/g, " ").trim()
}

// "br.", "čl.", "tač." and similar are not sentence ends
const ABBREVIATION = /(?:^|[\s(„"])(?:br|tač|tac|čl|cl|st|stav|god|tzv|npr|itd|sl|dr|mr|prof|ul|mil|mlrd|hilj|rb|tj|odn)$/iu

/** Index just after every full stop (or ! ?) that ends a sentence. */
function sentenceEnds(s: string): number[] {
	const ends: number[] = []
	for (const m of s.matchAll(/[.!?](?=["”“)]*\s+["„“(–-]?[\p{Lu}\d])/gu)) {
		const i = m.index as number
		const prev = s[i - 1] ?? ""
		const yearBefore = /(?:^|\s)(?:19|20)\d\d$/.test(s.slice(Math.max(0, i - 5), i))
		// a number before the full stop is an ordinal ("člana 36. stav 8"), except a year
		if (!(/\p{Ll}|[)”“%]/u.test(prev) || yearBefore)) continue
		if (ABBREVIATION.test(s.slice(Math.max(0, i - 8), i))) continue
		ends.push(i + 1)
	}
	return ends
}

const TERMINAL = /[.!?]["”“)]*$/u

/**
 * The first whole sentence(s) of an excerpt (at least MIN_QUOTE characters), without artifacts. A text that is cut off ("…"),
 * starts in the middle of a sentence or has no sentence end within `max` characters gives undefined.
 */
export function wholeQuote(raw: string, max = MAX_QUOTE): string | undefined {
	let s = stripPdfArtifacts(raw)
	const truncated = /[…]$|\.{3}$/.test(s)
	s = s.replace(/[…]+$|\.{3}$/u, "").trim()
	// the text began in the middle of a sentence (after a removed header): continue with the next sentence
	if (/^\p{Ll}/u.test(s)) {
		const first = sentenceEnds(s)[0]
		if (first === undefined) return undefined
		s = s.slice(first).trim()
	}
	const ends = sentenceEnds(s)
	if (!truncated && TERMINAL.test(s)) ends.push(s.length)
	const end = ends.find((e) => e >= MIN_QUOTE)
	if (end === undefined || end > max) return undefined
	return s.slice(0, end).replace(/\s+/g, " ").trim()
}

// the excerpt says that something was fine, corrected or not found: not a finding
const POSITIVE = /otklonil|otklonjen|zadovoljavaj|nisu utvrdjen|nije utvrdjen|nisu uoc|nije uoc|nema nepravilnost|bez nepravilnost|nisu date preporuk|nije bilo preporuk/
// boilerplate about recommendations that carries no content
const BOILERPLATE = /odgovarajuc\w* preporuk|preporuka broj|\(preporuka|podnaslov/
// the excerpt describes an irregularity or a recommendation
const ISSUE = [
	/ni(?:je|su) u skladu/,
	// "Društvo nije uspostavilo ...", but not a relative clause of a compliance statement ("osoba koje nije zaposlilo, ...")
	/(?<!\b(?:koje|koji|koja|kojih|kojoj|kojem|kojima|kojeg) )\bni(?:je|su) (?!bil[aeio]\b)\p{L}+/u,
	/nepravilnost/,
	/preporuk/,
	/propust/,
	/\bbez (?!pdv)/,
	/suprotno/,
	/\bpre?cen\w+|potcen\w+/,
	/prekora[cč]/,
]

export function describesIssue(text: string): boolean {
	const t = asciiFold(text)
	if (POSITIVE.test(t) || BOILERPLATE.test(t)) return false
	return ISSUE.some((re) => re.test(t))
}

/** One excerpt as a quote for a finding, or undefined when it is not an irregularity/recommendation or cannot be quoted whole. */
export function cleanDriExcerpt(raw: string, max = MAX_QUOTE): string | undefined {
	const quote = wholeQuote(raw, max)
	if (!quote || /^po na[šs]em mi[šs]ljenju/i.test(quote)) return undefined
	return describesIssue(quote) ? quote : undefined
}

/** The usable quotes of a report's excerpts, in their original order, without repeats. */
export function driFindingExcerpts(list: string[], max = MAX_QUOTE): string[] {
	const out: string[] = []
	for (const raw of list) {
		const q = cleanDriExcerpt(raw, max)
		if (q && !out.includes(q)) out.push(q)
	}
	return out
}

/** The auditor's opinion sentence ("Po našem mišljenju, ..."), when the excerpts hold it whole. */
export function opinionQuote(list: string[]): string | undefined {
	const raw = list.find((e) => /^po na[šs]em mi[šs]ljenju/i.test(e.trim()))
	return raw ? wholeQuote(raw, 600) : undefined
}
