// The language of a run: chosen in the browser when the dossier or the comparison starts. The agents write in it, and the
// report, the summary, the comparison reasons and the server's messages follow it. Nothing is machine-translated.

export type Lang = "sr" | "en"

export const asLang = (v: unknown): Lang => (v === "en" ? "en" : "sr")

/** The server's messages are written in Serbian; these are their English versions (fixed sentences and patterns). */
const ERRORS_EN: [RegExp, string][] = [
	[/^Naziv „(.+)“ odgovara većem broju ustanova: (.+)\. Upišite pun naziv ustanove\.$/s, "The name “$1” matches several bodies: $2. Type the full name of the institution."],
	[/^Institucija „(.+)“ nije pronađena u ACAS, na Portalu javnih nabavki ni u APR\. Proverite naziv \(probajte i sa č, ć, š, ž, đ\)\.$/s, "The institution “$1” was not found in ACAS, the Public Procurement Portal or APR. Check the name (try it with č, ć, š, ž, đ too)."],
	[/^Izvori \(ACAS, Portal javnih nabavki\) nisu odgovorili; pokušajte ponovo za nekoliko minuta\.$/, "The sources (ACAS, Public Procurement Portal) did not respond; try again in a few minutes."],
	[/^Registri \(ACAS, Portal javnih nabavki\) ne odgovaraju na vreme\. Pokušajte ponovo za nekoliko minuta\.$/, "The registers (ACAS, Public Procurement Portal) are not answering in time. Try again in a few minutes."],
	[/^Upišite naziv institucije \(ključne reči\)\. Linkovi se ne prihvataju\.$/, "Type the name of an institution (keywords). Links are not accepted."],
	[/^Upišite naziv institucije\.$/, "Type the name of an institution."],
	[/^Poređenje institucija je u toku: sačekajte da se završi pre nego što pokrenete dosije\.$/, "An institution comparison is running: wait for it to finish before you start a dossier."],
	[/^Dosije je u toku: sačekajte da se završi \(ili ga zatvorite\) pre nego što pokrenete poređenje institucija\.$/, "A dossier is running: wait for it to finish (or close it) before you start an institution comparison."],
	[/^Poređenje institucija je već u toku\.$/, "An institution comparison is already running."],
	[/^Upišite bar jednu instituciju\.$/, "Type at least one institution."],
	[/^Najviše (\d+) institucija po poređenju\.$/, "At most $1 institutions per comparison."],
	[/^Spisak institucija mora biti niz naziva\.$/, "The list of institutions must be a list of names."],
	[/^Upišite odgovor ili kliknite „Preskočite“\.$/, "Type an answer or click “Skip”."],
	[/^Upišite ime ili naziv\.$/, "Type a name."],
	[/^Zahtev je prevelik\.$/, "The request is too large."],
	[/^Telo zahteva nije ispravan JSON\.$/, "The request body is not valid JSON."],
	[/^Nepoznata ruta\.$/, "Unknown route."],
	[/^Metod nije dozvoljen\.$/, "Method not allowed."],
	[/^Interna greška servera\.$/, "Internal server error."],
	[/^Server je pun: svih (\d+) mesta za istovremeno korišćenje je zauzeto\. Pokušajte ponovo za minut\.$/, "The server is full: all $1 places for simultaneous use are taken. Try again in a minute."],
	[/^Sesija je prekinuta\. Osvežite stranicu\.$/, "The session ended. Reload the page."],
	[/^Institucija nije pronađena\.$/, "Institution not found."],
	[/^Nijedan izvor nije odgovorio \(rukovodstvo, nabavke, revizija\)\.$/, "No source responded (leadership, procurement, audit)."],
	[/^Trijaža nije završena: agent je prekinuo rad pre nego što je proverio sve izvore\.$/, "Triage not finished: the agent stopped before it checked every source."],
	[/^Vreme za trijažu je isteklo\.$/, "The time for the triage ran out."],
	[/^Trijaža se nije pokrenula \(budžet petlji\)\.$/, "The triage did not start (loop budget)."],
	[/^Trijaža se nije pokrenula\.$/, "The triage did not start."],
]

/** A server message in the run's language (unknown messages stay as they are). */
export function messageIn(lang: Lang, message: string): string {
	if (lang !== "en") return message
	for (const [re, en] of ERRORS_EN) if (re.test(message)) return message.replace(re, en)
	return message
}
