//! Who may call each RPC of the runtime protocol: the one default-deny table the Control Plane's
//! authorization layer enforces, and that a Gateway reads to decide which calls it forwards.
//!
//! A method missing from the table is refused, and a test fails when any RPC in the compiled
//! descriptors lacks an entry, so a new RPC cannot ship unclassified.

/// The gRPC path prefix of the runtime protocol's services.
pub const PACKAGE: &str = "/supertag.runtime.v2.";
/// The protocol negotiation service's path prefix; it carries no credential.
pub const NEGOTIATION_PATH: &str = "/supertag.runtime.v2.ProtocolNegotiation/";
/// The gRPC health service's path prefix.
pub const HEALTH_PATH: &str = "/grpc.health.v1.Health/";

pub const ADMIN: u16 = 1;
pub const OPERATOR: u16 = 1 << 1;
pub const GATEWAY: u16 = 1 << 2;
pub const HOST: u16 = 1 << 3;
pub const CLIENT: u16 = 1 << 4;
/// No credential: protocol negotiation.
pub const OPEN: u16 = 1 << 5;
/// An Auth Key as the bearer: enrollment only.
pub const ENROLL: u16 = 1 << 6;
/// Served by the state owner to the API tier only; never on the public listener.
pub const INTERNAL: u16 = 1 << 7;
/// Served by a Worker Host or Gateway on its own listener; never by the Control Plane.
pub const PEER_LOCAL: u16 = 1 << 8;

const O: u16 = OPERATOR;
const OC: u16 = OPERATOR | CLIENT;
const ANY: u16 = OPERATOR | GATEWAY | HOST | CLIENT;

/// Every RPC of the runtime protocol and who may call it on the Control Plane's public listener.
/// `*` covers every method of a service that has no exact entry. A `*` entry never admits a
/// client: each method a client may call is listed by name. See
/// contributing/auth-key-roles-design.md, section 4.
pub const TABLE: &[(&str, &str, u16)] = &[
    ("ProtocolNegotiation", "*", OPEN),
    // Operator Tokens and audit.
    ("OperatorAccess", "*", ADMIN),
    ("OperatorAccess", "ListAuditEntries", O),
    // Enrollment.
    ("Enrollments", "Enroll", ENROLL),
    ("Enrollments", "WhoAmI", ANY),
    ("Enrollments", "RotateCredential", ANY),
    ("Enrollments", "*", O),
    ("AuthKeys", "*", O),
    ("CredentialDirectory", "*", INTERNAL),
    // Fleet, configuration, recovery.
    ("Operator", "*", O),
    ("Operator", "GetTag", OC),
    ("Operator", "ListTags", OC),
    ("Operator", "GetTask", OC),
    ("Operator", "GetSessionDelivery", OC),
    ("Operator", "ListNativeUsage", OC),
    ("Operator", "ListEvents", OC),
    ("Operator", "CancelTask", OC),
    ("Placement", "*", O),
    ("PolicyCatalog", "*", O),
    ("SurfacePolicyCatalog", "*", O),
    ("ManifestRelationships", "*", O),
    // Manifest field ownership and `--force-conflicts`: an operator's apply, never a client's.
    ("ManifestRelationships", "ReconcileManifestFields", O),
    ("Teams", "*", O),
    ("Teams", "GetTeam", OC),
    ("Teams", "ListTeams", OC),
    ("Mailbox", "*", O),
    ("GithubWorkspaces", "*", O),
    ("GithubPublications", "*", O),
    ("WorkspaceVolumes", "*", O),
    ("ArtifactVolumes", "*", O),
    ("ArtifactPublications", "*", O),
    ("Spend", "*", O),
    ("Metrics", "*", O),
    // Conversations and own work. Every client method is listed by name, so a new method on
    // these services is operator-only until it is classified.
    ("Conversations", "*", O),
    ("Conversations", "ListConversations", OC),
    ("Conversations", "ListMessages", OC),
    ("Conversations", "SendMessage", OC),
    ("Conversations", "GetMessage", OC),
    ("Conversations", "MarkConversationRead", OC),
    ("Conversations", "FollowConversation", OC),
    ("Objectives", "*", O),
    ("Objectives", "CreateObjective", OC),
    ("Objectives", "GetObjective", OC),
    ("Objectives", "ListObjectives", OC),
    ("Objectives", "ListCommitReviews", OC),
    ("Objectives", "PauseObjective", OC),
    ("Objectives", "ResumeObjective", OC),
    ("Objectives", "CancelObjective", OC),
    ("Objectives", "ReviewObjective", OC),
    ("Objectives", "CompleteObjective", OC),
    // A client sees and changes the Schedules of its own conversations.
    ("Schedules", "*", O),
    ("Schedules", "Create", OC),
    ("Schedules", "Get", OC),
    ("Schedules", "List", OC),
    ("Schedules", "Pause", OC),
    ("Schedules", "Resume", OC),
    ("Schedules", "Delete", OC),
    // A client lists and deletes the shared notes and its own conversations' notes.
    ("Memories", "*", O),
    ("Memories", "List", OC),
    ("Memories", "Get", OC),
    ("Memories", "Delete", OC),
    // A network log names the origins and paths of other people's Tasks.
    ("NetworkLogs", "List", O),
    ("ObjectiveOverviews", "*", O),
    ("ObjectiveOverviews", "GetObjectiveOverview", OC),
    ("OperatorEvents", "*", O),
    ("OperatorEvents", "Watch", OC),
    ("LiveInputs", "*", O),
    ("LiveInputs", "QueueInput", OC),
    ("LiveInputs", "GetInput", OC),
    ("LiveInputs", "ResolveInput", OC),
    ("WorkSessions", "*", O),
    ("WorkSessions", "Get", OC),
    ("WorkSessions", "List", OC),
    ("WorkSessions", "Close", OC),
    ("ArtifactCatalog", "*", O),
    ("ArtifactCatalog", "Get", OC),
    ("ArtifactCatalog", "List", OC),
    ("ArtifactTransfers", "DownloadFile", OC),
    ("Inbox", "*", O),
    ("Inbox", "ListItems", OC),
    ("Inbox", "GetQuestion", OC),
    ("Inbox", "AnswerQuestion", OC),
    ("Inbox", "GetApproval", OC),
    ("Inbox", "ListApprovals", OC),
    ("Inbox", "DecideApproval", OC),
    // Execution.
    ("WorkerHost", "*", HOST),
    // A restarted host reclaiming an Attempt it proved stopped, and the limits its adapter
    // confirmed: only the Worker Host that holds the Attempt.
    ("WorkerHost", "ReclaimAttempt", HOST),
    ("WorkerHost", "ReportAppliedLimits", HOST),
    ("WorkerHost", "ReportCleanupFailure", HOST),
    ("WorkerHost", "ReportNetworkLog", HOST),
    ("AttemptInputs", "*", HOST),
    ("AttemptWorkstreams", "*", HOST),
    ("AttemptMailbox", "*", HOST),
    // A root turn reads its own Tag's Sessions and Objectives through its Worker Host.
    ("AttemptTagSessions", "*", HOST),
    ("AttemptSchedules", "*", HOST),
    ("AttemptMemory", "*", HOST),
    ("AttemptWorkSessions", "*", HOST),
    ("AttemptMcpEffects", "*", HOST),
    ("AttemptChangedPaths", "*", HOST),
    ("AttemptEffects", "*", HOST),
    ("AttemptWorkspaceMounts", "*", HOST),
    // A read-write Workspace copy's write-back summary, from the Attempt's own Worker Host.
    ("AttemptWorkspaceMounts", "RecordWrites", HOST),
    ("AttemptArtifacts", "*", HOST),
    ("ArtifactTransfers", "*", HOST),
    ("Transfers", "*", HOST),
    ("Transfers", "DownloadWorkspaceArtifact", OC),
    // A Worker Host serving the artifact and Workspace bytes it holds to the Control Plane's
    // relay: only the host the relay asked.
    ("HostRelay", "Await", HOST),
    ("HostRelay", "Deliver", HOST),
    // Surfaces.
    ("Connector", "*", GATEWAY),
    ("ReplyProgress", "*", GATEWAY),
    ("OperatorNotifications", "*", GATEWAY),
    // The state owner's directories, behind the API tier.
    ("CheckpointDirectory", "*", INTERNAL),
    ("WorkspaceDirectory", "*", INTERNAL),
    ("ArtifactDirectory", "*", INTERNAL),
    ("ArtifactVolumeDirectory", "*", INTERNAL),
    ("GithubPublisher", "*", INTERNAL),
    ("GithubSourceResolver", "*", INTERNAL),
    // Served by a Worker Host to its harness adapters, or by a Gateway to operators.
    ("Harness", "*", PEER_LOCAL),
    ("HarnessArtifacts", "*", PEER_LOCAL),
    ("HarnessEffects", "*", PEER_LOCAL),
    ("HarnessMailbox", "*", PEER_LOCAL),
    ("HarnessMcp", "*", PEER_LOCAL),
    ("HarnessQuestions", "*", PEER_LOCAL),
    ("HarnessSchedules", "*", PEER_LOCAL),
    ("HarnessMemory", "*", PEER_LOCAL),
    ("HarnessTagSessions", "*", PEER_LOCAL),
    ("HarnessWorkSessions", "*", PEER_LOCAL),
    ("HarnessWorkspace", "*", PEER_LOCAL),
    ("HarnessWorkstreams", "*", PEER_LOCAL),
    ("RemoteWorkspaceProvider", "*", PEER_LOCAL),
    ("WorkerArtifactTransfers", "*", PEER_LOCAL),
    ("OperatorNotificationTest", "*", PEER_LOCAL),
];

/// Who may call `service`/`method`; `None` when the table has no entry.
pub fn access(service: &str, method: &str) -> Option<u16> {
    let exact = TABLE.iter().find(|(s, m, _)| *s == service && *m == method);
    exact
        .or_else(|| TABLE.iter().find(|(s, m, _)| *s == service && *m == "*"))
        .map(|(_, _, access)| *access)
}

/// The roles allowed to call a gRPC path, by name, for diagnostics and documentation.
pub fn allowed_roles(path: &str) -> Vec<&'static str> {
    let Some((service, method)) = path.strip_prefix(PACKAGE).and_then(|p| p.split_once('/')) else {
        return vec![];
    };
    let access = access(service, method).unwrap_or(0);
    [
        (ADMIN, "admin"),
        (OPERATOR, "operator"),
        (GATEWAY, "gateway"),
        (HOST, "host"),
        (CLIENT, "client"),
        (OPEN, "unauthenticated"),
        (ENROLL, "auth-key"),
    ]
    .into_iter()
    .filter(|(bit, _)| access & bit != 0)
    .map(|(_, name)| name)
    .collect()
}

/// Who may call a gRPC path, `None` when it names no runtime RPC in the table.
pub fn path_access(path: &str) -> Option<u16> {
    let (service, method) = path.strip_prefix(PACKAGE)?.split_once('/')?;
    access(service, method)
}

/// Whether a Gateway forwards a call on `path` from its client listener to the Control Plane:
/// protocol negotiation and health, and every RPC that an operator, a client, or an Auth Key
/// (enrollment) may call. Worker Host, Gateway, internal, and peer-local RPCs are not served there.
/// Forwarding grants nothing: the Control Plane authorizes each call as its caller's own principal.
pub fn gateway_forwards(path: &str) -> bool {
    path.starts_with(NEGOTIATION_PATH)
        || path.starts_with(HEALTH_PATH)
        || path_access(path)
            .is_some_and(|access| access & (ADMIN | OPERATOR | CLIENT | ENROLL) != 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use prost::Message as _;

    /// Every RPC in the compiled protocol descriptors has an entry, so no RPC ships unclassified.
    #[test]
    fn every_rpc_in_the_protocol_is_classified() {
        let set = prost_types::FileDescriptorSet::decode(crate::FILE_DESCRIPTOR_SET)
            .expect("compiled descriptors");
        let mut missing = vec![];
        let mut methods = 0;
        for file in &set.file {
            for service in &file.service {
                let name = service.name();
                let explicit = TABLE.iter().any(|(s, _, _)| *s == name);
                for method in &service.method {
                    methods += 1;
                    if !explicit || access(name, method.name()).is_none() {
                        missing.push(format!("{name}/{}", method.name()));
                    }
                }
            }
        }
        assert!(methods > 250, "descriptors list too few methods: {methods}");
        assert!(missing.is_empty(), "unclassified RPCs: {missing:?}");
        // No entry names a service the protocol no longer has.
        for (service, method, _) in TABLE {
            let found = set
                .file
                .iter()
                .flat_map(|file| &file.service)
                .find(|s| s.name() == *service);
            let found = found.unwrap_or_else(|| panic!("stale table entry {service}"));
            assert!(
                *method == "*" || found.method.iter().any(|m| m.name() == *method),
                "stale table entry {service}/{method}"
            );
        }
    }

    #[test]
    fn no_service_wide_entry_admits_a_client() {
        for (service, method, access) in TABLE {
            assert!(
                *method != "*" || access & CLIENT == 0,
                "{service}/* admits a client; list each client method by name"
            );
        }
    }

    #[test]
    fn the_table_matches_the_approved_role_matrix() {
        let roles = |path: &str| allowed_roles(&format!("{PACKAGE}{path}"));
        assert_eq!(roles("OperatorAccess/CreateOperatorToken"), ["admin"]);
        assert_eq!(roles("OperatorAccess/ListAuditEntries"), ["operator"]);
        assert_eq!(roles("Operator/PutTag"), ["operator"]);
        assert_eq!(roles("Operator/SubmitTask"), ["operator"]);
        assert_eq!(roles("Operator/ListHosts"), ["operator"]);
        assert_eq!(roles("Operator/GetTag"), ["operator", "client"]);
        assert_eq!(roles("Conversations/SendMessage"), ["operator", "client"]);
        assert_eq!(roles("Objectives/CreateObjective"), ["operator", "client"]);
        assert_eq!(roles("Objectives/SetLimits"), ["operator"]);
        assert_eq!(roles("Inbox/DecideApproval"), ["operator", "client"]);
        assert_eq!(roles("WorkerHost/ClaimTask"), ["host"]);
        assert_eq!(roles("WorkerHost/ReclaimAttempt"), ["host"]);
        assert_eq!(roles("WorkerHost/ReportAppliedLimits"), ["host"]);
        assert_eq!(roles("WorkerHost/ReportCleanupFailure"), ["host"]);
        assert_eq!(roles("WorkerHost/ReportNetworkLog"), ["host"]);
        assert_eq!(roles("NetworkLogs/List"), ["operator"]);
        assert_eq!(roles("AttemptWorkspaceMounts/RecordWrites"), ["host"]);
        assert_eq!(roles("WorkspaceVolumes/Put"), ["operator"]);
        assert_eq!(
            roles("ManifestRelationships/ReconcileManifestFields"),
            ["operator"]
        );
        assert_eq!(roles("Transfers/UploadCheckpoint"), ["host"]);
        assert_eq!(
            roles("Transfers/DownloadWorkspaceArtifact"),
            ["operator", "client"]
        );
        assert_eq!(roles("HostRelay/Await"), ["host"]);
        assert_eq!(roles("HostRelay/Deliver"), ["host"]);
        assert_eq!(roles("AttemptArtifacts/CommitCapture"), ["host"]);
        assert_eq!(roles("Transfers/CommitWorkspace"), ["host"]);
        assert_eq!(roles("Connector/AcceptEvent"), ["gateway"]);
        assert_eq!(roles("OperatorNotifications/Claim"), ["gateway"]);
        assert_eq!(roles("Enrollments/Enroll"), ["auth-key"]);
        assert_eq!(
            roles("Enrollments/RotateCredential"),
            ["operator", "gateway", "host", "client"]
        );
        assert_eq!(roles("Enrollments/RevokeEnrollment"), ["operator"]);
        assert_eq!(roles("ProtocolNegotiation/Negotiate"), ["unauthenticated"]);
        for internal in [
            "CredentialDirectory/Resolve",
            "CheckpointDirectory/GetCheckpoint",
            "GithubPublisher/Claim",
            "Harness/Attach",
            "NoSuchService/Call",
        ] {
            assert!(roles(internal).is_empty(), "{internal}");
        }
    }

    #[test]
    fn a_gateway_forwards_only_operator_client_and_enrollment_calls() {
        let forwards = |path: &str| gateway_forwards(&format!("{PACKAGE}{path}"));
        for path in [
            "ProtocolNegotiation/Negotiate",
            "Enrollments/Enroll",
            "Enrollments/WhoAmI",
            "Operator/PutTag",
            "OperatorAccess/CreateOperatorToken",
            "Conversations/FollowConversation",
            "ArtifactTransfers/DownloadFile",
            "Transfers/DownloadWorkspaceArtifact",
        ] {
            assert!(forwards(path), "{path}");
        }
        assert!(gateway_forwards("/grpc.health.v1.Health/Check"));
        for path in [
            "WorkerHost/ClaimTask",
            "HostRelay/Await",
            "Transfers/UploadCheckpoint",
            "Connector/ClaimConnector",
            "ReplyProgress/Claim",
            "OperatorNotifications/Claim",
            "CredentialDirectory/Resolve",
            "CheckpointDirectory/GetCheckpoint",
            "Harness/Attach",
            "NoSuchService/Call",
        ] {
            assert!(!forwards(path), "{path}");
        }
    }
}
