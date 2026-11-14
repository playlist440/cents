"""Pure ASGI middleware that runs before any request body is read.

- CSRF: mutating /api requests need `X-Cents: 1` (403 otherwise).
- Uploads (/api/import, /api/restore): no valid session -> 401, and a body larger than the
  limit -> 413, both decided before the body is read; without Content-Length the limit is
  enforced while the body streams in.
- Security headers and Cache-Control on every response.
- Any unhandled exception becomes a JSON 500 instead of a dropped connection.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Awaitable, Callable

from . import auth, db
from .config import MAX_IMPORT_REQUEST_BYTES, MAX_RESTORE_BYTES, SESSION_COOKIE

log = logging.getLogger("cents")

Scope = dict[str, Any]
Message = dict[str, Any]
Receive = Callable[[], Awaitable[Message]]
Send = Callable[[Message], Awaitable[None]]

MUTATING = {"POST", "PUT", "PATCH", "DELETE"}
UPLOAD_LIMITS = {"/api/import": MAX_IMPORT_REQUEST_BYTES, "/api/restore": MAX_RESTORE_BYTES + 1024 * 1024}

CSP = ("default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; "
       "frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
SECURITY_HEADERS = [
    (b"content-security-policy", CSP.encode()),
    (b"x-content-type-options", b"nosniff"),
    (b"referrer-policy", b"no-referrer"),
    (b"x-frame-options", b"DENY"),
]


class BodyTooLarge(Exception):
    pass


def _cookie(headers: dict[bytes, bytes], name: str) -> str | None:
    for part in headers.get(b"cookie", b"").decode("latin-1").split(";"):
        key, _, val = part.strip().partition("=")
        if key == name:
            return val
    return None


class Guard:
    def __init__(self, app: Callable[..., Awaitable[None]]) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        path, method = scope["path"], scope["method"]
        headers = dict(scope["headers"])
        is_api = path.startswith("/api/")
        started = False

        async def send_with_headers(message: Message) -> None:
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
                names = {k.lower() for k, _ in message.get("headers", [])}
                extra = [(k, v) for k, v in SECURITY_HEADERS if k not in names]
                if b"cache-control" not in names:
                    extra.append((b"cache-control", b"no-store" if is_api else b"no-cache"))
                message = {**message, "headers": list(message.get("headers", [])) + extra}
            await send(message)

        async def reply(status: int, code: str, text: str) -> None:
            body = json.dumps({"error": {"code": code, "message": text}}).encode()
            await send_with_headers({"type": "http.response.start", "status": status, "headers": [
                (b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
            await send_with_headers({"type": "http.response.body", "body": body})

        if is_api and method in MUTATING and headers.get(b"x-cents") != b"1":
            await reply(403, "csrf", "Deze actie is geweigerd. Vernieuw de pagina.")
            return

        limit = UPLOAD_LIMITS.get(path) if method == "POST" else None
        if limit is not None:
            if not self._session_ok(scope, headers):
                await reply(401, "unauthorized", "Log eerst in.")
                return
            length = headers.get(b"content-length")
            if length is not None and (not length.isdigit() or int(length) > limit):
                await reply(413, "too_large", "Dit bestand is te groot.")
                return
            receive = self._limited(receive, limit)

        try:
            await self.app(scope, receive, send_with_headers)
        except BodyTooLarge:
            if not started:
                await reply(413, "too_large", "Dit bestand is te groot.")
        except Exception:
            log.exception("unhandled error on %s %s", method, path)
            if not started:
                await reply(500, "internal", "Er ging iets mis.")

    @staticmethod
    def _limited(receive: Receive, limit: int) -> Receive:
        total = 0

        async def limited() -> Message:
            nonlocal total
            message = await receive()
            if message["type"] == "http.request":
                total += len(message.get("body", b""))
                if total > limit:
                    raise BodyTooLarge()
            return message

        return limited

    @staticmethod
    def _session_ok(scope: Scope, headers: dict[bytes, bytes]) -> bool:
        token = _cookie(headers, SESSION_COOKIE)
        if not token:
            return False
        app = scope.get("app")
        path = getattr(getattr(app, "state", None), "db_path", None)
        if not path:
            return False
        conn = db.connect(path)
        try:
            return auth.session_valid(conn, token)
        finally:
            conn.close()
