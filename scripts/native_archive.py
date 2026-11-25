#!/usr/bin/env python3
"""Build and verify an unpublished native CLI and terminal UI archive. Requires Python 3.11+.

This is a local packaging tool, not an installer or a signed release channel.
Default builds use release Rust code and compile the terminal UI with the pinned Bun (.bun-version).
Prebuilt inputs require an explicit profile and record supplied Cargo features.
Source metadata describes the packaging checkout, not an attestation that supplied
binaries were built from it. Binary versions and architecture are verified.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import gzip
import hashlib
import json
import os
from pathlib import Path
import platform as host_platform
import re
import shutil
import stat
import subprocess
import tarfile
import tempfile
import tomllib
import zlib

FORMAT = "supertag-native-archive-v1"
MAX_BINARY_BYTES = 512 * 1024 * 1024
MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024
MAX_MANIFEST_BYTES = 16 * 1024
PLATFORMS = {"linux-arm64", "linux-amd64", "darwin-arm64", "darwin-amd64"}
# The release switch for the terminal UI. While it is True, release archives, the installer
# checks, the release smoke, and the desktop app carry supertag-tui and licenses/opentui/, and the
# release attaches the FFmpeg source it links (scripts/ffmpeg_source.py). Set to False, they carry
# only the CLI; CI still builds and tests the terminal UI (`native_archive.py tui`). For a local
# check, SUPERTAG_RELEASE_TUI=1 (or 0) overrides it for every script of one run.
SHIP_TUI = True
SHIP_TUI = {"1": True, "0": False}.get(os.environ.get("SUPERTAG_RELEASE_TUI", ""), SHIP_TUI)
BINARIES = ("supertag", "supertag-tui") if SHIP_TUI else ("supertag",)
REPO = Path(__file__).resolve().parents[1]
# The terminal UI's entry point. Its package (the nearest directory with a package.json) is
# installed through the pnpm workspace, and Bun compiles the entry into supertag-tui.
TUI_ENTRY = "apps/tui/src/main.tsx"
# OpenTUI's native library for each platform, in the package Bun embeds for that platform.
OPENTUI_PACKAGES = {"darwin-arm64": ("core-darwin-arm64", "libopentui.dylib"),
                    "darwin-amd64": ("core-darwin-x64", "libopentui.dylib"),
                    "linux-arm64": ("core-linux-arm64", "libopentui.so"),
                    "linux-amd64": ("core-linux-x64", "libopentui.so")}
OPENTUI_PLATFORMS = ("darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64", "linux-x64-musl",
                     "linux-arm64-musl", "win32-x64", "win32-arm64")
# Release binaries must run on glibc 2.17 and later, like Bun's own Linux builds.
MAX_GLIBC = (2, 17)


class ArchiveError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise ArchiveError(message)


def native_platform():
    """This machine's platform, whatever the interpreter's: on Apple silicon an Intel Python runs
    under Rosetta and reports x86_64, but the CLI and its helpers run as arm64 there."""
    system = host_platform.system().lower()
    machine = {"aarch64": "arm64", "arm64": "arm64", "x86_64": "amd64", "amd64": "amd64"}.get(host_platform.machine())
    if system == "darwin" and machine == "amd64" and apple_silicon():
        machine = "arm64"
    name = f"{system}-{machine}"
    require(name in PLATFORMS, "native packaging supports Linux and macOS on arm64 or amd64")
    return name


def apple_silicon():
    """Whether this Mac has arm64 processors. An Intel Mac has no hw.optional.arm64, so sysctl fails."""
    try:
        answer = subprocess.run(["/usr/sbin/sysctl", "-n", "hw.optional.arm64"], capture_output=True,
                                text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return False
    return answer.returncode == 0 and answer.stdout.strip() == "1"


def version_from_repo(repo=REPO):
    return tomllib.loads((repo / "core/Cargo.toml").read_text())["workspace"]["package"]["version"]


def validate_metadata(version, platform, profile, features, source):
    require(isinstance(version, str) and len(version) <= 64 and re.fullmatch(
        r"[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?", version), "invalid package version")
    require(isinstance(platform, str) and platform in PLATFORMS, "invalid package platform")
    require(isinstance(profile, str) and profile in ("dev", "release"), "invalid build profile")
    require(isinstance(features, list) and len(features) <= 32
            and all(isinstance(f, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,64}", f) for f in features)
            and features == sorted(set(features)), "invalid build features")
    require(isinstance(source, dict) and set(source) == {"commit", "dirty"}
            and type(source["dirty"]) is bool
            and (source["commit"] is None or (isinstance(source["commit"], str)
                 and re.fullmatch(r"[a-f0-9]{40,64}", source["commit"]))), "invalid source metadata")


def package_root(version, platform, profile):
    return f"supertag-{version}-{platform}" + ("-dev" if profile == "dev" else "")


def digest(path):
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def check_architecture(header, platform):
    system, arch = platform.split("-")
    if system == "linux":
        expected = 183 if arch == "arm64" else 62
        valid = header[:6] == b"\x7fELF\x02\x01" and int.from_bytes(header[18:20], "little") == expected
    else:
        expected = 0x100000C if arch == "arm64" else 0x1000007  # CPU_TYPE_ARM64, CPU_TYPE_X86_64
        valid = header[:4] == b"\xcf\xfa\xed\xfe" and int.from_bytes(header[4:8], "little") == expected
    require(len(header) >= 32 and valid, "binary architecture does not match the package platform")


def check_versions(cli, tui, version):
    """CLI and, unless TUI is None, terminal UI versions."""
    with tempfile.TemporaryDirectory(prefix="supertag-version-") as home:
        env = {"PATH": os.defpath, "HOME": home}
        checks = [(cli, f"supertag {version}")] + ([] if tui is None else [(tui, version)])
        # macOS scans a new executable on its first run; a 100 MB terminal UI takes seconds.
        for binary, expected in checks:
            result = subprocess.run([str(binary), "--version"], env=env, capture_output=True,
                                    text=True, timeout=60, check=False)
            require(result.returncode == 0 and result.stdout.strip() == expected,
                    f"{Path(binary).name} does not report the package version")


def check_tui(tui, platform):
    """Load the terminal UI's embedded native library without a terminal, and on Linux check
    that neither the binary nor the library it embeds needs a glibc newer than MAX_GLIBC."""
    with tempfile.TemporaryDirectory(prefix="supertag-tui-check-") as home:
        result = subprocess.run([str(tui), "--headless-check"], env={"PATH": os.defpath, "HOME": home, "TMPDIR": home},
                                stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=60, check=False)
    require(result.returncode == 0 and result.stdout.strip() == "ok",
            "supertag-tui could not load its native library: " + result.stderr[-800:])
    glibc = None
    if platform.startswith("linux-"):
        newest = glibc_requirement(tui)
        require(newest is not None, "supertag-tui names no glibc symbol version")
        glibc = "GLIBC_" + ".".join(map(str, newest))
        require(newest <= MAX_GLIBC, f"supertag-tui needs {glibc}, newer than GLIBC_{'.'.join(map(str, MAX_GLIBC))}")
    return {"headless_check": True, "glibc": glibc}


def glibc_requirement(binary):
    """The newest GLIBC_x.y symbol version named anywhere in the file: the executable's own
    version needs and those of the shared library embedded in it."""
    pattern = re.compile(rb"GLIBC_([0-9]+)\.([0-9]+)(?:\.[0-9]+)?\x00")
    versions = {(int(major), int(minor)) for major, minor in pattern.findall(Path(binary).read_bytes())}
    return max(versions) if versions else None


def source_metadata(repo=REPO):
    result = subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True)
    if result.returncode:
        return {"commit": None, "dirty": True}
    status = subprocess.check_output(["git", "status", "--porcelain"], cwd=repo)
    return {"commit": result.stdout.strip(), "dirty": bool(status.strip())}


def write_checksum(path):
    checksum = Path(str(path) + ".sha256")
    checksum.write_text(f"{digest(path)}  {path.name}\n", encoding="ascii")
    return checksum


def copy_stream_bounded(reader, writer, limit):
    copied = 0
    while chunk := reader.read(min(1024 * 1024, limit - copied + 1)):
        copied += len(chunk)
        require(copied <= limit, "copy exceeds size limit")
        writer.write(chunk)


def copy_bounded(source, target, limit):
    # Nonblocking open lets the descriptor check reject a replaced FIFO before
    # it can hang. Enforce the limit while reading too, even if a file grows.
    with os.fdopen(os.open(source, os.O_RDONLY | os.O_NONBLOCK), "rb") as reader:
        info = os.fstat(reader.fileno())
        require(stat.S_ISREG(info.st_mode) and 0 < info.st_size <= limit,
                "copy source is not a bounded regular file")
        with Path(target).open("xb") as writer:
            copy_stream_bounded(reader, writer, limit)


def publish_files(files):
    created = []
    try:
        for staged, destination in files:
            identity = staged.stat()
            # Both paths share a filesystem. Linking publishes a complete file
            # atomically and refuses an existing destination, including links.
            os.link(staged, destination)
            created.append((destination, identity))
    except BaseException:
        for destination, identity in reversed(created):
            try:
                current = destination.lstat()
            except FileNotFoundError:
                continue
            # A different publisher may have replaced our name after creation.
            if os.path.samestat(current, identity):
                destination.unlink()
        raise


@contextmanager
def uncompressed_archive(path):
    # Fully consume gzip before parsing tar: tar readers stop at the first
    # footer, which alone does not verify gzip's checksum or truncation.
    limit = len(BINARIES) * MAX_BINARY_BYTES + MAX_MANIFEST_BYTES + 1024 * 1024
    with tempfile.TemporaryFile() as raw:
        size = 0
        try:
            with gzip.open(path, "rb") as compressed:
                for chunk in iter(lambda: compressed.read(1024 * 1024), b""):
                    size += len(chunk)
                    require(size <= limit, "expanded archive exceeds size limit")
                    raw.write(chunk)
        except (OSError, EOFError, zlib.error) as error:
            raise ArchiveError("invalid or truncated compressed archive") from error
        raw.seek(0)
        yield raw


def validate_tar_footer(raw, offset):
    raw.seek(offset)
    padding = raw.read(1024 * 1024 + 1)
    require(1024 <= len(padding) <= 1024 * 1024 and len(padding) % 512 == 0
            and not any(padding), "invalid tar footer or trailing archive data")


def create_archive(cli, tui, output, *, version, platform, profile, features, source):
    features = sorted(set(features))
    validate_metadata(version, platform, profile, features, source)
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    root = package_root(version, platform, profile)
    archive = output / f"{root}.tar.gz"
    checksum = Path(str(archive) + ".sha256")
    require(not archive.exists() and not checksum.exists(), "archive output already exists")
    with tempfile.TemporaryDirectory(prefix=".supertag-native-stage-", dir=output) as temporary:
        stage = Path(temporary)
        files = {}
        require((tui is not None) == SHIP_TUI, "the terminal UI must be supplied exactly when it ships")
        for name, source_path in zip(BINARIES, (cli, tui)[:len(BINARIES)], strict=True):
            source_path = Path(source_path)
            require(source_path.is_file(), "native binary is unavailable")
            require(0 < source_path.stat().st_size <= MAX_BINARY_BYTES, "native binary exceeds size limit")
            target = stage / name
            copy_bounded(source_path, target, MAX_BINARY_BYTES)
            target.chmod(0o755)
            with target.open("rb") as handle:
                check_architecture(handle.read(32), platform)
            files[name] = {"sha256": digest(target), "bytes": target.stat().st_size, "mode": 0o755}
        check_versions(stage / "supertag", stage / "supertag-tui" if SHIP_TUI else None, version)
        manifest = {"format": FORMAT, "version": version, "platform": platform, "profile": profile,
                    "features": features, "source": source, "files": files}
        payload = json.dumps(manifest, sort_keys=True, indent=2).encode() + b"\n"
        require(len(payload) <= MAX_MANIFEST_BYTES, "manifest exceeds size limit")
        (stage / "manifest.json").write_bytes(payload)
        temporary_archive = stage / archive.name
        with temporary_archive.open("wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", filename="", mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w") as target:
                directory = tarfile.TarInfo(root)
                directory.type = tarfile.DIRTYPE
                directory.mode = 0o755
                target.addfile(directory)
                for name in ("manifest.json", *BINARIES):
                    info = tarfile.TarInfo(f"{root}/{name}")
                    info.mode = 0o644 if name == "manifest.json" else 0o755
                    info.size = (stage / name).stat().st_size
                    with (stage / name).open("rb") as handle:
                        target.addfile(info, handle)
        temporary_checksum = write_checksum(temporary_archive)
        validate_archive(temporary_archive)
        publish_files([(temporary_archive, archive), (temporary_checksum, checksum)])
    return archive


def validate_archive(path, checksum=None):
    path = Path(path)
    checksum = Path(checksum) if checksum else Path(str(path) + ".sha256")
    require(path.is_file() and 0 < path.stat().st_size <= MAX_ARCHIVE_BYTES, "archive exceeds size limit or is unavailable")
    require(checksum.is_file() and checksum.stat().st_size <= 1024, "checksum is unavailable or oversized")
    try:
        expected = checksum.read_text(encoding="ascii")
    except UnicodeError as error:
        raise ArchiveError("invalid checksum file") from error
    require(expected == f"{digest(path)}  {path.name}\n", "archive checksum does not match")
    found = {}
    root = None
    manifest = None
    try:
        with uncompressed_archive(path) as raw, tarfile.open(fileobj=raw, mode="r:") as source:
            end = 0
            for index, member in enumerate(source):
                require(index < 2 + len(BINARIES), "unexpected or duplicate archive entry")
                require(not member.issym() and not member.islnk() and not member.sparse,
                        "archive links and sparse files are forbidden")
                parts = member.name.split("/")
                require(all(part not in ("", ".", "..") for part in parts), "unsafe archive path")
                end = member.offset_data + ((member.size + 511) // 512) * 512
                if index == 0:
                    require(member.isdir() and len(parts) == 1 and member.mode == 0o755, "archive root must be a directory")
                    root = member.name
                    continue
                require(member.isfile() and len(parts) == 2 and parts[0] == root
                        and parts[1] in ("manifest.json", *BINARIES), "unexpected archive entry")
                name = parts[1]
                require(name not in found, "duplicate archive entry")
                limit = MAX_MANIFEST_BYTES if name == "manifest.json" else MAX_BINARY_BYTES
                require(0 < member.size <= limit, "archive member exceeds size limit")
                require(member.mode == (0o644 if name == "manifest.json" else 0o755), "unexpected archive file mode")
                handle = source.extractfile(member)
                require(handle is not None, "archive member is unreadable")
                hashed = hashlib.sha256()
                prefix = b""
                size = 0
                manifest_data = b""
                for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                    size += len(chunk)
                    require(size <= limit, "archive member exceeds size limit")
                    hashed.update(chunk)
                    if not prefix:
                        prefix = chunk[:32]
                    if name == "manifest.json":
                        manifest_data += chunk
                require(size == member.size, "archive member is truncated")
                found[name] = {"sha256": hashed.hexdigest(), "bytes": size, "mode": member.mode, "header": prefix}
                if name == "manifest.json":
                    def unique_object(pairs):
                        value = {}
                        for key, item in pairs:
                            require(key not in value, "duplicate manifest key")
                            value[key] = item
                        return value
                    manifest = json.loads(manifest_data, object_pairs_hook=unique_object)
            validate_tar_footer(raw, end)
    except (tarfile.TarError, UnicodeError, json.JSONDecodeError, EOFError, OSError) as error:
        raise ArchiveError("invalid native archive") from error
    require(set(found) == {"manifest.json", *BINARIES}, "archive is missing required files")
    require(isinstance(manifest, dict) and set(manifest) == {"format", "version", "platform", "profile", "features", "source", "files"}, "invalid native manifest")
    require(manifest["format"] == FORMAT, "unsupported archive format")
    validate_metadata(manifest["version"], manifest["platform"], manifest["profile"], manifest["features"], manifest["source"])
    require(root == package_root(manifest["version"], manifest["platform"], manifest["profile"]), "archive root does not match manifest")
    require(isinstance(manifest["files"], dict) and set(manifest["files"]) == set(BINARIES), "invalid binary manifest")
    for name in BINARIES:
        actual = found[name]
        check_architecture(actual.pop("header"), manifest["platform"])
        require(manifest["files"][name] == actual, "binary digest or size does not match manifest")
    return manifest


def extract_archive(path, destination, checksum=None):
    path, destination = Path(path), Path(destination)
    require(not destination.exists() and not destination.is_symlink(), "extraction destination must be new")
    require(path.is_file() and path.stat().st_size <= MAX_ARCHIVE_BYTES, "archive exceeds size limit or is unavailable")
    checksum = Path(checksum) if checksum else Path(str(path) + ".sha256")
    require(checksum.is_file() and checksum.stat().st_size <= 1024, "checksum is unavailable or oversized")
    # The caller's archive may be replaced after validation. Extract a private
    # verified copy, so a later rename cannot substitute unchecked executables.
    with tempfile.TemporaryDirectory(prefix="supertag-archive-verify-") as temporary:
        staged = Path(temporary) / path.name
        copy_bounded(path, staged, MAX_ARCHIVE_BYTES)
        copy_bounded(checksum, Path(str(staged) + ".sha256"), 1024)
        manifest = validate_archive(staged)
        destination.mkdir(mode=0o700)
        root = destination / package_root(manifest["version"], manifest["platform"], manifest["profile"])
        root.mkdir(mode=0o755)
        # Validation completed before creating any output. Never use extractall.
        with tarfile.open(staged, "r:gz") as source:
            for member in source:
                if member.isfile():
                    target = root / member.name.split("/")[1]
                    with source.extractfile(member) as data, target.open("xb") as output:
                        copy_stream_bounded(data, output, member.size)
                    target.chmod(member.mode)
    return root


def build_cli(profile, features, repo=REPO, env=None):
    command = ["cargo", "build", "--locked", "--manifest-path", str(repo / "core/Cargo.toml"),
               "-p", "supertag-cli", "--bin", "supertag"]
    if profile == "release":
        command.append("--release")
    if features:
        command += ["--features", ",".join(features)]
    subprocess.run(command, cwd=repo, env=env, check=True)
    metadata = json.loads(subprocess.check_output(["cargo", "metadata", "--locked", "--no-deps", "--format-version", "1",
        "--manifest-path", str(repo / "core/Cargo.toml")], cwd=repo, env=env))
    return Path(metadata["target_directory"]) / ("release" if profile == "release" else "debug") / "supertag"


def bun_version(repo=REPO):
    return (repo / ".bun-version").read_text().strip()


def tui_package(repo=REPO):
    entry = repo / TUI_ENTRY
    package = next(parent for parent in entry.parents if (parent / "package.json").is_file())
    require(package != repo, "the terminal UI entry has no package of its own")
    return package, entry


def opentui_library(repo, platform):
    """OpenTUI's native library for PLATFORM, as installed for the terminal UI's package."""
    package, _entry = tui_package(repo)
    folder, library = OPENTUI_PACKAGES[platform]
    # pnpm links an optional platform package beside the package that depends on it.
    native = (package / "node_modules/@opentui/core").resolve().parent / folder / library
    require(native.is_file(), f"OpenTUI's native library for {platform} is not installed")
    return native


def copy_tui_notices(repo, platform, target):
    """Copy the license files of the native library supertag-tui embeds into TARGET.

    libopentui statically links FFmpeg (LGPL-2.1-or-later) and other components; its platform
    package carries their licenses and FFMPEG-SOURCE.md, which names the exact FFmpeg source.
    """
    target.mkdir(parents=True)
    copied = []
    for path in sorted(opentui_library(repo, platform).parent.iterdir()):
        if path.is_file() and (path.name.startswith(("LICENSE", "PATENTS", "AUTHORS")) or path.name == "FFMPEG-SOURCE.md"):
            copy_bounded(path, target / path.name, 1024 * 1024)
            (target / path.name).chmod(0o644)
            copied.append(path.name)
    require("LICENSE-FFMPEG" in copied and "FFMPEG-SOURCE.md" in copied and "LICENSE" in copied,
            "OpenTUI's native package no longer carries the expected license files")
    return copied


def build_tui(output, repo=REPO, env=None, *, sign_library=None):
    """Compile the terminal UI for this platform into OUTPUT, a path that must not exist yet.

    The pinned Bun compiles for the platform it runs on, so the embedded runtime is the builder's
    own (the baseline x64 build on linux-amd64 and darwin-amd64) and nothing is downloaded. Only this platform's
    OpenTUI package is embedded. SIGN_LIBRARY, given on macOS, is called with the path of
    OpenTUI's native library to sign it before Bun embeds it: Bun extracts
    it byte for byte at run time, so a library signed with the release identity passes the
    hardened runtime's library validation without disable-library-validation.
    """
    output = Path(output)
    require(not output.exists() and not output.is_symlink(), "terminal UI output already exists")
    env = dict(os.environ if env is None else env)
    platform = native_platform()
    bun = shutil.which("bun", path=env.get("PATH", os.defpath))
    require(bun is not None, "Bun is required to build the terminal UI; install the version in .bun-version")
    pinned = bun_version(repo)
    actual = subprocess.check_output([bun, "--version"], env=env, text=True, timeout=30).strip()
    require(actual == pinned, f"Bun {actual} differs from the pinned {pinned} in .bun-version")
    package, entry = tui_package(repo)
    # The whole workspace: the terminal UI bundles workspace sources (@supertag/client and the
    # SDK's) by path, whose dependencies a filtered install leaves out.
    subprocess.run(["pnpm", "install", "--frozen-lockfile", "--prefer-offline"],
                   cwd=repo, env={**env, "CI": "true"}, check=True)
    native = opentui_library(repo, platform)
    if sign_library is not None:
        require(platform.startswith("darwin-"), "only macOS libraries are signed")
        # pnpm hard-links package files from its store. Sign a private copy, never the store's.
        real = native.resolve(strict=True)
        private = real.with_name(f".{real.name}.signing")
        shutil.copyfile(real, private)
        os.replace(private, real)
        sign_library(real)
    own = {"darwin-arm64": "darwin-arm64", "darwin-amd64": "darwin-x64", "linux-arm64": "linux-arm64",
           "linux-amd64": "linux-x64"}[platform]
    externals = [argument for other in OPENTUI_PLATFORMS if other != own
                 for argument in ("--external", f"@opentui/core-{other}")]
    version = version_from_repo(repo)
    output.parent.mkdir(parents=True, exist_ok=True)
    # A fresh directory, never an existing file: macOS kills a signed binary rewritten in place.
    with tempfile.TemporaryDirectory(prefix=".supertag-tui-build-", dir=output.parent) as temporary:
        compiled = Path(temporary) / "supertag-tui"
        subprocess.run([bun, "build", "--compile", "--minify", "--bytecode", "--format=esm", *externals,
                        "--define", f"process.env.SUPERTAG_TUI_VERSION={json.dumps(version)}",
                        "--outfile", str(compiled), str(entry)], cwd=package, env=env, check=True)
        compiled.chmod(0o755)
        os.link(compiled, output)
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    package = commands.add_parser("package", help="build or package supplied native binaries")
    package.add_argument("--output", type=Path, required=True)
    package.add_argument("--cli", type=Path)
    package.add_argument("--tui", type=Path)
    package.add_argument("--profile", choices=("dev", "release"))
    package.add_argument("--feature", action="append", default=[], help="compiled Cargo feature, recorded in manifest")
    tui_only = commands.add_parser("tui", help="compile only the terminal UI for this platform and check it")
    tui_only.add_argument("--output", type=Path, required=True, help="new file to write")
    verify = commands.add_parser("verify", help="validate checksum, members, architecture, and binary hashes")
    verify.add_argument("archive", type=Path)
    verify.add_argument("--checksum", type=Path)
    args = parser.parse_args()
    try:
        if args.command == "verify":
            print(json.dumps(validate_archive(args.archive, args.checksum), sort_keys=True))
            return
        if args.command == "tui":
            path = build_tui(args.output.resolve())
            print(json.dumps({"path": str(path), "bytes": path.stat().st_size,
                              **check_tui(path, native_platform())}, sort_keys=True))
            return
        require(not args.tui or SHIP_TUI, "the terminal UI does not ship (SHIP_TUI)")
        require(not args.cli or bool(args.tui) == SHIP_TUI, "supply --tui with --cli exactly when the terminal UI ships")
        require(not args.cli or args.profile is not None, "prebuilt binaries require an explicit --profile")
        profile = args.profile or "release"
        with tempfile.TemporaryDirectory(prefix="supertag-native-build-") as temporary:
            cli = args.cli or build_cli(profile, args.feature)
            tui = args.tui or (build_tui(Path(temporary) / "supertag-tui") if SHIP_TUI else None)
            path = create_archive(cli, tui, args.output, version=version_from_repo(), platform=native_platform(),
                                  profile=profile, features=args.feature, source=source_metadata())
        print(path)
    except (ArchiveError, OSError, subprocess.SubprocessError) as error:
        parser.exit(1, f"native archive: {error}\n")


if __name__ == "__main__":
    main()
