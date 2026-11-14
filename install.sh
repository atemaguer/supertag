#!/bin/sh
# Installs SuperTag's native release for macOS or Linux on arm64 or amd64: the supertag CLI, the
# supertag-tui terminal UI, the shared execution provider, and the Node.js bridges for Claude Code,
# Cursor, OpenCode, E2B, and Modal. The archive must match the release's SHA256SUMS before it is
# unpacked, and the CLI and terminal UI must report the release's version before the command is
# linked. The installer never starts services or reads SuperTag state.
set -eu
umask 022

REPOSITORY="atemaguer/supertag"
# Release builds replace "latest" with their own version, so each release installs itself.
RELEASE_DEFAULT_VERSION="latest"
REQUESTED_VERSION="${SUPERTAG_VERSION:-$RELEASE_DEFAULT_VERSION}"
RECEIPT=".supertag-install.json"

fail() {
  printf 'SuperTag installer: %s\n' "$1" >&2
  exit 1
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

# Prints the SHA-256 digest of file $1.
sha256_of() {
  if command_exists shasum; then
    shasum -a 256 "$1" | awk '{ print $1 }'
  elif command_exists sha256sum; then
    sha256sum "$1" | awk '{ print $1 }'
  else
    fail "shasum or sha256sum is required to verify the download"
  fi
}

# Downloads URL $1 to file $2. Only https: and, for testing a local build, file: URLs are allowed.
download() {
  case "$1" in
    https://*) protocols='=https' ;;
    file://*) protocols='=file' ;;
    *) fail "unsupported download URL $1" ;;
  esac
  if command_exists curl; then
    curl --proto "$protocols" --proto-redir '=https' --tlsv1.2 -fsSL --retry 3 -o "$2" "$1"
  elif command_exists wget && [ "$protocols" = '=https' ]; then
    wget --https-only -q -O "$2" "$1"
  else
    fail "curl is required to download SuperTag"
  fi
}

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "SuperTag supports macOS and Linux; this is $(uname -s)" ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=amd64 ;;
  *) fail "SuperTag supports arm64 and amd64; this is $(uname -m)" ;;
esac
# A shell running under Rosetta reports x86_64 on Apple silicon; install the native build.
if [ "$os" = darwin ] && [ "$arch" = amd64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
  arch=arm64
fi
PLATFORM="$os-$arch"

case "$REQUESTED_VERSION" in
  latest) VERSION= ;;
  v*) VERSION=${REQUESTED_VERSION#v} ;;
  *) VERSION=$REQUESTED_VERSION ;;
esac
case "$VERSION" in
  *[!0-9A-Za-z.+-]*) fail "invalid version $REQUESTED_VERSION" ;;
esac
# A directory holding release assets, for testing a build before it is published.
if [ -n "${SUPERTAG_DOWNLOAD_URL:-}" ]; then
  BASE_URL=${SUPERTAG_DOWNLOAD_URL%/}
elif [ -z "$VERSION" ]; then
  BASE_URL="https://github.com/$REPOSITORY/releases/latest/download"
else
  BASE_URL="https://github.com/$REPOSITORY/releases/download/v$VERSION"
fi

if [ -n "${SUPERTAG_INSTALL_ROOT:-}" ]; then
  INSTALL_ROOT=$SUPERTAG_INSTALL_ROOT
elif [ -n "${XDG_DATA_HOME:-}" ]; then
  INSTALL_ROOT="${XDG_DATA_HOME}/supertag"
else
  INSTALL_ROOT="${HOME:?HOME is required}/.local/share/supertag"
fi
if [ -n "${SUPERTAG_BIN_DIR:-}" ]; then
  BIN_DIR=$SUPERTAG_BIN_DIR
elif [ -n "${XDG_BIN_HOME:-}" ]; then
  BIN_DIR=$XDG_BIN_HOME
else
  BIN_DIR="${HOME:?HOME is required}/.local/bin"
fi

mkdir -p "$INSTALL_ROOT/versions" "$BIN_DIR"
INSTALL_ROOT=$(CDPATH='' cd -P -- "$INSTALL_ROOT" >/dev/null 2>&1 && pwd)
BIN_DIR=$(CDPATH='' cd -P -- "$BIN_DIR" >/dev/null 2>&1 && pwd)
if [ -e "$BIN_DIR/supertag" ] && [ ! -L "$BIN_DIR/supertag" ]; then
  fail "$BIN_DIR/supertag was not installed by this script; remove it or set SUPERTAG_BIN_DIR"
fi
STAGING="$INSTALL_ROOT/versions/.install.$$"
cleanup() {
  rm -rf "$STAGING"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
rm -rf "$STAGING"
mkdir -p "$STAGING/download" "$STAGING/unpacked"

printf 'Downloading SuperTag for %s from %s...\n' "$PLATFORM" "$BASE_URL"
download "$BASE_URL/SHA256SUMS" "$STAGING/download/SHA256SUMS" ||
  fail "could not download SHA256SUMS from $BASE_URL"
# Each line is "<sha256>  supertag-<version>-<platform>-complete.tar.gz".
line=$(awk -v platform="$PLATFORM" -v version="$VERSION" '
  {
    name = $2; sub(/^\*/, "", name)
    suffix = "-" platform "-complete.tar.gz"
    if (NF != 2 || $1 !~ /^[0-9a-f]+$/ || length($1) != 64 || index(name, "supertag-") != 1) next
    if (length(name) <= length(suffix) + 9) next
    if (substr(name, length(name) - length(suffix) + 1) != suffix) next
    found = substr(name, 10, length(name) - length(suffix) - 9)
    if (version == "" || found == version) { print $1, found; exit }
  }' "$STAGING/download/SHA256SUMS")
[ -n "$line" ] || fail "the release at $BASE_URL has no ${VERSION:+$VERSION }build for $PLATFORM"
EXPECTED=${line%% *}
VERSION=${line#* }
case "$VERSION" in
  '' | *[!0-9A-Za-z.+-]*) fail "the release lists an invalid version" ;;
esac
ROOT_NAME="supertag-$VERSION-$PLATFORM-complete"
ARCHIVE="$STAGING/download/$ROOT_NAME.tar.gz"
download "$BASE_URL/$ROOT_NAME.tar.gz" "$ARCHIVE" || fail "could not download $ROOT_NAME.tar.gz"
ACTUAL=$(sha256_of "$ARCHIVE")
[ "$ACTUAL" = "$EXPECTED" ] || fail "$ROOT_NAME.tar.gz did not match its SHA256SUMS checksum"

# Every entry stays inside the release's root directory.
tar -tzf "$ARCHIVE" > "$STAGING/download/entries" || fail "$ROOT_NAME.tar.gz is not a readable archive"
awk -v root="$ROOT_NAME" '
  $0 != root && $0 != root "/" && index($0, root "/") != 1 { bad = 1 }
  $0 ~ /(^|\/)\.\.(\/|$)/ { bad = 1 }
  END { exit bad }' "$STAGING/download/entries" || fail "$ROOT_NAME.tar.gz has an entry outside $ROOT_NAME"
tar -xzf "$ARCHIVE" -C "$STAGING/unpacked" || fail "could not unpack $ROOT_NAME.tar.gz"
PACKAGE="$STAGING/unpacked/$ROOT_NAME"
[ -f "$PACKAGE/manifest.json" ] && [ -x "$PACKAGE/supertag" ] && [ -x "$PACKAGE/supertag-tui" ] ||
  fail "$ROOT_NAME.tar.gz is not a complete SuperTag release"
# macOS applies the umask to symbolic links; the release records them as 0777, as Linux creates them.
if [ "$os" = darwin ]; then
  find "$PACKAGE" -type l -exec chmod -h 777 {} +
fi

cli_version=$("$PACKAGE/supertag" --version 2>/dev/null || true)
[ "$cli_version" = "supertag $VERSION" ] || fail "the supertag binary reports ${cli_version:-no version}, not $VERSION"
tui_version=$("$PACKAGE/supertag-tui" --version 2>/dev/null || true)
[ "$tui_version" = "$VERSION" ] || fail "the supertag-tui binary reports ${tui_version:-no version}, not $VERSION"

# The layout and receipt of rust/scripts/install_native_release.py, so either can replace the other.
commit=$(grep -o '"commit"[[:space:]]*:[[:space:]]*"[0-9a-f]\{40\}"' "$PACKAGE/manifest.json" |
  head -n 1 | sed 's/.*"\([0-9a-f]\{40\}\)"$/\1/')
[ -n "$commit" ] || fail "the release manifest names no source commit"
printf '{"archive_sha256": "%s", "format": "supertag-native-install-v1", "source_commit": "%s"}\n' \
  "$ACTUAL" "$commit" > "$PACKAGE/$RECEIPT"
chmod 600 "$PACKAGE/$RECEIPT"

# The directory name carries the archive digest, so an installed directory with a receipt already
# holds this exact release; reinstalling it leaves it in place for any running services.
TARGET="$INSTALL_ROOT/versions/native-$VERSION-$PLATFORM-release-$ACTUAL"
if [ ! -f "$TARGET/$RECEIPT" ] || [ ! -x "$TARGET/supertag" ]; then
  # A directory without a receipt is incomplete; move it aside before replacing it.
  if [ -e "$TARGET" ]; then
    mv "$TARGET" "$STAGING/replaced"
  fi
  mv "$PACKAGE" "$TARGET"
fi

LINK_STAGING="$BIN_DIR/.supertag.install.$$"
rm -f "$LINK_STAGING"
ln -s "$TARGET/supertag" "$LINK_STAGING"
mv -f "$LINK_STAGING" "$BIN_DIR/supertag"

INSTALLED_VERSION=$("$BIN_DIR/supertag" --version)
[ "$INSTALLED_VERSION" = "supertag $VERSION" ] || fail "the installed command failed its version check"

printf 'Installed SuperTag %s at %s\n' "$VERSION" "$BIN_DIR/supertag"
case ":${PATH:-}:" in
  *":$BIN_DIR:"*) ;;
  *) printf 'Add %s to PATH to run supertag from a new shell.\n' "$BIN_DIR" ;;
esac
node_version=$(node --version 2>/dev/null || true)
case "$node_version" in
  v22.1[3-9].* | v22.[2-9][0-9].*) ;;
  *)
    printf 'Claude Code, Cursor, OpenCode, E2B, and Modal need Node.js 22.13 or a later 22.x on PATH%s.\n' \
      "${node_version:+; this is $node_version}"
    ;;
esac
printf 'Next: install Claude Code, Codex, Cursor, or OpenCode, then run supertag init in a repository.\n'
