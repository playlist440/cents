"""Zelfcontrole ("Kloppen je gegevens?", SPEC 9): runs on the household's own server and tells
the family what Cents cannot see. Nothing leaves the server.

- `coverage` (verantwoordingsmeter): of the spending in the last up to twelve complete periods,
  the share that sits in a bakje that says what it was for. Unknown: Nog te sorteren, Contant,
  Overig and the part of credit-card bills Cents cannot explain (bakje Creditcard).
- `accounts`: per visible checking, savings and credit account the first and last transaction,
  the last import, months without any transaction between them (checking accounts only: a quiet
  savings account is normal) and balance breaks: a day whose end balance is not the previous
  day's balance plus that day's payments, so transactions are missing in between.
- `transfers`: transfers to an own checking or savings account that has transactions around that
  date, without the matching opposite payment on that account within four days.
- `issues`: how many things to look at (breaks, missing months, unmatched transfers).
"""

from __future__ import annotations

import sqlite3
from datetime import date, timedelta

from .. import db
from . import cache, ledger as ledger_mod
from .ledger import DAILY, FIXED

MONTHS = 12
UNKNOWN = ("unsorted", "contant", "overig", "creditcard")
MATCH_DAYS = 4
LIST_MAX = 8


def coverage(lg: ledger_mod.Ledger) -> dict | None:
    history = lg.complete_before(lg.current(), MONTHS)
    if not history:
        return None
    spent: dict[int, int] = {}
    for p in history:
        for r in lg.flows_for(p).rows:
            grp, cid, value = r["bucket"]
            if grp in (FIXED, DAILY):
                spent[cid] = spent.get(cid, 0) + value
    total = sum(v for v in spent.values() if v > 0)
    unknown = []
    for key in UNKNOWN:
        cid = lg.cat_ids.get(key)
        cents = max(0, spent.get(cid, 0)) if cid else 0
        if cents:
            unknown.append({"key": key, "category_id": cid, "cents": cents,
                            "per_month_cents": int(round(cents / len(history))),
                            "share": round(cents / total, 4) if total else 0.0})
    unknown_cents = sum(u["cents"] for u in unknown)
    return {"months": len(history), "spent_cents": total, "unknown_cents": unknown_cents,
            "share": round((total - unknown_cents) / total, 4) if total else None,
            "unknown": sorted(unknown, key=lambda u: -u["cents"])}


def _months_between(first: str, last: str) -> list[str]:
    y, m = int(first[:4]), int(first[5:7])
    out = []
    while f"{y:04d}-{m:02d}" <= last[:7]:
        out.append(f"{y:04d}-{m:02d}")
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


def _balance_breaks(rows: list[dict]) -> list[dict]:
    """Days where the end balance does not follow from the previous day's end balance and the
    day's payments. Order inside a day is not trusted: a day is fine when the expected end
    balance is one of that day's balances. Days without a balance carry the running total."""
    totals: dict[str, int] = {}
    balanced: dict[str, list[dict]] = {}
    for r in rows:
        totals[r["date"]] = totals.get(r["date"], 0) + r["amount_cents"]
        if r["balance_after_cents"] is not None:
            balanced.setdefault(r["date"], []).append(r)
    breaks, prev_end = [], None
    for day in sorted(totals):
        txs = sorted(balanced.get(day, []), key=lambda r: (r["seq"] is None, r["seq"] or 0, r["id"]))
        if not txs:
            prev_end = None if prev_end is None else prev_end + totals[day]
            continue
        if prev_end is None:
            prev_end = txs[-1]["balance_after_cents"]
            continue
        expected = prev_end + totals[day]
        if expected in {r["balance_after_cents"] for r in txs}:
            prev_end = expected
            continue
        end = txs[-1]["balance_after_cents"]
        breaks.append({"date": day, "expected_cents": expected, "actual_cents": end,
                       "difference_cents": end - expected})
        prev_end = end
    return breaks


def accounts(conn: sqlite3.Connection, today: date) -> list[dict]:
    out = []
    for a in db.rows(conn, "SELECT id, name, type, iban FROM accounts WHERE hidden = 0 "
                           "AND type IN ('checking', 'savings', 'credit') ORDER BY sort, id"):
        rows = db.rows(conn, "SELECT id, date, amount_cents, balance_after_cents, seq FROM transactions "
                             "WHERE account_id = ? ORDER BY date, seq, id", (a["id"],))
        imported = db.value(conn, """SELECT MAX(substr(i.imported_at, 1, 10)) FROM imports i
                                     WHERE i.account_id = ? OR EXISTS (SELECT 1 FROM transactions t
                                     WHERE t.import_id = i.id AND t.account_id = ?)""", (a["id"], a["id"]))
        item = {"id": a["id"], "name": a["name"], "type": a["type"], "iban": a["iban"], "count": len(rows),
                "first_date": rows[0]["date"] if rows else None,
                "last_date": rows[-1]["date"] if rows else None, "last_import": imported,
                "days_since": (today - date.fromisoformat(rows[-1]["date"])).days if rows else None,
                "missing_months": [], "breaks": [], "breaks_count": 0}
        if rows and a["type"] == "checking":
            seen = {r["date"][:7] for r in rows}
            item["missing_months"] = [m for m in _months_between(rows[0]["date"], rows[-1]["date"])
                                      if m not in seen]
        if rows and a["type"] in ("checking", "savings"):
            breaks = _balance_breaks(rows)
            item["breaks"], item["breaks_count"] = breaks[-LIST_MAX:], len(breaks)
        out.append(item)
    return out


def transfers(conn: sqlite3.Connection, accs: list[dict]) -> dict:
    spans = {a["id"]: (a["first_date"], a["last_date"]) for a in accs
             if a["type"] in ("checking", "savings") and a["first_date"]}
    names = {a["id"]: a["name"] for a in accs}
    rows = db.rows(conn, "SELECT id, account_id, date, amount_cents, transfer_account_id FROM transactions "
                         "WHERE kind = 'transfer' AND transfer_account_id IS NOT NULL ORDER BY date DESC, id DESC")
    by_acc: dict[int, list[dict]] = {}
    for r in db.rows(conn, "SELECT account_id, date, amount_cents FROM transactions"):
        by_acc.setdefault(r["account_id"], []).append(r)
    unmatched = []
    for r in rows:
        other = r["transfer_account_id"]
        span = spans.get(other)
        if not span or not span[0] <= r["date"] <= span[1] or r["account_id"] not in names:
            continue
        lo = (date.fromisoformat(r["date"]) - timedelta(days=MATCH_DAYS)).isoformat()
        hi = (date.fromisoformat(r["date"]) + timedelta(days=MATCH_DAYS)).isoformat()
        if any(t["amount_cents"] == -r["amount_cents"] and lo <= t["date"] <= hi
               for t in by_acc.get(other, [])):
            continue
        unmatched.append({"transaction_id": r["id"], "date": r["date"], "amount_cents": r["amount_cents"],
                          "account": names[r["account_id"]], "other_account": names.get(other)})
    return {"count": len(unmatched), "items": unmatched[:LIST_MAX]}


def compute(conn: sqlite3.Connection) -> dict:
    return cache.memo(conn, "checks", lambda: _compute(conn))


def _compute(conn: sqlite3.Connection) -> dict:
    lg = ledger_mod.get(conn)
    accs = accounts(conn, lg.today)
    tr = transfers(conn, accs)
    issues = (sum(a["breaks_count"] + len(a["missing_months"]) for a in accs) + tr["count"])
    return {"coverage": coverage(lg), "accounts": accs, "transfers": tr, "issues": issues}
