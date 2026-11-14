"""Own accounts: transfer detection (SPEC 7).

A transaction is a transfer when its counterparty IBAN is another own account, or its text
matches that account's `match` keywords. To a credit-card account it is a `settlement`.
"""

from __future__ import annotations

import json
import sqlite3

from .. import db
from ..classify.library import norm_text

CREDIT_CARD_MATCH = ["international card services", "ics"]

# category for money moving from a checking account to an own account of this type
CATEGORY_BY_TARGET = {"savings": "sparen", "investment": "beleggen", "checking": "intern",
                      "credit": "creditcard"}


def load_accounts(conn: sqlite3.Connection) -> list[dict]:
    out = []
    for a in db.rows(conn, "SELECT id, iban, name, type, match FROM accounts"):
        try:
            a["match"] = [m for m in json.loads(a["match"] or "[]") if isinstance(m, str)]
        except ValueError:
            a["match"] = []
        out.append(a)
    return out


def find_transfer_account(tx: dict, accounts: list[dict]) -> dict | None:
    """The own account on the other side of `tx`, or None."""
    own_id = tx.get("account_id")
    cp_iban = tx.get("counterparty_iban")
    if cp_iban:
        for a in accounts:
            if a["iban"] and a["iban"] == cp_iban and a["id"] != own_id:
                return a
    text = f" {norm_text((tx.get('counterparty_name') or '') + ' ' + (tx.get('raw_description') or tx.get('description') or ''))} "
    if text.strip() == "":
        return None
    candidates = [(norm_text(k), a) for a in accounts if a["id"] != own_id for k in a["match"]]
    for keyword, account in sorted(candidates, key=lambda ka: -len(ka[0])):
        if keyword and f" {keyword} " in text:
            return account
    return None


def transfer_result(tx: dict, target: dict, accounts: list[dict]) -> tuple[str, str]:
    """(kind, category key) for a transfer from tx's account to `target`."""
    kind = "settlement" if target["type"] == "credit" else "transfer"
    source = next((a for a in accounts if a["id"] == tx.get("account_id")), None)
    if source is None or source["type"] == "checking":
        return kind, CATEGORY_BY_TARGET.get(target["type"], "intern")
    return kind, "intern"
