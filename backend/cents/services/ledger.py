"""The cash-flow ledger: every transaction that counts for income, spending or saving, put in
its group once per database state, with per-period totals. Shared by summary, insights, goals
and net worth.

Rules (SPEC 4.1 and 7):
- Cash flow = checking accounts + manual credit-card purchases. Interest on a savings or
  investment account counts as income (nothing else on those accounts counts).
- `income` group: income. `fixed`/`daily`: spending, a positive amount is a refund.
  `unsorted`: money out is daily spending, money in is income. `saving`: money out of checking
  is saved, money back in is withdrawn. `internal` never counts.
- Credit card: a settlement is explained by the manual purchases outstanding before it; only
  the unexplained rest counts as daily spending in bakje `creditcard`. Payments to the card
  company without a credit-card account are fully unexplained.
- Mortgage (services/mortgage.py): the linked payment of the lender is split. The interest part
  stays a fixed cost in its bakje; the repaid part (`row["repaid"]`) counts as saved
  ("Afgelost", `Flows.repaid`), so the result improves while cash projections keep the full
  payment. Linked debts (services/assets.py) are split the same way; `repaid` sums both.

All totals in `Flows` are positive magnitudes: `fixed` = money spent on fixed costs, `saved` =
money put aside (negative when more was withdrawn than saved).
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field
from datetime import date, timedelta

from .. import db
from . import cache, periods
from .periods import Period

INCOME, FIXED, DAILY, SAVING = "income", "fixed", "daily", "saving"
SPENDING = (FIXED, DAILY)


@dataclass
class Flows:
    period: Period
    income: int = 0
    fixed: int = 0
    daily: int = 0
    saved: int = 0
    repaid: int = 0                                            # part of `saved`: mortgage + debt repaid
    spent: dict[int, int] = field(default_factory=dict)        # fixed + daily, per bakje
    counts: dict[int, int] = field(default_factory=dict)       # transactions per bakje
    income_by_cat: dict[int, int] = field(default_factory=dict)
    saved_by_cat: dict[int, int] = field(default_factory=dict)
    daily_by_day: list[int] = field(default_factory=list)
    rows: list[dict] = field(default_factory=list)

    @property
    def net(self) -> int:
        return self.income - self.fixed - self.daily - self.saved

    def daily_cumulative(self, days: int | None = None) -> list[int]:
        out, total = [], 0
        for value in self.daily_by_day[:days if days is not None else len(self.daily_by_day)]:
            total += value
            out.append(total)
        return out


@dataclass
class Ledger:
    start_day: int
    today: date
    data_today: date
    first: date | None
    last: date | None
    categories: dict[int, dict]
    cat_ids: dict[str, int]
    rows: list[dict]
    flows: dict[str, Flows]
    credit: dict[int, dict]          # credit account id -> {outstanding, events, last_unexplained}
    unsorted_cat: int
    last_imported: date | None = None     # latest imported transaction date (not in the future)
    last_import_at: date | None = None    # day of the latest import
    early_income: dict[int, str] = field(default_factory=dict)  # tx id -> period it counts in

    # -- periods -----------------------------------------------------------------------
    def period(self, period_id: str) -> Period:
        return periods.period_by_id(period_id, self.start_day)

    def period_of(self, day: date) -> Period:
        return periods.period_for(day, self.start_day)

    def current(self) -> Period:
        return periods.period_for(self.today, self.start_day)

    def shift(self, p: Period, n: int) -> Period:
        return periods.shift(p, n, self.start_day)

    def flows_for(self, p: Period) -> Flows:
        found = self.flows.get(p.id)
        if found is not None:
            return found
        return Flows(p, daily_by_day=[0] * p.days_total)

    def first_complete(self) -> Period | None:
        """The first period fully covered by data (a quiet first week is allowed)."""
        if self.first is None:
            return None
        p = self.period_of(self.first)
        if self.first > p.start + timedelta(days=6):
            p = self.shift(p, 1)
        return p

    def complete_before(self, p: Period, n: int) -> list[Period]:
        """Up to n complete periods before `p` (most recent first), never the current period
        or later. Periods without any cash-flow transaction are gaps in the imports, not quiet
        months, and are skipped."""
        fc = self.first_complete()
        if fc is None:
            return []
        current = self.current()
        out = []
        q = self.shift(p, -1)
        while len(out) < n and q.start >= fc.start:
            if q.start < current.start and q.id in self.flows:
                out.append(q)
            q = self.shift(q, -1)
        return out

    def category(self, category_id: int | None) -> dict:
        return self.categories.get(category_id or -1) or self.categories[self.unsorted_cat]


# ---------------------------------------------------------------------------- building

_SELECT = """
    SELECT t.id, COALESCE(t.book_date, t.date) AS date, t.amount_cents, t.category_id, t.merchant_key, t.merchant_name,
           t.method, t.kind, t.account_id, t.transfer_account_id, t.manual, t.description,
           a.type AS account_type, c.key AS category_key, c.grp AS grp
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE a.hidden = 0 AND (a.type = 'checking' OR (a.type = 'credit' AND t.manual = 1)
       OR (a.type IN ('savings', 'investment') AND t.method = 'interest'))
    ORDER BY COALESCE(t.book_date, t.date), t.id
"""


def _credit_card(rows: list[dict], credit_ids: set[int]) -> tuple[dict[int, int], dict[int, dict]]:
    """Unexplained part per settlement transaction id, and the state per credit account."""
    events: dict[int, list[tuple[str, int, dict]]] = {a: [] for a in credit_ids}
    for r in rows:
        if r["account_type"] == "credit":
            events[r["account_id"]].append((r["date"], 0, r))
        elif r["category_key"] == "creditcard" and r["transfer_account_id"] in credit_ids:
            events[r["transfer_account_id"]].append((r["date"], 1, r))
    unexplained: dict[int, int] = {}
    state: dict[int, dict] = {}
    for account_id, evs in events.items():
        outstanding, history, last_unexplained = 0, [], None
        for day, is_settlement, r in sorted(evs, key=lambda e: (e[0], e[1], e[2]["id"])):
            if not is_settlement:
                outstanding += -r["amount_cents"]
            else:
                pay = -r["amount_cents"]
                explained = min(pay, max(0, outstanding)) if pay > 0 else 0
                outstanding -= explained
                unexplained[r["id"]] = pay - explained
                last_unexplained = pay - explained
            history.append((day, outstanding))
        state[account_id] = {"outstanding": outstanding, "events": history,
                             "last_unexplained": last_unexplained}
    return unexplained, state


def bucket(r: dict, cat_ids: dict[str, int], unexplained: dict[int, int],
           unsorted_cat: int) -> tuple[str, int, int] | None:
    """(group, bakje id, value) for one ledger row, or None when it does not count.
    value: income -> amount in; fixed/daily -> amount spent; saving -> amount saved."""
    amount = r["amount_cents"]
    key, grp = r["category_key"], r["grp"]
    cat = r["category_id"] if key else unsorted_cat
    if r["account_type"] in ("savings", "investment"):         # interest only
        if amount <= 0:
            return None
        return INCOME, (cat if grp == INCOME else cat_ids.get("inkomen-overig", cat)), amount
    if key == "creditcard":
        return DAILY, cat, unexplained.get(r["id"], -amount)
    if key is None or key == "unsorted":
        return (INCOME, cat, amount) if amount > 0 else (DAILY, cat, -amount)
    if grp == INCOME:
        return INCOME, cat, amount
    if grp in SPENDING:
        return grp, cat, -amount
    if grp == SAVING:
        return SAVING, cat, -amount
    return None


EARLY_DAYS = 3


def _early_income(rows: list[dict], pid_by_date: dict[str, Period], sd: int) -> set[int]:
    """Income that usually arrives in the first week of a period but this time came up to
    three days before it (a salary paid early because of a weekend) counts in the period it is
    meant for. Only for series of three or more payments of one payer."""
    series: dict[str, list[dict]] = {}
    for r in rows:
        b = r["bucket"]
        if b and b[0] == INCOME and r["grp"] == INCOME and r["amount_cents"] > 0 and r["merchant_key"]:
            series.setdefault(r["merchant_key"], []).append(r)
    early: set[int] = set()
    for txs in series.values():
        if len(txs) < 3:
            continue
        offsets = [(date.fromisoformat(t["date"]) - pid_by_date[t["date"]].start).days for t in txs]
        if sum(o <= 6 for o in offsets) < 0.6 * len(txs):
            continue
        for t in txs:
            p = pid_by_date[t["date"]]
            if (p.end - date.fromisoformat(t["date"])).days <= EARLY_DAYS:
                early.add(t["id"])
    return early


def build(conn: sqlite3.Connection) -> Ledger:
    sd = periods.start_day_of(conn)
    today = periods.today()
    first, last = periods.data_range(conn)
    data_today = periods.data_today(conn, today)
    categories = {r["id"]: r for r in db.rows(conn, "SELECT id, key, name, emoji, color, grp FROM categories")}
    cat_ids = {c["key"]: cid for cid, c in categories.items()}
    unsorted_cat = cat_ids["unsorted"]
    rows = db.rows(conn, _SELECT)
    credit_ids = {r["id"] for r in db.rows(conn, "SELECT id FROM accounts WHERE type = 'credit'")}
    unexplained, credit = _credit_card(rows, credit_ids)

    pid_by_date: dict[str, Period] = {}
    for r in rows:
        p = pid_by_date.get(r["date"])
        if p is None:
            p = pid_by_date[r["date"]] = periods.period_for(date.fromisoformat(r["date"]), sd)
        r["period"] = p.id
        r["bucket"] = bucket(r, cat_ids, unexplained, unsorted_cat)
    early = _early_income(rows, pid_by_date, sd)
    from . import assets, mortgage               # local import: both read ledger rows
    splits = assets.split_configs(conn)           # linked debts (SPEC 7.3)
    m_split = mortgage.split_config(conn)
    if m_split:
        splits[m_split[0]] = m_split[1]           # the mortgage wins a shared merchant
    if splits:
        for r in rows:
            b = r["bucket"]
            share = splits.get(r["merchant_key"])
            if (share and b and b[0] == FIXED and b[2] > 0 and r["account_type"] == "checking"):
                repaid = int(round(b[2] * share))
                if repaid:
                    r["repaid"] = repaid
                    r["bucket"] = (FIXED, b[1], b[2] - repaid)

    flows: dict[str, Flows] = {}
    for r in rows:
        b = r["bucket"]
        if b is None:
            continue
        p = pid_by_date[r["date"]]
        if r["id"] in early:
            p = periods.shift(p, 1, sd)
            r["period"] = p.id
        f = flows.get(p.id)
        if f is None:
            f = flows[p.id] = Flows(p, daily_by_day=[0] * p.days_total)
        grp, cat, value = b
        f.rows.append(r)
        f.counts[cat] = f.counts.get(cat, 0) + 1
        if grp == INCOME:
            f.income += value
            f.income_by_cat[cat] = f.income_by_cat.get(cat, 0) + value
        elif grp == SAVING:
            f.saved += value
            f.saved_by_cat[cat] = f.saved_by_cat.get(cat, 0) + value
        else:
            if grp == FIXED:
                f.fixed += value
            else:
                f.daily += value
                f.daily_by_day[(date.fromisoformat(r["date"]) - p.start).days] += value
            f.spent[cat] = f.spent.get(cat, 0) + value
        if r.get("repaid"):
            f.saved += r["repaid"]
            f.repaid += r["repaid"]
    last_import = db.value(conn, "SELECT MAX(imported_at) FROM imports")
    return Ledger(sd, today, data_today, first, last, categories, cat_ids, rows, flows, credit,
                  unsorted_cat, periods.last_imported(conn, today),
                  date.fromisoformat(last_import[:10]) if last_import else None,
                  {r["id"]: r["period"] for r in rows if r["id"] in early})


def get(conn: sqlite3.Connection) -> Ledger:
    return cache.memo(conn, "ledger", lambda: build(conn))
