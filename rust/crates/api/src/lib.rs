//! The Control Plane's public API tier.
//!
//! This tier holds no durable state. It authenticates every caller (operators, Worker Hosts,
//! Gateways and clients) in one authorization layer ([`authorize`]), serves Watch fan-out and
//! transfers (checkpoints, workspace bundles, artifacts), and forwards every call to the state
//! owner over a [`ProtocolChannel`]. The state owner and its controllers live in
//! `supertag-control-plane`. One process serves both, over an in-process channel ([`in_process`]).
//! This tier keeps nothing but transfer files, so it could later run as replicas in front of one
//! state owner that share the transfer directory; no process runs it alone yet.
//!
//! [`Api::routes`] lists every public service. The process serving them puts the protocol fence
//! and then [`Api::authorize`] in front of all of them at once.

mod artifact_publications;
mod attempt_safety;
pub mod authorize;
mod conversations;
mod enrollments;
mod github_publications;
mod github_workspaces;
pub mod in_process;
mod inbox;
mod inputs;
mod mailbox;
mod manifest_relationships;
mod mcp_effects;
mod metrics;
mod operator_access;
mod passthrough;
mod placement;
mod policy;
#[cfg(test)]
mod readiness_tests;
mod spend;
mod surface_policy;
mod teams;
pub mod transfers;
mod watch;
mod work_sessions;
mod workspace_mounts;

pub use authorize::{Caller, Role};
pub use watch::ApiWatch;

use std::{future::Future, sync::Arc, time::Duration};

use anyhow::{Context, ensure};
use supertag_protocol::negotiation::ProtocolChannel;
use supertag_protocol::v2::{
    objectives_client::ObjectivesClient,
    objectives_server::{Objectives, ObjectivesServer},
    operator_client::OperatorClient,
    operator_server::{Operator, OperatorServer},
    worker_host_client::WorkerHostClient,
    worker_host_server::{WorkerHost, WorkerHostServer},
    *,
};
use supertag_protocol::{HOST_GENERATION_HEADER, INTERNAL_PRINCIPAL_HEADER, host_generation};
use tonic::{
    Request, Response, Status,
    metadata::{Ascii, MetadataValue},
};

const CALL_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_MESSAGE_BYTES: usize = 1024 * 1024;
const AUTHORIZATION: &str = "authorization";
const PRINCIPAL: &str = INTERNAL_PRINCIPAL_HEADER;
const TIMEOUT: &str = "grpc-timeout";

#[derive(Clone)]
pub struct Api {
    control_plane: ProtocolChannel,
    credentials: Arc<Credentials>,
}

struct Credentials {
    /// This process's internal credential for the state owner.
    internal: MetadataValue<Ascii>,
    /// The admin operator token, as a bearer header value.
    admin: MetadataValue<Ascii>,
    /// The admin operator's principal, such as `operator:local`.
    admin_principal: String,
}

impl Api {
    /// `internal_token` reaches the state owner; the admin operator token and principal come from
    /// process configuration. Every other credential is resolved by the state owner on each call.
    pub fn new(
        control_plane: ProtocolChannel,
        internal_token: String,
        admin_token: String,
        admin_principal: String,
    ) -> anyhow::Result<Self> {
        ensure!(
            internal_token != admin_token,
            "internal and operator tokens must be distinct"
        );
        ensure!(
            admin_principal.strip_prefix("operator:").is_some_and(|id| {
                !id.is_empty()
                    && !id.starts_with("token:")
                    && id.len() <= 255
                    && id.bytes().all(|byte| byte.is_ascii_graphic())
            }),
            "the admin operator principal must be operator:ID and not name an Operator Token"
        );
        ensure!(
            !admin_token.starts_with(supertag_protocol::OPERATOR_TOKEN_SECRET_PREFIX)
                && !admin_token.starts_with(supertag_protocol::AUTH_KEY_SECRET_PREFIX)
                && !admin_token.starts_with(supertag_protocol::CREDENTIAL_SECRET_PREFIX),
            "the admin operator token must not look like an issued credential"
        );
        Ok(Self {
            control_plane,
            credentials: Arc::new(Credentials {
                internal: bearer(&internal_token).context("invalid internal credential")?,
                admin: bearer(&admin_token).context("invalid operator token")?,
                admin_principal,
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

    /// Worker Hosts, Gateways and clients negotiate their protocol version here before any other
    /// call; [`supertag_protocol::negotiation::fence`] refuses a call that did not. Negotiation
    /// carries no credential, so the negotiated role grants nothing.
    pub fn negotiation_service(
        &self,
    ) -> protocol_negotiation_server::ProtocolNegotiationServer<
        supertag_protocol::negotiation::Negotiator,
    > {
        supertag_protocol::negotiation::Negotiator::new(
            ServiceRole::ControlPlane,
            &[
                ServiceRole::WorkerHost,
                ServiceRole::Client,
                ServiceRole::Gateway,
            ],
        )
        .service()
    }

    /// Every service of the public listener: the operator, client, Worker Host and Gateway API,
    /// enrollment, transfers, Watch fan-out, and health. Gateway services are relayed to the state
    /// owner over `state_owner`. `shutdown` ends open Watch streams.
    pub async fn routes(
        &self,
        transfers: transfers::ApiTransfers,
        state_owner: tonic::transport::Channel,
        shutdown: tokio_util::sync::CancellationToken,
    ) -> tonic::service::Routes {
        use passthrough::Passthrough;
        use tonic::server::NamedService;
        let (health, health_service) = tonic_health::server::health_reporter();
        let mut names = Vec::new();
        let mut routes = tonic::service::Routes::builder();
        macro_rules! add {
            ($($service:expr),* $(,)?) => {$({
                let service = $service;
                fn name<S: NamedService>(_: &S) -> &'static str {
                    S::NAME
                }
                names.push(name(&service));
                routes.add_service(service);
            })*};
        }
        let internal = self.credentials.internal.clone();
        add!(
            self.negotiation_service(),
            self.operator_service(),
            self.operator_access_service(),
            self.enrollments_service(),
            self.conversations_service(),
            self.worker_host_service(),
            transfers.artifact_catalog_service(),
            transfers.artifact_volumes_service(),
            self.workspace_volumes_service(),
            self.placement_service(),
            self.auth_keys_service(),
            self.attempt_workspace_mounts_service(),
            transfers.attempt_artifacts_service(),
            transfers.artifact_transfer_service(),
            transfers.service(),
            self.objectives_service(),
            self.live_inputs_service(),
            self.attempt_inputs_service(),
            self.teams_service(),
            self.attempt_workstreams_service(),
            self.mailbox_service(),
            self.inbox_service(),
            self.github_workspaces_service(),
            self.github_publications_service(),
            self.artifact_publications_service(),
            self.policy_service(),
            self.manifest_relationships_service(),
            self.surface_policy_service(),
            self.work_sessions_service(),
            self.attempt_work_sessions_service(),
            self.attempt_mailbox_service(),
            self.attempt_mcp_effects_service(),
            self.attempt_changed_paths_service(),
            self.attempt_effects_service(),
            self.spend_service(),
            self.metrics_service(),
            self.objective_overview_service(),
            self.operator_events_service(shutdown),
            Passthrough::<connector_server::ConnectorServer<()>>::new(
                state_owner.clone(),
                internal.clone()
            ),
            Passthrough::<reply_progress_server::ReplyProgressServer<()>>::new(
                state_owner.clone(),
                internal.clone()
            ),
            Passthrough::<operator_notifications_server::OperatorNotificationsServer<()>>::new(
                state_owner,
                internal
            ),
        );
        for name in names {
            health
                .set_service_status(name, tonic_health::ServingStatus::Serving)
                .await;
        }
        routes.add_service(health_service);
        routes.routes()
    }

    pub fn objectives_service(&self) -> ObjectivesServer<Self> {
        ObjectivesServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }

    /// Forwards a call with the caller's principal. A host caller's call also carries its
    /// registered generation.
    async fn forward<T, R, F>(
        &self,
        request: Request<T>,
        call: impl FnOnce(ProtocolChannel, Request<T>) -> F,
    ) -> Result<Response<R>, Status>
    where
        F: Future<Output = Result<Response<R>, Status>>,
    {
        let timeout = request_budget(&request)?;
        let deadline = tokio::time::Instant::now() + timeout;
        tokio::time::timeout_at(deadline, async {
            let caller = self.caller(&request).await?;
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return Err(Status::deadline_exceeded("Control Plane request timed out"));
            }
            let mut upstream =
                self.credentials
                    .upstream(request.into_inner(), caller.identity()?, remaining);
            if caller.role == Role::Host {
                upstream
                    .metadata_mut()
                    .insert(HOST_GENERATION_HEADER, caller.generation.into());
            }
            call(self.control_plane.clone(), upstream).await
        })
        .await
        .map_err(|_| Status::deadline_exceeded("Control Plane request timed out"))?
        .map_err(supertag_protocol::upstream_status)
    }

    /// Forwards a Worker Host call. A `registered` call must name the host's current generation.
    async fn forward_host<T, R, F>(
        &self,
        request: Request<T>,
        registered: bool,
        call: impl FnOnce(ProtocolChannel, Request<T>) -> F,
    ) -> Result<Response<R>, Status>
    where
        F: Future<Output = Result<Response<R>, Status>>,
    {
        let timeout = request_budget(&request)?;
        let deadline = tokio::time::Instant::now() + timeout;
        tokio::time::timeout_at(deadline, async {
            let host = self.caller(&request).await?;
            if host.role != Role::Host {
                return Err(Status::permission_denied(
                    "caller is not allowed to use this method",
                ));
            }
            if registered && host_generation(&request)? != host.generation {
                return Err(Status::permission_denied(
                    "Worker Host generation is no longer current",
                ));
            }
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return Err(Status::deadline_exceeded("Control Plane request timed out"));
            }
            let mut upstream =
                self.credentials
                    .upstream(request.into_inner(), host.identity()?, remaining);
            if registered {
                upstream
                    .metadata_mut()
                    .insert(HOST_GENERATION_HEADER, host.generation.into());
            }
            call(self.control_plane.clone(), upstream)
                .await
                .map_err(supertag_protocol::upstream_status)
        })
        .await
        .map_err(|_| Status::deadline_exceeded("Control Plane request timed out"))?
    }

    /// Checks that a Worker Host call names its current generation, for calls that do not forward.
    pub(crate) async fn registered_host<T>(&self, request: &Request<T>) -> Result<Caller, Status> {
        let host = self.caller(request).await?;
        if host.role != Role::Host || host_generation(request)? != host.generation {
            return Err(Status::permission_denied(
                "Worker Host generation is no longer current",
            ));
        }
        Ok(host)
    }
}

impl Credentials {
    fn upstream<T>(
        &self,
        message: T,
        identity: MetadataValue<Ascii>,
        timeout: Duration,
    ) -> Request<T> {
        // Rebuild metadata and extensions so caller claims are never forwarded.
        let mut upstream = Request::new(message);
        upstream
            .metadata_mut()
            .insert(AUTHORIZATION, self.internal.clone());
        upstream.metadata_mut().insert(PRINCIPAL, identity);
        upstream.set_timeout(timeout);
        upstream
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

fn operator_client(channel: ProtocolChannel) -> OperatorClient<ProtocolChannel> {
    OperatorClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
}

fn worker_host_client(channel: ProtocolChannel) -> WorkerHostClient<ProtocolChannel> {
    WorkerHostClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
}

fn objectives_client(channel: ProtocolChannel) -> ObjectivesClient<ProtocolChannel> {
    ObjectivesClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
}

#[tonic::async_trait]
impl Objectives for Api {
    async fn create_objective(
        &self,
        request: Request<CreateObjectiveRequest>,
    ) -> Result<Response<Objective>, Status> {
        self.forward(request, |channel, request| async {
            objectives_client(channel).create_objective(request).await
        })
        .await
    }

    async fn get_objective(
        &self,
        request: Request<GetObjectiveRequest>,
    ) -> Result<Response<Objective>, Status> {
        self.forward(request, |channel, request| async {
            objectives_client(channel).get_objective(request).await
        })
        .await
    }

    async fn list_objectives(
        &self,
        request: Request<ListObjectivesRequest>,
    ) -> Result<Response<ListObjectivesResponse>, Status> {
        self.forward(request, |channel, request| async {
            objectives_client(channel).list_objectives(request).await
        })
        .await
    }

    async fn list_commit_reviews(
        &self,
        request: Request<ListObjectiveCommitReviewsRequest>,
    ) -> Result<Response<ListObjectiveCommitReviewsResponse>, Status> {
        self.forward(request, |channel, request| async {
            objectives_client(channel)
                .list_commit_reviews(request)
                .await
        })
        .await
    }

    async fn set_limits(
        &self,
        request: Request<SetObjectiveLimitsRequest>,
    ) -> Result<Response<Objective>, Status> {
        self.forward(request, |channel, request| async {
            objectives_client(channel).set_limits(request).await
        })
        .await
    }

    async fn set_runtime_actions(
        &self,
        request: Request<SetObjectiveRuntimeActionsRequest>,
    ) -> Result<Response<Objective>, Status> {
        self.forward(request, |channel, request| async {
            objectives_client(channel)
                .set_runtime_actions(request)
                .await
        })
        .await
    }

    async fn pause_objective(
        &self,
        request: Request<ObjectiveActionRequest>,
    ) -> Result<Response<Objective>, Status> {
        self.forward(request, |channel, request| async {
            objectives_client(channel).pause_objective(request).await
        })
        .await
    }

    async fn resume_objective(
        &self,
        request: Request<ObjectiveActionRequest>,
    ) -> Result<Response<Objective>, Status> {
        self.forward(request, |channel, request| async {
            objectives_client(channel).resume_objective(request).await
        })
        .await
    }

    async fn cancel_objective(
        &self,
        request: Request<ObjectiveActionRequest>,
    ) -> Result<Response<Objective>, Status> {
        self.forward(request, |channel, request| async {
            objectives_client(channel).cancel_objective(request).await
        })
        .await
    }

    async fn review_objective(
        &self,
        request: Request<ReviewObjectiveRequest>,
    ) -> Result<Response<Objective>, Status> {
        self.forward(request, |channel, request| async {
            objectives_client(channel).review_objective(request).await
        })
        .await
    }

    async fn complete_objective(
        &self,
        request: Request<CompleteObjectiveRequest>,
    ) -> Result<Response<Objective>, Status> {
        self.forward(request, |channel, request| async {
            objectives_client(channel).complete_objective(request).await
        })
        .await
    }
}

#[tonic::async_trait]
impl Operator for Api {
    async fn get_reply_delivery(
        &self,
        request: Request<GetReplyDeliveryRequest>,
    ) -> Result<Response<ReplyDelivery>, Status> {
        self.forward(request, |channel, request| async {
            operator_client(channel).get_reply_delivery(request).await
        })
        .await
    }

    async fn list_reply_deliveries(
        &self,
        request: Request<ListReplyDeliveriesRequest>,
    ) -> Result<Response<ListReplyDeliveriesResponse>, Status> {
        self.forward(request, |channel, request| async {
            operator_client(channel)
                .list_reply_deliveries(request)
                .await
        })
        .await
    }

    async fn resolve_reply(
        &self,
        request: Request<ResolveReplyRequest>,
    ) -> Result<Response<ReplyDelivery>, Status> {
        self.forward(request, |channel, request| async {
            operator_client(channel).resolve_reply(request).await
        })
        .await
    }

    async fn list_hosts(
        &self,
        request: Request<ListHostsRequest>,
    ) -> Result<Response<ListHostsResponse>, Status> {
        self.forward(request, |channel, request| async {
            operator_client(channel).list_hosts(request).await
        })
        .await
    }

    async fn get_host(
        &self,
        request: Request<GetHostRequest>,
    ) -> Result<Response<WorkerHostStatus>, Status> {
        self.forward(request, |channel, request| async {
            operator_client(channel).get_host(request).await
        })
        .await
    }

    async fn set_host_draining(
        &self,
        request: Request<SetHostDrainingRequest>,
    ) -> Result<Response<WorkerHostStatus>, Status> {
        self.forward(request, |channel, request| async {
            operator_client(channel).set_host_draining(request).await
        })
        .await
    }

    async fn create_auth_key(
        &self,
        request: Request<CreateAuthKeyRequest>,
    ) -> Result<Response<AuthKey>, Status> {
        self.forward(request, |channel, request| async {
            operator_client(channel).create_auth_key(request).await
        })
        .await
    }

    async fn put_tag(&self, request: Request<PutTagRequest>) -> Result<Response<Tag>, Status> {
        self.forward(request, |channel, request| async {
            operator_client(channel).put_tag(request).await
        })
        .await
    }

    async fn get_tag(&self, request: Request<GetTagRequest>) -> Result<Response<Tag>, Status> {
        self.forward(request, |channel, request| async {
            operator_client(channel).get_tag(request).await
        })
        .await
    }

    async fn retire_tag(
        &self,
        request: Request<RetireTagRequest>,
    ) -> Result<Response<RetireTagResponse>, Status> {
        self.forward(request, |channel, request| async {
            operator_client(channel).retire_tag(request).await
        })
        .await
    }

    async fn list_tags(
        &self,
        request: Request<ListTagsRequest>,
    ) -> Result<Response<ListTagsResponse>, Status> {
        self.forward(request, |channel, request| async {
            operator_client(channel).list_tags(request).await
        })
        .await
    }

    async fn submit_task(
        &self,
        request: Request<SubmitTaskRequest>,
    ) -> Result<Response<Task>, Status> {
        supertag_protocol::crash_point("api.submit", "before-forward");
        let task = self
            .forward(request, |channel, request| async {
                operator_client(channel).submit_task(request).await
            })
            .await?;
        supertag_protocol::crash_point("api.submit", "after-forward");
        Ok(task)
    }

    async fn get_task(&self, request: Request<GetTaskRequest>) -> Result<Response<Task>, Status> {
        self.forward(request, |channel, request| async {
            operator_client(channel).get_task(request).await
        })
        .await
    }

    async fn get_session_delivery(
        &self,
        request: Request<GetSessionDeliveryRequest>,
    ) -> Result<Response<SessionDelivery>, Status> {
        self.forward(request, |channel, request| async {
            operator_client(channel).get_session_delivery(request).await
        })
        .await
    }

    async fn list_native_usage(
        &self,
        request: Request<ListNativeUsageRequest>,
    ) -> Result<Response<ListNativeUsageResponse>, Status> {
        self.forward(request, |channel, request| async {
            operator_client(channel).list_native_usage(request).await
        })
        .await
    }

    async fn list_events(
        &self,
        request: Request<ListEventsRequest>,
    ) -> Result<Response<ListEventsResponse>, Status> {
        self.forward(request, |channel, request| async {
            operator_client(channel).list_events(request).await
        })
        .await
    }

    async fn cancel_task(
        &self,
        request: Request<CancelTaskRequest>,
    ) -> Result<Response<Task>, Status> {
        self.forward(request, |channel, request| async {
            operator_client(channel).cancel_task(request).await
        })
        .await
    }

    async fn resolve_attempt(
        &self,
        request: Request<ResolveAttemptRequest>,
    ) -> Result<Response<AttemptResolution>, Status> {
        self.forward(request, |channel, request| async {
            operator_client(channel).resolve_attempt(request).await
        })
        .await
    }
}

#[tonic::async_trait]
impl WorkerHost for Api {
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
        supertag_protocol::crash_point("api.claim", "before-forward");
        let claim = self
            .forward_host(request, true, |channel, request| async {
                worker_host_client(channel).claim_task(request).await
            })
            .await?;
        if claim.get_ref().assignment.is_some() {
            supertag_protocol::crash_point("api.claim", "after-forward");
        }
        Ok(claim)
    }

    async fn start_task(
        &self,
        request: Request<StartTaskRequest>,
    ) -> Result<Response<Task>, Status> {
        supertag_protocol::crash_point("api.start", "before-forward");
        let task = self
            .forward_host(request, true, |channel, request| async {
                worker_host_client(channel).start_task(request).await
            })
            .await?;
        supertag_protocol::crash_point("api.start", "after-forward");
        Ok(task)
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
        supertag_protocol::crash_point("api.append-event", "before-forward");
        let event = self
            .forward_host(request, true, |channel, request| async {
                worker_host_client(channel).append_event(request).await
            })
            .await?;
        supertag_protocol::crash_point("api.append-event", "after-forward");
        Ok(event)
    }

    async fn finish_task(
        &self,
        request: Request<FinishTaskRequest>,
    ) -> Result<Response<Task>, Status> {
        supertag_protocol::crash_point("api.finish", "before-forward");
        let task = self
            .forward_host(request, true, |channel, request| async {
                worker_host_client(channel).finish_task(request).await
            })
            .await?;
        supertag_protocol::crash_point("api.finish", "after-forward");
        Ok(task)
    }
}

#[cfg(test)]
mod tests;
