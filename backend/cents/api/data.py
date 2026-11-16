"""Export, backup, restore, reclassify and deleting all data."""

from __future__ import annotations

import csv
import io
import json
import logging
import os
import sqlite3
import tempfile
from pathlib import Path

from fastapi import APIRouter, Depends, Request
from fastapi.responses import FileResponse, Response
from python_multipart import MultipartParser
from python_multipart.exceptions import MultipartParseError
from python_multipart.multipart import parse_options_header
from starlette.background import BackgroundTask

from .. import auth, db
from ..classify import engine
from ..config import MAX_RESTORE_BYTES
from ..errors import ApiError
from ..schemas import PasswordBody
from ..services import imports as import_service
from ..services import cache, periods
from .deps import get_conn

router = APIRouter()
log = logging.getLogger("cents.restore")

FORMULA_START = ("=", "+", "-", "@", "\t", "\r")


def _euro(cents: int) -> str:
    sign = "-" if cents < 0 else ""
    cents = abs(cents)
    return f"{sign}{cents // 100},{cents % 100:02d}"


def _cell(text: str | None) -> str:
    """Text cell that a spreadsheet will not run as a formula (CSV injection)."""
    text = text or ""
    return "'" + text if text.startswith(FORMULA_START) else text


@router.get("/export/transactions.csv")
def export_csv(conn: sqlite3.Connection = Depends(get_conn)) -> Response:
    out = io.StringIO()
    writer = csv.writer(out, delimiter=";", lineterminator="\r\n")
    writer.writerow(["datum", "rekening", "iban", "bedrag", "naam", "omschrijving", "bakje",
                     "tags", "notitie", "betaalwijze", "tegenrekening", "soort", "handmatig"])
    rows = db.rows(conn, """
        SELECT t.*, a.name AS account_name, a.iban AS account_iban, c.name AS category_name,
               (SELECT GROUP_CONCAT(g.name, ', ') FROM transaction_tags tt JOIN tags g ON g.id = tt.tag_id
                WHERE tt.transaction_id = t.id) AS tag_names
        FROM transactions t JOIN accounts a ON a.id = t.account_id
        LEFT JOIN categories c ON c.id = t.category_id ORDER BY t.date, t.id""")
    for r in rows:
        writer.writerow([r["date"], _cell(r["account_name"]), _cell(r["account_iban"]),
                         _euro(r["amount_cents"]),            # the amount is never prefixed
                         _cell(r["merchant_name"]), _cell(r["description"]), _cell(r["category_name"]),
                         _cell(r["tag_names"]), _cell(r["note"]), _cell(r["method"]),
                         _cell(r["counterparty_iban"]), r["kind"], "ja" if r["manual"] else "nee"])
    filename = f"cents-transacties-{periods.today().isoformat()}.csv"
    return Response("\ufeff" + out.getvalue(), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{filename}"'})


@router.get("/export/backup")
def export_backup(request: Request, conn: sqlite3.Connection = Depends(get_conn)) -> FileResponse:
    """A consistent, self-contained copy without login sessions (the password hash stays, so a
    backup can be restored on a fresh install)."""
    directory = Path(request.app.state.db_path).parent
    fd, tmp = tempfile.mkstemp(prefix="backup-", suffix=".db", dir=directory)
    os.close(fd)
    target = sqlite3.connect(tmp)
    try:
        conn.backup(target)
        target.execute("DELETE FROM sessions")
        target.commit()
        target.execute("PRAGMA journal_mode = DELETE")
        target.execute("VACUUM")                       # no session hashes left in free pages
    finally:
        target.close()
    filename = f"cents-backup-{periods.today().isoformat()}.db"
    return FileResponse(tmp, media_type="application/vnd.sqlite3", filename=filename,
                        background=BackgroundTask(os.unlink, tmp))


# ---------------------------------------------------------------- restore

def _bad(message: str = "Dit is geen geldige Cents-back-up.") -> ApiError:
    return ApiError(400, "bad_backup", message)


async def _receive_backup(request: Request, target: str) -> None:
    """Stream the uploaded file straight into `target` (one copy on disk). Accepts multipart
    (field `file`, as before) or a raw body."""
    ctype, options = parse_options_header(request.headers.get("content-type", ""))
    size = 0
    with open(target, "wb") as fh:
        def write(data: bytes) -> None:
            nonlocal size
            size += len(data)
            if size > MAX_RESTORE_BYTES:
                raise ApiError(413, "too_large", "Deze back-up is te groot.")
            fh.write(data)

        if ctype != b"multipart/form-data":
            async for chunk in request.stream():
                write(chunk)
            return
        boundary = options.get(b"boundary")
        if not boundary:
            raise _bad()
        part: dict = {"headers": {}, "field": b"", "value": b"", "is_file": False, "done": False}

        def on_part_begin() -> None:
            part.update(headers={}, field=b"", value=b"", is_file=False)

        def on_header_field(data: bytes, start: int, end: int) -> None:
            part["field"] += data[start:end]

        def on_header_value(data: bytes, start: int, end: int) -> None:
            part["value"] += data[start:end]

        def on_header_end() -> None:
            part["headers"][part["field"].lower()] = part["value"]
            part["field"], part["value"] = b"", b""

        def on_headers_finished() -> None:
            _, disp = parse_options_header(part["headers"].get(b"content-disposition", b""))
            part["is_file"] = disp.get(b"name") == b"file" and not part["done"]

        def on_part_data(data: bytes, start: int, end: int) -> None:
            if part["is_file"]:
                write(data[start:end])

        def on_part_end() -> None:
            if part["is_file"]:
                part["done"], part["is_file"] = True, False

        parser = MultipartParser(boundary, {
            "on_part_begin": on_part_begin, "on_header_field": on_header_field,
            "on_header_value": on_header_value, "on_header_end": on_header_end,
            "on_headers_finished": on_headers_finished, "on_part_data": on_part_data,
            "on_part_end": on_part_end})
        try:
            async for chunk in request.stream():
                parser.write(chunk)
            parser.finalize()
        except MultipartParseError:
            raise _bad() from None
        if not part["done"]:
            raise _bad("Kies een back-upbestand.")


def _reference_columns(version: int) -> dict[str, set[str]]:
    """Tables and columns of a fresh database migrated up to `version`."""
    ref = sqlite3.connect(":memory:")
    try:
        for script in db.MIGRATIONS[:version]:
            ref.executescript(script)
        return {t: {c[1] for c in ref.execute(f"PRAGMA table_info({t})")}
                for (t,) in ref.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    finally:
        ref.close()


def _validate_backup(path: str, live_page_size: int) -> None:
    with open(path, "rb") as fh:
        if fh.read(16) != b"SQLite format 3\x00":
            raise _bad()
    try:
        src = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        try:
            if [r[0] for r in src.execute("PRAGMA integrity_check")] != ["ok"]:
                raise _bad("Deze back-up is beschadigd.")
            version = src.execute("PRAGMA user_version").fetchone()[0]
            if version > db.SCHEMA_VERSION:
                raise _bad("Deze back-up komt uit een nieuwere versie van Cents.")
            if version < 1:
                raise _bad()
            objects = src.execute("SELECT type, name, sql FROM sqlite_master").fetchall()
            if any(t in ("trigger", "view") for t, _, _ in objects) or \
                    any(t == "table" and "VIRTUAL" in (sql or "").upper() for t, _, sql in objects):
                raise _bad()
            tables = {n for t, n, _ in objects if t == "table" and not n.startswith("sqlite_")}
            reference = _reference_columns(version)
            if tables != set(reference):
                raise _bad()
            for table, columns in reference.items():
                if {c[1] for c in src.execute(f"PRAGMA table_info({table})")} != columns:
                    raise _bad()
            if src.execute("PRAGMA page_size").fetchone()[0] != live_page_size:
                raise _bad("Deze back-up kan ik niet terugzetten.")
            hashed = src.execute("SELECT value FROM settings WHERE key = ?", (auth.PASSWORD_KEY,)).fetchone()
            if not hashed or not json.loads(hashed[0] or "null"):
                raise _bad("Deze back-up heeft geen wachtwoord en wordt niet teruggezet.")
        finally:
            src.close()
    except sqlite3.Error:
        raise _bad("Deze back-up is beschadigd.") from None
    except ValueError:
        raise _bad() from None


def _save_pre_restore(conn: sqlite3.Connection, db_path: str) -> str:
    """Copy the live database to cents.db.pre-restore (only the latest one is kept)."""
    final = db_path + ".pre-restore"
    tmp = final + ".tmp"
    target = sqlite3.connect(tmp)
    try:
        conn.backup(target)
    finally:
        target.close()
    os.replace(tmp, final)
    return final


@router.post("/restore")
async def restore(request: Request, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    db_path = request.app.state.db_path
    directory = Path(db_path).parent
    fd, tmp = tempfile.mkstemp(prefix="restore-", suffix=".db", dir=directory)
    os.close(fd)
    try:
        await _receive_backup(request, tmp)
        live_page_size = conn.execute("PRAGMA page_size").fetchone()[0]
        _validate_backup(tmp, live_page_size)

        # what must survive the swap: the live password and the live sessions
        live_hash = db.value(conn, "SELECT value FROM settings WHERE key = ?", (auth.PASSWORD_KEY,))
        live_sessions = conn.execute("SELECT token_hash, created_at, expires_at FROM sessions").fetchall()
        conn.commit()
        pre_restore = _save_pre_restore(conn, db_path)
        src = sqlite3.connect(f"file:{tmp}?mode=ro", uri=True)
        try:
            src.backup(conn)
        except sqlite3.Error:
            log.exception("restore copy failed, putting the previous database back")
            back = sqlite3.connect(pre_restore)
            try:
                back.backup(conn)
            finally:
                back.close()
            raise _bad("Deze back-up kan ik niet terugzetten. Er is niets veranderd.") from None
        finally:
            src.close()

        db.migrate(conn)
        db.seed_categories(conn)
        if live_hash:
            conn.execute("INSERT INTO settings (key, value) VALUES (?, ?) "
                         "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                         (auth.PASSWORD_KEY, live_hash))
        conn.execute("DELETE FROM sessions")
        conn.executemany("INSERT INTO sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)",
                         [tuple(r) for r in live_sessions])
        import_service.refresh_accounts(conn)
        engine.classify_all(conn)
        cache.clear()           # the after_write hook also gives the database a new state token
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    return {"ok": True, "transactions": db.value(conn, "SELECT COUNT(*) FROM transactions")}


@router.post("/reclassify")
def reclassify(conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    renormalized = import_service.renormalize_all(conn)
    import_service.refresh_accounts(conn)
    changed = engine.classify_all(conn)
    return {"ok": True, "updated_count": changed, "renormalized": renormalized}


@router.delete("/data")
def delete_data(body: PasswordBody, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    if not auth.check_password(conn, body.password):
        raise ApiError(400, "wrong_password", "Dat wachtwoord klopt niet.")
    for table in ("transaction_tags", "goal_entries", "transactions", "trades", "cash_events",
                  "prices", "imports", "rules", "tags", "goals", "account_values",
                  "recurring_ignored", "accounts", "securities"):
        conn.execute(f"DELETE FROM {table}")
    conn.execute("DELETE FROM settings WHERE key IN ('dismissed_suggestions', '_prices_status')")
    return {"ok": True}
