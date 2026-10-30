# Integrity Watch Srbija (Transparentnost Srbija)

Adapter: `src/data/sources/integrityWatch.ts` · probe: `scripts/probe-jn.ts` · cache: `data/cache/integrity_watch/`
Platform: https://integritywatchserbia.org.rs (the old `integritywatch.rs` does not resolve). Operator: Transparentnost Srbija (NGO, not a state register,
so `SourceRef.official = false`).

## Files (all public, plain HTTP GET, no login)

| file | size | content |
|---|---|---|
| `/data/downloadable_csv_xls/contracts_full.csv` (same bytes as `/data/contracts_full_flagged.csv`, per year `/data/contracts_years/contracts_<YYYY>.csv`, xlsx twin) | ~103 MB, 358,026 rows | every public-procurement contract lot, 2021-01-01 .. 2026-03-31 (what the "Preuzmi podatke (csv)" button downloads) |
| `/data/companies_close_to_parties.csv` | 5 KB, 39 companies | `pib,company_name,source`: companies IW links to a political party; `source` is the media article used |
| `/data/companies_income.json` (csv: `/data/downloadable_csv_xls/companies_incomes.csv`) | 208 KB | MBR (matični broj), PIB, name, income and won-tender totals 2021-2024 for those companies |
| `/data/strings.json` | 31 KB | UI texts (column titles, descriptions) |

The contracts file is the same data as the Portal javnih nabavki lot-level contracts (`VContracts`), transliterated to Latin, enriched with three flag columns.
The platform's own table loads `contracts_full_flagged.csv` / `contracts_years/contracts_<year>.csv` (found in `static/main.js`).
The text has encoding damage at the source (e.g. `parkirali��ta`); names with š/ž/č are mostly fine.

## Columns of `contracts_full.csv` (19, in file order)

| # | column | meaning |
|---|---|---|
| 1 | `TenderId` | portal procedure id (`https://jnportal.ujn.gov.rs/tender-eo/<id>`) |
| 2 | `TenderName` | procedure name |
| 3 | `OfficialName` | contracting authority (name only, no PIB) |
| 4 | `LotId` | lot id |
| 5 | `LotTitle` | lot title |
| 6 | `LotNo` | lot number (may be empty, may be `1.0`) |
| 7 | `ContractNo` | contract number |
| 8 | `ContractDate` | `YYYY-MM-DD` |
| 9 | `LotContractedValue` | contract value without VAT, RSD |
| 10 | `LotContractedValueVAT` | contract value with VAT |
| 11 | `FinalValue` | value after annexes, without VAT |
| 12 | `FinalValueVAT` | value after annexes, with VAT |
| 13 | `Currency` | always `RSD` in this file |
| 14 | `ContractorIDs` | supplier PIBs, comma separated (joint bids have several) |
| 15 | `ContractorsNames` | supplier names, comma separated (names may contain commas) |
| 16 | `Year` | contract year |
| 17 | `ContractorCompaniesRealtedToPublicOfficial` (sic) | Python-style list of PIBs among the suppliers that IW flags as **related to a public official** (`['100731198']`, `[]` if none). No person name |
| 18 | `ContractorCompaniesWithPoliticalRelations` | list of PIBs among the suppliers that IW flags as **linked to a political party/subject** (`['113080389']`). No party name; the basis is in `companies_close_to_parties.csv` |
| 19 | `ContractorHasWonTendersFromSingleAuthority` | list of PIBs that won tenders from a single authority only (a concentration flag, **not** an official/political link: ignored by the adapter) |

Totals in the file: flag 17 on 796 rows, flag 18 on 1,983 rows, both on 494 rows, flag 19 on 19,852 rows; 2,285 rows carry flag 17 or 18 (41 distinct firms:
12 official-related, 33 party-linked). IŽS: 1,350 rows (2021 to 2026), 49 carry a link flag.

### `companies_close_to_parties.csv`
`pib`, `company_name`, `source` (URL of the media article that documents the link).

### `companies_income.json` (array of objects)
`MBR`, `PIB`, `name`, `income_allyears_thousands_RSD_num`, `won_tenders_value_allyears_num`, `won_tenders_value_allyears_thousands_RSD_num`,
`tenders_won_from_single_authority`, `frameworkagreements_won_from_single_authority`, `authorities_tenders_won_from` (+ yearly income / tender totals). The adapter takes only `MBR` and `PIB`.
(CSV twin columns: `MBR, PIB, Company name, Income in thousands RSD 2021..2024, Total value of tenders won 2021..2024, Comparison of value of tenders won to total income 2021..2024 %`.)

## What the adapter does

`buildIndex()` downloads the 103 MB CSV to `data/raw/iw/contracts_full.csv` (gitignored; skipped when already there, always re-downloaded in `DATA_MODE=live`), streams it with
`csv-parse` and keeps only rows with flag 17 or 18. Per (authority, flagged firm) it aggregates: kinds (`official` / `political`), number of flagged contracts, value of contracts
where the firm is the **sole** supplier, number and value of **joint bids** (value of the whole bid, not attributed to the firm), first/last date and the 5 largest contracts.
Result (699 pairs, 480 KB) is cached as one compact JSON string in `data/cache/integrity_watch/index.json`; with it `getLinksForAuthority` and `getLinksForSupplier` work offline for **any**
authority and supplier, not only IŽS. Derived results are cached too (`authority-<name>.json`, `supplier-<pib>.json`); a missing derived file in `DATA_MODE=cache` is recomputed from the index.

- `getLinksForAuthority({name})` matches the authority by normalized name (IW has no authority PIB), returns one `IntegrityWatchLink` per firm and link kind, biggest first.
- `getLinksForSupplier({pib?, mb?, name?})`: by PIB; by MB through the MB<->PIB table (only for the 32 party-linked firms with MBR); by name (similarity >= 0.9). Companies from
  `companies_close_to_parties.csv` that have no flagged contract row are returned with the party link only.
- `linkType`: `povezanost sa javnim funkcionerom` or `povezanost sa političkim subjektom`. `linkedPerson` is always empty (the open data names neither the official nor the party).
  `detail` says what the flag means, the media source for party links, number of flagged contracts, joint bids, period and the largest contract.
- `source.url` is the public platform (`/?l=sr` or `/companies.php?l=sr`); there is no per-company deep link.
- An empty result means "no flag in the IW dataset as of the download", not "no link exists".

## Caveats

- Flags are IW's own research (media/registers); the CSV does not say who the official is or which party. They are **signals for verification**, never proof.
- Joint bids: the flag is attached to a firm inside the bid; the whole bid value is shown only as `joint` in `detail`.
- `OfficialName` is a name only: authorities with similar names can be confused (the adapter requires equal normalized name or similarity >= 0.85).
- Dataset ends 2026-03-31, the Portal data in `jnportal` is newer (until October 2026).
