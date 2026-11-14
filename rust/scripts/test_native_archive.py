"""Contract tests for the unpublished native archive format (no build tools needed)."""
import hashlib
import gzip
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import native_archive as archive


def elf():
    data = bytearray(64)
    data[:6] = b"\x7fELF\x02\x01"
    data[18:20] = (183).to_bytes(2, "little")
    return bytes(data)


class ArchiveContract(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.cli = self.root / "cli"
        self.tui = self.root / "tui"
        self.cli.write_bytes(elf() + b"cli")
        self.tui.write_bytes(elf() + b"tui")

    def tearDown(self):
        self.tmp.cleanup()

    def package(self, output=None):
        output = output or f"out-{len(list(self.root.iterdir()))}"
        with patch.object(archive, "check_versions"):
            return archive.create_archive(
                self.cli, self.tui, self.root / output,
                version="0.1.0", platform="linux-arm64", profile="dev",
                features=["test-fixtures"], source={"commit": "a" * 40, "dirty": True},
            )

    def rewrite(self, change):
        path = self.package()
        with tarfile.open(path, "r:gz") as source:
            entries = [(item, source.extractfile(item).read() if item.isfile() else None)
                       for item in source]
        entries = change(entries)
        with tarfile.open(path, "w:gz") as target:
            for item, data in entries:
                if data is not None:
                    item.size = len(data)
                target.addfile(item, io.BytesIO(data) if data is not None else None)
        archive.write_checksum(path)
        return path

    def test_deterministic_pair_checksum_manifest_and_private_extraction(self):
        first = self.package()
        second = self.package("second")
        self.assertEqual(first.read_bytes(), second.read_bytes())
        checksum = Path(str(first) + ".sha256").read_text()
        self.assertEqual(checksum, hashlib.sha256(first.read_bytes()).hexdigest() + "  " + first.name + "\n")
        manifest = archive.validate_archive(first)
        self.assertEqual(manifest["profile"], "dev")
        self.assertEqual(manifest["features"], ["test-fixtures"])
        self.assertTrue(manifest["source"]["dirty"])
        destination = archive.extract_archive(first, self.root / "fresh")
        self.assertEqual((destination / "supertag").read_bytes(), self.cli.read_bytes())
        self.assertEqual((destination / "supertag-tui").read_bytes(), self.tui.read_bytes())
        self.assertEqual((destination / "supertag").stat().st_mode & 0o777, 0o755)
        self.assertEqual((self.root / "fresh").stat().st_mode & 0o777, 0o700)

    def test_mismatched_versions_fail_before_emitting_archive(self):
        with patch.object(archive, "check_versions", side_effect=archive.ArchiveError("version mismatch")):
            with self.assertRaises(archive.ArchiveError):
                archive.create_archive(self.cli, self.tui, self.root / "out", version="0.1.0",
                    platform="linux-arm64", profile="release", features=[], source={"commit": None, "dirty": True})
        self.assertFalse(list((self.root / "out").glob("*.tar.gz")))

    def test_checksum_or_binary_digest_tampering_is_refused(self):
        path = self.package()
        Path(str(path) + ".sha256").write_text("0" * 64 + "  " + path.name + "\n")
        with self.assertRaises(archive.ArchiveError):
            archive.validate_archive(path)
        Path(str(path) + ".sha256").write_bytes(b"\xff")
        with self.assertRaises(archive.ArchiveError):
            archive.validate_archive(path)
        path = self.rewrite(lambda entries: [(item, data + b"changed" if item.name.endswith("/supertag") else data)
                                            for item, data in entries])
        with self.assertRaises(archive.ArchiveError):
            archive.extract_archive(path, self.root / "invalid")
        self.assertFalse((self.root / "invalid").exists())

    def test_paths_links_duplicates_and_extra_entries_are_refused(self):
        for kind in ("traversal", "symlink", "hardlink", "duplicate", "extra"):
            with self.subTest(kind=kind):
                def change(entries):
                    item = tarfile.TarInfo("../outside" if kind == "traversal" else entries[0][0].name + "/extra")
                    data = b"unexpected"
                    if kind in ("symlink", "hardlink"):
                        item.type = tarfile.SYMTYPE if kind == "symlink" else tarfile.LNKTYPE
                        item.linkname = "/etc/passwd"
                        data = None
                    if kind == "duplicate":
                        return entries + [entries[-1]]
                    return entries + [(item, data)]
                with self.assertRaises(archive.ArchiveError):
                    archive.validate_archive(self.rewrite(change))
        self.assertFalse((self.root / "outside").exists())

    def test_manifest_and_architecture_are_checked(self):
        def change(entries):
            changed = []
            for item, data in entries:
                if item.name.endswith("/manifest.json"):
                    manifest = json.loads(data)
                    manifest["version"] = "other"
                    data = json.dumps(manifest).encode()
                changed.append((item, data))
            return changed
        with self.assertRaises(archive.ArchiveError):
            archive.validate_archive(self.rewrite(change))
        self.cli.write_bytes(b"not a native executable")
        with self.assertRaises(archive.ArchiveError):
            self.package("bad-architecture")

    def test_existing_destination_and_oversized_members_are_refused(self):
        path = self.package()
        existing = self.root / "exists"
        existing.mkdir()
        (existing / "keep").write_text("preserved")
        with self.assertRaises(archive.ArchiveError):
            archive.extract_archive(path, existing)
        self.assertEqual((existing / "keep").read_text(), "preserved")
        with patch.object(archive, "MAX_BINARY_BYTES", 32):
            with self.assertRaises(archive.ArchiveError):
                archive.validate_archive(path)

    def test_extraction_uses_the_verified_copy_if_original_is_replaced(self):
        path = self.package()
        validate = archive.validate_archive
        def replace_after_verification(staged, checksum=None):
            result = validate(staged, checksum)
            path.write_bytes(b"replaced after validation")
            return result
        with patch.object(archive, "validate_archive", side_effect=replace_after_verification):
            destination = archive.extract_archive(path, self.root / "fresh")
        self.assertEqual((destination / "supertag").read_bytes(), self.cli.read_bytes())

    def test_truncated_gzip_or_tar_footer_and_trailing_data_are_refused(self):
        for kind in ("gzip-footer", "tar-footer", "raw-trailer", "gzip-member", "compressed-trailer"):
            with self.subTest(kind=kind):
                path = self.package()
                compressed = path.read_bytes()
                raw = gzip.decompress(compressed)
                if kind == "gzip-footer":
                    changed = compressed[:-8]
                elif kind == "tar-footer":
                    with tarfile.open(path, "r:gz") as source:
                        final = source.getmembers()[-1]
                    end = final.offset_data + ((final.size + 511) // 512) * 512
                    changed = gzip.compress(raw[:end])
                elif kind == "raw-trailer":
                    changed = gzip.compress(raw + b"hidden data")
                elif kind == "gzip-member":
                    changed = compressed + gzip.compress(b"hidden second member")
                else:
                    changed = compressed + b"not gzip data"
                path.write_bytes(changed)
                archive.write_checksum(path)
                with self.assertRaises(archive.ArchiveError):
                    archive.validate_archive(path)

    def test_valid_tar_and_gzip_zero_padding_remains_accepted(self):
        path = self.package()
        path.write_bytes(gzip.compress(gzip.decompress(path.read_bytes()) + b"\0" * 1024) + b"\0" * 32)
        archive.write_checksum(path)
        self.assertEqual(archive.validate_archive(path)["version"], "0.1.0")

    def test_validation_finishes_before_publication_and_failure_cleans_staging(self):
        output = self.root / "validation-failure"
        def reject_staged(path, checksum=None):
            self.assertFalse(list(output.glob("*.tar.gz")))
            self.assertFalse(list(output.glob("*.sha256")))
            raise archive.ArchiveError("injected staged validation failure")
        with patch.object(archive, "validate_archive", side_effect=reject_staged):
            with self.assertRaises(archive.ArchiveError):
                self.package(output.name)
        self.assertEqual(list(output.iterdir()), [])

    def test_concurrent_checksum_is_preserved_and_only_our_archive_is_rolled_back(self):
        link = os.link
        for replace_archive in (False, True):
            with self.subTest(replace_archive=replace_archive):
                output = self.root / f"concurrent-{replace_archive}"
                target = output / "supertag-0.1.0-linux-arm64-dev.tar.gz"
                def race(source, destination, **kwargs):
                    if str(destination).endswith(".sha256"):
                        if replace_archive:
                            target.unlink()
                            target.write_bytes(b"another publisher's archive")
                        Path(destination).write_bytes(b"another publisher's checksum")
                    return link(source, destination, **kwargs)
                with patch.object(archive.os, "link", side_effect=race):
                    with self.assertRaises(FileExistsError):
                        self.package(output.name)
                self.assertEqual(Path(str(target) + ".sha256").read_bytes(), b"another publisher's checksum")
                if replace_archive:
                    self.assertEqual(target.read_bytes(), b"another publisher's archive")
                else:
                    self.assertFalse(target.exists())
                self.assertFalse(list(output.glob(".supertag-native-stage-*")))

    def test_first_publication_failure_exposes_no_output(self):
        output = self.root / "link-failure"
        with patch.object(archive.os, "link", side_effect=OSError("injected publication failure")):
            with self.assertRaises(OSError):
                self.package(output.name)
        self.assertEqual(list(output.iterdir()), [])

    def test_partial_staging_copy_failure_leaves_no_artifact(self):
        output = self.root / "copy-failure"
        def fail_copy(reader, writer, limit):
            writer.write(reader.read(16))
            raise OSError("injected write failure after partial copy")
        with patch.object(archive, "copy_stream_bounded", side_effect=fail_copy):
            with self.assertRaises(OSError):
                self.package(output.name)
        self.assertEqual(list(output.iterdir()), [])

    def test_bounded_copy_rejects_input_growth_without_writing_past_limit(self):
        source, target = self.root / "growing", self.root / "copy"
        source.write_bytes(b"a" * 64)
        fstat = os.fstat
        def grow_after_stat(fd):
            result = fstat(fd)
            with source.open("ab") as writer:
                writer.write(b"b" * 64)
            return result
        with patch.object(archive.os, "fstat", side_effect=grow_after_stat):
            with self.assertRaises(archive.ArchiveError):
                archive.copy_bounded(source, target, 80)
        self.assertLessEqual(target.stat().st_size, 80)


if __name__ == "__main__":
    unittest.main()
