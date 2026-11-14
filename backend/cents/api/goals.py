"""Savings goals ("potjes"): GET/POST/PATCH/DELETE /goals, entries, saldo."""

from __future__ import annotations

import json
import sqlite3

from fastapi import APIRouter, Depends

from .. import db
from ..errors import ApiError, bad_request, not_found
from ..schemas import GoalCreate, GoalEntryBody, GoalPatch, GoalSaldoBody, iso_date
from ..services import goals, periods
from .deps import get_conn

router = APIRouter()


def load_goal(conn: sqlite3.Connection, goal_id: int) -> dict:
    goal = db.row(conn, "SELECT * FROM goals WHERE id = ?", (goal_id,))
    if not goal:
        raise not_found("Dit potje bestaat niet (meer).")
    return goal


def _code(conn: sqlite3.Connection, code: str | None, own_id: int | None = None) -> str:
    if code is None:
        return goals.new_code(conn)
    code = code.strip()
    if not goals.valid_code(code):
        raise bad_request("Een code is 5 cijfers en begint niet met 0.", "bad_code")
    other = db.value(conn, "SELECT id FROM goals WHERE code = ?", (code,))
    if other and other != own_id:
        raise ApiError(409, "code_exists", "Deze code hoort al bij een ander potje.")
    return code


def _keywords(words: list[str]) -> str:
    return json.dumps([w.strip().lower() for w in words if w and w.strip()], ensure_ascii=False)


@router.get("/goals")
def list_goals(conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    return goals.overview(conn)


@router.post("/goals")
def create_goal(body: GoalCreate, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    sort = (db.value(conn, "SELECT MAX(sort) FROM goals") or 0) + 10
    goal_id = db.insert(conn, "goals", {
        "name": body.name.strip(), "emoji": body.emoji or "🎯", "color": body.color or "teal",
        "target_cents": body.target_cents, "target_date": iso_date(body.target_date),
        "repeat": body.repeat, "code": _code(conn, body.code), "keywords": _keywords(body.keywords),
        "archived": 0, "sort": sort, "created_at": db.now_iso()})
    goals.match_transfers(conn)
    return goals.one_goal(conn, goal_id)


@router.patch("/goals/{goal_id}")
def patch_goal(goal_id: int, body: GoalPatch, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    load_goal(conn, goal_id)
    sent = body.model_fields_set
    updates: dict = {}
    for field in ("emoji", "color", "target_cents", "repeat", "sort"):
        if field in sent and getattr(body, field) is not None:
            updates[field] = getattr(body, field)
    if "name" in sent and body.name:
        updates["name"] = body.name.strip()
    if "target_date" in sent:
        updates["target_date"] = iso_date(body.target_date)
    if "keywords" in sent:
        updates["keywords"] = _keywords(body.keywords or [])
    if "code" in sent and body.code:
        updates["code"] = _code(conn, body.code, goal_id)
    if "archived" in sent and body.archived is not None:
        updates["archived"] = int(body.archived)
    db.update(conn, "goals", goal_id, updates)
    if {"name", "keywords", "code"} & updates.keys() or updates.get("archived") == 0:
        goals.match_transfers(conn)
    return goals.one_goal(conn, goal_id)


@router.delete("/goals/{goal_id}")
def delete_goal(goal_id: int, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    load_goal(conn, goal_id)
    conn.execute("UPDATE transactions SET goal_id = NULL WHERE goal_id = ?", (goal_id,))
    conn.execute("DELETE FROM goal_entries WHERE goal_id = ?", (goal_id,))
    conn.execute("DELETE FROM goals WHERE id = ?", (goal_id,))
    return {"ok": True}


@router.post("/goals/{goal_id}/entries")
def add_entry(goal_id: int, body: GoalEntryBody, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    load_goal(conn, goal_id)
    if body.transaction_id is not None:
        tx = db.row(conn, """SELECT t.*, a.type AS account_type FROM transactions t
                             JOIN accounts a ON a.id = t.account_id WHERE t.id = ?""",
                    (body.transaction_id,))
        if not tx:
            raise not_found("Deze betaling bestaat niet (meer).")
        if body.amount_cents:
            # part of a transfer: replace this goal's share, keep the other goals' shares
            whole = goals.goal_amount(tx, tx["account_type"])
            others = db.value(conn, "SELECT COALESCE(SUM(amount_cents), 0) FROM goal_entries "
                                    "WHERE transaction_id = ? AND goal_id != ?", (tx["id"], goal_id))
            same_sign = (body.amount_cents > 0) == (whole > 0)
            if not same_sign or abs(others + body.amount_cents) > abs(whole):
                raise bad_request("Samen is dit meer dan het bedrag van de overboeking.", "split_too_large")
            conn.execute("DELETE FROM goal_entries WHERE transaction_id = ? AND goal_id = ?",
                         (tx["id"], goal_id))
            if tx["goal_id"] is None:
                conn.execute("UPDATE transactions SET goal_id = ? WHERE id = ?", (goal_id, tx["id"]))
            entry_id = db.insert(conn, "goal_entries", {
                "goal_id": goal_id, "date": tx["date"], "amount_cents": body.amount_cents,
                "transaction_id": tx["id"], "kind": "manual", "note": body.note})
        else:
            conn.execute("DELETE FROM goal_entries WHERE transaction_id = ?", (tx["id"],))
            entry_id = goals.assign(conn, tx, goal_id, "manual")
    else:
        if not body.amount_cents:
            raise bad_request("Vul een bedrag in.", "no_amount")
        entry_id = db.insert(conn, "goal_entries", {
            "goal_id": goal_id, "date": iso_date(body.date) or periods.today().isoformat(),
            "amount_cents": body.amount_cents, "transaction_id": None, "kind": "manual",
            "note": (body.note or "").strip() or None})
    entry = db.row(conn, "SELECT * FROM goal_entries WHERE id = ?", (entry_id,))
    return {"entry": goals.entry_json(entry), "goal": goals.one_goal(conn, goal_id)}


@router.post("/goals/{goal_id}/saldo")
def set_saldo(goal_id: int, body: GoalSaldoBody, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    load_goal(conn, goal_id)
    saldo = db.value(conn, "SELECT COALESCE(SUM(amount_cents), 0) FROM goal_entries WHERE goal_id = ?",
                     (goal_id,))
    entry = None
    if body.saldo_cents != saldo:
        entry_id = db.insert(conn, "goal_entries", {
            "goal_id": goal_id, "date": periods.today().isoformat(),
            "amount_cents": body.saldo_cents - saldo, "transaction_id": None, "kind": "adjust",
            "note": None})
        entry = goals.entry_json(db.row(conn, "SELECT * FROM goal_entries WHERE id = ?", (entry_id,)))
    return {"entry": entry, "goal": goals.one_goal(conn, goal_id)}


@router.delete("/goal-entries/{entry_id}")
def delete_entry(entry_id: int, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    entry = db.row(conn, "SELECT * FROM goal_entries WHERE id = ?", (entry_id,))
    if not entry:
        raise not_found("Deze boeking bestaat niet (meer).")
    conn.execute("DELETE FROM goal_entries WHERE id = ?", (entry_id,))
    if entry["transaction_id"]:
        tx_id = entry["transaction_id"]
        current = db.value(conn, "SELECT goal_id FROM transactions WHERE id = ?", (tx_id,))
        still = db.value(conn, "SELECT 1 FROM goal_entries WHERE transaction_id = ? AND goal_id = ?",
                         (tx_id, current))
        if not still:
            other = db.value(conn, "SELECT goal_id FROM goal_entries WHERE transaction_id = ? "
                                   "ORDER BY id DESC LIMIT 1", (tx_id,))
            conn.execute("UPDATE transactions SET goal_id = ? WHERE id = ?", (other, tx_id))
    return {"ok": True}
