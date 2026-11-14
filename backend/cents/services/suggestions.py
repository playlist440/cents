"""Account suggestions for GET /bootstrap (SPEC 7): likely own savings / investment accounts."""

from __future__ import annotations

import json
import sqlite3

from .. import db
from ..classify.library import Library, get_library, norm_text
from ..importers.normalize import OWN_ACCOUNT_CODES


def account_suggestions(conn: sqlite3.Connection, lib: Library | None = None) -> list[dict]:
    lib = lib or get_library()
    accounts = db.rows(conn, "SELECT iban, type, match FROM accounts")
    own = {a["iban"] for a in accounts if a["iban"]}
    dismissed = set(db.get_setting(conn, "dismissed_suggestions", []) or [])
    out: list[dict] = []

    codes = sorted(OWN_ACCOUNT_CODES)
    for r in db.rows(conn, f"""
        SELECT counterparty_iban AS iban, MAX(counterparty_name) AS name, COUNT(*) AS count
        FROM transactions
        WHERE counterparty_iban IS NOT NULL
          AND (LOWER(bank_category) = 'sparen' OR iso_subfamily = 'BOOK'
               OR bank_code IN ({db.placeholders(codes)}))
        GROUP BY counterparty_iban ORDER BY count DESC""", codes):
        key = f"savings:{r['iban']}"
        if r["iban"] in own or key in dismissed:
            continue
        out.append({"key": key, "type": "savings", "iban": r["iban"], "name": "Spaarrekening",
                    "counterparty_name": r["name"], "count": r["count"], "match": []})

    covered = set()
    for a in accounts:
        if a["type"] == "investment":
            covered |= {norm_text(m) for m in json.loads(a["match"] or "[]")}
    for brand in lib.merchants:
        if brand.get("category") != "beleggen" or not brand.get("key"):
            continue
        key = f"investment:{brand['key']}"
        matches = [m.lower() for m in brand.get("match", [])]
        if key in dismissed or covered & {norm_text(m) for m in matches}:
            continue
        count = db.value(conn, "SELECT COUNT(*) FROM transactions WHERE merchant_key = ?", (brand["key"],))
        if count:
            out.append({"key": key, "type": "investment", "iban": None, "name": brand.get("name"),
                        "counterparty_name": brand.get("name"), "count": count, "match": matches})
    return out
