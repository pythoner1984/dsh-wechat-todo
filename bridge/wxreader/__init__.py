"""A read-only layer over the local WeChat databases.

The layer exists because the plugin needs five things the raw databases do not
give for free, each of which failed in measurement before it was built in:

1. a chat list that is not limited to recently active sessions;
2. date ranges, which the databases have no index predicate for;
3. cross-shard identity, because ``local_id`` is not unique on its own;
4. per-shard sender resolution, because ``real_sender_id`` is a rowid into that
   shard's own ``Name2Id`` table;
5. structured "@ me" / "reply to me" detection, because the rendered text
   under-reports mentions by more than an order of magnitude.

Everything here is read-only against WeChat and never reaches the network.
"""

from __future__ import annotations

from .config import KeyStore, ReaderConfig, database_salt
from .errors import (
    ChatNotFound,
    DatabaseLocked,
    DriverUnavailable,
    KeyNotFound,
    ReaderError,
    SchemaMismatch,
)
from .mentions import (
    QuotedMessage,
    Relation,
    RelationKind,
    RelationReport,
    detect_relation,
    parse_at_user_list,
    parse_quoted_message,
)
from .models import Chat, Message, MessageKey, Page
from .store import DatabasePool, WeChatReader, local_date_to_epoch, table_for

__all__ = [
    "Chat",
    "ChatNotFound",
    "DatabaseLocked",
    "DatabasePool",
    "DriverUnavailable",
    "KeyNotFound",
    "KeyStore",
    "Message",
    "MessageKey",
    "Page",
    "QuotedMessage",
    "ReaderConfig",
    "ReaderError",
    "Relation",
    "RelationKind",
    "RelationReport",
    "SchemaMismatch",
    "WeChatReader",
    "database_salt",
    "detect_relation",
    "local_date_to_epoch",
    "parse_at_user_list",
    "parse_quoted_message",
    "table_for",
]

__version__ = "0.1.0"
