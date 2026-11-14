from datetime import date

import pytest

from cents.services import periods as P


def test_start_day_1_is_calendar_month():
    p = P.period_for(date(2026, 11, 14), 1)
    assert (p.id, p.start, p.end, p.last) == ("2026-11", date(2026, 11, 1), date(2026, 12, 1), date(2026, 11, 30))
    assert p.days_total == 30 and p.label == "november 2026"


def test_start_day_24_named_after_next_month():
    p = P.period_for(date(2026, 11, 24), 24)
    assert (p.id, p.start, p.end) == ("2026-12", date(2026, 11, 24), date(2026, 12, 24))
    p = P.period_for(date(2026, 11, 23), 24)
    assert (p.id, p.start, p.end) == ("2026-11", date(2026, 10, 24), date(2026, 11, 24))


def test_year_boundaries():
    p = P.period_for(date(2026, 12, 30), 24)
    assert (p.id, p.start, p.end) == ("2027-01", date(2026, 12, 24), date(2027, 1, 24))
    p = P.period_for(date(2027, 1, 5), 24)
    assert p.id == "2027-01"
    p = P.period_for(date(2027, 1, 5), 10)
    assert (p.id, p.start, p.end) == ("2026-12", date(2026, 12, 10), date(2027, 1, 10))
    assert P.shift(P.period_by_id("2026-12", 1), 1, 1).id == "2027-01"
    assert P.shift(P.period_by_id("2027-01", 1), -1, 1).id == "2026-12"


def test_by_id_roundtrip_every_start_day():
    for sd in range(1, 29):
        seen = []
        p = P.period_by_id("2025-11", sd)
        for _ in range(30):                      # consecutive, no gaps, no duplicate ids
            assert P.period_by_id(p.id, sd) == p
            assert P.period_for(p.start, sd) == p and P.period_for(p.last, sd) == p
            nxt = P.shift(p, 1, sd)
            assert nxt.start == p.end
            seen.append(p.id)
            p = nxt
        assert len(set(seen)) == len(seen)


def test_id_is_month_with_most_days_for_typical_days():
    assert P.period_for(date(2026, 3, 20), 15).id == "2026-03"   # 15 Mar - 14 Apr: 17 vs 14
    assert P.period_for(date(2026, 3, 20), 20).id == "2026-04"   # 20 Mar - 19 Apr: 12 vs 19


def test_bad_input():
    with pytest.raises(ValueError):
        P.period_for(date(2026, 1, 1), 29)
    with pytest.raises(ValueError):
        P.period_by_id("2026-13", 1)
    with pytest.raises(ValueError):
        P.period_by_id("nonsense", 1)


def test_period_json():
    p = P.period_by_id("2026-11", 1)
    j = P.period_json(p, 1, now=date(2026, 11, 14), first=date(2026, 1, 3), last=date(2026, 11, 10))
    assert j["is_current"] and j["day_index"] == 14 and j["days_total"] == 30
    assert j["from"] == "2026-11-01" and j["to"] == "2026-11-30"
    assert j["prev"] == "2026-10" and j["next"] is None
    first = P.period_json(P.period_by_id("2026-01", 1), 1, now=date(2026, 11, 14), first=date(2026, 1, 3))
    assert first["prev"] is None and first["next"] == "2026-02" and first["day_index"] == 31


def test_data_today(conn):
    from cents import db
    assert P.data_today(conn, date(2026, 11, 14)) == date(2026, 11, 14)
    acc = db.insert(conn, "accounts", {"name": "x", "type": "checking", "created_at": "x"})
    db.insert(conn, "transactions", {"account_id": acc, "dedupe_key": "k", "date": "2026-11-01",
                                     "amount_cents": -100, "created_at": "x", "updated_at": "x"})
    assert P.data_today(conn, date(2026, 11, 14)) == date(2026, 11, 4)
