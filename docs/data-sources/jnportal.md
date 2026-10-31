# Portal javnih nabavki (jnportal.ujn.gov.rs)

Adapter: `src/data/sources/jnportal.ts` · probe: `scripts/probe-jn.ts` · cache: `data/cache/jnportal/`

Status: **unofficial, undocumented API** used by the portal's own public pages (no login). It can change or be
rate limited without notice. Answers are cached locally (data/cache/, gitignored), so a repeated query does not depend on it.

## How the API was found

`https://jnportal.ujn.gov.rs` is ASP.NET (WebForms) + DevExtreme grids, not a SPA with bundles. `Scripts/app.js`
(55 KB) contains the generic grid loader: every public list page declares `options.gridName='<Grid>'` and the loader calls

```
GET https://jnportal.ujn.gov.rs/api/searchgrid/<GridName>/get
    ?filter=<json>&sort=<json>&group=<json>&skip=<n>&take=<n>&requireTotalCount=true
```

`filter`/`sort`/`group` are DevExtreme JSON (`["CAName","contains","..."]`, `[{"selector":"LotId","desc":false}]`).
The response is `{ "data": [...], "totalCount": N }` (with `group`: `{key, items, count}` nodes).

## Session (required, no login)

1. `GET https://jnportal.ujn.gov.rs/` (any page) returns two cookies, `ASP.NET_SessionId` and `.ASPXFORMSAUTH`
   (anonymous), and a hidden input `<input id="uiUserToken" value="<guid>">`.
2. Every API call sends header `UserToken: <guid>` and `Cookie: ASP.NET_SessionId=...`.
   Without both: 401/403. The session from any page works for every grid.
3. The portal has a `TrafficGuardModule`: when it is rate limiting, even page loads answer `500 NullReferenceException`
   (`UserSession.get_Actor`). Waiting about a minute fixes it. The adapter retries session creation (up to 6 times, growing
   delay), re-creates the session on 401/403/5xx, uses 450 ms between pages and one session per process.
4. `take` is silently capped at **100** rows per request.

Helper caveat: `src/data/http.ts` keeps only the last `Set-Cookie` header (`headers.forEach` overwrites). The portal needs
`ASP.NET_SessionId` (the first one), so the session bootstrap uses global `fetch` (`getSetCookie()`); all API calls use `getJson`.

## Grids used

| grid | page | what | key fields |
|---|---|---|---|
| `ContractorsPublic` | `/contractors` | directory of contracting authorities and economic operators (authority lookup) | `Id` (= authority id used in the other grids, IŽS = 4192), `Name`, `IdentificationNumber` (PIB), `City`, `IsContractingAuthority`, `IsContractingEntity` |
| `VContracts` | `/ugovori` | **contracts per lot** from procedures (this is the 1,537 for IŽS) | `TenderId`, `TenderName`, `OfficialName`, `LotId`, `LotTitle`, `LotNo`, `ContractNo`, `ContractDate`, `LotContractedValue`, `LotContractedValueVAT`, `FinalValue`, `FinalValueVAT`, `Currency`, `ContractorIDs` (PIB list, comma separated), `ContractorsNames` |
| `TendersAll` | `/postupci-svi` | procedures (tenders) | `Id`, `CAId`, `Name`, `ReferenceNumber`, `ProcedureTypeId`, `ProcedureType`, `CPVExtended`, `NoticePublishDate`, `TenderStatus`, `NegotiatedProcedureLegalBaseArticle` |
| `VContractRegisterPublic` | `/contracts` | contract register incl. exempt purchases (not used, see caveats) | `Id`, `TenderId`, `ProcedureTypeId`, `ContractCAId`, `CAIdentificationNumber`, `ContractorIdentificationNumber`, `TotalValue`, `TotalValueVat`, `ExemptionLegalBaseId` |

Other grids exist (`VAwardDecisions`, `VFrameworkAgreements`, `ComplaintDecisionsPRBPublic`, `AnnualStatsPublic`, ...). The full list is in the
page links of `https://jnportal.ujn.gov.rs/`.

### Requests the adapter makes

```
# authority by name (Cyrillic, "contains" is case-insensitive) or PIB
GET /api/searchgrid/ContractorsPublic/get?filter=["Name","contains","Инфраструктура железнице Србије"]&skip=0&take=50&requireTotalCount=true
GET /api/searchgrid/ContractorsPublic/get?filter=["IdentificationNumber","=","109108420"]&skip=0&take=50
# -> {"data":[{"Name":"Инфраструктура железнице Србије","Id":4192,"IdentificationNumber":"109108420","City":"Београд",
#             "IsContractingEntity":true,...}],"totalCount":1}

# all contracts of the authority (16 pages of 100 for IŽS); OfficialName is the authority name in Cyrillic
GET /api/searchgrid/VContracts/get?filter=["OfficialName","=","Инфраструктура железнице Србије"]
    &sort=[{"selector":"LotId","desc":false},{"selector":"ContractNo","desc":false}]&skip=0&take=100&requireTotalCount=true
# -> {"data":[{"TenderId":375682,"TenderName":"Средства и опрема за личну заштиту на раду","OfficialName":"Инфраструктура железнице Србије",
#      "LotId":693853,"LotTitle":"Партија 1 – ...","LotNo":1,"ContractNo":"1/2026-1/809","ContractDate":"2026-10-19T00:00:00",
#      "LotContractedValue":47588888,"LotContractedValueVAT":57106665.6,"FinalValue":47588888,"FinalValueVAT":57106665.6,
#      "Currency":"РСД","ContractorIDs":"101735363","ContractorsNames":"ПРЕДУЗЕЋЕ ТРНЕX ДОО", ...}],"totalCount":1537}

# procedures of the authority (procedure type per TenderId; 16 pages for IŽS)
GET /api/searchgrid/TendersAll/get?filter=["CAId","=",4192]&sort=[{"selector":"Id","desc":false}]&skip=0&take=100&requireTotalCount=true
# -> {"data":[{"Id":397141,"Name":"Одржавање друмских возила ...","ProcedureTypeId":6,
#      "ProcedureType":"Преговарачки поступак без објављивања јавног позива","NegotiatedProcedureLegalBaseArticle":"Члан 61. став 8.",
#      "CPVExtended":"50110000 - ...","NoticePublishDate":"2026-10-07T00:00:00","TenderStatus":"Отворене понуде / пријаве","CAId":4192,...}],"totalCount":1522}
```

`VContracts` has no procedure type, so the adapter joins it to `TendersAll` on `TenderId` (all 1,537 contracts matched).
Procedure type ids (lookup taken from the page): 1 otvoreni postupak, 2 restriktivni, 3 konkurentni sa pregovaranjem, 4 konkurentni dijalog,
5 partnerstvo za inovacije, **6 pregovarački postupak bez objavljivanja javnog poziva**, 7 pregovarački sa objavljivanjem, 11 nabavka izuzeta od
primene ZJN, 27 izmena ugovora po prethodnom ZJN, 29 mikro nabavke.

### Deep links (public)

- procedure and its contract: `https://jnportal.ujn.gov.rs/tender-eo/<TenderId>` (used as `Contract.url` and `SourceRef.url`)
- authority page (filtered contract list): `https://jnportal.ujn.gov.rs/ugovori?initFilter=["OfficialName","=","<ime na ćirilici>"]` (URL-encoded;
  the server renders the filter into the grid, verified)
- contract in the register: `https://jnportal.ujn.gov.rs/contract-eo/<VContractRegisterPublic.Id>` (not used)

## Normalization (`jnportal.ts`)

- Cyrillic -> Latin with `cyrToLat` (the portal itself shows Latin company names transliterated to Cyrillic, so `ЕЛЕЦТУС` -> `ELECTUS`).
- `valueRsd` = `LotContractedValue` (contract value at signing, without VAT), `valueRsdWithVat` = `LotContractedValueVAT`. `FinalValue` (after
  annexes) is stored in the cache (`finalValueRsd`) but not returned. Only `Currency = РСД` is used for RSD fields.
- 12 IŽS contracts are in EUR: `valueRsd` is left undefined (no exchange rate is invented); the title gets a suffix
  `[ugovor u EUR: ... bez PDV; nije preračunato u RSD]`. They are counted as contracts, excluded from RSD totals.
- Dates: `ContractDate` -> `YYYY-MM-DD`. `cpv` = 8-digit code from the tender.
- **Joint bids** (`ContractorIDs` has several PIBs, 281 of 1,537): `supplierName` = `Zajednička ponuda: <names>`, `supplierPib` = the FIRST PIB listed by the
  portal. In `getSummary().topSuppliers` a joint bid is its own bidder (key = sorted PIB set), so one PIB can appear several times
  (alone and as lead of different consortia). `getContractsWithSupplier({pib})` matches **any** member of a joint bid.
- `procedureType` carries the legal basis for negotiated procedures, e.g. `Pregovarački postupak bez objavljivanja javnog poziva (Član 61. stav 8.)`.
  `withoutPublication` = `ProcedureTypeId === 6`.
- `getSummary().withoutPublication` has **all** negotiated procedures without publication. A procedure with no published contract (open or cancelled)
  is returned as a `Contract` with `supplierName = "(nema objavljenog ugovora; status postupka: ...)"` and no value; it is not in `getContracts()`.
- No MB (matični broj) exists in these grids: `supplierMb` is always undefined (APR adapter / human fills it in).
- `getContractsWithSupplier`: with a PIB only the PIB is compared; without a PIB the name is compared on normalized words (all words of the
  wanted name inside one member name). With only an MB nothing is returned.
- HHI = sum of squared percentage shares of bidders (0..10000), shares on RSD value without VAT.

## Cache

`data/cache/jnportal/contracts-<authorityId>.json` (`contracts-4192.json`, ~750 KB): the envelope `data` field is ONE JSON **string** (compact,
instead of a pretty-printed 1 MB array): `{authority, totalTenders, contracts[], negotiated[]}`. Every other function derives from it offline.
`authority-index.json` maps id/PIB/name -> authority so `{name}` or `{pib}` without `jnId` also resolves offline (`DATA_MODE=cache`).
`authority-<query>.json` caches `findAuthority` queries. In `DATA_MODE=live` the list is re-crawled once per process (~65 s).

## IŽS numbers (crawled 2026-10-30)

| | |
|---|---|
| Authority | Infrastruktura železnice Srbije, id 4192, PIB 109108420 |
| Contracts (`VContracts`) | **1,537** (1,525 RSD, 12 EUR; one duplicated lot row kept as the portal lists it) |
| Procedures (`TendersAll`) | 1,522 (1,506 otvoreni, 10 negotiated w/o publication, 6 izmena ugovora po starom ZJN) |
| Total value, RSD without VAT | **65,362,337,153** (original contract values; with later annexes 58,142,013,945) |
| Period (signing dates) | 2020-09-25 to 2026-10-26 |
| By year (contracts / RSD M) | 2020: 22 / 1,037 · 2021: 198 / 2,759 · 2022: 270 / 15,019 · 2023: 316 / 9,878 · 2024: 242 / 17,203 · 2025: 265 / 9,656 · 2026: 224 / 9,810 |
| HHI (bidder shares) | 1,032 |
| Largest bidder | EPS (PIB 103920327), 14 contracts, 17.24 bn RSD, 26.4 % |
| Negotiated w/o publication | 10 procedures: 8 with a contract (total 87.35 M RSD without VAT), 2 without (one open, one cancelled) |

## Caveats

- Unofficial API: shapes, limits and the session scheme can change. Treat every number as "prema podacima sa Portala javnih nabavki na dan preuzimanja".
- `VContracts` (1,537) is lot-level and covers procedures only. The register grid `VContractRegisterPublic` (1,088 rows for IŽS) additionally has
  366 contracts "izuzeti od primene ZJN" (procedure type 11, ~275 M RSD) with no tender. They are **not** included in the 1,537 / 65.4 bn.
- `LotContractedValue` can differ a lot from `FinalValue` after annexes (25 contracts; e.g. contract 1/2022-1/145: 4.80 bn at signing, 45.1 M after changes).
  Journalists should check the contract page before quoting a value.
- Winners are as published on the portal; groups of bidders are listed by name without roles.
- Name matching on names is a convenience; PIB is the reliable key.

## Crawl cap for big authorities (live path)

A judge can type an authority that was never cached. EPS has 10,037 contract lots and 167 pages of procedures: crawling all of it takes
minutes. `fetchStore` therefore reads **the most recent contracts only**:

- `VContracts` is sorted by `ContractDate` (newest first), then `LotId`, and read until `MAX_CONTRACTS` (1,500) rows or 36 s
  (`CRAWL_BUDGET_MS` 60 s x 0.6) are reached. The store records `coverage = {total, analyzed, truncated, from, proceduresPartial}` (the portal's
  `totalCount`, the rows read, the oldest signing date). Older cache files have no `coverage` and mean "everything was read".
- Procedures (`TendersAll`) are read from the oldest tender among those contracts (`Id >= min TenderId`), with their own budget. The
  negotiated procedures without a public call are asked for directly (`ProcedureTypeId = 6`, a few rows), so that list is complete for the
  analysed period even when the crawl of procedures stopped early (`proceduresPartial`).
- Every figure then describes the analysed period. The finding text says so ("Analiza obuhvata samo poslednjih 1.500 od ukupno 10.037
  ugovora ... potpisanih od ..."), the finding title does ("poslednjih 1.500 od 10.037 ugovora"), and the BEZ_OBJAVE / KONCENTRACIJA texts repeat the
  period. Aggregates (total value, HHI, top supplier, share of negotiated procedures) are computed on the same rows, never extrapolated.
- A renamed authority's older contracts (old `OfficialName`) are read only while the cap and the budget leave room: they are older than
  what the current name holds.
- `authorityActivity(a)` (one request) tells a live registration from an old one: contracts count and the date of the latest contract.
  The resolver uses it when several portal entries have the same name.
- `authority-index.json` is a read-modify-write file: writes are serialized and `writeCache` is write-then-rename (parallel lookups once
  overwrote the index with a partial copy).
