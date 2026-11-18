# DEGIRO CSV exports

Research notes for `backend/cents/importers/degiro.py` (2026-11). Sources: public forum threads
and import guides of portfolio trackers (Portfolio Performance forum, Sharesight, trackers'
DEGIRO import help pages) plus the field layout as DEGIRO shows it in the web app. No personal
export was used; the fixtures in `tests/fixtures/degiro_*.csv` are made up.

## General

- Exported from the web app: Inbox/Activiteit → Transacties / Rekeningoverzicht, Portefeuille.
- CSV, UTF-8 (sometimes with BOM); comma separated, some guides mention semicolons. Both are
  accepted (the delimiter is taken from the header line).
- Numbers: Dutch exports use decimal comma and are quoted (`"110,50"`); English exports use
  a decimal point. Thousands separators may appear (`1.234,56`). Dates `DD-MM-YYYY`.
- Amount columns come in pairs: a named column and an **unnamed** column next to it. One holds
  the currency code, the other the number; the order differs per file (Transacties: number then
  currency; Rekeningoverzicht: currency then number). The parser reads both cells and takes
  whichever is a 3-letter code as currency.
- Header text differs per language and per DEGIRO version, so columns are found by name with
  aliases, never by position.

## Transacties (Transactions.csv)

NL: `Datum,Tijd,Product,ISIN,Beurs,Uitvoeringsplaats,Aantal,Koers,,Lokale waarde,,Waarde,,Wisselkoers,Transactiekosten en/of,,Totaal,,Order ID`
(the fee column is sometimes "Transactiekosten en/of derden").

EN: `Date,Time,Product,ISIN,Reference exchange,Venue,Quantity,Price,,Local value,,Value,,Exchange rate,Transaction and/or third,,Total,,Order ID`

- One row per execution: an order filled in parts gives several rows with the same Order ID.
  Dedupe key: account + Order ID + ISIN + date + quantity + occurrence number within the file,
  so re-importing the full history (or an overlapping period) is safe and two identical fills
  stay two.
- Quantity: positive = buy, negative = sell. Value/Total in EUR are negative for buys.
- Exchange rate: units of the local currency per EUR; empty for EUR.
- Beurs: DEGIRO's exchange code (EAM = Euronext Amsterdam, XET/TDG = Xetra/Tradegate, EPA, MIL,
  LSE, NSY, NDQ, …). Used to pick the matching listing at the price provider.
- Not in this file: dividends, dividend tax, connection fees.

## Rekeningoverzicht (Account.csv)

NL: `Datum,Tijd,Valutadatum,Product,ISIN,Omschrijving,FX,Mutatie,,Saldo,,Order Id`
EN: `Date,Time,Value date,Product,ISIN,Description,FX,Change,,Balance,,Order Id`

All cash movements. Cents keeps:
- `Dividend` → dividend; `Dividendbelasting` / `Dividend tax` → dividend tax;
- `Aansluitingskosten` / `Connection fee` (yearly exchange connection), service fees → fee;
- deposits (`iDEAL storting`, `Storting`, `Deposit`, positive, EUR) and withdrawals
  (`Terugstorting`, `Withdrawal`, negative). When present they define "ingelegd" for the account
  instead of the bank side, so a deposit from a bank account outside Cents still counts.

Ignored on purpose: reservations ("Reservation iDEAL"), the flatex cash sweeps ("Overboeking
naar/van uw geldrekening", "Cash Sweep Transfer"), `Transactiekosten` rows (duplicate the fee
column of Transacties), buy/sell rows, currency conversion rows ("Valuta Creditering/
Debitering"). For a dividend in another currency the FX of the row, or of a conversion row on
the same date, converts it to EUR.

## Portefeuille (Portfolio.csv)

NL: `Product,Symbool/ISIN,Aantal,Slotkoers,Lokale waarde,,Waarde in EUR`
EN: `Product,Symbol/ISIN,Amount,Closing,Local value,,Value in EUR`

- A snapshot without a date: stored as prices for the import day (`source = degiro_portfolio`),
  close in EUR = Waarde in EUR / Aantal.
- First row is the cash line (`CASH & CASH FUND & FTX CASH (EUR)`, no ISIN): skipped.
- "Symbool/ISIN" usually holds the ISIN; when it is a ticker the fund is matched by symbol or
  name among known securities.
- When quantities differ from the trades in Cents the import result lists them (`mismatch`);
  nothing is corrected automatically.

## Price source evaluation (keyless)

| Source | Keyless | By ISIN | EU ETFs in EUR | History | Notes |
| --- | --- | --- | --- | --- | --- |
| Yahoo Finance search + v8 chart | yes | search by ISIN (one hit, often the London line) | yes (`.AS`, `.DE`, `.PA`, `.MI`) | daily, years | unofficial; can rate-limit; ToS do not grant automated use |
| boerse-frankfurt.de API | no (signed `X-Security` headers) | yes | yes | yes | breaks when the signing changes |
| live.euronext.com | yes | ISIN-MIC | only Euronext | CSV download | HTML/AJAX endpoints, fragile |
| OpenFIGI | key optional | yes | — | no prices | mapping only |
| ECB eurofxref | yes | — | FX only | full history | official, stable |

Choice: Yahoo for prices (behind `PriceProvider`), ECB for FX. Verified once on 2026-11-16:
IE00B3RBWM25 → VWRL.AS (EUR), IE00B4L5Y983 → IWDA.AS (EUR), ~1.5 years of daily closes.
