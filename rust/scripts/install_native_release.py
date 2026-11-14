# /// script
# requires-python = ">=3.13"
# dependencies = ["PyYAML==6.0.3"]
# ///
"""Install a verified local native archive without changing the release channel.

Uses the existing SUPERTAG_INSTALL_ROOT / SUPERTAG_BIN_DIR and XDG overrides.
Keeps older installs, switches only a managed command link, and never starts
services or reads, imports, archives, or removes runtime state.
"""
from contextlib import contextmanager
import argparse
import ctypes
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import tempfile
import uuid

from native_archive import ArchiveError, check_versions, copy_bounded, digest, native_platform, require
from node_bridges import PACKAGES, smoke_entry, verify_node
from release_archive import (check_provider_version, MAX_ARCHIVE_BYTES, MAX_ENTRIES, MAX_MANIFEST_BYTES, extract_release,
                             unique_object, validate_manifest, validate_release)

RECEIPT = ".supertag-install.json"
INSTALL_FORMAT = "supertag-native-install-v1"


def install_paths(env):
    home = env.get("HOME")
    require(home, "HOME is required")
    root = env.get("SUPERTAG_INSTALL_ROOT") or str(Path(env.get("XDG_DATA_HOME") or Path(home) / ".local/share") / "supertag")
    binary = env.get("SUPERTAG_BIN_DIR") or env.get("XDG_BIN_HOME") or str(Path(home) / ".local/bin")
    require(Path(root).is_absolute() and Path(binary).is_absolute(), "installation paths must be absolute")
    return Path(root), Path(binary)


def owned(info, label):
    require(info.st_uid == os.geteuid() and (stat.S_ISLNK(info.st_mode) or info.st_mode & 0o022 == 0),
            f"{label} must be owned by the installing user and not writable by others")


def directory(path):
    require(not path.is_symlink(), "installation directory must not be a symlink")
    missing, parent = [], path
    while not parent.exists():
        require(not parent.is_symlink(), "installation parent is a dangling link")
        missing.append(parent)
        parent = parent.parent
    for item in reversed(missing):
        item.mkdir(mode=0o700)
    path = path.resolve(strict=True)
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode), "installation path must be a directory")
    owned(info, "installation directory")
    for ancestor in path.parents:
        metadata = ancestor.stat()
        require(metadata.st_uid in (0, os.geteuid()) and
                (metadata.st_mode & 0o022 == 0 or metadata.st_mode & stat.S_ISVTX),
                "installation parent is writable by another user")
    return path


def read_json(path, maximum):
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb") as handle:
        info = os.fstat(handle.fileno())
        owned(info, "installation metadata")
        require(stat.S_ISREG(info.st_mode) and 0 < info.st_size <= maximum, "invalid installation metadata")
        data = handle.read(maximum + 1)
        require(len(data) <= maximum, "oversized installation metadata")
        return json.loads(data, object_pairs_hook=unique_object)


def target_name(manifest, archive_hash):
    return f"native-{manifest['version']}-{manifest['platform']}-{manifest['profile']}-{archive_hash}"


def receipt_for(manifest, archive_hash):
    return {"format": INSTALL_FORMAT, "archive_sha256": archive_hash,
            "source_commit": manifest["source"]["commit"]}


@contextmanager
def locked(path):
    descriptor = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        info = os.fstat(descriptor)
        owned(info, "installation lock")
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, "invalid installation lock")
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ArchiveError("another native installation is in progress") from error
        yield
    finally:
        os.close(descriptor)


def rename_exclusive(source, target):
    """Publish a prepared directory/link without replacing even an empty target."""
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform == "darwin":
        function = libc.renamex_np
        function.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        arguments = [os.fsencode(source), os.fsencode(target), 0x00000004]  # RENAME_EXCL
    elif sys.platform == "linux" and hasattr(libc, "renameat2"):
        function = libc.renameat2
        function.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        arguments = [-100, os.fsencode(source), -100, os.fsencode(target), 1]  # AT_FDCWD, RENAME_NOREPLACE
    else:
        raise ArchiveError("exclusive native installation is unsupported on this platform")
    function.restype = ctypes.c_int
    if function(*arguments) != 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code), str(target))


def link_identity(command):
    try:
        info = command.lstat()
    except FileNotFoundError:
        return None
    owned(info, "existing command")
    require(stat.S_ISLNK(info.st_mode), "refusing to replace an unmanaged supertag command")
    return info.st_dev, info.st_ino, str(command.readlink())


def managed_command(command, root):
    identity = link_identity(command)
    if identity is None:
        return None
    target = Path(os.path.abspath(command.parent / identity[2]))
    try:
        relative = target.relative_to(root / "versions")
    except ValueError as error:
        raise ArchiveError("refusing to replace an unmanaged supertag command") from error
    parts = relative.parts
    require(len(parts) >= 2, "invalid managed command path")
    version = root / "versions" / parts[0]
    require(not version.is_symlink() and version.is_dir(), "managed installation directory is unavailable")
    owned(version.lstat(), "managed installation")
    if len(parts) == 2 and parts[1] == "supertag":
        manifest = validate_manifest(read_json(version / "manifest.json", MAX_MANIFEST_BYTES))
        receipt = read_json(version / RECEIPT, 4096)
        require(isinstance(receipt, dict) and set(receipt) == {"format", "archive_sha256", "source_commit"}
                and receipt["format"] == INSTALL_FORMAT and isinstance(receipt["archive_sha256"], str)
                and re.fullmatch(r"[a-f0-9]{64}", receipt["archive_sha256"])
                and parts[0] == target_name(manifest, receipt["archive_sha256"])
                and receipt["source_commit"] == manifest["source"]["commit"], "unrecognized native installation")
    elif len(parts) == 4 and parts[1:] == ("node_modules", ".bin", "supertag"):
        # Recognize only the existing install.sh layout. Keep it for rollback;
        # no npm command is executed and no old state is inspected.
        manifest = read_json(version / "node_modules/supertag-ai/package.json", 1024 * 1024)
        require(isinstance(manifest, dict) and manifest.get("name") == "supertag-ai" and manifest.get("version") == parts[0]
                and target.resolve(strict=True).is_relative_to(version), "unrecognized npm installation")
    else:
        raise ArchiveError("refusing to replace an unmanaged supertag command")
    return identity


def verify_installed(package, manifest, archive_hash):
    require(not package.is_symlink() and package.is_dir(), "native installation directory is unsafe")
    owned(package.lstat(), "native installation")
    require(read_json(package / "manifest.json", MAX_MANIFEST_BYTES) == manifest, "installed manifest differs from archive")
    require(read_json(package / RECEIPT, 4096) == receipt_for(manifest, archive_hash), "installed archive receipt differs")
    expected = set(manifest["entries"]) | {"manifest.json", RECEIPT}
    found = set()
    for path in package.rglob("*"):
        name = path.relative_to(package).as_posix()
        found.add(name)
        require(len(found) <= MAX_ENTRIES + 2 and name in expected, "unexpected installed file")
        info = path.lstat()
        owned(info, "installed file")
        if name in ("manifest.json", RECEIPT):
            continue
        entry = manifest["entries"][name]
        require(stat.S_IMODE(info.st_mode) == entry["mode"], "installed file mode differs")
        if entry["type"] == "directory":
            require(stat.S_ISDIR(info.st_mode), "installed directory differs")
        elif entry["type"] == "symlink":
            require(stat.S_ISLNK(info.st_mode) and str(path.readlink()) == entry["target"], "installed link differs")
        else:
            require(stat.S_ISREG(info.st_mode) and info.st_size == entry["bytes"], "installed file size differs")
            with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb") as handle:
                descriptor = os.fstat(handle.fileno())
                require(stat.S_ISREG(descriptor.st_mode) and descriptor.st_size == entry["bytes"], "installed file changed")
                hashed, count = hashlib.sha256(), 0
                while chunk := handle.read(min(1024 * 1024, entry["bytes"] - count + 1)):
                    count += len(chunk)
                    require(count <= entry["bytes"], "installed file grew during verification")
                    hashed.update(chunk)
                require(count == entry["bytes"] and hashed.hexdigest() == entry["sha256"], "installed file digest differs")
    require(found == expected, "native installation is incomplete")


def probe(package, manifest, node):
    check_versions(package / "supertag", package / "supertag-tui", manifest["version"])
    check_provider_version(package / "supertag-shared-execution", manifest["version"])
    for kind, name in PACKAGES.items():
        smoke_entry(node, kind, package / "node-bridges/node_modules" / name)


def sync_path(path, *, is_directory=False):
    flags = os.O_RDONLY | os.O_NOFOLLOW
    if is_directory:
        flags |= os.O_DIRECTORY
    descriptor = os.open(path, flags)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def sync_package(package, manifest):
    for name in ["manifest.json", RECEIPT, *(
            name for name, entry in manifest["entries"].items() if entry["type"] == "file")]:
        sync_path(package / name)
    directories = [name for name, entry in manifest["entries"].items() if entry["type"] == "directory"]
    for name in sorted(directories, key=lambda value: value.count("/"), reverse=True):
        sync_path(package / name, is_directory=True)
    sync_path(package, is_directory=True)


def install(archive, *, env=None, node=None, expected_sha256=None):
    original = Path(archive).resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix="supertag-install-verify-") as temporary:
        candidate = Path(temporary) / original.name
        copy_bounded(original, candidate, MAX_ARCHIVE_BYTES)
        copy_bounded(Path(str(original) + ".sha256"), Path(str(candidate) + ".sha256"), 1024)
        return install_verified(candidate, env=env, node=node, expected_sha256=expected_sha256)


def install_verified(archive, *, env=None, node=None, expected_sha256=None):
    env = dict(os.environ if env is None else env)
    archive = Path(archive).resolve(strict=True)
    manifest = validate_release(archive)
    archive_hash = digest(archive)
    if expected_sha256 is not None:
        require(re.fullmatch(r"[a-f0-9]{64}", expected_sha256) and archive_hash == expected_sha256,
                "archive differs from the expected SHA-256")
    require(manifest["platform"] == native_platform(), "archive platform does not match this machine")
    node = node or shutil.which("node", path=env.get("PATH", os.defpath))
    require(node, "Node 22.13 or a later Node 22 interpreter is required")
    node = Path(node).resolve(strict=True)
    verify_node(node)
    configured_root, configured_bin = install_paths(env)
    root, binary = directory(configured_root), directory(configured_bin)
    versions = directory(root / "versions")
    command = binary / "supertag"
    with locked(binary / ".supertag-native-install.lock"), locked(root / ".native-install.lock"):
        before = managed_command(command, root)
        target = versions / target_name(manifest, archive_hash)
        reused = target.exists() or target.is_symlink()
        if reused:
            verify_installed(target, manifest, archive_hash)
            probe(target, manifest, node)
            verify_installed(target, manifest, archive_hash)
        else:
            with tempfile.TemporaryDirectory(prefix=".native-stage-", dir=versions) as temporary:
                package = extract_release(archive, Path(temporary) / "verified")
                # The input may have changed since initial selection. Bind the
                # verified private extraction to that original manifest.
                require(read_json(package / "manifest.json", MAX_MANIFEST_BYTES) == manifest,
                        "archive changed during installation")
                with (package / RECEIPT).open("x") as receipt:
                    json.dump(receipt_for(manifest, archive_hash), receipt, sort_keys=True)
                    receipt.write("\n")
                    receipt.flush()
                    os.fsync(receipt.fileno())
                (package / RECEIPT).chmod(0o600)
                verify_installed(package, manifest, archive_hash)
                probe(package, manifest, node)
                verify_installed(package, manifest, archive_hash)
                sync_package(package, manifest)
                rename_exclusive(package, target)
                sync_path(versions, is_directory=True)
        require(link_identity(command) == before, "supertag command changed during installation")
        temporary_link = binary / (".supertag-native-" + uuid.uuid4().hex)
        try:
            temporary_link.symlink_to(target / "supertag")
            if before is None:
                rename_exclusive(temporary_link, command)
            else:
                os.replace(temporary_link, command)
            sync_path(binary, is_directory=True)
        finally:
            temporary_link.unlink(missing_ok=True)
    return {"version": manifest["version"], "platform": manifest["platform"], "archive_sha256": archive_hash,
            "command": str(command), "installation": str(target), "reused": reused,
            "shared_execution_provider": str(target / "supertag-shared-execution"),
            "previous_command": before[2] if before else None, "runtime_state_unchanged": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--sha256", help="optional independently supplied expected archive digest")
    parser.add_argument("--node", type=Path, help="external Node 22.13+ interpreter (default: PATH)")
    args = parser.parse_args()
    try:
        print(json.dumps(install(args.archive, node=args.node, expected_sha256=args.sha256), indent=2, sort_keys=True))
    except (ArchiveError, OSError, ValueError) as error:
        parser.exit(1, f"native install: {error}\n")


if __name__ == "__main__":
    main()
