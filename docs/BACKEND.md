# Backend map

Python 3.12, FastAPI, stdlib `sqlite3`. Package `backend/cents/`. SPEC.md is the contract;
deviations are in `docs/DECISIONS.md`.

```
uv run --python 3.12 --with-requirements requirements.txt --with-requirements requirements-dev.txt pytest -q
CENTS_DATA_DIR=$(mktemp -d) uv run --python 3.12 --with-requirements requirements.txt \
  uvicorn cents.main:app --app-dir backend --port 8765
```
Set `PYTHONDONTWRITEBYTECODE=1` (the folder is cloud-synced).

## Modules

| Module | Responsibility |
|---|---|
| `main.py` | `create_app(data_dir, frontend_dir)`: lifespan (init DB), error handlers, routers, static frontend at `/` (placeholder page when `frontend/index.html` is missing). |
| `guard.py` | Pure ASGI middleware, runs before any body is read: CSRF header, session + size check for `/api/import` and `/api/restore`, security headers/CSP, JSON 500 for unhandled errors. |
| `config.py` | Paths and constants (`CENTS_DATA_DIR`, upload limits, session length). |
| `db.py` | Full schema (SPEC §4), forward-only `MIGRATIONS` list + `PRAGMA user_version`, WAL, foreign keys, category seeding, query helpers. |
| `errors.py` | `ApiError(status, code, dutch_message)` → `{"error": {code, message}}`. |
| `auth.py` | scrypt password (N=2^15, parameters stored in the hash, re-hash on login; setting `_password_hash`), atomic first-run setup, hashed session tokens, rolling 180-day expiry, `LoginLimiter`. |
| `hooks.py` | Extension points for analytics (see below). |
| `schemas.py` | Pydantic request bodies; `iso_date()` validation. |
| `importers/asn_csv.py`, `camt053.py` | Stream bytes or a file object → `(Statement, tx dict)` pairs (`iter_rows` / `iter_entries`); `parse()` collects them into `list[Statement]`. |
| `importers/detect.py` | Pick a parser from content: `iter_file()` (lazy), `parse_file()` (complete). |
| `importers/normalize.py` | method, merchant name/key, city, MCC, wallet, mandate, creditor, clean description. Pure. |
| `classify/library.py` | Loads `data/*.json` (missing/broken file = empty). `get_library()` / `set_library()`. `norm_text()`. |
| `classify/engine.py` | `classify(tx, ctx)` (one tx, pure; returns category, source, kind, transfer account and a `reason`) and `classify_all(conn, lib, ids)` (persist, in chunks). Order: user > rule (incl. `below_cents` split) > transfer > interest > strong merchant > MCC > keyword > weak merchant > bank > heuristic. |
| `classify/reasons.py` | `reason_label()`: Dutch text for `category_reason` (`merchant:shell:small` → "Shell · klein bedrag"). |
| `services/assumptions.py` | Adjustable engine assumptions (setting `assumptions`, defaults, validation). |
| `services/imports.py` | Dedupe key, account auto-creation and `refresh_accounts()` (order-independent checking/savings typing and auto names), enrichment, atomic per-file `import_file()`, `import_files()`, `delete_import()`, `renormalize_all()`. |
| `services/transfers.py` | Own-account transfer detection, kind/category for a transfer. |
| `services/learning.py` | Rules (merchant → bakje/tag, optional amount threshold), `set_merchant_below`, `update_rule`, sort queue + suggestions. `via:` keys (Tikkie) never get rules. |
| `services/suggestions.py` | Likely savings / investment accounts for bootstrap. |
| `services/periods.py` | **The only place that computes period boundaries.** |
| `services/txquery.py` | API `Tx` shape, list filters, period query helpers. |
| `services/cache.py` | `memo(conn, name, fn)`: derived data cached per database state (token `_state`, bumped by the `after_write` hook). `bump(conn)` after writes outside a request. |
| `services/ledger.py` | The cash-flow ledger, built once per state: every counting transaction in its group (income/fixed/daily/saving, credit-card unexplained part, savings interest) and per-period `Flows` (totals, per bakje, daily spending per day). `complete_before(p, n)`, `first_complete()`. |
| `services/recurring.py` | Recurring detection (`detect()` is pure), `items(conn)` cached, `recurring_json`, `occurrences()`, the `provide_recurring_lookup` hook. |
| `services/summary.py` | `overview`, `trends`, `category_summary`, `tag_summary`. |
| `services/outlook.py` | Current-period "now" figures for `/overview`: `free` (Vrij geld), `tempo`, `checking_warning`, next `payday`. |
| `services/insights.py` | One function per rule; `candidates()` (all, ranked) and `compute()` (top five). |
| `services/goals.py` | Goal matching (code > name/keyword > learned), `after_import` matching, `after_write` reconcile of `transactions.goal_id`, roll-over, `overview()` (GET /goals). |
| `services/networth.py` | Balances per account, investments, credit card, month-end series. |
| `services/calendar.py` | GET /calendar: per-item schedule of expected dates, one-to-one matching of payments, paid/expected/missed. |
| `services/recap.py` | GET /recap (period or year, as a `Range` of periods) and /recap/index; highlights. |
| `services/smart.py` | GET /assumptions ("Slimme aannames"): salary series, account type sources, ignored items, learned goal links, start-day suggestion. |
| `services/text.py` | Dutch sentence formatting: `euro()` ("€ 85", NBSP, whole euros), months, percent. |
| `api/*.py` | One router per resource. `api/deps.py`: `get_conn`, `require_session`. |

## Conventions

- Money: integer cents, negative = out. Dates: ISO strings. Rows are plain dicts.
- One DB connection per request (`Depends(get_conn)`); it is committed at the end of the request,
  rolled back on any exception. Never commit inside a route (except restore).
- Only parameterised SQL. `db.insert/update` take table/column names from code only.
- User-facing errors: `raise ApiError(status, "code", "Korte Nederlandse zin.")`. Unhandled
  exceptions become `500 {"error": {"code": "internal"}}` (guard.py); `OverflowError` → 400.
- Money in request bodies: use `schemas.Money` / `PositiveMoney` (±10^12 cents).
- Restore (`api/data.py`) keeps the live password hash and sessions, writes
  `cents.db.pre-restore`, and validates the file against a freshly migrated schema.
- Mutating requests need header `X-Cents: 1` (middleware), all routers except
  `session.public_router` and `health.public_router` need a session.
- `category_reason` is set by the engine on every (re)classification and to `user`/`none` by
  the routes that write categories directly; `GET /transactions/{id}` adds it plus
  `category_reason_label`. Merchant keys: brand key, plain name, `p:<name>` (person),
  `via:<service>` (Tikkie without a named person), `iban:<iban>` / `x:<hash>` (nameless),
  `bankkosten <last4>` / `rente <last4>`.
- CAMT parsing yields rows as it reads; per-statement balance corrections arrive in
  `Statement.balance_fix` at the end of the statement and are applied by the import.
- Categories are referenced by `key` in code (`db.category_ids(conn)["sparen"]`), never by id.
- `category_source`: `user` is never overwritten; `classify_all` recomputes everything else.
  After changing accounts, rules or the library, call `engine.classify_all(conn)`.
- Tests: `tests/helpers.py` builds synthetic ASN CSV / CAMT files and a tiny inline library;
  `conftest.py` gives `conn`, `anon` and `client` (logged in, sends `X-Cents: 1`).

## Adding a router (analytics)

1. Create `backend/cents/api/overview.py` with `router = APIRouter()` and routes without the
   `/api` prefix (e.g. `@router.get("/overview")`), using `conn = Depends(get_conn)`.
2. Import it in `api/__init__.py` and append `overview.router` to `PROTECTED_ROUTERS`.

Analytics routers: `api/overview.py` (`/overview`, `/trends`, `/categories/{id}/summary`,
`/tags/{id}/summary`), `api/recurring.py`, `api/goals.py` (`/goals*`, `/goal-entries/{id}`),
`api/networth.py`, `api/smart.py` (`/assumptions`, `DELETE /recurring/ignore`,
`DELETE /goals/links`, `/insights/dismiss`, `/insights/mute`; registered before `goals`).
`api/calendar.py` (`/calendar`), `api/recap.py` (`/recap`, `/recap/index`).
`api/settings.py` adds `muted_insight_kinds` and `insight_kinds` to the settings JSON. Sign conventions and every interpretation of SPEC 9 are in DECISIONS.md
("Analytics").

## Analytics data flow

```
transactions ──► ledger.get(conn)  (cached per database state)
                   ├─ recurring.items(conn)          (cached)
                   ├─ summary.overview(conn, period) (cached per period) ─► insights.compute
                   ├─ summary.trends / category_summary / tag_summary
                   ├─ goals.overview(conn)           (cached; roll-over written first)
                   └─ networth.get(conn)             (cached)
```
- Any mutating request → `after_write` → `cache.bump` (new `_state`) + `goals.reconcile`.
- Import → `after_import` → `goals.match_imported` (new transfers only).
- Cached results are shared: never mutate what `items()`, `get()` or `overview()` return.
- Tests: `tests/book.py` writes accounts/transactions straight into the test database and
  freezes "today" (`today` fixture); `test_demo_household.py` runs `tools/make_demo_data.py`.
- Recurring pipeline per merchant/direction: amount clusters → split by day of month → chain
  sequential clusters (price changes) → `analyse_series` → daily-bakje filter. `by_transaction()`
  maps transaction ids to their item (used by the `large` and `category_spike` insights).
- The ledger moves early income (≤ 3 days before a period it usually opens) into that period
  (`Ledger.early_income`); `Ledger.last_imported` / `last_import_at` drive "data today" and stale.
- `recurring.full_items(conn)` gives the items with their payments (`_ids`) for the calendar
  and recap; never return those private fields from an API route (`recurring.public()`).
- Measured with 6,232 transactions (8.7 years of the demo household): first request after a
  write ~25-41 ms (`/overview`, `/recurring`, `/goals`, `/networth`, `/trends`, `/calendar`,
  `/recap`, `/recap/index`), cached ~1.6-1.9 ms.

## Hooks (`hooks.py`)

```python
from ..hooks import on_after_write, on_after_import, provide_recurring_lookup

@on_after_import
def match_goals(conn, import_ids): ...          # after an import, before commit

@on_after_write
def invalidate_cache(conn): ...                  # end of EVERY mutating request, before commit

@provide_recurring_lookup
def recurring_item(conn, merchant_key): ...      # -> RecurringItem | None, used by
                                                 #    GET /transactions/{id} merchant.recurring
```
Make sure the module that registers is imported (import it from its router module).
`PATCH /transactions/{id} {goal_id}` only stores `transactions.goal_id`; the `after_write` hook
`goals.reconcile` creates, moves or removes the matching `goal_entries` row.

## Querying transactions for a period

```python
from cents.services import periods, txquery

sd = periods.start_day_of(conn)
p = periods.resolve(conn, "2026-11")           # Period(id, start, end[exclusive])
p_json = periods.period_json(p, sd, first=..., last=...)   # API Period object
rows = txquery.cashflow_rows(conn, p.start, p.end)
# each row: all transaction columns + category_key, grp, account_type
income = sum(r["amount_cents"] for r in rows if r["grp"] == "income" or
             (r["category_key"] == "unsorted" and r["amount_cents"] > 0))
```
- `cashflow_rows` = checking accounts + manual credit-card purchases (SPEC §7). `period_rows`
  takes any extra SQL condition on aliases `t`, `a`, `c`.
- `periods.shift(p, -1, sd)`, `periods.complete_periods_before(p, 6, sd)`,
  `periods.data_today(conn)`, `periods.today()` (Europe/Amsterdam).
- `kind`: `normal`, `transfer` (own accounts), `settlement` (credit-card bill). Group `internal`
  (bakjes `intern`, `creditcard`) never counts; `saving` (sparen/beleggen) counts as saved.
- Account balances: `balance_after_cents` of the latest transaction per account (ASN files are
  consistent: CSV `Saldo voor boeking + Bedrag`, CAMT `OPBD` + running sum).
