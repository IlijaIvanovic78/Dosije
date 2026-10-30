# Submission text (build.jigjoy.ai)

**Track:** Freestyle

**Project name:** Dosije

**Repository:** <GitHub URL>

**One-liner:** From breaking news to a sourced dossier on a Serbian public institution in minutes: a team of
concurrent Mozaik agents investigates live, and the journalist is a member of the team.

## Description

News breaks: "the union demands the resignation of the management of Infrastruktura železnice Srbije". A journalist
must find out fast who runs the institution and whether that is within the law, where the money goes, and what the
state auditor found. Today that is half a day of manual work across ACAS, the public procurement portal, APR, DRI PDFs
and old news.

Dosije does it in minutes. It reads 9 public sources, most through the JSON APIs behind the state websites:
- ACAS register of officials and their asset reports;
- the Portal javnih nabavki (1,537 contracts for the demo institution);
- APR open data (134k companies);
- DRI audit reports (PDF text);
- Integrity Watch Srbija;
- Službeni glasnik tables of contents;
- OpenSanctions and KRIK;
- RSS, Google News and GDELT.

Every claim has a link, a date and a status (official / confirmed / unconfirmed / refuted), and the dossier ends with
a checklist of what still needs manual verification. The system never accuses; it shows signals to verify.

On the real demo data it surfaces signals for verification:
- an acting director 17 months into a 12-month legal maximum;
- the company run only by consecutive acting directors since 2020, which the state auditor also flagged;
- 10 procedures without a public call, including the Novi Sad station building assessment after the canopy collapse;
- 8 suppliers flagged by Integrity Watch;
- a real conflict between the media ("general director") and the official register ("acting"), resolved in favor of
  the official source.

"Mapa prioriteta" runs a whole list of institutions in parallel and ranks where a transition team should look first.

It runs with no API key: `npm install && npm start`, a committed offline cache of real public data, and a
deterministic inference runner plugged in through Mozaik's official runner extension point. With `OPENAI_API_KEY` set,
the same agents run on gpt-5.4-mini and gpt-5.4.

## How the agents run concurrently

- **One runtime, one event bus.** `defineRuntime<DosijeState>()` creates it. The journalist is a `createHuman`
  participant, and her actions are events on the same bus.
- **No orchestrator.**
  - `dosije.started` makes four core agents (Kadrovik, Nabavke, Revizor, Mediji) start their own `runLoop` at the
    same moment.
  - Every `entity.added` makes the Fabrika participant `createAgent` + `join` + `runLoop` a new specialist: a Firme
    agent per supplier, Imovina and Mediji agents per official, Provera per company owner.
  - A typical run peaks at **13 concurrent loops with up to 21 agents**.
- **Shared state.** `DosijeState extends RuntimeState` holds the case file. The Urednik reacts to `finding.added`: it
  computes statuses, merges duplicates and resolves conflicts (the official source wins). A budget in the shared
  state caps the fan-out.
- **Interception.** A `UrednikGate` (`InterceptionHandler`) on every loop:
  - rejects claims without a source;
  - scrubs personal data by rewriting the call;
  - for sensitive signals, creates an inbox approval and awaits the journalist. Mozaik awaits `handle()` inside that
    loop only, so **only that agent pauses while all the others keep running**.
- **The human cascades into new work.** Her answer to "who owns company X?" (APR's search is behind reCAPTCHA) is an
  event. The asking agent wakes up, registers the person, and new Provera and Mediji agents spawn for that name.
- **Evidence.**
  - a live Gantt of all agents in the UI;
  - `out/trace-*.jsonl` (every event, written by an observer participant);
  - the CLI Gantt;
  - `npm test` (14 tests), which asserts peak concurrency, runtime spawns, a blocked unsourced claim and a conflict
    won by the official source.
