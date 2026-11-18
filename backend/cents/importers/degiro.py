"""DEGIRO CSV exports (see docs/research/degiro-format.md).

Three files, Dutch or English headers, comma or semicolon separated, decimal comma or point:

- Transactions ("Transacties.csv"): one row per (partial) fill.
- Account statement ("Account.csv" / Rekeningoverzicht): we keep dividends, dividend tax and
  fees that are not already in the transactions file, and deposits/withdrawals (they make
  "ingelegd" complete when a deposit is missing on the bank side). Cash sweeps, reservations and
  currency conversions are ignored.
- Portfolio ("Portfolio.csv" / Portefeuille): a snapshot with closing prices.

Amount columns come in pairs: a named column and an unnamed one next to it, one holding the
currency code and the other the number (the order differs per file). `_money` reads either.
"""

from __future__ import annotations

import csv
import io
import re
from datetime import date

from . import ImportFormatError, Source, as_stream

ISIN_RE = re.compile(r"^[A-Z]{2}[A-Z0-9]{9}[0-9]$")
CUR_RE = re.compile(r"^[A-Z]{3}$")

TX_COLS = {
    "date": ("datum", "date"), "time": ("tijd", "time"), "product": ("product",),
    "isin": ("isin",), "exchange": ("beurs", "reference exchange", "exchange"),
    "venue": ("uitvoeringsplaats", "venue"), "quantity": ("aantal", "quantity", "number"),
    "price": ("koers", "price"), "local": ("lokale waarde", "local value"),
    "value": ("waarde", "value", "value eur", "waarde eur"),
    "fx": ("wisselkoers", "exchange rate"),
    "fees": ("transactiekosten", "transaction", "transaction costs", "kosten"),
    "total": ("totaal", "total", "totaal eur", "total eur"), "order": ("order id", "order"),
}
ACC_COLS = {
    "date": ("datum", "date"), "time": ("tijd", "time"), "product": ("product",),
    "isin": ("isin",), "description": ("omschrijving", "description"), "fx": ("fx",),
    "change": ("mutatie", "change"), "order": ("order id", "order"),
}
PF_COLS = {
    "product": ("product",), "isin": ("symbool/isin", "symbol/isin", "isin"),
    "quantity": ("aantal", "quantity", "amount"), "close": ("slotkoers", "closing", "close", "closing price"),
    "local": ("lokale waarde", "local value"), "value": ("waarde in eur", "value in eur", "waarde", "value"),
}

# Account statement rows we keep (lowercase substrings of the description), first match wins.
EVENT_KINDS = [
    # money in and out of DEGIRO itself (bank deposits, withdrawals); checked against SKIP first
    ("withdrawal", ("terugstorting", "withdrawal", "opname")),
    ("deposit", ("storting", "deposit")),
    ("dividend_tax", ("dividendbelasting", "dividend tax", "bronbelasting", "withholding tax")),
    ("dividend", ("dividend",)),
    ("fee", ("aansluitingskosten", "connection fee", "servicekosten", "service fee",
             "adr/gdr", "kosten van derden voor aansluiting")),
]


MOVE_SKIP = ("reserv", "sweep", "overboeking", "geldrekening", "cash fund")


def decode(raw: bytes) -> str:
    for enc in ("utf-8-sig", "cp1252"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("latin-1")


def _rows(text: str) -> list[list[str]]:
    first = text.split("\n", 1)[0]
    delim = ";" if first.count(";") > first.count(",") else ","
    return [r for r in csv.reader(io.StringIO(text), delimiter=delim) if any(c.strip() for c in r)]


def _norm(h: str) -> str:
    return re.sub(r"\s+", " ", (h or "").strip().strip('"').lower())


def kind_of_header(header: list[str]) -> str | None:
    names = {_norm(h) for h in header}
    has = lambda *opts: any(o in names for o in opts)  # noqa: E731
    if has("isin", "symbool/isin", "symbol/isin") and has("slotkoers", "closing", "close", "closing price"):
        return "degiro_portfolio"
    if has("isin") and has("aantal", "quantity", "number") and has("koers", "price"):
        return "degiro_transactions"
    if has("omschrijving", "description") and has("mutatie", "change"):
        return "degiro_account"
    return None


def looks_like(head_text: str) -> str | None:
    rows = _rows(head_text.split("\n", 2)[0] + "\n")
    return kind_of_header(rows[0]) if rows else None


def _index(header: list[str], spec: dict[str, tuple[str, ...]]) -> dict[str, int]:
    names = [_norm(h) for h in header]
    out: dict[str, int] = {}
    for key, opts in spec.items():
        for i, n in enumerate(names):
            if i in out.values():
                continue
            if n in opts or (key == "fees" and (n.startswith("transactiekosten") or n.startswith("transaction"))):
                out[key] = i
                break
    return out


def number(text: str | None) -> float | None:
    """'1.234,56' / '1,234.56' / '-75,12' / '75.12' -> float; '' -> None."""
    s = (text or "").strip().replace(" ", "").replace(" ", "")
    if not s:
        return None
    if "," in s and "." in s:
        if s.rfind(",") > s.rfind("."):
            s = s.replace(".", "").replace(",", ".")
        else:
            s = s.replace(",", "")
    elif "," in s:
        s = s.replace(",", ".")
    try:
        return float(s)
    except ValueError:
        return None


def _cell(row: list[str], i: int | None) -> str:
    return row[i].strip() if i is not None and i < len(row) else ""


def _money(row: list[str], header: list[str], i: int | None) -> tuple[float | None, str | None]:
    """The (number, currency) of a named amount column and the unnamed column next to it."""
    if i is None:
        return None, None
    cells = [_cell(row, i)]
    if i + 1 < len(header) and not _norm(header[i + 1]):
        cells.append(_cell(row, i + 1))
    num, cur = None, None
    for c in cells:
        parts = c.split()
        for p in parts:
            if CUR_RE.match(p):
                cur = cur or p
            elif number(p) is not None and num is None:
                num = number(p)
    return num, cur


def cents(x: float | None) -> int | None:
    return None if x is None else int(round(x * 100))


def parse_date(text: str) -> str:
    s = (text or "").strip()
    for pat in (r"(\d{1,2})-(\d{1,2})-(\d{4})", r"(\d{1,2})/(\d{1,2})/(\d{4})", r"(\d{1,2})\.(\d{1,2})\.(\d{4})"):
        m = re.fullmatch(pat, s)
        if m:
            return date(int(m[3]), int(m[2]), int(m[1])).isoformat()
    try:
        return date.fromisoformat(s).isoformat()
    except ValueError:
        raise ImportFormatError(f"Deze datum begrijp ik niet: {s!r}.") from None


def read(source: Source) -> tuple[str, list[str], list[list[str]]]:
    rows = _rows(decode(as_stream(source).read()))
    if not rows:
        raise ImportFormatError("Dit bestand is leeg.")
    kind = kind_of_header(rows[0])
    if not kind:
        raise ImportFormatError("Dit DEGIRO-bestand herken ik niet.")
    return kind, rows[0], rows[1:]


def parse_transactions(header: list[str], rows: list[list[str]]) -> list[dict]:
    ix = _index(header, TX_COLS)
    out = []
    for r in rows:
        isin = _cell(r, ix.get("isin")).upper()
        qty = number(_cell(r, ix.get("quantity")))
        if not ISIN_RE.match(isin) or not qty:
            continue
        price, cur = _money(r, header, ix.get("price"))
        local, local_cur = _money(r, header, ix.get("local"))
        value, _ = _money(r, header, ix.get("value"))
        fees, _ = _money(r, header, ix.get("fees"))
        fx = number(_cell(r, ix.get("fx")))
        currency = cur or local_cur or "EUR"
        if price is None:
            raise ImportFormatError("In dit bestand mist een koers.")
        if value is None:
            base = local if local is not None else -qty * price
            value = base / fx if fx else base
        out.append({
            "date": parse_date(_cell(r, ix.get("date"))), "time": _cell(r, ix.get("time")) or None,
            "name": _cell(r, ix.get("product")) or isin, "isin": isin,
            "exchange": _cell(r, ix.get("exchange")) or None, "quantity": qty, "price": price,
            "currency": currency, "fx_rate": fx if fx and currency != "EUR" else None,
            "value_eur_cents": cents(value), "fees_cents": abs(cents(fees) or 0),
            "order_id": _cell(r, ix.get("order")) or None,
        })
    return out


def parse_account(header: list[str], rows: list[list[str]]) -> list[dict]:
    ix = _index(header, ACC_COLS)
    fx_by_date: dict[tuple[str, str], float] = {}
    parsed = []
    for r in rows:
        desc = _cell(r, ix.get("description"))
        amount, cur = _money(r, header, ix.get("change"))
        if amount is None:
            continue
        day = parse_date(_cell(r, ix.get("date")))
        fx = number(_cell(r, ix.get("fx")))
        if fx and cur and cur != "EUR":
            fx_by_date[(day, cur)] = fx
        parsed.append((r, day, desc, amount, cur or "EUR", fx))
    out = []
    for r, day, desc, amount, cur, fx in parsed:
        low = desc.lower()
        kind = next((k for k, keys in EVENT_KINDS if any(x in low for x in keys)), None)
        if kind is None:
            continue
        if kind in ("deposit", "withdrawal"):
            # a reservation is followed by the real deposit; sweeps between DEGIRO and its
            # flatex cash account are not money in or out
            if any(x in low for x in MOVE_SKIP) or cur != "EUR":
                continue
            if (kind == "deposit") != (amount > 0):
                continue
        rate = 1.0 if cur == "EUR" else (fx or fx_by_date.get((day, cur))
                                         or next((v for (d, c), v in sorted(fx_by_date.items()) if c == cur and d >= day), None))
        isin = _cell(r, ix.get("isin")).upper()
        out.append({
            "date": day, "time": _cell(r, ix.get("time")) or None,
            "isin": isin if ISIN_RE.match(isin) else None, "name": _cell(r, ix.get("product")) or None,
            "kind": kind, "currency": cur, "amount_local": amount,
            "amount_cents": cents(amount / rate) if rate else None, "description": desc[:200],
        })
    return out


def parse_portfolio(header: list[str], rows: list[list[str]]) -> list[dict]:
    ix = _index(header, PF_COLS)
    out = []
    for r in rows:
        ident = _cell(r, ix.get("isin")).upper()
        qty = number(_cell(r, ix.get("quantity")))
        if not ident or not qty:
            continue                                        # cash rows have no symbol/quantity
        close, cur_close = _money(r, header, ix.get("close"))
        local, cur_local = _money(r, header, ix.get("local"))
        value_eur, _ = _money(r, header, ix.get("value"))
        currency = cur_local or cur_close or "EUR"
        if close is None and local is not None:
            close = local / qty
        if close is None:
            continue
        if value_eur is None and currency == "EUR":
            value_eur = local if local is not None else close * qty
        out.append({"ident": ident, "is_isin": bool(ISIN_RE.match(ident)),
                    "name": _cell(r, ix.get("product")) or ident, "quantity": qty,
                    "close": close, "currency": currency,
                    "close_eur": (value_eur / qty) if value_eur is not None else None})
    return out
