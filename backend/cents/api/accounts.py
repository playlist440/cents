"""Own accounts and manual account values (investments)."""

from __future__ import annotations

import json
import sqlite3

from fastapi import APIRouter, Depends

from .. import db
from ..classify import engine
from ..errors import ApiError, not_found
from ..importers.normalize import clean_iban
from ..importers import degiro
from ..schemas import AccountCreate, AccountPatch, AccountValueBody, SecurityPatch, TradeBody, iso_date
from ..services import imports as import_service
from ..services import investments, prices
from .deps import get_conn

router = APIRouter()


def account_json(conn: sqlite3.Connection, row: dict) -> dict:
    counts = db.row(conn, "SELECT COUNT(*) AS n, COALESCE(SUM(manual = 0), 0) AS imported "
                          "FROM transactions WHERE account_id = ?", (row["id"],))
    return {"id": row["id"], "iban": row["iban"], "name": row["name"], "type": row["type"],
            "match": json.loads(row["match"] or "[]"),
            "manual_balance_cents": row["manual_balance_cents"],
            "manual_balance_date": row["manual_balance_date"], "hidden": bool(row["hidden"]),
            "locked": bool(row["locked"]),
            "sort": row["sort"], "created_at": row["created_at"],
            "type_source": row["type_source"], "name_source": row["name_source"],
            "n_transactions": counts["n"], "n_imported": counts["imported"]}


def load_account(conn: sqlite3.Connection, account_id: int) -> dict:
    row = db.row(conn, "SELECT * FROM accounts WHERE id = ?", (account_id,))
    if not row:
        raise not_found("Deze rekening bestaat niet (meer).")
    return row


def _check_iban(conn: sqlite3.Connection, iban: str | None, own_id: int | None = None) -> str | None:
    iban = clean_iban(iban)
    if iban:
        other = db.value(conn, "SELECT id FROM accounts WHERE iban = ?", (iban,))
        if other and other != own_id:
            raise ApiError(409, "iban_exists", "Deze rekening bestaat al.")
    return iban


def _clean_match(match: list[str]) -> list[str]:
    return [m.strip().lower() for m in match if m and m.strip()]


@router.get("/accounts")
def list_accounts(conn: sqlite3.Connection = Depends(get_conn)) -> list[dict]:
    return [account_json(conn, a) for a in db.rows(conn, "SELECT * FROM accounts ORDER BY sort, id")]


@router.post("/accounts")
def create_account(body: AccountCreate, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    iban = _check_iban(conn, body.iban)
    match = _clean_match(body.match) if body.match is not None else None
    account_id = import_service.create_account(conn, body.name.strip(), body.type, iban, match,
                                               source="user")
    engine.classify_all(conn)
    return account_json(conn, load_account(conn, account_id))


@router.patch("/accounts/{account_id}")
def patch_account(account_id: int, body: AccountPatch, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    load_account(conn, account_id)
    sent = body.model_fields_set
    updates: dict = {}
    if "name" in sent and body.name:
        updates["name"] = body.name.strip()
        updates["name_source"] = "user"          # never renamed automatically again
    if "type" in sent and body.type:
        updates["type"] = body.type
        updates["type_source"] = "user"          # never re-typed automatically again
    if "iban" in sent:
        updates["iban"] = _check_iban(conn, body.iban, account_id)
    if "match" in sent:
        updates["match"] = json.dumps(_clean_match(body.match or []))
    if "hidden" in sent and body.hidden is not None:
        updates["hidden"] = int(body.hidden)
    if "locked" in sent and body.locked is not None:
        updates["locked"] = int(body.locked)
    if "sort" in sent and body.sort is not None:
        updates["sort"] = body.sort
    if "manual_balance_cents" in sent:
        updates["manual_balance_cents"] = body.manual_balance_cents
    if "manual_balance_date" in sent:
        updates["manual_balance_date"] = iso_date(body.manual_balance_date)
    db.update(conn, "accounts", account_id, updates)
    if {"type", "iban", "match"} & updates.keys():
        engine.classify_all(conn)
    return account_json(conn, load_account(conn, account_id))


@router.delete("/accounts/{account_id}")
def delete_account(account_id: int, force: int = 0, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    load_account(conn, account_id)
    imported = db.value(conn, "SELECT COUNT(*) FROM transactions WHERE account_id = ? AND manual = 0",
                        (account_id,)) or 0
    imported += db.value(conn, "SELECT COUNT(*) FROM trades WHERE account_id = ? AND manual = 0",
                         (account_id,)) or 0
    if imported and not force:
        raise ApiError(409, "has_transactions",
                       "Op deze rekening staan geïmporteerde betalingen. Weet je het zeker?")
    conn.execute("DELETE FROM accounts WHERE id = ?", (account_id,))
    import_service.refresh_accounts(conn)
    engine.classify_all(conn)
    return {"ok": True}


# ---------------------------------------------------------------- values

def value_json(row: dict) -> dict:
    return {"id": row["id"], "account_id": row["account_id"], "date": row["date"],
            "value_cents": row["value_cents"]}


@router.get("/accounts/{account_id}/values")
def list_values(account_id: int, conn: sqlite3.Connection = Depends(get_conn)) -> list[dict]:
    load_account(conn, account_id)
    return [value_json(r) for r in db.rows(
        conn, "SELECT * FROM account_values WHERE account_id = ? ORDER BY date, id", (account_id,))]


@router.post("/accounts/{account_id}/values")
def add_value(account_id: int, body: AccountValueBody, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    load_account(conn, account_id)
    value_id = db.insert(conn, "account_values", {"account_id": account_id, "date": iso_date(body.date),
                                                  "value_cents": body.value_cents})
    return value_json(db.row(conn, "SELECT * FROM account_values WHERE id = ?", (value_id,)))


@router.delete("/account-values/{value_id}")
def delete_value(value_id: int, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    if not conn.execute("DELETE FROM account_values WHERE id = ?", (value_id,)).rowcount:
        raise not_found("Deze waarde bestaat niet (meer).")
    return {"ok": True}


# ---------------------------------------------------------------- holdings (SPEC 7.1)

@router.get("/accounts/{account_id}/holdings")
def get_holdings(account_id: int, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    acc = load_account(conn, account_id)
    if acc["type"] != "investment":
        raise ApiError(422, "not_investment", "Dit is geen beleggingsrekening.")
    out = investments.holdings(conn, account_id)
    out["chart"] = investments.chart(conn, account_id)
    out["prices"] = prices.status(conn)
    return out


@router.post("/accounts/{account_id}/trades")
def add_trade(account_id: int, body: TradeBody, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    acc = load_account(conn, account_id)
    if acc["type"] != "investment":
        raise ApiError(422, "not_investment", "Dit is geen beleggingsrekening.")
    isin = body.isin.strip().upper()
    if not degiro.ISIN_RE.match(isin):
        raise ApiError(422, "bad_isin", "Deze ISIN klopt niet.")
    known = db.row(conn, "SELECT name FROM securities WHERE isin = ?", (isin,))
    if not known and not (body.name or "").strip():
        raise ApiError(422, "name_required", "Geef het fonds een naam.")
    quantity = body.quantity if body.side == "buy" else -body.quantity
    if body.side == "sell":
        held = next((h["quantity"] for h in investments.holdings(conn, account_id)["holdings"]
                     if h["isin"] == isin), 0)
        if body.quantity > held + 1e-6:
            raise ApiError(422, "too_many", "Zoveel heb je niet van dit fonds.")
    trade_id = investments.add_trade(conn, account_id, day=iso_date(body.date), isin=isin,
                                     name=(body.name or "").strip() or None, quantity=quantity,
                                     price_cents=body.price_cents, fees_cents=body.fees_cents)
    return {"id": trade_id}


@router.delete("/trades/{trade_id}")
def delete_trade(trade_id: int, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    row = db.row(conn, "SELECT manual FROM trades WHERE id = ?", (trade_id,))
    if not row:
        raise not_found("Deze aankoop bestaat niet (meer).")
    if not row["manual"]:
        raise ApiError(409, "imported", "Geïmporteerde transacties verwijder je via de import.")
    conn.execute("DELETE FROM trades WHERE id = ?", (trade_id,))
    return {"ok": True}


@router.get("/securities")
def list_securities(q: str = "", conn: sqlite3.Connection = Depends(get_conn)) -> list[dict]:
    like = f"%{q.strip().lower()}%"
    return db.rows(conn, """SELECT isin, name, symbol, currency, exchange, price_symbol FROM securities
                            WHERE LOWER(name) LIKE ? OR LOWER(isin) LIKE ? OR LOWER(COALESCE(symbol, '')) LIKE ?
                            ORDER BY name LIMIT 50""", (like, like, like))


@router.patch("/securities/{isin}")
def patch_security(isin: str, body: SecurityPatch, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    isin = isin.upper()
    if not db.row(conn, "SELECT 1 FROM securities WHERE isin = ?", (isin,)):
        raise not_found("Dit fonds ken ik niet.")
    sym = (body.price_symbol or "").strip() or None
    conn.execute("UPDATE securities SET price_symbol = ?, price_symbol_source = ? WHERE isin = ?",
                 (sym, "user" if sym else None, isin))
    return db.row(conn, "SELECT isin, name, symbol, currency, exchange, price_symbol FROM securities WHERE isin = ?", (isin,))
