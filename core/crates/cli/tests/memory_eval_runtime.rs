//! The memory eval's fixture mode (`tests/evals/memory/run.mjs`): on a throwaway `supertag up`, the
//! fixture adapter runs as each harness, and every check of the scenario passes. It checks that
//! what one Session taught reaches later Sessions in the right store, that a Work Session only
//! proposes, that the merging turn and the daily review merge and drop proposals, and that the
//! Worker Host counts it all.
#![cfg(feature = "test-fixtures")]
#[path = "support/children.rs"]
mod children;
use children::reaped;

#[path = "../../../test-support/prerequisites.rs"]
mod prerequisites;

use std::{path::Path, time::Duration};

use anyhow::{Context, Result, ensure};
use serde_json::Value;
use tokio::{process::Command, time::timeout};

const BIN: &str = env!("CARGO_BIN_EXE_supertag");
const ADAPTER: &str = env!("CARGO_BIN_EXE_supertag-fixture-adapter");

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn memory_reaches_later_sessions_on_every_harness() -> Result<()> {
    let Some(node) = prerequisites::env("node", "SUPERTAG_RUST_TEST_NODE")? else {
        return Ok(());
    };
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../tests/evals/memory/run.mjs");
    let output = timeout(
        Duration::from_secs(600),
        reaped(Command::new(node))
            .arg(&script)
            .args(["--cli", BIN, "--adapter", ADAPTER, "--json"])
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .context("the memory eval did not finish")??;
    let report: Value = serde_json::from_slice(&output.stdout).with_context(|| {
        format!(
            "memory eval output: {}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
    })?;
    for harness in ["claude-code", "codex", "opencode", "cursor"] {
        let result = &report["harnesses"][harness];
        let failed: Vec<&Value> = result["steps"]
            .as_array()
            .context("steps")?
            .iter()
            .flat_map(|step| step["checks"].as_array().into_iter().flatten())
            .filter(|check| check["pass"] != true)
            .collect();
        ensure!(
            result["error"].is_null() && failed.is_empty(),
            "{harness}: {failed:?} {}",
            result["error"]
        );
    }
    ensure!(report["passed"] == true, "{report}");
    Ok(())
}
