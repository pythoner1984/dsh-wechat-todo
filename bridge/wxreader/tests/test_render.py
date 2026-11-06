"""Rendering and type-decoding tests.

These cover what a browser sees, not what the database stores: `local_type`
packs an app-message subtype into the high 32 bits, and every non-text payload
is XML. Both facts were measured against the real database and would otherwise
regress silently, because a wrong render still looks like "some string".
"""

from __future__ import annotations

import unittest

from wxreader.store import base_type, kind_of
from wxreader import store


class TypeDecodingTests(unittest.TestCase):
    def test_plain_types_have_no_subtype(self):
        for value in (1, 3, 34, 43, 47, 48, 10000):
            self.assertEqual(base_type(value), value)

    def test_base_types_map_to_names(self):
        self.assertEqual(kind_of(1), "text")
        self.assertEqual(kind_of(3), "image")
        self.assertEqual(kind_of(34), "voice")
        self.assertEqual(kind_of(43), "video")
        self.assertEqual(kind_of(47), "sticker")
        self.assertEqual(kind_of(48), "location")
        self.assertEqual(kind_of(10000), "system")

    def test_app_message_subtype_lives_in_the_high_word(self):
        # Measured row: 21474836529 == (5 << 32) | 49
        self.assertEqual(base_type(21474836529), 49)
        self.assertEqual(kind_of(21474836529), "link")
        # 25769803825 == (6 << 32) | 49, a file attachment
        self.assertEqual(kind_of(25769803825), "file")

    def test_unknown_app_subtype_stays_readable(self):
        self.assertEqual(kind_of((987654 << 32) | 49), "app")

    def test_unknown_base_type_reports_its_number(self):
        self.assertEqual(kind_of(4242), "type_4242")


class RenderTests(unittest.TestCase):
    def test_plain_text_is_untouched(self):
        self.assertEqual(store._render_text("李四，这个合同付一下", "text"),
                         "李四，这个合同付一下")

    def test_group_sender_prefix_is_stripped_before_markup_is_detected(self):
        # Real group rows start with "wxid_xxx: " and then hold XML. Inspecting
        # the raw string for a leading "<" therefore misses every group row.
        raw = 'wxid_someone: <?xml version="1.0"?><msg><img aeskey="x"/></msg>'
        self.assertEqual(store._render_text(raw, "image"), "[图片]")

    def test_group_sender_prefix_is_stripped_from_plain_text(self):
        # The same prefix sits in front of plain text, where it used to survive
        # into the UI as a stray "wxid_xxx:" line above every message.
        raw = "wxid_someone: 李四，这个合同付一下"
        self.assertEqual(store._render_text(raw, "text"), "李四，这个合同付一下")

    def test_chatroom_prefix_is_also_stripped(self):
        raw = "123@chatroom: 明天下午三点开会"
        self.assertEqual(store._render_text(raw, "text"), "明天下午三点开会")

    def test_ordinary_colon_text_is_not_treated_as_a_prefix(self):
        for raw in ("价格: 12", "https://example.com/a", "注意: 别迟到"):
            with self.subTest(raw=raw):
                self.assertEqual(store._render_text(raw, "text"), raw)

    def test_image_becomes_a_placeholder(self):
        raw = '<?xml version="1.0"?><msg><img aeskey="abc" length="9"/></msg>'
        self.assertEqual(store._render_text(raw, "image"), "[图片]")

    def test_file_keeps_its_name(self):
        raw = (
            "<msg><appmsg><title>7万元开发费合同.pdf</title><des></des>"
            "<type>6</type></appmsg></msg>"
        )
        self.assertEqual(store._render_text(raw, "file"), "7万元开发费合同.pdf")

    def test_link_keeps_title_and_description(self):
        raw = (
            "<msg><appmsg><title>一篇好文章</title><des>值得一读</des>"
            "<type>5</type></appmsg></msg>"
        )
        self.assertEqual(store._render_text(raw, "link"), "一篇好文章 · 值得一读")

    def test_cdata_titles_are_unwrapped(self):
        raw = "<msg><appmsg><title><![CDATA[红包封面]]></title><type>2001</type></appmsg></msg>"
        self.assertEqual(store._render_text(raw, "red_packet"), "红包封面")

    def test_location_uses_the_point_of_interest(self):
        raw = '<msg><location poiname="某产业园" label="杭州"/></msg>'
        self.assertEqual(store._render_text(raw, "location"), "[位置] 某产业园")

    def test_voice_has_no_body_so_it_falls_back(self):
        self.assertEqual(store._render_text("<msg><voicemsg length='9'/></msg>", "voice"),
                         "[语音]")

    def test_empty_payload_uses_the_kind_placeholder(self):
        self.assertEqual(store._render_text("", "image"), "[图片]")
        self.assertEqual(store._render_text("   ", "video"), "[视频]")


if __name__ == "__main__":
    unittest.main()
