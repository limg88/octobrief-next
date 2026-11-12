"""A strict reader of the zip of an Office package, as strict as `listZipEntries` of the TypeScript
gate: a single disk, the directory exactly where the end record says, nothing after the end record
but its comment, no zip64, no encrypted entry, only stored or deflated entries, and every entry
inflated to exactly its declared size, step by step, never beyond it."""

from __future__ import annotations

import struct
import zlib
from dataclasses import dataclass

END_OF_DIRECTORY = 0x06054B50
ZIP64_LOCATOR = 0x07064B50
DIRECTORY_ENTRY = 0x02014B50
LOCAL_HEADER = 0x04034B50

# Compressed input handed to the inflater at a time: bounds what one step can produce.
INFLATE_STEP = 16 * 1024


class ZipUnreadable(Exception):
    """A zip that cannot be read exactly as it declares itself."""


@dataclass(frozen=True)
class ZipEntry:
    name: str
    method: int
    compressed_size: int
    declared_size: int
    data_offset: int


def _u16(b: bytes, at: int) -> int:
    if at < 0 or at + 2 > len(b):
        raise ZipUnreadable
    return struct.unpack_from("<H", b, at)[0]


def _u32(b: bytes, at: int) -> int:
    if at < 0 or at + 4 > len(b):
        raise ZipUnreadable
    return struct.unpack_from("<I", b, at)[0]


def list_entries(data: bytes) -> list[ZipEntry]:
    """The entries of the zip, from its central directory; nothing is inflated."""
    end = len(data) - 22
    while end >= 0 and _u32(data, end) != END_OF_DIRECTORY:
        if len(data) - end > 65_557:
            raise ZipUnreadable
        end -= 1
    if end < 0:
        raise ZipUnreadable
    if end >= 20 and _u32(data, end - 20) == ZIP64_LOCATOR:
        raise ZipUnreadable
    if _u16(data, end + 4) != 0 or _u16(data, end + 6) != 0:
        raise ZipUnreadable
    count = _u16(data, end + 10)
    if _u16(data, end + 8) != count:
        raise ZipUnreadable
    directory_size = _u32(data, end + 12)
    directory_offset = _u32(data, end + 16)
    if directory_offset + directory_size != end:
        raise ZipUnreadable
    if _u16(data, end + 20) != len(data) - end - 22:
        raise ZipUnreadable
    at = directory_offset
    entries: list[ZipEntry] = []
    for _ in range(count):
        if _u32(data, at) != DIRECTORY_ENTRY:
            raise ZipUnreadable
        flags = _u16(data, at + 8)
        method = _u16(data, at + 10)
        compressed_size = _u32(data, at + 20)
        declared_size = _u32(data, at + 24)
        name_length = _u16(data, at + 28)
        following = at + 46 + name_length + _u16(data, at + 30) + _u16(data, at + 32)
        local = _u32(data, at + 42)
        if flags & 1 or method not in (0, 8):
            raise ZipUnreadable
        if at + 46 + name_length > len(data):
            raise ZipUnreadable
        raw = data[at + 46 : at + 46 + name_length]
        try:
            name = raw.decode("utf-8") if flags & 2048 else raw.decode("latin-1")
        except UnicodeDecodeError as error:
            raise ZipUnreadable from error
        if _u32(data, local) != LOCAL_HEADER:
            raise ZipUnreadable
        data_offset = local + 30 + _u16(data, local + 26) + _u16(data, local + 28)
        if data_offset + compressed_size > len(data):
            raise ZipUnreadable
        entries.append(ZipEntry(name, method, compressed_size, declared_size, data_offset))
        at = following
    if at != end:
        raise ZipUnreadable
    return entries


def read_entry(data: bytes, entry: ZipEntry) -> bytes:
    """The data of one entry, exactly as long as it declares, or `ZipUnreadable`."""
    raw = data[entry.data_offset : entry.data_offset + entry.compressed_size]
    if entry.method == 0:
        if len(raw) != entry.declared_size:
            raise ZipUnreadable
        return bytes(raw)
    inflater = zlib.decompressobj(-15)
    out = bytearray()
    try:
        for at in range(0, len(raw), INFLATE_STEP):
            pending = raw[at : at + INFLATE_STEP]
            while pending:
                room = entry.declared_size - len(out) + 1
                out += inflater.decompress(pending, room)
                if len(out) > entry.declared_size:
                    raise ZipUnreadable
                pending = inflater.unconsumed_tail
        out += inflater.flush()
    except zlib.error as error:
        raise ZipUnreadable from error
    if not inflater.eof or len(out) != entry.declared_size:
        raise ZipUnreadable
    return bytes(out)
