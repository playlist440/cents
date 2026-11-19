"""Recurring payments: GET /recurring, POST /recurring/ignore."""

from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends

from ..schemas import RecurringIgnoreBody
from ..services import recurring
from .deps import get_conn

router = APIRouter()


@router.get("/recurring")
def list_recurring(conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    return recurring.recurring_json(conn)


@router.post("/recurring/ignore")
def ignore_recurring(body: RecurringIgnoreBody, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    recurring.ignore(conn, body.key.strip())
    return {"ok": True}


# ---------------------------------------------------------------- marked as subscription

from pydantic import BaseModel  # noqa: E402

from .. import db  # noqa: E402
from ..errors import ApiError, not_found  # noqa: E402
from ..services import ledger as ledger_mod  # noqa: E402


class PinBody(BaseModel):
    transaction_id: int
    name: str | None = None


class PinAmount(BaseModel):
    amount_cents: int


def _pin_preview(conn, tx_id: int) -> tuple[dict, list[dict]]:
    lg = ledger_mod.get(conn)
    rows = recurring.candidate_rows(lg)
    row = next((r for r in rows if r["id"] == tx_id), None)
    if row is None:
        raise ApiError(422, "not_recurring", "Deze betaling kan geen abonnement zijn (geen naam, of een creditcard-afrekening of opname).")
    fields = recurring.pin_fields(row)
    return {**fields, "name": row["merchant_name"] or row["merchant_key"]}, recurring.pin_matches(fields, rows)


@router.post("/recurring/pins/preview")
def pin_preview(body: PinBody, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    """What a mark would follow: the exact rule and the payments it matches (shown before saving)."""
    pin, txs = _pin_preview(conn, body.transaction_id)
    return {"rule": pin, "count": len(txs),
            "transactions": [{"id": t["id"], "date": t["date"], "amount_cents": t["amount_cents"],
                              "description": t.get("description"), "merchant_name": t["merchant_name"]}
                             for t in sorted(txs, key=lambda t: t["date"], reverse=True)]}


@router.post("/recurring/pins")
def pin_create(body: PinBody, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    pin, _ = _pin_preview(conn, body.transaction_id)
    if db.value(conn, "SELECT 1 FROM recurring_pins WHERE merchant_key = ? AND COALESCE(iban, '') = ? "
                      "AND amount_cents = ? AND desc_key = ?",
                (pin["merchant_key"], pin["iban"] or "", pin["amount_cents"], pin["desc_key"])):
        raise ApiError(409, "exists", "Deze betaling is al als abonnement gemarkeerd.")
    pid = db.insert(conn, "recurring_pins", {**pin, "name": (body.name or "").strip()[:80] or pin["name"]})
    return {"ok": True, "id": pid, "key": f"pin:{pid}"}


@router.post("/recurring/pins/{pid}/amount")
def pin_amount(pid: int, body: PinAmount, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    """Take over a new price (only after the user said yes)."""
    pin = db.row(conn, "SELECT * FROM recurring_pins WHERE id = ?", (pid,))
    if not pin:
        raise not_found("Deze markering bestaat niet (meer).")
    earlier = [x for x in (pin["earlier_amounts"] or "").split(",") if x] + [str(pin["amount_cents"])]
    conn.execute("UPDATE recurring_pins SET amount_cents = ?, earlier_amounts = ? WHERE id = ?",
                 (body.amount_cents, ",".join(dict.fromkeys(earlier)), pid))
    return {"ok": True}


@router.delete("/recurring/pins/{pid}")
def pin_delete(pid: int, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    if not conn.execute("DELETE FROM recurring_pins WHERE id = ?", (pid,)).rowcount:
        raise not_found("Deze markering bestaat niet (meer).")
    return {"ok": True}
