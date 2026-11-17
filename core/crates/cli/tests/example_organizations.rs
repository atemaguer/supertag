//! Every example organization in `examples/organizations/` applies through a separate Control
//! Plane process and the operator CLI, then round-trips: a second `diff` and `apply` report no
//! changes. A field the Rust manifests no longer take fails the whole document, so this keeps the
//! examples on the current manifest form.
#[path = "support/children.rs"]
mod children;
#[path = "../../../test-support/prerequisites.rs"]
mod prerequisites;
#[macro_use]
#[path = "support/database.rs"]
mod database;
#[path = "support/operator_services.rs"]
mod operator_services;

use std::path::Path;

use anyhow::{Context, Result, ensure};
use operator_services::OperatorServices;
use serde_json::Value;

const EXAMPLES: [&str; 3] = ["mixed-harnesses", "review-team", "solo"];

fn example(name: &str) -> String {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../examples/organizations")
        .join(name)
        .join("organization.yaml")
        .display()
        .to_string()
}

#[test]
fn every_example_is_tested() -> Result<()> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../examples/organizations");
    let mut found = Vec::new();
    for entry in std::fs::read_dir(&root)? {
        let entry = entry?;
        if entry.path().join("organization.yaml").is_file() {
            found.push(entry.file_name().to_string_lossy().into_owned());
        }
    }
    found.sort();
    ensure!(found == EXAMPLES, "add each example to EXAMPLES: {found:?}");
    Ok(())
}

database_tests! {
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    mixed_harnesses;
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    review_team;
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    solo;
}

async fn mixed_harnesses(database: String) -> Result<()> {
    applies_and_round_trips(&database, "mixed-harnesses").await
}

async fn review_team(database: String) -> Result<()> {
    applies_and_round_trips(&database, "review-team").await
}

async fn solo(database: String) -> Result<()> {
    applies_and_round_trips(&database, "solo").await
}

async fn applies_and_round_trips(database: &str, name: &str) -> Result<()> {
    let services = OperatorServices::start(database).await?;
    let path = example(name);
    let preview = services.ok(&["diff", "-f", &path]).await?;
    ensure!(
        preview.lines().all(|line| ["create ", "assign ", "add "]
            .iter()
            .any(|verb| line.starts_with(verb))),
        "{name}: a fresh Control Plane previewed {preview}"
    );
    services
        .ok(&["apply", "-f", &path])
        .await
        .with_context(|| format!("apply {name}"))?;
    let again = services.ok(&["diff", "-f", &path]).await?;
    ensure!(
        again == "No changes.\n",
        "{name}: diff after apply: {again}"
    );
    ensure!(services.ok(&["apply", "-f", &path]).await? == "No changes.\n");

    // Every Tag works in the example's Workspace, following a branch.
    let tags: Value = serde_json::from_str(&services.ok(&["get", "tags"]).await?)?;
    let tags = tags["tags"].as_array().context("tags")?;
    ensure!(!tags.is_empty(), "{name}: no Tags");
    for tag in tags {
        ensure!(
            tag["workspace"]["workspace_id"] == "app" && tag["workspace"]["ref"] == "main",
            "{name}: Tag {} does not follow app at main: {tag}",
            tag["tag_id"]
        );
        // Only review-team places Tags by label, keeping the verifier on its own host.
        let expected: &[&str] = match (name, tag["tag_id"].as_str()) {
            ("review-team", Some("verifier")) => &["verify"],
            ("review-team", _) => &["team"],
            _ => &[],
        };
        ensure!(
            tag["runs_on"] == serde_json::json!(expected),
            "{name}: {tag}"
        );
    }
    services.stop().await
}
