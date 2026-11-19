"""Bespaarlijst: GET /besparen (services/besparen.py)."""

from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends

from ..services import besparen
from .deps import get_conn

router = APIRouter()


@router.get("/besparen")
def get_besparen(conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    return besparen.compute(conn)
