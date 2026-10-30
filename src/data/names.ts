/** Name without the legal-form suffix, e.g. "Infrastruktura železnice Srbije a.d." -> "Infrastruktura železnice Srbije". */
export function searchName(name: string): string {
	return name.replace(/\s+(a\.d\.|d\.o\.o\.|ad|doo|j\.p\.|jp)(\s+.*)?$/i, "").trim()
}
