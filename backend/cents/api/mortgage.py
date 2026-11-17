"""Mortgage (hypotheek, SPEC 7.2): parts, yearly statements, home value, linked payment."""

from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends

from .. import db
from ..errors import ApiError, not_found
from ..schemas import (HomeValueBody, MortgageCreate, MortgagePartName, MortgagePatch,
                       MortgageYearBody, iso_date)
from ..services import ledger as ledger_mod
from ..services import mortgage, periods
from .deps import get_conn

router = APIRouter()


def _out(conn: sqlite3.Connection) -> dict:
    return mortgage.summary(conn, ledger_mod.get(conn))


@router.get("/mortgage")
def get_mortgage(conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    return _out(conn)


@router.post("/mortgage")
def create_mortgage(body: MortgageCreate, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    if mortgage.parts(conn):
        raise ApiError(409, "exists", "Er is al een hypotheek.")
    for i, part in enumerate(body.parts):
        db.insert(conn, "mortgage_parts", {"name": part.name.strip(), "sort": i,
                                           "created_at": db.now_iso()})
    return _out(conn)


@router.patch("/mortgage")
def patch_mortgage(body: MortgagePatch, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    sent = body.model_fields_set
    if "include_in_networth" in sent and body.include_in_networth is not None:
        db.set_setting(conn, mortgage.INCLUDE_SETTING, body.include_in_networth)
    if "merchant_key" in sent:
        key = body.merchant_key
        if key:
            known = db.value(conn, "SELECT 1 FROM transactions WHERE merchant_key = ? LIMIT 1", (key,))
            if not known:
                raise ApiError(422, "unknown_merchant", "Deze betaling ken ik niet.")
            if db.value(conn, "SELECT 1 FROM assets WHERE merchant_key = ?", (key,)):
                raise ApiError(409, "merchant_linked", "Deze betaling hoort al bij een andere lening.")
        if key is None:
            conn.execute("DELETE FROM settings WHERE key = ?", (mortgage.MERCHANT_SETTING,))
        else:
            db.set_setting(conn, mortgage.MERCHANT_SETTING, key)
    return _out(conn)


@router.delete("/mortgage")
def delete_mortgage(conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    for table in ("mortgage_years", "mortgage_parts", "home_values"):
        conn.execute(f"DELETE FROM {table}")
    conn.execute("DELETE FROM settings WHERE key IN (?, ?)",
                 (mortgage.MERCHANT_SETTING, mortgage.INCLUDE_SETTING))
    return {"ok": True}


@router.patch("/mortgage/parts/{part_id}")
def rename_part(part_id: int, body: MortgagePartName, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    if not db.update(conn, "mortgage_parts", part_id, {"name": body.name.strip()}):
        raise not_found("Dit leningdeel bestaat niet (meer).")
    return _out(conn)


@router.put("/mortgage/years/{year}")
def put_year(year: int, body: MortgageYearBody, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    mortgage.check_year(year, periods.today())
    known = {p["id"] for p in mortgage.parts(conn)}
    if any(p.part_id not in known for p in body.parts):
        raise not_found("Dit leningdeel bestaat niet (meer).")
    if len({p.part_id for p in body.parts}) != len(body.parts):
        raise ApiError(422, "invalid", "Elk leningdeel mag maar één keer voorkomen.")
    conn.execute("DELETE FROM mortgage_years WHERE year = ?", (year,))
    for p in body.parts:
        db.insert(conn, "mortgage_years", {"part_id": p.part_id, "year": year,
                                           "debt_end_cents": p.debt_end_cents,
                                           "interest_cents": p.interest_cents,
                                           "repaid_cents": p.repaid_cents})
    return _out(conn)


@router.delete("/mortgage/years/{year}")
def delete_year(year: int, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    if not conn.execute("DELETE FROM mortgage_years WHERE year = ?", (year,)).rowcount:
        raise not_found("Deze jaaropgave bestaat niet (meer).")
    return _out(conn)


@router.post("/mortgage/home-values")
def add_home_value(body: HomeValueBody, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    db.insert(conn, "home_values", {"date": iso_date(body.date), "value_cents": body.value_cents})
    return _out(conn)


@router.delete("/mortgage/home-values/{value_id}")
def delete_home_value(value_id: int, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    if not conn.execute("DELETE FROM home_values WHERE id = ?", (value_id,)).rowcount:
        raise not_found("Deze waarde bestaat niet (meer).")
    return _out(conn)
