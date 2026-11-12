"""Bounded, relocatable native release archive; no installer or network operations."""
from contextlib import contextmanager
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tarfile
import tempfile
import zlib

from native_archive import (ArchiveError, BINARIES as CLI_TUI_BINARIES, MAX_BINARY_BYTES, check_architecture,
                            copy_bounded, copy_stream_bounded, digest, package_root,
                            publish_files, require, validate_metadata, validate_tar_footer,
                            write_checksum)

FORMAT = "supertag-native-release-v1"
# The small CLI/TUI fixture archive intentionally keeps its existing two files.
BINARIES = (*CLI_TUI_BINARIES, "supertag-shared-execution")


def check_provider_version(binary, version):
    with tempfile.TemporaryDirectory(prefix="supertag-provider-version-") as home:
        result = subprocess.run([str(binary), "--version"], env={"PATH": os.defpath, "HOME": home},
                                capture_output=True, text=True, timeout=10, check=False)
        require(result.returncode == 0 and result.stdout.strip() == f"supertag-shared-execution {version}",
                "shared execution provider does not report the package version")

MAX_ARCHIVE_BYTES = 2 * 1024**3
MAX_EXPANDED_BYTES = 4 * 1024**3
MAX_MANIFEST_BYTES = 32 * 1024**2
MAX_ENTRIES = 100_000


def relative_name(name):
    require(isinstance(name, str) and len(name.encode()) <= 4096 and "\\" not in name
            and "\x00" not in name and not name.startswith("/")
            and all(part not in ("", ".", "..") for part in name.split("/")), "unsafe release path")
    return name


def validate_tree(entries):
    # Check every target before resolving any chain, including targets reached
    # through a later manifest entry.
    for entry in entries.values():
        if entry["type"] == "symlink":
            target = entry["target"]
            require(isinstance(target, str) and 0 < len(target.encode()) <= 4096
                    and not target.startswith("/") and "\\" not in target and "\x00" not in target,
                    "unsafe release link")
    for name, entry in entries.items():
        relative_name(name)
        parts = name.split("/")
        for end in range(1, len(parts)):
            require(entries.get("/".join(parts[:end]), {}).get("type") == "directory",
                    "release entry traverses a non-directory")
        if entry["type"] == "symlink":
            target = entry["target"]
            # Resolve against the manifest only, before creating any filesystem output.
            pending = parts[:-1] + target.split("/")
            resolved, hops = [], 0
            while pending:
                part = pending.pop(0)
                if part in ("", "."):
                    continue
                if part == "..":
                    require(resolved, "release link leaves package")
                    resolved.pop()
                    continue
                resolved.append(part)
                candidate = entries.get("/".join(resolved))
                require(candidate is not None, "dangling release link")
                if candidate["type"] == "symlink":
                    hops += 1
                    require(hops <= 64, "cyclic release link")
                    resolved.pop()
                    pending = candidate["target"].split("/") + pending
                elif pending:
                    require(candidate["type"] == "directory", "release link traverses a non-directory")


def inventory(root):
    entries, total = {}, 0
    # Path.rglob does not traverse directory symlinks on the supported Python versions.
    for path in sorted(root.rglob("*")):
        name = relative_name(path.relative_to(root).as_posix())
        require(name != "manifest.json", "release stage already contains a manifest")
        info = path.lstat()
        if stat.S_ISDIR(info.st_mode):
            entry = {"type": "directory", "mode": 0o755}
        elif stat.S_ISLNK(info.st_mode):
            entry = {"type": "symlink", "target": str(path.readlink()), "mode": 0o777}
        else:
            require(stat.S_ISREG(info.st_mode) and 0 <= info.st_size <= MAX_BINARY_BYTES,
                    "unsupported or oversized release file")
            require(info.st_mode & 0o022 == 0, "writable release file")
            total += info.st_size
            require(total <= MAX_EXPANDED_BYTES, "release exceeds expanded size limit")
            entry = {"type": "file", "mode": 0o755 if info.st_mode & 0o111 else 0o644,
                     "bytes": info.st_size, "sha256": digest(path)}
        entries[name] = entry
        require(len(entries) <= MAX_ENTRIES, "too many release entries")
    validate_tree(entries)
    return entries


def validate_manifest(manifest):
    require(isinstance(manifest, dict) and set(manifest) == {
        "format", "version", "platform", "profile", "source", "runtime", "entries"}, "invalid release manifest")
    require(manifest["format"] == FORMAT, "unsupported release format")
    source = manifest["source"]
    require(isinstance(source, dict) and set(source) == {"commit", "archive_sha256", "lockfiles"},
            "invalid release source")
    require(isinstance(source["commit"], str) and re.fullmatch(r"[a-f0-9]{40}", source["commit"]),
            "release requires an exact source commit")
    validate_metadata(manifest["version"], manifest["platform"], manifest["profile"], [],
                      {"commit": source["commit"], "dirty": False})
    require(isinstance(source["lockfiles"], dict) and set(source["lockfiles"]) == {
        "pnpm-lock.yaml", "rust/Cargo.lock", "apps/tui/go.sum"}, "invalid source lockfiles")
    for value in [source["archive_sha256"], *source["lockfiles"].values()]:
        require(isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value), "invalid source digest")
    runtime = manifest["runtime"]
    require(isinstance(runtime, dict) and set(runtime) == {"node", "helpers"}
            and runtime["node"] == ">=22.13 <23", "invalid runtime requirements")
    from node_bridges import PACKAGES, entry_for
    expected = {kind: f"node-bridges/node_modules/{package}/{entry_for(kind)}" for kind, package in PACKAGES.items()}
    require(runtime["helpers"] == expected, "release does not contain the complete helper set")
    entries = manifest["entries"]
    require(isinstance(entries, dict) and len(entries) <= MAX_ENTRIES, "invalid release entries")
    total = 0
    for name, entry in entries.items():
        relative_name(name)
        require(name != "manifest.json" and isinstance(entry, dict), "invalid release entry")
        kind = entry.get("type")
        if kind == "file":
            require(set(entry) == {"type", "mode", "bytes", "sha256"} and entry["mode"] in (0o644, 0o755)
                    and type(entry["bytes"]) is int and 0 <= entry["bytes"] <= MAX_BINARY_BYTES
                    and isinstance(entry["sha256"], str) and re.fullmatch(r"[a-f0-9]{64}", entry["sha256"]),
                    "invalid release file")
            total += entry["bytes"]
        elif kind == "directory":
            require(entry == {"type": "directory", "mode": 0o755}, "invalid release directory")
        elif kind == "symlink":
            require(set(entry) == {"type", "mode", "target"} and entry["mode"] == 0o777, "invalid release link")
        else:
            raise ArchiveError("unsupported release entry")
    require(total <= MAX_EXPANDED_BYTES, "release exceeds expanded size limit")
    validate_tree(entries)
    for name in [*BINARIES, "node-bridges/manifest.json", *expected.values()]:
        require(entries.get(name, {}).get("type") == "file", "release is missing a required file")
    for name in BINARIES:
        require(entries[name]["mode"] == 0o755, "release binary is not executable")
    return manifest


def create_release(stage, output, *, version, platform, profile, source):
    from node_bridges import PACKAGES, entry_for
    manifest = {"format": FORMAT, "version": version, "platform": platform, "profile": profile,
                "source": source, "runtime": {"node": ">=22.13 <23", "helpers": {
                    kind: f"node-bridges/node_modules/{package}/{entry_for(kind)}" for kind, package in PACKAGES.items()}},
                "entries": inventory(stage)}
    validate_manifest(manifest)
    encoded = json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode() + b"\n"
    require(len(encoded) <= MAX_MANIFEST_BYTES, "release manifest is oversized")
    output.mkdir(parents=True, exist_ok=True)
    root = package_root(version, platform, profile) + "-complete"
    archive = output / (root + ".tar.gz")
    require(not archive.exists() and not Path(str(archive) + ".sha256").exists(), "release output already exists")
    with tempfile.TemporaryDirectory(prefix=".supertag-release-", dir=output) as temporary:
        candidate = Path(temporary) / archive.name
        with candidate.open("xb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", filename="", mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as target:
                directory = tarfile.TarInfo(root)
                directory.type, directory.mode = tarfile.DIRTYPE, 0o755
                target.addfile(directory)
                import io
                header = tarfile.TarInfo(root + "/manifest.json")
                header.mode, header.size = 0o644, len(encoded)
                target.addfile(header, io.BytesIO(encoded))
                for name, entry in manifest["entries"].items():
                    info = tarfile.TarInfo(root + "/" + name)
                    info.mode = entry["mode"]
                    if entry["type"] == "directory":
                        info.type = tarfile.DIRTYPE
                        target.addfile(info)
                    elif entry["type"] == "symlink":
                        info.type, info.linkname = tarfile.SYMTYPE, entry["target"]
                        target.addfile(info)
                    else:
                        info.size = entry["bytes"]
                        with (stage / name).open("rb") as data:
                            target.addfile(info, data)
        checksum = write_checksum(candidate)
        validate_release(candidate)
        publish_files([(candidate, archive), (checksum, Path(str(archive) + ".sha256"))])
    return archive


@contextmanager
def expanded(path):
    with tempfile.TemporaryFile() as raw:
        total = 0
        try:
            with gzip.open(path, "rb") as compressed:
                while chunk := compressed.read(1024 * 1024):
                    total += len(chunk)
                    require(total <= MAX_EXPANDED_BYTES + MAX_MANIFEST_BYTES + MAX_ENTRIES * 4096,
                            "expanded release is oversized")
                    raw.write(chunk)
        except (OSError, EOFError, zlib.error) as error:
            raise ArchiveError("invalid compressed release") from error
        raw.seek(0)
        yield raw


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "duplicate release manifest key")
        result[key] = value
    return result


def validate_release(path, checksum=None):
    path = Path(path)
    checksum = Path(checksum) if checksum else Path(str(path) + ".sha256")
    require(path.is_file() and 0 < path.stat().st_size <= MAX_ARCHIVE_BYTES, "release archive is unavailable or oversized")
    require(checksum.is_file() and checksum.stat().st_size <= 1024, "release checksum is unavailable")
    require(checksum.read_text(encoding="ascii") == f"{digest(path)}  {path.name}\n", "release checksum differs")
    found, manifest, root, end = set(), None, None, 0
    with expanded(path) as raw, tarfile.open(fileobj=raw, mode="r:") as archive:
        for index, member in enumerate(archive):
            require(index < MAX_ENTRIES + 2 and not member.sparse and not member.islnk(), "unsupported release archive entry")
            relative_name(member.name)
            require(member.uid == 0 and member.gid == 0 and member.mtime == 0, "unexpected release owner or timestamp")
            end = member.offset_data + ((member.size + 511) // 512) * 512
            if index == 0:
                require(member.isdir() and "/" not in member.name and member.mode == 0o755, "invalid release root")
                root = member.name
                continue
            require(member.name.startswith(root + "/"), "release entry leaves root")
            name = member.name[len(root) + 1:]
            require(name not in found, "duplicate release archive entry")
            found.add(name)
            if index == 1:
                require(name == "manifest.json" and member.isfile() and member.mode == 0o644
                        and member.size <= MAX_MANIFEST_BYTES, "invalid release manifest entry")
                manifest = validate_manifest(json.load(archive.extractfile(member), object_pairs_hook=unique_object))
                require(root == package_root(manifest["version"], manifest["platform"], manifest["profile"]) + "-complete",
                        "release root differs from manifest")
                continue
            entry = manifest["entries"].get(name)
            require(entry is not None and member.mode == entry["mode"], "unexpected release archive entry or mode")
            if entry["type"] == "directory":
                require(member.isdir() and member.size == 0, "invalid release directory entry")
            elif entry["type"] == "symlink":
                require(member.issym() and member.size == 0 and member.linkname == entry["target"], "release link differs")
            else:
                require(member.isfile() and member.size == entry["bytes"], "release file size differs")
                reader, hashed, size, prefix = archive.extractfile(member), hashlib.sha256(), 0, b""
                while chunk := reader.read(1024 * 1024):
                    size += len(chunk)
                    hashed.update(chunk)
                    if not prefix:
                        prefix = chunk[:32]
                require(size == entry["bytes"] and hashed.hexdigest() == entry["sha256"], "release file digest differs")
                if name in BINARIES:
                    check_architecture(prefix, manifest["platform"])
        require(manifest is not None and found == {"manifest.json", *manifest["entries"]}, "release archive is incomplete")
        validate_tar_footer(raw, end)
    return manifest


def extract_release(path, destination, checksum=None):
    path, destination = Path(path), Path(destination)
    require(not destination.exists() and not destination.is_symlink(), "release extraction requires a new destination")
    checksum = Path(checksum) if checksum else Path(str(path) + ".sha256")
    with tempfile.TemporaryDirectory(prefix="supertag-release-verify-") as temporary:
        candidate = Path(temporary) / path.name
        copy_bounded(path, candidate, MAX_ARCHIVE_BYTES)
        copy_bounded(checksum, Path(str(candidate) + ".sha256"), 1024)
        manifest = validate_release(candidate)
        destination.mkdir(mode=0o700)
        root = destination / (package_root(manifest["version"], manifest["platform"], manifest["profile"]) + "-complete")
        root.mkdir(mode=0o755)
        # No extractall: every parent is a validated directory; links are created last.
        for name, entry in sorted(manifest["entries"].items(), key=lambda item: (item[0].count("/"), item[0])):
            if entry["type"] == "directory":
                (root / name).mkdir(mode=0o755)
        with tarfile.open(candidate, "r:gz") as archive:
            for member in archive:
                if member.isfile():
                    name = member.name.split("/", 1)[1]
                    with archive.extractfile(member) as reader, (root / name).open("xb") as writer:
                        copy_stream_bounded(reader, writer, member.size)
                    (root / name).chmod(member.mode)
        for name, entry in manifest["entries"].items():
            if entry["type"] == "symlink":
                link = root / name
                link.symlink_to(entry["target"])
                # Linux creates 0777 links; macOS applies the process umask.
                # Restore the portable metadata without chmod-ing the target.
                if stat.S_IMODE(link.lstat().st_mode) != entry["mode"]:
                    link.chmod(entry["mode"], follow_symlinks=False)
    return root
