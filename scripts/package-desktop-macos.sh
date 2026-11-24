#!/bin/bash
# Put the supertag CLI inside the desktop app, sign it, and build, sign, and notarize its disk image.
#
#   package-desktop-macos.sh APP CLI_DIRECTORY IMAGE [ZIP]
#
# APP is the unsigned SuperTag.app from `pnpm --filter @supertag/desktop package:mac`
# (apps/desktop/release/mac-arm64/SuperTag.app, or release/mac/SuperTag.app with --x64 for Intel),
# its fuses already flipped. CLI_DIRECTORY is an extracted complete release archive for the same
# architecture: supertag, supertag-shared-execution, node-bridges/, and supertag-tui when
# the release ships it (SHIP_TUI in scripts/native_archive.py).
# The CLI goes to SuperTag.app/Contents/Resources/supertag/, where the app looks for it first.
# IMAGE is the disk image to write: a drag-to-install volume that holds SuperTag.app, a symbolic
# link named Applications to /Applications, and the .DS_Store from scripts/dmg_layout.py that makes
# Finder show the two side by side. ZIP, when given, is the signed app zipped for the app's own
# updates: Squirrel.Mac installs an update from a zip of the app, not from a disk image, and checks
# its signature against the running app's. It is written last, from the app the image holds, and
# holds only the app.
#
# With SIGNED=true it needs IDENTITY (a "Developer ID Application: ..." name), APPLE_DEVELOPER_ID_P12,
# APPLE_DEVELOPER_ID_P12_PASSWORD, NOTARY_KEY_PATH, APPLE_NOTARY_KEY_ID and APPLE_NOTARY_ISSUER_ID.
# Without it, the app keeps electron-builder's ad-hoc signature, which is only good for local checks.
set -euo pipefail

app=${1:?Usage: package-desktop-macos.sh APP CLI_DIRECTORY IMAGE [ZIP]}
cli=${2:?Usage: package-desktop-macos.sh APP CLI_DIRECTORY IMAGE [ZIP]}
image=${3:?Usage: package-desktop-macos.sh APP CLI_DIRECTORY IMAGE [ZIP]}
zip=${4:-}
signed=${SIGNED:-false}

binaries=(supertag supertag-shared-execution)
[[ -e "$cli/supertag-tui" ]] && binaries+=(supertag-tui)
for name in "${binaries[@]}"; do
  [[ -f "$cli/$name" && -x "$cli/$name" ]] || { echo "$cli has no executable $name" >&2; exit 1; }
done
[[ -f "$cli/node-bridges/manifest.json" ]] || { echo "$cli has no node-bridges/manifest.json" >&2; exit 1; }
[[ -d "$app/Contents/MacOS" ]] || { echo "$app is not an app bundle" >&2; exit 1; }
# An Intel app must carry the Intel archive, and an Apple silicon app the Apple silicon one.
app_arch=$(lipo -archs "$app/Contents/MacOS/SuperTag")
for name in "${binaries[@]}"; do
  cli_arch=$(lipo -archs "$cli/$name")
  [[ "$cli_arch" == "$app_arch" ]] ||
    { echo "$cli/$name is built for $cli_arch, but the app for $app_arch" >&2; exit 1; }
done

resources="$app/Contents/Resources/supertag"
rm -rf "$resources"
mkdir -p "$resources"
# ditto keeps the modes, extended attributes and signatures of the CLI's files.
ditto "$cli" "$resources"

# Every Mach-O inside the bridges: Cursor's cursorsandbox and rg, and native Node modules.
machos=()
while IFS= read -r -d '' path; do
  if file -b "$path" | grep -q 'Mach-O'; then
    machos+=("$path")
  fi
done < <(find "$resources/node-bridges" -type f \( -perm -u+x -o -name '*.node' -o -name '*.dylib' \) -print0)
echo "Found ${#machos[@]} executables in the Node bridges."

layout="$(dirname "$0")/dmg_layout.py"

# Stage the volume's contents, write them to a read-write image, then compress it into IMAGE.
# The volume holds a copy of the app (ditto keeps its symlinks, extended attributes and signature),
# the Applications link to drag it onto, and the window layout. dmg_layout.py writes the layout as
# a .DS_Store file, so nothing has to script Finder, which a release runner cannot rely on.
# `hdiutil create -srcfolder` straight to a compressed format leaves unused space in the file: for
# this app, a 293 MB image held 78 MB of compressed data. Converting a finished image writes only
# the compressed data.
create_image() {
  local scratch
  scratch=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/supertag-app-image.XXXXXXXX")
  mkdir "$scratch/volume"
  ditto "$app" "$scratch/volume/SuperTag.app"
  ln -s /Applications "$scratch/volume/Applications"
  python3 "$layout" write "$scratch/volume"
  python3 "$layout" check "$scratch/volume"
  hdiutil create -quiet -volname SuperTag -srcfolder "$scratch/volume" -format UDRW "$scratch/SuperTag.dmg"
  rm -f "$image"
  hdiutil convert -quiet "$scratch/SuperTag.dmg" -format ULMO -o "$image"
  rm -rf "$scratch"
}

# Mount IMAGE read-only where Finder does not show it, and run the given command on the mount point.
# It always unmounts, and returns the command's status.
with_mounted_image() {
  local mount status=0
  mount=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/supertag-app-mount.XXXXXXXX")
  hdiutil attach -quiet -readonly -nobrowse -noautoopen -mountpoint "$mount" "$image" ||
    { rmdir "$mount"; return 1; }
  "$@" "$mount" || status=$?
  hdiutil detach -quiet "$mount" || hdiutil detach -quiet -force "$mount"
  rmdir "$mount"
  return "$status"
}

# The finished image holds exactly the app, the Applications link to /Applications, and the layout.
check_image() {
  with_mounted_image python3 "$layout" check ||
    { echo "$image is not a drag-to-install image" >&2; exit 1; }
}

# The update zip, as electron-builder's zip target makes it: ditto keeps the bundle's symlinks,
# extended attributes and signature.
create_zip() {
  [[ -n "$zip" ]] || return 0
  rm -f "$zip"
  ditto -c -k --sequesterRsrc --keepParent "$app" "$zip"
}

if [[ "$signed" != true ]]; then
  echo "SIGNED is not true: leaving the app unsigned for a local check."
  create_image
  check_image
  create_zip
  exit 0
fi

: "${IDENTITY:?}" "${APPLE_DEVELOPER_ID_P12:?}" "${APPLE_DEVELOPER_ID_P12_PASSWORD:?}"
: "${NOTARY_KEY_PATH:?}" "${APPLE_NOTARY_KEY_ID:?}" "${APPLE_NOTARY_ISSUER_ID:?}"
umask 077
work=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/supertag-app-signing.XXXXXXXX")
keychain="$work/signing.keychain-db"
password=$(openssl rand -hex 32)
original_keychains=()
while IFS= read -r line; do
  line=${line#"${line%%[![:space:]]*}"}
  line=${line#\"}
  original_keychains+=("${line%\"}")
done < <(security list-keychains -d user)
cleanup() {
  security list-keychains -d user -s ${original_keychains[@]+"${original_keychains[@]}"} || true
  security delete-keychain "$keychain" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT
printf '%s' "$APPLE_DEVELOPER_ID_P12" | base64 -D > "$work/signing.p12"
security create-keychain -p "$password" "$keychain"
# A new keychain locks after five idle minutes, and building the disk image can take that long;
# codesign then waits for a password prompt nobody can answer. Turn the lock off.
security set-keychain-settings "$keychain"
security unlock-keychain -p "$password" "$keychain"
security import "$work/signing.p12" -k "$keychain" -f pkcs12 -P "$APPLE_DEVELOPER_ID_P12_PASSWORD" \
  -T /usr/bin/codesign
rm -f "$work/signing.p12"
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$password" "$keychain" > /dev/null
security list-keychains -d user -s "$keychain" ${original_keychains[@]+"${original_keychains[@]}"}

sign() {
  codesign --force --timestamp --options runtime --keychain "$keychain" --sign "$IDENTITY" "$@"
}

# Claude Code's executable embeds a JavaScript engine and needs these under the hardened runtime,
# as Anthropic's own signature grants them. Everything else gets no entitlements.
cat > "$work/claude.entitlements" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
</dict>
</plist>
PLIST
for path in "${machos[@]}"; do
  if [[ "$(basename "$path")" == claude ]]; then
    sign --entitlements "$work/claude.entitlements" "$path"
  else
    sign "$path"
  fi
done
# The CLI binaries arrive already signed and notarized by the release's package job; signing them
# again keeps one identity throughout and fails here, not later, if one is missing. supertag-tui
# keeps its one entitlement, allow-jit, for Bun's JavaScript engine; the OpenTUI library inside it
# was signed with this identity before it was embedded. Each is signed as a fresh copy moved into
# place, because macOS can kill a signed binary rewritten in place.
for name in "${binaries[@]}"; do
  fresh="$work/fresh-$name"
  cp "$resources/$name" "$fresh"
  if [[ "$name" == supertag-tui ]]; then
    sign --entitlements "$(dirname "$0")/supertag-tui.entitlements" "$fresh"
  else
    sign "$fresh"
  fi
  rm -f "$resources/$name"
  mv "$fresh" "$resources/$name"
done
# The Electron parts and the app last, inside out: frameworks, helper apps, then SuperTag.app, each
# with the hardened runtime; the helpers and the app get only allow-jit. The CLI tree above keeps
# the signatures it just got.
node "$(dirname "$0")/../apps/desktop/build/sign-mac.mjs" "$app" "$IDENTITY" "$keychain"
codesign --verify --deep --strict --verbose=2 "$app"

# Apple notarizes only the outermost container: the service checks the nested app and every
# executable in it and issues tickets for the disk image and the app alike. So the app is not
# notarized or stapled on its own; the disk image carries the stapled ticket, and Gatekeeper finds
# the app's ticket online once someone copies the app out of the image.
create_image
security unlock-keychain -p "$password" "$keychain"
codesign --force --timestamp --keychain "$keychain" --sign "$IDENTITY" "$image"
codesign --verify --strict --verbose=2 "$image"
xcrun notarytool submit "$image" --key "$NOTARY_KEY_PATH" \
  --key-id "$APPLE_NOTARY_KEY_ID" --issuer "$APPLE_NOTARY_ISSUER_ID" --wait --timeout 30m
xcrun stapler staple "$image"
xcrun stapler validate "$image"
spctl --assess --type open --context context:primary-signature --verbose=2 "$image"

# Check the image as shipped: its contents and layout, then the app inside it. The app's ticket is
# not stapled, so Gatekeeper looks it up online; give a just-published ticket a moment to appear.
check_image
assess_app() {
  local attempt
  for attempt in 1 2 3 4 5; do
    if spctl --assess --type execute --verbose=2 "$1/SuperTag.app"; then
      return 0
    fi
    echo "Gatekeeper has not accepted the app yet (attempt $attempt); retrying."
    sleep 15
  done
  return 1
}
with_mounted_image assess_app || { echo "Gatekeeper rejected the app inside $image" >&2; exit 1; }
create_zip
