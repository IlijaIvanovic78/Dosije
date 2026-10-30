# DRI (Državna revizorska institucija): izvori podataka

Adapter: `src/data/sources/dri.ts`. Cache: `data/cache/dri/`. Probe: `scripts/probe-media.ts`.
Exports: `getReports({name, nameCyr?})` (lista, bez izvoda) i `getReportFindings(report)` (mišljenje + 3-6 doslovnih izvoda).

## Endpoints (www.dri.rs, bez prijave, bez JSON API-ja koji radi)

| URL | šta daje |
|---|---|
| `GET /izvestaji` | stranica "Svi izveštaji" (1.8 MB). Sadrži SVE subjekte revizije (oko 2.000) kao checkbox filtere: `<input value="272" name="subjects">` + labela + brojač izveštaja |
| `GET /izvestaji?subjects=<id>[&page=N]` | spisak izveštaja za subjekta, 20 po strani, server-rendered HTML, `rel="next"` za paginaciju |
| `GET /izvestaj/<reportId>` | stranica izveštaja; link na PDF je u bloku `single-doc` (`/storage/newaudits/...pdf` ili `/storage/upload/documents/revision/...pdf`) |
| `GET /audits/searchsubjects?searchTerm=` | select2 AJAX pretraga subjekata: **403 za ne-browser klijente**, ne koristimo ga (lista iz `/izvestaji` je ista) |

Filteri `subjects`, `year`, `types`, `topics`, `sectors`, `tags`, `search` rade i kao query parametri (iz `custom.js`/inline skripte na `/izvestaji`).

## Kako radi `getReports`

1. Učita `/izvestaji` i izvuče listu subjekata `{id, label, reports}`.
2. Upari instituciju sa subjektima: tokeni imena bez pravne forme (`normalizeName`), poređenje Latinica/Ćirilica preko `asciiFold`, tolerancija na padeže (zajednički prefiks >= 5 slova). Svi tokeni moraju biti u labeli. Ako postoji labela čiji je navodnicima označeni deo identičan imenu (`"ИНФРАСТРУКТУРА ЖЕЛЕЗНИЦЕ СРБИЈЕ"`), koristi se samo ona. Maks. 4 subjekta.
3. Za svaki subjekt prođe sve strane (pauza 300 ms), izvuče id, naslov, datum, tip i PDF.
4. Ako lista nema PDF link, otvori `/izvestaj/<id>` i uzme ga odatle.
5. Rezultat je sortiran po datumu opadajuće i keširan kao `data/cache/dri/reports-<normalizovano-ime>.json`.

Polja `AuditReport`: `id` (DRI id izveštaja), `title` (latinica), `publishedAt` (datum sa liste), `year` (revidirana godina za finansijsku reviziju, reviziju pravilnosti i svrsishodnosti, inače godina objave), `kind` (iz naslova i oznake tipa), `url` (PDF), `source.url` (stranica izveštaja `https://www.dri.rs/izvestaj/<id>`, `official: true`).

## Kako radi `getReportFindings`

1. PDF preko `getBuffer`, tekst preko `unpdf` (`extractText`, `mergePages`). PDF se **ne** kešira, kešira se samo `{opinion, excerpts}` (`findings-<id>.json`).
2. **Mišljenje**: traži naslov reda `Мишљење са резервом|Негативно мишљење|Позитивно мишљење|Уздржавање од изражавања мишљења|Мишљење` + `о финансијским извештајима|правилности` u prvih 60% teksta. Vrednosti: `pozitivno mišljenje`, `mišljenje sa rezervom`, `negativno mišljenje`, `uzdržavanje od mišljenja`. Ako ga nema, `opinion` je `undefined` (nije izmišljeno). Prvi izvod je rečenica "Po našem mišljenju, ...".
3. **Izvodi**: tekst se očisti od ponovljenih zaglavlja stranica i brojeva strana, podeli na rečenice i boduje (iznosi u dinarima/%, "nije u skladu", "vršioca dužnosti", pregovarački postupak, nabavke...). Odbacuju se sadržaj/TOC, boilerplate o odazivnom izveštaju i duplikati. Bira se do 5 rečenica (+ rečenica mišljenja), svaka <= 400 znakova (duže se seku na granici klauze i završavaju sa `…`).
4. Tekst se transliteruje u latinicu (`cyrToLat`) radi doslednosti sa UI; sadržaj je doslovan. Zaobilaženje greške u `translit.ts`: `cyrToLat` daje `Lj/Nj/Dž` i u VELIKIM rečima ("ZAKLjUČAK"), `latinize()` u adapteru to ispravlja.

## Rezultat za Infrastruktura železnice Srbije a.d. (subjekt id 272)

**21 izveštaj** (2 strane liste) kod subjekta "АД ЗА УПРАВЉАЊЕ ЖЕЛЕЗНИЧКОМ ИНФРАСТРУКТУРОМ "ИНФРАСТРУКТУРА ЖЕЛЕЗНИЦЕ СРБИЈЕ", БЕОГРАД". Tim je ranije brojao 19; sajt prikazuje 21 (brojač uz subjekta takođe kaže 21), razlika su verovatno dva izveštaja koja tim nije uračunao. Nisu uključeni subjekti "А. Д. Железнице Србије" (id 510, 4 izveštaja, matično preduzeće pre podele) i "Дирекција за железнице" (ids 1674 i 11377).

| id | objavljen | tip | mišljenje | izvoda | tema |
|---|---|---|---|---|---|
| 15213 | 2025-11-07 | poslerevizioni | - | 3 | zapošljavanje osoba sa invaliditetom |
| 15214 | 2025-11-07 | odazivni | - | 0 (skeniran PDF) | isto |
| 14510 | 2025-07-25 | revizija pravilnosti i svrsishodnosti | - | 5 | zapošljavanje osoba sa invaliditetom, 2023-2024 |
| 13967 | 2024-12-26 | revizija odazivnog izveštaja | - | 5 | javne nabavke i ugovori sa fizičkim licima |
| 13969 | 2024-12-26 | poslerevizioni | - | 5 | isto |
| 13968 | 2024-12-26 | odazivni | - | 0 (skeniran PDF) | isto |
| 11985 | 2023-07-12 | revizija pravilnosti (2022) | - | 5 | javne nabavke 2022, ugovori o radu van radnog odnosa |
| 11576 / 11577 | 2023-03-27 | odazivni / poslerevizioni | - | 0 / 5 | interna finansijska kontrola |
| 11295 | 2023-01-31 | revizija svrsishodnosti | - | 5 | interna finansijska kontrola u JP i društvima kapitala (IŽS: v.d. direktora "od dve do devet godina") |
| 4191 / 4194 / 4197 | 2021-12-22 | odazivni tipovi | - | 5 / 0 / 5 | pravilnost 2019 |
| 3605 / 3609 | 2021-04-29 | odazivni / poslerevizioni | - | 0 / 5 | pružni prelazi |
| 3328 | 2021-01-06 | revizija svrsishodnosti | - | 5 | upravljanje bezbednosnim rizicima na prelazima preko pruge |
| 3217 / 3218 / 3219 | 2020-12-29 | odazivni tipovi | - | 5 / 0 / 5 | finansijski izveštaji 2018 |
| 3066 | 2020-12-02 | revizija pravilnosti (2019) | - | 5 | ugovori van radnog odnosa 39,71 mil. RSD, nabavke 11,69 mlrd. RSD, v.d. direktora duže od 2 godine, pregovarački postupci |
| 2198 | 2019-12-04 | finansijska revizija (2018) | **mišljenje sa rezervom** | 6 | prikazane precenjene stavke (npr. građevinski objekti 3,99 mlrd. RSD) |

Svi izvodi su u kešu (`findings-<id>.json`). Najvažniji za dosije: 2198 (jedino mišljenje), 3066 i 11985 (nabavke, ugovori van radnog odnosa, v.d.), 11295 (v.d. IŽS).

## Ograničenja

- Šest PDF-ova (odazivni izveštaji 15214, 13968, 11576, 4194, 3605, 3218) su skenirane slike bez tekstualnog sloja: `excerpts: []`. OCR nije dostupan bez novih paketa.
- Zvanično mišljenje (pozitivno / sa rezervom / negativno) postoji samo u finansijskim revizijama (kod IŽS jedna, 2018). Revizije pravilnosti i svrsishodnosti daju "zaključke i nalaze", bez ocene; zato je `opinion` tu `undefined`.
- Izbor izvoda je heuristika (bodovanje rečenica), ne razumevanje teksta: novinar treba da otvori PDF (`source.url` vodi na stranicu izveštaja).
- `getReportFindings` u `DATA_MODE=cache` baca `CacheMissError` za izveštaj koji nije zagrejan; svih 21 jeste.
- Pauze: 300 ms između strana liste i detalja, `http.ts` ograničava konkurenciju po hostu. Sajt povremeno sporo servira velike PDF-ove (timeout 90 s).
- Tekstovi PDF-ova mogu imati nestandardne razmake; `flatten()` uklanja ponovljena zaglavlja stranica (linije dužine >= 30 znakova koje se javljaju >= 4 puta).

## Preciznost: naslov mora imenovati instituciju

`getReports` vraća samo izveštaje čiji naslov imenuje instituciju (sve značajne reči naziva, sa padežima, uključujući stari naziv „Srbija voz“ za Srbijavoz). DRI pod svakim revidiranim subjektom navodi i zajedničke revizije više subjekata čiji naslov imenuje samo temu (npr. „Upravljanje bezbednosnim rizicima na prelazima preko pruge“); one se izostavljaju. „Železnice Srbije“ ne prihvata naslove koji pominju „Infrastruktura železnice Srbije“. Vrsta revizije (`kind`) se određuje po prvom pominjanju u naslovu, pa izveštaj o merama ispravljanja po reviziji finansijskih izveštaja nije „finansijska revizija“. Naslov nalaza u dosijeu je `DRI <godina> · <tema>: <prva rečenica izvoda>`, a doslovan izvod je u tekstu.
