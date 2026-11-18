//! How the adapter treats each notification the Codex app server sends during a turn.
//!
//! Every method in the Codex app server's schema is classified here, and
//! `codex_schema_has_no_unclassified_methods` checks that against the installed Codex, so a new
//! method shows up in CI before a Codex release reaches a host:
//!
//! - **handled**: the adapter acts on it (`app_server::Stream::accept`). Codex must still send it.
//! - **ignored**: reviewed, and restated by an authoritative completed item or the turn's own
//!   result, or about something SuperTag doesn't use. None asks for a reply.
//! - **refused**: reviewed, and the turn fails, because it signals something SuperTag doesn't honour.
//!
//! A method in none of these lists is unknown. One that looks like progress (its last segment is
//! an update, change, delta, or progress report, and nothing in it names an approval, request,
//! result, completion, failure, or error) is logged once and ignored. Any other unknown method
//! fails the turn, so a new kind of result or approval can't pass unseen. Server requests (with
//! an `id`) are separate: an unknown one is refused with an error reply and the turn goes on.

/// Notifications `app_server::Stream::accept` acts on.
pub(crate) const HANDLED: &[&str] = &[
    "error",
    "item/agentMessage/delta",
    "item/completed",
    "item/started",
    "remoteControl/status/changed",
    "thread/started",
    "thread/tokenUsage/updated",
    "turn/completed",
    "turn/moderationMetadata",
    "turn/plan/updated",
    "turn/started",
    "warning",
];

/// Server requests answered other than with a refusal: `item/tool/call` runs SuperTag's tools,
/// and `app_server::Transport::deny_request` declines the two approvals. Checked against the schema.
#[cfg(test)]
const ANSWERED_REQUESTS: &[&str] = &[
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/tool/call",
];

/// Notifications reviewed and ignored by name. Whole namespaces are in [`IGNORED_PREFIXES`].
const IGNORED: &[&str] = &[
    // Restated by the completed item or the turn's result; the Worker Host computes the
    // delivered diff from the checkout itself.
    "turn/diff/updated",
    "item/fileChange/patchUpdated",
    "item/commandExecution/terminalInteraction",
    "item/reasoning/summaryPartAdded",
    "item/mcpToolCall/progress",
    "item/autoApprovalReview/started",
    "item/autoApprovalReview/completed",
    "serverRequest/resolved",
    "command/exec/outputDelta",
    "process/outputDelta",
    "process/exited",
    // Codex's own configuration, tools, and files outside the turn.
    "hook/started",
    "hook/completed",
    "mcpServer/startupStatus/updated",
    "mcpServer/oauthLogin/completed",
    "mcpServer/event/stream/notification",
    "skills/changed",
    "app/list/updated",
    "fs/changed",
    "project/changed",
    "externalAgentConfig/import/progress",
    "externalAgentConfig/import/completed",
    "fuzzyFileSearch/sessionUpdated",
    "fuzzyFileSearch/sessionCompleted",
    "modelProvider/authRecoveryStarted",
    "modelProvider/authRecoveryCompleted",
    "windows/worldWritableWarning",
    "windowsSandbox/setupCompleted",
    // Advisory text for Codex's own interface.
    "deprecationNotice",
    "configWarning",
    "guardianWarning",
    "sessionConfigured",
];

/// Namespaces about the thread, account, model, and configuration, none of which carries a
/// turn's work.
const IGNORED_PREFIXES: &[&str] = &["codex/", "thread/", "account/", "model/", "config/"];

/// Notifications that fail the turn: SuperTag runs with approvals declined and doesn't honour a
/// review requirement it can't see through.
const REFUSED: &[&str] = &["autoApprovalReview/strictReviewRequired"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Kind {
    Handled,
    Ignored,
    Refused,
    /// Unknown, but shaped like progress: logged once and ignored.
    Progress,
    /// Unknown: fails the turn.
    Unknown,
}

pub(crate) fn classify(method: &str) -> Kind {
    if HANDLED.contains(&method) {
        Kind::Handled
    } else if REFUSED.contains(&method) {
        Kind::Refused
    } else if IGNORED.contains(&method)
        || IGNORED_PREFIXES
            .iter()
            .any(|prefix| method.starts_with(prefix))
        || streamed_item_delta(method)
    {
        Kind::Ignored
    } else if progress(method) {
        Kind::Progress
    } else {
        Kind::Unknown
    }
}

/// A method name short and plain enough to repeat in a log line or an error.
pub(crate) fn plain(method: &str) -> bool {
    method.len() <= 128
        && method
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'_'))
}

/// A streamed fragment of an item, such as `item/agentMessage/delta` or
/// `item/commandExecution/outputDelta`. The completed item is authoritative.
fn streamed_item_delta(method: &str) -> bool {
    method.starts_with("item/") && (method.ends_with("/delta") || method.ends_with("Delta"))
}

/// Shaped like a progress report: its last segment updates, changes, or streams something, and
/// nothing in it names an approval, request, result, completion, failure, or error.
fn progress(method: &str) -> bool {
    if !plain(method) {
        return false;
    }
    let Some((_, last)) = method.rsplit_once('/') else {
        return false;
    };
    let last = last.to_ascii_lowercase();
    let lower = method.to_ascii_lowercase();
    ["updated", "changed", "delta", "progress"]
        .iter()
        .any(|suffix| last.ends_with(suffix))
        && ![
            "approv", "request", "result", "complet", "fail", "error", "denied", "review",
        ]
        .iter()
        .any(|word| lower.contains(word))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_known_methods_and_unknown_progress() {
        for method in [
            "turn/completed",
            "item/completed",
            "error",
            "item/agentMessage/delta",
        ] {
            assert_eq!(classify(method), Kind::Handled, "{method}");
        }
        for method in [
            "turn/diff/updated",
            "item/commandExecution/outputDelta",
            "item/reasoning/summaryTextDelta",
            "thread/status/changed",
            "serverRequest/resolved",
        ] {
            assert_eq!(classify(method), Kind::Ignored, "{method}");
        }
        assert_eq!(
            classify("autoApprovalReview/strictReviewRequired"),
            Kind::Refused
        );
        // A future Codex's progress degrades to a log line.
        for method in [
            "turn/summary/updated",
            "item/webSearch/progress",
            "item/fileChange/statusChanged",
            "turn/usage/delta",
        ] {
            assert_eq!(classify(method), Kind::Progress, "{method}");
        }
        // Anything that could carry a result or an approval still fails the turn.
        for method in [
            "turn/finished",
            "turn/result/updated",
            "item/approval/updated",
            "item/review/changed",
            "turn/failed",
            "item/output/completed",
            "item/errorDelta/updated",
            "newThing",
        ] {
            assert_eq!(classify(method), Kind::Unknown, "{method}");
        }
    }

    fn schema_methods(directory: &std::path::Path, file: &str) -> Vec<String> {
        let schema: serde_json::Value =
            serde_json::from_slice(&std::fs::read(directory.join(file)).unwrap()).unwrap();
        schema["oneOf"]
            .as_array()
            .unwrap_or_else(|| panic!("{file} has no oneOf"))
            .iter()
            .map(|variant| {
                variant["properties"]["method"]["enum"][0]
                    .as_str()
                    .unwrap_or_else(|| panic!("{file}: a variant without a method"))
                    .to_owned()
            })
            .collect()
    }

    /// Run by Core CI against the pinned Codex, and weekly against the latest release
    /// (`.github/workflows/codex-drift.yml`).
    #[test]
    #[ignore = "requires SUPERTAG_TEST_CODEX_BINARY; reads the installed Codex app server's schema"]
    fn codex_schema_has_no_unclassified_methods() {
        let codex =
            std::env::var_os("SUPERTAG_TEST_CODEX_BINARY").expect("set SUPERTAG_TEST_CODEX_BINARY");
        let directory = tempfile::tempdir().unwrap();
        let generated = std::process::Command::new(&codex)
            .args(["app-server", "generate-json-schema", "--out"])
            .arg(directory.path())
            .output()
            .unwrap();
        assert!(
            generated.status.success(),
            "codex app-server generate-json-schema failed: {}",
            String::from_utf8_lossy(&generated.stderr)
        );
        let notifications = schema_methods(directory.path(), "ServerNotification.json");
        let requests = schema_methods(directory.path(), "ServerRequest.json");
        let unclassified: Vec<_> = notifications
            .iter()
            .filter(|method| matches!(classify(method), Kind::Progress | Kind::Unknown))
            .collect();
        assert!(
            unclassified.is_empty(),
            "classify these Codex notifications in codex-adapter/src/notifications.rs: {unclassified:?}"
        );
        let gone: Vec<_> = HANDLED
            .iter()
            .filter(|method| !notifications.iter().any(|known| known == *method))
            .collect();
        assert!(
            gone.is_empty(),
            "Codex no longer sends these handled notifications: {gone:?}"
        );
        let gone: Vec<_> = ANSWERED_REQUESTS
            .iter()
            .filter(|method| !requests.iter().any(|known| known == *method))
            .collect();
        assert!(
            gone.is_empty(),
            "Codex no longer sends these answered requests: {gone:?}"
        );
    }
}
