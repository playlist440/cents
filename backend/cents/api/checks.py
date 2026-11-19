"""Zelfcontrole: GET /checks (services/checks.py)."""

from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends

from ..services import checks
from .deps import get_conn

router = APIRouter()


@router.get("/checks")
def get_checks(conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    return checks.compute(conn)
