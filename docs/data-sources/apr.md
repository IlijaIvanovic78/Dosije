# APR (Agencija za privredne registre): otvoreni podaci

Adapter: `src/data/sources/apr.ts` (`getCompany`, `findInstitutionCompany`).
Index builder: `scripts/build-apr-index.ts`. Probe: `scripts/probe-apr.ts`.

## Datasets (data.gov.rs, publisher: Agencija za privredne registre)

| dataset | data.gov.rs page | download (JSON, no login) | size |
|---|---|---|---|
| Registar privrednih društava | https://data.gov.rs/sr/datasets/api-za-registar-privrednikh-drushtava/ | https://openapi.apr.gov.rs/api/opendata/companies | 58.0 MB |
| Registar finansijskih izveštaja (ključni pokazatelji RGFI) | https://data.gov.rs/sr/datasets/api-za-registar-finansijskikh-izveshtaja-baza-fi-za-privredna-drushtva/ | https://openapi.apr.gov.rs/api/opendata/companies/financial-statements | 56.9 MB |

- Found via `https://data.gov.rs/api/1/organizations/?q=<cyrillic>` (organization `agentsija-za-privredne-registre`) and
  `https://data.gov.rs/api/1/datasets/?organization=<id>`. Free-text dataset search (`?q=`) returned nothing for these.
- Update frequency: monthly. Both files carry `DatumPreseka` (cut-off date): **2026-09-30** at the time of the build;
  data.gov.rs shows last update 2026-10-21.
- License: `sodl` ("Српска лиценца за отворене податке"); published as EU high-value datasets (Reg. 2023/138).
- Same dump also available for associations/foundations (`/api/opendata/ngo`), not used.
- There is **no per-company endpoint** (`/companies/<mb>` and `?mb=` are 404 / ignored and return the full dump).
  So lookups use the committed index; there is no live fallback.

## Fields

Companies file: `Podaci{ <MB>: { PoslovnoIme, SifraOpstine, NazivOpstine, NazivStatus, DatumOsnivanja, NazivPravneForme, SifraDelatnosti } }`
(134,374 companies: aktivan 125,054; u likvidaciji 6,122; u prinudnoj likvidaciji 1,826; u stečaju 1,372).

Financial file: `Podaci{ <MB>: { GodinaFi, PoslovnoIme, SifraOpstine, NazivOpstine, PoslovnaImovina, Kapital, Gubitak, UkupniPrihodi, NetoDobitak, NetoGubitak, ProsecanBrojZaposlenih } }`
(123,454 rows: 112,644 for 2025, 10,810 for 2024; the latest filed year per company).

Not in the open data: owners, directors, PIB, address, per-activity names.

Mapping to `CompanyProfile`:

| CompanyProfile | source |
|---|---|
| `mb` | key, trimmed, left-padded to 8 digits (some keys have a trailing space or lost leading zeros) |
| `name` | `PoslovnoIme`, transliterated to Latin (mixed scripts in the source) |
| `founded` | `DatumOsnivanja` |
| `municipality` | `NazivOpstine` (registered seat), Latin, title case |
| `activityCode` | `SifraDelatnosti` (4-digit šifra delatnosti; names are not in the data, so `activityName` is never set) |
| `legalForm`, `status` | `NazivPravneForme`, `NazivStatus`, Latin |
| `revenueRsd`, `revenueYear` | `UkupniPrihodi` (AOP 1043, **ukupni prihodi**, not only operating revenue) x 1000, `GodinaFi` |
| `employees` | `ProsecanBrojZaposlenih` (AOP 9005, average number of employees) |

**Unit assumption:** the API does not state units. RGFI forms are filed in thousands of dinars, so amounts are multiplied by
1000. Checks: Telekom Srbija 219,037,607 -> 219 mlrd RSD; a small company with `7901` -> 7.9 mil RSD (7,901 RSD would be absurd).
A company's financial row is absent for ~18k companies (no filed RGFI): `revenueRsd`, `revenueYear`, `employees` are then undefined.
7,102 financial rows have an MB that is not in the register file (deleted or other entity type); they are not indexed.
An `employees: 0` / revenue 0 is what the company filed (often an empty report), not a missing value.

`SourceRef`: `kind: "apr"`, `official: true`, title `APR – otvoreni podaci: <name> (MB ..., presek <date>)`, url = the data.gov.rs
dataset page (financial dataset when revenue/employees are present, otherwise the companies dataset), `retrievedAt` = cut-off date
at 00:00Z, `publishedAt` = cut-off date. The APR company search (https://pretraga2.apr.gov.rs/unifiedentitysearch) is behind
reCAPTCHA, so it is not used as the source URL.

## TLS fix (do not disable verification)

`openapi.apr.gov.rs` (cert `*.apr.gov.rs`) sends only the leaf certificate. Node fails with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`.
Fix, done with `node:tls` only:

1. `tls.connect({ rejectUnauthorized: false })` just to read `getPeerCertificate(true)` (no data is sent).
2. Leaf issuer: "SSL2BUY EMEA RSA Domain Validation Secure Server CA". AIA `CA Issuers`:
   `http://crt.sectigo.com/SSL2BUYEMEARSADomainValidationSecureServerCA.crt` (DER).
3. Downloaded it, converted DER -> PEM with `crypto.X509Certificate#toString()`, saved as `certs/apr-chain.pem`
   (valid until 2034-07-30, SHA-256 `58:F0:F7:56:...:89:FF:1F`). It chains to "Sectigo Public Server Authentication Root R46",
   which is in Node's built-in root store, so only the intermediate is needed.
4. `src/data/http.ts` `caFile: "certs/apr-chain.pem"` builds `tls.rootCertificates + this file`; verification stays on.
   The path is relative to the working directory (run from the repo root).

The leaf certificate expires 2026-11-13; the server will then present a renewed leaf, normally issued by the same intermediate.
If TLS fails again, repeat steps 1 to 3.

## Index (`data/static/apr-index.json.gz`, committed)

Built by `npx.cmd tsx scripts/build-apr-index.ts` (`--refresh` forces a new download; raw files are kept in `data/raw/apr/`, gitignored).
Companies and financial rows are joined by MB. Size: 20.2 MB JSON -> **5.8 MB gzip**. Load (gunzip + parse): ~0.6 s once per process,
then MB lookups take microseconds; the first fuzzy name lookup builds a token index (~0.15 s).

Structure: `rows{ mb: [name, founded, municipalityIdx, activityCode, legalFormIdx, statusIdx, revenueRsd, revenueYear, employees] }`,
lookup tables for municipality / legal form / status, `names{ normalizedName: mb | mb[] }`.

Cache note: `cached()` is not used because there is no per-company request to cache; the committed index plays that role and
works in every `DATA_MODE`. If the file is missing, `apr.ts` logs a warning and returns `null`.

## Matching approach and limits

- **By MB** (`getCompany({mb})`): exact; accepts 1 to 8 digits (left-padded). Unknown MB -> `null` (then falls back to `name` if given).
- **By PIB only: always `null`.** The data has no PIB, and PIB -> MB has no legal algorithmic mapping. Use MB from another source
  (Portal javnih nabavki, ACAS) or ask the journalist.
- **By name** (`getCompany({name})`): `aprNormalize` (`src/data/sources/aprNames.ts`: `translit.normalizeName` plus a fix for
  "društvo s ograničenom odgovornošću" and "d.o.o.") on both sides. Exact normalized match, otherwise token-set similarity
  (`nameSimilarity`) >= 0.8. The best candidate must be clear: a tie of equal score returns `null` unless activity status
  (aktivan preferred) or the legal form written in the query (a.d. / d.o.o. / JP) breaks it. Ambiguity -> `null`.
- **`findInstitutionCompany(name)`**: same, plus a lenient third step for official names that are longer than what people type
  (`Telekom Srbija` vs `Preduzeće za telekomunikacije Telekom Srbija akcionarsko društvo`; `Infrastruktura železnice Srbije` vs
  `Akcionarsko društvo za upravljanje javnom železničkom infrastrukturom Infrastruktura železnice Srbije`): the query (>= 2 tokens) must
  be a contiguous phrase in the name, only active companies with the matching legal form, and the shortest name must beat the
  runner-up by 25%. It is a heuristic: callers should show the returned `name` and MB to the journalist.
- Known limits: single-word queries match only exact names (e.g. `Galenika a.d.` -> `null`, the register has a long name);
  abbreviations and aliases ("NIS", "IŽS", "EPS") are not resolved here (the resolver does it); names in the register are the
  registered business names and may differ from the brand; `normalizeName` strips everything after a trailing "Beograd/Novi Sad/..."
  token; several companies may share one name (branches, successors), then the result is `null` or the single active one.
- Registered municipality is the seat in the register; the financial file has the municipality at the time of the report (can differ).
