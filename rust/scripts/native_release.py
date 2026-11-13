# /// script
# requires-python = ">=3.13"
# dependencies = ["PyYAML==6.0.3", "grpcio==1.85.1", "grpcio-tools==1.85.1", "protobuf==7.36.2"]
# ///
"""Assemble a complete unpublished native release from an exact clean commit.

Builds happen in disposable source, HOME, Cargo target, and Go cache directories.
The output includes CLI, matching Go TUI, shared execution provider, and all five private Node runtime helpers.
Node 22.13+ (22.x), Git, and optional provider credentials remain external.
No installer, registry publication, signing, or state migration is performed.
"""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import tempfile
import tomllib

from native_archive import (ArchiveError, REPO, build_binaries, check_versions, copy_bounded,
                            digest, native_platform, publish_files, require, version_from_repo, MAX_BINARY_BYTES, PLATFORMS)
from node_bridges import PACKAGES, stage_workspace
from release_archive import check_provider_version, create_release, extract_release, validate_release


def snapshot(repo, commit, scratch):
    require(re.fullmatch(r"[a-f0-9]{40}", commit), "provide the full expected source commit")
    actual = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
    require(actual == commit, "source HEAD differs from the expected commit")
    dirty = subprocess.check_output(["git", "status", "--porcelain", "--untracked-files=no"], cwd=repo)
    require(not dirty, "source has tracked changes; commit or use a clean source checkout")
    archive = scratch / "source.tar"
    subprocess.run(["git", "archive", "--format=tar", "-o", archive, commit], cwd=repo, check=True)
    source = scratch / "source"
    with tarfile.open(archive) as contents:
        contents.extractall(source, filter="data")
    identity = {"commit": commit, "archive_sha256": digest(archive), "lockfiles": {
        name: digest(source / name) for name in ("pnpm-lock.yaml", "rust/Cargo.lock", "apps/tui/go.sum")}}
    archive.unlink()
    return source, identity


def build_environment(scratch):
    home = scratch / "home"
    home.mkdir(mode=0o700)
    # Build tools can use caches only below the disposable HOME. Do not inherit
    # npm config, Node injection hooks, compiler flags, Git config, or credentials.
    env = {"PATH": os.environ.get("PATH", os.defpath), "HOME": str(home), "LANG": "C.UTF-8",
           "CI": "true", "CARGO_BUILD_JOBS": "2", "GOMAXPROCS": "2",
           "CARGO_TARGET_DIR": str(scratch / "cargo-target"), "GOCACHE": str(scratch / "go-cache"),
           "GOPATH": str(scratch / "go"), "NODE_OPTIONS": "--max-old-space-size=4096"}
    # rustup is a toolchain selector. Its installation may live outside HOME;
    # Cargo's package/config directory intentionally does not pass through.
    rustup = os.environ.get("RUSTUP_HOME") or str(Path.home() / ".rustup")
    if Path(rustup).is_dir():
        env["RUSTUP_HOME"] = rustup
    return env


def build_shared_provider(source, env, profile):
    command = ["cargo", "build", "--locked", "--manifest-path", str(source / "rust/Cargo.toml"),
               "-p", "supertag-shared-execution", "--bin", "supertag-shared-execution"]
    if profile == "release":
        command.append("--release")
    subprocess.run(command, cwd=source, env=env, check=True)
    return Path(env["CARGO_TARGET_DIR"]) / ("release" if profile == "release" else "debug") / "supertag-shared-execution"


def tool_versions(source, env, platform):
    """Record the tools that run, and reject mixed-architecture native builds early."""
    def probe(command):
        return subprocess.check_output(command, cwd=source, env=env, text=True, timeout=30).strip()
    rust_output = probe(["rustc", "-vV"])
    rust = dict(line.split(": ", 1) for line in rust_output.splitlines() if ": " in line)
    expected_host = {"linux-arm64": "aarch64-unknown-linux-gnu", "linux-amd64": "x86_64-unknown-linux-gnu",
                     "darwin-arm64": "aarch64-apple-darwin", "darwin-amd64": "x86_64-apple-darwin"}[platform]
    pinned = tomllib.loads((source / "rust/rust-toolchain.toml").read_text())["toolchain"]["channel"]
    require(rust.get("host") == expected_host, "Rust host does not match the expected platform")
    require(rust.get("release") == pinned, "Rust version differs from the source pin")
    cargo = probe(["cargo", "--version"])
    require(cargo.startswith(f"cargo {pinned} "), "Cargo version differs from the source pin")
    node = json.loads(probe(["node", "-p", "JSON.stringify({version:process.version,platform:process.platform,arch:process.arch})"]))
    system, arch = platform.split("-")
    require(node.get("platform") == system and node.get("arch") == {"amd64": "x64", "arm64": "arm64"}[arch],
            "Node interpreter does not match the expected platform")
    match = re.fullmatch(r"v22\.(\d+)\.\d+", node.get("version", ""))
    require(match and int(match[1]) >= 13, "Node 22.13 or later in the Node 22 line is required")
    pnpm = probe(["pnpm", "--version"])
    require(json.loads((source / "package.json").read_text())["packageManager"] == f"pnpm@{pnpm}",
            "pnpm version differs from the source pin")
    go = json.loads(probe(["go", "env", "-json", "GOVERSION", "GOHOSTOS", "GOHOSTARCH"]))
    return {"rust": rust, "cargo": cargo, "node": node, "pnpm": pnpm, "go": go,
            "python": sys.version.split()[0]}


def assemble(repo, commit, output, profile="release", *, smoke=False, install_smoke=False, expected_platform=None):
    platform = native_platform()
    require(expected_platform is None or platform == expected_platform, "builder does not match the expected platform")
    output = output.resolve()
    with tempfile.TemporaryDirectory(prefix="supertag-release-build-") as temporary:
        scratch = Path(temporary)
        source, identity = snapshot(repo, commit, scratch)
        env = build_environment(scratch)
        env["RUSTUP_TOOLCHAIN"] = tomllib.loads((source / "rust/rust-toolchain.toml").read_text())["toolchain"]["channel"]
        tools = tool_versions(source, env, platform)
        stage = scratch / "release"
        stage.mkdir()
        cli, tui = build_binaries(scratch, profile, [], source, env)
        provider = build_shared_provider(source, env, profile)
        version = version_from_repo(source)
        check_versions(cli, tui, version)
        check_provider_version(provider, version)
        for name, path in (("supertag", cli), ("supertag-tui", tui), ("supertag-shared-execution", provider)):
            copy_bounded(path, stage / name, MAX_BINARY_BYTES)
            (stage / name).chmod(0o755)
        for name in ("LICENSE", "NOTICE"):
            copy_bounded(source / name, stage / name, 1024 * 1024)
            (stage / name).chmod(0o644)
        _helpers, node = stage_workspace(stage / "node-bridges", PACKAGES, source, env)
        # Stage on the destination filesystem so publication can use atomic,
        # no-overwrite links, but expose nothing final until smoke has passed.
        output.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix=".supertag-release-candidate-", dir=output) as candidate_dir:
            archive = create_release(stage, Path(candidate_dir), version=version, platform=platform,
                                     profile=profile, source=identity)
            files = [archive, Path(str(archive) + ".sha256")]
            if smoke or install_smoke:
                smoke_built_release(archive, source, env, profile, node, install_smoke=install_smoke)
                files.append(Path(str(archive) + ".smoke.json"))
                if install_smoke:
                    files.append(Path(str(archive) + ".install-smoke.json"))
            receipt = Path(str(archive) + ".build.json")
            receipt.write_text(json.dumps({"format": "supertag-native-build-v1", "source": identity,
                "archive_sha256": digest(archive), "platform": platform, "profile": profile,
                "tools": tools, "extracted_smoke": smoke or install_smoke,
                "installed_smoke": install_smoke}, indent=2, sort_keys=True) + "\n")
            files.append(receipt)
            final_archive = output / archive.name
            publish_files([(path, output / path.name) for path in files])
    return final_archive


def smoke_built_release(archive, source, env, profile, node, *, install_smoke=False):
    # Test equipment is built separately after the production binary was
    # captured. No test feature or fixture binary enters the archive.
    command = ["cargo", "build", "--locked", "--manifest-path", str(source / "rust/Cargo.toml"),
               "-p", "supertag-cli", "--features", "test-fixtures", "--bin", "supertag-fixture-adapter"]
    if profile == "release":
        command.append("--release")
    subprocess.run(command, cwd=source, env=env, check=True)
    fixture = Path(env["CARGO_TARGET_DIR"]) / ("release" if profile == "release" else "debug") / "supertag-fixture-adapter"
    from smoke_native_release import smoke_release
    receipt = smoke_release(archive, fixture, Path(node),
                            source / "packages/runtime/harnesses/opencode/fixtures/native-opencode.mjs",
                            source / "rust/proto/supertag/environment/v2/environment.proto")
    with Path(str(archive) + ".smoke.json").open("x") as target:
        json.dump(receipt, target, indent=2, sort_keys=True)
        target.write("\n")
    if install_smoke:
        from smoke_native_install import smoke_install
        installed = smoke_install(archive, fixture, Path(node),
            source / "packages/runtime/harnesses/opencode/fixtures/native-opencode.mjs",
            source / "rust/proto/supertag/environment/v2/environment.proto")
        with Path(str(archive) + ".install-smoke.json").open("x") as target:
            json.dump(installed, target, indent=2, sort_keys=True)
            target.write("\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    package = commands.add_parser("package")
    package.add_argument("--repo", type=Path, default=REPO)
    package.add_argument("--commit", required=True, help="full expected clean source HEAD")
    package.add_argument("--output", type=Path, required=True)
    package.add_argument("--profile", choices=("dev", "release"), default="release")
    package.add_argument("--expect-platform", choices=sorted(PLATFORMS), help="require the builder and runtime tools to match this platform")
    package.add_argument("--install-smoke", action="store_true", help="also verify fresh install/reinstall before publishing local output; implies --smoke")
    package.add_argument("--smoke", action="store_true", help="also build test equipment and verify extracted CLI/TUI/helpers")
    verify = commands.add_parser("verify")
    verify.add_argument("archive", type=Path)
    extract = commands.add_parser("extract")
    extract.add_argument("archive", type=Path)
    extract.add_argument("--destination", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.command == "package":
            print(assemble(args.repo.resolve(), args.commit, args.output, args.profile, smoke=args.smoke, install_smoke=args.install_smoke,
                           expected_platform=args.expect_platform))
        elif args.command == "verify":
            manifest = validate_release(args.archive)
            print(json.dumps({key: value for key, value in manifest.items() if key != "entries"}, indent=2))
        else:
            print(extract_release(args.archive, args.destination))
    except (ArchiveError, OSError, ValueError, tarfile.TarError, subprocess.SubprocessError) as error:
        parser.exit(1, f"native release: {error}\n")


if __name__ == "__main__":
    main()
