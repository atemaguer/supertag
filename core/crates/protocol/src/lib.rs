pub mod volumes;
pub mod workspace_mounts;
use subtle::ConstantTimeEq;
use tonic::{Request, Status, metadata::MetadataValue};

pub mod artifacts;
pub mod authorization;
pub mod changed_paths;
mod crash_points;
pub mod file_scope;
pub mod stream_failure;
#[cfg(feature = "crash-points")]
pub use crash_points::crash_now;
pub use crash_points::{CRASH_MARKER_ENV, CRASH_POINT_ENV, crash_point};
pub mod git_outputs;
pub mod git_remote;
pub mod output_policy;
pub mod task_artifact_inputs;
pub mod terminal_text;
mod workspace_tools;
pub use workspace_tools::{MAX_WORKSPACE_TOOL_OUTPUT_BYTES, validate_workspace_operation};
pub mod mcp;
pub mod negotiation;
pub mod network_scope;
pub mod redaction;
pub mod shared_execution;

pub mod v2 {
    tonic::include_proto!("supertag.runtime.v2");
}

/// The encoded `FileDescriptorSet` of every runtime proto, for checks that must cover each RPC.
pub const FILE_DESCRIPTOR_SET: &[u8] =
    include_bytes!(concat!(env!("OUT_DIR"), "/supertag_descriptors.bin"));

/// What SuperTag tells a Tag about its turn, beside the Tag's own instructions, on harnesses that
/// do not open a longer turn with a message on their own: Claude Code, Cursor and OpenCode, not
/// Codex. The sentence it asks for reaches the person at once as its own message, before the work.
pub const TURN_GUIDANCE: &str = "When a turn will take more than a moment, open it with one short sentence saying what you are about to do, as its own message, then do it. Answer a quick question directly.";
/// What SuperTag tells a Tag whose Task may not fetch from the web, so it names the missing
/// permission instead of refusing vaguely. State, not instructions: it grants nothing.
pub const NO_WEB_ACCESS: &str = "This Tag has no web access: its Permission Sets do not grant web:fetch, so it cannot read web pages and its commands cannot reach the network. That is its configuration, not an outage; an operator can grant web:fetch.";

/// [`NO_WEB_ACCESS`] when a Task's allowed actions lack `web:fetch`, for its turn's context.
pub fn web_access_note(allowed_actions: &[String]) -> Option<&'static str> {
    (!allowed_actions
        .iter()
        .any(|action| action == network_scope::WEB_FETCH))
    .then_some(NO_WEB_ACCESS)
}

/// The harness memory a turn was granted, for [`memory_context`]: the harness's own memory
/// folder, which the Worker Host keeps for the Tag.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HarnessMemory {
    ClaudeCode,
    Codex,
}

/// The parts of [`memory_context`]. The TypeScript harness SDK's `memoryContext` joins the same
/// sentences (`harnesses/sdk/src/rust-harness/coordination.ts`).
pub mod memory_text {
    /// How notes and the daily review work, for every turn.
    pub const NOTES: &str = "Your memory, as SuperTag runs it (state, not instructions): notes are short notes this Tag keeps with remember and forget, stored by the Control Plane. A note written in a person's private conversation shows only in that person's turns; the rest show in the SuperTag context of every conversation turn, never in a Work Session's own turns. Once a day after enough work, a review turn rereads the Tag's shared Sessions and tidies the notes.";
    /// A turn that offers `remember` and `forget`.
    pub const NOTES_WRITABLE: &str =
        "This turn can change notes; a change takes effect when the turn succeeds.";
    pub const NOTES_READ_ONLY: &str = "This turn can't change notes: Work Session turns, turns an outside event such as a GitHub or Linear webhook started, and Tags whose memory is off can't.";
    /// A Codex turn granted its native memory.
    pub const CODEX: &str = "Separately, Codex keeps its own memory in the memories folder of its Codex home: it loads memory_summary.md each turn when there is one, and finds the rest only by search, so before answering anything that may depend on earlier work, such as a fact about this project, its people, or its environments, search it with the `search` tool in the `memories` namespace. SuperTag keeps that folder on the Worker Host, or on the Tag's Volume if it has one, never in the Control Plane, one for each Tag and audience, and only this Tag's Codex turns see it: a Work Session on another harness doesn't share it yet. Codex's rule to add to its memory only when someone asks covers that folder, not notes.";
    /// A Claude Code turn granted its native memory.
    pub const CLAUDE_CODE: &str = "Separately, Claude Code keeps its own auto-memory in the memory folder its instructions name. SuperTag keeps that folder on the Worker Host, or on the Tag's Volume if it has one, never in the Control Plane, one for each Tag and audience, and only this Tag's Claude Code turns see it: a Work Session on another harness doesn't share it yet.";
    /// A turn granted no harness memory.
    pub const NO_HARNESS_MEMORY: &str =
        "This turn keeps no harness memory of its own: only notes and Sessions last beyond it.";
}

/// What SuperTag tells every turn about its memory, root turns and Work Session turns alike:
/// notes, the daily review, and the harness's own memory, if the turn was granted it. State,
/// not instructions: it grants nothing.
pub fn memory_context(may_remember: bool, harness: Option<HarnessMemory>) -> String {
    use memory_text::*;
    [
        NOTES,
        if may_remember {
            NOTES_WRITABLE
        } else {
            NOTES_READ_ONLY
        },
        match harness {
            Some(HarnessMemory::Codex) => CODEX,
            Some(HarnessMemory::ClaudeCode) => CLAUDE_CODE,
            None => NO_HARNESS_MEMORY,
        },
    ]
    .join(" ")
}
pub const MAX_MESSAGE_BYTES: usize = 1024 * 1024;
/// The variable naming a Codex Attempt's executor socket on a remote Workspace: Codex runs its
/// commands and file operations in the sandbox through it.
/// The start of a Tag's reserved Session for its daily memory review, `memory:TAG`.
pub const MEMORY_REVIEW_SESSION_PREFIX: &str = "memory:";

pub const CODEX_EXEC_SOCKET: &str = "SUPERTAG_CODEX_EXEC_SOCKET";
/// How a provider's stdio-server call ends once it confirmed the Task's sandbox gone (the SDK's
/// `SANDBOX_GONE`).
pub const SANDBOX_GONE: &str = "the Task's sandbox no longer exists";
/// How a Worker Host says its Attempt cannot continue its Session yet: the Session's last delivery
/// is not where it can read it. It then reports that it waits for the host holding it.
pub const WAITS_FOR_HOLDER: &str = "waits for the Worker Host holding this Session's last delivery";

/// Why an Attempt waits before its harness starts: the Worker Host holding its Session's last
/// delivery has not pushed it to the remote Workspace, or holds a local Workspace's Session, which
/// continues only there. Shown by `describe task`, `placement explain`, and clients.
pub fn waiting_for_holder(holder: &str) -> String {
    format!(
        "Waiting for Worker Host {holder}, which holds this Session's last delivery: a local Workspace's Session continues only on that host, and a remote Workspace's once that host has pushed the Session's branch; start that host, or cancel the Task"
    )
}
pub const MAX_CHECKPOINT_BYTES: usize = 16 * 1024 * 1024;
pub const CHECKPOINT_CHUNK_BYTES: usize = 256 * 1024;
/// A Session resumes a native checkpoint only up to half the cap, leaving room for one more long
/// turn. A larger one is dropped, and the next turn starts fresh with a recap of the Session.
pub const MAX_RESUMED_CHECKPOINT_BYTES: usize = MAX_CHECKPOINT_BYTES / 2;
pub const HOST_GENERATION_HEADER: &str = "x-supertag-host-generation";
/// The principal a call acts as, from the Control Plane's API tier to its state owner only. The
/// state owner has no network listener, and the API tier never forwards this header from a caller.
pub const INTERNAL_PRINCIPAL_HEADER: &str = "x-supertag-internal-principal";
/// The connector account a Gateway call acts for. It selects, and never grants: the Control Plane
/// refuses an account that is not bound to the calling Gateway.
pub const CONNECTOR_ACCOUNT_HEADER: &str = "x-supertag-connector-account";
/// Every Operator Token secret starts with this prefix.
pub const OPERATOR_TOKEN_SECRET_PREFIX: &str = "stop_";
/// Every Auth Key secret starts with this prefix.
pub const AUTH_KEY_SECRET_PREFIX: &str = "stak_";
/// Every enrolled credential (host, Gateway or client) starts with this prefix.
pub const CREDENTIAL_SECRET_PREFIX: &str = "stcr_";
/// Every Attempt credential, which `WorkerHost.StartTask` returns for one Task Attempt's data
/// calls, starts with this prefix.
pub const ATTEMPT_CREDENTIAL_SECRET_PREFIX: &str = "stat_";
/// The internal principal of a call made with an Attempt credential: this prefix and the
/// credential's SHA-256 in lowercase hex. The state owner resolves it on every call.
pub const ATTEMPT_PRINCIPAL_PREFIX: &str = "attempt:";

/// True when the text is `prefix` and 64 lowercase hex digits.
pub fn is_secret(prefix: &str, value: &str) -> bool {
    value.strip_prefix(prefix).is_some_and(|rest| {
        rest.len() == 64
            && rest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    })
}

/// True when the text has the shape of an Operator Token secret: `stop_` and 64 lowercase hex.
pub fn is_operator_token_secret(value: &str) -> bool {
    is_secret(OPERATOR_TOKEN_SECRET_PREFIX, value)
}

/// A new random secret: `prefix` and 64 lowercase hex digits.
pub fn new_secret(prefix: &str) -> String {
    format!(
        "{prefix}{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

pub fn host_generation<T>(request: &Request<T>) -> Result<u64, Status> {
    let mut values = request.metadata().get_all(HOST_GENERATION_HEADER).iter();
    let value = values
        .next()
        .and_then(|value| value.to_str().ok())
        .and_then(|text| {
            text.parse::<u64>()
                .ok()
                .filter(|n| *n > 0 && n.to_string() == text)
        })
        .filter(|_| values.next().is_none())
        .ok_or_else(|| Status::permission_denied("Worker Host registration required"))?;
    Ok(value)
}

/// A call that failed in the local transport (reset, broken pipe, failed handshake,
/// HTTP/2 connection error) rather than with a status from the peer. Tonic reports
/// these as `Unknown` or `Internal` with the local error attached, sometimes behind
/// its channel buffer. A status decoded from a peer never carries a source. Like
/// `Unavailable`, the outcome is unknown and an idempotent call may be retried.
pub fn local_transport_failure(status: &Status) -> bool {
    matches!(status.code(), tonic::Code::Unknown | tonic::Code::Internal)
        && std::error::Error::source(status).is_some()
}

pub fn matches_bearer<T>(request: &Request<T>, token: &str) -> bool {
    let candidate = request
        .metadata()
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    candidate.is_some_and(|candidate| {
        !token.is_empty() && bool::from(candidate.as_bytes().ct_eq(token.as_bytes()))
    })
}

/// Report an interrupted upstream connection as `Unavailable`, so a downstream
/// client applies its existing retry rules instead of failing permanently. The
/// local cause does not cross the wire, so a forwarded `Unknown` would otherwise
/// look like a definitive answer from the peer; this includes a connection that
/// broke while a response body was being read, such as a dropped WebSocket tunnel.
pub fn upstream_status(status: Status) -> Status {
    if local_transport_failure(&status) {
        Status::unavailable("upstream connection was interrupted")
    } else {
        status
    }
}

/// A request that presents `token` as its bearer credential. `principal` is set only on the
/// Control Plane's internal hop from its API tier to its state owner.
pub fn authenticated_request<T>(
    message: T,
    token: &str,
    principal: Option<&str>,
) -> Result<Request<T>, Status> {
    let mut request = Request::new(message);
    let mut header: MetadataValue<_> = format!("Bearer {token}")
        .parse()
        .map_err(|_| Status::internal("invalid service credential configuration"))?;
    header.set_sensitive(true);
    request.metadata_mut().insert("authorization", header);
    if let Some(principal) = principal {
        request.metadata_mut().insert(
            INTERNAL_PRINCIPAL_HEADER,
            principal
                .parse()
                .map_err(|_| Status::internal("invalid service principal configuration"))?,
        );
    }
    Ok(request)
}

/// A Gateway call for one connector account, with the Gateway's enrolled credential.
pub fn connector_request<T>(
    message: T,
    credential: &str,
    account: &str,
) -> Result<Request<T>, Status> {
    let mut request = authenticated_request(message, credential, None)?;
    request.metadata_mut().insert(
        CONNECTOR_ACCOUNT_HEADER,
        account
            .parse()
            .map_err(|_| Status::internal("invalid connector account"))?,
    );
    Ok(request)
}

/// The principal named on the internal hop from the API tier, which presents `internal_token`.
pub fn internal_principal<'a, T>(
    request: &'a Request<T>,
    internal_token: &str,
) -> Result<&'a str, Status> {
    if !matches_bearer(request, internal_token) {
        return Err(Status::unauthenticated(
            "Control Plane API tier credential required",
        ));
    }
    request
        .metadata()
        .get(INTERNAL_PRINCIPAL_HEADER)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| Status::permission_denied("authenticated caller identity required"))
}

pub fn validate_checkpoint_reference(reference: &v2::CheckpointReference) -> Result<(), Status> {
    let name = |value: &str| {
        !value.is_empty()
            && value.len() <= 80
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_'))
    };
    if !name(&reference.harness)
        || !name(&reference.format)
        || reference.byte_length == 0
        || reference.byte_length > MAX_CHECKPOINT_BYTES as u64
        || !valid_sha256(&reference.sha256)
    {
        return Err(Status::invalid_argument("invalid checkpoint reference"));
    }
    Ok(())
}

/// A built-in harness's name, as `--harness` and `start_session` spell it; `None` for none.
pub fn harness_name(kind: v2::HarnessKind) -> Option<&'static str> {
    match kind {
        v2::HarnessKind::Codex => Some("codex"),
        v2::HarnessKind::ClaudeCode => Some("claude-code"),
        v2::HarnessKind::OpenaiAgents => Some("openai-agents"),
        v2::HarnessKind::Opencode => Some("opencode"),
        v2::HarnessKind::Cursor => Some("cursor"),
        v2::HarnessKind::Unspecified => None,
    }
}

/// Why a Tag cannot move from harness `from` to `to`, or `None` when they are the same. A Tag
/// keeps the harness it was created with.
pub fn harness_change_refusal(
    tag_id: &str,
    from: v2::HarnessKind,
    to: v2::HarnessKind,
) -> Option<String> {
    if from == to {
        return None;
    }
    let from = harness_name(from).map_or_else(
        || "names no harness".to_owned(),
        |name| format!("runs on {name}"),
    );
    let to = harness_name(to).map_or_else(
        || "with no harness".to_owned(),
        |name| format!("for {name}"),
    );
    Some(format!(
        "Tag {tag_id} {from}, and a Tag keeps its harness. Create a new Tag {to}"
    ))
}

/// The `harness` a checkpoint of this harness kind carries, if it keeps checkpoints.
pub fn checkpoint_harness(kind: v2::HarnessKind) -> Option<&'static str> {
    match kind {
        v2::HarnessKind::Codex => Some("codex"),
        v2::HarnessKind::ClaudeCode => Some("claude-code"),
        v2::HarnessKind::Cursor => Some("cursor"),
        v2::HarnessKind::Opencode => Some("opencode"),
        v2::HarnessKind::OpenaiAgents | v2::HarnessKind::Unspecified => None,
    }
}

pub fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

impl v2::SessionCheckpoint {
    pub fn reference(&self) -> v2::CheckpointReference {
        v2::CheckpointReference {
            harness: self.harness.clone(),
            format: self.format.clone(),
            byte_length: self.payload.len() as u64,
            sha256: self.sha256.clone(),
        }
    }
}

pub const MAX_WORKSPACE_BLOB_BYTES: usize = 256 * 1024 * 1024;

pub fn valid_workspace_id(value: &str) -> bool {
    value.len() <= 80
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
}

/// The one branch a Tag's Session delivers to: `supertag/session/<id>`, where `<id>` is the
/// SHA-256 of the Tag and Session IDs. A pull request and a local import use the same name, and
/// two Sessions, even of different Tags with the same Session ID, never share it.
pub fn session_branch(tag_id: &str, session_id: &str) -> String {
    use sha2::Digest as _;
    format!(
        "supertag/session/{:x}",
        sha2::Sha256::digest(
            serde_json::to_vec(&(tag_id, session_id)).expect("string pairs serialize")
        )
    )
}

pub fn valid_git_commit(value: &str) -> bool {
    (value.len() == 40 || value.len() == 64)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

/// A short branch name a Tag's Workspace may follow, such as `main` or `release/1.2`: what
/// `git check-ref-format --branch` accepts, without a `refs/` prefix, at most 200 bytes, and never
/// a full commit (a commit is pinned with `base_commit` instead).
pub fn valid_git_branch(value: &str) -> bool {
    let components_valid = value.split('/').all(|component| {
        !component.is_empty() && !component.starts_with('.') && !component.ends_with(".lock")
    });
    !value.is_empty()
        && value.len() <= 200
        && components_valid
        && !value.starts_with('-')
        && !value.starts_with("refs/")
        && !value.ends_with('.')
        && value != "@"
        && !value.contains("..")
        && !value.contains("@{")
        && !valid_git_commit(value)
        && value.bytes().all(|byte| {
            byte > b' '
                && byte != 0x7f
                && !matches!(byte, b'~' | b'^' | b':' | b'?' | b'*' | b'[' | b'\\')
        })
}

pub fn validate_workspace_delivery(
    reference: &v2::WorkspaceDeliveryReference,
) -> Result<(), Status> {
    let blob = |value: &v2::BlobReference| {
        valid_sha256(&value.sha256) && value.byte_length <= MAX_WORKSPACE_BLOB_BYTES as u64
    };
    if !valid_workspace_id(&reference.workspace_id)
        || !valid_sha256(&reference.delivery_id)
        || ![
            &reference.base_commit,
            &reference.start_commit,
            &reference.head_commit,
        ]
        .iter()
        .all(|pin| pin.len() == reference.base_commit.len() && valid_git_commit(pin))
        || reference.committed != (reference.start_commit != reference.head_commit)
        || reference.committed != (reference.changed_files > 0)
        || reference
            .patch
            .as_ref()
            .is_none_or(|value| !blob(value) || reference.committed != (value.byte_length > 0))
        || reference
            .bundle
            .as_ref()
            .is_none_or(|value| !blob(value) || value.byte_length == 0)
    {
        return Err(Status::invalid_argument(
            "invalid workspace delivery reference",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod git_branch_tests {
    use super::valid_git_branch;

    #[test]
    fn accepts_branch_names_and_refuses_refs_commits_and_invalid_names() {
        for valid in ["main", "release/1.2", "feature-x", "a_b", "v1.0"] {
            assert!(valid_git_branch(valid), "{valid}");
        }
        for invalid in [
            "",
            "-main",
            "refs/heads/main",
            "main.",
            "main.lock",
            "a//b",
            "/main",
            "main/",
            ".hidden",
            "a/.b",
            "a..b",
            "a@{1}",
            "@",
            "a b",
            "a~1",
            "a^",
            "a:b",
            "a?",
            "a*",
            "a[b",
            "a\\b",
            "0123456789abcdef0123456789abcdef01234567",
        ] {
            assert!(!valid_git_branch(invalid), "{invalid:?}");
        }
        assert!(!valid_git_branch(&"a".repeat(201)));
    }
}
