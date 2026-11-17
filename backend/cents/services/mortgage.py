"""Mortgage (hypotheek, SPEC 7.2): loan parts, yearly statements, home value, the split of the
monthly payment and the estimated debt between statements.

- A yearly statement (jaaropgave) is per part per year: debt on 31 December, interest paid and
  amount repaid that year. Statements always describe a finished year (the current year can not
  be entered).
- Split: the linked payment (the direct debit of the lender) is split with the ratio of the most
  recent entered year, all parts summed: repaid share = repaid / (repaid + interest). The repaid
  share counts as saving in the ledger ("Afgelost"); the interest stays a fixed cost in bakje
  Wonen. Cash projections (Nog te besteden, recurring items) keep the full payment.
- Estimated debt on a day: per part, the debt of the latest statement on or before that day
  minus that part's share of the repaid amounts of linked payments since; before the first
  statement, the first statement plus the repaid amounts until then. Never below zero. A part's
  share of the repaid amounts follows its own repaid amount in the latest year (an
  aflossingsvrij part gets nothing).
- Home value: the latest WOZ/value entry on or before the day, else the first one. Net worth
  includes home value − debt ("overwaarde") when the setting is on and a home value is known.
"""

from __future__ import annotations

import sqlite3
from datetime import date

from .. import db

CATEGORY = "wonen"
HINTS = ("hypothe",)
MERCHANT_SETTING = "mortgage_merchant_key"      # None/absent = automatic, "" = no link
INCLUDE_SETTING = "mortgage_include_home"


def parts(conn: sqlite3.Connection) -> list[dict]:
    return db.rows(conn, "SELECT id, name, sort FROM mortgage_parts ORDER BY sort, id")


def statements(conn: sqlite3.Connection) -> dict[int, dict[int, dict]]:
    """year -> part id -> {debt_end_cents, interest_cents, repaid_cents}"""
    out: dict[int, dict[int, dict]] = {}
    for r in db.rows(conn, "SELECT * FROM mortgage_years ORDER BY year, part_id"):
        out.setdefault(r["year"], {})[r["part_id"]] = r
    return out


def latest_year(conn: sqlite3.Connection) -> int | None:
    return db.value(conn, "SELECT MAX(year) FROM mortgage_years")


def ratio(conn: sqlite3.Connection) -> tuple[int | None, float | None]:
    """(year, repaid share) of the most recent entered year, all parts summed."""
    year = latest_year(conn)
    if year is None:
        return None, None
    r = db.row(conn, "SELECT SUM(repaid_cents) AS rep, SUM(interest_cents) AS int "
                     "FROM mortgage_years WHERE year = ?", (year,))
    total = (r["rep"] or 0) + (r["int"] or 0)
    return year, ((r["rep"] or 0) / total if total > 0 else 0.0)


def include_home(conn: sqlite3.Connection) -> bool:
    return bool(db.get_setting(conn, INCLUDE_SETTING, True))


def candidates(conn: sqlite3.Connection) -> list[dict]:
    """Merchants paid from a checking account in bakje Wonen, likely mortgage first."""
    rows = db.rows(conn, """
        SELECT t.merchant_key, MAX(t.merchant_name) AS merchant_name, COUNT(*) AS n,
               MAX(t.date) AS last_date, SUM(LOWER(COALESCE(t.description, '')) LIKE '%hypothe%') AS hinted,
               (SELECT t2.amount_cents FROM transactions t2 WHERE t2.merchant_key = t.merchant_key
                  AND t2.amount_cents < 0 ORDER BY t2.date DESC, t2.id DESC LIMIT 1) AS amount_cents
        FROM transactions t JOIN accounts a ON a.id = t.account_id
        JOIN categories c ON c.id = t.category_id
        WHERE c.key = ? AND a.type = 'checking' AND t.amount_cents < 0 AND t.merchant_key IS NOT NULL
        GROUP BY t.merchant_key""", (CATEGORY,))
    for r in rows:
        text = f"{r['merchant_key']} {r['merchant_name'] or ''}".lower()
        r["likely"] = any(h in text for h in HINTS) or bool(r["hinted"])
    rows.sort(key=lambda r: (not r["likely"], -r["n"], r["amount_cents"] or 0))
    return [{"merchant_key": r["merchant_key"], "merchant_name": r["merchant_name"],
             "amount_cents": r["amount_cents"], "count": r["n"], "last_date": r["last_date"],
             "likely": r["likely"]} for r in rows]


def detected(conn: sqlite3.Connection, strict: bool = False) -> dict | None:
    """The automatic choice: a merchant that looks like a mortgage lender, else (not `strict`)
    the most regular Wonen payment with at least three payments."""
    found = candidates(conn)
    for c in found:
        if c["likely"]:
            return c
    if strict:
        return None
    return next((c for c in found if c["count"] >= 3), None)


def linked_merchant(conn: sqlite3.Connection) -> tuple[str | None, bool]:
    """(merchant key, chosen automatically)"""
    chosen = db.get_setting(conn, MERCHANT_SETTING, None)
    if chosen is not None:
        return (chosen or None), False
    found = detected(conn)
    return (found["merchant_key"] if found else None), True


def split_config(conn: sqlite3.Connection) -> tuple[str, float] | None:
    """(linked merchant key, repaid share) for the ledger, or None when nothing is split."""
    if not db.value(conn, "SELECT 1 FROM mortgage_parts LIMIT 1"):
        return None
    _, share = ratio(conn)
    key, _ = linked_merchant(conn)
    if not key or not share:
        return None
    return key, share


# ---------------------------------------------------------------------------- estimates

def _repaid_events(lg, key: str | None) -> list[tuple[str, int]]:
    """Repaid amounts of the mortgage's own linked payment (debts are split too)."""
    return [(r["date"], r["repaid"]) for r in lg.rows if r.get("repaid") and r["merchant_key"] == key]


def _weights(conn: sqlite3.Connection, plist: list[dict], st: dict) -> dict[int, float]:
    year = max(st) if st else None
    rep = {pid: v["repaid_cents"] for pid, v in (st.get(year) or {}).items()} if year else {}
    total = sum(rep.values())
    if total <= 0:
        return {p["id"]: 0.0 for p in plist}
    return {p["id"]: rep.get(p["id"], 0) / total for p in plist}


class Estimator:
    """Debt per part and home value on any day."""

    def __init__(self, conn: sqlite3.Connection, lg):
        self.parts = parts(conn)
        self.st = statements(conn)
        self.weights = _weights(conn, self.parts, self.st)
        self.events = _repaid_events(lg, linked_merchant(conn)[0])
        self.homes = db.rows(conn, "SELECT id, date, value_cents FROM home_values ORDER BY date, id")

    def _repaid_between(self, after: str, upto: str) -> int:
        return sum(v for d, v in self.events if after < d <= upto)

    def part_debt(self, part_id: int, day: str) -> int | None:
        years = sorted(y for y, per in self.st.items() if part_id in per)
        if not years:
            return None
        w = self.weights.get(part_id, 0.0)
        before = [y for y in years if f"{y}-12-31" <= day]
        if before:
            y = before[-1]
            base = self.st[y][part_id]["debt_end_cents"]
            debt = base - w * self._repaid_between(f"{y}-12-31", day)
        else:
            y = years[0]
            base = self.st[y][part_id]["debt_end_cents"]
            debt = base + w * self._repaid_between(day, f"{y}-12-31")
        return max(0, int(round(debt)))

    def debt(self, day: str) -> int | None:
        found = [self.part_debt(p["id"], day) for p in self.parts]
        found = [d for d in found if d is not None]
        return sum(found) if found else None

    def home(self, day: str) -> int | None:
        if not self.homes:
            return None
        known = [h for h in self.homes if h["date"] <= day]
        return (known[-1] if known else self.homes[0])["value_cents"]

    def equity(self, day: str) -> int | None:
        """Home value − debt, or None when there is no home value."""
        home = self.home(day)
        if home is None:
            return None
        return home - (self.debt(day) or 0)


def networth_part(conn: sqlite3.Connection, lg) -> dict | None:
    """The `home` block of GET /networth and the value function for the series."""
    if not parts(conn) and not db.value(conn, "SELECT 1 FROM home_values LIMIT 1"):
        return None
    est = Estimator(conn, lg)
    today = lg.today.isoformat()
    home, debt = est.home(today), est.debt(today)
    included = include_home(conn) and home is not None
    return {"home_cents": home, "debt_cents": debt,
            "equity_cents": (home - (debt or 0)) if home is not None else None,
            "included": included, "_estimator": est}


def summary(conn: sqlite3.Connection, lg) -> dict:
    """GET /mortgage."""
    plist = parts(conn)
    st = statements(conn)
    est = Estimator(conn, lg)
    today = lg.today.isoformat()
    year, share = ratio(conn)
    key, auto = linked_merchant(conn)
    cands = candidates(conn)
    linked = next((c for c in cands if c["merchant_key"] == key), None)
    repaid_ytd = sum(v for d, v in est.events if d >= f"{lg.today.year}-01-01")
    home = est.home(today)
    debt = est.debt(today)
    last_complete = lg.today.year - 1
    return {
        "exists": bool(plist),
        "parts": [{"id": p["id"], "name": p["name"],
                   "debt_cents": est.part_debt(p["id"], today),
                   "years": [{"year": y, "debt_end_cents": per[p["id"]]["debt_end_cents"],
                              "interest_cents": per[p["id"]]["interest_cents"],
                              "repaid_cents": per[p["id"]]["repaid_cents"]}
                             for y, per in sorted(st.items(), reverse=True) if p["id"] in per]}
                  for p in plist],
        "years": sorted(st, reverse=True),
        "latest_year": year,
        "form_year": last_complete,
        "missing_year": last_complete if plist and last_complete not in st else None,
        "repaid_share": round(share, 4) if share is not None else None,
        "debt_cents": debt,
        "repaid_this_year_cents": repaid_ytd,
        "home_cents": home,
        "home_values": est.homes,
        "equity_cents": (home - (debt or 0)) if home is not None else None,
        "include_in_networth": include_home(conn),
        "payment": ({"merchant_key": key, "merchant_name": (linked or {}).get("merchant_name") or key,
                     "amount_cents": (linked or {}).get("amount_cents"), "auto": auto}
                    if key else None),
        "candidates": cands[:8],
    }


def check_year(year: int, today: date) -> None:
    from ..errors import ApiError
    if year >= today.year:
        raise ApiError(422, "year_not_finished",
                       f"De jaaropgave over {year} komt pas na afloop van dat jaar.")
    if year < 1950:
        raise ApiError(422, "bad_year", "Dit jaar klopt niet.")
