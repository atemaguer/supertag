#!/bin/sh
# Stage the public installer and matching TUI binaries in the npm package.
set -eu
cd "$(dirname "$0")/.."

package=packages/supertag-ai
version=$(node -p 'require("./packages/supertag-ai/package.json").version')
sed "s/^RELEASE_DEFAULT_VERSION=\"latest\"$/RELEASE_DEFAULT_VERSION=\"$version\"/" install.sh > "$package/install.sh"
sh -n "$package/install.sh"

mkdir -p "$package/tui"
for platform in darwin-arm64 darwin-amd64 linux-arm64 linux-amd64; do
  name=supertag-tui-$platform
  install -m 755 "apps/tui/dist/$name" "$package/tui/$name"
done
cd "$package/tui"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum supertag-tui-* > SHA256SUMS
else
  shasum -a 256 supertag-tui-* > SHA256SUMS
fi
