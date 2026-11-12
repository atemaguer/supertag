use std::{sync::Arc, time::Duration};

use supertag_protocol::{
    MAX_MESSAGE_BYTES, MAX_WORKSPACE_TOOL_OUTPUT_BYTES, authenticated_request,
    v2::{
        HarnessWorkspaceRequest, HarnessWorkspaceResult, SharedExecutionAccessSummary, TaskState,
        harness_workspace_client::HarnessWorkspaceClient,
        harness_workspace_server::{HarnessWorkspace, HarnessWorkspaceServer},
    },
    validate_workspace_operation,
};
use tokio::{
    sync::Mutex,
    time::{self, Instant},
};
use tonic::{Request, Response, Status, transport::Channel};

use super::Bridge;

const CONTROL_TIMEOUT: Duration = Duration::from_secs(5);
const TOOL_TIMEOUT: Duration = Duration::from_secs(130);

/// A provider connection scoped to one sandbox, with its own private token.
#[derive(Clone)]
pub(crate) struct RemoteWorkspace {
    provider: Provider,
    operation: Arc<Mutex<()>>,
}

#[derive(Clone)]
enum Provider {
    Sandbox {
        client: HarnessWorkspaceClient<Channel>,
        token: String,
    },
    Shared(crate::shared_execution::Access),
}

impl RemoteWorkspace {
    pub(crate) fn new(channel: Channel, token: String) -> Self {
        Self {
            provider: Provider::Sandbox {
                client: HarnessWorkspaceClient::new(channel)
                    .max_decoding_message_size(MAX_WORKSPACE_TOOL_OUTPUT_BYTES + 16)
                    .max_encoding_message_size(MAX_MESSAGE_BYTES),
                token,
            },
            operation: Arc::default(),
        }
    }

    pub(crate) fn shared(access: crate::shared_execution::Access) -> Self {
        Self {
            provider: Provider::Shared(access),
            operation: Arc::default(),
        }
    }

    pub(super) fn shared_summary(&self) -> Option<SharedExecutionAccessSummary> {
        match &self.provider {
            Provider::Sandbox { .. } => None,
            Provider::Shared(access) => Some(access.summary.clone()),
        }
    }

    async fn execute(
        &self,
        input: HarnessWorkspaceRequest,
        deadline: Instant,
    ) -> Result<HarnessWorkspaceResult, Status> {
        match &self.provider {
            Provider::Shared(access) => access.execute(input).await,
            Provider::Sandbox { client, token } => {
                let mut downstream = authenticated_request(input, token, None)?;
                downstream.set_timeout(deadline.saturating_duration_since(Instant::now()));
                Ok(client.clone().execute(downstream).await?.into_inner())
            }
        }
    }
}

impl Bridge {
    pub(super) fn workspace_service(&self) -> HarnessWorkspaceServer<Self> {
        HarnessWorkspaceServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_WORKSPACE_TOOL_OUTPUT_BYTES + 16)
    }
}

#[tonic::async_trait]
impl HarnessWorkspace for Bridge {
    async fn execute(
        &self,
        request: Request<HarnessWorkspaceRequest>,
    ) -> Result<Response<HarnessWorkspaceResult>, Status> {
        self.authenticate(&request)?;
        self.require_attached()?;
        let workspace = self
            .workspace
            .as_ref()
            .ok_or_else(|| Status::failed_precondition("execution has no remote workspace"))?;
        let input = request.into_inner();
        let accepted = self.assignment.task.as_ref().expect("validated assignment");
        validate_workspace_operation(&input, &accepted.allowed_actions)?;
        let (mut deadline, closed) = self.inputs.authority();
        let tool_deadline = Instant::now() + TOOL_TIMEOUT;
        let operation = async {
            // Serialize tools so a command cannot race a scoped file operation.
            let _permit = workspace.operation.lock().await;
            let mut authority = authenticated_request(self.attempt(), &self.host_token, None)?;
            authority.set_timeout(CONTROL_TIMEOUT);
            let live = self
                .host
                .clone()
                .inspect_attempt(authority)
                .await?
                .into_inner();
            if live.state() != TaskState::Running
                || live.task_id != accepted.task_id
                || live.attempt_id.as_deref() != Some(self.assignment.attempt_id.as_str())
            {
                return Err(Status::failed_precondition(
                    "workspace execution authority expired",
                ));
            }
            let result = workspace.execute(input, tool_deadline).await?;
            if result.text.len() > MAX_WORKSPACE_TOOL_OUTPUT_BYTES {
                return Err(Status::data_loss(
                    "workspace provider returned oversized output",
                ));
            }
            Ok(Response::new(result))
        };
        tokio::pin!(operation);
        loop {
            let expires = (*deadline.borrow_and_update()).min(tool_deadline);
            if Instant::now() >= expires {
                return Err(Status::deadline_exceeded(
                    "workspace operation authority expired",
                ));
            }
            tokio::select! {
                biased;
                _ = closed.cancelled() => return Err(Status::failed_precondition("workspace execution is closed")),
                changed = deadline.changed() => changed.map_err(|_| Status::failed_precondition("workspace execution is closed"))?,
                _ = time::sleep_until(expires) => return Err(Status::deadline_exceeded("workspace operation authority expired")),
                result = &mut operation => return result,
            }
        }
    }
}
