#!/usr/bin/env bash
set -euo pipefail

release_tag=${1:-}
check_latest=${2:-false}
if [[ ! $release_tag =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  printf 'Expected a version tag such as v0.2.0-alpha.9, got %s\n' "$release_tag" >&2
  exit 1
fi
version=${release_tag#v}
selector=$version
if [[ $check_latest == true ]]; then
  selector=latest
fi

fresh_home=$(mktemp -d)
trap 'rm -rf "$fresh_home"' EXIT
installer="$fresh_home/install.sh"
registry="https://registry.npmjs.org/supertag-ai"
installer_url="https://unpkg.com/supertag-ai@$selector/install.sh"
deadline=$((SECONDS + 1800))
curl_options=(--disable --fail --silent --location --max-time 15)

wait_for() {
  local description=$1
  shift
  printf 'Waiting for %s\n' "$description"
  while (( SECONDS < deadline )); do
    if "$@"; then
      return 0
    fi
    sleep 15
  done
  printf 'Timed out waiting for %s within the 30-minute propagation window\n' "$description" >&2
  return 1
}

npm_ready() {
  curl "${curl_options[@]}" --head --output /dev/null "$registry/$version" &&
    curl "${curl_options[@]}" --head --output /dev/null "$registry/-/supertag-ai-$version.tgz"
}

installer_ready() {
  curl "${curl_options[@]}" --output "$installer" "$installer_url" &&
    grep -Fxq "RELEASE_DEFAULT_VERSION=\"$version\"" "$installer"
}

wait_for "npm metadata and tarball for $version" npm_ready
wait_for "$installer_url to serve $version" installer_ready

env -i HOME="$fresh_home" PATH="$PATH" sh "$installer"
cli="$fresh_home/.local/bin/supertag"
platform=$(node -p 'process.platform + "-" + process.arch.replace(/^x64$/, "amd64")')
tui="$fresh_home/.local/share/supertag/versions/$version/node_modules/supertag-ai/tui/supertag-tui-$platform"
test "$(env -i HOME="$fresh_home" PATH="$PATH" "$cli" --version)" = "$version"
test "$("$tui" --version)" = "$version"
printf 'Verified SuperTag CLI and TUI %s from %s\n' "$version" "$installer_url"
