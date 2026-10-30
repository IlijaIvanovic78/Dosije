// Scripted per-group policies (docs/AGENT_BEHAVIOR.md). A policy is an async generator: every `yield` is exactly ONE tool call (what
// an LLM would emit for one step) and receives that tool's output as the next input, so a policy only uses what an LLM
// would see in its context. The scripted runner turns each yield into a Mozaik FunctionCallItem.

import { formatRsd } from "../../data/analysis/procurement"
import { formatDate, isHeadPosition } from "../../data/analysis/vd"
import { asciiFold } from "../../data/translit"
import { n } from "../../shared/plural"
import { clauseHeadline } from "../../shared/text"
import { entityIdFor } from "../domain"
import { describeOwners, parseOwnerAnswer } from "../owners"
import { buildLede, leadHeads } from "../summary"
import { clip } from "../util"

export interface Step {
	tool: string
	args: Record<string, unknown>
}

export interface ToolResult {
	text: string
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	json: any
	blocked: boolean
}

export interface PolicyCtx {
	group: string
	message: string
}

export type Policy = (ctx: PolicyCtx) => AsyncGenerator<Step, string, ToolResult>

const call = (tool: string, args: Record<string, unknown> = {}): Step => ({ tool, args })
const APR_SEARCH = "https://pretraga2.apr.gov.rs/unifiedentitysearch"

type Src = Record<string, unknown>
const srcs = (list: unknown): Src[] => (Array.isArray(list) ? (list as Src[]) : [])
const money = (v: unknown) => (typeof v === "number" ? formatRsd(v) : "nepoznata vrednost")
/** Serbian number formats: 1.537 and 2,56. */
const num = (v: number) => v.toLocaleString("sr-RS")
const dec = (v: unknown) => String(v).replace(".", ",")
const isHeadTitle = isHeadPosition


// ─── a source that did not answer is a finding, never an empty section ───────────────────────────────────────────────

export const UNAVAILABLE_PREFIX = "Izvor nije odgovorio"

const SOURCE_PAGES: Record<string, { kind: string; title: string; url: string; section: string }> = {
	acas: { kind: "acas", title: "ACAS registar funkcionera", url: "https://publicacas.acas.rs/#/acas/funkcioner", section: "rukovodstvo" },
	jn: { kind: "jnportal", title: "Portal javnih nabavki", url: "https://jnportal.ujn.gov.rs/ugovori", section: "novac" },
	dri: { kind: "dri", title: "DRI: izveštaji o reviziji", url: "https://www.dri.rs/izvestaji", section: "revizija" },
	mediji: { kind: "vesti", title: "Pretraga vesti (RSS, Google News)", url: "https://news.google.com/", section: "mediji" },
}

/** A tool answered with an error: say so in the dossier (with the source page to check by hand) so the journalist is not shown a silent gap. */
async function* sourceGap(which: keyof typeof SOURCE_PAGES, what: string, failure: unknown): AsyncGenerator<Step, void, ToolResult> {
	const s = SOURCE_PAGES[which]
	const why = clip(String((failure as { error?: unknown } | undefined)?.error ?? "nema odgovora"), 140)
	yield call("add_finding", {
		section: s.section,
		title: `${UNAVAILABLE_PREFIX}: ${s.title}`,
		text: `${what} nije dobijeno: izvor trenutno ne odgovara (${why}). Ovo nije nalaz o instituciji, nego praznina u pretrazi: ponoviti pretragu ili ručno proveriti na stranici izvora.`,
		severity: "paznja",
		sources: [{ kind: s.kind, title: s.title, url: s.url }],
	})
}
// ─── Kadrovik ────────────────────────────────────────────────────────────────

async function* kadrovik(): AsyncGenerator<Step, string, ToolResult> {
	const off = (yield call("acas_funkcioneri")).json
	if (off?.ok === false) {
		yield* sourceGap("acas", "Spisak funkcionera", off)
		return "Kadrovik: ACAS nije odgovorio."
	}
	if (!off?.officials?.length) {
		yield call("add_finding", {
			section: "rukovodstvo",
			title: "U registru ACAS nema funkcionera za ovu instituciju",
			text: "Pretraga registra funkcionera ACAS nije vratila nijednog funkcionera za ovu instituciju. To ne znači da čelnika nema: registar sadrži samo funkcionere koji su podneli prijavu, a institucija može biti upisana pod drugim nazivom. Proveriti ručno u registru.",
			severity: "paznja",
			signalCode: "IMENOVANJE_NEPOZNATO",
			sources: [{ kind: "acas", title: "ACAS registar funkcionera", url: "https://publicacas.acas.rs/#/acas/funkcioner" }],
		})
		return "ACAS nije vratio funkcionere za ovu instituciju."
	}
	type O = { personId: string; name: string; position: string; acting: boolean; from?: string; to?: string; current: boolean; appointedBy?: string }
	const officials = off.officials as O[]
	const acas = srcs(off.sources)
	const current = officials.filter((o) => o.current)
	// the tool names the head (deterministic pickHead: rank, then latest start); a board chair is never taken for the head
	const head = current.find((o) => o.personId === off.headPersonId && isHeadTitle(o.position)) ?? (off.headPersonId ? undefined : current.find((o) => isHeadTitle(o.position)))
	const others = current.filter((o) => o !== head && o.personId !== head?.personId).slice(0, 2)
	const people = [head, ...others].filter((o): o is O => !!o)

	for (const p of people) {
		yield call("add_entity", {
			kind: "osoba",
			name: p.name,
			role: "funkcioner",
			attrs: { position: p.position, from: p.from ?? null, personId: p.personId },
			sources: acas.map((s) => ({ ...s, publishedAt: p.from })),
		})
	}
	if (!head) {
		yield call("add_finding", {
			section: "rukovodstvo",
			title: "Čelnik institucije nije pronađen u registru ACAS",
			text: `U registru ACAS (${n(off.count, "zapis")}) nema funkcionera sa funkcijom direktora, predsednika ili ministra koji je trenutno na funkciji${people.length ? `; u registru su tekući: ${people.map((p) => `${p.name} (${p.position})`).join(", ")}` : ""}. Registar sadrži samo funkcionere koji su podneli prijavu, pa čelnika treba proveriti na sajtu institucije ili u APR.`,
			severity: "paznja",
			signalCode: "IMENOVANJE_NEPOZNATO",
			sources: acas.slice(0, 1),
		})
		return "Kadrovik: u registru nema tekućeg čelnika; uneti funkcioneri."
	}

	const entityId = entityIdFor("osoba", head.name)
	yield call("add_finding", {
		section: "rukovodstvo",
		title: `${head.name}: ${head.position} od ${formatDate(head.from)}`,
		text: `Prema registru funkcionera ACAS, ${head.name} obavlja funkciju „${head.position}“ u ${off.institution}${head.from ? ` od ${formatDate(head.from)}` : ""}${head.appointedBy ? `; organ imenovanja: ${head.appointedBy}` : ""}.`,
		severity: "info",
		sources: acas.map((s) => ({ ...s, publishedAt: head.from })),
		entityIds: [entityId],
		claim: { subject: head.name, predicate: "funkcija", value: head.position },
	})

	let vd: Record<string, any> | undefined
	if (head.acting) {
		vd = (yield call("vd_provera", { personId: head.personId })).json
		if (vd?.chain) {
			const chain = vd.chain
			yield call("add_finding", {
				section: "rukovodstvo",
				title: `Od ${formatDate(chain.since)} institucijom rukovode samo vršioci dužnosti (${n(chain.actingCount, "uzastopniVd")})`,
				text: chain.explanation,
				severity: "signal",
				signalCode: "VD_LANAC",
				sources: srcs(vd.sources).slice(0, 1),
				entityIds: [entityId],
			})
		}
	}

	const acts = (yield call("paragraf_akti", { personName: head.name })).json
	if (acts && acts.count > 0) {
		const first = acts.acts[0]
		yield call("add_finding", {
			section: "rukovodstvo",
			title: `Službeni glasnik: objavljen akt o imenovanju/razrešenju (${first.gazette})`,
			text: `U Službenom glasniku (${first.gazette}, ${formatDate(first.date)}) objavljen je akt: „${first.title.replace(/[.\s]+$/u, "")}“. Sadržaj broja navodi samo naslov akta, ne i ime imenovanog; pun tekst akta nije slobodno dostupan.`,
			severity: "info",
			sources: srcs(acts.sources).slice(0, 2),
			entityIds: [entityId],
		})
	} else if (acts) {
		yield call("add_finding", {
			section: "rukovodstvo",
			title: `Akt o imenovanju ${head.name} nije pronađen`,
			text: `U sadržajima brojeva Službenog glasnika nije pronađen akt o imenovanju za ${head.name}; to ne znači da akt ne postoji. Proveriti kod osnivača ili u pretplati.`,
			severity: "paznja",
			signalCode: "IMENOVANJE_NEPOZNATO",
			sources: srcs(acts.sources).slice(0, 1),
			entityIds: [entityId],
		})
	}

	if (vd?.overLimit) {
		yield call("add_finding", {
			section: "rukovodstvo",
			title: `${head.name} je v.d. ${n(vd.months, "mesec")}; zakonski maksimum je ${n((vd.rule?.maxMonths ?? 12) + (vd.rule?.extensionMonths ?? 0), "mesec")}`,
			text: String(vd.explanation),
			severity: "signal",
			signalCode: "VD_PREKO_ROKA",
			sources: srcs(vd.sources),
			entityIds: [entityId],
			claim: { subject: head.name, predicate: "datum_imenovanja", value: String(head.from) },
		})
	}
	// the rule that applies to this legal form, stated even when nothing is over the limit (or when there is no rule to apply)
	const legalLabel = String(off.legalType ?? "").replace(/_/g, " ")
	if (head.acting && vd && !vd.overLimit) {
		if (vd.applicable && vd.rule) {
			yield call("add_finding", {
				section: "rukovodstvo",
				title: `${head.name} je v.d. ${n(vd.months, "mesec")}; zakonski rok (${vd.rule.maxMonths + (vd.rule.extensionMonths ?? 0)} mes.) ističe ${formatDate(vd.limitDate)}`,
				text: `${String(vd.explanation)} Pravni oblik za proveru roka: ${legalLabel}.`,
				severity: vd.nearLimit ? "paznja" : "info",
				signalCode: vd.nearLimit ? "VD_BLIZU_ROKA" : undefined,
				sources: srcs(vd.sources),
				entityIds: [entityId],
			})
		} else {
			yield call("add_finding", {
				section: "rukovodstvo",
				title: `${head.name} je v.d.: za ovaj pravni oblik rok nije proveren`,
				text: `${String(vd.explanation)} Pravni oblik: ${legalLabel}. Za njega tabela propisa nema automatskog roka za vršioca dužnosti, pa sistem ne tvrdi da je rok prekoračen; proveriti statut i odluku osnivača.`,
				severity: "info",
				sources: srcs(vd.sources).slice(0, 1),
				entityIds: [entityId],
			})
		}
	}

	// a legal form without a rule in the table (local government, other): said plainly, so nobody reads silence as "checked, fine"
	if (!["javno_preduzece", "drustvo_kapitala_drzavno", "zdravstvena_ustanova", "organ_drzavne_uprave"].includes(String(off.legalType)) && !head.acting) {
		const hasActing = head.acting || current.some((x) => x.acting)
		yield call("add_finding", {
			section: "rukovodstvo",
			title: `Rok za v.d.: za pravni oblik „${legalLabel}“ nema automatskog zakonskog roka u proverenoj tabeli`,
			text: `${head.name} u registru ACAS ${head.acting ? "je vođen kao vršilac dužnosti" : "nije vođen kao vršilac dužnosti"}${hasActing && !head.acting ? ", ali su u registru drugi funkcioneri na dužnosti vođeni kao v.d." : ""}. Za pravni oblik „${legalLabel}“ tabela propisa sistema nema najduži dozvoljeni rok za v.d. (važe posebni zakoni, statut i odluka osnivača, koji nisu proveravani), pa sistem ne tvrdi da je rok prekoračen.`,
			severity: "info",
			sources: acas.slice(0, 1).map((s) => ({ ...s, publishedAt: head.from })),
			entityIds: [entityId],
		})
	}

	// earlier acting heads whose term ran past the limit of this legal form (closed terms, computed from the register's dates)
	const past = (off.ranijiVd ?? []) as { name: string; position: string; from: string; to: string; months: number; days: number; maxMonths: number; law: string; article: string }[]
	if (past.length) {
		const list = past.map((x) => `${x.name} (${x.position}) od ${formatDate(x.from)} do ${formatDate(x.to)}: ${n(x.months, "mesec")} i ${n(x.days, "dan")}`).join("; ")
		yield call("add_finding", {
			section: "rukovodstvo",
			title: `Ranije: v.d. na čelu institucije duže od zakonskog roka (${past[0].name}, ${n(past[0].months, "mesec")})`,
			text: `Prema datumima u registru ACAS, ranije mandate vršioca dužnosti na čelu institucije: ${list}. ${past[0].law}, ${past[0].article}, propisuje najviše ${n(past[0].maxMonths, "mesec")}. Činjenični obrazac za proveru, ne zaključak o kršenju propisa: propis je naveden u današnjem tekstu (za mandate koji su počeli pre njegovog stupanja na snagu proveriti tadašnji zakon), a registar može imati nepotpune ili kasno unete datume.`,
			severity: "paznja",
			sources: [...acas.slice(0, 1), ...srcs(off.ranijiVdIzvori)],
			entityIds: [entityId],
		})
	}

	// the same person acting again: public-enterprise and health-care laws allow one acting mandate
	const again = (off.ponovljenVd ?? []) as { from: string; to?: string }[]
	if (head.acting && again.length) {
		yield call("add_finding", {
			section: "rukovodstvo",
			title: `${head.name} je ponovo v.d. na čelu institucije (ranije: ${again.map((x) => `${formatDate(x.from)}${x.to ? ` – ${formatDate(x.to)}` : ""}`).join(", ")})`,
			text: `U registru ACAS ${head.name} ima ranije zapise o vršenju iste funkcije kao v.d. (${again.map((x) => `od ${formatDate(x.from)}${x.to ? ` do ${formatDate(x.to)}` : ""}`).join("; ")}), a sada je vođen kao v.d. od ${formatDate(head.from)}. Propis za ovaj pravni oblik (${legalLabel}) dozvoljava samo jedan mandat vršioca dužnosti. Činjenični obrazac za proveru, ne zaključak: zapisi u registru mogu biti produženje istog mandata ili nova odluka osnivača.`,
			severity: "paznja",
			sources: srcs(vd?.sources).slice(0, 2),
			entityIds: [entityId],
		})
	}

	// other acting officials in office (v.d. pomoćnik ministra, v.d. načelnik uprave...): the same legal limit applies to them
	for (const o of current.filter((x) => x.acting && x.personId !== head.personId && x.from && x.personId !== off.headPersonId).slice(0, 3)) {
		const other = (yield call("vd_provera", { personId: o.personId })).json
		if (other?.overLimit) {
			yield call("add_finding", {
				section: "rukovodstvo",
				title: `${o.name} (${o.position}) je v.d. ${n(other.months, "mesec")}; zakonski maksimum je ${n((other.rule?.maxMonths ?? 6) + (other.rule?.extensionMonths ?? 0), "mesec")}`,
				text: String(other.explanation),
				severity: "signal",
				signalCode: "VD_PREKO_ROKA",
				sources: srcs(other.sources),
				claim: { subject: o.name, predicate: "datum_imenovanja", value: String(o.from) },
			})
		}
	}
	return `Kadrovik: proveren čelnik ${head.name} i ${n(others.length, "funkcioner")}, rok v.d. i akt o imenovanju.`
}

// ─── Nabavke ─────────────────────────────────────────────────────────────────

async function* nabavke(): AsyncGenerator<Step, string, ToolResult> {
	const pr = (yield call("jn_pregled")).json
	if (pr?.ok === false) {
		yield* sourceGap("jn", "Pregled ugovora", pr)
		return "Nabavke: Portal javnih nabavki nije odgovorio."
	}
	if (!pr?.totalContracts) {
		yield call("add_finding", {
			section: "novac",
			title: "Portal javnih nabavki: nema objavljenih ugovora za ovog naručioca",
			text: "Portal javnih nabavki ne navodi nijedan ugovor za ovog naručioca (po nazivu i matičnim podacima). To ne mora značiti da ugovora nema: nabavke male vrednosti i izuzete nabavke nisu u ovoj evidenciji, a naručilac može biti vođen pod drugim nazivom.",
			severity: "info",
			sources: [{ kind: "jnportal", title: "Portal javnih nabavki", url: "https://jnportal.ujn.gov.rs/ugovori" }],
		})
		return "Portal javnih nabavki nije vratio podatke o ugovorima."
	}
	const jnSource = srcs(pr.sources).slice(0, 1)
	const cov = pr.obuhvat as { total: number; analyzed: number; truncated: boolean; from?: string; proceduresPartial?: boolean } | undefined
	const capped = !!cov?.truncated
	// big authorities (EPS) are read on their most recent contracts only: every figure says so
	const scope = capped ? ` Analiza obuhvata samo poslednjih ${num(cov.analyzed)} od ukupno ${num(cov.total)} ugovora koje Portal navodi za naručioca (potpisanih od ${formatDate(cov.from)}); stariji ugovori nisu uključeni, pa se zbirovi i udeli odnose na taj period.` : ""
	const partial = cov?.proceduresPartial ? " Vrsta postupka je preuzeta samo za deo ugovora, pa broj postupaka bez objavljivanja može biti veći." : ""
	const cands = (pr.kandidatiZaProveru ?? []) as {
		rank: number
		name: string
		pib: string
		mb?: string
		contracts: number
		valueRsd: number
		sharePct: number
		razlog: string
	}[]

	for (const c of cands) {
		yield call("add_entity", {
			kind: "firma",
			name: c.name,
			role: "dobavljac",
			attrs: { pib: c.pib, mb: c.mb ?? null, valueRsd: c.valueRsd, contracts: c.contracts, share: c.sharePct / 100, rank: c.rank, razlog: c.razlog },
			sources: jnSource,
		})
	}

	yield call("add_finding", {
		section: "novac",
		title: capped ? `Portal javnih nabavki: poslednjih ${num(pr.totalContracts)} od ${num(cov.total)} ugovora, ukupno ${money(pr.totalValueRsd)}` : `Portal javnih nabavki: ${n(pr.totalContracts, "ugovor", num(pr.totalContracts))}, ukupno ${money(pr.totalValueRsd)}`,
		text: `Prema Portalu javnih nabavki, ${pr.institution} je od ${formatDate(pr.period?.from)} do ${formatDate(pr.period?.to)} zaključila ${n(pr.totalContracts, "ugovor", num(pr.totalContracts))} ukupne vrednosti ${money(pr.totalValueRsd)} bez PDV (vrednosti pri potpisivanju${pr.contractsWithoutRsdValue ? `; za ${n(pr.contractsWithoutRsdValue, "ugovor")} u stranoj valuti nije izvršeno preračunavanje u RSD` : ""}). Koncentracija po svim ponuđačima (HHI): ${pr.hhiSviPonudjaci}.${scope}${partial}`,
		severity: "info",
		sources: jnSource,
	})

	const nwp = pr.bezObjavljivanja
	if (nwp?.count > 0) {
		const big = nwp.najveci
		yield call("add_finding", {
			section: "novac",
			title: `${n(nwp.count, "pregovarackiPostupak")} bez objavljivanja javnog poziva (${money(nwp.valueRsd)})`,
			text: `Portal javnih nabavki beleži ${n(nwp.count, "postupak")} bez objavljivanja javnog poziva (sa objavljenim ugovorom ukupne vrednosti ${money(nwp.valueRsd)}: ${nwp.saUgovorom}; bez objavljenog ugovora: ${nwp.bezUgovora}), što je ${dec(nwp.sharePct)}% ukupne vrednosti ugovora.${big ? ` Najveći: „${clip(big.title, 110)}“, ${big.supplier}, ${money(big.valueRsd)} (${formatDate(big.signedAt)}); pravni osnov naveden u postupku: ${big.procedure ?? "nije naveden"}.` : ""} Ovaj postupak je zakonski dozvoljen u propisanim slučajevima; razloge treba proveriti u odluci o pokretanju postupka.${capped ? ` Brojevi se odnose na analizirani period od ${formatDate(cov.from)}, ne na celu istoriju naručioca.` : ""}${partial}`,
			severity: nwp.sharePct > 10 ? "signal" : "paznja",
			signalCode: "BEZ_OBJAVE",
			sources: srcs(pr.sources).slice(0, 2),
		})
	}

	const k = pr.koncentracija
	if (k?.triggered) {
		const top = cands.find((c) => c.pib === k.topPib)
		yield call("add_finding", {
			section: "novac",
			title: `Koncentracija: ${k.topName} učestvuje u ${dec(k.topSharePct)}% vrednosti ugovora (bez državnih preduzeća)`,
			text: `Bez državnih preduzeća i javnih sistema (EPS, NIS, fakulteti; izuzeto ${money(pr.javniSistemi?.iskljuceno)}) firma ${k.topName} učestvuje, samostalno ili u zajedničkim ponudama, u ugovorima vrednosti ${money(k.topValueRsd)}, što je ${dec(k.topSharePct)}% preostale vrednosti (${money(k.vrednostBezJavnihSistema)}); HHI po ponuđačima: ${k.hhiBezJavnihSistema}. Vrednost zajedničke ponude nije vrednost jedne firme. Koncentracija sama po sebi nije nepravilnost, ali je razlog za dalju proveru.${capped ? ` Odnosi se na poslednjih ${num(cov.analyzed)} ugovora (od ${formatDate(cov.from)}).` : ""}`,
			severity: "paznja",
			signalCode: "KONCENTRACIJA",
			sources: jnSource,
			entityIds: top ? [entityIdFor("firma", top.name, { mb: top.mb, pib: top.pib })] : [],
		})
	}

	const iw = (yield call("iw_veze")).json
	for (const l of (iw?.links ?? []) as { supplierName: string; pib?: string; mb?: string; kinds: string[]; contracts: number; valueRsd?: number; sources: unknown }[]) {
		const kinds = [...new Set(l.kinds)].join(" i ")
		const cand = cands.find((c) => c.pib === l.pib)
		yield call("add_finding", {
			section: "firme",
			title: `${l.supplierName}: označen u bazi Integrity Watch Srbija`,
			text: `Baza Integrity Watch Srbija (Transparentnost Srbija) označava firmu ${l.supplierName} kao: ${kinds}. Označenih ugovora kod ove institucije: ${l.contracts}${l.valueRsd ? `, vrednost samostalnih ugovora ${money(l.valueRsd)}` : ""}. Otvoreni podaci ne imenuju funkcionera ni stranku; podatak zahteva proveru.`,
			severity: "signal",
			signalCode: "POLITICKA_VEZA",
			sources: srcs(l.sources),
			entityIds: cand ? [entityIdFor("firma", cand.name, { mb: cand.mb, pib: cand.pib })] : [],
		})
	}
	return `Nabavke: ${n(pr.totalContracts, "ugovor", num(pr.totalContracts))}; za proveru izdvojeno ${n(cands.length, "dobavljac")}; oznaka Integrity Watch: ${(iw?.links ?? []).length}.`
}

// ─── Revizor ─────────────────────────────────────────────────────────────────

const AUDIT_KEYWORDS = /(v\.?\s?d\.?|vr[šs]ioc|nabavk|pregovara[čc]k|nije u skladu|nepravilnost|mil\.|mlrd|dinara|ugovor)/i

function excerptScore(e: string): number {
	return (e.match(new RegExp(AUDIT_KEYWORDS, "gi")) ?? []).length
}

// what a verbatim excerpt is about, for a headline ("DRI 2023 · javne nabavke: ...")
const DRI_TOPICS: [RegExp, string][] = [
	[/vr[šs]ioc\w* dužnosti|v\. ?d\./i, "vršioci dužnosti"],
	[/javn\w+ nabavk|postupak\w* javn|pregovara[čc]k/i, "javne nabavke"],
	[/ugovor\w* o (?:radu|obavljanju|delu)|rad van radnog|naknad\w+ po ugovor|zarad|porez na zarade|doprinos/i, "zarade i angažovanje"],
	[/prihod\w* od putarin|putarin/i, "prihodi od putarine"],
	[/oprem|osnovn\w+ sredstv|nekretnin|popis/i, "imovina i oprema"],
	[/osoba sa invaliditetom|invalidit/i, "zapošljavanje osoba sa invaliditetom"],
	[/finansijsk\w+ izve[šs]taj|bilans|računovodstv|racunovodstv|knjigovodstv/i, "finansijski izveštaji"],
]

/** Headline of a DRI excerpt: first clause of the verbatim sentence, cut at a word boundary (full excerpt stays in the text). */
export function driTitle(period: number | string | undefined, kind: string | undefined, excerpt: string): string {
	const body = excerpt
		.replace(/…$/u, "")
		.replace(/^(?:zaklju[čc]ak|nalaz|otkrivena nepravilnost|prioritet)\b[^:]{0,12}:\s*/i, "")
		.replace(/^(?:međutim|pored toga|takođe|navedeno)\b,?\s*/i, "")
		// an introductory clause ("U skladu sa ovim odredbama Zakona i Pravilnika, ...") says nothing: start at the statement
		.replace(/^(?:u skladu sa|s obzirom (?:da|na)|kao što je|za|prema|zbog)\s[^,]{5,90},\s+(?=\p{L})/iu, "")
	const cut = body.search(/,?\s+(?:što|jer|odnosno)\s|;|\s\(Napomena/i)
	const clause = cut >= 40 ? body.slice(0, cut) : body
	const topic = DRI_TOPICS.find(([re]) => re.test(excerpt))?.[1] ?? kind ?? "izveštaj"
	return `DRI ${period ?? ""} · ${topic}: ${clauseHeadline(clause, 100)}`.replace(/\s+/g, " ")
}

/**
 * What a DRI report is "of", in titles and texts. The AUDITED period only when the title of the report states it
 * ("za 2018. godinu" -> "finansijski izveštaji za 2018."); the publication year is not a period (a report published in 2025 can
 * quote 2023-2024), so then the label is the publication date.
 */
export function driLabels(r: { kind?: string; period?: string; publishedAt?: string }): { title: string; text: string } {
	const published = r.publishedAt ? `izveštaj objavljen ${formatDate(r.publishedAt)}` : "izveštaj bez datuma objave"
	const what = /^finansijska/.test(asciiFold(r.kind ?? "")) ? "finansijski izveštaji" : (r.kind ?? "revizija")
	if (r.period) return { title: `za ${r.period}.`, text: `${what} za ${r.period}., ${published}` }
	return { title: r.publishedAt ? `izveštaj od ${formatDate(r.publishedAt)}` : "izveštaj", text: `${what}, ${published}` }
}

/** Reaction: Nabavke wrote BEZ_OBJAVE / KONCENTRACIJA; Revizor looks for an earlier DRI finding on the same topic and backs the finding up. */
async function* revizorReakcija(c: PolicyCtx): AsyncGenerator<Step, string, ToolResult> {
	const nalazId = /\[(f\d+) · [A-Z_]+\]/.exec(c.message)?.[1]
	if (!nalazId) return "Revizor: poruka povoda nema oznaku nalaza, pa nema reakcije."
	const res = (yield call("dri_srodni_nalazi", { nalazId })).json
	if (!res || res.ok === false) return `Revizor: provera srodnih nalaza DRI nije moguća (${clip(String(res?.error ?? "nema odgovora"), 80)}).`
	type Hit = { kind?: string; period?: string; publishedAt?: string; excerpt: string; izvori: Record<string, unknown>[] }
	const hit = ((res.nalazi ?? []) as Hit[])[0]
	if (!hit) return "Revizor: u već obrađenim izveštajima DRI nema srodnog nalaza, pa ništa nije dodato."
	const label = driLabels(hit)
	const when = hit.period ? `za ${hit.period}.` : `objavljenom ${formatDate(hit.publishedAt)}`
	yield call("add_finding", {
		section: "revizija",
		title: `DRI je u izveštaju ${when} već utvrdio nalaz o ${res.tema}`,
		text: `Potkrepljuje nalaz ${res.povod?.agent ?? "Nabavke"} „${String(res.povod?.title ?? "").replace(/[.\s]+$/u, "")}“. U izveštaju DRI (${label.text}) stoji: „${hit.excerpt}“ Doslovan izvod. Povezanost je tematska: izvod ne govori nužno o istim postupcima kao nalaz Nabavke, pa oba izvora treba čitati zajedno.`,
		severity: "paznja",
		signalCode: "DRI_NALAZ",
		sources: [...hit.izvori, ...srcs(res.izvoriPovoda)],
		potkrepljuje: nalazId,
	})
	return `Revizor: reagovao na nalaz ${res.povod?.agent ?? "Nabavke"} i dodao srodni nalaz DRI (${label.title}).`
}

async function* revizor(c: PolicyCtx): AsyncGenerator<Step, string, ToolResult> {
	if (/^Povod: nalaz /.test(c.message)) return yield* revizorReakcija(c)
	const list = (yield call("dri_izvestaji")).json
	type R = { id: string; title: string; year?: number; publishedAt?: string; kind?: string }
	const reports = ((list?.reports ?? []) as R[]).slice().sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""))
	if (list?.ok === false) {
		yield* sourceGap("dri", "Spisak izveštaja DRI", list)
		return "Revizor: DRI nije odgovorio."
	}
	if (!reports.length) return "DRI nema izveštaja o ovoj instituciji u dostupnim podacima."
	const kind = (r: R) => asciiFold(r.kind ?? "")
	const main = reports.filter((r) => /revizija pravilnosti/.test(kind(r)) && !/odaziv|poslerevizion/.test(kind(r))).slice(0, 3)
	const financial = reports.filter((r) => /finansijska revizija/.test(kind(r))).slice(0, 1)
	const picks = [...main, ...financial]
	if (!picks.length) picks.push(...reports.slice(0, 2))

	let findings = 0
	for (const r of picks) {
		const nz = (yield call("dri_nalazi", { reportId: r.id })).json
		if (!nz || nz.ok === false) continue
		// "za 2018." only when the report's title states the audited period; otherwise the publication date (see driLabels)
		const labels = driLabels({ kind: nz.kind, period: nz.period, publishedAt: nz.publishedAt })
		const sources = srcs(nz.sources)
		if (nz.opinion) {
			const op = String(nz.opinion)
			const severity = /negativ|uzdr/i.test(op) ? "signal" : /rezerv/i.test(op) ? "paznja" : "info"
			findings++
			yield call("add_finding", {
				section: "revizija",
				title: `DRI ${labels.title} · ${nz.kind ?? "revizija"}: ${op}`,
				// the opinion sentence is quoted only when the tool returned it whole (never a sentence cut off in the middle)
				text: `Državna revizorska institucija je u izveštaju (${labels.text}) izrazila ${op}.${nz.misljenjeIzvod ? ` Izvod iz izveštaja: „${String(nz.misljenjeIzvod)}“` : ""}`,
				severity,
				signalCode: "DRI_MISLJENJE",
				sources,
			})
		}
		const excerpts = ((nz.excerpts ?? []) as string[])
			.filter((e) => e.length > 80 && !/^po na[šs]em mi[šs]ljenju/i.test(e) && !/Preporuka broj|^Rezime\b|Rezime (?:nalaza|datih)/i.test(e))
			.map((e) => ({ e, s: excerptScore(e) }))
			.sort((a, b) => b.s - a.s)
		// the two best excerpts, but a finding about acting heads (v.d.) is never left out: it is the one other agents react to
		const acting = excerpts.find((x) => /vr[šs]ioc\w*\s+du[žz]nosti|v\.\s?d\./i.test(x.e))
		const picked = excerpts.slice(0, 2)
		if (acting && !picked.includes(acting)) picked[1] = acting
		for (const { e, s } of picked) {
			findings++
			yield call("add_finding", {
				section: "revizija",
				title: driTitle(labels.title, nz.kind, e),
				text: `Prema izveštaju DRI (${labels.text}): „${e}“ Doslovan izvod; pun kontekst je u izveštaju.`,
				severity: s > 0 ? "paznja" : "info",
				signalCode: "DRI_NALAZ",
				sources,
			})
		}
	}
	return `Revizor: pregledano ${n(picks.length, "izvestaj")} DRI, upisano ${n(findings, "nalaz")}.`
}

// ─── Mediji ──────────────────────────────────────────────────────────────────

type Item = { title: string; outlet?: string; publishedAt?: string; url: string; snippet?: string; nalazi?: string }
const itemSource = (i: Item) => ({ kind: "vesti", title: `${i.outlet ?? "Vesti"}: ${i.title}`, url: i.url, publishedAt: i.publishedAt })
const stripOutlet = (s: string) => s.replace(/\s+/g, " ").trim()

// "v. d.", "br.", "čl. 23" etc. are not sentence ends
const ABBREVIATION = /(?:^|[\s(„"])(?:[\p{L}]{1,2}|br|tzv|npr|itd|god|mil|mlrd|čl|tač|st|sl|dr|mr|prof|ul)$/iu

function lead(text: string, max = 340): string {
	const t = stripOutlet(text)
	const cut = t.slice(0, max)
	let end = -1
	for (const m of cut.matchAll(/[.;!?](?=\s)/g)) {
		const before = cut.slice(Math.max(0, m.index - 12), m.index)
		if (m[0] === "." && ABBREVIATION.test(before)) continue
		end = m.index
	}
	return end > 80 ? cut.slice(0, end + 1) : clip(t, max)
}

const NEWS_RECENT_DAYS = 90
const isRecent = (i: Item) => !!i.publishedAt && Date.now() - Date.parse(i.publishedAt) <= NEWS_RECENT_DAYS * 86400e3

type Overview = { naslov: string; tekst: string; ukupno: number; izvori: Record<string, unknown>[] }

/** The "Pregled medija" finding: counts, themes and 10-12 distinct articles, exactly as the search tool prepared them. */
function pregledMedija(res: { pregled?: Overview } | undefined): Record<string, unknown> | undefined {
	const p = res?.pregled
	if (!p || !p.ukupno || !p.izvori?.length) return undefined
	return { section: "mediji", title: p.naslov, text: p.tekst, severity: "info", sources: p.izvori }
}

async function* medijiInstitucija(c: PolicyCtx): AsyncGenerator<Step, string, ToolResult> {
	const query = /upit: (.+?)\.(?: Fokus|$)/.exec(c.message)?.[1] ?? /Institucija: (.+?)[.(]/.exec(c.message)?.[1]?.trim() ?? "institucija"
	const res = (yield call("vesti_pretraga", { query, days: 365, tip: "institucija" })).json
	if (!res || res.ok === false) {
		yield* sourceGap("mediji", "Pretraga medija o instituciji", res)
		return `Mediji: pretraga nije dostupna (${clip(String(res?.error ?? "nema rezultata"), 80)}).`
	}
	const items = ((res.clanci ?? []) as Item[]).filter((i) => i.url)
	const review = pregledMedija(res)
	if (!items.length && !review) return "Mediji: nema članaka o instituciji u poslednjih 12 meseci."
	let written = 0

	// a claim about the institution needs the institution in the headline (an article that mentions it only in passing is not "about" it)
	const union = items.find((i) => isRecent(i) && i.nalazi === "naslov" && /sindikat|ostavk/i.test(asciiFold(i.title)))
	if (union) {
		const art = (yield call("vest_tekst", { url: union.url })).json
		const body = art?.text ? lead(String(art.text)) : (union.snippet ?? union.title)
		const finding = {
			section: "mediji",
			title: clip(union.title, 150),
			text: `Prema navodima sindikata (prenosi ${union.outlet ?? "medij"}, ${formatDate(union.publishedAt)}): ${body} Navodi nisu potvrđeni iz nezavisnog ni zvaničnog izvora.`,
			severity: "paznja",
			signalCode: "MEDIJSKI_NAVOD",
		}
		// deliberate, documented demo of the source gate: a claim without a source is refused, then retried with the article
		const first = yield call("add_finding", { ...finding, sources: [] })
		void first
		written++
		yield call("add_finding", { ...finding, sources: [itemSource(union)] })
	}

	// specific claims come from the last 90 days: the title or snippet must carry a reason to flag it
	const keyword = /(ugovor|nabavk|dodelila|tender|direktor|ostavk|revizij|nepravilnost)/i
	const others = items
		.filter((i) => i !== union && isRecent(i) && i.nalazi === "naslov" && keyword.test(asciiFold(i.title)))
		.sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""))
		.slice(0, 2)
	for (const i of others) {
		written++
		const important = /(ugovor|nabavk|dodelila|tender|nepravilnost|revizij)/i.test(asciiFold(i.title))
		yield call("add_finding", {
			section: "mediji",
			title: clip(i.title, 150),
			text: `${i.outlet ?? "Medij"} (${formatDate(i.publishedAt)}) piše: ${i.snippet ? clip(i.snippet, 220) : clip(i.title, 220)}${important ? " Navod nije potvrđen u zvaničnom izvoru; proveriti." : ""}`,
			severity: important ? "paznja" : "info",
			signalCode: important ? "MEDIJSKI_NAVOD" : undefined,
			sources: [itemSource(i)],
		})
	}
	if (review) {
		written++
		yield call("add_finding", review)
	}
	return `Mediji: ${n(res.pregled?.ukupno ?? items.length, "clanak")} u poslednjih 12 meseci, upisano ${n(written, "nalaz")}${union ? " (uključujući ponovljen pokušaj sa izvorom)" : ""}.`
}

async function* medijiOsoba(c: PolicyCtx): AsyncGenerator<Step, string, ToolResult> {
	const name = /Osoba: (.+?)(?:,| \(|\. )/.exec(c.message)?.[1]?.trim() ?? ""
	if (!name) return "Mediji: nije zadato ime osobe."
	yield call("dosije_pregled")
	// same names are common: the tool keeps an article only if it names the person AND the institution (or the owned firm)
	const firm = /vlasnik firme (.+?)(?:\. |, |$)/.exec(c.message)?.[1]?.trim()
	const res = (yield call("vesti_pretraga", { query: name, days: 730, tip: "osoba", kontekst: firm ? [firm] : [] })).json
	if (!res || res.ok === false) return `Mediji: pretraga za ${name} nije dostupna (${clip(String(res?.error ?? "nema rezultata"), 80)}).`
	const about = ((res.clanci ?? []) as Item[]).filter((i) => i.url)
	const review = pregledMedija(res)
	if (!about.length && !review) return `Mediji · ${name}: nema članaka koji pominju osobu zajedno sa institucijom ili firmom u poslednje 2 godine (imenjaci su česti), pa nema nalaza.`
	let written = 0
	const withFunction = about.find((i) => /generaln\w*\s+direktor/.test(asciiFold(i.title)) && !/\bv\.?\s?d\b|vrsilac|vrsioc/.test(asciiFold(i.title)))
	if (withFunction) {
		written++
		yield call("add_finding", {
			section: "mediji",
			title: `${withFunction.outlet ?? "Medij"}: ${name} naveden kao „generalni direktor“`,
			text: `Naslov članka (${withFunction.outlet ?? "medij"}, ${formatDate(withFunction.publishedAt)}) navodi ${name} kao „generalni direktor“, bez oznake v.d.: „${clip(withFunction.title, 150)}“. Funkciju treba uporediti sa zvaničnim registrom.`,
			severity: "paznja",
			signalCode: "MEDIJSKI_NAVOD",
			sources: [itemSource(withFunction)],
			claim: { subject: name, predicate: "funkcija", value: "generalni direktor" },
		})
	}
	const recent = about.find((i) => i !== withFunction && /sindikat|ostavk/.test(asciiFold(i.title)))
	if (recent) {
		written++
		yield call("add_finding", {
			section: "mediji",
			title: clip(recent.title, 150),
			text: `${recent.outlet ?? "Medij"} (${formatDate(recent.publishedAt)}) navodi zahtev sindikata u kojem se pominje ${name}: ${clip(recent.snippet ?? recent.title, 220)} Navod nije potvrđen iz nezavisnog ili zvaničnog izvora.`,
			severity: "paznja",
			signalCode: "MEDIJSKI_NAVOD",
			sources: [itemSource(recent)],
		})
	}
	if (review) {
		written++
		yield call("add_finding", review)
	}
	return `Mediji · ${name}: ${n(res.pregled?.ukupno ?? about.length, "clanak")}, upisano ${n(written, "nalaz")}.`
}

/** Reaction: Kadrovik wrote VD_PREKO_ROKA / VD_LANAC about the head; Mediji checks how the press covered the appointment and names the function. */
async function* medijiReakcija(c: PolicyCtx): AsyncGenerator<Step, string, ToolResult> {
	const name = /Osoba: (.+?) \(funkcija prema ACAS/.exec(c.message)?.[1]?.trim()
	const acasFunction = /funkcija prema ACAS: „(.+?)“\)/.exec(c.message)?.[1]
	const from = /^Povod: nalaz (.+?): /.exec(c.message)?.[1] ?? "Kadrovik"
	if (!name) return "Mediji: poruka povoda nema ime osobe, pa nema reakcije."
	const res = (yield call("vesti_imenovanje", { ime: name })).json
	if (!res || res.ok === false) return `Mediji: ciljana provera za ${name} nije dostupna (${clip(String(res?.error ?? "nema odgovora"), 80)}).`
	const articles = ((res.clanci ?? []) as { outlet: string; publishedAt?: string; title: string; url: string; naziv: string }[]).filter((a) => a.url)
	if (!articles.length) return `Mediji: u medijima nema članaka o imenovanju ili funkciji osobe ${name} (reakcija na nalaz ${from}), pa nema nalaza.`
	const vd = Number(res.nazivi?.vd) || 0
	const dir = Number(res.nazivi?.direktor) || 0
	const other = Number(res.nazivi?.drugo) || 0
	// only articles whose headline or lead names the person together with the appointment/function are counted (see the tool)
	const all = Number(res.brojClanaka) || vd + dir + other
	const stating = res.clanakSaFunkcijom as { outlet: string; publishedAt?: string; title: string; url: string; fraza?: string } | undefined
	// the aggregate is neutral: status comes from its sources and it carries NO claim, so it can never be the one marked against the register
	yield call("add_finding", {
		section: "mediji",
		title: `Imenovanje u medijima: ${name}, ${n(all, "clanak")} (${vd} sa oznakom v.d., ${dir} samo „direktor“)`,
		text: `Ciljana provera medija povodom nalaza ${from}: ${n(all, "clanak")} čiji naslov ili uvod pominje osobu ${name} uz imenovanje ili funkciju. Prema naslovima i uvodima, ${vd} navodi oznaku v.d., ${dir} navodi „direktor“ bez te oznake, a ${other} ostalo.${all > articles.length ? ` Izvori ispod su ${n(articles.length, "clanak")} od njih.` : ""}${acasFunction ? ` Registar ACAS vodi osobu kao „${acasFunction}“; naziv u medijima nije pobijanje registra.` : ""}`,
		severity: "info",
		sources: articles.map((a) => itemSource({ title: a.title, outlet: a.outlet, publishedAt: a.publishedAt, url: a.url })),
		entityIds: [entityIdFor("osoba", name)],
	})
	let written = 1
	// the comparison with the register needs ONE specific article that states the function: it is the only source of that finding
	if (stating?.fraza && !res.navodVecUDosijeu) {
		written++
		yield call("add_finding", {
			section: "mediji",
			title: `${stating.outlet}: ${name} naveden kao „${stating.fraza}“`,
			text: `Naslov ili uvod članka (${stating.outlet}, ${formatDate(stating.publishedAt)}) navodi ${name} kao „${stating.fraza}“, bez oznake v.d.: „${clip(stating.title, 150)}“. Funkciju treba uporediti sa zvaničnim registrom.`,
			severity: "paznja",
			signalCode: "MEDIJSKI_NAVOD",
			sources: [itemSource({ title: stating.title, outlet: stating.outlet, publishedAt: stating.publishedAt, url: stating.url })],
			entityIds: [entityIdFor("osoba", name)],
			claim: { subject: name, predicate: "funkcija", value: stating.fraza },
		})
	}
	return `Mediji: reagovao na nalaz ${from}, ${n(all, "clanak")} o imenovanju osobe ${name} (${vd} v.d., ${dir} direktor), upisano ${n(written, "nalaz")}.`
}

/** Reaction: the Revizor filed a DRI finding about procurement or acting heads; Mediji reads the shared state and looks for coverage of that audit topic. */
async function* medijiRevizijaReakcija(c: PolicyCtx): AsyncGenerator<Step, string, ToolResult> {
	const tema = /Tema revizije: (.+?)\. Institucija/.exec(c.message)?.[1]?.trim()
	const from = /^Povod: nalaz (.+?): /.exec(c.message)?.[1] ?? "Revizor"
	const nalaz = (/^Povod: nalaz .+?: (.+?) \[f\d+ · [A-Z_]+\]/.exec(c.message)?.[1] ?? "").split(": ")[0]
	if (!tema) return "Mediji: poruka povoda nema temu revizije, pa nema reakcije."
	// read what the others have already filed, then search the media for the audit topic of this institution
	yield call("dosije_pregled")
	const res = (yield call("vesti_tema_revizije", { tema })).json
	if (!res || res.ok === false) return `Mediji: pretraga medija o temi „${tema}“ nije dostupna (${clip(String(res?.error ?? "nema odgovora"), 80)}).`
	const articles = ((res.clanci ?? []) as { outlet: string; publishedAt?: string; title: string; url: string }[]).filter((a) => a.url)
	if (!articles.length) return `Mediji: u medijima nema članaka o temi revizije „${tema}“ za instituciju (reakcija na nalaz ${from}), pa nema nalaza.`
	const count = Number(res.brojClanaka) || articles.length
	const d = res.uDosijeu as { nalaziONabavkama?: number; nalaziRevizije?: number; nalaziORukovodstvu?: number } | undefined
	// what the shared state already holds on the topic when the check runs (only what exists is named)
	const held = [
		tema === "javne nabavke" && d?.nalaziONabavkama ? `${n(d.nalaziONabavkama, "nalaz")} o nabavkama` : "",
		tema !== "javne nabavke" && d?.nalaziORukovodstvu ? `${n(d.nalaziORukovodstvu, "nalaz")} o rukovodstvu` : "",
		d?.nalaziRevizije ? `${n(d.nalaziRevizije, "nalaz")} revizije` : "",
	].filter(Boolean)
	yield call("add_finding", {
		section: "mediji",
		title: `Mediji o temi revizije „${tema}“: ${n(count, "clanak")}`,
		text: `Povodom nalaza ${from}${nalaz ? ` (${nalaz})` : ""} provereno je kako mediji izveštavaju o istoj temi: ${n(count, "clanak")} u pretrazi medija pominje temu „${tema}“ za ovu instituciju${res.osoba ? ` ili njenog čelnika (${res.osoba})` : ""}. Prikazano ih je ${articles.length}, npr. ${articles.slice(0, 2).map((a) => `${a.outlet}, ${formatDate(a.publishedAt)}`).join("; ")}.${held.length ? ` U dosijeu je u trenutku provere već bilo: ${held.join(" i ")}.` : ""} Članci su zaseban izvor: ne potvrđuju niti pobijaju nalaz DRI.`,
		severity: "info",
		sources: articles.map((a) => itemSource({ title: a.title, outlet: a.outlet, publishedAt: a.publishedAt, url: a.url })),
	})
	return `Mediji: reagovao na nalaz ${from}, ${n(count, "clanak")} o temi „${tema}“.`
}

async function* mediji(c: PolicyCtx): AsyncGenerator<Step, string, ToolResult> {
	if (/^Povod: nalaz Revizor: /.test(c.message)) return yield* medijiRevizijaReakcija(c)
	if (/^Povod: nalaz /.test(c.message)) return yield* medijiReakcija(c)
	return yield* /^Osoba:/.test(c.message) ? medijiOsoba(c) : medijiInstitucija(c)
}

// ─── Firme ───────────────────────────────────────────────────────────────────

async function* firme(c: PolicyCtx): AsyncGenerator<Step, string, ToolResult> {
	const answer = /^Novinarka je odgovorila na pitanje "([\s\S]*)": ([\s\S]+)$/.exec(c.message)
	if (answer) return yield* firmeOdgovor(answer[1], answer[2])

	const m = /Dobavljač: (.+?) \(PIB (\S+), MB (\S+?)\)\./.exec(c.message)
	if (!m) return "Firme: poruka nema podatke o dobavljaču."
	const [, name, pibRaw, mbRaw] = m
	const pib = /^\d+$/.test(pibRaw) ? pibRaw : undefined
	const mb = /^\d+$/.test(mbRaw) ? mbRaw : undefined
	const rank = Number(/Rang[^:]*: (\d+)/.exec(c.message)?.[1] ?? 99)
	yield call("dosije_pregled")
	const fs = (yield call("firma_signali", { name, pib, mb })).json
	if (!fs || fs.ok === false) return `Firme: provera firme ${name} nije uspela (${clip(String(fs?.error ?? ""), 80)}).`

	const jn = srcs(fs.sources).filter((s) => s.kind !== "integrity_watch")
	const iw = srcs(fs.sources).filter((s) => s.kind === "integrity_watch")
	const p = fs.profile
	const ct = fs.contracts
	// a bidder that only appears in joint bids has no name on the portal: show the registered APR name instead of "PIB ..."
	const shown = /^(PIB|MB) \d+$/.test(name) && p?.name ? clip(p.name, 40) : name
	const profileText = p
		? `Prema APR (otvoreni podaci): ${p.name} je osnovana ${formatDate(p.founded)}, opština ${p.municipality ?? "nepoznata"}, šifra delatnosti ${p.activityCode ?? "nepoznata"}, ${typeof p.employees === "number" ? n(p.employees, "zaposleni") : "broj zaposlenih nije poznat"}${p.revenueRsd !== undefined ? `, ukupni prihodi za ${p.revenueYear}. godinu ${money(p.revenueRsd)}` : ""}. `
		: `Firma nije pouzdano pronađena u APR otvorenim podacima (${fs.matchBasis}), pa profil nije prikazan. `
	yield call("add_finding", {
		section: "firme",
		title: `${shown}: ${n(ct.count, "ugovor")} sa institucijom${p ? `, osnovana ${formatDate(p.founded)}` : ""}`,
		text: `${profileText}Ugovori sa institucijom prema Portalu javnih nabavki: ${ct.count} (${ct.soleCount} samostalno, ${ct.jointCount} u zajedničkim ponudama), samostalno ${money(ct.soleValueRsd)}, vrednost zajedničkih ponuda ${money(ct.jointValueRsd)} (nije vrednost ove firme); prvi ugovor ${formatDate(ct.first)}, poslednji ${formatDate(ct.last)}.`,
		severity: "info",
		sources: jn.length ? jn : srcs(fs.sources),
	})
	for (const s of (fs.signals ?? []) as { code: string; label: string; severity: string; detail: string }[]) {
		yield call("add_finding", {
			section: "firme",
			title: `${shown}: ${s.label}`,
			text: s.detail,
			severity: s.severity,
			signalCode: s.code,
			sources: s.code === "POLITICKA_VEZA" && iw.length ? iw : jn.length ? jn : srcs(fs.sources),
		})
	}
	if (rank <= 2) {
		yield call("ask_human", {
			question: `Ko su vlasnici firme ${name} (${mb ? `MB ${mb}` : pib ? `PIB ${pib}` : "MB nepoznat"})? Nema automatskog izvora.`,
			title: `Vlasnici firme ${clip(name, 40)}`,
			hint: "APR pretraga je iza reCAPTCHA pa je agenti ne mogu koristiti. Otvori APR pretragu, nađi firmu po nazivu ili matičnom broju i prepiši ime vlasnika. Ako nije dostupno, klikni Preskoči.",
			links: [
				{ label: "APR pretraga privrednih subjekata", url: APR_SEARCH },
				...(ct.biggest?.url ? [{ label: "Portal javnih nabavki: najveći ugovor", url: ct.biggest.url }] : []),
			],
			entityName: name,
		})
	}
	return `Firme: provereno ${name}, ${n((fs.signals ?? []).length, "signal")}${rank <= 2 ? ", postavljeno pitanje o vlasnicima" : ""}.`
}

async function* firmeOdgovor(question: string, answer: string): AsyncGenerator<Step, string, ToolResult> {
	const firm = /firme (.+?) \((?:MB|PIB)/.exec(question)?.[1] ?? "firme"
	// "Marko Marković, 100%" -> one person, share 100%; "100%" or "nepoznato" is not a name and starts nothing
	const owners = parseOwnerAnswer(answer)
	if (!owners.length) return `Firme: u odgovoru novinarke nema imena osobe („${clip(answer, 60)}“), pa nije dodat vlasnik ni pokrenuta provera.`
	const source = { kind: "novinar", title: "Novinar: unos nakon ručne provere u APR pretrazi", url: APR_SEARCH }
	for (const owner of owners) {
		yield call("add_entity", { kind: "osoba", name: owner.name, role: "vlasnik", attrs: { firma: firm, ...(owner.share ? { udeo: owner.share } : {}) }, sources: [source] })
	}
	const who = describeOwners(owners)
	yield call("add_finding", {
		section: "firme",
		title: `Vlasnik firme ${clip(firm, 40)}, prema novinarki: ${who}`,
		text: `Novinarka je nakon ručne provere u APR pretrazi navela da je vlasnik firme ${firm}: ${who}. Sistem ovaj podatak nije nezavisno potvrdio; sledi provera da li se osoba pojavljuje u registru funkcionera i na PEP listama.`,
		severity: "info",
		sources: [source],
	})
	return `Firme: upisan vlasnik (${who}) prema odgovoru novinarke; pokrenuta provera osobe.`
}

// ─── Imovina ─────────────────────────────────────────────────────────────────

async function* imovina(c: PolicyCtx): AsyncGenerator<Step, string, ToolResult> {
	const name = /Funkcioner: (.+?) \(ACAS ID/.exec(c.message)?.[1]
	const personId = /ACAS ID (\d+)/.exec(c.message)?.[1]
	const from = / od (\d{4}-\d{2}-\d{2})/.exec(c.message)?.[1]
	if (!name || !personId) return "Imovina: nema ACAS ID funkcionera."
	yield call("dosije_pregled")
	const r = (yield call("acas_imovina", { personId, name })).json
	const reports = (r?.reports ?? []) as { reportDate?: string; reason?: string; summary: string[]; url: string }[]
	const acasRegister = { kind: "acas", title: `ACAS registar – pretraga: ${name}`, url: "https://publicacas.acas.rs/#/acas/funkcioner" }
	if (!reports.length) {
		yield call("add_finding", {
			section: "rukovodstvo",
			title: `${name}: izveštaj o imovini nije pronađen`,
			text: `Nije pronađen izveštaj o imovini i prihodima funkcionera ${name} u registru ACAS${r?.ok === false ? " (izvor trenutno nije dostupan)" : ""}. Proveriti ručno u registru.`,
			severity: "paznja",
			signalCode: "IMOVINA",
			sources: [acasRegister],
		})
		return `Imovina: nema izveštaja za ${name}.`
	}
	const latest = reports[0]
	yield call("add_finding", {
		section: "rukovodstvo",
		title: `${name}: izveštaj o imovini i prihodima od ${formatDate(latest.reportDate)}`,
		text: `U registru ACAS postoji izveštaj o imovini i prihodima funkcionera ${name} od ${formatDate(latest.reportDate)}${latest.reason ? ` (${latest.reason})` : ""}. Prikaz stavki: ${latest.summary.slice(0, 3).map((l) => clip(l, 150)).join("; ")}.`,
		severity: "info",
		sources: srcs(r.sources).slice(0, 2),
	})
	if (from && !reports.some((x) => (x.reportDate ?? "") >= from)) {
		yield call("add_finding", {
			section: "rukovodstvo",
			title: `${name}: nema izveštaja o imovini posle stupanja na funkciju`,
			text: `Nije pronađen izveštaj o imovini nakon stupanja na funkciju (${formatDate(from)}); najnoviji u registru je od ${formatDate(latest.reportDate)} Proveriti.`,
			severity: "paznja",
			signalCode: "IMOVINA",
			sources: srcs(r.sources).slice(0, 1),
		})
	}
	return `Imovina: ${n(reports.length, "izvestaj")} za ${name}.`
}

// ─── Provera ─────────────────────────────────────────────────────────────────

async function* provera(c: PolicyCtx): AsyncGenerator<Step, string, ToolResult> {
	const m = /Provera: (.+?) \(vlasnik firme (.+?), prema/.exec(c.message)
	if (!m) return "Provera: nema imena osobe."
	const [, name, firm] = m
	yield call("dosije_pregled")
	const a = (yield call("acas_pretraga_osobe", { name })).json
	const p = (yield call("pep_provera", { name })).json
	const acasOk = a && a.ok !== false
	const acasMatches = acasOk ? ((a.matches ?? []) as { position: string; institution: string }[]) : []
	const pepMatches = p && p.ok !== false ? ((p.matches ?? []) as { dataset: string; name: string }[]) : []
	const sources = [...srcs(a?.sources), ...srcs(p?.sources)]
	const registerSource = { kind: "acas", title: `ACAS registar – pretraga: ${name}`, url: "https://publicacas.acas.rs/#/acas/funkcioner" }

	if (acasMatches.length || pepMatches.length) {
		const parts: string[] = []
		if (acasMatches.length) parts.push(`${n(a.distinctPersons, "osoba")} u registru funkcionera ACAS (npr. ${acasMatches[0].position}, ${clip(acasMatches[0].institution, 60)})`)
		if (pepMatches.length) parts.push(`${n(pepMatches.length, "unos")} na PEP listama (${[...new Set(pepMatches.map((x) => x.dataset))].join(", ")})`)
		yield call("add_finding", {
			section: "firme",
			title: `Ime vlasnika firme ${clip(firm, 40)} poklapa se sa registrom: ${name}`,
			text: `Ime „${name}“ (vlasnik firme ${firm}, prema unosu novinarke) poklapa se sa: ${parts.join("; ")}. Poklapanje imena nije dokaz identiteta: potrebno je utvrditi da li je to ista osoba.`,
			severity: "signal",
			signalCode: "VLASNIK_FUNKCIONER",
			sources: sources.length ? sources : [registerSource],
		})
		return `Provera · ${name}: postoji poklapanje imena (potrebna potvrda identiteta).`
	}
	yield call("add_finding", {
		section: "firme",
		title: `Vlasnik ${name}: nema poklapanja u registru funkcionera ni na PEP listama`,
		text: `Pretraga imena „${name}“ (vlasnik firme ${firm}, prema unosu novinarke) nije dala poklapanje na PEP listama${acasOk ? " ni u registru funkcionera ACAS" : "; pretraga registra ACAS nije dostupna u ovom režimu podataka"}. Odsustvo poklapanja nije dokaz da veza ne postoji.`,
		severity: "info",
		sources: [registerSource, { kind: "opensanctions", title: "OpenSanctions – Politically Exposed Persons (Srbija)", url: "https://www.opensanctions.org/datasets/peps/" }],
	})
	return `Provera · ${name}: bez poklapanja.`
}

// ─── Urednik (final summary loop) ────────────────────────────────────────────

async function* urednik(): AsyncGenerator<Step, string, ToolResult> {
	const pr = (yield call("dosije_pregled")).json
	if (!pr?.counts) return "Urednik: pregled dosijea nije dostupan."
	const c = pr.counts
	const top = (pr.preporucenTopSignala ?? []) as { id: string; title: string }[]
	const conflicts = (pr.konflikti ?? []) as unknown[]
	const lede = buildLede({
		institution: String(pr.institucija ?? "institucija"),
		findings: Number(c.nalaza) || 0,
		signals: Number(c.signala) || 0,
		attention: Number(c.pazni) || 0,
		conflicts: conflicts.length,
		heads: leadHeads(top.map((t) => t.title)),
	})
	yield call("napisi_sazetak", {
		lede,
		topSignals: top.map((t) => ({ findingId: t.id, headline: t.title })),
		toVerify: pr.predlogZaProveru ?? [],
	})
	return "Urednik: sažetak dosijea je napisan."
}

// ─── Trijaža (Mapa prioriteta): the three triage tools, upisi_red, one sentence ─────────────────────────────

async function* trijaza(): AsyncGenerator<Step, string, ToolResult> {
	const r = (yield call("trijaza_rukovodstvo")).json
	const nb = (yield call("trijaza_nabavke")).json
	const d = (yield call("trijaza_revizija")).json

	const lead =
		r?.ok === false || !r
			? "Registar ACAS nije odgovorio"
			: !r.head
				? "U registru ACAS nema tekućeg čelnika"
				: r.head.acting && r.vd?.months !== undefined
					? `Prema ACAS, čelnik je v.d. ${n(r.vd.months, "mesec")} (zakonski rok ${n(r.vd.limitMonths, "mesec")})${r.vd.overLimit ? ", signal za proveru" : ""}${r.chain ? `; institucijom rukovode samo v.d. već ${n(r.chain.totalMonths, "mesec")} (${n(r.chain.actingCount, "uzastopniVd")})` : ""}`
					: "Prema ACAS, čelnik nije vođen kao v.d."
	const buy =
		nb?.ok === false || !nb
			? "Portal javnih nabavki nije odgovorio"
			: `Portal javnih nabavki: ${n(nb.contracts, "ugovor", num(nb.contracts))}, ${n(nb.bezObjavljivanja?.count ?? 0, "postupak")} bez objave javnog poziva (${dec(nb.bezObjavljivanja?.sharePct ?? 0)}% vrednosti)`
	const audit =
		d?.ok === false || !d
			? "DRI nije odgovorio."
			: `DRI: ${n(d.total, "izvestaj")} o reviziji${d.saRezervomIliNegativna ? `; među poznatim mišljenjima: ${d.saRezervomIliNegativna} sa rezervom ili negativnih` : ""}.`
	yield call("upisi_red", { summary: `${lead}. ${buy}; ${audit}` })
	return "Trijaža završena: red je upisan u Mapu prioriteta."
}

const POLICIES: Record<string, Policy> = { kadrovik, nabavke, revizor, mediji, firme, imovina, provera, urednik, trijaza }
// (`revizor` and `mediji` take the first message: a "Povod: nalaz ..." message is a reaction to another agent's finding)

export function policyFor(group: string): Policy | undefined {
	return POLICIES[group]
}
