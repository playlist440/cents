"""The classification engine (SPEC 6). First hit wins:

user > rule > transfer > interest > strong merchant > mcc > keyword > weak merchant > bank >
heuristic > unsorted

`kind` (normal/transfer/settlement) and `transfer_account_id` are facts about own accounts and
are always recomputed (except for manual transactions); the category order above decides only
the category.
"""

from __future__ import annotations

import copy
import re
import sqlite3
import statistics
from dataclasses import dataclass, field

from .. import db
from ..services import assumptions as assumptions_service
from ..services import transfers
from .library import Library, get_library

SALARY_RE = re.compile(r"\b(salaris|loon|salary|loonbetaling|netto loon|vakantiegeld)\b", re.I)


@dataclass
class Context:
    lib: Library
    accounts: list[dict]
    cat_ids: dict[str, int]
    rules: dict[str, dict] = field(default_factory=dict)
    assumptions: dict = field(default_factory=lambda: copy.deepcopy(assumptions_service.DEFAULTS))

    @classmethod
    def load(cls, conn: sqlite3.Connection, lib: Library | None = None) -> "Context":
        rules = {r["merchant_key"]: r for r in db.rows(conn, "SELECT * FROM rules")}
        return cls(lib=lib or get_library(), accounts=transfers.load_accounts(conn),
                   cat_ids=db.category_ids(conn), rules=rules,
                   assumptions=assumptions_service.get(conn))

    def own_ibans(self) -> set[str]:
        return {a["iban"] for a in self.accounts if a["iban"]}


@dataclass
class Result:
    category_id: int | None
    category_source: str
    kind: str = "normal"
    transfer_account_id: int | None = None
    reason: str = "none"          # short machine string, see reason_label()


PRIVATE_PREFIXES = ("p:", "via:")
UNATTENDED_FUEL_MCC = "5542"      # automated pumps: always fuel, never split by amount


def is_person(tx: dict) -> bool:
    """Private counterparties (p:) and payment-request intermediaries without a named person
    (via:, e.g. Tikkie) are only sorted by the user."""
    return (tx.get("merchant_key") or "").startswith(PRIVATE_PREFIXES)


def _small(entry: dict | None, tx: dict, ctx: Context) -> str | None:
    """The small-amount bakje of a library entry when the split applies, else None.
    abs(amount) < below_cents (equal is the main bakje); a refund follows the same split."""
    small = (entry or {}).get("small")
    setting = ctx.assumptions.get("small_amount_at_fuel", {})
    if not small or not setting.get("enabled", True) or str(tx.get("mcc") or "") == UNATTENDED_FUEL_MCC:
        return None
    below = setting.get("below_cents") or small.get("below_cents")
    return small.get("category") if abs(tx.get("amount_cents") or 0) < below else None


def _merchant_entry(tx: dict, lib: Library, weak: bool) -> dict | None:
    amount, method = tx.get("amount_cents"), tx.get("method")
    entry = lib.brand(tx.get("merchant_key"), amount, method, weak=weak)
    if entry:
        return entry
    texts = [tx.get("merchant_name"), tx.get("counterparty_name")]
    if method in ("ideal", "debit"):
        texts.append(tx.get("description"))
    for text in texts:
        entry = lib.match_merchant(text, amount, method, weak=weak) if text else None
        if entry:
            return entry
    return None


def _merchant_category(tx: dict, lib: Library, weak: bool) -> str | None:
    entry = _merchant_entry(tx, lib, weak)
    return entry.get("category") if entry else None


HEURISTIC_REASONS = {"contant": "atm", "overig": "fee", "inkomen-overig": "interest", "salaris": "salary"}


def _heuristic(tx: dict) -> str | None:
    method = tx.get("method")
    amount = tx.get("amount_cents") or 0
    if method == "atm":
        return "contant"
    if method == "fee":
        return "overig"
    if method == "interest":
        return "inkomen-overig" if amount > 0 else "overig"
    text = f"{tx.get('description') or ''} {tx.get('counterparty_name') or ''}"
    if amount > 0 and not is_person(tx) and SALARY_RE.search(text):
        return "salaris"
    return None


def _heuristic_reason(tx: dict, key: str) -> str:
    method = tx.get("method")
    if method in ("atm", "fee", "interest"):
        return f"heuristic:{method}"
    return f"heuristic:{HEURISTIC_REASONS.get(key, 'other')}"


def classify(tx: dict, ctx: Context) -> Result:
    """Decide category, kind and transfer account for one transaction (a dict of columns)."""
    kind, transfer_account_id, transfer_category = "normal", None, None
    if not tx.get("manual"):
        target = transfers.find_transfer_account(tx, ctx.accounts)
        if target is not None:
            kind, transfer_category = transfers.transfer_result(tx, target, ctx.accounts)
            transfer_account_id = target["id"]

    def done(key: str | None, source: str, reason: str) -> Result | None:
        cid = ctx.cat_ids.get(key) if key else None
        if cid is None:
            return None
        return Result(cid, source, kind, transfer_account_id, reason)

    if tx.get("category_source") == "user" and tx.get("category_id"):
        return Result(tx["category_id"], "user", kind, transfer_account_id, "user")

    amount = tx.get("amount_cents") or 0
    rule = ctx.rules.get(tx.get("merchant_key") or "")
    if rule:
        below, below_cat = rule.get("below_cents"), rule.get("below_category_id")
        if below and below_cat and abs(amount) < below:
            return Result(below_cat, "rule", kind, transfer_account_id, "rule:below")
        if rule.get("category_id"):
            return Result(rule["category_id"], "rule", kind, transfer_account_id, "rule")

    if transfer_category:
        # own-account transfers carry source "heuristic" (SPEC has no separate source)
        result = done(transfer_category, "heuristic", "transfer")
        if result:
            return result

    # Interest is a fact from the bank code, stronger than any name or bank label (ASN labels
    # savings interest "Sparen", which would otherwise land in bakje sparen).
    if tx.get("method") == "interest":
        result = done(_heuristic(tx), "heuristic", "heuristic:interest")
        if result:
            return result

    if not is_person(tx):
        lib = ctx.lib
        for weak in (False, None):
            if weak is None:            # mcc and keyword come between strong and weak brands
                mcc = lib.mcc_entry(tx.get("mcc"))
                if mcc and mcc.get("category"):
                    small = _small(mcc, tx, ctx)
                    code = str(tx.get("mcc"))
                    result = done(small, "mcc", f"mcc:{code}:small") if small else \
                        done(mcc["category"], "mcc", f"mcc:{code}")
                    if result:
                        return result
                found = lib.match_keyword_full(
                    f"{tx.get('merchant_name') or ''} {tx.get('description') or ''}", amount,
                    tx.get("method"))
                if found:
                    result = done(found[0], "keyword", f"keyword:{found[1]}")
                    if result:
                        return result
                weak = True
            entry = _merchant_entry(tx, lib, weak)
            if entry:
                small = _small(entry, tx, ctx)
                key = entry.get("key") or "?"
                result = done(small, "merchant", f"merchant:{key}:small") if small else \
                    done(entry.get("category"), "merchant", f"merchant:{key}")
                if result:
                    return result
        bank = lib.bank_category(tx.get("bank_category"), amount)
        result = done(bank, "bank", f"bank:{tx.get('bank_category')}")
        if result:
            return result
        heuristic = _heuristic(tx)
        result = done(heuristic, "heuristic", _heuristic_reason(tx, heuristic or ""))
        if result:
            return result

    return Result(ctx.cat_ids.get("unsorted"), "none", kind, transfer_account_id, "none")


# ---------------------------------------------------------------- persistence

def classify_all(conn: sqlite3.Connection, lib: Library | None = None,
                 ids: list[int] | None = None, ctx: Context | None = None) -> int:
    """Run the engine over transactions (all, or `ids`) and store changes. Returns the number
    of transactions whose category, kind or transfer account changed."""
    ctx = ctx or Context.load(conn, lib)
    if ids is not None and not ids:
        return 0
    changed = 0
    now = db.now_iso()
    for chunk in _chunks(conn, ids):          # bounded memory, also for 100k+ transactions
        for tx in chunk:
            res = classify(tx, ctx)
            updates: dict = {}
            if res.category_id != tx["category_id"]:
                updates["category_id"] = res.category_id
            if res.category_source != tx["category_source"]:
                updates["category_source"] = res.category_source
            if res.reason != tx.get("category_reason"):
                updates["category_reason"] = res.reason
            if res.kind != tx["kind"]:
                updates["kind"] = res.kind
            if res.transfer_account_id != tx["transfer_account_id"]:
                updates["transfer_account_id"] = res.transfer_account_id
            if res.transfer_account_id and tx["method"] in (None, "transfer", "other"):
                updates["method"] = "internal"
            if updates:
                updates["updated_at"] = now
                db.update(conn, "transactions", tx["id"], updates)
                changed += 1
            rule = ctx.rules.get(tx["merchant_key"] or "")
            if rule and rule.get("tag_id"):
                conn.execute("INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)",
                             (tx["id"], rule["tag_id"]))
    changed += detect_salary(conn, ctx)
    return changed


CHUNK = 2000


def _chunks(conn: sqlite3.Connection, ids: list[int] | None):
    """Transactions in id order, CHUNK rows at a time (all, or only `ids`)."""
    if ids is not None:
        ordered = sorted(set(ids))
        for start in range(0, len(ordered), CHUNK):
            part = ordered[start:start + CHUNK]
            yield db.rows(conn, f"SELECT * FROM transactions WHERE id IN ({db.placeholders(part)})", part)
        return
    last = 0
    while True:
        rows = db.rows(conn, "SELECT * FROM transactions WHERE id > ? ORDER BY id LIMIT ?", (last, CHUNK))
        if not rows:
            return
        yield rows
        last = rows[-1]["id"]


def detect_salary(conn: sqlite3.Connection, ctx: Context) -> int:
    """The largest stable monthly credit from a company that is still unsorted -> salaris.
    Only when nothing is in `salaris` yet."""
    salary_id, unsorted = ctx.cat_ids.get("salaris"), ctx.cat_ids.get("unsorted")
    if not salary_id or not unsorted:
        return 0
    if db.value(conn, "SELECT 1 FROM transactions WHERE category_id = ? LIMIT 1", (salary_id,)):
        return 0
    rows = db.rows(conn, """
        SELECT t.id, t.merchant_key, t.date, t.amount_cents FROM transactions t
        JOIN accounts a ON a.id = t.account_id
        WHERE t.category_id = ? AND t.category_source = 'none' AND t.amount_cents > 0
          AND t.kind = 'normal' AND t.manual = 0 AND a.type = 'checking'
          AND t.merchant_key NOT LIKE 'p:%' AND t.method IN ('transfer', 'other')
    """, (unsorted,))
    groups: dict[str, list[dict]] = {}
    for r in rows:
        groups.setdefault(r["merchant_key"], []).append(r)
    best_key, best_amount = None, 0
    for key, items in groups.items():
        months = {r["date"][:7] for r in items}
        amounts = [r["amount_cents"] for r in items]
        if len(months) < 3 or len(items) > len(months) + 1:
            continue
        median = statistics.median(amounts)
        if median < 50000 or max(amounts) > median * 1.3 or min(amounts) < median * 0.7:
            continue
        if median > best_amount:
            best_key, best_amount = key, median
    if not best_key:
        return 0
    ids = [r["id"] for r in groups[best_key]]
    conn.execute(f"UPDATE transactions SET category_id = ?, category_source = 'heuristic', "
                 f"category_reason = 'heuristic:salary', updated_at = ? WHERE id IN ({db.placeholders(ids)})", (salary_id, db.now_iso(), *ids))
    return len(ids)


def classify_merchant(conn: sqlite3.Connection, merchant_key: str, lib: Library | None = None) -> int:
    ids = [r["id"] for r in db.rows(conn, "SELECT id FROM transactions WHERE merchant_key = ?",
                                    (merchant_key,))]
    return classify_all(conn, lib, ids)
