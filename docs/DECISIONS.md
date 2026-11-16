
## Backend core (2026-11-14)

- 2026-11-14 · **Period ids.** "Month with most days" skips or doubles a month for start days
  around 14-16 (e.g. start day 16). Rule used instead, fixed per start day: 1-15 → the period is
  named after the month it starts in, 16-28 → after the next month (24 Oct-23 Nov = "2026-11").
  This equals "most days" for every start day except 16 in 31-day months.
- 2026-11-14 · **Period JSON.** `from` and `to` are both inclusive (last day). SQL helpers use
  `Period.end` (exclusive). `GET /bootstrap` returns `periods: {first, last, current}` as ids.
- 2026-11-14 · **kind is a fact.** `kind`/`transfer_account_id` are recomputed on every
  (re)classification even when the category came from the user or a rule; manual transactions
  are never transfers. Own-account transfers get `category_source = "heuristic"` (SPEC has no
  separate source value).
- 2026-11-14 · **Transfers seen from a savings/investment account** get bakje `intern`
  (only checking → savings is `sparen`), so nothing is counted twice.
- 2026-11-14 · **Savings auto-detection is direction-aware.** A new IBAN becomes `savings` when
  savings-like transfers (bank category "Sparen" or ISO `BOOK`) from other accounts go *to* it
  more often than they come *from* it, or when its own statement (≥ 3 rows) holds only
  own-account transfers and interest. Without this, importing the savings file first made the
  checking account look like savings. Accounts are named "Betaalrekening"/"Spaarrekening", with
  the last 4 IBAN digits added when one of that type already exists.
- 2026-11-14 · **One import row per file**, also for files with several accounts. The per-file
  result reports the first new account (or the first account) and adds `new_accounts[]` and
  `import_id`. Undoing an import does not delete auto-created accounts.
- 2026-11-14 · **Dedupe/enrich.** Enrichment fills raw facts the stored row lacks (ISO codes,
  bank category, type, balance, counterparty, refs) and recomputes derived fields unless the
  category was set by the user or a rule (then merchant name/key stay). `enriched` ⊆ `duplicates`.
- 2026-11-14 · **ASN CSV tail parsing.** The quoted free-text columns can contain commas and
  apostrophes ("CAFE 'T HOEKJE"), so the 16 fixed columns are split on commas and the tail
  (Betalingskenmerk, Omschrijving, Afschriftnummer, Categorie) is matched with a pattern. A header
  with an unexpected column order falls back to a CSV reader mapped by header name.
- 2026-11-14 · **Learning details.** Choosing "Nog te sorteren" with `apply_to_merchant` forgets
  the merchant's rule and re-runs the engine. A merchant-wide change also pulls the edited
  transaction back from `user` to the rule. Bulk category changes are per-transaction (`user`),
  they do not create rules. `tag_always` stores one tag per merchant (the newly added one).
- 2026-11-14 · **Account suggestions** carry a `key` (`savings:<iban>`, `investment:<brand>`);
  "Nee" is stored with `PATCH /settings {dismissed_suggestions: [...keys]}`.
- 2026-11-14 · **Library format.** `asn_categories.json` values may be direction-specific
  (`{"out": "belastingen", "in": "toeslagen"}`), as the data files use it for
  "Belastingen & Toeslagen". The 4-digit bank code method from `bank_codes.json` wins over
  everything except "counterparty is an own IBAN".
- 2026-11-14 · **Salary heuristic.** Besides the words salaris/loon, the largest unsorted
  incoming company transfer on a checking account with ≥ 3 distinct months, a median ≥ € 500 and
  amounts within ±30 % becomes `salaris`, only while nothing is in `salaris` yet.
- 2026-11-14 · **Filters.** `min_cents`/`max_cents` compare absolute amounts. `q` also matches
  counterparty name and city, and amounts typed as "12,50", "€ 12,50", "12.50", "1.250,00" or "12".
- 2026-11-14 · **Data endpoints.** CSV export uses `;`, decimal comma and a UTF-8 BOM (opens
  cleanly in Dutch Excel/Numbers). Restore validates the file, replaces the database and keeps
  the current device logged in. `DELETE /data` removes transactions, imports, accounts, tags,
  rules, goals and values; bakjes, settings and the password stay. `POST /reclassify` also
  recomputes merchant names/keys from the stored raw fields (except user/rule rows).
- 2026-11-14 · **Small extra read endpoints** for the UI: `GET /categories`, `GET /tags` (with
  `count`), `GET /accounts`, `GET /accounts/{id}/values`. Logout needs no session.
- 2026-11-14 · `.gitignore` ignores every `data/` directory; an exception for
  `backend/cents/data/` was added so the library files are committed.
- 2026-11-14 · **Account typing is order-independent.** New IBANs start as checking; after every
  import, import undo, account delete and reclassify, `refresh_accounts` re-decides checking vs
  savings for every account with `type_source = 'auto'` from all stored rows: savings when it has
  no card/iDEAL/direct-debit/ATM rows and ≥ 90 % of its rows are own-account transfers (BOOK
  codes, an own IBAN as counterparty, bank category "Sparen") or interest/fees, or when other
  accounts move money to it labelled "Sparen"/BOOK more often than back. If every bank account
  would be savings, the busiest stays checking; a lone savings-only account may be savings.
  Auto names (`name_source = 'auto'`) follow the type, with the last 4 IBAN digits on all
  accounts of a type only when there are two or more. `PATCH /accounts` with `type`/`name` (or
  `POST /accounts`) marks them `user`: never changed automatically. Migration v2 adds
  `accounts.type_source` and `accounts.name_source`.
- 2026-11-14 · **Large and repeated imports.** Upload limit 250 MB per file; uploads are parsed
  from Starlette's temporary file (CSV line by line, CAMT with `iterparse` on end events,
  clearing each `Ntry`), rows are inserted with `executemany` in batches of 2000, and
  classification runs once per request in chunks. Each file is stored inside its own SAVEPOINT:
  a failure midway stores nothing of that file (other files in the request still import). Keys
  without a bank sequence number are `h:<sha1>:<n>`, n = occurrence of an identical row within
  the same file, so two identical payments on one day stay two and re-imports (same or
  overlapping file) match one-to-one. The import response contains counts only.

## Frontend (2026-11-14)

- 2026-11-14 · **Runtime deps.** SPEC §2 lists `@preact/signals`; the frontend uses only Preact
  hooks + htm (one vendored module, `htm@3.1.1/preact/standalone`) and a ~100-line store
  (`js/store.js`). One file less to vendor, nothing lost.
- 2026-11-14 · **Sheets are centred cards from 700 px** (DESIGN only says ≥ 1000). A full-width
  bottom sheet on an iPad in portrait looks wrong; iPadOS uses form sheets at every size.
- 2026-11-14 · **No background scale-down behind large sheets.** Scaling the page would break
  the fixed tab bar and sticky nav bars (transforms create containing blocks); the scrim alone
  reads fine.
- 2026-11-14 · **Status bar style `black-translucent`.** Content runs under the status bar and
  the nav bars pad by `env(safe-area-inset-top)`, so the translucent bar covers the status bar
  like a native app, in both light and dark.
- 2026-11-14 · **Tabs are history entries too.** Switching tabs pushes a history entry (with a
  cross-fade, not a slide). Browser back then behaves predictably on the web; the back chevron
  and the edge swipe only appear on screens with a parent and go to that parent.
- 2026-11-14 · **Edge-swipe back only in Home Screen mode** (Safari tabs have their own).
- 2026-11-14 · **Overzicht details.** The month pill sits in the centre of the nav bar and stays
  there when the large title collapses. "Waar het heen ging" shows fixed and daily bakjes (as
  `/overview.categories` returns them); the first 6 rows, then "Toon alle". Chips: mid-month only
  "meer" chips for daily bakjes, compared with normaal pro rata to the day; "minder" only for
  finished months; never on "Nog te sorteren". The hero shows "Nog te besteden" (current month),
  "Uitgegeven" when `left_cents` is null, and "Over"/"Tekort" (= `net_cents`) for past months; a
  negative "nog te besteden" turns orange. The pace chart is not scrubbable: a horizontal swipe
  on the hero changes the month. The "unsorted" insight is hidden while the sort banner shows.
- 2026-11-14 · **Tile links.** Inkomen → `#/transacties?period=…&flow=in`, Uitgegeven →
  `flow=out` (a UI parameter; the backend's `min_cents`/`max_cents` are absolute amounts),
  Vaste lasten → `#/vaste-lasten`, Gespaard → `#/potjes`.
- 2026-11-14 · **Insight links.** The frontend follows `href` when present, else maps
  `link: {screen, params}` itself (same table as `services/insights.py`). `/import` opens the
  Import sheet.
- 2026-11-14 · **Restore upload** uses multipart field `file` (SPEC does not name it).
- 2026-11-14 · **Expenses in lists are unsigned** (`€ 41,20`), income `+€ 2.400` in green;
  negative balances and "Tekort" use a real minus (U+2212).
- 2026-11-14 · **Sidebar selection is solid accent with white text** (macOS/iPadOS sidebar
  style). Tabs have no badges: the sort banner on Overzicht carries the count.
- 2026-11-14 · **Undo for endpoints without an inverse.** Deleting a potje, account, custom
  bakje, account value, goal entry or learned rule and "Geen vaste last" hide the item at once
  and commit the API call only after the undo toast (~5 s; `screens/_kit.js` `commitLater`,
  flushed when the page is hidden). Archive, assignments, saldo and money changes call the API
  at once and undo with the inverse call.
- 2026-11-14 · **Confirmation sheets only where undo is impossible**: undoing an import,
  restoring a backup and "Alles wissen" (password). Everything else is undo-by-toast.
- 2026-11-14 · **Potjes.** The grid always ends with a "Nieuw potje" ghost card. "Nog te
  verdelen" shows even without potjes; every transfer has a "+ Nieuw potje" chip that prefills
  the 5-digit code (and words) from its description, so an existing standing order ("Spaardoel
  41827") picks up its whole history at once. The edit sheet shows the code (editable). Colour is
  picked automatically for a new potje and editable later. "Geld toevoegen" has Erbij/Eraf.
  Reaching 100 % pops a 🎉 badge on the ring and the toast says "… is gehaald" (with undo).
- 2026-11-14 · **Vermogen.** Credit cards show the open amount (not negative) with subtitle
  "open"; investments show "inleg …" with the result under the value. Range 6M/1J = last 7/13
  monthly points. "Nee" on a suggestion appends its key to `dismissed_suggestions`.
- 2026-11-14 · **Vaste lasten.** Item history = the merchant's payments with the same sign within
  0.6–1.6 × the current amount (the API has no per-item payment list). Savings transfers form
  their own group at the end (they are not in `monthly_out_cents`). Share-of-income bar =
  `monthly_out / monthly_in`, orange above 60 %.
- 2026-11-14 · **Jaaroverzicht** loads `/trends?periods=24`: the chart shows the last 12, the
  extra year feeds "Zelfde maand vorig jaar" (last complete month, or the scrubbed one). A
  scrubbed month shows an "Open" pill that goes to Overzicht for that period (a tap on the
  chart itself only selects, so scrubbing never navigates by accident).
- 2026-11-14 · **Instellingen** sub-lists are pushed screens (`#/instellingen/regels`,
  `/imports`, `/backup`) with back label "Terug" (the long titles leave no room). "Maand begint
  op" is a 28-day grid with a live sentence and Annuleer/Klaar. On wide screens Instellingen also
  lists Bakjes and Sorteren (the sidebar has no Meer). "Componenten" (gallery) only in mock mode.
- 2026-11-14 · **Bakjes** hides `unsorted`, `intern` and `creditcard`; soort is editable only
  for custom bakjes (vast/dagelijks/inkomen).
- 2026-11-14 · **Mock aligned with the backend:** `POST /goals/{id}/entries` and `/saldo` return
  `{entry, goal}` (`entry` null when unchanged), `GET /goals` adds `archived_goals` and per goal
  `archived`/`sort`, suggestion kind `yearly_bills`, `GET /accounts` adds `n_transactions` and
  `n_imported`.

- 2026-11-14 · **Transacties list.** Filters live in the URL query (`q`, `category_id`, `tag_id`,
  `account_id`, `period`, `merchant_key`, `unsorted=1`, `flow`). Pages of 150 via the opaque
  cursor; only the day groups within ~1400 px of the viewport are in the DOM (top/bottom spacers
  sized from measured group heights), so 6,000 rows stay ~30 rows in the DOM. A refetch after
  any mutation reloads as many rows as are loaded (in requests of ≤ 1000). Day header total =
  signed sum of that day. Search is debounced 260 ms into `q`.
- 2026-11-14 · **`flow=in|out`** fetches the whole period (pages of 1000) and filters on the
  client to exactly the rows behind Overzicht's tile: cash-flow accounts (checking, manual
  credit-card purchases), `kind = normal`; `out` = bakjes with `grp = daily` (refunds included,
  so the sum equals `daily_cents`) plus bakje `creditcard`/settlements when there is no
  credit-card account (they are then unexplained daily spending); `in` = income bakjes and
  positive unsorted. Verified equal to `/overview` on the real backend for four months.
- 2026-11-14 · **Split view** (≥ 1000 px): list + sticky detail pane rendering the same
  `TransactieDetail` as the sheet; ↑/↓ move the selection. "Selecteer" sits leading (the
  trailing slot keeps `+`), "Klaar" trailing while selecting; the bulk bar sits above the tab bar.
- 2026-11-14 · **Bulk undo** restores each payment's previous bakje with one bulk call per
  previous bakje (they become `user`-sourced: the bulk endpoint has no "back to rule").
- 2026-11-14 · **Transaction sheet.** Bakje changes save on tap (optimistic, list updated via an
  in-memory change channel before the refetch). Undo of a merchant-wide change PATCHes the
  previous bakje merchant-wide again. "Altijd voor <winkel>" (tags) is a switch: on = PATCH with
  the last added tag first + `tag_always`; off = PATCH `{tag_ids: [], tag_always: true}` (forgets
  the merchant's tag rule) followed by PATCH with the tags restored (the API has no direct off).
  The merchant sparkline buckets `GET /transactions?merchant_key&from=-370 days` per month; the
  line says "afgelopen jaar" because `total_12m_cents` is a rolling 12 months. Potje picker only
  for savings transfers and only when `/goals` answers.
- 2026-11-14 · **Amount-dependent bakjes (owner request).** The "Voor alle van <winkel>" switch
  became a pop-up row "Geldt voor: Alleen deze · Alle van <winkel> · Onder € X" (fits 320 px);
  "Onder" reveals a stepper over round amounts (€ 1, 2, 3, 5, 7,50, 10, 15, 20, 25, 30, 40, 50,
  75, 100, …), default the next round amount above the payment. It sends `apply_scope` and, for
  safety with servers that do not know it yet, `apply_to_merchant: false` for `merchant_below`
  (an old server then changes only this payment). An existing threshold shows as a row
  "Onder € 15 · 🍽️ Uit eten" with "Grens aanpassen" / "Grens weghalen" (`PATCH /rules/{id}`,
  undoable). `category_reason_label` shows as one quiet line under the grid. Sorteren keeps one
  tap per merchant.
- 2026-11-14 · **Sorteren.** Queue fetched once per opening (no refetch per tap, so the order
  never jumps); saves run in the background, a failed save puts the card back. The card is
  cloned and flown into the tile with the Web Animations API while the next card springs in, so
  input is never blocked. Swipe right = suggestion, left = skip (buttons do the same). Undo =
  `POST /sort` with `unsorted` (the backend forgets the rule). Skipped merchants can be revisited
  at the end. Keys: 1 suggestion, 2–9 tiles (hint badges on pointer devices), space, ⌘Z, Esc.
- 2026-11-14 · **Import.** One request per file, in order (each file gets its own progress,
  result and error; the API also caps a request at 20 files). Upload progress via
  XMLHttpRequest (`js/upload.js`), then "Verwerken…" until the response. New accounts are named
  and typed inline (`PATCH /accounts/{id}`; an auto name follows the chosen soort). A drop while
  the sheet is open joins the open sheet. Nothing new reads "Alles was al bekend" with a calm
  check, never as an error.
- 2026-11-14 · **Tags.** List totals come from `GET /transactions?tag_id&limit=1`
  (`sum_out_cents`, `count`). Tag delete is commit-later (5.4 s, flushed on `pagehide`) so undo
  keeps rules and links intact. Tag detail uses `/tags/{id}/summary` and falls back to computing
  it from `/transactions?tag_id` when the endpoint is missing. Typing an emoji first in a tag name
  ("🇮🇹 Vakantie Italië") sets the tag's emoji.
- 2026-11-14 · **Mock aligned with the backend:** `POST /transactions` returns
  `{transaction, updated_count}`; `GET /transactions` accepts `limit` up to 1000. Mock also
  implements the amount-threshold contract (`apply_scope`, `category_reason*`, rule `below_*`,
  `PATCH /rules/{id}`).
- 2026-11-14 · **SearchField** (shared): the box gets `min-width: 0` and the input `width: 0`, so
  "Annuleer" is never squeezed at 320 px.

## Analytics (2026-11-14)

- 2026-11-14 · **Signs.** Totals are positive magnitudes: overview `income/fixed/daily/saved`
  (+ `_upcoming`), `categories[].spent_cents`/`avg_cents`, trends, bakje summary `spent_cents`,
  `series`, `merchants[].cents`, recurring `monthly_out/in`, `yearly_out`, tag `by_category` /
  `by_month` (net money out). Single items keep the payment's sign: recurring `amount_cents`,
  `per_month_cents`, `change.from/to_cents`, overview `upcoming[].amount_cents`. Tag summary
  `total_out_cents` is ≤ 0 like `sum_out_cents` of GET /transactions. Goal amounts are seen from
  the pot: money from checking to savings is positive (also `unassigned[].amount_cents`).
- 2026-11-14 · **Savings interest** counts as income in its own income bakje, else in
  "Overig inkomen" (ASN labels interest "Sparen", so the engine puts it in `sparen`). Nothing
  else on a savings or investment account counts.
- 2026-11-14 · **Credit card.** Settlements are explained per credit-card account by its manual
  purchases. Payments in bakje `creditcard` without a credit-card account are fully unexplained.
  The unexplained part is daily spending and shows as the "Creditcard" bakje in
  `categories`. Net worth `unexplained_cents` = the unexplained part of the latest settlement.
- 2026-11-14 · **Complete periods.** History = periods before the current one; the first data
  period counts when the data starts within its first 7 days. Periods without a single
  cash-flow transaction are import gaps and are skipped (they would drag every "normaal" down).
- 2026-11-14 · **Expected income.** Current/future period: income so far + recurring income
  items still expected in the period; without recurring income, max(income, mean of the last
  three complete periods). Past periods: the actual income.
- 2026-11-14 · **Upcoming** = occurrences of recurring items (not ended) from `next_date` on
  inside the period, overdue ones included; only for the current and future periods.
  `per_day_left` = `left` / days left including today (real today), not clamped (can be < 0).
  `pace.actual` runs to "data today"; `pace.typical` is `[]` without history; `pace` is null for
  future periods and periods without data and history. `balance.expected_end_cents` = checking
  balance + income still expected − upcoming fixed − upcoming saving − typical rest of daily
  spending (current period with history only).
- 2026-11-14 · **Overview `unsorted`** is global (the sort queue: merchants, transactions,
  signed sum), not per period, so the banner and Sorteren agree.
- 2026-11-14 · **Bakje lists** (overview, trends) hold fixed + daily bakjes plus "Nog te
  sorteren" (money out) and the credit-card line. `avg_cents` = mean of up to six complete
  periods (zero months included); the spike insight uses the median as SPEC says.
- 2026-11-14 · **Recurring.** Cash withdrawals, `internal` bakjes and card settlements are
  never recurring. Savings transfers are (for `saving_upcoming`) but are left out of
  `monthly_out_cents`. Item key = `merchant_key|rounded current amount` (the median of six moves
  for months after a price change and the "ignore" would be lost). `change` = the most recent
  price change (run of payments at the latest price vs the median of the three before it),
  reported for 12 months; not for `variable` items. A yearly pair is rejected when the merchant
  had two or more other payments in between (a shop you visit often). Monthly `next_date`: the
  usual day (median of the last six) in the first month more than 15 days after the last payment.
- 2026-11-14 · **Insights.** `link` is `{screen, params}` as asked; each insight also carries
  `href`, the frontend hash route (`/vaste-lasten`, `/overzicht/bakje/3?period=…`, `/import`, …),
  because the current frontend `openLink()` takes a path string. Rules about "now" (pace,
  price/new/ended subscriptions, yearly bill, goals, stale, unsorted, buffer) run only for the
  current period. Thresholds: pace from day 5 and ≥ max(€ 25, 10 %); spike compares the same
  day range in earlier periods; duplicate ≥ € 10, card/debit, last 45 days for the current
  period; large > € 150 and > 3 × the merchant's median (≥ 3 other payments) else the bakje's;
  price change within the last four periods; yearly bill due within 60 days; left_over for a
  past period, or for last period during the first 10 days; buffer = savings ÷ average
  fixed + daily (good from 3 months, ranked low); fixed share over the last three complete
  periods (warn > 60 %, else info); savings rate = year to date in the current period;
  goal_reached only when the last entry is < 60 days old. Fixed ranking scores, top five.
- 2026-11-14 · **Goal matching** runs after every import (new transactions only) and when a
  goal is created, renamed, gets keywords/code, or is unarchived (all transfers without a goal),
  so "Vakantie" picks up its history at once. Savings transfers = checking rows in `sparen` or
  own transfers to a savings account; a savings-side row only when its checking mirror (same
  amount, ±3 days) is not imported. `POST /goals` and `PATCH` accept an optional `code`
  (5 digits, not starting with 0, unique) for an existing standing order.
- 2026-11-14 · **Goal entries ↔ `transactions.goal_id`** are kept in line by an `after_write`
  hook: set → entry (kind `manual`, learned for later matching), changed → moved, cleared →
  removed. `POST /goals/{id}/entries {transaction_id, amount_cents}` splits a transfer over
  several potjes. `POST /goals/{id}/entries` and `/saldo` return `{entry, goal}` (`entry` is
  null when the saldo was already right).
- 2026-11-14 · **Goal numbers.** `avg_contribution` = entries (not `adjust`) over the complete
  periods of the last three since the goal started; with none yet the status is `on_track`.
  `catch_up_cents` = the advice when `behind` (both are what is still needed per month from
  now). A passed one-off date counts as one month left. `projected_date` = today + ⌈rest ÷
  average⌉ months. The yearly roll-over is written on GET /goals (a negative saldo restarts at 0
  with an `adjust` entry "Nieuw jaar"). `unassigned` = the last 90 days, at most 50. Archived
  goals are left out of `goals` and totals and listed in the added `archived_goals`; goals also
  carry `archived` and `sort`. Suggestion kinds: `buffer` (3 × average monthly fixed + daily,
  rounded up to € 100, unless a goal name contains "buffer") and `yearly_bills`.
- 2026-11-14 · **Net worth.** Investment value = last entered value + net transfers since that
  date; without a value it is the invested amount and `result_cents` is null. Series per
  calendar month, last value carried forward, 0 before an account's first known value; hidden
  accounts are left out of the total and the series.
- 2026-11-14 · **Summaries.** Trends leave out periods before the first data period (fewer than
  `periods` for a new household). The bakje summary adds `period` (Period object); `merchants`
  is the top 10. Tag `by_month` is keyed by period id.
- 2026-11-14 · **Cache.** Every mutating request stores a random token in the private setting
  `_state`; derived data is cached per (database file, token, today). A connection with
  uncommitted writes never uses the cache.
- 2026-11-14 · **Security review fixes (backend core).**
  Restore always keeps the live password hash and the live sessions (read before the swap,
  written back after) and refuses a backup without a password hash; exported backups contain no
  sessions (journal mode DELETE, vacuumed). Before a restore the live database is copied to
  `cents.db.pre-restore` (latest only). The upload is validated: SQLite header, `integrity_check`,
  no triggers/views/virtual tables, exactly the tables and columns of a fresh database migrated to
  the file's `user_version` (older versions are migrated after the restore, newer ones refused),
  same page size as the live database; any `sqlite3.Error` becomes a 400. After the swap:
  migrations, `refresh_accounts`, classification, analytics cache cleared. The backup is streamed
  straight into one temp file (multipart field `file` as before, or a raw body).
  A pure ASGI middleware (`guard.py`) runs before the body is read: CSRF header, session check
  for `/api/import` and `/api/restore` (401), size caps via Content-Length and while streaming
  (413; import 1 GB per request, at most 20 files of 250 MB; restore 500 MB), security headers,
  and a JSON 500 `{"code": "internal"}` for unhandled errors (no dropped connections). Integer
  overflow anywhere → 400 "Dit getal is te groot."; money fields are bounded to ±10^12 cents
  (422). CSV export prefixes text cells starting with = + - @ tab or CR with `'` (never the
  amount). First-run setup is atomic (`INSERT … ON CONFLICT DO NOTHING`; losers get 409).
  scrypt N = 2^15 (maxmem raised); older hashes still verify and are re-hashed on the next login.
  CSP adds `base-uri 'none'; form-action 'self'`. Dependencies pinned to the current releases
  (FastAPI 0.162.7, Starlette 1.10.0, Uvicorn 0.54.0, python-multipart 0.0.33).
- 2026-11-14 · **Interest beats labels.** A transaction with method `interest` goes to
  `inkomen-overig` (or `overig` when negative) before merchant/MCC/keyword/bank steps; ASN labels
  savings interest "Sparen", which used to put it in bakje `sparen`.

## Analytics review fixes (2026-11-14)

- 2026-11-14 · **Recurring series.** Amount clusters of one merchant and direction are chained
  when the old one stops and the next starts 0.5–1.6 gaps later (amount within ×0.5–2): a price
  rise above 15 % continues the item with a `change` (visible from the first new payment). A
  cluster with irregular gaps of ≥ 4 payments is split at the widest gap between its days of the
  month when both halves are regular (two policies at one insurer). New frequencies
  `2-weekly` (12–16 days, × 26/12 per month) and `4-weekly` (every gap 26–29 days, × 13/12);
  their `next_date` is last + median gap.
- 2026-11-14 · **Fixed costs only.** `monthly_out_cents`/`yearly_out_cents` and
  `fixed_upcoming` count items in bakjes of group `fixed`; `monthly_in_cents` items of group
  `income`; saving items stay listed but outside the totals. Items in `daily` bakjes (and
  "Nog te sorteren") are listed only when they look like a subscription: monthly or longer,
  last six amounts within 5 %, and the merchant had fewer than two other payments in that
  span. No price-change/new/ended insights for them.
- 2026-11-14 · **"new"** needs ≥ 75 days of data on the account before the first payment.
- 2026-11-14 · **Item key** = `merchant_key|direction|frequency|original amount` (median of the
  series' first three payments, whole euros; no amount for `variable` items; `#2` on a clash).
  It survives price changes, so "Negeer" sticks. Older keys (`netflix|16`) no longer match.
  `DELETE /recurring/ignore {key}` un-ignores.
- 2026-11-14 · **Insights.** Payments of quarterly/half-yearly/yearly recurring items are left
  out of `category_spike` (current and history) and every recurring payment is left out of
  `large`. `left_over`, `savings_rate` (current: year to date over complete periods only, from
  two of them), `fixed_share` and `last_year` use only complete periods. `/trends` periods carry
  `partial` (current period, first partial period, import gaps). Identical payments within 3
  days form one group → one insight ("Drie keer € 25 …"); with more than two groups, the
  largest plus one "N andere betalingen staan er dubbel in". Wording: "Nieuwe vaste last",
  "N winkels / personen / winkels of personen zonder bakje", buffer detail "3 maanden is een
  gangbare buffer". Period ids outside 1971–2200 → 400 `bad_period`.
- 2026-11-14 · **Data today and stale.** "Data today" = latest *imported* transaction on a
  visible checking/savings account, never after today (manual and future-dated rows do not
  count) + 3 days. `stale` fires only when that date is > 10 days ago *and* the latest import
  (`imports.imported_at`) is > 10 days ago.
- 2026-11-14 · **Hidden accounts** are left out of cash flow, recurring, goals' savings
  transfers, bakje and tag summaries (they already were out of net worth). The sort queue
  (core) still includes them.
- 2026-11-14 · **Goals.** A passed date on a non-yearly goal that is not reached → status
  `overdue`, `months_left` 0, `monthly_advice_cents` = the remaining amount, `catch_up_cents`
  null; insight (kind `goal_behind`, tone info) "De datum van X is voorbij; nog € Y te gaan".
  Splitting a transfer: shares must have the transfer's sign and may together not exceed it
  (400 `split_too_large`).
- 2026-11-14 · **Early salary.** Income of one payer (bakje group `income`, ≥ 3 payments) that
  usually arrives in the first 7 days of a period (≥ 60 % of payments) and this time came up to
  3 days before the period start counts in the period it is meant for. Applied once in the
  ledger, so overview, trends, net, pace and history all agree and nothing is counted twice.
  `GET /transactions?period=` (core) still lists the payment by its booking date.
- 2026-11-14 · **Insight preferences.** Ids are stable per fact (`price_change:<key>:<date>`,
  `duplicate:<merchant_key>:<date>`, `category_spike:<category_id>:<period>`,
  `new_recurring:<key>`, `ended_recurring:<key>:<last_date>`, `yearly_bill:<key>:<due date>`,
  `large:<tx id>`, `left_over:<period>`, `pace|buffer|unsorted|fixed_share|last_year:<period>`,
  `stale:<last import date>`, `goal_behind:<goal>:<period or date>`, `goal_reached:<goal>`).
  `POST /insights/dismiss {id}`, `POST /insights/mute {kind, muted}`; both are filtered out
  before ranking. Dismissed ids are stored in the private setting `_dismissed_insights` (latest
  500; private so 500 ids do not ride along with every bootstrap), muted kinds in
  `muted_insight_kinds`. `GET/PATCH /settings` add `muted_insight_kinds` and `insight_kinds`
  `[{kind, label}]`.
- 2026-11-14 · **Assumptions.** `GET /assumptions` (module `services/smart.py`; the core's
  `services/assumptions.py` holds engine thresholds). `salary` = live recurring income items in
  bakje `salaris`; `accounts[].type_source` = `import` when an import created/filled the
  account, else `user` (a later type change by the user is not tracked); `goal_links` = learned
  description → goal links from manual assignments; `DELETE /goals/links {goal_id,
  description}` stores the link in the private setting `_forgotten_goal_links` so it is no
  longer used. `suggestion.month_start_day` = usual day of the largest monthly salary when the
  last six days lie within 4 days, 2–28, and differ from the setting.
- 2026-11-14 · **Calculation review (core).** CAMT `RvslInd` no longer flips the sign
  (`CdtDbtInd` is the real direction; SPEC §5 was wrong); the flag is kept as `reversal` in the
  parsed row only. CAMT balances are computed in booking order (date, sequence) and anchored on
  OPBD, or on CLBD when OPBD + entries ≠ CLBD; a chain contradicting CLBD is never stored
  (descending files are corrected at the end of each statement). ASN CSV balances come per row
  from "Saldo voor boeking", so order never matters. Amounts are parsed strictly (decimal point,
  ≤ 2 decimals, no thousands separator); anything else fails the file cleanly. Only an
  ASN-style `NtryRef` (`<8 digits>-<digits>`) is a sequence number; other banks use the
  content-hash key. Bank fees and interest get one merchant per own account ("Bankkosten" /
  "Rente", key `bankkosten <last 4>` / `rente <last 4>`). Nameless payees get `iban:<iban>` or a
  per-transaction `x:<hash>` key instead of one shared "onbekend".
- 2026-11-14 · **Library matching.** Deterministic: longest match, then earliest position in
  the text, then file order. Merchant and keyword entries may carry `"methods"` (allow-list;
  set on every beleggen, leningen, wonen, verzekeringen, energie, belastingen, toeslagen and
  creditcard brand: transfer/ideal/debit/internal/other, never card/atm) and merchants
  `"weak"` (true, or the list of weak match strings) for brand names that are also common words,
  surnames, places or very short tokens; longer forms ("shell express", "action nederland",
  "bp express") stay strong. Engine order: user, rule, transfer, interest, strong merchant, MCC,
  keyword, weak merchant, bank category, heuristic. Only strong brands rename a merchant.
  Keywords: generic housing words (huur, maandhuur, kale huur, huurpenningen, hypotheek,
  hypotheekrente) only for debit/transfer; "loon" only for transfers; VvE forms added to wonen.
  Kept as they are, with reasons: gift/kerk (only money out → cadeaus is right), school (whole
  word only, compounds like rijschool do not hit), zoo, cafe, pizza, hotel, camping, catering
  (whole words that name the purpose; MCC and strong brands come first anyway).
  `asn_categories` "Lening": out → leningen, in → inkomen-overig. "Sparen" stays `sparen` in
  both directions: money back from savings on a checking account is a withdrawal (negative
  saving), which is what the analytics expect.
- 2026-11-14 · **Persons and intermediaries.** A name with a trade word (slagerij, bakkerij,
  garage … and every single-word keyword of five letters or more) is not a person. Tikkie /
  betaalverzoek: when the text names the requester (", Van J de Vries") the row becomes that
  person (`p:` key); otherwise key `via:tikkie`, which behaves like a person (never classified
  by library data, `is_person: true` in the sort queue) and never gets a rule: sorting it or
  `apply_to_merchant` sets only the currently unsorted rows, as individual choices.
- 2026-11-14 · **Amount-dependent bakjes and explanations.** Migration v3 adds
  `rules.below_cents`, `rules.below_category_id` and `transactions.category_reason`. A split
  applies when `abs(amount) < below_cents` (equal → main bakje; refunds follow the same split).
  Library `small` sits on MCC 5541 and the 19 fuel brands, never on 5542 or EV charging; a card
  MCC 5542 disables a brand's split. Setting `assumptions.small_amount_at_fuel` (enabled,
  below_cents 100–10000) replaces the threshold of every library `small` entry and can switch
  them off; user rule thresholds always apply. `PATCH /transactions/{id}` accepts `apply_scope`
  (`one` | `merchant` | `merchant_below` + `below_cents`); `merchant_below` stores the main
  bakje explicitly (existing rule, else the most common bakje of the merchant's larger amounts,
  else of all its rows). Rule application now re-runs the engine for the merchant, so a
  threshold is honoured; user-set rows are never touched.

## Frontend: Mac first (2026-11-14)

- 2026-11-14 · **Desktop layer in one file.** Everything for ≥ 1000 px lives in
  `css/desktop.css` (linked last) as a token density layer (type 13–14 px, rows 36–40 px,
  `--gutter` 36 px, `--col-max` 1200 px, sidebar 240 px, toolbar 52 px) plus per-screen blocks.
  Field font sizes only drop below 16 px for `(hover: hover) and (pointer: fine)`, so an iPad in
  landscape never zooms into inputs. Screens branch in JS on `useLayout() === 'wide'` only where
  the structure differs (tables, inspectors, splits).
- 2026-11-14 · **Toolbar instead of nav bar + large title** on desktop (Screen renders it): back
  chevron (pushed screens), title, `titleView` (month switcher / segmented control), screen
  actions, the global search and one `+`. Screens with their own `+` pass `add` items; the `+`
  menu shows them above "Bankbestand importeren" / "Uitgave toevoegen", so there is never a
  second plus. Search: on Transacties it is the list's search (live into `q`); elsewhere Enter
  opens Transacties with `q`.
- 2026-11-14 · **No sliding pages on the Mac.** push/pop become the 150 ms cross-fade; Sorteren
  is a normal sidebar destination (sidebar stays visible, count badge when merchants wait).
- 2026-11-14 · **Transacties worksheet.** One windowed table (same paging/windowing as the
  phone list), inspector fixed on the right (400 px, 320 px below 1280). Click selects, ⌘-click
  toggles, ⇧-click/⇧↑↓ select a range; with 2+ chosen the bulk bar sits in the toolbar and the
  inspector shows a summary with Bakje/Tag. The bakje cell is a pop-up (popover list with search
  and "Alle van <winkel>" switch, default on like the sheet). Right-click: Bakje ▸, Tag ▸,
  Kopieer bedrag, Toon alles van deze winkel. ⌘A is not taken (it is a browser shortcut).
- 2026-11-14 · **Mac selection colours.** Rows use a tint-soft selection (not solid accent:
  bakje chips stay readable); menus and popover lists highlight the hovered row in solid accent
  with white text like macOS menus. Menus open without a pre-highlighted item.
- 2026-11-14 · **Pickers are popovers on desktop** (bakje, tag, bulk, period, "Maand begint op",
  rule threshold). Real tasks (import, new potje, new expense, edit sheets) stay centred sheets.
- 2026-11-14 · **System Settings layout** (`SettingsSplit`) for Instellingen (Algemeen, Bakjes,
  Slimme aannames, Geleerde regels, Importgeschiedenis, Back-up) and Tags (tags left, tag right;
  `#/tags` opens the first tag). Switching sections is instant (`direction: 'none'`).
- 2026-11-14 · **Draw-in animations never decide the final state** (`js/anim.js`): base style =
  end state; Web Animations from a start state with fill `backwards`, skipped when the document
  is hidden or motion is reduced, and finished by a timer shortly after their planned end even
  if no frames are produced. Applies to capsule, ranked bars, tile/share bars, rings, chart
  bars/lines/areas, Sorteren card; count-ups land on the target after `duration + 150 ms`.
- 2026-11-14 · **Segmented control** positions its thumb by CSS from the index (equal
  `minmax(0, 1fr)` columns, `--seg-i` / `--seg-n`); nothing is measured, so it is exact at every
  width, after resizes and while hidden.
- 2026-11-14 · **New API values.** Frequencies via `freqLabel()` (`2-weekly` "per 2 weken",
  `4-weekly` "per 4 weken"; unknown → no chip / "terugkerend"). Goal `overdue` → chip "Datum
  voorbij" (neutral grey), card "nog € X te gaan", advice "Datum voorbij. Nog € X te gaan."
  `/trends` `partial` periods are drawn at 45 % opacity, never used for "Zelfde maand vorig
  jaar" or Jaaroverzicht averages.
- 2026-11-14 · **Insight preferences.** Every insight has "…" (and right-click): "Niet meer
  tonen" hides it at once and commits `POST /insights/dismiss` after the undo toast; "Dit soort
  meldingen uitzetten" calls `/insights/mute` at once, undo unmutes.
- 2026-11-14 · **Slimme aannames** (`#/instellingen/aannames`): one row per assumption (salary
  series → its payments; account soort pop-up with undo; suggested start day "Gebruik" with undo;
  fuel split switch + € stepper 1–100; ignored vaste lasten "Zet terug"; learned potje links
  "Vergeet" (commit-later); insight kinds as switches; link to Geleerde regels).
- 2026-11-14 · **Rules with a threshold** show "Onder € 15: Uit eten"; the row menu offers
  "Grens aanpassen" (popover stepper) and "Grens weghalen", both undoable.
- 2026-11-14 · **Amount scope against the real backend.** Verified `apply_scope:
  merchant_below` stores `below_cents`/`below_category_id`; the temporary `apply_to_merchant:
  false` is no longer sent. The toast does not repeat `updated_count` for this scope (the backend
  counts every re-applied row). `via:` merchant keys never offer "Alle van …".

## Calendar, yearly cost, recap (2026-11-14)

- 2026-11-14 · **Calendar schedule.** Items: recurring items in `fixed` bakjes (out), `income`
  bakjes (in) and `saving` bakjes. Expected dates: monthly = the usual day of the month (median of
  the last six); 2-/4-weekly and weekly = steps of 14/28/7 days from the last payment;
  quarterly/half-year/yearly = 3/6/12 months from the last payment. Never before the first
  payment; for an ended item never after its last one; ended items are left out of future
  periods. Payments are matched one-to-one to the nearest slot within a tolerance (weekly 3,
  2-weekly 6, 4-weekly 10, monthly 12, quarterly 20, half-year 25, yearly 30 days); a matched
  payment shows on its own date (also when the slot itself lies just outside the period, e.g. a
  rent paid on 2 November for 1 November). A second payment for the same slot is not shown. A
  payment that fits no slot is shown as `paid` unless another payment of the item lies within 3
  days. Unpaid slots: `missed` when more than 5 days before "data today", else `expected`.
  Future periods: up to 12 periods ahead (further → 400), all `expected`. Missed income is
  listed in `days` but not in the `in` totals (SPEC has no `in.missed_cents`).
- 2026-11-14 · **Yearly cost.** `per_year_cents` = |amount| × payments per year (weekly 52,
  2-weekly 26, 4-weekly 13, monthly 12, quarterly 4, half-year 2, yearly 1).
  `subscriptions` = live outgoing items in bakjes `abonnementen` and `telecom`.
- 2026-11-14 · **bank_fees** = this calendar year's rows with method `fee` on checking
  accounts (≥ € 10), id `bank_fees:<year>`, links to `/transacties?method=fee&from=<year>-01-01`.
- 2026-11-14 · **fx_costs, conservative.** The importers keep only the euro amount: no original
  currency, rate or separate conversion fee (ASN card payments abroad end in a country suffix
  such as `FRFRANKRIJK`, and inside the eurozone there is no conversion at all). A cost is only
  counted when the text proves it: a `fee` row whose text mentions the exchange rate
  ("koers…", "wisselkoers…", "valuta…", "buitenlandkosten"), or a card payment whose text names
  the rate *and* a separate cost amount ("… koers 1,1650 kosten EUR 1,25" → € 1,25). Nothing in
  ASN or the demo data matches, so the insight does not appear in practice until a bank writes
  such text. Shown from € 1 a year, id `fx_costs:<year>`.
- 2026-11-14 · **Recap.** A year = the periods whose id lies in it (up to the current one), so
  year totals are exactly the sum of `months` and of `/trends`. `previous` (and every "dan
  vorige maand/vorig jaar" sentence, `movers`, `previous_cents`) only when the previous period
  or year is complete. `categories` = fixed + daily bakjes (incl. "Nog te sorteren" and the
  credit-card line) with spending > 0; `share` of total spending. `movers` need ≥ € 10 change
  and skip "Nog te sorteren". `largest` leaves out payments of recurring items.
  `days_without_spending` = days without a daily-group payment from the first data day (or the
  range start) up to "data today". `recurring.per_month_cents` = fixed recurring items that had a
  payment in the range; `new` = first payment in the range with ≥ 75 days of data before it;
  `ended` = ended items whose last payment is in the range; `changed` = price change dated in the
  range. `goals` = goals with entries before the range end; `added_cents` excludes `adjust`.
  `networth` from the calendar-month series: month end before the range start → month end of
  the range's last day (or today); null when either is unknown. Highlights: up to six of net
  result, largest bakje, biggest riser, savings rate, potje reached, biggest faller, most
  visited merchant (≥ 3 times, no persons), new/ended fixed cost, days without spending (period
  only), net-worth change; "N betalingen bij M winkels" fills up when fewer than three apply;
  an empty range has no highlights. The index lists complete periods and years with data,
  newest first; future periods/years → 400.

## Frontend: design review fixes (2026-11-14)

- 2026-11-14 · **Sheets close for real.** `router.js` never mutates sheet objects: closing creates
  new objects and a new array, so `useSheets` re-renders and the sheet animates out. A
  `closeSheet()` that triggers `history.back()` is counted (`awaitingPops`); a `navigate()` made
  meanwhile waits for that popstate instead of going back a second time (creating a tag with
  Enter used to end one entry too far back).
- 2026-11-14 · **Modal focus.** Sheets focus their first field (desktop) or the panel (phone),
  trap Tab/Shift-Tab, restore focus on close; the shell (`.main`, sidebar, tab bar) is `inert`
  while a sheet is open. A skip link "Naar de inhoud" focuses the screen's h1.
  `document.title` = "<screen> — Cents".
- 2026-11-14 · **Contrast tokens** (measured in the running app, every text node on 13 screens,
  composited backgrounds): light accent `#136E4A` (6.3:1 on white, 5.6:1 on grouped, ≥ 4.67:1 on
  tinted chips; white on accent 6.3:1), secondary `#636366` (≥ 4.70:1), tertiary only for
  decorative hints (`rgba(60,60,67,.45)`), per-colour text tokens `--<colour>-text` (light ≥ 5.1:1,
  dark ≥ 6.0:1), orange text `#A04800` (5.5:1), red text `#C4271D` (5.75:1). Dark: dark text
  `#04260F` on green fills (7.45:1), secondary .62 alpha (≥ 6.0:1), tertiary .45 hints only.
  Lowest text contrast found: 4.67:1 light, 6.03:1 dark. Focus ring: 2 px solid accent.
- 2026-11-14 · **Sidebar / settings selection** is a quiet tinted row (accent at 11 %, accent
  icon and label), not a saturated fill.
- 2026-11-14 · **Worksheet columns** come from the data: Winkel `minmax(200px, 1fr)`, Tags only
  when a loaded row has tags, Rekening only when rows come from more than one account; inspector
  400 / 340 px; below 1100 px it is an overlay that appears only with a selection (✕ / Esc).
- 2026-11-14 · **Bakje in the Mac inspector** is one row opening the searchable picker; the phone
  keeps the tile grid (11 px labels, no hyphenation, two lines). Tile order is the same for money
  in and out.
- 2026-11-14 · **Scope** is a segmented control "Alleen deze · Alle N · Onder € X"; the default is
  "Alle" for library/MCC/bank bakjes and "Alleen deze" when the payment follows a rule or an own
  choice (`category_source` rule/user).
- 2026-11-14 · **Toasts**: undo toasts for several payments stay 10 s, every toast pauses while
  hovered or focused; on the Mac they sit bottom-right (over the inspector column), on the phone
  above the bulk bar.
- 2026-11-14 · **Wording:** tile "Dagelijks" (as in Jaaroverzicht), "alles samen" next to the total
  of Waar het heen ging, Binnenkort leaves out savings transfers, day headers show "€ x uit",
  "Sneltoetsen", "Bewaar" for a new tag, Slimme aannames "Kleine bedragen · Apart tonen onder € 15",
  "Salaris komt meestal op de 24e", insight kinds "Herinner me aan importeren" / "Twee keer
  afgeschreven" (frontend names; the server labels stay for the rest), insight switches folded
  under one "Meldingen" row. "Alles wissen" moved to a "Gevaarlijk" group at the bottom of
  Back-up en export. Import rows: date + counts as title, file name (middle-truncated) below,
  "Import terugdraaien".
- 2026-11-14 · **Charts:** pace axis has five evenly spaced day labels; bars are only dimmed by a
  real selection; the income line's segment into an incomplete month is dashed; Jaaroverzicht uses
  chart tokens with more separation in dark mode.
- 2026-11-14 · **Sorteren:** "Klaar" goes to Overzicht for the current period; a toast's Herstel
  undoes that merchant and makes it the current card; persons and `via:` intermediaries get "Sla
  over" as the primary action (no suggested bakje); key hints 11 px on solid backgrounds.
- 2026-11-14 · **Mac modality:** sheets with Annuleer/primary show them as a bottom-right button
  pair on ≥ 1000 px; new tag and tag edit are popovers anchored to their button. Amount fields
  group thousands while typing ("15.900"; a last dot with ≤ 2 digits is the decimal comma).
- 2026-11-14 · **Terugblik** has a sidebar row below Jaaroverzicht and a row in Meer; the
  sidebar adds it itself until `routes.js` lists it.

## Frontend: Vaste lasten list + kalender, Terugblik (2026-11-14)

- 2026-11-14 · **Vaste lasten in four sections** (list and table): Vaste lasten (`fixed` bakjes;
  its subtotal equals `monthly_out_cents`, the hero), Ook elke maand (recurring items in daily
  bakjes, e.g. a gym), Sparen en beleggen (`saving` bakjes), Inkomen. Subtotals count live items
  only (ended ones are listed dimmed). The old Uitgaven/Inkomsten switch is gone: income is the
  fourth section; the hero is always the fixed costs.
- 2026-11-14 · **Table (Mac):** Naam, Bakje (flexible), Hoe vaak (only when not monthly), Volgende,
  Per maand, Per jaar; Naam/Volgende/Per maand/Per jaar sort on click (default per maand, high to
  low; live before ended). Subscriptions line under the hero from `subscriptions`.
- 2026-11-14 · **Inspector only on selection.** No empty panel: the table uses the full width; from
  1400 px a selection opens a 380 px inspector column (Esc or ✕ closes; "Hoe vaak" then moves into
  the name cell as a chip); between 1000 and 1399 px (too narrow for table + inspector) the details
  open as a sheet.
- 2026-11-14 · **Lijst · Kalender** is a segmented control in the toolbar (phone: under the hero)
  and lives in the URL (`?view=kalender&period=`). Kalender = month grid ma–zo over the period's
  real date range (days outside dimmed), month switcher from the first period to 12 ahead, today
  marked. Per day at most three items, then "+N" (popover with all). Items: paid = ✓ and muted,
  expected = normal, missed = orange dot + "niet gezien", income green with +. Header line
  "Al afgeschreven · Komt nog" (+ "Niet gezien" when > 0). Arrow keys move between days with
  items (↑/↓ by a week), Enter opens the first item. A click opens the same item details, with a
  status row on top; a paid one links to its payment. Phone: an agenda (days with items, inset
  list). No days at all: one quiet line.
- 2026-11-14 · **Terugblik.** Index: years first, then complete periods grouped per year; each card
  fetches its recap when it scrolls into view and shows the first highlight. Detail: headline
  (over/tekort; tekort orange), highlights (the one that repeats the headline is left out on the
  detail page), five totals with "€ x meer/minder dan <vorige>" (the result tile shows the previous
  result instead of a difference), year chart (running month drawn partial), bakjes (capsule +
  table with previous and share; on a period a row opens the bakje), movers, top winkels, grootste
  uitgaven, vaste lasten, sparen en potjes, vermogen, previous/next. `complete: false` → chip "Nog
  bezig" (current) or "Niet compleet" (a past year that starts mid-year, e.g. data from June) and
  no comparisons. Print: "Druk af" (Mac toolbar) → A4 portrait, light tokens even in dark mode,
  no chrome or buttons, cards and rows never split, footer "Cents · Terugblik <label>".
- 2026-11-14 · **Mock** follows the backend for `/recurring` `monthly_out_cents` (fixed bakjes
  only, was fixed + daily) and the deficit highlight wording ("€ x meer uitgegeven dan er
  binnenkwam"); it implements `/calendar`, `/recap`, `/recap/index`, `per_year_cents` and
  `subscriptions` (subscriptions = live outgoing items in `abonnementen`/`telecom`).
- 2026-11-16 · **Vrij geld replaces "Nog te besteden".** The old headline added this month's salary
  before it arrived (~27th) and looked at one account. The hero now shows Vrij geld = checking +
  savings − potjes (≤ savings balance) − buffer (assumption; a potje named "buffer" counts towards
  it) − recurring fixed costs after the balance date and before payday − outstanding credit-card
  purchases; moving money between own accounts never changes it. A tap opens the breakdown as a
  popover (Mac and iPhone). Tempo (3-month mean of income − fixed − daily, 12-month mini bars) sits
  under it, the pace chart stays. The checking warning card shows only when the day-by-day
  projection drops below the floor (desktop: above the tiles; iPhone: under the hero).
  `left_cents`/`per_day_left_cents` stay in the API for compatibility but are not shown.
  New assumptions `payday_day`, `buffer`, `checking_floor_cents` (Slimme aannames → Vrij geld).
