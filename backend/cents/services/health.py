"""Hoe staan we ervoor (Overzicht, SPEC 9): five calm read-outs for people without a financial
background, each with one plain sentence in the UI. No traffic lights.

All shares are of the real income, averaged over the last up to twelve complete periods (at
least two), without spread parts (one-off purchases are not a monthly pattern):

- `buffer`: the buffer bar's figures (outlook.buffer_status) in months of fixed costs.
- `housing`: wonen (the full mortgage payment, the repayment included) + energie + belastingen
  & gemeente, per month and as a share of income.
- `fixed`: all fixed costs with the full mortgage payment, per month, as a share, and what is
  left of the income for the rest.
- `saving`: what went to savings and investments, without the mortgage repayment (shown
  separately as `repaid_cents`), per month and as a share of income.
- `debts`: the mortgage and the debts on Vermogen; `known` is false when there are none.
"""

from __future__ import annotations

import sqlite3

from . import networth
from .ledger import FIXED, Ledger

MONTHS = 12
HOUSING = ("wonen", "energie", "belastingen")


def _share(cents: float, income: float) -> float | None:
    return round(cents / income, 3) if income > 0 else None


def compute(conn: sqlite3.Connection, lg: Ledger, buffer: dict | None) -> dict | None:
    history = lg.complete_before(lg.current(), MONTHS)
    if len(history) < 2:
        return None
    flows = [lg.flows_for(p) for p in history]
    n = len(flows)
    income = sum(f.income for f in flows) / n
    fixed = sum(f.fixed - f.spread_fixed + f.repaid for f in flows) / n
    repaid = sum(f.repaid for f in flows) / n
    saved = sum(f.saved - f.repaid for f in flows) / n
    housing_ids = {lg.cat_ids[k] for k in HOUSING if k in lg.cat_ids}
    housing = sum(r["bucket"][2] + (r.get("repaid") or 0) for f in flows for r in f.rows
                  if r["bucket"][0] == FIXED and r["bucket"][1] in housing_ids and not r.get("part")) / n

    nw = networth.get(conn)
    debts = []
    home = nw.get("home")
    if home and home.get("debt_cents"):
        debts.append({"kind": "mortgage", "name": "Hypotheek", "cents": home["debt_cents"]})
    for a in nw.get("assets") or []:
        if a["kind"] == "debt" and (a.get("value_cents") or 0) > 0:
            debts.append({"kind": "debt", "name": a["name"], "cents": a["value_cents"],
                          "id": a["id"]})
    rnd = lambda x: int(round(x))  # noqa: E731
    return {
        "months": n,
        "income_cents": rnd(income),
        "buffer": None if not buffer else {
            "months": buffer["months"], "target_months": buffer["target_months"],
            "saved_cents": buffer["saved_cents"], "target_cents": buffer["target_cents"],
            "source": buffer["source"]},
        "housing": {"cents": rnd(housing), "share": _share(housing, income)},
        "fixed": {"cents": rnd(fixed), "share": _share(fixed, income),
                  "rest_cents": rnd(income - fixed)},
        "saving": {"cents": rnd(saved), "share": _share(saved, income), "repaid_cents": rnd(repaid)},
        "debts": {"known": bool(debts), "total_cents": sum(d["cents"] for d in debts),
                  "items": debts},
    }
