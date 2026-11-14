"""Check that a release tag names the version every released artifact reports.

The Rust workspace version is the release version: the native archive, the supertag and
supertag-tui binaries, and the Python SDK must all carry it. Prints the version on success.
"""
import argparse
from pathlib import Path
import re
import sys
import tomllib

REPO = Path(__file__).resolve().parents[2]
VERSION = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?")


def release_version(tag, repo=REPO):
    version = tomllib.loads((repo / "rust/Cargo.toml").read_text())["workspace"]["package"]["version"]
    if not VERSION.fullmatch(version):
        raise ValueError(f"rust/Cargo.toml has an invalid release version {version!r}")
    if tag != f"v{version}":
        raise ValueError(f"release {tag} does not match the Rust workspace version {version}")
    python = tomllib.loads((repo / "sdks/python/pyproject.toml").read_text())["project"]["version"]
    if python != version:
        raise ValueError(f"sdks/python is {python} but the release is {version}")
    return version


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tag", help="release tag, for example v0.3.0-alpha.1")
    args = parser.parse_args()
    try:
        print(release_version(args.tag))
    except (OSError, KeyError, ValueError) as error:
        sys.exit(f"release version: {error}")


if __name__ == "__main__":
    main()
