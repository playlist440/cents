"""POST /import, GET /imports, DELETE /imports/{id}."""

from __future__ import annotations

import sqlite3
from typing import BinaryIO

from fastapi import APIRouter, Depends, File, UploadFile

from .. import db
from ..config import MAX_IMPORT_FILES, MAX_UPLOAD_BYTES
from ..errors import bad_request, not_found
from ..services import imports as import_service
from .deps import get_conn

router = APIRouter()


def upload_size(upload: UploadFile) -> int:
    """Size of an upload. Starlette has already streamed it to a temporary file."""
    upload.file.seek(0, 2)
    size = upload.file.tell()
    upload.file.seek(0)
    return size


@router.post("/import")
def import_files(files: list[UploadFile] = File(...), investment_account_id: int | None = None,
                 conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    if not files:
        raise bad_request("Kies een bestand.", "no_files")
    if len(files) > MAX_IMPORT_FILES:
        raise bad_request(f"Kies hoogstens {MAX_IMPORT_FILES} bestanden tegelijk.", "too_many_files")
    accepted: list[tuple[str, BinaryIO]] = []
    too_big: list[str] = []
    for upload in files:
        name = upload.filename or "bestand"
        if upload_size(upload) > MAX_UPLOAD_BYTES:
            too_big.append(name)
        else:
            accepted.append((name, upload.file))      # parsed incrementally from disk
    result = import_service.import_files(conn, accepted, investment_account_id=investment_account_id)
    limit_mb = MAX_UPLOAD_BYTES // (1024 * 1024)
    for name in too_big:
        result["files"].append(import_service.empty_result(
            name, f"Dit bestand is groter dan {limit_mb} MB."))
    return result


@router.get("/imports")
def list_imports(conn: sqlite3.Connection = Depends(get_conn)) -> list[dict]:
    return db.rows(conn, """
        SELECT i.id, i.filename, i.format, i.imported_at, i.account_id, a.name AS account_name,
               i.n_new, i.n_duplicate, i.n_enriched, i.date_from, i.date_to,
               (SELECT COUNT(*) FROM transactions t WHERE t.import_id = i.id) AS n_transactions
        FROM imports i LEFT JOIN accounts a ON a.id = i.account_id
        ORDER BY i.imported_at DESC, i.id DESC
    """)


@router.delete("/imports/{import_id}")
def delete_import(import_id: int, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    n = import_service.delete_import(conn, import_id)
    if n is None:
        raise not_found("Deze import bestaat niet (meer).")
    return {"ok": True, "deleted": n}

