# Pravni izvori: rokovi za v.d., Službeni glasnik, PEP

Kod: `src/data/rules/vdRules.ts`, `src/data/sources/paragraf.ts`, `src/data/sources/pep.ts`
Tekstovi zakona proveravani 30.10.2026. na besplatnim punim tekstovima na paragraf.rs (isti članovi su u Službenom glasniku).

## 1. Rokovi za vršioca dužnosti (`VD_RULES`)

| `legalType` | Zakon | Član | Maks. | Produženje | Napomena |
|---|---|---|---|---|---|
| `javno_preduzece` | Zakon o javnim preduzećima ("Sl. glasnik RS", br. 15/2016 i 88/2019) | čl. 52 st. 1-3 | 12 mes. | nema | isto lice ne može biti dva puta imenovano za v.d. |
| `drustvo_kapitala_drzavno` | Zakon o upravljanju privrednim društvima koja su u vlasništvu Republike Srbije ("Sl. glasnik RS", br. 76/2023) | čl. 23 st. 2 | 12 mes. | nema | primena od 15.09.2024. (čl. 51) |
| `zdravstvena_ustanova` | Zakon o zdravstvenoj zaštiti ("Sl. glasnik RS", br. 25/2019, 92/2023 - autentično tumačenje i 29/2025 - odluka US) | čl. 117 st. 1 | 6 mes. | nema | v.d. „može imati samo jedan mandat" |
| `organ_drzavne_uprave` | Zakon o državnim službenicima ("Sl. glasnik RS", br. 79/2005 i kasnije izmene, poslednja 80/2026) | čl. 67a st. 1 i 4 | 6 mes. | +3 mes. | produženje samo ako konkurs ne okonča postavljenjem ili ne uspe |
| `lokalna_samouprava` | nema pravila u tabeli | | | | `ruleFor()` vraća `undefined`; ne tvrditi rok |
| `ostalo` | nema pravila u tabeli | | | | isto; ustanove (kultura, obrazovanje) imaju posebne zakone koji nisu proveravani |

Javna komunalna preduzeća lokalne samouprave su `javno_preduzece` (ZJP važi i za njih), a ne `lokalna_samouprava`.
`monthsBetween(from, to)` vraća pune kalendarske mesece i preostale dane (22.05.2025. do 30.10.2026. = 17 meseci, 8 dana).

### Citirane odredbe (kratko, doslovno)

- **ZJP čl. 52**: „Vršilac dužnosti direktora može se imenovati do imenovanja direktora javnog preduzeća po sprovedenom javnom
  konkursu. Period obavljanja funkcije vršioca dužnosti direktora ne može biti duži od jedne godine. Isto lice ne može biti dva
  puta imenovano za vršioca dužnosti direktora." <https://www.paragraf.rs/propisi/zakon_o_javnim_preduzecima.html>
- **ZJP čl. 53 st. 2**: „Odredbe čl. 24-26. i čl. 29-52. ovog zakona primenjuju se i na društvo kapitala čiji je jedini vlasnik
  Republika Srbija, autonomna pokrajina i jedinica lokalne samouprave." (zato čl. 52 važi i za 100% državno društvo kapitala)
- **Zakon o upravljanju privrednim društvima koja su u vlasništvu RS čl. 23 st. 2**: „Izuzetno od stava 1. ovog člana, do imenovanja
  direktora po sprovedenom javnom konkursu, imenuje se vršilac dužnosti direktora, shodnom primenom Zakona, bez sprovođenja javnog
  konkursa, a najduže na period do godinu dana." Čl. 3 st. 1: društvo kapitala je d.o.o. ili a.d. u kojem RS ima više od 50% kapitala
  ili kontrolno vlasništvo. <https://www.paragraf.rs/propisi/zakon-o-upravljanju-privrednim-drustvima-koja-su-u-vlasnistvu-republike-srbije.html>
- **Zakon o zdravstvenoj zaštiti čl. 117 st. 1**: „... dok se ne sprovede konkurs za direktora, osnivač će imenovati vršioca dužnosti
  direktora na period ne duži od šest meseci, koji može imati samo jedan mandat." <https://www.paragraf.rs/propisi/zakon_o_zdravstvenoj_zastiti.html>
- **Zakon o državnim službenicima čl. 67a**: „Do postavljenja državnog službenika na položaj, može biti postavljen jedan ili više
  vršilaca dužnosti, na ukupni period do najviše šest meseci, bez internog ili javnog konkursa." (st. 1); „... status vršioca dužnosti
  može se produžiti najduže još tri meseca." (st. 4) <https://www.paragraf.rs/propisi/zakon_o_drzavnim_sluzbenicima.html>

Ispravka u odnosu na istraživanje tima: „čl. 23 za privredna društva u državnom vlasništvu" je član **Zakona o upravljanju privrednim
društvima koja su u vlasništvu Republike Srbije (76/2023)**, ne ZJP. Rok je isti (godinu dana), pa je zaključak za IŽS isti po oba zakona.

### Primena na IŽS (za Kadrovika)

Prema medijima (N1/Danas, 24.05.2025.) Vlada je Jevtića imenovala „na osnovu člana 52. stav 1. Zakona o javnim preduzećima i člana
43. stav 2. Zakona o Vladi": to je tvrdnja medija, ne gotov akt (tekst rešenja nije javno dostupan besplatno). Ni po jednom od dva
primenljiva zakona v.d. ne sme trajati duže od 12 meseci. Pravnu kvalifikaciju IŽS (javno preduzeće ili društvo kapitala) ne određuje
adapter: `vd_provera` treba da prikaže oba i da označi „signal za proveru", ne zaključak. Ista osoba nije dvaput imenovana (prema ACAS),
ali se na istom mestu od 2020. u ACAS-u smenila četvorica v.d. (Šurlan, Tanasković, Maksimović, Jevtić); zakon zabranjuje dvostruko imenovanje
istog lica, ne niz različitih v.d., pa to je samo zapažanje za proveru.

## 2. Službeni glasnik (`paragraf.ts`)

Izvor: besplatni sadržaji brojeva Službenog glasnika na paragraf.rs
(`https://www.paragraf.rs/glasila/rs/sluzbeni-glasnik-republike-srbije-<broj>-<godina>.html`).

- `robots.txt` zabranjuje samo `/pdf/*`, `/arhiva_*`, `/obrasci/*` i sl.; `/glasila/` je dozvoljen. Uslovi korišćenja
  (`prakticna-pravila-pruzanja-usluga`) ne pominju automatsko čitanje javnih strana; čita se samo sadržaj broja (naslovi akata),
  uz keš i uz navođenje izvora. Tekstovi akata (pretplata) se ne preuzimaju.
- Nalazi iz sadržaja brojeva sadrže samo **naslov akta**, ne ime osobe. Ime se uzima iz ACAS-a samo da bi se odredio vremenski prozor
  (datum stupanja ± 3 dana do +21 dan). Poklapanje znači: u tom prozoru je objavljen akt tog tipa za tu ustanovu, ne da imenuje baš tu osobu.
- Datum u `AppointmentAct.date` je datum izlaska broja, ne datum donošenja rešenja (Vlada odlučuje dan ranije).
- `source.official=false` jer je izvor komercijalni prepis sadržaja; sam akt je u Službenom glasniku. Urednik može prevesti u „zvanično"
  ako ga ACAS potvrđuje.
- Brojevi se nalaze binarnom pretragom po datumu izdanja (do ~8 zahteva po datumu); svaki pregledani broj je keširan u
  `data/cache/paragraf/sg-<godina>-<broj>.json` (samo naslovi akata o imenovanju/razrešenju/prestanku, nije ceo sadržaj).
  Nepostojeći brojevi (404) se takođe keširaju; za tekuću godinu osvežiti keš u `live` režimu.

Pronađeno za IŽS (naslovi iz Službenog glasnika, ćirilicom ili latinicom u izvoru):

| Datum broja | Broj | Akt |
|---|---|---|
| 23.05.2025. | 44/2025 | Rešenje o razrešenju v.d. generalnog direktora AD za upravljanje javnom železničkom infrastrukturom „Infrastruktura železnice Srbije", Beograd |
| 23.05.2025. | 44/2025 | Rešenje o imenovanju v.d. generalnog direktora istog društva |
| 06.12.2024. | 97/2024 | Rešenje o imenovanju v.d. generalnog direktora istog društva |
| 29.11.2024. | 95/2024 | Rešenje o razrešenju v.d. generalnog direktora istog društva |
| 07.05.2024. | 41/2024 | Rešenje o imenovanju v.d. generalnog direktora istog društva |

Datumi se slažu sa ACAS-om (Jevtić od 22.05.2025., Maksimović od 05.12.2024., Tanasković od 07.05.2024.).
Ostalo što je ispitano: pravno-informacioni-sistem.rs (službeni PIS) je Vue SPA bez dokumentovanog API-ja; izvor sa tekstom rešenja
(Službeni glasnik pretplata, Paragraf Lex) nije slobodan. Linkovi ka pojedinačnim aktima na paragraf.rs ne postoje u besplatnom sadržaju broja.

## 3. PEP (`pep.ts`)

- **OpenSanctions** (zbirka `peps`, `targets.simple.csv`, ~180 MB, preuzima se strimovano i filtrira na `countries` sadrži `rs`,
  `schema=Person`): 1.387 osoba (verzija `20261029152704-lww`). Sirove odabrane kolone idu u `data/raw/opensanctions-peps-rs.csv`
  (gitignored), kompaktna lista (ime, do 6 alijasa, godina rođenja, nazivi skupova podataka) u `data/cache/pep/opensanctions-rs.json`.
  Kolone telefon/e-mail/adresa se ne čitaju. Licenca: **CC BY-NC 4.0** (nekomercijalna upotreba uz navođenje izvora,
  <https://www.opensanctions.org/licensing/>); za komercijalnu upotrebu treba licenca. Poklapanje je samo po imenu (isti redosled
  reči ili isto ime i prezime sa srednjim imenom, prag 0,85). Pisanje sa „x"/„w" u izvoru (npr. „Alexander Sapic") neće pogoditi.
- **KRIK Baza imovine političara** (<https://imovinapoliticara.krik.rs/>): `robots.txt` ne postoji (404), nema posebnih uslova na strani.
  Čita se samo indeks profila (ime, stranka, link): 79 profila u `data/cache/pep/krik-profiles.json`. Sadržaj profila (imovina, firme)
  se ne kopira; novinar prati link. Da bi se profili dublje koristili, treba pitati KRIK (`dopunibazu@krik.rs` je adresa za dopune).
- `matchPep("Zoran Jevtić")` nema podudaranja u oba izvora (očekivano: nije poslanik, pa ni PEP u ovim bazama; to ne znači da nije funkcioner,
  za to služi ACAS).
