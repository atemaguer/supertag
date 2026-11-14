//! Why this host could not confirm an Attempt's cleanup, told to the Control Plane.
//!
//! TypeScript parity: the redacted `ExecutionCleanupError` evidence a Worker records with an
//! uncertain Attempt (`tests/durable-cleanup-unknown.test.ts`): at most eight causes of at most 160
//! characters, with the values only this host knows redacted before anything leaves it: its
//! credential variables and credential, the Attempt's lease token, and, when the adapter run
//! failed, the adapter's bootstrap token and the Attempt's resolved MCP credentials (TypeScript's
//! runtime-input values). The Control Plane stores them for the Task execution report and shows
//! them in `supertag get task`.
//!
//! Difference: TypeScript also keeps the causes of an execution error that preceded the cleanup
//! failure. A Rust Attempt's execution failure is its harness result, not an error, so the reasons
//! are the cleanup error's causes alone.
use std::time::Duration;

use supertag_protocol::{
    authenticated_request,
    redaction::{SensitiveValue, redact_text},
    v2::ReportCleanupFailureRequest,
};

use crate::{RegisteredHost, journal::Attempt};

const MAX_REASONS: usize = 8;
const MAX_REASON_CHARS: usize = 160;

/// Marks an error after which this host cannot prove the Attempt's execution stopped, with the
/// Attempt's own values to redact from its causes. Only the outermost marker counts.
#[derive(Debug, Default)]
pub(crate) struct CleanupUnconfirmed {
    secrets: Vec<SensitiveValue>,
}

impl CleanupUnconfirmed {
    pub(crate) fn redacting(secrets: Vec<SensitiveValue>) -> Self {
        Self { secrets }
    }
}

impl std::fmt::Display for CleanupUnconfirmed {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .write_str("Execution cleanup could not be confirmed; execution remains uncertain.")
    }
}

/// The error's causes, outermost first, each redacted with `secrets` and then bounded, so a cut
/// can never leave part of a secret.
pub(crate) fn reasons(error: &anyhow::Error, secrets: &[SensitiveValue]) -> Vec<String> {
    let marker = CleanupUnconfirmed::default().to_string();
    let mut reasons: Vec<String> = Vec::new();
    for cause in error.chain() {
        if cause.to_string() == marker {
            continue;
        }
        let line = cause
            .to_string()
            .chars()
            .map(|character| {
                if character.is_control() {
                    ' '
                } else {
                    character
                }
            })
            .collect::<String>();
        let redacted = redact_text(line.trim(), secrets, false);
        let reason: String = redacted.trim().chars().take(MAX_REASON_CHARS).collect();
        if reason.is_empty() || reasons.last() == Some(&reason) {
            continue;
        }
        reasons.push(reason);
        if reasons.len() == MAX_REASONS {
            break;
        }
    }
    if reasons.is_empty() {
        reasons.push(CleanupUnconfirmed::default().to_string());
    }
    reasons
}

/// The values `error`'s reasons must not carry: this host's, the Attempt's lease token, and those
/// its marker names.
fn secrets(error: &anyhow::Error, host_token: &str, lease_token: &str) -> Vec<SensitiveValue> {
    let mut secrets = crate::adapter::host_secrets(&[host_token, lease_token]);
    if let Some(marker) = error.downcast_ref::<CleanupUnconfirmed>() {
        secrets.extend(marker.secrets.iter().cloned());
    }
    secrets
}

/// Best effort: the host is about to stop on this error, and the Attempt stays uncertain whether
/// or not the Control Plane records why.
pub(crate) async fn report(
    host: &mut RegisteredHost,
    attempt: &Attempt,
    token: &str,
    error: &anyhow::Error,
) {
    let message = ReportCleanupFailureRequest {
        attempt: Some(attempt.inspect()),
        reasons: reasons(error, &secrets(error, token, &attempt.lease_token)),
    };
    let Ok(mut request) = authenticated_request(message, token, None) else {
        return;
    };
    request.set_timeout(Duration::from_secs(5));
    if host.report_cleanup_failure(request).await.is_err() {
        supertag_protocol::terminal_text::warn(&format!(
            "Task {} Attempt {}: the Control Plane did not record why cleanup could not be confirmed",
            attempt.task_id, attempt.attempt_id
        ));
    }
}

#[cfg(test)]
mod tests {
    use anyhow::anyhow;

    use super::*;

    #[test]
    fn redacts_host_resolved_values_before_bounding_each_cause() {
        let secret = "host-resolved-private-value";
        let error = anyhow!("Process tree holding {secret} did not exit")
            .context(format!(
                "Close refused {} {secret} {}",
                "x".repeat(130),
                "y".repeat(500)
            ))
            .context("adapter process group did not stop\nwith a second line")
            .context(CleanupUnconfirmed::default());
        let reasons = reasons(&error, &[SensitiveValue::High(secret.into())]);
        assert_eq!(
            reasons[0],
            "adapter process group did not stop with a second line"
        );
        assert!(reasons[1].starts_with("Close refused xxx"));
        assert_eq!(reasons[1].chars().count(), 160);
        assert_eq!(reasons[2], "Process tree holding [REDACTED] did not exit");
        assert!(
            reasons
                .iter()
                .all(|reason| !reason.contains("host-resolved"))
        );
        // Explicit credentials are hidden even when the host did not know them.
        let url = anyhow!("fetch https://user:pass-word@example.test/x failed");
        assert_eq!(
            super::reasons(&url, &[]),
            ["fetch https://[REDACTED]@example.test/x failed"]
        );
    }

    #[test]
    fn redacts_the_values_the_adapter_run_marked() {
        let error = anyhow!("MCP server rejected mcp-credential-1234 and bootstrap-5678")
            .context(CleanupUnconfirmed::redacting(vec![
                SensitiveValue::High("mcp-credential-1234".into()),
                SensitiveValue::High("bootstrap-5678".into()),
            ]))
            .context("Task t Attempt a needs recovery with lease-9012");
        let secrets = secrets(&error, "host-token-3456", "lease-9012");
        assert_eq!(
            reasons(&error, &secrets),
            [
                "Task t Attempt a needs recovery with [REDACTED]",
                "MCP server rejected [REDACTED] and [REDACTED]",
            ]
        );
    }

    #[test]
    fn keeps_at_most_eight_causes() {
        let mut error = anyhow!("cause 0");
        for index in 1..20 {
            error = error.context(format!("cause {index}"));
        }
        let reasons = reasons(&error, &[]);
        assert_eq!(reasons.len(), 8);
        assert_eq!(reasons[0], "cause 19");
        let only_marker =
            anyhow!(CleanupUnconfirmed::default()).context(CleanupUnconfirmed::default());
        assert!(only_marker.downcast_ref::<CleanupUnconfirmed>().is_some());
        assert_eq!(
            super::reasons(&only_marker, &[]),
            [CleanupUnconfirmed::default().to_string()]
        );
    }
}
