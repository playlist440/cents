"""Session, first-run setup, login, logout, password change."""

from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends, Request, Response

from .. import VERSION, auth
from ..config import SESSION_COOKIE
from ..errors import ApiError
from ..schemas import PasswordBody, PasswordChange
from .deps import get_conn, set_session_cookie

public_router = APIRouter()
router = APIRouter()


def _client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


@public_router.get("/session")
def get_session(request: Request, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    valid, _ = auth.check_session(conn, request.cookies.get(SESSION_COOKIE))
    return {"setup_required": not auth.has_password(conn), "authenticated": valid,
            "version": VERSION}


@public_router.post("/setup")
def setup(body: PasswordBody, request: Request, response: Response,
          conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    already = ApiError(409, "already_setup", "Er is al een wachtwoord ingesteld.")
    if auth.has_password(conn):
        raise already
    if len(body.password) < auth.MIN_PASSWORD_LENGTH:
        raise ApiError(400, "password_too_short", "Kies een wachtwoord van minstens 8 tekens.")
    if not auth.claim_first_password(conn, body.password):    # a parallel request won
        raise already
    set_session_cookie(request, response, auth.create_session(conn))
    return {"ok": True}


@public_router.post("/login")
def login(body: PasswordBody, request: Request, response: Response,
          conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    limiter: auth.LoginLimiter = request.app.state.login_limiter
    ip = _client_ip(request)
    if limiter.blocked(ip):
        raise ApiError(429, "too_many_attempts", "Te veel pogingen. Probeer het over een paar minuten opnieuw.")
    if not auth.has_password(conn):
        raise ApiError(409, "setup_required", "Kies eerst een wachtwoord.")
    if not auth.check_password(conn, body.password):
        limiter.fail(ip)
        raise ApiError(401, "wrong_password", "Dat wachtwoord klopt niet.")
    limiter.reset(ip)
    auth.rehash_if_needed(conn, body.password)
    set_session_cookie(request, response, auth.create_session(conn))
    return {"ok": True}


@public_router.post("/logout")
def logout(request: Request, response: Response, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    auth.delete_session(conn, request.cookies.get(SESSION_COOKIE))
    response.delete_cookie(SESSION_COOKIE, path="/")
    return {"ok": True}


@router.post("/password")
def change_password(body: PasswordChange, request: Request,
                    conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    if not auth.check_password(conn, body.current):
        raise ApiError(400, "wrong_password", "Je huidige wachtwoord klopt niet.")
    if len(body.new) < auth.MIN_PASSWORD_LENGTH:
        raise ApiError(400, "password_too_short", "Kies een wachtwoord van minstens 8 tekens.")
    auth.set_password(conn, body.new)
    auth.delete_other_sessions(conn, request.cookies.get(SESSION_COOKIE))
    return {"ok": True}
