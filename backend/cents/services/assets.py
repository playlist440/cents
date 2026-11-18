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
- Possession (bezitting, services/spread.py): a car or anything else you sell again later. Its
  value goes down linearly from the price to the expected resale value over its life; 0 once
  sold. Its waardeverlies counts as a cost per month (ledger), the purchase does not.
- Cash projections (outlook, Nog te besteden) never look at these items.
"""

from __future__ import annotations

import calendar
import re
import sqlite3
from datetime import date

from .. import db
from . import periods, spread

KINDS = ("pension", "debt", "other", "possession")
DEBT_KINDS = ("studieschuld", "lening", "overig")
DEFAULT_INCLUDE = {"pension": False, "debt": True, "other": True, "possession": True}
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
        self.start_day = lg.start_day
        self.plan = None
        if a["kind"] == "possession":
            sale = (db.row(conn, "SELECT COALESCE(book_date, date) AS date, amount_cents FROM transactions "
                                 "WHERE id = ?", (a["sale_tx_id"],)) if a["sale_tx_id"] else None)
            self.plan = spread.possession_plan(a, {"_sale": sale} if sale else None)
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
        if self.plan is not None:
            return spread.value_on(self.plan, self.plan.total or 0, day, self.start_day)
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


def _tx_brief(conn: sqlite3.Connection, tx_id: int | None) -> dict | None:
    if not tx_id:
        return None
    t = db.row(conn, "SELECT id, COALESCE(book_date, date) AS date, amount_cents, merchant_name, category_id "
                     "FROM transactions WHERE id = ?", (tx_id,))
    return dict(t) if t else None


def possession_out(conn: sqlite3.Connection, it: Item, today: str) -> dict:
    a, plan = it.a, it.plan
    total = plan.total or 0
    sd = it.start_day
    first = periods.period_for(date.fromisoformat(plan.start), sd) if plan.start else None
    value = it.value(today)
    parts = spread.amounts(total, plan.months, plan.keep)
    sale_tx = _tx_brief(conn, a["sale_tx_id"])
    return {"id": a["id"], "kind": "possession", "name": a["name"], "emoji": a["emoji"],
            "include": bool(a["include"]), "value_cents": value,
            "signed_cents": value or 0, "as_of": today if value is not None else None,
            "estimated": False, "repaid_since_cents": 0, "repaid_share": None, "payment": None,
            "debt_kind": None, "entries": [],
            "price_cents": total, "start_date": plan.start, "life_months": plan.months,
            "residual_cents": plan.keep, "category_id": a["category_id"],
            "monthly_cents": parts[0] if parts else 0,
            "lost_cents": (total - value) if value is not None and not plan.sale_date else None,
            "end_period": spread.end_period(plan, first, sd).id if first else None,
            "purchase": _tx_brief(conn, a["tx_id"]),
            "sale": ({"date": plan.sale_date, "cents": plan.sale_cents, "tx": sale_tx,
                      "result_cents": next((v for _, _, v, role in spread.schedule(plan, total, first, sd)
                                            if role == "sale"), None) if first else None}
                     if plan.sale_date else None)}


def sale_candidates(conn: sqlite3.Connection, a: dict) -> list[dict]:
    """Money in after the purchase (at least € 100), newest first: likely the sale. Not from a
    payer that paid three times or more (salary, allowances)."""
    taken = {r["sale_tx_id"] for r in db.rows(conn, "SELECT sale_tx_id FROM assets WHERE sale_tx_id IS NOT NULL")}
    rows = db.rows(conn, """
        SELECT t.id, COALESCE(t.book_date, t.date) AS date, t.amount_cents, t.merchant_name
        FROM transactions t JOIN accounts a ON a.id = t.account_id
        WHERE t.amount_cents >= 10000 AND t.kind = 'normal' AND a.type IN ('checking', 'savings')
          AND COALESCE(t.book_date, t.date) >= ?
          AND (t.merchant_key IS NULL OR (SELECT COUNT(*) FROM transactions x WHERE x.merchant_key = t.merchant_key
                                          AND x.amount_cents > 0) < 3)
        ORDER BY COALESCE(t.book_date, t.date) DESC, t.id DESC LIMIT 40""", (a["start_date"] or "0000",))
    return [r for r in rows if r["id"] not in taken][:15]


def purchase_candidates(conn: sqlite3.Connection, today: date) -> list[dict]:
    """Big payments (at least € 500) of the last three years that may be a purchase: one per
    merchant (its largest), no merchant paid that much three times or more (rent, mortgage)."""
    since = date(today.year - 3, today.month, 1).isoformat()
    taken = {r["tx_id"] for r in db.rows(conn, "SELECT tx_id FROM assets WHERE tx_id IS NOT NULL")}
    rows = db.rows(conn, """
        SELECT t.id, COALESCE(t.book_date, t.date) AS date, t.amount_cents, t.merchant_name,
               t.merchant_key, t.category_id
        FROM transactions t JOIN accounts a ON a.id = t.account_id
        LEFT JOIN categories c ON c.id = t.category_id
        WHERE t.amount_cents <= -50000 AND t.kind = 'normal' AND a.type IN ('checking', 'savings', 'credit')
          AND COALESCE(c.grp, 'daily') IN ('fixed', 'daily') AND COALESCE(t.book_date, t.date) >= ?
        ORDER BY t.amount_cents, t.id""", (since,))
    count: dict[str, int] = {}
    for r in rows:
        count[r["merchant_key"] or ""] = count.get(r["merchant_key"] or "", 0) + 1
    out, seen = [], set()
    for r in rows:
        key = r["merchant_key"] or f"tx:{r['id']}"
        if r["id"] in taken or key in seen or (r["merchant_key"] and count[r["merchant_key"]] >= 3):
            continue
        seen.add(key)
        out.append({k: r[k] for k in ("id", "date", "amount_cents", "merchant_name", "category_id")})
    return out[:15]


def out(conn: sqlite3.Connection, it: Item, today: str, names: dict[str, str]) -> dict:
    if it.plan is not None:
        return possession_out(conn, it, today)
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
    items_out = [out(conn, it, today, names) for it in estimators(conn, lg)]
    for x in items_out:
        if x["kind"] == "possession" and not x["sale"]:
            x["sale_candidates"] = sale_candidates(conn, {"start_date": x["start_date"]})
    return {"items": items_out, "candidates": cands[:12],
            "purchase_candidates": purchase_candidates(conn, lg.today)}


def networth_part(conn: sqlite3.Connection, lg) -> tuple[list[dict], list[Item]]:
    """Items for GET /networth (`assets`) and the estimators of the included ones."""
    today = lg.today.isoformat()
    ests = estimators(conn, lg)
    listed = [{"id": it.a["id"], "kind": it.a["kind"], "name": it.a["name"],
               "debt_kind": it.a["debt_kind"], "include": bool(it.a["include"]),
               "value_cents": it.value(today), "signed_cents": it.signed(today),
               "as_of": (today if it.plan is not None else it.ents[-1]["date"] if it.ents else None),
               "emoji": it.a["emoji"],
               **({"monthly_cents": spread.amounts(it.plan.total or 0, it.plan.months, it.plan.keep)[0],
                   "sold": bool(it.plan.sale_date), "sale_date": it.plan.sale_date}
                  if it.plan is not None else {})} for it in ests]
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
