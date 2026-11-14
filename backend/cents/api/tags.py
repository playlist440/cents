"""Tags: create, edit, delete (list comes with bootstrap and GET /tags)."""

from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends

from .. import db
from ..errors import ApiError, not_found
from ..schemas import TagCreate, TagPatch
from .deps import get_conn

router = APIRouter()


def tag_json(row: dict) -> dict:
    return {"id": row["id"], "name": row["name"], "emoji": row["emoji"], "color": row["color"],
            "archived": bool(row["archived"]), "created_at": row["created_at"],
            "count": row.get("count", 0)}


def list_tags(conn: sqlite3.Connection) -> list[dict]:
    return [tag_json(r) for r in db.rows(conn, """
        SELECT g.*, (SELECT COUNT(*) FROM transaction_tags tt WHERE tt.tag_id = g.id) AS count
        FROM tags g ORDER BY g.archived, g.name COLLATE NOCASE""")]


def load_tag(conn: sqlite3.Connection, tag_id: int) -> dict:
    row = db.row(conn, "SELECT * FROM tags WHERE id = ?", (tag_id,))
    if not row:
        raise not_found("Deze tag bestaat niet (meer).")
    return row


def _unique_name(conn: sqlite3.Connection, name: str, own_id: int | None = None) -> str:
    name = name.strip()
    other = db.value(conn, "SELECT id FROM tags WHERE name = ? COLLATE NOCASE", (name,))
    if other and other != own_id:
        raise ApiError(409, "tag_exists", "Er is al een tag met deze naam.")
    return name


@router.get("/tags")
def get_tags(conn: sqlite3.Connection = Depends(get_conn)) -> list[dict]:
    return list_tags(conn)


@router.post("/tags")
def create_tag(body: TagCreate, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    tag_id = db.insert(conn, "tags", {"name": _unique_name(conn, body.name), "emoji": body.emoji or "🏷️",
                                      "color": body.color or "gray", "archived": 0,
                                      "created_at": db.now_iso()})
    return tag_json(load_tag(conn, tag_id))


@router.patch("/tags/{tag_id}")
def patch_tag(tag_id: int, body: TagPatch, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    load_tag(conn, tag_id)
    updates = {f: getattr(body, f) for f in body.model_fields_set if getattr(body, f) is not None}
    if "name" in updates:
        updates["name"] = _unique_name(conn, updates["name"], tag_id)
    if "archived" in updates:
        updates["archived"] = int(updates["archived"])
    db.update(conn, "tags", tag_id, updates)
    return tag_json(load_tag(conn, tag_id))


@router.delete("/tags/{tag_id}")
def delete_tag(tag_id: int, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    load_tag(conn, tag_id)
    conn.execute("UPDATE rules SET tag_id = NULL WHERE tag_id = ?", (tag_id,))
    conn.execute("DELETE FROM rules WHERE category_id IS NULL AND tag_id IS NULL")
    conn.execute("DELETE FROM tags WHERE id = ?", (tag_id,))
    return {"ok": True}
