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


EMOJI_BY_WORD = [("motor", "🏍️"), ("scooter", "🛵"), ("camper", "🚐"), ("caravan", "🚐"), ("boot", "⛵"),
                 ("sloep", "⛵"), ("fiets", "🚲"), ("bike", "🚲"), ("auto", "🚗"), ("car", "🚗")]


def _emoji_for(name: str) -> str:
    low = name.lower()
    return next((e for w, e in EMOJI_BY_WORD if w in low), "🚗")


def _default_category(conn: sqlite3.Connection, tx: dict | None) -> int | None:
    """The bakje of the purchase when it is a spending bakje, else Auto & vervoer."""
    if tx and tx["category_id"]:
        cat = db.row(conn, "SELECT key, grp FROM categories WHERE id = ?", (tx["category_id"],))
        if cat and cat["grp"] in ("fixed", "daily") and cat["key"] not in ("unsorted", "creditcard"):
            return tx["category_id"]
    return db.value(conn, "SELECT id FROM categories WHERE key = 'vervoer'")


def _check_category(conn: sqlite3.Connection, category_id: int) -> None:
    cat = db.row(conn, "SELECT grp FROM categories WHERE id = ?", (category_id,))
    if not cat or cat["grp"] not in ("fixed", "daily"):
        raise ApiError(422, "unknown_category", "Kies een bakje voor uitgaven.")


def _purchase_tx(conn: sqlite3.Connection, tx_id: int, asset_id: int | None) -> dict:
    tx = db.row(conn, "SELECT * FROM transactions WHERE id = ?", (tx_id,))
    if not tx or tx["amount_cents"] >= 0:
        raise ApiError(422, "not_a_purchase", "Kies de betaling waarmee je het kocht.")
    if db.value(conn, "SELECT 1 FROM assets WHERE (tx_id = ? OR sale_tx_id = ?) AND id != ?",
                (tx_id, tx_id, asset_id or 0)):
        raise ApiError(409, "tx_linked", "Deze betaling hoort al bij een andere bezitting.")
    return tx


def _check_possession(price: int, residual: int, life: int) -> None:
    if residual > price:
        raise ApiError(422, "residual_too_high", "De verwachte verkoopprijs is hoger dan de aankoopprijs.")
    if not 6 <= life <= 360:
        raise ApiError(422, "invalid", "Kies een gebruiksduur tussen een half jaar en 30 jaar.")


def _create_possession(conn: sqlite3.Connection, body: AssetCreate) -> int:
    tx = _purchase_tx(conn, body.tx_id, None) if body.tx_id else None
    price = body.price_cents or (-tx["amount_cents"] if tx else None)
    start = iso_date(body.start_date) if body.start_date else ((tx["book_date"] or tx["date"]) if tx else None)
    if not price or not start:
        raise ApiError(422, "invalid", "Vul de aankoopprijs en de datum in.")
    life = body.life_months or 96
    residual = body.residual_cents if body.residual_cents is not None else 0
    _check_possession(price, residual, life)
    if body.category_id is not None:
        _check_category(conn, body.category_id)
    sort = (db.value(conn, "SELECT MAX(sort) FROM assets") or 0) + 1
    new_id = db.insert(conn, "assets", {
        "kind": "possession", "name": body.name.strip(), "debt_kind": None,
        "include": int(body.include if body.include is not None else True), "merchant_key": None,
        "sort": sort, "created_at": db.now_iso(), "tx_id": tx["id"] if tx else None,
        "price_cents": price, "start_date": start, "life_months": life, "residual_cents": residual,
        "curve": "front" if body.curve == "front" else None,
        "category_id": body.category_id if body.category_id is not None else _default_category(conn, tx),
        "emoji": body.emoji or _emoji_for(body.name)})
    if tx and tx["spread_months"]:
        db.update(conn, "transactions", tx["id"], {"spread_months": None})
    return new_id


@router.post("/assets")
def create_asset(body: AssetCreate, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    if body.kind == "possession":
        new_id = _create_possession(conn, body)
        out = _out(conn)
        out["id"] = new_id
        return out
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
    if a["kind"] == "possession":
        _patch_possession(conn, a, body, sent, changes)
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


def _patch_possession(conn: sqlite3.Connection, a: dict, body: AssetPatch, sent: set, changes: dict) -> None:
    for f in ("price_cents", "life_months", "residual_cents"):
        if f in sent and getattr(body, f) is not None:
            changes[f] = getattr(body, f)
    if "start_date" in sent and body.start_date:
        changes["start_date"] = iso_date(body.start_date)
    if "curve" in sent and body.curve:
        changes["curve"] = "front" if body.curve == "front" else None
    if "category_id" in sent and body.category_id is not None:
        _check_category(conn, body.category_id)
        changes["category_id"] = body.category_id
    if "emoji" in sent and body.emoji:
        changes["emoji"] = body.emoji
    merged = {**a, **changes}
    _check_possession(merged["price_cents"] or 0, merged["residual_cents"] or 0, merged["life_months"] or 96)
    if {"sale_tx_id", "sale_date", "sale_cents"} & sent:
        if body.sale_tx_id:
            tx = db.row(conn, "SELECT * FROM transactions WHERE id = ?", (body.sale_tx_id,))
            if not tx or tx["amount_cents"] <= 0:
                raise ApiError(422, "not_a_sale", "Kies de betaling waarmee je het geld kreeg.")
            if db.value(conn, "SELECT 1 FROM assets WHERE (tx_id = ? OR sale_tx_id = ?) AND id != ?",
                        (tx["id"], tx["id"], a["id"])):
                raise ApiError(409, "tx_linked", "Deze betaling hoort al bij een andere bezitting.")
            if (tx["book_date"] or tx["date"]) < (merged["start_date"] or ""):
                raise ApiError(422, "sale_before_purchase", "Deze betaling is van vóór de aankoop.")
            changes.update(sale_tx_id=tx["id"], sale_date=None, sale_cents=None)
        elif body.sale_date and body.sale_cents is not None:
            day = iso_date(body.sale_date)
            if day < (merged["start_date"] or ""):
                raise ApiError(422, "sale_before_purchase", "Deze datum is van vóór de aankoop.")
            changes.update(sale_tx_id=None, sale_date=day, sale_cents=body.sale_cents)
        else:
            changes.update(sale_tx_id=None, sale_date=None, sale_cents=None)


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
