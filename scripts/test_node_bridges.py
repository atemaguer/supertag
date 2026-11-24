import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from native_archive import ArchiveError
import node_bridges
from node_bridges import PACKAGES, prepare_workspace, verify_relocatable_tree


class NodeBridgeContracts(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()

    def store_package(self, store, key, name, version="1.0.0", **metadata):
        """A package as pnpm lays it out: store/KEY/node_modules/NAME, its dependencies beside it."""
        package = store / key / "node_modules" / name
        package.mkdir(parents=True)
        (package / "package.json").write_text(json.dumps({"name": name, "version": version, **metadata}))
        (package / "index.js").write_text(f"// {name}@{version}")
        return package

    def link(self, directory, name, package):
        link = directory / name
        link.parent.mkdir(parents=True, exist_ok=True)
        link.symlink_to(package, target_is_directory=True)
        return link

    def test_external_packages_are_copied_flat_with_what_they_depend_on(self):
        store = self.root / "workspace/node_modules/.pnpm"
        sdk = self.store_package(store, "sdk@1.0.0", "@vendor/sdk", dependencies={"helper": "1.0.0"},
                                 optionalDependencies={"@vendor/sdk-here": "1.0.0", "@vendor/sdk-elsewhere": "1.0.0",
                                                       "@anthropic-ai/claude-agent-sdk-darwin-arm64": "1.0.0"})
        helper = self.store_package(store, "helper@1.0.0", "helper", dependencies={"@vendor/sdk": "1.0.0"})
        here = self.store_package(store, "sdk-here@1.0.0", "@vendor/sdk-here")
        claude = self.store_package(store, "claude@1.0.0", "@anthropic-ai/claude-agent-sdk-darwin-arm64")
        # An npm alias: the dependency's name differs from the package's own.
        alias = self.store_package(store, "undici@8.0.0", "undici", "8.0.0")
        (sdk / "node_modules/.bin").mkdir(parents=True)
        (sdk / "node_modules/.bin/tool").write_text("#!/bin/sh")
        (sdk / "vendor/node_modules").mkdir(parents=True)
        (sdk / "vendor/node_modules/kept.js").write_text("// part of the package")
        for name, package in (("helper", helper), ("@vendor/sdk-here", here),
                              ("@anthropic-ai/claude-agent-sdk-darwin-arm64", claude)):
            self.link(sdk.parent.parent, name, package)
        self.link(helper.parent, "@vendor/sdk", sdk)
        self.link(helper.parent, "undici8", alias)
        (helper / "package.json").write_text(json.dumps(
            {"name": "helper", "version": "1.0.0", "dependencies": {"@vendor/sdk": "1.0.0", "undici8": "npm:undici@8.0.0"}}))
        bridge = self.link(self.root / "workspace/bridge/node_modules", "@vendor/sdk", sdk)
        modules = self.root / "stage/node_modules"
        copied = {}
        node_bridges.copy_external(bridge, modules, copied)
        self.assertEqual(sorted(copied), ["@vendor/sdk", "@vendor/sdk-here", "helper", "undici8"])
        self.assertEqual(sorted(path.relative_to(modules).as_posix() for path in modules.rglob("*") if path.is_file()),
                         ["@vendor/sdk-here/index.js", "@vendor/sdk-here/package.json", "@vendor/sdk/index.js",
                          "@vendor/sdk/package.json", "@vendor/sdk/vendor/node_modules/kept.js", "helper/index.js",
                          "helper/package.json", "undici8/index.js", "undici8/package.json"])
        verify_relocatable_tree(modules)
        node_bridges.verify_no_claude_executable(modules)
        # A second version of a staged package has nowhere to go in a flat node_modules.
        other = self.store_package(store, "helper@2.0.0", "helper", "2.0.0")
        with self.assertRaisesRegex(ArchiveError, "two versions of helper"):
            node_bridges.copy_external(self.link(self.root / "elsewhere", "helper", other), modules, copied)

    def test_a_missing_required_dependency_fails_and_a_staged_claude_is_refused(self):
        store = self.root / "node_modules/.pnpm"
        sdk = self.store_package(store, "sdk@1.0.0", "sdk", dependencies={"absent": "1.0.0"})
        with self.assertRaisesRegex(ArchiveError, "sdk depends on absent"):
            node_bridges.copy_external(self.link(self.root / "bridge/node_modules", "sdk", sdk),
                                       self.root / "stage/node_modules", {})
        package = self.root / "stage/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64"
        package.mkdir(parents=True)
        with self.assertRaisesRegex(ArchiveError, "Claude Code executable"):
            node_bridges.verify_no_claude_executable(self.root / "stage")

    def test_a_bundle_may_import_only_the_packages_staged_beside_it(self):
        calls = []

        def run(command, **_kwargs):
            calls.append([str(word) for word in command])
            return subprocess.CompletedProcess(command, 0, json.dumps({"packages": 1, "imports": imports}), "")

        repo, target = self.root / "repo", self.root / "stage/cursor"
        imports = ["@cursor/sdk", "@cursor/sdk/agent"]
        with patch.object(node_bridges.subprocess, "run", side_effect=run), \
             patch.object(node_bridges, "copy_external") as copy:
            node_bridges.bundle("node", repo, "cursor", target)
            imports = ["@cursor/sdk", "express"]
            with self.assertRaisesRegex(ArchiveError, "imports express"):
                node_bridges.bundle("node", repo, "cursor", target)
        self.assertEqual(calls[0], ["node", str(repo / "scripts/bundle-node-bridge.mjs"),
                                    "--package", str(repo / "harnesses/cursor"), "--output", str(target),
                                    "--entry", "dist/rust-adapter/entry.js", "--entry", "dist/runner.js",
                                    "--entry", "dist/stop-watchdog-main.js", "--external", "@cursor/sdk"])
        self.assertEqual(copy.call_args_list[0].args[:2],
                         (repo / "harnesses/cursor/node_modules/@cursor/sdk", target / "node_modules"))

    def test_every_bridge_has_an_entry_directly_under_its_own_directory(self):
        self.assertEqual(node_bridges.staged_entries(), {
            "claude-code": "node-bridges/claude-code/entry.js", "cursor": "node-bridges/cursor/entry.js",
            "opencode": "node-bridges/opencode/entry.js", "e2b": "node-bridges/e2b/main.js",
            "modal": "node-bridges/modal/main.js", "local-vm": "node-bridges/local-vm/main.js"})
        self.assertLessEqual(set(node_bridges.EXTERNAL) | set(node_bridges.SECONDARY_ENTRIES), set(PACKAGES))

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
