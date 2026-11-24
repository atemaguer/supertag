//! Where a runtime test finds the entry of a Node bridge.
//!
//! A test normally starts the entry `tsc` compiled in the checkout, such as
//! `harnesses/claude-code/dist/rust-adapter/entry.js`. With `SUPERTAG_RUST_TEST_NODE_BRIDGES` set
//! to a directory staged by `scripts/node_bridges.py`, it starts that directory's bundled entry
//! instead, so the same test runs against the files a release ships.
#![allow(dead_code)]

use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail, ensure};

pub const STAGED: &str = "SUPERTAG_RUST_TEST_NODE_BRIDGES";

/// The entry of the bridge `kind`: `claude-code`, `opencode`, or `local-vm`.
pub fn entry(kind: &str) -> Result<PathBuf> {
    let (source, name) = match kind {
        "claude-code" | "opencode" => (format!("harnesses/{kind}/dist/rust-adapter"), "entry.js"),
        "local-vm" => (
            "harnesses/environments/local-vm/dist/rust-provider".to_owned(),
            "main.js",
        ),
        _ => bail!("no Node bridge is named {kind}"),
    };
    let entry = match std::env::var_os(STAGED).filter(|value| !value.is_empty()) {
        Some(staged) => Path::new(&staged).join(kind).join(name),
        None => Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .join(source)
            .join(name),
    };
    ensure!(
        entry.is_file(),
        "the {kind} bridge has no entry at {}; build it with pnpm build, or stage it with scripts/node_bridges.py when {STAGED} is set",
        entry.display()
    );
    entry
        .canonicalize()
        .with_context(|| format!("resolve {}", entry.display()))
}
