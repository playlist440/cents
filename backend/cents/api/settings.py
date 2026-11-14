"""GET/PATCH /settings."""

from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends

from .. import db
from ..classify import engine
from ..schemas import SettingsPatch
from ..services import assumptions
from ..services import insights
from .deps import get_conn

router = APIRouter()


def settings_json(conn: sqlite3.Connection) -> dict:
    """Public settings plus the insight kinds the UI can switch off (analytics)."""
    out = db.public_settings(conn)
    out.setdefault("muted_insight_kinds", [])
    out["insight_kinds"] = insights.kinds_json()
    return out


@router.get("/settings")
def get_settings(conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    return settings_json(conn)


@router.patch("/settings")
def patch_settings(body: SettingsPatch, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    for key in body.model_fields_set:
        val = getattr(body, key)
        if val is None:
            continue
        if key == "assumptions":
            assumptions.merge(conn, val)
            engine.classify_all(conn)              # the defaults changed: re-sort everything
            continue
        if key == "household_name":
            val = val.strip()
        db.set_setting(conn, key, val)
    return settings_json(conn)
