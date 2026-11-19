"""Recap ("Terugblik", SPEC 14) of one period or one calendar year.

A year is the twelve periods whose id lies in that year, so a year's totals are exactly the sum
of its periods (and of /trends). Comparisons ("vergeleken met") are only made against a
complete previous period or a complete previous year.
"""

from __future__ import annotations

import sqlite3
from datetime import timedelta

from .. import db
from . import cache, ledger as ledger_mod, networth, recurring, txquery
from .ledger import DAILY, FIXED, Flows, Ledger
from .periods import Period
from .text import euro, percent

SPENDING_KEYS = ("unsorted", "creditcard")


class Range:
    """A list of periods seen as one stretch of time."""

    def __init__(self, lg: Ledger, plist: list[Period], kind: str, label: str):
        self.lg, self.periods, self.kind, self.label = lg, plist, kind, label
        self.start, self.end = plist[0].start, plist[-1].end
        complete = {q.id for q in lg.complete_before(lg.current(), 10000)}
        self.complete = all(q.id in complete for q in plist)
        self.has_data = any(lg.has_data(q.id) for q in plist)

    def flows(self) -> list[Flows]:
        return [self.lg.flows_for(q) for q in self.periods]

    def totals(self) -> dict:
        fs = self.flows()
        t = {"income_cents": sum(f.income for f in fs), "fixed_cents": sum(f.fixed for f in fs),
             "daily_cents": sum(f.daily for f in fs), "saved_cents": sum(f.saved for f in fs),
             "repaid_cents": sum(f.repaid for f in fs)}
        # over / tekort (SPEC 9): saving is not spending. `net_cents` (after saving) is kept for
        # compatibility; the screens use `result_cents`.
        t["result_cents"] = t["income_cents"] - t["fixed_cents"] - t["daily_cents"]
        t["net_cents"] = t["result_cents"] - t["saved_cents"]
        return t

    def spent(self) -> dict[int, int]:
        out: dict[int, int] = {}
        for f in self.flows():
            for cid, v in f.spent.items():
                out[cid] = out.get(cid, 0) + v
        return out

    def rows(self) -> list[dict]:
        return [r for f in self.flows() for r in f.rows]


def _period_range(lg: Ledger, p: Period) -> Range:
    return Range(lg, [p], "period", p.label)


def _year_range(lg: Ledger, year: int) -> Range:
    plist = [lg.period(f"{year:04d}-{m:02d}") for m in range(1, 13)]
    plist = [q for q in plist if q.start <= lg.current().start]
    return Range(lg, plist, "year", str(year))


def _spending_rows(r: Range) -> list[dict]:
    return [x for x in r.rows() if x["bucket"][0] in (FIXED, DAILY) and x["amount_cents"] < 0
            and not x.get("part")]


def _days_without_spending(r: Range) -> int:
    last = min(r.end - timedelta(days=1), r.lg.data_today)
    if r.lg.first is None or last < r.start:
        return 0
    spent_days = {x["date"] for x in r.rows() if x["bucket"][0] == DAILY and x["amount_cents"] < 0
                  and not x.get("part")}
    first = max(r.start, r.lg.first or r.start)
    days = (last - first).days + 1
    return max(0, sum(1 for i in range(days)
                      if (first + timedelta(days=i)).isoformat() not in spent_days))


def _recurring(conn: sqlite3.Connection, lg: Ledger, r: Range) -> dict:
    rows_by_id = {x["id"]: x for x in lg.rows}
    lo, hi = r.start.isoformat(), r.end.isoformat()
    new, ended, changed, per_month = [], [], [], 0
    for item in recurring.full_items(conn):
        cat = lg.categories.get(item["category_id"] or -1, {})
        if cat.get("grp") != FIXED or item["direction"] != "out":
            continue
        dates = sorted(rows_by_id[i]["date"] for i in item["_ids"] if i in rows_by_id)
        if not dates:
            continue
        public = recurring.public(item)
        if dates[0] < hi and dates[-1] >= lo:
            per_month += -item["per_month_cents"]
        if lo <= dates[0] < hi and lg.first and dates[0] > (lg.first + timedelta(days=75)).isoformat():
            new.append(public)
        if item["status"] == "ended" and lo <= dates[-1] < hi:
            ended.append(public)
        if item["change"] and lo <= item["change"]["date"] < hi:
            changed.append(public)
    return {"per_month_cents": per_month, "new": new, "ended": ended, "changed": changed}


def _goals(conn: sqlite3.Connection, r: Range) -> list[dict]:
    lo, hi = r.start.isoformat(), r.end.isoformat()
    out = []
    for g in db.rows(conn, "SELECT * FROM goals WHERE archived = 0 ORDER BY sort, id"):
        entries = db.rows(conn, "SELECT date, amount_cents, kind FROM goal_entries WHERE goal_id = ?",
                          (g["id"],))
        before = sum(e["amount_cents"] for e in entries if e["date"] < lo)
        added = sum(e["amount_cents"] for e in entries if lo <= e["date"] < hi and e["kind"] != "adjust")
        saldo = sum(e["amount_cents"] for e in entries if e["date"] < hi)
        if not any(e["date"] < hi for e in entries):
            continue
        target = g["target_cents"] or 0
        out.append({"id": g["id"], "name": g["name"], "emoji": g["emoji"], "added_cents": added,
                    "saldo_cents": saldo, "target_cents": target,
                    "reached": target > 0 and saldo >= target,
                    "_reached_now": target > 0 and saldo >= target and before < target})
    return out


def _networth(conn: sqlite3.Connection, lg: Ledger, r: Range) -> dict | None:
    series = {s["month"]: s["total_cents"] for s in networth.get(conn)["series"]}
    before = r.start - timedelta(days=1)
    last = min(r.end - timedelta(days=1), lg.today)
    start = series.get(f"{before.year:04d}-{before.month:02d}")
    end = series.get(f"{last.year:04d}-{last.month:02d}")
    if start is None or end is None:
        return None
    return {"start_cents": start, "end_cents": end}


def _highlights(lg: Ledger, r: Range, out: dict) -> list[dict]:
    """Up to six short, true sentences, most telling first."""
    h: list[dict] = []
    t = out["totals"]
    than = "vorige maand" if r.kind == "period" else "vorig jaar"
    when = f"in {r.label.split()[0]}" if r.kind == "period" else f"in {r.label}"
    if t["income_cents"] or t["fixed_cents"] or t["daily_cents"]:
        if t["result_cents"] >= 0:
            h.append({"emoji": "🎉", "title": f"{euro(t['result_cents'])} over {when}", "detail": None})
        else:
            h.append({"emoji": "🧾", "title": f"{euro(-t['result_cents'])} meer uitgegeven dan er binnenkwam",
                      "detail": None})
    cats = out["categories"]
    if cats:
        top = cats[0]
        c = lg.categories[top["category_id"]]
        h.append({"emoji": c["emoji"] or "📦",
                  "title": f"{c['name']} was het grootste bakje: {euro(top['cents'])} ({percent(top['share'])})",
                  "detail": None})
    up = out["movers"]["up"]
    if up:
        c = lg.categories[up[0]["category_id"]]
        h.append({"emoji": "📈", "title": f"{c['name']}: {euro(up[0]['cents'] - up[0]['previous_cents'])} meer dan {than}",
                  "detail": None})
    s = out["savings"]
    if s["saved_cents"] > 0 and t["income_cents"] > 0:
        h.append({"emoji": "🐷", "title": f"{percent(s['rate'])} van je inkomen gespaard ({euro(s['saved_cents'])})",
                  "detail": None})
    for g in s["goals"]:
        if g.pop("_reached_now", False):
            h.append({"emoji": g["emoji"] or "🎯", "title": f"Potje {g['name']} gehaald", "detail": None})
    for g in s["goals"]:
        g.pop("_reached_now", None)
    down = out["movers"]["down"]
    if down:
        c = lg.categories[down[0]["category_id"]]
        h.append({"emoji": "📉",
                  "title": f"{c['name']}: {euro(down[0]['previous_cents'] - down[0]['cents'])} minder dan {than}",
                  "detail": None})
    visits: dict[str, list] = {}
    for x in _spending_rows(r):
        if x["merchant_key"] and not x["merchant_key"].startswith("p:"):
            visits.setdefault(x["merchant_key"], []).append(x)
    if visits:
        key, xs = max(visits.items(), key=lambda kv: (len(kv[1]), kv[0]))
        if len(xs) >= 3:
            h.append({"emoji": "🛒", "title": f"Het vaakst bij {xs[-1]['merchant_name']}: {len(xs)} keer",
                      "detail": None})
    rec = out["recurring"]
    for item in rec["new"][:1]:
        h.append({"emoji": "✨", "title": f"Nieuw vast: {item['name']}, {euro(abs(item['per_month_cents']))} per maand",
                  "detail": None})
    for item in rec["ended"][:1]:
        h.append({"emoji": "⏸️", "title": f"Gestopt: {item['name']}", "detail": None})
    free = out["counts"]["days_without_spending"]
    if free >= 1 and r.kind == "period":
        h.append({"emoji": "🌿", "title": "1 dag zonder dagelijkse uitgaven" if free == 1
                  else f"{free} dagen zonder dagelijkse uitgaven", "detail": None})
    nw = out["networth"]
    if nw and nw["end_cents"] != nw["start_cents"]:
        diff = nw["end_cents"] - nw["start_cents"]
        word = "groeide" if diff > 0 else "daalde"
        h.append({"emoji": "📊", "title": f"Je vermogen {word} met {euro(abs(diff))}", "detail": None})
    counts = out["counts"]
    if len(h) < 3 and counts["payments"]:
        h.append({"emoji": "🧮", "title": f"{counts['payments']} betalingen bij {counts['merchants']} winkels",
                  "detail": None})
    return h[:6]


def build(conn: sqlite3.Connection, lg: Ledger, r: Range, prev: Range | None) -> dict:
    by_tx = recurring.by_transaction(conn)
    totals = r.totals()
    use_prev = prev is not None and prev.complete and prev.has_data
    previous = None
    prev_spent: dict[int, int] = {}
    if use_prev:
        previous = {"label": prev.label, **prev.totals()}
        prev_spent = prev.spent()
    spent = r.spent()
    total_spent = sum(v for v in spent.values() if v > 0)
    categories = []
    for cid, cents in spent.items():
        cat = lg.categories.get(cid)
        if not cat or cents <= 0:
            continue
        categories.append({"category_id": cid, "cents": cents,
                           "previous_cents": prev_spent.get(cid, 0) if use_prev else None,
                           "share": round(cents / total_spent, 4) if total_spent else 0.0})
    categories.sort(key=lambda c: (-c["cents"], c["category_id"]))
    movers = {"up": [], "down": []}
    if use_prev:
        diffs = []
        for cid in set(spent) | set(prev_spent):
            cat = lg.categories.get(cid)
            if not cat or cat["key"] == "unsorted":
                continue
            d = spent.get(cid, 0) - prev_spent.get(cid, 0)
            if abs(d) >= 1000:
                diffs.append((d, cid))
        movers["up"] = [{"category_id": cid, "cents": spent.get(cid, 0), "previous_cents": prev_spent.get(cid, 0)}
                        for d, cid in sorted(diffs, key=lambda x: (-x[0], x[1])) if d > 0][:3]
        movers["down"] = [{"category_id": cid, "cents": spent.get(cid, 0), "previous_cents": prev_spent.get(cid, 0)}
                          for d, cid in sorted(diffs, key=lambda x: (x[0], x[1])) if d < 0][:3]
    merchants: dict[str, dict] = {}
    for x in r.rows():
        grp, cid, value = x["bucket"]
        if grp not in (FIXED, DAILY) or not x["merchant_key"]:
            continue
        m = merchants.setdefault(x["merchant_key"], {"merchant_key": x["merchant_key"],
                                                     "merchant_name": x["merchant_name"],
                                                     "category_id": cid, "cents": 0, "count": 0})
        m["cents"] += value + (x.get("repaid") or 0)          # what was paid to them
        m["count"] += 1
    spend_rows = _spending_rows(r)
    largest_rows = sorted((x for x in spend_rows if x["id"] not in by_tx),
                          key=lambda x: (x["amount_cents"], x["id"]))[:5]
    largest = []
    if largest_rows:
        ids = [x["id"] for x in largest_rows]
        tx = {t["id"]: t for t in db.rows(conn, f"SELECT * FROM transactions WHERE id IN ({db.placeholders(ids)})", ids)}
        largest = txquery.tx_list_json(conn, [tx[i] for i in ids if i in tx])
    goals = _goals(conn, r)
    out = {
        "kind": r.kind, "label": r.label,
        "from": r.start.isoformat(), "to": (r.end - timedelta(days=1)).isoformat(),
        "complete": r.complete,
        "totals": totals,
        "previous": previous,
        "categories": categories,
        "movers": movers,
        "merchants": sorted(merchants.values(), key=lambda m: (-m["cents"], m["merchant_key"]))[:10],
        "largest": largest,
        "counts": {"payments": len(spend_rows),
                   "merchants": len({x["merchant_key"] for x in spend_rows if x["merchant_key"]}),
                   "days_without_spending": _days_without_spending(r)},
        "recurring": _recurring(conn, lg, r),
        "savings": {"saved_cents": totals["saved_cents"],
                    "rate": round(min(1.0, max(0.0, totals["saved_cents"] / totals["income_cents"])), 4)
                    if totals["income_cents"] > 0 else 0.0,
                    "goals": goals},
        "networth": _networth(conn, lg, r),
        "months": None,
    }
    if r.kind == "year":
        out["months"] = [{"period": q.id, "label": q.label, **_period_range(lg, q).totals()}
                         for q in r.periods if lg.first is not None and q.end > lg.first]
    out["highlights"] = _highlights(lg, r, out)
    for g in out["savings"]["goals"]:
        g.pop("_reached_now", None)
    return out


def period_recap(conn: sqlite3.Connection, period_id: str | None) -> dict:
    lg = ledger_mod.get(conn)
    p = lg.period(period_id) if period_id else lg.current()

    def compute() -> dict:
        return build(conn, lg, _period_range(lg, p), _period_range(lg, lg.shift(p, -1)))
    return cache.memo(conn, f"recap:{p.id}", compute)


def year_recap(conn: sqlite3.Connection, year: int) -> dict:
    lg = ledger_mod.get(conn)

    def compute() -> dict:
        prev = _year_range(lg, year - 1)
        prev = prev if len(prev.periods) == 12 else None
        return build(conn, lg, _year_range(lg, year), prev)
    return cache.memo(conn, f"recap:y{year}", compute)


def index(conn: sqlite3.Connection) -> dict:
    lg = ledger_mod.get(conn)
    complete = lg.complete_before(lg.current(), 10000)
    years = sorted({int(pid[:4]) for pid in lg.flows if lg.has_data(pid) and lg.period(pid).start <= lg.current().start},
                   reverse=True)
    return {"periods": [{"id": q.id, "label": q.label} for q in complete], "years": years}


def is_future_period(conn: sqlite3.Connection, period_id: str) -> bool:
    lg = ledger_mod.get(conn)
    return lg.period(period_id).start > lg.current().start


def is_future_year(conn: sqlite3.Connection, year: int) -> bool:
    return year > int(ledger_mod.get(conn).current().id[:4])
