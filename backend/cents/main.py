"""App factory: API routers under /api, the static frontend at /, security headers, CSRF guard.

Run: uvicorn cents.main:app --app-dir backend
"""

from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager, suppress
from pathlib import Path

from fastapi import Depends, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import VERSION, auth, config, db
from .api import PROTECTED_ROUTERS, PUBLIC_ROUTERS
from .api.deps import require_session
from .guard import Guard
from .errors import ApiError
from .services import prices

log = logging.getLogger("cents")

STATUS_CODES = {400: "bad_request", 401: "unauthorized", 403: "forbidden", 404: "not_found",
                405: "method_not_allowed", 409: "conflict", 413: "too_large", 429: "too_many_requests"}
STATUS_MESSAGES = {404: "Niet gevonden.", 405: "Dat kan hier niet.", 413: "Dit bestand is te groot."}

PLACEHOLDER = """<!doctype html><html lang="nl"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Cents</title>
<body style="font-family:-apple-system,system-ui,sans-serif;display:grid;place-items:center;
min-height:90vh;color:#444"><p>Cents draait. De app zelf staat nog niet klaar.</p></body></html>"""


def error_response(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse({"error": {"code": code, "message": message}}, status_code=status)


def create_app(data_dir: str | Path | None = None, frontend_dir: str | Path | None = None,
               price_task: bool | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        directory = Path(data_dir) if data_dir else config.data_dir()
        app.state.db_path = str(directory / "cents.db")
        db.init_db(app.state.db_path)
        task = None
        if price_task if price_task is not None else os.environ.get("CENTS_PRICE_TASK", "1") != "0":
            task = asyncio.create_task(prices.daily_task(app.state.db_path))
        try:
            yield
        finally:
            if task:
                task.cancel()
                with suppress(asyncio.CancelledError, Exception):
                    await task

    app = FastAPI(title="Cents", version=VERSION, lifespan=lifespan, docs_url=None,
                  redoc_url=None, openapi_url=None)
    app.state.login_limiter = auth.LoginLimiter()

    @app.exception_handler(ApiError)
    async def api_error(_: Request, exc: ApiError):
        return error_response(exc.status, exc.code, exc.message)

    @app.exception_handler(StarletteHTTPException)
    async def http_error(_: Request, exc: StarletteHTTPException):
        message = STATUS_MESSAGES.get(exc.status_code, "Dat lukte niet.")
        return error_response(exc.status_code, STATUS_CODES.get(exc.status_code, "error"), message)

    @app.exception_handler(RequestValidationError)
    async def validation_error(_: Request, exc: RequestValidationError):
        log.info("validation error: %s", exc.errors())
        return error_response(422, "invalid", "Deze invoer klopt niet.")

    @app.exception_handler(OverflowError)
    async def overflow(_: Request, exc: OverflowError):
        return error_response(400, "number_too_large", "Dit getal is te groot.")

    @app.exception_handler(Exception)
    async def unexpected(_: Request, exc: Exception):
        log.exception("unexpected error", exc_info=exc)
        return error_response(500, "internal", "Er ging iets mis.")

    for router in PUBLIC_ROUTERS:
        app.include_router(router, prefix="/api")
    for router in PROTECTED_ROUTERS:
        app.include_router(router, prefix="/api", dependencies=[Depends(require_session)])

    @app.api_route("/api/{rest:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
                   include_in_schema=False)
    async def api_not_found(rest: str):
        raise ApiError(404, "not_found", "Niet gevonden.")

    # outermost: runs before routing and before any body is read
    app.add_middleware(Guard)

    static = Path(frontend_dir) if frontend_dir else config.frontend_dir()
    if (static / "index.html").exists():
        app.mount("/", StaticFiles(directory=str(static), html=True), name="frontend")
    else:
        @app.get("/", include_in_schema=False)
        async def placeholder() -> HTMLResponse:
            return HTMLResponse(PLACEHOLDER)

    return app


app = create_app()
