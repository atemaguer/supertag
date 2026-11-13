mod apply_sets;
mod approvals;
mod artifact_acquisitions;
mod artifact_captures;
mod artifact_context;
mod artifact_direct;
mod artifact_publications;
mod artifact_volumes;
mod audit;
mod budget_pool;
mod checkpoints;
mod commit_reviews;
mod context;
mod conversations;
mod external_effects;
mod github_publications;
mod github_workspaces;
mod history;
mod inbox;
mod inputs;
mod mailbox;
mod manifest_relationships;
mod mcp_effects;
pub mod objective_limits;
mod objectives;
mod operator_access;
mod policy;
mod replies;
mod review_artifacts;
mod store;
mod surface_policy;
mod tags;
mod task_artifact_inputs;
mod teams;
mod usage;
mod watch;
mod work_sessions;
mod workspace_mounts;
mod workspaces;

pub use audit::{AuditLayer, AuditService};
pub use github_workspaces::validate_manifest_workspace;
pub use objectives::validate_manifest_objective;
pub use operator_access::{AuditRecord, OPERATOR_TOKEN_LIFETIME_MS, OperatorAuthentication};
pub use policy::{
    normalize_manifest_context, normalize_manifest_permission, normalize_manifest_role,
    normalize_tag_execution,
};
pub use store::{HostAuthority, Store, StoreError};
pub use surface_policy::{validate_manifest_account, validate_manifest_location};
pub use watch::OperatorWatch;

use std::sync::Arc;

use supertag_protocol::{host_generation, incoming_principal, v2::*};
use tonic::{Request, Response, Status};

#[derive(Clone)]
pub struct ControlPlane {
    store: Store,
    gateway_token: Arc<String>,
}

impl ControlPlane {
    pub async fn open(database_url: &str, gateway_token: String) -> anyhow::Result<Self> {
        anyhow::ensure!(
            !gateway_token.is_empty(),
            "a private Gateway credential is required"
        );
        Ok(Self {
            store: Store::open(database_url).await?,
            gateway_token: Arc::new(gateway_token),
        })
    }

    pub async fn seed_host(&self, host_id: &str, token_digest: &[u8]) -> anyhow::Result<()> {
        self.store.seed_host(host_id, token_digest).await?;
        Ok(())
    }

    fn host_authority<T>(&self, request: &Request<T>) -> Result<HostAuthority, Status> {
        let principal = self.principal(request, "host:")?;
        Ok(HostAuthority::new(principal, host_generation(request)?)?)
    }

    pub async fn sweep(&self) -> anyhow::Result<()> {
        self.store.sweep_objectives().await?;
        self.store.sweep_expired_attempts().await?;
        self.store.sweep_inputs().await?;
        self.store.sweep_artifact_transfer_grants().await?;
        self.store.sweep_mailbox().await?;
        self.store.sweep_approvals().await?;
        self.store.sweep_work_sessions().await?;
        self.store.sweep_commit_reviews().await?;
        self.store.sweep_replies().await?;
        self.store.sweep_github_publications().await?;
        self.store.prune_watch().await?;
        Ok(())
    }

    fn principal<T>(&self, request: &Request<T>, class: &str) -> Result<String, Status> {
        let principal = incoming_principal(request, &self.gateway_token)?;
        let Some(identity) = principal.strip_prefix(class) else {
            return Err(Status::permission_denied(
                "caller is not allowed to use this service",
            ));
        };
        if identity.is_empty() || principal.len() > 256 {
            return Err(Status::permission_denied("invalid caller identity"));
        }
        Ok(principal.to_owned())
    }
}

impl From<StoreError> for Status {
    fn from(error: StoreError) -> Self {
        match error {
            StoreError::InvalidArgument(message) => Self::invalid_argument(message),
            StoreError::NotFound(message) => Self::not_found(message),
            StoreError::Conflict(message) => Self::already_exists(message),
            StoreError::FailedPrecondition(message) => Self::failed_precondition(message),
            StoreError::PermissionDenied => {
                Self::permission_denied("execution ownership does not match")
            }
            StoreError::Storage(_) | StoreError::Data(_) => {
                Self::internal("storage operation failed")
            }
        }
    }
}

#[tonic::async_trait]
impl operator_server::Operator for ControlPlane {
    async fn get_reply_delivery(
        &self,
        request: Request<GetReplyDeliveryRequest>,
    ) -> Result<Response<ReplyDelivery>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .get_reply_delivery(&principal, &request.into_inner().reply_id)
                .await?,
        ))
    }

    async fn list_reply_deliveries(
        &self,
        request: Request<ListReplyDeliveriesRequest>,
    ) -> Result<Response<ListReplyDeliveriesResponse>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .list_reply_deliveries(&principal, &request.into_inner())
                .await?,
        ))
    }

    async fn resolve_reply(
        &self,
        request: Request<ResolveReplyRequest>,
    ) -> Result<Response<ReplyDelivery>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .resolve_reply(&principal, &request.into_inner())
                .await?,
        ))
    }

    async fn list_hosts(
        &self,
        request: Request<ListHostsRequest>,
    ) -> Result<Response<ListHostsResponse>, Status> {
        self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store.list_hosts(&request.into_inner()).await?,
        ))
    }

    async fn get_host(
        &self,
        request: Request<GetHostRequest>,
    ) -> Result<Response<WorkerHostStatus>, Status> {
        self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store.get_host(&request.into_inner().host_id).await?,
        ))
    }

    async fn set_host_draining(
        &self,
        request: Request<SetHostDrainingRequest>,
    ) -> Result<Response<WorkerHostStatus>, Status> {
        self.principal(&request, "operator:")?;
        let input = request.into_inner();
        Ok(Response::new(
            self.store
                .set_host_draining(&input.host_id, input.draining)
                .await?,
        ))
    }

    async fn create_auth_key(
        &self,
        request: Request<CreateAuthKeyRequest>,
    ) -> Result<Response<AuthKey>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .create_auth_key(&principal, &request.into_inner())
                .await?,
        ))
    }

    async fn revoke_host(
        &self,
        request: Request<RevokeHostRequest>,
    ) -> Result<Response<HostRecord>, Status> {
        self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .revoke_host(&request.into_inner().host_id)
                .await?,
        ))
    }

    async fn put_tag(&self, request: Request<PutTagRequest>) -> Result<Response<Tag>, Status> {
        self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store.put_tag_spec(request.into_inner()).await?,
        ))
    }

    async fn get_tag(&self, request: Request<GetTagRequest>) -> Result<Response<Tag>, Status> {
        self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store.get_tag(&request.into_inner().tag_id).await?,
        ))
    }

    async fn retire_tag(
        &self,
        request: Request<RetireTagRequest>,
    ) -> Result<Response<RetireTagResponse>, Status> {
        self.principal(&request, "operator:")?;
        let input = request.into_inner();
        Ok(Response::new(
            self.store.retire_tag(&input.tag_id, input.dry_run).await?,
        ))
    }

    async fn list_tags(
        &self,
        request: Request<ListTagsRequest>,
    ) -> Result<Response<ListTagsResponse>, Status> {
        self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store.list_tags(&request.into_inner()).await?,
        ))
    }

    async fn submit_task(
        &self,
        request: Request<SubmitTaskRequest>,
    ) -> Result<Response<Task>, Status> {
        let principal = self.principal(&request, "operator:")?;
        let task = self
            .store
            .submit_task(&principal, &request.into_inner())
            .await?;
        supertag_protocol::crash_point("control-plane.submit", "after-commit");
        Ok(Response::new(task))
    }

    async fn get_task(&self, request: Request<GetTaskRequest>) -> Result<Response<Task>, Status> {
        let principal = self.principal(&request, "operator:")?;
        let task_id = request.into_inner().task_id;
        self.store.ensure_task_access(&principal, &task_id).await?;
        Ok(Response::new(self.store.get_task(&task_id).await?))
    }

    async fn list_native_usage(
        &self,
        request: Request<ListNativeUsageRequest>,
    ) -> Result<Response<ListNativeUsageResponse>, Status> {
        let principal = self.principal(&request, "operator:")?;
        let input = request.into_inner();
        self.store
            .ensure_task_access(&principal, &input.task_id)
            .await?;
        Ok(Response::new(self.store.list_native_usage(&input).await?))
    }

    async fn list_events(
        &self,
        request: Request<ListEventsRequest>,
    ) -> Result<Response<ListEventsResponse>, Status> {
        let principal = self.principal(&request, "operator:")?;
        let input = request.into_inner();
        self.store
            .ensure_task_access(&principal, &input.task_id)
            .await?;
        Ok(Response::new(ListEventsResponse {
            events: self
                .store
                .list_events(&input.task_id, input.after_sequence, input.limit)
                .await?,
        }))
    }

    async fn cancel_task(
        &self,
        request: Request<CancelTaskRequest>,
    ) -> Result<Response<Task>, Status> {
        let principal = self.principal(&request, "operator:")?;
        let task_id = request.into_inner().task_id;
        self.store.ensure_task_access(&principal, &task_id).await?;
        Ok(Response::new(self.store.cancel_task(&task_id).await?))
    }

    async fn resolve_attempt(
        &self,
        request: Request<ResolveAttemptRequest>,
    ) -> Result<Response<AttemptResolution>, Status> {
        let principal = self.principal(&request, "operator:")?;
        let input = request.into_inner();
        self.store
            .ensure_task_access(&principal, &input.task_id)
            .await?;
        Ok(Response::new(
            self.store.resolve_attempt(&principal, &input).await?,
        ))
    }
}

#[tonic::async_trait]
impl worker_host_server::WorkerHost for ControlPlane {
    async fn get_attempt_history(
        &self,
        request: Request<InspectAttemptRequest>,
    ) -> Result<Response<AttemptHistory>, Status> {
        let host = self.host_authority(&request)?;
        Ok(Response::new(
            self.store
                .get_attempt_history(&host, request.get_ref())
                .await?,
        ))
    }

    async fn get_context_pins(
        &self,
        request: Request<InspectAttemptRequest>,
    ) -> Result<Response<ContextResolutionManifest>, Status> {
        let host = self.host_authority(&request)?;
        Ok(Response::new(
            self.store
                .get_context_pins(&host, request.get_ref())
                .await?,
        ))
    }

    async fn commit_context_resolution(
        &self,
        request: Request<CommitContextResolutionRequest>,
    ) -> Result<Response<ContextResolutionManifest>, Status> {
        let host = self.host_authority(&request)?;
        Ok(Response::new(
            self.store
                .commit_context_resolution(&host, request.get_ref())
                .await?,
        ))
    }
    async fn report_host(
        &self,
        request: Request<ReportHostRequest>,
    ) -> Result<Response<WorkerHostStatus>, Status> {
        let authority = self.host_authority(&request)?;
        Ok(Response::new(
            self.store
                .report_host(&authority, &request.into_inner())
                .await?,
        ))
    }

    async fn ask_question(
        &self,
        request: Request<AskQuestionRequest>,
    ) -> Result<Response<ObjectiveQuestion>, Status> {
        let authority = self.host_authority(&request)?;
        Ok(Response::new(
            self.store
                .ask_question(&authority, &request.into_inner())
                .await?,
        ))
    }

    async fn get_attempt_capabilities(
        &self,
        request: Request<InspectAttemptRequest>,
    ) -> Result<Response<AttemptCapabilities>, Status> {
        let authority = self.host_authority(&request)?;
        Ok(Response::new(
            self.store
                .attempt_capabilities(&authority, &request.into_inner())
                .await?,
        ))
    }

    async fn register_host(
        &self,
        request: Request<RegisterHostRequest>,
    ) -> Result<Response<HostRecord>, Status> {
        let principal = self.principal(&request, "host:")?;
        let host_id = principal
            .strip_prefix("host:")
            .expect("checked host principal");
        let input = request.into_inner();
        Ok(Response::new(
            self.store
                .register_host(host_id, &input.incarnation_id)
                .await?,
        ))
    }

    async fn claim_task(
        &self,
        request: Request<ClaimTaskRequest>,
    ) -> Result<Response<ClaimTaskResponse>, Status> {
        let principal = self.host_authority(&request)?;
        let input = request.into_inner();
        let harness = HarnessKind::try_from(input.harness_kind)
            .map_err(|_| Status::invalid_argument("unknown harness kind"))?;
        let assignment = self
            .store
            .claim_task_with_sources(
                &principal,
                &input.operation_id,
                (&input.workspace_ids, &input.gateway_workspace_ids),
                harness,
                &input.context_contracts,
                input.execution_profile.as_ref(),
            )
            .await?;
        if assignment.is_some() {
            supertag_protocol::crash_point("control-plane.claim", "after-commit");
        }
        Ok(Response::new(ClaimTaskResponse { assignment }))
    }

    async fn start_task(
        &self,
        request: Request<StartTaskRequest>,
    ) -> Result<Response<Task>, Status> {
        let principal = self.host_authority(&request)?;
        let task = self
            .store
            .start_task(&principal, &request.into_inner())
            .await?;
        supertag_protocol::crash_point("control-plane.start", "after-commit");
        Ok(Response::new(task))
    }

    async fn inspect_attempt(
        &self,
        request: Request<InspectAttemptRequest>,
    ) -> Result<Response<Task>, Status> {
        let principal = self.host_authority(&request)?;
        let input = request.into_inner();
        Ok(Response::new(
            self.store
                .inspect_attempt(
                    &principal,
                    &input.task_id,
                    &input.attempt_id,
                    &input.lease_token,
                )
                .await?,
        ))
    }

    async fn renew_attempt(
        &self,
        request: Request<InspectAttemptRequest>,
    ) -> Result<Response<AttemptAuthority>, Status> {
        let principal = self.host_authority(&request)?;
        Ok(Response::new(
            self.store
                .renew_attempt(&principal, &request.into_inner())
                .await?,
        ))
    }

    async fn get_attempt_resolution(
        &self,
        request: Request<InspectAttemptRequest>,
    ) -> Result<Response<GetAttemptResolutionResponse>, Status> {
        let principal = self.host_authority(&request)?;
        Ok(Response::new(GetAttemptResolutionResponse {
            resolution: self
                .store
                .get_attempt_resolution(&principal, &request.into_inner())
                .await?,
        }))
    }

    async fn report_attempt_usage(
        &self,
        request: Request<ReportAttemptUsageRequest>,
    ) -> Result<Response<ReportAttemptUsageResponse>, Status> {
        let principal = self.host_authority(&request)?;
        self.store
            .report_attempt_usage(&principal, &request.into_inner())
            .await?;
        Ok(Response::new(ReportAttemptUsageResponse {}))
    }

    async fn append_event(
        &self,
        request: Request<AppendEventRequest>,
    ) -> Result<Response<TaskEvent>, Status> {
        let principal = self.host_authority(&request)?;
        let event = self
            .store
            .append_event(&principal, &request.into_inner())
            .await?;
        supertag_protocol::crash_point("control-plane.append-event", "after-commit");
        Ok(Response::new(event))
    }

    async fn finish_task(
        &self,
        request: Request<FinishTaskRequest>,
    ) -> Result<Response<Task>, Status> {
        let principal = self.host_authority(&request)?;
        let task = self
            .store
            .finish_task(&principal, &request.into_inner())
            .await?;
        supertag_protocol::crash_point("control-plane.finish", "after-commit");
        Ok(Response::new(task))
    }
}

#[tonic::async_trait]
impl host_directory_server::HostDirectory for ControlPlane {
    async fn enroll(
        &self,
        request: Request<PrivateEnrollHostRequest>,
    ) -> Result<Response<HostRecord>, Status> {
        self.principal(&request, "service:")?;
        let input = request.into_inner();
        let enrollment = input
            .enrollment
            .ok_or_else(|| Status::invalid_argument("enrollment required"))?;
        Ok(Response::new(
            self.store
                .enroll_host(&enrollment, &input.key_digest)
                .await?,
        ))
    }

    async fn authenticate(
        &self,
        request: Request<AuthenticateHostRequest>,
    ) -> Result<Response<HostRecord>, Status> {
        self.principal(&request, "service:")?;
        Ok(Response::new(
            self.store
                .authenticate_host(&request.into_inner().token_digest)
                .await?,
        ))
    }
}

#[tonic::async_trait]
impl connector_server::Connector for ControlPlane {
    async fn renew_reply(
        &self,
        request: Request<RenewReplyRequest>,
    ) -> Result<Response<ReplyLease>, Status> {
        let principal = self.principal(&request, "connector:")?;
        Ok(Response::new(
            self.store
                .renew_reply(&principal, &request.into_inner())
                .await?,
        ))
    }

    async fn accept_event(
        &self,
        request: Request<AcceptEventRequest>,
    ) -> Result<Response<Task>, Status> {
        let principal = self.principal(&request, "connector:")?;
        Ok(Response::new(
            self.store
                .accept_event(&principal, &request.into_inner())
                .await?,
        ))
    }

    async fn accept_slack_event(
        &self,
        request: Request<AcceptSlackEventRequest>,
    ) -> Result<Response<AcceptSlackEventResponse>, Status> {
        let principal = self.principal(&request, "connector:")?;
        let accepted = self
            .store
            .accept_slack_event(&principal, &request.into_inner())
            .await?;
        supertag_protocol::crash_point("control-plane.slack-admission", "after-commit");
        Ok(Response::new(accepted))
    }

    async fn accept_github_event(
        &self,
        request: Request<AcceptGithubEventRequest>,
    ) -> Result<Response<AcceptGithubEventResponse>, Status> {
        let principal = self.principal(&request, "connector:")?;
        Ok(Response::new(
            self.store
                .accept_github_event(&principal, &request.into_inner())
                .await?,
        ))
    }

    async fn accept_linear_event(
        &self,
        request: Request<AcceptLinearEventRequest>,
    ) -> Result<Response<AcceptLinearEventResponse>, Status> {
        let principal = self.principal(&request, "connector:")?;
        Ok(Response::new(
            self.store
                .accept_linear_event(&principal, &request.into_inner())
                .await?,
        ))
    }

    async fn accept_lark_event(
        &self,
        request: Request<AcceptLarkEventRequest>,
    ) -> Result<Response<AcceptLarkEventResponse>, Status> {
        let principal = self.principal(&request, "connector:")?;
        Ok(Response::new(
            self.store
                .accept_lark_event(&principal, &request.into_inner())
                .await?,
        ))
    }

    async fn accept_microsoft_teams_activity(
        &self,
        request: Request<AcceptMicrosoftTeamsActivityRequest>,
    ) -> Result<Response<AcceptMicrosoftTeamsActivityResponse>, Status> {
        let principal = self.principal(&request, "connector:")?;
        Ok(Response::new(
            self.store
                .accept_microsoft_teams_activity(&principal, &request.into_inner())
                .await?,
        ))
    }

    async fn get_microsoft_teams_reply_route(
        &self,
        request: Request<GetMicrosoftTeamsReplyRouteRequest>,
    ) -> Result<Response<MicrosoftTeamsReplyRoute>, Status> {
        let principal = self.principal(&request, "connector:")?;
        Ok(Response::new(
            self.store
                .get_microsoft_teams_reply_route(&principal, &request.into_inner())
                .await?,
        ))
    }

    async fn claim_reply(
        &self,
        request: Request<ClaimReplyRequest>,
    ) -> Result<Response<ClaimReplyResponse>, Status> {
        let principal = self.principal(&request, "connector:")?;
        let claim = self
            .store
            .claim_reply(&principal, &request.into_inner().operation_id)
            .await?;
        if claim.reply.is_some() {
            supertag_protocol::crash_point("control-plane.claim-reply", "after-commit");
        }
        Ok(Response::new(claim))
    }

    async fn settle_reply(
        &self,
        request: Request<SettleReplyRequest>,
    ) -> Result<Response<Reply>, Status> {
        let principal = self.principal(&request, "connector:")?;
        let reply = self
            .store
            .settle_reply(&principal, &request.into_inner())
            .await?;
        supertag_protocol::crash_point("control-plane.settle-reply", "after-commit");
        Ok(Response::new(reply))
    }
}

#[tonic::async_trait]
impl live_inputs_server::LiveInputs for ControlPlane {
    async fn queue_input(
        &self,
        request: Request<QueueInputRequest>,
    ) -> Result<Response<LiveInput>, Status> {
        let principal = self.principal(&request, "operator:")?;
        let input = request.into_inner();
        self.store
            .ensure_task_access(&principal, &input.task_id)
            .await?;
        Ok(Response::new(
            self.store.queue_input(&principal, &input).await?,
        ))
    }

    async fn get_input(
        &self,
        request: Request<GetInputRequest>,
    ) -> Result<Response<LiveInput>, Status> {
        let principal = self.principal(&request, "operator:")?;
        let input_id = request.into_inner().input_id;
        self.store
            .ensure_input_access(&principal, &input_id)
            .await?;
        Ok(Response::new(self.store.get_input(&input_id).await?))
    }

    async fn resolve_input(
        &self,
        request: Request<ResolveInputRequest>,
    ) -> Result<Response<LiveInput>, Status> {
        let principal = self.principal(&request, "operator:")?;
        let input = request.into_inner();
        self.store
            .ensure_input_access(&principal, &input.input_id)
            .await?;
        Ok(Response::new(
            self.store.resolve_input(&principal, &input).await?,
        ))
    }
}

#[tonic::async_trait]
impl attempt_inputs_server::AttemptInputs for ControlPlane {
    async fn take_input(
        &self,
        request: Request<TakeInputRequest>,
    ) -> Result<Response<TakeInputResponse>, Status> {
        let host = self.host_authority(&request)?;
        Ok(Response::new(
            self.store
                .take_input_for_host(&host, &request.into_inner())
                .await?,
        ))
    }

    async fn settle_input(
        &self,
        request: Request<SettleInputRequest>,
    ) -> Result<Response<LiveInput>, Status> {
        let host = self.host_authority(&request)?;
        Ok(Response::new(
            self.store
                .settle_input(&host, &request.into_inner())
                .await?,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use supertag_protocol::{
        authenticated_request, v2::connector_server::Connector, v2::operator_server::Operator,
        v2::worker_host_server::WorkerHost,
    };

    #[tokio::test]
    async fn private_api_requires_gateway_and_preserves_principal_class() {
        let cp = ControlPlane::open("sqlite::memory:", "private-key".into())
            .await
            .unwrap();
        let tag = PutTagRequest {
            name: None,
            expected_revision: None,
            execution: None,
            approval_rules: vec![],
            harness_kind: 0,
            workspace: None,
            tag_id: "tag".into(),
            instructions: String::new(),
            allowed_actions: vec![],
        };
        assert_eq!(
            cp.put_tag(Request::new(tag.clone()))
                .await
                .unwrap_err()
                .code(),
            tonic::Code::Unauthenticated
        );
        assert_eq!(
            cp.put_tag(
                authenticated_request(tag.clone(), "wrong", Some("operator:alice")).unwrap()
            )
            .await
            .unwrap_err()
            .code(),
            tonic::Code::Unauthenticated
        );
        assert_eq!(
            cp.put_tag(
                authenticated_request(tag.clone(), "private-key", Some("host:worker")).unwrap()
            )
            .await
            .unwrap_err()
            .code(),
            tonic::Code::PermissionDenied
        );
        assert_eq!(
            cp.put_tag(
                authenticated_request(tag.clone(), "private-key", Some("operator:")).unwrap()
            )
            .await
            .unwrap_err()
            .code(),
            tonic::Code::PermissionDenied
        );
        assert!(
            cp.put_tag(authenticated_request(tag, "private-key", Some("operator:alice")).unwrap())
                .await
                .is_ok()
        );
        let claim = ClaimTaskRequest {
            harness_kind: 0,
            workspace_ids: vec![],
            operation_id: "claim".into(),
            context_contracts: vec![],
            execution_profile: None,
            gateway_workspace_ids: vec![],
        };
        assert_eq!(
            cp.claim_task(
                authenticated_request(claim, "private-key", Some("operator:alice")).unwrap()
            )
            .await
            .unwrap_err()
            .code(),
            tonic::Code::PermissionDenied
        );
        assert_eq!(
            cp.claim_reply(
                authenticated_request(
                    ClaimReplyRequest {
                        operation_id: "delivery".into()
                    },
                    "private-key",
                    Some("operator:alice")
                )
                .unwrap()
            )
            .await
            .unwrap_err()
            .code(),
            tonic::Code::PermissionDenied
        );
        assert_eq!(
            cp.accept_event(
                authenticated_request(
                    AcceptEventRequest {
                        requested_execution: None,
                        account_id: "account-a".into(),
                        event_id: "event".into(),
                        tag_id: "tag".into(),
                        session_id: "session".into(),
                        prompt: "hello".into(),
                        destination: Some(ReplyDestination {
                            conversation_id: "room".into(),
                            thread_id: None
                        })
                    },
                    "private-key",
                    Some("connector:account-b")
                )
                .unwrap()
            )
            .await
            .unwrap_err()
            .code(),
            tonic::Code::PermissionDenied
        );
    }
}
