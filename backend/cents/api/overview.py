"""Overview, trends and the bakje / tag summaries (analytics, read-only)."""

from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends, Query

from ..errors import bad_request
from ..services import summary
from ..services.periods import period_by_id
from .categories import load_category
from .deps import get_conn
from .tags import load_tag

router = APIRouter()


def _check_period(period: str | None) -> str | None:
    """A period id "YYYY-MM" between 1971 and 2200 (anything else is a typo, never data)."""
    if period:
        try:
            period_by_id(period)
            ok = 1971 <= int(period[:4]) <= 2200
        except ValueError:
            ok = False
        if not ok:
            raise bad_request("Onbekende maand.", "bad_period")
    return period or None


@router.get("/overview")
def overview(period: str | None = None, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    return summary.overview(conn, _check_period(period))


@router.get("/trends")
def trends(periods: int = Query(default=12, ge=1, le=36),
           conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    return summary.trends(conn, periods)


@router.get("/categories/{category_id}/summary")
def category_summary(category_id: int, period: str | None = None,
                     conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    category = load_category(conn, category_id)
    return summary.category_summary(conn, category, _check_period(period))


@router.get("/tags/{tag_id}/summary")
def tag_summary(tag_id: int, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    load_tag(conn, tag_id)
    return summary.tag_summary(conn, tag_id)
