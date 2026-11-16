from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).parent))

from cents import db  # noqa: E402
from cents.classify.library import Library, set_library  # noqa: E402
from cents.main import create_app  # noqa: E402
from helpers import tiny_library  # noqa: E402

PASSWORD = "test-wachtwoord"


os.environ["CENTS_PRICE_TASK"] = "0"       # no background price task in tests


@pytest.fixture(autouse=True)
def no_network():
    """Tests never reach the internet: the price provider and FX source are offline."""
    from cents.services import prices
    old_provider, old_fx = prices.PROVIDER, prices.FX_SOURCE
    prices.set_provider(prices.OfflineProvider())

    def no_fx(start):
        raise prices.OfflineError("offline")
    prices.FX_SOURCE = no_fx
    yield
    prices.set_provider(old_provider)
    prices.FX_SOURCE = old_fx


@pytest.fixture(autouse=True)
def library():
    """Every test runs with the tiny inline library (never the real data files)."""
    lib = tiny_library()
    set_library(lib)
    yield lib
    set_library(Library())


@pytest.fixture
def conn(tmp_path):
    path = tmp_path / "cents.db"
    db.init_db(path)
    c = db.connect(path)
    yield c
    c.close()


@pytest.fixture
def anon(tmp_path):
    app = create_app(data_dir=tmp_path, frontend_dir=tmp_path / "no-frontend")
    with TestClient(app, headers={"X-Cents": "1"}) as client:
        yield client


@pytest.fixture
def client(anon):
    r = anon.post("/api/setup", json={"password": PASSWORD})
    assert r.status_code == 200, r.text
    return anon


def upload(client, *files: tuple[str, str | bytes]):
    payload = [("files", (name, body.encode("utf-8") if isinstance(body, str) else body, "text/plain"))
               for name, body in files]
    r = client.post("/api/import", files=payload)
    assert r.status_code == 200, r.text
    return r.json()
