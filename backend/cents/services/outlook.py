"""The holistic "now" figures of the Overzicht (SPEC 9 "Nog te besteden, tempo, buffer,
betaalrekening").

- `free` ("Nog te besteden tot <salarisdatum>"): the checking balance(s) − fixed costs still
  due before the next salary (and those of this period that are overdue) − recurring savings
  transfers before payday − outstanding credit-card purchases − the expected next credit-card
  settlement (when it falls before payday) − typical daily spending for the days until payday.
  Not clamped: negative means the money on the checking account does not reach payday at a
  normal pace. Savings are not in it: `free.savings` reports the savings balance minus potjes
  and the buffer ("vrij spaargeld") next to it.
- Balance dates: per account `as_of` = the later of its latest balance and the end of the
  latest import that covered it. The oldest of the checking accounts drives `stale` and the
  start of the window for fixed costs and daily spending; payday is the next salary after the
  main checking account's date, so a salary that is expected but not imported yet
  (`salary_pending`) is still the upcoming payday.
- `tempo`: mean monthly result (income − fixed − daily) over the last three complete periods,
  plus up to twelve complete periods for a mini chart. Saving is not spending and money back
  from savings is not income (the ledger already does that). `None` with < 2 complete periods.
- `buffer`: what the buffer holds (a potje named "buffer", else savings not in potjes, at most
  the target) against the target from the `buffer` assumption.
- `checking_warning`: day-by-day projection of the main checking account until the next
  salary (upcoming fixed costs and savings transfers, other recurring income, typical daily
  spending per day). Only returned when the lowest point drops below the floor.

Assumptions (services/assumptions.py): `payday_day`, `buffer`, `checking_floor_cents`.
"""

from __future__ import annotations

import calendar
import math
import sqlite3
import statistics
from datetime import date, timedelta

from .. import db
from . import assumptions as assumptions_mod
from . import goals as goals_mod
from . import networth, periods, recurring
from .ledger import DAILY, FIXED, INCOME, SAVING, Ledger

STALE_DAYS = 5
TEMPO_MONTHS = 3
CHART_MONTHS = 12
TYPICAL_MONTHS = 6
SETTLEMENTS = 3


def _group(lg: Ledger, item: dict) -> str | None:
    return lg.categories.get(item["category_id"] or -1, {}).get("grp")


def _day_in_month(y: int, m: int, day: int) -> date:
    return date(y, m, min(day, calendar.monthrange(y, m)[1]))


def _next_month(d: date, day: int | None = None) -> date:
    y, m = (d.year + 1, 1) if d.month == 12 else (d.year, d.month + 1)
    return _day_in_month(y, m, day or d.day)


def balance_accounts(conn: sqlite3.Connection) -> list[dict]:
    """Visible checking/savings accounts with a balance; `as_of` = the later of the balance
    date and the latest import of a file for that account (that import's day, at most the
    latest imported transaction of any account): a quiet savings account whose file was
    imported together with a fresh checking file is not stale."""
    out = []
    last = periods.last_imported(conn)
    for a in networth.get(conn)["accounts"]:
        if a["type"] not in ("checking", "savings") or a["balance_cents"] is None or a.get("locked"):
            continue                       # a fixed (vaste) account is not money you can use
        imported = db.value(conn, """
            SELECT MAX(substr(i.imported_at, 1, 10)) FROM imports i WHERE i.account_id = ? OR EXISTS (
                SELECT 1 FROM transactions t WHERE t.import_id = i.id AND t.account_id = ?)""",
                            (a["id"], a["id"]))
        covered = min(imported, last.isoformat()) if imported and last else None
        as_of = max(filter(None, [a["as_of"], covered]), default=None)
        out.append({**a, "as_of": as_of})
    return out


def main_checking(conn: sqlite3.Connection, accounts: list[dict] | None = None) -> dict | None:
    accounts = [a for a in (accounts if accounts is not None else balance_accounts(conn))
                if a["type"] == "checking"]
    if not accounts:
        return None
    counts = {r["account_id"]: r["n"] for r in db.rows(
        conn, "SELECT account_id, COUNT(*) AS n FROM transactions GROUP BY account_id")}
    return max(accounts, key=lambda a: (counts.get(a["id"], 0), a["balance_cents"]))


def salary_item(lg: Ledger, items: list[dict]) -> dict | None:
    income = [i for i in items if i["direction"] == "in" and i["status"] != "ended"
              and not i.get("own_account") and _group(lg, i) == INCOME]
    return max(income, key=lambda i: i["amount_cents"]) if income else None


def _payday_base(conn: sqlite3.Connection, lg: Ledger) -> date:
    """The balance date payday counts from: the main checking account's (the salary lands
    there), else the latest balance date, else today."""
    accounts = balance_accounts(conn)
    chk = main_checking(conn, accounts)
    day = (chk or {}).get("as_of") or max((a["as_of"] for a in accounts if a["as_of"]), default=None)
    return min(lg.today, date.fromisoformat(day)) if day else lg.today


def next_payday(conn: sqlite3.Connection, lg: Ledger, items: list[dict],
                base: date) -> tuple[date, str]:
    """First salary date after `base` and how it was found: `setting`, `salary` or `period`."""
    setting = assumptions_mod.get(conn)["payday_day"]["day"]
    if isinstance(setting, int):
        d = _day_in_month(base.year, base.month, setting)
        return (d if d > base else _next_month(d, setting)), "setting"
    main = salary_item(lg, items)
    if main:
        nxt = recurring.occurrences(main, base + timedelta(days=1), base + timedelta(days=400))
        if nxt:
            return nxt[0], "salary"
    return lg.current().end, "period"


def payday(conn: sqlite3.Connection, lg: Ledger, items: list[dict]) -> tuple[date, str]:
    """Next salary after the balance date (not after today: a salary that is due but not
    imported yet is still the upcoming one)."""
    return next_payday(conn, lg, items, _payday_base(conn, lg))


def _spend_items(lg: Ledger, items: list[dict], start: date, end: date,
                 groups: tuple[str, ...], direction: str = "out") -> list[tuple[dict, date]]:
    """Expected payments from the checking account (card-paid items come in through the card's
    settlement, which is counted separately)."""
    out = []
    for i in items:
        if (i["direction"] == direction and _group(lg, i) in groups and not i.get("via_card")
                and not i.get("own_account")):
            out += [(i, d) for d in recurring.occurrences(i, start, end)]
    return out


def _own_moves(items: list[dict], start: date, end: date) -> list[tuple[dict, date]]:
    """Transfers to and from your own accounts (potjes, terugstorten), both ways: together they
    are "sparen min opnemen", never income or a fixed cost."""
    return [(i, d) for i in items if i.get("own_account") and not i.get("via_card")
            for d in recurring.occurrences(i, start, end)]


def monthly_fixed(lg: Ledger, items: list[dict]) -> float:
    """The one "vaste lasten per maand" (SPEC 9): the live recurring fixed costs per month, as
    on the Vaste lasten screen (the full mortgage payment, no one-off purchases); without any,
    the average of the previous up to six complete periods."""
    live = -sum(i["per_month_cents"] for i in items if i["direction"] == "out"
                and i["status"] != "ended" and _group(lg, i) == FIXED)
    if live > 0:
        return live
    history = lg.complete_before(lg.current(), 6)
    if history:
        return sum(lg.flows_for(p).fixed - lg.flows_for(p).spread_fixed + lg.flows_for(p).repaid
                   for p in history) / len(history)
    return 0.0


def is_buffer(name: str | None) -> bool:
    """A potje whose name contains "buffer" is the buffer."""
    return "buffer" in (name or "").lower()


def assumed_buffer_target(conn: sqlite3.Connection, lg: Ledger, items: list[dict]) -> tuple[int, str]:
    """The buffer from the `buffer` assumption: a fixed amount, else months × average monthly
    fixed costs (with the mortgage repayment, without spread parts). Also the reason in words."""
    setting = assumptions_mod.get(conn)["buffer"]
    if setting.get("amount_cents") is not None:
        return max(0, int(setting["amount_cents"])), "je eigen bedrag"
    months = float(setting.get("months") or 0)
    word = f"{months:g} {'maand' if months == 1 else 'maanden'} vaste lasten".replace(".", ",")
    return max(0, int(round(monthly_fixed(lg, items) * months))), word


def buffer_target(conn: sqlite3.Connection, lg: Ledger, items: list[dict],
                  pots: list[dict] | None = None) -> tuple[int, str]:
    """The one buffer target (SPEC 9): the target of the buffer potje when it has one, else
    the assumption. Returns (cents, source) with source `potje` or `assumption`."""
    pots = pots if pots is not None else [g for g in goals_mod.overview(conn)["goals"] if is_buffer(g["name"])]
    pot_target = sum(g["target_cents"] or 0 for g in pots)
    if pot_target > 0:
        return pot_target, "potje"
    return assumed_buffer_target(conn, lg, items)[0], "assumption"


def buffer_status(conn: sqlite3.Connection, lg: Ledger, items: list[dict]) -> dict | None:
    """The buffer: a potje named "buffer" when there is one, else the savings balance that is
    not in potjes (at most the target). `months` = how many months of fixed costs it covers."""
    savings = sum(a["balance_cents"] for a in balance_accounts(conn) if a["type"] == "savings")
    active = goals_mod.overview(conn)["goals"]
    pots = [g for g in active if is_buffer(g["name"])]
    target, target_source = buffer_target(conn, lg, items, pots)
    if pots:
        saved, source = sum(max(0, g["saldo_cents"]) for g in pots), "potje"
    else:
        free_savings = max(0, savings - sum(max(0, g["saldo_cents"]) for g in active))
        saved, source = (min(free_savings, target) if target else free_savings), "savings"
    if not target and not saved:
        return None
    monthly = monthly_fixed(lg, items)
    return {"saved_cents": int(saved), "target_cents": target, "source": source,
            "target_source": target_source, "goal_id": pots[0]["id"] if pots else None,
            "monthly_fixed_cents": int(round(monthly)),
            "months": round(saved / monthly, 1) if monthly > 0 else None,
            "target_months": round(target / monthly, 1) if monthly > 0 else None}


def _card_lump(r: dict) -> int:
    """The part of a ledger row that is a credit-card settlement counted as daily spending."""
    b = r["bucket"]
    return b[2] if b and b[0] == DAILY and r["category_key"] == "creditcard" else 0


def daily_rate(lg: Ledger) -> float:
    """Typical daily spending per day (cents): the median of the per-day rate of the last six
    complete periods, without credit-card settlement lumps (estimated separately)."""
    rates = []
    for p in lg.complete_before(lg.current(), TYPICAL_MONTHS):
        f = lg.flows_for(p)
        rates.append((f.daily - f.spread_daily - sum(_card_lump(r) for r in f.rows)) / p.days_total)
    return float(statistics.median(rates)) if rates else 0.0


def expected_settlement(lg: Ledger, after: date, before: date) -> dict | None:
    """The next credit-card settlement, estimated as the median unexplained part of the last
    three, on the same day one month after the latest; only when it falls in (after, before)."""
    rows = sorted((r for r in lg.rows if _card_lump(r) and r["amount_cents"] < 0),
                  key=lambda r: r["date"])
    if not rows:
        return None
    cents = int(round(statistics.median([_card_lump(r) for r in rows[-SETTLEMENTS:]])))
    last = date.fromisoformat(rows[-1]["date"])
    day = _next_month(last)
    while day <= after:
        day = _next_month(day, last.day)
    if cents <= 0 or day >= before:
        return None
    return {"date": day.isoformat(), "cents": cents}


OVERDUE_GRACE = 10     # a payment to the same merchant this close before the expected day counts


def _overdue_fixed(lg: Ledger, items: list[dict], start: date) -> list[dict]:
    """Fixed costs of this period that were expected before the balance date but have not been
    paid (not ended): they may still come, so Nog te besteden keeps them aside. Any payment to
    that merchant from a little before the expected day on (another amount, another account)
    counts as paid."""
    lo = lg.current().start
    out = []
    for i in items:
        if i["direction"] != "out" or i["status"] == "ended" or _group(lg, i) != FIXED or i.get("via_card"):
            continue
        day = date.fromisoformat(i["next_date"])
        if not lo <= day < start:
            continue
        # paid: a payment to that merchant of about this amount, shortly before the expected day
        # (at most half the rhythm, so last week's payment does not count for a weekly cost)
        grace = min(OVERDUE_GRACE, recurring.FREQUENCIES[i["frequency"]][0] // 2)
        since = (day - timedelta(days=grace)).isoformat()
        typical = abs(i["amount_cents"])
        if any(r["merchant_key"] == i["merchant_key"] and r["amount_cents"] < 0 and r["date"] >= since
               and abs(-r["amount_cents"] - typical) <= max(0.3 * typical, 500) for r in lg.rows):
            continue
        out.append({"name": i["name"], "date": day.isoformat(), "cents": -i["amount_cents"]})
    return sorted(out, key=lambda x: x["date"])


def free(conn: sqlite3.Connection, lg: Ledger, items: list[dict], buf: dict | None) -> dict | None:
    """Nog te besteden (SPEC 9): the money on the checking account(s) that is not needed for
    what is still due before payday at a normal pace. Savings are reported next to it
    (`savings`: the balance minus potjes and the buffer = vrij spaargeld), never in it."""
    accounts = balance_accounts(conn)
    checking = [a for a in accounts if a["type"] == "checking"]
    saving_accounts = [a for a in accounts if a["type"] == "savings"]
    if not checking:
        return None
    balances = sum(a["balance_cents"] for a in checking)
    savings = sum(a["balance_cents"] for a in saving_accounts)
    as_of = min((a["as_of"] for a in checking if a["as_of"]), default=None)
    credit = sum(a.get("outstanding_cents") or 0 for a in networth.get(conn)["accounts"]
                 if a["type"] == "credit")

    pay, source = payday(conn, lg, items)
    start = (date.fromisoformat(as_of) + timedelta(days=1)) if as_of else lg.today
    fixed = -sum(i["amount_cents"] for i, _ in _spend_items(lg, items, start, pay, (FIXED,)))
    overdue = _overdue_fixed(lg, items, start)
    overdue_cents = sum(x["cents"] for x in overdue)
    # sparen min opnemen: what goes to savings before payday, minus what comes back (a weekly
    # transfer back from a boodschappen potje); may be negative
    to_savings = -sum(i["amount_cents"] for i, _ in _spend_items(lg, items, start, pay, (SAVING,))
                      + _own_moves(items, start, pay))
    # other money that comes in every month before payday (toeslagen, kinderbijslag)
    incoming = [{"name": i["name"], "date": d.isoformat(), "cents": i["amount_cents"]}
                for i, d in _spend_items(lg, items, start, pay, (INCOME,), direction="in")]
    income_cents = sum(x["cents"] for x in incoming)
    card = expected_settlement(lg, start - timedelta(days=1), pay)
    rate = daily_rate(lg)
    days = max(0, (pay - start).days)
    daily = int(round(rate * days))
    total = (balances + income_cents - fixed - overdue_cents - to_savings - credit
             - (card["cents"] if card else 0) - daily)
    days_left = (pay - lg.today).days

    # savings: potjes live on the savings account(s), never more than is there; savings that
    # already form the buffer are set aside too (never the unfilled part of the target)
    active = goals_mod.overview(conn)["goals"]
    in_goals = sum(max(0, g["saldo_cents"]) for g in active)
    goals_cents = min(in_goals, max(0, savings)) if savings > 0 else 0
    reserved = 0
    if buf and buf["source"] == "savings":
        reserved = min(buf["saved_cents"], buf["target_cents"] or 0, max(0, savings - goals_cents))
    stale_of = lambda d: bool(d) and (lg.today - date.fromisoformat(d)).days > STALE_DAYS  # noqa: E731
    acc_json = lambda a: {"name": a["name"], "type": a["type"], "balance_cents": a["balance_cents"],  # noqa: E731
                          "as_of": a["as_of"], "stale": stale_of(a["as_of"])}
    savings_out = None
    if saving_accounts:
        savings_out = {"balance_cents": savings, "goals_cents": goals_cents,
                       "buffer_cents": reserved, "free_cents": max(0, savings - goals_cents - reserved),
                       "accounts": [acc_json(a) for a in saving_accounts]}
    return {"total_cents": total, "balances_cents": balances,
            "fixed_until_payday_cents": fixed, "fixed_overdue_cents": overdue_cents,
            "fixed_overdue": overdue, "saving_until_payday_cents": to_savings,
            "income_until_payday_cents": income_cents, "income_until_payday": incoming,
            "credit_cents": credit, "card_settlement": card,
            "daily_until_payday_cents": daily,
            "daily_rate_cents": int(round(rate)), "daily_days": days,
            "start": start.isoformat(),
            "days_left": max(0, days_left),
            # what is left on top of normal daily spending, per day …
            "per_day_cents": int(total / days_left) if days_left > 0 else None,
            # … and the whole day budget for daily spending (normal pace + that extra)
            "day_budget_cents": max(0, int(round(rate + total / days_left))) if days_left > 0 else None,
            "payday": pay.isoformat(), "payday_source": source,
            "salary_pending": pay <= lg.today,
            "as_of": as_of, "stale": stale_of(as_of),
            "accounts": [acc_json(a) for a in checking],
            "savings": savings_out}


def result(lg: Ledger, p) -> int:
    """A period's result, the one definition of "over / tekort": income − fixed − daily.
    Saving is not spending, money back from savings is not income."""
    f = lg.flows_for(p)
    return f.income - f.fixed - f.daily


_net = result


def tempo(lg: Ledger) -> dict | None:
    complete = lg.complete_before(lg.current(), CHART_MONTHS)   # most recent first
    if len(complete) < 2:
        return None
    recent = complete[:TEMPO_MONTHS]
    avg = int(round(sum(_net(lg, p) for p in recent) / len(recent)))
    since = recent[-1]
    if avg < 0:      # the start of the run of short months, if it is longer
        run = []
        for p in complete:
            if _net(lg, p) >= 0:
                break
            run.append(p)
        if len(run) > len(recent):
            since = run[-1]
    return {"avg_net_cents": avg, "periods": len(recent), "since": since.id,
            "months": [{"period": p.id, "net_cents": _net(lg, p)} for p in reversed(complete)]}


def checking_warning(conn: sqlite3.Connection, lg: Ledger, items: list[dict], pay: date,
                     f: dict | None = None) -> dict | None:
    """Day-by-day projection of the main checking account until the day before payday, with the
    same items as Nog te besteden (`f`): fixed costs (and overdue ones, on the first day),
    savings transfers and other income on their dates, the credit card (outstanding purchases
    and the expected settlement, on the settlement day or else the last day) and the typical
    daily rate. With one checking account its last day equals Nog te besteden."""
    acc = main_checking(conn)
    if acc is None or len(lg.complete_before(lg.current(), 6)) < 1:
        return None
    floor = assumptions_mod.get(conn)["checking_floor_cents"]["cents"]
    start = (date.fromisoformat(acc["as_of"]) + timedelta(days=1)) if acc["as_of"] else lg.today
    if pay <= start:
        return None
    due: dict[date, int] = {}
    moves = (_spend_items(lg, items, start, pay, (FIXED, SAVING))
             + _spend_items(lg, items, start, pay, (INCOME,), direction="in")
             + _own_moves(items, start, pay))
    for i, d in moves:
        due[d] = due.get(d, 0) + i["amount_cents"]
    if f:
        due[start] = due.get(start, 0) - f["fixed_overdue_cents"]
        card = f["card_settlement"]
        card_day = date.fromisoformat(card["date"]) if card else pay - timedelta(days=1)
        card_day = min(max(card_day, start), pay - timedelta(days=1))
        due[card_day] = due.get(card_day, 0) - f["credit_cents"] - (card["cents"] if card else 0)
    per_day = daily_rate(lg)
    balance, low, low_day = float(acc["balance_cents"]), None, None
    day = start
    while day < pay:
        balance += due.get(day, 0) - per_day
        if day >= lg.today and (low is None or balance < low):
            low, low_day = balance, day
        day += timedelta(days=1)
    if low is None or low >= floor:
        return None
    low_cents = int(math.floor(low))
    need = floor - low_cents
    suggest = int(math.ceil(need / 5000) * 5000)
    savings = networth.balance_of_type(conn, "savings") or 0
    return {"date": low_day.isoformat(), "low_cents": low_cents, "floor_cents": floor,
            "suggest_cents": suggest if savings >= suggest else None,
            "account_id": acc["id"], "payday": pay.isoformat()}


def compute(conn: sqlite3.Connection, lg: Ledger) -> dict:
    """The figures about now for the current period."""
    items = recurring.items(conn)
    buf = buffer_status(conn, lg, items)
    f = free(conn, lg, items, buf)
    pay = date.fromisoformat(f["payday"]) if f else payday(conn, lg, items)[0]
    from . import checks, health             # local import: health reads networth
    h = health.compute(conn, lg, buf, monthly_fixed(lg, items))
    if h:
        cov = checks.coverage(lg)          # "kunnen we al onze uitgaven verantwoorden?"
        h["accounted"] = cov and {"share": cov["share"], "unknown_cents": cov["unknown_cents"],
                                  "months": cov["months"]}
    return {"free": f, "tempo": tempo(lg), "buffer": buf,
            "checking_warning": checking_warning(conn, lg, items, pay, f), "health": h}
