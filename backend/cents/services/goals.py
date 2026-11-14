"""Savings goals ("potjes", SPEC 9 "Goals").

A goal's saldo is the sum of its entries. Entries come from savings transfers matched to the
goal (kind `auto`), transfers assigned by hand (`manual`, with transaction_id), manual top-ups
(`manual`) and "saldo aanpassen" (`adjust`, the delta).

Invariant kept by the `after_write` hook: when `transactions.goal_id` is set there is an entry
(transaction, goal); when it is cleared, the transaction's entries are removed. So
`PATCH /transactions/{id} {goal_id}` creates, moves or removes the entry without the
transactions route knowing about goals.

Goal amounts are seen from the pot: money from checking to savings is positive.
"""

from __future__ import annotations

import calendar
import json
import math
import re
import secrets
import sqlite3
from datetime import date, timedelta

from .. import db
from ..classify.library import norm_text
from ..hooks import on_after_import, on_after_write
from . import cache, ledger as ledger_mod, networth, recurring
from .text import euro

ENTRY_KINDS = ("auto", "manual", "adjust")
UNASSIGNED_DAYS = 90
UNASSIGNED_MAX = 50
MIRROR_DAYS = 3
REF_TAIL = re.compile(r"\s*Referentie:.*$", re.I | re.S)


# ---------------------------------------------------------------------------- helpers

def new_code(conn: sqlite3.Connection) -> str:
    while True:
        code = str(10000 + secrets.randbelow(90000))
        if not db.value(conn, "SELECT 1 FROM goals WHERE code = ?", (code,)):
            return code


def valid_code(code: str) -> bool:
    return bool(re.fullmatch(r"[1-9]\d{4}", code or ""))


def match_text(tx: dict) -> str:
    """Normalised description without the bank's 'Referentie: ...' tail."""
    text = tx.get("description") or tx.get("raw_description") or ""
    return norm_text(REF_TAIL.sub("", text))


def goal_amount(tx: dict, account_type: str) -> int:
    """A transaction's amount seen from the pot (money into savings is positive)."""
    return tx["amount_cents"] if account_type in ("savings", "investment") else -tx["amount_cents"]


def _keywords(goal: dict) -> list[str]:
    raw = goal.get("keywords")
    try:
        words = json.loads(raw) if isinstance(raw, str) else (raw or [])
    except ValueError:
        words = []
    return [w for w in words if isinstance(w, str) and w.strip()]


def _add_months(day: date, n: int) -> date:
    index = day.year * 12 + day.month - 1 + n
    y, m = index // 12, index % 12 + 1
    return date(y, m, min(day.day, calendar.monthrange(y, m)[1]))


def _add_year(day: date) -> date:
    return _add_months(day, 12)


# ---------------------------------------------------------------------------- savings transfers

_CANDIDATES = """
    SELECT t.id, t.date, t.amount_cents, t.description, t.raw_description, t.goal_id,
           t.account_id, t.transfer_account_id, t.import_id, a.type AS account_type,
           ta.type AS target_type, c.key AS category_key
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    LEFT JOIN accounts ta ON ta.id = t.transfer_account_id
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE a.hidden = 0
      AND ((a.type = 'checking' AND (c.key = 'sparen' OR (t.kind = 'transfer' AND ta.type = 'savings')))
        OR (a.type = 'savings' AND t.kind = 'transfer' AND ta.type = 'checking'))
"""


def savings_transfers(conn: sqlite3.Connection, where: str = "", params: tuple = ()) -> list[dict]:
    """Transfers to/from savings, each money movement once: the checking side when it is
    imported, else the savings side."""
    rows = db.rows(conn, _CANDIDATES + (f" AND ({where})" if where else "") + " ORDER BY t.date, t.id",
                   params)
    savings_side = [r for r in rows if r["account_type"] == "savings"]
    if not savings_side:
        return rows
    # mirrors on the checking accounts (whether or not they are in `rows`)
    mirrors = db.rows(conn, """
        SELECT t.date, t.amount_cents, t.account_id, t.transfer_account_id FROM transactions t
        JOIN accounts a ON a.id = t.account_id
        WHERE a.type = 'checking' AND t.kind = 'transfer' AND t.transfer_account_id IS NOT NULL""")
    index: dict[tuple[int, int, int], list[date]] = {}
    for m in mirrors:
        index.setdefault((m["account_id"], m["transfer_account_id"], m["amount_cents"]), []).append(
            date.fromisoformat(m["date"]))
    out = []
    for r in rows:
        if r["account_type"] == "savings":
            day = date.fromisoformat(r["date"])
            seen = index.get((r["transfer_account_id"], r["account_id"], -r["amount_cents"]), [])
            if any(abs((d - day).days) <= MIRROR_DAYS for d in seen):
                continue
        out.append(r)
    return out


def _active_goals(conn: sqlite3.Connection) -> list[dict]:
    return db.rows(conn, "SELECT * FROM goals WHERE archived = 0 ORDER BY sort, id")


FORGOTTEN_LINKS = "_forgotten_goal_links"


def learned_links(conn: sqlite3.Connection) -> list[dict]:
    """Learned "description -> goal" links: transfers the user assigned to a goal by hand.
    Links the user removed (DELETE /goals/links) are left out."""
    forgotten = {(f["goal_id"], f["description"])
                 for f in (db.get_setting(conn, FORGOTTEN_LINKS, []) or [])}
    links: dict[tuple[int, str], dict] = {}
    for r in db.rows(conn, """
            SELECT e.goal_id, g.name AS goal_name, t.date, t.description, t.raw_description
            FROM goal_entries e
            JOIN transactions t ON t.id = e.transaction_id
            JOIN goals g ON g.id = e.goal_id AND g.archived = 0
            WHERE e.kind = 'manual' ORDER BY t.date, e.id"""):
        text = match_text(r)
        if not text or (r["goal_id"], text) in forgotten:
            continue
        link = links.setdefault((r["goal_id"], text), {"goal_id": r["goal_id"], "goal_name": r["goal_name"],
                                                       "description": text, "count": 0, "last": r["date"]})
        link["count"] += 1
        link["last"] = r["date"]
    return sorted(links.values(), key=lambda l: (l["last"], l["goal_id"]))


def forget_link(conn: sqlite3.Connection, goal_id: int, description: str) -> None:
    text = norm_text(description)
    items = [f for f in (db.get_setting(conn, FORGOTTEN_LINKS, []) or [])
             if (f["goal_id"], f["description"]) != (goal_id, text)]
    items.append({"goal_id": goal_id, "description": text})
    db.set_setting(conn, FORGOTTEN_LINKS, items[-500:])


def _learned(conn: sqlite3.Connection) -> dict[str, int]:
    """normalised description -> goal (the most recent manual assignment wins)."""
    return {l["description"]: l["goal_id"] for l in learned_links(conn)}


def find_goal(tx: dict, goals: list[dict], learned: dict[str, int]) -> int | None:
    """Code > name/keyword (longest wins) > learned description."""
    text = match_text(tx)
    if not text:
        return None
    padded = f" {text} "
    for g in goals:
        if g["code"] and f" {g['code']} " in padded:
            return g["id"]
    best, best_len = None, 0
    for g in goals:
        for word in [g["name"], *_keywords(g)]:
            w = norm_text(word)
            if w and f" {w} " in padded and len(w) > best_len:
                best, best_len = g["id"], len(w)
    if best is not None:
        return best
    return learned.get(text)


def assign(conn: sqlite3.Connection, tx: dict, goal_id: int, kind: str,
            amount: int | None = None) -> int:
    entry_id = db.insert(conn, "goal_entries", {
        "goal_id": goal_id, "date": tx["date"],
        "amount_cents": amount if amount is not None else goal_amount(tx, tx["account_type"]),
        "transaction_id": tx["id"], "kind": kind, "note": None})
    conn.execute("UPDATE transactions SET goal_id = ?, updated_at = ? WHERE id = ? "
                 "AND (goal_id IS NULL OR goal_id != ?)", (goal_id, db.now_iso(), tx["id"], goal_id))
    return entry_id


def match_transfers(conn: sqlite3.Connection, where: str = "", params: tuple = ()) -> int:
    """Match savings transfers without a goal (and without entries). Returns the count."""
    goals = _active_goals(conn)
    if not goals:
        return 0
    learned = _learned(conn)
    cond = ("t.goal_id IS NULL AND NOT EXISTS (SELECT 1 FROM goal_entries e "
            "WHERE e.transaction_id = t.id)")
    n = 0
    for tx in savings_transfers(conn, cond + (f" AND ({where})" if where else ""), params):
        goal_id = find_goal(tx, goals, learned)
        if goal_id is not None:
            assign(conn, tx, goal_id, "auto")
            n += 1
    return n


@on_after_import
def match_imported(conn: sqlite3.Connection, import_ids: list[int]) -> None:
    if import_ids:
        match_transfers(conn, f"t.import_id IN ({db.placeholders(import_ids)})", tuple(import_ids))


@on_after_write
def reconcile(conn: sqlite3.Connection) -> None:
    """Keep goal entries in line with transactions.goal_id (manual assignment via PATCH)."""
    for r in db.rows(conn, """
            SELECT t.id, t.date, t.amount_cents, t.goal_id, a.type AS account_type
            FROM transactions t JOIN accounts a ON a.id = t.account_id
            WHERE t.goal_id IS NOT NULL AND NOT EXISTS (
                SELECT 1 FROM goal_entries e WHERE e.transaction_id = t.id AND e.goal_id = t.goal_id)"""):
        conn.execute("DELETE FROM goal_entries WHERE transaction_id = ?", (r["id"],))
        assign(conn, r, r["goal_id"], "manual")
    conn.execute("""DELETE FROM goal_entries WHERE transaction_id IN (
                        SELECT id FROM transactions WHERE goal_id IS NULL)""")


# ---------------------------------------------------------------------------- roll-over

def roll_over(conn: sqlite3.Connection, today: date) -> bool:
    """Move passed dates of yearly goals one year ahead; a negative saldo restarts at zero
    (a positive one is kept). Returns True when something changed."""
    changed = False
    for g in db.rows(conn, "SELECT * FROM goals WHERE repeat = 'yearly' AND target_date IS NOT NULL "
                           "AND target_date < ?", (today.isoformat(),)):
        target = date.fromisoformat(g["target_date"])
        while target < today:
            target = _add_year(target)
        db.update(conn, "goals", g["id"], {"target_date": target.isoformat()})
        saldo = db.value(conn, "SELECT COALESCE(SUM(amount_cents), 0) FROM goal_entries "
                               "WHERE goal_id = ?", (g["id"],))
        if saldo < 0:
            db.insert(conn, "goal_entries", {"goal_id": g["id"], "date": today.isoformat(),
                                             "amount_cents": -saldo, "transaction_id": None,
                                             "kind": "adjust", "note": "Nieuw jaar"})
        changed = True
    if changed:
        cache.bump(conn)
    return changed


# ---------------------------------------------------------------------------- read model

def entry_json(e: dict) -> dict:
    return {"id": e["id"], "date": e["date"], "amount_cents": e["amount_cents"], "kind": e["kind"],
            "note": e["note"], "transaction_id": e["transaction_id"]}


def months_between(today: date, target: date) -> int:
    return (target.year - today.year) * 12 + (target.month - today.month)


def round_up_5(cents: float) -> int:
    return int(math.ceil(cents / 500) * 500) if cents > 0 else 0


def goal_json(goal: dict, entries: list[dict], lg: ledger_mod.Ledger) -> dict:
    today = lg.today
    saldo = sum(e["amount_cents"] for e in entries)
    target = goal["target_cents"] or 0
    remaining = max(0, target - saldo)
    target_date = date.fromisoformat(goal["target_date"]) if goal["target_date"] else None
    overdue = (target_date is not None and target_date < today and goal["repeat"] != "yearly"
               and not (target > 0 and saldo >= target))
    if overdue:
        months_left, advice = 0, remaining
    else:
        months_left = max(1, months_between(today, target_date)) if target_date else None
        advice = round_up_5(remaining / months_left) if target_date else 0

    # average contribution over the last three complete periods since the goal started
    started_str = min([goal["created_at"][:10]] + [e["date"] for e in entries])
    started = date.fromisoformat(started_str)
    window = [p for p in lg.complete_before(lg.current(), 3) if p.end > started]
    avg = None
    if window:
        lo, hi = window[-1].start.isoformat(), window[0].end.isoformat()
        total = sum(e["amount_cents"] for e in entries
                    if e["kind"] != "adjust" and lo <= e["date"] < hi)
        avg = int(round(total / len(window)))

    if target > 0 and saldo >= target:
        status = "reached"
    elif overdue:
        status = "overdue"
    elif target_date is None:
        status = "no_date"
    elif avg is None or avg >= 0.9 * advice:
        status = "on_track"
    else:
        status = "behind"

    projected = None
    if remaining > 0 and avg and avg > 0:
        projected = _add_months(today, math.ceil(remaining / avg)).isoformat()
    entries_sorted = sorted(entries, key=lambda e: (e["date"], e["id"]), reverse=True)
    return {
        "id": goal["id"], "name": goal["name"], "emoji": goal["emoji"], "color": goal["color"],
        "target_cents": goal["target_cents"], "target_date": goal["target_date"],
        "repeat": goal["repeat"], "code": goal["code"], "keywords": _keywords(goal),
        "saldo_cents": saldo,
        "progress": round(min(1.0, max(0.0, saldo / target)), 4) if target > 0 else 0.0,
        "monthly_advice_cents": advice if status != "reached" else 0,
        "catch_up_cents": advice if status == "behind" else None,
        "months_left": months_left,
        "projected_date": projected,
        "status": status,
        "avg_contribution_cents": avg or 0,
        "entries": [entry_json(e) for e in entries_sorted[:20]],
        "archived": bool(goal["archived"]), "sort": goal["sort"],
    }


def _entries_by_goal(conn: sqlite3.Connection) -> dict[int, list[dict]]:
    out: dict[int, list[dict]] = {}
    for e in db.rows(conn, "SELECT * FROM goal_entries ORDER BY date, id"):
        out.setdefault(e["goal_id"], []).append(e)
    return out


def one_goal(conn: sqlite3.Connection, goal_id: int) -> dict:
    lg = ledger_mod.get(conn)
    goal = db.row(conn, "SELECT * FROM goals WHERE id = ?", (goal_id,))
    entries = db.rows(conn, "SELECT * FROM goal_entries WHERE goal_id = ? ORDER BY date, id", (goal_id,))
    return goal_json(goal, entries, lg)


def suggestions(conn: sqlite3.Connection, lg: ledger_mod.Ledger, goals: list[dict]) -> list[dict]:
    names = " ".join(norm_text(g["name"]) for g in goals)
    out = []
    history = lg.complete_before(lg.current(), 6)
    if "buffer" not in names.split() and history:
        avg = sum(lg.flows_for(p).fixed + lg.flows_for(p).daily for p in history) / len(history)
        target = int(math.ceil(3 * avg / 10000) * 10000)
        if target > 0:
            out.append({"kind": "buffer", "name": "Buffer", "emoji": "🛟", "target_cents": target,
                        "target_date": None, "reason": "3 maanden uitgaven"})
    yearly = [i for i in recurring.items(conn)
              if i["frequency"] == "yearly" and i["direction"] == "out" and i["status"] != "ended"]
    if yearly and "jaarlijkse" not in names.split() and "jaarlijks" not in names.split():
        total = -sum(i["amount_cents"] for i in yearly)
        if total > 0:
            out.append({"kind": "yearly_bills", "name": "Jaarlijkse rekeningen", "emoji": "📅",
                        "target_cents": total, "target_date": None,
                        "reason": f"{euro(total / 12)} per maand"})
    return out


def overview(conn: sqlite3.Connection) -> dict:
    """GET /goals."""
    lg = ledger_mod.get(conn)
    roll_over(conn, lg.today)

    def compute() -> dict:
        all_goals = db.rows(conn, "SELECT * FROM goals ORDER BY sort, id")
        entries = _entries_by_goal(conn)
        items = [goal_json(g, entries.get(g["id"], []), lg) for g in all_goals]
        active = [g for g in items if not g["archived"]]
        since = (lg.today - timedelta(days=UNASSIGNED_DAYS)).isoformat()
        unassigned = savings_transfers(conn, "t.date >= ? AND NOT EXISTS (SELECT 1 FROM goal_entries e "
                                             "WHERE e.transaction_id = t.id)", (since,))
        unassigned = sorted(unassigned, key=lambda r: (r["date"], r["id"]), reverse=True)[:UNASSIGNED_MAX]
        total_advice = sum(g["monthly_advice_cents"] for g in active)
        history = lg.complete_before(lg.current(), 3)
        room = None
        if history:
            over = sum(lg.flows_for(p).income - lg.flows_for(p).fixed - lg.flows_for(p).daily
                       for p in history) / len(history)
            avg_over = int(round(over))
            room = {"avg_over_cents": avg_over, "fits": avg_over >= total_advice,
                    "difference_cents": avg_over - total_advice}
        savings_balance = networth.balance_of_type(conn, "savings")
        in_goals = sum(g["saldo_cents"] for g in active)
        return {
            "goals": active,
            "unassigned": [{"transaction_id": r["id"], "date": r["date"],
                            "amount_cents": goal_amount(r, r["account_type"]),
                            "description": REF_TAIL.sub("", r["description"] or r["raw_description"] or "")}
                           for r in unassigned],
            "total_advice_cents": total_advice,
            "room": room,
            "savings_balance_cents": savings_balance,
            "unallocated_cents": None if savings_balance is None else savings_balance - in_goals,
            "suggestions": suggestions(conn, lg, active),
            "archived_goals": [g for g in items if g["archived"]],
        }
    return cache.memo(conn, "goals", compute)
