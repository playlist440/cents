"""Bakjes: list (via bootstrap), create, edit, delete custom ones."""

from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends

from .. import db
from ..classify.library import norm_text
from ..errors import ApiError, not_found
from ..schemas import CategoryCreate, CategoryPatch
from .deps import get_conn

router = APIRouter()


def category_json(row: dict) -> dict:
    return {"id": row["id"], "key": row["key"], "name": row["name"], "emoji": row["emoji"],
            "color": row["color"], "grp": row["grp"], "sort": row["sort"],
            "hidden": bool(row["hidden"]), "builtin": bool(row["builtin"])}


def list_categories(conn: sqlite3.Connection) -> list[dict]:
    return [category_json(r) for r in db.rows(conn, "SELECT * FROM categories ORDER BY sort, id")]


def load_category(conn: sqlite3.Connection, category_id: int) -> dict:
    row = db.row(conn, "SELECT * FROM categories WHERE id = ?", (category_id,))
    if not row:
        raise not_found("Dit bakje bestaat niet (meer).")
    return row


@router.get("/categories")
def get_categories(conn: sqlite3.Connection = Depends(get_conn)) -> list[dict]:
    return list_categories(conn)


@router.post("/categories")
def create_category(body: CategoryCreate, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    base = "c-" + (norm_text(body.name).replace(" ", "-") or "bakje")
    key, n = base, 2
    while db.value(conn, "SELECT 1 FROM categories WHERE key = ?", (key,)):
        key, n = f"{base}-{n}", n + 1
    sort = (db.value(conn, "SELECT MAX(sort) FROM categories") or 0) + 10
    new_id = db.insert(conn, "categories", {
        "key": key, "name": body.name.strip(), "emoji": body.emoji or "📦",
        "color": body.color or "gray", "grp": body.grp, "sort": sort, "hidden": 0, "builtin": 0})
    return category_json(load_category(conn, new_id))


@router.patch("/categories/{category_id}")
def patch_category(category_id: int, body: CategoryPatch,
                   conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    row = load_category(conn, category_id)
    updates = {f: getattr(body, f) for f in body.model_fields_set if getattr(body, f) is not None}
    if "grp" in updates and row["builtin"] and updates["grp"] != row["grp"]:
        raise ApiError(400, "builtin_group", "De soort van een standaardbakje kan niet veranderen.")
    if "hidden" in updates:
        if row["key"] == "unsorted" and updates["hidden"]:
            raise ApiError(400, "cannot_hide", "Dit bakje kan niet verborgen worden.")
        updates["hidden"] = int(updates["hidden"])
    if "name" in updates:
        updates["name"] = updates["name"].strip()
    db.update(conn, "categories", category_id, updates)
    return category_json(load_category(conn, category_id))


@router.delete("/categories/{category_id}")
def delete_category(category_id: int, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    row = load_category(conn, category_id)
    if row["builtin"]:
        raise ApiError(400, "builtin", "Standaardbakjes kun je verbergen, niet verwijderen.")
    unsorted = db.unsorted_id(conn)
    n = conn.execute("UPDATE transactions SET category_id = ?, category_source = 'none', "
                     "category_reason = 'none', updated_at = ? "
                     "WHERE category_id = ?", (unsorted, db.now_iso(), category_id)).rowcount
    conn.execute("UPDATE rules SET category_id = NULL WHERE category_id = ?", (category_id,))
    conn.execute("UPDATE rules SET below_cents = NULL, below_category_id = NULL WHERE below_category_id = ?",
                 (category_id,))
    conn.execute("DELETE FROM rules WHERE category_id IS NULL AND tag_id IS NULL AND below_cents IS NULL")
    conn.execute("DELETE FROM categories WHERE id = ?", (category_id,))
    return {"ok": True, "moved": n}
