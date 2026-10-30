// Serbian Latin <-> Cyrillic transliteration and name normalization.
// ACAS and data.gov.rs search only Cyrillic; JN portal and APR mix both scripts.

const LAT_TO_CYR_DIGRAPHS: [RegExp, string][] = [
	[/DŽ/g, "Џ"], [/Dž/g, "Џ"], [/dž/g, "џ"],
	[/LJ/g, "Љ"], [/Lj/g, "Љ"], [/lj/g, "љ"],
	[/NJ/g, "Њ"], [/Nj/g, "Њ"], [/nj/g, "њ"],
]

const LAT_TO_CYR: Record<string, string> = {
	A: "А", B: "Б", V: "В", G: "Г", D: "Д", Đ: "Ђ", E: "Е", Ž: "Ж", Z: "З", I: "И", J: "Ј", K: "К", L: "Л",
	M: "М", N: "Н", O: "О", P: "П", R: "Р", S: "С", T: "Т", Ć: "Ћ", U: "У", F: "Ф", H: "Х", C: "Ц", Č: "Ч", Š: "Ш",
	a: "а", b: "б", v: "в", g: "г", d: "д", đ: "ђ", e: "е", ž: "ж", z: "з", i: "и", j: "ј", k: "к", l: "л",
	m: "м", n: "н", o: "о", p: "п", r: "р", s: "с", t: "т", ć: "ћ", u: "у", f: "ф", h: "х", c: "ц", č: "ч", š: "ш",
}

const CYR_TO_LAT: Record<string, string> = {
	А: "A", Б: "B", В: "V", Г: "G", Д: "D", Ђ: "Đ", Е: "E", Ж: "Ž", З: "Z", И: "I", Ј: "J", К: "K", Л: "L", Љ: "Lj",
	М: "M", Н: "N", Њ: "Nj", О: "O", П: "P", Р: "R", С: "S", Т: "T", Ћ: "Ć", У: "U", Ф: "F", Х: "H", Ц: "C", Ч: "Č",
	Џ: "Dž", Ш: "Š",
	а: "a", б: "b", в: "v", г: "g", д: "d", ђ: "đ", е: "e", ж: "ž", з: "z", и: "i", ј: "j", к: "k", л: "l", љ: "lj",
	м: "m", н: "n", њ: "nj", о: "o", п: "p", р: "r", с: "s", т: "t", ћ: "ć", у: "u", ф: "f", х: "h", ц: "c", ч: "č",
	џ: "dž", ш: "š",
}

export function latToCyr(input: string): string {
	let s = input
	for (const [re, rep] of LAT_TO_CYR_DIGRAPHS) s = s.replace(re, rep)
	return Array.from(s, (ch) => LAT_TO_CYR[ch] ?? ch).join("")
}

const CYR_UPPER = /[\u0410-\u042F\u0402\u0408-\u040B\u040F]/

/** ALL-CAPS Cyrillic keeps upper-case digraphs: "ЗДРАВЉА" -> "ZDRAVLJA" (not "ZDRAVLjA"). */
export function cyrToLat(input: string): string {
	const chars = Array.from(input)
	return chars
		.map((ch, i) => {
			const lat = CYR_TO_LAT[ch]
			if (lat === undefined) return ch
			if (lat.length === 2 && ch === ch.toUpperCase() && (CYR_UPPER.test(chars[i - 1] ?? "") || CYR_UPPER.test(chars[i + 1] ?? ""))) return lat.toUpperCase()
			return lat
		})
		.join("")
}

export function hasCyrillic(s: string): boolean {
	return /[\u0400-\u04FF]/.test(s)
}

/** Lowercase ASCII form: Cyrillic -> Latin, diacritics stripped (đ -> dj). */
export function asciiFold(input: string): string {
	return cyrToLat(input)
		.replace(/[Đđ]/g, "dj")
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
}

export function slugify(input: string, maxLen = 80): string {
	return asciiFold(input)
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, maxLen)
}

const LEGAL_SUFFIXES = [
	"drustvo sa ogranicenom odgovornoscu",
	"akcionarsko drustvo",
	"javno preduzece",
	"privredno drustvo",
	"ortacko drustvo",
	"komanditno drustvo",
	"preduzetnik",
	"d o o",
	"doo",
	"a d",
	"ad",
	"jp",
	"pd",
	"od",
	"kd",
	"pr",
]

/** Normalize a company / institution / person name for matching across sources. */
export function normalizeName(input: string, opts: { alwaysStripCity?: boolean } = {}): string {
	let s = asciiFold(input).replace(/["'„“”‘’`()]/g, " ").replace(/[.,;:/\\|_-]+/g, " ")
	s = ` ${s.replace(/\s+/g, " ").trim()} `
	for (const suffix of LEGAL_SUFFIXES) s = s.replace(new RegExp(` ${suffix} `, "g"), " ")
	const trimmed = s.replace(/\s+/g, " ").trim()
	const stripped = trimmed.replace(/\s+(beograd|novi sad|nis|kragujevac|subotica)(\s+\S+)*\s*$/g, " ").replace(/\s+/g, " ").trim()
	// "Dom zdravlja Novi Sad", "Grad Novi Sad": without the city only a generic phrase is left, which names hundreds of bodies
	if (!opts.alwaysStripCity && stripped !== trimmed && stripped.split(" ").every((t) => GENERIC_WORDS.has(t))) return trimmed
	return stripped
}

export const GENERIC_WORDS = new Set([
	"dom", "zdravlja", "grad", "gradska", "gradsko", "opstina", "opsta", "bolnica", "klinicki", "centar", "zavod", "institut", "skola", "gimnazija",
	"vodovod", "i", "kanalizacija", "javno", "komunalno", "gradski", "toplana", "gradska", "ustanova", "apoteka", "fakultet", "univerzitet",
	"univerzitetski", "specijalna", "opsta", "republicki", "drzavna", "klinicko", "bolnicki", "medicinski", "osnovna", "srednja", "visoka", "tehnicka", "muzej", "pozoriste", "biblioteka", "decji", "vrtic", "predskolska", "ustanova", "kulture", "obrazovanje", "za", "zdravstveni", "kulturni", "sportski", "preduzece", "uprava", "agencija", "direkcija", "ministarstvo", "fond", "posta", "aerodrom", "jkp", "jp",
])

const CASE_ENDINGS = new Set(["", "a", "e", "i", "o", "u", "om", "em", "im", "am", "ama", "ima", "ih", "og", "oj", "ovi", "ova", "ove", "ega", "emu", "omu", "ju", "ja", "je", "ji"])

/** Fleeting "a": "petar" ~ "petra", "petru", "petrom". */
function fleetingA(a: string, b: string): boolean {
	if (!a.endsWith("ar")) return false
	const stem = `${a.slice(0, -2)}r`
	return stem.length >= 4 && b.startsWith(stem) && CASE_ENDINGS.has(b.slice(stem.length))
}

/**
 * Same Serbian word up to a case ending, on ASCII-folded lowercase tokens: "zeleznice" ~ "zeleznica",
 * "jevtic" ~ "jevtica", but "srbija" !~ "srbijavoz" and "srbijavoz" !~ "srbijavode".
 */
export function sameWord(a: string, b: string): boolean {
	if (a === b) return true
	if (fleetingA(a, b) || fleetingA(b, a)) return true
	const min = Math.min(a.length, b.length)
	if (min < 5) {
		// short stems ("dom" ~ "doma", "nis" ~ "nisu"): only a bare case ending of at most two letters may differ
		if (min < 3) return false
		const [s, l] = a.length <= b.length ? [a, b] : [b, a]
		return l.startsWith(s) && l.length - s.length <= 2 && CASE_ENDINGS.has(l.slice(s.length))
	}
	let i = 0
	while (i < min && a[i] === b[i]) i++
	if (i < 4) return false
	return CASE_ENDINGS.has(a.slice(i)) && CASE_ENDINGS.has(b.slice(i))
}

/** Token-set similarity (0..1) on normalized names. */
export function nameSimilarity(a: string, b: string): number {
	const ta = new Set(normalizeName(a).split(" ").filter(Boolean))
	const tb = new Set(normalizeName(b).split(" ").filter(Boolean))
	if (ta.size === 0 || tb.size === 0) return 0
	let inter = 0
	for (const t of ta) if (tb.has(t)) inter++
	return inter / Math.max(ta.size, tb.size)
}
