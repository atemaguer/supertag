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
                self.cli, self.tui if archive.SHIP_TUI else None, self.root / output,
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
        if archive.SHIP_TUI:
            self.assertEqual((destination / "supertag-tui").read_bytes(), self.tui.read_bytes())
        else:
            self.assertFalse((destination / "supertag-tui").exists())
            self.assertEqual(manifest["files"].keys(), {"supertag"})
        self.assertEqual((destination / "supertag").stat().st_mode & 0o777, 0o755)
        self.assertEqual((self.root / "fresh").stat().st_mode & 0o777, 0o700)

    def test_mismatched_versions_fail_before_emitting_archive(self):
        with patch.object(archive, "check_versions", side_effect=archive.ArchiveError("version mismatch")):
            with self.assertRaises(archive.ArchiveError):
                archive.create_archive(self.cli, self.tui if archive.SHIP_TUI else None, self.root / "out", version="0.1.0",
                    platform="linux-arm64", profile="release", features=[], source={"commit": None, "dirty": True})
        self.assertFalse(list((self.root / "out").glob("*.tar.gz")))

    def test_the_terminal_ui_goes_in_exactly_when_it_ships(self):
        wrong = None if archive.SHIP_TUI else self.tui
        with patch.object(archive, "check_versions"), self.assertRaisesRegex(archive.ArchiveError, "exactly when it ships"):
            archive.create_archive(self.cli, wrong, self.root / "out", version="0.1.0", platform="linux-arm64",
                                   profile="dev", features=[], source={"commit": None, "dirty": True})
        self.assertEqual(archive.BINARIES, ("supertag", "supertag-tui") if archive.SHIP_TUI else ("supertag",))

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


class TerminalUIBuild(unittest.TestCase):
    """The terminal UI build, without Bun: the commands it runs and what it refuses."""

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.repo = Path(temporary.name) / "repo"
        (self.repo / "core").mkdir(parents=True)
        (self.repo / "core/Cargo.toml").write_text('[workspace.package]\nversion = "1.2.3"\n')
        (self.repo / ".bun-version").write_text("1.4.5\n")
        package = self.repo / Path(archive.TUI_ENTRY).parents[1]
        (self.repo / archive.TUI_ENTRY).parent.mkdir(parents=True)
        (self.repo / archive.TUI_ENTRY).write_text("console.log('fixture')\n")
        (package / "package.json").write_text('{"name": "@fixture/tui"}')
        # pnpm's layout: the platform package sits beside the real @opentui/core directory.
        store = self.repo / "node_modules/.pnpm/core/node_modules/@opentui"
        (store / "core").mkdir(parents=True)
        (store / "core-linux-arm64").mkdir()
        self.library = store / "core-linux-arm64/libopentui.so"
        self.library.write_bytes(b"library")
        (package / "node_modules/@opentui").mkdir(parents=True)
        (package / "node_modules/@opentui/core").symlink_to(store / "core")
        self.bun = Path(temporary.name) / "bin/bun"
        self.bun.parent.mkdir()
        self.bun.write_text("#!/bin/sh\n")
        self.bun.chmod(0o755)
        self.commands = []

    def build(self, bun_version="1.4.5", **options):
        def run(command, **kwargs):
            self.commands.append(command)
            if command[:2] == [str(self.bun), "build"]:
                Path(command[command.index("--outfile") + 1]).write_bytes(b"compiled")
        with patch.object(archive, "native_platform", return_value="linux-arm64"), \
             patch.object(archive.subprocess, "check_output", return_value=bun_version + "\n"), \
             patch.object(archive.subprocess, "run", side_effect=run):
            return archive.build_tui(self.repo.parent / "out/supertag-tui", self.repo,
                                     {"PATH": str(self.bun.parent)}, **options)

    def test_compiles_the_entry_for_this_platform_only_with_the_release_version(self):
        output = self.build()
        self.assertEqual(output.read_bytes(), b"compiled")
        install, compile_ = self.commands
        self.assertEqual(install[:3], ["pnpm", "install", "--frozen-lockfile"])
        self.assertNotIn("--filter", install)
        self.assertEqual(compile_[:6], [str(self.bun), "build", "--compile", "--minify", "--bytecode", "--format=esm"])
        self.assertNotIn("--target", " ".join(compile_))
        externals = {compile_[index + 1] for index, value in enumerate(compile_) if value == "--external"}
        self.assertEqual(len(externals), len(archive.OPENTUI_PLATFORMS) - 1)
        self.assertNotIn("@opentui/core-linux-arm64", externals)
        self.assertIn('process.env.SUPERTAG_TUI_VERSION="1.2.3"', compile_)
        self.assertEqual(compile_[-1], str(self.repo / archive.TUI_ENTRY))
        with self.assertRaisesRegex(archive.ArchiveError, "already exists"):
            self.build()

    def test_a_bun_other_than_the_pin_is_refused(self):
        with self.assertRaisesRegex(archive.ArchiveError, "pinned 1.4.5"):
            self.build("1.3.6")
        self.assertEqual(self.commands, [])

    def test_the_library_is_signed_as_a_private_copy_before_compiling(self):
        signed = []
        def sign(path):
            signed.append(path)
            self.assertEqual(len(self.commands), 1, "signed before Bun compiles")
            path.write_bytes(b"signed library")
        with self.assertRaisesRegex(archive.ArchiveError, "only macOS"):
            self.build(sign_library=sign)
        # The same layout with macOS's package; a second link stands for pnpm's store.
        self.commands.clear()
        (self.library.parent.parent / "core-darwin-arm64").mkdir()
        mac = self.library.parent.parent / "core-darwin-arm64/libopentui.dylib"
        os.link(self.library, mac)
        os.link(mac, self.repo.parent / "mac-store-file")
        def run(command, **kwargs):
            self.commands.append(command)
            if command[:2] == [str(self.bun), "build"]:
                Path(command[command.index("--outfile") + 1]).write_bytes(b"compiled")
        with patch.object(archive, "native_platform", return_value="darwin-arm64"), \
             patch.object(archive.subprocess, "check_output", return_value="1.4.5\n"), \
             patch.object(archive.subprocess, "run", side_effect=run):
            archive.build_tui(self.repo.parent / "mac/supertag-tui", self.repo,
                              {"PATH": str(self.bun.parent)}, sign_library=sign)
        self.assertEqual(signed, [mac.resolve()])
        self.assertEqual(mac.read_bytes(), b"signed library")
        self.assertEqual((self.repo.parent / "mac-store-file").read_bytes(), b"library", "the store's file is untouched")

    def test_glibc_requirement_is_the_newest_symbol_version(self):
        binary = self.repo.parent / "elf"
        binary.write_bytes(b"\0GLIBC_2.2.5\0GLIBC_2.17\0GLIBC_PRIVATE\0GLIBC_2.3.4\0")
        self.assertEqual(archive.glibc_requirement(binary), (2, 17))
        binary.write_bytes(b"\0GLIBC_2.17\0GLIBC_2.34\0")
        self.assertEqual(archive.glibc_requirement(binary), (2, 34))
        with patch.object(archive.subprocess, "run",
                          return_value=archive.subprocess.CompletedProcess([], 0, "ok\n", "")):
            with self.assertRaisesRegex(archive.ArchiveError, "GLIBC_2.34, newer than GLIBC_2.17"):
                archive.check_tui(binary, "linux-arm64")
            self.assertEqual(archive.check_tui(binary, "darwin-arm64"), {"headless_check": True, "glibc": None})

    def test_a_terminal_ui_that_cannot_load_its_library_is_refused(self):
        with patch.object(archive.subprocess, "run",
                          return_value=archive.subprocess.CompletedProcess([], 1, "", "dlopen failed")):
            with self.assertRaisesRegex(archive.ArchiveError, "dlopen failed"):
                archive.check_tui(self.repo / "missing", "darwin-arm64")

    def test_the_embedded_library_licenses_are_copied_and_required(self):
        target = self.repo.parent / "licenses"
        with self.assertRaisesRegex(archive.ArchiveError, "expected license files"):
            archive.copy_tui_notices(self.repo, "linux-arm64", target)
        for name in ("LICENSE", "LICENSE-FFMPEG", "FFMPEG-SOURCE.md", "PATENTS-LIBWEBP", "index.js"):
            (self.library.parent / name).write_text(name)
        copied = archive.copy_tui_notices(self.repo, "linux-arm64", self.repo.parent / "licenses-2")
        self.assertEqual(copied, ["FFMPEG-SOURCE.md", "LICENSE", "LICENSE-FFMPEG", "PATENTS-LIBWEBP"])
        self.assertEqual((self.repo.parent / "licenses-2/LICENSE-FFMPEG").read_text(), "LICENSE-FFMPEG")


if __name__ == "__main__":
    unittest.main()
