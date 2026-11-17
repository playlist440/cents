"""Insights (SPEC 9 "Insights"): short, calm Dutch sentences about one period.

Every rule only speaks when the data supports it (minimum history per rule). All candidates are
ranked and at most five are returned. Shape:
`{id, kind, tone, emoji, title, value_cents?, detail?, link: {screen, params}, href}`;
`href` is the frontend hash route for the same place.

The Overzicht shows only the actionable kinds (`OVERZICHT_HIDDEN` are left out there:
informational figures the hero, tiles or buffer bar already say). `candidates` still returns
every kind.

Rules about "now" (pace, subscriptions, bills due, goals, import age, unsorted, buffer) only run
for the current period; rules about a period's own numbers run for any period.
"""

from __future__ import annotations

import re
import sqlite3
import statistics
from datetime import date, timedelta

from .. import db
from . import goals as goals_mod
from . import recurring
from .ledger import DAILY, FIXED, SAVING, Ledger
from .periods import Period
from .text import day_month, euro, month_name, one_decimal, percent, period_month

MAX_INSIGHTS = 5

SCORES = {
    "stale": 100, "duplicate": 90, "price_change": 80, "ended_recurring": 78,
    "new_recurring": 76, "category_spike": 70, "large": 68, "yearly_bill": 66, "left_over": 64,
    "pace": 60, "goal_behind": 58, "goal_reached": 56, "buffer": 55, "unsorted": 50,
    "fixed_share": 45, "last_year": 40, "savings_rate": 35, "fx_costs": 33, "bank_fees": 30,
    "tempo": 62,
}


# Informational kinds that the Overzicht does not show (DECISIONS 2026-11-17).
OVERZICHT_HIDDEN = frozenset({"fixed_share", "last_year", "savings_rate", "pace", "buffer",
                              "goal_reached", "bank_fees", "fx_costs"})


def _href(screen: str, params: dict) -> str:
    q = lambda: f"?period={params['period']}" if params.get("period") else ""  # noqa: E731
    if screen == "category":
        return f"/overzicht/bakje/{params['id']}{q()}"
    if screen == "goal":
        return f"/potjes/{params['id']}"
    if screen == "transactions" and "from" in params:
        parts = [f"{k}={v}" for k, v in params.items() if v is not None]
        return "/transacties?" + "&".join(parts)
    if screen == "transactions":
        parts = [f"{k}={v}" for k, v in params.items() if v is not None]
        return "/transacties" + ("?" + "&".join(parts) if parts else "")
    return {"sort": "/sorteren", "recurring": "/vaste-lasten", "goals": "/potjes",
            "import": "/import", "networth": "/vermogen", "trends": "/jaaroverzicht"}[screen]


def make(kind: str, ident: str, tone: str, emoji: str, title: str, screen: str,
         params: dict | None = None, value_cents: int | None = None, detail: str | None = None,
         bonus: float = 0) -> dict:
    params = params or {}
    out = {"id": ident, "kind": kind, "tone": tone, "emoji": emoji, "title": title,
           "link": {"screen": screen, "params": params}, "href": _href(screen, params),
           "_score": SCORES[kind] + bonus}
    if value_cents is not None:
        out["value_cents"] = int(value_cents)
    if detail:
        out["detail"] = detail
    return out


def _group(lg: Ledger, item: dict) -> str | None:
    return lg.categories.get(item["category_id"] or -1, {}).get("grp")


# ---------------------------------------------------------------------------- rules

def pace(lg: Ledger, p: Period, ov: dict) -> list[dict]:
    pc = ov.get("pace")
    if not ov["period"]["is_current"] or not pc or not pc["typical"] or len(pc["actual"]) < 5:
        return []
    if len(lg.complete_before(p, 6)) < 2:
        return []
    i = len(pc["actual"]) - 1
    diff = pc["actual"][i] - pc["typical"][i]
    if abs(diff) < max(2500, 0.1 * pc["typical"][i]):
        return []
    if diff < 0:
        return [make("pace", f"pace:{p.id}", "good", "🌱",
                     f"Dagelijkse uitgaven op koers: {euro(-diff)} onder normaal tot nu toe",
                     "transactions", {"period": p.id}, -diff)]
    return [make("pace", f"pace:{p.id}", "info", "🧭",
                 f"Dagelijkse uitgaven {euro(diff)} boven normaal tot nu toe",
                 "transactions", {"period": p.id}, diff)]


NON_MONTHLY = ("quarterly", "half-year", "yearly")


def category_spike(lg: Ledger, p: Period, ov: dict, by_tx: dict[int, dict]) -> list[dict]:
    history = lg.complete_before(p, 6)
    if len(history) < 3:
        return []
    is_current = ov["period"]["is_current"]
    upto = len(ov["pace"]["actual"]) if is_current and ov.get("pace") else p.days_total
    if is_current and upto < 7:
        return []

    def spent_until(q: Period, days: int) -> dict[int, int]:
        """Spending per bakje in the first `days` days, without quarterly/yearly bills (they
        are expected, not "more than normal")."""
        f = lg.flows_for(q)
        limit = (q.start + timedelta(days=days)).isoformat()
        out: dict[int, int] = {}
        for r in f.rows:
            grp, cid, value = r["bucket"]
            item = by_tx.get(r["id"])
            if item and item["frequency"] in NON_MONTHLY:
                continue
            if grp in (FIXED, DAILY) and r["date"] < limit:
                out[cid] = out.get(cid, 0) + value
        return out

    now = spent_until(p, upto)
    before = [spent_until(h, upto) for h in history]
    found = []
    for cid, spent in now.items():
        cat = lg.categories.get(cid)
        if not cat or cat["grp"] not in (FIXED, DAILY) or cat["key"] == "unsorted":
            continue
        normal = statistics.median([b.get(cid, 0) for b in before])
        diff = spent - normal
        if diff > 5000 and diff > 0.2 * normal:
            found.append((diff, cid, cat))
    found.sort(key=lambda x: -x[0])
    when = "deze maand" if is_current else f"in {period_month(p.id)}"
    return [make("category_spike", f"category_spike:{cid}:{p.id}", "info", cat["emoji"] or "📊",
                 f"{cat['name']}: {euro(diff)} meer dan normaal {when}",
                 "category", {"id": cid, "period": p.id}, diff, bonus=min(diff / 10000, 5))
            for diff, cid, cat in found[:2]]


def recurring_news(lg: Ledger, p: Period, ov: dict, items: list[dict]) -> list[dict]:
    """Price changes, new and stopped fixed costs (bakjes of group `fixed` only), and yearly
    bills that are due soon."""
    if not ov["period"]["is_current"]:
        return []
    out = []
    recent = lg.shift(p, -3).start.isoformat()
    for item in items:
        group = _group(lg, item)
        if item["direction"] != "out" or group in (SAVING, "internal"):
            continue
        params = {"key": item["key"]}
        ch = item["change"]
        if group == FIXED and ch and item["status"] != "ended" and ch["date"] >= recent:
            delta = abs(ch["to_cents"]) - abs(ch["from_cents"])
            word = "duurder" if delta > 0 else "goedkoper"
            out.append(make("price_change", f"price_change:{item['key']}:{ch['date']}", "info", "🏷️",
                            f"{item['name']} is {euro(max(abs(delta), 100))} {word} geworden",
                            "recurring", params, delta, detail=f"Sinds {day_month(ch['date'])}"))
        if group == FIXED and item["status"] == "new":
            is_sub = lg.categories.get(item["category_id"] or -1, {}).get("key") == "abonnementen"
            what = "Nieuw abonnement" if is_sub else "Nieuwe vaste last"
            out.append(make("new_recurring", f"new_recurring:{item['key']}", "info", "✨",
                            f"{what}: {item['name']}, {euro(abs(item['per_month_cents']))} per maand",
                            "recurring", params, abs(item["per_month_cents"])))
        if group == FIXED and item["status"] == "ended":
            out.append(make("ended_recurring", f"ended_recurring:{item['key']}:{item['last_date']}",
                            "info", "⏸️",
                            f"{item['name']} is sinds {month_name(item['last_date'])} niet meer betaald",
                            "recurring", params, abs(item["amount_cents"]),
                            detail="Opgezegd, of nog niet afgeschreven?"))
        if item["frequency"] == "yearly" and item["status"] != "ended":
            due = date.fromisoformat(item["next_date"])
            if 0 <= (due - lg.data_today).days <= 60:
                out.append(make("yearly_bill", f"yearly_bill:{item['key']}:{item['next_date']}", "info", "📅",
                                f"{item['name']} {euro(abs(item['amount_cents']))} komt eraan in {month_name(due)}",
                                "recurring", params, abs(item["amount_cents"])))
    return out


COUNT_WORDS = {2: "Twee", 3: "Drie", 4: "Vier", 5: "Vijf"}


def duplicates(lg: Ledger, p: Period, ov: dict) -> list[dict]:
    """Identical payments (merchant and amount) within three days of each other: one insight
    per group. More than two groups: the largest one, plus one insight for the rest."""
    if ov["period"]["is_current"]:
        lo, hi = lg.data_today - timedelta(days=45), lg.data_today + timedelta(days=1)
    else:
        lo, hi = p.start, p.end
    rows = [r for r in lg.rows if lo.isoformat() <= r["date"] < hi.isoformat()
            and r["amount_cents"] <= -1000 and r["method"] in ("card", "debit")
            and r["merchant_key"] and r["account_type"] == "checking"]
    by_key: dict[tuple[str, int], list[dict]] = {}
    for r in rows:
        by_key.setdefault((r["merchant_key"], r["amount_cents"]), []).append(r)
    groups: list[list[dict]] = []
    for txs in by_key.values():
        run: list[dict] = []
        for r in txs:
            if run and (date.fromisoformat(r["date"]) - date.fromisoformat(run[-1]["date"])).days > 3:
                if len(run) > 1:
                    groups.append(run)
                run = []
            run.append(r)
        if len(run) > 1:
            groups.append(run)
    if not groups:
        return []
    groups.sort(key=lambda g: (-(len(g) - 1) * -g[0]["amount_cents"], g[0]["date"]))
    out = []
    shown = groups[:1] if len(groups) > 2 else groups
    for g in shown:
        first, last = g[0], g[-1]
        when = f"op {day_month(first['date'])}" if first["date"] == last["date"] \
            else f"tussen {day_month(first['date'])} en {day_month(last['date'])}"
        times = COUNT_WORDS.get(len(g), str(len(g)))
        out.append(make("duplicate", f"duplicate:{first['merchant_key']}:{first['date']}", "warn", "👀",
                        f"{times} keer {euro(-first['amount_cents'])} bij {first['merchant_name']} {when}",
                        "transactions", {"merchant_key": first["merchant_key"], "period": p.id},
                        -first["amount_cents"] * (len(g) - 1), detail="Klopt dat?"))
    if len(groups) > 2:
        rest = groups[1:]
        out.append(make("duplicate", f"duplicate:rest:{rest[0][0]['merchant_key']}:{rest[0][0]['date']}",
                        "warn", "👀", f"{len(rest)} andere betalingen staan er dubbel in",
                        "transactions", {"period": p.id},
                        sum(-g[0]["amount_cents"] * (len(g) - 1) for g in rest), bonus=-1))
    return out


def large(lg: Ledger, p: Period, ov: dict, by_tx: dict[int, dict]) -> list[dict]:
    fc = lg.first_complete()
    if fc is None or len(lg.complete_before(p, 3)) < 3:
        return []
    f = lg.flows_for(p)
    by_merchant: dict[str, list[int]] = {}
    by_cat: dict[int, list[int]] = {}
    for r in lg.rows:
        b = r["bucket"]
        if b and b[0] in (FIXED, DAILY) and r["amount_cents"] < 0:
            by_merchant.setdefault(r["merchant_key"] or "", []).append(r)
            by_cat.setdefault(b[1], []).append(r)
    best = None
    for r in f.rows:
        grp, cid, value = r["bucket"]
        if grp not in (FIXED, DAILY) or r["amount_cents"] >= 0 or value <= 15000 or r["id"] in by_tx:
            continue
        others = [abs(o["amount_cents"]) for o in by_merchant.get(r["merchant_key"] or "", [])
                  if o["id"] != r["id"]]
        if len(others) < 3:
            others = [abs(o["amount_cents"]) for o in by_cat.get(cid, []) if o["id"] != r["id"]]
        if len(others) < 3:
            continue
        typical = statistics.median(others)
        if value > 3 * typical and (best is None or value > best[1]):
            best = (r, value)
    if not best:
        return []
    r, value = best
    return [make("large", f"large:{r['id']}", "info", "💸",
                 f"Eenmalig {euro(value)} bij {r['merchant_name'] or 'onbekend'}",
                 "transactions", {"merchant_key": r["merchant_key"], "period": p.id,
                                  "transaction_id": r["id"]}, value)]


def _complete_ids(lg: Ledger) -> set[str]:
    return {q.id for q in lg.complete_before(lg.current(), 10000)}


def savings_rate(lg: Ledger, p: Period, ov: dict) -> list[dict]:
    complete = _complete_ids(lg)
    if ov["period"]["is_current"]:
        year = p.id[:4]
        plist = [lg.flows_for(lg.period(pid)) for pid in sorted(complete) if pid[:4] == year]
        if len(plist) < 2:
            return []
        income = sum(f.income for f in plist)
        saved = sum(f.saved for f in plist)
        when = "Dit jaar"
        ident = f"savings_rate:{year}:{len(plist)}"
    else:
        if p.id not in complete:
            return []
        income, saved = ov["income_cents"], ov["saved_cents"]
        when = f"In {period_month(p.id)}"
        ident = f"savings_rate:{p.id}"
    if income <= 0 or saved <= 0 or saved / income < 0.02:
        return []
    return [make("savings_rate", ident, "good", "🐷",
                 f"{when} {percent(saved / income)} van je inkomen gespaard",
                 "goals", {}, saved)]


def buffer(conn: sqlite3.Connection, lg: Ledger, p: Period, ov: dict) -> list[dict]:
    """Same definition as the buffer bar (outlook.buffer_status): what the buffer holds in
    months of fixed costs, against the `buffer` assumption."""
    if not ov["period"]["is_current"]:
        return []
    b = ov.get("buffer")
    if len(lg.complete_before(p, 6)) < 2 or not b or b["months"] is None or b["saved_cents"] <= 0:
        return []
    title = f"Je buffer dekt {one_decimal(b['months'])} maanden vaste lasten"
    if b["saved_cents"] < b["target_cents"]:
        detail = (f"Doel: {euro(b['target_cents'])}"
                  + (f", {one_decimal(b['target_months'])} maanden" if b["target_months"] else ""))
        return [make("buffer", f"buffer:{p.id}", "warn", "🛟", title, "networth", {},
                     b["saved_cents"], detail=detail)]
    return [make("buffer", f"buffer:{p.id}", "good", "🛟", title, "networth", {}, b["saved_cents"],
                 bonus=-25)]


def tempo(ov: dict) -> list[dict]:
    """The last three complete periods together: more out than in."""
    t = ov.get("tempo")
    if not ov["period"]["is_current"] or not t or t["avg_net_cents"] >= 0:
        return []
    short = -t["avg_net_cents"]
    if short < 2500:
        return []
    return [make("tempo", f"tempo:{t['since']}", "warn", "📉",
                 f"Jullie geven sinds {period_month(t['since'])} gemiddeld {euro(short)} per maand "
                 "meer uit dan er binnenkomt.", "trends", {}, -short)]


def left_over(lg: Ledger, p: Period, ov: dict) -> list[dict]:
    """A finished period whose result (income − fixed − daily, as the hero) is positive. A potje
    is suggested only for money that is still on the checking account: not when the month drew
    on savings, nor for what was already put aside."""
    complete = _complete_ids(lg)
    target = p
    if ov["period"]["is_current"]:
        if ov["period"]["day_index"] > 10:
            return []
        target = lg.shift(p, -1)
    if target.id not in complete:
        return []
    f = lg.flows_for(target)
    over = f.income - f.fixed - f.daily
    if over < 5000:
        return []
    title = f"{euro(over)} over in {period_month(target.id)}"
    unsaved = over - f.saved
    if f.saved >= 0 and unsaved >= 5000:
        title += ". Zet het in een potje?" if f.saved == 0 else \
            f", waarvan {euro(unsaved)} nog niet gespaard. Zet het in een potje?"
    elif f.saved < 0:
        title += f", met {euro(-f.saved)} uit je spaargeld"
    return [make("left_over", f"left_over:{target.id}", "good", "🎉", title, "goals", {}, over)]


def unsorted(conn: sqlite3.Connection, p: Period, ov: dict) -> list[dict]:
    n = ov["unsorted"]["merchants"]
    if not ov["period"]["is_current"] or n <= 0:
        return []
    persons = db.value(conn, """
        SELECT COUNT(DISTINCT t.merchant_key) FROM transactions t JOIN categories c ON c.id = t.category_id
        WHERE c.key = 'unsorted' AND t.kind = 'normal' AND t.merchant_key LIKE 'p:%'""") or 0
    if persons and persons < n:
        what = "winkels of personen"
    elif persons:
        what = "persoon" if n == 1 else "personen"
    else:
        what = "winkel" if n == 1 else "winkels"
    return [make("unsorted", f"unsorted:{p.id}", "info", "🗂️", f"{n} {what} zonder bakje", "sort", {},
                 bonus=min(n, 10))]


def stale(lg: Ledger, p: Period, ov: dict) -> list[dict]:
    """Only imported data counts; an import in the last 10 days means the account was quiet."""
    if not ov["period"]["is_current"] or lg.last_imported is None:
        return []
    days = (lg.today - lg.last_imported).days
    if days <= 10:
        return []
    if lg.last_import_at is not None and (lg.today - lg.last_import_at).days <= 10:
        return []
    return [make("stale", f"stale:{lg.last_imported.isoformat()}", "warn", "⏳",
                 f"Laatste import {days} dagen geleden", "import", {})]


def fixed_share(lg: Ledger, p: Period, ov: dict) -> list[dict]:
    if ov["period"]["is_current"]:
        plist = lg.complete_before(p, 3)
        if len(plist) < 2:
            return []
    else:
        if p.id not in _complete_ids(lg):
            return []
        plist = [p]
    income = sum(lg.flows_for(q).income for q in plist)
    fixed = sum(lg.flows_for(q).fixed for q in plist)
    if income <= 0 or fixed <= 0:
        return []
    share = fixed / income
    warn = share > 0.6
    return [make("fixed_share", f"fixed_share:{p.id}", "warn" if warn else "info", "🏠",
                 f"Je vaste lasten zijn {percent(share)} van je inkomen",
                 "recurring", {}, fixed // len(plist), bonus=0 if warn else -25)]


def last_year(lg: Ledger, p: Period, ov: dict) -> list[dict]:
    before = lg.shift(p, -12)
    if before.id not in _complete_ids(lg):
        return []
    days = len(ov["pace"]["actual"]) if ov.get("pace") and ov["period"]["is_current"] else p.days_total
    if days < 7:
        return []
    now = sum(lg.flows_for(p).daily_by_day[:days])
    then = sum(lg.flows_for(before).daily_by_day[:days])
    diff = now - then
    if then <= 0 or abs(diff) < 5000 or abs(diff) < 0.1 * then:
        return []
    word = "meer" if diff > 0 else "minder"
    text = f"{euro(diff)} {word} aan dagelijkse uitgaven dan in {period_month(before.id)} vorig jaar"
    if ov["period"]["is_current"]:
        text = "Tot nu toe " + text
    return [make("last_year", f"last_year:{p.id}", "info", "🗓️", text,
                 "trends", {}, abs(diff))]


def goal_news(conn: sqlite3.Connection, lg: Ledger, p: Period, ov: dict) -> list[dict]:
    if not ov["period"]["is_current"]:
        return []
    out = []
    recent = (lg.today - timedelta(days=60)).isoformat()
    for g in goals_mod.overview(conn)["goals"]:
        emoji = g["emoji"] or "🎯"
        if g["status"] == "overdue":
            rest = max(0, (g["target_cents"] or 0) - g["saldo_cents"])
            out.append(make("goal_behind", f"goal_behind:{g['id']}:{g['target_date']}", "info", emoji,
                            f"De datum van {g['name']} is voorbij; nog {euro(rest)} te gaan",
                            "goal", {"id": g["id"]}, rest))
        elif g["status"] == "behind":
            out.append(make("goal_behind", f"goal_behind:{g['id']}:{p.id}", "warn", emoji,
                            f"{g['name']} loopt achter. Met {euro(g['catch_up_cents'] or 0)} per maand haal je het nog",
                            "goal", {"id": g["id"]}, g["catch_up_cents"]))
        elif g["status"] == "reached" and g["entries"] and g["entries"][0]["date"] >= recent:
            out.append(make("goal_reached", f"goal_reached:{g['id']}", "good", emoji,
                            f"{g['name']} is gehaald", "goal", {"id": g["id"]}, g["saldo_cents"]))
    return out[:2]


FX_WORDS = re.compile(r"\b(wisselkoers\w*|koers\w*|valutakosten|valuta\w*|buitenlandkosten|"
                      r"currency|exchange rate)\b", re.I)
FX_FEE_AMOUNT = re.compile(r"\b(?:wisselkoerskosten|koersopslag|valutakosten|opslag|kosten|fee)\b"
                           r"[:\s]*(?:eur|€)?\s*(\d{1,4}[.,]\d{2})\b", re.I)


def fx_cost(r: dict) -> int:
    """Currency-conversion cost identifiable in one transaction (cents, positive), else 0.
    Only explicit evidence counts: a bank-fee row that mentions the exchange rate, or a card
    payment whose text names the rate AND a separate cost amount. A plain card payment abroad
    in euro (ASN: country suffix like FRFRANKRIJK) carries no conversion cost and is ignored."""
    text = r.get("description") or ""
    if r["amount_cents"] >= 0 or not FX_WORDS.search(text):
        return 0
    if r["method"] == "fee":
        return -r["amount_cents"]
    m = FX_FEE_AMOUNT.search(text)
    if r["method"] == "card" and m:
        cents = int(m.group(1).replace(",", "").replace(".", ""))
        return cents if 0 < cents < -r["amount_cents"] else 0
    return 0


def _this_year(lg: Ledger) -> tuple[str, str, str]:
    year = str(lg.today.year)
    return year, f"{year}-01-01", lg.today.isoformat()


def bank_fees(lg: Ledger, p: Period, ov: dict) -> list[dict]:
    if not ov["period"]["is_current"]:
        return []
    year, lo, hi = _this_year(lg)
    total = -sum(r["amount_cents"] for r in lg.rows
                 if r["method"] == "fee" and lo <= r["date"] <= hi and r["account_type"] == "checking")
    if total < 1000:
        return []
    return [make("bank_fees", f"bank_fees:{year}", "info", "🏦", f"Dit jaar {euro(total)} aan bankkosten",
                 "transactions", {"method": "fee", "from": lo}, total)]


def fx_costs(lg: Ledger, p: Period, ov: dict) -> list[dict]:
    if not ov["period"]["is_current"]:
        return []
    year, lo, hi = _this_year(lg)
    total = sum(fx_cost(r) for r in lg.rows if lo <= r["date"] <= hi and r["account_type"] == "checking")
    if total < 100:
        return []
    return [make("fx_costs", f"fx_costs:{year}", "info", "💱", f"Dit jaar {euro(total)} aan wisselkoerskosten",
                 "transactions", {"q": "koers", "from": lo}, total)]


# ---------------------------------------------------------------------------- preferences

KIND_LABELS = {
    "pace": "Dagelijkse uitgaven tot nu toe",
    "category_spike": "Meer dan normaal in een bakje",
    "price_change": "Prijsstijgingen",
    "new_recurring": "Nieuwe vaste lasten",
    "ended_recurring": "Gestopte vaste lasten",
    "duplicate": "Dubbele afschrijvingen",
    "large": "Grote eenmalige uitgaven",
    "savings_rate": "Hoeveel je spaart",
    "buffer": "Buffer",
    "tempo": "Meer uit dan erin",
    "left_over": "Geld over",
    "unsorted": "Nog te sorteren",
    "yearly_bill": "Jaarlijkse rekeningen",
    "goal_behind": "Potjes die achterlopen",
    "goal_reached": "Gehaalde potjes",
    "stale": "Importherinnering",
    "fixed_share": "Aandeel vaste lasten",
    "last_year": "Vergelijking met vorig jaar",
    "bank_fees": "Bankkosten",
    "fx_costs": "Wisselkoerskosten",
}
DISMISSED_MAX = 500
DISMISSED_KEY = "_dismissed_insights"   # private: up to 500 ids, kept out of GET /settings


def kinds_json() -> list[dict]:
    return [{"kind": k, "label": v} for k, v in KIND_LABELS.items()]


def dismiss(conn: sqlite3.Connection, ident: str) -> None:
    ids = [i for i in (db.get_setting(conn, DISMISSED_KEY, []) or []) if i != ident]
    ids.append(ident)
    db.set_setting(conn, DISMISSED_KEY, ids[-DISMISSED_MAX:])


def mute(conn: sqlite3.Connection, kind: str, muted: bool) -> list[str]:
    kinds = [k for k in (db.get_setting(conn, "muted_insight_kinds", []) or []) if k != kind]
    if muted:
        kinds.append(kind)
    db.set_setting(conn, "muted_insight_kinds", kinds)
    return kinds


# ---------------------------------------------------------------------------- all

def candidates(conn: sqlite3.Connection, lg: Ledger, p: Period, ov: dict) -> list[dict]:
    """Every insight that applies and is not dismissed or muted, best first (with its
    internal `_score`)."""
    if lg.first is None:
        return []
    items = recurring.items(conn)
    by_tx = recurring.by_transaction(conn)
    found: list[dict] = []
    found += stale(lg, p, ov)
    found += duplicates(lg, p, ov)
    found += recurring_news(lg, p, ov, items)
    found += category_spike(lg, p, ov, by_tx)
    found += large(lg, p, ov, by_tx)
    found += left_over(lg, p, ov)
    found += pace(lg, p, ov)
    found += tempo(ov)
    found += goal_news(conn, lg, p, ov)
    found += buffer(conn, lg, p, ov)
    found += unsorted(conn, p, ov)
    found += fixed_share(lg, p, ov)
    found += last_year(lg, p, ov)
    found += savings_rate(lg, p, ov)
    found += bank_fees(lg, p, ov)
    found += fx_costs(lg, p, ov)
    dismissed = set(db.get_setting(conn, DISMISSED_KEY, []) or [])
    muted = set(db.get_setting(conn, "muted_insight_kinds", []) or [])
    found = [i for i in found if i["id"] not in dismissed and i["kind"] not in muted]
    found.sort(key=lambda i: -i["_score"])
    return found


def compute(conn: sqlite3.Connection, lg: Ledger, p: Period, ov: dict,
            overview: bool = False) -> list[dict]:
    """At most five insights for period `p`; for the Overzicht (`overview`) only the
    actionable kinds."""
    out = []
    found = [i for i in candidates(conn, lg, p, ov)
             if not (overview and i["kind"] in OVERZICHT_HIDDEN)]
    for item in found[:MAX_INSIGHTS]:
        item = dict(item)
        item.pop("_score")
        out.append(item)
    return out
