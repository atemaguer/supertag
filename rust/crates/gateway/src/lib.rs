//! Public gRPC ingress for operators and Worker Hosts.

mod artifact_publications;

mod conversations;
mod delivery_journal;
pub mod github;
mod github_publications;
mod github_workspaces;
mod inbox;
mod inputs;
pub mod lark;
pub mod linear;
mod mailbox;
mod mcp_effects;
pub mod microsoft_teams;
mod policy;
#[cfg(test)]
mod readiness_tests;
pub mod slack;
mod surface_policy;
mod teams;
pub mod transfers;
mod watch;
mod work_sessions;

pub use watch::GatewayWatch;

use std::{future::Future, sync::Arc, time::Duration};

use anyhow::{Context, ensure};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use supertag_protocol::v2::{
    host_directory_client::HostDirectoryClient,
    host_enrollment_server::{HostEnrollment, HostEnrollmentServer},
    objectives_client::ObjectivesClient,
    objectives_server::{Objectives, ObjectivesServer},
    operator_client::OperatorClient,
    operator_server::{Operator, OperatorServer},
    worker_host_client::WorkerHostClient,
    worker_host_server::{WorkerHost, WorkerHostServer},
    *,
};
use supertag_protocol::{HOST_GENERATION_HEADER, host_generation};
use tonic::{
    Code, Request, Response, Status,
    metadata::{Ascii, MetadataValue},
    transport::Channel,
};

const CALL_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_MESSAGE_BYTES: usize = 1024 * 1024;
const AUTHORIZATION: &str = "authorization";
const PRINCIPAL: &str = "x-supertag-principal";
const TIMEOUT: &str = "grpc-timeout";

#[derive(Clone)]
pub struct Gateway {
    control_plane: Channel,
    credentials: Arc<Credentials>,
}

struct Credentials {
    service: MetadataValue<Ascii>,
    operator: Principal,
}

struct Principal {
    authorization: MetadataValue<Ascii>,
    identity: MetadataValue<Ascii>,
}

impl Gateway {
    /// The operator and private service tokens come from process configuration.
    /// The Control Plane authenticates enrolled Worker Host credentials.
    pub fn new(
        control_plane: Channel,
        gateway_token: String,
        operator_token: String,
        operator_principal: String,
    ) -> anyhow::Result<Self> {
        ensure!(
            gateway_token != operator_token,
            "Gateway and operator tokens must be distinct"
        );
        Ok(Self {
            control_plane,
            credentials: Arc::new(Credentials {
                service: bearer(&gateway_token).context("invalid Gateway service credential")?,
                operator: Principal::new(&operator_token, &operator_principal, "operator:")
                    .context("invalid operator configuration")?,
            }),
        })
    }

    pub fn operator_service(&self) -> OperatorServer<Self> {
        OperatorServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }

    pub fn worker_host_service(&self) -> WorkerHostServer<Self> {
        WorkerHostServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }

    pub fn host_enrollment_service(&self) -> HostEnrollmentServer<Self> {
        HostEnrollmentServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }

    pub fn objectives_service(&self) -> ObjectivesServer<Self> {
        ObjectivesServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }

    async fn forward<T, R, F>(
        &self,
        request: Request<T>,
        principal: &Principal,
        call: impl FnOnce(Channel, Request<T>) -> F,
    ) -> Result<Response<R>, Status>
    where
        F: Future<Output = Result<Response<R>, Status>>,
    {
        let (request, timeout) = self.credentials.forwarded(request, principal)?;
        tokio::time::timeout(timeout, call(self.control_plane.clone(), request))
            .await
            .map_err(|_| Status::deadline_exceeded("Control Plane request timed out"))?
    }

    async fn forward_host<T, R, F>(
        &self,
        request: Request<T>,
        registered: bool,
        call: impl FnOnce(Channel, Request<T>) -> F,
    ) -> Result<Response<R>, Status>
    where
        F: Future<Output = Result<Response<R>, Status>>,
    {
        let token_digest = self.credentials.host_credential_digest(&request)?;
        let timeout = request_budget(&request)?;
        let deadline = tokio::time::Instant::now() + timeout;
        tokio::time::timeout_at(deadline, async {
            let host = self.authenticate_host(token_digest, timeout).await?;
            if registered && host_generation(&request)? != host.generation {
                return Err(Status::permission_denied(
                    "Worker Host generation is no longer current",
                ));
            }
            let identity = format!("host:{}", host.host_id)
                .parse()
                .map_err(|_| Status::internal("invalid enrolled Worker Host identity"))?;
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return Err(Status::deadline_exceeded("Control Plane request timed out"));
            }
            let mut upstream = self
                .credentials
                .upstream(request.into_inner(), identity, remaining);
            if registered {
                upstream
                    .metadata_mut()
                    .insert(HOST_GENERATION_HEADER, host.generation.into());
            }
            call(self.control_plane.clone(), upstream).await
        })
        .await
        .map_err(|_| Status::deadline_exceeded("Control Plane request timed out"))?
    }

    async fn authenticate_host(
        &self,
        token_digest: Vec<u8>,
        timeout: Duration,
    ) -> Result<HostRecord, Status> {
        let request = self.credentials.upstream(
            AuthenticateHostRequest { token_digest },
            MetadataValue::from_static("service:gateway"),
            timeout,
        );
        let host = host_directory_client(self.control_plane.clone())
            .authenticate(request)
            .await
            .map_err(host_authentication_error)?
            .into_inner();
        if host.revoked {
            return Err(Status::unauthenticated(
                "valid Worker Host credential required",
            ));
        }
        Ok(host)
    }
}

impl Credentials {
    fn forwarded<T>(
        &self,
        request: Request<T>,
        principal: &Principal,
    ) -> Result<(Request<T>, Duration), Status> {
        principal.authorize(&request)?;
        let timeout = request_budget(&request)?;
        Ok((
            self.upstream(request.into_inner(), principal.identity.clone(), timeout),
            timeout,
        ))
    }

    fn upstream<T>(
        &self,
        message: T,
        identity: MetadataValue<Ascii>,
        timeout: Duration,
    ) -> Request<T> {
        let mut upstream = self.authenticated(message, identity);
        upstream.set_timeout(timeout);
        upstream
    }

    fn authenticated<T>(&self, message: T, identity: MetadataValue<Ascii>) -> Request<T> {
        // Rebuild metadata and extensions so caller claims are never forwarded.
        let mut upstream = Request::new(message);
        upstream
            .metadata_mut()
            .insert(AUTHORIZATION, self.service.clone());
        upstream.metadata_mut().insert(PRINCIPAL, identity);
        upstream
    }

    fn host_credential_digest<T>(&self, request: &Request<T>) -> Result<Vec<u8>, Status> {
        let mut values = request.metadata().get_all(AUTHORIZATION).iter();
        let invalid = || Status::unauthenticated("valid bearer credential required");
        let value = values.next().ok_or_else(invalid)?;
        if values.next().is_some()
            || bool::from(
                value
                    .as_encoded_bytes()
                    .ct_eq(self.service.as_encoded_bytes()),
            )
            || bool::from(
                value
                    .as_encoded_bytes()
                    .ct_eq(self.operator.authorization.as_encoded_bytes()),
            )
        {
            return Err(invalid());
        }
        let token = value
            .to_str()
            .ok()
            .and_then(|value| value.strip_prefix("Bearer "))
            .filter(|token| valid_bearer_token(token))
            .ok_or_else(invalid)?;
        Ok(Sha256::digest(token.as_bytes()).to_vec())
    }
}

impl Principal {
    fn authorize<T>(&self, request: &Request<T>) -> Result<(), Status> {
        let values = request.metadata().get_all(AUTHORIZATION);
        let mut entries = values.iter();
        let valid = entries.next().is_some_and(|value| {
            bool::from(
                value
                    .as_encoded_bytes()
                    .ct_eq(self.authorization.as_encoded_bytes()),
            )
        });
        if !valid || entries.next().is_some() {
            return Err(Status::unauthenticated("valid bearer credential required"));
        }
        Ok(())
    }
}

impl Principal {
    fn new(token: &str, identity: &str, prefix: &str) -> anyhow::Result<Self> {
        ensure!(
            identity.strip_prefix(prefix).is_some_and(|id| {
                !id.is_empty() && id.len() <= 255 && id.bytes().all(|byte| byte.is_ascii_graphic())
            }),
            "principal has invalid role or identity"
        );
        Ok(Self {
            authorization: bearer(token)?,
            identity: identity.parse().context("invalid principal metadata")?,
        })
    }
}

fn bearer(token: &str) -> anyhow::Result<MetadataValue<Ascii>> {
    ensure!(valid_bearer_token(token), "invalid bearer token format");
    let mut value = format!("Bearer {token}")
        .parse::<MetadataValue<Ascii>>()
        .context("invalid bearer metadata")?;
    value.set_sensitive(true);
    Ok(value)
}

fn valid_bearer_token(token: &str) -> bool {
    let body = token.trim_end_matches('=');
    !body.is_empty()
        && token.len() <= 512
        && body
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-._~+/".contains(&byte))
}

fn request_budget<T>(request: &Request<T>) -> Result<Duration, Status> {
    let timeout = client_timeout(request)?.min(CALL_TIMEOUT);
    if timeout.is_zero() {
        return Err(Status::deadline_exceeded("request deadline elapsed"));
    }
    Ok(timeout)
}

fn host_authentication_error(error: Status) -> Status {
    match error.code() {
        Code::PermissionDenied | Code::Unauthenticated => {
            Status::unauthenticated("valid Worker Host credential required")
        }
        _ => error,
    }
}

fn client_timeout<T>(request: &Request<T>) -> Result<Duration, Status> {
    let values = request.metadata().get_all(TIMEOUT);
    let mut timeouts = values.iter();
    let Some(value) = timeouts.next() else {
        return Ok(CALL_TIMEOUT);
    };
    let invalid = || Status::invalid_argument("invalid grpc-timeout");
    if timeouts.next().is_some() {
        return Err(invalid());
    }
    let bytes = value.as_encoded_bytes();
    let Some((&unit, digits)) = bytes.split_last() else {
        return Err(invalid());
    };
    if digits.is_empty() || digits.len() > 8 || !digits.iter().all(u8::is_ascii_digit) {
        return Err(invalid());
    }
    let value = digits
        .iter()
        .fold(0_u64, |value, digit| value * 10 + u64::from(digit - b'0'));
    match unit {
        b'H' => Ok(Duration::from_secs(value * 3_600)),
        b'M' => Ok(Duration::from_secs(value * 60)),
        b'S' => Ok(Duration::from_secs(value)),
        b'm' => Ok(Duration::from_millis(value)),
        b'u' => Ok(Duration::from_micros(value)),
        b'n' => Ok(Duration::from_nanos(value)),
        _ => Err(invalid()),
    }
}

fn operator_client(channel: Channel) -> OperatorClient<Channel> {
    OperatorClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
}

fn worker_host_client(channel: Channel) -> WorkerHostClient<Channel> {
    WorkerHostClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
}

fn host_directory_client(channel: Channel) -> HostDirectoryClient<Channel> {
    HostDirectoryClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
}

fn objectives_client(channel: Channel) -> ObjectivesClient<Channel> {
    ObjectivesClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
}

#[tonic::async_trait]
impl Objectives for Gateway {
    async fn create_objective(
        &self,
        request: Request<CreateObjectiveRequest>,
    ) -> Result<Response<Objective>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { objectives_client(channel).create_objective(request).await },
        )
        .await
    }

    async fn get_objective(
        &self,
        request: Request<GetObjectiveRequest>,
    ) -> Result<Response<Objective>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { objectives_client(channel).get_objective(request).await },
        )
        .await
    }

    async fn list_objectives(
        &self,
        request: Request<ListObjectivesRequest>,
    ) -> Result<Response<ListObjectivesResponse>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { objectives_client(channel).list_objectives(request).await },
        )
        .await
    }

    async fn list_commit_reviews(
        &self,
        request: Request<ListObjectiveCommitReviewsRequest>,
    ) -> Result<Response<ListObjectiveCommitReviewsResponse>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async {
                objectives_client(channel)
                    .list_commit_reviews(request)
                    .await
            },
        )
        .await
    }

    async fn set_limits(
        &self,
        request: Request<SetObjectiveLimitsRequest>,
    ) -> Result<Response<Objective>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { objectives_client(channel).set_limits(request).await },
        )
        .await
    }

    async fn set_runtime_actions(
        &self,
        request: Request<SetObjectiveRuntimeActionsRequest>,
    ) -> Result<Response<Objective>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async {
                objectives_client(channel)
                    .set_runtime_actions(request)
                    .await
            },
        )
        .await
    }

    async fn pause_objective(
        &self,
        request: Request<ObjectiveActionRequest>,
    ) -> Result<Response<Objective>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { objectives_client(channel).pause_objective(request).await },
        )
        .await
    }

    async fn resume_objective(
        &self,
        request: Request<ObjectiveActionRequest>,
    ) -> Result<Response<Objective>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { objectives_client(channel).resume_objective(request).await },
        )
        .await
    }

    async fn cancel_objective(
        &self,
        request: Request<ObjectiveActionRequest>,
    ) -> Result<Response<Objective>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { objectives_client(channel).cancel_objective(request).await },
        )
        .await
    }

    async fn review_objective(
        &self,
        request: Request<ReviewObjectiveRequest>,
    ) -> Result<Response<Objective>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { objectives_client(channel).review_objective(request).await },
        )
        .await
    }
}

#[tonic::async_trait]
impl Operator for Gateway {
    async fn get_reply_delivery(
        &self,
        request: Request<GetReplyDeliveryRequest>,
    ) -> Result<Response<ReplyDelivery>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { operator_client(channel).get_reply_delivery(request).await },
        )
        .await
    }

    async fn list_reply_deliveries(
        &self,
        request: Request<ListReplyDeliveriesRequest>,
    ) -> Result<Response<ListReplyDeliveriesResponse>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async {
                operator_client(channel)
                    .list_reply_deliveries(request)
                    .await
            },
        )
        .await
    }

    async fn resolve_reply(
        &self,
        request: Request<ResolveReplyRequest>,
    ) -> Result<Response<ReplyDelivery>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { operator_client(channel).resolve_reply(request).await },
        )
        .await
    }

    async fn list_hosts(
        &self,
        request: Request<ListHostsRequest>,
    ) -> Result<Response<ListHostsResponse>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { operator_client(channel).list_hosts(request).await },
        )
        .await
    }

    async fn get_host(
        &self,
        request: Request<GetHostRequest>,
    ) -> Result<Response<WorkerHostStatus>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { operator_client(channel).get_host(request).await },
        )
        .await
    }

    async fn set_host_draining(
        &self,
        request: Request<SetHostDrainingRequest>,
    ) -> Result<Response<WorkerHostStatus>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { operator_client(channel).set_host_draining(request).await },
        )
        .await
    }

    async fn create_auth_key(
        &self,
        request: Request<CreateAuthKeyRequest>,
    ) -> Result<Response<AuthKey>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { operator_client(channel).create_auth_key(request).await },
        )
        .await
    }

    async fn revoke_host(
        &self,
        request: Request<RevokeHostRequest>,
    ) -> Result<Response<HostRecord>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { operator_client(channel).revoke_host(request).await },
        )
        .await
    }

    async fn put_tag(&self, request: Request<PutTagRequest>) -> Result<Response<Tag>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { operator_client(channel).put_tag(request).await },
        )
        .await
    }

    async fn get_tag(&self, request: Request<GetTagRequest>) -> Result<Response<Tag>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { operator_client(channel).get_tag(request).await },
        )
        .await
    }

    async fn retire_tag(
        &self,
        request: Request<RetireTagRequest>,
    ) -> Result<Response<RetireTagResponse>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { operator_client(channel).retire_tag(request).await },
        )
        .await
    }

    async fn list_tags(
        &self,
        request: Request<ListTagsRequest>,
    ) -> Result<Response<ListTagsResponse>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { operator_client(channel).list_tags(request).await },
        )
        .await
    }

    async fn submit_task(
        &self,
        request: Request<SubmitTaskRequest>,
    ) -> Result<Response<Task>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { operator_client(channel).submit_task(request).await },
        )
        .await
    }

    async fn get_task(&self, request: Request<GetTaskRequest>) -> Result<Response<Task>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { operator_client(channel).get_task(request).await },
        )
        .await
    }

    async fn list_native_usage(
        &self,
        request: Request<ListNativeUsageRequest>,
    ) -> Result<Response<ListNativeUsageResponse>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { operator_client(channel).list_native_usage(request).await },
        )
        .await
    }

    async fn list_events(
        &self,
        request: Request<ListEventsRequest>,
    ) -> Result<Response<ListEventsResponse>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { operator_client(channel).list_events(request).await },
        )
        .await
    }

    async fn cancel_task(
        &self,
        request: Request<CancelTaskRequest>,
    ) -> Result<Response<Task>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { operator_client(channel).cancel_task(request).await },
        )
        .await
    }

    async fn resolve_attempt(
        &self,
        request: Request<ResolveAttemptRequest>,
    ) -> Result<Response<AttemptResolution>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { operator_client(channel).resolve_attempt(request).await },
        )
        .await
    }
}

#[tonic::async_trait]
impl HostEnrollment for Gateway {
    async fn enroll_host(
        &self,
        request: Request<EnrollHostRequest>,
    ) -> Result<Response<HostRecord>, Status> {
        let key_digest = self.credentials.host_credential_digest(&request)?;
        let timeout = request_budget(&request)?;
        let upstream = self.credentials.upstream(
            PrivateEnrollHostRequest {
                enrollment: Some(request.into_inner()),
                key_digest,
            },
            MetadataValue::from_static("service:gateway"),
            timeout,
        );
        tokio::time::timeout(
            timeout,
            host_directory_client(self.control_plane.clone()).enroll(upstream),
        )
        .await
        .map_err(|_| Status::deadline_exceeded("Control Plane request timed out"))?
        .map_err(host_authentication_error)
    }
}

#[tonic::async_trait]
impl WorkerHost for Gateway {
    async fn get_attempt_history(
        &self,
        request: Request<InspectAttemptRequest>,
    ) -> Result<Response<AttemptHistory>, Status> {
        self.forward_host(request, true, |channel, request| async {
            worker_host_client(channel)
                .get_attempt_history(request)
                .await
        })
        .await
    }

    async fn get_context_pins(
        &self,
        request: Request<InspectAttemptRequest>,
    ) -> Result<Response<ContextResolutionManifest>, Status> {
        self.forward_host(request, true, |channel, request| async {
            worker_host_client(channel).get_context_pins(request).await
        })
        .await
    }

    async fn commit_context_resolution(
        &self,
        request: Request<CommitContextResolutionRequest>,
    ) -> Result<Response<ContextResolutionManifest>, Status> {
        self.forward_host(request, true, |channel, request| async {
            worker_host_client(channel)
                .commit_context_resolution(request)
                .await
        })
        .await
    }
    async fn report_host(
        &self,
        request: Request<ReportHostRequest>,
    ) -> Result<Response<WorkerHostStatus>, Status> {
        self.forward_host(request, true, |channel, request| async {
            worker_host_client(channel).report_host(request).await
        })
        .await
    }

    async fn ask_question(
        &self,
        request: Request<AskQuestionRequest>,
    ) -> Result<Response<ObjectiveQuestion>, Status> {
        self.forward_host(request, true, |channel, request| async {
            worker_host_client(channel).ask_question(request).await
        })
        .await
    }

    async fn get_attempt_capabilities(
        &self,
        request: Request<InspectAttemptRequest>,
    ) -> Result<Response<AttemptCapabilities>, Status> {
        self.forward_host(request, true, |channel, request| async {
            worker_host_client(channel)
                .get_attempt_capabilities(request)
                .await
        })
        .await
    }

    async fn register_host(
        &self,
        request: Request<RegisterHostRequest>,
    ) -> Result<Response<HostRecord>, Status> {
        self.forward_host(request, false, |channel, request| async {
            worker_host_client(channel).register_host(request).await
        })
        .await
    }

    async fn claim_task(
        &self,
        request: Request<ClaimTaskRequest>,
    ) -> Result<Response<ClaimTaskResponse>, Status> {
        self.forward_host(request, true, |channel, request| async {
            worker_host_client(channel).claim_task(request).await
        })
        .await
    }

    async fn start_task(
        &self,
        request: Request<StartTaskRequest>,
    ) -> Result<Response<Task>, Status> {
        self.forward_host(request, true, |channel, request| async {
            worker_host_client(channel).start_task(request).await
        })
        .await
    }

    async fn inspect_attempt(
        &self,
        request: Request<InspectAttemptRequest>,
    ) -> Result<Response<Task>, Status> {
        self.forward_host(request, true, |channel, request| async {
            worker_host_client(channel).inspect_attempt(request).await
        })
        .await
    }

    async fn renew_attempt(
        &self,
        request: Request<InspectAttemptRequest>,
    ) -> Result<Response<AttemptAuthority>, Status> {
        self.forward_host(request, true, |channel, request| async {
            worker_host_client(channel).renew_attempt(request).await
        })
        .await
    }

    async fn get_attempt_resolution(
        &self,
        request: Request<InspectAttemptRequest>,
    ) -> Result<Response<GetAttemptResolutionResponse>, Status> {
        self.forward_host(request, true, |channel, request| async {
            worker_host_client(channel)
                .get_attempt_resolution(request)
                .await
        })
        .await
    }

    async fn report_attempt_usage(
        &self,
        request: Request<ReportAttemptUsageRequest>,
    ) -> Result<Response<ReportAttemptUsageResponse>, Status> {
        self.forward_host(request, true, |channel, request| async {
            worker_host_client(channel)
                .report_attempt_usage(request)
                .await
        })
        .await
    }

    async fn append_event(
        &self,
        request: Request<AppendEventRequest>,
    ) -> Result<Response<TaskEvent>, Status> {
        self.forward_host(request, true, |channel, request| async {
            worker_host_client(channel).append_event(request).await
        })
        .await
    }

    async fn finish_task(
        &self,
        request: Request<FinishTaskRequest>,
    ) -> Result<Response<Task>, Status> {
        self.forward_host(request, true, |channel, request| async {
            worker_host_client(channel).finish_task(request).await
        })
        .await
    }
}

#[cfg(test)]
mod tests;
