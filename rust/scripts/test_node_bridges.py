import json
from pathlib import Path
import subprocess
import tempfile
import unittest

from native_archive import ArchiveError
from node_bridges import prepare_workspace, relocate_self_alias, verify_deploy_lock, verify_relocatable_tree


class NodeBridgeContracts(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()

    def test_exact_snapshot_pin_and_known_private_workspace_dependency(self):
        workspace = self.root / "packages/sdk"
        workspace.mkdir(parents=True)
        (workspace / "package.json").write_text(json.dumps({"name": "@supertag/sdk", "private": True}))
        source = {"packages": {"foo@1.0.0": {"resolution": {"integrity": "pinned"}}},
                  "snapshots": {"foo@1.0.0": {}}, "importers": {"packages/sdk": {}}}
        deployed = {"packages": {**source["packages"], "@supertag/sdk@file:packages/sdk": {}},
                    "snapshots": dict(source["snapshots"])}
        verify_deploy_lock(source, deployed, self.root)
        deployed["snapshots"]["foo@1.0.0"] = {"dependencies": {"bar": "2.0.0"}}
        with self.assertRaisesRegex(ArchiveError, "differs from the lockfile"):
            verify_deploy_lock(source, deployed, self.root)
        deployed["packages"]["foo@2.0.0"] = {"resolution": {"integrity": "unlocked"}}
        with self.assertRaisesRegex(ArchiveError, "unlocked"):
            verify_deploy_lock(source, deployed, self.root)

    def test_relocates_only_the_known_pnpm_self_alias(self):
        source = self.root / "source"
        source.mkdir()
        stage = self.root / "stage"
        alias = stage / "node_modules/.pnpm/node_modules/@supertag/cursor"
        alias.parent.mkdir(parents=True)
        alias.symlink_to(source)
        relocate_self_alias(stage, "@supertag/cursor", source)
        relocated = self.root / "moved"
        stage.rename(relocated)
        verify_relocatable_tree(relocated)
        moved_alias = relocated / alias.relative_to(stage)
        self.assertEqual(moved_alias.resolve(strict=True), relocated)
        self.assertFalse(moved_alias.readlink().is_absolute())

    def test_rejects_unrelated_external_and_dangling_links(self):
        stage = self.root / "stage"
        stage.mkdir()
        outside = self.root / "outside"
        outside.write_text("outside")
        link = stage / "link"
        link.symlink_to("../outside")
        with self.assertRaisesRegex(ArchiveError, "leaves bundle"):
            verify_relocatable_tree(stage)
        link.unlink()
        link.symlink_to("missing")
        with self.assertRaisesRegex(ArchiveError, "unresolved staged link"):
            verify_relocatable_tree(stage)

    def test_staging_uses_committed_source_in_a_separate_workspace(self):
        repo = self.root / "checkout"
        repo.mkdir()
        scratch = self.root / "scratch"
        scratch.mkdir()
        subprocess.run(["git", "init", "--quiet"], cwd=repo, check=True)
        (repo / "manifest").write_text("committed")
        subprocess.run(["git", "add", "manifest"], cwd=repo, check=True)
        subprocess.run(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
                        "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Source"], cwd=repo, check=True)
        (repo / "manifest").write_text("working copy")
        (repo / "node_modules").mkdir()
        (repo / "node_modules/state").write_text("development")
        source = prepare_workspace(repo, scratch)
        self.assertEqual((source / "manifest").read_text(), "committed")
        self.assertFalse((source / "node_modules").exists())
        self.assertEqual((repo / "node_modules/state").read_text(), "development")


if __name__ == "__main__":
    unittest.main()
