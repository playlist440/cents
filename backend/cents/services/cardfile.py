"""Creditcard-invulbestand (SPEC 5 "Creditcard by hand"): the purchases the family types into
the template (importers/card_xlsx.py) become manual transactions on the credit-card account.

- The account: the only credit account, else a new "Creditcard". Its `match` keywords come from
  the payments already sorted as Creditcard (the monthly settlement), so that settlement is
  linked to the card and only its unexplained part counts (services/ledger.py): purchases are
  never counted twice.
- The file is leading for the period it covers: rows already imported from an earlier version
  of the file that are no longer in it (between its first and last date) are removed, rows that
  are the same are kept as they are (with any bakje chosen in Cents), new rows are added.
- A bakje typed in the file (name, case-insensitive) is used as the user's choice; an empty one
  is filled in by the classifier like any other payment.
"""

from __future__ import annotations

import json
import sqlite3

from .. import db
from ..classify.library import norm_text
from ..importers import ImportFormatError, Source
from ..importers import card_xlsx
from ..importers.etoro import read_workbook
from . import periods

KEY_PREFIX = "card:"


def template(conn: sqlite3.Connection) -> bytes:
    names = [r["name"] for r in db.rows(conn, """SELECT name FROM categories
        WHERE grp IN ('fixed', 'daily') AND key NOT IN ('unsorted', 'creditcard') AND hidden = 0
        ORDER BY sort, id""")]
    return card_xlsx.template(names)


def is_card_file(source: Source) -> bool:
    return card_xlsx.looks_like(read_workbook(source))


def _issuer_keywords(conn: sqlite3.Connection) -> list[str]:
    """Words that identify the card's settlement on the checking account."""
    names = db.rows(conn, """SELECT COALESCE(NULLIF(t.counterparty_name, ''), t.merchant_name) AS n, COUNT(*) AS c
        FROM transactions t JOIN categories c ON c.id = t.category_id
        JOIN accounts a ON a.id = t.account_id
        WHERE c.key = 'creditcard' AND a.type = 'checking' AND t.amount_cents < 0
        GROUP BY n ORDER BY c DESC LIMIT 2""")
    words = [norm_text(r["n"]) for r in names if r["n"] and norm_text(r["n"])]
    return words or ["international card services"]


def card_account(conn: sqlite3.Connection) -> tuple[dict, bool]:
    cards = db.rows(conn, "SELECT * FROM accounts WHERE type = 'credit' ORDER BY sort, id")
    if cards:
        acc = cards[0]
        if not json.loads(acc["match"] or "[]"):
            db.update(conn, "accounts", acc["id"], {"match": json.dumps(_issuer_keywords(conn))})
        return acc, False
    sort = (db.value(conn, "SELECT MAX(sort) FROM accounts") or 0) + 1
    new_id = db.insert(conn, "accounts", {
        "iban": None, "name": "Creditcard", "type": "credit", "match": json.dumps(_issuer_keywords(conn)),
        "hidden": 0, "sort": sort, "created_at": db.now_iso()})
    return db.row(conn, "SELECT * FROM accounts WHERE id = ?", (new_id,)), True


def import_card(conn: sqlite3.Connection, filename: str, source: Source, result: dict) -> None:
    from ..api.transactions import merchant_fields
    rows = card_xlsx.parse(read_workbook(source))
    today = periods.today().isoformat()
    late = next((r for r in rows if r["date"] > today), None)
    if late:
        raise ImportFormatError(f"De datum {late['date']} ligt in de toekomst.")
    acc, is_new = card_account(conn)
    cats = {}
    for c in db.rows(conn, "SELECT id, key, name FROM categories"):
        cats[c["name"].strip().lower()] = c["id"]
        cats[c["key"]] = c["id"]
    unsorted = db.unsorted_id(conn)
    now = db.now_iso()
    import_id = db.insert(conn, "imports", {"filename": filename, "format": "card_xlsx", "imported_at": now,
                                            "account_id": acc["id"]})
    lo, hi = min(r["date"] for r in rows), max(r["date"] for r in rows)
    existing = {r["dedupe_key"]: r["id"] for r in db.rows(
        conn, "SELECT id, dedupe_key FROM transactions WHERE account_id = ? AND dedupe_key LIKE ? "
              "AND date BETWEEN ? AND ?", (acc["id"], KEY_PREFIX + "%", lo, hi))}
    seen: dict[str, int] = {}
    keep: set[str] = set()
    new = 0
    for r in rows:
        name, mkey = merchant_fields(r["name"])
        base = f"{KEY_PREFIX}{acc['id']}:{r['date']}:{r['amount_cents']}:{norm_text(r['name'])}"
        seen[base] = seen.get(base, 0) + 1
        key = f"{base}:{seen[base]}"
        keep.add(key)
        if key in existing:
            continue
        cid = cats.get((r["bakje"] or "").lower()) if r["bakje"] else None
        db.insert(conn, "transactions", {
            "account_id": acc["id"], "import_id": import_id, "dedupe_key": key, "date": r["date"],
            "amount_cents": r["amount_cents"], "merchant_name": name, "merchant_key": mkey,
            "description": r["name"], "raw_description": r["name"],
            "method": "card" if r["amount_cents"] < 0 else "other",
            "category_id": cid or unsorted, "category_source": "user" if cid else "none",
            "category_reason": "user" if cid else "none", "kind": "normal", "manual": 1,
            "created_at": now, "updated_at": now})
        new += 1
    gone = [tid for k, tid in existing.items() if k not in keep]
    if gone:
        conn.execute(f"DELETE FROM transactions WHERE id IN ({db.placeholders(gone)})", gone)
    result.update({"ok": True, "import_id": import_id, "account_id": acc["id"], "account_name": acc["name"],
                   "is_new_account": is_new, "new": new, "duplicates": len(rows) - new, "removed": len(gone),
                   "date_from": lo, "date_to": hi})
    if is_new:
        result["new_accounts"].append({"id": acc["id"], "name": acc["name"], "type": "credit", "iban": None})
    db.update(conn, "imports", import_id, {"n_new": new, "n_duplicate": len(rows) - new,
                                           "date_from": lo, "date_to": hi})
