"""Automatic prices: GET /prices/status, POST /prices/refresh ("Nu bijwerken")."""

from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends, Request

from .. import db
from ..errors import ApiError
from ..services import prices
from .deps import get_conn

router = APIRouter()


@router.get("/prices/status")
def price_status(conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    return prices.status(conn)


@router.post("/prices/refresh")
def refresh_prices(request: Request) -> dict:
    """Runs the fetch now (in this worker thread, with its own connections)."""
    conn = db.connect(request.app.state.db_path)
    try:
        if not prices.enabled(conn):
            raise ApiError(409, "disabled", "Koersen ophalen staat uit.")
    finally:
        conn.close()
    result = prices.refresh(request.app.state.db_path, force=True)
    conn = db.connect(request.app.state.db_path)
    try:
        out = prices.status(conn)
    finally:
        conn.close()
    out["result"] = {"ok": result.get("ok", False), "updated": result.get("updated", 0)}
    return out
