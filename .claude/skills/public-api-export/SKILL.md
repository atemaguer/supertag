---
name: public-api-export
description: Add or change a supertag-ai public entry point under the stability policy. Read before touching packages/supertag-ai exports, tsup config, or the api-stability table.
---

# Public API export

`packages/supertag-ai` is the only published package. Everything it exposes is a compatibility
commitment at some stability level, so adding an export is a contract change, not a build
tweak.

## Four places must agree

Adding an entry point `supertag-ai/thing` means editing all four:

1. **`packages/supertag-ai/src/thing.ts`** — the entry module, re-exporting from internal
   `@supertag/*` packages. Keep it a thin, deliberate surface; do not re-export a whole
   internal module.

2. **`packages/supertag-ai/tsup.config.ts`** — add `thing: "src/thing.ts"` to `entry`.
   Not listed means not built.

3. **`packages/supertag-ai/package.json`** — add to `exports`:

   ```json
   "./thing": {
     "types": "./dist/thing.d.ts",
     "import": "./dist/thing.js"
   }
   ```

   ESM only. There is no `require` condition and no CJS build.

4. **`docs/reference/api-stability.md`** — add a row naming the surface, its level (Stable,
   Beta, Experimental, Internal), and its compatibility boundary. An undocumented export is
   Internal by default and carries no promise, which is rarely what you intend.

Also update the entry-point table in `packages/supertag-ai/README.md` — that is what npm
renders.

## Verify

```sh
pnpm --filter supertag-ai test:package
```

This builds, then runs `publint`, `attw --pack . --profile esm-only`, and
`scripts/verify-external-worker.mjs` against the packed tarball. A missing tsup entry, a
malformed `exports` map, or unresolvable types fail here and **only** here — `pnpm build`
alone will not catch them.

Confirm the subpath actually resolves from outside the workspace:

```sh
node --input-type=module -e "import('supertag-ai/thing').then(m=>console.log(Object.keys(m)))"
```

## Footguns

**Non-code assets need a copy step.** `dist/` holds only what tsup emits. Migrations and wire
schemas reach the package through `scripts/copy-migrations.mjs`, and anything shipped must be
listed in `package.json` `files`. An `exports` entry pointing at a path nothing copies resolves
to nothing — this has shipped broken before.

**`files` entries must exist.** A name listed there that is absent from the package directory is
silently omitted from the tarball.

**Internal packages must not leak.** tsup bundles `@supertag/*` via
`noExternal: [/^@supertag\//]` and `dts.resolve`. Runtime dependencies stay in `external` so
consumers resolve them normally. Never add `@supertag/*` to `external` — it would make private
packages a resolution requirement for users.

**`e2b` is an optional dependency.** Reachable only through
`supertag-ai/environments/e2b`. Do not import it from a non-optional entry point.

**Removing or renaming an export is a breaking change.** Follow the deprecation rules in
`docs/reference/api-stability.md`. Experimental surfaces may change without a deprecation
period; Beta surfaces may not, outside a minor pre-1.0 release.
