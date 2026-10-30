// Text helpers shared by the data layer and the agents.

/** Cuts at a word boundary (never mid-word) and appends "…"; text that fits is returned whole. */
export function clipWords(s: string, max: number): string {
	const t = s.replace(/\s+/g, " ").trim()
	if (t.length <= max) return t
	const cut = t.slice(0, Math.max(0, max - 1))
	// the cut is clean when it fell exactly on a word end
	const clean = /\s/.test(t[Math.max(0, max - 1)] ?? "")
	const at = clean ? cut.length : cut.lastIndexOf(" ")
	const head = at >= max * 0.5 ? cut.slice(0, at) : cut
	return `${head.replace(/[\s,;:–—\-(„"“]+$/u, "")}…`
}

/**
 * A short title from a long sentence: whole if it fits, otherwise cut at the last CLAUSE boundary that fits (a comma, "(", or just
 * before "koji/koje/što/jer/dok/i/..."), so the title ends where a phrase ends. Only when there is no such boundary: "…".
 */
export function clauseHeadline(s: string, max = 100): string {
	const t = s.replace(/\s+/g, " ").trim().replace(/[.\s]+$/u, "")
	if (t.length <= max) return t
	const window = t.slice(0, max + 1)
	const min = Math.floor(max * 0.45)
	const at = [...window.matchAll(/,\s|\s\(|\s(?=(?:koje|koji|koja|koju|kojima|kojim|što|jer|dok|ali|odnosno|te|i|ili)\s)/giu)]
		.map((m) => m.index as number)
		.filter((i) => i >= min)
		.pop()
	return at === undefined ? clipWords(t, max) : t.slice(0, at).replace(/[\s,;:–—\-(„"“]+$/u, "")
}

/** First clause of a sentence cut at a word boundary: ends at the first ";" / ":" / " - " if that is not too early, otherwise at the last word that fits. */
export function headline(s: string, max = 90): string {
	const t = s.replace(/\s+/g, " ").trim().replace(/[.\s]+$/u, "")
	const clause = /^(.{40,}?)(?:[;:]\s|\s[–—-]\s)/u.exec(t)?.[1]
	const first = clause && clause.length <= max ? clause : t
	return clipWords(first, max)
}
