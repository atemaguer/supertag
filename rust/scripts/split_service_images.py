"""Build local Linux Control Plane and Gateway images from a verified native archive."""

import argparse
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

from native_archive import ArchiveError, REPO, extract_archive, require


def build_images(archive, repository, tag=None, checksum=None):
    with tempfile.TemporaryDirectory(prefix="supertag-service-images-") as temporary:
        root = Path(temporary)
        # The extractor checks the checksum and the native binary in a private copy.
        package = extract_archive(archive, root / "verified", checksum)
        manifest = json.loads((package / "manifest.json").read_text())
        platform = manifest["platform"]
        require(platform.startswith("linux-"), "service images require a Linux native archive")
        arch = platform.removeprefix("linux-")
        context = root / "context"
        context.mkdir()
        shutil.copyfile(package / "supertag", context / "supertag")
        dockerfile = REPO / "deploy/docker/rust-service.Dockerfile"
        version = manifest["version"]
        tags = {}
        for service in ("control-plane", "gateway"):
            name = f"{repository}-{service}:{tag or version}"
            command = [
                "docker", "build", "--platform", f"linux/{arch}", "--file", dockerfile,
                "--target", service, "--tag", name,
                "--label", f"org.opencontainers.image.version={version}",
                "--label", f"org.opencontainers.image.title=SuperTag {service}",
                "--label", f"org.supertag.source.dirty={str(manifest['source']['dirty']).lower()}",
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
    args = parser.parse_args()
    try:
        print(json.dumps(build_images(args.archive, args.repository, args.tag, args.checksum), sort_keys=True))
    except (ArchiveError, OSError, subprocess.SubprocessError) as error:
        parser.exit(1, f"Split service images: {error}\n")


if __name__ == "__main__":
    main()
