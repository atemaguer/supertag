#!/bin/bash
# Put the supertag CLI inside the desktop app, sign it, and build, sign, and notarize its disk image.
#
#   package-desktop-macos.sh APP CLI_DIRECTORY IMAGE
#
# APP is the unsigned SuperTag.app from `tauri build --bundles app`. CLI_DIRECTORY is an extracted
# complete release archive: supertag, supertag-tui, supertag-shared-execution, and node-bridges/.
# The CLI goes to SuperTag.app/Contents/Resources/supertag/, where the app looks for it first.
# IMAGE is the disk image to write.
#
# With SIGNED=true it needs IDENTITY (a "Developer ID Application: ..." name), APPLE_DEVELOPER_ID_P12,
# APPLE_DEVELOPER_ID_P12_PASSWORD, NOTARY_KEY_PATH, APPLE_NOTARY_KEY_ID and APPLE_NOTARY_ISSUER_ID.
# Without it, the app keeps its ad-hoc signature, which is only good for local checks.
set -euo pipefail

app=${1:?Usage: package-desktop-macos.sh APP CLI_DIRECTORY IMAGE}
cli=${2:?Usage: package-desktop-macos.sh APP CLI_DIRECTORY IMAGE}
image=${3:?Usage: package-desktop-macos.sh APP CLI_DIRECTORY IMAGE}
signed=${SIGNED:-false}

for name in supertag supertag-tui supertag-shared-execution; do
  [[ -f "$cli/$name" && -x "$cli/$name" ]] || { echo "$cli has no executable $name" >&2; exit 1; }
done
[[ -f "$cli/node-bridges/manifest.json" ]] || { echo "$cli has no node-bridges/manifest.json" >&2; exit 1; }
[[ -d "$app/Contents/MacOS" ]] || { echo "$app is not an app bundle" >&2; exit 1; }

resources="$app/Contents/Resources/supertag"
rm -rf "$resources"
mkdir -p "$resources"
# ditto keeps the bridges' relative symlinks, which pnpm's layout depends on.
ditto "$cli" "$resources"

# Every Mach-O inside the bridges, such as Claude Code's native executable and native Node modules.
machos=()
while IFS= read -r -d '' path; do
  if file -b "$path" | grep -q 'Mach-O'; then
    machos+=("$path")
  fi
done < <(find "$resources/node-bridges" -type f \( -perm -u+x -o -name '*.node' -o -name '*.dylib' \) -print0)
echo "Found ${#machos[@]} executables in the Node bridges."

if [[ "$signed" != true ]]; then
  echo "SIGNED is not true: leaving the app unsigned for a local check."
  rm -f "$image"
  hdiutil create -quiet -volname SuperTag -srcfolder "$app" -ov -format ULMO "$image"
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
# again keeps one identity throughout and fails here, not later, if one is missing.
for name in supertag supertag-tui supertag-shared-execution; do
  sign "$resources/$name"
done
sign "$app"
codesign --verify --deep --strict --verbose=2 "$app"

# Apple notarizes only the outermost container: the service checks the nested app and every
# executable in it and issues tickets for the disk image and the app alike. So the app is not
# notarized or stapled on its own; the disk image carries the stapled ticket, and Gatekeeper finds
# the app's ticket online once someone copies the app out of the image.
rm -f "$image"
hdiutil create -quiet -volname SuperTag -srcfolder "$app" -ov -format ULMO "$image"
security unlock-keychain -p "$password" "$keychain"
codesign --force --timestamp --keychain "$keychain" --sign "$IDENTITY" "$image"
codesign --verify --strict --verbose=2 "$image"
xcrun notarytool submit "$image" --key "$NOTARY_KEY_PATH" \
  --key-id "$APPLE_NOTARY_KEY_ID" --issuer "$APPLE_NOTARY_ISSUER_ID" --wait --timeout 30m
xcrun stapler staple "$image"
xcrun stapler validate "$image"
spctl --assess --type open --context context:primary-signature --verbose=2 "$image"

# Check the app as shipped, inside the image. Its ticket is not stapled, so Gatekeeper looks it up
# online; give a just-published ticket a moment to appear.
mount="$work/mount"
mkdir "$mount"
hdiutil attach -quiet -readonly -nobrowse -noautoopen -mountpoint "$mount" "$image"
assessed=false
for attempt in 1 2 3 4 5; do
  if spctl --assess --type execute --verbose=2 "$mount/SuperTag.app"; then
    assessed=true
    break
  fi
  echo "Gatekeeper has not accepted the app yet (attempt $attempt); retrying."
  sleep 15
done
hdiutil detach -quiet "$mount"
[[ "$assessed" == true ]] || { echo "Gatekeeper rejected the app inside $image" >&2; exit 1; }
