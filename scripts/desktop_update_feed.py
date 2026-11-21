"""Write latest-mac.yml, the feed the desktop app's updater reads from a published GitHub Release.

    desktop_update_feed.py --version VERSION --output latest-mac.yml ZIP...

Each ZIP is a signed app zipped for updates, SuperTag-VERSION-darwin-ARCH.zip, with its
ZIP.blockmap beside it. electron-updater picks the zip for the Mac it runs on: one whose name
holds "arm64" on Apple silicon, any other on Intel. The feed lists every zip given, so one file
serves each architecture the release builds.
"""
import argparse
import base64
import datetime
import hashlib
from pathlib import Path
import re
import sys

ARCHES = ('arm64', 'amd64')


class FeedError(Exception):
    pass


def sha512(path):
    digest = hashlib.sha512()
    with open(path, 'rb') as file:
        for chunk in iter(lambda: file.read(1 << 20), b''):
            digest.update(chunk)
    return base64.b64encode(digest.digest()).decode('ascii')


def arch_of(path, version):
    match = re.fullmatch(rf'SuperTag-{re.escape(version)}-darwin-([a-z0-9_]+)\.zip', path.name)
    if not match or match.group(1) not in ARCHES:
        raise FeedError(f'{path.name} is not SuperTag-{version}-darwin-ARCH.zip for ARCH in {", ".join(ARCHES)}')
    return match.group(1)


def feed(version, zips, release_date):
    """latest-mac.yml's text for `zips`, Apple silicon first."""
    if not re.fullmatch(r'\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?', version):
        raise FeedError(f'{version} is not a release version')
    if not zips:
        raise FeedError('no update zips')
    entries = []
    for path in zips:
        arch = arch_of(path, version)
        if not path.is_file():
            raise FeedError(f'{path} does not exist')
        if not Path(f'{path}.blockmap').is_file():
            raise FeedError(f'{path} has no {path.name}.blockmap beside it')
        entries.append((ARCHES.index(arch), path))
    arches = [index for index, _ in entries]
    if len(set(arches)) != len(arches):
        raise FeedError('more than one zip for an architecture')
    entries.sort()
    lines = [f'version: {version}', 'files:']
    for _, path in entries:
        lines += [f'  - url: {path.name}', f'    sha512: {sha512(path)}', f'    size: {path.stat().st_size}']
    first = entries[0][1]
    # The single-file fields older electron-updater releases read.
    lines += [f'path: {first.name}', f'sha512: {sha512(first)}', f"releaseDate: '{release_date}'"]
    return '\n'.join(lines) + '\n'


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--version', required=True)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--release-date', help='ISO 8601; now when absent')
    parser.add_argument('zips', nargs='+', type=Path)
    args = parser.parse_args(argv)
    release_date = args.release_date or datetime.datetime.now(datetime.timezone.utc).strftime(
        '%Y-%m-%dT%H:%M:%S.000Z')
    try:
        text = feed(args.version, args.zips, release_date)
    except FeedError as error:
        print(f'desktop_update_feed.py: {error}', file=sys.stderr)
        return 1
    args.output.write_text(text)
    print(text, end='')
    return 0


if __name__ == '__main__':
    sys.exit(main())
