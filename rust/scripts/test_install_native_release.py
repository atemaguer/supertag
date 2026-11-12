"""Local install/upgrade boundaries, with native execution replaced by probes."""
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from native_archive import ArchiveError
from node_bridges import PACKAGES, entry_for
from release_archive import create_release
from test_native_archive import elf
import install_native_release as installer


class NativeInstallContracts(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.home = self.root / "home"
        self.home.mkdir(mode=0o700)
        self.env = {"HOME": str(self.home), "PATH": os.defpath}
        self.node = self.root / "node"
        self.node.write_bytes(elf())
        self.node.chmod(0o755)
        self.stage = self.root / "stage"
        self.stage.mkdir()
        for name in ("supertag", "supertag-tui"):
            (self.stage / name).write_bytes(elf() + name.encode())
            (self.stage / name).chmod(0o755)
        for kind, package in PACKAGES.items():
            entry = self.stage / "node-bridges/node_modules" / package / entry_for(kind)
            entry.parent.mkdir(parents=True)
            entry.write_text("compiled helper")
        (self.stage / "node-bridges/manifest.json").write_text("{}")
        self.source = {"commit": "a" * 40, "archive_sha256": "b" * 64,
                       "lockfiles": {name: "c" * 64 for name in ("pnpm-lock.yaml", "rust/Cargo.lock", "apps/tui/go.sum")}}
        self.archive = self.package("0.1.0")
        for name in ("verify_node", "check_versions", "smoke_entry"):
            context = patch.object(installer, name)
            context.start()
            self.addCleanup(context.stop)
        context = patch.object(installer, "native_platform", return_value="linux-arm64")
        context.start()
        self.addCleanup(context.stop)

    def package(self, version):
        return create_release(self.stage, self.root / ("out-" + version), version=version,
                              platform="linux-arm64", profile="release", source=self.source)

    def install(self, archive=None, **options):
        return installer.install(archive or self.archive, env=self.env, node=self.node, **options)

    def test_fresh_install_uses_normal_paths_and_verified_replay(self):
        state = self.home / ".supertag"
        state.mkdir()
        sentinel = state / "runtime.sqlite3"
        sentinel.write_bytes(b"old state must remain untouched")
        installed = self.install()
        command = self.home / ".local/bin/supertag"
        target = Path(installed["installation"])
        self.assertEqual(command.readlink(), target / "supertag")
        self.assertEqual(target.parent, self.home / ".local/share/supertag/versions")
        self.assertFalse(installed["reused"])
        self.assertTrue(self.install()["reused"])
        self.assertEqual(len(list(target.parent.glob("native-*"))), 1)
        self.assertEqual(sentinel.read_bytes(), b"old state must remain untouched")

    def test_install_root_and_bin_override_precedence(self):
        self.assertEqual(installer.install_paths({"HOME": "/home/example", "XDG_DATA_HOME": "/data", "XDG_BIN_HOME": "/bin-home"}),
                         (Path("/data/supertag"), Path("/bin-home")))
        self.assertEqual(installer.install_paths({"HOME": "/home/example", "XDG_DATA_HOME": "/ignored", "XDG_BIN_HOME": "/ignored",
                                                  "SUPERTAG_INSTALL_ROOT": "/chosen", "SUPERTAG_BIN_DIR": "/commands"}),
                         (Path("/chosen"), Path("/commands")))

    def test_upgrade_retains_old_release_and_failure_preserves_active_link(self):
        first = self.install()
        command = Path(first["command"])
        second = self.package("0.1.1")
        with patch.object(installer, "probe", side_effect=ArchiveError("native probe failed")):
            with self.assertRaisesRegex(ArchiveError, "native probe failed"):
                self.install(second)
        self.assertEqual(command.readlink(), Path(first["installation"]) / "supertag")
        installed = self.install(second)
        self.assertEqual(command.readlink(), Path(installed["installation"]) / "supertag")
        self.assertTrue(Path(first["installation"]).is_dir())
        self.assertNotEqual(installed["installation"], first["installation"])

    def test_known_npm_install_is_retained_when_command_switches(self):
        root = self.home / ".local/share/supertag"
        version = root / "versions/0.2.0-alpha.9"
        package = version / "node_modules/supertag-ai"
        package.mkdir(parents=True)
        (package / "package.json").write_text(json.dumps({"name": "supertag-ai", "version": "0.2.0-alpha.9"}))
        legacy = version / "node_modules/.bin/supertag"
        legacy.parent.mkdir()
        legacy.write_text("preserved npm launcher")
        binary = self.home / ".local/bin"
        binary.mkdir()
        (binary / "supertag").symlink_to(legacy)
        installed = self.install()
        self.assertEqual(installed["previous_command"], str(legacy))
        self.assertEqual(legacy.read_text(), "preserved npm launcher")

    def test_unmanaged_command_and_unknown_target_are_not_replaced(self):
        binary = self.home / ".local/bin"
        binary.mkdir(parents=True)
        command = binary / "supertag"
        command.write_text("user-owned command")
        with self.assertRaisesRegex(ArchiveError, "unmanaged"):
            self.install()
        self.assertEqual(command.read_text(), "user-owned command")
        command.unlink()
        command.symlink_to(self.node)
        with self.assertRaisesRegex(ArchiveError, "unmanaged"):
            self.install()
        self.assertEqual(command.readlink(), self.node)

    def test_tampered_installed_tree_is_not_silently_reused(self):
        first = self.install()
        target = Path(first["installation"])
        (target / "supertag").write_bytes(elf() + b"modified binary")
        with self.assertRaisesRegex(ArchiveError, "installed file"):
            self.install()
        self.assertEqual(Path(first["command"]).readlink(), target / "supertag")

    def test_checksum_platform_and_expected_digest_fail_before_creating_roots(self):
        with self.assertRaisesRegex(ArchiveError, "expected SHA-256"):
            self.install(expected_sha256="0" * 64)
        with patch.object(installer, "native_platform", return_value="darwin-arm64"):
            with self.assertRaisesRegex(ArchiveError, "platform"):
                self.install()
        Path(str(self.archive) + ".sha256").write_text("0" * 64 + "  " + self.archive.name + "\n")
        with self.assertRaisesRegex(ArchiveError, "checksum"):
            self.install()
        self.assertFalse((self.home / ".local").exists())

    def test_symlinked_root_and_foreign_owned_directory_are_refused(self):
        outside = self.root / "outside"
        outside.mkdir()
        alias = self.root / "alias"
        alias.symlink_to(outside, target_is_directory=True)
        self.env["SUPERTAG_INSTALL_ROOT"] = str(alias)
        with self.assertRaisesRegex(ArchiveError, "symlink"):
            self.install()
        self.env["SUPERTAG_INSTALL_ROOT"] = str(outside)
        with patch.object(installer.os, "geteuid", return_value=os.geteuid() + 1):
            with self.assertRaisesRegex(ArchiveError, "owned"):
                self.install()
        self.assertEqual(list(outside.iterdir()), [])

    def test_lock_is_exclusive_and_cannot_alias_another_file(self):
        path = self.root / "lock"
        with installer.locked(path):
            with self.assertRaisesRegex(ArchiveError, "in progress"):
                with installer.locked(path):
                    self.fail("lock should be exclusive")
        path.unlink()
        secret = self.root / "other"
        secret.write_text("untouched")
        path.symlink_to(secret)
        with self.assertRaises(OSError):
            with installer.locked(path):
                self.fail("must not follow lock symlink")
        self.assertEqual(secret.read_text(), "untouched")

    def test_publish_cannot_replace_even_an_empty_directory(self):
        source, target = self.root / "source", self.root / "target"
        source.mkdir()
        target.mkdir()
        with self.assertRaises(FileExistsError):
            installer.rename_exclusive(source, target)
        self.assertTrue(source.is_dir())
        self.assertTrue(target.is_dir())

    def test_command_replaced_during_probe_is_preserved(self):
        first = self.install()
        command = Path(first["command"])
        second = self.package("0.1.1")
        def collision(*_):
            command.unlink()
            command.write_text("a concurrent unmanaged command")
        with patch.object(installer, "probe", side_effect=collision):
            with self.assertRaisesRegex(ArchiveError, "unmanaged"):
                self.install(second)
        self.assertEqual(command.read_text(), "a concurrent unmanaged command")


if __name__ == "__main__":
    unittest.main()
