//! Every example organization in `examples/` applies through a separate Control
//! Plane process and the operator CLI, then round-trips: a second `diff` and `apply` report no
//! changes. Its `objectives.yaml` then applies and round-trips the same way. A field the Rust
//! manifests no longer take fails the whole document, so this keeps the examples on the current
//! manifest form.
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

const EXAMPLES: [&str; 5] = [
    "engineering-org",
    "marketing-org",
    "multiplayer",
    "reliability",
    "review-team",
];

fn example(name: &str, file: &str) -> String {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../examples")
        .join(name)
        .join(file)
        .display()
        .to_string()
}

#[test]
fn every_example_is_tested() -> Result<()> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../examples");
    let mut found = Vec::new();
    for entry in std::fs::read_dir(&root)? {
        let entry = entry?;
        if entry.path().join("organization.yaml").is_file() {
            ensure!(
                entry.path().join("objectives.yaml").is_file(),
                "{:?} has no objectives.yaml",
                entry.file_name()
            );
            found.push(entry.file_name().to_string_lossy().into_owned());
        }
    }
    found.sort();
    ensure!(found == EXAMPLES, "add each example to EXAMPLES: {found:?}");
    Ok(())
}

database_tests! {
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    engineering_org;
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    marketing_org;
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    multiplayer;
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    reliability;
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    review_team;
}

async fn engineering_org(database: String) -> Result<()> {
    applies_and_round_trips(&database, "engineering-org").await
}

async fn marketing_org(database: String) -> Result<()> {
    applies_and_round_trips(&database, "marketing-org").await
}

async fn multiplayer(database: String) -> Result<()> {
    applies_and_round_trips(&database, "multiplayer").await
}

async fn reliability(database: String) -> Result<()> {
    applies_and_round_trips(&database, "reliability").await
}

async fn review_team(database: String) -> Result<()> {
    applies_and_round_trips(&database, "review-team").await
}

async fn applies_and_round_trips(database: &str, name: &str) -> Result<()> {
    let services = OperatorServices::start(database).await?;
    for file in ["organization.yaml", "objectives.yaml"] {
        let path = example(name, file);
        let preview = services.ok(&["diff", "-f", &path]).await?;
        ensure!(
            preview
                .lines()
                .all(|line| ["create ", "assign ", "add ", "grant "]
                    .iter()
                    .any(|verb| line.starts_with(verb))),
            "{name}/{file}: a fresh Control Plane previewed {preview}"
        );
        services
            .ok(&["apply", "-f", &path])
            .await
            .with_context(|| format!("apply {name}/{file}"))?;
        let again = services.ok(&["diff", "-f", &path]).await?;
        ensure!(
            again == "No changes.\n",
            "{name}/{file}: diff after apply: {again}"
        );
        ensure!(services.ok(&["apply", "-f", &path]).await? == "No changes.\n");
    }

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
        // review-team keeps the verifier on its own host; engineering-org places each function
        // on the host with its coding agent and sandbox.
        let expected: &[&str] = match (name, tag["tag_id"].as_str()) {
            ("review-team", Some("verifier")) => &["verify"],
            ("review-team", _) => &["team"],
            ("engineering-org", Some("platform-lead" | "infra-builder")) => &["platform"],
            ("engineering-org", Some("reviewer" | "security-reviewer" | "support")) => &["review"],
            ("engineering-org", Some("verifier")) => &["verify"],
            ("engineering-org", Some("reliability")) => &["reliability"],
            ("engineering-org", _) => &["product"],
            _ => &[],
        };
        ensure!(
            tag["runs_on"] == serde_json::json!(expected),
            "{name}: {tag}"
        );
    }
    services.stop().await
}
