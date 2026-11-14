"""Runtime configuration. No environment variable is required."""

from __future__ import annotations

import os
from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parent
LIBRARY_DIR = PACKAGE_DIR / "data"
DEFAULT_FRONTEND_DIR = PACKAGE_DIR.parent.parent / "frontend"

TIMEZONE = "Europe/Amsterdam"
SESSION_COOKIE = "cents_session"
SESSION_DAYS = 180
MAX_UPLOAD_BYTES = 250 * 1024 * 1024
MAX_RESTORE_BYTES = 500 * 1024 * 1024
MAX_IMPORT_REQUEST_BYTES = 1024 * 1024 * 1024     # all files of one import request together
MAX_IMPORT_FILES = 20
LOGIN_MAX_FAILURES = 5
LOGIN_WINDOW_SECONDS = 300


def data_dir() -> Path:
    return Path(os.environ.get("CENTS_DATA_DIR", "/data"))


def frontend_dir() -> Path:
    return Path(os.environ.get("CENTS_FRONTEND_DIR", str(DEFAULT_FRONTEND_DIR)))
