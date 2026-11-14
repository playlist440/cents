"""Recurring payments ("vaste lasten") and recurring income (SPEC 9 "Recurring").

Detected on the fly from the cash-flow transactions, cached per database state.
`amount_cents`, `per_month_cents` and `change.*` carry the sign of the payments (negative =
money out); the totals of GET /recurring are positive magnitudes.
"""

from __future__ import annotations

import calendar
import sqlite3
import statistics
from datetime import date, timedelta

from .. import db
from ..hooks import provide_recurring_lookup
from . import cache, ledger as ledger_mod

# name -> (min gap, max gap in days, payments per month, step in days for projections)
FREQUENCIES: dict[str, tuple[int, int, float, int]] = {
    "weekly": (5, 9, 52 / 12, 7),
    "2-weekly": (12, 16, 26 / 12, 14),
    "4-weekly": (26, 29, 13 / 12, 28),
    "monthly": (24, 38, 1.0, 0),
    "quarterly": (80, 102, 1 / 3, 91),
    "half-year": (165, 200, 1 / 6, 182),
    "yearly": (340, 390, 1 / 12, 365),
}
SUBSCRIPTION_FREQUENCIES = ("monthly", "quarterly", "half-year", "yearly")
PER_YEAR = {"weekly": 52, "2-weekly": 26, "4-weekly": 13, "monthly": 12, "quarterly": 4,
            "half-year": 2, "yearly": 1}
SUBSCRIPTION_BAKJES = ("abonnementen", "telecom")
NEW_DAYS = 75               # first payment less than this long ago -> "new" ...
NEW_HISTORY_DAYS = 75       # ... but only with this much history before it
ENDED_FACTOR = 1.6          # overdue by more than this x the median gap -> "ended"
ENDED_LISTED_DAYS = 92      # ended items stay listed for about three periods
CHANGE_LISTED_DAYS = 365    # a price change is reported for a year
SPENDING_STABLE = 1.05      # a daily-bakje series must be this stable to be a subscription


def _median(values: list[float]) -> float:
    return statistics.median(values)


def _day(t: dict) -> date:
    return date.fromisoformat(t["date"])


def _cluster(txs: list[dict]) -> list[list[dict]]:
    """Split one merchant's payments by amount: same cluster while
    amount <= previous * 1.15 + EUR 0.50 (sorted by absolute amount)."""
    ordered = sorted(txs, key=lambda t: (abs(t["amount_cents"]), t["date"]))
    clusters: list[list[dict]] = []
    for t in ordered:
        amount = abs(t["amount_cents"])
        if clusters and amount <= abs(clusters[-1][-1]["amount_cents"]) * 1.15 + 50:
            clusters[-1].append(t)
        else:
            clusters.append([t])
    return [sorted(c, key=lambda t: (t["date"], t["id"])) for c in clusters]


def _gaps(txs: list[dict]) -> list[int]:
    dates = [_day(t) for t in txs]
    return [(b - a).days for a, b in zip(dates, dates[1:])]


def frequency(gaps: list[int]) -> str | None:
    """The frequency whose window holds the median gap (a stable 26-29 day rhythm is 4-weekly)."""
    if not gaps:
        return None
    if len(gaps) >= 2 and all(26 <= g <= 29 for g in gaps):
        return "4-weekly"
    mg = _median(gaps)
    for name, (lo, hi, _, _) in FREQUENCIES.items():
        if name != "4-weekly" and lo <= mg <= hi:
            return name
    return None


def _regular(txs: list[dict]) -> str | None:
    """Frequency when the payment dates are regular (amounts not checked)."""
    gaps = _gaps(txs)
    freq = frequency(gaps)
    if freq is None or (len(txs) < 3 and freq != "yearly"):
        return None
    mg = _median(gaps)
    if sum(abs(g - mg) <= 0.35 * mg for g in gaps) < 0.7 * len(gaps):
        return None
    return freq


def _split_by_day(cluster: list[dict]) -> list[list[dict]]:
    """Two series with similar amounts on different days of the month (two policies at one
    insurer) merge into one cluster with alternating gaps. Split at the widest gap between the
    days of the month when both halves are regular."""
    if len(cluster) < 4 or _regular(cluster):
        return [cluster]
    days = sorted({_day(t).day for t in cluster})
    if len(days) < 2:
        return [cluster]
    widest, cut = max((b - a, a) for a, b in zip(days, days[1:]))
    if widest < 3:
        return [cluster]
    low = [t for t in cluster if _day(t).day <= cut]
    high = [t for t in cluster if _day(t).day > cut]
    if _regular(low) and _regular(high):
        return [low, high]
    return [cluster]


def _link(segments: list[list[dict]]) -> list[list[list[dict]]]:
    """Chain amount clusters of one merchant that follow each other: the old price stops and the
    new one starts about one gap later (a price rise of more than 15 %)."""
    chains: list[list[list[dict]]] = []
    for seg in sorted(segments, key=lambda s: s[0]["date"]):
        target = None
        for chain in chains:
            flat = [t for s in chain for t in s]
            if len(flat) < 2 or flat[-1]["date"] >= seg[0]["date"]:
                continue
            g = _median(_gaps(flat))
            step = (_day(seg[0]) - _day(flat[-1])).days
            ratio = abs(seg[0]["amount_cents"]) / max(1, abs(flat[-1]["amount_cents"]))
            if 0.5 * g <= step <= 1.6 * g and 0.5 <= ratio <= 2.0:
                target = chain
                break
        if target is not None:
            target.append(seg)
        else:
            chains.append([seg])
    return chains


def _same_price(a: int, b: int) -> bool:
    return abs(a - b) <= max(0.02 * b, 50)


def _change(txs: list[dict]) -> dict | None:
    """The most recent price change: the run of payments at the latest price compared with the
    median of the three payments before that run."""
    amounts = [abs(t["amount_cents"]) for t in txs]
    latest = amounts[-1]
    i = len(amounts) - 1
    while i > 0 and _same_price(amounts[i - 1], latest):
        i -= 1
    if i == 0:
        return None
    before = _median(amounts[max(0, i - 3):i])
    if abs(latest - before) <= 0.02 * before or abs(latest - before) <= 50:
        return None
    sign = -1 if txs[-1]["amount_cents"] < 0 else 1
    return {"from_cents": sign * int(round(before)), "to_cents": sign * latest, "date": txs[i]["date"]}


def _next_monthly(dates: list[date]) -> date:
    usual = int(_median([d.day for d in dates[-6:]]))
    last = dates[-1]
    y, m = last.year, last.month
    for _ in range(3):
        candidate = date(y, m, min(usual, calendar.monthrange(y, m)[1]))
        if candidate > last + timedelta(days=15):
            return candidate
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return last + timedelta(days=30)


def _group(t: dict) -> str:
    """Bakje group of a payment; "Nog te sorteren" behaves like daily spending here."""
    if t.get("category_key") == "unsorted":
        return "daily"
    return t.get("grp") or "fixed"


def analyse_series(segments: list[list[dict]], data_today: date,
                   history_start: date | None = None) -> dict | None:
    """RecurringItem fields (plus private `_ids`, `_group`, `_base`) for a chain of amount
    clusters, oldest first; None when it is not recurring (or ended too long ago)."""
    txs = [t for s in segments for t in s]
    n = len(txs)
    freq = _regular(txs)
    if freq is None:
        return None
    gaps = _gaps(txs)
    mg = _median(gaps)
    ref = segments[-1] if len(segments[-1]) >= 2 or len(segments) == 1 else segments[-2]
    last6 = [abs(t["amount_cents"]) for t in ref[-6:]]
    variable = False
    if max(last6) > min(last6) * 1.25:
        if freq == "monthly" and n >= 4:
            variable = True
        else:
            return None
    group = _group(txs[-1])
    whole6 = [abs(t["amount_cents"]) for t in txs[-6:]]
    if group == "daily" and (freq not in SUBSCRIPTION_FREQUENCIES or variable
                             or max(whole6) > min(whole6) * SPENDING_STABLE):
        return None         # groceries, fuel, a favourite restaurant: no fixed cost

    dates = [_day(t) for t in txs]
    since_last = (data_today - dates[-1]).days
    if since_last > ENDED_FACTOR * mg:
        ended_since = dates[-1] + timedelta(days=ENDED_FACTOR * mg)
        if (data_today - ended_since).days > ENDED_LISTED_DAYS:
            return None
        status = "ended"
    elif ((data_today - dates[0]).days < NEW_DAYS and history_start is not None
          and (dates[0] - history_start).days >= NEW_HISTORY_DAYS):
        status = "new"
    else:
        status = "active"

    last = txs[-1]
    sign = -1 if last["amount_cents"] < 0 else 1
    typical = int(round(_median(last6)))
    amount = sign * typical if variable else last["amount_cents"]
    next_date = _next_monthly(dates) if freq == "monthly" else dates[-1] + timedelta(days=round(mg))
    change = None
    if not variable:
        if len(segments) > 1:
            before = _median([abs(t["amount_cents"]) for t in segments[-2][-3:]])
            latest = abs(last["amount_cents"])
            if abs(latest - before) > 0.02 * before and abs(latest - before) > 50:
                change = {"from_cents": sign * int(round(before)), "to_cents": last["amount_cents"],
                          "date": segments[-1][0]["date"]}
        else:
            change = _change(txs)
    if change and (data_today - date.fromisoformat(change["date"])).days > CHANGE_LISTED_DAYS:
        change = None
    direction = "out" if sign < 0 else "in"
    base = f"{last['merchant_key']}|{direction}|{freq}"
    # the series' original amount: stable when prices change later, so "Negeer" sticks
    first_amount = round(_median([abs(t["amount_cents"]) for t in txs[:3]]) / 100)
    return {
        "key": base if variable else f"{base}|{first_amount}",
        "name": last["merchant_name"] or last["merchant_key"],
        "merchant_key": last["merchant_key"],
        "category_id": last["category_id"],
        "direction": direction,
        "amount_cents": amount,
        "frequency": freq,
        "per_month_cents": int(round(amount * FREQUENCIES[freq][2])),
        "per_year_cents": abs(amount) * PER_YEAR[freq],
        "last_date": last["date"],
        "next_date": next_date.isoformat(),
        "status": status,
        "variable": variable,
        "count": n,
        "change": change,
        "_ids": [t["id"] for t in txs],
        "_group": group,
    }


def analyse_cluster(txs: list[dict], data_today: date, history_start: date | None = None) -> dict | None:
    """One amount cluster as a series (kept for callers and tests)."""
    item = analyse_series([sorted(txs, key=lambda t: (t["date"], t["id"]))], data_today, history_start)
    return public(item) if item else None


def candidate_rows(lg: ledger_mod.Ledger) -> list[dict]:
    """Cash-flow payments that may recur: no cash withdrawals, no own-account or card bills."""
    out = []
    for r in lg.rows:
        if r["account_type"] not in ("checking", "credit") or not r["merchant_key"]:
            continue
        if r["method"] == "atm" or r["kind"] == "settlement" or r["grp"] == "internal":
            continue
        out.append(r)
    return out


def _busy_between(pair: list[dict], txs: list[dict]) -> bool:
    """A yearly pair is only believable when the merchant was (nearly) silent in between:
    two similar card payments a year apart at a shop you visit often are a coincidence."""
    dates = sorted(t["date"] for t in pair)
    lo, hi = dates[0], dates[-1]
    ids = {t["id"] for t in pair}
    return sum(1 for t in txs if lo < t["date"] < hi and t["id"] not in ids) >= 2


def public(item: dict) -> dict:
    return {k: v for k, v in item.items() if not k.startswith("_")}


def detect_full(rows: list[dict], data_today: date, ignored: set[str] = frozenset()) -> list[dict]:
    """Recurring items with their private fields (`_ids`, `_group`)."""
    starts: dict[object, date] = {}
    for r in rows:
        acc = r.get("account_id")
        d = _day(r)
        if acc not in starts or d < starts[acc]:
            starts[acc] = d
    groups: dict[tuple[str, bool], list[dict]] = {}
    for r in rows:
        if r["amount_cents"] == 0:
            continue
        groups.setdefault((r["merchant_key"], r["amount_cents"] < 0), []).append(r)
    items = []
    for txs in groups.values():
        if len(txs) < 2:
            continue
        segments = [part for cl in _cluster(txs) for part in _split_by_day(cl)]
        for chain in _link(segments):
            flat = [t for s in chain for t in s]
            if len(flat) == 2 and _busy_between(flat, txs):
                continue
            item = analyse_series(chain, data_today, starts.get(flat[0].get("account_id")))
            if item and item["_group"] == "daily" and _busy_between(flat, [t for t in txs if t not in flat]):
                continue    # a shop or restaurant you also visit at other times: no subscription
            if item:
                items.append(item)
    seen: dict[str, int] = {}
    for item in sorted(items, key=lambda i: (i["last_date"], i["name"])):
        n = seen.get(item["key"], 0)
        seen[item["key"]] = n + 1
        if n:
            item["key"] = f"{item['key']}#{n + 1}"
    items = [i for i in items if i["key"] not in ignored]
    items.sort(key=lambda i: (-abs(i["per_month_cents"]), i["name"]))
    return items


def detect(rows: list[dict], data_today: date, ignored: set[str] = frozenset()) -> list[dict]:
    return [public(i) for i in detect_full(rows, data_today, ignored)]


def _computed(conn: sqlite3.Connection) -> dict:
    def compute() -> dict:
        lg = ledger_mod.get(conn)
        ignored = {r["key"] for r in db.rows(conn, "SELECT key FROM recurring_ignored")}
        full = detect_full(candidate_rows(lg), lg.data_today, ignored)
        return {"items": [public(i) for i in full],
                "full": full,
                "groups": {i["key"]: i["_group"] for i in full},
                "by_tx": {tid: public(i) for i in full for tid in i["_ids"]}}
    return cache.memo(conn, "recurring", compute)


def items(conn: sqlite3.Connection) -> list[dict]:
    """All recurring items (cached per database state). Do not mutate the result."""
    return _computed(conn)["items"]


def full_items(conn: sqlite3.Connection) -> list[dict]:
    """Items with their private fields (`_ids`: the payments, `_group`). Do not mutate."""
    return _computed(conn)["full"]


def by_transaction(conn: sqlite3.Connection) -> dict[int, dict]:
    """transaction id -> the recurring item it belongs to."""
    return _computed(conn)["by_tx"]


def group_of(lg: ledger_mod.Ledger, item: dict) -> str | None:
    cat = lg.categories.get(item["category_id"] or -1, {})
    return "daily" if cat.get("key") == "unsorted" else cat.get("grp")


def recurring_json(conn: sqlite3.Connection) -> dict:
    lg = ledger_mod.get(conn)
    all_items = items(conn)
    live = [i for i in all_items if i["status"] != "ended"]
    monthly_out = -sum(i["per_month_cents"] for i in live
                       if i["direction"] == "out" and group_of(lg, i) == "fixed")
    monthly_in = sum(i["per_month_cents"] for i in live
                     if i["direction"] == "in" and group_of(lg, i) == "income")
    subs = [i for i in live if i["direction"] == "out"
            and lg.categories.get(i["category_id"] or -1, {}).get("key") in SUBSCRIPTION_BAKJES]
    return {"monthly_out_cents": monthly_out, "monthly_in_cents": monthly_in,
            "yearly_out_cents": monthly_out * 12, "items": [dict(i) for i in all_items],
            "subscriptions": {"per_month_cents": -sum(i["per_month_cents"] for i in subs),
                              "per_year_cents": sum(i["per_year_cents"] for i in subs),
                              "count": len(subs)}}


def ignore(conn: sqlite3.Connection, key: str) -> None:
    conn.execute("INSERT OR IGNORE INTO recurring_ignored (key) VALUES (?)", (key,))


@provide_recurring_lookup
def for_merchant(conn: sqlite3.Connection, merchant_key: str) -> dict | None:
    """The main recurring item of a merchant (for GET /transactions/{id})."""
    found = [i for i in items(conn) if i["merchant_key"] == merchant_key]
    if not found:
        return None
    found.sort(key=lambda i: (i["status"] == "ended", -abs(i["per_month_cents"])))
    return dict(found[0])


def occurrences(item: dict, start: date, end: date) -> list[date]:
    """Expected payment dates of a (not ended) item in [start, end), from next_date on."""
    if item["status"] == "ended":
        return []
    out = []
    day = date.fromisoformat(item["next_date"])
    step_days = {name: f[3] for name, f in FREQUENCIES.items()}
    while day < end and len(out) < 10:
        if day >= start:
            out.append(day)
        if item["frequency"] == "monthly":
            y, m = (day.year + 1, 1) if day.month == 12 else (day.year, day.month + 1)
            day = date(y, m, min(day.day, calendar.monthrange(y, m)[1]))
        else:
            day = day + timedelta(days=step_days[item["frequency"]])
    return out
