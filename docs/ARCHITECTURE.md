# Dosije: architecture and build spec

> Internal source of truth for everyone building Dosije. `README.md` is the public summary.
> Contracts live in code: `src/shared/types.ts` (domain + wire) and `src/data/types.ts` (normalized data).

## 1. Product

**Breaking news hits:** "Sindikat traži ostavku rukovodstva Infrastrukture železnice". A journalist types the
institution (or pastes the news link) and within minutes gets a **dosije**:

- who runs the institution, since when, appointed by whom, and whether the appointment fits the legal limits;
- where the money goes (contracts, suppliers, negotiated procedures without publication);
- what the state auditor (DRI) found;
- what the media report, and where reports conflict with official registers.

Every claim carries a **source link, a date and a status** (zvanično / potvrđeno / nepotvrđeno / odstupa od registra; the last one is
the contract code `demantovano`: a headline that names a function differently than the register is not a denial),
plus a list of **what still needs manual verification**. A team of **concurrent Mozaik agents** builds it live on
screen. The journalist is a **participant on the same event bus** (`createHuman`): she answers questions the
system cannot answer from open data (e.g. company owners behind reCAPTCHA) and approves sensitive signals.

**The system never accuses.** It surfaces *signals for verification*; the human decides.

Users: journalists and researchers (N1, Danas, KRIK, 021, Južne vesti); transition teams and new directors
("popis stanja": contracts in progress, audit findings, who holds which function and on what basis); unions,
whistleblowers and citizens checking whether public data confirms a claim.

**Demo case: Infrastruktura železnice Srbije a.d. (IŽS).** Facts verified by the team are in section 9.

## 2. Hard rules (every contributor)

1. **Never fabricate facts about real people or companies.** Every finding comes from a fetched public source
   (cached) or from the journalist. If a source cannot be fetched, the feature degrades (fewer findings); it never
   invents. Dev mocks must use clearly fictional names ("Primer d.o.o.", "Petar Petrović").
2. **Signals, not accusations.** Wording such as "signal za proveru", "prema podacima ACAS", "nije potvrđeno".
   Never state "korupcija", "nezakonito" or "kriminal" as fact.
3. **No personal contact data.** ACAS returns officials' phone/e-mail: drop it in the adapter, never cache or show it.
4. **Everything goes through `cached()`** (`src/data/cache.ts`), so the demo runs offline with `DATA_MODE=cache`.
5. **Cross-platform**: Windows/macOS/Linux, Node >= 20, run with `tsx`, no build step, no native deps, use
   `path.join`. On Windows PowerShell call `npx.cmd` / `npm.cmd` (`npm.ps1` is blocked by execution policy).
6. **Dependencies are fixed**: `@mozaik-ai/core@4.2.0`, `dotenv`, `fast-xml-parser`, `csv-parse`, `unpdf`,
   `tsx`, `typescript`. Do not add packages. If something is truly impossible without one, say so in your report.
7. **Style**: TypeScript, tabs, double quotes, no semicolons (match `src/data/*.ts`). Comments only where the code
   is not obvious. User-facing strings in Serbian (Latin script). Do not run git commands (the orchestrator commits).
8. **Tool outputs to the LLM are compact JSON (<= 4,000 chars)**; truncate lists and include ready-made `SourceRef`s
   so an agent can copy them into `add_finding`.
9. **Be polite to public servers**: `http.ts` limits per-host concurrency; add small delays in bulk crawls; cache.
10. **Serbian number agreement**: every generated text with a count uses `src/shared/plural.ts` (`n(3, "ugovor")` -> "3 ugovora"; one/few/many); text is cut at word boundaries (`src/shared/text.ts`), never mid-word.
11. **Precision before volume**: a datum is shown only if it provably belongs to the institution (news: `src/data/newsMatch.ts`; DRI: title names it; JN: tender belongs to its CAId; IW/ACAS: authority name matches). `npm run qa` checks this on the six preset institutions and writes `docs/QA.md`.

## 3. Repository layout and ownership

```
src/shared/types.ts            domain + wire contracts                      (orchestrator)
src/data/types.ts              normalized data types                        (orchestrator)
src/data/http.ts cache.ts translit.ts   shared helpers                      (orchestrator)
src/data/sources/acas.ts       ACAS officials, person search, assets        (data-acas)
src/data/sources/paragraf.ts   appointment acts (Službeni glasnik)          (data-acas)
src/data/sources/pep.ts        OpenSanctions / KRIK PEP cross-check         (data-acas)
src/data/rules/vdRules.ts      legal limits for acting heads (v.d.)         (data-acas)
src/data/sources/jnportal.ts   Portal javnih nabavki                        (data-jn)
src/data/sources/integrityWatch.ts  Integrity Watch Srbija CSV              (data-jn)
src/data/sources/apr.ts        APR open data                                (data-apr)
src/data/sources/dri.ts        DRI reports + PDF excerpts                   (data-media)
src/data/sources/news.ts       RSS, Google News RSS, GDELT, Serper, Brave   (data-media)
src/data/resolver.ts           Razrešavač: query/URL -> InstitutionRef      (core)
src/data/index.ts              data facade used by tools                    (core)
src/mozaik/**                  runtime, state, participants, tools, gate    (core)
src/server.ts                  HTTP + SSE + REST                            (core)
public/**                      UI: plain HTML/CSS/JS ES modules, no build   (frontend)
scripts/probe-<source>.ts      live probes that warm the cache              (data agents)
scripts/mock-server.ts         fake SSE/REST server for UI development      (frontend)
scripts/warm-cache.ts cli.ts   cache warmer, headless run                   (core)
test/*.test.ts                 node:test via tsx                            (core)
data/cache/<source>/*.json     committed demo cache (normalized, PII-free)
docs/data-sources/<source>.md  endpoint notes written by each data agent
```

## 4. Data layer

### 4.1 Modes
`DATA_MODE=auto|cache|live` (see `cache.ts`). The demo institution (IŽS) must be served 100% from the committed
cache. Other institutions work live in `auto` mode when the sites are up. `DATA_MODE=cache` is **read-only**: `writeCache` writes nothing,
so `npm test`, `npm run qa` and demos leave `data/cache` untouched. Negative results (a resolver miss, an empty search for an unknown name,
no officials / reports / acts) are returned but not cached (`cached(..., {skipWrite})`), so a curious visitor does not fill the cache.
`npm run qa` writes its report to `out/qa.md`; `docs/QA.md` only with `--write-docs`.

### 4.2 Adapters: required exports (exact names)

All functions are `async`, return normalized types from `src/data/types.ts`, cache through `cached(source, cacheKey(...), fetcher)`,
strip PII and attach a `SourceRef` with a **public** URL.

| file | exports |
|---|---|
| `acas.ts` | `findInstitution(name)` -> `{id,name,nameCyr,source}[]` (accepts Latin, converts with `latToCyr`) · `getOfficials({acasId?,name,nameCyr?})` -> `Official[]` (current + recent functions in that institution) · `searchPerson(fullName)` -> `Official[]` (all functions of matching persons) · `getAssetReports(personId, fullName?)` -> `AssetReport[]` |
| `paragraf.ts` | `findAppointmentActs(institutionName, personName?)` -> `AppointmentAct[]` |
| `pep.ts` | `matchPep(fullName)` -> `PepMatch[]` |
| `rules/vdRules.ts` | `VD_RULES: VdRule[]` · `ruleFor(legalType)` · `monthsBetween(fromIso, toIso)` -> `{months, days}` |
| `jnportal.ts` | `findAuthority(nameOrPib)` -> `{id,name,pib?,mb?,source}[]` · `getContracts({jnId?,name,pib?})` -> `Contract[]` · `getSummary(inst)` -> `ProcurementSummary` · `getContractsWithSupplier(inst, {pib?,mb?,name?})` -> `Contract[]` |
| `integrityWatch.ts` | `getLinksForAuthority({name,pib?})` -> `IntegrityWatchLink[]` · `getLinksForSupplier({pib?,mb?,name?})` -> `IntegrityWatchLink[]` |
| `apr.ts` | `getCompany({mb?,pib?,name?})` -> `CompanyProfile \| null` · `findInstitutionCompany(name)` -> `CompanyProfile \| null` |
| `dri.ts` | `getReports({name,nameCyr?})` -> `AuditReport[]` (list, no excerpts) · `getReportFindings(report)` -> `AuditReport` (with excerpts) |
| `news.ts` | `searchNews(query, {days?,limit?,kind?,aliases?,context?,exclude?})` -> `NewsItem[]` (precise, merged, deduped, ranked by relevance then recency; queries built by `newsPlan.ts`, rules in `newsMatch.ts`) · `fetchArticle(url)` -> `ArticleText` · `availableProviders()` -> `string[]` |

Search providers in `news.ts`: free and always on: outlet RSS (N1, Danas, Nova, Vreme, Insajder, 021, RTS, Južne
vesti, raspadsistema), Google News RSS (exact phrase, Latin and Cyrillic, both language editions, aliases such as "IŽS"), GDELT DOC API. Optional with keys: `SERPER_API_KEY` (Serper.dev, Google
results) and `BRAVE_API_KEY` (Brave Search News). Missing keys are skipped silently.

### 4.3 Facade (core)
`src/data/index.ts` exports `resolveInstitution(query)` plus the adapters as namespaces (`acas`, `jn`, `iw`,
`apr`, `dri`, `news`, `pep`, `paragraf`, `rules`). The resolver accepts a name, an alias ("IŽS") or a news URL
(fetches the article, matches a known institution, extracts person names).

## 5. Mozaik design (core)

### 5.1 Runtime and shared state
- `src/mozaik/runtime.ts`: `export const { initializeRuntime, resolveRuntime, resolveParticipant, join, leave, sendMessage, sendEvent, runLoop } = defineRuntime<DosijeState>()`.
- `DosijeState extends RuntimeState` is **the** shared state: current case (findings, entities, conflicts, tasks,
  report), `budget`, `stats`, `agentInfo: Map<id, AgentInfo>`, `names: Map<id, string>` (survives `leave`),
  `activeLoops: Map<loopId, {agentId, startedAt}>`, `pendingApprovals: Map<taskId, resolver>`. All mutation goes
  through methods; every mutation is followed by the matching domain event (`sendEvent`) from the participant that
  caused it.

### 5.2 Participants

Core agents (created at boot, joined once):

| agent | group | reacts to | tools |
|---|---|---|---|
| Kadrovik | kadrovik | `dosije.started` | `acas_funkcioneri`, `vd_provera`, `paragraf_akti` + common |
| Nabavke | nabavke | `dosije.started` | `jn_pregled`, `jn_ugovori_dobavljaca`, `iw_veze` + common |
| Revizor | revizor | `dosije.started` | `dri_izvestaji`, `dri_nalazi` + common |
| Mediji | mediji | `dosije.started` | `vesti_pretraga`, `vest_tekst` + common |
| Urednik | urednik | `finding.added` (dedupe, statuses, conflicts: deterministic), `odgovor.coveka` (resolves approvals), loop tracking (completion), `dosije.zatvori` | `dosije_pregled`, `napisi_sazetak` (final summary loop) |

Dynamic agents (spawned by the **Fabrika** participant on `entity.added`, budget-limited, `leave()` when done):

| agent | trigger | tools |
|---|---|---|
| Firme · *firma* | `entity.added` kind=firma | `apr_firma`, `firma_signali`, `iw_veze_dobavljaca` + common (`ask_human` for owners) |
| Imovina · *osoba* | `entity.added` kind=osoba, role=funkcioner | `acas_imovina` + common |
| Mediji · *osoba* | `entity.added` kind=osoba | `vesti_pretraga`, `vest_tekst` + common |
| Provera · *osoba* | `entity.added` kind=osoba, role=vlasnik (usually from the journalist's answer) | `acas_pretraga_osobe`, `pep_provera` + common |

Reactions of core agents (situation handlers on `finding.added` produced by ANOTHER agent, see 5.3): the handler publishes `agent.reakcija`
(`{agentId, agentName, reaction: {findingId, fromAgent, signalCode, title, at}}`, producer = the reacting agent), appends the reaction to
`AgentInfo.reactions` (reset with every case) and starts the loop. The reaction is visible in the timeline (the loop's first message
`Povod: nalaz <agent>: <title>`), in `AgentInfo`, in the CLI log (`↳ reakcija na nalaz Kadrovik · VD_LANAC: ...`) and in the report
("Kako je nastao"). Each fires at most once per case and trigger code (`DosijeState.reacted`).

Humans and observers:
- **Novinar** (`createHuman`): the journalist. REST endpoints publish on her behalf: `dosije.started`,
  `odgovor.coveka`, `entity.added` (leads), `dosije.zatvori`.
- **Fabrika** (`createHuman`, handlers only): reacts to `entity.added`, checks the budget in shared state,
  `createAgent` + `join` + `runLoop`. (Same idea as baro's StoryFactory.)
- **SSE most** (observer): matches every event, forwards a sanitized `WireEvent` to all browsers.
- **Zapisničar** (observer): appends every event to `out/trace-<caseId>.jsonl` (concurrency evidence).

### 5.3 Reaction map (compose by reaction, not orchestration)

| event (producer) | who reacts | reaction |
|---|---|---|
| `dosije.started` (Novinar) | Kadrovik, Nabavke, Revizor, Mediji | each starts its own `runLoop` at the same moment |
| `entity.added` firma (Nabavke) | Fabrika | spawns *Firme · X* (top suppliers, budget) |
| `entity.added` osoba funkcioner (Kadrovik) | Fabrika | spawns *Imovina · X* and *Mediji · X* |
| `entity.added` osoba vlasnik (Novinar / agent after an answer) | Fabrika | spawns *Provera · X* and *Mediji · X* |
| `finding.added` (any agent) | Urednik | dedupe/merge, status, conflict check (official source wins) -> `finding.updated`, `conflict.resolved` |
| `finding.added` VD_PREKO_ROKA / VD_LANAC (**Kadrovik**) | Mediji | **cross-agent reaction**: a new Mediji loop (fresh context, via `startAgentLoop`) with a targeted media check of the appointment: do outlets say "v.d." or "direktor"? (`vesti_imenovanje`; a finding with real articles and, if new, a `funkcija` claim for the Urednik's conflict check). First message `Povod: nalaz Kadrovik: <title> [f3 · VD_LANAC]`. Once per case and code (and per person). |
| `finding.added` BEZ_OBJAVE / KONCENTRACIJA (**Nabavke**) | Revizor | **cross-agent reaction**: a new Revizor loop that searches the cached DRI excerpts for an earlier finding on the same topic (`dri_srodni_nalazi`) and adds a corroboration finding "DRI je u izveštaju <za 2019. / objavljenom ...> već utvrdio nalaz o ..." whose sources are the DRI report AND the Nabavke finding's procurement source (`potkrepljuje` = the Nabavke finding; the Urednik adds a note to it). First message `Povod: nalaz Nabavke: <title> [f7 · BEZ_OBJAVE]`. Nothing is added when no related excerpt exists. |
| `finding.added` DRI_NALAZ about procurement or acting heads (**Revizor**) | Mediji | **cross-agent reaction**: a new Mediji loop that reads the shared state (`dosije_pregled`), then searches the coverage of that audit topic for the institution (`vesti_tema_revizije`: the cached institution search, plus the head's person search for acting heads) and files a neutral finding "Mediji o temi revizije „<tema>“: N članaka" **only with real articles** (headline or lead names the topic). First message `Povod: nalaz Revizor: <title> [f12 · DRI_NALAZ]. Tema revizije: <tema>. ...`; `agent.reakcija` carries `reaction.tema`. Once per case and topic (`javne nabavke`, `vršioci dužnosti`). |
| `mapa.red` (Trijaža agents) | Urednik | **cross-institution coordination**: `updateLinks()` compares the top suppliers (name + PIB) that the Trijaža tools put into the shared state; a supplier among the top 8 of 2+ institutions -> `mapa.veza` (once per link, again when an institution joins it) and every affected row gets `signals.sharedSuppliers`, +5 points (max +10) and the reason line "Isti dobavljač u N institucije: <naziv>" (`mapa.red` from the Urednik) |
| `pitanje.za_coveka` (agent or gate) | SSE most -> UI inbox | journalist sees the question |
| `odgovor.coveka` (Novinar) | Urednik (approvals), the asking agent (questions) | resolve the awaited approval / start a new loop with the answer (e.g. owner name -> `add_entity` -> cascade) |
| `message_received.started` / `model.answer` (any) | Urednik | track active loops; idle for 2.5 s -> final summary loop -> `dosije.zavrsen` |
| `dosije.zatvori` (Novinar) | Urednik | finalize now; pending approvals auto-rejected |
| every event | SSE most, Zapisničar | stream to UI, append to trace |

### 5.4 Loops
- **Fresh context per loop:** `ModelContext.create().addContextItem(DeveloperMessageItem.create(agent.getDeveloperMessage()))`.
  Never pass `agent.getMemory().getContext()` to two concurrent loops (contexts are mutated in place).
- **Tools per loop:** `inferenceInput.tools = makeTools({agentId, caseId})`, so each tool knows who called it and
  becomes a no-op for a stale case.
- **One `UrednikGate` instance per loop** (4th argument of `runLoop`).
- **Prompt rule: one tool call per step.** Mozaik 4.2 executes only the first function call of an inference output.
- Agent instructions are Serbian and start with a marker line `[[agent:<group>]]` (used by the scripted runner).

### 5.5 Tools catalog

Common (every worker agent):
- `add_finding({section, title, text, severity, signalCode?, sources:[{kind,title,url,publishedAt?,official?}], entityIds?, claim?:{subject,predicate,value}})`
  -> `{ok, findingId}`. Status is computed by the Urednik from sources (official -> zvanično, >= 2 independent
  -> potvrđeno, else nepotvrđeno). Passes through the gate first. Optional `potkrepljuje: <findingId>` (reactions only): this finding
  backs up another agent's finding with an independent source (stored as `Finding.corroborates`).
- `add_entity({kind, name, role?, attrs?, sources?})` -> `{ok, entityId, duplicate}`. Emits `entity.added`.
- `ask_human({question, title?, hint?, links?, entityName?})` -> `{ok, taskId}`. Non-blocking: the loop continues;
  the answer arrives later as `odgovor.coveka` and starts a new loop.
- `dosije_pregled()` -> compact view of shared state (awareness of what others found).

Source and analysis tools (thin wrappers over the data facade; analysis is deterministic code):

| tool | returns |
|---|---|
| `acas_funkcioneri()` | officials of the case institution + sources |
| `vd_provera({personId})` | `{person, position, from, today, months, days, rule, overLimit, daysOver, explanation, sources}` |
| `paragraf_akti({personName?})` | appointment acts |
| `jn_pregled()` | `ProcurementSummary` (compact) |
| `jn_ugovori_dobavljaca({pib?, mb?, name?})` | top contracts with that supplier |
| `iw_veze()` / `iw_veze_dobavljaca({pib?, name})` | Integrity Watch links |
| `apr_firma({mb?, pib?, name?})` | `CompanyProfile` |
| `firma_signali({mb?, pib?, name})` | `{profile, contracts:{count,valueRsd,first,last}, signals:[{code,label,detail}], sources}`: contracts > annual revenue, founded < 12 months before the first contract, < 10 employees with > 50M RSD, IW link |
| `acas_imovina({personId?, name})` | `AssetReport[]` |
| `acas_pretraga_osobe({name})` | `Official[]` (is this person an official?) |
| `pep_provera({name})` | `PepMatch[]` |
| `dri_izvestaji()` / `dri_nalazi({reportId})` | audit reports / excerpts (`period` = audited period, only when the report's title states it). `excerpts` are filtered in `src/mozaik/driText.ts`: only whole-sentence quotes that describe an irregularity or a recommendation (neutral/positive compliance statements, page headers, "Page N", cut-off sentences are dropped); `misljenjeIzvod` is the opinion sentence when it is whole |
| `vesti_tema_revizije({tema})` | Mediji's reaction to a Revizor finding: articles whose headline/lead names the audit topic (`javne nabavke` / `vršioci dužnosti`) for the institution, plus how many findings the dossier already holds on it |
| `dri_srodni_nalazi({nalazId})` | Revizor's reaction: the best not yet used cached DRI excerpt on the topic of a Nabavke finding (BEZ_OBJAVE / KONCENTRACIJA), with the report's sources and the finding's procurement source |
| `vesti_imenovanje({ime})` | Mediji's reaction: only articles whose headline or lead names the person (given name AND surname) together with an appointment/function word (imenovan, postavljen, direktor, v.d., vršilac), each classified "v.d." / "direktor" / "drugo"; `clanakSaFunkcijom` is the ONE article that states the function (the only source of a `funkcija` claim), `navodVecUDosijeu` says whether the dossier already holds it |
| `vesti_pretraga({query, days?, tip?, kontekst?})` / `vest_tekst({url})` | `{pregled: {naslov, tekst, ukupno, izvori[<=12]}, clanci}` (institution: 12 months, aliases; person: 2 years, article must name person AND institution/firm) / article text |
| `dosije_pregled()` / `napisi_sazetak({lede, topSignals, toVerify})` | Urednik only |

### 5.6 Interception: `UrednikGate implements InterceptionHandler`
Matches `function_call` transitions. Policies, in order:
1. **Budget**: loop tool calls > `maxToolCallsPerLoop`, or budget exhausted -> skip the call; the output tells the
   agent to wrap up.
2. **PII scrub**: rewrite args of `add_finding`/`add_entity` (strip phone numbers and e-mails) with
   `FunctionCallItem.rehydrate({callId, name, args})`.
3. **Source gate**: `add_finding` without at least one valid `http(s)` source -> publish `claim.blocked`, append
   `[call, FunctionCallOutputItem.create(callId, "ODBIJENO: ...")]` to `inferenceInput.context`, return
   `{nextStateId: "inference", input: inferenceInput}`. The agent must retry with a source or drop the claim.
4. **Sensitive approval**: `add_finding` with severity `signal` and signalCode in `VD_PREKO_ROKA`,
   `VLASNIK_FUNKCIONER`, `POLITICKA_VEZA` (or naming a person) -> create a blocking `HumanTask` (kind
   `odobrenje`), publish `pitanje.za_coveka`, then **await** the decision (a Promise in
   `state.pendingApprovals`, resolved by the Urednik when `odgovor.coveka` arrives). Approve -> execute (approval
   `approved`). Reject -> skip with output "Novinar je odbio ...". **Only this agent's loop is suspended; every
   other loop keeps running.** That is the point the UI must make visible.

The gate never throws (try/catch; on error return the original transition).

### 5.7 Inference
- **LLM mode** (`OPENAI_API_KEY` set; Anthropic/Gemini auto-detected as fallback): `ResilientInferenceRunner`
  finds the model in Mozaik's `supportedModels`, calls `endpoint.infer`, with a global semaphore
  (`LLM_CONCURRENCY`), retries on 429/5xx/timeouts (3 attempts, backoff), a 90 s timeout, and on final failure
  returns a `ModelMessageItem` ("Agent nije uspeo: ...") so the loop ends with `model.answer`. **`runLoop` does not
  catch errors; an exception there is an unhandled rejection that kills the process.** Token usage goes into the
  budget. Default models: workers `gpt-5.4-mini` (reasoning `low`), Urednik `gpt-5.4`.
- **Scripted mode** (no key): `ScriptedInferenceRunner` with deterministic per-agent policies. It reads the
  `[[agent:<group>]]` marker and the `function_call_output` items in the context to choose the next single
  `FunctionCallItem` (via `FunctionCallItem.rehydrate`) or the final `ModelMessageItem`. Latency is simulated
  (500-1600 ms x `DEMO_SPEED`). Same tools, gate, events and state as LLM mode; only the model call is replaced
  through Mozaik's official `inferenceRunnerConfig.runner` extension point.
- `process.on("unhandledRejection")` is a logging safety net.

### 5.8 Completion
The Urednik tracks loops: +1 on `message_received.started`, -1 on `model.answer` (by `loopId`). When there are no
active loops for 2.5 s and no pending spawns -> final Urednik loop -> `dosije.zavrsen` with the report (Markdown
from `src/mozaik/report.ts`). `dosije.zatvori` forces finalization.

### 5.9 Budget defaults
`maxFirme` 8 (top suppliers by value), `maxOsobe` 6, `maxLoops` 40, `maxToolCalls` 400, `maxToolCallsPerLoop` 24,
`maxTokens` 1,500,000. Visible in the UI.

### 5.10 Mapa prioriteta (additive)
A list of institutions (default `data/static/mapa-preset.json`, at most 8) goes through the same runtime in parallel.
`DosijeState.mapa` is a slice separate from the case (`{id, status, startedAt, finishedAt, rows: Map<slug, MapaRow>}`); a map
and a case are mutually exclusive (REST answers 409) and a new run replaces the previous one.

| event (producer) | who reacts | reaction |
|---|---|---|
| `mapa.started` (Novinar) | Fabrika | resolves every institution, then spawns one dynamic agent "Trijaža · <short name>" (group `trijaza`) per institution in the same tick; each runs its own `runLoop` (fresh context, per-loop tools, UrednikGate) |
| `mapa.red` (Trijaža agent, Fabrika, Urednik) | SSE bridge, Urednik | upsert of one row, after every triage tool; the Urednik also reacts to it (below) |
| `mapa.veza` (Urednik) | SSE bridge | `{mapaId, veza: {key, supplier: {name, pib}, institutions: [{slug, name, rank, share}], points, line}}`: one supplier (PIB) that is among the top 8 suppliers of 2+ institutions; `line` = "Isti dobavljač u 3 institucije: ZGOP DOO". The affected rows follow as `mapa.red` with `signals.sharedSuppliers` and the +points |
| loop end of a Trijaža agent | Urednik | finishes a row the agent did not write (all three tools ran) or marks it `error`; when every row is terminal and no triage loop is active: `mapa.zavrsena` with the ranking |

Tools: `trijaza_rukovodstvo`, `trijaza_nabavke`, `trijaza_revizija` (wrappers over the same adapters and `src/data/analysis`
functions; DRI opinions only from cache, no PDF download) and `upisi_red({summary})`, which is rejected until all three ran.
Figures and the score (`src/data/analysis/priority.ts`) are computed in code from the tool results; the model only adds the
summary. Outputs are compact JSON (<= 2,500 chars) with ready-made `sources`. A Trijaža loop uses the map id as its
"case id", so tools and gate treat the running map like a running case. A watchdog (`MAPA_TIMEOUT_MS`, default 10 min) turns
unfinished rows into errors. The Zapisničar writes `out/trace-<mapaId>.jsonl`.

### 5.11 Live search (`izvor.upit`)
Every request an agent's tool makes to a public source is visible on the bus. `buildTool` runs each tool handler inside an
`AsyncLocalStorage` context `{agentId, agentName, tool}` (`src/data/activity.ts`), so the data layer, which knows nothing about
Mozaik, can attribute a request to the agent and tool that caused it, even through `Promise.all` and memoized crawls. Adapters
wrap one request in `trackActivity()`; `cached()` takes an optional `activity` descriptor (source, kind, action, Serbian label,
public URL). A call produces two events with the same `id`: `u_toku` at the start, then `ok` (live), `kes` (cache hit, with
`cachedAt`) or `greska`, with `ms` and `items`. Live multi-page crawls add one nested activity per page ("ugovori, strana 3/16")
and per news provider; nested cache hits stay silent. `src/mozaik/activity.ts` is the bridge: it publishes each report as a real
`izvor.upit` SemanticEvent produced by the agent (so all participants see it, the SSE bridge forwards it and the Zapisničar traces
it), drops requests of a closed case or map, and publishes at most 400 requests per case (the rest only counts in
`stats.activitiesDropped`). Outside a tool (CLI probes, warm-cache, the resolver) nothing is emitted. In scripted mode the
simulated source latency is spent inside the `u_toku` -> `kes` window, so the feed shows requests in progress while the total
per tool call is unchanged. `npm run cli -- "<institution>" --pretraga` prints one line per request.

A request still `u_toku` when its case or map ends or is replaced is finished by `finalizeActivities()` (`src/mozaik/activity.ts`) with a
final `izvor.upit` (status `greska`, error `prekinuto: dosije završen` / `prekinuto: mapa završena` / `... zamenjen novim`), published before
`dosije.zavrsen` / `mapa.zavrsena`; the late result of the real request is then dropped, so a request has exactly one final event and the UI
never shows a request in flight after "Završeno".

## 6. Wire protocol
Defined in `src/shared/types.ts` (`WireEvent`, `WirePayloads`, `DosijeSnapshot`, REST list at the bottom).

## 7. UI (frontend)

**Goal:** a judge looks at one screen and sees four things:
- several agents working **at the same time**;
- the shared case file filling up live;
- the human as a team member, through the inbox and approvals that pause one agent while the others keep going;
- what each agent is **searching right now**, plus the raw Mozaik events under the hood.

**Tech:** `public/index.html` + `public/styles.css` + `public/app.js`, with ES modules under `public/js/`. There is no
build, no CDN and no webfont, so it works offline. It is vanilla JS with small render helpers, and the timeline redraws
at most 4 times per second.

**Look and feel:** the design system is [`docs/DESIGN.md`](DESIGN.md), a clean, modern research tool:
- white cards on a light gray page, a bold sans-serif type scale (the printed report keeps a book serif);
- color means state: blue working, amber waiting for you, red signal, green official or done, always as text pills;
- no emojis (initials avatars, small SVG icons) and almost no motion.

**Layout (the flow is: start, the team investigates, you decide, the dossier is ready):**
- **Start screen:** a large input for an institution or a news link (an optional focus behind "+ Dodaj fokus"), four
  example institutions, "Kako radi" in four steps, the public sources and a way into "Mapa prioriteta".
- **Top bar:** wordmark, the "Dosije | Mapa prioriteta" switch, "+ Novi dosije", "Sanduče N" and SR | EN. A connection
  note appears only when the server connection drops.
- **Run bar:** the steps "Tim istražuje → Tvoje odluke → Dosije je spreman" (clickable: step 2 opens the decisions,
  step 3 the report), plus agents working at once (peak), findings, signals and Mozaik events.
- **Left column, "Tim":**
  - a small concurrency chart;
  - one lane per agent, with the core agents first and dynamic agents grouped under "Firme", "Imovina", "Mediji ·
    osobe", "Provera" and "Trijaža", each with a thin timeline: think, tool, waiting (hatched), findings (ticks) and
    spawn (hollow circle);
  - the approval banner ("Kadrovik čeka tvoju odluku. Ostali agenti nastavljaju.");
  - **"Pretraga uživo"**: `izvor.upit` requests with source, label, link and status.
- **Right column, "Dosije":**
  - institution header;
  - **"Čeka tvoju odluku"**: the open questions (answer or skip) and approvals ("Ubaci u izveštaj" / "Odbaci") right
    on the dossier, one card open at a time; only the asking agent is paused;
  - **"Dosije je spreman"** once the report exists: what the team did, "Otvori izveštaj", "Preuzmi .md" and "Šta još
    proveriti";
  - "Glavni signali", where repeated signal codes are grouped;
  - section tabs (Rukovodstvo, Novac, Firme, Revizija, Mediji, Šta još proveriti);
  - finding rows with a severity rule, status, sources (a compact article list when there are four or more), merge
    and conflict notes.
- **Sanduče:** a side panel with the open decisions as short rows, the decision history and "Dodaj trag".
- **Report modal:** a printable document, with "Preuzmi .md", "Štampaj / PDF" (prints only the report) and "Kopiraj".
- **Mapa prioriteta:** the institution list, "Pokreni mapu" and a live ranking table with signal chips, details and
  "Otvori dosije".
- **Bottom drawer:** the raw Mozaik event log, collapsed by default.

**Robustness:** the EventSource reconnects automatically, and the server replays the current case's events after the
snapshot, so a reload rebuilds the timeline. Events are deduped by `seq`, every untrusted string is inserted as text,
and the Markdown renderer escapes first.

## 8. Config
See `.env.example`. With no key: scripted agents + cached data. `OPENAI_API_KEY` switches to real LLM agents.
`DATA_MODE`, `DEMO_SPEED`, `LLM_CONCURRENCY`, `SERPER_API_KEY`, `BRAVE_API_KEY`, `PORT`.

## 9. Verified facts (team checked with live requests, Oct 2026)
- ACAS: **Zoran Jevtić**, v.d. generalnog direktora, Infrastruktura železnice Srbije a.d., **since 2025-05-22**,
  appointed by the **Vlada** (Government).
- Portal javnih nabavki: **1,537 contracts** for IŽS with values, suppliers and PIBs; **10 negotiated procedures
  without publication**. The portal has an undocumented JSON API behind the SPA that works without login.
- DRI: **19 reports** related to IŽS.
- APR open data: free, no login, 134,374 companies, includes founding date, municipality, activity code, revenue
  2025 and employees (e.g. Telekom Srbija: 9,152 employees). Missing: owners, director, PIB, address. The APR
  server sends an incomplete TLS chain (needs an extra CA, see `HttpOptions.caFile`).
- Integrity Watch Srbija (Transparentnost Srbija): CSV 2021 to May 2026 with columns about supplier links to
  officials and political links.
- Legal limits for acting heads (v.d.): public enterprises (Zakon o javnim preduzećima, čl. 52) and state-owned
  companies (čl. 23): max 1 year; health care (čl. 117): 6 months; civil servants (čl. 67a): 6 months + 3.
- Media called Jevtić "novi generalni direktor" while ACAS lists him as "v.d.": a real conflict the Urednik resolves
  in favor of the official source.
- Oct 2026: the union demanded the resignation of IŽS management (raspadsistema.com). Context: the Novi Sad canopy
  collapse (1 Nov 2024).
- Gaps with no legal automated path: company owners/directors (APR search is behind reCAPTCHA; CompanyWall is paid
  or forbids scraping) -> human-in-the-loop questions; budget payments -> not covered.

## 10. Concurrency evidence (for the jury)
Live Gantt + sparkline in the UI; `out/trace-<caseId>.jsonl`; `npm test` asserts peak concurrent loops >= 4, at
least one blocked unsourced claim, and a resolved conflict where the official source wins.
