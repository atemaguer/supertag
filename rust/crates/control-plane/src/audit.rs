//! Records the general audit log for administrative and authority-changing operator calls.
//!
//! The layer wraps the private gRPC router. For each audited unary method called by a
//! Gateway-authenticated operator, it records who called, what the call did, its target, and the
//! gRPC outcome, after the handler answers and before the response leaves the Control Plane. A
//! later call therefore lists it. Calls refused as unauthenticated and previews are not recorded.
//! Recording never fails the call it describes; a failure is reported on standard error.

use std::{
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
};

use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use prost::Message;
use subtle::ConstantTimeEq;
use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};
use tonic::{Code, body::Body};
use tower_layer::Layer;
use tower_service::Service;

use crate::{ControlPlane, Store, operator_access::AuditRecord};

const PRINCIPAL: &str = "x-supertag-principal";

/// What an audited call targets: `Kind/ID`, the kind alone, or nothing for a preview.
enum Target {
    Named(String),
    Kind,
    Skip,
}

type Decode = fn(&[u8]) -> Option<Target>;

struct Rule {
    action: &'static str,
    kind: &'static str,
    decode: Decode,
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
            decode: |bytes| {
                let $value = <$message>::decode(bytes).ok()?;
                $target
            },
        }
    };
}

/// The audited methods of the private Control Plane API.
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
            "WorkerHost",
            CreateAuthKeyRequest,
            |value| named("WorkerHost", &value.host_id)
        ),
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
        ("ManifestRelationships", "ProvisionTags") => rule!(
            "tag.provision",
            "Tag",
            ProvisionTagsRequest,
            |value| match value.tags.as_slice() {
                [single] => named(
                    "Tag",
                    single.tag.as_ref().map_or("", |tag| tag.tag_id.as_str())
                ),
                _ => Some(Target::Kind),
            }
        ),
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
        let actor = rule.as_ref().and_then(|_| {
            // Only Gateway-authenticated operators are recorded; the handler refuses the rest.
            if !gateway_bearer(request.headers(), &self.layer.gateway_token) {
                return None;
            }
            let principal = request.headers().get(PRINCIPAL)?.to_str().ok()?;
            principal
                .strip_prefix("operator:")
                .filter(|id| !id.is_empty())
                .map(str::to_owned)
        });
        let (Some(rule), Some(actor)) = (rule, actor) else {
            return Box::pin(inner.call(request));
        };
        let store = self.layer.store.clone();
        Box::pin(async move {
            let method = request.uri().path().to_owned();
            let (parts, body) = request.into_parts();
            // The router refuses a larger message, so a body over the limit is passed on
            // unaudited-as-named and the handler's refusal is recorded by kind.
            let bytes = Limited::new(body, MAX_MESSAGE_BYTES + 5)
                .collect()
                .await
                .map(|collected| collected.to_bytes())
                .unwrap_or_default();
            let target = unary_message(&bytes)
                .and_then(rule.decode)
                .unwrap_or(Target::Kind);
            let request = http::Request::from_parts(parts, Body::new(Full::<Bytes>::new(bytes)));
            let response = inner.call(request).await?;
            if matches!(target, Target::Skip) {
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
            let succeeded = code == Code::Ok;
            let record = AuditRecord {
                actor,
                action: rule.action.into(),
                target: match target {
                    Target::Named(target) if succeeded => target,
                    _ => rule.kind.into(),
                },
                succeeded,
                code: code_name(code).into(),
                method,
            };
            if let Err(error) = store.record_audit_entry(&record).await {
                eprintln!(
                    "Could not record the audit entry for {} {}: {error}",
                    record.action, record.target
                );
            }
            Ok(response)
        })
    }
}
