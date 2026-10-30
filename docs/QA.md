# QA izveštaj

Generisano skriptom `npm run qa` (scripts/qa.ts) · datum: 2026-10-30 · režim: `DATA_MODE=cache`, skriptovani agenti, bez ključa.

Skripta pokreće pun dosije za svaku institucije iz Mape prioriteta i proverava: izvor za svaki nalaz, dostupnost svakog linka, da svaki podatak pripada toj instituciji, duplikate, prazne odeljke i gramatiku brojeva.

## Nalazi po odeljcima

| institucija | nalaza | rukovodstvo | novac | firme | revizija | mediji | članaka | jedinstvenih linkova |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Infrastruktura železnice Srbije a.d. | 37 | 7 | 3 | 14 | 9 | 4 | 21 | 46 |
| Srbijavoz a.d. Beograd | 30 | 8 | 2 | 10 | 8 | 2 | 24 | 49 |
| Srbija Kargo a.d. | 30 | 7 | 2 | 10 | 9 | 2 | 15 | 41 |
| Železnice Srbije a.d. | 19 | 4 | 1 | 8 | 4 | 2 | 12 | 31 |
| Putevi Srbije | 30 | 7 | 3 | 10 | 7 | 3 | 25 | 47 |
| Koridori Srbije d.o.o. | 26 | 6 | 2 | 7 | 9 | 2 | 23 | 44 |

## Linkovi

238 jedinstvenih URL-ova iz svih izvora nalaza (GET, 12 s, jedan zahtev po domenu, pauza 0,25-1,5 s): **233 radi**, 5 blokira botove (401/403/429: prijavljeno, nije greška), 0 upozorenja (isteklo vreme, 5xx), **0 grešaka** (404/410, DNS, TLS, meka 404).

Blokiraju botove (link je javan, ali sajt odbija automatski zahtev):

- https://www.tanjug.rs/ekonomija/srbija/288429/infrastruktura-zeleznice-srbije-pruga-nis-brestovac-prosla-predvidena-ispitivanja/vest (HTTP 403: blokira botove)
- https://www.tanjug.rs/ekonomija/srbija/170899/ljubisa-pejicic-novi-direktor-srbijavoza/vest (HTTP 403: blokira botove)
- https://www.paragraf.rs/glasila/ (HTTP 403: blokira botove)
- https://www.ekapija.com/news/5701952/renovira-se-zgrada-u-centru-beograda-koridori-srbije-traze-izvodjace-radova-vrednih (HTTP 403: blokira botove)
- https://www.ekapija.com/news/5645535/koridori-srbije-podneli-zahtev-za-zelenu-dozvolu-za-46-km-sektora-2 (HTTP 403: blokira botove)


## Precizost: podatak pripada instituciji

| institucija | ACAS | Portal javnih nabavki | APR | DRI | Integrity Watch | Vesti |
|---|---|---|---|---|---|---|
| Infrastruktura železnice Srbije a.d. | 10 funkcionera, svi pod nazivom institucije | 1537 ugovora, naručilac „Infrastruktura železnice Srbije“ odgovara; 2020-2026 | institucija „Akcionarsko društvo za upravljanje javnom železničkom infrastrukturom Infrastruktura železnice Srbije Beograd-Savski Venac“; 8 dobavljača sa APR profilom, nazivi se poklapaju | 19 izveštaja, svi imenuju instituciju u naslovu | 9 oznaka, svi naručioci odgovaraju | 39 članaka u 12 meseci (0 potvrđeno tekstom), svi pominju instituciju |
| Srbijavoz a.d. Beograd | 10 funkcionera, svi pod nazivom institucije | 702 ugovora, naručilac „"Srbijavoz" a.d. Beograd“ odgovara; 2021-2026 | institucija „Akcionarsko društvo za železnički prevoz putnika Srbijavoz Beograd“; 4 dobavljača sa APR profilom, nazivi se poklapaju | 10 izveštaja, svi imenuju instituciju u naslovu | 2 oznaka, svi naručioci odgovaraju | 60 članaka u 12 meseci (0 potvrđeno tekstom), svi pominju instituciju |
| Srbija Kargo a.d. | 11 funkcionera, svi pod nazivom institucije; 2 zastarelih zapisa bez datuma prestanka se ignoriše | 299 ugovora, naručilac „Srbija Kargo a.d.“ odgovara; 2021-2026 | institucija „Akcionarsko društvo za železnički prevoz robe Srbija Kargo Beograd-Savski Venac“; 2 dobavljača sa APR profilom, nazivi se poklapaju | 12 izveštaja, svi imenuju instituciju u naslovu | 3 oznaka, svi naručioci odgovaraju | 20 članaka u 12 meseci (8 potvrđeno tekstom), svi pominju instituciju |
| Železnice Srbije a.d. | 2 funkcionera, svi pod nazivom institucije | 48 ugovora, naručilac „ŽELEZNICE SRBIJE AD“ odgovara; 2020-2026 | institucija „Železnice Srbije akcionarsko društvo, Beograd“; 3 dobavljača sa APR profilom, nazivi se poklapaju | 4 izveštaja, svi imenuju instituciju u naslovu | 0 oznaka, svi naručioci odgovaraju | 18 članaka u 12 meseci (1 potvrđeno tekstom), svi pominju instituciju |
| Putevi Srbije | 12 funkcionera, svi pod nazivom institucije | 505 ugovora, naručilac „Društvo sa ograničenom odgovornošću "Putevi Srbije" Beograd“ odgovara; 2020-2026 | institucija „Društvo s ograničenom odgovornošću Putevi Srbije Beograd“; 2 dobavljača sa APR profilom, nazivi se poklapaju | 28 izveštaja, svi imenuju instituciju u naslovu | 2 oznaka, svi naručioci odgovaraju | 60 članaka u 12 meseci (0 potvrđeno tekstom), svi pominju instituciju |
| Koridori Srbije d.o.o. | 6 funkcionera, svi pod nazivom institucije | 136 ugovora, naručilac „"KORIDORI SRBIJE" DOO BEOGRAD“ odgovara; 2021-2026 | institucija „KORIDORI SRBIJE DRUŠTVO S OGRANIČENOM ODGOVORNOŠĆU BEOGRAD (STARI GRAD)“; 2 dobavljača sa APR profilom, nazivi se poklapaju | 8 izveštaja, svi imenuju instituciju u naslovu | 0 oznaka, svi naručioci odgovaraju | 20 članaka u 12 meseci (12 potvrđeno tekstom), svi pominju instituciju |

## Upozorenja

_Nema._

## Greške

_Nema: sve provere prolaze._

## Gramatika

Provereni su naslovi i tekstovi nalaza, sažetak, lista za proveru, izveštaj i razlozi Mape: bez grešaka u slaganju broja sa imenicom (1 ugovor, 3 ugovora, 7 ugovora; mesec/meseca/meseci; nalaz/nalaza; ...).

## Pronađeno i ispravljeno u ovoj iteraciji

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
