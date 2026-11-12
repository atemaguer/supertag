# /// script
# requires-python = ">=3.13"
# dependencies = ["PyYAML==6.0.3"]
# ///
"""Stage version-matched Node helpers from a committed release or source snapshot."""

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tarfile
import tempfile

import yaml

from native_archive import ArchiveError, REPO, check_architecture, native_platform, require, version_from_repo


FORMAT = "supertag-node-bridges-v1"
PROTOCOL = "supertag.runtime.v2"
NODE_MAJOR = 22
PACKAGES = {
    "claude-code": "@supertag/worker-claude-code",
    "cursor": "@supertag/worker-cursor",
    "opencode": "@supertag/worker-opencode",
    "e2b": "@supertag/worker-environment-e2b",
    "modal": "@supertag/worker-environment-modal",
}
HARNESS_BRIDGES = {"claude-code", "cursor", "opencode"}
STARTUP_ERRORS = {
    "claude-code": "Claude adapter could not complete its execution safely.",
    "cursor": "Cursor adapter could not complete its execution safely.",
    "opencode": "OpenCode adapter could not complete its execution safely.",
    "e2b": "SuperTag E2B Workspace provider stopped after an error.",
    "modal": "SuperTag Modal Workspace provider stopped after an error.",
}
ENTRY = Path("dist/rust-adapter/entry.js")


def entry_for(kind):
    return ENTRY if kind in HARNESS_BRIDGES else Path("dist/rust-provider/main.js")


def source_for(repo, kind):
    category = "harnesses" if kind in HARNESS_BRIDGES else "environments"
    return repo / "packages/runtime" / category / kind


def lockfile(path):
    require(path.is_file() and path.stat().st_size <= 16 * 1024 * 1024, "invalid pnpm lockfile")
    document = yaml.safe_load(path.read_bytes())
    require(isinstance(document, dict) and document.get("lockfileVersion") == "9.0", "unsupported pnpm lockfile")
    return document


def verify_deploy_lock(source, deployed, repo=REPO):
    for section in ("packages", "snapshots"):
        pinned = source[section]
        for key, value in deployed[section].items():
            if key in pinned:
                require(value == pinned[key], f"staged dependency differs from the lockfile: {key}")
                continue
            # pnpm deploy rewrites linked private packages to local file dependencies.
            match = re.fullmatch(r"(@supertag/[a-z0-9-]+)@file:(packages/[a-z0-9/-]+)(?:\(.+\))?", key)
            require(match and match[2] in source["importers"], f"staged dependency is unlocked: {key}")
            package = json.loads((repo / match[2] / "package.json").read_text())
            require(package.get("private") is True and package.get("name") == match[1], f"unrecognized workspace dependency: {key}")


def relocate_self_alias(stage, package, source):
    alias = stage / "node_modules/.pnpm/node_modules" / package
    if alias.is_symlink() and alias.resolve(strict=False) == source:
        alias.unlink()
        alias.symlink_to(os.path.relpath(stage, alias.parent), target_is_directory=True)


def verify_relocatable_tree(root):
    for entry in root.rglob("*"):
        mode = entry.lstat().st_mode
        if stat.S_ISLNK(mode):
            target = entry.readlink()
            try:
                resolved = entry.resolve(strict=True)
            except (FileNotFoundError, RuntimeError) as error:
                raise ArchiveError(f"unresolved staged link: {entry.relative_to(root)}") from error
            require(not target.is_absolute() and resolved.is_relative_to(root), f"staged link leaves bundle: {entry.relative_to(root)}")
        else:
            require((stat.S_ISDIR(mode) or stat.S_ISREG(mode)) and mode & 0o022 == 0,
                    f"unexpected staged file or mode: {entry.relative_to(root)}")


def verify_native_asset(package, pattern, platform, label):
    candidates = {path.resolve(strict=True) for path in package.glob(pattern)}
    require(len(candidates) == 1, f"{label} is unavailable or ambiguous")
    path = candidates.pop()
    require(path.is_file() and os.access(path, os.X_OK), f"{label} is not executable")
    with path.open("rb") as binary:
        check_architecture(binary.read(32), platform)


def verify_cursor_assets(package, platform):
    system, arch = platform.split("-")
    vendor = f"sdk-{system}-{'x64' if arch == 'amd64' else arch}"
    for name in ("cursorsandbox", "rg"):
        verify_native_asset(package, f"node_modules/.pnpm/*/node_modules/@cursor/{vendor}/bin/{name}", platform, f"Cursor {name}")
    for name in ("runner.js", "stop-watchdog-main.js"):
        require((package / "dist" / name).is_file(), f"Cursor {name} is unavailable")


def verify_claude_asset(package, platform):
    system, arch = platform.split("-")
    vendor = f"claude-agent-sdk-{system}-{'x64' if arch == 'amd64' else arch}"
    verify_native_asset(package, f"node_modules/.pnpm/*/node_modules/@anthropic-ai/{vendor}/claude", platform, "Claude native executable")


def verify_node(node):
    result = subprocess.run([node, "--version"], env={"PATH": os.defpath}, check=True,
                            stdout=subprocess.PIPE, text=True, timeout=10)
    version = re.fullmatch(r"v(\d+)\.(\d+)\.\d+\n?", result.stdout)
    require(version and int(version[1]) == NODE_MAJOR and int(version[2]) >= 13, "Node 22.13 or later in the Node 22 line is required")


def smoke_entry(node, kind, package):
    entry = package / entry_for(kind)
    require(entry.is_file(), f"compiled {kind} entry is unavailable")
    with tempfile.TemporaryDirectory(prefix="supertag-bridge-home-") as home:
        # EOF reaches the adapter's bootstrap check without sending a provider request.
        result = subprocess.run([node, entry], cwd=home, env={"PATH": os.defpath, "HOME": home},
                                input="", capture_output=True, text=True, timeout=15)
        require(result.returncode == 1 and not result.stdout and result.stderr.strip() == STARTUP_ERRORS[kind],
                f"packaged {kind} entry did not reach its bootstrap check")


def prepare_workspace(repo, scratch):
    source = scratch / "source"
    if (repo / ".git").exists():
        archive = scratch / "source.tar"
        subprocess.run(["git", "archive", "--format=tar", "-o", archive, "HEAD"], cwd=repo, check=True)
        with tarfile.open(archive) as contents:
            contents.extractall(source, filter="data")
        archive.unlink()
    else:
        shutil.copytree(
            repo, source, symlinks=True,
            ignore=shutil.ignore_patterns(".git", "node_modules", "dist", "target", ".pnpm-store", ".venv", "*.tsbuildinfo"),
        )
    return source


def stage(output, kinds, repo=REPO):
    # Legacy pnpm deploy changes workspace dependency state. Keep installs,
    # generated files, and the legacy deploy lock inside a disposable source tree.
    with tempfile.TemporaryDirectory(prefix="supertag-bridge-source-") as temporary:
        source = prepare_workspace(repo, Path(temporary))
        staged, _node = stage_workspace(output, kinds, source)
        return staged


def stage_workspace(output, kinds, repo, env=None):
    output = Path(output).resolve()
    require(not output.exists(), "Node bridge output already exists")
    output.parent.mkdir(parents=True, exist_ok=True)
    root_package = json.loads((repo / "package.json").read_text())
    manager = subprocess.check_output(["pnpm", "--version"], cwd=repo, env=env, text=True).strip()
    require(root_package["packageManager"] == f"pnpm@{manager}", "workspace pnpm version differs from its pin")
    source_lock = lockfile(repo / "pnpm-lock.yaml")
    subprocess.run(["pnpm", "install", "--frozen-lockfile", "--prefer-offline", "--prod=false"],
                   cwd=repo, env={**(os.environ if env is None else env), "CI": "true"}, check=True)
    probe = subprocess.check_output(
        ["pnpm", "--silent", "exec", "node", "-p", "process.execPath"], cwd=repo, env=env, text=True,
    ).splitlines()
    require(bool(probe), "workspace Node interpreter is unavailable")
    node = Path(probe[-1].strip())
    require(node.is_absolute() and node.is_file(), "workspace Node interpreter is unavailable")
    verify_node(node)
    selected = sorted(set(kinds))
    command = ["pnpm"]
    for kind in selected:
        command.extend(["--filter", PACKAGES[kind]])
    subprocess.run([*command, "build"], cwd=repo, env=env, check=True)
    platform = native_platform()
    with tempfile.TemporaryDirectory(prefix=".supertag-node-bridges-", dir=output.parent) as temporary:
        staging = Path(temporary) / "node-bridges"
        staging.mkdir()
        for kind in selected:
            package = PACKAGES[kind]
            source_package = source_for(repo, kind).resolve()
            metadata = json.loads((source_package / "package.json").read_text())
            require(metadata.get("private") is True and metadata.get("name") == package,
                    f"runtime helper must remain a private workspace package: {kind}")
            target = staging / "node_modules" / package
            target.parent.mkdir(parents=True, exist_ok=True)
            subprocess.run(["pnpm", "--filter", package, "--prod", "deploy", "--legacy",
                            "--prefer-offline", "--ignore-scripts", target], cwd=repo, env=env, check=True)
            verify_deploy_lock(source_lock, lockfile(target / "node_modules/.pnpm/lock.yaml"), repo)
            relocate_self_alias(target, package, source_package)
            verify_relocatable_tree(target)
            if kind == "cursor":
                verify_cursor_assets(target, platform)
            if kind == "claude-code":
                verify_claude_asset(target, platform)
            smoke_entry(node, kind, target)
        manifest = {"format": FORMAT, "version": version_from_repo(repo), "protocol": PROTOCOL,
                    "platform": platform, "node_major": NODE_MAJOR,
                    "bridges": [kind for kind in selected if kind in HARNESS_BRIDGES]}
        (staging / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        require(not output.exists(), "Node bridge output already exists")
        staging.rename(output)
    # Legacy deploy rewrites this disposable workspace's dependency state. Keep
    # the verified interpreter instead of probing pnpm again after deployment.
    return output, node


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--bridge", action="append", choices=PACKAGES, help="bridge to include (default: all)")
    args = parser.parse_args()
    try:
        print(stage(args.output, args.bridge or PACKAGES))
    except (ArchiveError, OSError, ValueError, yaml.YAMLError, subprocess.SubprocessError) as error:
        parser.exit(1, f"Node bridges: {error}\n")


if __name__ == "__main__":
    main()
