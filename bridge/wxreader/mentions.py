"""Detection of "@ me" and "reply to me" from the raw message payloads.

The rendered message text cannot be used for this. WeChat inserts a U+2005
(FOUR-PER-EM SPACE) inside a rendered @-mention and may truncate the text, so a
substring match on the display string finds only a small fraction of the rows
that actually mention the account. Measured on this machine: 36 of 574.

Two structured signals are reliable:

``<atuserlist>``
    Lives in the ``source`` column. A comma separated list of the wxids that
    were @-mentioned in the message.

``<refermsg><fromusr>``
    Lives in the ``message_content`` column, for quote-replies. ``fromusr`` is
    the wxid of the author of the quoted message, which is what decides whether
    the reply is directed at this account.

Both are plain XML, so this module is pure and testable offline.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from enum import Enum

_CDATA_WRAPPER = re.compile(r"^<!\[CDATA\[(.*)\]\]>$", re.S)
_AT_USER_LIST = re.compile(r"<atuserlist>(.*?)</atuserlist>", re.S | re.I)
_REFER_MSG = re.compile(r"<refermsg>(.*?)</refermsg>", re.S | re.I)
_REFER_FROM = re.compile(r"<fromusr>(.*?)</fromusr>", re.S | re.I)
_REFER_DISPLAY = re.compile(r"<displayname>(.*?)</displayname>", re.S | re.I)
_REFER_CONTENT = re.compile(r"<content>(.*?)</content>", re.S | re.I)
_REFER_TYPE = re.compile(r"<type>(.*?)</type>", re.S | re.I)

# A wxid or a group id. Deliberately loose: the point is to reject empty
# strings and stray markup, not to validate the identifier format.
_ID_CHARS = re.compile(r"^[A-Za-z0-9_@.\-]{2,128}$")


class RelationKind(str, Enum):
    """Why a message counts as related to the signed-in account."""

    MENTION = "mention"
    REPLY = "reply"
    NICKNAME = "nickname"


@dataclass(frozen=True)
class Relation:
    """One reason a message is related, with the evidence behind it."""

    kind: RelationKind

    def label(self) -> str:
        return {
            RelationKind.MENTION: "@了你",
            RelationKind.REPLY: "回复了你",
            RelationKind.NICKNAME: "提到你的名字",
        }[self.kind]


@dataclass
class QuotedMessage:
    """The message that a quote-reply points at."""

    from_user: str = ""
    display_name: str = ""
    content: str = ""
    kind: str = ""


@dataclass
class RelationReport:
    """Everything the read layer can say about one message's relevance."""

    relations: list[Relation] = field(default_factory=list)
    mentioned_ids: list[str] = field(default_factory=list)
    quoted: QuotedMessage | None = None

    @property
    def related(self) -> bool:
        return bool(self.relations)

    def labels(self) -> list[str]:
        return [r.label() for r in self.relations]


def _unwrap(value: str) -> str:
    text = value.strip()
    match = _CDATA_WRAPPER.match(text)
    if match:
        return match.group(1).strip()
    return text


def parse_at_user_list(source_xml: str) -> list[str]:
    """Return the wxids that were @-mentioned, in order, deduplicated.

    The list is comma separated. Entries are unwrapped from CDATA when present,
    and anything that does not look like an identifier is dropped.
    """
    if not source_xml or "<atuserlist" not in source_xml:
        return []
    found: list[str] = []
    seen: set[str] = set()
    for block in _AT_USER_LIST.findall(source_xml):
        for part in _unwrap(block).split(","):
            candidate = _unwrap(part)
            if not candidate or not _ID_CHARS.match(candidate):
                continue
            if candidate in seen:
                continue
            seen.add(candidate)
            found.append(candidate)
    return found


def parse_quoted_message(content_xml: str) -> QuotedMessage | None:
    """Return the quoted message of a quote-reply, or None."""
    if not content_xml or "<refermsg" not in content_xml:
        return None
    block = _REFER_MSG.search(content_xml)
    if not block:
        return None
    body = block.group(1)
    from_match = _REFER_FROM.search(body)
    display_match = _REFER_DISPLAY.search(body)
    content_match = _REFER_CONTENT.search(body)
    type_match = _REFER_TYPE.search(body)
    return QuotedMessage(
        from_user=_unwrap(from_match.group(1)) if from_match else "",
        display_name=_unwrap(display_match.group(1)) if display_match else "",
        content=_unwrap(content_match.group(1)) if content_match else "",
        kind=_unwrap(type_match.group(1)) if type_match else "",
    )


def detect_relation(
    *,
    self_username: str,
    source_xml: str = "",
    content_xml: str = "",
    rendered_text: str = "",
    self_nickname: str = "",
) -> RelationReport:
    """Decide whether a message is related to the signed-in account.

    ``self_username`` is the authority for both the mention and the reply
    check. ``self_nickname`` only adds a *display* hint: a message that mentions
    the nickname in its body counts, but the structured signals always win, and
    the nickname check never runs when a structured signal already matched.

    ``rendered_text`` must be the decoded body, not the raw column.
    """
    report = RelationReport()

    # Without a known identity there is nothing to compare against. Refusing
    # here keeps an unconfigured reader from claiming every message that
    # happens to contain some nickname string is related to the user.
    if not self_username:
        return report

    mentioned = parse_at_user_list(source_xml)
    if mentioned:
        report.mentioned_ids = mentioned
        if self_username and self_username in mentioned:
            report.relations.append(Relation(RelationKind.MENTION))

    quoted = parse_quoted_message(content_xml)
    if quoted is not None:
        report.quoted = quoted
        if self_username and quoted.from_user == self_username:
            report.relations.append(Relation(RelationKind.REPLY))

    if not report.relations and self_nickname and rendered_text:
        if self_nickname in rendered_text:
            report.relations.append(Relation(RelationKind.NICKNAME))

    return report
