#!/usr/bin/env python3
"""Fetch and verify the FFmpeg source that the release archives' terminal UI links.

supertag-tui embeds OpenTUI's native library, which statically links FFmpeg under the LGPL 2.1.
Each release archive carries OpenTUI's licenses/opentui/FFMPEG-SOURCE.md, which names the exact
FFmpeg source tarball and its SHA-256. This reads that file from every archive given, requires
them to name the same source, downloads it into OUTPUT, and fails unless its SHA-256 matches.
It writes NAME and NAME.sha256 (sha256sum format) and prints {"name", "url", "sha256"} as JSON.
The release attaches the tarball next to the archives, so their FFmpeg source ships with them.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import tarfile
import tempfile
import urllib.parse
import urllib.request

from native_archive import ArchiveError, require, write_checksum

NOTICE = "licenses/opentui/FFMPEG-SOURCE.md"
MAX_NOTICE_BYTES = 1024 * 1024
MAX_SOURCE_BYTES = 256 * 1024 * 1024
SOURCE_LINE = re.compile(r"^- Source: (\S+)$", re.MULTILINE)
DIGEST_LINE = re.compile(r"^- SHA-256: `([0-9a-f]{64})`$", re.MULTILINE)
TARBALL = re.compile(r"ffmpeg-[0-9]+(?:\.[0-9]+)*\.tar\.(?:xz|gz|bz2)")


def parse_notice(text):
    """The FFmpeg source URL and SHA-256 that OpenTUI's FFMPEG-SOURCE.md names."""
    sources, digests = SOURCE_LINE.findall(text), DIGEST_LINE.findall(text)
    require(len(sources) == 1 and len(digests) == 1,
            "FFMPEG-SOURCE.md must name exactly one FFmpeg source and one SHA-256")
    url = urllib.parse.urlsplit(sources[0])
    name = url.path.rsplit("/", 1)[-1]
    require(url.scheme == "https" and url.hostname == "ffmpeg.org" and not url.query and not url.fragment
            and TARBALL.fullmatch(name), f"FFMPEG-SOURCE.md names an unexpected FFmpeg source: {sources[0]}")
    return {"name": name, "url": sources[0], "sha256": digests[0]}


def notice_from_archive(path):
    """The FFMPEG-SOURCE.md text inside one complete release archive."""
    with tarfile.open(path, "r:gz") as archive:
        for member in archive:
            parts = member.name.split("/")
            if len(parts) == 4 and "/".join(parts[1:]) == NOTICE:
                require(member.isfile() and 0 < member.size <= MAX_NOTICE_BYTES,
                        f"{Path(path).name}: {NOTICE} is not a bounded regular file")
                with archive.extractfile(member) as handle:
                    return handle.read(MAX_NOTICE_BYTES).decode("utf-8")
    raise ArchiveError(f"{Path(path).name} carries no {NOTICE}")


def agreed_source(archives):
    """The one FFmpeg source every archive names."""
    require(archives, "name at least one release archive")
    sources = {Path(path).name: parse_notice(notice_from_archive(path)) for path in archives}
    require(len({json.dumps(source, sort_keys=True) for source in sources.values()}) == 1,
            f"the archives name different FFmpeg sources: {sources}")
    return next(iter(sources.values()))


def fetch(source, output, open_url=urllib.request.urlopen):
    """Download SOURCE into OUTPUT and keep it only if its SHA-256 matches."""
    output = Path(output)
    target = output / source["name"]
    require(not target.exists() and not Path(str(target) + ".sha256").exists(), f"{target} already exists")
    output.mkdir(parents=True, exist_ok=True)
    hashed, size = hashlib.sha256(), 0
    with tempfile.NamedTemporaryFile(dir=output, prefix=".ffmpeg-source-", delete=False) as partial:
        staged = Path(partial.name)
        try:
            with open_url(source["url"], timeout=120) as response:
                while chunk := response.read(1024 * 1024):
                    size += len(chunk)
                    require(size <= MAX_SOURCE_BYTES, "the FFmpeg source exceeds its size limit")
                    hashed.update(chunk)
                    partial.write(chunk)
        except BaseException:
            staged.unlink()
            raise
    if hashed.hexdigest() != source["sha256"]:
        staged.unlink()
        raise ArchiveError(f"{source['url']} has SHA-256 {hashed.hexdigest()}, not {source['sha256']} "
                           "as OpenTUI's FFMPEG-SOURCE.md records")
    staged.chmod(0o644)
    staged.rename(target)
    write_checksum(target)
    return target


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--output", type=Path, required=True, help="directory to write the tarball and its .sha256 into")
    parser.add_argument("archives", type=Path, nargs="+", help="complete release archives")
    args = parser.parse_args()
    try:
        source = agreed_source(args.archives)
        fetch(source, args.output)
    except (ArchiveError, OSError, tarfile.TarError, UnicodeError) as error:
        parser.exit(1, f"ffmpeg source: {error}\n")
    print(json.dumps(source, sort_keys=True))


if __name__ == "__main__":
    main()
