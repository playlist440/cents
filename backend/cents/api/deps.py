"""Request dependencies: the database connection and the session check."""

from __future__ import annotations

import sqlite3
from typing import Iterator

from fastapi import Depends, Request, Response

from .. import auth, db, hooks
from ..config import SESSION_COOKIE, SESSION_DAYS
from ..errors import ApiError

MUTATING = {"POST", "PUT", "PATCH", "DELETE"}


def get_conn(request: Request) -> Iterator[sqlite3.Connection]:
    """One connection per request. Mutating requests run `hooks.after_write` and commit;
    any exception rolls everything back."""
    conn = db.connect(request.app.state.db_path)
    try:
        yield conn
        if request.method in MUTATING:
            hooks.after_write(conn)
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    finally:
        conn.close()


def is_https(request: Request) -> bool:
    return request.url.scheme == "https" or \
        request.headers.get("x-forwarded-proto", "").lower() == "https"


def set_session_cookie(request: Request, response: Response, token: str) -> None:
    response.set_cookie(SESSION_COOKIE, token, max_age=SESSION_DAYS * 86400, httponly=True,
                        samesite="lax", secure=is_https(request), path="/")


def require_session(request: Request, response: Response,
                    conn: sqlite3.Connection = Depends(get_conn)) -> None:
    token = request.cookies.get(SESSION_COOKIE)
    valid, refreshed = auth.check_session(conn, token)
    if not valid:
        raise ApiError(401, "unauthorized", "Log eerst in.")
    if refreshed and token:
        set_session_cookie(request, response, token)
