"""Long-lived JSON-lines bridge over the wxreader read layer.

The DSH host plugin spawns this once and keeps it warm: opening the encrypted
WeChat databases costs a couple of seconds, which is far too slow to pay on
every UI request.

Protocol: one JSON object per line on stdin, one JSON object per line on
stdout. A request looks like ``{"id": 7, "cmd": "chats"}``; the reply is either
``{"id": 7, "ok": true, "data": ...}`` or
``{"id": 7, "ok": false, "error": {"code": "...", "message": "..."}}``.

Everything here is read-only against WeChat. Nothing is written back, no message
is ever sent, and the key store is only read.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import traceback
from typing import Any

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import wxreader  # noqa: E402
from wxreader import config as wxconfig  # noqa: E402


def _jsonable(value: Any) -> Any:
    """Best-effort conversion to plain JSON types."""
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    return str(value)


class Bridge:
    def __init__(self, config_path: str, keys_path: str | None):
        self.config_path = config_path
        self.keys_path = keys_path
        self.reader: wxreader.WeChatReader | None = None
        self._group_cache: list[wxreader.Chat] | None = None
        self._stats_cache: dict[str, dict[str, int]] | None = None

    # -- lifecycle ------------------------------------------------------
    def _ensure_reader(self) -> wxreader.WeChatReader:
        if self.reader is None:
            self.reader = wxreader.WeChatReader.from_files(
                self.config_path, self.keys_path
            )
        return self.reader

    def reset(self) -> None:
        """Drop the open databases so the next request re-reads them."""
        if self.reader is not None:
            try:
                self.reader.close()
            except Exception:
                pass
        self.reader = None
        self._group_cache = None
        self._stats_cache = None

    # -- serialisation --------------------------------------------------
    def _message_payload(self, reader: wxreader.WeChatReader, message) -> dict:
        report = reader.relation(message)
        labels = report.labels()
        quoted = report.quoted
        return {
            "id": str(message.key),
            "chat": message.key.chat,
            "shard": message.key.shard,
            "localId": message.key.local_id,
            "serverId": message.key.server_id,
            "time": message.create_time * 1000,
            "sortSeq": message.sort_seq,
            "kind": message.kind,
            "text": message.text,
            "sender": message.sender_username,
            "senderName": message.sender_display or message.sender_username,
            "fromMe": message.from_me,
            "status": message.status,
            "relations": [kind.value for kind in (r.kind for r in report.relations)],
            "relationLabels": labels,
            "related": report.related,
            "mentionedIds": report.mentioned_ids,
            "quoted": (
                None
                if quoted is None
                else {
                    "fromUser": quoted.from_user,
                    "displayName": quoted.display_name,
                    "content": quoted.content[:500],
                    "kind": quoted.kind,
                }
            ),
        }

    def _chat_payload(self, chat, stats: dict[str, dict[str, int]]) -> dict:
        stat = stats.get(chat.username) or {}
        return {
            "username": chat.username,
            "displayName": chat.display_name or "",
            "label": chat.label,
            "isGroup": chat.is_group,
            "owner": chat.owner,
            "memberCount": chat.member_count,
            "messageCount": int(stat.get("count") or 0),
            "lastTime": int(stat.get("last") or 0) * 1000,
        }

    # -- commands -------------------------------------------------------
    def cmd_health(self, _args: dict) -> dict:
        reader = self._ensure_reader()
        return {
            "health": _jsonable(reader.health()),
            "selfUsername": reader.self_username,
            "selfNickname": reader.self_nickname(),
            "configPath": self.config_path,
        }

    def cmd_chats(self, args: dict) -> dict:
        reader = self._ensure_reader()
        if self._group_cache is None or args.get("refresh"):
            self._group_cache = reader.list_groups()
        if self._stats_cache is None or args.get("refresh"):
            self._stats_cache = reader.chat_stats()
        stats = self._stats_cache
        groups = [g for g in self._group_cache if stats.get(g.username, {}).get("count", 0) > 0]
        # Groups without readable rows cannot drive a board, so they are offered
        # separately instead of silently disappearing.
        silent = len(self._group_cache) - len(groups)
        groups.sort(key=lambda c: (-(stats.get(c.username, {}).get("last") or 0), c.label))
        return {
            "chats": [self._chat_payload(g, stats) for g in groups],
            "withoutMessages": silent,
            "totalGroups": len(self._group_cache),
        }

    def cmd_messages(self, args: dict) -> dict:
        reader = self._ensure_reader()
        chat = str(args.get("chat") or "")
        if not chat:
            raise ValueError("chat is required")
        limit = int(args.get("limit") or 60)
        offset = int(args.get("offset") or 0)
        page = reader.history(
            chat,
            limit=limit,
            offset=offset,
            since=args.get("since") or "",
            before=args.get("before") or "",
            ascending=bool(args.get("ascending")),
        )
        return {
            "chat": chat,
            "messages": [self._message_payload(reader, m) for m in page.messages],
            "hasMore": page.has_more,
            "nextOffset": page.next_offset,
            "scanned": page.scanned,
        }

    def cmd_poll(self, args: dict) -> dict:
        """Return rows at or above each chat's watermark, oldest first.

        The comparison is inclusive on purpose: two rows can share a sort_seq,
        and a strict ``>`` would lose the second one permanently.
        """
        reader = self._ensure_reader()
        watermarks = args.get("watermarks") or {}
        from_dates = args.get("fromDates") or {}
        chats = args.get("chats") or list(watermarks.keys())
        limit = int(args.get("limit") or 200)
        events: list[dict] = []
        for chat in chats:
            mark = int(watermarks.get(chat) or 0)
            since = str(from_dates.get(chat) or "")
            if mark <= 0:
                # No watermark yet: summarize the *newest* window, not the oldest.
                # Taking the oldest rows would make the first pass describe the
                # beginning of the group's history instead of what just happened.
                # `since` honours the configured start date so a group whose whole
                # history predates it does not get summarized on the first pass.
                recent = reader.history(chat, limit=limit, since=since)
                rows = list(reversed(recent.messages))
            else:
                rows = reader.new_messages_inclusive(chat, mark, limit=limit)
            if not rows:
                continue
            rows = sorted(rows, key=lambda m: (m.sort_seq, m.key.local_id))
            events.append(
                {
                    "chat": chat,
                    "messages": [self._message_payload(reader, m) for m in rows],
                    "maxSortSeq": max(m.sort_seq for m in rows),
                }
            )
        return {"events": events}

    def cmd_recent(self, args: dict) -> dict:
        """Newest rows for several chats at once, for the board's first paint."""
        reader = self._ensure_reader()
        chats = args.get("chats") or []
        limit = int(args.get("limit") or 30)
        out: list[dict] = []
        for chat in chats:
            try:
                page = reader.history(chat, limit=limit)
            except Exception as exc:  # a single unreadable chat must not break the batch
                out.append({"chat": chat, "error": str(exc), "messages": []})
                continue
            out.append(
                {
                    "chat": chat,
                    "messages": [self._message_payload(reader, m) for m in page.messages],
                }
            )
        return {"chats": out}

    def dispatch(self, request: dict) -> dict:
        cmd = str(request.get("cmd") or "")
        handler = getattr(self, "cmd_%s" % cmd, None)
        if handler is None:
            raise ValueError("unknown command: %s" % cmd)
        if cmd == "reset":
            self.reset()
            return {"reset": True}
        return handler(request.get("args") or {})


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="wxreader JSON bridge")
    defaults = wxconfig.ReaderConfig.default_paths()
    parser.add_argument("--config", default=defaults["config"])
    parser.add_argument("--keys", default="")
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args(argv)

    bridge = Bridge(args.config, args.keys or None)

    if args.selftest:
        print(json.dumps(_jsonable(bridge.cmd_health({})), ensure_ascii=False))
        return 0

    # Line-buffered so the host sees each reply as soon as it is produced.
    try:
        out = sys.stdout
        out.reconfigure(encoding="utf-8", newline="\n")  # type: ignore[attr-defined]
    except Exception:
        out = sys.stdout
    stdin = sys.stdin
    try:
        stdin.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except Exception:
        pass

    for line in stdin:
        line = line.strip()
        if not line:
            continue
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            data = bridge.dispatch(request)
            reply = {"id": request_id, "ok": True, "data": _jsonable(data)}
        except Exception as exc:
            reply = {
                "id": request_id,
                "ok": False,
                "error": {
                    "code": getattr(exc, "code", type(exc).__name__),
                    "message": str(exc),
                    "trace": traceback.format_exc(limit=3),
                },
            }
        out.write(json.dumps(reply, ensure_ascii=False) + "\n")
        out.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
