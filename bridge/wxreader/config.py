"""Configuration and key store for the read layer.

The reader consumes authorization material that already exists on the machine.
It never extracts keys, never scans a process, and never writes to a WeChat
database.

Two files are read:

``config.json``
    Paths to the encrypted databases plus the wxid of the logged-in account.
    The layout matches the config already produced by rion-wechat-cli, so an
    existing installation can be reused as-is.

``keys.json``
    Two accepted shapes:

    * ``{"salt_keys": {"<salt hex>": {"key": "<96 hex>"}}}`` — salt addressed,
      which is what rion-wechat-cli writes;
    * ``{"<salt hex>": {"key": "<96 hex>"}}`` — the same map without the
      wrapper, accepted so either file works unchanged.

    The stored value is ``enc_key(64 hex) + salt(32 hex)``, i.e. a 96 hex
    SQLCipher raw key.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path

from .errors import KeyNotFound, ReaderError

PLAINTEXT_HEADER = b"SQLite format 3\x00"
SALT_BYTES = 16
ENC_KEY_HEX = 64
RAW_KEY_HEX = 96


def database_salt(path: str | os.PathLike[str]) -> str:
    """Return the 32 hex salt of an encrypted database, or "" when plaintext.

    WeChat's SQLCipher databases keep the first 16 bytes unencrypted so a tool
    can identify the key that belongs to the file. A file that starts with the
    ordinary SQLite header is not encrypted and needs no key.
    """
    try:
        with open(path, "rb") as handle:
            head = handle.read(SALT_BYTES)
    except OSError:
        return ""
    if len(head) < SALT_BYTES or head == PLAINTEXT_HEADER:
        return ""
    return head.hex()


def _extract_key(entry: object) -> str:
    if isinstance(entry, str):
        return entry.strip()
    if isinstance(entry, dict):
        for field_name in ("key", "enc_key", "raw_key"):
            value = entry.get(field_name)
            if isinstance(value, str) and value.strip():
                return value.strip()
    return ""


@dataclass
class KeyStore:
    """Maps a database file to the SQLCipher raw key that opens it."""

    salt_keys: dict[str, str] = field(default_factory=dict)
    path_keys: dict[str, str] = field(default_factory=dict)

    @classmethod
    def load(cls, path: str | os.PathLike[str]) -> "KeyStore":
        with open(path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
        if not isinstance(payload, dict):
            raise ReaderError(
                "key file must contain a JSON object", "invalid_key_file"
            )

        salt_map: dict[str, str] = {}
        path_map: dict[str, str] = {}

        # salt addressed: either wrapped, or the whole file is the salt map
        salt_source = payload.get("salt_keys")
        if not isinstance(salt_source, dict):
            salt_source = payload
        for salt, entry in salt_source.items():
            if not isinstance(salt, str):
                continue
            key = _extract_key(entry)
            if key:
                salt_map[salt.lower()] = key

        # path addressed: kept for completeness, rarely used on Windows
        for name in ("path_keys", "files", "databases"):
            block = payload.get(name)
            if isinstance(block, dict):
                for file_path, entry in block.items():
                    key = _extract_key(entry)
                    if key:
                        path_map[str(file_path)] = key

        return cls(salt_keys=salt_map, path_keys=path_map)

    def key_for(self, path: str | os.PathLike[str]) -> str | None:
        """Return the raw key for ``path``, or None when it is plaintext."""
        text = str(path)
        for candidate in (text, os.path.abspath(text), os.path.basename(text)):
            key = self.path_keys.get(candidate)
            if key:
                return key
        salt = database_salt(path)
        if not salt:
            return None
        return self.salt_keys.get(salt)

    def require_key(self, path: str | os.PathLike[str]) -> str:
        key = self.key_for(path)
        if key:
            return key
        if not database_salt(path):
            raise KeyNotFound(
                "database is plaintext but a key was required: %s" % path,
                "unexpected_plaintext_database",
            )
        raise KeyNotFound(
            "no key matches the salt of %s; the key store is out of date"
            % os.path.basename(str(path))
        )


@dataclass
class ReaderConfig:
    """Where the databases live and which account is signed in."""

    session_db: str = ""
    contact_db: str = ""
    message_dbs: list[str] = field(default_factory=list)
    keys_file: str = ""
    self_username: str = ""
    self_display_name: str = ""
    db_root: str = ""
    extra: dict = field(default_factory=dict)

    @classmethod
    def load(cls, path: str | os.PathLike[str]) -> "ReaderConfig":
        with open(path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
        if not isinstance(payload, dict):
            raise ReaderError(
                "config must contain a JSON object", "invalid_config"
            )
        message_dbs = payload.get("message_dbs") or []
        if not isinstance(message_dbs, list):
            message_dbs = []
        known = {
            "session_db",
            "contact_db",
            "message_dbs",
            "keys_file",
            "self_username",
            "self_display_name",
            "db_root",
        }
        return cls(
            session_db=str(payload.get("session_db") or ""),
            contact_db=str(payload.get("contact_db") or ""),
            message_dbs=[str(p) for p in message_dbs if p],
            keys_file=str(payload.get("keys_file") or ""),
            self_username=str(payload.get("self_username") or ""),
            self_display_name=str(payload.get("self_display_name") or ""),
            db_root=str(payload.get("db_root") or ""),
            extra={k: v for k, v in payload.items() if k not in known},
        )

    def resolve_db_root(self) -> str:
        """Best-effort account directory, used for media path lookups."""
        if self.db_root:
            return self.db_root
        for candidate in (self.session_db, self.contact_db, *self.message_dbs):
            if not candidate:
                continue
            parent = Path(candidate).parent
            if parent.name == "db_storage":
                return str(parent.parent)
            return str(parent.parent)
        return ""

    def missing_files(self) -> list[str]:
        wanted = [p for p in (self.session_db, self.contact_db, *self.message_dbs) if p]
        return [p for p in wanted if not os.path.exists(p)]

    def default_paths() -> dict[str, str]:  # pragma: no cover - convenience only
        home = Path(os.environ.get("USERPROFILE") or os.path.expanduser("~"))
        return {
            "config": str(home / ".config" / "rion-wechat-reader" / "config.json"),
            "keys": str(home / ".config" / "rion-wechat-reader" / "keys.json"),
        }
