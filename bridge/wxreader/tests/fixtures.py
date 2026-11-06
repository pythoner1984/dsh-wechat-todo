"""Build throw-away encrypted WeChat-shaped databases for tests.

The fixtures copy the real schema exactly, including the awkward parts:

* ``message_content`` / ``source`` are zstd frames, as on disk;
* each shard has its own ``Name2Id`` table whose rowids collide with the other
  shards while naming different people;
* one chat's rows are spread across shards with repeating ``local_id``;
* some rows share a ``sort_seq``.

Building these as real SQLCipher databases means the tests exercise the same
code path as production, including the key handling.
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from dataclasses import dataclass

import zstandard

MESSAGE_COLUMNS = """
    local_id INTEGER PRIMARY KEY,
    server_id INTEGER,
    local_type INTEGER,
    sort_seq INTEGER,
    real_sender_id INTEGER,
    create_time INTEGER,
    status INTEGER,
    upload_status INTEGER,
    download_status INTEGER,
    server_seq INTEGER,
    origin_source INTEGER,
    source BLOB,
    message_content BLOB,
    compress_content BLOB,
    packed_info_data BLOB,
    WCDB_CT_message_content INTEGER,
    WCDB_CT_source INTEGER
"""


def table_for(chat: str) -> str:
    return "Msg_" + hashlib.md5(chat.encode("utf-8")).hexdigest()


def zstd(text: str) -> bytes:
    return zstandard.ZstdCompressor().compress(text.encode("utf-8"))


@dataclass
class FixtureLayout:
    """Paths and identifiers produced by :func:`build`."""

    root: str
    config_path: str
    keys_path: str
    self_username: str
    self_nickname: str
    chats: dict[str, str]
    shards: list[str]

    def cleanup(self) -> None:
        import shutil

        shutil.rmtree(self.root, ignore_errors=True)


SCHEMA_SESSION = """
CREATE TABLE SessionTable (
    username TEXT,
    type INTEGER,
    unread_count INTEGER,
    summary TEXT,
    is_hidden INTEGER,
    last_timestamp INTEGER,
    sort_timestamp INTEGER,
    last_msg_sender TEXT,
    last_sender_display_name TEXT
);
"""

SCHEMA_CONTACT = """
CREATE TABLE contact (
    id INTEGER PRIMARY KEY,
    username TEXT,
    local_type INTEGER,
    remark TEXT,
    nick_name TEXT
);
CREATE TABLE chat_room (
    id INTEGER PRIMARY KEY,
    username TEXT,
    owner TEXT
);
CREATE TABLE chatroom_member (
    room_id INTEGER,
    member_id INTEGER
);
"""

SCHEMA_SHARD = """
CREATE TABLE Name2Id (
    user_name TEXT,
    is_session INTEGER
);
"""


def _connect(path: str, key: str):
    from sqlcipher3 import dbapi2 as driver

    conn = driver.connect(path)
    conn.execute('PRAGMA key = "x\'%s\'"' % key)
    conn.row_factory = driver.Row
    return conn


def build(
    *,
    self_username: str = "wxid_self",
    self_nickname: str = "我自己",
    shard_count: int = 2,
    compress: bool = True,
) -> FixtureLayout:
    """Create a fixture set and return where it landed.

    The layout mirrors a real account directory:

    ``root/<account>/db_storage/{session,contact,message}/…``
    """
    root = tempfile.mkdtemp(prefix="wxreader-fixture-")
    account = "wxid_test_account_1234"
    db_root = os.path.join(root, account, "db_storage")
    session_dir = os.path.join(db_root, "session")
    contact_dir = os.path.join(db_root, "contact")
    message_dir = os.path.join(db_root, "message")
    for path in (session_dir, contact_dir, message_dir):
        os.makedirs(path, exist_ok=True)

    shard_paths = [
        os.path.join(message_dir, "message_%d.db" % index)
        for index in range(shard_count)
    ]
    session_path = os.path.join(session_dir, "session.db")
    contact_path = os.path.join(contact_dir, "contact.db")

    # Each database gets its own key. WeChat derives them per file, and using
    # distinct keys here catches an accidental "same key everywhere" assumption.
    keys: dict[str, str] = {}
    for index, path in enumerate([*shard_paths, session_path, contact_path]):
        keys[path] = ("%064x" % (0xC0FFEE + index * 7919)) * 1

    for path, key in keys.items():
        conn = _connect(path, key)
        try:
            if path == session_path:
                conn.executescript(SCHEMA_SESSION)
            elif path == contact_path:
                conn.executescript(SCHEMA_CONTACT)
            else:
                conn.executescript(SCHEMA_SHARD)
            conn.commit()
        finally:
            conn.close()

    groups = {
        "group_alpha": "111@chatroom",
        "group_beta": "222@chatroom",
        "group_gamma": "333@chatroom",
    }
    self_id = self_username

    # -- contact: groups, members, own identity
    conn = _connect(contact_path, keys[contact_path])
    try:
        conn.execute(
            "INSERT INTO contact (id, username, local_type, remark, nick_name) "
            "VALUES (1, ?, 1, '', ?)",
            (self_id, self_nickname),
        )
        for index, (label, username) in enumerate(groups.items(), start=10):
            conn.execute(
                "INSERT INTO contact (id, username, local_type, remark, nick_name) "
                "VALUES (?, ?, 2, '', ?)",
                (index, username, label),
            )
            conn.execute(
                "INSERT INTO chat_room (id, username, owner) VALUES (?, ?, ?)",
                (index, username, self_id),
            )
            conn.execute(
                "INSERT INTO chatroom_member (room_id, member_id) VALUES (?, ?)",
                (index, 1),
            )
            conn.execute(
                "INSERT INTO chatroom_member (room_id, member_id) VALUES (?, ?)",
                (index, index),
            )
        conn.commit()
    finally:
        conn.close()

    # -- session: only two of the three groups are "recent"
    conn = _connect(session_path, keys[session_path])
    try:
        conn.execute(
            "INSERT INTO SessionTable VALUES (?,0,0,'',0,?,?, '','')",
            (groups["group_alpha"], 1793000000, 1793000000),
        )
        conn.execute(
            "INSERT INTO SessionTable VALUES (?,0,0,'',0,?,?, '','')",
            (groups["group_beta"], 1792000000, 1792000000),
        )
        conn.commit()
    finally:
        conn.close()

    encoder = (lambda text: zstd(text)) if compress else (lambda text: text.encode())

    # -- shards: the interesting part
    # shard 0: Name2Id rowids 1..3 -> self, alice, bob
    # shard 1: Name2Id rowids 1..3 -> carol, dave, self   (colliding rowids!)
    shard_senders = [
        {1: self_id, 2: "wxid_alice", 3: "wxid_bob"},
        {1: "wxid_carol", 2: "wxid_dave", 3: self_id},
    ]

    def at_source(ids: list[str]) -> bytes:
        inner = ",".join(ids)
        xml = (
            "<msgsource><atuserlist><![CDATA[%s]]></atuserlist>"
            "<silence>0</silence></msgsource>" % inner
        )
        return encoder(xml)

    def reply_content(text: str, quoted_from: str) -> bytes:
        xml = (
            "<msg><appmsg><type>57</type><title>%s</title>"
            "<refermsg><type>1</type><svrid>1</svrid>"
            "<fromusr>%s</fromusr><chatusr>%s</chatusr>"
            "<displayname>某人</displayname><content>原文</content>"
            "<createtime>1792900000</createtime></refermsg></appmsg></msg>"
            % (text, quoted_from, quoted_from)
        )
        return encoder(xml)

    for shard_index, path in enumerate(shard_paths):
        conn = _connect(path, keys[path])
        try:
            senders = shard_senders[shard_index]
            for rowid, username in senders.items():
                conn.execute(
                    "INSERT INTO Name2Id (rowid, user_name, is_session) VALUES (?,?,0)",
                    (rowid, username),
                )

            for label, username in groups.items():
                table = table_for(username)
                conn.execute(
                    'CREATE TABLE "%s" (%s)' % (table, MESSAGE_COLUMNS)
                )
                rows = _rows_for(
                    label=label,
                    username=username,
                    shard_index=shard_index,
                    at_source=at_source,
                    reply_content=reply_content,
                    sender_rowid=1 if shard_index == 0 else 3,
                )
                for row in rows:
                    conn.execute(
                        'INSERT INTO "%s" (local_id, server_id, local_type, sort_seq,'
                        " real_sender_id, create_time, status, source,"
                        " message_content, WCDB_CT_message_content, WCDB_CT_source)"
                        " VALUES (?,?,?,?,?,?,?,?,?,?,?)" % table,
                        row,
                    )
            conn.commit()
        finally:
            conn.close()

    # -- write config + key store
    key_entries: dict[str, dict[str, str]] = {}
    for path, key in keys.items():
        with open(path, "rb") as handle:
            salt = handle.read(16).hex()
        key_entries[salt] = {"key": key + salt}

    keys_path = os.path.join(root, "keys.json")
    with open(keys_path, "w", encoding="utf-8") as handle:
        json.dump({"salt_keys": key_entries}, handle, indent=2)

    config_path = os.path.join(root, "config.json")
    with open(config_path, "w", encoding="utf-8") as handle:
        json.dump(
            {
                "session_db": session_path,
                "contact_db": contact_path,
                "message_dbs": shard_paths,
                "keys_file": keys_path,
                "self_username": self_username,
                "self_display_name": self_nickname,
            },
            handle,
            indent=2,
        )

    return FixtureLayout(
        root=root,
        config_path=config_path,
        keys_path=keys_path,
        self_username=self_username,
        self_nickname=self_nickname,
        chats=groups,
        shards=shard_paths,
    )


def _rows_for(
    *,
    label: str,
    username: str,
    shard_index: int,
    at_source,
    reply_content,
    sender_rowid: int,
) -> list[tuple]:
    """Rows for one chat inside one shard.

    Deliberate properties, each asserted by a test:

    * ``group_alpha`` appears in **both** shards with the same ``local_id``
      values (1, 2) holding different content -> identity must include shard;
    * two rows share ``sort_seq`` 2000 -> a ``>`` watermark would lose one;
    * one row @-mentions the account, one quote-replies to the account,
      one does neither.
    """
    base = 1793000000 + shard_index * 1000
    if label == "group_alpha":
        if shard_index == 0:
            return [
                (1, 1001, 1, 1000, sender_rowid, base + 10, 4,
                 at_source([]), _plain("alpha shard0 first"), 0, 0),
                (2, 1002, 1, 2000, sender_rowid, base + 20, 4,
                 at_source(["wxid_self"]), _plain("alpha shard0 at me"), 0, 0),
            ]
        return [
            (1, 1003, 1, 1000, sender_rowid, base + 30, 4,
             at_source([]), _plain("alpha shard1 first"), 0, 0),
            (2, 1004, 1, 2000, sender_rowid, base + 40, 4,
             at_source([]), _plain("alpha shard1 second"), 0, 0),
            (3, 1005, 49, 2000, sender_rowid, base + 50, 4,
             at_source([]), reply_content("alpha reply", "wxid_self"), 0, 0),
        ]
    if label == "group_beta":
        if shard_index != 0:
            return []
        return [
            (1, 2001, 1, 500, sender_rowid, base + 5, 4,
             at_source([]), _plain("beta older"), 0, 0),
            (2, 2002, 1, 900, sender_rowid, base + 9, 4,
             at_source([]), _plain("beta newer"), 0, 0),
        ]
    # group_gamma lives only in shard 1, and is absent from the session table
    if shard_index != 1:
        return []
    return [
        (1, 3001, 1, 100, sender_rowid, base + 1, 4,
         at_source(["wxid_other", "wxid_self"]), _plain("gamma mentions me twice"), 0, 0),
    ]


def _plain(text: str) -> bytes:
    return zstd(text)
