"""Errors raised by the read layer.

Kept separate so tests can assert on them without importing the reader.
"""

from __future__ import annotations


class ReaderError(Exception):
    """Base class for every failure in this package."""

    code = "reader_error"

    def __init__(self, message: str, code: str | None = None):
        super().__init__(message)
        if code:
            self.code = code

    def as_dict(self) -> dict[str, str]:
        return {"code": self.code, "message": str(self)}


class KeyNotFound(ReaderError):
    """No key in the key store matches the database's salt."""

    code = "key_not_found"


class DatabaseLocked(ReaderError):
    """WeChat holds an exclusive lock that even a read connection cannot pass."""

    code = "database_locked"


class SchemaMismatch(ReaderError):
    """A required table or column is missing from the database."""

    code = "schema_mismatch"


class DriverUnavailable(ReaderError):
    """The SQLCipher driver needed to open an encrypted database is missing."""

    code = "driver_unavailable"


class ChatNotFound(ReaderError):
    """The requested chat has no message table in any shard."""

    code = "chat_not_found"
