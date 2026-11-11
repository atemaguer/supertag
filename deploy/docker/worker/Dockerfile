FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates git python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*

# For split execution, match the Codex CLI installed on the Worker Host.
ARG CODEX_VERSION
RUN if [ -n "$CODEX_VERSION" ]; then \
      npm install --global --no-audit --no-fund --cache /tmp/codex-npm-cache "@openai/codex@$CODEX_VERSION" \
      && rm -rf /tmp/codex-npm-cache; \
    fi
