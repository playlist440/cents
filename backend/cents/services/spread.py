"""Costs over time (SPEC 7.4): uitsmeren and bezittingen.

A big purchase you use for years distorts the month you paid it. Two ways to count it instead:

- **Uitsmeren** (`transactions.spread_months`): a payment counts in equal parts over that many
  periods, starting in its own period. Only for spending (fixed/daily bakjes, unsorted).
- **Bezitting** (`assets` kind `possession`): something you sell again later (a car). The
  purchase price minus the expected resale value (`residual_cents`) counts as waardeverlies,
  in equal parts over `life_months`, in the bakje `category_id`. The purchase payment itself
  (`tx_id`, optional) does not count as spending. On a sale (`sale_tx_id` or `sale_date` +
  `sale_cents`) the parts stop; in the sale's period the book value minus the sale price
  counts once (negative = sold for more than expected). The sale payment is not income.
  The value on Vermogen goes down linearly per day from the price to the residual value.

Cash figures (Nog te besteden, buffer, the checking projection) follow the real money: they use
balances, and `outlook` leaves spread parts out of its typical spending.

Parts are ledger rows with `part` = {kind, index, months, role, total_cents, name, asset_id}
(`role`: part | sale). Spread parts carry the transaction id; possession parts carry the
purchase transaction id when there is one.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import date

from .. import db
from . import periods
from .periods import Period

SPREAD_CHOICES = (6, 12, 24, 36, 60, 96, 120)
MAX_MONTHS = 240


@dataclass
class Plan:
    kind: str                     # spread | possession
    months: int
    tx_id: int | None = None
    total: int | None = None      # cents; spread: None = the payment's own amount
    keep: int = 0                 # possession: expected resale value at the end
    curve: str | None = None      # possession: 'front' = faster at first, else linear
    start: str | None = None      # possession: purchase day
    category_id: int | None = None
    sale_date: str | None = None
    sale_cents: int | None = None
    asset_id: int | None = None
    name: str | None = None


def amounts(total: int, months: int, keep: int = 0, curve: str | None = None) -> list[int]:
    """`total - keep` in `months` parts; the first parts take the leftover cents. With curve
    'front' the parts shrink month by month (sum of the years' digits: the first month weighs
    `months`, the last 1), like a car that loses most of its value in the first years."""
    months = max(1, int(months))
    base = max(0, total - max(0, min(keep, total)))
    if curve == "front" and months > 1:
        weights = list(range(months, 0, -1))
        whole = sum(weights)
        parts = [base * w // whole for w in weights]
        for i in range(base - sum(parts)):
            parts[i] += 1
        return parts
    q, r = divmod(base, months)
    return [q + (1 if i < r else 0) for i in range(months)]


def _index(pid: str) -> int:
    y, m = (int(x) for x in pid.split("-"))
    return y * 12 + m - 1


def schedule(plan: Plan, total: int, start: Period, start_day: int) -> list[tuple[Period, int, int, str]]:
    """(period, offset, cents, role) for every period the plan counts in."""
    parts = amounts(total, plan.months, plan.keep, plan.curve)
    out = []
    sale_k = None
    if plan.sale_date and plan.sale_cents is not None:
        sale_p = periods.period_for(date.fromisoformat(plan.sale_date), start_day)
        sale_k = max(0, _index(sale_p.id) - _index(start.id))
    upto = len(parts) if sale_k is None else min(sale_k, len(parts))
    for k in range(upto):
        out.append((periods.shift(start, k, start_day) if k else start, k, parts[k], "part"))
    if sale_k is not None:
        book = total - sum(parts[:upto])
        out.append((periods.shift(start, sale_k, start_day) if sale_k else start, sale_k,
                    book - plan.sale_cents, "sale"))
    return out


def value_on(plan: Plan, total: int, day: str, start_day: int) -> int | None:
    """A possession's value on `day`: from the price down to the residual value, linearly per
    day inside each period; 0 once sold; None before it was bought."""
    if not plan.start or day < plan.start:
        return None
    if plan.sale_date and day >= plan.sale_date:
        return 0
    parts = amounts(total, plan.months, plan.keep, plan.curve)
    d = date.fromisoformat(day)
    first = periods.period_for(date.fromisoformat(plan.start), start_day)
    p = periods.period_for(d, start_day)
    k = _index(p.id) - _index(first.id)
    if k >= len(parts):
        return total - sum(parts)
    begin = date.fromisoformat(plan.start) if k == 0 else p.start
    span = max(1, (p.end - begin).days)
    frac = (d - begin).days / span
    return total - sum(parts[:k]) - int(round(parts[k] * frac))


def end_period(plan: Plan, start: Period, start_day: int) -> Period:
    return periods.shift(start, plan.months - 1, start_day)


# ---------------------------------------------------------------- loading

def possession_plan(a: dict, tx: dict | None) -> Plan:
    sale_date, sale_cents = a["sale_date"], a["sale_cents"]
    if a["sale_tx_id"] and tx is not None and tx.get("_sale"):
        sale_date, sale_cents = tx["_sale"]["date"], tx["_sale"]["amount_cents"]
    return Plan(kind="possession", months=a["life_months"] or 96, tx_id=a["tx_id"],
                total=a["price_cents"] or 0, keep=a["residual_cents"] or 0, start=a["start_date"],
                category_id=a["category_id"], sale_date=sale_date, sale_cents=sale_cents,
                asset_id=a["id"], name=a["name"], curve=a.get("curve"))


def possessions(conn: sqlite3.Connection) -> list[tuple[dict, Plan]]:
    """Every possession with its plan. A linked sale payment gives the sale date and price."""
    out = []
    for a in db.rows(conn, "SELECT * FROM assets WHERE kind = 'possession' ORDER BY sort, id"):
        sale = None
        if a["sale_tx_id"]:
            sale = db.row(conn, "SELECT COALESCE(book_date, date) AS date, amount_cents FROM transactions "
                                "WHERE id = ?", (a["sale_tx_id"],))
        plan = possession_plan(a, {"_sale": sale} if sale else None)
        out.append((a, plan))
    return out


def spread_plans(conn: sqlite3.Connection) -> dict[int, Plan]:
    """Spread payments by transaction id (not the purchases of possessions)."""
    taken = {r["tx_id"] for r in db.rows(conn, "SELECT tx_id FROM assets WHERE kind = 'possession' "
                                               "AND tx_id IS NOT NULL")}
    return {r["id"]: Plan(kind="spread", months=r["spread_months"], tx_id=r["id"])
            for r in db.rows(conn, "SELECT id, spread_months FROM transactions WHERE spread_months > 1")
            if r["id"] not in taken}


def links(conn: sqlite3.Connection) -> dict[int, dict]:
    """Transaction id -> {asset_id, name, role} for purchases and sales of possessions."""
    out: dict[int, dict] = {}
    for a in db.rows(conn, "SELECT id, name, tx_id, sale_tx_id FROM assets WHERE kind = 'possession'"):
        if a["tx_id"]:
            out[a["tx_id"]] = {"asset_id": a["id"], "name": a["name"], "role": "purchase"}
        if a["sale_tx_id"]:
            out[a["sale_tx_id"]] = {"asset_id": a["id"], "name": a["name"], "role": "sale"}
    return out


def part_json(r: dict) -> dict:
    """The `part` of a ledger row for the API (bakje lists)."""
    p = r["part"]
    return {"kind": p["kind"], "index": p["index"], "months": p["months"], "role": p["role"],
            "cents": r["bucket"][2], "total_cents": p["total_cents"], "name": p["name"],
            "asset_id": p["asset_id"], "tx_id": r["id"], "date": r["date"], "period": r["period"],
            "category_id": r["bucket"][1]}


# ---------------------------------------------------------------- API helpers

SPENDING_GROUPS = ("fixed", "daily")


def check_spreadable(conn: sqlite3.Connection, tx: dict) -> None:
    """Only money out that counts as spending can be spread (not a transfer, saving or a
    credit-card bill), and not the purchase of a possession (that has its own plan)."""
    from ..errors import bad_request
    cat = db.row(conn, "SELECT key, grp FROM categories WHERE id = ?", (tx["category_id"],)) or {}
    acc = db.row(conn, "SELECT type FROM accounts WHERE id = ?", (tx["account_id"],)) or {}
    if (tx["amount_cents"] >= 0 or tx["kind"] != "normal" or cat.get("grp") not in SPENDING_GROUPS
            or cat.get("key") == "creditcard" or acc.get("type") not in ("checking", "credit")):
        raise bad_request("Alleen een uitgave kun je over maanden verdelen.", "spread_not_spending")
    if db.value(conn, "SELECT 1 FROM assets WHERE kind = 'possession' AND tx_id = ?", (tx["id"],)):
        raise bad_request("Deze betaling hoort bij een bezitting.", "spread_possession")


def describe(conn: sqlite3.Connection, tx: dict) -> dict | None:
    """How a payment counts over time, for the transaction sheet."""
    sd = periods.start_day_of(conn)
    day = date.fromisoformat(tx.get("book_date") or tx["date"])
    start = periods.period_for(day, sd)
    link = links(conn).get(tx["id"])
    if link:
        a = db.row(conn, "SELECT * FROM assets WHERE id = ?", (link["asset_id"],))
        plan = next((p for x, p in possessions(conn) if x["id"] == a["id"]), None)
        total = plan.total or 0
        first = periods.period_for(date.fromisoformat(plan.start), sd) if plan.start else start
        return {"kind": "possession", "role": link["role"], "asset_id": a["id"], "name": a["name"],
                "emoji": a["emoji"], "months": plan.months, "residual_cents": plan.keep,
                "price_cents": total, "monthly_cents": amounts(total, plan.months, plan.keep, plan.curve)[0],
                "curve": plan.curve or "linear",
                "value_cents": value_on(plan, total, periods.today().isoformat(), sd),
                "from": first.id, "to": end_period(plan, first, sd).id,
                "sold": bool(plan.sale_date), "sale_date": plan.sale_date, "sale_cents": plan.sale_cents,
                "category_id": a["category_id"]}
    months = tx.get("spread_months")
    if not months or months < 2 or tx["amount_cents"] >= 0:
        return None
    total = -tx["amount_cents"]
    return {"kind": "spread", "months": months, "monthly_cents": amounts(total, months)[0],
            "from": start.id, "to": periods.shift(start, months - 1, sd).id}
