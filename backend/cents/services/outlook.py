"""The holistic "now" figures of the Overzicht (SPEC 9 "Vrij geld, tempo, betaalrekening").

- `free`: checking + savings balances − money in active potjes − buffer − fixed costs still
  due before the next salary − outstanding credit-card purchases. Moving money between own
  accounts never changes it (both balances are counted; transfers to savings are no cost).
- `tempo`: mean monthly result (income − fixed − daily) over the last three complete periods,
  plus up to twelve complete periods for a mini chart. Saving is not spending and money back
  from savings is not income (the ledger already does that). `None` with < 2 complete periods.
- `checking_warning`: day-by-day projection of the main checking account until the next
  salary (upcoming fixed costs and savings transfers on their dates, typical daily spending per
  day). Only returned when the lowest point drops below the floor.

Assumptions (services/assumptions.py): `payday_day`, `buffer`, `checking_floor_cents`.
"""

from __future__ import annotations

import calendar
import math
import sqlite3
from datetime import date, timedelta

from .. import db
from . import assumptions as assumptions_mod
from . import goals as goals_mod
from . import networth, recurring
from .ledger import FIXED, INCOME, SAVING, Ledger

STALE_DAYS = 5
TEMPO_MONTHS = 3
CHART_MONTHS = 12


def _group(lg: Ledger, item: dict) -> str | None:
    return lg.categories.get(item["category_id"] or -1, {}).get("grp")


def _day_in_month(y: int, m: int, day: int) -> date:
    return date(y, m, min(day, calendar.monthrange(y, m)[1]))


def payday(conn: sqlite3.Connection, lg: Ledger, items: list[dict]) -> tuple[date, str]:
    """Next salary date after today and how it was found: `setting`, `salary` or `period`."""
    today = lg.today
    setting = assumptions_mod.get(conn)["payday_day"]["day"]
    if isinstance(setting, int):
        d = _day_in_month(today.year, today.month, setting)
        if d <= today:
            y, m = (today.year + 1, 1) if today.month == 12 else (today.year, today.month + 1)
            d = _day_in_month(y, m, setting)
        return d, "setting"
    income = [i for i in items if i["direction"] == "in" and i["status"] != "ended"
              and _group(lg, i) == INCOME]
    if income:
        main = max(income, key=lambda i: i["amount_cents"])
        nxt = recurring.occurrences(main, today + timedelta(days=1), today + timedelta(days=400))
        if nxt:
            return nxt[0], "salary"
    return lg.current().end, "period"


def _spend_items(lg: Ledger, items: list[dict], start: date, end: date,
                 groups: tuple[str, ...]) -> list[tuple[dict, date]]:
    out = []
    for i in items:
        if i["direction"] == "out" and _group(lg, i) in groups:
            out += [(i, d) for d in recurring.occurrences(i, start, end)]
    return out


def buffer_target(conn: sqlite3.Connection, lg: Ledger, items: list[dict]) -> int:
    setting = assumptions_mod.get(conn)["buffer"]
    if setting.get("amount_cents") is not None:
        return max(0, int(setting["amount_cents"]))
    history = lg.complete_before(lg.current(), 6)
    if history:
        monthly = sum(lg.flows_for(p).fixed for p in history) / len(history)
    else:
        monthly = -sum(i["per_month_cents"] for i in items if i["direction"] == "out"
                       and i["status"] != "ended" and _group(lg, i) == FIXED)
    return max(0, int(round(monthly * float(setting.get("months") or 0))))


def free(conn: sqlite3.Connection, lg: Ledger, items: list[dict]) -> dict | None:
    accounts = [a for a in networth.get(conn)["accounts"]
                if a["type"] in ("checking", "savings") and a["balance_cents"] is not None]
    if not accounts:
        return None
    balances = sum(a["balance_cents"] for a in accounts)
    savings = sum(a["balance_cents"] for a in accounts if a["type"] == "savings")
    as_of = max((a["as_of"] for a in accounts if a["as_of"]), default=None)
    credit = sum(a.get("outstanding_cents") or 0 for a in networth.get(conn)["accounts"]
                 if a["type"] == "credit")

    active = goals_mod.overview(conn)["goals"]
    in_goals = sum(max(0, g["saldo_cents"]) for g in active)
    # potjes live on the savings account(s); never subtract more than is there
    goals_cents = min(in_goals, max(0, savings)) if savings > 0 else 0
    # a potje called "buffer" already holds (part of) the buffer
    buffer_goal = sum(max(0, g["saldo_cents"]) for g in active if "buffer" in g["name"].lower())
    buffer_cents = max(0, buffer_target(conn, lg, items) - buffer_goal)

    pay, source = payday(conn, lg, items)
    start = (date.fromisoformat(as_of) + timedelta(days=1)) if as_of else lg.today
    fixed = -sum(i["amount_cents"] for i, _ in _spend_items(lg, items, start, pay, (FIXED,)))
    total = balances - goals_cents - buffer_cents - fixed - credit
    stale = bool(as_of) and (lg.today - date.fromisoformat(as_of)).days > STALE_DAYS
    return {"total_cents": total, "balances_cents": balances, "goals_cents": goals_cents,
            "buffer_cents": buffer_cents, "fixed_until_payday_cents": fixed,
            "credit_cents": credit, "payday": pay.isoformat(), "payday_source": source,
            "as_of": as_of, "stale": stale,
            "accounts": [{"name": a["name"], "type": a["type"], "balance_cents": a["balance_cents"],
                          "as_of": a["as_of"]} for a in accounts]}


def _net(lg: Ledger, p) -> int:
    f = lg.flows_for(p)
    return f.income - f.fixed - f.daily


def tempo(lg: Ledger) -> dict | None:
    complete = lg.complete_before(lg.current(), CHART_MONTHS)   # most recent first
    if len(complete) < 2:
        return None
    recent = complete[:TEMPO_MONTHS]
    avg = int(round(sum(_net(lg, p) for p in recent) / len(recent)))
    since = recent[-1]
    if avg < 0:      # the start of the run of short months, if it is longer
        run = []
        for p in complete:
            if _net(lg, p) >= 0:
                break
            run.append(p)
        if len(run) > len(recent):
            since = run[-1]
    return {"avg_net_cents": avg, "periods": len(recent), "since": since.id,
            "months": [{"period": p.id, "net_cents": _net(lg, p)} for p in reversed(complete)]}


def daily_pace(lg: Ledger) -> float:
    """Typical daily spending per day over the recent complete periods (cents)."""
    recent = lg.complete_before(lg.current(), TEMPO_MONTHS)
    days = sum(p.days_total for p in recent)
    return sum(lg.flows_for(p).daily for p in recent) / days if days else 0.0


def main_checking(conn: sqlite3.Connection) -> dict | None:
    accounts = [a for a in networth.get(conn)["accounts"]
                if a["type"] == "checking" and a["balance_cents"] is not None]
    if not accounts:
        return None
    counts = {r["account_id"]: r["n"] for r in db.rows(
        conn, "SELECT account_id, COUNT(*) AS n FROM transactions GROUP BY account_id")}
    return max(accounts, key=lambda a: (counts.get(a["id"], 0), a["balance_cents"]))


def checking_warning(conn: sqlite3.Connection, lg: Ledger, items: list[dict],
                     pay: date) -> dict | None:
    acc = main_checking(conn)
    if acc is None or len(lg.complete_before(lg.current(), 6)) < 1:
        return None
    floor = assumptions_mod.get(conn)["checking_floor_cents"]["cents"]
    start = (date.fromisoformat(acc["as_of"]) + timedelta(days=1)) if acc["as_of"] else lg.today
    if pay <= start:
        return None
    due: dict[date, int] = {}
    for i, d in _spend_items(lg, items, start, pay, (FIXED, SAVING)):
        due[d] = due.get(d, 0) + i["amount_cents"]
    per_day = daily_pace(lg)
    balance, low, low_day = float(acc["balance_cents"]), None, None
    day = start
    while day < pay:
        balance += due.get(day, 0) - per_day
        if day >= lg.today and (low is None or balance < low):
            low, low_day = balance, day
        day += timedelta(days=1)
    if low is None or low >= floor:
        return None
    low_cents = int(math.floor(low))
    need = floor - low_cents
    suggest = int(math.ceil(need / 5000) * 5000)
    savings = networth.balance_of_type(conn, "savings") or 0
    return {"date": low_day.isoformat(), "low_cents": low_cents, "floor_cents": floor,
            "suggest_cents": suggest if savings >= suggest else None,
            "account_id": acc["id"], "payday": pay.isoformat()}


def compute(conn: sqlite3.Connection, lg: Ledger) -> dict:
    """The three figures for the current period."""
    items = recurring.items(conn)
    f = free(conn, lg, items)
    pay = date.fromisoformat(f["payday"]) if f else payday(conn, lg, items)[0]
    return {"free": f, "tempo": tempo(lg), "checking_warning": checking_warning(conn, lg, items, pay)}

