# Dosije design system: "editorial newsroom tool"

The product is a research instrument for journalists. It should feel like a quality newspaper's internal tool or a
public-interest data project (ProPublica, The Markup, OCCRP Aleph, KRIK), **not** a sci-fi AI dashboard.

**What to avoid** (the "AI dashboard" look):
- dark navy with neon purple or cyan;
- glows, gradients, glassmorphism, shimmer;
- pulsing rings;
- emojis as icons;
- pills on everything;
- giant metric tiles;
- marketing copy.

## Principles
1. **Typography carries the hierarchy.** Use color and boxes sparingly.
2. **One accent color.** Red is reserved for signals; amber is reserved for "waiting for you".
3. **Hairlines, not cards.** Use 1px separators and whitespace instead of nested rounded boxes with shadows.
4. **Calm motion.** Use 150-200 ms fades and a pale highlight for new items. Nothing pulses, bounces or glows.
5. **No emojis anywhere in the UI.** Use small monochrome inline SVG icons (`currentColor`, 1.5px stroke, 16px) or
   2-letter initials.
6. **Data looks like data.** Numbers use tabular figures, identifiers are monospace, and dates are `dd.mm.yyyy`.

## Tokens

| token | value | use |
|---|---|---|
| `--paper` | `#FBFAF7` | page background |
| `--surface` | `#FFFFFF` | panels, inputs, modal |
| `--ink` | `#1C1B19` | primary text, primary button |
| `--ink-2` | `#55534E` | secondary text |
| `--ink-3` | `#8A8780` | labels, axis, meta |
| `--rule` | `#E6E3DC` | hairlines |
| `--rule-strong` | `#D3CFC6` | input borders |
| `--accent` | `#1F4E79` | links, focus, selected tab, tool bars |
| `--signal` | `#B42318` | signal severity, demantovano, "now" line |
| `--wait` | `#B45309` | waiting for the journalist (amber) |
| `--ok` | `#2F6B3A` | zvanično / done |
| `--warn` | `#8A6100` | pažnja |
| `--think` | `#CFCBC2` | inference bars (neutral gray) |
| `--highlight` | `#FFF4C2` | fade-out background of a new item |

Statuses are text plus a small dot, optionally in a very light tinted 4px-radius chip (tint at 8-10% of the color):
- **Zvanično**: `--ok`
- **Potvrđeno**: `--accent`
- **Nepotvrđeno**: `--warn`
- **Demantovano**: `--signal`, with the finding title struck through

Severity is a 3px left rule on a finding row: signal = `--signal`, pažnja = `--warn`, info = `--rule-strong`.

## Typography
- Headings and the dossier/report body: `"Source Serif 4", "Source Serif Pro", "Iowan Old Style", Charter, Georgia, "Times New Roman", serif`.
- UI: `system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`.
- Data and IDs: `ui-monospace, "SF Mono", "Cascadia Mono", Consolas, monospace`.
- No webfont downloads: the app must work offline.
- Sizes:

  | role | size / line-height |
  |---|---|
  | body | 15/1.55 |
  | small | 13 |
  | labels | 11px uppercase, letter-spacing .06em, `--ink-3` |
  | page title (institution) | 28px serif |
  | section titles | 19px serif |
  | finding titles | 16px serif, 600 |

- Use `font-variant-numeric: tabular-nums` for every number that updates.

## Components
- **Buttons.** Primary: solid `--ink` with white text, 6px radius, no shadow. Secondary: white with a 1px
  `--rule-strong` border. Text buttons: `--accent`, underline on hover.
- **Inputs.** White, 1px `--rule-strong`, 6px radius, a 2px focus ring in `--accent` at 35%.
- **Tabs.** Plain text with a 2px underline for the active tab, counts in `--ink-3`.
- **Agent avatar.** A 22px circle with 2-letter initials, a neutral tint per group (all tints muted, low chroma),
  and no emoji.
- **Agent status.** Small text on the right of the lane:
  - "razmišlja" in `--ink-3`;
  - "alat: <name>" in `--accent`;
  - "čeka tebe" in `--wait`;
  - "gotovo" in `--ok`;
  - "blokirano" in `--signal`, briefly.
  - An active agent shows a small 6px dot in `--accent`. It does not pulse; it may fade.
- **Timeline (Gantt).** Newspaper data-viz style:
  - thin 8px bars, think = `--think`, tool = `--accent`, waiting = `--wait` with a 45° hatch;
  - a finding is a 2px `--ink` tick, and a spawn is a small hollow circle;
  - the axis is thin with mm:ss labels in `--ink-3`, and the "now" line is 1px `--signal`;
  - no glow.
- **Concurrency chart.** A small, quiet area chart in `--ink` at 12% fill with a 1px line, labeled "istovremeno
  aktivnih: 9 (vrhunac 13)".
- **Toasts.** White, 1px border, small shadow (`0 2px 8px rgba(0,0,0,.08)`), and an action link.
- **Inbox.** A right-side panel, white. Each task is a block separated by hairlines. An approval shows the draft
  finding as it will appear in the report. The banner reads: "Kadrovik čeka tvoju odluku. Ostali agenti nastavljaju."
- **Report modal.** It should look like a printed document: serif, max 70ch, generous margins.

## Simplicity rules (the user explicitly asked for a much simpler, calmer UI)
- **Show less at once.** One top bar, one run bar, two columns, one collapsible drawer. Nothing else is always
  on screen.
- **Motion budget.** There are only two allowed animations:
  - a 150 ms opacity fade-in for new rows;
  - a pale `--highlight` background that fades out over 1.5 s on new findings.

  No slide-ins, pulses, glows, shimmer, bouncing counters or animated gradients. The timeline redraws at most 4 times
  per second.
- **Labels, not decoration.** Every colored mark has a text equivalent.
- **Copy** is short, plain Serbian, the way a newsroom colleague would write it. No hype and no "AI" buzzwords in
  headings.

## Live search ("Pretraga uživo")
Every public-source request an agent makes arrives as an `izvor.upit` event (`SourceActivity` in
`src/shared/types.ts`). There are two events per request with the same `id`: `u_toku`, then `ok`, `kes` or `greska`.
- **In the left column, under the lanes,** a plain list "Pretraga uživo" shows the most recent requests, newest on
  top, about 10 visible with a scroll for more. Each row reads:

  `12:04:31  KA  ACAS · pretraga  funkcioneri: Infrastruktura železnice Srbije  ✓ 0,4 s · 9`

  - `KA` is the agent's initials avatar;
  - the source label;
  - the action;
  - the label, which links to `url` when present;
  - the status: a spinner-free "…" while `u_toku`, then "✓ 0,4 s" or "keš 30.10." or "greška" in `--signal`.
- **Agent lanes** show the agent's current request as its status text ("ACAS: funkcioneri …"), falling back to
  "alat: <tool>" or "razmišlja".
- Keep this panel quiet: monospace time, sans text, no icons beyond the initials.

## Layout
The screen follows one flow: **start → the team investigates → you decide → the dossier is ready**. Each step has one
obvious place on screen, so a first-time user never has to hunt for what to do next.

- **Top bar** (white, hairline bottom): the logo mark and serif wordmark "Dosije" (back to the start screen), a
  segmented switch "Dosije | Mapa prioriteta", then "+ Novi dosije", "Sanduče" (an amber count badge when something
  waits) and SR | EN. No model or mode text: a connection note appears only when the server connection drops.
- **Run bar** under the top bar: three numbered steps "Tim istražuje → Tvoje odluke → Dosije je spreman" (blue =
  running, amber = waiting for you, green check = done; step 2 opens the decisions, step 3 the report), and on the
  right the numbers that show concurrency: "9 agenata radi istovremeno · vrhunac 13 · 36 nalaza · 8 signala · 412
  Mozaik događaja".
- **Columns.** Left (about 40%) "Tim agenata": the concurrency chart, the legend, then the lanes and "Pretraga uživo".
  Right (about 60%) "Dosije" as a document:
  - an article-style header: label, institution in serif, metadata line in mono;
  - **"Čeka tvoju odluku"** (amber tint, one card open at a time) while an agent waits for the journalist;
  - **"Dosije je spreman"** (green tint) at the end: a one-line summary, "Otvori izveštaj", "Preuzmi .md", "Šta još
    proveriti";
  - "Glavni signali" as a numbered serif list;
  - section tabs, then the findings as rows.
- **Start screen.** A serif headline, one paragraph, a large search field with the primary button, the demo
  institutions as cards, and "Kako radi" as four numbered steps (step 3, "Ti odlučuješ", in amber). Below: the public
  sources as tags and a pointer to "Mapa prioriteta". No hero gradient.
- **Phones.** One column: the dossier (and its decisions) first, the team below; the start form stacks.
