#!/bin/bash
# Sign and notarize the two standalone macOS binaries before checksums are written.
set -euo pipefail

dist=${1:?Usage: notarize-release-tui.sh DIST_DIRECTORY}
credentials=(
  APPLE_DEVELOPER_ID_P12
  APPLE_DEVELOPER_ID_P12_PASSWORD
  APPLE_NOTARY_KEY
  APPLE_NOTARY_KEY_ID
  APPLE_NOTARY_ISSUER_ID
)
missing=()
for name in "${credentials[@]}"; do
  if [[ -z ${!name:-} ]]; then
    missing+=("$name")
  fi
done
if [[ ${#missing[@]} == "${#credentials[@]}" ]]; then
  echo "::warning::Apple credentials are absent. This build will distribute unsigned macOS binaries."
  exit 0
fi
if [[ ${#missing[@]} != 0 ]]; then
  printf 'Incomplete macOS signing configuration. Missing: %s\n' "${missing[*]}" >&2
  exit 1
fi

umask 077
work=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/supertag-notary.XXXXXXXX")
keychain="$work/signing.keychain-db"
cleanup() {
  security delete-keychain "$keychain" >/dev/null 2>&1 || true
  rm -rf -- "$work"
}
trap cleanup EXIT

printf '%s' "$APPLE_DEVELOPER_ID_P12" | base64 -D > "$work/signing.p12"
printf '%s\n' "$APPLE_NOTARY_KEY" > "$work/AuthKey.p8"
keychain_password=$(openssl rand -hex 32)

security create-keychain -p "$keychain_password" "$keychain"
security set-keychain-settings -lut 3600 "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
security import "$work/signing.p12" -k "$keychain" -f pkcs12 \
  -P "$APPLE_DEVELOPER_ID_P12_PASSWORD" -T /usr/bin/codesign
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$keychain_password" \
  "$keychain" >/dev/null
identity=$(security find-identity -v -p codesigning "$keychain" |
  awk '/"Developer ID Application: / { print $2 }')
if [[ ! $identity =~ ^[[:xdigit:]]{40}$ ]]; then
  echo "The PKCS#12 file must contain one valid Developer ID Application identity and its private key." >&2
  exit 1
fi

mkdir "$work/submission"
binaries=(supertag-tui-darwin-arm64 supertag-tui-darwin-amd64)
for binary in "${binaries[@]}"; do
  codesign --force --options runtime --timestamp --keychain "$keychain" --sign "$identity" \
    "$dist/$binary"
  codesign --verify --strict "$dist/$binary"
  cp "$dist/$binary" "$work/submission/"
done
ditto -c -k "$work/submission" "$work/supertag-tui.zip"

notary_auth=(--key "$work/AuthKey.p8" --key-id "$APPLE_NOTARY_KEY_ID" --issuer "$APPLE_NOTARY_ISSUER_ID")
# The service can return a submission ID even if waiting fails.
submit_exit=0
xcrun notarytool submit "$work/supertag-tui.zip" "${notary_auth[@]}" \
  --wait --timeout 20m --output-format json > "$work/receipt.json" || submit_exit=$?
submission=$(jq -r '.id // empty' "$work/receipt.json")
status=$(jq -r '.status // empty' "$work/receipt.json")
if [[ -z $submission ]]; then
  echo "Apple notarization returned no submission ID (notarytool exit $submit_exit)." >&2
  exit 1
fi
echo "Apple notarization submission $submission: ${status:-unknown}"
if ! xcrun notarytool log "$submission" "${notary_auth[@]}" "$work/notary-log.json"; then
  echo "Could not retrieve the notarization log for $submission." >&2
  exit 1
fi
jq -r '.issues[]? | "\(.severity): \(.path): \(.message)"' "$work/notary-log.json"
if [[ $submit_exit != 0 || $status != Accepted ]]; then
  exit 1
fi

# Apple publishes tickets online for standalone executables. Check both signed files appear.
for binary in "${binaries[@]}"; do
  cdhash=$(codesign --display --verbose=4 "$dist/$binary" 2>&1 | awk -F= '$1 == "CDHash" { print $2 }')
  jq -e --arg name "$binary" --arg hash "$cdhash" '
    any(.ticketContents[]?; (.path | split("/") | last) == $name and .cdhash == $hash)
  ' "$work/notary-log.json" >/dev/null || {
    echo "The notarization ticket did not include $binary." >&2
    exit 1
  }
  echo "Verified Apple's notarization ticket for $binary."
done
