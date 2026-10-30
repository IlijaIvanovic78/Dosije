// Owner answers: a journalist writes "Marko Marković, 100%", "Petar Petrović 60%, Jovan Jovanović 40%" or "Ana Anić i Mila Milić".
// parseOwnerAnswer() turns that into person names plus the share as a separate attribute; fragments that are not names
// ("100%", "vlasnik", "nepoznato") are dropped, so no agent is ever spawned for them and nobody searches for "100%".

import { asciiFold, cyrToLat } from "../data/translit"

export interface ParsedOwner {
	name: string
	/** share as written by the journalist, normalized ("60%"), when she gave one */
	share?: string
}

export const MAX_OWNERS = 3

// "60%", "60 %", "100 odsto", "33.3 posto", "50 procenata"
const SHARE = /(\d{1,3}(?:\.\d{1,2})?)\s*(?:%|odsto|posto|procenata|procenta|percent)/giu
const SPLIT = /\s*(?:[;\n\r]+|,|\s[iи]\s|\s&\s|\s\+\s)\s*/u
const PARTICLE = /^(de|di|von|van|el|al|bin|ibn|le|la|da|dos|del)$/i

// words around a name that are not part of it (compared ASCII-folded, without full stops)
const FILLER = new Set([
	"vlasnik", "vlasnica", "vlasnici", "vlasnistvo", "vlasnistva", "suvlasnik", "suvlasnici", "suvlasnica", "osnivac", "osnivaci", "osnivacica",
	"direktor", "direktorka", "firme", "firma", "firmi", "preduzeca", "drustva", "je", "su", "po", "udeo", "udela", "ucesce", "ucesca", "sa", "od", "cela", "ceo", "sav", "potpuno",
	"jedini", "jedina", "navodno", "prema", "javlja", "javljaju", "kaze", "tvrdi", "ukupno", "ukupan", "posto", "odsto", "procenata", "procenta", "na", "za", "kao",
])

// answers that say "nothing found" ("Ne znam" has the shape of a name) and legal forms ("Extra Auto Transport d.o.o")
const NON_NAME = new Set([
	"ne", "znam", "nema", "nije", "nisam", "nemam", "nepoznato", "nepoznat", "nepoznata", "podatak", "podataka", "podatka", "nista", "nesto", "nedostupno", "dostupno", "dostupan",
	"preskoci", "preskocim", "ok", "da", "jos", "nigde", "nikako", "proveriti", "provera", "proveri", "drzava", "drzavno", "javno", "privatno", "doo", "ad", "pr", "dd", "kd", "od",
	"navedeno", "navedeni", "isto", "isti", "nepotvrdjeno", "unknown", "none", "tbd", "ime", "prezime", "imena", "ko", "koji", "koja", "ili",
])

const TOKEN = /^\p{L}[\p{L}'’.-]*$/u
const key = (t: string) => asciiFold(t).replace(/\./g, "")

function titleCase(token: string): string {
	if (PARTICLE.test(token)) return token.toLowerCase()
	return token
		.split("-")
		.map((p) => (p ? p[0].toLocaleUpperCase("sr") + p.slice(1).toLocaleLowerCase("sr") : p))
		.join("-")
}

interface Fragment {
	name?: string
	share?: string
	/** "po 50%": the share applies to every name of the answer */
	each?: boolean
}

/** One fragment ("Petar Petrović 60%") -> the name and/or the share; a fragment that is not a person name has no name. */
function parseFragment(raw: string): Fragment {
	let text = raw.replace(/\s+/g, " ").trim()
	let share: string | undefined
	for (const m of text.matchAll(SHARE)) share ??= `${m[1].replace(".", ",")}%`
	const each = !!share && /\bpo\s+\d/i.test(text)
	text = text.replace(SHARE, " ")
	// leftover numbers ("Marko Marković 100"), brackets, quotes and dashes around the name
	text = text.replace(/\d+/g, " ").replace(/[()[\]{}„“”"'`:–—/\\|!?*#_=<>@]+/gu, " ").replace(/\s-\s|^-|-$/g, " ").replace(/\s+/g, " ").trim()
	// a full stop ends the sentence ("Marko Marković."), except after a one-letter initial ("Ivan A. Petrović")
	const tokens = text.split(" ").map((t) => t.replace(/^[.,;-]+|[,;-]+$/g, "").replace(/(?<=\p{L}{2})\.+$/u, "")).filter(Boolean)
	const kept = tokens.filter((t) => !FILLER.has(key(t)))
	const none = { share, each }
	if (kept.length < 2 || kept.length > 4) return none
	if (!kept.every((t) => TOKEN.test(t))) return none
	if (kept.filter((t) => key(t).length >= 2).length < 2) return none
	if (kept.some((t) => NON_NAME.has(key(t)))) return none
	const name = cyrToLat(kept.map((t) => (/^\p{Lu}/u.test(t) ? t : titleCase(t))).join(" "))
	return { name, share, each }
}

/**
 * Person names (with the share, when given) from the journalist's free-text answer. At most MAX_OWNERS, no duplicates.
 * A share that stands apart ("Marko Marković, 100%") belongs to the name before it; "po 50%" applies to every name.
 */
export function parseOwnerAnswer(answer: string): ParsedOwner[] {
	const owners: ParsedOwner[] = []
	let each: string | undefined
	let last: ParsedOwner | undefined
	// a decimal comma ("33,3%") is not a separator
	for (const fragment of String(answer ?? "").replace(/(\d),(\d)/g, "$1.$2").split(SPLIT)) {
		if (!fragment.trim()) continue
		const f = parseFragment(fragment)
		if (f.name) {
			const same = owners.find((o) => asciiFold(o.name) === asciiFold(f.name as string))
			if (same) {
				if (f.share) same.share ??= f.share
				continue
			}
			last = { name: f.name, ...(f.share ? { share: f.share } : {}) }
			owners.push(last)
			if (f.each) each = f.share
		} else if (f.share && f.each) each = f.share
		else if (f.share && last && !last.share) last.share = f.share
	}
	if (each) for (const o of owners) o.share ??= each
	return owners.slice(0, MAX_OWNERS)
}

/** "Petar Petrović (60%), Jovan Jovanović (40%)" */
export function describeOwners(owners: ParsedOwner[]): string {
	return owners.map((o) => (o.share ? `${o.name} (${o.share})` : o.name)).join(", ")
}
