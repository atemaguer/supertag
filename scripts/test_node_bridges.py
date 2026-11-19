import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from native_archive import ArchiveError
import node_bridges
from node_bridges import PACKAGES, prepare_workspace, relocate_self_alias, verify_deploy_lock, verify_relocatable_tree


class NodeBridgeContracts(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()

    def test_exact_snapshot_pin_and_known_private_workspace_dependency(self):
        workspace = self.root / "harnesses/sdk"
        workspace.mkdir(parents=True)
        (workspace / "package.json").write_text(json.dumps({"name": "@supertag/sdk", "private": True}))
        source = {"packages": {"foo@1.0.0": {"resolution": {"integrity": "pinned"}}},
                  "snapshots": {"foo@1.0.0": {}}, "importers": {"harnesses/sdk": {}}}
        deployed = {"packages": {**source["packages"], "@supertag/sdk@file:harnesses/sdk": {}},
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

    def test_parent_alias_preserves_internal_link_boundary(self):
        parent = self.root / "real-parent"
        stage = parent / "stage"
        stage.mkdir(parents=True)
        (stage / "content").write_text("inside")
        link = stage / "link"
        link.symlink_to("content")
        alias = self.root / "parent-alias"
        alias.symlink_to(parent, target_is_directory=True)
        verify_relocatable_tree(alias / "stage")
        (parent / "outside").write_text("outside")
        link.unlink()
        link.symlink_to("../outside")
        with self.assertRaisesRegex(ArchiveError, "leaves bundle"):
            verify_relocatable_tree(alias / "stage")

    def test_drops_build_only_files_and_links_to_them(self):
        stage = self.root / "stage"
        package = stage / "node_modules/.pnpm/zod@4.0.0/node_modules/zod"
        package.mkdir(parents=True)
        kept = ["package.json", "index.js", "index.cjs", "index.mjs", "README.md", "LICENSE"]
        dropped = ["index.d.ts", "index.d.mts", "index.d.cts", "index.js.map", "index.d.ts.map", "src.ts",
                   "src.mts", "src.cts", ".tsbuildinfo"]
        for name in [*kept, *dropped]:
            (package / name).write_text(name)
        (stage / "types.d.ts").symlink_to(package.relative_to(stage) / "index.d.ts")
        (stage / "entry.js").symlink_to(package.relative_to(stage) / "index.js")
        self.assertEqual(node_bridges.drop_build_only_files(stage), sum(len(name) for name in dropped))
        self.assertEqual(sorted(path.name for path in package.iterdir()), sorted(kept))
        self.assertFalse((stage / "types.d.ts").is_symlink())
        self.assertEqual((stage / "entry.js").read_text(), "index.js")
        verify_relocatable_tree(stage)

    def test_keeps_failing_on_unrelated_dangling_links(self):
        stage = self.root / "stage"
        stage.mkdir()
        (stage / "link").symlink_to("missing.js")
        with self.assertRaisesRegex(ArchiveError, "unresolved staged link"):
            node_bridges.drop_build_only_files(stage)

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


    def test_bridges_build_after_the_workspace_packages_they_depend_on(self):
        # Each bridge's own tsc --build would otherwise rebuild the shared SDK concurrently.
        (self.root / "package.json").write_text(json.dumps({"packageManager": "pnpm@11.18.0"}))
        node = self.root / "node"
        node.write_text("")
        builds = []

        def run(command, **_kwargs):
            if command[-1] == "build":
                builds.append(command)
                raise subprocess.CalledProcessError(1, command)

        probes = {"--version": "11.18.0\n", "exec": f"{node}\n"}
        with patch.object(node_bridges, "lockfile"), patch.object(node_bridges, "verify_node"), \
             patch.object(node_bridges.subprocess, "run", side_effect=run), \
             patch.object(node_bridges.subprocess, "check_output",
                          side_effect=lambda command, **_kwargs: probes[command[1] if command[1] == "--version" else "exec"]):
            with self.assertRaises(subprocess.CalledProcessError):
                node_bridges.stage_workspace(self.root / "out", PACKAGES, self.root)
        filters = [builds[0][index + 1] for index, word in enumerate(builds[0]) if word == "--filter"]
        self.assertEqual(filters, [f"{PACKAGES[kind]}..." for kind in sorted(PACKAGES)])


if __name__ == "__main__":
    unittest.main()
