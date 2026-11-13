#!/usr/bin/env bash
set -euo pipefail
spike_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
cd "$spike_dir"
npm ci --ignore-scripts --no-audit --no-fund
uv venv --python "${SUPERTAG_SPIKE_PYTHON:-3.13}" .venv --allow-existing
uv pip sync --python .venv/bin/python requirements.txt
mkdir -p generated
.venv/bin/python -m grpc_tools.protoc -I . --python_out=generated --grpc_python_out=generated harness.proto
npx --no-install tsc --project tsconfig.json
