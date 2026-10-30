# ACAS: registar funkcionera i izveštaji o imovini

Adapter: `src/data/sources/acas.ts` · cache: `data/cache/acas/` · probe: `scripts/probe-acas.ts`

## Kako je API otkriven

1. `https://www.acas.rs/cyr/pages/pretraga_registra` samo preusmerava (HTTP 302) na `https://publicacas.acas.rs/`.
2. To je Angular SPA (`main.js`, ~4 MB). U `main.js` je `environment.API_URL = '/acasPublicNew'`, dakle API je
   `https://publicacas.acas.rs/acasPublicNew` (Spring, JSON, **bez prijave, bez kapče, bez kolačića**).
3. Rute servisa su pročitane iz bundle-a (`API_URL + '/funkcijaFunkcionera'`, `/organizacija`,
   `/obrazacPrijavaImovineIPrihoda`, ...), a nazivi filtera iz formi (`formControlName`) i iz `base.service.ts`
   (`GET <entitet>/search?page&limit&sorting=polje:asc|desc&<filteri>`).

Pretraga prima **samo ćirilicu** (adapter koristi `latToCyr`). Pretraga je „sadrži, bez razlike u velikim/malim slovima".

## Endpointi koji rade (GET, `Accept: application/json`)

Svi „search" odgovori: `{ "results": [...], "total": N }`. `limit` do 2000 radi; adapter traži najviše 200 po strani.

| Endpoint | Parametri | Upotreba |
|---|---|---|
| `/organizacija/search` | `naziv` (ćirilica, podniz), `page`, `limit` | `findInstitution` |
| `/funkcijaFunkcionera/search` | `organizacijaId`, `funkcionerId`, `funkcionerIme`, `funkcionerPrezime`, `sorting=datumStupanja:desc`, `page`, `limit` | `getOfficials`, `searchPerson` |
| `/funkcioner/{funkcionerId}` | | ime i prezime osobe (kad je poznat samo ID) |
| `/obrazacPrijavaImovineIPrihoda/getAllByFunkcionerId/{funkcionerId}` | | spisak izveštaja osobe (niz, ne `results`) |
| `/prihodBudzeta/search` | `obrazacId`, `deleted=false` | prihodi od javnih funkcija u izveštaju |
| `/nepokretnaImovina/search` | `obrazacId`, `deleted=false` | nepokretnosti (vrsta, struktura, površina, udeo, osnov sticanja) |
| `/imovinaRegistracija/search` | isto | pokretna imovina (vrsta, marka/tip, godina) |
| `/imovinaPravoKoriscenja/search`, `/imovinaAkcije/search`, `/imovinaUdeli/search`, `/imovinaDelatnost/search` | isto | pravo korišćenja, akcije, udeli, samostalna delatnost |

**Ne rade** (ignorišu filter ili 404): `organizacijaNaziv` i `funkcijaNaziv` u `funkcijaFunkcionera/search`
(vraća svih ~68.000 redova: filtrirati preko `organizacijaId`), `funkcioner/search?ime=`, `exportPDF`, `getUkupnoSve`.
`funkcionerPrezime` sam vraća i imenjake, pa adapter filtrira lokalno po tokenima imena.

### Primer 1: ustanova

`GET /organizacija/search?page=1&limit=20&naziv=Инфраструктура железнице Србије`
```json
{ "results": [ { "id": 9721, "naziv": "Инфраструктура железнице Србије а.д. Београд", "mestoNaziv": "Београд" } ], "total": 1 }
```
(odgovor sadrži i polje `adresa` sedišta ustanove; adapter ga ne čuva)

### Primer 2: funkcije u ustanovi (skraćeno, bez kontakt polja)

`GET /funkcijaFunkcionera/search?page=1&limit=200&sorting=datumStupanja:desc&organizacijaId=9721`
```json
{ "results": [ {
  "id": 5066133, "organizacijaId": 9721,
  "organizacijaNaziv": "Инфраструктура железнице Србије а.д. Београд",
  "funkcijaNaziv": "В.Д. Генералног Директора",
  "funkcionerId": 5036367, "funkcionerIme": "Зоран", "funkcionerPrezime": "Јевтић",
  "datumStupanja": 1747864800000, "datumPrestanka": null, "aktivna": 1,
  "organizacijaImenovanjaNaziv": "Влада Републике Србије"
} ], "total": 10 }
```
`datumStupanja` je epoch ms u ponoć po beogradskom vremenu (`1747864800000` = 2025-05-21T22:00Z = **22.05.2025**);
adapter konvertuje u ISO datum u zoni `Europe/Belgrade`.

### Primer 3: izveštaj o imovini

`GET /obrazacPrijavaImovineIPrihoda/getAllByFunkcionerId/5036367`
```json
[ { "id": 5032950, "tipPrijavljivanja": "STUPANJE_NA_JAVNU_FUNKCIJU", "datumPodnosenja": "20.06.2025.",
    "datumPodnosenjaDate": 1750413600000, "funkcionerId": 5036367, "zasticenOdObjavljivanja": false } ]
```
`GET /prihodBudzeta/search?obrazacId=5032950&deleted=false` →
`{ "funkcijaNaziv": "В.Д. Генералног Директора", "organizacijaNaziv": "Инфраструктура железнице Србије а.д. Београд", "intervalPrihodaString": "Месечно", "iznosPrihoda": 236343, "valutaSifra": "RSD", "periodObavljanja": "22.05.2025. - " }`

## Normalizacija (šta adapter vraća)

- `Official`: `id` = `funkcionerId` (osoba, **ne** red funkcije; ista osoba ima isti ID u svim ustanovama, a imenjaci imaju različite),
  `fullName`/`position` latinica (`cyrToLat`; ime pisano VELIKIM slovima se pretvara u normalan oblik), `fullNameCyr`/`positionCyr`
  ćirilica, `isActing` iz „в.д." / „вршилац дужности", `from`/`to` ISO datum (beogradska zona), `appointedBy` =
  `organizacijaImenovanjaNaziv`, `source` = zvanični javni link `https://publicacas.acas.rs/#/acas/funkcioner`
  (SPA nema javnu rutu ka ustanovi ili osobi: u Angular routeru postoje samo `funkcioner` i `funkcionerIzvestajDetails/:id`, a `funkcioner` ne čita parametre iz URL-a; zato naslov izvora nosi uput za pretragu: „ACAS registar – pretraga: <naziv>“).
- `AssetReport`: jedan po izveštaju (najviše 3 najnovija po osobi), `reportDate` ISO, `reason` (stupanje na javnu funkciju,
  prestanak, promene u toku vršenja funkcije...), `summary` kratke linije (prihodi od javnih funkcija; broj i vrste
  nepokretnosti sa površinom; vozila sa markom i godinom; akcije/udeli sa nazivom firme i procentom; samostalna delatnost),
  `incomes[]`, `source.url` = `https://publicacas.acas.rs/#/acas/funkcionerIzvestajDetails/<id izveštaja>` (ruta iz Angular
  routera; **nije proveravena u pretraživaču**, jer u ovoj sesiji nije bio dostupan).
  Izveštaj sa `zasticenOdObjavljivanja=true` daje samo napomenu da podaci nisu javni.
- `searchPerson` vraća sve funkcije svih osoba sa tim imenom (npr. „Zoran Jevtić": 4 različita `id`-ja, među njima
  v.d. direktora IŽS i predsednik opštine Mali Zvornik). **Podudaranje je samo po imenu: ID-jevi se moraju proveriti.**
  `getAssetReports(personId, fullName)` bez numeričkog ID-ja radi samo ako ime pogađa tačno jednu osobu, inače vraća `[]`.

## Kako se odbacuju lični podaci

Sirovi odgovor `funkcijaFunkcionera/search` sadrži `liceTelefon`, `liceEmail`, `liceSkolskaSprema`, `liceZvanje`,
`jednoZanimanje`; izveštaji o imovini sadrže JMBG, adrese, boravište, supružnika, sedište preduzetnika, mesto
nepokretnosti. Adapter **nikad ne kopira objekat**: `toOfficial()` i `summarizeReport()` biraju polja po imenu, a
`cached()` dobija samo već normalizovan rezultat. Provereno `grep` na `data/cache/acas/` (`@`, telefon, jmbg, adresa:
bez pogodaka). Namerno izostavljeno: sedište preduzetnika/firme, mesto nepokretnosti, mesto podnošenja izveštaja,
marka/tip vozila kad je `javniPodatak=false`.

## Keš

`data/cache/acas/`: `institution-<naziv>.json`, `officials-<acasId>.json`, `person-<ime-prezime>.json`,
`assets-<funkcionerId>.json`. Zagrejano za IŽS (ID 9721): 10 osoba (sadašnji i tri prethodna v.d. direktora + članovi skupštine društva).

## Ograničenja i oprez

- Registar obuhvata samo funkcionere koji su obavezni da prijave funkciju; za IŽS je u ACAS (ID 9721) 10 funkcija
  (v.d. generalnog direktora i skupština društva); odbor direktora/nadzorni odbor nisu pronađeni pod tim ID-jem. Ne zaključivati da ne postoje.
- Podaci su samoprijavljeni i mogu kasniti; `datumStupanja` je datum stupanja na funkciju iz prijave.
- Izveštaj nema vrednosti nepokretnosti ni pojedinačne iznose imovine, samo stavke koje je ACAS objavio.
- Pretraga imena: ćirilica bez dijakritičkih grešaka („Jevtic" bez „ć" neće pogoditi). Imenjaci su česti.
- Server je „jenkins-test" okruženje (`X-Application-Context: application:jenkins-test`): neslužbeni API bez garancija,
  moguće promene. Adapter radi 1-8 zahteva po upitu, sekvencijalno, sa pauzom od 150 ms između izveštaja.
- Anomalija u podacima: `aktivna=0` bez `datumPrestanka` bi bio prikazan kao funkcija bez kraja (u IŽS slučaju se ne javlja).
