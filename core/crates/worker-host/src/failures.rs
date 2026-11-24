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
//! in the Task execution report. A Worker process runs one Attempt, and each slot of the Worklet's
//! pool keeps its own reasons, so the reasons noted since the Attempt began are that Attempt's.
//! Errors from serving other hosts are logged without being recorded.
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

tokio::task_local! {
    /// The reasons noted for the Attempt of the Worklet pool slot this task runs.
    static SLOT: std::cell::RefCell<Vec<String>>;
}

/// Runs a Worklet pool slot, whose noted reasons are its own Attempt's: several slots run
/// Attempts at once in one Worklet. A Worker runs one Attempt, so its reasons are the process's.
pub(crate) async fn per_slot<F: std::future::Future>(slot: F) -> F::Output {
    SLOT.scope(std::cell::RefCell::new(Vec::new()), slot).await
}

fn with_recorded<R>(use_lines: impl FnOnce(&mut Vec<String>) -> R) -> R {
    let mut use_lines = Some(use_lines);
    if let Ok(result) =
        SLOT.try_with(|lines| (use_lines.take().expect("used once"))(&mut lines.borrow_mut()))
    {
        return result;
    }
    (use_lines.take().expect("used once"))(
        &mut recorded().lock().unwrap_or_else(|error| error.into_inner()),
    )
}

/// Forgets reasons noted before this Attempt began.
pub(crate) fn begin_attempt() {
    with_recorded(Vec::clear);
}

/// The reasons noted since the Attempt began, as failure detail: the latest eight lines, each
/// one line of at most 160 characters. Clears them.
pub(crate) fn take_detail() -> Vec<String> {
    let lines = with_recorded(std::mem::take);
    let skip = lines.len().saturating_sub(MAX_DETAIL);
    lines.into_iter().skip(skip).collect()
}

/// The reasons this slot noted, then those its Worker noted, as one failure detail.
pub(crate) fn merged_detail(worker: Vec<String>) -> Vec<String> {
    let mut lines = take_detail();
    lines.extend(worker);
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
    with_recorded(|recorded| {
        if recorded.last() != Some(&line) {
            recorded.push(line);
        }
        if recorded.len() > MAX_DETAIL {
            recorded.remove(0);
        }
    });
}

/// What a failed Task's result says after `what`, the fixed sentence for the step that failed:
/// the cause of `error` as far as it is safe to show whoever asked (see
/// `supertag_workspaces::failure_cause`), with this host's credentials hidden, and where the full
/// reason is. The Worklet does not know the name `supertag logs` lists it under, so the command
/// is the one that prints every service's log.
pub(crate) fn shown(what: &str, error: &anyhow::Error) -> String {
    shown_cause(what, &supertag_workspaces::failure_cause(error))
}

/// [`shown`], for a cause that is already safe to show.
pub(crate) fn shown_cause(what: &str, cause: &str) -> String {
    let cause = redact_text(cause, &secrets(), false);
    let cause = cause.trim().trim_end_matches('.');
    if cause.is_empty() {
        format!("{what}. Run `supertag logs` on its Worker Host to see why.")
    } else {
        format!("{what}: {cause}. Run `supertag logs` on its Worker Host for the full detail.")
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
    fn a_shown_failure_names_its_cause_and_where_the_detail_is() {
        remember_credential("stcr_shown-failure-secret");
        let error = anyhow::anyhow!("`git ls-tree` output exceeds its 256 MiB size limit").context(
            "list stcr_shown-failure-secret in /Users/someone/.supertag/hosts/laptop/state",
        );
        let shown = shown("Task workspace could not be prepared safely", &error);
        assert!(
            shown.starts_with("Task workspace could not be prepared safely: list "),
            "{shown}"
        );
        assert!(
            shown.ends_with(
                "…/state: `git ls-tree` output exceeds its 256 MiB size limit. Run `supertag logs` on its Worker Host for the full detail."
            ),
            "{shown}"
        );
        assert!(!shown.contains("stcr_shown-failure-secret"), "{shown}");
        assert!(!shown.contains("/Users/someone"), "{shown}");
        assert_eq!(
            shown_cause("Task workspace could not be prepared safely", " "),
            "Task workspace could not be prepared safely. Run `supertag logs` on its Worker Host to see why."
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
