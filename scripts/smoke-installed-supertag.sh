#!/usr/bin/env bash
# Starts an installed supertag command's local services in a temporary state directory, lists
# Tags through the local Control Plane, and stops the services. No harness or credential is used:
# the Worker Host's adapter is /usr/bin/true, and no Task is submitted.
set -euo pipefail

supertag=${1:?Usage: smoke-installed-supertag.sh PATH_TO_SUPERTAG}
state=$(mktemp -d)
stop() {
  "$supertag" down --state-directory "$state" >/dev/null 2>&1 || true
  rm -rf "$state"
}
trap stop EXIT

"$supertag" up --state-directory "$state" --adapter /usr/bin/true
"$supertag" ps --state-directory "$state"
tags=$("$supertag" get tags --state-directory "$state")
printf '%s\n' "$tags"
[[ $tags == *'"tags":[]'* ]]
"$supertag" down --state-directory "$state"
if [[ $("$supertag" ps --state-directory "$state") != "SuperTag is not running on this machine." ]]; then
  echo "supertag down left services running" >&2
  exit 1
fi
printf 'Started, queried, and stopped %s\n' "$("$supertag" --version)"
