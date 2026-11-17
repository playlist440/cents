"""Net worth (SPEC 7 "Balances", 10 GET /networth).

- Checking / savings: `balance_after_cents` of the latest transaction, else the manual balance.
- Investment: invested = transfers out of checking to the account minus transfers back.
  Value = the latest manual value plus the net transfers made after that value's date (money
  moved in later is known; nothing is interpolated). Without any value: value = invested.
  With holdings (trades imported or entered): value = market value of the funds + estimated
  cash (services/investments.py); history from daily prices.
- Credit card: outstanding = manual purchases not yet explained by a settlement; the balance
  is minus that.
- Home (SPEC 7.2): `home` = {home_cents, debt_cents, equity_cents, included}; when included
  (setting on and a home value known) the overwaarde counts in `total_cents` and in the series
  (`home_cents` per point = home value − estimated debt at month end).
- Other items (SPEC 7.3): `assets` lists pension, debt and other items with `signed_cents`
  (debt negative) and `include`; included ones count in `total_cents` and in the series
  (`assets_cents` per point, only when at least one item is included). `pension_excluded_cents`
  = the pension not counted (shown as "Pensioen (later beschikbaar)"), else None.
- Series: one point per calendar month (month end, today for the current month), each account
  carrying its last known value forward; before an account's first known value it counts 0.
"""

from __future__ import annotations

import bisect
import calendar
import sqlite3
from datetime import date

from .. import db
from . import assets as assets_mod, cache, investments, ledger as ledger_mod, mortgage

TYPES = ("checking", "savings", "investment", "credit")


def _month_end(y: int, m: int) -> date:
    return date(y, m, calendar.monthrange(y, m)[1])


class _Timeline:
    """Known values of one account over time; value_at(day) carries the last one forward."""

    def __init__(self, points: list[tuple[str, int]]):
        points = sorted(points, key=lambda p: p[0])
        self.days = [p[0] for p in points]
        self.values = [p[1] for p in points]

    def value_at(self, day: str) -> int | None:
        i = bisect.bisect_right(self.days, day)
        return self.values[i - 1] if i else None


def _balance_points(conn: sqlite3.Connection, account_id: int) -> list[tuple[str, int]]:
    rows = db.rows(conn, """SELECT date, balance_after_cents FROM transactions
                            WHERE account_id = ? AND balance_after_cents IS NOT NULL
                            ORDER BY date, seq, id""", (account_id,))
    last_per_day: dict[str, int] = {}
    for r in rows:
        last_per_day[r["date"]] = r["balance_after_cents"]
    return list(last_per_day.items())


def _investment(conn: sqlite3.Connection, account: dict) -> dict:
    """Invested and value timelines of an investment account."""
    flows = db.rows(conn, """
        SELECT t.date, t.amount_cents FROM transactions t JOIN accounts a ON a.id = t.account_id
        WHERE t.transfer_account_id = ? AND a.type = 'checking' ORDER BY t.date, t.id""",
                    (account["id"],))
    invested_points, total = [], 0
    for f in flows:
        total += -f["amount_cents"]
        invested_points.append((f["date"], total))
    values = db.rows(conn, "SELECT id, date, value_cents FROM account_values WHERE account_id = ? "
                           "ORDER BY date, id", (account["id"],))
    invested = _Timeline(invested_points)

    def value_at(day: str) -> int | None:
        known = [v for v in values if v["date"] <= day]
        inv_now = invested.value_at(day)
        if not known:
            return inv_now
        last = known[-1]
        moved_since = (inv_now or 0) - (invested.value_at(last["date"]) or 0)
        return last["value_cents"] + moved_since

    return {"invested": invested, "values": values, "value_at": value_at}


def compute(conn: sqlite3.Connection) -> dict:
    lg = ledger_mod.get(conn)
    today = lg.today.isoformat()
    accounts = db.rows(conn, "SELECT * FROM accounts ORDER BY sort, id")
    out_accounts, timelines = [], []
    first_days: list[str] = []
    for a in accounts:
        item = {"id": a["id"], "name": a["name"], "type": a["type"], "iban": a["iban"],
                "balance_cents": None, "as_of": None}
        if a["type"] in ("checking", "savings"):
            points = _balance_points(conn, a["id"])
            if points:
                item["balance_cents"], item["as_of"] = points[-1][1], points[-1][0]
            elif a["manual_balance_cents"] is not None:
                item["balance_cents"] = a["manual_balance_cents"]
                item["as_of"] = a["manual_balance_date"]
                points = [(a["manual_balance_date"] or today, a["manual_balance_cents"])]
            timeline = _Timeline(points)
            timelines.append((a["type"], timeline.value_at))
            if points:
                first_days.append(points[0][0])
        elif a["type"] == "investment" and investments.has_holdings(conn, a["id"]):
            h = investments.holdings(conn, a["id"], today)
            value_at, first = investments.value_timeline(conn, a["id"])
            item.update({
                "balance_cents": h["value_cents"], "as_of": h["price_date"],
                "invested_cents": h["invested_cents"], "result_cents": h["result_cents"],
                "result_pct": h["result_pct"], "price_result_cents": h["price_result_cents"],
                "market_value_cents": h["market_value_cents"], "cash_cents": h["cash_cents"],
                "dividends_cents": h["dividends_cents"], "costs_cents": h["costs_cents"],
                "price_stale": h["price_stale"], "has_holdings": True,
                "holdings_count": sum(1 for x in h["holdings"] if x["quantity"] > 0),
                "values": []})
            timelines.append(("investment", value_at))
            dep = investments._deposits(conn, a["id"])
            first_days += [d for d in ([first] + [p[0] for p in dep[:1]]) if d]
        elif a["type"] == "investment":
            inv = _investment(conn, a)
            invested = inv["invested"].value_at(today) or 0
            value = inv["value_at"](today)
            last_value = inv["values"][-1] if inv["values"] else None
            item["balance_cents"] = value if value is not None else (
                a["manual_balance_cents"] if a["manual_balance_cents"] is not None else 0)
            item["as_of"] = last_value["date"] if last_value else None
            item["invested_cents"] = invested
            item["result_cents"] = (item["balance_cents"] - invested) if last_value else None
            item["values"] = [{"id": v["id"], "date": v["date"], "value_cents": v["value_cents"]}
                              for v in inv["values"]]
            timelines.append(("investment", inv["value_at"]))
            first_days += [d for d in (inv["invested"].days[:1] + [v["date"] for v in inv["values"][:1]])]
        elif a["type"] == "credit":
            state = lg.credit.get(a["id"], {"outstanding": 0, "events": [], "last_unexplained": None})
            outstanding = max(0, state["outstanding"])
            item["balance_cents"] = -outstanding
            item["as_of"] = state["events"][-1][0] if state["events"] else None
            item["outstanding_cents"] = outstanding
            item["unexplained_cents"] = state["last_unexplained"] or 0
            credit_line = _Timeline(state["events"])
            timelines.append(("credit", lambda day, t=credit_line: -max(0, t.value_at(day) or 0)))
            if state["events"]:
                first_days.append(state["events"][0][0])
        else:
            timelines.append(("other", lambda day: None))
        item["hidden"] = bool(a["hidden"])
        out_accounts.append(item)

    visible = [a for a in out_accounts if not a["hidden"]]
    total = sum(a["balance_cents"] or 0 for a in visible)
    lines = [line for line, a in zip(timelines, out_accounts) if not a["hidden"]]
    home = mortgage.networth_part(conn, lg)
    est = home.pop("_estimator") if home else None
    if home and home["included"]:
        total += home["equity_cents"]
    asset_items, counted = assets_mod.networth_part(conn, lg)
    total += sum(a["signed_cents"] for a in asset_items if a["include"])
    excluded = [a["value_cents"] for a in asset_items
                if a["kind"] == "pension" and not a["include"] and a["value_cents"] is not None]

    series = []
    if first_days:
        start = min(first_days)
        y, m = int(start[:4]), int(start[5:7])
        now = lg.today
        while (y, m) <= (now.year, now.month):
            end = min(_month_end(y, m), now).isoformat()
            point = {"month": f"{y:04d}-{m:02d}", "checking_cents": 0, "savings_cents": 0,
                     "investment_cents": 0, "credit_cents": 0}
            for kind, fn in lines:
                if kind in TYPES:
                    point[f"{kind}_cents"] += fn(end) or 0
            point["total_cents"] = sum(point[f"{k}_cents"] for k in TYPES)
            if home and home["included"]:
                point["home_cents"] = est.equity(end) or 0
                point["total_cents"] += point["home_cents"]
            if counted:
                point["assets_cents"] = sum(it.signed(end) for it in counted)
                point["total_cents"] += point["assets_cents"]
            series.append(point)
            y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    for a in visible:
        a.pop("hidden", None)
    return {"total_cents": total, "accounts": visible, "series": series, "home": home,
            "assets": asset_items, "pension_excluded_cents": sum(excluded) if excluded else None}


def get(conn: sqlite3.Connection) -> dict:
    """GET /networth (cached; do not mutate)."""
    return cache.memo(conn, "networth", lambda: compute(conn))


def balance_of_type(conn: sqlite3.Connection, kind: str) -> int | None:
    """Sum of the known balances of visible accounts of one type (None when there is none)."""
    found = [a["balance_cents"] for a in get(conn)["accounts"]
             if a["type"] == kind and a["balance_cents"] is not None]
    return sum(found) if found else None
