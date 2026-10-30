# Submission text (build.jigjoy.ai)

**Track:** Freestyle

**Project name:** Dosije

**One-liner:** From breaking news to a sourced dossier on a Serbian public institution in minutes: a team of
concurrent Mozaik agents searches public registers live, and the journalist is a member of the team.

## Description

News breaks: "the union demands the resignation of the management of Infrastruktura železnice Srbije". A journalist
must find out fast who runs the institution and whether that is within the law, where the money goes, and what the
state auditor found. Today that is half a day of manual work. Dosije does it in minutes from nine public sources,
mostly through the JSON APIs behind the state websites:
- the ACAS register of officials and their asset reports;
- the procurement portal;
- APR open data;
- DRI audit reports (PDF text);
- Integrity Watch Srbija;
- the Službeni glasnik;
- OpenSanctions and KRIK;
- news.

Every claim has a link, a date and a status: official, confirmed, unconfirmed, or differs from the register. The
dossier ends with a checklist of what still needs a human. It shows signals for verification, never verdicts.

On real data it finds:
- an acting director 17 months into a 12-month legal maximum;
- the company run only by acting directors since 2020, which the state auditor also flagged;
- 10 procedures without a public call;
- suppliers flagged by Integrity Watch;
- media calling the acting director "general director", resolved in favor of the official register.

"Mapa prioriteta" runs a list of institutions in parallel and ranks where a transition team should look first.

It runs with no API key (`npm install && npm start`) on a committed cache of real public data, with a deterministic
inference runner in Mozaik's official runner slot. With `OPENAI_API_KEY`, the same agents run on gpt-5.4-mini and
gpt-5.4.

## How the agents run concurrently

- **One runtime, one bus, no orchestrator.** `defineRuntime<DosijeState>()`. The journalist is a `createHuman`
  participant, and her actions are events on the same bus.
- **Reaction chains.**
  - `dosije.started`: four core agents start their own `runLoop` at the same moment.
  - `entity.added`: the Fabrika participant creates, joins and runs a specialist per supplier, official and company
    owner.
  - `finding.added` from another agent triggers cross-agent reactions:
    - the Kadrovik's acting-head signal sends Mediji to check the appointment coverage;
    - Nabavke's procurement signals send the Revizor after earlier audit findings, filing a corroborated finding.
  - A typical run peaks at 13-14 concurrent loops with about 20 agents.
- **Shared state.** `DosijeState extends RuntimeState` holds the case file. The Urednik computes statuses, merges
  duplicates and resolves conflicts; the official register wins. A budget in the state caps the fan-out.
- **Interception.** A `UrednikGate` on every loop rejects claims without a source, scrubs personal data, and awaits
  the journalist's approval for sensitive signals. Only that loop pauses.
- **Live search.** Every request to a public source is an `izvor.upit` event on the bus, attributed to its agent.
- **The human cascades into new work.** Her answer to "who owns company X?" (APR is behind reCAPTCHA) spawns new
  checking agents for that person.
- **Evidence:** the live timeline, `out/trace-*.jsonl`, the CLI Gantt, and the test suite (concurrency, spawning,
  blocked claims, conflicts, LLM mode against a fake OpenAI API).
