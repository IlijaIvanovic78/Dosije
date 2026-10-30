// Serbian plural forms for generated text: "1 ugovor", "3 ugovora", "7 ugovora"; "1 mesec", "3 meseca", "7 meseci".
// one: n % 10 == 1 && n % 100 != 11; few: n % 10 in 2..4 && n % 100 not in 12..14; many: everything else (including 0).

export type Forms = readonly [one: string, few: string, many: string]

export function pluralIndex(n: number): 0 | 1 | 2 {
	const i = Math.abs(Math.trunc(n))
	const m10 = i % 10
	const m100 = i % 100
	if (m10 === 1 && m100 !== 11) return 0
	if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 1
	return 2
}

/** The word form that agrees with n: plural(3, FORMS.ugovor) -> "ugovora". */
export function plural(n: number, forms: Forms): string {
	return forms[pluralIndex(n)]
}

/** Number and word together: count(1, FORMS.ugovor) -> "1 ugovor"; `shown` replaces the digits (e.g. "1.537"). */
export function count(n: number, forms: Forms, shown?: string): string {
	return `${shown ?? String(n)} ${plural(n, forms)}`
}

export const FORMS = {
	ugovor: ["ugovor", "ugovora", "ugovora"],
	nalaz: ["nalaz", "nalaza", "nalaza"],
	agent: ["agent", "agenta", "agenata"],
	konflikt: ["konflikt", "konflikta", "konflikata"],
	izvestaj: ["izveštaj", "izveštaja", "izveštaja"],
	clanak: ["članak", "članka", "članaka"],
	postupak: ["postupak", "postupka", "postupaka"],
	mesec: ["mesec", "meseca", "meseci"],
	dan: ["dan", "dana", "dana"],
	godina: ["godina", "godine", "godina"],
	tvrdnja: ["tvrdnja", "tvrdnje", "tvrdnji"],
	zadatak: ["zadatak", "zadatka", "zadataka"],
	firma: ["firma", "firme", "firmi"],
	osoba: ["osoba", "osobe", "osoba"],
	petlja: ["petlja", "petlje", "petlji"],
	signal: ["signal", "signala", "signala"],
	dobavljac: ["dobavljač", "dobavljača", "dobavljača"],
	funkcioner: ["funkcioner", "funkcionera", "funkcionera"],
	zaposleni: ["zaposleni", "zaposlena", "zaposlenih"],
	pregovarackiPostupak: ["pregovarački postupak", "pregovaračka postupka", "pregovaračkih postupaka"],
	unos: ["unos", "unosa", "unosa"],
	pokrenutAgent: ["pokrenut tokom rada", "pokrenuta tokom rada", "pokrenutih tokom rada"],
	stavka: ["stavka", "stavke", "stavki"],
	zapis: ["zapis", "zapisa", "zapisa"],
	ucesnik: ["učesnik", "učesnika", "učesnika"],
	entitet: ["entitet", "entiteta", "entiteta"],
	institucija: ["institucija", "institucije", "institucija"],
	upit: ["upit", "upita", "upita"],
	pozivAlata: ["poziv alata", "poziva alata", "poziva alata"],
	zakljucivanje: ["zaključivanje", "zaključivanja", "zaključivanja"],
	dogadjaj: ["Mozaik događaj", "Mozaik događaja", "Mozaik događaja"],
	presretanje: ["presretanje", "presretanja", "presretanja"],
	oznaka: ["oznaka", "oznake", "oznaka"],
	veza: ["veza", "veze", "veza"],
	sekunda: ["sekunda", "sekunde", "sekundi"],
	blokiranaTvrdnja: ["blokirana tvrdnja", "blokirane tvrdnje", "blokiranih tvrdnji"],
	uzastopniVd: ["uzastopni v.d.", "uzastopna v.d.", "uzastopnih v.d."],
	zvanicniNalaz: ["zvaničan nalaz", "zvanična nalaza", "zvaničnih nalaza"],
	driMisljenje: ["DRI mišljenje sa rezervom ili negativno", "DRI mišljenja sa rezervom ili negativna", "DRI mišljenja sa rezervom ili negativnih"],
	izvestajORevizijama: ["izveštaj o reviziji", "izveštaja o reviziji", "izveštaja o reviziji"],
} as const satisfies Record<string, Forms>

/** "1 ugovor, 3 ugovora, 7 ugovora" in one call: n(3, "ugovor"). */
export function n(num: number, key: keyof typeof FORMS, shown?: string): string {
	return count(num, FORMS[key], shown)
}
