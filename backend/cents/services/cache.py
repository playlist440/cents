"""Memoisation of derived analytics data per database state.

Every successful mutating request stores a new random token in the private setting `_state`
(via the `after_write` hook, inside the same transaction). Derived data (ledger, recurring
items, overviews, ...) is cached under (database file, state token, today). Readers see the
token that belongs to their snapshot, so a cache entry can never mix two database states, also
with several processes or after a restore.

A connection with uncommitted changes (`conn.in_transaction`) never reads or fills the cache:
it computes everything fresh from what it sees.
"""

from __future__ import annotations

import sqlite3
import threading
import uuid
from collections import OrderedDict
from typing import Any, Callable

from .. import db
from ..hooks import on_after_write
from . import periods

STATE_KEY = "_state"
MAX_STATES = 6

_lock = threading.Lock()
_store: "OrderedDict[tuple, dict[str, Any]]" = OrderedDict()


def bump(conn: sqlite3.Connection) -> None:
    """Mark the database as changed (call after writes outside a mutating request)."""
    db.set_setting(conn, STATE_KEY, uuid.uuid4().hex)


@on_after_write
def _after_write(conn: sqlite3.Connection) -> None:
    bump(conn)


def _key(conn: sqlite3.Connection) -> tuple:
    path = conn.execute("PRAGMA database_list").fetchone()[2]
    state = db.value(conn, "SELECT value FROM settings WHERE key = ?", (STATE_KEY,))
    return (path, state, periods.today().isoformat())


def memo(conn: sqlite3.Connection, name: str, compute: Callable[[], Any]) -> Any:
    """`compute()` once per database state (and day)."""
    if conn.in_transaction:
        return compute()
    key = _key(conn)
    with _lock:
        bucket = _store.get(key)
        if bucket is not None and name in bucket:
            _store.move_to_end(key)
            return bucket[name]
    result = compute()
    if conn.in_transaction:          # computing wrote something (e.g. a goal roll-over)
        return result
    with _lock:
        bucket = _store.setdefault(key, {})
        bucket[name] = result
        _store.move_to_end(key)
        while len(_store) > MAX_STATES:
            _store.popitem(last=False)
    return result


def clear() -> None:
    with _lock:
        _store.clear()
