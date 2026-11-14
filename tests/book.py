"""A tiny bookkeeping helper for analytics tests: write accounts and transactions straight into
the test database (exact categories, kinds and dates), then read through the real API.

Everything here is synthetic."""

from __future__ import annotations

import itertools
import json
from datetime import date
from pathlib import Path

import pytest

from cents import db
from cents.services import cache, periods

_seq = itertools.count(1)


class Book:
    def __init__(self, path: Path):
        self.conn = db.connect(path)
        self.cats = db.category_ids(self.conn)

    def account(self, name: str, type_: str = "checking", iban: str | None = None,
                match: list[str] | None = None, manual_balance: int | None = None,
                manual_date: str | None = None) -> int:
        return db.insert(self.conn, "accounts", {
            "iban": iban, "name": name, "type": type_, "match": json.dumps(match or []),
            "manual_balance_cents": manual_balance, "manual_balance_date": manual_date,
            "hidden": 0, "sort": next(_seq), "created_at": "2025-01-01T00:00:00+00:00"})

    def tx(self, account: int, day: str, amount: int, cat: str = "unsorted",
           merchant: str | None = None, *, kind: str = "normal", method: str = "transfer",
           to: int | None = None, manual: int = 0, description: str | None = None,
           balance: int | None = None, source: str = "rule") -> int:
        merchant = merchant or cat
        now = db.now_iso()
        return db.insert(self.conn, "transactions", {
            "account_id": account, "dedupe_key": f"test:{next(_seq)}", "date": day,
            "amount_cents": amount, "balance_after_cents": balance, "seq": next(_seq),
            "description": description or merchant, "raw_description": description or merchant,
            "method": method, "merchant_key": merchant.lower(), "merchant_name": merchant,
            "category_id": self.cats[cat], "category_source": source, "kind": kind,
            "transfer_account_id": to, "manual": manual, "created_at": now, "updated_at": now})

    def monthly(self, account: int, first: str, n: int, amount: int, cat: str, merchant: str,
                **kw) -> list[int]:
        y, m, d = (int(x) for x in first.split("-"))
        ids = []
        for i in range(n):
            yy, mm = divmod(m - 1 + i, 12)
            ids.append(self.tx(account, date(y + yy, mm + 1, d).isoformat(), amount, cat,
                               merchant, **kw))
        return ids

    def commit(self) -> None:
        cache.bump(self.conn)
        self.conn.commit()

    def close(self) -> None:
        self.conn.close()


@pytest.fixture
def today(monkeypatch):
    """Freeze "today" (default 2026-03-15); call the fixture value to move it."""
    state = {"day": date(2026, 3, 15)}
    monkeypatch.setattr(periods, "today", lambda: state["day"])

    def set_day(day: str) -> date:
        state["day"] = date.fromisoformat(day)
        return state["day"]
    set_day.current = lambda: state["day"]
    return set_day


@pytest.fixture
def book(client, tmp_path, today):
    b = Book(tmp_path / "cents.db")
    yield b
    b.close()
