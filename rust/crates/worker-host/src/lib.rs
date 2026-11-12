mod adapter;
mod artifact_inputs;
mod artifact_snapshots;
mod checkpoints;
pub mod context;
mod credentials;
mod enrollment;
mod guardian;
mod journal;
mod mcp;
mod readiness;
mod remote;
mod remote_provider;
mod shared_execution;
mod task_outputs;
mod workspaces;

pub use credentials::{provider_environment, provider_environment_for, validate_opencode_model};
pub use enrollment::enroll;
pub use guardian::{ADAPTER_STATE_DIRECTORY, guard_adapter};
pub use mcp::McpCatalog;
pub use remote_provider::{ProviderAuthority, ProviderConfig};
pub use shared_execution::SharedExecutionConfig;
pub use workspaces::{WORKSPACE_DIRECTORY, WorkspaceMapping, WorkspaceSource};

use std::{ffi::OsString, path::PathBuf, sync::Arc, time::Duration};

use anyhow::{Context, Result, bail, ensure};
use journal::{Attempt, Entry, Journal};
use prost::Message;
use supertag_protocol::{
    HOST_GENERATION_HEADER, MAX_MESSAGE_BYTES, authenticated_request,
    v2::{
        Assignment, AttemptExecutionSelection, ClaimTaskRequest, CommitContextResolutionRequest,
        FinishTaskRequest, HarnessCompleteRequest, HarnessExecutionProfile, HarnessKind,
        HostRecord, InspectAttemptRequest, RegisterHostRequest, ResolvedSkill, StartTaskRequest,
        Task, TaskState, artifact_transfers_client::ArtifactTransfersClient,
        attempt_artifacts_client::AttemptArtifactsClient,
        attempt_inputs_client::AttemptInputsClient, attempt_mailbox_client::AttemptMailboxClient,
        attempt_mcp_effects_client::AttemptMcpEffectsClient,
        attempt_work_sessions_client::AttemptWorkSessionsClient,
        attempt_workstreams_client::AttemptWorkstreamsClient, worker_host_client::WorkerHostClient,
    },
};
use tokio::time::{self, Instant};
use tokio_util::sync::CancellationToken;
use tonic::{
    Code, Request, Status,
    metadata::{Ascii, MetadataValue},
    service::{Interceptor, interceptor::InterceptedService},
    transport::{Channel, Endpoint},
};
use uuid::Uuid;

pub struct HostOptions {
    pub gateway: Endpoint,
    pub token: Option<String>,
    pub state_directory: PathBuf,
    pub adapter_guardian: PathBuf,
    pub adapter: PathBuf,
    pub adapter_args: Vec<OsString>,
    pub harness: HarnessKind,
    pub provider_model: Option<String>,
    pub execution_profile: HarnessExecutionProfile,
    pub attempt_timeout: Duration,
    pub wait_for_recovery: bool,
    pub once: bool,
    pub workspace: Option<WorkspaceMapping>,
    pub remote_provider: Option<ProviderConfig>,
    pub shared_execution: Option<SharedExecutionConfig>,
    pub context_catalog: context::ContextCatalog,
    pub mcp_catalog: McpCatalog,
}

#[derive(Clone)]
pub(crate) struct HostHeaders(MetadataValue<Ascii>);

impl Interceptor for HostHeaders {
    fn call(&mut self, mut request: Request<()>) -> Result<Request<()>, Status> {
        request
            .metadata_mut()
            .insert(HOST_GENERATION_HEADER, self.0.clone());
        Ok(request)
    }
}

pub(crate) type RegisteredHost = WorkerHostClient<InterceptedService<Channel, HostHeaders>>;
pub(crate) type RegisteredInputs = AttemptInputsClient<InterceptedService<Channel, HostHeaders>>;
#[derive(Clone)]
pub(crate) struct CoordinationClients {
    transfers: checkpoints::Transfers,
    acquisitions: AttemptArtifactsClient<InterceptedService<Channel, HostHeaders>>,
    artifacts: ArtifactTransfersClient<InterceptedService<Channel, HostHeaders>>,
    workstreams: AttemptWorkstreamsClient<InterceptedService<Channel, HostHeaders>>,
    mailbox: AttemptMailboxClient<InterceptedService<Channel, HostHeaders>>,
    work_sessions: AttemptWorkSessionsClient<InterceptedService<Channel, HostHeaders>>,
    mcp_effects: AttemptMcpEffectsClient<InterceptedService<Channel, HostHeaders>>,
}

impl Attempt {
    fn from_assignment(assignment: Assignment) -> Result<Self> {
        let task = assignment.task.context("assignment has no Task")?;
        ensure!(
            task.attempt_id.as_deref() == Some(assignment.attempt_id.as_str()),
            "assignment has mismatched Attempt identity"
        );
        let requires_unsandboxed_commands =
            task.attempt_execution.as_ref().is_some_and(|attempt| {
                matches!(
                    attempt.harness_kind(),
                    HarnessKind::Opencode | HarnessKind::Cursor
                ) && attempt.shared_execution.is_none()
                    && task
                        .allowed_actions
                        .iter()
                        .any(|action| action == "commands:execute")
            });
        Ok(Self {
            task_id: task.task_id,
            attempt_id: assignment.attempt_id,
            lease_token: assignment.lease_token,
            execution_selection: task
                .attempt_execution
                .map(|selection| selection.encode_to_vec()),
            requires_unsandboxed_commands,
        })
    }

    fn can_launch(&self, options: &HostOptions) -> Result<bool> {
        let Some(selection) = &self.execution_selection else {
            return Ok(false);
        };
        let execution = AttemptExecutionSelection::decode(selection.as_slice())
            .context("stored Attempt execution selection is invalid")?;
        let model = execution
            .selection
            .as_ref()
            .and_then(|selection| selection.model.as_ref());
        Ok(execution.harness_kind == options.harness as i32
            && execution.remote_file_workspace == options.execution_profile.remote_file_workspace
            && execution.shared_execution == options.execution_profile.shared_execution
            && execution
                .mcp_servers
                .iter()
                .all(|server| options.execution_profile.mcp_servers.contains(server))
            && model.is_none_or(|model| options.execution_profile.model_ids.contains(model))
            && (!self.requires_unsandboxed_commands
                || options.execution_profile.allow_unsandboxed_commands))
    }

    fn inspect(&self) -> InspectAttemptRequest {
        InspectAttemptRequest {
            task_id: self.task_id.clone(),
            attempt_id: self.attempt_id.clone(),
            lease_token: self.lease_token.clone(),
        }
    }
}

fn claim_request(
    options: &HostOptions,
    workspaces: &workspaces::Workspaces,
    operation_id: String,
) -> ClaimTaskRequest {
    ClaimTaskRequest {
        operation_id,
        workspace_ids: workspaces.ids(),
        gateway_workspace_ids: workspaces.gateway_ids(),
        harness_kind: options.harness as i32,
        context_contracts: options.context_catalog.supported_contracts(),
        execution_profile: Some(options.execution_profile.clone()),
    }
}

pub async fn run(
    options: HostOptions,
    shutdown: CancellationToken,
    ready: impl FnOnce(),
) -> Result<()> {
    ensure!(
        !options.attempt_timeout.is_zero(),
        "attempt timeout must be positive"
    );
    ensure!(
        options.execution_profile.mcp_servers == options.mcp_catalog.capabilities()
            && (options.execution_profile.mcp_servers.is_empty()
                || (options.harness == HarnessKind::ClaudeCode
                    && options.remote_provider.is_none())),
        "MCP tools require a local Claude Code Worker Host with the matching catalog"
    );
    provider_environment_for(options.harness, options.provider_model.as_deref())?;
    ensure!(
        options.execution_profile.remote_file_workspace == options.remote_provider.is_some()
            && (options.remote_provider.is_none()
                || (options.harness == HarnessKind::Cursor
                    && options.workspace.is_some()
                    && !options.execution_profile.allow_unsandboxed_commands)),
        "invalid Worker Host remote Workspace profile"
    );
    ensure!(
        options.execution_profile.shared_execution.as_ref()
            == options
                .shared_execution
                .as_ref()
                .map(SharedExecutionConfig::capability)
            && (options.shared_execution.is_none()
                || (options.harness == HarnessKind::Cursor
                    && options.workspace.is_none()
                    && options.remote_provider.is_none()
                    && options.execution_profile.mcp_servers.is_empty()
                    && !options.execution_profile.allow_unsandboxed_commands)),
        "shared execution requires a Cursor Worker Host with the exact provider profile"
    );
    ensure!(
        !matches!(
            options.harness,
            HarnessKind::Opencode | HarnessKind::OpenaiAgents | HarnessKind::Cursor
        ) || options.context_catalog.supported_contracts().is_empty(),
        "the selected harness does not load Skills"
    );
    let shutdown = shutdown.child_token();
    let journal = Arc::new(Journal::open(&options.state_directory)?);
    let workspaces =
        workspaces::Workspaces::new(&options.state_directory, options.workspace.clone())?;
    // Terminal proof is durable; finishing local cleanup needs neither the source
    // repository nor a new network registration.
    if let Some(Entry::Terminal { attempt, prepared }) = journal.load()? {
        cleanup_terminal(
            &journal,
            &workspaces,
            &options.state_directory,
            &attempt,
            prepared.as_deref(),
        )?;
        if options.once {
            ready();
            return Ok(());
        }
    }
    let token = match &options.token {
        Some(token) if !token.is_empty() => token.clone(),
        Some(_) => bail!("Worker Host credential is empty"),
        None => enrollment::host_token(&journal, &options.gateway)?,
    };
    let incarnation_id = journal.incarnation()?;
    let channel = options.gateway.clone().connect_lazy();
    let mut registration = WorkerHostClient::new(channel.clone())
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES);
    let registration = loop {
        if shutdown.is_cancelled() {
            return Ok(());
        }
        let response = registration
            .register_host(request(
                RegisterHostRequest {
                    incarnation_id: incarnation_id.clone(),
                },
                &token,
            )?)
            .await;
        match response {
            Ok(response) => {
                let host = response.into_inner();
                ensure!(
                    !host.revoked && host.generation > 0,
                    "Worker Host registration is inactive"
                );
                break host;
            }
            Err(error) if retryable(&error) => wait_for_work(&shutdown).await,
            Err(error) => return Err(error.into()),
        }
    };
    let headers = HostHeaders(registration.generation.to_string().parse()?);
    let inputs = AttemptInputsClient::with_interceptor(
        options.gateway.clone().connect_lazy(),
        headers.clone(),
    )
    .max_decoding_message_size(MAX_MESSAGE_BYTES)
    .max_encoding_message_size(MAX_MESSAGE_BYTES);
    let coordination = CoordinationClients {
        acquisitions: AttemptArtifactsClient::with_interceptor(channel.clone(), headers.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES),
        transfers: checkpoints::Transfers::new(channel.clone(), headers.clone()),
        artifacts: ArtifactTransfersClient::with_interceptor(
            options.gateway.clone().connect_lazy(),
            headers.clone(),
        )
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES),
        workstreams: AttemptWorkstreamsClient::with_interceptor(channel.clone(), headers.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES),
        mailbox: AttemptMailboxClient::with_interceptor(channel.clone(), headers.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES),
        work_sessions: AttemptWorkSessionsClient::with_interceptor(
            channel.clone(),
            headers.clone(),
        )
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES),
        mcp_effects: AttemptMcpEffectsClient::with_interceptor(channel.clone(), headers.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES),
    };
    let transfers = checkpoints::Transfers::new(channel.clone(), headers.clone());
    let mut host = WorkerHostClient::with_interceptor(channel, headers)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES);
    let presence = readiness::Presence::start(
        journal.clone(),
        host.clone(),
        token.clone(),
        options.harness as i32,
        workspaces
            .ids()
            .into_iter()
            .chain(workspaces.gateway_ids())
            .collect(),
        options.execution_profile.clone(),
        shutdown.clone(),
    );
    let outcome = async {
    let mut ready = Some(ready);
    while !shutdown.is_cancelled() {
        let entry = match journal.load()? {
            Some(entry) => entry,
            None => {
                let operation_id = Uuid::new_v4().to_string();
                let claim = claim_request(&options, &workspaces, operation_id.clone());
                let entry = Entry::Claim {
                    operation_id,
                    request: claim.encode_to_vec(),
                };
                journal.save(&entry)?;
                entry
            }
        };
        presence.set(match &entry {
            Entry::Claim { .. } => readiness::State::Ready,
            Entry::Executing { .. } => readiness::State::Recovery,
            _ => readiness::State::Busy,
        });
        match entry {
            Entry::Claim { operation_id, request: saved } => {
                if saved.is_empty() {
                    journal.clear()?;
                    continue;
                }
                let claim = ClaimTaskRequest::decode(saved.as_slice())
                    .context("stored Claim is invalid")?;
                ensure!(claim.operation_id == operation_id, "stored Claim identity differs");
                if claim != claim_request(&options, &workspaces, operation_id) {
                    // Never submit an unsent Claim with a superseded profile. A
                    // previously allocated reservation expires on its existing lease.
                    journal.clear()?;
                    continue;
                }
                let response = host
                    .claim_task(request(claim, &token)?)
                    .await;
                let assignment = match response {
                    Ok(response) => response.into_inner().assignment,
                    Err(error) if retryable(&error) => {
                        wait_for_work(&shutdown).await;
                        continue;
                    }
                    Err(error) => return Err(error.into()),
                };
                if let Some(ready) = ready.take() {
                    ready();
                }
                if let Some(assignment) = assignment {
                    journal.save(&Entry::Starting {
                        attempt: Attempt::from_assignment(assignment)?,
                    })?;
                } else {
                    journal.clear()?;
                    if options.once {
                        return Ok(());
                    }
                    wait_for_work(&shutdown).await;
                }
            }
            Entry::Starting { attempt } => {
                run_assignment(
                    &options,
                    &journal,
                    &workspaces,
                    (&mut host, &inputs, &coordination, &transfers, &token, &registration),
                    attempt,
                    &shutdown,
                    || {
                        if let Some(ready) = ready.take() {
                            ready();
                        }
                    },
                )
                .await?;
            }
            Entry::Executing { attempt, prepared } => {
                ensure_providers_stopped(&options, &journal, &attempt, &registration).await?;
                match resolved(&mut host, &attempt, &token).await {
                    Ok(true) => journal.save(&Entry::Terminal { attempt, prepared })?,
                    Ok(false) if options.wait_for_recovery => {
                        if let Some(ready) = ready.take() {
                            ready();
                            eprintln!(
                                "Task {} Attempt {} needs recovery before this host can claim work",
                                attempt.task_id, attempt.attempt_id
                            );
                        }
                        wait_for_work(&shutdown).await;
                    }
                    Ok(false) => bail!(
                        "Task {} Attempt {} needs recovery before this host can claim work",
                        attempt.task_id,
                        attempt.attempt_id
                    ),
                    Err(error) if retryable(&error) => wait_for_work(&shutdown).await,
                    Err(error) => return Err(error.into()),
                }
            }
            Entry::Finalizing {
                attempt,
                result,
                succeeded,
                objective_signal,
                waiting_approval_ids,
                checkpoint,
                workspace,
                remote_tree,
                outputs,
            } => {
                // This stage is recorded only after the adapter process group was reaped.
                // Exact finalization can safely resume after a Host restart.
                with_cleanup_authority(
                    &mut host, &attempt, &token, &shutdown,
                    ensure_providers_stopped(&options, &journal, &attempt, &registration),
                ).await?;
                if let Some(pending) = outputs.as_ref().filter(|output| succeeded && !output.frozen).cloned() {
                    if remote_tree.is_some() {
                        save_finish(&journal, attempt, adapter::failed("Task output files could not be captured safely"))?;
                        continue;
                    }
                    let cancellation = shutdown.child_token();
                    let frozen = with_authority(&mut host, &attempt, &token, &shutdown, &cancellation, async {
                        pending.freeze(&workspace, &workspaces, &options.state_directory, &attempt, &cancellation)
                            .await.map(Box::new).map_err(|error| {
                                let required = supertag_protocol::output_policy::REQUIRED_OUTPUT_MISSING;
                                let message = if error.downcast_ref::<Status>().is_some_and(|status| status.message() == required) {
                                    required
                                } else {
                                    "Task output files could not be captured safely"
                                };
                                Status::failed_precondition(message)
                            })
                    }).await;
                    match frozen {
                        Ok((pending, _)) => journal.save(&Entry::Finalizing {
                            attempt,
                            result,
                            succeeded,
                            objective_signal,
                            waiting_approval_ids,
                            checkpoint,
                            workspace,
                            remote_tree,
                            outputs: Some(pending),
                        })?,
                        Err(_) if shutdown.is_cancelled() => return Ok(()),
                        Err(error) if retryable(&error) => wait_for_work(&shutdown).await,
                        Err(error) => save_finish(
                            &journal,
                            attempt,
                            adapter::failed(
                                if error.message() == supertag_protocol::output_policy::REQUIRED_OUTPUT_MISSING {
                                    supertag_protocol::output_policy::REQUIRED_OUTPUT_MISSING
                                } else {
                                    "Task output files could not be captured safely"
                                },
                            ),
                        )?,
                    }
                    continue;
                }
                let cancellation = shutdown.child_token();
                let finalization = with_authority(
                    &mut host,
                    &attempt,
                    &token,
                    &shutdown,
                    &cancellation,
                    async {
                        let input_state = options.state_directory.clone();
                        let input_attempt = attempt.attempt_id.clone();
                        let input_checkout = workspace.checkout.path.clone();
                        tokio::task::spawn_blocking(move || artifact_inputs::Inputs::cleanup(&input_state, &input_attempt, &input_checkout))
                            .await.map_err(|_| Status::internal("artifact input cleanup failed"))?
                            .map_err(|_| Status::failed_precondition("artifact input files could not be removed safely"))?;
                        if let Some(tree) = &remote_tree {
                            workspaces.restore_remote(&workspace, tree, &cancellation).await
                                .map_err(|_| Status::invalid_argument("Remote Workspace output could not be restored safely"))?;
                        }
                        if let Some(directory) = outputs.as_ref().and_then(|outputs| outputs.cleanup_directory()) {
                            let checkout = workspace.checkout.path.clone();
                            let directory = directory.to_owned();
                            tokio::task::spawn_blocking(move || {
                                supertag_workspaces::remove_output_directory(&checkout, &directory)
                                    .map_err(|_| Status::failed_precondition("Task output directory could not be removed safely"))
                            }).await.map_err(|_| Status::internal("Task output cleanup failed"))??;
                        }
                        workspaces
                            .finalize(&workspace, &result, succeeded, outputs.as_ref().map(|output| output.directory.as_str()), &cancellation)
                            .await
                            .map_err(|_| {
                                Status::invalid_argument(
                                    "Workspace output could not be captured safely",
                                )
                            })
                    },
                )
                .await;
                match finalization {
                    Ok((pending, _)) => journal.save(&Entry::Finish {
                        attempt,
                        result,
                        succeeded,
                        objective_signal,
                        waiting_approval_ids,
                        checkpoint,
                        workspace: Some(Box::new(pending)),
                        prepared: Some(workspace),
                        outputs,
                    })?,
                    Err(_) if shutdown.is_cancelled() => return Ok(()),
                    Err(error) if retryable(&error) => wait_for_work(&shutdown).await,
                    Err(_) => save_finish(
                        &journal,
                        attempt,
                        adapter::failed("Workspace output could not be captured safely"),
                    )?,
                }
            }
            Entry::Finish {
                attempt,
                result,
                succeeded,
                objective_signal,
                waiting_approval_ids,
                checkpoint,
                workspace,
                prepared,
                outputs,
            } => {
                with_cleanup_authority(
                    &mut host, &attempt, &token, &shutdown,
                    ensure_providers_stopped(&options, &journal, &attempt, &registration),
                ).await?;
                let prepared = prepared.or_else(|| {
                    workspace.as_ref().map(|pending| {
                        Box::new(workspaces::PreparedWorkspace {
                            workspace_id: pending.workspace_id.clone(),
                            checkout: pending.checkout.clone(),
                        })
                    })
                });
                if let Some(mut pending) = workspace
                    .as_ref()
                    .filter(|pending| succeeded && !pending.uploaded)
                    .cloned()
                {
                    let receipt = match workspaces.verify(&pending) {
                        Ok(receipt) => receipt,
                        Err(_) => {
                            save_finish(
                                &journal,
                                attempt,
                                adapter::failed("Workspace output no longer matches its receipt"),
                            )?;
                            continue;
                        }
                    };
                    let cancellation = shutdown.child_token();
                    let upload = with_authority(
                        &mut host, &attempt, &token, &shutdown, &cancellation,
                        async {
                            tokio::select! {
                                result = transfers.upload_workspace(&attempt, &token, &pending, receipt) => result,
                                _ = cancellation.cancelled() => Err(Status::cancelled("workspace transfer cancelled")),
                            }
                        },
                    ).await;
                    match upload {
                        Ok(_) => {
                            pending.uploaded = true;
                            journal.save(&Entry::Finish {
                                attempt,
                                result,
                                succeeded,
                                objective_signal,
                                waiting_approval_ids,
                                checkpoint,
                                workspace: Some(pending),
                                prepared,
                                outputs,
                            })?;
                        }
                        Err(error)
                            if retryable(&error) || error.code() == Code::ResourceExhausted =>
                        {
                            wait_for_work(&shutdown).await
                        }
                        Err(_) if shutdown.is_cancelled() => return Ok(()),
                        Err(_) => save_finish(
                            &journal,
                            attempt,
                            adapter::failed("Workspace output could not be committed"),
                        )?,
                    }
                    continue;
                }
                if let Some(mut pending) = checkpoint
                    .as_ref()
                    .filter(|pending| !pending.uploaded)
                    .cloned()
                {
                    let upload =
                        async {
                            // Obtain a fresh budget after the adapter and its descendants stop.
                            host.renew_attempt(request(attempt.inspect(), &token).map_err(
                                |_| Status::internal("invalid upload authority request"),
                            )?)
                            .await?;
                            let payload = journal.read_checkpoint(&pending).map_err(|_| {
                                Status::data_loss("staged checkpoint could not be read")
                            })?;
                            transfers.upload(&attempt, &token, payload).await
                        }
                        .await;
                    match upload {
                        Ok(_) => {
                            pending.uploaded = true;
                            journal.save(&Entry::Finish {
                                attempt,
                                result,
                                succeeded,
                                objective_signal,
                                waiting_approval_ids,
                                checkpoint: Some(pending),
                                workspace,
                                prepared,
                                outputs,
                            })?;
                        }
                        Err(error)
                            if retryable(&error) || error.code() == Code::ResourceExhausted =>
                        {
                            wait_for_work(&shutdown).await;
                        }
                        Err(error)
                            if lost_ownership(&error)
                                || error.code() == Code::Unauthenticated
                                || error.code() == Code::InvalidArgument
                                || error.code() == Code::DataLoss =>
                        {
                            save_finish(
                                &journal,
                                attempt,
                                adapter::failed("Session checkpoint could not be committed"),
                            )?;
                        }
                        Err(error) => return Err(error.into()),
                    }
                    continue;
                }
                if let Some(mut pending) = outputs.as_ref().filter(|output| succeeded && output.pending()).cloned() {
                    let cancellation = shutdown.child_token();
                    let upload = with_authority(&mut host, &attempt, &token, &shutdown, &cancellation, async {
                        tokio::select! {
                            result = pending.publish(&options.state_directory, &attempt, &coordination, &token) => result,
                            _ = cancellation.cancelled() => Err(Status::cancelled("Task output transfer cancelled")),
                        }
                    }).await;
                    match upload {
                        Ok(_) => journal.save(&Entry::Finish {
                            attempt,
                            result,
                            succeeded,
                            objective_signal,
                            waiting_approval_ids,
                            checkpoint,
                            workspace,
                            prepared,
                            outputs: Some(pending),
                        })?,
                        Err(error) if retryable(&error) || error.code() == Code::ResourceExhausted => wait_for_work(&shutdown).await,
                        Err(_) if shutdown.is_cancelled() => return Ok(()),
                        Err(_) => save_finish(
                            &journal,
                            attempt,
                            adapter::failed("Task output could not be committed"),
                        )?,
                    }
                    continue;
                }
                let outcome = host
                    .finish_task(request(
                        FinishTaskRequest {
                            task_id: attempt.task_id.clone(),
                            attempt_id: attempt.attempt_id.clone(),
                            lease_token: attempt.lease_token.clone(),
                            result,
                            succeeded,
                            objective_signal,
                            waiting_approval_ids: waiting_approval_ids.clone(),
                            artifacts: outputs.as_ref().filter(|_| succeeded)
                                .and_then(|outputs| outputs.selection()).into_iter().collect(),
                            checkpoint_sha256: checkpoint.map(|pending| pending.sha256),
                            workspace_delivery: workspace
                                .as_ref()
                                .filter(|_| succeeded)
                                .map(|pending| workspaces.verify(pending))
                                .transpose()?,
                        },
                        &token,
                    )?)
                    .await;
                match outcome {
                    Ok(response) if response.get_ref().state() == TaskState::Uncertain => {
                        // Cleanup was observed, but the operator still owns the
                        // recovery decision. Preserve the checkout until its receipt.
                        if prepared.is_some() {
                            journal.save(&Entry::Executing { attempt, prepared })?;
                            if options.once {
                                return Ok(());
                            }
                        } else {
                            journal.save(&Entry::Terminal {
                                attempt,
                                prepared: None,
                            })?;
                        }
                        continue;
                    }
                    Ok(response) => ensure!(
                        matches!(
                            response.get_ref().state(),
                            TaskState::Succeeded | TaskState::Failed | TaskState::Cancelled
                        ),
                        "Finish returned a nonterminal Task"
                    ),
                    Err(error) if retryable(&error) => {
                        wait_for_work(&shutdown).await;
                        continue;
                    }
                    Err(error)
                        if error.code() == Code::InvalidArgument
                            && (objective_signal != 0 || !waiting_approval_ids.is_empty()) =>
                    {
                        // An invalid owner signal is rejected before the Finish transaction
                        // commits. Settle the cleaned-up Attempt as a controlled failure.
                        journal.save(&Entry::Finish {
                            attempt,
                            result: "Harness proposed an invalid Objective or approval update".into(),
                            succeeded: false,
                            objective_signal: 0,
                            waiting_approval_ids: vec![],
                            checkpoint: None,
                            workspace,
                            prepared,
                            outputs: None,
                        })?;
                        continue;
                    }
                    Err(error) if lost_ownership(&error) || error.code() == Code::AlreadyExists => {
                        match resolved(&mut host, &attempt, &token).await {
                            Ok(true) => {}
                            Ok(false) => return Err(error.into()),
                            Err(error) if retryable(&error) => {
                                wait_for_work(&shutdown).await;
                                continue;
                            }
                            Err(error) => return Err(error.into()),
                        }
                    }
                    Err(error) => return Err(error.into()),
                }
                journal.save(&Entry::Terminal { attempt, prepared })?;
            }
            Entry::Terminal { attempt, prepared } => {
                cleanup_terminal(&journal, &workspaces, &options.state_directory, &attempt, prepared.as_deref())?;
                if let Some(ready) = ready.take() {
                    ready();
                }
                if options.once {
                    return Ok(());
                }
            }
        }
    }
    Ok(())
    }.await;
    let stopped = presence.stop().await;
    outcome.and(stopped)
}

fn cleanup_terminal(
    journal: &Journal,
    workspaces: &workspaces::Workspaces,
    state_directory: &std::path::Path,
    attempt: &Attempt,
    prepared: Option<&workspaces::PreparedWorkspace>,
) -> Result<()> {
    if let Some(prepared) = prepared {
        workspaces.discard(prepared)?;
    }
    context::discard_attempt(state_directory, &attempt.attempt_id)?;
    journal.clear()
}

async fn resolved(
    host: &mut RegisteredHost,
    attempt: &Attempt,
    token: &str,
) -> Result<bool, Status> {
    let mut request = authenticated_request(attempt.inspect(), token, None)?;
    request.set_timeout(Duration::from_secs(5));
    let receipt = host
        .get_attempt_resolution(request)
        .await?
        .into_inner()
        .resolution;
    match receipt {
        Some(receipt)
            if receipt.task_id == attempt.task_id && receipt.attempt_id == attempt.attempt_id =>
        {
            Ok(true)
        }
        Some(_) => Err(Status::data_loss(
            "recovery receipt has mismatched identity",
        )),
        None => Ok(false),
    }
}

async fn run_assignment(
    options: &HostOptions,
    journal: &Journal,
    workspaces: &workspaces::Workspaces,
    connection: (
        &mut RegisteredHost,
        &RegisteredInputs,
        &CoordinationClients,
        &checkpoints::Transfers,
        &str,
        &HostRecord,
    ),
    attempt: Attempt,
    shutdown: &CancellationToken,
    ready: impl FnOnce(),
) -> Result<()> {
    let (host, inputs, coordination, transfers, token, registration) = connection;
    // Starting is durable before requesting authority and never records a launch.
    // A lost start response can therefore be retried using this exact Attempt.
    let can_launch = attempt.can_launch(options)?;
    let start = if can_launch {
        host.start_task(request(
            StartTaskRequest {
                task_id: attempt.task_id.clone(),
                attempt_id: attempt.attempt_id.clone(),
                lease_token: attempt.lease_token.clone(),
            },
            token,
        )?)
        .await
    } else {
        host.inspect_attempt(request(attempt.inspect(), token)?)
            .await
    };
    let task = match start {
        Ok(response) => response.into_inner(),
        Err(error) if retryable(&error) => {
            wait_for_work(shutdown).await;
            return Ok(());
        }
        Err(error) if lost_ownership(&error) => {
            match host
                .inspect_attempt(request(attempt.inspect(), token)?)
                .await
            {
                Ok(response) => response.into_inner(),
                Err(error) if retryable(&error) => {
                    wait_for_work(shutdown).await;
                    return Ok(());
                }
                // No adapter was launched for Starting. The Control Plane can
                // safely retire a reservation that expired before start.
                Err(error) if lost_ownership(&error) => {
                    context::discard_attempt(&options.state_directory, &attempt.attempt_id)?;
                    return journal.clear();
                }
                Err(error) => return Err(error.into()),
            }
        }
        Err(error) => return Err(error.into()),
    };
    ensure_attempt(&task, &attempt)?;
    if !can_launch {
        ready();
        if task.state() == TaskState::Claimed {
            // Starting never launched an adapter. Leave an unstarted reservation
            // for the Control Plane's lease expiry to put back in the queue.
            return journal.clear();
        }
        return save_finish(
            journal,
            attempt,
            adapter::failed("Worker Host execution profile changed before launch"),
        );
    }
    if task.state() == TaskState::Claimed {
        // A pause can block Start after Claim. No adapter has launched, so
        // retain the intent while the Control Plane retires the reservation.
        ready();
        wait_for_work(shutdown).await;
        return Ok(());
    }
    if matches!(task.state(), TaskState::Cancelled | TaskState::Uncertain) {
        ready();
        return save_finish(
            journal,
            attempt,
            adapter::failed("Task Attempt ended before launch"),
        );
    }
    ensure!(
        task.state() == TaskState::Running,
        "Control Plane did not authorize the Task Attempt to start"
    );

    let sent = Instant::now();
    let renewed = host.renew_attempt(request(attempt.inspect(), token)?).await;
    let authority = match renewed {
        Ok(response) => response.into_inner(),
        Err(error) if retryable(&error) => {
            wait_for_work(shutdown).await;
            return Ok(());
        }
        Err(error) if lost_ownership(&error) => {
            context::discard_attempt(&options.state_directory, &attempt.attempt_id)?;
            return journal.clear();
        }
        Err(error) => return Err(error.into()),
    };
    ready();
    let mut task = authority.task.context("execution authority has no Task")?;
    ensure_attempt(&task, &attempt)?;
    let valid_until = sent
        .checked_add(Duration::from_millis(authority.valid_for_ms))
        .context("invalid execution authority duration")?;
    if task.state() != TaskState::Running || valid_until <= Instant::now() {
        return save_finish(
            journal,
            attempt,
            adapter::failed("Execution authority expired before launch"),
        );
    }
    if !supertag_protocol::mcp::supports(&task, options.harness, &options.execution_profile) {
        return save_finish(
            journal,
            attempt,
            adapter::failed("Worker Host cannot enforce accepted MCP grants"),
        );
    }
    if !supertag_protocol::shared_execution::supports(
        &task,
        options.harness,
        options.execution_profile.shared_execution.as_ref(),
    ) {
        return save_finish(
            journal,
            attempt,
            adapter::failed("Worker Host cannot enforce accepted shared execution placement"),
        );
    }
    if !supertag_protocol::output_policy::supports(
        &task,
        options.harness,
        &options.execution_profile,
    ) {
        return save_finish(
            journal,
            attempt,
            adapter::failed("Worker Host cannot enforce accepted Task output requirements"),
        );
    }
    let checkpoint = match time::timeout_at(valid_until, transfers.download(&attempt, token)).await
    {
        Ok(Ok(checkpoint)) => checkpoint,
        Ok(Err(error)) if retryable(&error) || error.code() == Code::ResourceExhausted => {
            wait_for_work(shutdown).await;
            return Ok(());
        }
        Ok(Err(error)) if lost_ownership(&error) || error.code() == Code::DataLoss => {
            return save_finish(
                journal,
                attempt,
                adapter::failed("Session checkpoint could not be restored"),
            );
        }
        Ok(Err(error)) => return Err(error.into()),
        Err(_) => {
            return save_finish(
                journal,
                attempt,
                adapter::failed("Execution authority expired during checkpoint transfer"),
            );
        }
    };
    let resolved_skills = if task.policy_snapshot.as_ref().is_some_and(|snapshot| {
        snapshot
            .context_sets
            .iter()
            .any(|set| !set.items.is_empty())
    }) {
        let cancel = shutdown.child_token();
        let context_host = host.clone();
        match with_authority(
            host,
            &attempt,
            token,
            shutdown,
            &cancel,
            prepare_context(options, &task, &attempt, context_host, token, &cancel),
        )
        .await
        {
            Ok((skills, _)) => skills,
            Err(error) if retryable(&error) && !shutdown.is_cancelled() => {
                wait_for_work(shutdown).await;
                return Ok(());
            }
            Err(_) => {
                return save_finish(
                    journal,
                    attempt,
                    adapter::failed("Task Context Items could not be resolved safely"),
                );
            }
        }
    } else {
        vec![]
    };
    let operation_cancel = shutdown.child_token();
    let prepared = with_authority(host, &attempt, token, shutdown, &operation_cancel, async {
        workspaces
            .prepare(&task, &attempt, transfers, token, &operation_cancel)
            .await
            .map_err(|error| {
                error.downcast::<Status>().unwrap_or_else(|_| {
                    Status::invalid_argument("Task workspace could not be prepared safely")
                })
            })
    })
    .await;
    let (workspace, mut valid_until) = match prepared {
        Ok(prepared) => prepared,
        Err(error) if retryable(&error) && !shutdown.is_cancelled() => {
            wait_for_work(shutdown).await;
            return Ok(());
        }
        Err(_) => {
            return save_finish(
                journal,
                attempt,
                adapter::failed("Task workspace could not be prepared safely"),
            );
        }
    };
    journal.save(&Entry::Executing {
        attempt: attempt.clone(),
        prepared: workspace
            .as_ref()
            .map(|prepared| Box::new(prepared.clone())),
    })?;
    let mcp = if supertag_protocol::mcp::grants(&task).next().is_some() {
        let cancel = shutdown.child_token();
        match with_authority(
            host,
            &attempt,
            token,
            shutdown,
            &cancel,
            mcp::AttemptMcp::prepare(&options.mcp_catalog, &task, &cancel),
        )
        .await
        {
            Ok((mcp, expires)) => {
                valid_until = expires;
                mcp.map(Arc::new)
            }
            Err(_) => {
                return save_finish(
                    journal,
                    attempt,
                    adapter::failed("Task MCP tools could not be resolved safely"),
                );
            }
        }
    } else {
        None
    };
    let pending_outputs = if let Some(workspace) = workspace
        .as_ref()
        .filter(|_| options.remote_provider.is_some())
    {
        task_outputs::PendingOutputs::prepare_remote(&task, workspace, &attempt)
    } else {
        task_outputs::PendingOutputs::prepare(
            &task,
            workspace
                .as_ref()
                .map(|workspace| workspace.checkout.path.as_path()),
            &attempt,
            options.harness,
        )
    };
    let mut outputs = match pending_outputs {
        Ok(outputs) => outputs.map(Box::new),
        Err(_) => {
            return save_finish(
                journal,
                attempt,
                adapter::failed("Task output directory could not be prepared safely"),
            );
        }
    };
    let mut provider = if options.remote_provider.is_some() {
        let workspace = workspace
            .as_ref()
            .context("remote Attempt has no prepared Workspace")?;
        let cancel = shutdown.child_token();
        let prepared = with_authority(host, &attempt, token, shutdown, &cancel, async {
            remote::prepare(
                options,
                journal,
                workspaces,
                (&attempt, workspace, &task),
                registration,
                &cancel,
            )
            .await
            .map_err(|_| Status::failed_precondition("Remote Workspace could not be prepared"))
        })
        .await;
        match prepared {
            Ok((provider, expires)) => {
                valid_until = expires;
                Some(provider)
            }
            Err(_) => {
                with_cleanup_authority(
                    host,
                    &attempt,
                    token,
                    shutdown,
                    remote::ensure_stopped(options, journal, &attempt, registration),
                )
                .await?;
                return save_finish(
                    journal,
                    attempt,
                    adapter::failed("Remote Workspace could not be prepared"),
                );
            }
        }
    } else {
        None
    };
    let shared_access = if let Some(config) = options.shared_execution.as_ref() {
        let cancel = shutdown.child_token();
        match with_authority(host, &attempt, token, shutdown, &cancel, async {
            shared_execution::prepare(
                config,
                journal,
                &attempt,
                &task,
                registration,
                options.attempt_timeout,
            )
            .await
            .map_err(|_| {
                Status::failed_precondition("shared execution access could not be prepared")
            })
        })
        .await
        {
            Ok((access, expires)) => {
                valid_until = expires;
                Some(access)
            }
            Err(_) => {
                save_finish(
                    journal,
                    attempt.clone(),
                    adapter::failed("Shared execution access could not be prepared safely"),
                )?;
                with_cleanup_authority(
                    host,
                    &attempt,
                    token,
                    shutdown,
                    shared_execution::ensure_released(options, journal, &attempt, registration),
                )
                .await?;
                return Ok(());
            }
        }
    } else {
        None
    };
    let uses_shared_access = shared_access.is_some();
    let remote_workspace = provider
        .as_ref()
        .map(|provider| {
            let (channel, token) = provider.workspace_connection();
            adapter::RemoteWorkspace::new(channel, token)
        })
        .or_else(|| shared_access.map(adapter::RemoteWorkspace::shared));
    let adapter_workspace = workspace
        .as_ref()
        .filter(|_| remote_workspace.is_none())
        .map(|prepared| prepared.checkout.path.as_path());
    let output_directory = outputs
        .as_ref()
        .zip(adapter_workspace)
        .map(|(outputs, checkout)| outputs.absolute(checkout));
    if let Some(output) = outputs.as_ref().filter(|_| provider.is_some()) {
        task.instructions.push_str(&format!(
            "\n\nTask output directory: {}\nUse paths relative to the remote Workspace in the admitted file tools. SuperTag preserves selected Task outputs from this Attempt.",
            output.directory,
        ));
        if let Some(policy) = &task.output_policy {
            task.instructions.push_str(&format!(
                "\nRequired output paths and patterns, relative to the Workspace: {}.",
                serde_json::to_string(&policy.required)?,
            ));
        }
    } else if let Some(directory) = &output_directory
        && task
            .allowed_actions
            .iter()
            .any(|action| action == "files:write")
    {
        task.instructions.push_str(&format!(
            "\n\nSave deliverables in the Task output directory at {}. Use this directory for files you want to return with the Task result.",
            directory.display(),
        ));
    }
    let assignment = Assignment {
        task: Some(task),
        attempt_id: attempt.attempt_id.clone(),
        lease_token: attempt.lease_token.clone(),
    };
    let outcome = adapter::execute(
        options,
        assignment,
        adapter::ExecutionInputs {
            checkpoint,
            workspace: adapter_workspace,
            output_directory: output_directory.as_deref(),
            resolved_skills,
            remote_workspace,
            mcp: mcp.clone(),
        },
        (host.clone(), inputs.clone(), coordination.clone()),
        token,
        valid_until,
        shutdown,
    )
    .await
    .with_context(|| {
        format!(
            "Task {} Attempt {} needs recovery",
            attempt.task_id, attempt.attempt_id
        )
    });
    if let Some(mcp) = mcp {
        mcp.close().await;
    }
    let saved = async {
        let mut outcome = outcome?;
        let remote_tree = if let Some(provider) = provider.as_ref().filter(|_| outcome.succeeded) {
            let cancel = shutdown.child_token();
            let workspace = workspace.as_ref().expect("remote Workspace prepared");
            let captured = with_authority(
                host,
                &attempt,
                token,
                shutdown,
                &cancel,
                remote::capture(
                    provider,
                    journal,
                    (&attempt, workspace, workspaces),
                    outputs.take(),
                    &options.state_directory,
                    &cancel,
                ),
            )
            .await;
            match captured {
                Ok(((tree, frozen), _)) => {
                    outputs = frozen;
                    Some(tree)
                }
                Err(error) => {
                    let message = match error.message() {
                        supertag_protocol::output_policy::REQUIRED_OUTPUT_MISSING => {
                            supertag_protocol::output_policy::REQUIRED_OUTPUT_MISSING
                        }
                        remote::OUTPUTS_FAILED => remote::OUTPUTS_FAILED,
                        _ => remote::CAPTURE_FAILED,
                    };
                    outcome = adapter::failed(message);
                    None
                }
            }
        } else {
            None
        };
        if let Some(workspace) = workspace {
            let checkpoint = outcome
                .checkpoint
                .map(|checkpoint| journal.stage_checkpoint(checkpoint))
                .transpose()?;
            journal.save(&Entry::Finalizing {
                attempt: attempt.clone(),
                result: outcome.result,
                succeeded: outcome.succeeded,
                objective_signal: outcome.objective_signal,
                waiting_approval_ids: outcome.waiting_approval_ids,
                checkpoint,
                workspace: Box::new(workspace),
                remote_tree,
                outputs,
            })
        } else {
            save_finish(journal, attempt.clone(), outcome)
        }
    }
    .await;
    if uses_shared_access {
        with_cleanup_authority(
            host,
            &attempt,
            token,
            shutdown,
            shared_execution::ensure_released(options, journal, &attempt, registration),
        )
        .await?;
    }
    if let Some(provider) = provider.as_mut() {
        with_cleanup_authority(host, &attempt, token, shutdown, async {
            let closed = provider.shutdown().await;
            remote::ensure_stopped(options, journal, &attempt, registration).await?;
            closed
        })
        .await?;
    }
    saved
}

async fn prepare_context(
    options: &HostOptions,
    task: &Task,
    attempt: &Attempt,
    mut host: RegisteredHost,
    token: &str,
    cancel: &CancellationToken,
) -> Result<Vec<ResolvedSkill>, Status> {
    let credential = |_| Status::internal("invalid Context Item authority request");
    let expected = host
        .get_context_pins(request(attempt.inspect(), token).map_err(credential)?)
        .await?
        .into_inner();
    let prepared = options
        .context_catalog
        .prepare(
            task,
            &options.state_directory,
            &attempt.attempt_id,
            &expected,
            cancel,
        )
        .await
        .map_err(|_| Status::failed_precondition("Context Item could not be prepared"))?;
    let manifest = prepared
        .manifest()
        .map_err(|_| Status::data_loss("invalid prepared Context Items"))?;
    let receipt = host
        .commit_context_resolution(
            request(
                CommitContextResolutionRequest {
                    attempt: Some(attempt.inspect()),
                    manifest: Some(manifest.clone()),
                },
                token,
            )
            .map_err(credential)?,
        )
        .await?
        .into_inner();
    if receipt != manifest {
        return Err(Status::data_loss(
            "Context Item receipt has mismatched contents",
        ));
    }
    prepared
        .delivery()
        .map_err(|_| Status::data_loss("invalid Context Item delivery"))
}

fn ensure_attempt(task: &Task, attempt: &Attempt) -> Result<()> {
    ensure!(
        task.task_id == attempt.task_id
            && task.attempt_id.as_deref() == Some(attempt.attempt_id.as_str()),
        "Control Plane returned a different Task Attempt"
    );
    ensure!(
        task.attempt_execution.as_ref().map(Message::encode_to_vec) == attempt.execution_selection,
        "Control Plane returned a different Attempt execution selection"
    );
    Ok(())
}

fn save_finish(journal: &Journal, attempt: Attempt, outcome: HarnessCompleteRequest) -> Result<()> {
    let prepared = journal
        .load()?
        .map(|entry| entry.prepared(&attempt))
        .transpose()?
        .flatten();
    let checkpoint = outcome
        .checkpoint
        .map(|checkpoint| journal.stage_checkpoint(checkpoint))
        .transpose()?;
    journal.save(&Entry::Finish {
        attempt,
        result: outcome.result,
        succeeded: outcome.succeeded,
        objective_signal: outcome.objective_signal,
        waiting_approval_ids: outcome.waiting_approval_ids,
        checkpoint,
        workspace: None,
        prepared,
        outputs: None,
    })
}

async fn renew_running_attempt(
    host: &mut RegisteredHost,
    attempt: &Attempt,
    token: &str,
) -> Result<Instant, Status> {
    let sent = Instant::now();
    let response = host
        .renew_attempt(
            request(attempt.inspect(), token)
                .map_err(|_| Status::internal("invalid authority request"))?,
        )
        .await?
        .into_inner();
    let task = response
        .task
        .as_ref()
        .ok_or_else(|| Status::data_loss("execution authority has no Task"))?;
    ensure_attempt(task, attempt)
        .map_err(|_| Status::data_loss("execution authority has mismatched identity"))?;
    if task.state() != TaskState::Running {
        return Err(Status::failed_precondition("execution authority ended"));
    }
    let until = sent
        .checked_add(Duration::from_millis(response.valid_for_ms))
        .ok_or_else(|| Status::data_loss("invalid authority duration"))?;
    if until <= Instant::now() {
        return Err(Status::failed_precondition("execution authority expired"));
    }
    Ok(until)
}

async fn ensure_providers_stopped(
    options: &HostOptions,
    journal: &Journal,
    attempt: &Attempt,
    registration: &HostRecord,
) -> Result<()> {
    remote::ensure_stopped(options, journal, attempt, registration).await?;
    shared_execution::ensure_released(options, journal, attempt, registration).await
}

/// Cleanup continues after authority ends. Only renewal stops on cancellation.
async fn with_cleanup_authority(
    host: &mut RegisteredHost,
    attempt: &Attempt,
    token: &str,
    shutdown: &CancellationToken,
    cleanup: impl std::future::Future<Output = Result<()>>,
) -> Result<()> {
    let keep_lease = async {
        let mut pulse = time::interval(Duration::from_secs(2));
        pulse.set_missed_tick_behavior(time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                biased;
                _ = shutdown.cancelled() => break,
                _ = pulse.tick() => {},
            }
            match renew_running_attempt(host, attempt, token).await {
                Ok(_) => {}
                Err(error) if retryable(&error) => {}
                Err(_) => break,
            }
        }
    };
    tokio::pin!(cleanup);
    tokio::select! {
        biased;
        result = &mut cleanup => result,
        () = keep_lease => cleanup.await,
    }
}

/// Keep the execution lease alive during repository preparation and transfer.
/// The operation must observe `cancel` so native Git is reaped before returning.
async fn with_authority<T>(
    host: &mut RegisteredHost,
    attempt: &Attempt,
    token: &str,
    shutdown: &CancellationToken,
    cancel: &CancellationToken,
    operation: impl std::future::Future<Output = Result<T, Status>>,
) -> Result<(T, Instant), Status> {
    let mut valid_until = renew_running_attempt(host, attempt, token).await?;
    tokio::pin!(operation);
    let mut interval = time::interval(Duration::from_secs(2));
    interval.tick().await;
    let error = loop {
        tokio::select! {
            biased;
            _ = shutdown.cancelled() => break Status::cancelled("Worker Host is shutting down"),
            _ = time::sleep_until(valid_until) => break Status::failed_precondition("execution authority expired"),
            result = &mut operation => return result.map(|result| (result, valid_until)),
            _ = interval.tick() => {
                match time::timeout_at(valid_until, renew_running_attempt(host, attempt, token)).await {
                    Ok(Ok(until)) => valid_until = until,
                    Ok(Err(error)) if retryable(&error) => {},
                    Ok(Err(error)) => break error,
                    Err(_) => break Status::failed_precondition("execution authority expired"),
                }
            }
        }
    };
    cancel.cancel();
    let _ = operation.await;
    Err(error)
}

fn request<T>(message: T, token: &str) -> Result<Request<T>> {
    let mut request = authenticated_request(message, token, None)?;
    request.set_timeout(Duration::from_secs(5));
    Ok(request)
}

fn lost_ownership(error: &Status) -> bool {
    matches!(
        error.code(),
        Code::PermissionDenied | Code::FailedPrecondition | Code::NotFound
    )
}

fn retryable(error: &Status) -> bool {
    matches!(
        error.code(),
        Code::Unavailable | Code::DeadlineExceeded | Code::Cancelled
    )
}

async fn wait_for_work(shutdown: &CancellationToken) {
    tokio::select! {
        _ = time::sleep(Duration::from_millis(250)) => {}
        _ = shutdown.cancelled() => {}
    }
}
