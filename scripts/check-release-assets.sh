#!/usr/bin/env bash
# Fails unless the published GitHub Release for tag $1 carries every native archive, SHA256SUMS,
# and install.sh, so an SDK is never published for a release users cannot install.
set -euo pipefail

release_tag=$1
# The archive names carry rust/Cargo.toml's version; refuse a tag that names another one.
version=$(python3 "$(dirname "$0")/../rust/scripts/release_version.py" "$release_tag")
assets=$(gh release view "$release_tag" --repo "${GITHUB_REPOSITORY:-atemaguer/supertag}" \
  --json isDraft,assets --jq 'if .isDraft then "draft" else .assets[].name end')
if [[ $assets == draft ]]; then
  printf '%s is still a draft; publish it first\n' "$release_tag" >&2
  exit 1
fi
missing=0
for name in install.sh SHA256SUMS \
  "supertag-$version-darwin-arm64-complete.tar.gz" "supertag-$version-darwin-amd64-complete.tar.gz" \
  "supertag-$version-linux-arm64-complete.tar.gz" "supertag-$version-linux-amd64-complete.tar.gz"; do
  if ! grep -Fxq -- "$name" <<<"$assets"; then
    printf '%s has no %s asset\n' "$release_tag" "$name" >&2
    missing=1
  fi
done
exit "$missing"
