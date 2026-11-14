"""Importing bank files: parse, create accounts, dedupe/enrich, store (SPEC 5).

Classification and hooks run once per request in `import_files`.
"""

from __future__ import annotations

import hashlib
import json
import logging
import sqlite3
from typing import Iterator

from .. import db, hooks
from ..classify import engine
from ..classify.library import Library, get_library
from ..importers import ImportFormatError, Source, Statement
from ..importers.detect import iter_file
from ..importers.normalize import collapse, normalize
from . import transfers

log = logging.getLogger("cents.import")

COLUMNS = [
    "date", "value_date", "amount_cents", "balance_after_cents", "seq", "counterparty_name",
    "counterparty_iban", "description", "raw_description", "method", "pay_type", "bank_code",
    "iso_family", "iso_subfamily", "mcc", "wallet", "city", "end_to_end_id", "mandate_id",
    "creditor_id", "bank_category", "merchant_key", "merchant_name",
]
# Raw facts a second file may add to a stored transaction.
ENRICH_FIELDS = [
    "value_date", "balance_after_cents", "seq", "counterparty_name", "counterparty_iban",
    "raw_description", "pay_type", "bank_code", "iso_family", "iso_subfamily", "mcc", "wallet",
    "end_to_end_id", "mandate_id", "creditor_id", "bank_category",
]
DERIVED_FIELDS = ["method", "merchant_name", "merchant_key", "city", "mcc", "wallet",
                  "mandate_id", "creditor_id", "description"]
ACCOUNT_NAMES = {"checking": "Betaalrekening", "savings": "Spaarrekening",
                 "credit": "Creditcard", "investment": "Beleggingen"}


def base_key(iban: str, tx: dict) -> str:
    """iban|date|seq when the bank gives a sequence number, else a content hash (h:...)."""
    if tx.get("seq") is not None:
        return f"{iban}|{tx['date']}|{int(tx['seq'])}"
    ref = tx.get("acct_svcr_ref") or tx.get("end_to_end_id") or ""
    parts = [iban, tx["date"], str(tx["amount_cents"]), tx.get("counterparty_iban") or "", ref,
             collapse(tx.get("raw_description"))]
    return "h:" + hashlib.sha1("|".join(parts).encode("utf-8")).hexdigest()


def dedupe_key(iban: str, tx: dict, occurrence: int = 1) -> str:
    """The stored key. Content-hash keys get the occurrence number of identical rows within
    the same file (":1", ":2", ...), so two identical card payments on one day stay two
    transactions, and re-importing the same or an overlapping file matches them one-to-one."""
    key = base_key(iban, tx)
    return f"{key}:{occurrence}" if key.startswith("h:") else key


# ---------------------------------------------------------------- accounts

def account_name(conn: sqlite3.Connection, kind: str, iban: str | None) -> str:
    """Default name for a new account (before `refresh_accounts` settles the suffixes)."""
    base = ACCOUNT_NAMES.get(kind, "Rekening")
    if iban and db.value(conn, "SELECT 1 FROM accounts WHERE type = ? LIMIT 1", (kind,)):
        return f"{base} {iban[-4:]}"
    return base


def create_account(conn: sqlite3.Connection, name: str, kind: str, iban: str | None = None,
                   match: list[str] | None = None, source: str = "auto") -> int:
    """`source` = 'auto' (created by an import: type and name may change automatically) or
    'user' (created or chosen by the user: never changed automatically)."""
    if match is None:
        match = list(transfers.CREDIT_CARD_MATCH) if kind == "credit" else []
    sort = (db.value(conn, "SELECT MAX(sort) FROM accounts") or 0) + 10
    return db.insert(conn, "accounts", {
        "iban": iban, "name": name, "type": kind, "match": json.dumps(match),
        "hidden": 0, "sort": sort, "created_at": db.now_iso(),
        "type_source": source, "name_source": source,
    })


def get_or_create_account(conn: sqlite3.Connection, iban: str) -> tuple[dict, bool]:
    """The account for an IBAN. New ones start as checking; `refresh_accounts` decides the
    real type once all rows of the import are stored."""
    existing = db.row(conn, "SELECT * FROM accounts WHERE iban = ?", (iban,))
    if existing:
        return existing, False
    account_id = create_account(conn, account_name(conn, "checking", iban), "checking", iban)
    return db.row(conn, "SELECT * FROM accounts WHERE id = ?", (account_id,)), True


SAVINGS_SHARE = 0.9          # share of rows that must be own-account transfers or interest


def _looks_like_savings(conn: sqlite3.Connection, account: dict, own_ibans: set[str]) -> bool | None:
    """True/False from the account's stored rows; None when it has no imported rows."""
    others = sorted(own_ibans - {account["iban"]}) or [""]
    r = db.row(conn, f"""
        SELECT COUNT(*) AS n,
               COALESCE(SUM(method IN ('card', 'ideal', 'debit', 'atm')), 0) AS active,
               COALESCE(SUM(method IN ('internal', 'interest', 'fee')
                            OR counterparty_iban IN ({db.placeholders(others)})
                            OR LOWER(bank_category) = 'sparen'), 0) AS own_like
        FROM transactions WHERE account_id = ? AND manual = 0""", (*others, account["id"]))
    if not r["n"]:
        return None
    if r["active"]:
        return False
    if r["own_like"] >= SAVINGS_SHARE * r["n"]:
        return True
    # the other side: other accounts move money TO this IBAN labelled "Sparen" / BOOK
    c = db.row(conn, """
        SELECT COALESCE(SUM(amount_cents < 0), 0) AS n_out, COALESCE(SUM(amount_cents > 0), 0) AS n_in
        FROM transactions WHERE counterparty_iban = ? AND account_id != ?
          AND (LOWER(bank_category) = 'sparen' OR iso_subfamily = 'BOOK')""",
                 (account["iban"], account["id"]))
    return c["n_out"] > c["n_in"]


def refresh_accounts(conn: sqlite3.Connection) -> bool:
    """Re-decide checking vs savings for every automatically typed account from all stored
    rows (so the result does not depend on import order), then settle automatic names.
    Accounts whose type or name the user chose are never changed. Returns True on a change."""
    accounts = db.rows(conn, "SELECT * FROM accounts ORDER BY id")
    own_ibans = {a["iban"] for a in accounts if a["iban"]}
    changed = False
    new_types = {a["id"]: a["type"] for a in accounts}
    auto = [a for a in accounts if a["type_source"] == "auto" and a["iban"]
            and a["type"] in ("checking", "savings")]
    counts: dict[int, int] = {}
    for a in auto:
        verdict = _looks_like_savings(conn, a, own_ibans)
        if verdict is not None:
            new_types[a["id"]] = "savings" if verdict else "checking"
        counts[a["id"]] = db.value(conn, "SELECT COUNT(*) FROM transactions WHERE account_id = ?", (a["id"],))
    # Several accounts that only move money between each other: the busiest one is checking.
    bank = [a for a in accounts if new_types[a["id"]] in ("checking", "savings")]
    if len(bank) > 1 and auto and all(new_types[a["id"]] == "savings" for a in bank):
        busiest = max(auto, key=lambda a: counts.get(a["id"], 0))
        new_types[busiest["id"]] = "checking"
    for a in auto:
        if new_types[a["id"]] != a["type"]:
            db.update(conn, "accounts", a["id"], {"type": new_types[a["id"]]})
            changed = True

    per_type: dict[str, int] = {}
    for kind in new_types.values():
        per_type[kind] = per_type.get(kind, 0) + 1
    for a in accounts:
        if a["name_source"] != "auto":
            continue
        kind = new_types[a["id"]]
        name = ACCOUNT_NAMES.get(kind, "Rekening")
        if per_type[kind] > 1 and a["iban"]:
            name = f"{name} {a['iban'][-4:]}"
        if name != a["name"]:
            db.update(conn, "accounts", a["id"], {"name": name})
            changed = True
    return changed


# ---------------------------------------------------------------- one file

def _enrich(conn: sqlite3.Connection, stored: dict, fresh: dict, lib: Library,
            own_ibans: set[str], account_iban: str | None = None) -> bool:
    updates = {f: fresh[f] for f in ENRICH_FIELDS
               if fresh.get(f) not in (None, "") and stored.get(f) in (None, "")}
    if not updates:
        return False
    merged = {**stored, **updates}
    derived = normalize(merged, lib, own_ibans, account_iban)
    locked = stored["category_source"] in ("user", "rule") or stored["manual"]
    for field in DERIVED_FIELDS:
        if derived.get(field) in (None, ""):
            continue
        if field in ("merchant_key", "merchant_name") and locked:
            continue
        if stored.get(field) in (None, "") or not locked:
            if derived[field] != stored.get(field):
                updates[field] = derived[field]
    updates["updated_at"] = db.now_iso()
    db.update(conn, "transactions", stored["id"], updates)
    return True


INSERT_COLUMNS = COLUMNS + ["account_id", "import_id", "dedupe_key", "category_id",
                            "category_source", "kind", "manual", "created_at", "updated_at"]
INSERT_SQL = (f"INSERT INTO transactions ({', '.join(INSERT_COLUMNS)}) "
              f"VALUES ({', '.join('?' for _ in INSERT_COLUMNS)})")
BATCH = 2000


def empty_result(filename: str, error: str | None = None) -> dict:
    return {"filename": filename, "format": None, "ok": False, "error": error,
            "account_id": None, "account_name": None, "is_new_account": False,
            "new_accounts": [], "new": 0, "duplicates": 0, "enriched": 0,
            "date_from": None, "date_to": None, "import_id": None}


def _store(conn: sqlite3.Connection, filename: str, fmt: str,
           pairs: Iterator[tuple[Statement, dict]], lib: Library, result: dict) -> None:
    """Consume the parser stream and write rows in batches. Memory holds one batch, the
    dedupe keys of the accounts involved, and nothing per row beyond that."""
    now = db.now_iso()
    import_id = db.insert(conn, "imports", {"filename": filename, "format": fmt, "imported_at": now})
    own_ibans = {r["iban"] for r in db.rows(conn, "SELECT iban FROM accounts WHERE iban IS NOT NULL")}
    unsorted = db.unsorted_id(conn)
    date_from: str | None = None
    date_to: str | None = None
    pending: list[tuple] = []
    accounts: dict[int, tuple[dict, set[str], dict[str, int]]] = {}   # id(statement) -> state

    for st, tx in pairs:
        state = accounts.get(id(st))
        if state is None:
            account, is_new = get_or_create_account(conn, st.iban)
            own_ibans.add(st.iban)
            if is_new:
                result["new_accounts"].append({"id": account["id"], "name": account["name"],
                                               "type": account["type"], "iban": account["iban"]})
            if result["account_id"] is None or (is_new and not result["is_new_account"]):
                result["account_id"], result["account_name"] = account["id"], account["name"]
                result["is_new_account"] = is_new
            known = {r[0] for r in conn.execute(
                "SELECT dedupe_key FROM transactions WHERE account_id = ?", (account["id"],))}
            state = accounts[id(st)] = (account, known, {}, {}, st)
        account, known, occurrences, positions, _ = state

        base = base_key(st.iban, tx)
        occurrences[base] = occurrences.get(base, 0) + 1
        key = dedupe_key(st.iban, tx, occurrences[base])
        if "_pos" in tx:
            positions[tx["_pos"]] = key
        date_from = min(date_from or tx["date"], tx["date"])
        date_to = max(date_to or tx["date"], tx["date"])
        if key in known:
            result["duplicates"] += 1
            stored = db.row(conn, "SELECT * FROM transactions WHERE dedupe_key = ?", (key,))
            if stored and any(tx.get(f) not in (None, "") and stored.get(f) in (None, "")
                              for f in ENRICH_FIELDS):
                fresh = {**tx, **normalize(tx, lib, own_ibans, st.iban)}
                if _enrich(conn, stored, fresh, lib, own_ibans, st.iban):
                    result["enriched"] += 1
            continue
        known.add(key)
        fresh = {**tx, **normalize(tx, lib, own_ibans, st.iban)}
        pending.append(tuple([fresh.get(c) for c in COLUMNS] + [
            account["id"], import_id, key, unsorted, "none", "normal", 0, now, now]))
        result["new"] += 1
        if len(pending) >= BATCH:
            conn.executemany(INSERT_SQL, pending)
            pending.clear()
    if pending:
        conn.executemany(INSERT_SQL, pending)
    # Balances corrected at the end of a statement (descending file, wrong opening balance):
    # rows of this import get the corrected chain, older rows only when they had none.
    for _, _, _, positions, st in accounts.values():
        if st.balance_fix:
            conn.executemany(
                "UPDATE transactions SET balance_after_cents = ? WHERE dedupe_key = ? "
                "AND (import_id = ? OR balance_after_cents IS NULL)",
                [(st.balance_fix[pos], key, import_id) for pos, key in positions.items()
                 if pos in st.balance_fix])

    result.update({"ok": True, "import_id": import_id, "date_from": date_from, "date_to": date_to})
    db.update(conn, "imports", import_id, {
        "account_id": result["account_id"], "n_new": result["new"],
        "n_duplicate": result["duplicates"], "n_enriched": result["enriched"],
        "date_from": date_from, "date_to": date_to,
    })


def import_file(conn: sqlite3.Connection, filename: str, source: Source,
                lib: Library | None = None) -> dict:
    """Parse and store one file (bytes or a binary file object) atomically: either all of it
    is stored or nothing (SAVEPOINT). Classification is done by `import_files`."""
    lib = lib or get_library()
    result = empty_result(filename)
    try:
        fmt, pairs = iter_file(source)
    except ImportFormatError as exc:
        result["error"] = str(exc)
        return result
    result["format"] = fmt
    if not conn.in_transaction:
        conn.execute("BEGIN")
    conn.execute("SAVEPOINT import_file")
    try:
        _store(conn, filename, fmt, pairs, lib, result)
    except Exception as exc:
        conn.execute("ROLLBACK TO import_file")
        conn.execute("RELEASE import_file")
        if isinstance(exc, ImportFormatError):
            message = str(exc)
        else:
            log.exception("import of %s failed", filename)
            message = "Dit bestand kon ik niet importeren. Er is niets opgeslagen."
        failed = empty_result(filename, message)
        failed["format"] = fmt
        return failed
    conn.execute("RELEASE import_file")
    return result


# ---------------------------------------------------------------- a request with many files

def import_files(conn: sqlite3.Connection, files: list[tuple[str, Source]],
                 lib: Library | None = None) -> dict:
    """Import several files one by one, then type accounts, classify everything once and run
    the hooks. The response holds only counts (no per-row data), whatever the file size."""
    lib = lib or get_library()
    results = [import_file(conn, name, source, lib) for name, source in files]
    import_ids = [r["import_id"] for r in results if r["ok"]]
    if import_ids:
        refresh_accounts(conn)
        engine.classify_all(conn, lib)
        hooks.after_import(conn, import_ids)
        names = {a["id"]: a for a in db.rows(conn, "SELECT id, name, type FROM accounts")}
        for r in results:
            if r["account_id"] in names:
                r["account_name"] = names[r["account_id"]]["name"]
            for acc in r["new_accounts"]:
                if acc["id"] in names:
                    acc["name"], acc["type"] = names[acc["id"]]["name"], names[acc["id"]]["type"]
    totals = {k: sum(r[k] for r in results) for k in ("new", "duplicates", "enriched")}
    return {"files": results, "totals": totals, "unsorted_merchants": unsorted_merchant_count(conn)}


def unsorted_merchant_count(conn: sqlite3.Connection) -> int:
    return int(db.value(conn, """
        SELECT COUNT(DISTINCT t.merchant_key) FROM transactions t
        JOIN categories c ON c.id = t.category_id
        WHERE c.key = 'unsorted' AND t.kind = 'normal'
    """) or 0)


def delete_import(conn: sqlite3.Connection, import_id: int) -> int | None:
    """Remove an import and its transactions. Returns the count, None when unknown."""
    if not db.row(conn, "SELECT id FROM imports WHERE id = ?", (import_id,)):
        return None
    n = conn.execute("DELETE FROM transactions WHERE import_id = ?", (import_id,)).rowcount
    conn.execute("DELETE FROM imports WHERE id = ?", (import_id,))
    refresh_accounts(conn)
    engine.classify_all(conn)
    return n


def renormalize_all(conn: sqlite3.Connection, lib: Library | None = None) -> int:
    """Recompute derived fields of imported transactions (after a library update).
    Merchant name/key stay as they are when the user or a rule set the category."""
    lib = lib or get_library()
    own_ibans = {r["iban"] for r in db.rows(conn, "SELECT iban FROM accounts WHERE iban IS NOT NULL")}
    changed = 0
    ibans = {r["id"]: r["iban"] for r in db.rows(conn, "SELECT id, iban FROM accounts")}
    for tx in (t for chunk in engine._chunks(conn, None) for t in chunk if not t["manual"]):
        derived = normalize(tx, lib, own_ibans, ibans.get(tx["account_id"]))
        locked = tx["category_source"] in ("user", "rule")
        updates = {f: derived[f] for f in DERIVED_FIELDS
                   if derived.get(f) not in (None, "") and derived[f] != tx.get(f)
                   and not (locked and f in ("merchant_key", "merchant_name"))}
        if updates:
            updates["updated_at"] = db.now_iso()
            db.update(conn, "transactions", tx["id"], updates)
            changed += 1
    return changed
