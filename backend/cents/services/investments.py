"""Holdings of investment accounts: DEGIRO imports, manual trades, value and result.

Model (SPEC 7.1)
- `trades`: buys (+quantity) and sells (-quantity) with their EUR value and fees.
- `cash_events`: dividends (+), dividend tax (-) and fees (-) from the account statement.
- `prices`: closing prices per ISIN and day, already converted to EUR (`close_eur`).

Figures per account (all cents)
- market value = sum over funds of quantity x latest price (price fallback: latest portfolio
  export or fetched price; else the last trade price).
- cost = average-cost basis of what is still held (fees included); realised = result of sells.
- price result ("koersresultaat", without dividend and costs) = market value - cost of what is
  held excluding fees + realised excluding fees.
- result (with dividend and costs) = price result + dividends - dividend tax - all fees.
- cash: DEGIRO keeps uninvested money in cash. When the bank side shows deposits, cash =
  deposits - net bought - fees + net dividends (never below 0). Balance = market value + cash.

Buys and sells never touch `transactions`, so they never count as spending.
"""

from __future__ import annotations

import bisect
import math
import sqlite3
from datetime import date, timedelta

from .. import db
from ..errors import ApiError
from ..importers import Source, degiro

STALE_DAYS = 4


# ---------------------------------------------------------------- import

def pick_account(conn: sqlite3.Connection, account_id: int | None, result: dict) -> dict | None:
    """The investment account a DEGIRO file goes to. Creates "DEGIRO" when there is none.
    With several and no choice: sets result error_code 'choose_account' and returns None."""
    from . import imports as import_service
    if account_id is not None:
        acc = db.row(conn, "SELECT * FROM accounts WHERE id = ? AND type = 'investment'", (account_id,))
        if not acc:
            raise ApiError(422, "invalid", "Kies een beleggingsrekening.")
        return acc
    accs = db.rows(conn, "SELECT * FROM accounts WHERE type = 'investment' ORDER BY sort, id")
    if len(accs) > 1:
        named = [a for a in accs if "degiro" in a["name"].lower()]
        if len(named) == 1:
            return named[0]
        result["error_code"] = "choose_account"
        result["choices"] = [{"id": a["id"], "name": a["name"]} for a in accs]
        result["error"] = "Bij welke beleggingsrekening hoort dit bestand?"
        return None
    if accs:
        return accs[0]
    new_id = import_service.create_account(conn, "DEGIRO", "investment", None, ["degiro", "flatex"],
                                           source="user")
    acc = db.row(conn, "SELECT * FROM accounts WHERE id = ?", (new_id,))
    result["new_accounts"].append({"id": acc["id"], "name": acc["name"], "type": "investment", "iban": None})
    result["is_new_account"] = True
    return acc


def upsert_security(conn: sqlite3.Connection, isin: str, name: str | None, currency: str | None = None,
                    exchange: str | None = None, symbol: str | None = None) -> None:
    cur = db.row(conn, "SELECT * FROM securities WHERE isin = ?", (isin,))
    if not cur:
        db.insert(conn, "securities", {"isin": isin, "name": (name or isin)[:120], "currency": currency,
                                       "exchange": exchange, "symbol": symbol})
        return
    upd = {k: v for k, v in (("currency", currency), ("exchange", exchange), ("symbol", symbol))
           if v and not cur[k]}
    if name and cur["name"] == isin:
        upd["name"] = name[:120]
    if upd:
        conn.execute(f"UPDATE securities SET {', '.join(f'{k} = ?' for k in upd)} WHERE isin = ?",
                     (*upd.values(), isin))


def _qty_key(q: float) -> str:
    return f"{q:.6f}".rstrip("0").rstrip(".")


def import_degiro(conn: sqlite3.Connection, filename: str, source: Source, fmt: str,
                  account_id: int | None, result: dict) -> None:
    """Store one DEGIRO file. Fills `result` like a bank import (new / duplicates / dates)."""
    kind, header, rows = degiro.read(source)
    acc = pick_account(conn, account_id, result)
    if acc is None:
        return
    result["account_id"], result["account_name"] = acc["id"], acc["name"]
    now = db.now_iso()
    import_id = db.insert(conn, "imports", {"filename": filename, "format": fmt, "imported_at": now,
                                            "account_id": acc["id"]})
    days: list[str] = []
    info: dict = {"kind": kind}
    if kind == "degiro_transactions":
        seen: dict[str, int] = {}
        for t in degiro.parse_transactions(header, rows):
            upsert_security(conn, t["isin"], t["name"], t["currency"], t["exchange"])
            key = None
            if t["order_id"]:
                base = f"{acc['id']}|{t['order_id']}|{t['isin']}|{t['date']}|{_qty_key(t['quantity'])}"
                seen[base] = seen.get(base, 0) + 1
                key = f"{base}|{seen[base]}"
                if db.value(conn, "SELECT 1 FROM trades WHERE dedupe_key = ?", (key,)):
                    result["duplicates"] += 1
                    days.append(t["date"])
                    continue
            elif db.value(conn, """SELECT 1 FROM trades WHERE account_id = ? AND date = ? AND isin = ?
                                   AND quantity = ? AND value_eur_cents = ?""",
                          (acc["id"], t["date"], t["isin"], t["quantity"], t["value_eur_cents"])):
                result["duplicates"] += 1
                continue
            db.insert(conn, "trades", {
                "account_id": acc["id"], "import_id": import_id, "date": t["date"], "time": t["time"],
                "isin": t["isin"], "quantity": t["quantity"], "price": t["price"],
                "currency": t["currency"], "fx_rate": t["fx_rate"],
                "value_eur_cents": t["value_eur_cents"], "fees_cents": t["fees_cents"],
                "order_id": t["order_id"], "dedupe_key": key, "manual": 0, "created_at": now})
            result["new"] += 1
            days.append(t["date"])
    elif kind == "degiro_account":
        seen = {}
        for e in degiro.parse_account(header, rows):
            if e["amount_cents"] is None:
                continue
            if e["isin"]:
                upsert_security(conn, e["isin"], e["name"])
            base = f"{acc['id']}|{e['date']}|{e['time']}|{e['isin']}|{e['kind']}|{e['currency']}|{e['amount_local']:.4f}"
            seen[base] = seen.get(base, 0) + 1
            key = f"{base}|{seen[base]}"
            days.append(e["date"])
            if db.value(conn, "SELECT 1 FROM cash_events WHERE dedupe_key = ?", (key,)):
                result["duplicates"] += 1
                continue
            db.insert(conn, "cash_events", {
                "account_id": acc["id"], "import_id": import_id, "date": e["date"], "isin": e["isin"],
                "kind": e["kind"], "amount_cents": e["amount_cents"], "currency": e["currency"],
                "amount_local": e["amount_local"], "description": e["description"], "dedupe_key": key})
            result["new"] += 1
    else:
        today = date.today().isoformat()
        held = {h["isin"]: h for h in holdings(conn, acc["id"])["holdings"]}
        mismatch, in_file = [], set()
        for p in degiro.parse_portfolio(header, rows):
            isin = p["ident"] if p["is_isin"] else db.value(
                conn, "SELECT isin FROM securities WHERE symbol = ? OR UPPER(name) = ?",
                (p["ident"], p["name"].upper()))
            if not isin:
                continue
            in_file.add(isin)
            upsert_security(conn, isin, p["name"], p["currency"],
                            symbol=None if p["is_isin"] else p["ident"])
            close_eur = p["close_eur"] if p["close_eur"] is not None else (p["close"] if p["currency"] == "EUR" else None)
            if close_eur is not None:
                conn.execute("""INSERT INTO prices (isin, date, source, close, currency, close_eur, import_id)
                                VALUES (?, ?, 'degiro_portfolio', ?, ?, ?, ?)
                                ON CONFLICT(isin, date, source) DO UPDATE SET close = excluded.close,
                                currency = excluded.currency, close_eur = excluded.close_eur,
                                import_id = excluded.import_id""",
                             (isin, today, p["close"], p["currency"], close_eur, import_id))
                result["new"] += 1
            have = held.get(isin, {}).get("quantity", 0)
            if abs(have - p["quantity"]) > 1e-6:
                mismatch.append({"isin": isin, "name": p["name"], "quantity": have, "file_quantity": p["quantity"]})
        for isin, h in held.items():                     # held in Cents, missing in the file
            if h["quantity"] > 1e-6 and isin not in in_file:
                mismatch.append({"isin": isin, "name": h["name"], "quantity": h["quantity"], "file_quantity": 0})
        info["mismatch"] = mismatch
        days.append(today)
    result["investment"] = info
    result.update({"ok": True, "import_id": import_id,
                   "date_from": min(days) if days else None, "date_to": max(days) if days else None})
    db.update(conn, "imports", import_id, {"n_new": result["new"], "n_duplicate": result["duplicates"],
                                           "date_from": result["date_from"], "date_to": result["date_to"]})


# ---------------------------------------------------------------- manual trades

def add_trade(conn: sqlite3.Connection, account_id: int, *, day: str, isin: str, name: str | None,
              quantity: float, price_cents: int, fees_cents: int) -> int:
    upsert_security(conn, isin, name, "EUR")
    value = -int(round(quantity * price_cents))
    return db.insert(conn, "trades", {
        "account_id": account_id, "import_id": None, "date": day, "time": None, "isin": isin,
        "quantity": quantity, "price": price_cents / 100, "currency": "EUR", "fx_rate": None,
        "value_eur_cents": value, "fees_cents": fees_cents, "order_id": None, "dedupe_key": None,
        "manual": 1, "created_at": db.now_iso()})


# ---------------------------------------------------------------- prices

class PriceBook:
    """Latest EUR price per ISIN on or before a day (fetched, portfolio export, else trades)."""

    def __init__(self, conn: sqlite3.Connection, isins: list[str]):
        self.series: dict[str, tuple[list[str], list[float], list[str]]] = {}
        for isin in isins:
            rows = db.rows(conn, """SELECT date, source, close_eur FROM trades_prices
                                    WHERE isin = ? ORDER BY date, prio""", (isin,))
            name = db.value(conn, "SELECT name FROM securities WHERE isin = ?", (isin,)) or ""
            scale = _source_scales(rows, any_gap="%" in name)
            pts: dict[str, tuple[float, str]] = {}
            for r in rows:
                pts[r["date"]] = (r["close_eur"] * scale.get(r["source"], 1.0), r["source"])
            days = sorted(pts)
            self.series[isin] = (days, [pts[d][0] for d in days], [pts[d][1] for d in days])

    def at(self, isin: str, day: str) -> tuple[float | None, str | None, str | None]:
        days, vals, srcs = self.series.get(isin, ([], [], []))
        i = bisect.bisect_right(days, day)
        if not i:
            return None, None, None
        return vals[i - 1], days[i - 1], srcs[i - 1]


def _source_scales(rows: list, any_gap: bool = False) -> dict[str, float]:
    """Bonds are quoted as a percentage of the nominal amount (98.5 = 98.5 %), while a trade
    gives the real price per unit (value / quantity). A quote source can therefore be off by a
    power of ten. Per source, compare its price nearest to a trade (within 10 days) with that
    trade's real price; when they differ by about 10x, 100x or 1000x, rescale that source.
    Normal funds get factor 1. For a bond (a "%" in the name, like DEGIRO's "NL2.5%DSL...") the
    nearest trade counts at any distance: a bond does not move tenfold."""
    trades = [(date.fromisoformat(r["date"]), r["close_eur"]) for r in rows
              if r["source"] == "trade" and r["close_eur"]]
    if not trades:
        return {}
    out: dict[str, float] = {}
    for src in {r["source"] for r in rows} - {"trade"}:
        best = None
        for r in rows:
            if r["source"] != src or not r["close_eur"] or r["close_eur"] <= 0:
                continue
            d = date.fromisoformat(r["date"])
            for td, tp in trades:
                gap = abs((d - td).days)
                if (gap <= 10 or any_gap) and (best is None or gap < best[0]):
                    best = (gap, tp / r["close_eur"])
        if best is None:
            continue
        exp = math.log10(best[1])
        k = round(exp)
        if k != 0 and abs(exp - k) < 0.2:
            out[src] = 10.0 ** k
    return out


PRICE_VIEW = """CREATE TEMP VIEW IF NOT EXISTS trades_prices AS
    SELECT isin, date, source, close_eur, CASE source WHEN 'degiro_portfolio' THEN 2 ELSE 1 END AS prio
    FROM prices
    UNION ALL
    SELECT isin, date, 'trade' AS source,
           ABS(CAST(value_eur_cents AS REAL)) / 100.0 / ABS(quantity) AS close_eur, 0 AS prio
    FROM trades WHERE quantity != 0"""


def _price_book(conn: sqlite3.Connection, isins: list[str]) -> PriceBook:
    conn.execute(PRICE_VIEW)
    return PriceBook(conn, isins)


# ---------------------------------------------------------------- holdings

def _deposits(conn: sqlite3.Connection, account_id: int) -> list[tuple[str, int]]:
    """Cumulative net money moved in. DEGIRO's own account statement (deposits and withdrawals)
    when imported: it is complete, also for money from a bank account that is not in Cents.
    Else the bank side: transfers from own checking/savings accounts."""
    own = db.rows(conn, """SELECT date, amount_cents FROM cash_events WHERE account_id = ?
                           AND kind IN ('deposit', 'withdrawal') ORDER BY date, id""", (account_id,))
    if own:
        out, total = [], 0
        for f in own:
            total += f["amount_cents"]
            out.append((f["date"], total))
        return out
    flows = db.rows(conn, """
        SELECT t.date, t.amount_cents FROM transactions t JOIN accounts a ON a.id = t.account_id
        WHERE t.transfer_account_id = ? AND a.type IN ('checking', 'savings') ORDER BY t.date, t.id""", (account_id,))
    out, total = [], 0
    for f in flows:
        total += -f["amount_cents"]
        out.append((f["date"], total))
    return out


def has_holdings(conn: sqlite3.Connection, account_id: int) -> bool:
    return bool(db.value(conn, "SELECT 1 FROM trades WHERE account_id = ? LIMIT 1", (account_id,)))


def _replay(trades: list[dict]) -> dict[str, dict]:
    """Average-cost bookkeeping per ISIN over trades (sorted by date)."""
    state: dict[str, dict] = {}
    for t in trades:
        s = state.setdefault(t["isin"], {"quantity": 0.0, "cost": 0, "cost_ex": 0, "realised": 0,
                                         "realised_ex": 0, "fees": 0, "bought": 0, "sold": 0})
        q = t["quantity"]
        amount = abs(t["value_eur_cents"])
        s["fees"] += t["fees_cents"]
        if q > 0:
            s["cost"] += amount + t["fees_cents"]
            s["cost_ex"] += amount
            s["quantity"] += q
            s["bought"] += amount + t["fees_cents"]
        else:
            held = s["quantity"]
            share = min(1.0, -q / held) if held > 0 else 0.0
            part, part_ex = round(s["cost"] * share), round(s["cost_ex"] * share)
            s["realised"] += amount - t["fees_cents"] - part
            s["realised_ex"] += amount - part_ex
            s["cost"] -= part
            s["cost_ex"] -= part_ex
            s["quantity"] += q
            s["sold"] += amount - t["fees_cents"]
            if abs(s["quantity"]) < 1e-9:
                s["quantity"], s["cost"], s["cost_ex"] = 0.0, 0, 0
    return state


def holdings(conn: sqlite3.Connection, account_id: int, today: str | None = None) -> dict:
    """Holdings and figures of one investment account (GET /accounts/{id}/holdings)."""
    today = today or date.today().isoformat()
    trades = db.rows(conn, """SELECT t.*, s.name FROM trades t JOIN securities s ON s.isin = t.isin
                              WHERE t.account_id = ? ORDER BY t.date, t.time, t.id""", (account_id,))
    events = db.rows(conn, "SELECT * FROM cash_events WHERE account_id = ? "
                           "AND kind IN ('dividend', 'dividend_tax', 'fee') ORDER BY date, id", (account_id,))
    isins = sorted({t["isin"] for t in trades})
    book = _price_book(conn, isins)
    state = _replay(trades)
    names = {r["isin"]: r for r in db.rows(conn, f"SELECT * FROM securities WHERE isin IN ({db.placeholders(isins)})", isins)}
    div_by = {}
    for e in events:
        if e["isin"] and e["kind"] in ("dividend", "dividend_tax"):
            div_by[e["isin"]] = div_by.get(e["isin"], 0) + e["amount_cents"]

    items, value_total, oldest_price = [], 0, None
    for isin in isins:
        s = state[isin]
        price, pday, psrc = book.at(isin, today)
        value = int(round(s["quantity"] * price * 100)) if price is not None and s["quantity"] else 0
        if s["quantity"]:
            value_total += value
            if pday and (oldest_price is None or pday < oldest_price):
                oldest_price = pday
        avg = int(round(s["cost"] / s["quantity"])) if s["quantity"] > 0 else None
        price_result = value - s["cost_ex"] + s["realised_ex"]
        items.append({
            "isin": isin, "name": names[isin]["name"], "symbol": names[isin]["symbol"],
            "price_symbol": names[isin]["price_symbol"], "currency": names[isin]["currency"],
            "quantity": round(s["quantity"], 6), "avg_price_cents": avg,
            "price_cents": int(round(price * 100)) if price is not None else None,
            "price_date": pday, "price_source": psrc, "value_cents": value,
            "cost_cents": s["cost"], "realised_cents": s["realised"],
            "result_cents": value - s["cost"] + s["realised"] + div_by.get(isin, 0),
            "price_result_cents": price_result, "dividends_cents": div_by.get(isin, 0),
            "fees_cents": s["fees"],
            "trades": [{"id": t["id"], "date": t["date"], "quantity": t["quantity"],
                        "price": t["price"], "currency": t["currency"],
                        "value_eur_cents": t["value_eur_cents"], "fees_cents": t["fees_cents"],
                        "manual": bool(t["manual"])} for t in reversed(trades) if t["isin"] == isin],
        })
    items.sort(key=lambda h: (-(h["quantity"] > 0), -h["value_cents"]))

    dividends = sum(e["amount_cents"] for e in events if e["kind"] == "dividend")
    div_tax = -sum(e["amount_cents"] for e in events if e["kind"] == "dividend_tax")
    fee_events = -sum(e["amount_cents"] for e in events if e["kind"] == "fee")
    trade_fees = sum(s["fees"] for s in state.values())
    net_bought = sum(s["bought"] - s["sold"] for s in state.values())
    price_result = sum(h["price_result_cents"] for h in items)
    deposits = _deposits(conn, account_id)
    bank_invested = deposits[-1][1] if deposits else None
    cash = 0
    if bank_invested is not None:
        cash = max(0, bank_invested - net_bought - fee_events + dividends - div_tax)
    invested = bank_invested if bank_invested is not None else net_bought + fee_events
    result = price_result + dividends - div_tax - trade_fees - fee_events
    base = invested if invested and invested > 0 else None
    stale = oldest_price is not None and oldest_price < (date.fromisoformat(today) - timedelta(days=STALE_DAYS)).isoformat()
    return {
        "account_id": account_id, "holdings": items, "market_value_cents": value_total,
        "cash_cents": cash, "value_cents": value_total + cash,
        "invested_cents": invested,
        "invested_source": ("degiro" if db.value(conn, "SELECT 1 FROM cash_events WHERE account_id = ? AND kind "
                                             "IN ('deposit', 'withdrawal') LIMIT 1", (account_id,))
                            else "bank") if bank_invested is not None else "trades",
        "net_bought_cents": net_bought,
        "result_cents": result, "result_pct": round(result / base, 4) if base else None,
        "price_result_cents": price_result,
        "price_result_pct": round(price_result / base, 4) if base else None,
        "dividends_cents": dividends - div_tax, "dividend_tax_cents": div_tax,
        "costs_cents": trade_fees + fee_events,
        "price_date": oldest_price, "price_stale": stale,
        "events": [{"id": e["id"], "date": e["date"], "isin": e["isin"], "kind": e["kind"],
                    "amount_cents": e["amount_cents"], "description": e["description"]}
                   for e in reversed(events)][:200],
    }


def value_timeline(conn: sqlite3.Connection, account_id: int):
    """value_at(day) -> cents (market value + cash) for net-worth history and the chart."""
    trades = db.rows(conn, "SELECT * FROM trades WHERE account_id = ? ORDER BY date, time, id", (account_id,))
    events = db.rows(conn, "SELECT date, kind, amount_cents FROM cash_events WHERE account_id = ? "
                           "AND kind IN ('dividend', 'dividend_tax', 'fee') ORDER BY date", (account_id,))
    isins = sorted({t["isin"] for t in trades})
    book = _price_book(conn, isins)
    deposits = _deposits(conn, account_id)
    dep_days = [d for d, _ in deposits]
    trade_days = [t["date"] for t in trades]
    ev_days = [e["date"] for e in events]

    def value_at(day: str) -> int | None:
        n = bisect.bisect_right(trade_days, day)
        if not n:
            i = bisect.bisect_right(dep_days, day)
            return deposits[i - 1][1] if i else None
        qty: dict[str, float] = {}
        net = 0
        for t in trades[:n]:
            qty[t["isin"]] = qty.get(t["isin"], 0) + t["quantity"]
            net += -t["value_eur_cents"] + t["fees_cents"]
        market = 0
        for isin, q in qty.items():
            if abs(q) < 1e-9:
                continue
            p, _, _ = book.at(isin, day)
            market += int(round(q * (p or 0) * 100))
        cash = 0
        i = bisect.bisect_right(dep_days, day)
        if deposits:
            ev = sum(e["amount_cents"] for e in events[:bisect.bisect_right(ev_days, day)])
            cash = max(0, (deposits[i - 1][1] if i else 0) - net + ev)
        return market + cash

    first = trade_days[0] if trade_days else None
    return value_at, first


def chart(conn: sqlite3.Connection, account_id: int, today: str | None = None) -> list[dict]:
    """Weekly points (plus today) of value and money put in, from the first trade."""
    today = today or date.today().isoformat()
    value_at, first = value_timeline(conn, account_id)
    if not first:
        return []
    deposits = _deposits(conn, account_id)
    dep_days = [d for d, _ in deposits]
    trades = db.rows(conn, "SELECT date, value_eur_cents, fees_cents FROM trades WHERE account_id = ? ORDER BY date", (account_id,))
    out = []
    day = date.fromisoformat(first)
    end = date.fromisoformat(today)
    step = timedelta(days=7 if (end - day).days <= 3 * 366 else 14)
    while True:
        iso = min(day, end).isoformat()
        if deposits:
            i = bisect.bisect_right(dep_days, iso)
            inv = deposits[i - 1][1] if i else 0
        else:
            inv = sum(-t["value_eur_cents"] + t["fees_cents"] for t in trades if t["date"] <= iso)
        out.append({"date": iso, "value_cents": value_at(iso) or 0, "invested_cents": inv})
        if day >= end:
            break
        day += step
    return out
