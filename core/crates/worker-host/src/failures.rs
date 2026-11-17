//! Why a Worker Host operation failed or fell back, written to the Worker Host log.
//!
//! The host keeps answering the Control Plane and the harness adapter with fixed messages, which
//! may not carry paths, provider output, or credentials. The underlying error used to be
//! discarded with them, so a failed capture or a warm preparation retried cold left no trace of
//! its cause. These helpers write that cause to this host's own standard error, redacted with
//! the host's credential variables and its own credentials, and filtered for terminal controls.
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
    crate::adapter::host_secrets(&known)
}

/// Logs `what` happened and the error behind it, with its causes.
pub(crate) fn note(what: &str, error: &dyn Display) {
    let line = format!("{what}: {error:#}");
    supertag_protocol::terminal_text::warn(&redact_text(&line, &secrets(), false));
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
