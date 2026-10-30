# Vesti i mediji: izvori podataka

Adapter: `src/data/sources/news.ts`. Cache: `data/cache/vesti/`. Probe: `scripts/probe-media.ts`.
Exports: `searchNews(query, {days?, limit?})`, `fetchArticle(url)`, `availableProviders()`.

U kešu je samo spojen rezultat pretrage (`search-<upit>-d<dani>-l<limit>.json`) i izvučen tekst članka (`article-<url>.json`). RSS feedovi se ne keširaju pojedinačno (stari feed bi lažno izgledao kao svež).

## Provajderi

| provajder | uvek uključen | endpoint | napomena |
|---|---|---|---|
| RSS izdanja | da | vidi tabelu feedova | ~50 poslednjih stavki po feedu: nema arhive |
| raspadsistema.com | da | `https://raspadsistema.com/data.json` (polje `feed`) | sajt je SPA bez RSS-a; JSON se ažurira na pola sata; svaka stavka ima `url` originalnog članka (npr. Danas) i `status` (nepotvrdjeno / potvrdjeno) |
| Google News RSS | da | `https://news.google.com/rss/search?q=<q> when:<N>d&hl=sr&gl=RS&ceid=RS:sr` | pretraga se šalje i latinicom i ćirilicom; linkovi su neprozirni i razrešavaju se (vidi dole) |
| GDELT DOC 2.0 | da | `https://api.gdeltproject.org/api/v2/doc/doc?query=..&mode=artlist&format=json&maxrecords=75&sort=datedesc&timespan=..` | samo poslednja 3 meseca; limit 1 zahtev / 5 s (često 429 sa ove mreže); srpski izvori slabo pokriveni; best effort sa budžetom od 16 s |
| Serper.dev | samo uz `SERPER_API_KEY` | `POST https://google.serper.dev/news`, header `X-API-KEY`, body `{q, gl:"rs", hl:"sr", num:20, tbs}` | rezultati `news[]` (`title, link, snippet, date, source`); datum je relativan ("pre 2 dana"), pretvara se u ISO |
| Brave News | samo uz `BRAVE_API_KEY` | `GET https://api.search.brave.com/res/v1/news/search?q=..&country=rs&search_lang=sr&count=20&freshness=<od>to<do>`, header `X-Subscription-Token` | rezultati `results[]` (`title, url, description, page_age`) |

Serper i Brave su implementirani po dokumentaciji, ali **nisu testirani** (na ovoj mašini nema ključeva). Bez ključa se preskaču bez poruke. `availableProviders()` vraća `["rss","google-news-rss","gdelt"]` plus `"serper"` / `"brave"`.

### RSS feedovi (provereni uživo, 30.10.2026)

| izdanje | URL | status |
|---|---|---|
| N1 | `https://n1info.rs/feed/` | radi (50) |
| Danas | `https://www.danas.rs/feed/` | radi (50) |
| Nova.rs | `https://nova.rs/feed/` | radi (50) |
| Vreme | `https://www.vreme.com/feed/` | radi (12) |
| Insajder | `https://insajder.net/feed` | radi (100) |
| 021.rs | `https://www.021.rs/rss/all` | radi (10); `/rss`, `/feed/` su 404 |
| RTS | `https://www.rts.rs/page/stories/sr/rss.html` | radi (20); `/rss` je 404 |
| Južne vesti | `https://www.juznevesti.com/feed/` | radi (10); `/rss` daje 403 |
| raspadsistema.com | `/feed`, `/rss`, `/sitemap.xml` su 404; koristi se `data.json` | radi (70) |
| KRIK, CINS, Istinomer | `https://www.krik.rs/feed/`, `https://www.cins.rs/feed/`, `https://www.istinomer.rs/feed/` | radi (10 svaki), dodati kao istraživački mediji |

Ne rade ili nisu potrebni: `n1info.rs/rss/`, `nova.rs/rss`, `vreme.com/rss.php` (HTML), `insajder.net/rss` (404), `radar.nova.rs/feed/` (greška veze). B92 i Blic feedovi rade, ali nisu uključeni (raspadsistema.com ih takođe ne koristi kao izvor).

## Pretraga: preciznost, spajanje, sortiranje

`searchNews(query, {days?, limit?, kind?, aliases?, context?, exclude?})`. Upit gradi `src/data/newsPlan.ts` (isti za alat agenata, `warm-cache` i `npm run qa`, jer je keš ključ sastavljen od upita); pravila preciznosti su u `src/data/newsMatch.ts`.

- **Institucija** (`kind: "institution"`, 12 meseci): Google News se pita tačnom frazom (`"Infrastruktura železnice Srbije"`) na latinici I ćirilici, u oba izdanja (`hl=sr-Latn` i `hl=sr`: daju različite rezultate, npr. 100 prema 44 stavke), i za svaki kratki naziv iz `data/static/news-aliases.json` + `shortName` iz `institutions.json` (npr. `IŽS`, `Srbija voz`). Članak se prihvata samo ako **naslov ili opis** sadrži sve značajne reči naziva, redom, bez razmaka većeg od jedne reči, sa padežnim nastavcima (`sameWord`): „Direktor Infrastrukture železnice Srbije“ da, „Infrastruktura puteva u Srbiji i železnice“ ne.
- **Duži nazivi se ne računaju kao kraći**: `exclude` (iz tabele institucija: svaka druga institucija čije reči sadrže ove) maskira pominjanja unutar njih, pa „Infrastruktura železnice Srbije“ nije „Železnice Srbije“.
- **Osoba** (`kind: "person"`, 2 godine): puno ime (u bilo kom redosledu, sa padežima, „Petar“ ~ „Petra“) I institucija ili firma (`context`) u naslovu, opisu ili preuzetom tekstu članka. Google ne daje opis, pa kandidati čiji naslov ne nosi ime (do 30) se proveravaju na tekstu članka (12 s, 3 istovremeno; ne ide u keš, u rezultatu ostaje rečenica sa imenom kao `snippet`, `verified: "tekst"`). Sportske i čitulje naslovi bez institucije se odbacuju (imenjaci).
- Provere na tekstu važe i za instituciju kad naslovi daju manje od 25 pogodaka (do 20 članaka). Članak koji ne može da se preuzme (403, paywall) ostaje neproveren i **ne ulazi** u rezultat.
- Dedupe: normalizovan URL + sličnost naslova (>= 0.85 poklapanje reči, <= 4 dana): isto izdanje koje ponavlja naslov i **agregatori** (Google News, MSN, Naslovi.net, ...) se spajaju, ostaje originalno izdanje (lista izdanja koja objavljuju sopstvene vesti, pa najraniji datum). Ista vest u dva različita izdanja ostaje (nezavisni izvori za status „potvrđeno“), a „Pregled medija“ ih broji kao jednu.
- Poredak: relevantnost (naslov > opis > tekst, naziv na početku naslova, dodatni nazivi, izdanje sa sopstvenim izveštavanjem), pa najnovije. Linkovi sa Google-a koji se ne razreše idu na kraj i ne ulaze u pregled.
- Google News linkovi (`news.google.com/rss/articles/CBMi...`) se razrešavaju u originalni URL posle filtriranja: čita se `data-n-a-sg` / `data-n-a-ts` sa stranice linka pa `POST /_/DotsSplashUi/data/batchexecute` (`Fbv4je` / `garturlreq`). To je interni Google endpoint bez garancije stabilnosti.
- **Pregled medija** (`newsOverview`): do 12 najrelevantnijih različitih članaka (najviše 2 po izdanju), broj različitih priča, najčešće teme iz naslova (rečnik tema u `newsMatch.ts`: nesreće i bezbednost, javne nabavke i ugovori, rukovodstvo, radovi, sindikat, saobraćaj, revizija, finansije).
- `NewsItem`: `matched` = pronađeni nazivi, `verified` = gde je poklapanje nađeno (naslov / opis / tekst), `score`, `source` (`kind: "vesti"`, `official: false`, javni URL članka).
- raspadsistema.com stavke imaju `outlet: "raspadsistema.com (Danas)"` i `url` originalnog članka; `snippet` je njihov kratak opis i funkcija osobe, `provider: "rss:raspadsistema"`.
- Ključ keša: `search-<upit>-<tip>-d<dani>-l<limit>[-a-<nazivi>][-c-<kontekst>][-x-<izuzeci>]`. Promena pravila ili naziva menja ključ: stari fajlovi se brišu (vidi `docs/QA.md`).
## fetchArticle

HTML preko `getText`, zatim: naslov (`og:title` / JSON-LD `headline` / `<h1>`, bez sufiksa izdanja), datum (`article:published_time`, JSON-LD `datePublished`, `<time datetime>`), izdanje (poznata imena po hostu / `og:site_name`), tekst (najveći `<article>`, a ako je kratak, kontejner sa klasom article/content/entry; uklanja se `script/style/nav/aside/figure/form/footer`; pasusi >= 40 znakova bez "Pročitajte i / Foto:..."; spaja se sa `\n\n`; maks. 6000 znakova na granici pasusa; poslednja opcija je JSON-LD `articleBody`). Google News linkovi se prvo razrešavaju. Greška ako je izvučeno < 80 znakova.

Poznata ograničenja: **tanjug.rs vraća 403** botovima (zato nema teksta za Tanjugove vesti, samo naslov iz pretrage); RTS i RTV stranice nemaju datum u HTML-u (`publishedAt` je `undefined`, datum je u `NewsItem` iz Google RSS-a); paywall/SPA stranice ne daju tekst.

## Demo keš (stvarni članci, 30.10.2026)

Pretrage (u kešu): `"Infrastruktura železnice Srbije"` (90 dana, 16 stavki), `"Zoran Jevtić"` (730 dana, 6), `"Jevtić Infrastruktura železnice generalni direktor"` (730 dana, 9).

**(a) Sindikat traži ostavke rukovodstva IŽS (oktobar 2026)**
- raspadsistema.com (https://raspadsistema.com/, stavka u `data.json`, 30.10.2026 11:09, status "nepotvrdjeno"): "Sindikat „Nezavisnost" traži ostavke rukovodstva „Infrastrukture železnice Srbije" u roku od 48 sati". Pominje v.d. generalnog direktora Zorana Jevtića i izvršne direktore. Sajt nema stalne linkove po stavci (SPA), pa je izvor koji se citira:
- Danas, 2026-10-30: "Sindikat „Nezavisnost" zahteva ostavke čelnika „Infrastrukture železnice Srbije" u roku od 48 sati": https://www.danas.rs/vesti/ekonomija/sindikat-nezavisnost-zahteva-ostavke-celnika-infrastrukture-zeleznice-srbije-u-roku-od-48-sati/ (tekst u kešu; tvrdnje sindikata, "Prozvani se nisu oglasili", nije potvrđeno).

**(b) Jevtić kao "generalni direktor" (konflikt sa ACAS "v.d.")**
- RTV, 2025-05-24 (datum iz Google RSS-a): naslov "Зоран Јевтић нови генерални директор „Инфраструктуре железнице Србије"", a tekst kaže "именован за в. д. директора": https://rtv.rs/sr_ci/drustvo/zoran-jevtic-novi-generalni-direktor-infrastrukture-zeleznice-srbije_1630301.html
- Tanjug, 2025-05-24: "Zoran Jevtić novi generalni direktor Infrastrukture železnice Srbije": https://www.tanjug.rs/ekonomija/srbija/164383/zoran-jevtic-novi-generalni-direktor-infrastrukture-zeleznice-srbije/vest (samo naslov u pretrazi, članak vraća 403)
- Nova Ekonomija, 2025-08-07: "Generalni direktor Infrastrukture, Zoran Jevtić, ..." (tekst): https://novaekonomija.rs/vesti-iz-zemlje/direktor-infrastruktura-zeleznice-srbije-zoran-jeftic-prokop-bezbedan-stubovi-grede-zeleznicka-stanica
- B92, 2025-08-07: "Generalni Direktor „Infrastrukture železnice Srbije" Zoran Jevtić kaže za Tanjug...": https://www.b92.net/lokal/beograd/drustvo/153048/direktor-infrastrukture-zeleznice-srbije-stanica-prokop-je-bezbedna-za-koriscenje/vest
- RTS (Google RSS: 2025-08-07): "Generalni direktor „Infrastrukture železnice Srbije" Zoran Jevtić ...": https://www.rts.rs/lat/vesti/drustvo/5766234/infrastruktura-zeleznice-srbije-prokop.html
- Suprotna strana (konzistentna sa ACAS): Glas javnosti 2025-05-24 "Zoran Jevtić imenovan za vršioca dužnosti direktora „Infrastrukture železnice Srbije"": https://www.glas-javnosti.rs/vesti/drustvo/zoran-jevtic-imenovan-za-vrsioca-duznosti-direktora-e2809einfrastrukture-zeleznice-srbije- ; Nova Ekonomija 2025-05-26 "Ko je Zoran Jevtić, novi direktor Infrastrukture železnice Srbije" (tekst: "novog vršioca dužnosti"): https://novaekonomija.rs/vesti-iz-zemlje/ko-je-zoran-jevtic-novi-direktor-infrastrukture-zeleznice-srbije ; Danas 2026-10-30 koristi "v. d. generalnog direktora".

**(c) Ostali nedavni članci o IŽS (tekst u kešu)**
- 021.rs, 2026-09-03, "Posao vredan 470 miliona dinara „Infrastruktura železnice Srbije" dodelila firmi Daneta Šijana": https://www.021.rs/info/srbija/454127/posao-vredan-470-miliona-dinara-infrastruktura-zeleznice-srbije-dodelila-firmi-daneta-sijana
- N1, 2026-09-14, "Infrastruktura železnice: Ukradeno 80 metara kontaktne mreže na pruzi Ovča - Pančevo, saobraćaj samo desnim kolosekom": https://n1info.rs/vesti/infrastruktura-zeleznice-ukradeno-80-metara-kontaktne-mreze-na-pruzi-ovca-pancevo-saobracaj-samo-desnim-kolosekom/
- Danas, 2026-09-24, "Infrastruktura železnice: Putnički vozovi na pruzi Niš–Brestovac ići će bezbedno brzinom od 120 kilometara na sat": https://www.danas.rs/vesti/ekonomija/infrastruktura-zeleznice-putnicki-vozovi-na-pruzi-nis-brestovac-ici-ce-bezbedno-brzinom-od-120-kilometara-na-sat/
- JuGmedia, 2026-09-25, "Infrastruktura: Uskoro železnički saobraćaj, obnovljena pruga Niš-Brestovac, netačni navodi medija o rekonstrukciji": https://jugmedia.rs/infrastruktura-uskoro-zeleznicki-saobracaj-obnovljena-pruga-nis-brestovac-netacni-navodi-medija-o-rekonstrukciji/
- Insajder, 2026-10-04 i 2026-10-08 (saopštenja IŽS): https://insajder.net/prenosimo/infrastruktura-zeleznice-upotrebna-dozvola-za-novo-zeleznicko-stajaliste-u-novom-sadu-rasterecenje-stanice-u-petrovaradinu , https://insajder.net/prenosimo/infrastrukture-zeleznice-srbije-od-petka-redovan-putnicki-saobracaj-na-pruzi-nis-leskovac
- Nova Ekonomija, 2026-10-07, "Infrastruktura železnica Srbije: Od danas otvorena tehničko putnička stanica Novi Sad": https://novaekonomija.rs/vesti-iz-zemlje/infrastruktura-zeleznica-srbije-od-danas-otvorena-tehnicko-putnicka-stanica-novi-sad

Većina članaka iz (c) su preneta saopštenja IŽS; 021.rs (ugovor od 470 miliona dinara) je jedina vest o nabavci i treba je proveriti na Portalu javnih nabavki.

## Poređenje provajdera

| | RSS izdanja | Google News RSS | GDELT DOC 2.0 | Serper.dev | Brave News |
|---|---|---|---|---|---|
| cena | besplatno | besplatno (neslužbeno, samo za ličnu upotrebu po uslovima) | besplatno | 2.500 besplatnih upita, zatim oko 1 USD / 1.000 | 5 USD kredita mesečno, zatim 5 USD / 1.000 |
| ključ | ne | ne | ne | `SERPER_API_KEY` | `BRAVE_API_KEY` |
| pokrivenost srpskih medija | samo izdanja sa liste, samo poslednjih 10-100 stavki | dobra, ali ~100 rezultata po upitu i nema opisa | slaba za srpski, samo 3 meseca | Google rezultati, najbolja svežina i opisi | sopstveni indeks, slabiji za srpski |
| datumi | tačni | datum bez sata (07:00 UTC) | tačni | relativni ("pre 2 dana") | `page_age` ISO kada postoji |
| rizik | feed se menja ili nestane | linkovi su neprozirni, rate limit bez najave | 429 uz 1 zahtev / 5 s | kvota | kvota |
| uloga | arhiva ne postoji, ali tačan tekst za tekuće vesti | glavni besplatni izvor za istoriju (2025) | dodatni signal | preporuka za produkciju | alternativa |

Za demo je dovoljan besplatni sloj (RSS + Google News RSS) jer radi iz keša. Za produkciju bi trebalo dodati Serper (najjeftinije pri malom obimu i sa Google rangiranjem) ili Brave (nezavisan indeks), a Google News RSS ne oslanjati kao jedini izvor.

## Ostalo

- Jedan `searchNews` traje 15-20 s uživo (Google 2 zahteva + razrešavanje linkova + GDELT budžet), 1 ms iz keša.
- `NEWS_DEBUG=1` ispisuje broj stavki po provajderu na stderr.
- U `DATA_MODE=cache` pretraga sa drugim `days`/`limit` ili upitom koji nije zagrejan baca `CacheMissError`.
