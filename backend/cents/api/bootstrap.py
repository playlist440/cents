"""GET /bootstrap: everything the UI needs on start."""

from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends

from .. import db
from ..services import periods, suggestions
from ..services.imports import unsorted_merchant_count
from .accounts import account_json
from .categories import list_categories
from .deps import get_conn
from .tags import list_tags

router = APIRouter()


@router.get("/bootstrap")
def bootstrap(conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    start_day = periods.start_day_of(conn)
    first, last = periods.data_range(conn)
    today = periods.today()
    return {
        "settings": db.public_settings(conn),
        "accounts": [account_json(conn, a) for a in db.rows(conn, "SELECT * FROM accounts ORDER BY sort, id")],
        "categories": list_categories(conn),
        "tags": list_tags(conn),
        "periods": {
            "first": periods.period_for(first, start_day).id if first else None,
            "last": periods.period_for(last, start_day).id if last else None,
            "current": periods.period_for(today, start_day).id,
        },
        "has_data": first is not None,
        "unsorted_merchants": unsorted_merchant_count(conn),
        "suggestions": {"accounts": suggestions.account_suggestions(conn)},
    }
