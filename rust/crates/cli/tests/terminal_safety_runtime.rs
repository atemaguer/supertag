//! Text that reaches the CLI from the Control Plane cannot drive the operator's terminal.
//!
//! Real services store values that hold terminal controls, bidirectional overrides, and line
//! breaks. Readable views replace them with spaces and keep escape payloads visible. JSON keeps
//! every value: unsafe characters are written as `\u` escapes that parse back to the original.
#[path = "../../../test-support/prerequisites.rs"]
mod prerequisites;
#[macro_use]
#[path = "support/database.rs"]
mod database;
#[path = "support/operator_services.rs"]
mod operator_services;

use anyhow::{Context, Result};
use operator_services::OperatorServices;
use serde_json::Value;

/// Control and format characters a stored value may carry, around a fake line.
const HOSTILE: &str =
    "visible\x1b[2J\x1b]0;hidden-title\x07\r\n\t\u{9b}\u{202e}\u{2028}\u{2066}\u{200b}fake line";

/// Names refuse control characters, but format characters can still reorder or hide text.
const DISPLAY_NAME: &str = "Lead\u{202e}\u{2066}\u{200b}tsil";

/// Whether `c` could change a terminal or reorder or hide text.
fn unsafe_char(c: char) -> bool {
    c.is_control()
        || matches!(
            c,
            '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2028}' | '\u{2029}' | '\u{2060}'..='\u{206f}' | '\u{feff}'
        )
}

/// No unsafe character other than the renderer's own line breaks.
fn assert_terminal_safe(output: &str) {
    assert!(
        !output.chars().any(|c| c != '\n' && unsafe_char(c)),
        "{output:?}"
    );
}

/// A readable view keeps the evidence visible and adds no line of its own.
fn assert_readable(output: &str) {
    assert_terminal_safe(output);
    assert!(
        output.contains("hidden-title") && output.contains("[2J"),
        "{output:?}"
    );
    assert!(
        !output
            .lines()
            .any(|line| line.trim_start().starts_with("fake line")),
        "{output:?}"
    );
}

database_tests! {
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    stored_text_cannot_drive_the_terminal;
}

async fn stored_text_cannot_drive_the_terminal(database: String) -> Result<()> {
    let services = OperatorServices::start(&database).await?;
    let instructions = format!("Review releases. {HOSTILE}");
    services
        .ok(&[
            "put-tag",
            "lead",
            "--name",
            DISPLAY_NAME,
            "--instructions",
            &instructions,
            "--allow",
            "files:read",
        ])
        .await?;

    // JSON keeps the stored value exactly, but carries it as escapes.
    let tag = services.ok(&["get-tag", "lead"]).await?;
    assert_terminal_safe(&tag);
    assert!(tag.contains("\\u009b") && tag.contains("\\u202e"), "{tag}");
    let parsed: Value = serde_json::from_str(&tag)?;
    assert_eq!(parsed["instructions"], instructions.as_str());

    let described = services.ok(&["describe", "tag", "lead"]).await?;
    assert_readable(&described);
    let described: Value = serde_json::from_str(
        &services
            .ok(&["describe", "tag", "lead", "--output", "json"])
            .await?,
    )?;
    assert_eq!(described["instructions"], instructions.as_str());

    let outcome = format!("Ship the release. {HOSTILE}");
    services
        .ok(&["objective", "create", "ship", &outcome, "--owner", "lead"])
        .await?;
    let objective = services.ok(&["objective", "get", "ship"]).await?;
    assert_terminal_safe(&objective);
    let parsed: Value = serde_json::from_str(&objective)?;
    assert_eq!(parsed["outcome"], outcome.as_str());
    let listed = services.ok(&["objective", "list"]).await?;
    assert_terminal_safe(&listed);

    assert_readable(&services.ok(&["describe", "objective", "ship"]).await?);
    let status = services.ok(&["status"]).await?;
    assert_terminal_safe(&status);
    assert!(status.contains("lead (Lead   tsil)"), "{status}");
    let status = services.ok(&["status", "--output", "json"]).await?;
    assert_terminal_safe(&status);
    let status: Value = serde_json::from_str(&status)?;
    assert!(status.to_string().contains(DISPLAY_NAME), "{status}");

    // An error that repeats what the Control Plane was asked about is filtered too.
    let error = services.fails(&["describe", "tag", HOSTILE]).await?;
    assert_terminal_safe(&error);
    assert!(error.starts_with("Error: "), "{error}");

    let reason = format!("Paused for review. {HOSTILE}");
    services
        .ok(&["objective", "pause", "ship", "--reason", &reason])
        .await?;
    let paused: Value = serde_json::from_str(&services.ok(&["objective", "get", "ship"]).await?)
        .context("parse paused Objective")?;
    assert!(paused["paused_at_ms"].is_number(), "{paused}");
    services.stop().await
}
