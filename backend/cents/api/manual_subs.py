"""Subscriptions entered by hand: POST/PATCH/DELETE /subscriptions."""

from __future__ import annotations

import sqlite3
from datetime import date
from typing import Annotated, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from .. import db
from ..errors import ApiError, not_found
from ..services import manual_subs, periods
from .deps import get_conn

router = APIRouter()
Freq = Literal["weekly", "4-weekly", "monthly", "yearly"]


class SubBody(BaseModel):
    name: Annotated[str, Field(min_length=1, max_length=80)]
    amount_cents: Annotated[int, Field(gt=0, le=10_000_000)]
    frequency: Freq
    start_date: date
    end_date: date | None = None
    category_id: int | None = None
    paid_from: Annotated[str, Field(max_length=60)] | None = None


class SubPatch(BaseModel):
    name: Annotated[str, Field(min_length=1, max_length=80)] | None = None
    amount_cents: Annotated[int, Field(gt=0, le=10_000_000)] | None = None
    frequency: Freq | None = None
    start_date: date | None = None
    end_date: date | None = None
    category_id: int | None = None
    paid_from: Annotated[str, Field(max_length=60)] | None = None


def _check(conn, cat_id):
    if cat_id is not None and not db.value(conn, "SELECT 1 FROM categories WHERE id = ?", (cat_id,)):
        raise ApiError(422, "invalid", "Dit bakje bestaat niet (meer).")


def _out(conn, sid):
    r = db.row(conn, "SELECT * FROM manual_subscriptions WHERE id = ?", (sid,))
    if not r:
        raise not_found("Dit abonnement bestaat niet (meer).")
    return manual_subs.as_item(r, periods.today())


@router.post("/subscriptions")
def create(body: SubBody, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    _check(conn, body.category_id)
    sid = db.insert(conn, "manual_subscriptions", {
        "name": body.name.strip(), "amount_cents": body.amount_cents, "frequency": body.frequency,
        "start_date": body.start_date.isoformat(), "end_date": body.end_date.isoformat() if body.end_date else None,
        "category_id": body.category_id, "paid_from": (body.paid_from or "").strip() or None})
    return _out(conn, sid)


@router.patch("/subscriptions/{sid}")
def update(sid: int, body: SubPatch, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    _out(conn, sid)
    data = body.model_dump(exclude_unset=True)
    if "category_id" in data:
        _check(conn, data["category_id"])
    for k in ("start_date", "end_date"):
        if k in data and data[k] is not None:
            data[k] = data[k].isoformat()
    if "start_date" in data and data["start_date"] is None:
        del data["start_date"]
    for k in ("name", "paid_from"):
        if k in data and data[k] is not None:
            data[k] = data[k].strip() or (None if k == "paid_from" else data[k])
    if data:
        sets = ", ".join(f"{k} = ?" for k in data)
        conn.execute(f"UPDATE manual_subscriptions SET {sets} WHERE id = ?", (*data.values(), sid))
    return _out(conn, sid)


@router.delete("/subscriptions/{sid}")
def delete(sid: int, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    if not conn.execute("DELETE FROM manual_subscriptions WHERE id = ?", (sid,)).rowcount:
        raise not_found("Dit abonnement bestaat niet (meer).")
    return {"ok": True}
