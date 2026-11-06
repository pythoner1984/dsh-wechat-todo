"""Identity types shared by the read layer.

A message's identity is ``(chat, shard, local_id)``, never ``local_id`` alone:
the same ``local_id`` appears in several shards for different messages, and one
chat's rows can span shards. Measured on this machine: 7346 collisions in the
first 60 groups, with 31 groups spanning up to 3 shards.

``server_id`` is a better identifier when present, but it is not exposed by
every path (the rion-wechat-cli reader does return it; some helper paths do
not), so the layer always carries both and lets the caller pick.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class MessageKey:
    """Stable identity of one message row."""

    chat: str
    shard: str
    local_id: int
    server_id: int = 0

    def as_tuple(self) -> tuple[str, str, int]:
        return (self.chat, self.shard, self.local_id)

    def __str__(self) -> str:
        return "%s|%s|%d" % (self.chat, self.shard, self.local_id)


@dataclass
class Chat:
    """A conversation, either a group or a one-to-one chat."""

    username: str
    display_name: str = ""
    is_group: bool = False
    owner: str = ""
    member_count: int = 0
    message_count: int = 0
    last_time: int = 0

    @property
    def label(self) -> str:
        """What the UI should show; falls back to the raw id."""
        return self.display_name or self.username


@dataclass
class Message:
    """One decoded message.

    ``text`` is the rendered body, ``content_xml`` and ``source_xml`` are the
    raw decoded payloads kept so relation detection never has to touch the
    database twice.
    """

    key: MessageKey
    create_time: int = 0
    sort_seq: int = 0
    local_type: int = 0
    kind: str = ""
    text: str = ""
    content_xml: str = ""
    source_xml: str = ""
    sender_id: int = 0
    sender_username: str = ""
    sender_display: str = ""
    from_me: bool = False
    status: int = 0
    extra: dict = field(default_factory=dict)

    @property
    def stable_id(self) -> str:
        return str(self.key)


@dataclass
class Page:
    """One page of messages plus the cursor needed to continue."""

    messages: list[Message] = field(default_factory=list)
    has_more: bool = False
    next_offset: int = 0
    scanned: int = 0

    def __len__(self) -> int:
        return len(self.messages)
