"""Verify image input before invoking Docker; all archives and tools are synthetic."""
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from native_archive import ArchiveError, create_archive
from node_bridges import PACKAGES, entry_for
from release_archive import create_release
from test_native_archive import elf
import split_service_images as images


class SplitImagesContracts(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.stage = self.root / "stage"
        self.stage.mkdir()
        for name in ("supertag", "supertag-tui", "supertag-shared-execution"):
            path = self.stage / name
            path.write_bytes(elf() + name.encode())
            path.chmod(0o755)
        for kind, package in PACKAGES.items():
            entry = self.stage / "node-bridges/node_modules" / package / entry_for(kind)
            entry.parent.mkdir(parents=True)
            entry.write_text("synthetic helper")
        (self.stage / "node-bridges/manifest.json").write_text("{}")
        self.source = {"commit": "a" * 40, "archive_sha256": "b" * 64,
                       "lockfiles": {name: "c" * 64 for name in ("pnpm-lock.yaml", "rust/Cargo.lock", "apps/tui/go.sum")}}

    def package(self):
        return create_release(self.stage, self.root / "out", version="0.1.0", platform="linux-arm64",
                              profile="dev", source=self.source)

    def test_complete_archive_is_verified_but_only_cli_enters_service_image(self):
        archive = self.package()
        builds = []
        def build(command, **kwargs):
            context = Path(command[-1])
            self.assertEqual([path.name for path in context.iterdir()], ["supertag"])
            self.assertEqual((context / "supertag").read_bytes(), (self.stage / "supertag").read_bytes())
            builds.append([str(value) for value in command])
        with patch.object(images.subprocess, "run", side_effect=build), \
             patch.object(images.subprocess, "check_output", return_value="supertag 0.1.0\n"):
            tags = images.build_images(archive, "fixture", "exact")
        self.assertEqual(tags, {"control-plane": "fixture-control-plane:exact", "gateway": "fixture-gateway:exact"})
        self.assertEqual(len(builds), 2)
        for command in builds:
            self.assertIn("org.opencontainers.image.revision=" + self.source["commit"], command)
            self.assertIn("org.supertag.source.dirty=false", command)
            self.assertIn("org.supertag.archive.format=supertag-native-release-v1", command)

    def test_corrupt_complete_archive_stops_before_docker(self):
        archive = self.package()
        with archive.open("ab") as output:
            output.write(b"corrupt")
        with patch.object(images.subprocess, "run") as run:
            with self.assertRaisesRegex(ArchiveError, "checksum differs"):
                images.build_images(archive, "fixture")
        run.assert_not_called()

    def test_older_cli_tui_fixture_requires_explicit_format_and_preserves_dirty_label(self):
        with patch("native_archive.check_versions"):
            archive = create_archive(self.stage / "supertag", self.stage / "supertag-tui", self.root / "thin",
                                     version="0.1.0", platform="linux-arm64", profile="dev", features=[],
                                     source={"commit": "a" * 40, "dirty": True})
        with patch.object(images.subprocess, "run") as run:
            with self.assertRaises(ArchiveError):
                images.build_images(archive, "fixture")
            run.assert_not_called()
        with patch.object(images.subprocess, "run") as run, \
             patch.object(images.subprocess, "check_output", return_value="supertag 0.1.0\n"):
            images.build_images(archive, "fixture", archive_format="cli-tui")
        self.assertIn("org.supertag.source.dirty=true", run.call_args_list[0].args[0])


if __name__ == "__main__":
    unittest.main()
