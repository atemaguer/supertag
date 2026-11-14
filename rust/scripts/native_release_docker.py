# /// script
# requires-python = ">=3.13"
# dependencies = ["PyYAML==6.0.3"]
# ///
"""Assemble and test a complete Linux release in disposable Debian 12 containers.

Accepts a clean exact source HEAD. Nothing is uploaded, installed on the host, or
published. Docker may emulate the selected architecture; the binaries and all
runtime helpers are executed under that architecture before output is accepted.
"""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import uuid

from native_archive import ArchiveError, REPO, digest, require
from release_archive import validate_release


def verify_source(repo, commit):
    require(re.fullmatch(r"[a-f0-9]{40}", commit), "provide the full expected source commit")
    require(subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip() == commit,
            "source HEAD differs from the expected commit")
    require(not subprocess.check_output(["git", "status", "--porcelain", "--untracked-files=no"], cwd=repo),
            "source has tracked changes")


def package(repo, commit, output, platform, profile="release"):
    require(platform in ("linux-amd64", "linux-arm64"), "Docker release platform must be Linux amd64 or arm64")
    require(profile in ("dev", "release"), "unknown release profile")
    verify_source(repo, commit)
    output = output.resolve()
    require(not output.exists(), "release output directory already exists")
    output.mkdir(mode=0o700, parents=True)
    identifier = "supertag-release-" + uuid.uuid4().hex[:12]
    target = "linux/" + platform.removeprefix("linux-")
    with tempfile.TemporaryDirectory(prefix=identifier + "-") as temporary:
        root = Path(temporary)
        bundle = root / "source.bundle"
        subprocess.run(["git", "bundle", "create", bundle, "HEAD"], cwd=repo, check=True)
        context = root / "context"
        context.mkdir()
        for source, name in ((REPO / "deploy/docker/rust-release.Dockerfile", "Dockerfile"),
                             (REPO / "rust/scripts/native_release_container.sh", "native_release_container.sh")):
            shutil.copyfile(source, context / name)
        image = "supertag-native-release-builder:" + platform + "-" + digest(context / "Dockerfile")[:12]
        subprocess.run(["docker", "build", "--platform", target, "--tag", image, context], check=True)
        image_id = subprocess.check_output(["docker", "image", "inspect", "--format", "{{.Id}}", image], text=True).strip()
        try:
            subprocess.run(["docker", "run", "--rm", "--init", "--name", identifier,
                "--platform", target, "--cpus", "2", "--memory", "6g",
                "--label", f"org.supertag.release-rehearsal={identifier}",
                "--user", f"{os.getuid()}:{os.getgid()}",
                "--mount", f"type=bind,src={bundle},dst=/input/source.bundle,readonly",
                "--mount", f"type=bind,src={output},dst=/output",
                "--env", f"SUPERTAG_BUILD_COMMIT={commit}", "--env", f"SUPERTAG_BUILD_PLATFORM={platform}",
                "--env", f"SUPERTAG_BUILD_PROFILE={profile}", image_id], check=True)
        finally:
            owned = subprocess.check_output(["docker", "ps", "--all", "--quiet", "--filter",
                f"label=org.supertag.release-rehearsal={identifier}"], text=True, timeout=30).split()
            if owned:
                subprocess.run(["docker", "rm", "--force", *owned], stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, timeout=30, check=True)
        archives = list(output.glob("*.tar.gz"))
        require(len(archives) == 1, "builder did not return exactly one complete archive")
        archive = archives[0]
        manifest = validate_release(archive)
        require(manifest["source"]["commit"] == commit and manifest["platform"] == platform
                and manifest["profile"] == profile, "builder output source/platform/profile differs")
        for suffix in (".build.json", ".smoke.json", ".install-smoke.json"):
            receipt = json.loads(Path(str(archive) + suffix).read_text())
            require(receipt["archive_sha256"] == digest(archive), "builder receipt archive digest differs")
        Path(str(archive) + ".builder.json").write_text(json.dumps({
            "format": "supertag-native-container-build-v1", "source_commit": commit,
            "source_bundle_sha256": digest(bundle), "archive_sha256": digest(archive), "platform": platform,
            "builder_image": image, "builder_image_id": image_id,
            "dockerfile_sha256": digest(context / "Dockerfile"),
            "entrypoint_sha256": digest(context / "native_release_container.sh"),
            "published": False}, indent=2, sort_keys=True) + "\n")
    return archive


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=REPO)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--platform", choices=("linux-amd64", "linux-arm64"), required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--profile", choices=("dev", "release"), default="release")
    args = parser.parse_args()
    try:
        print(package(args.repo.resolve(), args.commit, args.output, args.platform, args.profile))
    except (ArchiveError, OSError, ValueError, subprocess.SubprocessError) as error:
        parser.exit(1, f"container release: {error}\n")


if __name__ == "__main__":
    main()
