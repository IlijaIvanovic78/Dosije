# Dosije design system: "a clean, modern research tool"

The product is a research instrument for journalists. It should feel like a well-made modern product (clean cards,
clear states, generous spacing) that a newsroom would trust, **not** a sci-fi AI dashboard and not a bare HTML page.
Anyone looking at the screen for five seconds should be able to say what is happening: how many agents work right now,
who waits for the journalist, and what the dossier already says.

**What to avoid:**
- dark navy with neon purple or cyan, glows, glassmorphism, shimmer, pulsing rings;
- emojis as icons;
- giant metric tiles and marketing copy;
- old-blog typography (system serif headings on a beige page).

## Principles
1. **One flow, always visible.** The run bar shows where the run is: the team investigates → you decide → the dossier
   is ready. Each step has one obvious place on screen.
2. **Cards on a light gray page.** White cards (14px radius, 1px `--rule` border, a faint shadow) group what belongs
   together: the team, live search, the dossier header, decisions, signals, people and firms, findings.
3. **Color means state.** Blue = working / selected, amber = waiting for you, red = signal, green = official / done.
   States are soft tinted pills with text, never color alone.
4. **Calm motion.** Only a 150 ms fade for new items and a pale highlight that fades out on new findings. Nothing
   pulses, bounces or slides.
5. **No emojis.** Small monochrome inline SVG icons (`currentColor`, 1.6px stroke) or 2-letter initials.
6. **Data looks like data.** Numbers use tabular figures, identifiers are monospace, dates are `dd.mm.yyyy`.

## Tokens

| token | value | use |
|---|---|---|
| `--bg` | `#F4F5F7` | page background |
| `--surface` | `#FFFFFF` | cards, inputs, modal |
| `--sunk` / `--hover` | `#F1F3F6` / `#F8F9FB` | neutral pills, segmented controls, row hover |
| `--ink` / `--ink-2` / `--ink-3` | `#111827` / `#4B5563` / `#8B95A5` | text, secondary text, labels and meta |
| `--rule` / `--rule-strong` | `#E7E9EE` / `#D6DAE1` | card borders and separators / input borders |
| `--accent` (+ `-ink`, `-tint`) | `#2563EB` | links, focus, the active step, tool bars, the live agent count |
| `--signal` (+ `-tint`) | `#DC2626` | signals, "odstupa od registra", the "now" line |
| `--wait` (+ `-ink`, `-tint`) | `#D97706` | waiting for the journalist |
| `--ok` (+ `-ink`, `-tint`) | `#16A34A` | zvanično, done |
| `--warn` (+ `-tint`) | `#A16207` | nepotvrđeno, pažnja |
| `--think` | `#D5DBE4` | inference bars |

Statuses are pills (dot + text) on a tint of their color: **Zvanično** green, **Potvrđeno** blue, **Nepotvrđeno**
amber-brown, **Odstupa od registra** red. Severity is a 3px rule on the left edge of a finding: signal = red,
pažnja = amber, info = gray.

## Typography
- UI and headings: `"Inter", "Segoe UI Variable", "Segoe UI", system-ui, -apple-system, Roboto, sans-serif` (headings
  bold with slightly negative letter-spacing). No webfont downloads: the app must work offline.
- The printed report uses a book serif (`"Source Serif 4"`, Charter, Georgia); on screen it uses the UI font.
- Data and IDs: `ui-monospace, "SF Mono", "Cascadia Mono", Consolas, monospace`.
- Sizes: body 14.5/1.55, small 12.5-13, labels 11px uppercase with letter-spacing .07em, institution title 28px bold,
  card titles 16px semibold, finding titles 15.5px semibold, start headline 50px extra-bold.

## Components
- **Buttons.** Primary: solid `--ink`, white text, 9px radius. Secondary: white with a 1px border. Text buttons in
  `--accent`. "Odluči" on a waiting banner is solid amber.
- **Inputs.** White, 1px `--rule-strong`, 9px radius, a 3px focus ring in `--accent` at 15%. The start search is one
  large field with the primary button inside it.
- **Agent avatar.** A 22-24px rounded square with 2-letter initials, one soft tint per agent group.
- **Agent status.** A pill on the right of each lane: "razmišlja" gray, the current request ("ACAS · funkcioneri …")
  blue, "čeka tebe" solid amber, "gotovo" green, "blokirano" red.
- **Team card.** The headline is the live count ("4 agenta rade upravo sada · vrhunac 15", the number in blue; after
  the run: "15 agenata istovremeno u vrhuncu"), then a small area chart (blue line, 10% fill), the legend and the
  timeline.
- **Timeline (Gantt).** Rounded 10px bars on a shared mm:ss axis: think = `--think`, tool = `--accent`, waiting =
  amber with a 45° hatch; a finding is a 2px dark tick, a spawn a hollow circle, "now" a 1px red line.
- **Decisions.** An amber-tinted card on the dossier ("3 odluke čekaju na tebe"), one task open at a time; an approval
  shows the draft finding as it will appear in the report.
- **Done card.** Green-tinted, a check icon, a one-line summary and the next actions.
- **Toasts.** White, 12px radius, a soft shadow; question toasts have an amber left edge.

## Simplicity rules
- **Show less at once.** One top bar, one run bar, two columns of cards, one collapsible drawer.
- **Motion budget.** Only the two animations above. The timeline redraws at most 4 times per second.
- **Labels, not decoration.** Every colored mark has a text equivalent.
- **Copy** is short, plain Serbian, the way a newsroom colleague would write it. No hype and no "AI" buzzwords in
  headings.

## Live search ("Pretraga uživo")
Every public-source request an agent makes arrives as an `izvor.upit` event (`SourceActivity` in
`src/shared/types.ts`). There are two events per request with the same `id`: `u_toku`, then `ok`, `kes` or `greska`.
- **A card under the team**, newest on top. Each row reads:

  `12:04:31  KA  ACAS  pretraga · funkcioneri: Infrastruktura železnice Srbije  [✓ 0,4 s · 9]`

  the time, the agent's initials, the source, the action and label (a link when there is a `url`), and a status pill:
  "…" while `u_toku`, then green "✓ 0,4 s", gray "keš 30.10." or red "greška".
- **Agent lanes** show the agent's current request as their status pill, falling back to "alat: <tool>" or
  "razmišlja".

## Layout
The screen follows one flow: **start → the team investigates → you decide → the dossier is ready**.

- **Top bar** (white): the logo mark and wordmark "Dosije" (back to the start screen), a segmented switch "Dosije |
  Mapa prioriteta", then "+ Novi dosije", "Sanduče" (an amber count badge when something waits) and SR | EN. No model
  or mode text: a connection note appears only when the server connection drops.
- **Run bar** under the top bar: three numbered steps "Tim istražuje → Tvoje odluke → Dosije je spreman" (blue =
  running, amber = waiting for you, green check = done; step 2 opens the decisions, step 3 the report), and on the
  right the numbers as pills: "6 agenata radi istovremeno", "vrhunac 15", "31 nalaz", "5 signala", "642 Mozaik
  događaja".
- **Columns.** Left (about 40%): the team card and the live search card. Right (about 60%), a column of cards: the
  institution header, "Čeka tvoju odluku" while an agent waits, "Dosije je spreman" at the end, "Glavni signali",
  "Osobe i firme", then the findings with section tabs.
- **Start screen.** A bold headline, one paragraph, the large search field, the demo institutions as cards with an
  icon, and "Kako radi" as four numbered steps (step 3, "Ti odlučuješ", in amber). Below: the public sources as tags
  and a pointer to "Mapa prioriteta". A very faint blue glow at the top of the page is the only gradient.
- **Phones.** One column: the dossier (and its decisions) first, the team below; the start form stacks.
