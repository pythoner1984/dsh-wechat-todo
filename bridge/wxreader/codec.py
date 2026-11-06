"""Decoding of the on-disk column payloads.

WeChat 4.x stores most message columns as either plain bytes, UTF-8 text, or a
zstd frame. Everything above this module should see ``str`` only.

Three payload families matter:

``message_content``
    Usually a zstd frame holding XML. Text messages may be plain UTF-8.
``source``
    ``<msgsource>`` XML describing the message envelope. This is where
    ``<atuserlist>`` lives, which is the only reliable record of who was
    @-mentioned.
``compress_content``
    A fallback copy of ``message_content`` used by some message kinds.

None of the decoding depends on the database, so every function here is pure
and can be tested against literal byte strings.
"""

from __future__ import annotations

import zstandard

from .errors import DriverUnavailable

ZSTD_MAGIC = b"\x28\xb5\x2f\xfd"

# WeChat can produce very large blobs (long forwarded articles). The cap keeps
# a corrupt frame from expanding without bound.
MAX_DECOMPRESSED = 8 * 1024 * 1024

_decoder: zstandard.ZstdDecompressor | None = None


def _decompressor() -> zstandard.ZstdDecompressor:
    global _decoder
    if _decoder is None:
        _decoder = zstandard.ZstdDecompressor()
    return _decoder


def is_zstd(blob: object) -> bool:
    """True when ``blob`` begins with the zstd frame magic."""
    if not isinstance(blob, (bytes, bytearray, memoryview)):
        return False
    raw = bytes(blob[: len(ZSTD_MAGIC)])
    return raw == ZSTD_MAGIC


def decompress(blob: bytes | bytearray | memoryview) -> str:
    """Decompress a zstd frame to UTF-8 text, or "" when it is not a frame."""
    if not is_zstd(blob):
        return ""
    try:
        with _decompressor().stream_reader(bytes(blob)) as reader:
            data = reader.read(MAX_DECOMPRESSED)
    except zstandard.ZstdError:
        return ""
    except OSError:
        return ""
    if not data:
        return ""
    return data.decode("utf-8", "replace")


def decode_text(blob: object) -> str:
    """Decode any column payload to text, tolerating plain bytes and zstd."""
    if blob is None:
        return ""
    if isinstance(blob, str):
        return blob
    if isinstance(blob, memoryview):
        blob = bytes(blob)
    if not isinstance(blob, (bytes, bytearray)):
        return ""
    if not blob:
        return ""
    if is_zstd(blob):
        return decompress(blob)
    try:
        return bytes(blob).decode("utf-8")
    except UnicodeDecodeError:
        return bytes(blob).decode("utf-8", "replace")


def require_driver() -> None:
    """Raise when the SQLCipher driver is missing.

    Kept here so the whole package fails with one clear error instead of an
    ImportError from deep inside a connection helper.
    """
    try:
        import sqlcipher3  # noqa: F401
    except ImportError:
        try:
            import pysqlcipher3  # noqa: F401
        except ImportError:
            raise DriverUnavailable(
                "reading an encrypted WeChat database needs the sqlcipher3 "
                "(or pysqlcipher3) driver; install it in the interpreter that "
                "runs this module",
                "driver_unavailable",
            ) from None
