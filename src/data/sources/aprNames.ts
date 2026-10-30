// Name normalization shared by apr.ts (queries) and scripts/build-apr-index.ts (index keys); they must agree.
// Wraps translit.normalizeName and fixes what it misses in APR names: "društvo s ograničenom odgovornošću"
// (with "s" instead of "sa") and the DOO / a.d. abbreviations glued to other words.

import { cyrToLat, normalizeName } from "../translit"

export function aprNormalize(name: string): string {
	const s = cyrToLat(name)
		.replace(/dru[šs]tvo\s+s\s+ograni[čc]enom/gi, "društvo sa ograničenom")
		.replace(/\bd\s*\.\s*o\s*\.\s*o\s*\.?/gi, " doo ")
	// the committed index was built with the city always stripped: queries must normalize the same way
	return normalizeName(s, { alwaysStripCity: true })
}
