// Scripted per-group policies (docs/AGENTS.md). A policy is an async generator: every `yield` is exactly ONE tool call (what
// an LLM would emit for one step) and receives that tool's output as the next input, so a policy only uses what an LLM
// would see in its context. The scripted runner turns each yield into a Mozaik FunctionCallItem.

import { formatRsd } from "../../data/analysis/procurement"
import { formatDate } from "../../data/analysis/vd"
import { asciiFold } from "../../data/translit"
import { entityIdFor } from "../domain"
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
const money = (n: unknown) => (typeof n === "number" ? formatRsd(n) : "nepoznata vrednost")
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
				title: `Od ${formatDate(chain.since)} institucijom rukovode samo vršioci dužnosti (${chain.actingCount} uzastopna)`,
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
			title: `${head.name} je v.d. ${vd.months} meseci; zakonski maksimum je ${vd.rule?.maxMonths}`,
			text: String(vd.explanation),
			severity: "signal",
			signalCode: "VD_PREKO_ROKA",
			sources: srcs(vd.sources),
			entityIds: [entityId],
			claim: { subject: head.name, predicate: "datum_imenovanja", value: String(head.from) },
		})
	}
	return `Kadrovik: proveren čelnik ${head.name} i ${others.length} druga funkcionera, rok v.d. i akt o imenovanju.`
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
		title: `Portal javnih nabavki: ${pr.totalContracts} ugovora, ukupno ${money(pr.totalValueRsd)}`,
		text: `Prema Portalu javnih nabavki, ${pr.institution} je od ${formatDate(pr.period?.from)} do ${formatDate(pr.period?.to)} zaključila ${pr.totalContracts} ugovora ukupne vrednosti ${money(pr.totalValueRsd)} bez PDV (vrednosti pri potpisivanju${pr.contractsWithoutRsdValue ? `; ${pr.contractsWithoutRsdValue} ugovora u EUR nije preračunato` : ""}). Koncentracija po svim ponuđačima (HHI): ${pr.hhiSviPonudjaci}.`,
		severity: "info",
		sources: jnSource,
	})

	const nwp = pr.bezObjavljivanja
	if (nwp?.count > 0) {
		const big = nwp.najveci
		yield call("add_finding", {
			section: "novac",
			title: `${nwp.count} pregovaračkih postupaka bez objavljivanja javnog poziva (${money(nwp.valueRsd)})`,
			text: `Portal javnih nabavki beleži ${nwp.count} postupaka bez objavljivanja javnog poziva (${nwp.saUgovorom} sa objavljenim ugovorom ukupne vrednosti ${money(nwp.valueRsd)}, ${nwp.bezUgovora} bez objavljenog ugovora), što je ${nwp.sharePct}% ukupne vrednosti ugovora.${big ? ` Najveći: „${clip(big.title, 110)}“, ${big.supplier}, ${money(big.valueRsd)} (${formatDate(big.signedAt)}); pravni osnov naveden u postupku: ${big.procedure ?? "nije naveden"}.` : ""} Ovaj postupak je zakonski dozvoljen u propisanim slučajevima; razloge treba proveriti u odluci o pokretanju postupka.`,
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
			title: `Koncentracija: ${k.topName} učestvuje u ${k.topSharePct}% vrednosti ugovora (bez državnih preduzeća)`,
			text: `Bez državnih preduzeća i javnih sistema (EPS, NIS, fakulteti; izuzeto ${money(pr.javniSistemi?.iskljuceno)}) firma ${k.topName} učestvuje, samostalno ili u zajedničkim ponudama, u ugovorima vrednosti ${money(k.topValueRsd)}, što je ${k.topSharePct}% preostale vrednosti (${money(k.vrednostBezJavnihSistema)}); HHI po ponuđačima: ${k.hhiBezJavnihSistema}. Vrednost zajedničke ponude nije vrednost jedne firme. Koncentracija sama po sebi nije nepravilnost, ali je razlog za dalju proveru.`,
			severity: "paznja",
			signalCode: "KONCENTRACIJA",
			sources: jnSource,
			entityIds: top ? [entityIdFor("firma", top.name, { mb: top.mb, pib: top.pib })] : [],
		})
	}

	const iw = (yield call("iw_veze")).json
	const sourceByUrl = new Map(srcs(iw?.sources).map((s) => [String(s.url), s]))
	for (const l of (iw?.links ?? []) as { supplierName: string; pib?: string; mb?: string; kinds: string[]; contracts: number; valueRsd?: number; sourceUrls: string[] }[]) {
		const kinds = [...new Set(l.kinds)].join(" i ")
		const cand = cands.find((c) => c.pib === l.pib)
		yield call("add_finding", {
			section: "firme",
			title: `${l.supplierName}: označen u bazi Integrity Watch Srbija`,
			text: `Baza Integrity Watch Srbija (Transparentnost Srbija) označava firmu ${l.supplierName} kao: ${kinds}. Označenih ugovora kod ove institucije: ${l.contracts}${l.valueRsd ? `, vrednost samostalnih ugovora ${money(l.valueRsd)}` : ""}. Otvoreni podaci ne imenuju funkcionera ni stranku; podatak zahteva proveru.`,
			severity: "signal",
			signalCode: "POLITICKA_VEZA",
			sources: [...new Set(l.sourceUrls)].map((u) => sourceByUrl.get(u)).filter((s): s is Src => !!s),
			entityIds: cand ? [entityIdFor("firma", cand.name, { mb: cand.mb, pib: cand.pib })] : [],
		})
	}
	return `Nabavke: ${pr.totalContracts} ugovora, ${cands.length} dobavljača prosleđeno na proveru, ${(iw?.links ?? []).length} oznaka Integrity Watch.`
}

// ─── Revizor ─────────────────────────────────────────────────────────────────

const AUDIT_KEYWORDS = /(v\.?\s?d\.?|vr[šs]ioc|nabavk|pregovara[čc]k|nije u skladu|nepravilnost|mil\.|mlrd|dinara|ugovor)/i

function excerptScore(e: string): number {
	return (e.match(new RegExp(AUDIT_KEYWORDS, "gi")) ?? []).length
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
		const n = (yield call("dri_nalazi", { reportId: r.id })).json
		if (!n || n.ok === false) continue
		const label = `${n.kind ?? "izveštaj"} za ${n.year ?? "?"}. godinu`
		const sources = srcs(n.sources)
		if (n.opinion) {
			const op = String(n.opinion)
			const severity = /negativ|uzdr/i.test(op) ? "signal" : /rezerv/i.test(op) ? "paznja" : "info"
			findings++
			yield call("add_finding", {
				section: "revizija",
				title: `DRI (${n.year}): ${op}`,
				text: `Državna revizorska institucija je u izveštaju (${label}, objavljen ${formatDate(n.publishedAt)}) izrazila ${op}.${n.excerpts?.[0] ? ` Izvod iz izveštaja: „${clip(String(n.excerpts[0]), 300)}“` : ""}`,
				severity,
				signalCode: "DRI_MISLJENJE",
				sources,
			})
		}
		const excerpts = ((n.excerpts ?? []) as string[])
			.filter((e) => e.length > 80 && !/^po na[šs]em mi[šs]ljenju/i.test(e))
			.map((e) => ({ e, s: excerptScore(e) }))
			.sort((a, b) => b.s - a.s)
			.slice(0, 2)
		for (const { e, s } of excerpts) {
			findings++
			yield call("add_finding", {
				section: "revizija",
				title: `DRI (${n.year}, ${n.kind}): ${clip(e, 85)}`,
				text: `Prema izveštaju DRI (${label}, ${formatDate(n.publishedAt)}): „${clip(e, 360)}“ Doslovan izvod; pun kontekst je u izveštaju.`,
				severity: s > 0 ? "paznja" : "info",
				signalCode: "DRI_NALAZ",
				sources,
			})
		}
	}
	return `Revizor: pregledano ${picks.length} izveštaja DRI, upisano ${findings} nalaza.`
}

// ─── Mediji ──────────────────────────────────────────────────────────────────

type Item = { title: string; outlet?: string; publishedAt?: string; url: string; snippet?: string }
const itemSource = (i: Item) => ({ kind: "vesti", title: `${i.outlet ?? "Vesti"}: ${i.title}`, url: i.url, publishedAt: i.publishedAt })
const stripOutlet = (s: string) => s.replace(/\s+/g, " ").trim()

function lead(text: string, max = 280): string {
	const t = stripOutlet(text)
	const cut = t.slice(0, max)
	const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("; "))
	return end > 80 ? cut.slice(0, end + 1) : clip(t, max)
}

async function* medijiInstitucija(c: PolicyCtx): AsyncGenerator<Step, string, ToolResult> {
	const query = /upit: (.+?)\.(?: Fokus|$)/.exec(c.message)?.[1] ?? /Institucija: (.+?)[.(]/.exec(c.message)?.[1]?.trim() ?? "institucija"
	const res = (yield call("vesti_pretraga", { query, days: 90 })).json
	const wanted = asciiFold(query)
		.split(/[^a-z0-9]+/)
		.filter((w) => w.length > 3)
		.map((w) => w.slice(0, 5))
	const relevant = (i: Item) => {
		const hay = asciiFold(`${i.title} ${i.snippet ?? ""}`)
		return wanted.length === 0 || wanted.filter((w) => hay.includes(w)).length >= Math.ceil(wanted.length * 0.6)
	}
	const items = ((res?.items ?? []) as Item[]).filter((i) => i.url && relevant(i))
	if (!items.length) return "Mediji: nema članaka o instituciji u traženom periodu."
	let written = 0

	const union = items.find((i) => /sindikat|ostavk/i.test(asciiFold(i.title)))
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

	const others = items
		.filter((i) => i !== union)
		.map((i) => ({ i, s: (/(ugovor|nabavk|dodelila|tender|direktor|ostavk|revizij|nepravilnost)/i.test(asciiFold(i.title)) ? 2 : 0) + (i.publishedAt ?? "").slice(0, 4) }))
		.sort((a, b) => String(b.s).localeCompare(String(a.s)))
		.slice(0, 2)
		.map((x) => x.i)
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
	return `Mediji: pregledano ${items.length} članaka, upisano ${written + 1} nalaza (uključujući ponovljen pokušaj sa izvorom).`
}

async function* medijiOsoba(c: PolicyCtx): AsyncGenerator<Step, string, ToolResult> {
	const name = /Osoba: (.+?)(?:,| \(|\. )/.exec(c.message)?.[1]?.trim() ?? ""
	if (!name) return "Mediji: nije zadato ime osobe."
	yield call("dosije_pregled")
	const res = (yield call("vesti_pretraga", { query: name, days: 730 })).json
	if (!res || res.ok === false) return `Mediji: pretraga za ${name} nije dostupna (${clip(String(res?.error ?? "nema rezultata"), 80)}).`
	const items = ((res.items ?? []) as Item[]).filter((i) => i.url)
	if (!items.length) return `Mediji: nema članaka o osobi ${name} u poslednje 2 godine.`
	// same names are common: an article counts only if it names the person AND the institution (or the owned firm)
	const stems = (s: string) =>
		asciiFold(s)
			.split(/[^a-z0-9]+/)
			.filter((w) => w.length > 3)
			.map((w) => w.slice(0, 5))
	const nameStems = stems(name)
	const contexts = [/Institucija: (.+?)\. Pretraži/.exec(c.message)?.[1], /vlasnik firme (.+?)(?:\. |, |$)/.exec(c.message)?.[1]].filter((x): x is string => !!x).map(stems)
	const about = items.filter((i) => {
		const hay = asciiFold(`${i.title} ${i.snippet ?? ""}`)
		if (!nameStems.every((w) => hay.includes(w))) return false
		return contexts.some((ctx) => ctx.length > 0 && ctx.filter((w) => hay.includes(w)).length >= Math.ceil(ctx.length * 0.6))
	})
	if (!about.length) return `Mediji · ${name}: nijedan od ${items.length} članaka ne povezuje osobu sa institucijom (imenjaci su česti), pa nema nalaza.`
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
	if (!written && about[0]) {
		written++
		yield call("add_finding", {
			section: "mediji",
			title: clip(about[0].title, 150),
			text: `${about[0].outlet ?? "Medij"} (${formatDate(about[0].publishedAt)}) pominje ${name}: ${clip(about[0].snippet ?? about[0].title, 220)}`,
			severity: "info",
			sources: [itemSource(about[0])],
		})
	}
	return `Mediji · ${name}: ${items.length} članaka, upisano ${written} nalaza.`
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
	const profileText = p
		? `Prema APR (otvoreni podaci): ${p.name} je osnovana ${formatDate(p.founded)}, opština ${p.municipality ?? "nepoznata"}, šifra delatnosti ${p.activityCode ?? "nepoznata"}, ${p.employees ?? "nepoznat broj"} zaposlenih${p.revenueRsd !== undefined ? `, ukupni prihodi za ${p.revenueYear}. godinu ${money(p.revenueRsd)}` : ""}. `
		: `Firma nije pouzdano pronađena u APR otvorenim podacima (${fs.matchBasis}), pa profil nije prikazan. `
	yield call("add_finding", {
		section: "firme",
		title: `${name}: ${ct.count} ugovora sa institucijom${p ? `, osnovana ${formatDate(p.founded)}` : ""}`,
		text: `${profileText}Ugovori sa institucijom prema Portalu javnih nabavki: ${ct.count} (${ct.soleCount} samostalno, ${ct.jointCount} u zajedničkim ponudama), samostalno ${money(ct.soleValueRsd)}, vrednost zajedničkih ponuda ${money(ct.jointValueRsd)} (nije vrednost ove firme); prvi ugovor ${formatDate(ct.first)}, poslednji ${formatDate(ct.last)}.`,
		severity: "info",
		sources: jn.length ? jn : srcs(fs.sources),
	})
	for (const s of (fs.signals ?? []) as { code: string; label: string; severity: string; detail: string }[]) {
		yield call("add_finding", {
			section: "firme",
			title: `${name}: ${s.label}`,
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
	return `Firme: provereno ${name}, ${(fs.signals ?? []).length} signala${rank <= 2 ? ", postavljeno pitanje o vlasnicima" : ""}.`
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
	return `Imovina: ${reports.length} izveštaja za ${name}.`
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
		if (acasMatches.length) parts.push(`${a.distinctPersons} osoba u registru funkcionera ACAS (npr. ${acasMatches[0].position}, ${clip(acasMatches[0].institution, 60)})`)
		if (pepMatches.length) parts.push(`${pepMatches.length} unosa na PEP listama (${[...new Set(pepMatches.map((x) => x.dataset))].join(", ")})`)
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
	const lede =
		`U dosijeu o ${pr.institucija} tim agenata je prikupio ${c.nalaza} nalaza: ${c.signala} označeno kao signal za proveru i ${c.pazni} kao pažnja` +
		`${conflicts.length ? `; ${conflicts.length} konflikt(a) između izvora rešeno je u korist zvaničnog registra` : ""}. ` +
		(top.length ? `Najvažnije za proveru: ${top.slice(0, 3).map((t) => clip(t.title, 80)).join("; ")}. ` : "") +
		"To su signali za verifikaciju, ne zaključci; odluku donosi novinar."
	yield call("napisi_sazetak", {
		lede,
		topSignals: top.map((t) => ({ findingId: t.id, headline: t.title })),
		toVerify: pr.predlogZaProveru ?? [],
	})
	return "Urednik: sažetak dosijea je napisan."
}

const POLICIES: Record<string, Policy> = { kadrovik, nabavke, revizor, mediji, firme, imovina, provera, urednik }

export function policyFor(group: string): Policy | undefined {
	return POLICIES[group]
}
