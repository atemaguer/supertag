#!/usr/bin/env python3
"""Lay out the desktop app's disk image as a drag-to-install window, and check a mounted image.

    dmg_layout.py write DIRECTORY   write DIRECTORY/.DS_Store for the folder that becomes the volume
    dmg_layout.py check DIRECTORY   check a staged folder or a mounted image

The volume holds SuperTag.app, a symbolic link named Applications to /Applications, and the
.DS_Store that tells Finder how to show them: an icon-view window with no toolbar or sidebar, the
app on the left and Applications on the right. The window has no background picture, so it follows
light and dark appearance. The volume has no icon of its own: that would add the 2 MB icon file to
every image and a read-write mount to set the volume's custom-icon flag.

Finder is not asked to arrange the window, because scripting it on a release runner with no
desktop session is unreliable. This writes the .DS_Store directly instead: a buddy-allocated file
that holds one B-tree leaf of records. The bytes match what the `ds_store` Python library writes
for the same records, which is how the layout was checked; the format is described in that
library and in https://wiki.mozilla.org/DS_Store_File_Format. It uses only the standard library
and runs on the Python 3.9 that Xcode's command line tools install.
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import plistlib
import re
import stat
import struct
import sys

APP = "SuperTag.app"
LINK = "Applications"
LINK_TARGET = "/Applications"
STORE = ".DS_Store"
# What macOS itself can add to a volume's root while hdiutil builds the image.
SYSTEM_ENTRIES = frozenset({".fseventsd", ".Trashes"})

# The window's place on screen and size in points, title bar included.
WINDOW = (200, 120, 600, 400)
ICON_SIZE = 128
# Each icon's centre, in points from the top left of the window's content.
POSITIONS = {APP: (160, 170), LINK: (440, 170)}

WINDOW_SETTINGS = {
    "ContainerShowSidebar": False,
    "PreviewPaneVisibility": False,
    "ShowPathbar": False,
    "ShowSidebar": False,
    "ShowStatusBar": False,
    "ShowTabView": False,
    "ShowToolbar": False,
    "SidebarWidth": 0,
    "WindowBounds": "{{%d, %d}, {%d, %d}}" % WINDOW,
}
# backgroundType 0 is Finder's default background, which follows light and dark appearance.
ICON_VIEW_SETTINGS = {
    "arrangeBy": "none",
    "backgroundColorBlue": 1.0,
    "backgroundColorGreen": 1.0,
    "backgroundColorRed": 1.0,
    "backgroundType": 0,
    "gridOffsetX": 0.0,
    "gridOffsetY": 0.0,
    "gridSpacing": 100.0,
    "iconSize": float(ICON_SIZE),
    "labelOnBottom": True,
    "scrollPositionX": 0.0,
    "scrollPositionY": 0.0,
    "showIconPreview": True,
    "showItemInfo": False,
    "textSize": 13.0,
    "viewOptionsVersion": 1,
}

PAGE_SIZE = 4096
# Every offset in the file counts from byte 4, after the first magic number.
BASE = 4
# Block addresses carry the block's size as a power of two in their low five bits.
ROOT_BLOCK, SUPER_BLOCK, NODE_BLOCK = 2048 | 11, 32 | 5, 8192 | 13
# The blocks of each power-of-two size left free once those three are taken out of the 2 GB space.
FREE_WIDTHS = frozenset(range(6, 31)) - {11, 13}


class LayoutError(Exception):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise LayoutError(message)


def record(name: str, code: bytes, kind: bytes, value: bytes) -> bytes:
    encoded = name.encode("utf-16-be")
    return struct.pack(">I", len(encoded) // 2) + encoded + code + kind + value


def blob(data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + data


def records() -> list[bytes]:
    """The records in the order Finder keeps them: by name without case, then by code."""
    def plist(value: dict) -> bytes:
        return blob(plistlib.dumps(value, fmt=plistlib.FMT_BINARY, sort_keys=True))

    def location(name: str) -> bytes:
        return blob(struct.pack(">IIII", *POSITIONS[name], 0xFFFFFFFF, 0xFFFF0000))

    return [
        record(".", b"bwsp", b"blob", plist(WINDOW_SETTINGS)),
        record(".", b"icvl", b"type", b"icnv"),
        record(".", b"icvp", b"blob", plist(ICON_VIEW_SETTINGS)),
        record(".", b"vSrn", b"long", struct.pack(">I", 1)),
        record(LINK, b"Iloc", b"blob", location(LINK)),
        record(APP, b"Iloc", b"blob", location(APP)),
    ]


def build_store() -> bytes:
    entries = records()
    node = struct.pack(">II", 0, len(entries)) + b"".join(entries)
    require(len(node) <= PAGE_SIZE, "the records do not fit one B-tree node")

    root = struct.pack(">II", 3, 0) + struct.pack(">3I", ROOT_BLOCK, SUPER_BLOCK, NODE_BLOCK)
    root += bytes(4 * 253)
    root += struct.pack(">IB4sI", 1, 4, b"DSDB", 1)
    for width in range(32):
        root += struct.pack(">II", 1, 1 << width) if width in FREE_WIDTHS else struct.pack(">I", 0)

    def place(image: bytearray, address: int, data: bytes) -> None:
        offset, size = BASE + (address & ~0x1F), 1 << (address & 0x1F)
        require(len(data) <= size, "a block overflows")
        image[offset:offset + size] = data.ljust(size, b"\0")

    image = bytearray(BASE + 16384)
    image[:36] = struct.pack(">I4sIII16s", 1, b"Bud1", 2048, 2048, 2048,
                             bytes.fromhex("0000100c" "00000087" "0000200b" "00000000"))
    place(image, SUPER_BLOCK, struct.pack(">IIIII", 2, 0, len(entries), 1, PAGE_SIZE))
    place(image, ROOT_BLOCK, root)
    place(image, NODE_BLOCK, node)
    return bytes(image)


class Reader:
    def __init__(self, data: bytes, offset: int, end: int) -> None:
        self.data, self.offset, self.end = data, offset, min(end, len(data))

    def take(self, size: int) -> bytes:
        require(size >= 0 and self.offset + size <= self.end, ".DS_Store is truncated")
        self.offset += size
        return self.data[self.offset - size:self.offset]

    def unpack(self, layout: str) -> tuple:
        return struct.unpack(layout, self.take(struct.calcsize(layout)))


def parse_store(data: bytes) -> dict[tuple[str, str], object]:
    """Read every record of a .DS_Store, whatever wrote it, as {(name, code): value}."""
    header = Reader(data, 0, len(data))
    magic, buddy, offset, size, again, _ = header.unpack(">I4sIII16s")
    require(magic == 1 and buddy == b"Bud1" and offset == again, "not a .DS_Store file")
    root = Reader(data, BASE + offset, BASE + offset + size)
    count, _ = root.unpack(">II")
    addresses = root.unpack(f">{(count + 255) & ~255}I")[:count]
    directory = {}
    for _ in range(root.unpack(">I")[0]):
        name = root.take(root.unpack("B")[0])
        directory[name] = root.unpack(">I")[0]
    require(b"DSDB" in directory, ".DS_Store has no DSDB entry")

    def block(number: int) -> Reader:
        require(number < len(addresses), ".DS_Store names a missing block")
        start = BASE + (addresses[number] & ~0x1F)
        return Reader(data, start, start + (1 << (addresses[number] & 0x1F)))

    def entry(reader: Reader) -> tuple[tuple[str, str], object]:
        name = reader.take(2 * reader.unpack(">I")[0]).decode("utf-16-be")
        code, kind = reader.unpack(">4s4s")
        if kind == b"bool":
            value = reader.unpack(">?")[0]
        elif kind in (b"long", b"shor"):
            value = reader.unpack(">I")[0]
        elif kind == b"blob":
            value = reader.take(reader.unpack(">I")[0])
        elif kind == b"ustr":
            value = reader.take(2 * reader.unpack(">I")[0]).decode("utf-16-be")
        elif kind == b"type":
            value = reader.take(4).decode("latin-1")
        elif kind in (b"comp", b"dutc"):
            value = reader.unpack(">Q")[0]
        else:
            raise LayoutError(f".DS_Store has a record of unknown type {kind!r}")
        return (name, code.decode("latin-1")), value

    found: dict[tuple[str, str], object] = {}

    def walk(number: int, depth: int) -> None:
        require(depth < 16, ".DS_Store's tree is too deep")
        reader = block(number)
        last, entries = reader.unpack(">II")
        for _ in range(entries):
            if last:
                walk(reader.unpack(">I")[0], depth + 1)
            key, value = entry(reader)
            found[key] = value
        if last:
            walk(last, depth + 1)

    walk(block(directory[b"DSDB"]).unpack(">I")[0], 0)
    return found


def check_store(data: bytes) -> None:
    """Fail unless the .DS_Store shows the drag-to-install window."""
    found = parse_store(data)
    names = {name for name, _ in found}
    require(names == {".", APP, LINK}, f".DS_Store describes {sorted(names)}, not the app and {LINK}")
    require(found.get((".", "icvl")) == "icnv", "the window does not open in icon view")
    for code in ("bwsp", "icvp"):
        require(isinstance(found.get((".", code)), bytes), f".DS_Store has no {code} record")
    window = plistlib.loads(found[(".", "bwsp")])
    for key in ("ShowToolbar", "ShowSidebar", "ShowPathbar", "ShowStatusBar", "ShowTabView"):
        require(window.get(key) is False, f"the window sets {key} to {window.get(key)!r}")
    bounds = re.fullmatch(r"\{\{(\d+), (\d+)\}, \{(\d+), (\d+)\}\}", str(window.get("WindowBounds")))
    require(bounds is not None, f"the window's bounds are {window.get('WindowBounds')!r}")
    _, _, width, height = (int(part) for part in bounds.groups())
    require((width, height) == WINDOW[2:], f"the window is {width} by {height}")
    view = plistlib.loads(found[(".", "icvp")])
    require(view.get("iconSize") == ICON_SIZE, f"the icons are {view.get('iconSize')!r} points")
    require(view.get("arrangeBy") == "none", "Finder would rearrange the icons")
    require(view.get("backgroundType") == 0, "the window has a background of its own")
    places = {}
    for name in (APP, LINK):
        location = found.get((name, "Iloc"))
        require(isinstance(location, bytes) and len(location) == 16, f"{name} has no position")
        places[name] = struct.unpack(">II", location[:8])
        require(places[name] == POSITIONS[name], f"{name} is at {places[name]}")
    half = ICON_SIZE // 2
    require(places[APP][0] + half < places[LINK][0] - half and places[APP][1] == places[LINK][1],
            "the app is not left of Applications on one row")
    # The window's content is its bounds less a title bar of about 28 points; labels need room too.
    for x, y in places.values():
        require(half <= x <= width - half and half <= y <= height - 28 - half - 30,
                "an icon falls outside the window")


def check_volume(directory: Path) -> None:
    """Fail unless the folder holds exactly the app, the Applications link, and the layout."""
    names = {entry.name for entry in os.scandir(directory)} - SYSTEM_ENTRIES
    expected = {APP, LINK, STORE}
    require(not names - expected, f"{directory} holds unexpected {sorted(names - expected)}")
    require(expected <= names, f"{directory} lacks {sorted(expected - names)}")
    app = os.lstat(directory / APP)
    require(stat.S_ISDIR(app.st_mode), f"{APP} is not a folder")
    require(os.path.islink(directory / LINK), f"{LINK} is not a symbolic link")
    target = os.readlink(directory / LINK)
    require(target == LINK_TARGET, f"{LINK} points to {target!r}, not {LINK_TARGET}")
    require(stat.S_ISREG(os.lstat(directory / STORE).st_mode), f"{STORE} is not a regular file")
    check_store((directory / STORE).read_bytes())


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("command", choices=("write", "check"))
    parser.add_argument("directory", type=Path)
    arguments = parser.parse_args()
    try:
        if arguments.command == "write":
            (arguments.directory / STORE).write_bytes(build_store())
        else:
            check_volume(arguments.directory)
            print(f"{arguments.directory} holds {APP} and {LINK} -> {LINK_TARGET}, laid out for dragging.")
    except (LayoutError, OSError) as error:
        print(f"dmg_layout: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
