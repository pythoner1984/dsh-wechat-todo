"""Verify the read layer against the live WeChat databases.

Read-only. Prints counts and structural facts only, never message text.

Run with the interpreter that has the SQLCipher driver installed, e.g.::

    "%USERPROFILE%\\.codex\\share\\wechat-intelligence-hub\\projects\\
    rion-wechat-reader\\.venv\\Scripts\\python.exe" -m wxreader.live_check
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

from .config import ReaderConfig
from .mentions import RelationKind
from .store import WeChatReader


def _default_paths() -> tuple[str, str]:
    defaults = ReaderConfig.default_paths()
    return defaults["config"], defaults["keys"]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="")
    parser.add_argument("--keys", default="")
    parser.add_argument("--groups", type=int, default=20)
    parser.add_argument("--per-group", type=int, default=100)
    parser.add_argument(
        "--deep",
        action="store_true",
        help="also sweep every shard so relation totals are not sample-limited",
    )
    args = parser.parse_args(argv)

    config_path, keys_path = _default_paths()
    config_path = args.config or config_path
    keys_path = args.keys or keys_path

    report: dict = {
        "config": config_path,
        "keys": keys_path,
        "config_exists": os.path.exists(config_path),
        "keys_exists": os.path.exists(keys_path),
    }
    if not report["config_exists"] or not report["keys_exists"]:
        report["verdict"] = "configuration missing; nothing was read"
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 1

    started = time.time()
    reader = WeChatReader.from_files(config_path, keys_path)
    try:
        report["health"] = reader.health()
        report["self_username_present"] = bool(reader.self_username)
        report["self_nickname_present"] = bool(reader.self_nickname())

        chats = reader.list_chats(limit=500)
        groups_in_sessions = [c for c in chats if c.is_group]
        report["session_chats"] = len(chats)
        report["session_groups"] = len(groups_in_sessions)

        groups = reader.list_groups()
        report["contact_groups"] = len(groups)
        report["contact_groups_named"] = sum(1 for g in groups if g.display_name)

        counts = reader.chats_with_messages()
        report["chats_with_messages"] = len(counts)
        report["groups_with_messages"] = sum(
            1 for g in groups if counts.get(g.username)
        )

        # Sender resolution: every returned row must name its sender, and the
        # name must come from the row's own shard.
        checked = resolved = mismatched = 0
        cross_shard_groups = 0
        mentions = replies = related_groups = 0
        nickname_only = 0
        scanned = 0
        paging_overlaps = 0
        date_filter_ok = True
        # The parser is checked against a plain regex on the *same* rows. Two
        # methods over two different samples cannot be compared: a newest-N
        # sample legitimately contains no reply even when the database has many.
        raw_at_me = 0
        raw_reply_me = 0
        agree_at_me = 0
        agree_reply = 0

        target = [g for g in groups if counts.get(g.username)][: args.groups]
        for group in target:
            page = reader.history(group.username, limit=args.per_group)
            if not page.messages:
                continue
            scanned += len(page.messages)
            if len({m.key.shard for m in page.messages}) > 1:
                cross_shard_groups += 1

            mapping = {
                shard: reader.pool.name2id(shard)
                for shard in {m.key.shard for m in page.messages}
            }
            for message in page.messages:
                checked += 1
                expected = mapping.get(message.key.shard, {}).get(
                    message.sender_id, ""
                )
                if message.sender_username:
                    resolved += 1
                if expected != message.sender_username:
                    mismatched += 1
                report_relation = reader.relation(message)
                kinds = {r.kind for r in report_relation.relations}
                if RelationKind.MENTION in kinds:
                    mentions += 1
                if RelationKind.REPLY in kinds:
                    replies += 1
                if RelationKind.NICKNAME in kinds:
                    nickname_only += 1
                if report_relation.related:
                    related_groups += 1

                # independent re-derivation on this exact row
                raw_has_at = bool(
                    reader.self_username
                    and "<atuserlist" in message.source_xml
                    and reader.self_username
                    in _atuserlist_text(message.source_xml)
                )
                raw_has_reply = bool(
                    reader.self_username
                    and ("<fromusr>" + reader.self_username) in message.content_xml
                    and "<refermsg" in message.content_xml
                )
                if raw_has_at:
                    raw_at_me += 1
                    if RelationKind.MENTION in kinds:
                        agree_at_me += 1
                if raw_has_reply:
                    raw_reply_me += 1
                    if RelationKind.REPLY in kinds:
                        agree_reply += 1

            # paging must not repeat or skip rows
            first = reader.history(group.username, limit=args.per_group)
            second = reader.history(
                group.username, limit=args.per_group, offset=args.per_group
            )
            if {m.key for m in first.messages} & {m.key for m in second.messages}:
                paging_overlaps += 1

            # an explicit range must actually narrow the result
            times = [m.create_time for m in page.messages]
            if times:
                cutoff = (min(times) + max(times)) // 2
                narrowed = reader.history(
                    group.username, limit=args.per_group, since=cutoff
                )
                if any(m.create_time < cutoff for m in narrowed.messages):
                    date_filter_ok = False

        report["groups_scanned"] = len(target)
        report["messages_scanned"] = scanned
        report["sender_rows_checked"] = checked
        report["sender_rows_resolved"] = resolved
        report["sender_rows_mismatched"] = mismatched
        report["cross_shard_groups"] = cross_shard_groups
        report["paging_overlaps"] = paging_overlaps
        report["date_filter_respected"] = date_filter_ok
        report["mentions_of_me"] = mentions
        report["replies_to_me"] = replies
        report["nickname_only_matches"] = nickname_only
        report["related_messages"] = related_groups
        report["parser_agreement"] = {
            "raw_at_me_rows": raw_at_me,
            "parser_found_mention": agree_at_me,
            "raw_reply_me_rows": raw_reply_me,
            "parser_found_reply": agree_reply,
            "false_negatives": (raw_at_me - agree_at_me) + (raw_reply_me - agree_reply),
        }

        # A newest-N sample per group under-reports replies: a quote-reply is
        # rare and the newest rows rarely contain one. Sweep every shard once so
        # the totals reflect the database rather than the sample size.
        if args.deep:
            sweep = _deep_relation_sweep(reader)
            report["deep_sweep"] = sweep

        report["elapsed_s"] = round(time.time() - started, 2)
        report["verdict"] = _verdict(report)
    finally:
        reader.close()

    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report.get("verdict", "").startswith("ok") else 2


def _deep_relation_sweep(reader: WeChatReader) -> dict:
    """Scan every shard's newest rows and count structured relation signals.

    This is deliberately independent of :meth:`WeChatReader.relation`: it
    re-derives the answer with plain regexes over the decoded payloads, so a
    disagreement points at a bug in the parser rather than confirming it.
    """
    from . import codec

    me = reader.self_username
    rows = 0
    with_atuserlist = 0
    at_me = 0
    with_refermsg = 0
    reply_me_exact = 0
    chatusr_me = 0
    for shard, path in reader.pool.shard_paths().items():
        conn = reader.pool.open(path)
        tables = [
            str(r[0])
            for r in conn.execute(
                "SELECT name FROM sqlite_master "
                "WHERE type='table' AND name LIKE 'Msg_%'"
            ).fetchall()
        ]
        for table in tables:
            try:
                got = conn.execute(
                    'SELECT message_content, source FROM "%s" '
                    "ORDER BY sort_seq DESC LIMIT ?" % table,
                    (200,),
                ).fetchall()
            except Exception:
                continue
            for content, source in got:
                rows += 1
                source_text = codec.decode_text(source)
                content_text = codec.decode_text(content)
                block = __import__("re").search(
                    r"<atuserlist>(.*?)</atuserlist>", source_text, __import__("re").S
                )
                if block:
                    with_atuserlist += 1
                    if me and me in block.group(1):
                        at_me += 1
                quoted = __import__("re").search(
                    r"<refermsg>.*?</refermsg>",
                    content_text,
                    __import__("re").S,
                )
                if quoted:
                    with_refermsg += 1
                    segment = quoted.group(0)
                    if me and ("<fromusr>" + me) in segment:
                        reply_me_exact += 1
                    if me and ("<chatusr>" + me) in segment:
                        chatusr_me += 1
    return {
        "rows": rows,
        "rows_with_atuserlist": with_atuserlist,
        "atuserlist_contains_me": at_me,
        "rows_with_refermsg": with_refermsg,
        "refermsg_fromusr_is_me": reply_me_exact,
        "refermsg_chatusr_is_me": chatusr_me,
        "note": (
            "chatusr is the chat the quoted message came from, not its author; "
            "only fromusr decides whether the reply is directed at the account"
        ),
    }


def _verdict(report: dict) -> str:
    problems = []
    if report.get("sender_rows_mismatched"):
        problems.append("sender mismatch")
    if report.get("paging_overlaps"):
        problems.append("paging overlaps")
    if report.get("date_filter_respected") is False:
        problems.append("date filter ignored")
    if not report.get("self_nickname_present"):
        problems.append("own nickname missing")
    agreement = report.get("parser_agreement") or {}
    if agreement.get("false_negatives"):
        problems.append("parser missed relations the raw scan found")
    if problems:
        return "problems: " + ", ".join(problems)
    return "ok: read layer works against the live database"


def _atuserlist_text(source_xml: str) -> str:
    """Concatenate every atuserlist body, for a raw comparison."""
    import re

    return "".join(
        re.findall(r"<atuserlist>(.*?)</atuserlist>", source_xml, re.S)
    )


if __name__ == "__main__":
    sys.exit(main())
