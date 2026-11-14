"""Recurring payments: GET /recurring, POST /recurring/ignore."""

from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends

from ..schemas import RecurringIgnoreBody
from ..services import recurring
from .deps import get_conn

router = APIRouter()


@router.get("/recurring")
def list_recurring(conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    return recurring.recurring_json(conn)


@router.post("/recurring/ignore")
def ignore_recurring(body: RecurringIgnoreBody, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    recurring.ignore(conn, body.key.strip())
    return {"ok": True}
