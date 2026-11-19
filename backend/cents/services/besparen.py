"""Besparen (SPEC 9 Bespaarlijst): one place that answers "waar kunnen we besparen?". Cents
does not know prices elsewhere, so it never promises an amount saved; it lists what costs money
every year and what changed, each with the amount per year:

- `subscriptions`: live items in Abonnementen and Internet, tv & bellen (new ones marked).
- `price_rises`: live items that became more expensive in the last twelve months, with the
  extra per year.
- `contracts`: energy, insurance and telecom contracts that have run for more than a year:
  worth comparing.
- `fees`: bank costs and identifiable currency-conversion costs in the last twelve months.
- `higher`: daily bakjes whose typical month (the median) of the last six complete months is
  clearly above that of the same six months a year earlier (≥ € 25 and ≥ 15 %), without spread
  parts and waardeverlies (no habit to cut back on), so one big purchase is no trend.
- `later`: payments to buy-now-pay-later services (Klarna, Riverty, in3, Billink) in the last
  three months: money already spent that still has to be paid.
"""

from __future__ import annotations

import re
import sqlite3
import statistics
from datetime import timedelta

from . import cache, ledger as ledger_mod, recurring
from .ledger import DAILY

COMPARE = ("energie", "verzekeringen", "telecom")
HIGHER_MONTHS = 6
LATER = re.compile(r"\b(klarna|riverty|afterpay|in3|billink|achteraf ?betalen)\b", re.I)
LATER_DAYS = 92


def _later_name(r: dict) -> str | None:
    for text in (r.get("merchant_name"), r.get("merchant_key"), r.get("description")):
        m = LATER.search(text or "")
        if m:
            word = m.group(1).lower()
            return {"in3": "in3", "afterpay": "Riverty (Afterpay)"}.get(word, word.capitalize())
    return None


def later_payments(lg: ledger_mod.Ledger) -> list[dict]:
    """Buy-now-pay-later providers paid in the last three months, by provider."""
    since = (lg.today - timedelta(days=LATER_DAYS)).isoformat()
    out: dict[str, dict] = {}
    for r in lg.rows:
        if r["amount_cents"] >= 0 or r["date"] < since:
            continue
        name = _later_name(r)
        if name:
            e = out.setdefault(name, {"name": name, "cents": 0, "count": 0, "last_date": r["date"]})
            e["cents"] += -r["amount_cents"]
            e["count"] += 1
            e["last_date"] = max(e["last_date"], r["date"])
    return sorted(out.values(), key=lambda e: -e["cents"])


def _higher(lg: ledger_mod.Ledger) -> list[dict]:
    recent = lg.complete_before(lg.current(), HIGHER_MONTHS)
    complete = {q.id for q in lg.complete_before(lg.current(), 10000)}
    before = [lg.shift(q, -12) for q in recent]
    if len(recent) < HIGHER_MONTHS or any(q.id not in complete for q in before):
        return []
    def habits(q, cid: int) -> int:
        """Spending in a bakje without spread parts and waardeverlies: a car's depreciation
        or a kitchen paid off over months is no habit you can cut back on."""
        return sum(r["bucket"][2] for r in lg.flows_for(q).rows if r["bucket"][1] == cid and not r.get("part"))

    out = []
    for cid, cat in lg.categories.items():
        if cat["grp"] != DAILY or cat["key"] in ("unsorted", "creditcard"):
            continue
        # the middle month, not the mean: one big purchase (a car, a holiday) is not a trend
        now = statistics.median(habits(q, cid) for q in recent)
        then = statistics.median(habits(q, cid) for q in before)
        if then > 0 and now - then >= 2500 and now >= then * 1.15:
            out.append({"category_id": cid, "now_cents": int(round(now)), "then_cents": int(round(then)),
                        "extra_per_year_cents": int(round((now - then) * 12))})
    return sorted(out, key=lambda x: -x["extra_per_year_cents"])


def _compute(conn: sqlite3.Connection) -> dict:
    from .insights import fx_cost
    lg = ledger_mod.get(conn)
    full = recurring.full_items(conn)
    keys = {cid: c["key"] for cid, c in lg.categories.items()}
    by_id = {r["id"]: r for r in lg.rows}
    live = [i for i in full if i["direction"] == "out" and i["status"] != "ended"]
    year_ago = (lg.today - timedelta(days=365)).isoformat()
    pub = recurring.public

    subs = [{**pub(i), "per_year_cents": abs(i["per_year_cents"]), "new": i["status"] == "new"}
            for i in live if keys.get(i["category_id"]) in recurring.SUBSCRIPTION_BAKJES]
    subs.sort(key=lambda i: -i["per_year_cents"])

    rises = []
    for i in live:
        ch = i["change"]
        if ch and abs(ch["to_cents"]) > abs(ch["from_cents"]) and ch["date"] >= year_ago:
            per = recurring.PER_YEAR[i["frequency"]]
            rises.append({**pub(i), "from_cents": abs(ch["from_cents"]), "to_cents": abs(ch["to_cents"]),
                          "since": ch["date"],
                          "extra_per_year_cents": (abs(ch["to_cents"]) - abs(ch["from_cents"])) * per})
    rises.sort(key=lambda i: -i["extra_per_year_cents"])

    contracts = []
    for i in live:
        if keys.get(i["category_id"]) not in COMPARE:
            continue
        first = min((by_id[x]["date"] for x in i["_ids"] if x in by_id), default=None)
        if first and first <= year_ago:
            contracts.append({**pub(i), "per_year_cents": abs(i["per_year_cents"]), "since": first})
    contracts.sort(key=lambda i: -i["per_year_cents"])

    rows = [r for r in lg.rows if r["date"] >= year_ago and r["account_type"] == "checking"]
    bank = -sum(r["amount_cents"] for r in rows if r["method"] == "fee" and r["amount_cents"] < 0)
    fx = sum(fx_cost(r) for r in rows)
    sections = {
        "subscriptions": {"items": subs, "per_year_cents": sum(i["per_year_cents"] for i in subs)},
        "price_rises": {"items": rises, "per_year_cents": sum(i["extra_per_year_cents"] for i in rises)},
        "contracts": {"items": contracts, "per_year_cents": sum(i["per_year_cents"] for i in contracts)},
        "fees": {"bank_cents": bank, "fx_cents": fx, "per_year_cents": bank + fx, "since": year_ago},
        "higher": {"items": _higher(lg)},
        "later": {"items": later_payments(lg)},
    }
    sections["count"] = (len(subs) + len(rises) + len(contracts) + len(sections["higher"]["items"])
                         + len(sections["later"]["items"]) + (1 if bank + fx > 0 else 0))
    return sections


def compute(conn: sqlite3.Connection) -> dict:
    return cache.memo(conn, "besparen", lambda: _compute(conn))

