"""Overview, trends, bakje and tag summaries (SPEC 9 "Overview", 10).

Totals are positive magnitudes (`fixed_cents` = money spent on fixed costs, `saved_cents` =
money put aside); single items (`upcoming[].amount_cents`, transactions) keep the sign of the
payment. Group rules live in `ledger.py`.
"""

from __future__ import annotations

import sqlite3
from datetime import date, timedelta

from .. import db
from . import cache, ledger as ledger_mod, networth, outlook, recurring, txquery
from .imports import unsorted_merchant_count
from .ledger import DAILY, FIXED, INCOME, SAVING, Flows, Ledger
from .periods import Period, is_year_id, period_json, started_year_periods

HISTORY = 6


def _period_json(lg: Ledger, p: Period) -> dict:
    return period_json(p, lg.start_day, now=lg.today, first=lg.first, last=lg.last)


def _mean(values: list[int]) -> int:
    return int(round(sum(values) / len(values))) if values else 0


def category_value(f: Flows, category: dict) -> int:
    """What a bakje shows for a period: income in, saved, or spent."""
    if category["grp"] == INCOME:
        return f.income_by_cat.get(category["id"], 0)
    if category["grp"] == SAVING:
        return f.saved_by_cat.get(category["id"], 0)
    return f.spent.get(category["id"], 0)


def typical_cumulative(lg: Ledger, history: list[Period], days: int) -> list[int]:
    """Mean cumulative daily spending per day index over `history` (shorter periods carry
    their last value)."""
    if not history:
        return []
    series = [lg.flows_for(h).daily_cumulative() for h in history]
    out = []
    for i in range(days):
        out.append(_mean([s[min(i, len(s) - 1)] if s else 0 for s in series]))
    return out


def days_seen(lg: Ledger, p: Period) -> int:
    """How many days of `p` the data covers (up to "data today")."""
    if lg.data_today < p.start:
        return 0
    return min(p.days_total, (lg.data_today - p.start).days + 1)


def upcoming_items(lg: Ledger, items: list[dict], p: Period) -> list[tuple[dict, date]]:
    """Expected payments of recurring items in the rest of a current (or future) period."""
    if p.end <= lg.current().start:
        return []
    out = []
    for item in items:
        for day in recurring.occurrences(item, p.start, p.end):
            out.append((item, day))
    return out


def build_overview(conn: sqlite3.Connection, lg: Ledger, p: Period) -> dict:
    from . import insights   # insights uses this module's helpers

    f = lg.flows_for(p)
    current = lg.current()
    is_current = p.id == current.id
    is_future = p.start > current.start
    history = lg.complete_before(p, HISTORY)
    items = recurring.items(conn)
    group = lambda item: lg.categories.get(item["category_id"] or -1, {}).get("grp")  # noqa: E731

    upcoming = upcoming_items(lg, items, p)
    fixed_up = [(i, d) for i, d in upcoming if i["direction"] == "out" and group(i) == FIXED]
    saving_up = [(i, d) for i, d in upcoming if i["direction"] == "out" and group(i) == SAVING]
    income_up = [(i, d) for i, d in upcoming if i["direction"] == "in"
                 and (group(i) == INCOME or lg.categories.get(i["category_id"] or -1, {}).get("key") == "unsorted")]
    fixed_upcoming = -sum(i["amount_cents"] for i, _ in fixed_up)
    saving_upcoming = -sum(i["amount_cents"] for i, _ in saving_up)

    live_income_items = [i for i in items if i["direction"] == "in" and i["status"] != "ended"
                         and group(i) == INCOME]
    if is_current or is_future:
        if live_income_items:
            expected_income = f.income + sum(i["amount_cents"] for i, _ in income_up)
        elif history:
            expected_income = max(f.income, _mean([lg.flows_for(h).income for h in history[:3]]))
        else:
            expected_income = f.income
    else:
        expected_income = f.income

    left = per_day = None
    if is_current and len(history) >= 2:
        left = (max(f.income, expected_income) - f.fixed - fixed_upcoming - f.saved
                - saving_upcoming - f.daily)
        days_left = max(1, (p.end - lg.today).days)
        per_day = int(left / days_left)

    seen = days_seen(lg, p)
    pace = None
    if not is_future and (f.rows or history):
        pace = {"days": [(p.start + timedelta(days=i)).isoformat() for i in range(p.days_total)],
                "actual": f.daily_cumulative(seen),
                "typical": typical_cumulative(lg, history, p.days_total)}

    cats = []
    for cid, cat in lg.categories.items():
        if cat["grp"] not in (FIXED, DAILY) and cat["key"] not in ("unsorted", "creditcard"):
            continue
        spent = f.spent.get(cid, 0)
        avg = _mean([lg.flows_for(h).spent.get(cid, 0) for h in history])
        count = f.counts.get(cid, 0)
        if spent or avg or count:
            cats.append({"category_id": cid, "spent_cents": spent, "avg_cents": avg, "count": count})
    cats.sort(key=lambda c: (-c["spent_cents"], -c["avg_cents"], c["category_id"]))

    unsorted_rows = db.row(conn, """
        SELECT COUNT(*) AS n, COALESCE(SUM(t.amount_cents), 0) AS cents FROM transactions t
        JOIN categories c ON c.id = t.category_id WHERE c.key = 'unsorted' AND t.kind = 'normal'""")
    checking = networth.balance_of_type(conn, "checking")
    expected_end = None
    if is_current and pace and pace["typical"]:
        idx = max(0, len(pace["actual"]) - 1)
        typical_rest = pace["typical"][-1] - (pace["typical"][idx] if pace["actual"] else 0)
        expected_end = ((checking or 0) + max(0, expected_income - f.income) - fixed_upcoming
                        - saving_upcoming - max(0, typical_rest))

    ov = {
        "period": _period_json(lg, p),
        "income_cents": f.income,
        "expected_income_cents": expected_income,
        "fixed_cents": f.fixed,
        "fixed_upcoming_cents": fixed_upcoming,
        "daily_cents": f.daily,
        "saved_cents": f.saved,
        "saving_upcoming_cents": saving_upcoming,
        "left_cents": left,
        "per_day_left_cents": per_day,
        "net_cents": f.net,
        "pace": pace,
        "categories": cats,
        "income": sorted(({"category_id": c, "cents": v} for c, v in f.income_by_cat.items()),
                         key=lambda x: -x["cents"]),
        "upcoming": [{"key": i["key"], "name": i["name"], "date": d.isoformat(),
                      "amount_cents": i["amount_cents"], "category_id": i["category_id"]}
                     for i, d in sorted(fixed_up + saving_up, key=lambda x: (x[1], x[0]["name"]))],
        "insights": [],
        "unsorted": {"merchants": unsorted_merchant_count(conn), "transactions": unsorted_rows["n"],
                     "cents": unsorted_rows["cents"]},
        "balance": {"checking_cents": checking or 0, "expected_end_cents": expected_end},
    }
    now = outlook.compute(conn, lg) if is_current else {}
    ov["free"] = now.get("free")
    ov["tempo"] = now.get("tempo")
    ov["checking_warning"] = now.get("checking_warning")
    ov["insights"] = insights.compute(conn, lg, p, ov)
    return ov


# ---------------------------------------------------------------------------- year

def _spending_cats(lg: Ledger) -> list[int]:
    return [cid for cid, cat in lg.categories.items()
            if cat["grp"] in (FIXED, DAILY) or cat["key"] in ("unsorted", "creditcard")]


def _sum_flows(flows: list[Flows]) -> dict:
    out = {"income": 0, "fixed": 0, "daily": 0, "saved": 0, "spent": {}, "counts": {},
           "income_by_cat": {}}
    for f in flows:
        for k in ("income", "fixed", "daily", "saved"):
            out[k] += getattr(f, k)
        for name, src in (("spent", f.spent), ("counts", f.counts), ("income_by_cat", f.income_by_cat)):
            for cid, v in src.items():
                out[name][cid] = out[name].get(cid, 0) + v
    out["net"] = out["income"] - out["fixed"] - out["daily"] - out["saved"]
    return out


def year_period_json(lg: Ledger, year: int, plist: list[Period]) -> dict:
    """The `Period` object for a year: from the first period of the year up to today (year to
    date, `ytd`) or the end of its last period (a past year)."""
    now = lg.today
    current = lg.current()
    ytd = any(p.id == current.id for p in plist)
    first, last = plist[0], plist[-1]
    span_end = now if ytd else last.last
    days_total = (last.end - first.start).days
    prev_last = started_year_periods(year - 1, lg.start_day, now)
    has_prev = bool(prev_last) and lg.first is not None and prev_last[-1].end > lg.first
    has_next = bool(started_year_periods(year + 1, lg.start_day, now))
    return {
        "id": str(year),
        "kind": "year",
        "label": f"{year} tot nu" if ytd else str(year),
        "year": year,
        "from": first.start.isoformat(),
        "to": span_end.isoformat(),
        "is_current": ytd,
        "ytd": ytd,
        "months": len(plist),
        "first_period": first.id,
        "last_period": last.id,
        "day_index": min(days_total, (span_end - first.start).days + 1),
        "days_total": days_total,
        "prev": str(year - 1) if has_prev else None,
        "next": str(year + 1) if has_next else None,
    }


def build_year_overview(conn: sqlite3.Connection, lg: Ledger, year: int) -> dict:
    """GET /overview?period=YYYY: the started periods of a year added up (SPEC 9 "Jaar")."""
    plist = started_year_periods(year, lg.start_day, lg.today)
    if not plist:
        raise ValueError("year has not started")
    flows = [lg.flows_for(p) for p in plist]
    tot = _sum_flows(flows)
    current = lg.current()
    # "Normaal" for a year: the same months one year earlier, when the data covers all of them.
    prev_ids = [lg.shift(p, -12) for p in plist]
    covered = all(q.id in lg.flows and q.start < current.start for q in prev_ids)
    prev_tot = _sum_flows([lg.flows_for(q) for q in prev_ids]) if covered else None

    # Per month over the months the data covers (a year whose imports start in June is not
    # averaged over twelve).
    n = max(1, sum(1 for p in plist if p.id in lg.flows))
    cats = []
    for cid in _spending_cats(lg):
        spent = tot["spent"].get(cid, 0)
        avg = prev_tot["spent"].get(cid, 0) if prev_tot else 0
        count = tot["counts"].get(cid, 0)
        if spent or avg or count:
            cats.append({"category_id": cid, "spent_cents": spent, "avg_cents": avg, "count": count,
                         "per_month_cents": int(round(spent / n))})
    cats.sort(key=lambda c: (-c["spent_cents"], -c["avg_cents"], c["category_id"]))

    months = [{"period": p.id, "label": p.label, "income_cents": f.income, "fixed_cents": f.fixed,
               "daily_cents": f.daily, "saved_cents": f.saved, "net_cents": f.net,
               "partial": p.id == current.id}
              for p, f in zip(plist, flows)]
    unsorted_rows = db.row(conn, """
        SELECT COUNT(*) AS n, COALESCE(SUM(t.amount_cents), 0) AS cents FROM transactions t
        JOIN categories c ON c.id = t.category_id WHERE c.key = 'unsorted' AND t.kind = 'normal'""")
    checking = networth.balance_of_type(conn, "checking")
    return {
        "period": year_period_json(lg, year, plist),
        "income_cents": tot["income"],
        "expected_income_cents": tot["income"],
        "fixed_cents": tot["fixed"],
        "fixed_upcoming_cents": 0,
        "daily_cents": tot["daily"],
        "saved_cents": tot["saved"],
        "saving_upcoming_cents": 0,
        "left_cents": None,
        "per_day_left_cents": None,
        "net_cents": tot["net"],
        "per_month": {"income_cents": int(round(tot["income"] / n)),
                      "fixed_cents": int(round(tot["fixed"] / n)),
                      "daily_cents": int(round(tot["daily"] / n)),
                      "saved_cents": int(round(tot["saved"] / n)),
                      "net_cents": int(round(tot["net"] / n))},
        "previous_year": ({"income_cents": prev_tot["income"], "fixed_cents": prev_tot["fixed"],
                           "daily_cents": prev_tot["daily"], "saved_cents": prev_tot["saved"],
                           "net_cents": prev_tot["net"], "from": prev_ids[0].start.isoformat(),
                           "to": prev_ids[-1].last.isoformat()} if prev_tot else None),
        "months": months,
        "pace": None,
        "categories": cats,
        "income": sorted(({"category_id": c, "cents": v} for c, v in tot["income_by_cat"].items()),
                         key=lambda x: -x["cents"]),
        "upcoming": [],
        "insights": [],
        "unsorted": {"merchants": unsorted_merchant_count(conn), "transactions": unsorted_rows["n"],
                     "cents": unsorted_rows["cents"]},
        "balance": {"checking_cents": checking or 0, "expected_end_cents": None},
        "free": None,
        "tempo": None,
        "checking_warning": None,
    }


def overview(conn: sqlite3.Connection, period_id: str | None) -> dict:
    """GET /overview (cached per database state). `period_id` may be a year ("2026")."""
    lg = ledger_mod.get(conn)
    if is_year_id(period_id):
        year = int(period_id)
        return cache.memo(conn, f"overview:{year}", lambda: build_year_overview(conn, lg, year))
    p = lg.period(period_id) if period_id else lg.current()
    return cache.memo(conn, f"overview:{p.id}", lambda: build_overview(conn, lg, p))


# ---------------------------------------------------------------------------- trends

def trends(conn: sqlite3.Connection, n: int = 12) -> dict:
    lg = ledger_mod.get(conn)

    def compute() -> dict:
        current = lg.current()
        plist = [lg.shift(current, -i) for i in reversed(range(n))]
        plist = [p for p in plist if lg.first is not None and p.end > lg.first]
        flows = [lg.flows_for(p) for p in plist]
        complete = {q.id for q in lg.complete_before(current, 10000)}
        out_periods = [{"period": p.id, "label": p.label, "income_cents": f.income,
                        "fixed_cents": f.fixed, "daily_cents": f.daily, "saved_cents": f.saved,
                        "net_cents": f.net, "partial": p.id not in complete}
                       for p, f in zip(plist, flows)]
        categories = []
        for cid, cat in lg.categories.items():
            if cat["grp"] not in (FIXED, DAILY) and cat["key"] not in ("unsorted", "creditcard"):
                continue
            cents = [f.spent.get(cid, 0) for f in flows]
            if any(cents):
                categories.append({"category_id": cid, "cents": cents})
        categories.sort(key=lambda c: -sum(c["cents"]))
        merchants: dict[str, dict] = {}
        for f in flows:
            for r in f.rows:
                grp, cid, value = r["bucket"]
                if grp not in (FIXED, DAILY) or not r["merchant_key"]:
                    continue
                m = merchants.setdefault(r["merchant_key"], {
                    "merchant_key": r["merchant_key"], "merchant_name": r["merchant_name"],
                    "category_id": cid, "cents": 0, "count": 0})
                m["cents"] += value
                m["count"] += 1
                m["merchant_name"], m["category_id"] = r["merchant_name"] or m["merchant_name"], cid
        top = sorted(merchants.values(), key=lambda m: -m["cents"])[:10]
        return {"periods": out_periods, "categories": categories, "top_merchants": top}
    return cache.memo(conn, f"trends:{n}", compute)


# ---------------------------------------------------------------------------- bakje / tag

def category_summary(conn: sqlite3.Connection, category: dict, period_id: str | None) -> dict:
    lg = ledger_mod.get(conn)
    p = lg.period(period_id) if period_id else lg.current()
    f = lg.flows_for(p)
    cid = category["id"]
    history = lg.complete_before(p, HISTORY)
    series = []
    for i in reversed(range(12)):
        q = lg.shift(p, -i)
        series.append({"period": q.id, "cents": category_value(lg.flows_for(q), category)})

    merchants: dict[str, dict] = {}
    for r in f.rows:
        if r["bucket"][1] != cid:
            continue
        key = r["merchant_key"] or ""
        m = merchants.setdefault(key, {"merchant_key": r["merchant_key"],
                                       "merchant_name": r["merchant_name"], "cents": 0, "count": 0})
        m["cents"] += r["bucket"][2]
        m["count"] += 1
    ids = {r["id"] for r in f.rows if r["bucket"][1] == cid}
    ids |= {r["id"] for r in txquery.period_rows(conn, p.start, p.end,
                                                 "t.category_id = ? AND a.hidden = 0 AND "
                                                 + txquery.CASHFLOW_WHERE,
                                                 (cid,))}
    tx_rows = []
    if ids:
        id_list = sorted(ids)
        tx_rows = db.rows(conn, f"SELECT * FROM transactions WHERE id IN ({db.placeholders(id_list)}) "
                                "ORDER BY date DESC, id DESC", id_list)
    return {
        "spent_cents": category_value(f, category),
        "avg_cents": _mean([category_value(lg.flows_for(h), category) for h in history]),
        "count": len(tx_rows),
        "series": series,
        "merchants": sorted(merchants.values(), key=lambda m: -m["cents"])[:10],
        "transactions": txquery.tx_list_json(conn, tx_rows),
        "period": _period_json(lg, p),
    }


def tag_summary(conn: sqlite3.Connection, tag_id: int) -> dict:
    lg = ledger_mod.get(conn)
    rows = db.rows(conn, """SELECT t.* FROM transactions t
                            JOIN transaction_tags tt ON tt.transaction_id = t.id
                            JOIN accounts a ON a.id = t.account_id
                            WHERE tt.tag_id = ? AND a.hidden = 0
                            ORDER BY t.date DESC, t.id DESC""", (tag_id,))
    by_cat: dict[int | None, int] = {}
    by_month: dict[str, int] = {}
    for r in rows:
        by_cat[r["category_id"]] = by_cat.get(r["category_id"], 0) - r["amount_cents"]
        pid = lg.period_of(date.fromisoformat(r["date"])).id
        by_month[pid] = by_month.get(pid, 0) - r["amount_cents"]
    return {
        "total_out_cents": sum(r["amount_cents"] for r in rows if r["amount_cents"] < 0),
        "total_in_cents": sum(r["amount_cents"] for r in rows if r["amount_cents"] > 0),
        "count": len(rows),
        "first_date": rows[-1]["date"] if rows else None,
        "last_date": rows[0]["date"] if rows else None,
        "by_category": sorted(({"category_id": c, "cents": v} for c, v in by_cat.items() if v),
                              key=lambda x: -x["cents"]),
        "by_month": [{"month": m, "cents": by_month[m]} for m in sorted(by_month)],
        "transactions": txquery.tx_list_json(conn, rows),
    }
