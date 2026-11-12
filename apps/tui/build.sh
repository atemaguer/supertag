#!/bin/sh
# Cross-compiles static supertag-tui binaries into dist/.
set -eu
cd "$(dirname "$0")"
version=${SUPERTAG_TUI_VERSION:-$(sed -n '/^\[workspace\.package\]/,/^\[/s/^version = "\(.*\)"$/\1/p' ../../rust/Cargo.toml)}
[ -n "$version" ] || { echo "No workspace package version in rust/Cargo.toml" >&2; exit 1; }
mkdir -p dist
for platform in darwin/arm64 darwin/amd64 linux/arm64 linux/amd64; do
  goos=${platform%/*}
  goarch=${platform#*/}
  CGO_ENABLED=0 GOOS=$goos GOARCH=$goarch GOWORK=off go build -mod=readonly -trimpath \
    -ldflags "-s -w -X main.version=$version" \
    -o "dist/supertag-tui-$goos-$goarch" .
done
ls -l dist
