"""One error type for the whole API: {"error": {"code", "message"}} with a Dutch message."""

from __future__ import annotations


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def not_found(message: str = "Niet gevonden.") -> ApiError:
    return ApiError(404, "not_found", message)


def bad_request(message: str, code: str = "bad_request") -> ApiError:
    return ApiError(400, code, message)
