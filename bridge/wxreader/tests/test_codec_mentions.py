"""Offline tests for the pure decoding and relation logic.

Nothing here touches a database, so these run anywhere, including a machine
without SQLCipher.
"""

from __future__ import annotations

import unittest

import zstandard

from wxreader import codec
from wxreader.config import database_salt
from wxreader.mentions import (
    RelationKind,
    detect_relation,
    parse_at_user_list,
    parse_quoted_message,
)
from wxreader.store import local_date_to_epoch, table_for


class CodecTests(unittest.TestCase):
    def test_plain_utf8_passes_through(self):
        self.assertEqual(codec.decode_text("hello".encode("utf-8")), "hello")

    def test_str_passes_through(self):
        self.assertEqual(codec.decode_text("already text"), "already text")

    def test_empty_returns_empty(self):
        for value in (None, "", b"", bytearray()):
            self.assertEqual(codec.decode_text(value), "")

    def test_zstd_frame_is_decompressed(self):
        payload = zstandard.ZstdCompressor().compress("压缩的内容".encode("utf-8"))
        self.assertTrue(codec.is_zstd(payload))
        self.assertEqual(codec.decode_text(payload), "压缩的内容")

    def test_non_frame_bytes_are_not_treated_as_zstd(self):
        self.assertFalse(codec.is_zstd(b"not a frame"))
        self.assertEqual(codec.decode_text(b"not a frame"), "not a frame")

    def test_truncated_frame_returns_empty_not_raise(self):
        payload = zstandard.ZstdCompressor().compress(b"x" * 500)
        broken = payload[:12]
        self.assertEqual(codec.decode_text(broken), "")

    def test_invalid_utf8_is_replaced_not_fatal(self):
        self.assertIsInstance(codec.decode_text(b"\xff\xfe"), str)

    def test_memoryview_is_accepted(self):
        self.assertEqual(codec.decode_text(memoryview(b"abc")), "abc")


class SaltTests(unittest.TestCase):
    def test_plaintext_sqlite_has_no_salt(self):
        import tempfile, os

        handle, path = tempfile.mkstemp()
        os.close(handle)
        try:
            with open(path, "wb") as stream:
                stream.write(b"SQLite format 3\x00" + b"\x00" * 64)
            self.assertEqual(database_salt(path), "")
        finally:
            os.unlink(path)

    def test_missing_file_has_no_salt(self):
        self.assertEqual(database_salt("definitely-not-here.db"), "")

    def test_short_file_has_no_salt(self):
        import tempfile, os

        handle, path = tempfile.mkstemp()
        os.close(handle)
        try:
            with open(path, "wb") as stream:
                stream.write(b"\x01\x02")
            self.assertEqual(database_salt(path), "")
        finally:
            os.unlink(path)


class AtUserListTests(unittest.TestCase):
    def test_single_mention(self):
        xml = "<msgsource><atuserlist>wxid_a</atuserlist></msgsource>"
        self.assertEqual(parse_at_user_list(xml), ["wxid_a"])

    def test_comma_separated_mentions(self):
        xml = "<atuserlist>wxid_a,wxid_b,wxid_c</atuserlist>"
        self.assertEqual(parse_at_user_list(xml), ["wxid_a", "wxid_b", "wxid_c"])

    def test_cdata_wrapper_is_unwrapped(self):
        xml = "<atuserlist><![CDATA[wxid_a,wxid_b]]></atuserlist>"
        self.assertEqual(parse_at_user_list(xml), ["wxid_a", "wxid_b"])

    def test_empty_cdata_yields_nothing(self):
        xml = "<atuserlist><![CDATA[]]></atuserlist>"
        self.assertEqual(parse_at_user_list(xml), [])

    def test_duplicates_are_collapsed(self):
        xml = "<atuserlist>wxid_a,wxid_a</atuserlist>"
        self.assertEqual(parse_at_user_list(xml), ["wxid_a"])

    def test_missing_tag_yields_nothing(self):
        self.assertEqual(parse_at_user_list("<msgsource></msgsource>"), [])
        self.assertEqual(parse_at_user_list(""), [])

    def test_markup_noise_is_rejected(self):
        xml = "<atuserlist><b>bad</b></atuserlist>"
        self.assertEqual(parse_at_user_list(xml), [])

    def test_group_id_with_at_sign_is_kept(self):
        # atuserlist can carry a chatroom id, not only wxids
        xml = "<atuserlist>123@chatroom</atuserlist>"
        self.assertEqual(parse_at_user_list(xml), ["123@chatroom"])


class QuotedMessageTests(unittest.TestCase):
    def test_reply_is_parsed(self):
        xml = (
            "<msg><appmsg><refermsg><type>1</type><fromusr>wxid_a</fromusr>"
            "<displayname>张三</displayname><content>原文内容</content>"
            "</refermsg></appmsg></msg>"
        )
        quoted = parse_quoted_message(xml)
        self.assertIsNotNone(quoted)
        self.assertEqual(quoted.from_user, "wxid_a")
        self.assertEqual(quoted.display_name, "张三")
        self.assertEqual(quoted.content, "原文内容")

    def test_no_refermsg_returns_none(self):
        self.assertIsNone(parse_quoted_message("<msg></msg>"))
        self.assertIsNone(parse_quoted_message(""))

    def test_missing_fields_stay_empty(self):
        quoted = parse_quoted_message("<refermsg><type>1</type></refermsg>")
        self.assertIsNotNone(quoted)
        self.assertEqual(quoted.from_user, "")


class RelationTests(unittest.TestCase):
    def test_mention_by_structured_list(self):
        report = detect_relation(
            self_username="wxid_self",
            source_xml="<atuserlist>wxid_self,wxid_other</atuserlist>",
            rendered_text="@我自己 看下这个",
        )
        self.assertTrue(report.related)
        self.assertEqual([r.kind for r in report.relations], [RelationKind.MENTION])
        self.assertEqual(report.labels(), ["@了你"])

    def test_mention_of_someone_else_is_not_related(self):
        report = detect_relation(
            self_username="wxid_self",
            source_xml="<atuserlist>wxid_other</atuserlist>",
            rendered_text="@别人 看下",
        )
        self.assertFalse(report.related)

    def test_reply_to_me(self):
        xml = "<refermsg><fromusr>wxid_self</fromusr></refermsg>"
        report = detect_relation(
            self_username="wxid_self", content_xml=xml, rendered_text="回复你的消息"
        )
        self.assertTrue(report.related)
        self.assertEqual(report.labels(), ["回复了你"])

    def test_reply_to_someone_else_is_not_related(self):
        xml = "<refermsg><fromusr>wxid_other</fromusr></refermsg>"
        report = detect_relation(
            self_username="wxid_self", content_xml=xml, rendered_text="回复别人的消息"
        )
        self.assertFalse(report.related)

    def test_nickname_in_body_is_the_weakest_signal(self):
        report = detect_relation(
            self_username="wxid_self",
            rendered_text="这个事我自己处理",
            self_nickname="我自己",
        )
        self.assertTrue(report.related)
        self.assertEqual(report.labels(), ["提到你的名字"])

    def test_structured_signal_wins_over_nickname(self):
        report = detect_relation(
            self_username="wxid_self",
            source_xml="<atuserlist>wxid_self</atuserlist>",
            rendered_text="@我自己 你看",
            self_nickname="我自己",
        )
        self.assertEqual(report.labels(), ["@了你"])

    def test_both_signals_reported(self):
        report = detect_relation(
            self_username="wxid_self",
            source_xml="<atuserlist>wxid_self</atuserlist>",
            content_xml="<refermsg><fromusr>wxid_self</fromusr></refermsg>",
        )
        self.assertEqual(sorted(report.labels()), sorted(["@了你", "回复了你"]))

    def test_nothing_matches(self):
        report = detect_relation(
            self_username="wxid_self",
            source_xml="<atuserlist>wxid_other</atuserlist>",
            rendered_text="普通消息",
        )
        self.assertFalse(report.related)
        self.assertEqual(report.labels(), [])

    def test_empty_self_username_never_matches(self):
        report = detect_relation(
            self_username="",
            source_xml="<atuserlist>wxid_self</atuserlist>",
            rendered_text="@我自己",
            self_nickname="我自己",
        )
        self.assertFalse(report.related)


class DateAndTableTests(unittest.TestCase):
    def test_table_name_is_md5_of_username(self):
        import hashlib

        expected = "Msg_" + hashlib.md5(b"123@chatroom").hexdigest()
        self.assertEqual(table_for("123@chatroom"), expected)

    def test_date_start_of_day(self):
        start = local_date_to_epoch("2026-10-27")
        self.assertEqual(start % 86400, 57600)  # 16:00 UTC == 00:00 +08:00

    def test_date_end_of_day_is_inclusive(self):
        end = local_date_to_epoch("2026-10-27", end_of_day=True)
        self.assertEqual(end - local_date_to_epoch("2026-10-27"), 86399)

    def test_iso_datetime_is_accepted(self):
        self.assertGreater(local_date_to_epoch("2026-10-27T12:00:00"), 0)

    def test_bad_date_raises(self):
        from wxreader.errors import ReaderError

        with self.assertRaises(ReaderError):
            local_date_to_epoch("not-a-date")


if __name__ == "__main__":
    unittest.main()
