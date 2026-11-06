"""Read-only access to the encrypted WeChat databases.

Design rules this module follows, each one paid for by a measured failure:

* **Never construct the database object that scans process memory.** Keys come
  only from the key store. Opening is a plain SQLCipher connection.
* **``local_id`` alone is not a key.** ``(chat, shard, local_id)`` is. One chat
  can span several shards and ``local_id`` repeats across them.
* **Resolve senders per shard.** ``real_sender_id`` is a rowid into that shard's
  own ``Name2Id`` table. The same small integer names different people in
  different shards (measured: 369 shared rowids, all diverging).
* **Poll with ``>=``, not ``>``.** Rows sharing a ``sort_seq`` would otherwise
  become permanently invisible once the watermark sits on that value.
* **Filter dates here.** The database has no date index predicate in the helper
  API, so the layer translates dates into ``create_time`` bounds itself.
"""

from __future__ import annotations

import hashlib
import os
import re
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from typing import Any, Iterator

from . import codec
from .config import KeyStore, ReaderConfig, database_salt
from .errors import (
    ChatNotFound,
    DatabaseLocked,
    KeyNotFound,
    ReaderError,
    SchemaMismatch,
)
from .mentions import RelationReport, detect_relation, parse_at_user_list
from .models import Chat, Message, MessageKey, Page

# Chronology is (sort_seq, local_id); the tie-break is what keeps ordering
# stable when several rows share a second.
ORDER_ASC = "ORDER BY sort_seq ASC, local_id ASC"
ORDER_DESC = "ORDER BY sort_seq DESC, local_id ASC"

CST = timezone(timedelta(hours=8))

# ``local_type`` packs two numbers: the low 32 bits are the base type, the high
# 32 bits carry the ``<appmsg><type>`` subtype for app messages. Measured on this
# build: 21474836529 == (5 << 32) | 49.
_TYPE_MASK = 0xFFFFFFFF

# Base types that carry no readable body. Keeping the names here means the UI
# never has to interpret a raw integer.
_KIND_BY_TYPE = {
    1: "text",
    3: "image",
    34: "voice",
    37: "friend_request",
    42: "contact_card",
    43: "video",
    47: "sticker",
    48: "location",
    49: "app",
    50: "voip",
    10000: "system",
    10002: "system",
}

# ``<appmsg>`` subtypes worth naming; every other one stays "app".
_APPMSG_KIND = {
    1: "text_card",
    3: "music",
    5: "link",
    6: "file",
    8: "sticker",
    17: "location_share",
    19: "chat_record",
    33: "mini_program",
    36: "mini_program",
    57: "quote",
    62: "pat",
    74: "file",
    2000: "transfer",
    2001: "red_packet",
}


def base_type(local_type: int) -> int:
    """The base message type, with the app-message subtype bits removed."""
    return int(local_type or 0) & _TYPE_MASK


def kind_of(local_type: int) -> str:
    value = int(local_type or 0)
    base = value & _TYPE_MASK
    if base == 49:
        return _APPMSG_KIND.get(value >> 32, "app")
    return _KIND_BY_TYPE.get(base, "type_%d" % base)


def shard_label(path: str) -> str:
    """Short shard name used inside message keys.

    The database directory name is included because WeChat nests message
    databases one level down and two shards can otherwise compare equal.
    """
    parent = os.path.basename(os.path.dirname(path))
    return "%s__%s" % (parent, os.path.basename(path))


def table_for(chat: str) -> str:
    """Message table name for a chat: ``Msg_`` plus md5 of the username."""
    return "Msg_" + hashlib.md5(chat.encode("utf-8")).hexdigest()


def epoch_to_local(value: int) -> datetime:
    return datetime.fromtimestamp(int(value), CST)


def local_date_to_epoch(text: str, end_of_day: bool = False) -> int:
    """Convert ``YYYY-MM-DD`` (or an ISO string) to an epoch second.

    The upper bound of a day is inclusive, so a caller asking for
    ``before=2026-10-27`` gets everything up to and including that day.
    """
    raw = str(text).strip()
    if not raw:
        return 0
    for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S"):
        try:
            moment = datetime.strptime(raw, fmt).replace(tzinfo=CST)
        except ValueError:
            continue
        if fmt in ("%Y-%m-%d", "%Y/%m/%d") and end_of_day:
            moment = moment.replace(hour=23, minute=59, second=59)
        return int(moment.timestamp())
    try:
        moment = datetime.fromisoformat(raw)
    except ValueError:
        raise ReaderError(
            "unrecognised date %r; use YYYY-MM-DD" % text, "invalid_date"
        ) from None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=CST)
    return int(moment.timestamp())


class DatabasePool:
    """Opens the encrypted databases read-only, caching connections."""

    def __init__(self, config: ReaderConfig, keys: KeyStore):
        self.config = config
        self.keys = keys
        self._driver: Any = None
        self._connections: dict[str, Any] = {}
        self._shards: dict[str, str] = {}
        self._shard_paths: dict[str, str] = {}
        self._name2id: dict[str, dict[int, str]] = {}
        self._table_owner: dict[str, str] = {}

    # -- driver ---------------------------------------------------------
    def driver(self) -> Any:
        if self._driver is not None:
            return self._driver
        codec.require_driver()
        try:
            from sqlcipher3 import dbapi2 as driver
        except ImportError:  # pragma: no cover - fallback driver
            from pysqlcipher3 import dbapi2 as driver
        self._driver = driver
        return driver

    # -- connections ----------------------------------------------------
    def open(self, path: str) -> Any:
        if path in self._connections:
            return self._connections[path]
        if not os.path.exists(path):
            raise ReaderError(
                "database is missing: %s" % os.path.basename(path),
                "database_missing",
            )
        driver = self.driver()
        # Decide on the key before connecting. An encrypted file opened with no
        # key fails later with "file is not a database", which says nothing
        # about the actual cause; naming the missing key up front is actionable.
        key = self.keys.key_for(path)
        if key is None and database_salt(path):
            raise KeyNotFound(
                "no key matches the salt of %s; the key store is out of date"
                % os.path.basename(path)
            )
        try:
            conn = driver.connect(path)
        except Exception as exc:  # pragma: no cover - driver specific
            raise DatabaseLocked(
                "cannot open %s: %s" % (os.path.basename(path), exc),
                "database_locked",
            ) from None
        # Rows are addressed by column name throughout this module; without a
        # Row factory every subscript raises TypeError.
        try:
            conn.row_factory = driver.Row
        except Exception:
            pass
        try:
            if key:
                conn.execute('PRAGMA key = "x\'%s\'"' % key)
            conn.execute("PRAGMA query_only = ON")
            # Touch the schema so a wrong key fails here, with a clear message,
            # rather than on some later query with a confusing error.
            conn.execute(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' LIMIT 1"
            ).fetchone()
        except Exception as exc:
            conn.close()
            raise ReaderError(
                "cannot read %s (wrong or missing key): %s"
                % (os.path.basename(path), exc),
                "open_failed",
            ) from None
        self._connections[path] = conn
        return conn

    @contextmanager
    def session(self) -> Iterator[Any]:
        yield self.open(self.config.session_db)

    @contextmanager
    def contact(self) -> Iterator[Any]:
        yield self.open(self.config.contact_db)

    def close(self) -> None:
        for path, conn in list(self._connections.items()):
            try:
                conn.close()
            except Exception:
                pass
            self._connections.pop(path, None)

    # -- shards ---------------------------------------------------------
    def shard_paths(self) -> dict[str, str]:
        """Map shard label to database path, in config order."""
        if not self._shard_paths:
            for path in self.config.message_dbs:
                if os.path.exists(path):
                    self._shard_paths[shard_label(path)] = path
        return self._shard_paths

    def message_tables(self, shard: str) -> list[str]:
        conn = self.open(self.shard_paths()[shard])
        rows = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'"
        ).fetchall()
        return [str(r[0]) for r in rows]

    def username_for_table(self, shard: str, table: str) -> str:
        """Reverse a ``Msg_<md5>`` table name back to a chat username.

        The digest is one way, so the mapping is built forward from every
        username the databases know about and then inverted once per shard.
        """
        if not self._table_owner:
            self._build_table_owner()
        return self._table_owner.get(table, "")

    def _build_table_owner(self) -> None:
        owners: dict[str, str] = {}
        candidates: set[str] = set()
        try:
            conn = self.open(self.config.session_db)
            for (username,) in conn.execute("SELECT username FROM SessionTable"):
                if username:
                    candidates.add(str(username))
        except Exception:
            pass
        try:
            conn = self.open(self.config.contact_db)
            for (username,) in conn.execute("SELECT username FROM chat_room"):
                if username:
                    candidates.add(str(username))
        except Exception:
            pass
        for username in candidates:
            owners[table_for(username)] = username
        self._table_owner = owners

    def name2id(self, shard: str) -> dict[int, str]:
        """rowid -> username for this shard's own Name2Id table.

        Cached because it is consulted for every message and never changes
        while a poll loop is running.
        """
        if shard in self._name2id:
            return self._name2id[shard]
        mapping: dict[int, str] = {}
        try:
            conn = self.open(self.shard_paths()[shard])
        except (KeyError, ReaderError):
            self._name2id[shard] = mapping
            return mapping
        try:
            columns = [str(r[1]) for r in conn.execute("PRAGMA table_info(Name2Id)")]
        except Exception:
            self._name2id[shard] = mapping
            return mapping
        column = "user_name" if "user_name" in columns else "username"
        if column not in columns:
            self._name2id[shard] = mapping
            return mapping
        try:
            for row in conn.execute(
                'SELECT rowid, "%s" FROM Name2Id' % column
            ).fetchall():
                mapping[int(row[0])] = str(row[1] or "")
        except Exception:
            mapping = {}
        self._name2id[shard] = mapping
        return mapping


class WeChatReader:
    """The read layer's public surface.

    Every method is read-only against WeChat and does not touch the network.
    """

    def __init__(
        self,
        config: ReaderConfig,
        keys: KeyStore,
        pool: DatabasePool | None = None,
    ):
        self.config = config
        self.keys = keys
        self.pool = pool or DatabasePool(config, keys)
        self._self_nickname: str | None = None
        self._display_cache: dict[str, str] = {}

    # -- construction ---------------------------------------------------
    @classmethod
    def from_files(
        cls,
        config_path: str | os.PathLike[str],
        keys_path: str | os.PathLike[str] | None = None,
    ) -> "WeChatReader":
        config = ReaderConfig.load(config_path)
        actual_keys = keys_path or config.keys_file
        if not actual_keys:
            raise ReaderError(
                "config does not name a key file and none was given",
                "missing_keys_file",
            )
        keys = KeyStore.load(actual_keys)
        return cls(config, keys)

    def close(self) -> None:
        self.pool.close()

    def __enter__(self) -> "WeChatReader":
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()

    # -- identity -------------------------------------------------------
    @property
    def self_username(self) -> str:
        return self.config.self_username

    def self_nickname(self) -> str:
        """The signed-in account's own display name.

        Note the column is ``nick_name``, not ``nickname``; reading the wrong
        name yields an empty string and silently disables nickname matching.
        """
        if self._self_nickname is not None:
            return self._self_nickname
        name = self.config.self_display_name
        if not name and self.config.self_username:
            try:
                conn = self.pool.open(self.config.contact_db)
                row = conn.execute(
                    "SELECT nick_name, remark FROM contact WHERE username=? LIMIT 1",
                    (self.config.self_username,),
                ).fetchone()
                if row:
                    name = str(row[0] or row[1] or "")
            except Exception:
                name = ""
        self._self_nickname = name
        return name

    def health(self) -> dict:
        """A compact readiness report, safe to show in a UI."""
        report: dict[str, Any] = {
            "self_username": self.config.self_username,
            "self_nickname_present": bool(self.self_nickname()),
            "message_dbs": len(self.config.message_dbs),
            "missing_files": self.config.missing_files(),
        }
        try:
            codec.require_driver()
            report["driver"] = "ok"
        except Exception as exc:
            report["driver"] = "missing: %s" % exc
        try:
            report["session_chats"] = len(self.list_chats(limit=10000))
        except Exception as exc:
            report["session_chats"] = "error: %s" % exc
        try:
            report["groups"] = len(self.list_groups())
        except Exception as exc:
            report["groups"] = "error: %s" % exc
        try:
            report["shards"] = len(self.pool.shard_paths())
        except Exception as exc:
            report["shards"] = "error: %s" % exc
        return report

    # -- chats ----------------------------------------------------------
    def _contact_name(self, username: str) -> str:
        if username in self._display_cache:
            return self._display_cache[username]
        name = ""
        try:
            conn = self.pool.open(self.config.contact_db)
            row = conn.execute(
                "SELECT nick_name, remark FROM contact WHERE username=? LIMIT 1",
                (username,),
            ).fetchone()
            if row:
                name = str(row[1] or row[0] or "")
        except Exception:
            name = ""
        self._display_cache[username] = name
        return name

    def list_chats(self, limit: int = 200, include_hidden: bool = False) -> list[Chat]:
        """Chats known to the session table, most recent first.

        ``SessionTable.type`` is 0 for every row on this build, so it cannot be
        used to tell groups from direct chats; the ``@chatroom`` suffix is the
        only reliable discriminator.
        """
        conn = self.pool.open(self.config.session_db)
        where = "" if include_hidden else "WHERE is_hidden=0 "
        sql = (
            "SELECT username, summary, last_timestamp, last_sender_display_name "
            "FROM SessionTable " + where + "ORDER BY sort_timestamp DESC LIMIT ?"
        )
        rows = conn.execute(sql, (int(limit),)).fetchall()
        chats: list[Chat] = []
        for username, summary, last_time, last_sender in rows:
            name = str(username or "")
            if not name:
                continue
            chats.append(
                Chat(
                    username=name,
                    display_name=self._contact_name(name) or str(summary or ""),
                    is_group=name.endswith("@chatroom"),
                    last_time=int(last_time or 0),
                )
            )
        return chats

    def list_groups(self) -> list[Chat]:
        """Every group in the contact database.
        This is the full set. The session table usually knows only the groups
        that were recently active, so it under-reports the list badly.
        """
        conn = self.pool.open(self.config.contact_db)
        rows = conn.execute("SELECT id, username, owner FROM chat_room").fetchall()
        if not rows:
            return []
        owner_by_room = {int(r[0]): (str(r[1] or ""), str(r[2] or "")) for r in rows}
        counts: dict[int, int] = {}
        try:
            for room_id, total in conn.execute(
                "SELECT room_id, COUNT(*) FROM chatroom_member GROUP BY room_id"
            ).fetchall():
                counts[int(room_id)] = int(total)
        except Exception:
            counts = {}
        groups: list[Chat] = []
        for room_id, (username, owner) in owner_by_room.items():
            if not username:
                continue
            groups.append(
                Chat(
                    username=username,
                    display_name=self._contact_name(username),
                    is_group=True,
                    owner=owner,
                    member_count=counts.get(room_id, 0),
                )
            )
        groups.sort(key=lambda c: c.label)
        return groups

    def chats_with_messages(self) -> dict[str, int]:
        """Chat username -> number of rows, from the message tables.

        Useful to tell "known chat" from "chat we can actually read".
        """
        return {name: stat["count"] for name, stat in self.chat_stats().items()}

    def chat_stats(self) -> dict[str, dict[str, int]]:
        """Chat username -> ``{"count": rows, "last": newest create_time}``.

        One pass over the message tables. ``chat_room`` carries no timestamp, so
        this is the only place a group's real last-activity time can come from.
        """
        stats: dict[str, dict[str, int]] = {}
        for shard, path in self.pool.shard_paths().items():
            conn = self.pool.open(path)
            try:
                tables = conn.execute(
                    "SELECT name FROM sqlite_master "
                    "WHERE type='table' AND name LIKE 'Msg_%'"
                ).fetchall()
            except Exception:
                continue
            for (table,) in tables:
                try:
                    total, newest = conn.execute(
                        'SELECT COUNT(*), MAX(create_time) FROM "%s"' % str(table)
                    ).fetchone()
                except Exception:
                    continue
                username = self.pool.username_for_table(shard, str(table))
                if not username:
                    continue
                entry = stats.setdefault(username, {"count": 0, "last": 0})
                entry["count"] += int(total or 0)
                entry["last"] = max(entry["last"], int(newest or 0))
        return stats

    # -- messages -------------------------------------------------------
    def _locate(self, chat: str) -> list[tuple[str, str]]:
        """Return ``(shard, table)`` pairs holding rows for ``chat``."""
        table = table_for(chat)
        found: list[tuple[str, str]] = []
        for shard, path in self.pool.shard_paths().items():
            conn = self.pool.open(path)
            try:
                row = conn.execute(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
                    (table,),
                ).fetchone()
            except Exception:
                continue
            if row:
                found.append((shard, table))
        return found

    def _row_to_message(self, chat: str, shard: str, row: Any) -> Message:
        columns = {
            "local_id": row["local_id"],
            "server_id": row["server_id"] if "server_id" in row.keys() else 0,
            "create_time": row["create_time"],
            "sort_seq": row["sort_seq"],
            "local_type": row["local_type"],
            "real_sender_id": row["real_sender_id"],
            "status": row["status"],
        }
        content_raw = row["message_content"]
        source_raw = row["source"] if "source" in row.keys() else b""
        content_text = codec.decode_text(content_raw)
        source_text = codec.decode_text(source_raw)

        local_type = int(columns["local_type"] or 0)
        kind = kind_of(local_type)
        text = _render_text(content_text, kind)

        sender_id = int(columns["real_sender_id"] or 0)
        sender_username = self.pool.name2id(shard).get(sender_id, "")
        # ``Name2Id`` only yields the wxid; the display name lives in ``contact``
        # and is what a UI has to show. Lookups are cached per reader.
        sender_display = self._contact_name(sender_username) if sender_username else ""
        is_me = bool(self.config.self_username) and (
            sender_username == self.config.self_username
        )
        key = MessageKey(
            chat=chat,
            shard=shard,
            local_id=int(columns["local_id"] or 0),
            server_id=int(columns["server_id"] or 0),
        )
        return Message(
            key=key,
            create_time=int(columns["create_time"] or 0),
            sort_seq=int(columns["sort_seq"] or 0),
            local_type=local_type,
            kind=kind,
            text=text,
            content_xml=content_text,
            source_xml=source_text,
            sender_id=sender_id,
            sender_username=sender_username,
            sender_display=sender_display,
            from_me=is_me,
            status=int(columns["status"] or 0),
        )

    def history(
        self,
        chat: str,
        limit: int = 100,
        offset: int = 0,
        since: str | int = "",
        before: str | int = "",
        ascending: bool = False,
    ) -> Page:
        """Read a page of history, newest first unless ``ascending``.

        ``since`` / ``before`` accept ``YYYY-MM-DD`` and are inclusive on both
        ends, so a range covers whole days including the upper one.
        """
        locations = self._locate(chat)
        if not locations:
            raise ChatNotFound(
                "no message table for this chat: %s" % chat, "chat_not_found"
            )
        want = max(0, int(limit))
        skip = max(0, int(offset))
        lower = _bound(since, end_of_day=False)
        upper = _bound(before, end_of_day=True)

        collected: list[Message] = []
        scanned = 0
        for shard, table in locations:
            conn = self.pool.open(self.pool.shard_paths()[shard])
            clauses: list[str] = []
            params: list[Any] = []
            if lower:
                clauses.append("create_time >= ?")
                params.append(lower)
            if upper:
                clauses.append("create_time <= ?")
                params.append(upper)
            where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
            order = ORDER_ASC if ascending else ORDER_DESC
            # A per-shard limit of skip+want is enough to merge correctly and
            # avoids pulling the entire history of a busy group.
            sql = 'SELECT * FROM "%s" %s %s LIMIT ?' % (table, where, order)
            try:
                rows = conn.execute(sql, (*params, skip + want)).fetchall()
            except Exception as exc:
                raise SchemaMismatch(
                    "cannot read message table: %s" % exc, "schema_mismatch"
                ) from None
            scanned += len(rows)
            for row in rows:
                collected.append(self._row_to_message(chat, shard, row))

        collected.sort(
            key=lambda m: (m.sort_seq, m.key.local_id), reverse=not ascending
        )
        # Deduplicate on the real identity; the same row can be seen twice when
        # a shard is opened through two paths.
        seen: set[MessageKey] = set()
        unique: list[Message] = []
        for message in collected:
            if message.key in seen:
                continue
            seen.add(message.key)
            unique.append(message)
        page = unique[skip: skip + want] if want else unique[:0]
        return Page(
            messages=page,
            has_more=len(unique) > skip + len(page),
            next_offset=skip + len(page),
            scanned=scanned,
        )

    def new_messages(
        self,
        chat: str,
        since_seq: int = 0,
        limit: int = 200,
    ) -> list[Message]:
        """Rows strictly above ``since_seq``, oldest first.

        The comparison here is ``>=`` on the caller's side, not ``>``: pass
        ``since_seq`` one below the watermark so rows that share the watermark's
        ``sort_seq`` are returned too. Callers must deduplicate on ``MessageKey``.
        """
        locations = self._locate(chat)
        if not locations:
            return []
        want = max(0, int(limit))
        if not want:
            return []
        collected: list[Message] = []
        for shard, table in locations:
            conn = self.pool.open(self.pool.shard_paths()[shard])
            sql = (
                'SELECT * FROM "%s" WHERE sort_seq > ? %s LIMIT ?'
                % (table, ORDER_ASC)
            )
            try:
                rows = conn.execute(sql, (int(since_seq), want)).fetchall()
            except Exception as exc:
                raise SchemaMismatch(
                    "cannot read message table: %s" % exc, "schema_mismatch"
                ) from None
            for row in rows:
                collected.append(self._row_to_message(chat, shard, row))
        collected.sort(key=lambda m: (m.sort_seq, m.key.local_id))
        return collected[:want]

    def new_messages_inclusive(
        self,
        chat: str,
        watermark: int,
        limit: int = 200,
    ) -> list[Message]:
        """Rows at or above ``watermark``, oldest first.

        This is the poll the layer recommends: asking for the watermark value
        itself is what recovers rows that share a ``sort_seq`` with it.
        """
        return self.new_messages(chat, since_seq=int(watermark) - 1, limit=limit)

    def relation(
        self, message: Message, include_nickname: bool = True
    ) -> RelationReport:
        """Whether ``message`` relates to the signed-in account, and why."""
        return detect_relation(
            self_username=self.config.self_username,
            source_xml=message.source_xml,
            content_xml=message.content_xml,
            rendered_text=message.text,
            self_nickname=self.self_nickname() if include_nickname else "",
        )

    def mentioned_ids(self, message: Message) -> list[str]:
        return parse_at_user_list(message.source_xml)


def _bound(value: str | int, end_of_day: bool) -> int:
    if not value:
        return 0
    if isinstance(value, int):
        return value
    text = str(value).strip()
    if not text:
        return 0
    if text.isdigit():
        return int(text)
    return local_date_to_epoch(text, end_of_day=end_of_day)


_RENDER_STRIP = (
    "<msgsource>",
    "<refermsg>",
    "<sysmsg",
    "<appmsg",
)

# Payloads for group messages are often prefixed with ``wxid_xxx: `` so the
# renderer knows who spoke. The reader resolves the sender from Name2Id anyway,
# so the prefix is noise in a UI.
#
# The prefix appears in front of XML *and* in front of plain text, so it cannot
# be anchored on a following ``<``. It is anchored on the shape of a WeChat id
# instead, which keeps ordinary text such as ``http://…`` or ``价格: 12`` intact.
# Observers, official accounts and openim channels all reach us this way:
# ``wxid_xxx:``, ``123@chatroom:``, ``25984982070152557@openim:``.
_SENDER_PREFIX = re.compile(
    r"^(?:"
    r"wxid_[A-Za-z0-9_\-]{2,62}"
    r"|[A-Za-z0-9_\-]{2,64}@(?:chatroom|openim|im\.chatroom|app)"
    r"):[ \t]*"
)

_TITLE = re.compile(r"<title>(.*?)</title>", re.S | re.I)
_DES = re.compile(r"<des>(.*?)</des>", re.S | re.I)
_POINAME = re.compile(r'poiname="([^"]*)"', re.I)
_LABEL = re.compile(r'label="([^"]*)"', re.I)
_FILENAME = re.compile(r'<fileext>(.*?)</fileext>', re.S | re.I)
_EMOJI_MD5 = re.compile(r'<emoji[^>]*md5\s*=\s*"([^"]+)"', re.I)

# What a non-text message looks like when there is nothing readable inside it.
_KIND_PLACEHOLDER = {
    "image": "[图片]",
    "voice": "[语音]",
    "video": "[视频]",
    "sticker": "[表情]",
    "location": "[位置]",
    "contact_card": "[名片]",
    "red_packet": "[红包]",
    "transfer": "[转账]",
    "voip": "[语音通话]",
    "pat": "[拍一拍]",
    "friend_request": "[好友申请]",
}


def _clean_title(value: str) -> str:
    text = _unwrap_cdata(value)
    return re.sub(r"\s+", " ", text).strip()


def _unwrap_cdata(value: str) -> str:
    text = (value or "").strip()
    if text.startswith("<![CDATA[") and text.endswith("]]>"):
        return text[len("<![CDATA[") : -len("]]>")].strip()
    return text


def _render_text(content_xml: str, kind: str) -> str:
    """Turn a raw decoded payload into something a person can read.

    WeChat stores every non-text message as XML. Showing that XML in a column
    makes the list unreadable, so this reduces each kind to its human summary:
    a link keeps its title and description, a file keeps its name, an image
    becomes ``[图片]``. Plain text is returned untouched.
    """
    text = (content_xml or "").strip()
    if not text:
        return _KIND_PLACEHOLDER.get(kind, "")
    # Group rows prefix the payload with ``wxid_xxx: `` in front of the XML, so
    # the prefix has to go before deciding whether this is markup or plain text.
    body = _SENDER_PREFIX.sub("", text).strip()
    if not body:
        return _KIND_PLACEHOLDER.get(kind, "")
    if not body.startswith("<"):
        return body

    # Prefer the app-message body when the payload carries one: it holds the
    # title/description that stand in for the message.
    if "<appmsg" in body:
        title_match = _TITLE.search(body)
        des_match = _DES.search(body)
        title = _clean_title(title_match.group(1)) if title_match else ""
        des = _clean_title(des_match.group(1)) if des_match else ""
        name = " · ".join(part for part in (title, des) if part)
        if name:
            return name if kind not in ("file", "link", "music") else name
        return _KIND_PLACEHOLDER.get(kind, "[消息]")

    if kind in ("location", "location_share"):
        poi = _POINAME.search(body) or _LABEL.search(body)
        return "[位置] " + _clean_title(poi.group(1)) if poi else "[位置]"

    if kind == "sticker":
        return "[表情]"

    # Plain text that happens to be wrapped in <msg><![CDATA[…]]></msg>.
    cdata = re.search(r"<!\[CDATA\[(.*?)\]\]>", body, re.S)
    if cdata:
        value = _clean_title(cdata.group(1))
        if value:
            return value

    stripped = body
    for marker in _RENDER_STRIP:
        index = stripped.find(marker)
        if index > 0:
            stripped = stripped[:index]
            break
    if not stripped.startswith("<"):
        return stripped.strip()
    return _KIND_PLACEHOLDER.get(kind, "[消息]")
