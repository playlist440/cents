"""The single place that computes period ("maand") boundaries.

A period starts on `month_start_day` (1-28) and runs until the next start: [start, end).
Its id is the YYYY-MM of the calendar month holding most of its days. To keep exactly one
period per calendar month, that month is fixed per start day: start day 1-15 -> the month the
period starts in, 16-28 -> the next month (see docs/DECISIONS.md).
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from ..config import TIMEZONE
from .. import db

MONTHS_NL = ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus",
             "september", "oktober", "november", "december"]


@dataclass(frozen=True)
class Period:
    id: str            # "2026-11"
    start: date        # first day (inclusive)
    end: date          # first day of the next period (exclusive)

    @property
    def last(self) -> date:
        return self.end - timedelta(days=1)

    @property
    def days_total(self) -> int:
        return (self.end - self.start).days

    @property
    def label(self) -> str:
        year, month = (int(x) for x in self.id.split("-"))
        return f"{MONTHS_NL[month - 1]} {year}"

    def contains(self, day: date) -> bool:
        return self.start <= day < self.end


def today() -> date:
    return datetime.now(ZoneInfo(TIMEZONE)).date()


def _add_months(year: int, month: int, delta: int) -> tuple[int, int]:
    index = year * 12 + (month - 1) + delta
    return index // 12, index % 12 + 1


def _check(start_day: int) -> int:
    start_day = int(start_day)
    if not 1 <= start_day <= 28:
        raise ValueError("month_start_day must be 1..28")
    return start_day


def _id_offset(start_day: int) -> int:
    """Months between the start month and the id month."""
    return 0 if start_day <= 15 else 1


def period_for(day: date, start_day: int = 1) -> Period:
    """The period containing `day`."""
    start_day = _check(start_day)
    if day.day >= start_day:
        y, m = day.year, day.month
    else:
        y, m = _add_months(day.year, day.month, -1)
    return _from_start_month(y, m, start_day)


def _from_start_month(year: int, month: int, start_day: int) -> Period:
    start = date(year, month, start_day)
    ny, nm = _add_months(year, month, 1)
    end = date(ny, nm, start_day)
    iy, im = _add_months(year, month, _id_offset(start_day))
    return Period(f"{iy:04d}-{im:02d}", start, end)


def period_by_id(period_id: str, start_day: int = 1) -> Period:
    """Parse "YYYY-MM" and return that period. Raises ValueError on a bad id."""
    start_day = _check(start_day)
    try:
        year, month = (int(x) for x in period_id.split("-"))
        date(year, month, 1)
    except (ValueError, AttributeError):
        raise ValueError(f"bad period id {period_id!r}") from None
    sy, sm = _add_months(year, month, -_id_offset(start_day))
    return _from_start_month(sy, sm, start_day)


def shift(period: Period, n: int, start_day: int = 1) -> Period:
    """The period n steps later (negative = earlier)."""
    year, month = (int(x) for x in period.id.split("-"))
    y, m = _add_months(year, month, n)
    return period_by_id(f"{y:04d}-{m:02d}", start_day)


def periods_between(first: Period, last: Period, start_day: int = 1) -> list[Period]:
    out, p = [], first
    while p.start <= last.start:
        out.append(p)
        p = shift(p, 1, start_day)
    return out


def complete_periods_before(period: Period, n: int, start_day: int = 1) -> list[Period]:
    """Up to n periods directly before `period`, most recent first."""
    return [shift(period, -i, start_day) for i in range(1, n + 1)]


# ---------------------------------------------------------------- years

def is_year_id(value: str | None) -> bool:
    """A year id is four digits ("2026"); a period id is "YYYY-MM"."""
    return bool(value) and len(value) == 4 and value.isdigit()


def year_periods(year: int, start_day: int = 1) -> list[Period]:
    """The twelve periods whose id lies in `year` ("2026-01" .. "2026-12"). With a late start
    day the first one starts in December of the year before (the id rule above)."""
    return [period_by_id(f"{year:04d}-{m:02d}", start_day) for m in range(1, 13)]


def started_year_periods(year: int, start_day: int = 1, now: date | None = None) -> list[Period]:
    """The periods of `year` that have started on `now` (year to date for the current year,
    all twelve for a past year, none for a future year)."""
    now = now or today()
    return [p for p in year_periods(year, start_day) if p.start <= now]


# ---------------------------------------------------------------- database-aware helpers

def start_day_of(conn: sqlite3.Connection) -> int:
    return int(db.get_setting(conn, "month_start_day", 1) or 1)


def data_range(conn: sqlite3.Connection) -> tuple[date | None, date | None]:
    r = db.row(conn, "SELECT MIN(date) AS lo, MAX(date) AS hi FROM transactions")
    if not r or not r["lo"]:
        return None, None
    return date.fromisoformat(r["lo"]), date.fromisoformat(r["hi"])


def last_imported(conn: sqlite3.Connection, now: date | None = None) -> date | None:
    """Latest date of an imported transaction on a visible checking or savings account, never
    after today. Manual entries and future-dated rows say nothing about how fresh the data is."""
    now = now or today()
    hi = db.value(conn, """SELECT MAX(t.date) FROM transactions t JOIN accounts a ON a.id = t.account_id
                           WHERE t.manual = 0 AND a.hidden = 0 AND a.type IN ('checking', 'savings')
                           AND t.date <= ?""", (now.isoformat(),))
    return date.fromisoformat(hi) if hi else None


def data_today(conn: sqlite3.Connection, now: date | None = None) -> date:
    """min(today, latest imported transaction + 3 days): stale data must not look like a quiet
    month."""
    now = now or today()
    hi = last_imported(conn, now)
    if hi is None:
        return now
    return min(now, hi + timedelta(days=3))


def period_json(period: Period, start_day: int = 1, now: date | None = None,
                first: date | None = None, last: date | None = None) -> dict:
    """The API `Period` object. `first`/`last` are the data range (prev/next become null
    outside it; next is never beyond the current period)."""
    now = now or today()
    current = period_for(now, start_day)
    if period.contains(now):
        day_index = (now - period.start).days + 1
    elif period.end <= now:
        day_index = period.days_total
    else:
        day_index = 0
    prev_p = shift(period, -1, start_day)
    next_p = shift(period, 1, start_day)
    has_prev = first is not None and prev_p.end > first
    has_next = next_p.start <= max(current.start, last or current.start)
    return {
        "id": period.id,
        "label": period.label,
        "from": period.start.isoformat(),
        "to": period.last.isoformat(),
        "is_current": period.id == current.id,
        "day_index": day_index,
        "days_total": period.days_total,
        "prev": prev_p.id if has_prev else None,
        "next": next_p.id if has_next else None,
    }


def resolve(conn: sqlite3.Connection, period_id: str | None) -> Period:
    """Period from an API parameter; None means the current one."""
    sd = start_day_of(conn)
    if not period_id:
        return period_for(today(), sd)
    return period_by_id(period_id, sd)
