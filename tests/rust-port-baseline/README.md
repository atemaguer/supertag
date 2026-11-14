# Rust port capability ledger check

`capability-ledger.test.ts` checks `rust/docs/rust-port-capability-ledger.md`, which is frozen at
`6c934be8`, the last commit that contained the TypeScript runtime:

- each Rust test it cites still exists in the Rust file cited before it;
- each repository path it cites exists now or existed at the freeze commit;
- every TypeScript, Go, and Python test file at the freeze commit is cited by a capability row or
  an exemption.

The check reads the freeze commit from Git, so it needs full history (`fetch-depth: 0` in CI).
Run it from the repository root:

```sh
pnpm exec vitest run tests/rust-port-baseline
```

The portable behavioral baseline that ran five scenarios against the TypeScript system and the
Rust binary was removed with the TypeScript runtime. Its drivers, cases, and README are available
at `6c934be8` under `tests/rust-port-baseline/`.
