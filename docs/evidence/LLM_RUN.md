# Evidence: a real LLM run (OpenAI)

On 30 October 2026, Dosije ran with real OpenAI keys for "Infrastruktura železnice Srbije":
- the case data came from the committed cache (`DATA_MODE=cache`);
- workers ran on `gpt-5.4-mini` and the Urednik on `gpt-5.4` (`npm run cli -- "Infrastruktura železnice Srbije"`);
- the same Mozaik runtime, tools, gate and shared state as in no-key mode, with only the inference runner swapped.

Every event of this run is in [`trace-llm-izs.jsonl`](trace-llm-izs.jsonl): 787 events and 122 `gpt-5.4*` inference
calls, written by the Zapisničar observer.

- **Concurrency:** a peak of 14 concurrent loops, 24 loops, 19 agents (14 spawned at runtime), in 97 s.
- **Cross-agent reactions, decided on real model output:**
  - Mediji ← Revizor (DRI procurement finding);
  - Mediji ← Kadrovik (VD_PREKO_ROKA, VD_LANAC);
  - Revizor ← Nabavke (BEZ_OBJAVE, KONCENTRACIJA).
- **The model writes its own findings and summary.** One example finding title: "V.d. status Zorana Jevtića preko
  zakonskog roka".
- **The gate in LLM mode:** in a second run the model filed one claim without a source and the UrednikGate blocked
  it (`claim.blocked`). The only conflict that run was the real one, RTV "generalni direktor" vs ACAS "v.d.
  generalnog direktora", resolved in favor of the register.

```
Gantt (~ inference, # tool, ! waiting for the journalist, . idle)
                               0s                                48s                              97s
Kadrovik                       ~~#~#~~#~#~~#~~~#~~~#~~~~~!!!!~~#~#~~...................................
Nabavke                        ~~#~~#~#~#~~#~~~#~~~#~~~#~~#~#~~#~~#~~#~~#~~#~#~~#~#~~..................
Revizor                        ~~###~#~~#~~~#~~~~#~~~..........~~~#~#~#~#~.............................
Mediji                         ~~##~~#~#~~~~#~~~~~~#~~~#~~~#~~#~~##~~#~~...............................
Urednik                        .......................................................~~#~~~~~~~#~~~~~~
Firme ┬╖ ZGOP                   .....~~#~~#~~#~~~~......................................................
Firme ┬╖ Extra - Auto Transport .......~~#~~#~~~#~~#~~#~~...............................................
Firme ┬╖ ANTIKOR                .........~~#~~~#~~~#~~#~~~..............................................
Firme ┬╖ T&M GROUP SOLUTIONS    ............~~~#~~~#~~#~~~#~~...........................................
Firme ┬╖ KBV DATACOM            ................~~~#~~~~#~~##~~~........................................
Firme ┬╖ TRIOPROJEKT            ....................~~~~#~~~#~#~~.......................................
Firme ┬╖ PROINTER SISTEM        ........................~~~#~~#~~#~#~...................................
Firme ┬╖ ANDING TRADE           ...........................~~#~~#~~~##~~#~~.............................
Imovina ┬╖ Zoran Jevti─ç         .......~~#~#~~~.........................................................
Imovina ┬╖ Neboj┼ía ┼áurlan       .........~~~~#~~~#~~~~#~~~..............................................
Imovina ┬╖ Neboj┼ía Bojovi─ç      ............~~~~~~#~~~#~~~..............................................
Mediji ┬╖ Zoran Jevti─ç          .......~~#~~#~~.........................................................
Mediji ┬╖ Neboj┼ía ┼áurlan        .........~~~~~#~~~#~~~~.................................................
Mediji ┬╖ Neboj┼ía Bojovi─ç       ............~~~~~#~~#~~.................................................

Statistika
  vrhunac: 14 petlji istovremeno ┬╖ petlji ukupno: 24 ┬╖ 19 agenata (14 pokrenutih tokom rada)
  98 poziva alata ┬╖ 122 zaklju─ìivanja ┬╖ 2 presretanja ┬╖ 0 blokiranih tvrdnji bez izvora ┬╖ konflikata izvora: 5
  35 nalaza (signala: 10) ┬╖ 12 entiteta ┬╖ 11 zadataka ┬╖ 779 Mozaik doga─æaja
  trajanje: 96.7 s


Statistika
  vrhunac: 14 petlji istovremeno ┬╖ petlji ukupno: 24 ┬╖ 19 agenata (14 pokrenutih tokom rada)
  98 poziva alata ┬╖ 122 zaklju─ìivanja ┬╖ 2 presretanja ┬╖ 0 blokiranih tvrdnji bez izvora ┬╖ konflikata izvora: 5
  35 nalaza (signala: 10) ┬╖ 12 entiteta ┬╖ 11 zadataka ┬╖ 779 Mozaik doga─æaja
  trajanje: 96.7 s
```

Reproduce it: put `OPENAI_API_KEY` in `.env`, check the keys with `npm run check-keys`, then run `npm run cli --
"Infrastruktura železnice Srbije"` or `npm start`.