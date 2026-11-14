from fastapi.testclient import TestClient

from conftest import PASSWORD


def test_first_run_setup_and_login(anon):
    s = anon.get("/api/session").json()
    assert s["setup_required"] and not s["authenticated"] and s["version"]
    assert anon.get("/api/bootstrap").status_code == 401
    r = anon.post("/api/setup", json={"password": "kort"})
    assert r.status_code == 400 and r.json()["error"]["code"] == "password_too_short"
    assert anon.post("/api/setup", json={"password": PASSWORD}).status_code == 200
    assert anon.get("/api/session").json() == {"setup_required": False, "authenticated": True,
                                               "version": s["version"]}
    assert anon.post("/api/setup", json={"password": "nog-een-keer"}).status_code == 409
    assert anon.get("/api/bootstrap").status_code == 200
    assert anon.post("/api/logout").status_code == 200
    assert anon.get("/api/bootstrap").status_code == 401
    assert anon.post("/api/login", json={"password": PASSWORD}).status_code == 200
    assert anon.get("/api/bootstrap").status_code == 200


def test_cookie_flags(anon):
    r = anon.post("/api/setup", json={"password": PASSWORD})
    cookie = r.headers["set-cookie"].lower()
    assert "cents_session=" in cookie and "httponly" in cookie and "samesite=lax" in cookie
    assert "secure" not in cookie and "max-age=15552000" in cookie


def test_csrf_header_required(client):
    bare = TestClient(client.app, cookies=client.cookies)
    r = bare.post("/api/tags", json={"name": "Zonder header"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "csrf"
    assert bare.post("/api/login", json={"password": PASSWORD}).status_code == 403
    assert bare.get("/api/tags").status_code == 200          # reads need no header
    assert client.post("/api/tags", json={"name": "Met header"}).status_code == 200


def test_login_rate_limit(client):
    client.post("/api/logout")
    for _ in range(5):
        r = client.post("/api/login", json={"password": "fout-wachtwoord"})
        assert r.status_code == 401 and r.json()["error"]["message"]
    r = client.post("/api/login", json={"password": PASSWORD})
    assert r.status_code == 429 and r.json()["error"]["code"] == "too_many_attempts"


def test_change_password(client):
    r = client.post("/api/password", json={"current": "fout", "new": "nieuw-wachtwoord"})
    assert r.status_code == 400
    assert client.post("/api/password", json={"current": PASSWORD, "new": "nieuw-wachtwoord"}).status_code == 200
    client.post("/api/logout")
    assert client.post("/api/login", json={"password": PASSWORD}).status_code == 401
    assert client.post("/api/login", json={"password": "nieuw-wachtwoord"}).status_code == 200


def test_security_headers_and_errors(client):
    r = client.get("/api/healthz")
    assert r.json() == {"ok": True}
    assert r.headers["content-security-policy"].startswith("default-src 'self'")
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["referrer-policy"] == "no-referrer"
    r = client.get("/api/does-not-exist")
    assert r.status_code == 404 and r.json()["error"]["code"] == "not_found"
    r = client.post("/api/tags", json={})
    assert r.status_code == 422 and "error" in r.json()
    home = client.get("/")
    assert home.status_code == 200 and "Cents" in home.text


def test_static_frontend_served(tmp_path):
    from cents.main import create_app
    front = tmp_path / "frontend"
    front.mkdir()
    (front / "index.html").write_text("<!doctype html><title>Cents</title>hallo")
    with TestClient(create_app(data_dir=tmp_path / "data", frontend_dir=front)) as c:
        r = c.get("/")
        assert r.status_code == 200 and "hallo" in r.text
        assert c.get("/api/healthz").json() == {"ok": True}
