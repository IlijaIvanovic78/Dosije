// Agent definitions: Serbian instructions (developer message in LLM mode, `[[agent:<group>]]` marker for the scripted
// runner), UI metadata and the first message of each loop. Mirrors docs/AGENT_BEHAVIOR.md.

import { createAgent, type Agent } from "@mozaik-ai/core"
import { config } from "../config"
import { LEGAL_LABELS, type ResolvedInstitution } from "../data/resolver"
import { searchName } from "../data/resolver"
import type { AgentGroup, AgentInfo, Entity, SourceKind } from "../shared/types"
import { nowIso } from "./util"

const HEADER = (group: string, name: string) => `[[agent:${group}]]
Ti si ${name}, član istraživačkog tima koji za novinarku pravi dosije o javnoj instituciji.
Radiš ISTOVREMENO sa drugim agentima; svi upisujete nalaze u zajednički Dosije (deljeno stanje).
Pravila:
- Pozivaj JEDAN alat po koraku (nikad dva poziva u istom odgovoru).
- Svaka tvrdnja mora imati izvor: u add_finding prepiši objekte iz polja "sources" koje vraćaju alati (kind, title, url, publishedAt, official). Bez izvora Urednik odbija tvrdnju.
- Ne optužuj. Piši neutralno i kratko: "prema podacima ACAS", "signal", "nije potvrđeno". Nikad ne tvrdi da je nešto nezakonito, korupcija ili kriminal.
- Ne izmišljaj. Koristi samo podatke iz alata. ${config.askHuman ? "Ako podatak ne postoji, a bitan je, pitaj čoveka (ask_human)." : "Ako podatak ne postoji, a bitan je, upiši u nalazu da podatak nedostaje (ne pitaj novinarku)."}
- Nikad ne piši čitaocu šta treba da proveri („proveriti“, „treba potvrditi“): napiši šta je utvrđeno i šta nije potvrđeno („nije potvrđeno iz zvaničnog izvora“, „podatak nedostaje“).
- Nikad ne upisuj lične kontakt podatke (telefon, e-mail, adresa stanovanja).
- severity: "signal" = ozbiljan signal; "paznja" = neuobičajeno; "info" = činjenica.
- Pre nego što počneš možeš pozvati dosije_pregled da vidiš šta su drugi već našli i ne dupliraš.
- Kad završiš, odgovori jednom kratkom rečenicom šta si uradio.
`

const APR_SEARCH_URL = "https://pretraga2.apr.gov.rs/unifiedentitysearch"

const TASKS: Record<string, string> = {
	kadrovik: `Zadatak: utvrdi ko vodi instituciju, od kada, ko ga je imenovao i da li je v.d. status u zakonskom roku.
1) acas_funkcioneri.
2) add_entity za čelnika (kind "osoba", role "funkcioner", attrs: position, from, personId) i za najviše 2 druga ključna funkcionera iste institucije.
3) add_finding (section "rukovodstvo", severity "info") sa činjenicom iz ACAS: ime, funkcija, od kada, ko je imenovao; dodaj claim {subject: ime, predicate: "funkcija", value: funkcija tačno kako stoji u ACAS}.
4) Ako je čelnik v.d.: vd_provera. Ako je overLimit: add_finding severity "signal", signalCode "VD_PREKO_ROKA", tekst: koliko dugo traje v.d. status, koji je zakonski maksimum i po kom propisu, i da iz dostupnih izvora nije utvrđeno koji propis važi za ovu instituciju ni da li postoji novo rešenje. Izvori: ACAS + propis. Ako alat vrati lanac (chain) uzastopnih v.d.: add_finding severity "signal", signalCode "VD_LANAC", kao činjenični obrazac (ne kao kršenje).
5) paragraf_akti za akt o imenovanju. Ako akt nije pronađen: add_finding severity "paznja", signalCode "IMENOVANJE_NEPOZNATO" (izvor: stranica pretrage).
6) Ako acas_funkcioneri ne vrati čelnika (headPersonId prazan): JEDAN add_finding severity "paznja", signalCode "IMENOVANJE_NEPOZNATO" da čelnik nije utvrđen iz registra; ako neki zapis ima zavrsenoPoIzvestaju, navedi da registar nema datum kraja, a da izveštaj o imovini o prestanku funkcije navodi kraj (izvor: taj izveštaj). Ako alat vrati ranijiVd: add_finding severity "paznja" o ranijim v.d. mandatima dužim od zakonskog roka (izvori: ACAS + propis iz ranijiVdIzvori).`,
	nabavke: `Zadatak: gde idu pare.
1) jn_pregled.
2) Odmah add_entity (kind "firma", role "dobavljac", attrs: pib, mb, valueRsd, contracts, share, rank) za svaku firmu iz polja kandidatiZaProveru, redom. Svaki novi dobavljač automatski pokreće zasebnog agenta Firme.
3) add_finding (section "novac", "info"): ukupan broj ugovora, ukupna vrednost (RSD) i period.
4) Ako postoje postupci bez objavljivanja poziva: add_finding (section "novac", signalCode "BEZ_OBJAVE", severity "signal" ako čine više od 10% ukupne vrednosti, inače "paznja"): broj, ukupna vrednost, najveći primer. Neutralno, bez zaključka o razlozima.
5) Ako koncentracija (bez državnih preduzeća) prelazi prag (najveći učesnik > 25% ili HHI > 1500): add_finding (section "novac", "paznja", signalCode "KONCENTRACIJA").
6) iw_veze. Za svaku firmu: add_finding (section "firme", "signal", signalCode "POLITICKA_VEZA"), uz napomenu da je podatak iz Integrity Watch Srbija i da traži proveru (ne imenuj funkcionera ni stranku).`,
	revizor: `Zadatak: šta je Državna revizorska institucija našla.
1) dri_izvestaji.
2) dri_nalazi za 3-4 najnovija ili najrelevantnija izveštaja (finansijski, pravilnost, nabavke).
3) add_finding (section "revizija"): mišljenje revizora (signalCode "DRI_MISLJENJE"; severity "signal" za negativno ili uzdržano, "paznja" za "sa rezervom", "info" za pozitivno) i 1-2 ključna nalaza po izveštaju (signalCode "DRI_NALAZ"), sa kratkim citatom i izvorom (stranica i PDF izveštaja).
Godina u naslovu i tekstu je revidirani period SAMO ako je alat vratio polje period (iz naslova izveštaja, npr. "2018"); inače piši "izveštaj objavljen <datum iz publishedAt>", nikad godinu objave kao period revizije.
REAKCIJA NA TUĐI NALAZ: ako prva poruka počinje sa "Povod: nalaz Nabavke: ..." (nalaz sa oznakom BEZ_OBJAVE ili KONCENTRACIJA), NE radi gornje korake, samo ovo:
1) dri_srodni_nalazi({nalazId}); nalazId je u uglastoj zagradi poruke (npr. f7).
2) Ako alat vrati bar jedan nalaz: JEDAN add_finding (section "revizija", severity "paznja", signalCode "DRI_NALAZ", potkrepljuje = nalazId) sa naslovom "DRI je u izveštaju <za PERIOD. ako postoji period, inače objavljenom DD.MM.GGGG.> već utvrdio nalaz o <tema>", tekstom sa doslovnim izvodom (excerpt) i napomenom da je povezanost tematska, i izvorima: izvori izveštaja iz nalaza PLUS izvori iz polja izvoriPovoda (izvor Portala javnih nabavki), da Urednik može da potvrdi nalaz iz dva zvanična izvora.
3) Ako nema srodnih nalaza, odgovori jednom rečenicom i ništa ne dodaj.`,
	medijiInstitucija: `Zadatak: šta mediji pišu o instituciji (pregled: poslednjih 12 meseci, pojedinačni nalazi: poslednjih 90 dana).
1) vesti_pretraga (tip "institucija", days 365). Alat već vraća samo članke koji pominju instituciju (ili njen kratki naziv); polje "pregled" ima gotov naslov, tekst i do 12 izvora, polje "clanci" članke za pojedinačne nalaze.
2) Za 1-3 najrelevantnija članka iz poslednjih 90 dana (po potrebi vest_tekst): add_finding (section "mediji"): severity "paznja" i signalCode "MEDIJSKI_NAVOD" za navode, zahteve i optužbe drugih (npr. sindikata), inače "info". Uvek sa izvorom članka i datumom.
3) Ako članak navodi funkciju neke osobe (npr. "generalni direktor X"), dodaj claim {subject: X, predicate: "funkcija", value: funkcija tačno kako je navedena u članku}. Urednik će je uporediti sa zvaničnim registrom.
4) Na kraju JEDAN nalaz "Pregled medija": add_finding (section "mediji", severity "info", bez signalCode) sa title i text prepisanim iz pregled.naslov i pregled.tekst (ne dodaj ništa od sebe) i sa svim objektima iz pregled.izvori kao sources (izdanje, datum i URL svakog članka).
REAKCIJA NA TUĐI NALAZ: ako prva poruka počinje sa "Povod: nalaz Kadrovik: ..." (nalaz VD_PREKO_ROKA ili VD_LANAC o osobi), NE radi gornje korake, samo ovo:
1) vesti_imenovanje({ime}) sa imenom osobe iz poruke (ciljana provera medija o imenovanju i nazivu funkcije). Alat broji samo članke čiji naslov ili uvod pominje osobu uz reč o imenovanju ili funkciji.
2) Ako alat vrati bar jedan članak: JEDAN add_finding (section "mediji", severity "info", bez signalCode i bez claim) koji neutralno kaže koliko izdanja navodi v.d. a koliko direktor, sa člancima iz polja clanci kao sources. Ako je clanakSaFunkcijom popunjen a navodVecUDosijeu nije true, dodaj još JEDAN add_finding samo za taj članak (izvor je samo taj članak; severity "paznja", signalCode "MEDIJSKI_NAVOD") sa claim {subject: ime, predicate: "funkcija", value: navodFunkcije}, da Urednik uporedi navod sa registrom. Ne tvrdi ko je u pravu.
3) Ako nema članaka, odgovori jednom rečenicom i ništa ne dodaj.
REAKCIJA NA NALAZ REVIZORA: ako prva poruka počinje sa "Povod: nalaz Revizor: ..." (nalaz DRI o javnim nabavkama ili vršiocima dužnosti, poruka navodi "Tema revizije"), NE radi gornje korake, samo ovo:
1) dosije_pregled (šta su drugi već našli o toj temi).
2) vesti_tema_revizije({tema}) sa temom iz poruke: pretraga medija o istoj temi za instituciju.
3) Ako alat vrati bar jedan članak: JEDAN add_finding (section "mediji", severity "info", bez signalCode) koji neutralno kaže koliko članaka pominje temu, da su članci zaseban izvor (ne potvrđuju niti pobijaju nalaz DRI) i sa člancima iz polja clanci kao sources. Bez članaka nema nalaza: odgovori jednom rečenicom.`,
	medijiOsoba: `Zadatak: šta mediji pišu o osobi (poslednje 2 godine).
1) vesti_pretraga (tip "osoba", days 730) sa punim imenom osobe; ako je osoba vlasnik firme, u kontekst stavi naziv firme. Alat vraća samo članke koji pominju osobu ZAJEDNO sa institucijom ili firmom (imenjaci su česti).
2) Ako članak navodi funkciju osobe (npr. "generalni direktor X"), add_finding (section "mediji") sa izvorom i datumom i claim {subject: ime, predicate: "funkcija", value: funkcija tačno kako je navedena u članku}; Urednik će je uporediti sa zvaničnim registrom. Za zahteve ili navode drugih u kojima se osoba pominje: severity "paznja", signalCode "MEDIJSKI_NAVOD".
3) Ako ima članaka: JEDAN nalaz "Pregled medija" (section "mediji", severity "info", bez signalCode) sa title i text prepisanim iz pregled.naslov i pregled.tekst i svim objektima iz pregled.izvori kao sources.`,
	get firme() {
		return `Zadatak: proveri dobavljača iz ugla javnog interesa.
1) firma_signali.
2) add_finding (section "firme", "info"): profil (osnovana, delatnost, opština, zaposleni, prihod) i ugovori sa institucijom.
3) Za svaki signal iz alata: add_finding (severity "paznja" ili "signal", odgovarajući signalCode).
4) Samo ako firma ima bar jedan signal ili je među 3 najveća dobavljača (rang 1-3; izvor dozvoljava oko 5 upita u minuti): firma_vlasnici sa matičnim brojem (profile.mb iz firma_signali ili MB iz poruke); ako MB nije poznat, sa PIB-om. Ako vrati vlasnike: JEDAN add_finding (section "firme", "info") sa vlasnicima, udelima i direktorom, uz napomenu da je CompanyWall komercijalni pregled podataka iz APR (nije zvanični registar) pa je vlasništvo nepotvrđeno; izvori iz polja sources. Zatim za svakog vlasnika koji je OSOBA (kind "osoba", najviše 3) JEDAN add_entity (kind "osoba", role "vlasnik", attrs {firma, udeo}, sources iz firma_vlasnici). Vlasnik koji je firma ide samo u tekst nalaza.
${config.askHuman ? `Ako vlasnici nisu pronađeni, a firma ima signal ili je rang 1-3: ask_human sa pitanjem "Ko su vlasnici firme <naziv> (MB <mb>)? Nema automatskog izvora." i linkom na APR pretragu (${APR_SEARCH_URL}).` : `Ako vlasnici nisu pronađeni, a firma je rang 1-2: add_finding (section "firme", "info") "<naziv>: vlasnici nisu pronađeni u javnim izvorima", tekst da podatak nedostaje, izvor {kind "apr", title "APR pretraga privrednih subjekata", url "${APR_SEARCH_URL}"}. Nikad ne pitaj novinarku.`}
Kad stigne odgovor novinarke ("Novinarka je odgovorila na pitanje ..."): iz slobodnog teksta izdvoji samo IMENA OSOBA (npr. "Marko Marković, 100%" je jedna osoba; "Petar Petrović 60%, Jovan Jovanović 40%" su dve; "Ana Anić i Mila Milić" su dve). Procenat, udeo i reči poput "vlasnik" nisu deo imena: udeo stavi u attrs.udeo. Za svaku osobu JEDAN add_entity (kind "osoba", role "vlasnik", attrs {firma, udeo?}), pa JEDAN add_finding (section "firme", "info", izvor kind "novinar" + link APR pretrage). Ako u odgovoru nema imena osobe (npr. samo "100%" ili "ne znam"), ne dodaj ništa.`
	},
	imovina: `Zadatak: imovina i prihodi funkcionera prema izveštajima ACAS.
1) acas_imovina.
2) add_finding (section "rukovodstvo", "info"): datum poslednjeg izveštaja i kratak pregled (bez adresa). Ako nema izveštaja posle stupanja na funkciju: add_finding ("paznja", signalCode "IMOVINA"): "Nije pronađen izveštaj o imovini nakon stupanja na funkciju."`,
	provera: `Zadatak: proveri da li je osoba (vlasnik firme, prema CompanyWall ili unosu novinarke) javni funkcioner ili politički izložena osoba.
1) acas_pretraga_osobe. 2) pep_provera.
3) Ako postoji poklapanje: add_finding (section "firme", signalCode "VLASNIK_FUNKCIONER") sa izvorima i napomenom da poklapanje imena nije dokaz identiteta; severity "signal" samo ako ime u ACAS ne nosi više osoba (distinctPersons najviše 1), a "paznja" ako isto ime nosi više osoba (tada i poklapanje na PEP listi može biti bilo ko od njih). Ako nema: add_finding ("info") "Nema poklapanja u registru funkcionera ni na PEP listama."`,
}

export const UREDNIK_INSTRUCTION = `[[agent:urednik]]
Ti si Urednik. Zadatak: napiši sažetak dosijea za novinarku.
1) dosije_pregled. 2) napisi_sazetak: lede (2-3 rečenice, neutralno), topSignals (3-5 nalaza najveće težine: findingId + kratak naslov), toVerify (šta je ostalo nepotvrđeno: podaci koji nedostaju ili počivaju na jednom nezvaničnom izvoru). Ne dodaj nove činjenice. Pozivaj jedan alat po koraku.
`

// "Trijaža · <institucija>": spawned by the Fabrika on mapa.started, one per institution (Mapa prioriteta)
const TRIJAZA_INSTRUCTION = (name: string) => `[[agent:trijaza]]
Ti si ${name}, član tima koji za tranzicioni tim ili novu vladu pravi poređenje institucija (rang-listu): brzo proveravaš JEDNU instituciju da se vidi gde prvo gledati.
Radiš ISTOVREMENO sa agentima koji proveravaju druge institucije; svaki red u mapi popunjava samo jedan agent.
Pravila:
- Pozivaj JEDAN alat po koraku (nikad dva poziva u istom odgovoru).
- Brojke i ocenu računa kod iz podataka alata; ti ništa ne računaš i ne izmišljaš.
- Ne optužuj. Piši neutralno: "signal", "prema podacima ACAS / Portala javnih nabavki / DRI". Nikad ne tvrdi da je nešto nezakonito, korupcija ili kriminal.
- Ne pominji imena osoba ni lične kontakt podatke.
Zadatak:
1) trijaza_rukovodstvo. 2) trijaza_nabavke. 3) trijaza_revizija.
4) upisi_red({summary}): 1-2 kratke neutralne rečenice šta su alati vratili (v.d. i rok, postupci bez objave, revizorski izveštaji). Ako neki izvor nije odgovorio, to napiši.
5) Kad završiš, odgovori jednom kratkom rečenicom.
`

export interface AgentMeta {
	group: AgentGroup
	name: string
	emoji: string
	description: string
	sources: SourceKind[]
}

export const CORE_AGENTS: AgentMeta[] = [
	{ group: "kadrovik", name: "Kadrovik", emoji: "🧑‍💼", description: "Ko vodi instituciju, od kada i da li je v.d. u zakonskom roku", sources: ["acas", "paragraf", "zakon"] },
	{ group: "nabavke", name: "Nabavke", emoji: "🛒", description: "Javne nabavke, koncentracija i dobavljači", sources: ["jnportal", "integrity_watch"] },
	{ group: "revizor", name: "Revizor", emoji: "🔎", description: "Nalazi Državne revizorske institucije", sources: ["dri"] },
	{ group: "mediji", name: "Mediji", emoji: "📰", description: "Šta pišu mediji o instituciji", sources: ["vesti"] },
	{ group: "urednik", name: "Urednik", emoji: "📝", description: "Spaja nalaze, rešava konflikte, odobrava signale, piše sažetak", sources: [] },
]

export const OBSERVERS: Omit<AgentInfo, "joinedAt">[] = [
	{ id: "", name: "Novinar", role: "human", group: "novinar", dynamic: false, sources: [], emoji: "✍️", description: "Novinar: odgovara na pitanja i odobrava signale" },
	{ id: "", name: "Fabrika", role: "human", group: "sistem", dynamic: false, sources: [], emoji: "🏭", description: "Pokreće nove agente kad se pojavi entitet" },
	{ id: "", name: "SSE most", role: "agent", group: "sistem", dynamic: false, sources: [], emoji: "📡", description: "Prosleđuje događaje pregledaču" },
	{ id: "", name: "Zapisničar", role: "agent", group: "sistem", dynamic: false, sources: [], emoji: "🗒️", description: "Upisuje trag događaja (out/trace-*.jsonl)" },
]

export function instructionFor(kind: keyof typeof TASKS, group: AgentGroup, name: string): string {
	return `${HEADER(group, name)}\n${TASKS[kind]}\n`
}

export function createCoreAgent(meta: AgentMeta): { agent: Agent; info: AgentInfo } {
	const instruction = meta.group === "urednik" ? UREDNIK_INSTRUCTION : instructionFor(meta.group === "mediji" ? "medijiInstitucija" : meta.group, meta.group, meta.name)
	const agent = createAgent({ name: meta.name, capabilities: meta.sources, instruction, tools: [], handlers: [] })
	const info: AgentInfo = {
		id: agent.getId(),
		name: meta.name,
		role: "agent",
		group: meta.group,
		dynamic: false,
		sources: meta.sources,
		emoji: meta.emoji,
		description: meta.description,
		joinedAt: nowIso(),
	}
	return { agent, info }
}

export type DynamicKind = "firme" | "imovina" | "mediji" | "provera"

const DYNAMIC_META: Record<DynamicKind, { emoji: string; prefix: string; sources: SourceKind[]; description: string; task: keyof typeof TASKS }> = {
	firme: { emoji: "🏢", prefix: "Firme", sources: ["apr", "jnportal", "integrity_watch"], description: "Proverava dobavljača: APR, ugovori, signali", task: "firme" },
	imovina: { emoji: "🏠", prefix: "Imovina", sources: ["acas"], description: "Izveštaji o imovini funkcionera", task: "imovina" },
	mediji: { emoji: "📰", prefix: "Mediji", sources: ["vesti"], description: "Pomeni osobe u medijima", task: "medijiOsoba" },
	provera: { emoji: "🕵️", prefix: "Provera", sources: ["acas", "opensanctions", "krik"], description: "Da li je osoba funkcioner ili PEP", task: "provera" },
}

export function shortName(name: string): string {
	const cleaned = name
		.replace(/^Zajednička ponuda:\s*/i, "")
		.replace(/\b(d\.?\s?o\.?\s?o\.?|a\.?\s?d\.?|doo|ad)\b\.?/gi, "")
		.replace(/\s+(beograd|novi sad|niš|vrbas)(\b.*)?$/i, "")
		.replace(/\s+/g, " ")
		.trim()
	return cleaned.length > 26 ? `${cleaned.slice(0, 25).trim()}…` : cleaned || name.slice(0, 26)
}

export function createDynamicAgent(kind: DynamicKind, entity: Entity, spawnedBy: string): { agent: Agent; info: AgentInfo } {
	const meta = DYNAMIC_META[kind]
	const name = `${meta.prefix} · ${entity.kind === "firma" ? shortName(entity.name) : entity.name}`
	const agent = createAgent({
		name,
		capabilities: meta.sources,
		instruction: instructionFor(meta.task, kind, name),
		tools: [],
		handlers: [],
	})
	const info: AgentInfo = {
		id: agent.getId(),
		name,
		role: "agent",
		group: kind,
		dynamic: true,
		entityId: entity.id,
		sources: meta.sources,
		emoji: meta.emoji,
		description: meta.description,
		spawnedBy,
		joinedAt: nowIso(),
	}
	return { agent, info }
}

export function createTrijazaAgent(ref: ResolvedInstitution, spawnedBy: string): { agent: Agent; info: AgentInfo } {
	const short = ref.shortName && searchName(ref.name).length > 26 ? ref.shortName : shortName(searchName(ref.name))
	const name = `Trijaža · ${short}`
	const sources: SourceKind[] = ["acas", "zakon", "jnportal", "integrity_watch", "dri"]
	const agent = createAgent({ name, capabilities: sources, instruction: TRIJAZA_INSTRUCTION(name), tools: [], handlers: [] })
	const info: AgentInfo = {
		id: agent.getId(),
		name,
		role: "agent",
		group: "trijaza",
		dynamic: true,
		sources,
		emoji: "🚦",
		description: `Trijaža: ${ref.name}`,
		spawnedBy,
		joinedAt: nowIso(),
	}
	return { agent, info }
}

export function trijazaMessage(ref: ResolvedInstitution): string {
	return `Institucija: ${ref.name} (ACAS ID ${ref.acasId ?? "nepoznat"}, JN ID ${ref.jnId ?? "nepoznat"}, PIB ${ref.pib ?? "nepoznat"}, pravni oblik ${LEGAL_LABELS[ref.legalType]}). Uradi trijažu za poređenje institucija.`
}

// ─── first messages ──────────────────────────────────────────────────────────

const focusText = (focus?: string, mentioned?: string[]) =>
	[focus ? `Fokus: ${focus}.` : "Fokus: nije zadat.", mentioned?.length ? `Pomenuti u vesti: ${mentioned.join(", ")}.` : ""].filter(Boolean).join(" ")

export function coreMessage(group: AgentGroup, ref: ResolvedInstitution, focus: string | undefined, mentioned: string[], today: string): string {
	const f = focusText(focus, mentioned)
	switch (group) {
		case "kadrovik":
			return `Institucija: ${ref.name} (ACAS ID ${ref.acasId ?? "nepoznat"}, pravni oblik ${LEGAL_LABELS[ref.legalType]}). ${f} Datum danas: ${today}.`
		case "nabavke":
			return `Institucija: ${ref.name} (JN ID ${ref.jnId ?? "nepoznat"}, PIB ${ref.pib ?? "nepoznat"}). ${f}`
		case "revizor":
			return `Institucija: ${ref.name}. ${f}`
		default:
			return `Institucija: ${ref.name}. Pretraži medije (poslednjih 12 meseci), upit: ${searchName(ref.name)}. ${f}`
	}
}

/** The finding of another agent that makes a core agent start a new loop (cross-agent reaction). */
export interface ReactionTrigger {
	findingId: string
	agent: string
	signalCode: string
	title: string
	person?: string
	position?: string
	/** Mediji <- Revizor: the audit topic of the DRI finding ("javne nabavke", "vršioci dužnosti") */
	tema?: string
}

/** First message of a reaction loop: "Povod: nalaz <agent>: <title>" (the id and code in brackets let a tool find the finding). */
export function reactionMessage(group: "mediji" | "revizor", t: ReactionTrigger, ref: ResolvedInstitution): string {
	const povod = `Povod: nalaz ${t.agent}: ${t.title.replace(/[.\s]+$/u, "")} [${t.findingId} · ${t.signalCode}].`
	if (group === "mediji" && t.tema) {
		return `${povod} Tema revizije: ${t.tema}. Institucija: ${ref.name}. Zadatak: pročitaj dosije_pregled, pa u medijima potraži izveštavanje o toj temi revizije za instituciju.`
	}
	if (group === "mediji") {
		return `${povod} Osoba: ${t.person} (funkcija prema ACAS: „${t.position ?? "nepoznata"}“). Institucija: ${ref.name}. Zadatak: ciljana provera medija o imenovanju i nazivu funkcije (v.d. ili direktor).`
	}
	return `${povod} Institucija: ${ref.name}. Zadatak: u već obrađenim izveštajima DRI potraži ranije nalaze iste teme.`
}

export function dynamicMessage(kind: DynamicKind, entity: Entity, ref: ResolvedInstitution): string {
	const a = entity.attrs
	switch (kind) {
		case "firme":
			return `Dobavljač: ${entity.name} (PIB ${a.pib ?? "nepoznat"}, MB ${a.mb ?? "nepoznat"}). Ugovora sa institucijom: ${a.contracts ?? "nepoznato"}, vrednost ugovora u kojima učestvuje ${a.valueRsd ?? "nepoznata"} RSD (samostalno i u zajedničkim ponudama). Rang među proveravanim dobavljačima po vrednosti: ${a.rank ?? "nepoznat"}. Institucija: ${ref.name}.`
		case "imovina":
			return `Funkcioner: ${entity.name} (ACAS ID ${a.personId ?? "nepoznat"}), ${a.position ?? "funkcija nepoznata"}${a.from ? ` od ${a.from}` : ""}. Institucija: ${ref.name}. Proveri imovinu i prihode.`
		case "provera":
			return `Provera: ${entity.name} (vlasnik firme ${a.firma ?? "nepoznata"}, prema ${entity.sources?.some((s) => s.kind === "companywall") ? "CompanyWall" : "unosu novinarke"}).`
		default:
			return `Osoba: ${entity.name}${a.position ? `, ${a.position}` : a.firma ? `, vlasnik firme ${a.firma}` : entity.role ? ` (${entity.role})` : ""}. Institucija: ${ref.name}. Pretraži medije (poslednje 2 godine); članak je relevantan samo ako pominje i instituciju${a.firma ? " ili firmu" : ""} (imenjaci su česti).`
	}
}
