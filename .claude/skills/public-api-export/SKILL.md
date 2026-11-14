---
name: public-api-export
description: Add or change a supertag-ai public entry point under the stability policy. Read before touching packages/supertag-ai exports, tsup config, or the api-stability table.
---

# Public API export

`packages/supertag-ai` is the only public npm package: the TypeScript SDK for the native
services. Everything it exposes is a compatibility commitment at some stability level, so adding
an export is a contract change, not a build tweak. Its entry points speak only the
`supertag.runtime.v2` APIs of the Control Plane and Worker Host.

## Four places must agree

Adding an entry point `supertag-ai/thing` means editing all four:

1. **`packages/supertag-ai/src/thing.ts`** — the entry module. Keep it a thin, deliberate
   surface over the generated `supertag.runtime.v2` bindings and the Worker SDK's
   `rust-harness` client.
2. **`packages/supertag-ai/tsup.config.ts`** — add `thing: "src/thing.ts"` to `entry`.
3. **`packages/supertag-ai/package.json`** — add `./thing` to `exports` with `types` and
   `import` conditions. ESM only.
4. **`docs/reference/api-stability.md`** — add a row to the package entry point table with its
   level and compatibility boundary.

Also update `packages/supertag-ai/README.md`, which npm renders.

## Verify

```sh
pnpm --filter supertag-ai typecheck
SUPERTAG_RUST_TEST_CLI=/path/to/supertag pnpm --filter supertag-ai test:package
```

`test:package` builds, runs `publint` and `attw --pack . --profile esm-only`, and runs
`scripts/verify-control-plane-client.mjs` against a native Control Plane and Worker Host when
`SUPERTAG_RUST_TEST_CLI` names the built CLI. A malformed `exports` map or unresolvable types fail
here, not in `pnpm build`.

Removing or renaming an export is a breaking change; follow `docs/reference/api-stability.md`.
