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


FORMAT = "supertag-node-bridges-v2"
PROTOCOL = "supertag.runtime.v2"
NODE_MAJOR = 22
PACKAGES = {
    "claude-code": "@supertag/worker-claude-code",
    "cursor": "@supertag/worker-cursor",
    "opencode": "@supertag/worker-opencode",
    "e2b": "@supertag/worker-environment-e2b",
    "modal": "@supertag/worker-environment-modal",
    "local-vm": "@supertag/worker-environment-local-vm",
}
HARNESS_BRIDGES = {"claude-code", "cursor", "opencode"}
# Bridges that also run on Node majors after NODE_MAJOR: no native module tied to a Node ABI.
# Cursor's SDK ships native modules built for Node 22, so it stays on that line.
LATER_NODE_BRIDGES = {"claude-code"}
# The installed CLI starts these itself, so the manifest names them; the others need a path.
MANIFEST_BRIDGES = HARNESS_BRIDGES | {"local-vm"}
STARTUP_ERRORS = {
    "claude-code": "Claude adapter could not complete its execution safely.",
    "cursor": "Cursor adapter could not complete its execution safely.",
    "opencode": "OpenCode adapter could not complete its execution safely.",
    "e2b": "SuperTag E2B Workspace provider stopped after an error.",
    "modal": "SuperTag Modal Workspace provider stopped after an error.",
    "local-vm": "SuperTag local-vm Workspace provider stopped after an error.",
}
BUNDLER = Path("scripts/bundle-node-bridge.mjs")
# Processes a bridge starts beside its entry. Each is bundled into its own file next to the entry,
# where the bridge looks for it.
SECONDARY_ENTRIES = {"cursor": ("dist/runner.js", "dist/stop-watchdog-main.js")}
# Packages a bridge keeps as files in its own node_modules, with everything they depend on,
# because their code finds other files by path or by name while it runs:
# - The Claude Agent SDK and Cursor's SDK are proprietary, so they ship as published. Cursor's
#   also looks for its platform package (cursorsandbox, rg and native modules) by walking up
#   from its own file.
# - e2b imports undici, glob and tar by name when it first needs them.
# - modal's gRPC library reads .proto files beside its code, and its CBOR decoder loads a native
#   module from a platform package.
# Everything else a bridge imports is inside its bundled files.
EXTERNAL = {
    "claude-code": ("@anthropic-ai/claude-agent-sdk",),
    "cursor": ("@cursor/sdk",),
    "e2b": ("e2b",),
    "modal": ("modal",),
}
# The Agent SDK's platform packages each hold a whole Claude Code executable; the bridge runs the
# user's installed claude instead, so they are never staged.
UNSHIPPED = re.compile(r"@anthropic-ai/claude-agent-sdk-.+")


def entry_for(kind):
    """The bridge's entry file, relative to its directory in the staged tree."""
    return Path("entry.js" if kind in HARNESS_BRIDGES else "main.js")


def compiled_entry(kind):
    """The compiled entry the bundle is made from, relative to the bridge's source package."""
    return Path("dist/rust-adapter/entry.js" if kind in HARNESS_BRIDGES else "dist/rust-provider/main.js")


def staged_entries(root="node-bridges"):
    """Where each bridge's entry is in a release, relative to the release's root."""
    return {kind: f"{root}/{kind}/{entry_for(kind)}" for kind in PACKAGES}


def source_for(repo, kind):
    return repo / "harnesses" / kind if kind in HARNESS_BRIDGES else repo / "harnesses/environments" / kind


def lockfile(path):
    require(path.is_file() and path.stat().st_size <= 16 * 1024 * 1024, "invalid pnpm lockfile")
    document = yaml.safe_load(path.read_bytes())
    require(isinstance(document, dict) and document.get("lockfileVersion") == "9.0", "unsupported pnpm lockfile")
    return document


def verify_relocatable_tree(root):
    # macOS temporary directories may arrive through /var -> /private/var.
    # Compare resolved link destinations with the same canonical boundary.
    root = Path(root).resolve(strict=True)
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


def package_name(link):
    """The name a package directory has in its node_modules: NAME or @SCOPE/NAME."""
    return f"{link.parent.name}/{link.name}" if link.parent.name.startswith("@") else link.name


def copy_external(link, modules, copied):
    """Copy the package `link` names, and each package it depends on, into the flat `modules`.

    `link` is a package in a pnpm node_modules: a link into pnpm's store, where the package's own
    dependencies are its siblings. `copied` maps each staged name to the store directory it came
    from, so two versions of one package fail here; a flat node_modules cannot hold both.
    """
    name = package_name(link)
    if UNSHIPPED.fullmatch(name):
        return
    source = link.resolve(strict=True)
    if name in copied:
        require(copied[name] == source, f"two versions of {name} cannot share one node_modules")
        return
    copied[name] = source
    target = modules / name
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(source, target, symlinks=True,
                    ignore=lambda directory, _names: ["node_modules"] if Path(directory) == source else [])
    metadata = json.loads((source / "package.json").read_text())
    store = next(parent for parent in source.parents if parent.name == "node_modules")
    optional = metadata.get("optionalDependencies", {})
    for dependency in sorted({**metadata.get("dependencies", {}), **optional}):
        sibling = store / dependency
        if sibling.exists():
            copy_external(sibling, modules, copied)
        else:
            # pnpm installs only the optional packages built for this platform.
            require(dependency in optional, f"{name} depends on {dependency}, which is not installed")


def bundle(node, repo, kind, target, env=None):
    """Write the bridge's bundled entries, their license notices, and its external packages to `target`."""
    source = source_for(repo, kind)
    external = EXTERNAL.get(kind, ())
    command = [node, repo / BUNDLER, "--package", source, "--output", target]
    for entry in (compiled_entry(kind), *SECONDARY_ENTRIES.get(kind, ())):
        command.extend(["--entry", entry])
    for name in external:
        command.extend(["--external", name])
    report = json.loads(subprocess.run(command, cwd=repo, env=env, check=True, stdout=subprocess.PIPE, text=True).stdout)
    # The bundler leaves an import alone only when told to; anything else it could not put in a
    # bundle would be missing at run time.
    for name in report["imports"]:
        require(any(name == package or name.startswith(package + "/") for package in external),
                f"the {kind} bundle imports {name}, which is neither bundled nor staged")
    copied = {}
    for name in external:
        copy_external(source / "node_modules" / name, target / "node_modules", copied)
    return sorted(copied)


def verify_native_asset(path, platform, label):
    require(path.is_file() and not path.is_symlink() and os.access(path, os.X_OK),
            f"{label} is unavailable or not executable")
    with path.open("rb") as binary:
        check_architecture(binary.read(32), platform)


def verify_cursor_assets(node, package, platform):
    system, arch = platform.split("-")
    vendor = f"sdk-{system}-{'x64' if arch == 'amd64' else arch}"
    for name in ("cursorsandbox", "rg"):
        verify_native_asset(package / "node_modules/@cursor" / vendor / "bin" / name, platform, f"Cursor {name}")
    for name in ("runner.js", "stop-watchdog-main.js"):
        require((package / name).is_file(), f"Cursor {name} is unavailable")
    # The runner points Cursor's SDK at its platform package by walking up from the SDK's own
    # file. Ask the staged runner for that file: it throws when the walk finds no platform package.
    with tempfile.TemporaryDirectory(prefix="supertag-bridge-home-") as home:
        result = subprocess.run(
            [node, "--input-type=module", "--eval",
             "const { resolveCursorSandboxEntry } = await import(process.argv[1]);"
             "process.stdout.write(resolveCursorSandboxEntry());",
             (package / "runner.js").resolve().as_uri()],
            cwd=home, env={"PATH": os.defpath, "HOME": home}, capture_output=True, text=True, timeout=15)
    sdk = (package / "node_modules/@cursor/sdk").resolve()
    require(result.returncode == 0 and Path(result.stdout).is_relative_to(sdk),
            "the staged Cursor runner cannot find the SDK's platform package")


def verify_no_claude_executable(package):
    """The bridge runs the user's installed claude, so no copy of it is staged; see UNSHIPPED."""
    leftover = [path for path in package.rglob("*")
                if UNSHIPPED.fullmatch(package_name(path)) or (path.name in ("claude", "claude.exe") and path.is_file())]
    require(not leftover, "the Agent SDK's Claude Code executable is still bundled")


# Files only the TypeScript compiler, editors, and debuggers read: type declarations, TypeScript
# sources, source maps, and build info. Node 22 loads none of them from node_modules (it refuses to
# strip types there), and they are close to half of a package's bytes and files.
BUILD_ONLY_SUFFIXES = (".ts", ".mts", ".cts", ".map", ".tsbuildinfo")


def drop_build_only_files(package):
    """Remove the files in BUILD_ONLY_SUFFIXES, and any links to them, from a staged bridge."""
    removed = 0
    for parent, _directories, files in os.walk(package):
        for name in files:
            if name.endswith(BUILD_ONLY_SUFFIXES):
                entry = Path(parent) / name
                if not entry.is_symlink():
                    removed += entry.stat().st_size
                entry.unlink()
    for parent, _directories, files in os.walk(package):
        for name in files:
            entry = Path(parent) / name
            if entry.is_symlink() and not entry.exists():
                target = entry.readlink()
                require(str(target).endswith(BUILD_ONLY_SUFFIXES), f"unresolved staged link: {entry.relative_to(package)}")
                entry.unlink()
    return removed


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
    # Keep the install and the compiled files inside a disposable source tree.
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
    # The frozen install below ties every staged dependency to this lockfile.
    lockfile(repo / "pnpm-lock.yaml")
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
    # "PACKAGE..." also selects the workspace packages each bridge depends on, so pnpm builds
    # @supertag/worker-sdk to completion before the bridges. Selecting only the bridges ran their
    # `tsc --build` processes concurrently, each rebuilding the shared SDK reference, so one could
    # read the SDK's declarations while another was still writing them.
    command = ["pnpm"]
    for kind in selected:
        command.extend(["--filter", f"{PACKAGES[kind]}..."])
    subprocess.run([*command, "build"], cwd=repo, env=env, check=True)
    platform = native_platform()
    with tempfile.TemporaryDirectory(prefix=".supertag-node-bridges-", dir=output.parent) as temporary:
        staging = Path(temporary) / "node-bridges"
        staging.mkdir()
        for kind in selected:
            metadata = json.loads((source_for(repo, kind) / "package.json").read_text())
            require(metadata.get("private") is True and metadata.get("name") == PACKAGES[kind],
                    f"runtime helper must remain a private workspace package: {kind}")
            target = staging / kind
            bundle(node, repo, kind, target, env)
            drop_build_only_files(target)
            verify_relocatable_tree(target)
            if kind == "cursor":
                verify_cursor_assets(node, target, platform)
            if kind == "claude-code":
                verify_no_claude_executable(target)
            smoke_entry(node, kind, target)
        manifest = {"format": FORMAT, "version": version_from_repo(repo), "protocol": PROTOCOL,
                    "platform": platform, "node_major": NODE_MAJOR,
                    "node_later": [kind for kind in selected if kind in LATER_NODE_BRIDGES],
                    "bridges": [kind for kind in selected if kind in MANIFEST_BRIDGES]}
        (staging / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        require(not output.exists(), "Node bridge output already exists")
        staging.rename(output)
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
