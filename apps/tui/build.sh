#!/bin/sh
# Cross-compiles static supertag-tui binaries into dist/.
set -eu
cd "$(dirname "$0")"
version=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' ../../packages/supertag-ai/package.json)
[ -n "$version" ] || { echo "No version in packages/supertag-ai/package.json" >&2; exit 1; }
mkdir -p dist
for platform in darwin/arm64 darwin/amd64 linux/arm64 linux/amd64; do
  goos=${platform%/*}
  goarch=${platform#*/}
  CGO_ENABLED=0 GOOS=$goos GOARCH=$goarch go build -trimpath \
    -ldflags "-s -w -X main.version=$version" \
    -o "dist/supertag-tui-$goos-$goarch" .
done
ls -l dist
