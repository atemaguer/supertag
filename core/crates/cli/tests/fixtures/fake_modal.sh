#!/bin/sh
# A stand-in for the Modal CLI in tests of `supertag deploy`. It keeps "secrets" as files under
# $FAKE_MODAL/secrets, appends every invocation's arguments to $FAKE_MODAL/log, and for
# `modal deploy` records the SUPERTAG_MODAL_* environment and the app definition, then waits for
# the test to bring the "deployment" up and name its URL in $FAKE_MODAL/ready-N.
#
# It accepts only what the real CLI (deploy/modal/requirements.txt) accepts from supertag: a
# secret's values come from a private --from-json file, never from KEY=VALUE arguments.
set -eu
root=$FAKE_MODAL
printf '%s\n' "$*" >>"$root/log"

case "${1:-}" in
--version)
  echo "modal client version ${FAKE_MODAL_VERSION:-1.5.5}"
  ;;
profile)
  # `modal profile list --json`
  [ "$*" = "profile list --json" ] || { echo "unexpected: modal $*" >&2; exit 2; }
  cat "$root/profiles"
  ;;
app)
  # `modal app list [--env NAME] --json`: the app is listed as deployed once a rollout ran.
  [ "${2:-}" = list ] || { echo "unexpected: modal $*" >&2; exit 2; }
  if [ -e "$root/deployed" ]; then
    name=$(cat "$root/deployed")
    printf '[\n'
    printf '  {"app_id": "ap-0", "description": "%s", "state": "stopped", "tasks": "0", "created_at": "2026-11-21 10:00 UTC", "stopped_at": "2026-11-21 11:00 UTC"},\n' "$name"
    printf '  {"app_id": "ap-1", "description": "%s", "state": "deployed", "tasks": "1", "created_at": "2026-11-22 10:00 UTC", "stopped_at": null}\n' "$name"
    printf ']\n'
  else
    printf '[]\n'
  fi
  ;;
container)
  # `modal container list [--env NAME] --json` and `modal container stop ID --yes`. Each
  # rollout starts a container, and one stays until it is stopped, as a real one does while a
  # Worker Host or a Gateway holds a tunnel open.
  case "${2:-}" in
  list)
    printf '[\n'
    first=1
    for path in "$root"/containers/*; do
      [ -e "$path" ] || continue
      [ "$first" = 1 ] || printf ',\n'
      first=0
      printf '  {"container_id": "%s", "app_id": "ap-1", "app_name": "%s", "start_time": "2026-11-22 10:00:00+00:00"}' "${path##*/}" "$(cat "$path")"
    done
    printf '\n]\n'
    ;;
  stop)
    [ "${4:-}" = --yes ] || { echo "Aborted: no interactive terminal detected." >&2; exit 1; }
    [ -e "$root/containers/$3" ] || { echo "Container '$3' not found" >&2; exit 1; }
    rm "$root/containers/$3"
    ;;
  *)
    echo "unexpected: modal $*" >&2
    exit 2
    ;;
  esac
  ;;
secret)
  action=$2
  shift 2
  name=
  file=
  force=0
  while [ $# -gt 0 ]; do
    case "$1" in
    --env)
      shift
      printf '%s\n' "$1" >>"$root/environments"
      ;;
    --from-json)
      shift
      file=$1
      ;;
    --force) force=1 ;;
    --json | --yes) ;;
    -*)
      echo "unknown option $1" >&2
      exit 2
      ;;
    *=*)
      echo "a secret's values must not be passed as arguments" >&2
      exit 2
      ;;
    *) name=$1 ;;
    esac
    shift
  done
  case "$action" in
  list)
    printf '[\n'
    first=1
    for path in "$root"/secrets/*.json; do
      [ -e "$path" ] || continue
      [ "$first" = 1 ] || printf ',\n'
      first=0
      base=${path##*/}
      printf '  {"name": "%s", "created_at": "2026-11-22 10:00 UTC", "created_by": "test", "last_used_at": "-"}' "${base%.json}"
    done
    printf '\n]\n'
    ;;
  create)
    if [ -e "$root/secrets/$name.json" ] && [ "$force" = 0 ]; then
      echo "Secret '$name' already exists" >&2
      exit 1
    fi
    case "$(ls -l "$file")" in
    -rw-------*) ;;
    *)
      echo "the secret's file is readable by others" >&2
      exit 1
      ;;
    esac
    cp "$file" "$root/secrets/$name.json"
    echo "Created a new secret '$name'"
    ;;
  delete)
    [ -e "$root/secrets/$name.json" ] || {
      echo "Secret '$name' not found" >&2
      exit 1
    }
    rm "$root/secrets/$name.json"
    ;;
  *)
    echo "unexpected: modal secret $action" >&2
    exit 2
    ;;
  esac
  ;;
deploy)
  shift
  definition=
  while [ $# -gt 0 ]; do
    case "$1" in
    --env)
      shift
      printf '%s\n' "$1" >>"$root/environments"
      ;;
    *) definition=$1 ;;
    esac
    shift
  done
  if [ -e "$root/fail-deploy" ]; then
    echo "Secret 'missing' not found in environment 'main'" >&2
    exit 1
  fi
  number=$(($(find "$root" -name 'requested-*' | wc -l) + 1))
  env | grep '^SUPERTAG_MODAL_' | sort >"$root/deploy-$number.env"
  cp "$definition" "$root/app-$number.py"
  : >"$root/requested-$number"
  waited=0
  until [ -e "$root/ready-$number" ]; do
    sleep 0.1
    waited=$((waited + 1))
    [ "$waited" -lt 900 ] || {
      echo "the test never served rollout $number" >&2
      exit 1
    }
  done
  printf '%s' "$SUPERTAG_MODAL_APP" >"$root/deployed"
  mkdir -p "$root/containers"
  printf '%s' "$SUPERTAG_MODAL_APP" >"$root/containers/ta-$number"
  echo "✓ Created objects."
  echo "├── 🔨 Created mount app.py"
  echo "└── 🔨 Created web function serve => $(cat "$root/ready-$number")"
  echo "✓ App deployed in 1.0s! 🎉"
  echo
  echo "View Deployment: https://modal.com/apps/acme/main/deployed/tags"
  ;;
*)
  echo "unexpected: modal $*" >&2
  exit 2
  ;;
esac
