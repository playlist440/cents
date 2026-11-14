"""Learned rules (Instellingen > Geleerde regels)."""

from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends

from .. import db
from ..errors import bad_request, not_found
from ..schemas import RulePatch
from ..services import learning
from .deps import get_conn

router = APIRouter()


@router.get("/rules")
def list_rules(conn: sqlite3.Connection = Depends(get_conn)) -> list[dict]:
    return learning.list_rules(conn)


@router.delete("/rules/{rule_id}")
def delete_rule(rule_id: int, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    if not learning.delete_rule(conn, rule_id):
        raise not_found("Deze regel bestaat niet (meer).")
    return {"ok": True}


@router.patch("/rules/{rule_id}")
def patch_rule(rule_id: int, body: RulePatch, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    """Change a learned rule; `below_cents: null` clears the amount threshold. Re-applies to
    the merchant's transactions that were not set individually."""
    sent = body.model_fields_set
    fields: dict = {}
    for name in ("category_id", "below_category_id"):
        value = getattr(body, name)
        if name in sent and value is not None and \
                not db.value(conn, "SELECT 1 FROM categories WHERE id = ?", (value,)):
            raise bad_request("Dit bakje bestaat niet.", "unknown_category")
    if "category_id" in sent:
        fields["category_id"] = body.category_id
    if "below_cents" in sent:
        fields["below_cents"] = body.below_cents
        if body.below_cents is None:
            fields["below_category_id"] = None
    if "below_category_id" in sent and not ("below_cents" in sent and body.below_cents is None):
        fields["below_category_id"] = body.below_category_id
    rule = learning.update_rule(conn, rule_id, fields)
    if rule is None:
        raise not_found("Deze regel bestaat niet (meer).")
    return next(r for r in learning.list_rules(conn) if r["id"] == rule_id)
