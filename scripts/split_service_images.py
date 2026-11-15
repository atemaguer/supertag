# /// script
# requires-python = ">=3.13"
# dependencies = ["PyYAML==6.0.3"]
# ///
"""Build unpublished Linux Control Plane and Gateway images from a verified release."""

import argparse
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

from native_archive import ArchiveError, REPO, copy_bounded, digest, extract_archive, require
from release_archive import MAX_ARCHIVE_BYTES, extract_release


def build_images(archive, repository, tag=None, checksum=None, *, archive_format="complete"):
    with tempfile.TemporaryDirectory(prefix="supertag-service-images-") as temporary:
        root = Path(temporary)
        # Verify the entire selected archive before copying its CLI. Service
        # images deliberately do not contain harnesses, the TUI, or provider secrets.
        require(archive_format in ("complete", "cli-tui"), "unknown archive format")
        extractor = extract_release if archive_format == "complete" else extract_archive
        # The labels and extracted bytes must describe the same private input,
        # even if the caller replaces the original archive during a build.
        archive = Path(archive)
        staged = root / archive.name
        copy_bounded(archive, staged, MAX_ARCHIVE_BYTES)
        copy_bounded(Path(checksum) if checksum else Path(str(archive) + ".sha256"),
                     Path(str(staged) + ".sha256"), 1024)
        package = extractor(staged, root / "verified")
        manifest = json.loads((package / "manifest.json").read_text())
        platform = manifest["platform"]
        require(platform.startswith("linux-"), "service images require a Linux native archive")
        arch = platform.removeprefix("linux-")
        context = root / "context"
        context.mkdir()
        shutil.copyfile(package / "supertag", context / "supertag")
        dockerfile = REPO / "deploy/docker/rust-service.Dockerfile"
        version = manifest["version"]
        dirty = manifest["source"].get("dirty", False)
        archive_sha256 = digest(staged)
        tags = {}
        for service in ("control-plane", "gateway"):
            name = f"{repository}-{service}:{tag or version}"
            command = [
                "docker", "build", "--platform", f"linux/{arch}", "--file", dockerfile,
                "--target", service, "--tag", name,
                "--label", f"org.opencontainers.image.version={version}",
                "--label", f"org.opencontainers.image.title=SuperTag {service}",
                "--label", f"org.supertag.source.dirty={str(dirty).lower()}",
                "--label", f"org.supertag.archive.format={manifest['format']}",
                "--label", f"org.supertag.archive.sha256={archive_sha256}",
            ]
            if commit := manifest["source"]["commit"]:
                command.extend(["--label", f"org.opencontainers.image.revision={commit}"])
            subprocess.run([*command, context], check=True)
            installed = subprocess.check_output(
                ["docker", "run", "--rm", "--network", "none", "--entrypoint", "/usr/local/bin/supertag", name, "--version"],
                text=True, timeout=30,
            ).strip()
            require(installed == f"supertag {version}", f"{service} image version differs from the archive")
            tags[service] = name
    return tags


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--checksum", type=Path)
    parser.add_argument("--repository", default="supertag-native")
    parser.add_argument("--tag")
    parser.add_argument("--archive-format", choices=("complete", "cli-tui"), default="complete",
                        help="complete release (default), or the older CLI/TUI fixture archive")
    args = parser.parse_args()
    try:
        print(json.dumps(build_images(args.archive, args.repository, args.tag, args.checksum, archive_format=args.archive_format), sort_keys=True))
    except (ArchiveError, OSError, subprocess.SubprocessError) as error:
        parser.exit(1, f"Split service images: {error}\n")


if __name__ == "__main__":
    main()
