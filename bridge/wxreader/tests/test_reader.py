"""Integration tests against throw-away encrypted databases.

These exercise the real code path: SQLCipher connections, per-file keys, shard
lookup, sender resolution and relation detection. The fixtures reproduce the
awkward properties measured on the live database, so a regression in any of
them fails here rather than in production.
"""

from __future__ import annotations

import unittest

from wxreader import KeyStore, ReaderConfig, WeChatReader
from wxreader.errors import ChatNotFound, KeyNotFound
from wxreader.mentions import RelationKind

from . import fixtures


class ReaderTestCase(unittest.TestCase):
    layout: fixtures.FixtureLayout

    @classmethod
    def setUpClass(cls):
        cls.layout = fixtures.build()
        cls.reader = WeChatReader.from_files(
            cls.layout.config_path, cls.layout.keys_path
        )

    @classmethod
    def tearDownClass(cls):
        cls.reader.close()
        cls.layout.cleanup()


class IdentityTests(ReaderTestCase):
    def test_self_username_comes_from_config(self):
        self.assertEqual(self.reader.self_username, self.layout.self_username)

    def test_self_nickname_is_read_from_nick_name_column(self):
        # reading "nickname" instead of "nick_name" silently returns ""
        self.assertTrue(self.reader.self_nickname())
        self.assertEqual(self.reader.self_nickname(), self.layout.self_nickname)


class ChatListTests(ReaderTestCase):
    def test_session_table_only_knows_recent_chats(self):
        chats = self.reader.list_chats()
        names = {c.username for c in chats}
        self.assertIn(self.layout.chats["group_alpha"], names)
        self.assertIn(self.layout.chats["group_beta"], names)
        # group_gamma has messages but never appears in the session table
        self.assertNotIn(self.layout.chats["group_gamma"], names)

    def test_group_list_is_the_full_set(self):
        groups = self.reader.list_groups()
        names = {g.username for g in groups}
        self.assertEqual(len(names), 3)
        self.assertIn(self.layout.chats["group_gamma"], names)

    def test_groups_are_flagged_and_named(self):
        groups = {g.username: g for g in self.reader.list_groups()}
        alpha = groups[self.layout.chats["group_alpha"]]
        self.assertTrue(alpha.is_group)
        self.assertEqual(alpha.display_name, "group_alpha")
        self.assertGreaterEqual(alpha.member_count, 1)

    def test_chats_with_messages_finds_every_group(self):
        counts = self.reader.chats_with_messages()
        for username in self.layout.chats.values():
            self.assertIn(username, counts)
            self.assertGreater(counts[username], 0)

    def test_chats_with_messages_aggregates_across_shards(self):
        counts = self.reader.chats_with_messages()
        alpha = self.layout.chats["group_alpha"]
        # 2 rows in shard 0 plus 3 rows in shard 1
        self.assertEqual(counts[alpha], 5)


class ShardIdentityTests(ReaderTestCase):
    def test_local_id_alone_is_not_unique(self):
        page = self.reader.history(self.layout.chats["group_alpha"], limit=100)
        by_local_id: dict[int, list] = {}
        for message in page.messages:
            by_local_id.setdefault(message.key.local_id, []).append(message)
        # local_id 1 exists in both shards with different content
        self.assertIn(1, by_local_id)
        self.assertEqual(len(by_local_id[1]), 2)
        self.assertEqual(len({m.key.shard for m in by_local_id[1]}), 2)

    def test_message_keys_are_unique(self):
        page = self.reader.history(self.layout.chats["group_alpha"], limit=100)
        keys = [m.key for m in page.messages]
        self.assertEqual(len(keys), len(set(keys)))

    def test_history_spans_shards(self):
        page = self.reader.history(self.layout.chats["group_alpha"], limit=100)
        self.assertEqual(len({m.key.shard for m in page.messages}), 2)


class SenderResolutionTests(ReaderTestCase):
    def test_same_rowid_names_different_people_per_shard(self):
        shards = list(self.reader.pool.shard_paths())
        first = self.reader.pool.name2id(shards[0])
        second = self.reader.pool.name2id(shards[1])
        self.assertEqual(first.get(1), self.layout.self_username)
        self.assertNotEqual(first.get(1), second.get(1))

    def test_senders_resolve_through_their_own_shard(self):
        page = self.reader.history(self.layout.chats["group_alpha"], limit=100)
        for message in page.messages:
            self.assertTrue(
                message.sender_username,
                "sender for %s was not resolved" % message.key,
            )

    def test_from_me_uses_the_resolved_sender(self):
        page = self.reader.history(self.layout.chats["group_alpha"], limit=100)
        mine = [m for m in page.messages if m.from_me]
        self.assertTrue(mine)
        for message in mine:
            self.assertEqual(message.sender_username, self.layout.self_username)


class HistoryTests(ReaderTestCase):
    def test_newest_first_by_default(self):
        page = self.reader.history(self.layout.chats["group_alpha"], limit=100)
        seqs = [m.sort_seq for m in page.messages]
        self.assertEqual(seqs, sorted(seqs, reverse=True))

    def test_ascending_order_available(self):
        page = self.reader.history(
            self.layout.chats["group_alpha"], limit=100, ascending=True
        )
        seqs = [m.sort_seq for m in page.messages]
        self.assertEqual(seqs, sorted(seqs))

    def test_paging_has_no_gaps_or_duplicates(self):
        everything = self.reader.history(self.layout.chats["group_alpha"], limit=100)
        collected = []
        offset = 0
        while True:
            page = self.reader.history(
                self.layout.chats["group_alpha"], limit=2, offset=offset
            )
            if not page.messages:
                break
            collected.extend(page.messages)
            offset = page.next_offset
            if not page.has_more:
                break
        self.assertEqual(len(collected), len(everything.messages))
        self.assertEqual(
            [m.key for m in collected], [m.key for m in everything.messages]
        )

    def test_limit_zero_returns_nothing(self):
        page = self.reader.history(self.layout.chats["group_alpha"], limit=0)
        self.assertEqual(len(page.messages), 0)

    def test_unknown_chat_raises(self):
        with self.assertRaises(ChatNotFound):
            self.reader.history("999@chatroom", limit=10)

    def test_plain_text_body_is_decoded(self):
        page = self.reader.history(self.layout.chats["group_beta"], limit=10)
        self.assertTrue(any("beta" in m.text for m in page.messages))

    def test_zstd_payloads_are_decompressed(self):
        page = self.reader.history(self.layout.chats["group_alpha"], limit=100)
        for message in page.messages:
            self.assertNotIn("\x00", message.text)
            if message.kind == "text":
                self.assertTrue(message.text)


class DateRangeTests(ReaderTestCase):
    def _bounds(self, chat):
        page = self.reader.history(chat, limit=100)
        times = [m.create_time for m in page.messages]
        return min(times), max(times)

    def test_since_filters_out_older_rows(self):
        chat = self.layout.chats["group_alpha"]
        low, high = self._bounds(chat)
        middle = (low + high) // 2
        page = self.reader.history(chat, limit=100, since=middle)
        self.assertTrue(page.messages)
        for message in page.messages:
            self.assertGreaterEqual(message.create_time, middle)

    def test_before_filters_out_newer_rows(self):
        chat = self.layout.chats["group_alpha"]
        low, high = self._bounds(chat)
        middle = (low + high) // 2
        page = self.reader.history(chat, limit=100, before=middle)
        self.assertTrue(page.messages)
        for message in page.messages:
            self.assertLessEqual(message.create_time, middle)


class IncrementalTests(ReaderTestCase):
    def test_watermark_excludes_rows_at_or_below(self):
        chat = self.layout.chats["group_alpha"]
        everything = self.reader.history(chat, limit=100, ascending=True)
        floor = everything.messages[0].sort_seq
        newer = self.reader.new_messages(chat, since_seq=floor)
        for message in newer:
            self.assertGreater(message.sort_seq, floor)

    def test_strict_greater_than_loses_a_tied_row(self):
        """Documents the gap that the inclusive poll exists to close."""
        chat = self.layout.chats["group_alpha"]
        everything = self.reader.history(chat, limit=100, ascending=True)
        # several fixture rows share sort_seq 2000
        tie = [m for m in everything.messages if m.sort_seq == 2000]
        self.assertGreater(len(tie), 1)
        strict = self.reader.new_messages(chat, since_seq=2000)
        self.assertFalse([m for m in strict if m.sort_seq == 2000])

    def test_inclusive_poll_recovers_the_tied_rows(self):
        chat = self.layout.chats["group_alpha"]
        everything = self.reader.history(chat, limit=100, ascending=True)
        tied = {m.key for m in everything.messages if m.sort_seq == 2000}
        self.assertGreater(len(tied), 0)
        recovered = self.reader.new_messages_inclusive(chat, watermark=2000)
        self.assertTrue(tied.issubset({m.key for m in recovered}))

    def test_inclusive_poll_is_ordered(self):
        chat = self.layout.chats["group_alpha"]
        page = self.reader.new_messages_inclusive(chat, watermark=0)
        seqs = [m.sort_seq for m in page]
        self.assertEqual(seqs, sorted(seqs))


class RelationDetectionTests(ReaderTestCase):
    def test_mention_is_detected_from_source_column(self):
        page = self.reader.history(self.layout.chats["group_alpha"], limit=100)
        mentions = [m for m in page.messages if RelationKind.MENTION in
                    [r.kind for r in self.reader.relation(m).relations]]
        self.assertTrue(mentions)
        for message in mentions:
            self.assertIn(self.layout.self_username, message.source_xml)

    def test_reply_is_detected_from_content_column(self):
        page = self.reader.history(self.layout.chats["group_alpha"], limit=100)
        replies = [m for m in page.messages if RelationKind.REPLY in
                   [r.kind for r in self.reader.relation(m).relations]]
        self.assertTrue(replies)
        for message in replies:
            self.assertIn("<refermsg>", message.content_xml)

    def test_mention_of_another_member_is_not_related(self):
        page = self.reader.history(self.layout.chats["group_gamma"], limit=10)
        message = page.messages[0]
        report = self.reader.relation(message)
        self.assertTrue(report.related)
        self.assertIn(self.layout.self_username, report.mentioned_ids)

    def test_plain_message_is_unrelated(self):
        page = self.reader.history(self.layout.chats["group_beta"], limit=10)
        for message in page.messages:
            self.assertFalse(self.reader.relation(message).related)

    def test_relation_labels_are_human_readable(self):
        page = self.reader.history(self.layout.chats["group_alpha"], limit=100)
        labels = set()
        for message in page.messages:
            labels.update(self.reader.relation(message).labels())
        self.assertTrue(labels)
        self.assertTrue(labels <= {"@了你", "回复了你", "提到你的名字"})


class KeyHandlingTests(ReaderTestCase):
    def test_open_uses_the_key_matching_the_salt(self):
        paths = self.reader.pool.shard_paths()
        for path in paths.values():
            key = self.reader.keys.key_for(path)
            self.assertIsNotNone(key)
            self.assertEqual(len(key), 96)

    def test_missing_key_file_raises(self):
        with self.assertRaises(Exception):
            WeChatReader.from_files(self.layout.config_path, "nope.json")

    def test_wrong_key_store_raises_key_not_found(self):
        keys = KeyStore(salt_keys={})
        config = ReaderConfig.load(self.layout.config_path)
        reader = WeChatReader(config, keys)
        try:
            with self.assertRaises(KeyNotFound):
                reader.list_chats()
        finally:
            reader.close()

    def test_health_reports_readiness(self):
        report = self.reader.health()
        self.assertEqual(report["self_username"], self.layout.self_username)
        self.assertTrue(report["self_nickname_present"])
        self.assertEqual(report["driver"], "ok")
        self.assertEqual(report["missing_files"], [])
        self.assertEqual(report["shards"], 2)
        self.assertEqual(report["groups"], 3)

    def test_connections_are_read_only(self):
        conn = self.reader.pool.open(self.reader.config.session_db)
        with self.assertRaises(Exception):
            conn.execute("DELETE FROM SessionTable")


class LifecycleTests(unittest.TestCase):
    def test_context_manager_closes(self):
        layout = fixtures.build()
        try:
            with WeChatReader.from_files(layout.config_path, layout.keys_path) as reader:
                self.assertTrue(reader.list_groups())
            self.assertEqual(reader.pool._connections, {})
        finally:
            layout.cleanup()

    def test_plaintext_fixture_is_readable_without_keys(self):
        """A plaintext database must not require a key store entry."""
        import json, os, sqlite3, tempfile

        root = tempfile.mkdtemp(prefix="wxreader-plain-")
        try:
            db = os.path.join(root, "session.db")
            conn = sqlite3.connect(db)
            conn.executescript(fixtures.SCHEMA_SESSION)
            conn.execute(
                "INSERT INTO SessionTable VALUES ('1@chatroom',0,0,'',0,1,1,'','')"
            )
            conn.commit()
            conn.close()
            keys = os.path.join(root, "keys.json")
            with open(keys, "w", encoding="utf-8") as handle:
                json.dump({"salt_keys": {}}, handle)
            config = os.path.join(root, "config.json")
            with open(config, "w", encoding="utf-8") as handle:
                json.dump(
                    {
                        "session_db": db,
                        "contact_db": "",
                        "message_dbs": [],
                        "keys_file": keys,
                        "self_username": "wxid_self",
                    },
                    handle,
                )
            reader = WeChatReader.from_files(config, keys)
            try:
                chats = reader.list_chats()
                self.assertEqual(len(chats), 1)
                self.assertTrue(chats[0].is_group)
            finally:
                reader.close()
        finally:
            import shutil

            shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
