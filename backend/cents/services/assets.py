"""Other assets and liabilities (SPEC 7.3): pension, debt and other possessions.

- Every item has dated entries (`value_cents`): pension = opgebouwd bedrag, debt = restschuld,
  other = waarde. An item counts in net worth when its `include` switch is on (default off for
  pension, on for debt and other). Debt counts negative.
- Pension and other: the value on a day is the latest entry on or before that day; before the
  first entry the item counts 0 (like an account before its first known balance).
- Debt with a linked payment (`merchant_key`) and a known ratio (the latest entry with rente
  and/or afgelost): the payment is split like the mortgage (services/ledger.py): repaid share =
  repaid / (repaid + interest) counts as saving ("Afgelost"), the rest stays a fixed cost. The
  debt on a day = latest entry on or before that day minus the repaid amounts since; before the
  first entry, the first entry plus the repaid amounts until then. Never below zero.
- Cash projections (outlook, Nog te besteden) never look at these items.
"""

from __future__ import annotations

import calendar
import re
import sqlite3
from datetime import date

from .. import db

KINDS = ("pension", "debt", "other")
DEBT_KINDS = ("studieschuld", "lening", "overig")
DEFAULT_INCLUDE = {"pension": False, "debt": True, "other": True}
DUO = re.compile(r"\bduo\b|dienst uitvoering onderwijs")


def items(conn: sqlite3.Connection) -> list[dict]:
    return db.rows(conn, "SELECT * FROM assets ORDER BY sort, id")


def entries(conn: sqlite3.Connection, asset_id: int) -> list[dict]:
    return db.rows(conn, "SELECT id, date, value_cents, interest_cents, repaid_cents, note "
                         "FROM asset_entries WHERE asset_id = ? ORDER BY date, id", (asset_id,))


def ratio(ents: list[dict]) -> float | None:
    """Repaid share of the latest entry that has interest and/or repaid filled in."""
    for e in reversed(ents):
        rep, intr = e["repaid_cents"] or 0, e["interest_cents"] or 0
        if rep + intr > 0:
            return rep / (rep + intr)
    return None


def split_configs(conn: sqlite3.Connection) -> dict[str, float]:
    """merchant key -> repaid share for linked debts with a known ratio."""
    out: dict[str, float] = {}
    for a in db.rows(conn, "SELECT id, merchant_key FROM assets WHERE kind = 'debt' "
                           "AND merchant_key IS NOT NULL AND merchant_key != ''"):
        share = ratio(entries(conn, a["id"]))
        if share:
            out.setdefault(a["merchant_key"], share)
    return out


def candidates(conn: sqlite3.Connection) -> list[dict]:
    """Merchants paid from a checking account in a fixed-cost bakje; DUO first."""
    rows = db.rows(conn, """
        SELECT t.merchant_key, MAX(t.merchant_name) AS merchant_name, COUNT(*) AS n,
               (SELECT t2.amount_cents FROM transactions t2 WHERE t2.merchant_key = t.merchant_key
                  AND t2.amount_cents < 0 ORDER BY t2.date DESC, t2.id DESC LIMIT 1) AS amount_cents
        FROM transactions t JOIN accounts a ON a.id = t.account_id
        JOIN categories c ON c.id = t.category_id
        WHERE c.grp = 'fixed' AND a.type = 'checking' AND t.amount_cents < 0
          AND t.merchant_key IS NOT NULL
        GROUP BY t.merchant_key""")
    for r in rows:
        r["likely"] = bool(DUO.search(f"{r['merchant_key']} {r['merchant_name'] or ''}".lower()))
    rows.sort(key=lambda r: (not r["likely"], -r["n"], r["merchant_key"]))
    return [{"merchant_key": r["merchant_key"], "merchant_name": r["merchant_name"],
             "amount_cents": r["amount_cents"], "count": r["n"], "likely": r["likely"]} for r in rows]


class Item:
    """Value of one item on any day (debt positive here; `signed` makes it negative)."""

    def __init__(self, conn: sqlite3.Connection, a: dict, lg):
        self.a = a
        self.ents = entries(conn, a["id"])
        self.share = ratio(self.ents) if a["kind"] == "debt" else None
        key = a["merchant_key"]
        from . import mortgage                      # the mortgage wins a shared merchant (ledger)
        m_split = mortgage.split_config(conn)
        if m_split and m_split[0] == key:
            key = None
        self.events = ([(r["date"], r["repaid"]) for r in lg.rows
                        if r.get("repaid") and r["merchant_key"] == key] if key and self.share else [])

    def _repaid_between(self, after: str, upto: str) -> int:
        return sum(v for d, v in self.events if after < d <= upto)

    def value(self, day: str) -> int | None:
        if not self.ents:
            return None
        known = [e for e in self.ents if e["date"] <= day]
        if self.a["kind"] != "debt":
            return known[-1]["value_cents"] if known else None
        if known:
            last = known[-1]
            return max(0, last["value_cents"] - self._repaid_between(last["date"], day))
        first = self.ents[0]
        return max(0, first["value_cents"] + self._repaid_between(day, first["date"]))

    def signed(self, day: str) -> int:
        v = self.value(day) or 0
        return -v if self.a["kind"] == "debt" else v


def estimators(conn: sqlite3.Connection, lg) -> list[Item]:
    return [Item(conn, a, lg) for a in items(conn)]


def out(conn: sqlite3.Connection, it: Item, today: str, names: dict[str, str]) -> dict:
    a, ents = it.a, it.ents
    value = it.value(today)
    last = ents[-1] if ents else None
    repaid_since = it._repaid_between(last["date"], today) if last and it.events else 0
    key = a["merchant_key"]
    return {"id": a["id"], "kind": a["kind"], "name": a["name"], "debt_kind": a["debt_kind"],
            "include": bool(a["include"]), "value_cents": value,
            "signed_cents": (-(value or 0) if a["kind"] == "debt" else (value or 0)),
            "as_of": last["date"] if last else None,
            "estimated": bool(repaid_since),
            "repaid_since_cents": repaid_since,
            "repaid_share": round(it.share, 4) if it.share is not None else None,
            "payment": ({"merchant_key": key, "merchant_name": names.get(key) or key} if key else None),
            "entries": [dict(e) for e in reversed(ents)]}


def summary(conn: sqlite3.Connection, lg) -> dict:
    """GET /assets."""
    today = lg.today.isoformat()
    cands = candidates(conn)
    names = {c["merchant_key"]: c["merchant_name"] for c in cands}
    return {"items": [out(conn, it, today, names) for it in estimators(conn, lg)],
            "candidates": cands[:12]}


def networth_part(conn: sqlite3.Connection, lg) -> tuple[list[dict], list[Item]]:
    """Items for GET /networth (`assets`) and the estimators of the included ones."""
    today = lg.today.isoformat()
    ests = estimators(conn, lg)
    listed = [{"id": it.a["id"], "kind": it.a["kind"], "name": it.a["name"],
               "debt_kind": it.a["debt_kind"], "include": bool(it.a["include"]),
               "value_cents": it.value(today), "signed_cents": it.signed(today),
               "as_of": it.ents[-1]["date"] if it.ents else None} for it in ests]
    return listed, [it for it in ests if it.a["include"]]


def stale_pension(conn: sqlite3.Connection, today: date) -> bool:
    """A pension item whose last entry is more than 11 months old (or that has none)."""
    y, m = today.year, today.month - 11
    if m <= 0:
        y, m = y - 1, m + 12
    cutoff = date(y, m, min(today.day, calendar.monthrange(y, m)[1])).isoformat()
    for a in db.rows(conn, "SELECT id FROM assets WHERE kind = 'pension'"):
        last = db.value(conn, "SELECT MAX(date) FROM asset_entries WHERE asset_id = ?", (a["id"],))
        if last is None or last < cutoff:
            return True
    return False
