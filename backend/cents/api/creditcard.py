"""Creditcard-invulbestand: GET /creditcard/template (services/cardfile.py)."""

from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends
from fastapi.responses import Response

from ..services import cardfile
from .deps import get_conn

router = APIRouter()

XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


@router.get("/creditcard/template")
def card_template(conn: sqlite3.Connection = Depends(get_conn)) -> Response:
    return Response(cardfile.template(conn), media_type=XLSX,
                    headers={"Content-Disposition": 'attachment; filename="cents-creditcard.xlsx"'})
