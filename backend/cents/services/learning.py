"""Learning from the user: merchant rules, tag rules and the sort queue (SPEC 6, 10)."""

from __future__ import annotations

import sqlite3

from .. import db
from ..classify import engine
from ..classify.library import Library, get_library


def _upsert_rule(conn: sqlite3.Connection, merchant_key: str, **fields: int | None) -> None:
    rule = db.row(conn, "SELECT * FROM rules WHERE merchant_key = ?", (merchant_key,))
    if rule:
        db.update(conn, "rules", rule["id"], fields)
    else:
        db.insert(conn, "rules", {"merchant_key": merchant_key, "category_id": None, "tag_id": None,
                                  "created_at": db.now_iso(), **fields})
    conn.execute("DELETE FROM rules WHERE merchant_key = ? AND category_id IS NULL AND tag_id IS NULL "
                 "AND below_cents IS NULL", (merchant_key,))


def is_intermediary(merchant_key: str | None) -> bool:
    return (merchant_key or "").startswith("via:")


def set_merchant_category(conn: sqlite3.Connection, merchant_key: str, category_id: int,
                          lib: Library | None = None) -> int:
    """Learn "this merchant is this bakje": upsert the rule and apply it to every transaction
    of the merchant that the user did not set individually. Choosing `unsorted` forgets the
    rule instead. Returns the number of transactions of the merchant that were (re)assigned.

    Intermediary keys (`via:`, e.g. Tikkie without a named person) never get a rule: the
    choice applies only to the currently unsorted transactions, as individual choices."""
    if is_intermediary(merchant_key):
        if category_id == db.unsorted_id(conn):
            return 0
        cur = conn.execute(
            "UPDATE transactions SET category_id = ?, category_source = 'user', category_reason = 'user', "
            "updated_at = ? WHERE merchant_key = ? AND category_id = ?",
            (category_id, db.now_iso(), merchant_key, db.unsorted_id(conn)))
        return cur.rowcount
    if category_id == db.unsorted_id(conn):
        _upsert_rule(conn, merchant_key, category_id=None)
        engine.classify_merchant(conn, merchant_key, lib or get_library())
        return int(db.value(conn, "SELECT COUNT(*) FROM transactions WHERE merchant_key = ? "
                                  "AND category_source != 'user'", (merchant_key,)) or 0)
    _upsert_rule(conn, merchant_key, category_id=category_id)
    return _apply_rule(conn, merchant_key, lib)


def _apply_rule(conn: sqlite3.Connection, merchant_key: str, lib: Library | None = None) -> int:
    """Re-run the engine for the merchant (the rule, including an amount threshold, wins over
    everything but individual choices). Returns the merchant's non-user transaction count."""
    engine.classify_merchant(conn, merchant_key, lib or get_library())
    return int(db.value(conn, "SELECT COUNT(*) FROM transactions WHERE merchant_key = ? "
                              "AND category_source != 'user'", (merchant_key,)) or 0)


def main_category(conn: sqlite3.Connection, merchant_key: str, below_cents: int) -> int | None:
    """The merchant's current main bakje: its rule's, else the most common bakje of its larger
    amounts, else of all its transactions (never "unsorted")."""
    rule = db.row(conn, "SELECT category_id FROM rules WHERE merchant_key = ?", (merchant_key,))
    if rule and rule["category_id"]:
        return rule["category_id"]
    unsorted = db.unsorted_id(conn)
    for extra in ("AND ABS(amount_cents) >= ?", ""):
        params = [merchant_key, unsorted] + ([below_cents] if extra else [])
        row = db.row(conn, f"""SELECT category_id, COUNT(*) AS n FROM transactions
                               WHERE merchant_key = ? AND category_id != ? {extra}
                               GROUP BY category_id ORDER BY n DESC, category_id LIMIT 1""", params)
        if row:
            return row["category_id"]
    return None


def set_merchant_below(conn: sqlite3.Connection, merchant_key: str, below_cents: int,
                       below_category_id: int, lib: Library | None = None) -> int:
    """Amounts of this merchant below `below_cents` go to `below_category_id`; larger amounts
    keep the merchant's main bakje (made explicit in the rule)."""
    main = main_category(conn, merchant_key, below_cents)
    _upsert_rule(conn, merchant_key, category_id=main, below_cents=below_cents,
                 below_category_id=below_category_id)
    return _apply_rule(conn, merchant_key, lib)


def update_rule(conn: sqlite3.Connection, rule_id: int, fields: dict) -> dict | None:
    rule = db.row(conn, "SELECT * FROM rules WHERE id = ?", (rule_id,))
    if not rule:
        return None
    db.update(conn, "rules", rule_id, fields)
    _apply_rule(conn, rule["merchant_key"])
    return db.row(conn, "SELECT * FROM rules WHERE id = ?", (rule_id,))


def set_merchant_tag(conn: sqlite3.Connection, merchant_key: str, tag_id: int | None) -> int:
    """Learn "always tag this merchant" (tag_id None forgets it). Returns tagged count."""
    _upsert_rule(conn, merchant_key, tag_id=tag_id)
    if tag_id is None:
        return 0
    cur = conn.execute(
        "INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) "
        "SELECT id, ? FROM transactions WHERE merchant_key = ?", (tag_id, merchant_key))
    return cur.rowcount


def delete_rule(conn: sqlite3.Connection, rule_id: int) -> bool:
    rule = db.row(conn, "SELECT * FROM rules WHERE id = ?", (rule_id,))
    if not rule:
        return False
    conn.execute("DELETE FROM rules WHERE id = ?", (rule_id,))
    engine.classify_merchant(conn, rule["merchant_key"])
    return True


def list_rules(conn: sqlite3.Connection) -> list[dict]:
    return db.rows(conn, """
        SELECT r.id, r.merchant_key, r.category_id, r.tag_id, r.below_cents, r.below_category_id,
               (SELECT t.merchant_name FROM transactions t WHERE t.merchant_key = r.merchant_key
                ORDER BY t.date DESC LIMIT 1) AS merchant_name,
               (SELECT COUNT(*) FROM transactions t WHERE t.merchant_key = r.merchant_key) AS count
        FROM rules r ORDER BY merchant_name COLLATE NOCASE
    """)


# ---------------------------------------------------------------- sort queue

def sort_queue(conn: sqlite3.Connection, lib: Library | None = None, limit: int = 200) -> dict:
    """Merchants with unsorted transactions, largest total first."""
    lib = lib or get_library()
    unsorted = db.unsorted_id(conn)
    groups = db.rows(conn, """
        SELECT merchant_key, COUNT(*) AS count, SUM(ABS(amount_cents)) AS abs_total,
               SUM(amount_cents) AS total_cents, MAX(date) AS last_date
        FROM transactions
        WHERE category_id = ? AND kind = 'normal' AND merchant_key IS NOT NULL
        GROUP BY merchant_key ORDER BY abs_total DESC, merchant_key
    """, (unsorted,))
    popular = _popular_categories(conn)
    items = []
    for g in groups[:limit]:
        latest = db.row(conn, """SELECT * FROM transactions WHERE merchant_key = ? AND category_id = ?
                                 ORDER BY date DESC, id DESC LIMIT 1""", (g["merchant_key"], unsorted))
        if not latest:
            continue
        items.append({
            "merchant_key": g["merchant_key"],
            "merchant_name": latest["merchant_name"],
            "count": g["count"],
            "total_cents": g["total_cents"],
            "last_date": g["last_date"],
            "method": latest["method"],
            "city": latest["city"],
            "sample_description": latest["description"] or latest["raw_description"],
            "is_person": g["merchant_key"].startswith(engine.PRIVATE_PREFIXES),
            "suggestions": suggest_categories(conn, latest, lib, popular),
        })
    return {"items": items, "remaining": len(groups)}


def _popular_categories(conn: sqlite3.Connection) -> dict[str, list[int]]:
    """Most used bakjes for money out / in among sorted transactions."""
    out: dict[str, list[int]] = {}
    for sign, cond in (("out", "t.amount_cents < 0"), ("in", "t.amount_cents > 0")):
        out[sign] = [r["category_id"] for r in db.rows(conn, f"""
            SELECT t.category_id, COUNT(*) AS n FROM transactions t
            JOIN categories c ON c.id = t.category_id
            WHERE {cond} AND c.key != 'unsorted' AND c.grp != 'internal'
            GROUP BY t.category_id ORDER BY n DESC LIMIT 8""")]
    return out


DEFAULTS_OUT = {"card": ["boodschappen", "uit-eten", "winkelen", "vervoer"],
                "ideal": ["winkelen", "uit-eten", "vrije-tijd", "abonnementen"],
                "debit": ["abonnementen", "verzekeringen", "energie", "telecom"],
                "atm": ["contant"]}
DEFAULTS_OUT_OTHER = ["overig", "cadeaus", "winkelen", "wonen"]
DEFAULTS_IN = ["inkomen-overig", "salaris", "toeslagen"]
DEFAULTS_PERSON_OUT = ["cadeaus", "overig", "kinderen", "uit-eten"]


def suggest_categories(conn: sqlite3.Connection, tx: dict, lib: Library,
                       popular: dict[str, list[int]] | None = None) -> list[int]:
    """Up to four category ids, best first."""
    ids = db.category_ids(conn)
    amount = tx.get("amount_cents") or 0
    keys: list[str | None] = [
        lib.mcc_category(tx.get("mcc")),
        lib.match_keyword(f"{tx.get('merchant_name') or ''} {tx.get('description') or ''}", amount),
        lib.bank_category(tx.get("bank_category"), amount),
    ]
    if amount > 0:
        keys += DEFAULTS_IN
    elif (tx.get("merchant_key") or "").startswith("p:"):
        keys += DEFAULTS_PERSON_OUT
    else:
        keys += DEFAULTS_OUT.get(tx.get("method") or "", DEFAULTS_OUT_OTHER)
    found = [ids[k] for k in keys if k and k in ids]
    found += (popular or {}).get("in" if amount > 0 else "out", [])
    unique = list(dict.fromkeys(i for i in found if i != ids.get("unsorted")))
    hidden = {r["id"] for r in db.rows(conn, "SELECT id FROM categories WHERE hidden = 1")}
    return [i for i in unique if i not in hidden][:4]
