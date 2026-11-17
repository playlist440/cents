# Cents — specification

Cents is a self-hosted household-finance web app for one Dutch family. It replaces Firefly III,
which the owner found far too complex. The single reason Cents exists is a beautiful, effortless,
self-explanatory UI in Apple style. Dutch UI, English code.

This document is the contract between all builders. If something is ambiguous, choose the option
that is simplest for the family using the app, and note the choice in `docs/DECISIONS.md`.

## 1. Product principles

1. **Self-evident.** No onboarding, no manuals, almost no explanatory text. If a screen needs a
   paragraph of explanation, the design is wrong.
2. **Sort merchants, not transactions.** One decision ("Jumbo is Boodschappen") covers every past
   and future transaction of that merchant. The app learns from every correction.
3. **Zero configuration.** Import a file and everything works: accounts appear, categories are
   filled, fixed costs and savings are recognised. Settings are optional.
4. **One household.** One shared password, no user management.
5. **Private.** All data stays in one SQLite file on the owner's server. No external requests at
   runtime: no CDN, no fonts, no analytics, no telemetry. Everything is vendored.
6. **Dutch, plain words.** "bakje", "vaste lasten", "nog te besteden", "over". No finance jargon.

## 2. Architecture

- One Docker container. Python 3.12, FastAPI + uvicorn, stdlib `sqlite3` (WAL mode), no ORM.
- Frontend: static files served by FastAPI. **No build step**: ES modules, Preact + htm +
  @preact/signals (vendored in `frontend/js/vendor/`), hand-written CSS, custom SVG charts.
- Data dir: env `CENTS_DATA_DIR` (default `/data`), contains `cents.db`. Session secret and
  password hash live in the DB. **No required environment variables.**
- Port 8000 inside the container.
- Money is always integer **cents**, signed: negative = money out ("af"), positive = in ("bij").
- Dates are ISO `YYYY-MM-DD` strings. Timezone Europe/Amsterdam for "today".

```
cents-app/
  backend/cents/            python package
    main.py                 app factory, static mount, security headers
    config.py  db.py  auth.py  schemas.py
    importers/              asn_csv.py  camt053.py  detect.py  normalize.py
    classify/               engine.py  library.py
    data/                   categories.json  mcc.json  merchants.json  keywords.json
                            asn_categories.json  bank_codes.json
    services/               periods.py transfers.py summary.py recurring.py insights.py
                            goals.py networth.py
    api/                    one router module per resource
  frontend/                 index.html  manifest.webmanifest  icons/  css/  js/
  tests/                    pytest, synthetic fixtures only
  tools/make_demo_data.py   generates a synthetic household (ASN CSV + CAMT files)
  Dockerfile  docker-compose.yml  requirements.txt  .github/workflows/build.yml
```

Local development (no Docker and no Node on the dev machine; never create a venv inside the
project folder because it is cloud-synced):

```
CENTS_DATA_DIR=~/.cache/cents-dev uv run --python 3.12 --with-requirements requirements.txt \
  uvicorn cents.main:app --app-dir backend --port 8765
```

## 3. Privacy rules for builders (hard requirements)

- The parent folder contains the owner's real financial data. Never read anything outside
  `cents-app/` except the two sample files in `../Voorbeelden/` (format reference only).
- Never copy real names, IBANs, amounts or descriptions into code, tests, fixtures, docs or
  commit messages. All fixtures are synthetic (`tools/make_demo_data.py`).
- Nothing in `cents-app/` may contain personal data: this folder becomes a GitHub repository.

## 4. Data model (SQLite)

```sql
settings(key TEXT PRIMARY KEY, value TEXT)            -- JSON values
accounts(id INTEGER PK, iban TEXT UNIQUE NULL, name TEXT, type TEXT,   -- checking|savings|credit|investment
         match TEXT,            -- JSON list of lowercase keywords identifying transfers to this account
         manual_balance_cents INTEGER NULL, manual_balance_date TEXT NULL,
         hidden INTEGER DEFAULT 0, sort INTEGER, created_at TEXT)
imports(id PK, filename, format, imported_at, account_id, n_new, n_duplicate, n_enriched,
        date_from, date_to)
transactions(id PK, account_id, import_id NULL, dedupe_key TEXT UNIQUE,
  date, value_date, amount_cents, balance_after_cents NULL, seq INTEGER,   -- seq = bank sequence number
  counterparty_name, counterparty_iban, description, raw_description,
  method,            -- card|ideal|debit|transfer|atm|internal|fee|interest|other
  pay_type, bank_code, iso_family, iso_subfamily, mcc, wallet, city,
  end_to_end_id, mandate_id, creditor_id, bank_category,
  merchant_key, merchant_name,
  category_id, category_source,    -- user|rule|merchant|mcc|keyword|bank|heuristic|none
  kind,              -- normal|transfer|settlement   (transfer = between own accounts)
  transfer_account_id NULL, goal_id NULL, note, manual INTEGER DEFAULT 0,
  created_at, updated_at)
categories(id PK, key TEXT UNIQUE, name, emoji, color, grp, sort, hidden INTEGER, builtin INTEGER)
tags(id PK, name TEXT UNIQUE, emoji, color, archived INTEGER, created_at)
transaction_tags(transaction_id, tag_id, PRIMARY KEY(transaction_id, tag_id))
rules(id PK, merchant_key TEXT UNIQUE, category_id NULL, tag_id NULL, created_at)  -- learned from the user
goals(id PK, name, emoji, color, target_cents, target_date NULL, repeat TEXT,      -- none|yearly
      code TEXT UNIQUE, keywords TEXT, archived INTEGER, sort, created_at)
goal_entries(id PK, goal_id, date, amount_cents, transaction_id NULL, kind, note)  -- auto|manual|adjust
account_values(id PK, account_id, date, value_cents)       -- manual valuations (investments)
recurring_ignored(key TEXT PRIMARY KEY)
sessions(token_hash TEXT PRIMARY KEY, created_at, expires_at)
```

Indexes on `transactions(date)`, `(account_id, date)`, `(merchant_key)`, `(category_id, date)`.
Schema versioning with `PRAGMA user_version` and forward-only migrations in `db.py`.

### 4.1 Categories ("bakjes")

Fixed keys; names, emoji and colours are editable by the user, the user may add and hide bakjes.
`grp` drives every calculation and is not editable for builtin categories.

| key | name | emoji | grp | color |
|---|---|---|---|---|
| salaris | Salaris | 💼 | income | green |
| toeslagen | Toeslagen & uitkeringen | 🏛️ | income | mint |
| inkomen-overig | Overig inkomen | 💶 | income | teal |
| wonen | Wonen | 🏠 | fixed | indigo |
| energie | Energie & water | ⚡ | fixed | yellow |
| verzekeringen | Verzekeringen | 🛡️ | fixed | blue |
| telecom | Internet, tv & bellen | 📶 | fixed | cyan |
| abonnementen | Abonnementen | 🔁 | fixed | purple |
| belastingen | Belastingen & gemeente | 🧾 | fixed | brown |
| opvang-school | Opvang & school | 🎒 | fixed | orange |
| leningen | Leningen | 🏦 | fixed | gray |
| boodschappen | Boodschappen | 🛒 | daily | green |
| uit-eten | Uit eten & bezorgen | 🍽️ | daily | orange |
| vervoer | Auto & vervoer | 🚗 | daily | blue |
| huis-tuin | Huis & tuin | 🛠️ | daily | brown |
| kleding | Kleding | 👕 | daily | pink |
| verzorging | Gezondheid & verzorging | 💊 | daily | red |
| kinderen | Kinderen | 🧸 | daily | yellow |
| vrije-tijd | Vrije tijd | 🎟️ | daily | purple |
| vakantie | Vakantie | ✈️ | daily | cyan |
| cadeaus | Cadeaus & goede doelen | 🎁 | daily | pink |
| huisdieren | Huisdieren | 🐾 | daily | mint |
| winkelen | Winkelen | 🛍️ | daily | indigo |
| contant | Contant | 💵 | daily | gray |
| overig | Overig | 📦 | daily | gray |
| sparen | Sparen | 🐷 | saving | teal |
| beleggen | Beleggen | 📈 | saving | indigo |
| intern | Eigen rekeningen | 🔄 | internal | gray |
| creditcard | Creditcard | 💳 | internal | gray |
| unsorted | Nog te sorteren | ❔ | daily | gray |

Rules:
- A positive amount in a `fixed`/`daily` category is a refund: it reduces that bakje's spending.
- `unsorted`: negative amounts count as daily spending, positive amounts as income.
- `internal` never counts as income or spending.
- `saving`: money out of a checking account = saved (positive saving), money back in = withdrawn.

### 4.2 Tags

Free labels, many per transaction (e.g. "Verbouwing badkamer", "Vakantie Italië"). Tags never
affect totals; they give a cross-section. A tag has a name, an emoji and a colour.

## 5. Import

Formats, auto-detected from content (not from the file extension):

**ASN CSV** (`asn_csv`). Comma separated, optional header row. With header: 20 columns
`Datum, Je rekening, Van / naar, Naam, Adres, Postcode, Woonplaats, Valuta saldo,
Saldo voor boeking, Valuta, Bedrag bij / af, Verwerkingsdatum, Valutadatum, Code, Type,
Volgnummer, Betalingskenmerk, Omschrijving, Afschriftnummer, Categorie`. Older exports have no
header and 19 columns (no `Categorie`); detect a header by checking whether field 1 parses as a
date. Dates `dd-mm-yyyy`, possibly unpadded (`5-3-2025`). Amounts use a decimal point with a sign. `Omschrijving` and `Categorie`
are wrapped in literal single quotes that must be stripped; there are no double quotes.
UTF-8 with optional BOM; fall back to cp1252. `balance_after = Saldo voor boeking + Bedrag`.

**CAMT.053** (`camt053`, any `camt.053.001.xx` namespace, any bank). Per `Ntry`: `Amt` +
`CdtDbtInd` (which already gives the real direction; `RvslInd` only marks a reversal and must not flip the sign), `BookgDt`, `ValDt`, `BkTxCd/Domn` codes,
`BkTxCd/Prtry/Cd` (ASN: the same 4-digit code as CSV `Code`), `NtryRef`, `AcctSvcrRef`,
`NtryDtls/TxDtls` (party names and IBANs, `EndToEndId`, `MndtId`, creditor id, `RmtInf/Ustrd`
and structured remittance), `AddtlNtryInf`. The counterparty is `Cdtr` for DBIT and `Dbtr` for
CRDT. Running balance: `OPBD` balance plus cumulative entries in file order. Multiple `Stmt`
and multiple `TxDtls` per entry must not crash (batch entries: one transaction per entry).
Parse with `defusedxml` (XXE / entity-expansion safe).

Sample pattern facts (ASN): card payments carry no counterparty name or IBAN; the description is
`MERCHANT NAME  >CITY dd.mm.yyyy HHuMM KV002 <terminal> MCC:5411 Apple Pay betaling   NLNEDERLAND`.
Direct debits: `Europese incasso: <text>-Incassant ID: <creditor id>-Kenmerk Machtiging: <mandate>`.
iDEAL: `<ref> <ref> <merchant text> Referentie: <timestamp> <ref>`. Internal transfers between
own ASN accounts: ISO `ICDT/BOOK` or `RCDT/BOOK`, free text typed by the user, then
`Referentie: <uuid>`. In CAMT, `AddtlNtryInf` equals the CSV description and `Ustrd` is the same
text without the `Referentie:` tail. `NtryRef` has the form `<8 digits>-<7 digits>`, the second
part is the CSV `Volgnummer` zero-padded.

**Duplicates.** `dedupe_key = iban | booking date | sequence number` when a bank sequence number
exists (CSV `Volgnummer`, CAMT second half of `NtryRef`). The same transaction imported once as
CSV and once as CAMT must produce the same key (verify against `../Voorbeelden/`: 9 of 9 must
match). Otherwise `sha1(iban, date, amount, counterparty iban, AcctSvcrRef or EndToEndId,
description)`. On a duplicate, **enrich**: fill fields that the stored row lacks (bank category,
MCC, balance, counterparty) and re-classify if the category was not set by the user or a rule.

**Accounts** are created automatically from the IBAN in the file. First account → `checking`.
A new IBAN that already appears as counterparty of transactions that the bank labels `Sparen`
(or with ISO sub-family `BOOK`) → `savings`. Default name: "Betaalrekening" / "Spaarrekening"
(+ last 4 IBAN digits when there is more than one). The import response reports new accounts so
the UI can offer a one-tap rename/type change.

After every import: run transfer detection, classification, goal matching.

Reference data researched for this project is in `docs/research/asn-format.md` (official ASN
type list, the 4-digit code table, ISO families, MCC source). Facts from it:
- ASN `Type` codes (official list): ACC, AFB, BEA, BIJ, BVZ, EFF, EIC, GEA, IDE, IDM, IIC, IOI,
  IOM, IOS, ITP, KAS, MSC, NGI, NGM, NUL, OVS, PCQ, POV, RTI, TPP (+ AGI, AGM).
- 4-digit codes starting with 0/2/6/8 are credits, 1/3/7/9 debits. 3724/2724 (type NGI) and
  3754/2754 (NGM) are transfers between own accounts; periodic transfers use POV
  (3700/2700, 9802, 8706/8746); 9806 iDEAL; 9714 SEPA core direct debit; 79xx card payments;
  8809 incoming SEPA transfer.
- `Volgnummer` can be up to 8 digits. Compare sequence numbers as integers.

### 5.1 Normalisation (`normalize.py`)

Produces `method`, `merchant_name`, `merchant_key`, `city`, `mcc`, `wallet`, `mandate_id`,
`creditor_id`, a clean `description`.

- `method` from ASN type / ISO codes: BEA or CCRD/POSD → `card`; GEA or CWDL → `atm`;
  IDE or iDEAL pattern → `ideal`; INC/EIC or RDDT/IDDT → `debit`; BOOK sub-family or own IBAN →
  `internal`; RNT/interest → `interest`; KST/fees → `fee`; other credit transfers → `transfer`.
- Card merchant = text before `>`; city = text after `>` up to the date.
- Strip from merchant names: surrounding quotes, payment-terminal prefixes (`CCV*`, `BCK*`,
  `SumUp *`, `Zettle_*`, `MOL*`, `PAY.nl*`, `iZ *`, `TMC*`, `PAYPAL *`, generally
  `^[A-Za-z.]{2,8}\s?\*`), payment-provider wrappers in counterparty names (`X via Mollie`,
  `X by Buckaroo`, `X via Adyen`, `via Stripe`, `via MultiSafepay`, `via Pay.nl`,
  `via Online Betaalplatform`), legal forms (B.V., N.V., VOF), trailing branch numbers,
  country suffixes, repeated whitespace. Keep `Thuisbezorgd.nl via Takeaway.com` → Thuisbezorgd.
- `merchant_name` is a tidy display name (sensible capitalisation: "ALBERT HEIJN 1234" →
  "Albert Heijn"). If the library recognises a brand, use the brand's key and name.
- `merchant_key` is the stable grouping key: lowercase, accents removed, alphanumerics and single
  spaces only. Persons (private counterparties) get a key too, prefixed `p:`; detect with
  initials / "eo" / "Hr" / "Mw" patterns and absence of company words.

## 6. The library (classification)

Data file formats (all in `backend/cents/data/`, loaded once at start, missing file = empty):
```jsonc
// merchants.json   — list, see step 4
// mcc.json         — { "5411": { "label": "Supermarkt", "category": "boodschappen" }, "5311": { "label": "Warenhuis", "category": null } }
// keywords.json    — [ { "match": ["bakkerij", "bakker"], "category": "boodschappen", "sign": "out" } ]   sign optional
// asn_categories.json — { "Boodschappen": "boodschappen", "Overig": null }
// bank_codes.json  — { "types": { "BEA": { "label": "Pinbetaling", "method": "card" } },
//                      "codes": { "7916": { "label": "Contactloos betalen", "method": "card", "direction": "out" } } }
// categories.json  — the table of §4.1
```
The engine takes the library as an injectable object so tests can use tiny inline libraries.

`classify/engine.py` assigns a category in this order; the first hit wins:

1. `user` — the transaction was set individually by the user. Never overwritten.
2. `rule` — a learned rule for this `merchant_key`.
3. Transfers: counterparty IBAN is an own account, or text matches an account's `match`
   keywords → `kind=transfer` (see §7), category `sparen` / `beleggen` / `intern` / `creditcard`.
4. `merchant` — `data/merchants.json`: several hundred Dutch brands and creditors
   (supermarkets, energy, water companies, insurers, telecom, streaming, municipalities and
   tax offices, fuel, charging, parking, public transport, DIY, fashion, drugstores, web shops,
   food delivery, brokers, lenders, charities, childcare chains…). Entry:
   `{"key": "albert-heijn", "name": "Albert Heijn", "match": ["albert heijn", "ah to go"],
     "category": "boodschappen"}`; matching is on word boundaries of the normalised text,
   longest match first. Direction-specific entries are allowed with `"sign": "in"|"out"`
   (Belastingdienst out → `belastingen`, in → `toeslagen`).
5. `mcc` — `data/mcc.json` (ISO 18245 code → category + Dutch label). Broad codes (department
   and variety stores: 5300, 5310, 5311, 5331, 5399, 5999) map to nothing and fall through.
6. `keyword` — `data/keywords.json`: generic Dutch words in the merchant name or description
   ("bakkerij", "slagerij", "tandarts", "apotheek", "garage", "kapsalon", "pizzeria",
   "tuincentrum", "kinderopvang", "hypotheek", "premie", "contributie", …).
7. `bank` — `data/asn_categories.json` maps ASN's own `Categorie` to a bakje (`Overig` → none).
8. `heuristic` — ATM → `contant`; bank fees → `overig`; savings interest → `inkomen-overig`;
   a monthly credit with "salaris"/"loon" in the text, or the largest stable monthly credit from
   a company → `salaris`.
9. Otherwise `unsorted`. Private persons are always `unsorted` unless a rule exists.

**Learning.** `PATCH /api/transactions/{id}` with a new category and `apply_to_merchant=true`
(the default) upserts a rule for the `merchant_key` and updates every transaction of that
merchant whose source is not `user`. With `apply_to_merchant=false` only this transaction
changes (source `user`). Tags work the same way with `tag_always=true`.

`POST /api/reclassify` re-runs the engine on everything that is not `user`.

## 7. Own accounts, savings, investments, credit card

- **Transfer** = counterparty IBAN equals an own account's IBAN, or the text matches an own
  account's `match` keywords. `kind=transfer`, `transfer_account_id` set.
- Cash-flow figures are computed from **checking accounts and manual credit-card purchases
  only**. Transactions on a savings account are never counted twice: its transfers are internal;
  only interest counts (as income).
- Checking → savings: category `sparen`. Checking → investment account: `beleggen`.
  Checking → checking: `intern`.
- **Suggest accounts.** If transfers the bank labels `Sparen` go to an IBAN that is not an own
  account, `GET /api/bootstrap` returns a suggestion `{type:"savings", iban, name}`; if a
  library merchant with category `beleggen` appears, suggest an investment account with `match`
  keywords from that brand. One tap in the UI creates it.
- **Investment accounts** are manual: the user enters a value now and then
  (`account_values`). Invested = sum of transfers out of checking to that account minus
  transfers back. Result = latest value − invested.
- **Holdings (7.1, added later).** An investment account with trades (DEGIRO import or
  manual "Aankoop toevoegen") is valued from its holdings: market value = Σ quantity × latest
  EUR price (fetched daily, else the latest DEGIRO portfolio export, else the last trade price),
  plus estimated cash (bank deposits − net bought − fees + net dividends, ≥ 0, only when bank
  deposits are known). Invested = bank deposits as above, else net bought + fees. Result
  (with dividend and costs) = price result + dividends − dividend tax − fees; price result
  (without) = value − average-cost basis of what is held + realised, both excluding fees.
  Tables `securities`, `trades`, `cash_events`, `prices` (schema v4). Trades never touch
  `transactions`, so buys/sells never count as spending and Nog te besteden ignores them.
  Imports: DEGIRO Transacties (dedupe Order ID + ISIN + date + quantity + occurrence),
  Rekeningoverzicht (only dividend, dividend tax, connection/service fees), Portefeuille
  (prices for the export date; quantity differences are reported, never auto-corrected).
  Prices: services/prices.py, provider interface (default Yahoo Finance, keyless), ECB rates
  for FX; assumption `prices_auto.enabled` (default on; off = nothing leaves the server).
- **Credit card** (manual): the user adds purchases by hand (they count as spending in their
  bakje on the purchase date). The card company's monthly direct debit (matched via the account's
  `match` keywords, default `["international card services", "ics"]`) is `kind=settlement`,
  category `creditcard`. For each settlement: `explained = min(amount, outstanding before)`;
  the unexplained rest counts as spending in bakje `creditcard`'s stand-in "Creditcard" line of
  that month, so totals are right even if nobody enters purchases.
- **Balances.** Checking/savings: `balance_after_cents` of the latest transaction, else the
  manual balance. Net-worth history uses month-end balances carried forward.

## 8. Periods

Setting `month_start_day` (1–28, default 1). A period is `[start, next start)`. Its id is
`YYYY-MM` of the calendar month that contains most of its days. One helper in
`services/periods.py` is the only place that computes period boundaries. The "current" period
is the one containing today; "data today" for projections is `min(today, latest transaction
date + 3 days)` so that stale data does not look like a quiet month.

## 9. Calculations

**Recurring** (`services/recurring.py`), separately for money out and money in, computed on the
fly and cached until the next write:
- Group by `merchant_key`; within a merchant, cluster by amount (sorted; same cluster while
  `amount ≤ previous × 1.15 + €0.50`) so two policies with one insurer become two items.
- A cluster is recurring when it has ≥ 3 payments, the median gap fits a frequency window
  (weekly 5–9 days, monthly 24–38, quarterly 80–102, half-yearly 165–200, yearly 340–390; yearly
  needs only 2 payments), ≥ 70 % of gaps lie within ±35 % of the median, and the last six
  amounts differ ≤ 25 %. Monthly direct debits with ≥ 4 payments also qualify with varying
  amounts (flag `variable`).
- `status`: `active`; `new` (first payment < 75 days ago); `ended` (overdue by more than
  1.6 × the median gap, relative to "data today"); ended items are listed for 3 more periods.
- `next_date` = last date + median gap (monthly: same day-of-month as usual).
- `change`: latest amount differs from the median of the three before by > 2 % and > €0.50.
- Item key = `merchant_key|rounded typical amount`.

**Overview** (`services/summary.py`) for a period:
- `income`, `fixed`, `daily`, `saved` from category groups (§4.1), transfers per §7.
- `expected_income`: recurring income expected in the period, else the average of the last
  three complete periods; `fixed_upcoming`: recurring `fixed` items whose `next_date` falls in
  the rest of the period; `saving_upcoming` likewise for recurring transfers to savings.
- Current period: `left = max(income, expected_income) − fixed − fixed_upcoming − saved −
  saving_upcoming − daily`; `per_day_left = left / days remaining`. With fewer than two
  complete periods of history `left` is `null`. *(Kept in the API for compatibility; the
  UI no longer shows it: it counted this month's salary before it arrived and looked at one
  account only. Replaced by `free`, `tempo`, `checking_warning` below.)*
- `net = income − fixed − daily − saved` (cash flow after saving; kept for trends/recap).
  `result = income − fixed − daily` is the one definition of **over / tekort** (hero of a past
  month or a year, the year read-out, Tempo, the `left_over` insight): saving is not spending,
  money back from savings is not income.
- `fixed_upcoming`: only expected payments dated today or later; an expected payment of this
  period whose date passed without showing up is `fixed_overdue` (UI "achterstallig?", in
  `upcoming[]` with `overdue: true`). `salary_expected`: next date of the largest recurring
  income in this period (Inkomen tile "salaris verwacht 27 nov" while income is 0).
- **Nog te besteden** (`free`, current period only; `services/outlook.py`): balances of all
  visible checking and savings accounts − money in active potjes (sum of positive saldos, at
  most the savings balance) − recurring `fixed` items expected after the balance date and
  before payday − outstanding manual credit-card purchases − the expected next credit-card
  settlement (`card_settlement`: median unexplained part of the last three settlements, one
  month after the latest; only when it falls before payday) − typical daily spending for the
  days from the balance date to payday (`daily_rate` = median per-day daily spending of the
  last six complete periods, without credit-card settlement lumps). The buffer is **not**
  subtracted (shown separately). Not clamped: negative is shown negative. `per_day` = total ÷
  days from today to payday (`null` on/after payday). Transfers between own accounts never
  change it.
  Balance dates: per account `as_of` = the later of its latest balance and the day a file for
  that account was last imported (at most the latest imported transaction of any account).
  The oldest `as_of` of the checking/savings accounts is `free.as_of`; it drives `stale` (> 5
  days) and the start of the fixed-cost and daily-spending window; each account carries its own
  `stale`. Payday = the first salary after the main checking account's `as_of` (not after
  today): assumption `payday_day` when set (clamped to month end), else the next expected date
  of the largest live recurring income, else the end of the current period. When that date is
  already today or earlier the salary is due but not imported: `salary_pending` (UI "salaris
  nog niet verwerkt — importeer"); it is still the upcoming payday.
- **Buffer** (`buffer`, current period): `saved_cents` = the saldo of a potje whose name
  contains "buffer", else the savings balance outside potjes capped at the target;
  `target_cents` = assumption `buffer` (`amount_cents`, else `months` × average monthly fixed
  costs of the previous up to six complete periods, recurring items without history);
  `months` / `target_months` = in months of fixed costs. The `buffer` insight uses the same.
- **Tempo** (`tempo`): mean of `income − fixed − daily` over the last three complete periods
  (saving is not spending, money back from savings is not income), plus the series of up to
  twelve complete periods. `null` with fewer than two complete periods. `since` = the first
  of the three, or the start of a longer run of short months.
- **Waarschuwing betaalrekening** (`checking_warning`): the main checking account (most
  transactions) projected day by day from its balance date until the day before payday:
  recurring fixed costs, recurring savings transfers and other recurring income on their
  expected dates, minus the typical daily rate (as above) per day. If the lowest point from
  today on is below assumption `checking_floor_cents` (default 0) →
  `{date, low_cents, floor_cents, suggest_cents, account_id, payday}`; `suggest_cents` = the
  shortfall rounded up to € 50, `null` when the savings balance does not cover it. Else `null`.
- `pace`: cumulative daily-spending series for this period and the typical series (median of
  the previous up to six complete periods at the same day index). The UI shows it as
  "Dagelijkse uitgaven – nog over" (normal month's total minus spending; may go below zero),
  or as plain cumulative "Uitgegeven" when there is no typical series.
- Per category: spent, the average of the previous six complete periods, count.

**Jaar** (`build_year_overview`, `GET /overview?period=2026`): the periods whose id lies in the
year (`2026-01` … `2026-12`, so with `month_start_day` 24 the year starts on 24 December) and
that have started on today. The running year is year to date (`period.ytd`, label "2026 tot
nu", `to` = today; the running month counts as far as it goes); a past year has all twelve.
A year that has not started is a 400 (`future_year`). Totals (`income`, `fixed`, `daily`,
`saved`, `net`, per bakje, income per category) are the sums of those periods, so they always
equal the sum of the month overviews. `per_month` divides by the months that have data.
"Normaal" for a year is the same months one year earlier (`previous_year`, per bakje
`avg_cents`), only when the data covers all of them (else `null` / 0). Now-only figures
(`free`, `tempo`, `checking_warning`, `left`, `per_day_left`, `expected_end`, `pace`,
`upcoming`, `insights`, `buffer`) are `null` / empty for a year; `result` and per-month
`result_cents` are included.

**Insights** (`services/insights.py`): each returns `{id, kind, tone, emoji, title, value_cents?,
detail?, link}` with one short Dutch sentence as `title`. Compute all, rank, return at most five.
Only show an insight when the data really supports it (minimum history per rule). The
Overzicht shows only actionable kinds: `fixed_share`, `last_year`, `savings_rate`, `pace`,
`buffer`, `goal_reached`, `bank_fees`, `fx_costs` are left out there (`OVERZICHT_HIDDEN`).
1. `pace` — daily spending at this point vs typical ("Dagelijkse uitgaven € 85 boven normaal
   tot nu toe" / "op koers").
2. `category_spike` — a bakje > 20 % and > €50 above normal (median of the previous six
   periods); at most two per period. The word in the UI is "normaal", never "gemiddelde".
3. `price_change` — a recurring item changed price ("Netflix is € 2 duurder geworden").
4. `new_recurring` — a new subscription appeared.
5. `ended_recurring` — a fixed payment stopped (possible missed payment or cancelled).
6. `duplicate` — same merchant and amount twice within three days (debit or card).
7. `large` — an unusually large single expense (> 3× the merchant's or bakje's typical amount
   and > €150).
8. `savings_rate` — share of income saved or invested this period / this year.
9. `buffer` — the buffer (as `buffer` above) in months of fixed costs; warn below the target.
10. `left_over` — a finished period's `result` ≥ € 50: "€ X over in <maand>"; a potje is
    suggested only for the part not yet saved, never when the month drew on savings.
11. `unsorted` — merchants waiting to be sorted (links to Sorteren).
12. `yearly_bill` — a yearly payment is due within 60 days ("Wegenbelasting € 412 komt eraan
    in maart").
13. `goal_behind` / `goal_reached`.
14. `stale` — the latest transaction is more than 10 days old ("Laatste import 12 dagen
    geleden"), links to import.
15. `fixed_share` — fixed costs as a share of income; info below 50 %, warn above 60 %.
16. `last_year` — this period's daily spending vs the same period last year ("… meer aan
    dagelijkse uitgaven dan …"; needs 13 periods).
17. `tempo` — the three-month mean result (`tempo`) is € 25 or more negative: "Jullie geven
    sinds <maand> gemiddeld € X per maand meer uit dan er binnenkomt." Id `tempo:<since>`.
Tone: `good`, `warn`, `info`. Never moralise.

**Goals** (`services/goals.py`):
- `saldo = sum(goal_entries)`. Entries come from (a) savings transfers matched to the goal,
  (b) manual assignment of a transfer, (c) manual top-up, (d) "saldo aanpassen" (kind `adjust`,
  stores the delta so that the saldo equals what the user typed).
- Matching a transfer to/from a savings account to a goal, in order: the goal's 5-digit `code`
  appears as a separate word in the description; the goal name or one of its `keywords`
  appears in the description; a previous manual assignment of a transfer with the same
  normalised description (learned). Money moving back out of savings with a match subtracts.
- Unmatched savings transfers are returned as `unassigned` so the UI can offer one-tap
  assignment ("verdeel").
- `monthly_advice = max(0, target − saldo) / months left` (rounded up to a multiple of €5, at
  least one month). When behind, also return `catch_up_cents`: the monthly amount that still
  reaches the target in time. `status`: `reached`, `on_track` (average contribution of the last three periods ≥
  90 % of the advice), `behind`, `no_date`. A `yearly` goal rolls its date forward one year
  after it passes and keeps the saldo above zero that remains.
- `room`: average of (`income − fixed − daily`) over the last three complete periods compared
  with the total advice of all goals → `fits` true/false and the difference.
- `suggestions`: a buffer goal (3 × average monthly fixed + daily spending) when none exists;
  a "Jaarlijkse rekeningen" goal summing yearly recurring items ÷ 12.
- Goal codes: random 5 digits, unique, first digit not 0.

## 10. API

JSON everywhere, `snake_case`, cents as integers. All routes under `/api`. Every route except
`GET /api/session`, `POST /api/setup`, `POST /api/login` requires a session cookie
(`cents_session`, HttpOnly, SameSite=Lax, 180 days, rolling). Errors:
`{"error": {"code": "…", "message": "Dutch sentence"}}` with a fitting HTTP status. Mutating
requests must carry header `X-Cents: 1` (CSRF guard); reject otherwise.

Auth: `GET /session` → `{setup_required, authenticated, version}` · `POST /setup {password}`
(only while no password exists; min 8 chars) · `POST /login {password}` (scrypt; 5 failures per
5 minutes per IP → 429) · `POST /logout` · `POST /password {current, new}`.

`GET /bootstrap` → `{settings, accounts[], categories[], tags[], periods:{first,last,current},
has_data, unsorted_merchants, suggestions:{accounts:[…]}}`.

Types used below:
```ts
Tx = { id, account_id, date, amount_cents, merchant_name, merchant_key, counterparty_iban,
       description, method, city, category_id, category_source, kind, transfer_account_id,
       tag_ids: number[], goal_id, note, manual, balance_after_cents }
Period = { id: "2026-11", label: "november 2026", from, to, is_current, day_index, days_total,
           prev: string|null, next: string|null }
```

Import: `POST /import` (multipart, field `files`, many) → `{files:[{filename, format, ok, error,
account_id, account_name, is_new_account, new, duplicates, enriched, date_from, date_to}],
totals:{new, duplicates, enriched}, unsorted_merchants}` · `GET /imports` ·
`DELETE /imports/{id}` (removes that import's transactions; undo).

Transactions: `GET /transactions?period&from&to&account_id&category_id&tag_id&merchant_key&q&
method&kind&unsorted&min_cents&max_cents&limit=100&cursor` → `{items: Tx[], next_cursor,
count, sum_in_cents, sum_out_cents}` (newest first; `q` searches merchant, description, note,
tag names, and amounts typed as "12,50") · `GET /transactions/{id}` → `Tx & {raw_description,
counterparty_name, pay_type, bank_code, mcc, mcc_label, wallet, bank_category, mandate_id,
merchant:{count, total_12m_cents, typical_cents, recurring: RecurringItem|null}}` ·
`PATCH /transactions/{id} {category_id?, apply_to_merchant?, tag_ids?, tag_always?, note?,
goal_id?, …manual fields}` → `{transaction: Tx, updated_count}` · `POST /transactions`
(manual: `account_id, date, amount_cents, merchant_name, category_id?, tag_ids?, note?`) ·
`DELETE /transactions/{id}` (manual only) · `POST /transactions/bulk {ids, category_id?,
add_tag_ids?, remove_tag_ids?}`.

Sorting: `GET /sort/queue` → `{items:[{merchant_key, merchant_name, count, total_cents,
last_date, method, city, sample_description, is_person, suggestions: number[]  /* ≤ 4 category
ids, best first */}], remaining}` ordered by total amount · `POST /sort {merchant_key,
category_id}` → `{updated_count, remaining}`.

Categories: `POST /categories {name, emoji, color, grp}` · `PATCH /categories/{id}` ·
`DELETE /categories/{id}` (custom only; its transactions become `unsorted`) ·
`GET /categories/{id}/summary?period` → `{spent_cents, avg_cents, count, series:[{period,
cents}] /* 12 */, merchants:[{merchant_key, merchant_name, cents, count}], transactions: Tx[]}`.

Tags: `POST /tags {name, emoji?, color?}` · `PATCH /tags/{id}` · `DELETE /tags/{id}` ·
`GET /tags/{id}/summary` → `{total_out_cents, total_in_cents, count, first_date, last_date,
by_category:[{category_id, cents}], by_month:[{month, cents}], transactions: Tx[]}`.

Rules: `GET /rules` → `[{id, merchant_key, merchant_name, category_id, tag_id, count}]` ·
`DELETE /rules/{id}`.

Overview: `GET /overview?period` →
```ts
{ period: Period,
  income_cents, expected_income_cents, fixed_cents, fixed_upcoming_cents, daily_cents,
  saved_cents, saving_upcoming_cents,
  left_cents: number|null, per_day_left_cents: number|null,   // legacy, not shown in the UI
  net_cents, result_cents /* income − fixed − daily */,
  fixed_overdue_cents, salary_expected: string|null,
  free: { total_cents /* may be negative */, balances_cents, goals_cents,
          fixed_until_payday_cents, credit_cents,
          card_settlement: { date, cents } | null,
          daily_until_payday_cents, daily_rate_cents, daily_days, days_left,
          per_day_cents: number|null,
          payday: string, payday_source: "setting"|"salary"|"period", salary_pending: boolean,
          as_of: string|null /* oldest */, stale: boolean,
          accounts: [{ name, type, balance_cents, as_of, stale }] } | null,  // current only
  buffer: { saved_cents, target_cents, source: "potje"|"savings", months: number|null,
            target_months: number|null } | null,                 // current period only
  tempo: { avg_net_cents, periods, since: string /* period id */,
           months: [{ period, net_cents }] /* oldest first, ≤ 12 */ } | null,
  checking_warning: { date, low_cents, floor_cents, suggest_cents: number|null,
                      account_id, payday } | null,
  pace: { days: string[], actual: number[] /* cumulative cents, up to today */,
          typical: number[] /* cumulative cents, full period */ } | null,
  categories: [{ category_id, spent_cents, avg_cents, count }],   // fixed + daily, spent desc
  income: [{ category_id, cents }],
  upcoming: [{ key, name, date, amount_cents, category_id }],
  insights: Insight[],
  unsorted: { merchants, transactions, cents },
  balance: { checking_cents, expected_end_cents: number|null } }
```
`GET /overview?period=YYYY` (a year, §9 "Jaar") returns the same shape with
`period: { id: "2026", kind: "year", label: "2026 tot nu"|"2025", year, from, to, is_current,
ytd, months /* started periods */, first_period, last_period, day_index, days_total,
prev: "2025"|null, next: "2027"|null }`, `expected_income_cents` = `income_cents`, upcoming
amounts 0, plus `per_month: {income_cents, fixed_cents, daily_cents, saved_cents, net_cents}`,
`previous_year: {income_cents, fixed_cents, daily_cents, saved_cents, net_cents, from, to} |
null`, `months: [{period, label, income_cents, fixed_cents, daily_cents, saved_cents,
net_cents, partial}]` and `categories[].per_month_cents`.
`GET /trends?periods=12` → `{periods:[{period: Period-id, label, income_cents, fixed_cents,
daily_cents, saved_cents, net_cents}], categories:[{category_id, cents: number[]}],
top_merchants:[{merchant_key, merchant_name, category_id, cents, count}]}`.

Recurring: `GET /recurring` → `{monthly_out_cents, monthly_in_cents, yearly_out_cents,
items: RecurringItem[]}` with `RecurringItem = {key, name, merchant_key, category_id, direction:
"out"|"in", amount_cents, frequency: "weekly"|"monthly"|"quarterly"|"half-year"|"yearly",
per_month_cents, last_date, next_date, status, variable, count, change:{from_cents, to_cents,
date}|null}` · `POST /recurring/ignore {key}`.

Goals: `GET /goals` → `{goals:[{id, name, emoji, color, target_cents, target_date, repeat,
code, keywords, saldo_cents, progress /* 0..1 */, monthly_advice_cents, catch_up_cents,
months_left, projected_date, status,
avg_contribution_cents, entries:[{id, date, amount_cents, kind, note, transaction_id}] /* last
20 */}], unassigned:[{transaction_id, date, amount_cents, description}], total_advice_cents,
room:{avg_over_cents, fits, difference_cents}|null, savings_balance_cents: number|null,
unallocated_cents: number|null, suggestions:[{kind, name, emoji, target_cents, target_date,
reason}]}` · `POST /goals` · `PATCH /goals/{id}` · `DELETE /goals/{id}` ·
`POST /goals/{id}/entries {amount_cents, date?, note?, transaction_id?}` ·
`POST /goals/{id}/saldo {saldo_cents}` · `DELETE /goal-entries/{id}`.

Net worth: `GET /networth` → `{total_cents, accounts:[{id, name, type, iban, balance_cents,
as_of, invested_cents?, result_cents?, outstanding_cents?, unexplained_cents?, values?:
[{id, date, value_cents}]}], series:[{month, checking_cents, savings_cents, investment_cents,
credit_cents, total_cents}]}` · `POST /accounts {name, type, iban?, match?}` ·
`PATCH /accounts/{id}` · `DELETE /accounts/{id}` (only without imported transactions, or with
`?force=1`) · `POST /accounts/{id}/values {date, value_cents}` · `DELETE /account-values/{id}`.
Investment accounts with holdings add to their `/networth` account: `has_holdings,
market_value_cents, cash_cents, result_pct, price_result_cents, dividends_cents, costs_cents,
price_stale, holdings_count` (`balance_cents` = market value + cash, `as_of` = oldest price date).

Holdings (7.1): `GET /accounts/{id}/holdings` → `{holdings:[{isin, name, symbol, price_symbol,
currency, quantity, avg_price_cents, price_cents, price_date, price_source:
"yahoo"|"degiro_portfolio"|"trade", value_cents, cost_cents, realised_cents, result_cents,
price_result_cents, dividends_cents, fees_cents, trades:[{id, date, quantity, price, currency,
value_eur_cents, fees_cents, manual}]}], market_value_cents, cash_cents, value_cents,
invested_cents, invested_source: "bank"|"trades", net_bought_cents, result_cents, result_pct,
price_result_cents, price_result_pct, dividends_cents, dividend_tax_cents, costs_cents,
price_date, price_stale, events:[…], chart:[{date, value_cents, invested_cents}] /* weekly */,
prices: PriceStatus}` · `POST /accounts/{id}/trades {date, isin, name?, side: "buy"|"sell",
quantity, price_cents, fees_cents}` · `DELETE /trades/{id}` (manual only) ·
`GET /securities?q` · `PATCH /securities/{isin} {price_symbol}` (override the provider symbol) ·
`GET /prices/status` → `PriceStatus = {enabled, source, source_key, last_run, last_ok, error,
last_price_date, running, held}` · `POST /prices/refresh` ("Nu bijwerken"; 409 when off).
`POST /import?investment_account_id=` picks the investment account for DEGIRO files; without
it: the only investment account, else one named "DEGIRO", else a new "DEGIRO" account; with
several the file result has `error_code: "choose_account", choices:[{id, name}]` and nothing
is stored. File results gain `investment: {kind, mismatch?:[{isin, name, quantity,
file_quantity}]}`.

Settings & data: `GET /settings` · `PATCH /settings {month_start_day?, household_name?}` ·
`GET /export/transactions.csv` · `GET /export/backup` (consistent SQLite copy) ·
`POST /restore` (upload a backup) · `POST /reclassify` · `DELETE /data {password}`.

Health: `GET /healthz` (no auth) → `{ok:true}`.

## 11. Security

scrypt password hash; random 32-byte session tokens stored hashed; login rate limit; CSRF header;
upload limit 250 MB per file (five years of history in one file must work; uploads are streamed to disk and parsed incrementally); `defusedxml`; parameterised SQL only; security headers
(`Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self'
'unsafe-inline'; frame-ancestors 'none'`, `X-Content-Type-Options`, `Referrer-Policy:
no-referrer`); cookies not `Secure` (the app is served over plain HTTP inside a private
network) unless the request arrived over HTTPS; run as a non-root user in the container.

## 12. Frontend

See `docs/DESIGN.md` for the full design system and screen designs (authoritative for the UI).

## 13. Adjustable assumptions (added later; additive to §6, §9, §10)

Every smart assumption must be visible and correctable by the family.

- **Amount-dependent bakjes.** A rule may carry a threshold (`rules.below_cents`,
  `rules.below_category_id`): amounts below it go to the below-category, larger ones to the main
  category. Library entries may carry a default `"small": {"below_cents", "category"}`; it is
  set for staffed fuel stations (MCC 5541 and fuel brands): small amounts are food, large ones
  fuel. Unattended pumps (MCC 5542) are always fuel. Setting
  `assumptions.small_amount_at_fuel = {enabled, below_cents}` switches or tunes the default.
- **Reason.** Each transaction stores `category_reason`; `GET /transactions/{id}` returns it with
  a short Dutch `category_reason_label` ("Shell · klein bedrag").
- **Scope when correcting.** `PATCH /transactions/{id}` takes `apply_scope`:
  `one` | `merchant` | `merchant_below` (+ `below_cents`). `PATCH /rules/{id}` edits a rule.
- **Insights** have stable ids and can be dismissed one by one
  (`POST /insights/dismiss {id}`) or muted per kind (`POST /insights/mute {kind, muted}`).
- **Nog te besteden assumptions** in setting `assumptions` (PATCH /settings): `payday_day =
  {day: null|1–31}` (null = from the salary), `buffer = {months: 0–24, amount_cents:
  null|≥0}` (an amount wins over months), `checking_floor_cents = {cents}`. Shown and editable
  on "Slimme aannames".
- **Overview.** `GET /assumptions` lists what the app assumed (salary series, account types,
  ignored recurring items, learned goal links, suggested month start day, `payday: {date,
  source}` = the next salary date Nog te besteden counts to (after the balance date)) for the settings
  screen "Slimme aannames"; each item can be undone there.

## 14. Calendar, yearly cost, recap (added later; additive)

**Payment calendar.** `GET /api/calendar?period=YYYY-MM` →
```ts
{ period: Period,
  days: [{ date, items: [{ key, name, merchant_key, category_id, direction: "out"|"in",
                           amount_cents /* signed like the payment */,
                           status: "paid"|"expected"|"missed",
                           transaction_id: number|null }] }],   // only days that have items
  out: { paid_cents, expected_cents, missed_cents },             // positive totals
  in:  { paid_cents, expected_cents } }
```
Items are the recurring items (fixed-group expenses, recurring income, recurring savings
transfers) that fall in the period: `paid` when a matching payment exists in the period
(`transaction_id` set, date = the payment's date), `expected` when the next date lies after
"data today", `missed` when it lies more than 5 days before "data today" without a payment.
An item with a frequency shorter than the period appears once per occurrence.

**Yearly cost.** Every `RecurringItem` gets `per_year_cents` (positive, 12 × per month, or
the sum of a full year for non-monthly frequencies) and `GET /recurring` gets
`subscriptions: {per_month_cents, per_year_cents, count}` for items in bakje `abonnementen`
and `telecom`. New insights `bank_fees` ("Dit jaar € 86 aan bankkosten", once the year's fee
total is ≥ €10, links to the payments) and `fx_costs` (currency-conversion costs found in card
payments abroad, only when the bank's text makes them identifiable; otherwise never shown).

**Recap ("Terugblik").** `GET /api/recap?period=YYYY-MM` and `GET /api/recap?year=YYYY` →
```ts
{ kind: "period"|"year", label, from, to, complete: boolean,
  totals: { income_cents, fixed_cents, daily_cents, saved_cents, net_cents },
  previous: { label, income_cents, fixed_cents, daily_cents, saved_cents, net_cents } | null,
  categories: [{ category_id, cents, previous_cents|null, share }],      // spent desc
  movers: { up: [{ category_id, cents, previous_cents }], down: [...] }, // top 3 each
  merchants: [{ merchant_key, merchant_name, category_id, cents, count }],   // top 10
  largest: [Tx],                       // five largest single expenses, recurring ones excluded
  counts: { payments, merchants, days_without_spending },
  recurring: { per_month_cents, new: RecurringItem[], ended: RecurringItem[],
               changed: RecurringItem[] },
  savings: { saved_cents, rate /* 0..1 */, goals: [{ id, name, emoji, added_cents,
             saldo_cents, target_cents, reached: boolean }] },
  networth: { start_cents, end_cents } | null,
  months: [{ period, label, income_cents, fixed_cents, daily_cents, saved_cents,
             net_cents }] | null,      // year recap only
  highlights: [{ emoji, title, detail|null }] }   // 3–6 short Dutch sentences
```
A recap exists for every complete period and for every calendar year with data; the current
period or year may be requested and has `complete: false`. `GET /api/recap/index` →
`{periods: [{id, label}], years: [number]}` (newest first).
