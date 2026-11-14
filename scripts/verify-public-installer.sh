#!/usr/bin/env bash
# Runs a release's public installer in a clean home, checks the installed versions, and starts
# and stops local services with the installed command.
set -euo pipefail

release_tag=${1:-}
check_latest=${2:-false}
if [[ ! $release_tag =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  printf 'Expected a version tag such as v0.3.0-alpha.1, got %s\n' "$release_tag" >&2
  exit 1
fi
version=${release_tag#v}
releases="https://github.com/atemaguer/supertag/releases"
if [[ $check_latest == true ]]; then
  installer_url="$releases/latest/download/install.sh"
else
  installer_url="$releases/download/$release_tag/install.sh"
fi

fresh_home=$(mktemp -d)
trap 'rm -rf "$fresh_home"' EXIT
installer="$fresh_home/install.sh"
deadline=$((SECONDS + 900))
curl_options=(--disable --fail --silent --location --max-time 30)

installer_ready() {
  curl "${curl_options[@]}" --output "$installer" "$installer_url" &&
    grep -Fxq "RELEASE_DEFAULT_VERSION=\"$version\"" "$installer"
}

printf 'Waiting for %s to serve %s\n' "$installer_url" "$version"
until installer_ready; do
  if (( SECONDS >= deadline )); then
    printf 'Timed out waiting for %s within 15 minutes\n' "$installer_url" >&2
    exit 1
  fi
  sleep 15
done

env -i HOME="$fresh_home" PATH="$PATH" sh "$installer"
cli="$fresh_home/.local/bin/supertag"
test "$(env -i HOME="$fresh_home" PATH="$PATH" "$cli" --version)" = "supertag $version"
package=$(dirname "$(readlink "$cli")")
test "$("$package/supertag-tui" --version)" = "$version"
env -i HOME="$fresh_home" PATH="$PATH" bash "$(dirname "$0")/smoke-installed-supertag.sh" "$cli"
printf 'Verified SuperTag %s from %s\n' "$version" "$installer_url"
