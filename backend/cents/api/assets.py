"""Pension, debt and other possessions (SPEC 7.3): items, dated entries, linked debt payment."""

from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends

from .. import db
from ..errors import ApiError, not_found
from ..schemas import AssetCreate, AssetEntryBody, AssetPatch, iso_date
from ..services import assets, mortgage, periods
from ..services import ledger as ledger_mod
from .deps import get_conn

router = APIRouter()


def _out(conn: sqlite3.Connection) -> dict:
    return assets.summary(conn, ledger_mod.get(conn))


def _check_merchant(conn: sqlite3.Connection, key: str, asset_id: int | None) -> None:
    if not db.value(conn, "SELECT 1 FROM transactions WHERE merchant_key = ? LIMIT 1", (key,)):
        raise ApiError(422, "unknown_merchant", "Deze betaling ken ik niet.")
    taken = db.value(conn, "SELECT 1 FROM assets WHERE merchant_key = ? AND id != ?",
                     (key, asset_id or 0))
    if taken or (mortgage.parts(conn) and mortgage.linked_merchant(conn)[0] == key):
        raise ApiError(409, "merchant_linked", "Deze betaling hoort al bij een andere lening.")


@router.get("/assets")
def get_assets(conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    return _out(conn)


@router.post("/assets")
def create_asset(body: AssetCreate, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    key = None
    if body.kind == "debt":
        if "merchant_key" in body.model_fields_set:
            key = body.merchant_key or None
            if key:
                _check_merchant(conn, key, None)
        elif body.debt_kind == "studieschuld":            # auto-suggest DUO
            duo = next((c for c in assets.candidates(conn) if c["likely"]), None)
            if duo:
                try:
                    _check_merchant(conn, duo["merchant_key"], None)
                    key = duo["merchant_key"]
                except ApiError:
                    key = None
    include = body.include if body.include is not None else assets.DEFAULT_INCLUDE[body.kind]
    sort = (db.value(conn, "SELECT MAX(sort) FROM assets") or 0) + 1
    new_id = db.insert(conn, "assets", {
        "kind": body.kind, "name": body.name.strip(),
        "debt_kind": (body.debt_kind or "overig") if body.kind == "debt" else None,
        "include": int(include), "merchant_key": key, "sort": sort, "created_at": db.now_iso()})
    out = _out(conn)
    out["id"] = new_id
    return out


@router.patch("/assets/{asset_id}")
def patch_asset(asset_id: int, body: AssetPatch, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    a = db.row(conn, "SELECT * FROM assets WHERE id = ?", (asset_id,))
    if not a:
        raise not_found("Dit onderdeel bestaat niet (meer).")
    sent, changes = body.model_fields_set, {}
    if "name" in sent and body.name:
        changes["name"] = body.name.strip()
    if "include" in sent and body.include is not None:
        changes["include"] = int(body.include)
    if a["kind"] == "debt":
        if "debt_kind" in sent and body.debt_kind:
            changes["debt_kind"] = body.debt_kind
        if "merchant_key" in sent:
            key = body.merchant_key or None
            if key:
                _check_merchant(conn, key, asset_id)
            changes["merchant_key"] = key
    db.update(conn, "assets", asset_id, changes)
    return _out(conn)


@router.delete("/assets/{asset_id}")
def delete_asset(asset_id: int, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    if not conn.execute("DELETE FROM assets WHERE id = ?", (asset_id,)).rowcount:
        raise not_found("Dit onderdeel bestaat niet (meer).")
    return _out(conn)


@router.post("/assets/{asset_id}/entries")
def add_entry(asset_id: int, body: AssetEntryBody, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    a = db.row(conn, "SELECT kind FROM assets WHERE id = ?", (asset_id,))
    if not a:
        raise not_found("Dit onderdeel bestaat niet (meer).")
    day = iso_date(body.date)
    if day > periods.today().isoformat():
        raise ApiError(422, "future_date", "Deze datum ligt in de toekomst.")
    debt = a["kind"] == "debt"
    db.insert(conn, "asset_entries", {
        "asset_id": asset_id, "date": day, "value_cents": body.value_cents,
        "interest_cents": body.interest_cents if debt else None,
        "repaid_cents": body.repaid_cents if debt else None,
        "note": (body.note or "").strip() or None})
    return _out(conn)


@router.delete("/assets/{asset_id}/entries/{entry_id}")
def delete_entry(asset_id: int, entry_id: int, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    if not conn.execute("DELETE FROM asset_entries WHERE id = ? AND asset_id = ?",
                        (entry_id, asset_id)).rowcount:
        raise not_found("Deze waarde bestaat niet (meer).")
    return _out(conn)
