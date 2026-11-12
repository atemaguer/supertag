"""Exact-source, dependency and archive boundaries; no provider or build calls."""
import io
import json
import os
from pathlib import Path
import subprocess
import shutil
import tarfile
import tempfile
import unittest
from unittest.mock import patch

from native_archive import ArchiveError, write_checksum
from native_release import build_environment, snapshot
import native_release as assembly
from node_bridges import PACKAGES, entry_for, source_for
import release_archive as release
from test_native_archive import elf


class NativeReleaseContracts(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.stage = self.root / "stage"
        self.stage.mkdir()
        for name in ("supertag", "supertag-tui", "supertag-shared-execution"):
            (self.stage / name).write_bytes(elf() + name.encode())
            (self.stage / name).chmod(0o755)
        for kind, package in PACKAGES.items():
            entry = self.stage / "node-bridges/node_modules" / package / entry_for(kind)
            entry.parent.mkdir(parents=True)
            entry.write_text("compiled helper")
        (self.stage / "node-bridges/manifest.json").write_text("{}")
        self.source = {"commit": "a" * 40, "archive_sha256": "b" * 64,
                       "lockfiles": {name: "c" * 64 for name in ("pnpm-lock.yaml", "rust/Cargo.lock", "apps/tui/go.sum")}}

    def package(self, name="out"):
        return release.create_release(self.stage, self.root / name, version="0.1.0", platform="linux-arm64",
                                      profile="dev", source=self.source)

    def rewrite(self, mutate):
        path = self.package()
        with tarfile.open(path, "r:gz") as source:
            entries = [(item, source.extractfile(item).read() if item.isfile() else None) for item in source]
        with tarfile.open(path, "w:gz") as target:
            for item, data in mutate(entries):
                if data is not None:
                    item.size = len(data)
                target.addfile(item, io.BytesIO(data) if data is not None else None)
        write_checksum(path)
        return path

    def test_complete_relocatable_deterministic_package(self):
        alias = self.stage / "node-bridges/node_modules/alias"
        alias.symlink_to("@supertag/worker-cursor", target_is_directory=True)
        archive = self.package()
        self.assertEqual(archive.read_bytes(), self.package("again").read_bytes())
        manifest = release.validate_release(archive)
        self.assertEqual(set(manifest["runtime"]["helpers"]), set(PACKAGES))
        extracted = release.extract_release(archive, self.root / "unpack")
        self.assertEqual((extracted / "node-bridges/node_modules/alias/dist/rust-adapter/entry.js").read_text(), "compiled helper")
        self.assertEqual((extracted / "supertag").stat().st_mode & 0o777, 0o755)
        self.assertEqual(manifest["source"], self.source)

    def test_shared_provider_is_required_and_executable(self):
        provider = self.stage / "supertag-shared-execution"
        provider.unlink()
        with self.assertRaisesRegex(ArchiveError, "missing a required file"):
            self.package()
        provider.write_bytes(elf())
        provider.chmod(0o644)
        with self.assertRaisesRegex(ArchiveError, "not executable"):
            self.package()

    def test_shared_provider_architecture_is_verified_before_publication(self):
        (self.stage / "supertag-shared-execution").write_bytes(b"wrong executable" * 8)
        with self.assertRaisesRegex(ArchiveError, "architecture"):
            self.package()
        self.assertFalse(list((self.root / "out").glob("*.tar.gz")))

    def test_shared_provider_version_probe_has_no_ambient_credentials(self):
        with patch.dict(os.environ, {"SUPERTAG_EXECUTION_ADMIN_TOKEN": "synthetic-secret"}), \
             patch.object(release.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "supertag-shared-execution 0.1.0\n", "")) as run:
            release.check_provider_version(self.stage / "supertag-shared-execution", "0.1.0")
        self.assertEqual(set(run.call_args.kwargs["env"]), {"PATH", "HOME"})
        with patch.object(release.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "supertag-shared-execution 0.0.9\n", "")):
            with self.assertRaisesRegex(ArchiveError, "package version"):
                release.check_provider_version(self.stage / "supertag-shared-execution", "0.1.0")

    def test_provider_entries_come_from_private_environment_packages(self):
        for kind in ("modal", "e2b"):
            self.assertEqual(entry_for(kind).as_posix(), "dist/rust-provider/main.js")
            self.assertEqual(source_for(Path("source"), kind), Path("source/packages/runtime/environments") / kind)
        self.assertEqual(entry_for("cursor").as_posix(), "dist/rust-adapter/entry.js")

    def test_missing_provider_entry_fails_before_publication(self):
        (self.stage / "node-bridges/node_modules" / PACKAGES["modal"] / entry_for("modal")).unlink()
        with self.assertRaisesRegex(ArchiveError, "missing a required file"):
            self.package()
        self.assertFalse((self.root / "out").exists())

    def test_escaping_dangling_and_cyclic_links_are_refused(self):
        link = self.stage / "bad"
        for target in ("../outside", "/etc/passwd", "absent", "bad"):
            with self.subTest(target=target):
                link.symlink_to(target)
                with self.assertRaises(ArchiveError):
                    self.package()
                link.unlink()

    def test_tampered_file_rejected_before_destination_created(self):
        def mutate(entries):
            return [(item, data + b"changed" if item.name.endswith("/supertag") else data) for item, data in entries]
        path = self.rewrite(mutate)
        with self.assertRaisesRegex(ArchiveError, "size differs"):
            release.extract_release(path, self.root / "invalid")
        self.assertFalse((self.root / "invalid").exists())

    def test_duplicate_and_unmanifested_entries_are_rejected(self):
        with self.assertRaisesRegex(ArchiveError, "duplicate"):
            release.validate_release(self.rewrite(lambda entries: entries + [entries[-1]]))

    def test_manifest_cannot_put_files_beneath_a_symlink(self):
        entries = {"alias": {"type": "symlink", "mode": 0o777, "target": "."},
                   "alias/child": {"type": "file", "mode": 0o644, "bytes": 0, "sha256": "d" * 64}}
        with self.assertRaisesRegex(ArchiveError, "non-directory"):
            release.validate_tree(entries)

    def test_indirect_malformed_link_is_rejected_as_an_archive_error(self):
        for target in (None, 42, [], "/outside", "x" * 4097):
            with self.subTest(target=target):
                entries = {"first": {"type": "symlink", "mode": 0o777, "target": "second"},
                           "second": {"type": "symlink", "mode": 0o777, "target": target}}
                with self.assertRaisesRegex(ArchiveError, "unsafe release link"):
                    release.validate_tree(entries)

    def test_manifest_directory_order_does_not_control_extraction(self):
        def mutate(entries):
            changed = []
            for item, data in entries:
                if item.name.endswith("/manifest.json") and item.name.count("/") == 1:
                    manifest = json.loads(data)
                    manifest["entries"] = dict(reversed(list(manifest["entries"].items())))
                    data = json.dumps(manifest).encode()
                changed.append((item, data))
            return changed
        path = self.rewrite(mutate)
        extracted = release.extract_release(path, self.root / "unordered")
        self.assertEqual((extracted / "supertag").read_bytes(), (self.stage / "supertag").read_bytes())

    def test_failed_smoke_never_publishes_a_final_archive(self):
        source = self.root / "build-source"
        (source / "rust").mkdir(parents=True)
        (source / "rust/rust-toolchain.toml").write_text('[toolchain]\nchannel="1.93.1"\n')
        (source / "rust/Cargo.toml").write_text('[workspace.package]\nversion="0.1.0"\n')
        for name in ("LICENSE", "NOTICE"):
            (source / name).write_text("Fixture notice")
        def stage_helpers(target, *_):
            shutil.copytree(self.stage / "node-bridges", target)
            return target, Path("/verified/node")
        with patch.object(assembly, "snapshot", return_value=(source, self.source)), \
             patch.object(assembly, "build_binaries", return_value=(self.stage / "supertag", self.stage / "supertag-tui")), \
             patch.object(assembly, "build_shared_provider", return_value=self.stage / "supertag-shared-execution"), \
             patch.object(assembly, "check_provider_version"), \
             patch.object(assembly, "check_versions"), \
             patch.object(assembly, "native_platform", return_value="linux-arm64"), \
             patch.object(assembly, "stage_workspace", side_effect=stage_helpers), \
             patch.object(assembly, "smoke_built_release", side_effect=ArchiveError("smoke failed")):
            with self.assertRaisesRegex(ArchiveError, "smoke failed"):
                assembly.assemble(source, self.source["commit"], self.root / "failed-build", smoke=True)
        self.assertEqual(list((self.root / "failed-build").iterdir()), [])

    def test_build_environment_excludes_credentials_config_and_flags(self):
        with patch.dict(os.environ, {"OPENAI_API_KEY": "synthetic", "MODAL_TOKEN_SECRET": "synthetic",
                                    "NODE_OPTIONS": "--require=/sensitive", "RUSTFLAGS": "injected",
                                    "NPM_CONFIG_USERCONFIG": "/sensitive", "CARGO_HOME": "/sensitive"}):
            env = build_environment(self.root)
        self.assertFalse(any(key in env for key in ("OPENAI_API_KEY", "MODAL_TOKEN_SECRET", "RUSTFLAGS", "NPM_CONFIG_USERCONFIG", "CARGO_HOME")))
        self.assertEqual(env["HOME"], str(self.root / "home"))
        self.assertNotIn("sensitive", env["NODE_OPTIONS"])

    def test_exact_source_rejects_wrong_head_and_dirty_tracked_files(self):
        repo = self.root / "repo"
        repo.mkdir()
        subprocess.run(["git", "init", "--quiet"], cwd=repo, check=True)
        for name in ("pnpm-lock.yaml", "rust/Cargo.lock", "apps/tui/go.sum"):
            target = repo / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("locked")
        subprocess.run(["git", "add", "."], cwd=repo, check=True)
        subprocess.run(["git", "-c", "user.name=Fixture", "-c", "user.email=f@example.test", "-c", "commit.gpgsign=false",
                        "commit", "--quiet", "-m", "source"], cwd=repo, check=True)
        commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
        with self.assertRaisesRegex(ArchiveError, "HEAD differs"):
            snapshot(repo, "0" * 40, self.root)
        source, identity = snapshot(repo, commit, self.root)
        self.assertEqual((source / "pnpm-lock.yaml").read_text(), "locked")
        self.assertEqual(identity["commit"], commit)
        (repo / "pnpm-lock.yaml").write_text("edited")
        with self.assertRaisesRegex(ArchiveError, "tracked changes"):
            snapshot(repo, commit, self.root)
        self.assertEqual((source / "pnpm-lock.yaml").read_text(), "locked")


if __name__ == "__main__":
    unittest.main()
