---
name: verify-changes
description: The check, test, and build gates for this repository. Read before reporting any change complete.
---

# Verify changes

Run from the repository root after `pnpm install`.

## Gates

```sh
pnpm check   # biome, protobuf generation, typecheck, docs
pnpm test    # vitest: Node bridges, Worker SDK, repository checks
pnpm build   # tsc --build
cargo test --manifest-path rust/Cargo.toml --locked --workspace --all-features
cargo clippy --manifest-path rust/Cargo.toml --locked --workspace --all-targets --all-features -- -D warnings
```

`pnpm docs:check` checks documented commands against `rust/docs/cli-reference.md`, except pages
listed in `scripts/docs-pending-cli.txt`.

Rust tests that start a Node bridge need it built first
(`pnpm --filter @supertag/worker-cursor build`, and likewise for Claude Code, OpenCode, E2B, and
Modal) and `SUPERTAG_RUST_TEST_NODE` set. PostgreSQL cases need
`SUPERTAG_RUST_TEST_POSTGRES_URL_FILE` and `-- --include-ignored`. Set
`SUPERTAG_RUST_TEST_REQUIRE` so a missing prerequisite fails instead of skipping; see
CONTRIBUTING.md.

After terminal UI changes, run `go vet ./...` and `go test ./...` in `apps/tui`. After desktop
changes, run `pnpm --filter @supertag/desktop build` and `cargo clippy` with
`--manifest-path apps/desktop/src-tauri/Cargo.toml`.

## Notes

- If a gate cannot run in your environment, say so explicitly and state what you verified
  instead. Do not report a change complete on the strength of the gates you skipped.
