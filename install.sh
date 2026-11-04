#!/bin/sh
# Installs the SuperTag CLI from npm into its own directory, using the system's Node.js and npm.
# SuperTag runs the Claude Code and Codex CLIs you install yourself, so the copies the vendor SDKs
# bundle are removed after installing. `supertag init` checks for your harness CLIs.
set -eu

PACKAGE="${SUPERTAG_PACKAGE:-supertag-ai}"
# Release builds replace "latest" with their own version, so each release installs itself.
RELEASE_DEFAULT_VERSION="latest"
REQUESTED_VERSION="${SUPERTAG_VERSION:-$RELEASE_DEFAULT_VERSION}"
MINIMUM_NODE="22.13.0"

fail() {
  printf 'SuperTag installer: %s\n' "$1" >&2
  exit 1
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
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
