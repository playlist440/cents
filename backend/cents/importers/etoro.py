"""eToro account statement (Excel, "Account Statement" / "Financieel overzicht"), see
docs/research/etoro-format.md.

The workbook has sheets in Dutch or English. We read:

- Accountactiviteit / Account Activity: deposits, withdrawals, fees, dividends, and the amount
  (USD) put into each opened position.
- Gesloten posities / Closed Positions: per position the amount, units, open and close date,
  profit in USD and EUR.
- Holdings: half-yearly snapshots of the open positions with units and value in USD and EUR
  (prices for those dates).

eToro keeps the account in US dollars. Cents works in euros: amounts are converted with the
USD/EUR rate the file itself shows nearest to that day (profit USD vs EUR, holdings value USD
vs EUR, deposit in EUR vs USD). Every position has a Positie-ID, so importing an overlapping
statement again (for example every month from 2020) adds only what is new.

The xlsx is read with the standard library (zip + XML), no extra dependency.
"""

from __future__ import annotations

import bisect
import re
import zipfile
from datetime import date, datetime, timedelta

from defusedxml import ElementTree as ET

from . import ImportFormatError, Source, as_stream

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
      "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
      "rel": "http://schemas.openxmlformats.org/package/2006/relationships"}
ISIN_RE = re.compile(r"^[A-Z]{2}[A-Z0-9]{9}[0-9]$")

SHEETS = {
    "activity": ("accountactiviteit", "account activity"),
    "closed": ("gesloten posities", "closed positions"),
    "holdings": ("holdings", "posities", "open positions"),
}
COLS = {
    "activity": {"date": ("datum", "date"), "type": ("type",), "details": ("details",),
                 "amount": ("bedrag", "amount"), "units": ("eenheden", "units"),
                 "pid": ("positie-id", "position id"), "asset": ("activatype", "asset type")},
    "closed": {"pid": ("positie-id", "position id"), "action": ("actie", "action"),
               "side": ("long / short",), "amount": ("bedrag", "amount"), "units": ("eenheden", "units"),
               "open": ("openingsdatum", "open date"), "close": ("sluitingsdatum", "close date"),
               "lev": ("hefboom", "leverage"), "profit_usd": ("winst (usd)", "profit(usd)", "profit (usd)"),
               "profit_eur": ("winst (eur)", "profit(eur)", "profit (eur)"), "type": ("type",),
               "isin": ("isin",)},
    "holdings": {"snap": ("snapshot date",), "asset": ("asset",), "pid": ("position id", "positie-id"),
                 "side": ("direction",), "open": ("open date",), "lev": ("leverage",),
                 "open_rate": ("open rate",), "units": ("units",), "rate": ("current rate",),
                 "usd": ("value in usd",), "eur": ("value in eur",), "isin": ("isin",)},
}

# activity types (lowercase substrings), first match wins
EVENT_KINDS = [
    ("skip", ("positie openen", "open position", "winst/verlies", "profit/loss", "kopi", "copy",
              "stop loss", "take profit", "corp action", "split")),
    ("fee", ("opnamekosten", "withdraw fee", "withdrawal fee", "kosten", "fee", "commiss")),
    ("withdrawal", ("opname", "withdraw", "terugstort")),
    ("deposit", ("storten", "storting", "deposit")),
    ("dividend", ("dividend",)),
]


def looks_like(head: bytes) -> bool:
    return head.startswith(b"PK\x03\x04")


# ---------------------------------------------------------------- xlsx

def _col(ref: str) -> int:
    n = 0
    for ch in ref:
        if not ch.isalpha():
            break
        n = n * 26 + (ord(ch.upper()) - 64)
    return n - 1


def read_workbook(source: Source) -> dict[str, list[list]]:
    """Sheet name (lowercase) -> rows of cell values (str or float)."""
    try:
        zf = zipfile.ZipFile(as_stream(source))
    except zipfile.BadZipFile:
        raise ImportFormatError("Dit Excel-bestand kan ik niet openen.") from None
    with zf:
        names = set(zf.namelist())
        if "xl/workbook.xml" not in names:
            raise ImportFormatError("Dit is geen Excel-bestand.")
        strings: list[str] = []
        if "xl/sharedStrings.xml" in names:
            for si in ET.fromstring(zf.read("xl/sharedStrings.xml")).findall("m:si", NS):
                strings.append("".join(t.text or "" for t in si.iter(f"{{{NS['m']}}}t")))
        rels = {r.get("Id"): r.get("Target") for r in
                ET.fromstring(zf.read("xl/_rels/workbook.xml.rels")).findall("rel:Relationship", NS)}
        out: dict[str, list[list]] = {}
        for sh in ET.fromstring(zf.read("xl/workbook.xml")).find("m:sheets", NS):
            target = rels.get(sh.get(f"{{{NS['r']}}}id"), "")
            path = target.lstrip("/") if target.startswith("/") else "xl/" + target
            if path not in names:
                continue
            rows = []
            for row in ET.fromstring(zf.read(path)).iter(f"{{{NS['m']}}}row"):
                vals: list = []
                for c in row.findall("m:c", NS):
                    i = _col(c.get("r", "")) if c.get("r") else len(vals)
                    t = c.get("t")
                    v = c.find("m:v", NS)
                    if t == "s" and v is not None:
                        val = strings[int(v.text)]
                    elif t == "inlineStr":
                        val = "".join(x.text or "" for x in c.iter(f"{{{NS['m']}}}t"))
                    elif v is None or v.text is None:
                        val = None
                    elif t in ("str", "e"):
                        val = v.text
                    elif t == "b":
                        val = v.text == "1"
                    else:
                        try:
                            val = float(v.text)
                        except ValueError:
                            val = v.text
                    while len(vals) < i:
                        vals.append(None)
                    vals.append(val)
                rows.append(vals)
            out[(sh.get("name") or "").strip().lower()] = rows
        return out


def is_statement(book: dict[str, list[list]]) -> bool:
    return any(n in book for n in SHEETS["activity"]) and any(n in book for n in SHEETS["closed"])


# ---------------------------------------------------------------- values

def _norm(h) -> str:
    return re.sub(r"\s+", " ", str(h or "").strip().lower())


def _table(book: dict, kind: str) -> list[dict]:
    rows = next((book[n] for n in SHEETS[kind] if n in book), None)
    if not rows:
        return []
    names = [_norm(h) for h in rows[0]]
    ix = {k: next((i for i, n in enumerate(names) if n in opts), None) for k, opts in COLS[kind].items()}
    out = []
    for r in rows[1:]:
        if not any(v not in (None, "") for v in r):
            continue
        out.append({k: (r[i] if i is not None and i < len(r) else None) for k, i in ix.items()})
    return out


def num(v) -> float | None:
    if isinstance(v, bool) or v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip().replace(" ", "").replace(" ", "")
    neg = s.startswith("(") and s.endswith(")")
    s = s.strip("()")
    if "," in s and "." in s:
        s = s.replace(",", "") if s.rfind(".") > s.rfind(",") else s.replace(".", "").replace(",", ".")
    elif "," in s:
        s = s.replace(",", ".")
    try:
        x = float(s)
    except ValueError:
        return None
    return -x if neg else x


def when(v) -> tuple[str, str | None] | None:
    """'31/12/2024 14:05:09' (day first) or an Excel serial -> (iso date, time)."""
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        d = datetime(1899, 12, 30) + timedelta(days=float(v))
        return d.date().isoformat(), d.strftime("%H:%M:%S")
    m = re.match(r"\s*(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:\s+(\d{1,2}:\d{2}(?::\d{2})?))?", str(v or ""))
    if m:
        try:
            return date(int(m[3]), int(m[2]), int(m[1])).isoformat(), m[4]
        except ValueError:
            return None
    m = re.match(r"\s*(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2})?))?", str(v or ""))
    return (m[1], m[2]) if m else None


def cents(x: float | None) -> int | None:
    return None if x is None else int(round(x * 100))


def _pid(v) -> str | None:
    if v is None:
        return None
    s = str(int(v)) if isinstance(v, float) and v.is_integer() else str(v).strip()
    return s if s and s != "-" else None


def _ticker(details) -> str:
    """'ASML.NV/EUR' -> 'ASML.NV'; 'AML.L/GBX 1:20' -> 'AML.L'."""
    return str(details or "").split("/")[0].split()[0].strip().upper() if details else ""


def _action_name(action) -> tuple[str | None, str | None]:
    """'ASML Holding NV (ASML.NV)' -> ('ASML Holding NV', 'ASML.NV')."""
    s = str(action or "").strip()
    m = re.match(r"(.*?)\s*\(([^()]+)\)\s*$", s)
    return (m[1].strip() or None, m[2].strip().upper()) if m else (s or None, None)


class Rates:
    """USD per EUR on a day, nearest point the file itself gives."""

    def __init__(self):
        self.pts: dict[str, list[float]] = {}

    def add(self, day: str | None, usd: float | None, eur: float | None) -> None:
        if not day or not usd or not eur or abs(eur) < 1:
            return
        r = usd / eur
        if 0.7 < r < 1.8:
            self.pts.setdefault(day, []).append(r)

    def at(self, day: str) -> float:
        if not self.pts:
            raise ImportFormatError("In dit eToro-bestand vind ik geen koers van dollar naar euro.")
        days = sorted(self.pts)
        i = bisect.bisect_left(days, day)
        near = min((d for d in days[max(0, i - 1):i + 1]),
                   key=lambda d: abs((date.fromisoformat(d) - date.fromisoformat(day)).days))
        vals = self.pts[near]
        return sum(vals) / len(vals)


# ---------------------------------------------------------------- parse

def parse(source: Source) -> dict:
    """Positions (one buy, and a sell when closed), cash events and holdings prices, in EUR."""
    book = read_workbook(source)
    if not is_statement(book):
        raise ImportFormatError("Dit Excel-bestand herken ik niet als eToro-rekeningoverzicht.")
    activity, closed, holdings = _table(book, "activity"), _table(book, "closed"), _table(book, "holdings")
    rates = Rates()

    for c in closed:
        d = when(c["close"])
        rates.add(d and d[0], num(c["profit_usd"]), num(c["profit_eur"]))
    for h in holdings:
        d = when(h["snap"])
        rates.add(d and d[0], num(h["usd"]), num(h["eur"]))
    for a in activity:
        m = re.search(r"([\d.,]+)\s*EUR", str(a["details"] or ""))
        d = when(a["date"])
        if m and d:
            rates.add(d[0], num(a["amount"]), num(m[1]))

    opened: dict[str, dict] = {}
    events: list[dict] = []
    for a in activity:
        d = when(a["date"])
        typ = str(a["type"] or "").strip()
        low = typ.lower()
        if not d or not typ:
            continue
        pid = _pid(a["pid"])
        amount = num(a["amount"])
        if ("positie openen" in low or "open position" in low) and pid:
            opened[pid] = {"date": d[0], "time": d[1], "usd": amount, "units": num(a["units"]),
                           "ticker": _ticker(a["details"]), "asset": a["asset"]}
            continue
        kind = next((k for k, keys in EVENT_KINDS if any(x in low for x in keys)), None)
        if kind in (None, "skip") or not amount:
            continue
        eur = None
        if kind == "deposit":
            m = re.search(r"([\d.,]+)\s*EUR", str(a["details"] or ""))
            eur = num(m[1]) if m else None
        if eur is None:
            eur = amount / rates.at(d[0])
        eur = abs(eur) if kind == "deposit" else (-abs(eur) if kind == "withdrawal" else eur)
        events.append({"date": d[0], "time": d[1], "kind": kind, "pid": pid, "ticker": _ticker(a["details"]),
                       "amount_local": amount, "amount_cents": cents(eur), "description": typ[:200]})

    # identity per position: ISIN from closed/holdings sheets, else a ticker-based id
    names: dict[str, tuple[str | None, str | None]] = {}
    snaps: dict[str, list[dict]] = {}
    for h in holdings:
        pid = _pid(h["pid"])
        d = when(h["snap"])
        if pid and d:
            snaps.setdefault(pid, []).append({**h, "day": d[0]})
    positions: list[dict] = []
    seen_closed = set()
    for c in closed:
        pid = _pid(c["pid"])
        o, cl = when(c["open"]), when(c["close"])
        usd, units = num(c["amount"]), num(c["units"])
        if not pid or not o or not cl or not usd or not units:
            continue
        seen_closed.add(pid)
        name, tick = _action_name(c["action"])
        ins = opened.get(pid, {})
        isin = str(c["isin"] or "").strip().upper()
        ident = isin if ISIN_RE.match(isin) else "ETORO-" + (tick or ins.get("ticker") or pid)
        names[ident] = (name, tick)
        r_open = rates.at(o[0])
        profit_eur = num(c["profit_eur"])
        if profit_eur is None:
            profit_eur = (num(c["profit_usd"]) or 0) / rates.at(cl[0])
        cost = cents(usd / r_open)
        positions.append({"pid": pid, "isin": ident, "units": units, "open": o, "close": cl,
                          "cost_cents": cost, "proceeds_cents": cost + cents(profit_eur),
                          "leverage": num(str(c["lev"] or "1").strip("xX")) or 1})
    for pid, pts in snaps.items():
        if pid in seen_closed:
            continue
        pts.sort(key=lambda p: p["day"])
        last = pts[-1]
        ins = opened.get(pid, {})
        units = num(last["units"]) or ins.get("units")
        isin = str(last["isin"] or "").strip().upper()
        ident = isin if ISIN_RE.match(isin) else "ETORO-" + (ins.get("ticker") or str(last["asset"] or pid)[:20].upper())
        names[ident] = (str(last["asset"] or "").strip() or None, ins.get("ticker"))
        o = (ins["date"], ins["time"]) if ins else when(last["open"])
        usd = ins.get("usd")
        if not usd:                                       # no open row (older than the statement)
            first = pts[0]
            conv = (num(first["usd"]) or 0) / ((num(first["units"]) or 1) * (num(first["rate"]) or 1))
            usd = (num(first["units"]) or 0) * (num(first["open_rate"]) or 0) * conv
        if not o or not units or not usd:
            continue
        positions.append({"pid": pid, "isin": ident, "units": units, "open": o, "close": None,
                          "cost_cents": cents(usd / rates.at(o[0])), "proceeds_cents": None,
                          "leverage": num(str(last["lev"] or "1").strip("xX")) or 1})
    for pid, ins in opened.items():                       # opened after the last holdings snapshot
        if pid in seen_closed or pid in snaps or not ins.get("usd") or not ins.get("units"):
            continue
        ident = "ETORO-" + (ins["ticker"] or pid)
        names.setdefault(ident, (ins["ticker"] or None, ins["ticker"]))
        positions.append({"pid": pid, "isin": ident, "units": ins["units"], "open": (ins["date"], ins["time"]),
                          "close": None, "cost_cents": cents(ins["usd"] / rates.at(ins["date"])),
                          "proceeds_cents": None, "leverage": 1})

    prices = []
    for pid, pts in snaps.items():
        pos = next((p for p in positions if p["pid"] == pid), None)
        for p in pts:
            units, eur = num(p["units"]), num(p["eur"])
            if pos and units and eur:
                prices.append({"isin": pos["isin"], "date": p["day"], "close_eur": eur / units,
                               "close": num(p["rate"]) or eur / units})
    return {"positions": positions, "events": events, "prices": prices, "names": names,
            "leveraged": sum(1 for p in positions if p["close"] is None and p["leverage"] > 1)}
