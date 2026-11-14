"""GET /assumptions: everything the analytics assumed on its own ("Slimme aannames"), so the
user can see and undo it. (Engine thresholds live in services/assumptions.py, core.)"""

from __future__ import annotations

import sqlite3
import statistics
from datetime import date

from .. import db
from . import goals, ledger as ledger_mod, periods, recurring


def _names(conn: sqlite3.Connection, keys: list[str]) -> dict[str, str]:
    out = {}
    for key in keys:
        merchant = key.split("|")[0]
        name = db.value(conn, "SELECT merchant_name FROM transactions WHERE merchant_key = ? "
                              "ORDER BY date DESC LIMIT 1", (merchant,))
        out[key] = name or merchant
    return out


def salary_items(conn: sqlite3.Connection) -> list[dict]:
    lg = ledger_mod.get(conn)
    return [i for i in recurring.items(conn)
            if i["direction"] == "in" and i["status"] != "ended"
            and lg.categories.get(i["category_id"] or -1, {}).get("key") == "salaris"]


def suggested_start_day(conn: sqlite3.Connection) -> int | None:
    """The usual day of the largest monthly salary when it is stable (within 4 days), between
    2 and 28, and differs from the setting."""
    monthly = [i for i in salary_items(conn) if i["frequency"] == "monthly"]
    if not monthly:
        return None
    main = max(monthly, key=lambda i: i["amount_cents"])
    lg = ledger_mod.get(conn)
    days = [date.fromisoformat(r["date"]).day for r in lg.rows
            if r["merchant_key"] == main["merchant_key"] and r["amount_cents"] > 0][-6:]
    if len(days) < 3 or max(days) - min(days) > 4:
        return None
    usual = int(statistics.median(days))
    if not 2 <= usual <= 28 or usual == periods.start_day_of(conn):
        return None
    return usual


def assumptions(conn: sqlite3.Connection) -> dict:
    accounts = []
    for a in db.rows(conn, """SELECT a.id, a.name, a.type,
                                     (SELECT COUNT(*) FROM imports i WHERE i.account_id = a.id) AS imports
                              FROM accounts a ORDER BY a.sort, a.id"""):
        accounts.append({"id": a["id"], "name": a["name"], "type": a["type"],
                         "type_source": "import" if a["imports"] else "user"})
    ignored = [r["key"] for r in db.rows(conn, "SELECT key FROM recurring_ignored ORDER BY key")]
    names = _names(conn, ignored)
    return {
        "salary": [{"merchant_key": i["merchant_key"], "name": i["name"],
                    "amount_cents": i["amount_cents"], "frequency": i["frequency"]}
                   for i in salary_items(conn)],
        "accounts": accounts,
        "recurring_ignored": [{"key": k, "name": names[k]} for k in ignored],
        "recurring_count": sum(1 for i in recurring.items(conn) if i["status"] != "ended"),
        "rules_count": db.value(conn, "SELECT COUNT(*) FROM rules") or 0,
        "goal_links": [{k: link[k] for k in ("goal_id", "goal_name", "description", "count")}
                       for link in goals.learned_links(conn)],
        "month_start_day": periods.start_day_of(conn),
        "suggestion": {"month_start_day": suggested_start_day(conn)},
    }
