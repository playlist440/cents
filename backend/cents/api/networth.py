"""Net worth: GET /networth."""

from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends

from ..services import networth
from .deps import get_conn

router = APIRouter()


@router.get("/networth")
def get_networth(conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    data = networth.get(conn)
    return {"total_cents": data["total_cents"],
            "accounts": [dict(a) for a in data["accounts"]],
            "series": [dict(s) for s in data["series"]],
            "home": dict(data["home"]) if data.get("home") else None}
