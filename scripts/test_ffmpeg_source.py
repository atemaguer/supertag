"""The FFmpeg source the release attaches: read from the archives, agreed, and verified."""
import hashlib
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

import ffmpeg_source
from native_archive import REPO, ArchiveError

TARBALL = b"ffmpeg source bytes"


def notice(url="https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz", sha256=hashlib.sha256(TARBALL).hexdigest()):
    return (f"# FFmpeg\n\n- Source: {url}\n- SHA-256: `{sha256}`\n- License: LGPL-2.1-or-later\n"
            "- zlib 1.3.2: https://zlib.net/fossils/zlib-1.3.2.tar.gz\n"
            "- zlib SHA-256: `bb329a0a2cd0274d05519d61c667c062e06990d72e125ee2dfa8de64f0119d16`\n")


class Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


class FfmpegSource(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def archive(self, platform, text=None):
        path = self.root / f"supertag-0.1.0-{platform}-complete.tar.gz"
        with tarfile.open(path, "w:gz") as target:
            members = {"manifest.json": b"{}"}
            if text is not None:
                members[ffmpeg_source.NOTICE] = text.encode()
            for name, data in members.items():
                info = tarfile.TarInfo(f"supertag-0.1.0-{platform}-complete/{name}")
                info.size = len(data)
                target.addfile(info, io.BytesIO(data))
        return path

    def test_reads_the_source_every_archive_names(self):
        archives = [self.archive(platform, notice()) for platform in ("darwin-arm64", "linux-arm64")]
        self.assertEqual(ffmpeg_source.agreed_source(archives), {
            "name": "ffmpeg-9.0.2.tar.xz", "url": "https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz",
            "sha256": hashlib.sha256(TARBALL).hexdigest()})

    def test_refuses_archives_that_disagree_or_carry_none(self):
        with self.assertRaisesRegex(ArchiveError, "different FFmpeg sources"):
            ffmpeg_source.agreed_source([self.archive("darwin-arm64", notice()),
                                         self.archive("linux-arm64", notice(sha256="0" * 64))])
        with self.assertRaisesRegex(ArchiveError, "carries no"):
            ffmpeg_source.agreed_source([self.archive("linux-amd64")])

    def test_refuses_an_unexpected_or_ambiguous_source(self):
        for url in ("http://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz", "https://example.com/ffmpeg-9.0.2.tar.xz",
                    "https://ffmpeg.org/releases/../evil.sh"):
            with self.assertRaisesRegex(ArchiveError, "unexpected FFmpeg source"):
                ffmpeg_source.parse_notice(notice(url=url))
        with self.assertRaisesRegex(ArchiveError, "exactly one"):
            ffmpeg_source.parse_notice(notice() + notice())

    def test_keeps_the_download_only_when_its_digest_matches(self):
        source = ffmpeg_source.parse_notice(notice())
        output = self.root / "release"
        target = ffmpeg_source.fetch(source, output, open_url=lambda url, timeout: Response(TARBALL))
        self.assertEqual(target.read_bytes(), TARBALL)
        self.assertEqual(Path(str(target) + ".sha256").read_text(),
                         f"{source['sha256']}  ffmpeg-9.0.2.tar.xz\n")
        with self.assertRaisesRegex(ArchiveError, "already exists"):
            ffmpeg_source.fetch(source, output, open_url=lambda url, timeout: Response(TARBALL))
        tampered = self.root / "tampered"
        with self.assertRaisesRegex(ArchiveError, "not .* as OpenTUI's FFMPEG-SOURCE.md records"):
            ffmpeg_source.fetch(source, tampered, open_url=lambda url, timeout: Response(b"other bytes"))
        self.assertEqual(list(tampered.iterdir()), [])

    def test_notice_names_the_opentui_the_terminal_ui_depends_on(self):
        version = json.loads((REPO / "apps/tui/package.json").read_text())["dependencies"]["@opentui/core"]
        text = " ".join((REPO / "NOTICE").read_text().split())
        self.assertIn(f"@opentui/core-PLATFORM {version} packages", text)
        self.assertIn(f"tag v{version}", text)


if __name__ == "__main__":
    unittest.main()
