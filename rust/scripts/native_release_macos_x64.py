# /// script
# requires-python = ">=3.13"
# dependencies = ["PyYAML==6.0.3"]
# ///
"""Build and execute an unpublished Intel macOS release using disposable x64 tools.

Requires existing Rosetta on Apple Silicon. Does not change system Rosetta,
Rustup, Node, Go, Python, pnpm, or installed SuperTag state.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request

from native_archive import ArchiveError, REPO, digest, require
from native_release_docker import verify_source

NODE = ('node-v22.13.0-darwin-x64', 'cfaaf5edde585a15547f858f5b3b62a292cf5929a23707b6f1e36c29a32487be')
GO = ('go1.26.1.darwin-amd64', '65773dab2f8cc4cd23d93ba6d0a805de150ca0b78378879292be0b903b8cdd08')
MAX_DOWNLOAD = 256 * 1024**2


def download(url, path, expected):
    checksum = hashlib.sha256()
    size = 0
    with urllib.request.urlopen(url, timeout=60) as response, path.open('xb') as output:
        while data := response.read(1024 * 1024):
            size += len(data)
            require(size <= MAX_DOWNLOAD, 'tool download exceeds its bound')
            checksum.update(data)
            output.write(data)
    require(checksum.hexdigest() == expected, 'tool download checksum differs')


def provision(root):
    require(platform.system() == 'Darwin', 'Intel macOS packaging requires macOS')
    require(subprocess.check_output(['arch', '-x86_64', '/usr/bin/uname', '-m'], text=True).strip() == 'x86_64',
            'Intel execution is unavailable; existing Rosetta is required on Apple Silicon')
    uv, rustup = shutil.which('uv'), shutil.which('rustup')
    require(uv and rustup, 'uv and rustup are required as tool downloaders')
    root = root.resolve()
    require(not root.exists(), 'tool directory already exists')
    root.mkdir(mode=0o700, parents=True)
    home = root / 'home'
    home.mkdir(mode=0o700)
    env = {'HOME': str(home), 'PATH': os.environ.get('PATH', os.defpath), 'LANG': 'C.UTF-8',
           'RUSTUP_HOME': str(root/'rustup'), 'CARGO_HOME': str(root/'cargo')}
    for name, url, checksum, extracted, destination in (
        ('node.tar.gz', f'https://nodejs.org/dist/v22.13.0/{NODE[0]}.tar.gz', NODE[1], NODE[0], 'node'),
        ('go.tar.gz', f'https://go.dev/dl/{GO[0]}.tar.gz', GO[1], 'go', 'go'),
    ):
        archive = root / name
        download(url, archive, checksum)
        with tarfile.open(archive) as source:
            source.extractall(root, filter='data')
        if extracted != destination:
            (root/extracted).rename(root/destination)
        archive.unlink()
    subprocess.run([uv, '--no-config', '--cache-dir', str(root/'uv-cache'), 'python', 'install',
                    '--install-dir', str(root/'python'), '--no-bin', 'cpython-3.13.9-macos-x86_64-none'], env=env, check=True)
    interpreters = list((root/'python').glob('cpython-3.13.9-macos-x86_64-none/bin/python3.13'))
    require(len(interpreters) == 1, 'downloaded Intel Python is unavailable')
    python = interpreters[0]
    subprocess.run([python, '-m', 'venv', str(root/'release-python')], env=env, check=True)
    python = root/'release-python/bin/python'
    subprocess.run([python, '-m', 'pip', 'install', '--no-cache-dir', 'PyYAML==6.0.3',
                    'grpcio==1.85.1', 'grpcio-tools==1.85.1', 'protobuf==7.36.2'], env=env, check=True)
    subprocess.run([rustup, 'toolchain', 'install', '1.93.1-x86_64-apple-darwin', '--profile', 'minimal',
                    '--no-self-update', '--force-non-host'], env=env, check=True)
    bins = [root/'rustup/toolchains/1.93.1-x86_64-apple-darwin/bin', root/'node/bin', root/'go/bin', root/'release-python/bin']
    env['PATH'] = os.pathsep.join([*(str(path) for path in bins), env['PATH']])
    subprocess.run([str(root/'node/bin/npm'), 'install', '--global', '--ignore-scripts', '--no-audit', '--no-fund',
                    '--prefix', str(root/'node'), 'pnpm@11.18.0'], env=env, check=True)
    (root/'toolchain.json').write_text(json.dumps({'format':'supertag-macos-x64-tools-v1',
        'node_sha256':NODE[1], 'go_sha256':GO[1], 'python_binary_sha256':digest(python.resolve()),
        'python':'3.13.9', 'rust':'1.93.1-x86_64-apple-darwin', 'pnpm':'11.18.0'}, indent=2)+'\n')
    return python, env


def package(repo, commit, output, profile, tools):
    verify_source(repo, commit)
    require(profile in ('release', 'dev'), 'unknown release profile')
    output = output.resolve()
    require(not output.exists(), 'release output directory already exists')
    python, env = provision(tools)
    subprocess.run([python, repo/'rust/scripts/native_release.py', 'package', '--repo', repo, '--commit', commit,
        '--expect-platform', 'darwin-amd64', '--profile', profile, '--output', output, '--install-smoke'],
        env=env, check=True)
    shutil.copyfile(tools.resolve()/'toolchain.json', output/'toolchain.json')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, default=REPO)
    parser.add_argument('--commit', required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--tools-directory', type=Path, help='new private directory; retained for inspection when specified')
    parser.add_argument('--profile', choices=('dev', 'release'), default='release')
    args = parser.parse_args()
    try:
        if args.tools_directory:
            package(args.repo.resolve(), args.commit, args.output, args.profile, args.tools_directory)
        else:
            with tempfile.TemporaryDirectory(prefix='supertag-macos-x64-') as temporary:
                package(args.repo.resolve(), args.commit, args.output, args.profile, Path(temporary)/'tools')
    except (ArchiveError, OSError, ValueError, subprocess.SubprocessError) as error:
        parser.exit(1, f'Intel macOS release: {error}\n')


if __name__ == '__main__':
    main()
