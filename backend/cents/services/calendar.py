"""Payment calendar (SPEC 14): recurring fixed costs, income and savings transfers on their days.

For every item a schedule of expected dates is laid over the period (monthly: the usual day of
the month; other frequencies: steps from the last payment, months for quarterly and longer).
Payments of the item are matched one-to-one to the nearest slot within a tolerance, so a payment
made twice by mistake fills one slot (the duplicate insight covers the other). A slot in the
period is then `paid` (on the payment's date), `expected` (after "data today", or at most 5 days
overdue) or `missed` (more than 5 days before "data today"). A payment that fits no slot at all
is still shown as `paid` on its own date, unless it is a near-duplicate of another payment.
"""

from __future__ import annotations

import calendar as cal
import sqlite3
import statistics
from datetime import date, timedelta

from . import cache, ledger as ledger_mod, recurring
from .ledger import FIXED, INCOME, SAVING
from .periods import Period, period_json

MISSED_AFTER_DAYS = 5
FUTURE_PERIODS = 12
TOLERANCE = {"weekly": 3, "2-weekly": 6, "4-weekly": 10, "monthly": 12, "quarterly": 20,
             "half-year": 25, "yearly": 30}
STEP_DAYS = {"weekly": 7, "2-weekly": 14, "4-weekly": 28}
STEP_MONTHS = {"quarterly": 3, "half-year": 6, "yearly": 12}


def _add_months(day: date, n: int, wanted_day: int | None = None) -> date:
    index = day.year * 12 + day.month - 1 + n
    y, m = index // 12, index % 12 + 1
    return date(y, m, min(wanted_day or day.day, cal.monthrange(y, m)[1]))


def schedule(item: dict, dates: list[date], lo: date, hi: date) -> list[date]:
    """Expected payment dates of an item in [lo, hi], never before its first payment and, for
    an ended item, never after its last one."""
    freq = item["frequency"]
    first, last = dates[0], dates[-1]
    tol = timedelta(days=TOLERANCE[freq])
    out: list[date] = []
    if freq == "monthly":
        usual = int(statistics.median([d.day for d in dates[-6:]]))
        month = date(lo.year, lo.month, 1)
        while month <= hi:
            slot = date(month.year, month.month, min(usual, cal.monthrange(month.year, month.month)[1]))
            out.append(slot)
            month = _add_months(month, 1, 1)
    elif freq in STEP_DAYS:
        step = STEP_DAYS[freq]
        k = (lo - last).days // step - 1
        while True:
            slot = last + timedelta(days=step * k)
            if slot > hi:
                break
            out.append(slot)
            k += 1
    else:
        step = STEP_MONTHS[freq]
        k = ((lo.year - last.year) * 12 + lo.month - last.month) // step - 1
        while True:
            slot = _add_months(last, step * k, last.day)
            if slot > hi:
                break
            out.append(slot)
            k += 1
    end = last + tol if item["status"] == "ended" else hi
    return [s for s in out if lo <= s <= hi and s >= first - tol and s <= end]


def _match(slots: list[date], payments: list[dict], tol: int) -> dict[date, dict]:
    """One-to-one: closest (slot, payment) pairs first."""
    pairs = sorted(((abs((s - p["day"]).days), s, p["id"]) for s in slots for p in payments
                    if abs((s - p["day"]).days) <= tol), key=lambda x: (x[0], x[1], x[2]))
    by_id = {p["id"]: p for p in payments}
    used_slots: set[date] = set()
    used_pay: set[int] = set()
    out: dict[date, dict] = {}
    for _, slot, pid in pairs:
        if slot in used_slots or pid in used_pay:
            continue
        used_slots.add(slot)
        used_pay.add(pid)
        out[slot] = by_id[pid]
    return out


def calendar_items(lg: ledger_mod.Ledger, full: list[dict]) -> list[dict]:
    """The recurring items the calendar shows: fixed costs, income, savings transfers."""
    out = []
    for item in full:
        cat = lg.categories.get(item["category_id"] or -1, {})
        grp = "daily" if cat.get("key") == "unsorted" else cat.get("grp")
        if (grp == FIXED and item["direction"] == "out") or (grp == INCOME and item["direction"] == "in") \
                or grp == SAVING:
            out.append(item)
    return out


def build(conn: sqlite3.Connection, lg: ledger_mod.Ledger, p: Period) -> dict:
    rows_by_id = {r["id"]: r for r in lg.rows}
    current = lg.current()
    future = p.start > current.start
    data_today = lg.data_today
    entries: list[tuple[date, dict]] = []
    for item in calendar_items(lg, recurring.full_items(conn)):
        if future and item["status"] == "ended":
            continue
        payments = sorted(({"id": i, "day": date.fromisoformat(rows_by_id[i]["date"]),
                            "amount": rows_by_id[i]["amount_cents"]}
                           for i in item["_ids"] if i in rows_by_id), key=lambda x: (x["day"], x["id"]))
        if not payments:
            continue
        tol = TOLERANCE[item["frequency"]]
        dates = [x["day"] for x in payments]
        margin = timedelta(days=tol)
        slots = schedule(item, dates, p.start - margin, p.last + margin)
        matched = _match(slots, [x for x in payments
                                 if p.start - margin <= x["day"] <= p.last + margin], tol)
        base = {"key": item["key"], "name": item["name"], "merchant_key": item["merchant_key"],
                "category_id": item["category_id"], "direction": item["direction"]}
        used = {x["id"] for x in matched.values()}
        for slot in slots:
            pay = matched.get(slot)
            if pay is not None:
                if p.contains(pay["day"]):
                    entries.append((pay["day"], {**base, "amount_cents": pay["amount"], "status": "paid",
                                                 "transaction_id": pay["id"]}))
                continue
            if not p.contains(slot):
                continue
            if future or slot > data_today - timedelta(days=MISSED_AFTER_DAYS):
                status = "expected"
            else:
                status = "missed"
            entries.append((slot, {**base, "amount_cents": item["amount_cents"], "status": status,
                                   "transaction_id": None}))
        # payments that fit no slot: shown on their own date, unless they are a near-duplicate
        for pay in payments:
            if pay["id"] in used or not p.contains(pay["day"]):
                continue
            near = [q for q in payments if q["id"] != pay["id"] and abs((q["day"] - pay["day"]).days) <= 3]
            if near:
                continue
            entries.append((pay["day"], {**base, "amount_cents": pay["amount"], "status": "paid",
                                         "transaction_id": pay["id"]}))

    # subscriptions entered by hand: on their expected days, marked `manual`; not in the totals
    # (paid from a private account or already in the credit-card file)
    from . import manual_subs
    for m in manual_subs.items(conn, lg.today):
        if m["status"] == "ended":
            continue
        for day in recurring.occurrences({**m, "next_date": m["next_date"]}, p.start, p.last + timedelta(days=1)):
            entries.append((day, {"key": m["key"], "name": m["name"], "merchant_key": None, "category_id": m["category_id"],
                                  "direction": "out", "amount_cents": m["amount_cents"], "status": "expected",
                                  "transaction_id": None, "manual": True}))
        # past days of this period, before next_date
        d = date.fromisoformat(m["start_date"])
        for day in recurring.occurrences({**m, "next_date": m["start_date"]}, max(p.start, d), min(lg.today, p.last + timedelta(days=1))):
            entries.append((day, {"key": m["key"], "name": m["name"], "merchant_key": None, "category_id": m["category_id"],
                                  "direction": "out", "amount_cents": m["amount_cents"], "status": "expected",
                                  "transaction_id": None, "manual": True}))
    entries.sort(key=lambda e: (e[0], e[1]["direction"] != "in", e[1]["name"]))
    days: list[dict] = []
    for day, item in entries:
        if not days or days[-1]["date"] != day.isoformat():
            days.append({"date": day.isoformat(), "items": []})
        days[-1]["items"].append(item)
    out_tot = {"paid_cents": 0, "expected_cents": 0, "missed_cents": 0}
    in_tot = {"paid_cents": 0, "expected_cents": 0}
    for _, item in entries:
        if item.get("manual"):
            continue
        amount = abs(item["amount_cents"])
        if item["direction"] == "out":
            out_tot[f"{item['status']}_cents"] += amount
        elif item["status"] in ("paid", "expected"):
            in_tot[f"{item['status']}_cents"] += amount     # missed income: shown, not totalled
    return {"period": period_json(p, lg.start_day, now=lg.today, first=lg.first, last=lg.last),
            "days": days, "out": out_tot, "in": in_tot}


def get(conn: sqlite3.Connection, period_id: str | None) -> dict:
    lg = ledger_mod.get(conn)
    p = lg.period(period_id) if period_id else lg.current()
    return cache.memo(conn, f"calendar:{p.id}", lambda: build(conn, lg, p))


def too_far(conn: sqlite3.Connection, period_id: str) -> bool:
    lg = ledger_mod.get(conn)
    return lg.period(period_id).start > lg.shift(lg.current(), FUTURE_PERIODS).start
