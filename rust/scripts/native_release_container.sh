#!/bin/sh
# Run as the caller's UID, with input read-only and only /output persisted.
set -eu
umask 077
scratch=$(mktemp -d /tmp/supertag-release-container.XXXXXX)
trap 'rm -rf "$scratch"' EXIT
export HOME="$scratch/home"
mkdir -m 700 "$HOME"
export TMPDIR="$scratch"
git init --quiet "$scratch/repo"
git -C "$scratch/repo" fetch --quiet /input/source.bundle HEAD
git -C "$scratch/repo" checkout --quiet --detach FETCH_HEAD
# Python must have the target architecture; the package command verifies it and
# Node/Rust before compiling. The fixture is built separately from shipped code.
python "$scratch/repo/rust/scripts/native_release.py" package \
  --repo "$scratch/repo" --commit "$SUPERTAG_BUILD_COMMIT" \
  --expect-platform "$SUPERTAG_BUILD_PLATFORM" --profile "$SUPERTAG_BUILD_PROFILE" \
  --output /output --install-smoke
