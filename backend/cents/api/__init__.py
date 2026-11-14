"""All API routers. To add one: create `api/<name>.py` with `router = APIRouter()` and append
it below. PUBLIC routers need no session; every other router requires one."""

from __future__ import annotations

from fastapi import APIRouter

from . import (accounts, bootstrap, calendar, categories, data, goals, health, imports, networth, overview,
               recap, recurring, rules, session, settings, smart, sort, tags, transactions)

PUBLIC_ROUTERS: list[APIRouter] = [session.public_router, health.public_router]

PROTECTED_ROUTERS: list[APIRouter] = [
    session.router,
    bootstrap.router,
    imports.router,
    transactions.router,
    sort.router,
    categories.router,
    tags.router,
    rules.router,
    accounts.router,
    settings.router,
    data.router,
    # analytics
    overview.router,
    recurring.router,
    smart.router,           # before goals: DELETE /goals/links vs /goals/{id}
    goals.router,
    networth.router,
    calendar.router,
    recap.router,
]
