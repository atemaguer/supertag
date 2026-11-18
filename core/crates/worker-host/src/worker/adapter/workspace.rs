use std::{sync::Arc, time::Duration};

use supertag_protocol::{
    MAX_MESSAGE_BYTES, MAX_WORKSPACE_TOOL_OUTPUT_BYTES, authenticated_request,
    v2::{
        HarnessWorkspaceRequest, HarnessWorkspaceResult, SharedExecutionAccessSummary, TaskState,
        harness_workspace_client::HarnessWorkspaceClient,
        harness_workspace_request::Operation,
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
    /// Asks the Attempt to replace a sandbox its provider found gone.
    replacer: Option<Replacer>,
    /// The connection of the sandbox that replaced the first, once one did.
    replaced: Arc<std::sync::Mutex<Option<(Channel, String)>>>,
}

/// A request to replace the Attempt's lost sandbox, answered with the new sandbox's connection
/// or a fixed reason it could not be replaced.
pub(crate) type Replacer = tokio::sync::mpsc::Sender<
    tokio::sync::oneshot::Sender<Result<(Channel, String), &'static str>>,
>;

#[derive(Clone)]
enum Provider {
    Sandbox {
        channel: Channel,
        client: HarnessWorkspaceClient<Channel>,
        token: String,
    },
    /// A sandbox still being prepared while the Harness already runs. A tool waits for it; if
    /// preparation fails, every tool fails with the reason, and nothing runs on the host.
    Pending(tokio::sync::watch::Receiver<Option<Result<(Channel, String), String>>>),
    Shared(crate::worker::shared_execution::Access),
}

/// What a sandbox prepared in the background sends its pending workspace: its connection, or why
/// it could not be prepared.
pub(crate) type SandboxReady =
    tokio::sync::watch::Sender<Option<Result<(Channel, String), String>>>;
/// The receiving end of [`SandboxReady`].
pub(crate) type SandboxSource =
    tokio::sync::watch::Receiver<Option<Result<(Channel, String), String>>>;

impl RemoteWorkspace {
    pub(crate) fn new(channel: Channel, token: String) -> Self {
        Self {
            provider: Provider::Sandbox {
                client: client(channel.clone()),
                channel,
                token,
            },
            operation: Arc::default(),
            replacer: None,
            replaced: Arc::default(),
        }
    }

    /// Lets a lost sandbox be replaced through `replacer`.
    pub(crate) fn with_replacer(mut self, replacer: Replacer) -> Self {
        self.replacer = Some(replacer);
        self
    }

    /// A workspace whose sandbox is prepared in the background; `ready` says when it is.
    pub(crate) fn pending() -> (Self, SandboxReady) {
        let (ready, receiver) = tokio::sync::watch::channel(None);
        (
            Self {
                provider: Provider::Pending(receiver),
                operation: Arc::default(),
                replacer: None,
                replaced: Arc::default(),
            },
            ready,
        )
    }

    pub(crate) fn shared(access: crate::worker::shared_execution::Access) -> Self {
        Self {
            provider: Provider::Shared(access),
            operation: Arc::default(),
            replacer: None,
            replaced: Arc::default(),
        }
    }

    /// Where the sandbox's provider helper is reached once it is staged, for Codex's executor;
    /// None for shared execution, which has no sandbox.
    pub(crate) fn sandbox_ready(&self) -> Option<SandboxSource> {
        match &self.provider {
            Provider::Sandbox { channel, token, .. } => {
                let (_ready, source) =
                    tokio::sync::watch::channel(Some(Ok((channel.clone(), token.clone()))));
                Some(source)
            }
            Provider::Pending(ready) => Some(ready.clone()),
            Provider::Shared(_) => None,
        }
    }

    pub(super) fn shared_summary(&self) -> Option<SharedExecutionAccessSummary> {
        match &self.provider {
            Provider::Sandbox { .. } | Provider::Pending(_) => None,
            Provider::Shared(access) => Some(access.summary.clone()),
        }
    }

    async fn execute(
        &self,
        input: HarnessWorkspaceRequest,
        deadline: Instant,
        bridge: &Bridge,
    ) -> Result<HarnessWorkspaceResult, Status> {
        let replaced = self
            .replaced
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        let result = match replaced {
            Some((channel, token)) => sandbox(&client(channel), &token, input, deadline).await?,
            None => self.execute_first(input, deadline, bridge).await?,
        };
        if !result.sandbox_lost {
            return Ok(result);
        }
        // The provider confirmed this sandbox is gone. The call is not retried: a write or a
        // command must not run again against files reverted to the start of the turn.
        let text = match self.replace().await {
            Ok(connection) => {
                *self
                    .replaced
                    .lock()
                    .unwrap_or_else(|error| error.into_inner()) = Some(connection);
                crate::worker::remote::SANDBOX_REPLACED.to_owned()
            }
            Err(reason) => format!(
                "The sandbox stopped and could not be replaced ({reason}), so this turn's Workspace is gone."
            ),
        };
        Ok(HarnessWorkspaceResult {
            text,
            is_error: true,
            sandbox_lost: false,
        })
    }

    async fn replace(&self) -> Result<(Channel, String), &'static str> {
        let replacer = self
            .replacer
            .as_ref()
            .ok_or("this Workspace cannot replace its sandbox")?;
        let (reply, answer) = tokio::sync::oneshot::channel();
        replacer
            .send(reply)
            .await
            .map_err(|_| "the Attempt is ending")?;
        answer.await.map_err(|_| "the Attempt is ending")?
    }

    async fn execute_first(
        &self,
        input: HarnessWorkspaceRequest,
        deadline: Instant,
        bridge: &Bridge,
    ) -> Result<HarnessWorkspaceResult, Status> {
        match &self.provider {
            Provider::Shared(access) => match input {
                HarnessWorkspaceRequest {
                    operation: Some(Operation::Command(command)),
                } => {
                    access
                        .command(command, deadline, || bridge.fresh_command_authority())
                        .await
                }
                input => access.execute(input).await,
            },
            Provider::Sandbox { client, token, .. } => {
                sandbox(client, token, input, deadline).await
            }
            Provider::Pending(ready) => {
                let mut ready = ready.clone();
                let prepared = time::timeout_at(deadline, ready.wait_for(Option::is_some))
                    .await
                    .map_err(|_| {
                        Status::deadline_exceeded("the remote Workspace is not ready yet")
                    })?
                    .map_err(|error| {
                        crate::failures::noted(
                            Status::unavailable("Remote Workspace could not be prepared"),
                            &error,
                        )
                    })?
                    .clone()
                    .expect("waited for a value");
                let (channel, token) = prepared.map_err(Status::unavailable)?;
                sandbox(&client(channel), &token, input, deadline).await
            }
        }
    }
}

fn client(channel: Channel) -> HarnessWorkspaceClient<Channel> {
    HarnessWorkspaceClient::new(channel)
        .max_decoding_message_size(MAX_WORKSPACE_TOOL_OUTPUT_BYTES + 16)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
}

/// Run one operation in the sandbox. A provider that cannot be reached, or fails, returns its
/// error to the harness: nothing runs on the Worker Host instead.
async fn sandbox(
    client: &HarnessWorkspaceClient<Channel>,
    token: &str,
    input: HarnessWorkspaceRequest,
    deadline: Instant,
) -> Result<HarnessWorkspaceResult, Status> {
    let mut downstream = authenticated_request(input, token, None)?;
    downstream.set_timeout(deadline.saturating_duration_since(Instant::now()));
    Ok(client.clone().execute(downstream).await?.into_inner())
}

impl Bridge {
    pub(super) fn workspace_service(&self) -> HarnessWorkspaceServer<Self> {
        HarnessWorkspaceServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_WORKSPACE_TOOL_OUTPUT_BYTES + 16)
    }

    async fn fresh_command_authority(&self) -> Result<u64, Status> {
        let sent = Instant::now();
        let timeout = Duration::from_millis(1_500);
        let authority = time::timeout(timeout, self.lease.renew(timeout))
            .await
            .map_err(|_| Status::deadline_exceeded("Task authority renewal timed out"))?
            .map_err(|error| {
                crate::failures::noted(
                    Status::failed_precondition("Task authority renewal was refused"),
                    &error,
                )
            })?;
        if !authority.task.is_some_and(|task| {
            task.state() == TaskState::Running
                && task.task_id == self.task_id()
                && task.attempt_id.as_deref() == Some(self.assignment.attempt_id.as_str())
        }) {
            return Err(Status::failed_precondition(
                "Control Plane ended command authority",
            ));
        }
        let elapsed = u64::try_from(sent.elapsed().as_millis()).unwrap_or(u64::MAX);
        let remaining = authority
            .valid_for_ms
            .saturating_sub(elapsed)
            .saturating_sub(100);
        if remaining == 0 {
            return Err(Status::failed_precondition(
                "Control Plane ended command authority",
            ));
        }
        Ok(remaining)
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
        validate_workspace_operation(
            &input,
            &accepted.allowed_actions,
            supertag_protocol::file_scope::of_task(accepted),
        )?;
        let (mut deadline, closed) = self.inputs.authority();
        let tool_deadline = Instant::now() + TOOL_TIMEOUT;
        let operation = async {
            // Serialize tools so a command cannot race a scoped file operation.
            let _permit = workspace.operation.lock().await;
            let live = self.lease.inspect(CONTROL_TIMEOUT).await?;
            if live.state() != TaskState::Running
                || live.task_id != accepted.task_id
                || live.attempt_id.as_deref() != Some(self.assignment.attempt_id.as_str())
            {
                return Err(Status::failed_precondition(
                    "workspace execution authority expired",
                ));
            }
            let result = workspace.execute(input, tool_deadline, self).await?;
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
                changed = deadline.changed() => changed.map_err(|error| crate::failures::noted(Status::failed_precondition("workspace execution is closed"), &error))?,
                _ = time::sleep_until(expires) => return Err(Status::deadline_exceeded("workspace operation authority expired")),
                result = &mut operation => return result,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use supertag_protocol::v2::{WorkspaceCommand, WorkspaceWrite};
    use tonic::transport::Endpoint;

    /// A remote sandbox that became unreachable fails its file and command tools; the Worker
    /// Host never runs them itself.
    #[tokio::test]
    async fn an_unreachable_sandbox_fails_every_tool_without_a_host_effect() {
        let workspace = tempfile::tempdir().unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        let channel = Endpoint::from_shared(format!("http://{address}"))
            .unwrap()
            .connect_timeout(Duration::from_millis(500))
            .connect_lazy();
        let client = HarnessWorkspaceClient::new(channel);
        let marker = workspace.path().join("fallback");
        for operation in [
            Operation::Write(WorkspaceWrite {
                path: "fallback".into(),
                content: "written on the host".into(),
            }),
            Operation::Command(WorkspaceCommand {
                command: format!("touch {}", marker.display()),
                timeout_ms: Some(1_000),
            }),
        ] {
            let result = sandbox(
                &client,
                "fixture",
                HarnessWorkspaceRequest {
                    operation: Some(operation),
                },
                Instant::now() + Duration::from_secs(5),
            )
            .await;
            assert!(result.is_err(), "{result:?}");
        }
        assert!(!marker.exists());
        assert!(!std::env::current_dir().unwrap().join("fallback").exists());
    }
}
