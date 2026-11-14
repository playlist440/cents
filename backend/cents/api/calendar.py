"""Payment calendar: GET /calendar?period=YYYY-MM."""

from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends

from ..errors import bad_request
from ..services import calendar
from .deps import get_conn
from .overview import _check_period

router = APIRouter()


@router.get("/calendar")
def get_calendar(period: str | None = None, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    period = _check_period(period)
    if period and calendar.too_far(conn, period):
        raise bad_request("Zo ver vooruit kijkt de kalender niet.", "bad_period")
    return calendar.get(conn, period)
