"""Hoe staan we ervoor (Overzicht, SPEC 9): five calm read-outs for people without a financial
background, each with one plain sentence in the UI. No traffic lights.

Income is the real income averaged over the last up to twelve complete periods (at least two),
so holiday pay and a thirteenth month count. Without spread parts (one-off purchases are not a
monthly pattern):

- `buffer`: the buffer bar's figures (outlook.buffer_status) in months of fixed costs.
- `housing`: wonen (the full mortgage payment, the repayment included) + energie + belastingen
  & gemeente, per month and as a share of income.
- `fixed`: the one "vaste lasten per maand" (outlook.monthly_fixed, as on the Vaste lasten
  screen), as a share of income, and what is left of the income for the rest.
- `saving`: what went to savings and investments, without the mortgage repayment (shown
  separately as `repaid_cents`), per month and as a share of income.
- `debts`: the mortgage and the debts on Vermogen; `known` is false when there are none.
"""

from __future__ import annotations

import sqlite3

from datetime import timedelta

from .. import db
from . import networth
from .ledger import FIXED, Ledger

MONTHS = 12
HOUSING = ("wonen", "energie", "belastingen")


def _share(cents: float, income: float) -> float | None:
    return round(cents / income, 3) if income > 0 else None


def window(lg: Ledger) -> list:
    """The complete periods the averages use (None-like empty list with fewer than two)."""
    history = lg.complete_before(lg.current(), MONTHS)
    return history if len(history) >= 2 else []


def income(lg: Ledger) -> dict | None:
    """Average real income and mortgage/debt repayment per month over `window`, for every
    "x % van je inkomen" (health, Vaste lasten, the fixed_share insight)."""
    history = window(lg)
    if not history:
        return None
    flows = [lg.flows_for(p) for p in history]
    return {"income_cents": int(round(sum(f.income for f in flows) / len(flows))),
            "repaid_cents": int(round(sum(f.repaid for f in flows) / len(flows))),
            "months": len(flows)}


def fixed_share(lg: Ledger, monthly_fixed: float) -> float | None:
    """The one "vaste lasten: x % van je inkomen" (Hoe staan we ervoor, Vaste lasten, insight)."""
    inc = income(lg)
    return _share(monthly_fixed, inc["income_cents"]) if inc and monthly_fixed > 0 else None


def compute(conn: sqlite3.Connection, lg: Ledger, buffer: dict | None,
            monthly_fixed: float) -> dict | None:
    history = window(lg)
    if not history:
        return None
    flows = [lg.flows_for(p) for p in history]
    n = len(flows)
    if not any(f.fixed or f.daily for f in flows):
        return None         # no spending seen (only a savings account): nothing to say yet
    inc = sum(f.income for f in flows) / n
    repaid = sum(f.repaid for f in flows) / n
    saved = sum(f.saved - f.repaid for f in flows) / n
    housing_ids = {lg.cat_ids[k] for k in HOUSING if k in lg.cat_ids}
    housing = sum(r["bucket"][2] + (r.get("repaid") or 0) for f in flows for r in f.rows
                  if r["bucket"][0] == FIXED and r["bucket"][1] in housing_ids and not r.get("part")) / n

    nw = networth.get(conn)
    debts = []
    home = nw.get("home")
    from . import mortgage as mortgage_mod
    has_mortgage = bool(mortgage_mod.parts(conn))
    if home and home.get("debt_cents"):
        debts.append({"kind": "mortgage", "name": "Hypotheek", "cents": home["debt_cents"]})
    elif has_mortgage:
        # on Vermogen, but no jaaropgave yet: known, amount unknown
        debts.append({"kind": "mortgage", "name": "Hypotheek", "cents": 0, "unknown": True})
    for a in nw.get("assets") or []:
        if a["kind"] == "debt" and (a.get("value_cents") or 0) > 0:
            debts.append({"kind": "debt", "name": a["name"], "cents": a["value_cents"],
                          "id": a["id"]})
    # loans paid every month (bakje Leningen) that are not on Vermogen yet: DUO, a car loan
    from . import besparen, mortgage, recurring
    linked = {r["merchant_key"] for r in db.rows(conn, "SELECT merchant_key FROM assets WHERE kind = 'debt' "
                                                     "AND merchant_key IS NOT NULL")}
    linked.add(mortgage.linked_merchant(conn)[0])
    loans_id = lg.cat_ids.get("leningen")
    # with a mortgage on Vermogen whose payment is not one of these, such a payment is most
    # likely that mortgage: ask to link it instead of to add a loan
    m_key = mortgage_mod.linked_merchant(conn)[0]
    since = (lg.today - timedelta(days=62)).isoformat()
    m_paid = bool(m_key) and any(r["merchant_key"] == m_key and r["amount_cents"] < 0 and r["date"] >= since
                                 for r in lg.rows)
    unlisted = [{"name": i["name"], "per_month_cents": -i["per_month_cents"],
                 "maybe_mortgage": has_mortgage and not m_paid}
                for i in recurring.items(conn)
                if i["direction"] == "out" and i["status"] != "ended" and i["category_id"] == loans_id
                and i["merchant_key"] not in linked]
    rnd = lambda x: int(round(x))  # noqa: E731
    return {
        "months": n,
        "income_cents": rnd(inc),
        "buffer": None if not buffer else {
            "months": buffer["months"], "target_months": buffer["target_months"],
            "saved_cents": buffer["saved_cents"], "target_cents": buffer["target_cents"],
            "source": buffer["source"]},
        "housing": {"cents": rnd(housing), "share": _share(housing, inc)},
        "fixed": {"cents": rnd(monthly_fixed), "share": fixed_share(lg, monthly_fixed),
                  "rest_cents": rnd(inc - monthly_fixed)},
        "saving": {"cents": rnd(saved), "share": _share(saved, inc), "repaid_cents": rnd(repaid)},
        "debts": {"known": bool(debts), "total_cents": sum(d["cents"] for d in debts),
                  "items": debts, "unlisted": unlisted, "later": besparen.later_payments(lg)},
    }
