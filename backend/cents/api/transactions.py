"""Transactions: list/search, detail, edit (with learning), manual create/delete, bulk."""

from __future__ import annotations

import sqlite3
import statistics
import uuid
from datetime import date, timedelta

from fastapi import APIRouter, Depends, Query

from .. import db, hooks
from ..classify import engine
from ..classify.library import get_library, norm_text
from ..classify.reasons import reason_label
from ..errors import ApiError, bad_request, not_found
from ..importers.normalize import clean_merchant, tidy_name
from ..schemas import MONEY_LIMIT, TxBulk, TxCreate, TxPatch, iso_date
from ..services import learning, periods, txquery
from .deps import get_conn

router = APIRouter()


# ---------------------------------------------------------------- validation helpers

def check_category(conn: sqlite3.Connection, category_id: int) -> None:
    if not db.value(conn, "SELECT 1 FROM categories WHERE id = ?", (category_id,)):
        raise bad_request("Dit bakje bestaat niet.", "unknown_category")


def check_tags(conn: sqlite3.Connection, tag_ids: list[int]) -> None:
    if not tag_ids:
        return
    found = db.value(conn, f"SELECT COUNT(*) FROM tags WHERE id IN ({db.placeholders(tag_ids)})",
                     tag_ids)
    if found != len(set(tag_ids)):
        raise bad_request("Deze tag bestaat niet.", "unknown_tag")


def check_account(conn: sqlite3.Connection, account_id: int) -> dict:
    account = db.row(conn, "SELECT * FROM accounts WHERE id = ?", (account_id,))
    if not account:
        raise bad_request("Deze rekening bestaat niet.", "unknown_account")
    return account


def load_tx(conn: sqlite3.Connection, tx_id: int) -> dict:
    tx = txquery.get_tx(conn, tx_id)
    if not tx:
        raise not_found("Deze betaling bestaat niet (meer).")
    return tx


def tx_out(conn: sqlite3.Connection, tx_id: int) -> dict:
    return txquery.tx_list_json(conn, [load_tx(conn, tx_id)])[0]


def merchant_fields(name: str) -> tuple[str, str]:
    """(merchant_name, merchant_key) for a name typed by the user."""
    lib = get_library()
    cleaned = clean_merchant(name) or name.strip()
    brand = lib.match_merchant(cleaned)
    if brand and brand.get("key"):
        return brand.get("name") or cleaned, brand["key"]
    return tidy_name(cleaned), norm_text(cleaned) or "onbekend"


def set_tags(conn: sqlite3.Connection, tx_id: int, tag_ids: list[int]) -> None:
    conn.execute("DELETE FROM transaction_tags WHERE transaction_id = ?", (tx_id,))
    conn.executemany("INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)",
                     [(tx_id, t) for t in tag_ids])


# ---------------------------------------------------------------- list / detail

@router.get("/transactions")
def list_transactions(
    period: str | None = None,
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = None,
    account_id: int | None = None,
    category_id: int | None = None,
    tag_id: int | None = None,
    merchant_key: str | None = None,
    q: str | None = Query(default=None, max_length=200),
    method: str | None = None,
    kind: str | None = None,
    unsorted: bool = False,
    min_cents: int | None = Query(default=None, ge=-MONEY_LIMIT, le=MONEY_LIMIT),
    max_cents: int | None = Query(default=None, ge=-MONEY_LIMIT, le=MONEY_LIMIT),
    limit: int = Query(default=100, ge=1, le=1000),
    cursor: str | None = None,
    conn: sqlite3.Connection = Depends(get_conn),
) -> dict:
    filters = {"from": iso_date(from_), "to": iso_date(to), "account_id": account_id,
               "category_id": category_id, "tag_id": tag_id, "merchant_key": merchant_key,
               "q": q, "method": method, "kind": kind, "unsorted": unsorted,
               "min_cents": min_cents, "max_cents": max_cents}
    if period:
        try:
            p = periods.resolve(conn, period)
        except ValueError:
            raise bad_request("Onbekende maand.", "bad_period") from None
        filters["from"] = max(filters["from"] or "", p.start.isoformat())
        filters["to"] = min(filters["to"] or "9999-12-31", p.last.isoformat())
    return txquery.list_transactions(conn, filters, limit, cursor)


@router.get("/transactions/{tx_id}")
def get_transaction(tx_id: int, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    tx = load_tx(conn, tx_id)
    out = txquery.tx_list_json(conn, [tx])[0]
    for field in ("raw_description", "counterparty_name", "pay_type", "bank_code", "mcc", "wallet",
                  "bank_category", "mandate_id", "creditor_id", "value_date", "iso_family",
                  "iso_subfamily", "import_id"):
        out[field] = tx[field]
    out["mcc_label"] = get_library().mcc_label(tx["mcc"])
    out["category_reason"] = tx.get("category_reason") or tx["category_source"]
    out["category_reason_label"] = reason_label(tx.get("category_reason"), tx, get_library())
    out["merchant"] = merchant_summary(conn, tx["merchant_key"])
    return out


def merchant_summary(conn: sqlite3.Connection, merchant_key: str | None) -> dict:
    if not merchant_key:
        return {"count": 0, "total_12m_cents": 0, "typical_cents": None, "recurring": None}
    since = (periods.today() - timedelta(days=365)).isoformat()
    count = db.value(conn, "SELECT COUNT(*) FROM transactions WHERE merchant_key = ?", (merchant_key,))
    amounts = [r["amount_cents"] for r in db.rows(
        conn, "SELECT amount_cents FROM transactions WHERE merchant_key = ? AND date >= ?",
        (merchant_key, since))]
    return {
        "count": count,
        "total_12m_cents": sum(amounts),
        "typical_cents": int(statistics.median(amounts)) if amounts else None,
        "recurring": hooks.recurring_for_merchant(conn, merchant_key),
    }


# ---------------------------------------------------------------- edit

@router.patch("/transactions/{tx_id}")
def patch_transaction(tx_id: int, body: TxPatch, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    tx = load_tx(conn, tx_id)
    sent = body.model_fields_set
    updated_count = 1
    updates: dict = {}

    manual_fields = {"account_id", "date", "amount_cents", "merchant_name"} & sent
    if manual_fields and not tx["manual"]:
        raise bad_request("Alleen zelf toegevoegde uitgaven kun je zo aanpassen.", "not_manual")
    if "account_id" in sent and body.account_id is not None:
        check_account(conn, body.account_id)
        updates["account_id"] = body.account_id
    if "date" in sent and body.date is not None:
        updates["date"] = iso_date(body.date)
    if "amount_cents" in sent and body.amount_cents is not None:
        updates["amount_cents"] = body.amount_cents
    if "merchant_name" in sent and body.merchant_name:
        updates["merchant_name"], updates["merchant_key"] = merchant_fields(body.merchant_name)
        updates["description"] = body.merchant_name.strip()
    if "note" in sent:
        updates["note"] = (body.note or "").strip() or None
    if "book_date" in sent:
        book = iso_date(body.book_date) if body.book_date else None
        if book and abs((date.fromisoformat(book) - date.fromisoformat(tx["date"])).days) > 62:
            raise bad_request("Een boekdatum ligt hooguit twee maanden van de echte datum.", "book_date_range")
        updates["book_date"] = None if book == tx["date"] else book
    if "goal_id" in sent:
        if body.goal_id is not None and not db.value(conn, "SELECT 1 FROM goals WHERE id = ?", (body.goal_id,)):
            raise bad_request("Dit potje bestaat niet.", "unknown_goal")
        updates["goal_id"] = body.goal_id
    if updates:
        updates["updated_at"] = db.now_iso()
        db.update(conn, "transactions", tx_id, updates)
        tx = load_tx(conn, tx_id)

    if "category_id" in sent and body.category_id is not None:
        check_category(conn, body.category_id)
        scope = body.apply_scope or ("merchant" if body.apply_to_merchant else "one")
        if scope == "merchant_below" and not body.below_cents:
            raise bad_request("Kies een bedrag voor de grens.", "below_required")
        if not tx["merchant_key"] or learning.is_intermediary(tx["merchant_key"]):
            scope = "one"
        if scope == "one":
            db.update(conn, "transactions", tx_id, {"category_id": body.category_id,
                                                    "category_source": "user",
                                                    "category_reason": "user",
                                                    "updated_at": db.now_iso()})
        else:
            # This transaction follows the merchant again, even if it was set individually.
            db.update(conn, "transactions", tx_id, {"category_source": "rule"})
            if scope == "merchant":
                updated_count = learning.set_merchant_category(conn, tx["merchant_key"], body.category_id)
            else:
                updated_count = learning.set_merchant_below(conn, tx["merchant_key"], body.below_cents,
                                                            body.category_id)

    if "tag_ids" in sent and body.tag_ids is not None:
        check_tags(conn, body.tag_ids)
        before = {r["tag_id"] for r in db.rows(conn, "SELECT tag_id FROM transaction_tags WHERE transaction_id = ?", (tx_id,))}
        set_tags(conn, tx_id, body.tag_ids)
        if body.tag_always and tx["merchant_key"] and not learning.is_intermediary(tx["merchant_key"]):
            added = [t for t in body.tag_ids if t not in before] or body.tag_ids
            n = learning.set_merchant_tag(conn, tx["merchant_key"], added[0] if added else None)
            updated_count = max(updated_count, n)

    return {"transaction": tx_out(conn, tx_id), "updated_count": updated_count}


# ---------------------------------------------------------------- manual

@router.post("/transactions")
def create_transaction(body: TxCreate, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    check_account(conn, body.account_id)
    if body.category_id is not None:
        check_category(conn, body.category_id)
    check_tags(conn, body.tag_ids)
    day = iso_date(body.date)
    name, key = merchant_fields(body.merchant_name)
    now = db.now_iso()
    tx_id = db.insert(conn, "transactions", {
        "account_id": body.account_id, "dedupe_key": f"manual:{uuid.uuid4().hex}", "date": day,
        "amount_cents": body.amount_cents, "merchant_name": name, "merchant_key": key,
        "description": body.merchant_name.strip(), "method": "card" if body.amount_cents < 0 else "other",
        "category_id": body.category_id or db.unsorted_id(conn),
        "category_source": "user" if body.category_id else "none",
        "category_reason": "user" if body.category_id else "none", "kind": "normal",
        "note": (body.note or "").strip() or None, "manual": 1, "created_at": now, "updated_at": now,
    })
    if body.category_id is None:
        engine.classify_all(conn, ids=[tx_id])
    set_tags(conn, tx_id, body.tag_ids)
    return {"transaction": tx_out(conn, tx_id), "updated_count": 1}


@router.delete("/transactions/{tx_id}")
def delete_transaction(tx_id: int, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    tx = load_tx(conn, tx_id)
    if not tx["manual"]:
        raise ApiError(400, "not_manual", "Alleen zelf toegevoegde uitgaven kun je verwijderen.")
    conn.execute("DELETE FROM transactions WHERE id = ?", (tx_id,))
    return {"ok": True}


@router.post("/transactions/bulk")
def bulk_update(body: TxBulk, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    ids = list(dict.fromkeys(body.ids))
    existing = [r["id"] for r in db.rows(conn, f"SELECT id FROM transactions WHERE id IN ({db.placeholders(ids)})", ids)]
    if not existing:
        return {"updated_count": 0}
    if body.category_id is not None:
        check_category(conn, body.category_id)
        conn.execute(f"UPDATE transactions SET category_id = ?, category_source = 'user', "
                     f"category_reason = 'user', updated_at = ? "
                     f"WHERE id IN ({db.placeholders(existing)})", (body.category_id, db.now_iso(), *existing))
    check_tags(conn, body.add_tag_ids + body.remove_tag_ids)
    conn.executemany("INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)",
                     [(i, t) for i in existing for t in body.add_tag_ids])
    if body.remove_tag_ids:
        conn.execute(f"DELETE FROM transaction_tags WHERE transaction_id IN ({db.placeholders(existing)}) "
                     f"AND tag_id IN ({db.placeholders(body.remove_tag_ids)})",
                     (*existing, *body.remove_tag_ids))
    return {"updated_count": len(existing)}
