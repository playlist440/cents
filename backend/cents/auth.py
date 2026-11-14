"""One shared household password (scrypt) and server-side sessions (SPEC 10, 11)."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import threading
import time
from collections import deque
from datetime import datetime, timedelta, timezone

from . import db
from .config import LOGIN_MAX_FAILURES, LOGIN_WINDOW_SECONDS, SESSION_DAYS

PASSWORD_KEY = "_password_hash"
MIN_PASSWORD_LENGTH = 8
SCRYPT_N, SCRYPT_R, SCRYPT_P = 2 ** 15, 8, 1
SCRYPT_MAXMEM = 128 * 1024 * 1024        # N=2**15, r=8 needs 32 MB (hashlib's default limit)


def _scrypt(password: str, salt: bytes, n: int, r: int, p: int, dklen: int) -> bytes:
    return hashlib.scrypt(password.encode("utf-8"), salt=salt, n=n, r=r, p=p, dklen=dklen,
                          maxmem=SCRYPT_MAXMEM)


def hash_password(password: str) -> str:
    """The parameters are stored in the hash, so older hashes keep verifying."""
    salt = os.urandom(16)
    digest = _scrypt(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P, 32)
    return f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str | None) -> bool:
    if not stored:
        return False
    try:
        _, n, r, p, salt, digest = stored.split("$")
        if int(n) > 2 ** 20 or int(r) > 32 or int(p) > 16:      # refuse absurd costs
            return False
        check = _scrypt(password, bytes.fromhex(salt), int(n), int(r), int(p), len(digest) // 2)
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(check.hex(), digest)


def needs_rehash(stored: str | None) -> bool:
    try:
        _, n, r, p, _, _ = (stored or "").split("$")
        return (int(n), int(r), int(p)) != (SCRYPT_N, SCRYPT_R, SCRYPT_P)
    except ValueError:
        return True


def has_password(conn: sqlite3.Connection) -> bool:
    return bool(db.get_setting(conn, PASSWORD_KEY))


def set_password(conn: sqlite3.Connection, password: str) -> None:
    db.set_setting(conn, PASSWORD_KEY, hash_password(password))


def claim_first_password(conn: sqlite3.Connection, password: str) -> bool:
    """Store the very first password atomically. False when another request was first."""
    digest = hash_password(password)                 # slow part outside the write lock
    cur = conn.execute("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING",
                       (PASSWORD_KEY, json.dumps(digest)))
    return cur.rowcount == 1


def check_password(conn: sqlite3.Connection, password: str) -> bool:
    return verify_password(password, db.get_setting(conn, PASSWORD_KEY))


def rehash_if_needed(conn: sqlite3.Connection, password: str) -> None:
    """After a successful login: upgrade a hash made with older scrypt parameters."""
    if needs_rehash(db.get_setting(conn, PASSWORD_KEY)):
        set_password(conn, password)


# ---------------------------------------------------------------- sessions

def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def create_session(conn: sqlite3.Connection) -> str:
    token = secrets.token_urlsafe(32)
    now = _now()
    conn.execute("INSERT INTO sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)",
                 (_hash_token(token), now.isoformat(), (now + timedelta(days=SESSION_DAYS)).isoformat()))
    conn.execute("DELETE FROM sessions WHERE expires_at < ?", (now.isoformat(),))
    return token


def check_session(conn: sqlite3.Connection, token: str | None) -> tuple[bool, bool]:
    """(valid, refreshed). A valid session older than a day gets a new 180-day expiry."""
    if not token:
        return False, False
    row = db.row(conn, "SELECT expires_at FROM sessions WHERE token_hash = ?", (_hash_token(token),))
    now = _now()
    if not row or datetime.fromisoformat(row["expires_at"]) <= now:
        return False, False
    new_expiry = now + timedelta(days=SESSION_DAYS)
    if new_expiry - datetime.fromisoformat(row["expires_at"]) > timedelta(days=1):
        conn.execute("UPDATE sessions SET expires_at = ? WHERE token_hash = ?",
                     (new_expiry.isoformat(), _hash_token(token)))
        return True, True
    return True, False


def session_valid(conn: sqlite3.Connection, token: str | None) -> bool:
    """Read-only check (used before a request body is read)."""
    if not token:
        return False
    row = db.row(conn, "SELECT expires_at FROM sessions WHERE token_hash = ?", (_hash_token(token),))
    return bool(row) and datetime.fromisoformat(row["expires_at"]) > _now()


def delete_session(conn: sqlite3.Connection, token: str | None) -> None:
    if token:
        conn.execute("DELETE FROM sessions WHERE token_hash = ?", (_hash_token(token),))


def delete_other_sessions(conn: sqlite3.Connection, keep_token: str | None) -> None:
    conn.execute("DELETE FROM sessions WHERE token_hash != ?", (_hash_token(keep_token or ""),))


def restore_session(conn: sqlite3.Connection, token: str) -> None:
    """Re-insert a session (after a restore replaced the sessions table)."""
    now = _now()
    conn.execute("INSERT OR REPLACE INTO sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)",
                 (_hash_token(token), now.isoformat(), (now + timedelta(days=SESSION_DAYS)).isoformat()))


# ---------------------------------------------------------------- login rate limit

class LoginLimiter:
    """At most LOGIN_MAX_FAILURES failed logins per IP per LOGIN_WINDOW_SECONDS (in memory)."""

    def __init__(self, max_failures: int = LOGIN_MAX_FAILURES, window: int = LOGIN_WINDOW_SECONDS):
        self.max_failures = max_failures
        self.window = window
        self._failures: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    def _recent(self, ip: str, now: float) -> deque[float]:
        q = self._failures.setdefault(ip, deque())
        while q and q[0] <= now - self.window:
            q.popleft()
        return q

    def blocked(self, ip: str) -> bool:
        with self._lock:
            return len(self._recent(ip, time.monotonic())) >= self.max_failures

    def fail(self, ip: str) -> None:
        with self._lock:
            self._recent(ip, time.monotonic()).append(time.monotonic())

    def reset(self, ip: str) -> None:
        with self._lock:
            self._failures.pop(ip, None)
