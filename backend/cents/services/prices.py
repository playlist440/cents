"""Automatic daily prices for held funds (SPEC 7.1, docs/research/degiro-format.md).

What leaves the server: only ISINs / ticker symbols and currency codes, sent to
- the price provider (default: Yahoo Finance's public chart and search endpoints), and
- the ECB's daily euro reference rates (only when a fund trades in another currency).
No amounts, quantities, account data or anything about the user. User-Agent "Cents".
With the setting `assumptions.prices_auto.enabled = false` nothing is fetched at all.

The fetch runs in a background thread (asyncio task started in the app lifespan) once a day
after 18:30 Europe/Amsterdam and at startup when prices are stale; "Nu bijwerken" runs it on
request. Failures are logged and stored in the status; they never break a request or startup.
"""

from __future__ import annotations

import asyncio
import io
import json
import logging
import sqlite3
import ssl
import threading
import time
import os
import re
import urllib.error
import urllib.parse
import os
import urllib.request
import zipfile
from datetime import date, datetime, timedelta, timezone
from typing import Protocol
from xml.etree import ElementTree
from zoneinfo import ZoneInfo

from .. import db
from ..config import TIMEZONE
from . import assumptions, cache

log = logging.getLogger("cents.prices")

USER_AGENT = "Cents"
TIMEOUT = 15
RETRIES = 3
STATUS_KEY = "_prices_status"
RUN_AFTER = (18, 30)
RETRY_AFTER = timedelta(hours=1)
CHECK_EVERY_SECONDS = 15 * 60

# DEGIRO exchange code -> Yahoo suffix (the listing we prefer, in the fund's own currency)
YAHOO_SUFFIX = {"EAM": ".AS", "XAMS": ".AS", "EPA": ".PA", "XPAR": ".PA", "XET": ".DE",
                "XETR": ".DE", "TDG": ".DE", "FRA": ".F", "MIL": ".MI", "XMIL": ".MI",
                "EBR": ".BR", "XBRU": ".BR", "LSE": ".L", "XLON": ".L", "SWX": ".SW",
                "XSWX": ".SW", "ELI": ".LS", "MAD": ".MC", "OMX": ".ST", "WSE": ".WA",
                "NDQ": "", "NSY": "", "NYSE": "", "NASDAQ": ""}


class OfflineError(Exception):
    pass


def _ssl_context() -> ssl.SSLContext:
    """System trust store, plus certifi's bundle when installed (some Python builds ship
    without usable CA certificates)."""
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        return ssl.create_default_context()


_SSL: ssl.SSLContext | None = None


ISIN = re.compile(r"^[A-Z]{2}[A-Z0-9]{9}[0-9]$")
MAX_LOOKUPS = 8              # new symbol searches per run (several requests each): no rate limit


class RateLimited(Exception):
    """Yahoo answered 429: stop this run, keep what was fetched."""


def http_get(url: str) -> bytes:
    """GET with timeout and retries (1 s, 2 s backoff). Raises OfflineError.

    This is the only place in Cents that goes out to the internet. With the environment
    variable CENTS_OFFLINE=1 it refuses every request, whatever the setting says."""
    if os.environ.get("CENTS_OFFLINE", "0") not in ("", "0"):
        raise OfflineError("CENTS_OFFLINE is set")
    last: Exception | None = None
    for attempt in range(RETRIES):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "*/*"})
            global _SSL
            _SSL = _SSL or _ssl_context()
            with urllib.request.urlopen(req, timeout=TIMEOUT, context=_SSL) as res:   # noqa: S310
                return res.read(20 * 1024 * 1024)
        except urllib.error.HTTPError as exc:
            last = exc
            if exc.code == 404:
                break
            if exc.code == 429:
                raise RateLimited("Yahoo vraagt om even te wachten (te veel verzoeken)") from exc
        except Exception as exc:          # URLError, timeout, ...
            last = exc
        if attempt < RETRIES - 1:
            time.sleep(2 ** attempt)
    raise OfflineError(str(last))


# ---------------------------------------------------------------- providers

class PriceProvider(Protocol):
    name: str
    label: str

    def lookup(self, isin: str, exchange: str | None, currency: str | None,
               symbol: str | None, name: str | None = None) -> str | None: ...

    def history(self, symbol: str, start: date) -> tuple[str, list[tuple[str, float]]]: ...


class YahooProvider:
    """Yahoo Finance public endpoints (no key, no account). Unofficial: may change or rate-limit."""
    name = "yahoo"
    label = "Yahoo Finance"
    BASE = "https://query1.finance.yahoo.com"

    def _json(self, url: str) -> dict:
        return json.loads(http_get(url).decode("utf-8"))

    def _search(self, q: str) -> list[dict]:
        found = self._json(f"{self.BASE}/v1/finance/search?" + urllib.parse.urlencode(
            {"q": q, "quotesCount": 10, "newsCount": 0}))
        return [x for x in found.get("quotes", []) if x.get("symbol")]

    def _works(self, sym: str) -> str | None:
        """The currency of a symbol that has recent closes, else None."""
        try:
            cur, pts = self.history(sym, date.today() - timedelta(days=10))
        except OfflineError:
            return None
        return cur if pts else None

    def lookup(self, isin, exchange, currency, symbol, name=None):
        """ISIN search first. Prefer the listing on the DEGIRO exchange (same currency): try
        <base>.<suffix>, then a name search restricted to listings with exactly the same fund
        name as the ISIN hit. Fall back to the ISIN hit itself (other currency, converted)."""
        real_isin = bool(ISIN.match(isin or ""))
        quotes = self._search(isin) if real_isin else []
        if not real_isin:
            # eToro without ISIN ("ETORO-AAPL"): the ticker itself, a crypto pair, then a search
            # on ticker or name
            tick = (symbol or isin.removeprefix("ETORO-")).upper()
            for sym in (tick, f"{tick}-EUR", f"{tick}-USD"):
                if self._works(sym):
                    return sym
            quotes = self._search(tick) or (self._search(name) if name else [])
        suffix = YAHOO_SUFFIX.get((exchange or "").upper())
        if suffix:
            bases = ([symbol] if symbol else []) + [q["symbol"].split(".")[0] for q in quotes]
            for b in dict.fromkeys(bases):
                cur = self._works(b + suffix)
                if cur and (not currency or cur.upper() == currency.upper()):
                    return b + suffix
            names = {(q.get("longname") or "").strip().lower() for q in quotes} - {""}
            if names:
                for q in self._search(next(iter(names))):
                    if (q.get("longname") or "").strip().lower() in names and q["symbol"].endswith(suffix):
                        cur = self._works(q["symbol"])
                        if cur and (not currency or cur.upper() == currency.upper()):
                            return q["symbol"]
        for q in quotes:
            if self._works(q["symbol"]):
                return q["symbol"]
        return None

    def history(self, symbol, start):
        p1 = int(datetime.combine(start, datetime.min.time(), timezone.utc).timestamp())
        url = (f"{self.BASE}/v8/finance/chart/{urllib.parse.quote(symbol)}?"
               + urllib.parse.urlencode({"period1": p1, "period2": int(time.time()) + 86400,
                                         "interval": "1d"}))
        data = self._json(url)
        res = (data.get("chart") or {}).get("result") or []
        if not res:
            return "", []
        r = res[0]
        meta = r.get("meta") or {}
        tz = ZoneInfo(meta.get("exchangeTimezoneName") or TIMEZONE)
        closes = (((r.get("indicators") or {}).get("quote") or [{}])[0].get("close")) or []
        out: dict[str, float] = {}
        for ts, c in zip(r.get("timestamp") or [], closes):
            if c is None:
                continue
            out[datetime.fromtimestamp(ts, tz).date().isoformat()] = float(c)
        currency = meta.get("currency") or ""
        if currency == "GBp":
            out = {d: v / 100 for d, v in out.items()}
            currency = "GBP"
        return currency, sorted(out.items())


class OfflineProvider:
    """Used in tests and when nothing may leave the server."""
    name = "offline"
    label = "geen"

    def lookup(self, *a, **kw):
        raise OfflineError("offline")

    def history(self, *a):
        raise OfflineError("offline")


PROVIDER: PriceProvider = YahooProvider()


def set_provider(p: PriceProvider) -> None:
    global PROVIDER
    PROVIDER = p


# ---------------------------------------------------------------- FX (ECB reference rates)

ECB_90D = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml"
ECB_ALL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.zip"


def _fetch_ecb(start: date) -> dict[str, list[tuple[str, float]]]:
    if (date.today() - start).days < 85:
        xml = http_get(ECB_90D)
    else:
        with zipfile.ZipFile(io.BytesIO(http_get(ECB_ALL))) as z:
            name = z.namelist()[0]
            return _parse_ecb_csv(z.read(name).decode("utf-8"), start)
    out: dict[str, list[tuple[str, float]]] = {}
    for cube in ElementTree.fromstring(xml).iter():
        if cube.get("time"):
            day = cube.get("time")
            for c in cube:
                out.setdefault(c.get("currency"), []).append((day, float(c.get("rate"))))
    return {k: sorted(v) for k, v in out.items()}


def _parse_ecb_csv(text: str, start: date) -> dict[str, list[tuple[str, float]]]:
    lines = text.strip().splitlines()
    header = [h.strip() for h in lines[0].split(",")]
    out: dict[str, list[tuple[str, float]]] = {}
    for line in lines[1:]:
        cells = [c.strip() for c in line.split(",")]
        if cells[0] < start.isoformat():
            continue
        for cur, v in zip(header[1:], cells[1:]):
            try:
                out.setdefault(cur, []).append((cells[0], float(v)))
            except ValueError:
                pass
    return {k: sorted(v) for k, v in out.items()}


FX_SOURCE = _fetch_ecb


def to_eur(points: list[tuple[str, float]], currency: str,
           rates: dict[str, list[tuple[str, float]]]) -> list[tuple[str, float]]:
    """Divide by that day's (or the last earlier) ECB rate (units per EUR)."""
    if currency.upper() == "EUR":
        return points
    series = rates.get(currency.upper()) or []
    if not series:
        return []
    out, j = [], 0
    for day, v in points:
        while j + 1 < len(series) and series[j + 1][0] <= day:
            j += 1
        if series[j][0] <= day or j == 0:
            out.append((day, v / series[j][1]))
    return out


# ---------------------------------------------------------------- status and settings

def enabled(conn: sqlite3.Connection) -> bool:
    return bool(assumptions.get(conn)["prices_auto"]["enabled"])


def status(conn: sqlite3.Connection) -> dict:
    s = db.get_setting(conn, STATUS_KEY, {}) or {}
    last_price = db.value(conn, "SELECT MAX(date) FROM prices WHERE source = ?", (PROVIDER.name,))
    return {"enabled": enabled(conn), "source": PROVIDER.label, "source_key": PROVIDER.name,
            "last_run": s.get("last_run"), "last_ok": s.get("last_ok"), "error": s.get("error"),
            "last_price_date": last_price, "running": _lock.locked(),
            "held": len(held_isins(conn))}


def _set_status(conn: sqlite3.Connection, **kw) -> None:
    s = db.get_setting(conn, STATUS_KEY, {}) or {}
    s.update(kw)
    db.set_setting(conn, STATUS_KEY, s)


def held_isins(conn: sqlite3.Connection) -> list[dict]:
    """Securities with trades (with the first trade date), never anything about amounts."""
    return db.rows(conn, """SELECT s.*, MIN(t.date) AS first_date FROM securities s
                            JOIN trades t ON t.isin = s.isin GROUP BY s.isin""")


# ---------------------------------------------------------------- the fetch

_lock = threading.Lock()


def refresh(db_path: str, force: bool = False) -> dict:
    """Fetch missing daily closes for every held ISIN. Network happens without an open write
    transaction; results are written at the end. Returns a summary; never raises."""
    if not _lock.acquire(blocking=False):
        return {"ok": False, "error": "busy"}
    try:
        return _refresh(db_path, force)
    except Exception as exc:          # never crash the app
        log.warning("price refresh failed: %s", exc)
        return {"ok": False, "error": str(exc)}
    finally:
        _lock.release()


def _refresh(db_path: str, force: bool) -> dict:
    conn = db.connect(db_path)
    try:
        if not enabled(conn):
            return {"ok": False, "error": "disabled"}
        secs = held_isins(conn)
        if not secs:
            return {"ok": True, "updated": 0}
        plan = []
        for s in secs:
            last = db.value(conn, "SELECT MAX(date) FROM prices WHERE isin = ? AND source = ?",
                            (s["isin"], PROVIDER.name))
            start = date.fromisoformat(last) - timedelta(days=5) if last else date.fromisoformat(s["first_date"]) - timedelta(days=7)
            plan.append((s, start))
        _set_status(conn, last_run=db.now_iso())
        conn.commit()
    finally:
        conn.close()

    fetched: list[tuple[dict, str | None, str, list[tuple[str, float]]]] = []
    errors, later = [], 0
    known = lambda s: s["price_symbol_source"] in ("auto", "user") and s["price_symbol"]  # noqa: E731
    plan.sort(key=lambda x: not known(x[0]))          # funds with a symbol first, searches last
    lookups = 0
    for s, start in plan:
        try:
            sym = s["price_symbol"] if known(s) else None
            if not sym and s["price_symbol_source"] != "none":
                if lookups >= MAX_LOOKUPS:
                    later += 1                        # next run: Yahoo limits many searches at once
                    continue
                lookups += 1
                sym = PROVIDER.lookup(s["isin"], s["exchange"], s["currency"], s["symbol"], name=s["name"])
            if not sym:
                # eToro without ISIN has its own prices from the export: not an error
                if not str(s["isin"]).startswith("ETORO-"):
                    errors.append(f"{s['name'] or s['isin']}: niet gevonden")
                fetched.append((s, None, "", []))
                continue
            cur, pts = PROVIDER.history(sym, start)
            fetched.append((s, sym, cur, pts))
        except RateLimited as exc:
            errors.append(str(exc))
            break                                     # keep what we have; the next run continues
        except OfflineError as exc:
            errors.append(f"{s['name'] or s['isin']}: {exc}")
        except Exception as exc:                      # one odd answer never stops the others
            log.warning("price fetch %s failed: %s", s["isin"], exc)
            errors.append(f"{s['name'] or s['isin']}: {exc}")
    needed = {cur.upper() for _, _, cur, pts in fetched if pts and cur and cur.upper() != "EUR"}
    rates: dict = {}
    if needed:
        try:
            rates = FX_SOURCE(min(start for _, start in plan))
        except (OfflineError, RateLimited) as exc:
            errors.append(f"wisselkoersen: {exc}")

    conn = db.connect(db_path)
    try:
        n = 0
        for s, sym, cur, pts in fetched:
            if sym and s["price_symbol_source"] not in ("user",) and sym != s["price_symbol"]:
                conn.execute("UPDATE securities SET price_symbol = ?, price_symbol_source = 'auto' WHERE isin = ?",
                             (sym, s["isin"]))
            eur = to_eur(pts, cur or "EUR", rates)
            closes = dict(pts)
            for day, v in eur:
                conn.execute("""INSERT INTO prices (isin, date, source, close, currency, close_eur)
                                VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(isin, date, source) DO UPDATE
                                SET close = excluded.close, currency = excluded.currency,
                                close_eur = excluded.close_eur""",
                             (s["isin"], day, PROVIDER.name, closes[day], (cur or "EUR").upper(), v))
                n += 1
        ok = not errors
        _set_status(conn, error="; ".join(errors)[:300] if errors else None,
                    **({"last_ok": db.now_iso()} if fetched and any(p for *_, p in fetched) else {}))
        if n:
            cache.bump(conn)
        conn.commit()
        return {"ok": ok, "updated": n, "errors": errors, "later": later}
    finally:
        conn.close()


# ---------------------------------------------------------------- the daily task

def due(conn: sqlite3.Connection, now: datetime | None = None) -> bool:
    """Run when enabled, something is held, and the last successful fetch was before the most
    recent 18:30 Amsterdam (or before today at startup); wait an hour after a failed try."""
    if not enabled(conn) or not held_isins(conn):
        return False
    tz = ZoneInfo(TIMEZONE)
    now = (now or datetime.now(timezone.utc)).astimezone(tz)
    s = db.get_setting(conn, STATUS_KEY, {}) or {}
    cutoff = now.replace(hour=RUN_AFTER[0], minute=RUN_AFTER[1], second=0, microsecond=0)
    if now < cutoff:
        cutoff -= timedelta(days=1)
    last_ok = datetime.fromisoformat(s["last_ok"]).astimezone(tz) if s.get("last_ok") else None
    last_run = datetime.fromisoformat(s["last_run"]).astimezone(tz) if s.get("last_run") else None
    if last_ok and last_ok >= cutoff:
        return False
    if last_run and now - last_run < RETRY_AFTER:
        return False
    return True


async def daily_task(db_path: str) -> None:
    """Started in the app lifespan; cancelled on shutdown."""
    await asyncio.sleep(5)
    while True:
        try:
            conn = db.connect(db_path)
            try:
                run = due(conn)
            finally:
                conn.close()
            if run:
                await asyncio.to_thread(refresh, db_path)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.warning("price task: %s", exc)
        await asyncio.sleep(CHECK_EVERY_SECONDS)
