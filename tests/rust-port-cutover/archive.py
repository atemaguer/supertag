"""Checksum archive for the synthetic cutover rehearsal; not a production backup CLI."""
import hashlib
import io
import json
import os
import re
from pathlib import Path, PurePosixPath
import shutil
import stat
import tarfile
import tempfile

FORMAT = 'supertag-synthetic-cutover-v1'
MAX_BYTES = 256 * 1024 * 1024
MAX_FILES = 10000


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(path):
    with Path(path).open('rb') as file:
        return hashlib.file_digest(file, 'sha256').hexdigest()


def safe_path(name):
    return isinstance(name, str) and 0 < len(name) < 4096 and not name.startswith('/') and '\\' not in name and all(part not in ('', '.', '..') for part in name.split('/'))


def archive_fixture(source, archive, deployment):
    source, archive = Path(source), Path(archive)
    require(deployment.get('writers_stopped') is True, 'stop fixture writers before archiving')
    require(source.is_dir() and not source.is_symlink(), 'fixture root must be a directory')
    entries = {}
    total = 0
    for path in sorted(source.rglob('*')):
        info = path.lstat()
        name = path.relative_to(source).as_posix()
        require(safe_path(name) and name != 'manifest.json', 'invalid fixture path')
        require(stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode), 'fixture archive refuses links and special files')
        record = {'kind': 'directory' if stat.S_ISDIR(info.st_mode) else 'file', 'mode': stat.S_IMODE(info.st_mode)}
        require(record['mode'] & ~0o777 == 0, 'fixture mode has special bits')
        if record['kind'] == 'file':
            total += info.st_size
            require(total <= MAX_BYTES, 'fixture archive exceeds size limit')
            record.update(bytes=info.st_size, sha256=digest(path))
        entries[name] = record
        require(len(entries) <= MAX_FILES, 'too many fixture entries')
    manifest = {'format': FORMAT, 'deployment': deployment, 'entries': entries}
    payload = json.dumps(manifest, sort_keys=True).encode()
    require(len(payload) <= 2 * 1024 * 1024, 'fixture manifest too large')
    with os.fdopen(os.open(archive, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as output:
        with tarfile.open(fileobj=output, mode='w') as target:
            info = tarfile.TarInfo('manifest.json')
            info.size, info.mode = len(payload), 0o600
            target.addfile(info, io.BytesIO(payload))
            for name, record in entries.items():
                info = tarfile.TarInfo(name)
                info.mode = record['mode']
                if record['kind'] == 'directory':
                    info.type = tarfile.DIRTYPE
                    target.addfile(info)
                else:
                    info.size = record['bytes']
                    with (source / name).open('rb') as contents:
                        target.addfile(info, contents)
        output.flush()
        os.fsync(output.fileno())
    sha = digest(archive)
    verify_archive(archive, sha)
    return sha


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'duplicate fixture manifest field')
        result[key] = value
    return result


def verify_archive(archive, expected_sha256):
    archive = Path(archive)
    require(archive.is_file() and archive.stat().st_size <= MAX_BYTES + 32 * 1024 * 1024, 'fixture archive exceeds limit')
    require(digest(archive) == expected_sha256, 'fixture archive checksum differs')
    with tarfile.open(archive, 'r:') as contents:
        members = contents.getmembers()
        require(1 <= len(members) <= MAX_FILES + 1, 'invalid fixture entry count')
        first = members[0]
        require(first.name == 'manifest.json' and first.isfile() and first.size <= 2 * 1024 * 1024, 'fixture manifest missing')
        manifest = json.load(contents.extractfile(first), object_pairs_hook=unique_object)
        require(isinstance(manifest, dict), 'invalid fixture manifest')
        require(manifest.get('format') == FORMAT and isinstance(manifest.get('entries'), dict), 'invalid fixture manifest')
        entries = manifest['entries']
        require(len(entries) == len(members) - 1, 'fixture entry count differs')
        for name, record in entries.items():
            require(safe_path(name) and isinstance(record, dict), 'invalid fixture record')
            require(record.get('kind') in ('directory', 'file'), 'invalid fixture kind')
            require(type(record.get('mode')) is int and 0 <= record['mode'] <= 0o777, 'invalid fixture mode')
            if record['kind'] == 'file':
                require(type(record.get('bytes')) is int and 0 <= record['bytes'] <= MAX_BYTES and isinstance(record.get('sha256'), str) and re.fullmatch('[0-9a-f]{64}', record['sha256']), 'invalid fixture receipt')
        seen = set()
        total = 0
        for member in members[1:]:
            name = member.name
            require(safe_path(name) and name not in seen and name in entries, 'unexpected fixture path')
            seen.add(name)
            record = entries[name]
            require(isinstance(record, dict) and type(record.get('mode')) is int and 0 <= record['mode'] <= 0o777, 'invalid fixture mode')
            require(member.mode == record['mode'] and not member.sparse, 'fixture mode or sparse entry differs')
            parent = PurePosixPath(name).parent
            while str(parent) != '.':
                require(entries.get(str(parent), {}).get('kind') == 'directory', 'fixture parent is not a directory')
                parent = parent.parent
            if record.get('kind') == 'directory':
                require(member.isdir(), 'fixture directory differs')
            else:
                require(record.get('kind') == 'file' and member.isfile() and type(record.get('bytes')) is int and member.size == record['bytes'] and member.size >= 0, 'fixture file differs')
                total += member.size
                require(total <= MAX_BYTES, 'fixture data exceeds limit')
                require(hashlib.file_digest(contents.extractfile(member), 'sha256').hexdigest() == record.get('sha256'), 'fixture file checksum differs')
    return manifest


def restore_fixture(archive, destination, expected_sha256):
    destination = Path(destination)
    require(not destination.exists() and not destination.is_symlink(), 'restore destination must be new')
    manifest = verify_archive(archive, expected_sha256)
    temporary = Path(tempfile.mkdtemp(prefix='.verified-restore-', dir=destination.parent))
    try:
        with tarfile.open(archive, 'r:') as contents:
            for name, record in sorted(manifest['entries'].items(), key=lambda item: (item[0].count('/'), item[0])):
                path = temporary / name
                if record['kind'] == 'directory':
                    path.mkdir(mode=0o700)
                else:
                    with path.open('xb') as output, contents.extractfile(name) as source:
                        shutil.copyfileobj(source, output)
                        output.flush()
                        os.fsync(output.fileno())
                    path.chmod(record['mode'])
            for name, record in manifest['entries'].items():
                if record['kind'] == 'directory':
                    (temporary / name).chmod(record['mode'])
        temporary.rename(destination)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)
    return manifest
