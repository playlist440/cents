"""Smart assumptions and insight preferences: GET /assumptions, DELETE /recurring/ignore,
DELETE /goals/links, POST /insights/dismiss, POST /insights/mute."""

from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends

from ..errors import bad_request
from ..schemas import GoalLinkBody, InsightDismissBody, InsightMuteBody, RecurringIgnoreBody
from ..services import goals, insights, smart
from .deps import get_conn

router = APIRouter()


@router.get("/assumptions")
def get_assumptions(conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    return smart.assumptions(conn)


@router.delete("/recurring/ignore")
def unignore_recurring(body: RecurringIgnoreBody, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    conn.execute("DELETE FROM recurring_ignored WHERE key = ?", (body.key.strip(),))
    return {"ok": True}


@router.delete("/goals/links")
def forget_goal_link(body: GoalLinkBody, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    goals.forget_link(conn, body.goal_id, body.description)
    return {"ok": True}


@router.post("/insights/dismiss")
def dismiss_insight(body: InsightDismissBody, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    insights.dismiss(conn, body.id)
    return {"ok": True}


@router.post("/insights/mute")
def mute_insight(body: InsightMuteBody, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    if body.kind not in insights.KIND_LABELS:
        raise bad_request("Dit soort melding bestaat niet.", "unknown_kind")
    return {"ok": True, "muted_insight_kinds": insights.mute(conn, body.kind, body.muted)}
