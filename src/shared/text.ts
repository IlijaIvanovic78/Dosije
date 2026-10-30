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

/** First clause of a sentence cut at a word boundary: ends at the first ";" / ":" / " - " if that is not too early, otherwise at the last word that fits. */
export function headline(s: string, max = 90): string {
	const t = s.replace(/\s+/g, " ").trim().replace(/[.\s]+$/u, "")
	const clause = /^(.{40,}?)(?:[;:]\s|\s[–—-]\s)/u.exec(t)?.[1]
	const first = clause && clause.length <= max ? clause : t
	return clipWords(first, max)
}
