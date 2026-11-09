#!/bin/sh
# Installs the SuperTag CLI from npm into its own directory, using the system's Node.js and npm,
# plus the release's checksum-verified terminal UI binary on macOS and Linux. SuperTag runs the Claude Code and Codex CLIs you install yourself, so the copies the vendor SDKs
# bundle are removed after installing. `supertag init` checks for your harness CLIs.
set -eu

PACKAGE="${SUPERTAG_PACKAGE:-supertag-ai}"
# Release builds replace "latest" with their own version, so each release installs itself.
RELEASE_DEFAULT_VERSION="latest"
REQUESTED_VERSION="${SUPERTAG_VERSION:-$RELEASE_DEFAULT_VERSION}"
MINIMUM_NODE="22.13.0"
RELEASE_DOWNLOADS="https://github.com/atemaguer/supertag/releases/download"

fail() {
  printf 'SuperTag installer: %s\n' "$1" >&2
  exit 1
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

# Fetches URL $1 to file $2 with curl or wget.
download() {
  if command_exists curl; then
    curl -fsL -o "$2" "$1"
  elif command_exists wget; then
    wget -q -O "$2" "$1"
  else
    return 2
  fi
}

# Prints the SHA-256 digest of file $1.
sha256_of() {
  if command_exists shasum; then
    shasum -a 256 "$1" | awk '{ print $1 }'
  elif command_exists sha256sum; then
    sha256sum "$1" | awk '{ print $1 }'
  else
    return 2
  fi
}

tui_skipped() {
  printf 'The terminal UI was not installed: %s. The CLI works without it.\n' "$1" >&2
}

# Places the release's verified terminal UI binary in package directory $1 for version $2.
# A failure here leaves the CLI installed without the terminal UI.
install_tui() {
  platform=$(node -p 'process.platform + "-" + process.arch')
  case "$platform" in
    darwin-arm64 | darwin-x64 | linux-arm64 | linux-x64) ;;
    *)
      tui_skipped "no build exists for $platform"
      return 0
      ;;
  esac
  name="supertag-tui-$(printf '%s' "$platform" | sed 's/x64$/amd64/')"
  downloads="$1/.tui-download"
  rm -rf "$downloads"
  mkdir -p "$downloads"
  if [ -n "${SUPERTAG_TUI_SOURCE:-}" ]; then
    if ! cp "$SUPERTAG_TUI_SOURCE/$name" "$SUPERTAG_TUI_SOURCE/SHA256SUMS" "$downloads/" 2>/dev/null; then
      rm -rf "$downloads"
      tui_skipped "$SUPERTAG_TUI_SOURCE has no $name and SHA256SUMS"
      return 0
    fi
  else
    if ! command_exists curl && ! command_exists wget; then
      rm -rf "$downloads"
      tui_skipped "neither curl nor wget is available to download it"
      return 0
    fi
    for file in "$name" SHA256SUMS; do
      if ! download "$RELEASE_DOWNLOADS/v$2/$file" "$downloads/$file"; then
        rm -rf "$downloads"
        tui_skipped "could not download $file for release v$2"
        return 0
      fi
    done
  fi
  expected=$(awk -v file="$name" '$2 == file || $2 == "*" file { print $1; exit }' "$downloads/SHA256SUMS")
  if ! actual=$(sha256_of "$downloads/$name"); then
    rm -rf "$downloads"
    tui_skipped "neither shasum nor sha256sum is available to verify it"
    return 0
  fi
  if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
    rm -rf "$downloads"
    tui_skipped "$name did not match its SHA256SUMS checksum"
    return 0
  fi
  chmod 755 "$downloads/$name"
  tui_version=$("$downloads/$name" --version 2>/dev/null || true)
  if [ "$tui_version" != "$2" ]; then
    rm -rf "$downloads"
    tui_skipped "$name reports version ${tui_version:-none}, not $2"
    return 0
  fi
  mkdir -p "$1/tui"
  mv -f "$downloads/$name" "$1/tui/$name"
  rm -rf "$downloads"
}

# Succeeds when version $1 is at least $2, both major.minor.patch.
version_at_least() {
  awk -v have="$1" -v need="$2" 'BEGIN {
    split(have, h, "."); split(need, n, ".");
    for (i = 1; i <= 3; i++) { if (h[i] + 0 > n[i] + 0) exit 0; if (h[i] + 0 < n[i] + 0) exit 1 }
    exit 0
  }'
}

command_exists node || fail "Node.js $MINIMUM_NODE or newer is required: install it from https://nodejs.org, then run this again"
command_exists npm || fail "npm is required; it comes with Node.js"
NODE_VERSION=$(node --version | sed 's/^v//')
version_at_least "$NODE_VERSION" "$MINIMUM_NODE" ||
  fail "Node.js $NODE_VERSION is older than $MINIMUM_NODE; upgrade it from https://nodejs.org, then run this again"

case "$REQUESTED_VERSION" in
  latest) SPEC="$PACKAGE@latest" ;;
  v*) SPEC="$PACKAGE@${REQUESTED_VERSION#v}" ;;
  *) SPEC="$PACKAGE@$REQUESTED_VERSION" ;;
esac
# A local tarball or directory, for testing a build before it is published.
[ -n "${SUPERTAG_PACKAGE_SOURCE:-}" ] && SPEC=$SUPERTAG_PACKAGE_SOURCE

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
INSTALL_ROOT=$(CDPATH= cd -P -- "$INSTALL_ROOT" >/dev/null 2>&1 && pwd)
BIN_DIR=$(CDPATH= cd -P -- "$BIN_DIR" >/dev/null 2>&1 && pwd)
STAGING="$INSTALL_ROOT/versions/.install.$$"
cleanup() {
  rm -rf "$STAGING"
}
trap cleanup EXIT HUP INT TERM

printf 'Installing %s with npm...\n' "$SPEC"
mkdir -p "$STAGING"
printf '{"private":true}\n' > "$STAGING/package.json"
npm install --prefix "$STAGING" --omit=dev --no-audit --no-fund --no-save --loglevel=error "$SPEC" >&2 ||
  fail "npm could not install $SPEC"

# The SDKs ship platform copies of the Claude Code and Codex CLIs; SuperTag runs yours instead.
find "$STAGING/node_modules" -type d \( \
  -path '*/@openai/codex-darwin-*' -o -path '*/@openai/codex-linux-*' -o -path '*/@openai/codex-win32-*' -o \
  -path '*/@anthropic-ai/claude-agent-sdk-darwin-*' -o -path '*/@anthropic-ai/claude-agent-sdk-linux-*' -o \
  -path '*/@anthropic-ai/claude-agent-sdk-win32-*' \) -prune -exec rm -rf {} +

MANIFEST="$STAGING/node_modules/$PACKAGE/package.json"
[ -f "$MANIFEST" ] || fail "npm installed no $PACKAGE package"
RELEASE_VERSION=$(node -p "require(process.argv[1]).version" "$MANIFEST")
case "$RELEASE_VERSION" in
  '' | *[!0-9A-Za-z._+-]*) fail "the installed package has an invalid version" ;;
esac
[ -x "$STAGING/node_modules/.bin/supertag" ] || fail "the installed package has no supertag command"

install_tui "$STAGING/node_modules/$PACKAGE" "$RELEASE_VERSION"

TARGET="$INSTALL_ROOT/versions/$RELEASE_VERSION"
rm -rf "$TARGET"
mv "$STAGING" "$TARGET"

LINK_STAGING="$BIN_DIR/.supertag.install.$$"
rm -f "$LINK_STAGING"
ln -s "$TARGET/node_modules/.bin/supertag" "$LINK_STAGING"
mv -f "$LINK_STAGING" "$BIN_DIR/supertag"

INSTALLED_VERSION=$("$BIN_DIR/supertag" --version)
[ "$INSTALLED_VERSION" = "$RELEASE_VERSION" ] || fail "the installed command failed its version check"

printf 'Installed SuperTag %s at %s\n' "$RELEASE_VERSION" "$BIN_DIR/supertag"
case ":${PATH:-}:" in
  *":$BIN_DIR:"*) ;;
  *) printf 'Add %s to PATH to run supertag from a new shell.\n' "$BIN_DIR" ;;
esac
printf 'Next: install Claude Code, Codex, Cursor, or OpenCode, then run supertag init in a repository.\n'
