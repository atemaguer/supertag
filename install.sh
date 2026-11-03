#!/bin/sh

set -eu

REPOSITORY="${SUPERTAG_REPOSITORY:-atemaguer/supertag}"
REQUESTED_VERSION="${SUPERTAG_VERSION:-latest}"

fail() {
  printf 'SuperTag installer: %s\n' "$1" >&2
  exit 1
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

download() {
  source_url=$1
  destination=$2
  if command_exists curl; then
    curl --fail --location --silent --show-error "$source_url" --output "$destination"
    return
  fi
  if command_exists wget; then
    wget --quiet "$source_url" --output-document "$destination"
    return
  fi
  fail "curl or wget is required"
}

sha256() {
  if command_exists sha256sum; then
    sha256sum "$1" | awk '{print $1}'
    return
  fi
  if command_exists shasum; then
    shasum -a 256 "$1" | awk '{print $1}'
    return
  fi
  fail "sha256sum or shasum is required"
}

detect_os() {
  detected=${SUPERTAG_OS:-$(uname -s)}
  case "$detected" in
    Darwin | darwin) printf 'darwin\n' ;;
    Linux | linux) printf 'linux\n' ;;
    *) fail "unsupported operating system: $detected" ;;
  esac
}

detect_arch() {
  detected=${SUPERTAG_ARCH:-$(uname -m)}
  case "$detected" in
    arm64 | aarch64) printf 'arm64\n' ;;
    x86_64 | amd64 | x64) printf 'x64\n' ;;
    *) fail "unsupported CPU architecture: $detected" ;;
  esac
}

OS=$(detect_os)
ARCH=$(detect_arch)
ASSET="supertag-${OS}-${ARCH}.tar.gz"

if [ -n "${SUPERTAG_DOWNLOAD_ROOT:-}" ]; then
  DOWNLOAD_ROOT=${SUPERTAG_DOWNLOAD_ROOT%/}
elif [ "$REQUESTED_VERSION" = "latest" ]; then
  DOWNLOAD_ROOT="https://github.com/${REPOSITORY}/releases/latest/download"
else
  case "$REQUESTED_VERSION" in
    v*) RELEASE_TAG=$REQUESTED_VERSION ;;
    *) RELEASE_TAG="v${REQUESTED_VERSION}" ;;
  esac
  DOWNLOAD_ROOT="https://github.com/${REPOSITORY}/releases/download/${RELEASE_TAG}"
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

command_exists tar || fail "tar is required"

TEMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/supertag-install.XXXXXX")
cleanup() {
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT HUP INT TERM

ARCHIVE="$TEMP_DIR/$ASSET"
CHECKSUMS="$TEMP_DIR/checksums.txt"
download "$DOWNLOAD_ROOT/$ASSET" "$ARCHIVE"
download "$DOWNLOAD_ROOT/checksums.txt" "$CHECKSUMS"

EXPECTED_CHECKSUM=$(awk -v asset="$ASSET" '$2 == asset || $2 == "*" asset { print $1; exit }' "$CHECKSUMS")
[ -n "$EXPECTED_CHECKSUM" ] || fail "checksums.txt does not contain $ASSET"
ACTUAL_CHECKSUM=$(sha256 "$ARCHIVE")
[ "$ACTUAL_CHECKSUM" = "$EXPECTED_CHECKSUM" ] || fail "checksum verification failed for $ASSET"

EXTRACTED="$TEMP_DIR/extracted"
mkdir -p "$EXTRACTED"
tar -xzf "$ARCHIVE" -C "$EXTRACTED"
[ -x "$EXTRACTED/supertag/bin/supertag" ] || fail "release archive has no executable supertag command"
[ -f "$EXTRACTED/supertag/VERSION" ] || fail "release archive has no VERSION file"

RELEASE_VERSION=$(sed -n '1p' "$EXTRACTED/supertag/VERSION")
case "$RELEASE_VERSION" in
  '' | *[!0-9A-Za-z._+-]*) fail "release archive has an invalid version" ;;
esac

if [ "$REQUESTED_VERSION" != "latest" ]; then
  NORMALIZED_REQUESTED=${REQUESTED_VERSION#v}
  [ "$RELEASE_VERSION" = "$NORMALIZED_REQUESTED" ] ||
    fail "requested $NORMALIZED_REQUESTED but archive contains $RELEASE_VERSION"
fi

mkdir -p "$INSTALL_ROOT" "$BIN_DIR"
INSTALL_ROOT=$(CDPATH= cd -P -- "$INSTALL_ROOT" >/dev/null 2>&1 && pwd)
BIN_DIR=$(CDPATH= cd -P -- "$BIN_DIR" >/dev/null 2>&1 && pwd)
VERSIONS_DIR="$INSTALL_ROOT/versions"
TARGET="$VERSIONS_DIR/$RELEASE_VERSION"
STAGING="$VERSIONS_DIR/.${RELEASE_VERSION}.install.$$"
mkdir -p "$VERSIONS_DIR"

rm -rf "$STAGING"
mv "$EXTRACTED/supertag" "$STAGING"
if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
  rm -rf "$TARGET"
fi
mv "$STAGING" "$TARGET"

LINK_STAGING="$BIN_DIR/.supertag.install.$$"
rm -f "$LINK_STAGING"
ln -s "$TARGET/bin/supertag" "$LINK_STAGING"
mv -f "$LINK_STAGING" "$BIN_DIR/supertag"

INSTALLED_VERSION=$($BIN_DIR/supertag --version)
[ "$INSTALLED_VERSION" = "$RELEASE_VERSION" ] || fail "installed command failed its version check"

printf 'Installed SuperTag %s at %s\n' "$RELEASE_VERSION" "$BIN_DIR/supertag"
case ":${PATH:-}:" in
  *":$BIN_DIR:"*) ;;
  *) printf 'Add %s to PATH to run supertag from a new shell.\n' "$BIN_DIR" ;;
esac
