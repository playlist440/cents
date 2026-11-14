"""The sort queue: merchants without a bakje."""

from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends, Query

from ..services import learning
from ..services.imports import unsorted_merchant_count
from ..schemas import SortBody
from .deps import get_conn
from .transactions import check_category

router = APIRouter()


@router.get("/sort/queue")
def sort_queue(limit: int = Query(default=200, ge=1, le=1000),
               conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    return learning.sort_queue(conn, limit=limit)


@router.post("/sort")
def sort_merchant(body: SortBody, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    check_category(conn, body.category_id)
    updated = learning.set_merchant_category(conn, body.merchant_key, body.category_id)
    return {"updated_count": updated, "remaining": unsorted_merchant_count(conn)}
