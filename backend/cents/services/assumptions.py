"""Adjustable assumptions the engine makes (shown and editable in Instellingen).

Stored in setting `assumptions`; missing keys fall back to DEFAULTS.

- small_amount_at_fuel: library entries with a "small" split (fuel stations, MCC 5541) put
  amounts below the threshold in the small bakje (a sandwich, not fuel). Rule thresholds that
  the user set are not affected by this switch.
"""

from __future__ import annotations

import copy
import sqlite3
from typing import Any

from .. import db
from ..errors import ApiError

DEFAULTS: dict[str, dict[str, Any]] = {
    "small_amount_at_fuel": {"enabled": True, "below_cents": 1500},
    "payday_day": {"day": None},
    "buffer": {"months": 3, "amount_cents": None},
    "checking_floor_cents": {"cents": 0},
}
MAX_CENTS = 100_000_000
THRESHOLD_MIN, THRESHOLD_MAX = 100, 10000


def get(conn: sqlite3.Connection) -> dict[str, dict[str, Any]]:
    stored = db.get_setting(conn, "assumptions", {}) or {}
    out = copy.deepcopy(DEFAULTS)
    for key, values in stored.items():
        if key in out and isinstance(values, dict):
            out[key].update({k: v for k, v in values.items() if k in out[key]})
    return out


def merge(conn: sqlite3.Connection, patch: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Validate and store a partial update; returns the full new assumptions."""
    current = get(conn)
    for key, values in (patch or {}).items():
        if key not in DEFAULTS or not isinstance(values, dict):
            raise ApiError(422, "invalid", "Deze instelling bestaat niet.")
        for field, value in values.items():
            if field == "enabled":
                if not isinstance(value, bool):
                    raise ApiError(422, "invalid", "Kies aan of uit.")
            elif field == "day":
                if value is not None and (not isinstance(value, int) or isinstance(value, bool)
                                          or not 1 <= value <= 31):
                    raise ApiError(422, "invalid", "Kies een dag tussen 1 en 31.")
            elif field == "months":
                if not isinstance(value, (int, float)) or isinstance(value, bool) \
                        or not 0 <= value <= 24:
                    raise ApiError(422, "invalid", "Kies tussen 0 en 24 maanden.")
            elif field in ("amount_cents", "cents"):
                if field == "amount_cents" and value is None:
                    pass
                elif not isinstance(value, int) or isinstance(value, bool) \
                        or not -MAX_CENTS <= value <= MAX_CENTS \
                        or (field == "amount_cents" and value < 0):
                    raise ApiError(422, "invalid", "Kies een geldig bedrag.")
            elif field == "below_cents":
                if not isinstance(value, int) or isinstance(value, bool) \
                        or not THRESHOLD_MIN <= value <= THRESHOLD_MAX:
                    raise ApiError(422, "invalid", "Kies een bedrag tussen € 1 en € 100.")
            if field not in DEFAULTS[key]:
                raise ApiError(422, "invalid", "Deze instelling bestaat niet.")
            current[key][field] = value
    db.set_setting(conn, "assumptions", current)
    return current
