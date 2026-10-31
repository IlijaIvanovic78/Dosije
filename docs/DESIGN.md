# Dosije design system: editorial research

Dosije is a research instrument for journalists, researchers, civil society and citizens. It should look like a careful
piece of investigative journalism: paper, ink and archive documents, a serif for headlines, a plain sans for data. It
must read as credible, transparent and calm, never as an AI dashboard or a generic SaaS template.

**What to avoid:** bright generic blue as the main color, purple AI gradients, neon, glassmorphism, glows, pulsing
borders; emojis as icons; giant metric tiles and marketing copy; sensational wording.

## Principles

1. **The start page has character; the working screens are about data.** Only the start page carries the desk photo
   (`public/img/desk.webp`, documents on a table, the right side of the hero; the left half is clean paper for the
   headline and the form). Everything else is paper, cards and type.
2. **Two levels of information.** First the story of the run (the phases in the run bar, how many agents work now, the
   main signals); then the full detail for whoever wants it (the timeline, every agent with its role or the reason it
   was launched, every source request, every finding with its sources). Complexity is organised, never hidden.
3. **Color means state, and always comes with words.** A status is a pill with a dot and a word; a signal is a red
   rule and the word "signal". Nothing is told by color alone.
4. **Neutral language.** A signal is "worth a closer look", never proof. Links between people, companies and the
   institution are shown as the source records them. The UI never asks the user to approve or verify anything the
   system does on its own.
5. **Calm motion.** A short fade for new rows, a pale highlight that fades on a new finding, a slow breathing dot for
   what is live. Nothing bounces or slides.
6. **Data looks like data.** Tabular figures, identifiers in monospace, dates `dd.mm.yyyy`, full names readable (wrap,
   or the whole name on hover).
7. **Formal address.** The Serbian interface addresses the user with "Vi": "Pokrenite istraživanje", "Usmerite
   istraživanje", "Vaše odluke". A Serbian string is also the key of its English translation in `public/js/i18n.js`,
   so a change of wording renames that key too.
8. **One language per run.** A dossier or a comparison is researched in the language chosen when it starts: the agents
   write in it, and the report, the summary, the comparison reasons and the server's messages follow it. Nothing is
   machine-translated; switching the interface language later changes the interface, not what the agents wrote.

## Tokens (`public/styles.css`)

| token | value | use |
|---|---|---|
| `--bg` / `--paper` | `#F4F1EA` | page background (warm paper) |
| `--surface` | `#FFFEFB` | cards, panels |
| `--sunk` | `#ECE7DC` | counts, quiet pills, empty bars |
| `--ink` | `#1F2528` | text, primary buttons |
| `--ink-2` / `--ink-3` | `#454B4E` / `#686E70` | secondary text (both pass AA on paper) |
| `--rule` / `--rule-strong` | `#E3DDD1` / `#CDC5B6` | borders, separators |
| `--accent` | `#8F5944` | terracotta: active tab, links, live things, "searching a source" in the timeline |
| `--slate` | `#3F5866` | status "official", official sources |
| `--ok` | `#2F6B47` | status "confirmed", finished phases |
| `--wait` | `#A26511` | status "unconfirmed", "notable" findings |
| `--signal` | `#A8321F` | signals, "differs from the register", errors |
| comparison areas | slate / gold `#9A7A33` / olive `#5F6B3C` / terracotta | leadership / procurement / audit / shared suppliers |

Type: **Source Serif 4** for headlines and the report, **Inter** for the interface and data, **IBM Plex Mono** for
identifiers and the timeline axis (Google Fonts, with local fallbacks). Body 15px; nothing smaller than 12px.

## Statuses

| status | color | means |
|---|---|---|
| Zvanično / Official | slate | from an official register or document; the interpretation is not thereby confirmed |
| Potvrđeno / Confirmed | green | at least two independent sources report it |
| Nepotvrđeno / Unconfirmed | amber, hollow dot | a single unofficial source |
| Odstupa od registra / Differs from the register | red, diamond | the claim differs from the official register |

A source that did not answer is a finding of its own ("the source did not respond"), never an empty section.

## Screens

- **Top bar:** the two tools ("Dosije", "Poređenje institucija") with one underline that slides to the active one, and
  on the right SR / EN and "?", which opens the guide: how it works (three steps) and how to read a dossier. Changing
  the screen fades the new one in.
- **Start:** headline, one-paragraph explanation, the institution form (name or acronym; an optional focus that opens
  and closes in place), the current institutions as cards (`data/static/examples.json`), then where the data comes
  from as a slowly moving strip of source cards (official ones marked apart; it stops on hover or with its pause
  button, and stands still for reduced motion), and a one-line statement of neutrality.
- **Investigation:** the run bar (collecting data → the Editor's summary → the dossier is ready; counters for working
  now / launched / at once at most / findings / signals, each explained on hover). Left: the agent team (live count,
  concurrency chart, legend, timeline with lanes grouped and foldable, live source searches in plain words). Right: the
  dossier (header, done card, main signals with why / whom / source / date / status, people and companies with their
  recorded link, findings by area with a reliability line).
- **Institution comparison** ("mapa" in the code): what the score is made of (four areas), the list of institutions
  (one field each, or paste a list; it starts with the current institutions of `data/static/mapa-preset.json`), a
  ranking table whose score bar is split by area, details per area with sources and a way into the full dossier. A
  high score is never presented as wrongdoing.
- **Report:** a document on paper: serif headings, rules between sections, sources as links; print / PDF and Markdown.
