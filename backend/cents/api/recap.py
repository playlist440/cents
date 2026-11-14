"""Recap ("Terugblik"): GET /recap?period=YYYY-MM | ?year=YYYY, GET /recap/index."""

from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends

from ..errors import bad_request
from ..services import recap
from .deps import get_conn
from .overview import _check_period

router = APIRouter()


@router.get("/recap/index")
def recap_index(conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    return recap.index(conn)


@router.get("/recap")
def get_recap(period: str | None = None, year: str | None = None,
              conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    if year is not None:
        if not year.isdigit() or not 1971 <= int(year) <= 2200 or recap.is_future_year(conn, int(year)):
            raise bad_request("Onbekend jaar.", "bad_year")
        return recap.year_recap(conn, int(year))
    period = _check_period(period)
    if period and recap.is_future_period(conn, period):
        raise bad_request("Deze maand is nog niet begonnen.", "bad_period")
    return recap.period_recap(conn, period)
