"""Extension points for the analytics code (goal matching, cache invalidation, ...).

- `after_write(conn)` runs at the end of EVERY successful mutating API request (POST, PATCH,
  PUT, DELETE), inside the request's transaction, just before commit (see `api/deps.py`).
- `after_import(conn, import_ids)` runs after an import request has stored and classified the
  new transactions (before `after_write`).

Register with the decorators, e.g. in services/goals.py:

    from ..hooks import on_after_import

    @on_after_import
    def match_goals(conn, import_ids): ...

Registration happens at import time, so make sure the module is imported (api/__init__.py
imports every router module, and routers import their services).
"""

from __future__ import annotations

import sqlite3
from typing import Callable

AfterWrite = Callable[[sqlite3.Connection], None]
AfterImport = Callable[[sqlite3.Connection, list[int]], None]
RecurringLookup = Callable[[sqlite3.Connection, str], "dict | None"]

_after_write: list[AfterWrite] = []
_after_import: list[AfterImport] = []
_recurring_lookup: list[RecurringLookup] = []


def on_after_write(fn: AfterWrite) -> AfterWrite:
    if fn not in _after_write:
        _after_write.append(fn)
    return fn


def on_after_import(fn: AfterImport) -> AfterImport:
    if fn not in _after_import:
        _after_import.append(fn)
    return fn


def provide_recurring_lookup(fn: RecurringLookup) -> RecurringLookup:
    """Analytics: return the RecurringItem for a merchant_key (used by GET /transactions/{id})."""
    _recurring_lookup.clear()
    _recurring_lookup.append(fn)
    return fn


def after_write(conn: sqlite3.Connection) -> None:
    for fn in list(_after_write):
        fn(conn)


def after_import(conn: sqlite3.Connection, import_ids: list[int]) -> None:
    for fn in list(_after_import):
        fn(conn, import_ids)


def recurring_for_merchant(conn: sqlite3.Connection, merchant_key: str) -> dict | None:
    return _recurring_lookup[0](conn, merchant_key) if _recurring_lookup else None
