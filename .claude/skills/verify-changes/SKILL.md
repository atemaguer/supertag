---
name: verify-changes
description: The check, test, and build gates for this repository. Read before reporting any change complete.
---

# Verify changes

Run from the repository root after `pnpm install`.

## Gates

```sh
pnpm check   # biome, typecheck, docs
pnpm test    # vitest: Node bridges, Worker SDK, repository checks
pnpm build   # tsc --build
cargo test --manifest-path core/Cargo.toml --locked --workspace --all-features
cargo clippy --manifest-path core/Cargo.toml --locked --workspace --all-targets --all-features -- -D warnings
```

`pnpm docs:check` checks every documented `supertag` command and flag against
`docs/reference/cli.md`.

Rust tests that start a Node bridge need it built first
(`pnpm --filter @supertag/worker-cursor build`, and likewise for Claude Code, OpenCode, E2B, and
Modal) and `SUPERTAG_RUST_TEST_NODE` set. PostgreSQL cases need
`SUPERTAG_RUST_TEST_POSTGRES_URL_FILE` and `-- --include-ignored`. Set
`SUPERTAG_RUST_TEST_REQUIRE` so a missing prerequisite fails instead of skipping; see
CONTRIBUTING.md.

After `supertag-ai` changes, run `pnpm --filter supertag-ai typecheck` and, with
`SUPERTAG_RUST_TEST_CLI` naming a built `supertag`, `pnpm --filter supertag-ai test:package`.
After Python SDK changes, install it with `python -m pip install "./sdks/python[dev]"` in a virtual
environment, then run `ruff check sdks/python` and `pytest sdks/python/tests`.
After terminal UI changes, run `go vet ./...` and `go test ./...` in `apps/tui`. After desktop
changes, run `pnpm --filter @supertag/desktop build`, then `cargo clippy` and the whole
`cargo test` (unfiltered: it checks that every Tauri command is allowed) with
`--manifest-path apps/desktop/src-tauri/Cargo.toml`. CI runs them in `.github/workflows/desktop.yml`.

After changes under `proto/`, decide whether the protocol version changes and update
`proto/protocol.lock` (see "Changing `proto/`" in `AGENTS.md`); `cargo test -p supertag-protocol
--test protocol_lock` checks it.

After changes under `proto/` or `sdks/`, regenerate and check the bindings and run the round trip:

```sh
uv run --python 3.13 --script scripts/generate-bindings.py --check
uv run --python 3.13 --script scripts/wire-roundtrip.py
go -C sdks/go test ./...
```

After changes under `scripts/`, run the script tests and the release version gate:

```sh
node --test scripts/*.test.mjs
uv run --with PyYAML==6.0.3 python -m unittest discover -s scripts -p 'test_*.py'
python3 scripts/release_version.py --check
```

## Notes

- If a gate cannot run in your environment, say so explicitly and state what you verified
  instead. Do not report a change complete on the strength of the gates you skipped.
