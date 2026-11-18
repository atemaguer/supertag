//! Why a Worker Host operation failed or fell back, written to the Worker Host log.
//!
//! The host keeps answering the Control Plane and the harness adapter with fixed messages, which
//! may not carry paths, provider output, or credentials. The underlying error used to be
//! discarded with them, so a failed capture or a warm preparation retried cold left no trace of
//! its cause. These helpers write that cause to this host's own standard error, redacted with
//! the host's credential variables and its own credentials, and filtered for terminal controls.
//!
//! The reasons noted during an Attempt also become its failure detail: when the Attempt fails,
//! the host sends them with its fixed result, and the Control Plane shows them to operators only,
//! in the Task execution report. A Worker Host process runs one Attempt at a time, so the
//! reasons noted since the Attempt began are that Attempt's. Errors from serving other hosts are
//! logged without being recorded.
use std::{
    fmt::Display,
    sync::{Mutex, OnceLock},
};

use supertag_protocol::redaction::{SensitiveValue, redact_text};
use tonic::Status;

fn credentials() -> &'static Mutex<Vec<String>> {
    static CREDENTIALS: OnceLock<Mutex<Vec<String>>> = OnceLock::new();
    CREDENTIALS.get_or_init(Mutex::default)
}

/// Redacts `value` from every later log line, beside the host's credential variables.
pub(crate) fn remember_credential(value: &str) {
    if value.is_empty() {
        return;
    }
    let mut known = credentials()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if !known.iter().any(|known| known == value) {
        known.push(value.to_owned());
    }
}

fn secrets() -> Vec<SensitiveValue> {
    let known = credentials()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone();
    let known: Vec<&str> = known.iter().map(String::as_str).collect();
    crate::worker::adapter::host_secrets(&known)
}

/// The most failure detail lines an Attempt reports, and their longest length, as the Control
/// Plane accepts them.
const MAX_DETAIL: usize = 8;
const MAX_DETAIL_CHARS: usize = 160;

fn recorded() -> &'static Mutex<Vec<String>> {
    static RECORDED: OnceLock<Mutex<Vec<String>>> = OnceLock::new();
    RECORDED.get_or_init(Mutex::default)
}

/// Forgets reasons noted before this Attempt began.
pub(crate) fn begin_attempt() {
    recorded()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clear();
}

/// The reasons noted since the Attempt began, as failure detail: the latest eight lines, each
/// one line of at most 160 characters. Clears them.
pub(crate) fn take_detail() -> Vec<String> {
    let lines = std::mem::take(&mut *recorded().lock().unwrap_or_else(|error| error.into_inner()));
    let skip = lines.len().saturating_sub(MAX_DETAIL);
    lines.into_iter().skip(skip).collect()
}

fn logged(what: &str, error: &dyn Display) -> String {
    let line = redact_text(&format!("{what}: {error:#}"), &secrets(), false);
    supertag_protocol::terminal_text::warn(&line);
    line
}

/// Logs `what` happened and the error behind it, with its causes, and records it as the current
/// Attempt's failure detail.
pub(crate) fn note(what: &str, error: &dyn Display) {
    let line: String = logged(what, error)
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect::<String>()
        .trim()
        .chars()
        .take(MAX_DETAIL_CHARS)
        .collect();
    if line.is_empty() {
        return;
    }
    let mut recorded = recorded().lock().unwrap_or_else(|error| error.into_inner());
    if recorded.last() != Some(&line) {
        recorded.push(line);
    }
    if recorded.len() > MAX_DETAIL {
        recorded.remove(0);
    }
}

/// Logs like `note` without recording: for errors met while serving another host, which are not
/// this host's Attempt.
pub(crate) fn note_unrecorded(what: &str, error: &dyn Display) {
    logged(what, error);
}

/// `noted`, for errors met while serving another host.
pub(crate) fn noted_unrecorded(status: Status, error: &dyn Display) -> Status {
    note_unrecorded(status.message(), error);
    status
}

/// Logs `error` under `status`'s message and returns `status`, for
/// `.map_err(|error| noted(Status::internal("…"), &error))`.
pub(crate) fn noted(status: Status, error: &dyn Display) -> Status {
    note(status.message(), error);
    status
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn noted_reasons_become_bounded_one_line_detail() {
        begin_attempt();
        for index in 0..10 {
            note(
                "Workspace Volume staging failed",
                &format!("cause {index}\nsecond line {}", "x".repeat(300)),
            );
        }
        note_unrecorded("direct artifact read failed", &"a peer's error");
        // Other tests in this process may note reasons too; these assertions allow for them.
        let detail = take_detail();
        assert!(detail.len() <= 8, "{detail:?}");
        assert!(
            detail.iter().any(
                |line| line.starts_with("Workspace Volume staging failed: cause 9 second line")
            ),
            "{detail:?}"
        );
        assert!(!detail.iter().any(|line| line.contains("a peer's error")));
        assert!(detail.iter().all(|line| line.chars().count() <= 160));
        assert!(
            detail
                .iter()
                .all(|line| !line.chars().any(char::is_control))
        );
    }

    #[test]
    fn a_noted_reason_hides_the_host_credentials() {
        remember_credential("stcr_failure-note-secret");
        let line = redact_text(
            &format!(
                "{}: {:#}",
                "Remote Workspace output could not be captured safely",
                anyhow::anyhow!("provider said stcr_failure-note-secret").context("capture")
            ),
            &secrets(),
            false,
        );
        assert!(line.contains("capture: provider said"), "{line}");
        assert!(!line.contains("stcr_failure-note-secret"), "{line}");
    }
}
