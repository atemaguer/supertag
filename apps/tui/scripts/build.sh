#!/bin/sh
# Compiles supertag-tui with Bun for one target, for trying and measuring it locally. The release
# build compiles the same entry with the same flags (scripts/native_archive.py).
#   build.sh [darwin-arm64|darwin-x64|linux-arm64|linux-x64] [extra bun build flags...]
# Only the target's OpenTUI native package is embedded; the others are marked external (they sit
# behind process.platform branches and are never reached). Output: $OUT (default
# /tmp/supertag-tui/dist)/supertag-tui-TARGET.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
bun=${BUN:-bun}
default_target=$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m | sed 's/x86_64/x64/; s/aarch64/arm64/')
target=${1:-$default_target}
[ $# -gt 0 ] && shift
out=${OUT:-/tmp/supertag-tui/dist}
version=${SUPERTAG_TUI_VERSION:-$(sed -n '/^\[workspace\.package\]/,/^\[/s/^version = "\(.*\)"$/\1/p' "$here/../../core/Cargo.toml")}
externals=""
for platform in darwin-x64 darwin-arm64 linux-x64 linux-arm64 linux-x64-musl linux-arm64-musl win32-x64 win32-arm64; do
  [ "$platform" = "$target" ] || externals="$externals --external @opentui/core-$platform"
done
mkdir -p "$out"
# A signed binary copied over in place can be killed by macOS; always write a fresh file.
rm -f "$out/supertag-tui-$target"
cd "$here"
# shellcheck disable=SC2086
"$bun" build --compile --minify --bytecode --format=esm --target="bun-$target" $externals "$@" \
  --define "process.env.SUPERTAG_TUI_VERSION=\"$version\"" \
  --outfile "$out/supertag-tui-$target" src/main.tsx
ls -l "$out/supertag-tui-$target"
