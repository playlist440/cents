"""Reading transactions: the API `Tx` shape, list filters, and period helpers for analytics.

Analytics code should use `period_rows` / `cashflow_rows` instead of writing its own joins:
they return transaction dicts with `category_key`, `grp` (income|fixed|daily|saving|internal)
and `account_type` added.
"""

from __future__ import annotations

import re
import sqlite3
from datetime import date
from typing import Any, Iterable

from .. import db

TX_FIELDS = ["id", "account_id", "date", "amount_cents", "merchant_name", "merchant_key",
             "counterparty_iban", "description", "method", "city", "category_id",
             "category_source", "kind", "transfer_account_id", "goal_id", "note", "manual",
             "balance_after_cents"]

# Cash flow counts checking accounts and manual credit-card purchases only (SPEC 7).
CASHFLOW_WHERE = "(a.type = 'checking' OR (a.type = 'credit' AND t.manual = 1))"

_BASE_SELECT = """
    SELECT t.*, c.key AS category_key, c.grp AS grp, a.type AS account_type
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    LEFT JOIN categories c ON c.id = t.category_id
"""


def tag_map(conn: sqlite3.Connection, ids: Iterable[int]) -> dict[int, list[int]]:
    ids = list(ids)
    out: dict[int, list[int]] = {i: [] for i in ids}
    for start in range(0, len(ids), 500):
        chunk = ids[start:start + 500]
        for r in db.rows(conn, f"SELECT transaction_id, tag_id FROM transaction_tags "
                               f"WHERE transaction_id IN ({db.placeholders(chunk)}) ORDER BY tag_id",
                         chunk):
            out[r["transaction_id"]].append(r["tag_id"])
    return out


def tx_json(row: dict, tag_ids: list[int] | None = None) -> dict:
    out = {f: row.get(f) for f in TX_FIELDS}
    out["manual"] = bool(row.get("manual"))
    out["tag_ids"] = tag_ids or []
    return out


def tx_list_json(conn: sqlite3.Connection, rows: list[dict]) -> list[dict]:
    tags = tag_map(conn, [r["id"] for r in rows])
    return [tx_json(r, tags.get(r["id"])) for r in rows]


def get_tx(conn: sqlite3.Connection, tx_id: int) -> dict | None:
    return db.row(conn, "SELECT * FROM transactions WHERE id = ?", (tx_id,))


def _to_iso(d: date | str) -> str:
    return d.isoformat() if isinstance(d, date) else d


def period_rows(conn: sqlite3.Connection, start: date | str, end: date | str,
                where: str = "", params: Iterable[Any] = ()) -> list[dict]:
    """All transactions with start <= date < end (end exclusive), oldest first.
    `where` is an extra SQL condition on aliases t (transactions), a (accounts), c (categories)."""
    sql = _BASE_SELECT + " WHERE t.date >= ? AND t.date < ?"
    if where:
        sql += f" AND ({where})"
    return db.rows(conn, sql + " ORDER BY t.date, t.id", (_to_iso(start), _to_iso(end), *params))


def cashflow_rows(conn: sqlite3.Connection, start: date | str, end: date | str) -> list[dict]:
    """Transactions that count for income/spending/saving in [start, end)."""
    return period_rows(conn, start, end, CASHFLOW_WHERE)


# ---------------------------------------------------------------- list filters

def parse_amount_query(q: str) -> int | None:
    """'12,50' / '€ 12,50' / '12.50' / '1.250,00' / '12' -> cents; None when q is no amount."""
    s = re.sub(r"[€\s]", "", q).lstrip("-+")
    if re.fullmatch(r"\d+", s):
        return int(s) * 100
    m = re.fullmatch(r"(\d+)[,.](\d{1,2})", s)
    if m:
        return int(m.group(1)) * 100 + int(m.group(2).ljust(2, "0"))
    m = re.fullmatch(r"(\d{1,3}(?:\.\d{3})+)(?:,(\d{1,2}))?", s)
    if m:
        return int(m.group(1).replace(".", "")) * 100 + int((m.group(2) or "0").ljust(2, "0"))
    return None


def like_escape(text: str) -> str:
    return text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def build_filter(f: dict) -> tuple[str, list[Any]]:
    """WHERE clause for GET /transactions filters (keys as in the query string)."""
    where, params = ["1 = 1"], []
    if f.get("from"):
        where.append("t.date >= ?")
        params.append(f["from"])
    if f.get("to"):
        where.append("t.date <= ?")
        params.append(f["to"])
    for key in ("account_id", "category_id", "merchant_key", "method", "kind"):
        if f.get(key) not in (None, ""):
            where.append(f"t.{key} = ?")
            params.append(f[key])
    if f.get("tag_id") not in (None, ""):
        where.append("EXISTS (SELECT 1 FROM transaction_tags tt WHERE tt.transaction_id = t.id "
                     "AND tt.tag_id = ?)")
        params.append(f["tag_id"])
    if f.get("unsorted"):
        where.append("c.key = 'unsorted'")
    if f.get("min_cents") is not None:
        where.append("ABS(t.amount_cents) >= ?")
        params.append(abs(int(f["min_cents"])))
    if f.get("max_cents") is not None:
        where.append("ABS(t.amount_cents) <= ?")
        params.append(abs(int(f["max_cents"])))
    q = (f.get("q") or "").strip()
    if q:
        pattern = f"%{like_escape(q)}%"
        text = ["t.merchant_name LIKE ? ESCAPE '\\'", "t.description LIKE ? ESCAPE '\\'",
                "t.note LIKE ? ESCAPE '\\'", "t.counterparty_name LIKE ? ESCAPE '\\'",
                "t.city LIKE ? ESCAPE '\\'",
                "EXISTS (SELECT 1 FROM transaction_tags tt JOIN tags g ON g.id = tt.tag_id "
                "WHERE tt.transaction_id = t.id AND g.name LIKE ? ESCAPE '\\')"]
        qparams: list[Any] = [pattern] * len(text)
        cents = parse_amount_query(q)
        if cents is not None:
            text.append("ABS(t.amount_cents) = ?")
            qparams.append(cents)
        where.append("(" + " OR ".join(text) + ")")
        params.extend(qparams)
    return " AND ".join(where), params


def list_transactions(conn: sqlite3.Connection, f: dict, limit: int = 100,
                      cursor: str | None = None) -> dict:
    """Newest first, keyset paging. Count and sums cover the whole filtered set."""
    where, params = build_filter(f)
    base = ("FROM transactions t JOIN accounts a ON a.id = t.account_id "
            "LEFT JOIN categories c ON c.id = t.category_id WHERE " + where)
    totals = db.row(conn, "SELECT COUNT(*) AS n, "
                          "COALESCE(SUM(CASE WHEN t.amount_cents > 0 THEN t.amount_cents END), 0) AS sin, "
                          "COALESCE(SUM(CASE WHEN t.amount_cents < 0 THEN t.amount_cents END), 0) AS sout "
                          + base, params)
    page_where, page_params = "", list(params)
    if cursor:
        try:
            c_date, c_id = cursor.split("~", 1)
            date.fromisoformat(c_date)
            page_where = " AND (t.date < ? OR (t.date = ? AND t.id < ?))"
            page_params += [c_date, c_date, int(c_id)]
        except ValueError:
            pass
    rows = db.rows(conn, "SELECT t.* " + base + page_where +
                   " ORDER BY t.date DESC, t.id DESC LIMIT ?", page_params + [limit + 1])
    next_cursor = None
    if len(rows) > limit:
        rows = rows[:limit]
        next_cursor = f"{rows[-1]['date']}~{rows[-1]['id']}"
    return {"items": tx_list_json(conn, rows), "next_cursor": next_cursor,
            "count": totals["n"], "sum_in_cents": totals["sin"], "sum_out_cents": totals["sout"]}
