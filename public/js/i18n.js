// UI language (SR default, EN optional). One dictionary: the key is the Serbian text, the value its English version.
// Data content (findings, agent names, server messages) is not translated. Missing keys fall back to the Serbian key.

const STORAGE_KEY = "dosije.lang"
let lang = "sr"
try {
	if (localStorage.getItem(STORAGE_KEY) === "en") lang = "en"
} catch {}

const listeners = new Set()

export const getLang = () => lang

export function onLang(fn) {
	listeners.add(fn)
	return () => listeners.delete(fn)
}

/** Translate a Serbian key; {name} placeholders are filled from vars. */
export function t(key, vars) {
	let s = lang === "en" ? EN[key] ?? key : key
	if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m))
	return s
}

/** Plural form: sr = [one, few, many] (Serbian rules), en = [one, other]. */
export function pl(n, sr, en) {
	if (lang === "en") return (en || sr)[n === 1 ? 0 : 1] ?? ""
	const a = n % 10
	const b = n % 100
	if (a === 1 && b !== 11) return sr[0]
	if (a >= 2 && a <= 4 && !(b >= 12 && b <= 14)) return sr[1]
	return sr[2]
}

/** Translate the static markup: [data-i18n] (text) and [data-i18n-attr="placeholder aria-label title"] (attributes). */
export function applyStatic(root = document) {
	for (const el of root.querySelectorAll("[data-i18n]")) {
		if (el.dataset.sr === undefined) el.dataset.sr = el.textContent.trim()
		el.textContent = t(el.dataset.sr)
	}
	for (const el of root.querySelectorAll("[data-i18n-attr]")) {
		for (const attr of el.dataset.i18nAttr.split(/\s+/).filter(Boolean)) {
			const store = `sr${attr.replace(/(^|-)(\w)/g, (m, d, c) => c.toUpperCase())}`
			if (el.dataset[store] === undefined) el.dataset[store] = el.getAttribute(attr) || ""
			el.setAttribute(attr, t(el.dataset[store]))
		}
	}
}

export function setLang(next) {
	const v = next === "en" ? "en" : "sr"
	if (v === lang) return
	lang = v
	try {
		localStorage.setItem(STORAGE_KEY, v)
	} catch {}
	reflect()
	for (const fn of listeners) {
		try {
			fn(v)
		} catch (e) {
			console.error("[i18n]", e)
		}
	}
}

function reflect() {
	document.documentElement.lang = lang
	applyStatic()
	for (const b of document.querySelectorAll(".lang-btn")) b.setAttribute("aria-pressed", String(b.dataset.lang === lang))
	document.title = `Dosije · ${t("istraživački tim agenata")}`
}

const EN = {
	// redesigned start screen, run bar, decisions and the done card
	"Preskoči na sadržaj": "Skip to content",
	"Dosije: početna": "Dosije: home",
	"Tok istrage": "Investigation flow",
	"Od vesti do proverenog dosijea za nekoliko minuta": "From a news story to a verified dossier in minutes",
	"Upiši javnu instituciju ili nalepi link vesti. Tim agenata istovremeno pretražuje javne registre, a ti odlučuješ o osetljivim nalazima. Svaka tvrdnja u dosijeu ima izvor, datum i status.":
		"Enter a public institution or paste a news link. A team of agents searches the public registers at the same time, and you decide on the sensitive findings. Every claim in the dossier has a source, a date and a status.",
	"Institucija ili link vesti, npr. Srbijavoz": "Institution or news link, e.g. Srbijavoz",
	"Pokreni istragu": "Start the investigation",
	"+ Dodaj fokus istrage (opciono)": "+ Add an investigation focus (optional)",
	"Fokus, npr. javne nabavke 2024. ili imenovanje direktora": "Focus, e.g. 2024 procurement or the director's appointment",
	"Ili probaj primer": "Or try an example",
	"najbolji demo": "best demo",
	"Državno preduzeće · železnička infrastruktura": "State company · railway infrastructure",
	"Državno preduzeće · putnički prevoz": "State company · passenger rail",
	"Zdravstvena ustanova": "Health institution",
	"Lokalna samouprava": "Local government",
	"Vrati se na dosije": "Back to the dossier",
	"Upišeš instituciju": "You enter an institution",
	"Naziv ili link vesti. Sistem pronalazi instituciju u registrima (PIB, matični broj, ACAS).": "A name or a news link. The system finds the institution in the registers (tax ID, company number, ACAS).",
	"Tim agenata radi istovremeno": "A team of agents works at the same time",
	"Kadrovik, Nabavke, Revizor i Mediji kreću u istom trenutku. Za svaku firmu i osobu koju nađu pokreće se novi agent.":
		"Kadrovik, Nabavke, Revizor and Mediji start at the same moment. Every company and person they find gets a new agent.",
	"Ti odlučuješ": "You decide",
	"Kad agent naiđe na osetljiv signal ili ne može sam do podatka, pita tebe. Čeka samo on, ostali nastavljaju.":
		"When an agent hits a sensitive signal or cannot reach a fact on its own, it asks you. Only that agent waits; the others carry on.",
	"Dobijaš dosije sa izvorima": "You get a sourced dossier",
	"Glavni signali, link za svaku tvrdnju i lista šta još treba proveriti. Izvoz u PDF ili Markdown.": "The main signals, a link for every claim and a list of what still needs checking. Export to PDF or Markdown.",
	"Javni izvori koje agenti pretražuju": "Public sources the agents search",
	"funkcioneri i imovina": "officials and assets",
	"Portal javnih nabavki": "Public procurement portal",
	"privredni registar": "business register",
	"revizorski izveštaji": "audit reports",
	"Službeni glasnik": "Official Gazette",
	"Imaš više institucija?": "Several institutions?",
	"Mapa prioriteta ih proverava paralelno, po jedan agent za svaku, i rangira gde prvo gledati.": "The priority map checks them in parallel, one agent each, and ranks where to look first.",
	"Otvori mapu prioriteta": "Open the priority map",
	"Agenti završavaju trenutni korak i urednik piše izveštaj": "The agents finish their current step and the editor writes the report",
	"Čeka samo agent koji pita. Ostali nastavljaju.": "Only the asking agent waits. The others carry on.",
	"+ Dodaj trag": "+ Add a lead",
	"Tim agenata": "Agent team",
	"pretražuje izvor": "searching a source",
	"novi agent": "new agent",
	"Pitanja agenata, tvoje odluke i tragovi koje dodaješ timu.": "The agents' questions, your decisions and the leads you add to the team.",
	"Čeka tvoju odluku": "Waiting for your decision",
	"Kad agent ne može sam da dođe do podatka (na primer vlasnik firme iza reCAPTCHA) ili naiđe na osetljiv signal, pitanje se pojavljuje na vrhu dosijea i ovde.":
		"When an agent cannot reach a fact on its own (for example a company owner behind reCAPTCHA) or hits a sensitive signal, the question appears at the top of the dossier and here.",
	"Istorija odluka": "Decision history",
	"traži odobrenje": "asks for approval",
	"ima pitanje": "has a question",
	"{agent} je pauziran dok ne odlučiš": "{agent} is paused until you decide",
	"{agent} traži tvoje odobrenje": "{agent} asks for your approval",
	"Ctrl+Enter šalje": "Ctrl+Enter sends",
	odluči: "decide",
	"Tim istražuje": "Team investigating",
	Istraga: "Investigation",
	"Tvoje odluke": "Your decisions",
	"nije bilo pitanja": "no questions",
	"kad agent pita": "when an agent asks",
	"otvori izveštaj": "open the report",
	"urednik piše izveštaj": "the editor writes the report",
	"posle istrage": "after the investigation",
	"Trijaža institucija": "Institution triage",
	"Rang lista": "Ranking",
	"gde prvo gledati": "where to look first",
	"posle trijaže": "after triage",
	"sa v.d. preko roka": "with an acting head past the limit",
	// top bar, hero
	"Preskoči na dosije": "Skip to dossier",
	"istraživački tim agenata": "investigative agent team",
	"Institucija ili link vesti": "Institution or news link",
	"Fokus (opciono)": "Focus (optional)",
	"Fokus istrage (opciono)": "Investigation focus (optional)",
	"Napravi dosije": "Create dossier",
	"Pokrećem…": "Starting…",
	"Glavni meni": "Main menu",
	"Mapa prioriteta": "Priority map",
	"Lista institucija prolazi kroz isti tim agenata paralelno: gde prvo gledati": "A list of institutions goes through the same agent team in parallel: where to look first",
	"Sanduče": "Inbox",
	"Istraživački alat za novinare": "Research tool for journalists",
	"Od vesti do dosijea o instituciji": "From a news story to a dossier on an institution",
	"Upiši naziv javne institucije ili nalepi link vesti. Tim agenata istovremeno proverava registar funkcionera, javne nabavke, izveštaje Državne revizorske institucije i medije. Svaka tvrdnja ima izvor, datum i status. Ti si deo tima: odgovaraš na pitanja i odobravaš osetljive signale.":
		"Enter the name of a public institution or paste a news link. A team of agents checks the officials’ register, public procurement, State Audit Institution reports and the media at the same time. Every claim has a source, a date and a status. You are part of the team: you answer questions and approve sensitive signals.",
	"Primer": "Example",
	"Kako radi": "How it works",
	"Upiši instituciju ili link. Agenti kreću u istom trenutku, svaki sa svojim izvorima.": "Enter an institution or a link. The agents start at the same moment, each with its own sources.",
	"Na vremenskoj osi i u listi „Pretraga uživo“ vidiš šta svaki agent trenutno radi.": "On the timeline and in the “Live search” list you see what each agent is doing right now.",
	"Odlučuješ ti: odobrenje pauzira samo jednog agenta, ostali nastavljaju.": "You decide: an approval pauses only one agent, the others carry on.",
	"Sistem ne presuđuje: pokazuje signale za proveru, a odluka ostaje na čoveku.": "The system does not pass judgement: it shows signals to verify, and the decision stays with a human.",
	"veza prekinuta, povezujem…": "connection lost, reconnecting…",
	"povezujem…": "connecting…",
	"Veza sa serverom (SSE)": "Connection to the server (SSE)",
	"bez ključa": "no key",
	"keš": "cache",
	"uživo": "live",
	"auto": "auto",
	"Radnici": "Workers",
	"urednik": "editor",
	"podaci": "data",
	"pretraga vesti": "news search",
	"Nije podešen API ključ: agenti rade po skripti, ali sa istim alatima, kapijom i događajima": "No API key set: the agents follow a script, but with the same tools, gate and events",
	// status line
	"U toku": "Running",
	"Završava se": "Finishing",
	"Završeno": "Done",
	"Spremno": "Ready",
	"{done}/{n} institucija gotovo": "{done}/{n} institutions done",
	"{n} sa v.d. preko roka": "{n} with acting head past the limit",
	"petlje": "loops",
	"alati": "tools",
	"firme": "companies",
	"osobe": "people",
	// team column
	"Tim": "Team",
	"razmišlja": "thinking",
	"alat": "tool",
	"čeka tebe": "waiting for you",
	"nalaz": "finding",
	"pokrenut agent": "spawned agent",
	"Vremenska osa agenata": "Agent timeline",
	"Novi agenti se pokreću kad se pojavi nova firma ili osoba.": "New agents start when a new company or person appears.",
	"u timu": "on the team",
	"gotovo": "done",
	"blokirano": "blocked",
	"radi": "working",
	"greška": "error",
	"čeka": "waiting",
	"pokrenuo: {ev} · {by}": "spawned by {ev} · {by}",
	"reaguje na nalaz": "reacting to finding",
	"{agent} čeka tvoju odluku": "{agent} is waiting for your decision",
	"Ostali agenti nastavljaju.": "The others keep working.",
	"Odluči u sandučetu": "Decide in inbox",
	"Trijaža": "Triage",
	"Firme": "Companies",
	"Imovina": "Assets",
	"Mediji · osobe": "Media · people",
	"Provera": "Check",
	"istovremeno aktivnih: {n} (vrhunac {peak})": "active at the same time: {n} (peak {peak})",
	"sada": "now",
	"kraj": "end",
	// timeline tooltips
	"Odobrenje": "Approval",
	"Pitanje": "Question",
	"čeka odgovor": "waiting for an answer",
	"odgovoreno": "answered",
	"Razmišlja": "Thinking",
	"Alat": "Tool",
	"Čeka odluku novinara": "Waiting for the journalist’s decision",
	"u toku": "in progress",
	"Nalaz": "Finding",
	"Pokrenut agent": "Spawned agent",
	"Blokiran nalaz": "Blocked finding",
	"Urednik": "Editor",
	"Novinar": "Journalist",
	// live search
	"Pretraga uživo": "Live search",
	"pretraga": "search",
	"preuzimanje": "download",
	"dokument": "document",
	"prekinuto": "interrupted",
	"zahtev nije završen pre kraja dosijea": "the request did not finish before the dossier ended",
	"iz keša, preuzeto": "from cache, fetched",
	"iz keša": "from cache",
	"samo": "only",
	"prikaži sve": "show all",
	"Nema upita za izabranog agenta.": "No requests for the selected agent.",
	"Čekam prve upite agenata prema javnim izvorima.": "Waiting for the agents’ first requests to public sources.",
	"Upiti prema javnim izvorima pojaviće se ovde dok agenti rade.": "Requests to public sources will appear here while the agents work.",
	// dossier
	"Dosije": "Dossier",
	"Novi dosije": "New dossier",
	"Vraća prazan ekran; server zadržava dosije": "Returns to the empty screen; the server keeps the dossier",
	"Završi sada": "Finish now",
	"Izveštaj": "Report",
	"Glavni signali": "Main signals",
	"Osobe i firme": "People and companies",
	"Signali su polazna tačka za proveru, ne zaključak. Svaka tvrdnja ima izvor; konačnu odluku donosi novinar.": "Signals are a starting point for verification, not a conclusion. Every claim has a source; the final decision is the journalist’s.",
	"čeka odobrenje novinara": "waiting for the journalist’s approval",
	"odobrio novinar": "approved by the journalist",
	"odbio novinar": "rejected by the journalist",
	"signal": "signal",
	"pažnja": "attention",
	"Napomena urednika": "Editor’s note",
	"dodao {a}": "added by {a}",
	"spojeno iz {n} nalaza": "merged from {n} findings",
	"izvor": "source",
	"Zvanični registar ({src})": "Official register ({src})",
	"ovaj izvor": "this source",
	"drugi izvor": "the other source",
	"Neslaganje izvora": "Sources disagree",
	"{first} navodi „{a}“; {second} navodi „{b}“.": "{first} states “{a}”; {second} states “{b}”.",
	"Prednost ima zvanični registar.": "The official register takes precedence.",
	"Prednost ima nalaz sa više izvora.": "The finding with more sources takes precedence.",
	"Prednost ima noviji podatak.": "The newer data takes precedence.",
	"završava se": "finishing",
	"završeno": "done",
	"Učitavam instituciju…": "Loading institution…",
	"Fokus": "Focus",
	"Upit": "Query",
	"Integrity Watch Srbija: {n} dobavljača označeno ({list})": "Integrity Watch Serbia: {n} suppliers flagged ({list})",
	"{label}: {n} nalaza ({list})": "{label}: {n} findings ({list})",
	"manje": "less",
	"više": "more",
	"Nema aktivnog dosijea.": "No active dossier.",
	"Agenti traže prve signale za proveru…": "The agents are looking for the first signals to verify…",
	"klik filtrira nalaze": "click to filter findings",
	"firma": "company",
	"osoba": "person",
	"Sve": "All",
	"Šta još proveriti": "Still to verify",
	"Agent": "Agent",
	"Filter": "Filter",
	"ukloni sve": "clear all",
	"Nema nalaza za izabrani filter.": "No findings for the selected filter.",
	"Nalazi će se pojaviti ovde čim ih agenti dodaju, svaki sa izvorom i statusom.": "Findings will appear here as soon as the agents add them, each with a source and a status.",
	"Otvorena pitanja za tebe": "Open questions for you",
	"odobrenje": "approval",
	"pitanje": "question",
	"otvori": "open",
	"prikaži": "show",
	"Nema otvorenih pitanja.": "No open questions.",
	"Nepotvrđeni nalazi": "Unconfirmed findings",
	"nepotvrđeno": "unconfirmed",
	"Svi nalazi imaju potvrdu ili zvaničan izvor.": "All findings are confirmed or have an official source.",
	"Preporuka urednika: šta još proveriti": "Editor’s recommendation: what still needs verifying",
	"Nema dodatnih preporuka.": "No further recommendations.",
	"Dosije nije završen.": "The dossier was not finished.",
	"Dosije nije pokrenut.": "The dossier was not started.",
	"Završi dosije pa pokreni novi": "Finish the dossier, then start a new one",
	"Završavam dosije…": "Finishing the dossier…",
	"Dosije se još završava. Pokušaj ponovo za nekoliko sekundi.": "The dossier is still finishing. Try again in a few seconds.",
	// labels
	"Rukovodstvo": "Leadership",
	"Novac": "Money",
	"Revizija": "Audit",
	"Mediji": "Media",
	"Zvanično": "Official",
	"Potvrđeno": "Confirmed",
	"Nepotvrđeno": "Unconfirmed",
	"Odstupa od registra": "Differs from register",
	"v.d. preko roka": "acting head past the limit",
	"v.d. blizu roka": "acting head near the limit",
	"lanac v.d.": "chain of acting heads",
	"imenovanje nepoznato": "appointment unknown",
	"bez objave": "without publication",
	"koncentracija dobavljača": "supplier concentration",
	"ugovor veći od prihoda": "contract larger than revenue",
	"mlada firma": "young company",
	"malo zaposlenih": "few employees",
	"politička veza": "political link",
	"vlasnik je funkcioner": "owner is an official",
	"nalaz DRI": "DRI finding",
	"mišljenje DRI": "DRI opinion",
	"medijski navod": "media allegation",
	"imovina": "assets",
	"konflikt izvora": "source conflict",
	"Portal JN": "Procurement portal",
	"Vesti": "News",
	"Sl. glasnik": "Off. Gazette",
	"Zakon": "Law",
	"prednost zvaničnom izvoru": "official source takes precedence",
	"prednost nalazu sa više izvora": "finding with more sources takes precedence",
	"prednost novijem podatku": "newer data takes precedence",
	"institucija": "institution",
	"funkcioner": "official",
	"dobavljač": "supplier",
	"vlasnik": "owner",
	"pomenut": "mentioned",
	"zvanični izvor": "official source",
	"Izvori ({n})": "Sources ({n})",
	"prikaži manje": "show less",
	"prikaži još {n}": "show {n} more",
	// inbox
	"Ti si deo tima: agenti ti šalju pitanja i traže odobrenje.": "You are part of the team: agents send you questions and ask for approval.",
	"Zatvori": "Close",
	"Sanduče je prazno.": "The inbox is empty.",
	"Kad agent ne može sam da dođe do podatka (na primer vlasnik firme iza reCAPTCHA) ili naiđe na osetljiv signal, pojaviće se ovde.": "When an agent cannot get a piece of data on its own (for example a company owner behind a reCAPTCHA) or runs into a sensitive signal, it will show up here.",
	"Istorija": "History",
	"Dodaj trag": "Add a lead",
	"Znaš nešto što agenti ne znaju? Dodaj osobu ili firmu: odmah dobija svog agenta.": "Do you know something the agents don’t? Add a person or a company: it gets its own agent right away.",
	"Ime i prezime ili naziv firme": "Full name or company name",
	"Ime ili naziv": "Name",
	"Odgovor nije poslat.": "The answer was not sent.",
	"nacrt": "draft",
	"Urednik predlaže signal za izveštaj": "The editor proposes a signal for the report",
	"Urednik predlaže signal": "The editor proposes a signal",
	"Savet": "Hint",
	"Ubaci u izveštaj": "Add to report",
	"Odbaci": "Reject",
	"Upiši odgovor (na primer ime vlasnika)": "Type an answer (for example the owner’s name)",
	"Odgovor": "Answer",
	"Pošalji timu": "Send to the team",
	"Preskoči": "Skip",
	"odobreno": "approved",
	"odbijeno": "rejected",
	"isteklo": "expired",
	"Sanduče, {n} otvorenih zadataka": "Inbox, {n} open tasks",
	"Trag dodat: {name}. Tim ga već proverava.": "Lead added: {name}. The team is already checking it.",
	"Trag nije dodat.": "The lead was not added.",
	"{agent} čeka tvoje odobrenje": "{agent} is waiting for your approval",
	"{agent} ima pitanje za tebe": "{agent} has a question for you",
	"Odluči": "Decide",
	"Odgovori": "Answer",
	// report
	"Kopiraj": "Copy",
	"Kopirano": "Copied",
	"Preuzmi .md": "Download .md",
	"Štampaj / PDF": "Print / PDF",
	"Izveštaj još nije spreman": "The report is not ready yet",
	"Pojaviće se kad agenti završe dosije.": "It will appear when the agents finish the dossier.",
	"Dosije je spreman": "The dossier is ready",
	"Izveštaj generisan u {time}. Pregledaj signale i šta još treba proveriti.": "Report generated at {time}. Review the signals and what still needs verifying.",
	"Otvori izveštaj": "Open report",
	// map
	"Gde prvo gledati": "Where to look first",
	"← Nazad na dosije": "← Back to dossier",
	"Lista institucija prolazi kroz isti tim agenata istovremeno: po jedan agent „Trijaža“ za svaku instituciju proverava rukovodstvo (ACAS, v.d. i zakonski rok), javne nabavke i izveštaje DRI. Ocena je zbir fiksnih pravila, a ne mišljenje: pokazuje gde prvo gledati, ne ko je kriv.":
		"A list of institutions goes through the same agent team at once: one “Triage” agent per institution checks the leadership (ACAS, acting head and the legal limit), public procurement and DRI reports. The score is the sum of fixed rules, not an opinion: it shows where to look first, not who is to blame.",
	"Institucije (jedna po redu, najviše 8)": "Institutions (one per line, at most 8)",
	"Spisak institucija": "List of institutions",
	"Pokreni mapu": "Run the map",
	"Pokreni ponovo": "Run again",
	"Mapa radi…": "The map is running…",
	"izmeni listu": "edit the list",
	"vrati preset: transportni sektor": "restore preset: transport sector",
	"Rang lista institucija": "Institution ranking",
	"Institucija": "Institution",
	"Ocena": "Score",
	"Signali": "Signals",
	"Status": "Status",
	"Ocena sabira signale po fiksnim pravilima (v.d. preko roka, lanac v.d., postupci bez objave, Integrity Watch, DRI). To su signali za proveru, ne zaključak.": "The score adds up signals under fixed rules (acting head past the legal limit, chain of acting heads, procedures without publication, Integrity Watch, DRI). These are signals to verify, not a conclusion.",
	"v.d. {m}/{lim} mes.": "acting {m}/{lim} mo.",
	"lanac v.d. {m} mes.": "acting chain {m} mo.",
	"{n} sa rezervom": "{n} qualified",
	"Greška": "Error",
	"isti dobavljač: {name}": "same supplier: {name}",
	"trijaža nije uspela": "triage failed",
	"Nijedan signal nije prešao prag; ocena 0.": "No signal passed the threshold; score 0.",
	"Agent još proverava izvore…": "The agent is still checking sources…",
	"Sačekaj da se mapa završi": "Wait for the map to finish",
	"Pokreće pun dosije za ovu instituciju": "Starts a full dossier for this institution",
	"Otvori dosije": "Open dossier",
	"razrešeno kao": "resolved as",
	"agent proverava izvore": "agent is checking sources",
	"u redu": "queued",
	"Sakrij": "Hide",
	"Sakrij detalje": "Hide details",
	"Detalji": "Details",
	"Još nema mape. Pokreni je dugmetom iznad: institucije se pojavljuju ovde, a Trijaža agenti rade u koloni „Tim“.": "No map yet. Start it with the button above: institutions appear here, and the Triage agents work in the Team column.",
	"Završi dosije pa pokreni mapu": "Finish the dossier, then run the map",
	"Mapa nije pokrenuta.": "The map was not started.",
	// bottom drawer
	"Ispod haube: {n} Mozaik događaja": "Under the hood: {n} Mozaik events",
	"sakrij": "hide",
	"Filter po agentu": "Filter by agent",
	"Mozaik događaji": "Mozaik events",
	"pauzirano dok je miš iznad": "paused while the mouse is over it",
	"na kraj ↓": "to the end ↓",
	"Svi agenti": "All agents",
	"petlja": "loop",
	"izvori": "sources",
	"domen": "domain",
	"interception": "interception",
}

document.addEventListener("DOMContentLoaded", reflect)
if (document.readyState !== "loading") reflect()
