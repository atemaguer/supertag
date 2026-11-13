#!/usr/bin/env bash
set -euo pipefail
spike_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
cd "$spike_dir"

# Dependencies and generated bindings stay local to this experimental fixture.
bash "$spike_dir/setup.sh"
export PROTOC="$spike_dir/protoc.sh"
cargo run --locked -- "$spike_dir"
