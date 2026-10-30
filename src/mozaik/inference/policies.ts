// Scripted per-group policies (docs/AGENT_BEHAVIOR.md). A policy is an async generator: every `yield` is exactly ONE tool call (what
// an LLM would emit for one step) and receives that tool's output as the next input, so a policy only uses what an LLM
// would see in its context. The scripted runner turns each yield into a Mozaik FunctionCallItem.

import { formatRsd } from "../../data/analysis/procurement"
import { formatDate } from "../../data/analysis/vd"
import { asciiFold } from "../../data/translit"
import { n } from "../../shared/plural"
import { headline } from "../../shared/text"
import { entityIdFor } from "../domain"
import { buildLede } from "../summary"
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
const isHeadTitle = (p: string) => /(direktor|predsednik|na[čc]elnik)/i.test(p) && !/(skup[šs]tin|odbor|[čc]lan|zamenik|pomo[ćc]nik|savet|komisij)/i.test(p)

// ─── Kadrovik ────────────────────────────────────────────────────────────────

async function* kadrovik(): AsyncGenerator<Step, string, ToolResult> {
	const off = (yield call("acas_funkcioneri")).json
	if (!off?.officials?.length) return "ACAS nije vratio funkcionere za ovu instituciju, pa nema nalaza o rukovodstvu."
	type O = { personId: string; name: string; position: string; acting: boolean; from?: string; to?: string; current: boolean; appointedBy?: string }
	const officials = off.officials as O[]
	const acas = srcs(off.sources)
	const current = officials.filter((o) => o.current)
	const head = current.find((o) => isHeadTitle(o.position)) ?? current.find((o) => /direktor|predsednik|na[čc]elnik/i.test(o.position))
	const others = current.filter((o) => o !== head).slice(0, 2)
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
	if (!head) return "Kadrovik: u registru nema tekućeg čelnika; uneti funkcioneri."

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
			text: `U Službenom glasniku (${first.gazette}, ${formatDate(first.date)}) objavljen je akt: „${first.title}“. Sadržaj broja navodi samo naslov akta, ne i ime imenovanog; pun tekst akta nije slobodno dostupan.`,
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
			title: `${head.name} je v.d. ${n(vd.months, "mesec")}; zakonski maksimum je ${n(vd.rule?.maxMonths ?? 12, "mesec")}`,
			text: String(vd.explanation),
			severity: "signal",
			signalCode: "VD_PREKO_ROKA",
			sources: srcs(vd.sources),
			entityIds: [entityId],
			claim: { subject: head.name, predicate: "datum_imenovanja", value: String(head.from) },
		})
	}
	return `Kadrovik: proveren čelnik ${head.name} i ${n(others.length, "funkcioner")}, rok v.d. i akt o imenovanju.`
}

// ─── Nabavke ─────────────────────────────────────────────────────────────────

async function* nabavke(): AsyncGenerator<Step, string, ToolResult> {
	const pr = (yield call("jn_pregled")).json
	if (!pr?.totalContracts) return "Portal javnih nabavki nije vratio podatke o ugovorima."
	const jnSource = srcs(pr.sources).slice(0, 1)
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
		title: `Portal javnih nabavki: ${n(pr.totalContracts, "ugovor", num(pr.totalContracts))}, ukupno ${money(pr.totalValueRsd)}`,
		text: `Prema Portalu javnih nabavki, ${pr.institution} je od ${formatDate(pr.period?.from)} do ${formatDate(pr.period?.to)} zaključila ${n(pr.totalContracts, "ugovor", num(pr.totalContracts))} ukupne vrednosti ${money(pr.totalValueRsd)} bez PDV (vrednosti pri potpisivanju${pr.contractsWithoutRsdValue ? `; za ${n(pr.contractsWithoutRsdValue, "ugovor")} u stranoj valuti nije izvršeno preračunavanje u RSD` : ""}). Koncentracija po svim ponuđačima (HHI): ${pr.hhiSviPonudjaci}.`,
		severity: "info",
		sources: jnSource,
	})

	const nwp = pr.bezObjavljivanja
	if (nwp?.count > 0) {
		const big = nwp.najveci
		yield call("add_finding", {
			section: "novac",
			title: `${n(nwp.count, "pregovarackiPostupak")} bez objavljivanja javnog poziva (${money(nwp.valueRsd)})`,
			text: `Portal javnih nabavki beleži ${n(nwp.count, "postupak")} bez objavljivanja javnog poziva (sa objavljenim ugovorom ukupne vrednosti ${money(nwp.valueRsd)}: ${nwp.saUgovorom}; bez objavljenog ugovora: ${nwp.bezUgovora}), što je ${dec(nwp.sharePct)}% ukupne vrednosti ugovora.${big ? ` Najveći: „${clip(big.title, 110)}“, ${big.supplier}, ${money(big.valueRsd)} (${formatDate(big.signedAt)}); pravni osnov naveden u postupku: ${big.procedure ?? "nije naveden"}.` : ""} Ovaj postupak je zakonski dozvoljen u propisanim slučajevima; razloge treba proveriti u odluci o pokretanju postupka.`,
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
			text: `Bez državnih preduzeća i javnih sistema (EPS, NIS, fakulteti; izuzeto ${money(pr.javniSistemi?.iskljuceno)}) firma ${k.topName} učestvuje, samostalno ili u zajedničkim ponudama, u ugovorima vrednosti ${money(k.topValueRsd)}, što je ${dec(k.topSharePct)}% preostale vrednosti (${money(k.vrednostBezJavnihSistema)}); HHI po ponuđačima: ${k.hhiBezJavnihSistema}. Vrednost zajedničke ponude nije vrednost jedne firme. Koncentracija sama po sebi nije nepravilnost, ali je razlog za dalju proveru.`,
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
export function driTitle(year: number | string | undefined, kind: string | undefined, excerpt: string): string {
	const body = excerpt
		.replace(/…$/u, "")
		.replace(/^(?:zaklju[čc]ak|nalaz|otkrivena nepravilnost|prioritet)\b[^:]{0,12}:\s*/i, "")
		.replace(/^(?:međutim|pored toga|takođe|navedeno)\b,?\s*/i, "")
		// an introductory clause ("U skladu sa ovim odredbama Zakona i Pravilnika, ...") says nothing: start at the statement
		.replace(/^(?:u skladu sa|s obzirom (?:da|na)|kao što je|za|prema|zbog)\s[^,]{5,90},\s+(?=\p{L})/iu, "")
	const cut = body.search(/,?\s+(?:što|jer|odnosno)\s|;|\s\(Napomena/i)
	const clause = cut >= 40 ? body.slice(0, cut) : body
	const topic = DRI_TOPICS.find(([re]) => re.test(excerpt))?.[1] ?? kind ?? "izveštaj"
	return `DRI ${year ?? ""} · ${topic}: ${headline(clause, 90)}`.replace(/\s+/g, " ")
}

async function* revizor(): AsyncGenerator<Step, string, ToolResult> {
	const list = (yield call("dri_izvestaji")).json
	type R = { id: string; title: string; year?: number; publishedAt?: string; kind?: string }
	const reports = ((list?.reports ?? []) as R[]).slice().sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""))
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
		const label = `${nz.kind ?? "izveštaj"} za ${nz.year ?? "?"}. godinu`
		const sources = srcs(nz.sources)
		if (nz.opinion) {
			const op = String(nz.opinion)
			const severity = /negativ|uzdr/i.test(op) ? "signal" : /rezerv/i.test(op) ? "paznja" : "info"
			findings++
			yield call("add_finding", {
				section: "revizija",
				title: `DRI ${nz.year} · ${nz.kind ?? "revizija"}: ${op}`,
				text: `Državna revizorska institucija je u izveštaju (${label}, objavljen ${formatDate(nz.publishedAt)}) izrazila ${op}.${nz.excerpts?.[0] ? ` Izvod iz izveštaja: „${clip(String(nz.excerpts[0]), 300)}“` : ""}`,
				severity,
				signalCode: "DRI_MISLJENJE",
				sources,
			})
		}
		const excerpts = ((nz.excerpts ?? []) as string[])
			.filter((e) => e.length > 80 && !/^po na[šs]em mi[šs]ljenju/i.test(e) && !/Preporuka broj|^Rezime\b|Rezime (?:nalaza|datih)/i.test(e))
			.map((e) => ({ e, s: excerptScore(e) }))
			.sort((a, b) => b.s - a.s)
			.slice(0, 2)
		for (const { e, s } of excerpts) {
			findings++
			yield call("add_finding", {
				section: "revizija",
				title: driTitle(nz.year, nz.kind, e),
				text: `Prema izveštaju DRI (${label}, ${formatDate(nz.publishedAt)}): „${clip(e, 400)}“ Doslovan izvod; pun kontekst je u izveštaju.`,
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
	if (!res || res.ok === false) return `Mediji: pretraga nije dostupna (${clip(String(res?.error ?? "nema rezultata"), 80)}).`
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

async function* mediji(c: PolicyCtx): AsyncGenerator<Step, string, ToolResult> {
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
	const owners = answer
		.split(/\s*(?:,|;|\bi\b)\s*/)
		.map((s) => clip(s, 80))
		.filter((s) => s.length > 3)
		.slice(0, 2)
	if (!owners.length) return "Firme: odgovor novinarke je prazan."
	const source = { kind: "novinar", title: "Novinar: unos nakon ručne provere u APR pretrazi", url: APR_SEARCH }
	for (const owner of owners) {
		yield call("add_entity", { kind: "osoba", name: owner, role: "vlasnik", attrs: { firma: firm }, sources: [source] })
	}
	yield call("add_finding", {
		section: "firme",
		title: `Vlasnik firme ${clip(firm, 40)}, prema novinarki: ${owners.join(", ")}`,
		text: `Novinarka je nakon ručne provere u APR pretrazi navela da je vlasnik firme ${firm}: ${owners.join(", ")}. Sistem ovaj podatak nije nezavisno potvrdio; sledi provera da li se osoba pojavljuje u registru funkcionera i na PEP listama.`,
		severity: "info",
		sources: [source],
	})
	return `Firme: upisan vlasnik (${owners.join(", ")}) prema odgovoru novinarke; pokrenuta provera osobe.`
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
	const acasRegister = { kind: "acas", title: "ACAS – Registar funkcionera i izveštaji o imovini", url: "https://publicacas.acas.rs/#/acas/funkcioner" }
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
			text: `Nije pronađen izveštaj o imovini nakon stupanja na funkciju (${formatDate(from)}); najnoviji u registru je od ${formatDate(latest.reportDate)}. Proveriti.`,
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
	const registerSource = { kind: "acas", title: "ACAS – Registar funkcionera", url: "https://publicacas.acas.rs/#/acas/funkcioner" }

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
		heads: top.slice(0, 3).map((t) => clip(t.title, 80)),
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

export function policyFor(group: string): Policy | undefined {
	return POLICIES[group]
}
