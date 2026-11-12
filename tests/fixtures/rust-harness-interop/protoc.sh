#!/usr/bin/env bash
set -euo pipefail
spike_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
exec "$spike_dir/.venv/bin/python" -m grpc_tools.protoc "$@"
