"""Dutch formatting for insight sentences: "€ 85" (non-breaking space, whole euros)."""

from __future__ import annotations

from datetime import date

from .periods import MONTHS_NL

NBSP = " "


def euro(cents: float) -> str:
    """Whole euros, rounded half up, thousands with a dot: 123456 -> '€ 1.235'."""
    euros = int((abs(cents) + 50) // 100)
    return f"€{NBSP}{euros:,}".replace(",", ".")


def percent(share: float) -> str:
    return f"{round(share * 100)}{NBSP}%"


def one_decimal(x: float) -> str:
    return f"{x:.1f}".replace(".", ",")


def month_name(day: date | str) -> str:
    if isinstance(day, str):
        day = date.fromisoformat(day)
    return MONTHS_NL[day.month - 1]


def day_month(day: date | str) -> str:
    if isinstance(day, str):
        day = date.fromisoformat(day)
    return f"{day.day} {MONTHS_NL[day.month - 1]}"


def period_month(period_id: str) -> str:
    """'2026-10' -> 'oktober'."""
    return MONTHS_NL[int(period_id[5:7]) - 1]
