# Dosije

**From breaking news to a sourced dossier on a Serbian public institution, in minutes.** A team of concurrent
[Mozaik](https://docs.jigjoy.ai) agents searches public registers live, and the journalist is a member of the team.
It shows signals for verification, never verdicts.

NTP Novi Sad Hackathon 2026 · Freestyle track · `@mozaik-ai/core` 4.2.0

![Agents working at the same time; the Kadrovik waits for the journalist while the others continue](docs/img/01-team-live.png)

## Try it in 60 seconds (no API key)

```bash
npm install
npm start          # open http://localhost:3000
```

1. Click **"Infrastruktura železnice Srbije"**. Four agents start in the same instant. Every supplier and official
   they find spawns another agent.
2. Watch **"Pretraga uživo"**: every request to a public register appears live, with the agent that made it and a link.
3. After about 10 s you will see **"Kadrovik čeka tvoju odluku"**. Open **Sanduče** and approve. Only that agent
   paused; the rest kept working.
4. The Mediji and Revizor lanes show **"reaguje na nalaz"**: agents react to each other's findings.
5. Open **Izveštaj** (exports to `.md` or PDF), then try **Mapa prioriteta**, which runs six institutions in parallel.
   Use **SR | EN** in the top bar to switch the interface language.

**How it runs without a key, and with one:**
- Without a key, a deterministic inference runner sits in Mozaik's official runner slot. Everything else is real: the
  runtime, loops, tools, events, shared state, interception, and a committed cache of real public data. It works
  offline.
- For real LLM agents, put `OPENAI_API_KEY` in `.env`. Workers use `gpt-5.4-mini` and the editor uses `gpt-5.4`.
- Requires Node 20 or newer. npm may print `allow-scripts` warnings; they are harmless.

## What it is

When news breaks about an institution, a journalist needs to know three things fast:
- who runs it, and whether that is within the law;
- where the money goes;
- what the state auditor found.

Today that is half a day across ACAS, the procurement portal, APR, DRI PDFs and old news. Dosije does it in minutes.
Every claim has a link, a date and a status, and the dossier ends with a checklist of what still needs a human. It is
built for journalists, for transition teams taking stock of an institution, and for citizens checking a claim.

## How the agents work together

- **There is no orchestrator; agents react to events on one Mozaik bus.**
  - `dosije.started` starts four loops at once.
  - `entity.added` makes the Fabrika participant spawn a specialist per supplier, official or owner.
  - `finding.added` from *another* agent triggers a reaction:
    - Kadrovik's "acting head past the limit" sends Mediji to check how outlets reported the appointment.
    - Nabavke's "no public call" sends the Revizor after earlier DRI findings.
  - The journalist's answer is an event that starts new work.
- **Shared state.** `DosijeState` holds the dossier. The Urednik merges duplicates, assigns statuses and resolves
  conflicts; the official register wins.
- **Interception.** A gate on every loop rejects claims without a source and holds sensitive signals for the
  journalist. Only that loop waits.
- **Live search.** Every source request is an `izvor.upit` event, attributed to its agent.
- **A typical run:** a peak of 13-14 concurrent loops and about 20 agents, 14 of them spawned at runtime, with about
  770 Mozaik events in about 27 s. Tests assert the concurrency, spawning, blocking and conflict resolution.

The concept-by-concept map to the code is in [docs/HOW_IT_WORKS.md](docs/HOW_IT_WORKS.md).

## What it found (real data, Infrastruktura železnice Srbije)

| Signal for verification | Source |
|---|---|
| The acting director (v.d.) has served 17 months; the legal maximum is 12 (Law 76/2023, art. 23). | ACAS, law text |
| Only acting directors since May 2020. DRI flagged an acting director serving over two years in 2020. | ACAS, DRI |
| 1,537 contracts (65.36 bn RSD). Ten negotiated procedures without a public call. | Portal javnih nabavki |
| The media say "generalni direktor", the register says "v.d.". The claim is marked as differing from the register. | ACAS vs RTV |

| ![Inbox](docs/img/02-inbox-approval.png) | ![Report](docs/img/05-report.png) | ![Mapa prioriteta](docs/img/06-mapa.png) |
|---|---|---|
| Only the asking agent pauses for approval. | The report, with sources and a verification checklist. | Six triage agents at once, one ranking. |

## Commands

| command | what it does |
|---|---|
| `npm test` | the test suite: concurrency, the cascade, interception, conflicts, LLM mode against a fake OpenAI API |
| `npm run cli -- "Srbijavoz"` | a headless dossier with an ASCII Gantt of the agents |
| `npm run mapa` | the priority map from the terminal |
| `npm run qa` | checks every finding's source, link and attribution |

## Docs

- [How it works](docs/HOW_IT_WORKS.md): Mozaik concepts mapped to code, the gate, inference modes, map scoring,
  configuration and limits.
- [Architecture](docs/ARCHITECTURE.md), [agent behavior](docs/AGENT_BEHAVIOR.md), [design](docs/DESIGN.md), and the
  [data sources](docs/data-sources/): ACAS, Portal javnih nabavki, APR, DRI, Integrity Watch, Službeni glasnik,
  OpenSanctions/KRIK and news.

MIT license for the code. Data belongs to its publishers.
