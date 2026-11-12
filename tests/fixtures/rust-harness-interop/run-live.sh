#!/usr/bin/env bash
set -euo pipefail
spike_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
if [[ $# -gt 2 ]]; then
  echo "Usage: $0 [OUTPUT_DIRECTORY [typescript|python]]" >&2
  exit 1
fi
live_output="${1:-$(mktemp -d /tmp/supertag-rust-codex-live-XXXXXX)}"
case "$live_output" in
  /*) ;;
  *) live_output="$PWD/$live_output" ;;
esac
live_language="${2:-}"
bash "$spike_dir/setup.sh"
cd "$spike_dir"
export PROTOC="$spike_dir/protoc.sh"
live_args=("$spike_dir" --live "$live_output")
if [[ -n "$live_language" ]]; then live_args+=("$live_language"); fi
echo "Live Codex Task results: $live_output"
cargo run --locked -- "${live_args[@]}"
