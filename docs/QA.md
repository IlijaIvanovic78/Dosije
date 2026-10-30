# QA izveštaj

Generisano skriptom `npm run qa` (scripts/qa.ts) · datum: 2026-10-30 · režim: `DATA_MODE=cache`, skriptovani agenti, bez ključa.

Skripta pokreće pun dosije za svaku institucije iz Mape prioriteta i proverava: izvor za svaki nalaz, dostupnost svakog linka, da svaki podatak pripada toj instituciji, duplikate, prazne odeljke i gramatiku brojeva.

## Nalazi po odeljcima

| institucija | nalaza | rukovodstvo | novac | firme | revizija | mediji | članaka | jedinstvenih linkova |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Infrastruktura železnice Srbije a.d. | 40 | 7 | 3 | 14 | 11 | 5 | 21 | 46 |
| Srbijavoz a.d. Beograd | 32 | 8 | 2 | 10 | 9 | 3 | 23 | 48 |
| Srbija Kargo a.d. | 31 | 7 | 2 | 10 | 9 | 3 | 12 | 38 |
| Železnice Srbije a.d. | 18 | 4 | 1 | 8 | 4 | 1 | 11 | 30 |
| Putevi Srbije | 32 | 7 | 3 | 10 | 8 | 4 | 25 | 47 |
| Koridori Srbije d.o.o. | 28 | 6 | 2 | 7 | 10 | 3 | 20 | 41 |

## Linkovi

230 jedinstvenih URL-ova iz svih izvora nalaza (GET, 12 s, jedan zahtev po domenu, pauza 0,25-1,5 s): **223 radi**, 7 blokira botove (401/403/429: prijavljeno, nije greška), 0 upozorenja (isteklo vreme, 5xx), **0 grešaka** (404/410, DNS, TLS, meka 404).

Blokiraju botove (link je javan, ali sajt odbija automatski zahtev):

- https://www.tanjug.rs/ekonomija/srbija/288429/infrastruktura-zeleznice-srbije-pruga-nis-brestovac-prosla-predvidena-ispitivanja/vest (HTTP 403: blokira botove)
- https://www.tanjug.rs/ekonomija/srbija/164383/zoran-jevtic-novi-generalni-direktor-infrastrukture-zeleznice-srbije/vest (HTTP 403: blokira botove)
- https://www.tanjug.rs/ekonomija/srbija/170899/ljubisa-pejicic-novi-direktor-srbijavoza/vest (HTTP 403: blokira botove)
- https://www.paragraf.rs/glasila/ (HTTP 403: blokira botove)
- https://www.tanjug.rs/srbija/politika/255217/vlasti-pristine-upale-u-objekte-zeleznice-srbije-u-zvecanu-leposavicu-lesku-i-ibarskoj-slatini/vest (HTTP 403: blokira botove)
- https://www.ekapija.com/news/5701952/renovira-se-zgrada-u-centru-beograda-koridori-srbije-traze-izvodjace-radova-vrednih (HTTP 403: blokira botove)
- https://www.ekapija.com/news/5645535/koridori-srbije-podneli-zahtev-za-zelenu-dozvolu-za-46-km-sektora-2 (HTTP 403: blokira botove)


## Precizost: podatak pripada instituciji

| institucija | ACAS | Portal javnih nabavki | APR | DRI | Integrity Watch | Vesti |
|---|---|---|---|---|---|---|
| Infrastruktura železnice Srbije a.d. | 10 funkcionera, svi pod nazivom institucije | 1537 ugovora, naručilac „Infrastruktura železnice Srbije“ odgovara; 2020-2026 | institucija „Akcionarsko društvo za upravljanje javnom železničkom infrastrukturom Infrastruktura železnice Srbije Beograd-Savski Venac“; 8 dobavljača sa APR profilom, nazivi se poklapaju | 19 izveštaja, svi imenuju instituciju u naslovu | 9 oznaka, svi naručioci odgovaraju | 33 članaka u 12 meseci (0 potvrđeno tekstom), svi pominju instituciju |
| Srbijavoz a.d. Beograd | 10 funkcionera, svi pod nazivom institucije | 702 ugovora, naručilac „"Srbijavoz" a.d. Beograd“ odgovara; 2021-2026 | institucija „Akcionarsko društvo za železnički prevoz putnika Srbijavoz Beograd“; 4 dobavljača sa APR profilom, nazivi se poklapaju | 10 izveštaja, svi imenuju instituciju u naslovu | 2 oznaka, svi naručioci odgovaraju | 52 članaka u 12 meseci (0 potvrđeno tekstom), svi pominju instituciju |
| Srbija Kargo a.d. | 11 funkcionera, svi pod nazivom institucije; 2 zastarelih zapisa bez datuma prestanka se ignoriše | 299 ugovora, naručilac „Srbija Kargo a.d.“ odgovara; 2021-2026 | institucija „Akcionarsko društvo za železnički prevoz robe Srbija Kargo Beograd-Savski Venac“; 2 dobavljača sa APR profilom, nazivi se poklapaju | 12 izveštaja, svi imenuju instituciju u naslovu | 3 oznaka, svi naručioci odgovaraju | 10 članaka u 12 meseci (4 potvrđeno tekstom), svi pominju instituciju |
| Železnice Srbije a.d. | 2 funkcionera, svi pod nazivom institucije | 48 ugovora, naručilac „ŽELEZNICE SRBIJE AD“ odgovara; 2020-2026 | institucija „Železnice Srbije akcionarsko društvo, Beograd“; 3 dobavljača sa APR profilom, nazivi se poklapaju | 4 izveštaja, svi imenuju instituciju u naslovu | 0 oznaka, svi naručioci odgovaraju | 11 članaka u 12 meseci (1 potvrđeno tekstom), svi pominju instituciju |
| Putevi Srbije | 12 funkcionera, svi pod nazivom institucije | 505 ugovora, naručilac „Društvo sa ograničenom odgovornošću "Putevi Srbije" Beograd“ odgovara; 2020-2026 | institucija „Društvo s ograničenom odgovornošću Putevi Srbije Beograd“; 2 dobavljača sa APR profilom, nazivi se poklapaju | 28 izveštaja, svi imenuju instituciju u naslovu | 2 oznaka, svi naručioci odgovaraju | 43 članaka u 12 meseci (0 potvrđeno tekstom), svi pominju instituciju |
| Koridori Srbije d.o.o. | 6 funkcionera, svi pod nazivom institucije | 136 ugovora, naručilac „"KORIDORI SRBIJE" DOO BEOGRAD“ odgovara; 2021-2026 | institucija „KORIDORI SRBIJE DRUŠTVO S OGRANIČENOM ODGOVORNOŠĆU BEOGRAD (STARI GRAD)“; 2 dobavljača sa APR profilom, nazivi se poklapaju | 8 izveštaja, svi imenuju instituciju u naslovu | 0 oznaka, svi naručioci odgovaraju | 16 članaka u 12 meseci (9 potvrđeno tekstom), svi pominju instituciju |

## Upozorenja

- **Srbija Kargo a.d.** · mediji: „Pregled medija“ ima 8 izvora (cilj 10-12)

## Greške

_Nema: sve provere prolaze._

## Gramatika

Provereni su naslovi i tekstovi nalaza, sažetak, lista za proveru, izveštaj i razlozi Mape: bez grešaka u slaganju broja sa imenicom (1 ugovor, 3 ugovora, 7 ugovora; mesec/meseca/meseci; nalaz/nalaza; ...).

## Pronađeno i ispravljeno u ovoj iteraciji

- Agenti reaguju jedni na druge: Mediji na nalaz Kadrovika o v.d. (VD_PREKO_ROKA, VD_LANAC) ciljanom proverom medija o imenovanju i nazivu funkcije („v.d.“ ili „direktor“), Revizor na nalaz Nabavke (BEZ_OBJAVE, KONCENTRACIJA) potragom za ranijim nalazom DRI iste teme, sa izvorom izveštaja i izvorom Portala u istom nalazu. Svaka reakcija se pokreće najviše jednom po slučaju i oznaci, kao nova petlja istog agenta (poruka „Povod: nalaz …“, događaj `agent.reakcija`).
- Rang glavnih signala: zvanični (odobreni) prvi, zatim potvrđeni, pa nepotvrđeni; „akt o imenovanju nije pronađen“ je uvek ispod; najviše jedan nalaz po signalCode (više Integrity Watch oznaka je jedan signal). Pre: nepotvrđena IW oznaka je bila #1.
- Status `demantovano` se u svim tekstovima i izveštaju piše „odstupa od registra“; naslov u medijima koji drugačije naziva funkciju nije demant. Beleška: „Zvanični registar (ACAS) navodi «v.d. generalnog direktora»; ovaj izvor navodi «generalni direktor». Prednost ima zvanični registar.“ Bez precrtavanja u izveštaju.
- DRI: revidirani period se piše samo kad ga navodi naslov izveštaja („finansijski izveštaji za 2018.“); inače „izveštaj objavljen 25.07.2025.“ (godina objave više nije „revizija za 2025. godinu“). Naslovi izvora DRI su kratki i celi.
- Linkovi: ACAS nema javnu rutu za ustanovu ili osobu (samo pretraga i `funkcionerIzvestajDetails/<id>`, proveren u pregledaču), pa izvor nosi uput u naslovu („ACAS registar – pretraga: <naziv>“); Integrity Watch nema stranicu dobavljača („Integrity Watch Srbija – pretraga: <firma>“). Medijski članak koji IW navodi kao osnov povezivanja prikazuje se samo ako članak zaista pominje firmu.
- Tekst: dvostruke tačke posle datuma, stavke liste „Šta još treba proveriti“ su cele rečenice (skraćena formulacija umesto seckanja), naslovi DRI nalaza se završavaju na granici izraza, izvor „raspadsistema.com (Danas)“ je samo „Danas“, imena u CLI Ganttu se ne seku („Stegnjaja“, ne „Stegnjaj“). Pregled medija ne uključuje tabloidne mikro-sajtove kad ima bar 5 članaka iz poznatih izdanja (`src/data/sources/news.ts`).
- `npm run qa` i `npm test` ne menjaju keš ni praćene fajlove: izveštaj ide u out/qa.md (docs/QA.md samo uz `--write-docs`), a u `DATA_MODE=cache` ništa se ne upisuje u data/cache; negativni rezultati (promašaj razrešavača, prazne pretrage nepoznatih imena) se ne keširaju.
- Vesti: pretraga sada koristi tačne fraze na latinici i ćirilici, oba izdanja Google News (sr-Latn i sr) i kratke nazive (IŽS, Srbija voz); članak mora da pominje instituciju (sve značajne reči, sa padežima) u naslovu ili opisu, a članak o osobi i osobu i instituciju/firmu (naslov, opis ili preuzeti tekst). Imenjaci, sportske vesti i čitulje se odbacuju, a ponovljene vesti i agregatori se spajaju (ostaje originalno izdanje). Pre: 0-4 članka po dosijeu, sada 12 meseci istorije i do 12 izvora u nalazu „Pregled medija“.
- Vesti: „Železnice Srbije“ više ne hvata članke o „Infrastrukturi železnice Srbije“ (pominjanje unutar duže institucije se ne računa).
- DRI: izveštaj ulazi u dosije samo ako naslov imenuje instituciju (i stari naziv „Srbija voz“); zajedničke revizije bez imena institucije u naslovu su izbačene. Vrsta revizije se određuje po prvom pominjanju u naslovu (izveštaji o merama ispravljanja više nisu „finansijska revizija“).
- Portal javnih nabavki: Srbijavoz je imao samo 349 ugovora (od 2023); ugovori pod starim nazivom „Србија Воз а.д.“ dodati su preko aliasa, a svi ugovori se zadržavaju samo ako tender pripada šifri naručioca (CAId).
- ACAS: zapisi bez datuma prestanka koje je zamenio kasniji zapis za istu funkciju (Srbija Kargo: v.d. od 2017. pored v.d. od 2025.) više se ne računaju kao tekući, niti kvare lanac v.d.
- Gramatika: jedinstven pomoćnik za množinu (1 ugovor, 3 ugovora, 7 ugovora) u politikama, rezimeu, izveštaju, razlozima Mape i CLI ispisu; naslovi izvora se seku na granici reči.
- Naslovi DRI nalaza su sada naslovi („DRI 2022 · javne nabavke: …“), a doslovan izvod je u tekstu; izvodi koji su ostatak tabele („Preporuka broj …“, „Rezime datih preporuka“) se ne koriste.
- Nalaz o sindikatu/ostavkama i ostali pojedinačni medijski nalazi traže da NASLOV imenuje instituciju (članak koji je samo pominje usput ulazi samo u pregled).
- Dobavljač koji se pojavljuje samo u zajedničkim ponudama nema naziv na Portalu („PIB 100003172“): u naslovu nalaza se prikazuje naziv iz APR.
- Portal javnih nabavki vraća HTTP 500 na direktan link ako posetilac nije prethodno otvorio početnu stranicu (sesija); provera linkova se ponaša kao taj posetilac, a lista „Šta još treba proveriti“ sadrži napomenu o tome.
- Keš: obrisani nekorišćeni fajlovi (stari ključevi pretrage vesti i članci na koje se više ne poziva ništa, DRI izvodi zajedničkih revizija, stari ključ Integrity Watch naručioca, izveštaji o imovini osoba koje više nisu u izboru); `CACHE_TRACE` + `scripts/prune-cache.ts` nalaze takve fajlove.
