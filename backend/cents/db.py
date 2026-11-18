"""SQLite access: schema, forward-only migrations and a few small query helpers.

Conventions
- One connection per request (see `api/deps.py`), committed at the end of the request.
- Rows come back as plain dicts.
- Only parameterised SQL. Table and column names passed to `insert`/`update` come from code,
  never from the request.
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from .config import LIBRARY_DIR

SCHEMA_V1 = """
CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE accounts (
    id INTEGER PRIMARY KEY,
    iban TEXT UNIQUE,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'checking',      -- checking|savings|credit|investment
    match TEXT NOT NULL DEFAULT '[]',           -- JSON list of lowercase keywords
    manual_balance_cents INTEGER,
    manual_balance_date TEXT,
    hidden INTEGER NOT NULL DEFAULT 0,
    sort INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE TABLE imports (
    id INTEGER PRIMARY KEY,
    filename TEXT,
    format TEXT,
    imported_at TEXT NOT NULL,
    account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
    n_new INTEGER NOT NULL DEFAULT 0,
    n_duplicate INTEGER NOT NULL DEFAULT 0,
    n_enriched INTEGER NOT NULL DEFAULT 0,
    date_from TEXT,
    date_to TEXT
);

CREATE TABLE categories (
    id INTEGER PRIMARY KEY,
    key TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    emoji TEXT,
    color TEXT,
    grp TEXT NOT NULL,                          -- income|fixed|daily|saving|internal
    sort INTEGER NOT NULL DEFAULT 0,
    hidden INTEGER NOT NULL DEFAULT 0,
    builtin INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE tags (
    id INTEGER PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    emoji TEXT,
    color TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE TABLE goals (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    emoji TEXT,
    color TEXT,
    target_cents INTEGER,
    target_date TEXT,
    repeat TEXT NOT NULL DEFAULT 'none',        -- none|yearly
    code TEXT UNIQUE,
    keywords TEXT NOT NULL DEFAULT '[]',        -- JSON list
    archived INTEGER NOT NULL DEFAULT 0,
    sort INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE TABLE transactions (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    import_id INTEGER REFERENCES imports(id) ON DELETE SET NULL,
    dedupe_key TEXT UNIQUE NOT NULL,
    date TEXT NOT NULL,
    value_date TEXT,
    amount_cents INTEGER NOT NULL,
    balance_after_cents INTEGER,
    seq INTEGER,
    counterparty_name TEXT,
    counterparty_iban TEXT,
    description TEXT,
    raw_description TEXT,
    method TEXT,                                -- card|ideal|debit|transfer|atm|internal|fee|interest|other
    pay_type TEXT,
    bank_code TEXT,
    iso_family TEXT,
    iso_subfamily TEXT,
    mcc TEXT,
    wallet TEXT,
    city TEXT,
    end_to_end_id TEXT,
    mandate_id TEXT,
    creditor_id TEXT,
    bank_category TEXT,
    merchant_key TEXT,
    merchant_name TEXT,
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    category_source TEXT NOT NULL DEFAULT 'none',  -- user|rule|merchant|mcc|keyword|bank|heuristic|none
    kind TEXT NOT NULL DEFAULT 'normal',        -- normal|transfer|settlement
    transfer_account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
    goal_id INTEGER REFERENCES goals(id) ON DELETE SET NULL,
    note TEXT,
    manual INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX ix_tx_date ON transactions(date);
CREATE INDEX ix_tx_account_date ON transactions(account_id, date);
CREATE INDEX ix_tx_merchant ON transactions(merchant_key);
CREATE INDEX ix_tx_category_date ON transactions(category_id, date);
CREATE INDEX ix_tx_import ON transactions(import_id);

CREATE TABLE transaction_tags (
    transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (transaction_id, tag_id)
);
CREATE INDEX ix_tt_tag ON transaction_tags(tag_id);

CREATE TABLE rules (
    id INTEGER PRIMARY KEY,
    merchant_key TEXT UNIQUE NOT NULL,
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    tag_id INTEGER REFERENCES tags(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE goal_entries (
    id INTEGER PRIMARY KEY,
    goal_id INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    transaction_id INTEGER REFERENCES transactions(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'manual',        -- auto|manual|adjust
    note TEXT
);
CREATE INDEX ix_goal_entries_goal ON goal_entries(goal_id);
CREATE INDEX ix_goal_entries_tx ON goal_entries(transaction_id);

CREATE TABLE account_values (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    value_cents INTEGER NOT NULL
);
CREATE INDEX ix_account_values ON account_values(account_id, date);

CREATE TABLE recurring_ignored (
    key TEXT PRIMARY KEY
);

CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);
"""

# v2: remember whether an account's type and name were chosen automatically or by the user,
# so automatic re-typing ("checking" vs "savings") and renaming never override the user.
SCHEMA_V2 = """
ALTER TABLE accounts ADD COLUMN type_source TEXT NOT NULL DEFAULT 'auto';   -- auto|user
ALTER TABLE accounts ADD COLUMN name_source TEXT NOT NULL DEFAULT 'auto';   -- auto|user
"""

# v3: amount thresholds on rules ("below € X goes to another bakje") and an explanation of
# every automatic decision per transaction.
SCHEMA_V3 = """
ALTER TABLE rules ADD COLUMN below_cents INTEGER;
ALTER TABLE rules ADD COLUMN below_category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL;
ALTER TABLE transactions ADD COLUMN category_reason TEXT;
"""

# v4: holdings of investment accounts (DEGIRO import, manual trades) and daily prices.
# Quantities and per-unit prices are REAL (fractional units, 4+ decimals); money is cents.
SCHEMA_V4 = """
CREATE TABLE securities (
    isin TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    symbol TEXT,                                -- ticker from a portfolio export, if known
    currency TEXT,                              -- trading currency (EUR, USD, ...)
    exchange TEXT,                              -- DEGIRO exchange code (EAM, XET, ...)
    price_symbol TEXT,                          -- symbol at the price provider (auto or user)
    price_symbol_source TEXT                    -- auto|user|none
);

CREATE TABLE trades (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    import_id INTEGER REFERENCES imports(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    time TEXT,
    isin TEXT NOT NULL REFERENCES securities(isin),
    quantity REAL NOT NULL,                     -- + buy, - sell
    price REAL NOT NULL,                        -- per unit, in `currency`
    currency TEXT NOT NULL DEFAULT 'EUR',
    fx_rate REAL,                               -- units of `currency` per EUR (DEGIRO style)
    value_eur_cents INTEGER NOT NULL,           -- - for a buy, + for a sell (excl. fees)
    fees_cents INTEGER NOT NULL DEFAULT 0,      -- >= 0
    order_id TEXT,
    dedupe_key TEXT UNIQUE,
    manual INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE INDEX ix_trades_account ON trades(account_id, date);

CREATE TABLE cash_events (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    import_id INTEGER REFERENCES imports(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    isin TEXT,
    kind TEXT NOT NULL,                         -- dividend|dividend_tax|fee|deposit|withdrawal
    amount_cents INTEGER NOT NULL,              -- EUR, signed (+ received, - paid)
    currency TEXT NOT NULL DEFAULT 'EUR',
    amount_local REAL,
    description TEXT,
    dedupe_key TEXT UNIQUE
);
CREATE INDEX ix_cash_events_account ON cash_events(account_id, date);

CREATE TABLE prices (
    isin TEXT NOT NULL,
    date TEXT NOT NULL,
    source TEXT NOT NULL,                       -- yahoo|degiro_portfolio|trade
    close REAL NOT NULL,                        -- in `currency`
    currency TEXT NOT NULL,
    close_eur REAL NOT NULL,                    -- converted at that day's rate
    import_id INTEGER REFERENCES imports(id) ON DELETE CASCADE,
    PRIMARY KEY (isin, date, source)
);
"""

# v5: mortgage (hypotheek): loan parts, their yearly statements (jaaropgave) and home values.
SCHEMA_V5 = """
CREATE TABLE mortgage_parts (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    sort INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE TABLE mortgage_years (
    part_id INTEGER NOT NULL REFERENCES mortgage_parts(id) ON DELETE CASCADE,
    year INTEGER NOT NULL,
    debt_end_cents INTEGER NOT NULL,            -- schuld op 31 december
    interest_cents INTEGER NOT NULL DEFAULT 0,  -- rente betaald dat jaar
    repaid_cents INTEGER NOT NULL DEFAULT 0,    -- afgelost dat jaar
    PRIMARY KEY (part_id, year)
);

CREATE TABLE home_values (
    id INTEGER PRIMARY KEY,
    date TEXT NOT NULL,
    value_cents INTEGER NOT NULL
);
"""

# v6: other assets and liabilities (SPEC 7.3): pension, debt (studieschuld, lening) and other
# possessions, each with dated value entries.
SCHEMA_V6 = """
CREATE TABLE assets (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,                         -- pension|debt|other
    name TEXT NOT NULL,
    debt_kind TEXT,                             -- debt: studieschuld|lening|overig
    include INTEGER NOT NULL,                   -- counted in net worth
    merchant_key TEXT,                          -- debt: linked payment (split like the mortgage)
    sort INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE TABLE asset_entries (
    id INTEGER PRIMARY KEY,
    asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    value_cents INTEGER NOT NULL,               -- pension: opgebouwd; debt: restschuld; other: waarde
    interest_cents INTEGER,                     -- debt: rente over het jaar tot `date` (optional)
    repaid_cents INTEGER,                       -- debt: afgelost in dat jaar (optional)
    note TEXT
);
CREATE INDEX ix_asset_entries ON asset_entries(asset_id, date);
"""

# v7: a loan part that started during the year: restant op 1 januari is 0 and the amount at
# the start (hoofdsom) is kept, so the form shows what the statement says.
SCHEMA_V7 = """
ALTER TABLE mortgage_years ADD COLUMN principal_cents INTEGER;   -- hoofdsom, only for a new loan
"""

# v8: a savings account can be fixed (vast: deposit/term account, not freely withdrawable). It
# counts in net worth but not in vrij vermogen, Nog te besteden or the buffer.
SCHEMA_V8 = """
ALTER TABLE accounts ADD COLUMN locked INTEGER NOT NULL DEFAULT 0;
"""

# Forward-only. Append new migrations; never edit an old one.
MIGRATIONS: list[str] = [SCHEMA_V1, SCHEMA_V2, SCHEMA_V3, SCHEMA_V4, SCHEMA_V5, SCHEMA_V6, SCHEMA_V7, SCHEMA_V8]
SCHEMA_VERSION = len(MIGRATIONS)

DEFAULT_SETTINGS: dict[str, Any] = {"month_start_day": 1, "household_name": ""}


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def connect(path: str | Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(path), check_same_thread=False, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 15000")
    return conn


def init_db(path: str | Path) -> None:
    """Create or migrate the database and seed builtin categories."""
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    conn = connect(path)
    try:
        conn.execute("PRAGMA journal_mode = WAL")
        migrate(conn)
        seed_categories(conn)
        conn.commit()
    finally:
        conn.close()


def migrate(conn: sqlite3.Connection) -> None:
    version = conn.execute("PRAGMA user_version").fetchone()[0]
    if version > SCHEMA_VERSION:
        raise RuntimeError(f"database schema {version} is newer than this app ({SCHEMA_VERSION})")
    for number in range(version, SCHEMA_VERSION):
        conn.executescript("BEGIN;" + MIGRATIONS[number] + f";PRAGMA user_version = {number + 1};COMMIT;")


def seed_categories(conn: sqlite3.Connection) -> None:
    """Insert builtin categories that are missing (first start, or new ones in an update)."""
    builtin = json.loads((LIBRARY_DIR / "categories.json").read_text(encoding="utf-8"))
    existing = {r["key"] for r in rows(conn, "SELECT key FROM categories")}
    for index, cat in enumerate(builtin):
        if cat["key"] in existing:
            continue
        insert(conn, "categories", {
            "key": cat["key"], "name": cat["name"], "emoji": cat["emoji"], "color": cat["color"],
            "grp": cat["grp"], "sort": (index + 1) * 10, "hidden": 0, "builtin": 1,
        })


# ---------------------------------------------------------------- query helpers

def rows(conn: sqlite3.Connection, sql: str, params: Iterable[Any] = ()) -> list[dict]:
    return [dict(r) for r in conn.execute(sql, tuple(params)).fetchall()]


def row(conn: sqlite3.Connection, sql: str, params: Iterable[Any] = ()) -> dict | None:
    r = conn.execute(sql, tuple(params)).fetchone()
    return dict(r) if r is not None else None


def value(conn: sqlite3.Connection, sql: str, params: Iterable[Any] = ()) -> Any:
    r = conn.execute(sql, tuple(params)).fetchone()
    return r[0] if r is not None else None


def insert(conn: sqlite3.Connection, table: str, data: dict[str, Any]) -> int:
    cols = ", ".join(data)
    marks = ", ".join("?" for _ in data)
    cur = conn.execute(f"INSERT INTO {table} ({cols}) VALUES ({marks})", tuple(data.values()))
    return int(cur.lastrowid)


def update(conn: sqlite3.Connection, table: str, id_: int, data: dict[str, Any]) -> int:
    if not data:
        return 0
    sets = ", ".join(f"{c} = ?" for c in data)
    cur = conn.execute(f"UPDATE {table} SET {sets} WHERE id = ?", (*data.values(), id_))
    return cur.rowcount


def placeholders(items: Iterable[Any]) -> str:
    return ", ".join("?" for _ in items)


# ---------------------------------------------------------------- settings

def get_setting(conn: sqlite3.Connection, key: str, default: Any = None) -> Any:
    raw = value(conn, "SELECT value FROM settings WHERE key = ?", (key,))
    if raw is None:
        return DEFAULT_SETTINGS.get(key, default)
    return json.loads(raw)


def set_setting(conn: sqlite3.Connection, key: str, val: Any) -> None:
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, json.dumps(val, ensure_ascii=False)),
    )


def public_settings(conn: sqlite3.Connection) -> dict[str, Any]:
    """Settings visible to the UI. Keys starting with '_' (password hash etc.) stay private."""
    from .services import assumptions          # local import: assumptions uses db
    out = dict(DEFAULT_SETTINGS)
    out["dismissed_suggestions"] = []
    for r in rows(conn, "SELECT key, value FROM settings WHERE key NOT LIKE '\\_%' ESCAPE '\\'"):
        out[r["key"]] = json.loads(r["value"])
    out["assumptions"] = assumptions.get(conn)
    return out


# ---------------------------------------------------------------- categories

def category_ids(conn: sqlite3.Connection) -> dict[str, int]:
    """category key -> id"""
    return {r["key"]: r["id"] for r in rows(conn, "SELECT id, key FROM categories")}


def category_groups(conn: sqlite3.Connection) -> dict[int, str]:
    """category id -> grp (income|fixed|daily|saving|internal)"""
    return {r["id"]: r["grp"] for r in rows(conn, "SELECT id, grp FROM categories")}


def unsorted_id(conn: sqlite3.Connection) -> int:
    return int(value(conn, "SELECT id FROM categories WHERE key = 'unsorted'"))
