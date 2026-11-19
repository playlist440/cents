"""Subscriptions entered by hand: paid by credit card or from a private account, so Cents cannot
see them in a bank file. They appear in Vaste lasten (as recurring items with `manual: true`)
and in the subscriptions total, never in the budget figures (monthly fixed costs, Nog te
besteden, health): that money is already counted elsewhere (pocket money, the card file)."""

from __future__ import annotations

import calendar
import sqlite3
from datetime import date, timedelta

from .. import db

FREQS = {"weekly": (7, 52), "4-weekly": (28, 13), "monthly": (0, 12), "yearly": (0, 1)}


def _add_months(d: date, months: int, day: int) -> date:
    y, m = divmod(d.month - 1 + months, 12)
    y, m = d.year + y, m + 1
    return date(y, m, min(day, calendar.monthrange(y, m)[1]))


def next_date(start: date, freq: str, today: date) -> date:
    """First payment day on or after today, stepping from the start date."""
    if freq in ("weekly", "4-weekly"):
        step = FREQS[freq][0]
        if start >= today:
            return start
        return start + timedelta(days=-(-(today - start).days // step) * step)
    months = 12 if freq == "yearly" else 1
    n, d = 0, start
    while d < today:
        n += months
        d = _add_months(start, n, start.day)
    return d


def as_item(r: dict, today: date) -> dict:
    start = date.fromisoformat(r["start_date"])
    ended = bool(r["end_date"]) and r["end_date"] <= today.isoformat()
    per_year = r["amount_cents"] * FREQS[r["frequency"]][1]
    return {
        "key": f"manual:{r['id']}", "id": r["id"], "manual": True,
        "name": r["name"], "merchant_key": None, "category_id": r["category_id"],
        "direction": "out", "amount_cents": -r["amount_cents"], "frequency": r["frequency"],
        "per_month_cents": -int(round(per_year / 12)), "per_year_cents": per_year,
        "start_date": r["start_date"], "end_date": r["end_date"], "paid_from": r["paid_from"],
        "last_date": r["end_date"] if ended else None,
        "next_date": None if ended else next_date(start, r["frequency"], today).isoformat(),
        "day_of_month": start.day if r["frequency"] == "monthly" else None,
        "status": "ended" if ended else "active", "variable": False, "count": None, "change": None,
        "own_account": False, "via_card": False, "tx_ids": [],
    }


def items(conn: sqlite3.Connection, today: date) -> list[dict]:
    return [as_item(r, today) for r in db.rows(conn, "SELECT * FROM manual_subscriptions ORDER BY name COLLATE NOCASE")]
