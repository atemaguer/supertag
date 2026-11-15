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
# A mounted Cargo cache, when the caller supplies one, holds only Cargo's registry and target.
set -- --output /output --install-smoke
if [ -n "${SUPERTAG_BUILD_CARGO_CACHE:-}" ]; then
  set -- "$@" --cargo-cache "$SUPERTAG_BUILD_CARGO_CACHE"
fi
python "$scratch/repo/scripts/native_release.py" package \
  --repo "$scratch/repo" --commit "$SUPERTAG_BUILD_COMMIT" \
  --expect-platform "$SUPERTAG_BUILD_PLATFORM" --profile "$SUPERTAG_BUILD_PROFILE" "$@"
