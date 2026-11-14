"""GET /healthz (no session needed)."""

from __future__ import annotations

from fastapi import APIRouter

public_router = APIRouter()


@public_router.get("/healthz")
def healthz() -> dict:
    return {"ok": True}
