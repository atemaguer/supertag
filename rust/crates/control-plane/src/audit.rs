//! Records the general audit log for administrative and authority-changing operator calls.
//!
//! The layer wraps the private gRPC router. For each audited unary method called by a
//! Gateway-authenticated operator, it records who called, what the call did, its target, and the
//! gRPC outcome. A later call therefore lists it. Calls refused as unauthenticated and previews are
//! not recorded. A call that changes several resources records one entry per resource.
//!
//! Each entry is written in the transaction that makes the change it describes: every write
//! transaction takes the next write order, and that step records the entries of the audited call
//! running on the task, so an entry commits exactly when its change does. After the handler answers,
//! the layer settles the call: a call that changed nothing transactionally gets its entries then, a
//! failed call is recorded as failed, and entries an inner transaction committed for a call that
//! ultimately failed are marked failed. A target the log refuses is recorded by kind; a storage
//! failure while settling is reported on standard error and never fails the call.
//!
//! Callers other than operators are recorded too: a Worker Host joining with an Auth Key as
//! `auth-key:NAME`, and a person directing an Objective from a surface thread as
//! `<provider>:<user ID>`.

use std::{
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
};

use bytes::{Bytes, BytesMut};
use http_body::{Frame, SizeHint};
use prost::Message;
use subtle::ConstantTimeEq;
use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};
use tonic::{Code, body::Body};
use tower_layer::Layer;
use tower_service::Service;

use sqlx::{Any, Transaction};
use uuid::Uuid;

use crate::{ControlPlane, Store, operator_access::AuditRecord};

const PRINCIPAL: &str = "x-supertag-principal";

/// What an audited call targets: `Kind/ID`, several of them, the kind alone, or nothing for a
/// preview.
enum Target {
    Named(String),
    /// One entry per resource, such as each Tag a single call provisions.
    Many(Vec<String>),
    Kind,
    Skip,
}

/// One change a successful audited call made, when one call makes several.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuditChange {
    pub action: String,
    /// `Kind/ID`.
    pub target: String,
}

/// Set as a response extension by a handler whose call changed several resources, such as an
/// apply-set prune. The layer then records one entry per change instead of one for the call.
#[derive(Clone, Debug, Default)]
pub struct AuditChanges(pub Vec<AuditChange>);

type Decode = fn(&[u8]) -> Option<Target>;

/// Who an audited call acts as before its handler names a more specific actor.
#[derive(Clone, Copy)]
enum Caller {
    /// A Gateway-authenticated operator, recorded by its operator ID.
    Operator,
    /// A Worker Host presenting an Auth Key through the API tier. The handler names the key.
    AuthKey,
}

struct Rule {
    action: &'static str,
    kind: &'static str,
    decode: Decode,
    caller: Caller,
}

fn named(kind: &str, id: &str) -> Option<Target> {
    Some(if id.is_empty() {
        Target::Kind
    } else {
        Target::Named(format!("{kind}/{id}"))
    })
}

macro_rules! rule {
    ($action:literal, $kind:literal, $message:ty, |$value:ident| $target:expr) => {
        Rule {
            action: $action,
            kind: $kind,
            caller: Caller::Operator,
            decode: |bytes| {
                let $value = <$message>::decode(bytes).ok()?;
                $target
            },
        }
    };
}

/// The audited methods of the state owner's API.
fn rule(path: &str) -> Option<Rule> {
    let (service, method) = path
        .strip_prefix("/supertag.runtime.v2.")?
        .split_once('/')?;
    Some(match (service, method) {
        ("OperatorAccess", "CreateOperatorToken") => rule!(
            "operator-token.create",
            "OperatorToken",
            CreateOperatorTokenRequest,
            |value| named("OperatorToken", &value.name)
        ),
        ("OperatorAccess", "RotateOperatorToken") => rule!(
            "operator-token.rotate",
            "OperatorToken",
            RotateOperatorTokenRequest,
            |value| named("OperatorToken", &value.name)
        ),
        ("OperatorAccess", "RevokeOperatorToken") => rule!(
            "operator-token.revoke",
            "OperatorToken",
            RevokeOperatorTokenRequest,
            |value| named("OperatorToken", &value.name)
        ),
        ("Operator", "CreateAuthKey") => rule!(
            "auth-key.create",
            "AuthKey",
            CreateAuthKeyRequest,
            |value| named("AuthKey", &value.name)
        ),
        ("AuthKeys", "RevokeAuthKey") => rule!(
            "auth-key.revoke",
            "AuthKey",
            RevokeAuthKeyRequest,
            |value| named("AuthKey", &value.name)
        ),
        ("HostCredentials", "RotateHostCredential") => rule!(
            "worker-host.credential.rotate",
            "WorkerHost",
            RotateHostCredentialRequest,
            |value| named("WorkerHost", &value.host_id)
        ),
        ("HostDirectory", "Enroll") => Rule {
            caller: Caller::AuthKey,
            ..rule!(
                "worker-host.join",
                "WorkerHost",
                PrivateEnrollHostRequest,
                |value| named(
                    "WorkerHost",
                    value
                        .enrollment
                        .as_ref()
                        .map_or("", |enrollment| enrollment.host_id.as_str())
                )
            )
        },
        ("Operator", "RevokeHost") => rule!(
            "worker-host.revoke",
            "WorkerHost",
            RevokeHostRequest,
            |value| named("WorkerHost", &value.host_id)
        ),
        ("Operator", "SetHostDraining") => {
            fn decode(bytes: &[u8]) -> Option<Target> {
                let value = SetHostDrainingRequest::decode(bytes).ok()?;
                named("WorkerHost", &value.host_id)
            }
            // The action depends on the request, so the generic name covers both.
            Rule {
                action: "worker-host.set-draining",
                kind: "WorkerHost",
                decode,
                caller: Caller::Operator,
            }
        }
        ("Operator", "PutTag") => {
            rule!("tag.put", "Tag", PutTagRequest, |value| named(
                "Tag",
                &value.tag_id
            ))
        }
        ("Operator", "RetireTag") => rule!("tag.retire", "Tag", RetireTagRequest, |value| {
            if value.dry_run {
                Some(Target::Skip)
            } else {
                named("Tag", &value.tag_id)
            }
        }),
        ("Operator", "SubmitTask") => rule!("tag.message", "Tag", SubmitTaskRequest, |value| {
            named("Tag", &value.tag_id)
        }),
        ("Conversations", "SendMessage") => {
            rule!("tag.message", "Tag", SendMessageRequest, |value| named(
                "Tag",
                &value.tag_id
            ))
        }
        ("Operator", "CancelTask") => rule!("task.cancel", "Task", CancelTaskRequest, |value| {
            named("Task", &value.task_id)
        }),
        ("Operator", "ResolveAttempt") => {
            rule!("attempt.resolve", "Task", ResolveAttemptRequest, |value| {
                named("Task", &value.task_id)
            })
        }
        ("Operator", "ResolveReply") => rule!(
            "reply.resolve",
            "Reply",
            ResolveReplyRequest,
            |value| named("Reply", &value.reply_id)
        ),
        ("Objectives", "CreateObjective") => rule!(
            "objective.create",
            "Objective",
            CreateObjectiveRequest,
            |value| named("Objective", &value.objective_id)
        ),
        ("Objectives", "SetLimits") => rule!(
            "objective.limits",
            "Objective",
            SetObjectiveLimitsRequest,
            |value| named("Objective", &value.objective_id)
        ),
        ("Objectives", "SetRuntimeActions") => rule!(
            "objective.runtime-actions",
            "Objective",
            SetObjectiveRuntimeActionsRequest,
            |value| named("Objective", &value.objective_id)
        ),
        ("Objectives", "PauseObjective") => rule!(
            "objective.pause",
            "Objective",
            ObjectiveActionRequest,
            |value| named("Objective", &value.objective_id)
        ),
        ("Objectives", "ResumeObjective") => rule!(
            "objective.resume",
            "Objective",
            ObjectiveActionRequest,
            |value| named("Objective", &value.objective_id)
        ),
        ("Objectives", "CancelObjective") => rule!(
            "objective.cancel",
            "Objective",
            ObjectiveActionRequest,
            |value| named("Objective", &value.objective_id)
        ),
        ("Objectives", "ReviewObjective") => rule!(
            "objective.review",
            "Objective",
            ReviewObjectiveRequest,
            |value| named("Objective", &value.objective_id)
        ),
        ("Objectives", "CompleteObjective") => rule!(
            "objective.complete",
            "Objective",
            CompleteObjectiveRequest,
            |value| named("Objective", &value.objective_id)
        ),
        ("Inbox", "AnswerQuestion") => {
            rule!("question.answer", "Task", AnswerQuestionRequest, |value| {
                named("Task", &value.task_id)
            })
        }
        ("Inbox", "DecideApproval") => rule!(
            "approval.decide",
            "Approval",
            DecideApprovalRequest,
            |value| named("Approval", &value.approval_id)
        ),
        ("Teams", "CreateTeam") => rule!("team.create", "Team", CreateTeamRequest, |value| {
            named(
                "Team",
                if value.team_id.is_empty() {
                    &value.name
                } else {
                    &value.team_id
                },
            )
        }),
        ("Teams", "UpdateTeam") => rule!("team.update", "Team", UpdateTeamRequest, |value| {
            named("Team", &value.team)
        }),
        ("Teams", "DeleteTeam") => rule!("team.delete", "Team", DeleteTeamRequest, |value| {
            named("Team", &value.team)
        }),
        ("Mailbox", "ChangeGrant") => rule!(
            "mailbox-grant.change",
            "MailboxGrant",
            ChangeMailboxGrantRequest,
            |value| named(
                "MailboxGrant",
                &format!("{}->{}", value.sender_tag_id, value.recipient_tag_id)
            )
        ),
        ("PolicyCatalog", "PutPermissionSet") => rule!(
            "permission-set.put",
            "PermissionSet",
            PutPermissionSetRequest,
            |value| named(
                "PermissionSet",
                value
                    .permission_set
                    .as_ref()
                    .map_or("", |set| set.set_id.as_str())
            )
        ),
        ("PolicyCatalog", "DeletePermissionSet") => rule!(
            "permission-set.delete",
            "PermissionSet",
            DeletePolicyResourceRequest,
            |value| named("PermissionSet", &value.reference)
        ),
        ("PolicyCatalog", "PutContextSet") => rule!(
            "context-set.put",
            "ContextSet",
            PutContextSetRequest,
            |value| named(
                "ContextSet",
                value
                    .context_set
                    .as_ref()
                    .map_or("", |set| set.set_id.as_str())
            )
        ),
        ("PolicyCatalog", "DeleteContextSet") => rule!(
            "context-set.delete",
            "ContextSet",
            DeletePolicyResourceRequest,
            |value| named("ContextSet", &value.reference)
        ),
        ("PolicyCatalog", "PutRole") => rule!("role.put", "Role", PutRoleRequest, |value| {
            named(
                "Role",
                value.role.as_ref().map_or("", |role| role.role_id.as_str()),
            )
        }),
        ("PolicyCatalog", "AssignRole") => {
            rule!("role.assign", "Tag", AssignRoleRequest, |value| named(
                "Tag",
                &value.tag_id
            ))
        }
        ("PolicyCatalog", "DeactivateRoleAssignment") => rule!(
            "role.unassign",
            "RoleAssignment",
            DeactivateRoleAssignmentRequest,
            |value| named("RoleAssignment", &value.assignment_id)
        ),
        ("SurfacePolicyCatalog", "PutSurfaceAccount") => rule!(
            "surface-account.put",
            "SurfaceAccount",
            PutSurfaceAccountRequest,
            |value| named(
                "SurfaceAccount",
                value
                    .account
                    .as_ref()
                    .map_or("", |account| account.account_id.as_str())
            )
        ),
        ("SurfacePolicyCatalog", "PutSurfaceLocation") => rule!(
            "surface-location.put",
            "SurfaceLocation",
            PutSurfaceLocationRequest,
            |value| named(
                "SurfaceLocation",
                value
                    .location
                    .as_ref()
                    .map_or("", |location| location.location_id.as_str())
            )
        ),
        ("SurfacePolicyCatalog", "DeleteSurfaceLocation") => rule!(
            "surface-location.delete",
            "SurfaceLocation",
            DeleteSurfaceLocationRequest,
            |value| named("SurfaceLocation", &value.location_id)
        ),
        ("ManifestRelationships", "ReconcileTag") => rule!(
            "tag.relationships",
            "Tag",
            ReconcileTagRelationshipsRequest,
            |value| if value.preview {
                Some(Target::Skip)
            } else {
                named("Tag", &value.tag_id)
            }
        ),
        ("ManifestRelationships", "ProvisionTags") => {
            rule!("tag.provision", "Tag", ProvisionTagsRequest, |value| {
                let tags = value
                    .tags
                    .iter()
                    .filter_map(|tag| tag.tag.as_ref())
                    .filter(|tag| !tag.tag_id.is_empty())
                    .map(|tag| format!("Tag/{}", tag.tag_id))
                    .collect::<Vec<_>>();
                Some(if tags.is_empty() {
                    Target::Kind
                } else {
                    Target::Many(tags)
                })
            })
        }
        ("ManifestRelationships", "ReconcileApplySet") => rule!(
            "apply-set.reconcile",
            "ApplySet",
            ReconcileApplySetRequest,
            |value| if value.preview {
                Some(Target::Skip)
            } else {
                named("ApplySet", &value.apply_set)
            }
        ),
        ("LiveInputs", "QueueInput") => {
            rule!("task.input", "Task", QueueInputRequest, |value| named(
                "Task",
                &value.task_id
            ))
        }
        ("LiveInputs", "ResolveInput") => {
            rule!("input.resolve", "LiveInput", ResolveInputRequest, |value| {
                named("LiveInput", &value.input_id)
            })
        }
        ("GithubWorkspaces", "Put") => rule!(
            "github-workspace.put",
            "GithubWorkspace",
            PutGithubWorkspaceRequest,
            |value| named(
                "GithubWorkspace",
                value
                    .workspace
                    .as_ref()
                    .map_or("", |workspace| workspace.workspace_id.as_str())
            )
        ),
        ("GithubWorkspaces", "Delete") => rule!(
            "github-workspace.delete",
            "GithubWorkspace",
            DeleteGithubWorkspaceRequest,
            |value| named("GithubWorkspace", &value.workspace_id)
        ),
        ("GithubPublications", "Cancel") => rule!(
            "github-publication.cancel",
            "GithubPublication",
            CancelGithubPublicationRequest,
            |value| named("GithubPublication", &value.publication_id)
        ),
        ("ArtifactVolumeDirectory", "Put") => rule!(
            "artifact-volume.put",
            "ArtifactVolume",
            PutArtifactVolumeRequest,
            |value| named("ArtifactVolume", &value.volume_id)
        ),
        ("ArtifactVolumeDirectory", "ReserveCopy") => rule!(
            "artifact-volume.copy-reserve",
            "ArtifactVolume",
            CopyArtifactToVolumeRequest,
            |value| named("ArtifactVolume", &value.volume_id)
        ),
        ("ArtifactVolumeDirectory", "CommitCopy") => rule!(
            "artifact-volume.copy",
            "ArtifactVolumeCopy",
            CommitArtifactVolumeCopyRequest,
            |value| named("ArtifactVolumeCopy", &value.copy_id)
        ),
        ("ArtifactVolumeDirectory", "Delete") => rule!(
            "artifact-volume.delete",
            "ArtifactVolume",
            DeleteArtifactVolumeRequest,
            |value| named("ArtifactVolume", &value.volume_id)
        ),
        ("WorkspaceVolumes", "Put") => rule!(
            "workspace-volume.put",
            "WorkspaceVolume",
            PutWorkspaceVolumeRequest,
            |value| named("WorkspaceVolume", &value.volume_id)
        ),
        ("ArtifactPublications", "Publish") => rule!(
            "artifact-publication.publish",
            "ArtifactPublication",
            PublishArtifactRequest,
            |value| named("ArtifactPublication", &value.publication_id)
        ),
        ("ArtifactPublications", "Consume") => rule!(
            "artifact-publication.consume",
            "ArtifactConsumption",
            ConsumeArtifactPublicationRequest,
            |value| named("ArtifactConsumption", &value.consumption_id)
        ),
        ("ArtifactPublications", "WithdrawPublication") => rule!(
            "artifact-publication.withdraw",
            "ArtifactPublication",
            WithdrawArtifactApprovalRequest,
            |value| named("ArtifactPublication", &value.approval_id)
        ),
        ("ArtifactPublications", "WithdrawConsumption") => rule!(
            "artifact-consumption.withdraw",
            "ArtifactConsumption",
            WithdrawArtifactApprovalRequest,
            |value| named("ArtifactConsumption", &value.approval_id)
        ),
        _ => return None,
    })
}

/// The gRPC code name recorded with each entry.
fn code_name(code: Code) -> &'static str {
    match code {
        Code::Ok => "OK",
        Code::Cancelled => "CANCELLED",
        Code::Unknown => "UNKNOWN",
        Code::InvalidArgument => "INVALID_ARGUMENT",
        Code::DeadlineExceeded => "DEADLINE_EXCEEDED",
        Code::NotFound => "NOT_FOUND",
        Code::AlreadyExists => "ALREADY_EXISTS",
        Code::PermissionDenied => "PERMISSION_DENIED",
        Code::ResourceExhausted => "RESOURCE_EXHAUSTED",
        Code::FailedPrecondition => "FAILED_PRECONDITION",
        Code::Aborted => "ABORTED",
        Code::OutOfRange => "OUT_OF_RANGE",
        Code::Unimplemented => "UNIMPLEMENTED",
        Code::Internal => "INTERNAL",
        Code::Unavailable => "UNAVAILABLE",
        Code::DataLoss => "DATA_LOSS",
        Code::Unauthenticated => "UNAUTHENTICATED",
    }
}

/// The decoded single unary message of a gRPC request body, when it is uncompressed.
fn unary_message(body: &[u8]) -> Option<&[u8]> {
    let (&[flag, a, b, c, d], message) = body.split_first_chunk::<5>()?;
    let length = u32::from_be_bytes([a, b, c, d]) as usize;
    (flag == 0 && message.len() == length).then_some(message)
}

/// Whether the request carries the private Gateway credential, compared in constant time.
fn gateway_bearer(headers: &http::HeaderMap, token: &str) -> bool {
    let mut values = headers.get_all("authorization").iter();
    let candidate = values
        .next()
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    values.next().is_none()
        && candidate.is_some_and(|candidate| {
            !token.is_empty() && bool::from(candidate.as_bytes().ct_eq(token.as_bytes()))
        })
}

tokio::task_local! {
    /// The audited call whose handler is running on this task.
    static CALL: Arc<AuditCall>;
}

/// One audited call while its handler runs.
pub(crate) struct AuditCall {
    id: String,
    store: Store,
    action: &'static str,
    kind: &'static str,
    method: String,
    decode: Decode,
    /// The unary request message as the handler read it.
    copy: Arc<Mutex<Option<BytesMut>>>,
    state: Mutex<CallState>,
}

struct CallState {
    actor: String,
    /// Set while the call has no one to attribute it to, which is not recorded. A call made with
    /// an Auth Key starts unattributed and stays so until the handler finds the key, so a refusal
    /// of an unknown key, or of a request checked before its key is looked up, writes nothing.
    skip: bool,
}

impl AuditCall {
    fn actor(&self) -> String {
        self.state
            .lock()
            .map_or_else(|_| String::new(), |state| state.actor.clone())
    }

    fn skipped(&self) -> bool {
        self.state.lock().is_ok_and(|state| state.skip)
    }

    /// What the request targets, once the handler has read it.
    fn target(&self) -> Target {
        let bytes = self
            .copy
            .lock()
            .ok()
            .and_then(|copy| copy.as_ref().map(|copy| copy.clone().freeze()))
            .unwrap_or_default();
        unary_message(&bytes)
            .and_then(self.decode)
            .unwrap_or(Target::Kind)
    }

    fn record(&self, action: &str, target: String, succeeded: bool, code: Code) -> AuditRecord {
        AuditRecord {
            actor: self.actor(),
            action: action.into(),
            target,
            succeeded,
            code: code_name(code).into(),
            method: self.method.clone(),
        }
    }

    /// The entries of a successful call: one per resource it names.
    fn entries(&self, target: Target) -> Vec<(String, String)> {
        match target {
            Target::Named(target) => vec![(self.action.into(), target)],
            Target::Many(targets) => targets
                .into_iter()
                .map(|target| (self.action.to_owned(), target))
                .collect(),
            Target::Kind => vec![(self.action.into(), self.kind.into())],
            Target::Skip => Vec::new(),
        }
    }
}

fn current_call() -> Option<Arc<AuditCall>> {
    CALL.try_with(Arc::clone).ok()
}

/// Names who the running audited call acts as, such as the Auth Key a Worker Host presented, and
/// so lets the call be recorded.
pub(crate) fn note_actor(actor: &str) {
    if let Some(call) = current_call()
        && let Ok(mut state) = call.state.lock()
    {
        state.actor = actor.into();
        state.skip = false;
    }
}

/// Writes one entry in `transaction`, under the next write order. An entry of a call is written
/// at most once per action and target. A target the log refuses is recorded by its kind.
pub(crate) async fn insert_in(
    transaction: &mut Transaction<'_, Any>,
    call_id: Option<&str>,
    at_ms: i64,
    mut record: AuditRecord,
    kind: &str,
) -> crate::store::Result<()> {
    if crate::operator_access::validate_audit_record(&record).is_err() && record.target != kind {
        record.target = kind.into();
    }
    crate::operator_access::validate_audit_record(&record)?;
    let order = crate::store::increment_order(transaction).await?;
    sqlx::query("INSERT INTO supertag_v2_audit_entries (sequence, entry_id, at_ms, actor, action, target, outcome, code, method, call_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (call_id, action, target) DO NOTHING")
        .bind(order)
        .bind(Uuid::new_v4().to_string())
        .bind(at_ms)
        .bind(&record.actor)
        .bind(&record.action)
        .bind(&record.target)
        .bind(if record.succeeded { 1_i64 } else { 2 })
        .bind(&record.code)
        .bind(&record.method)
        .bind(call_id)
        .execute(&mut **transaction)
        .await?;
    Ok(())
}

/// Records the running audited call's entries in `transaction` as succeeded, once per call. A
/// rolled-back transaction takes its entries with it; the next one writes them again.
pub(crate) async fn record_call_in(
    transaction: &mut Transaction<'_, Any>,
) -> crate::store::Result<()> {
    let Some(call) = current_call() else {
        return Ok(());
    };
    if call.skipped() {
        return Ok(());
    }
    let recorded: Option<i64> =
        sqlx::query_scalar("SELECT 1 FROM supertag_v2_audit_entries WHERE call_id=$1 LIMIT 1")
            .bind(&call.id)
            .fetch_optional(&mut **transaction)
            .await?;
    if recorded.is_some() {
        return Ok(());
    }
    let at_ms = call.store.execution_now_ms();
    for (action, target) in call.entries(call.target()) {
        let record = call.record(&action, target, true, Code::Ok);
        insert_in(transaction, Some(&call.id), at_ms, record, call.kind).await?;
    }
    Ok(())
}

/// Names who the running audited call acts as, in the entries already written in `transaction`
/// and in those written later.
pub(crate) async fn note_actor_in(
    transaction: &mut Transaction<'_, Any>,
    actor: &str,
) -> crate::store::Result<()> {
    let Some(call) = current_call() else {
        return Ok(());
    };
    note_actor(actor);
    sqlx::query("UPDATE supertag_v2_audit_entries SET actor=$1 WHERE call_id=$2")
        .bind(actor)
        .bind(&call.id)
        .execute(&mut **transaction)
        .await?;
    Ok(())
}

/// Replaces the running audited call's entries in `transaction` with one per change, such as each
/// member an apply-set prune deletes. Without changes the call keeps its own entry.
pub(crate) async fn changes_in(
    transaction: &mut Transaction<'_, Any>,
    changes: &[AuditChange],
) -> crate::store::Result<()> {
    let Some(call) = current_call() else {
        return Ok(());
    };
    if changes.is_empty() || call.skipped() {
        return Ok(());
    }
    sqlx::query("DELETE FROM supertag_v2_audit_entries WHERE call_id=$1")
        .bind(&call.id)
        .execute(&mut **transaction)
        .await?;
    let at_ms = call.store.execution_now_ms();
    for change in changes {
        let record = call.record(&change.action, change.target.clone(), true, Code::Ok);
        insert_in(transaction, Some(&call.id), at_ms, record, call.kind).await?;
    }
    Ok(())
}

/// Passes a request body through unchanged and copies up to one maximum-size unary message.
struct Recording {
    inner: Body,
    /// `None` once the body is longer than any message the router accepts.
    copy: Arc<Mutex<Option<BytesMut>>>,
}

impl http_body::Body for Recording {
    type Data = Bytes;
    type Error = tonic::Status;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
        let frame = std::task::ready!(Pin::new(&mut self.inner).poll_frame(context));
        if let Some(data) = frame
            .as_ref()
            .and_then(|frame| frame.as_ref().ok())
            .and_then(Frame::data_ref)
            && let Ok(mut copy) = self.copy.lock()
        {
            let over = copy
                .as_ref()
                .is_some_and(|copy| copy.len() + data.len() > MAX_MESSAGE_BYTES + 5);
            if over {
                *copy = None;
            } else if let Some(copy) = copy.as_mut() {
                copy.extend_from_slice(data);
            }
        }
        Poll::Ready(frame)
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

/// Wraps the private router so audited calls are recorded.
#[derive(Clone)]
pub struct AuditLayer {
    store: Store,
    gateway_token: Arc<String>,
}

impl ControlPlane {
    pub fn audit_layer(&self) -> AuditLayer {
        AuditLayer {
            store: self.store.clone(),
            gateway_token: self.gateway_token.clone(),
        }
    }
}

impl<S> Layer<S> for AuditLayer {
    type Service = AuditService<S>;

    fn layer(&self, inner: S) -> Self::Service {
        AuditService {
            inner,
            layer: self.clone(),
        }
    }
}

#[derive(Clone)]
pub struct AuditService<S> {
    inner: S,
    layer: AuditLayer,
}

type BoxFuture<T, E> = Pin<Box<dyn std::future::Future<Output = Result<T, E>> + Send>>;

impl<S, ResBody> Service<http::Request<Body>> for AuditService<S>
where
    S: Service<http::Request<Body>, Response = http::Response<ResBody>> + Clone + Send + 'static,
    S::Future: Send + 'static,
    S::Error: Send + 'static,
    ResBody: Send + 'static,
{
    type Response = S::Response;
    type Error = S::Error;
    type Future = BoxFuture<Self::Response, Self::Error>;

    fn poll_ready(&mut self, context: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(context)
    }

    fn call(&mut self, request: http::Request<Body>) -> Self::Future {
        // Take the service that was polled ready and leave a fresh clone in its place.
        let clone = self.inner.clone();
        let mut inner = std::mem::replace(&mut self.inner, clone);
        let rule = rule(request.uri().path());
        let actor = rule.as_ref().and_then(|rule| {
            // Only Gateway-authenticated callers are recorded; the handler refuses the rest.
            if !gateway_bearer(request.headers(), &self.layer.gateway_token) {
                return None;
            }
            let principal = request.headers().get(PRINCIPAL)?.to_str().ok()?;
            match rule.caller {
                Caller::Operator => principal
                    .strip_prefix("operator:")
                    .filter(|id| !id.is_empty())
                    .map(str::to_owned),
                Caller::AuthKey => principal
                    .starts_with("service:")
                    .then(|| "auth-key".to_owned()),
            }
        });
        let (Some(rule), Some(actor)) = (rule, actor) else {
            return Box::pin(inner.call(request));
        };
        let store = self.layer.store.clone();
        Box::pin(async move {
            // The handler reads the body exactly as sent, including tonic's own refusal of an
            // oversized message; the layer keeps a copy to name the target.
            let copy = Arc::new(Mutex::new(Some(BytesMut::new())));
            let call = Arc::new(AuditCall {
                id: Uuid::new_v4().to_string(),
                store: store.clone(),
                action: rule.action,
                kind: rule.kind,
                method: request.uri().path().to_owned(),
                decode: rule.decode,
                copy: copy.clone(),
                state: Mutex::new(CallState {
                    actor,
                    skip: matches!(rule.caller, Caller::AuthKey),
                }),
            });
            let (parts, body) = request.into_parts();
            let body = Body::new(Recording { inner: body, copy });
            let response = CALL
                .scope(
                    call.clone(),
                    inner.call(http::Request::from_parts(parts, body)),
                )
                .await?;
            let target = call.target();
            if matches!(target, Target::Skip) || call.skipped() {
                return Ok(response);
            }
            let code = response
                .headers()
                .get("grpc-status")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<i32>().ok())
                .map_or(Code::Ok, Code::from_i32);
            if code == Code::Unauthenticated {
                return Ok(response);
            }
            let result = if code == Code::Ok {
                let changes = response
                    .extensions()
                    .get::<AuditChanges>()
                    .filter(|changes| !changes.0.is_empty());
                let replace = changes.is_some();
                let entries = changes.map_or_else(
                    || call.entries(target),
                    |changes| {
                        changes
                            .0
                            .iter()
                            .map(|change| (change.action.clone(), change.target.clone()))
                            .collect()
                    },
                );
                let records = entries
                    .into_iter()
                    .map(|(action, target)| call.record(&action, target, true, code))
                    .collect::<Vec<_>>();
                store
                    .settle_audit_call(&call.id, &records, replace, rule.kind)
                    .await
            } else {
                let record = call.record(rule.action, rule.kind.into(), false, code);
                store.fail_audit_call(&call.id, &record, rule.kind).await
            };
            if let Err(error) = result {
                supertag_protocol::terminal_text::warn(&format!(
                    "Could not record the audit entry for {} {}: {error}",
                    rule.action, rule.kind
                ));
            }
            Ok(response)
        })
    }
}
