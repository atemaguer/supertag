//! The Worklet's loop: register the host, then claim an Attempt, run it in a Worker, and carry
//! its journaled outcome through finalization, delivery, Finish, and cleanup, resuming from the
//! journal after a restart.

use std::{path::PathBuf, sync::Arc, time::Duration};

use anyhow::{Context, Result, bail, ensure};
use prost::Message;
use supertag_protocol::{
    MAX_MESSAGE_BYTES,
    v2::{
        ClaimTaskRequest, FinishTaskRequest, HarnessKind, RecordWorkspaceMountWritesRequest,
        TaskState, WorkspaceMountWriteStatus, attempt_artifacts_client::AttemptArtifactsClient,
        attempt_inputs_client::AttemptInputsClient, worker_host_client::WorkerHostClient,
    },
};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use tonic::{Code, Status};
use uuid::Uuid;

use crate::worker::{Settings, run::Worker};
use crate::worklet::authority::Authority;
use crate::worklet::authority::{with_authority, with_cleanup_authority};
use crate::worklet::claim::{CLAIM_WAIT, claim_request};
use crate::worklet::finish::{ensure_providers_stopped, save_finish, write_session_branch};
use crate::worklet::recovery::{
    cleanup_terminal, purge_discarded, reclaim, recovery_notice, resolved,
};
use crate::worklet::{background, registration};
use crate::{
    ArtifactSourceConfig, HostHeaders, McpCatalog, SharedExecutionConfig, WorkerOptions,
    WorkletOptions, artifact_inputs, environment, failures, lost_ownership,
    provider_environment_for, request, retryable, wait_for_work,
    worker::{adapter, remote},
    worklet::{
        checkpoints, cleanup_failure, enrollment,
        journal::{Attempt, Entry, Journal},
        landing, readiness, workspaces,
    },
    workspace_mounts,
};

pub(crate) async fn run(
    mut options: WorkletOptions,
    worker: WorkerOptions,
    shutdown: CancellationToken,
    ready: impl FnOnce(),
) -> Result<()> {
    if let Some(token) = &options.token {
        failures::remember_credential(token);
    }
    remote::validate_time_limit(worker.attempt_timeout, worker.remote_provider.is_some())?;
    ensure!(
        worker.execution_profile.mcp_servers == options.mcp_catalog.capabilities()
            && (worker.execution_profile.mcp_servers.is_empty()
                || (worker.harness == HarnessKind::ClaudeCode && worker.remote_provider.is_none())),
        "MCP tools require a local Claude Code Worker Host with the matching catalog"
    );
    provider_environment_for(worker.harness, worker.provider_model.as_deref())?;
    let labels = readiness::host_labels(&options.labels)?;
    ensure!(
        worker.execution_profile.remote_file_workspace == worker.remote_provider.is_some()
            && (worker.remote_provider.is_none()
                || (matches!(
                    worker.harness,
                    HarnessKind::Cursor
                        | HarnessKind::ClaudeCode
                        | HarnessKind::Opencode
                        | HarnessKind::Codex
                ) && !options.workspaces.is_empty()
                    && !worker.execution_profile.allow_unsandboxed_commands)),
        "invalid Worker Host remote Workspace profile"
    );
    ensure!(
        worker.execution_profile.shared_execution.as_ref()
            == worker
                .shared_execution
                .as_ref()
                .map(SharedExecutionConfig::capability)
            && (worker.shared_execution.is_none()
                || (worker.harness == HarnessKind::Cursor
                    && options.workspaces.is_empty()
                    && worker.remote_provider.is_none()
                    && worker.execution_profile.mcp_servers.is_empty()
                    && !worker.execution_profile.allow_unsandboxed_commands)),
        "shared execution requires a Cursor Worker Host with the exact provider profile"
    );
    ensure!(
        !matches!(
            worker.harness,
            HarnessKind::Opencode | HarnessKind::OpenaiAgents | HarnessKind::Cursor
        ) || worker.context_catalog.supported_contracts().is_empty(),
        "the selected harness does not load Skills"
    );
    let shutdown = shutdown.child_token();
    let journal = Arc::new(Journal::open(&options.state_directory)?);
    let local_roots: Vec<PathBuf> = options
        .workspaces
        .iter()
        .filter_map(workspaces::WorkspaceMapping::local_root)
        .map(std::path::Path::to_path_buf)
        .collect();
    let local_roots: Vec<&std::path::Path> = local_roots.iter().map(PathBuf::as_path).collect();
    if !options.workspace_mounts.is_empty() {
        ensure!(
            supertag_protocol::workspace_mounts::mount_harness(worker.harness)
                && !options.workspaces.is_empty()
                && local_roots.len() == options.workspaces.len()
                && worker.shared_execution.is_none(),
            "Workspace copy mounts require a Codex, Claude Code, Cursor, or OpenCode Worker Host with local Workspace mappings"
        );
        let state_directory = options.state_directory.clone();
        let artifact_storage = options
            .artifact_source
            .as_ref()
            .map(|source| source.directory.clone())
            .unwrap_or_else(|| state_directory.join("artifacts"));
        options.workspace_mounts.protect(
            &state_directory,
            &local_roots,
            Some(artifact_storage.as_path()),
        )?;
    }
    let workspaces =
        workspaces::Workspaces::new(&options.state_directory, options.workspaces.clone())?;
    // Checkouts a crash left moved aside but not yet deleted.
    if !options.once {
        workspaces.purge_all_discarded_in_background();
    }
    // Terminal proof is durable; finishing local cleanup needs neither the source
    // repository nor a new network registration.
    if let Some(Entry::Terminal { attempt, prepared }) = journal.load()? {
        let discarded = cleanup_terminal(
            &journal,
            &workspaces,
            &options.state_directory,
            &attempt,
            prepared.as_deref(),
        )?;
        purge_discarded(discarded, options.once);
        if options.once {
            ready();
            return Ok(());
        }
    }
    let token = match &options.token {
        Some(token) if !token.is_empty() => token.clone(),
        Some(_) => bail!("Worker Host credential is empty"),
        None if options.lane.is_some() => bail!("a supervised lane needs its Host credential"),
        None => enrollment::host_token(&journal, &options.control_plane)?,
    };
    let incarnation_id = match &options.lane {
        Some(lane) => {
            Uuid::parse_str(&lane.incarnation_id).context("invalid shared Host incarnation")?;
            lane.incarnation_id.clone()
        }
        None => journal.incarnation()?,
    };
    let channel = options.control_plane.clone().connect_lazy();
    let Some((registration, protocol)) = registration::register(
        &channel,
        &options.control_plane,
        &incarnation_id,
        &token,
        &shutdown,
    )
    .await?
    else {
        return Ok(());
    };
    let headers = HostHeaders::new(registration.generation, protocol);
    let inputs = AttemptInputsClient::with_interceptor(
        options.control_plane.clone().connect_lazy(),
        headers.clone(),
    )
    .max_decoding_message_size(MAX_MESSAGE_BYTES)
    .max_encoding_message_size(MAX_MESSAGE_BYTES);
    let acquisitions = AttemptArtifactsClient::with_interceptor(channel.clone(), headers.clone())
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES);
    // This host holds every artifact and Workspace delivery it produces; the Control Plane relays
    // none of them.
    let serving = options
        .artifact_source
        .take()
        .unwrap_or_else(|| ArtifactSourceConfig::in_state(&options.state_directory))
        .bind(&options.state_directory, &local_roots)
        .await?
        .serve(acquisitions.clone(), &token, &shutdown)
        .await?;
    let (coordination, storage) = registration::coordination(
        &channel,
        &headers,
        acquisitions,
        &serving.storage,
        &options.artifact_peers,
        &options.volumes,
        &options.state_directory,
    );
    // Workspace deliveries and Session checkpoints stay in this host's artifact storage, which
    // every lane of the host shares; only their digests go upstream.
    let transfers = checkpoints::Transfers::new(channel.clone(), headers.clone())
        .with_storage(serving.storage.clone())
        .with_checkpoints(checkpoints::Held::new(
            serving.storage.root(),
            &registration.host_id,
        ))
        .with_volumes(std::sync::Arc::new(options.volumes.clone()));
    // This host lands the Workspace deliveries it holds: right after each one, and queued ones
    // (retries, merges after their Work Session closed) in the background. A `--once` host lands
    // only what it may claim before it exits.
    let landings = landing::Landings::new(
        &options.state_directory,
        channel.clone(),
        headers.clone(),
        &token,
        serving.storage.clone(),
    )?;
    if !options.once {
        landings.spawn(shutdown.clone());
    }
    background::reconcile_checkpoints(&transfers, &token, &shutdown);
    if !options.volumes.is_empty() {
        background::collect_volume_garbage(
            &options.volumes,
            &storage.volume_objects,
            &token,
            &shutdown,
        );
    }
    let mut host = WorkerHostClient::with_interceptor(channel, headers)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES);
    // Preflight: warn before claiming work when the host is short of disk space.
    if let Some(warning) = environment::low_disk_warning(options.disk_space.sample().as_ref()) {
        supertag_protocol::terminal_text::warn(&warning);
    }
    if worker.execution_profile.allow_unsandboxed_commands {
        let name = match worker.harness {
            HarnessKind::ClaudeCode => "Claude Code",
            HarnessKind::Opencode => "OpenCode",
            HarnessKind::Cursor => "Cursor",
            _ => "This harness",
        };
        supertag_protocol::terminal_text::warn(&adapter::unsandboxed_caveat(name));
    }
    // A sign-in the provider proxy can't hold stays readable to commands run unsandboxed.
    if let Some(warning) = adapter::unproxied_key_warning(&worker) {
        supertag_protocol::terminal_text::warn(&warning);
    }
    let keep_awake = environment::KeepAwake::start(options.keep_awake.clone(), shutdown.clone());
    let presence = match &options.lane {
        // A supervised lane's supervisor reports the Host's presence, disk space, and labels.
        Some(lane) => readiness::Reporter::lane(lane.observer.clone()),
        None => readiness::Reporter::Host(Box::new(readiness::Presence::start(
            journal.clone(),
            options.disk_space.clone(),
            host.clone(),
            token.clone(),
            worker.harness as i32,
            workspaces
                .ids()
                .into_iter()
                .chain(workspaces.control_plane_ids())
                .collect(),
            (
                {
                    let profile = worker.execution_profile.clone();
                    let catalog = options.mcp_catalog.clone();
                    Arc::new(move || McpCatalog::advertised(&profile, &catalog.lapsed_logins()))
                },
                labels,
            ),
            shutdown.clone(),
        ))),
    };
    let outcome = async {
    let mut ready = Some(ready);
    let mut announced_recovery: Option<String> = None;
    let retire = options.lane.as_ref().map(|lane| lane.retire.clone());
    while !shutdown.is_cancelled() {
        let entry = match journal.load()? {
            Some(entry) => entry,
            // A retired lane leaves before it records a new Claim.
            None if retire.as_ref().is_some_and(CancellationToken::is_cancelled) => {
                presence.set(readiness::State::Stopping);
                return Ok(());
            }
            None => {
                let operation_id = Uuid::new_v4().to_string();
                let claim = claim_request(&options, &worker, &workspaces, operation_id.clone());
                let entry = Entry::Claim {
                    operation_id,
                    request: claim.encode_to_vec(),
                };
                journal.save(&entry)?;
                entry
            }
        };
        let state = match &entry {
            Entry::Claim { .. } => readiness::State::Ready,
            Entry::Executing { .. } => readiness::State::Recovery,
            _ => readiness::State::Busy,
        };
        presence.set(state);
        keep_awake.update(state == readiness::State::Busy);
        match entry {
            Entry::Claim { operation_id, request: saved } => {
                if saved.is_empty() {
                    journal.clear()?;
                    continue;
                }
                let claim = ClaimTaskRequest::decode(saved.as_slice())
                    .context("stored Claim is invalid")?;
                ensure!(claim.operation_id == operation_id, "stored Claim identity differs");
                if claim != claim_request(&options, &worker, &workspaces, operation_id) {
                    // Never submit an unsent Claim with a superseded profile. A
                    // previously allocated reservation expires on its existing lease.
                    journal.clear()?;
                    continue;
                }
                supertag_protocol::crash_point("worker-host.claim", "journaled");
                presence.first_report(Duration::from_secs(5)).await;
                let mut claim = claim;
                if ready.is_some() {
                    // The host says it is ready after its first claim answers, so that one
                    // is not held.
                    claim.wait_ms = 0;
                }
                let mut claim_request = request(claim.clone(), &token)?;
                claim_request.set_timeout(CLAIM_WAIT + Duration::from_secs(3));
                let sent = Instant::now();
                let retired = async {
                    match &retire {
                        Some(retire) => retire.cancelled().await,
                        None => std::future::pending().await,
                    }
                };
                // Shutdown ends a held claim; the journaled Claim replays with the same operation
                // on the next start, so an assignment made meanwhile is not lost. Retirement ends
                // it too, and asks again at once with the same operation: an assignment made
                // meanwhile comes back and runs, and otherwise the lane leaves.
                let response = tokio::select! {
                    response = host.claim_task(claim_request) => response,
                    _ = shutdown.cancelled() => continue,
                    _ = retired => {
                        claim.wait_ms = 0;
                        host.claim_task(request(claim, &token)?).await
                    }
                };
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
                    supertag_protocol::crash_point("worker-host.claim", "assigned");
                    failures::begin_attempt();
                    journal.save(&Entry::Starting {
                        attempt: Attempt::from_assignment(assignment)?,
                    })?;
                    supertag_protocol::crash_point("worker-host.start", "journaled");
                } else {
                    journal.clear()?;
                    if options.once {
                        return Ok(());
                    }
                    // A claim the Control Plane held already waited; claim again at once.
                    if sent.elapsed() >= Duration::from_secs(1) {
                        continue;
                    }
                    match &retire {
                        Some(retire) => tokio::select! {
                            () = wait_for_work(&shutdown) => {}
                            () = retire.cancelled() => {}
                        },
                        None => wait_for_work(&shutdown).await,
                    }
                }
            }
            Entry::Starting { attempt } | Entry::PreparingInputs { attempt, .. } => {
                Worker {
                    options: Settings {
                        options: &worker,
                        state_directory: &options.state_directory,
                        mcp_catalog: &options.mcp_catalog,
                        network_credentials: &options.network_credentials,
                        workspace_mounts: &options.workspace_mounts,
                    },
                    journal: journal.for_attempt(),
                    workspaces: &workspaces,
                    inputs: &inputs,
                    coordination: &coordination,
                    storage: &storage,
                    transfers: &transfers,
                    shutdown: &shutdown,
                    authority: Authority::new(
                        (&mut host, &token, &registration),
                        &shutdown,
                        (&journal, &workspaces),
                        (&options.state_directory, options.once),
                    ),
                }
                .run(attempt, || {
                    if let Some(ready) = ready.take() {
                        ready();
                    }
                })
                .await?;
            }
            Entry::Executing { attempt, prepared } => {
                ensure_providers_stopped(&worker, &journal, &attempt, &registration)
                    .await
                    .context(cleanup_failure::CleanupUnconfirmed::default())?;
                match resolved(&mut host, &attempt, &token).await {
                    Ok(true) => journal.save(&Entry::Terminal { attempt, prepared })?,
                    Ok(false) if reclaim(&mut host, &journal, &attempt, &token).await? => {
                        supertag_protocol::terminal_text::warn(&format!(
                            "Task {} Attempt {} was interrupted; its processes stopped, so this host recorded it as failed with an unknown outcome",
                            attempt.task_id, attempt.attempt_id
                        ));
                        journal.save(&Entry::Terminal { attempt, prepared })?;
                    }
                    Ok(false) if options.wait_for_recovery => {
                        if let Some(ready) = ready.take() {
                            ready();
                        }
                        // Once per Attempt, however this host came to wait: it claims no work
                        // until the operator decides.
                        if announced_recovery.as_deref() != Some(attempt.attempt_id.as_str()) {
                            supertag_protocol::terminal_text::warn(&recovery_notice(&attempt));
                            announced_recovery = Some(attempt.attempt_id.clone());
                        }
                        wait_for_work(&shutdown).await;
                    }
                    Ok(false) => {
                        return Err(anyhow::anyhow!(
                            "Task {} Attempt {} needs recovery before this host can claim work",
                            attempt.task_id,
                            attempt.attempt_id
                        )
                        .context(cleanup_failure::CleanupUnconfirmed::default()));
                    }
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
                quiet,
                checkpoint,
                workspace,
                remote_tree,
                outputs,
                file_scope,
            } => {
                // This stage is recorded only after the adapter process group was reaped.
                // Exact finalization can safely resume after a Host restart.
                with_cleanup_authority(
                    &mut host, &attempt, &token, &shutdown,
                    ensure_providers_stopped(&worker, &journal, &attempt, &registration),
                ).await?;
                if let Some(pending) = outputs.as_ref().filter(|output| succeeded && !output.frozen).cloned() {
                    if remote_tree.is_some() {
                        save_finish(&journal, attempt, adapter::failed("Task output files could not be captured safely"))?;
                        continue;
                    }
                    let cancellation = shutdown.child_token();
                    let frozen = with_authority(&mut host, &attempt, &token, &shutdown, &cancellation, async {
                        pending.freeze(&workspace, &workspaces, &options.state_directory, (&transfers, &attempt, &token), &cancellation)
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
                            quiet,
                            checkpoint,
                            workspace,
                            remote_tree,
                            outputs: Some(pending),
                            file_scope,
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
                if succeeded && !options.workspace_mounts.is_empty() {
                    // Read-write copies are written back directly to their
                    // Volumes; the Control Plane records only the summary.
                    let cancellation = shutdown.child_token();
                    let mounts = options.workspace_mounts.clone();
                    let state = options.state_directory.clone();
                    let attempt_id = attempt.attempt_id.clone();
                    let copy_cancel = cancellation.clone();
                    let mut client = coordination.workspace_mounts.clone();
                    let reported = with_authority(&mut host, &attempt, &token, &shutdown, &cancellation, async {
                        let writes = tokio::task::spawn_blocking(move || {
                            workspace_mounts::write_back(&mounts, &state, &attempt_id, &copy_cancel)
                        })
                        .await
                        .map_err(|error| crate::failures::noted(Status::internal("Workspace Volume write-back failed"), &error))?
                        .map_err(|error| {
                            supertag_protocol::terminal_text::warn(&format!(
                                "Workspace Volume write-back failed: {error:#}"
                            ));
                            Status::failed_precondition("Workspace Volume write-back failed")
                        })?;
                        if writes.is_empty() {
                            return Ok(true);
                        }
                        let complete = writes
                            .iter()
                            .all(|write| write.status == WorkspaceMountWriteStatus::Complete as i32);
                        let report = RecordWorkspaceMountWritesRequest {
                            task_id: attempt.task_id.clone(),
                            attempt_id: attempt.attempt_id.clone(),
                            lease_token: attempt.lease_token.clone(),
                            writes,
                        };
                        client
                            .record_writes(request(report, &token).map_err(|error| crate::failures::noted(Status::internal("Workspace Volume write-back failed"), &error))?)
                            .await
                            .map(|_| complete)
                    })
                    .await;
                    match reported {
                        Ok((true, _)) => {}
                        // A partial or refused write-back fails the Task; its
                        // summary is recorded for `describe task`.
                        Ok((false, _)) => {
                            save_finish(&journal, attempt, adapter::failed("Workspace Volume write-back was partial or refused"))?;
                            continue;
                        }
                        Err(_) if shutdown.is_cancelled() => return Ok(()),
                        Err(error) if retryable(&error) => {
                            wait_for_work(&shutdown).await;
                            continue;
                        }
                        Err(error) => {
                            failures::note("Workspace Volume write-back failed", &error);
                            save_finish(&journal, attempt, adapter::failed("Workspace Volume write-back failed"))?;
                            continue;
                        }
                    }
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
                            .await.map_err(|error| crate::failures::noted(Status::internal("artifact input cleanup failed"), &error))?
                            .map_err(|error| crate::failures::noted(Status::failed_precondition("artifact input files could not be removed safely"), &error))?;
                        if let Some(tree) = &remote_tree {
                            workspaces.restore_remote(&workspace, tree, &cancellation).await
                                .map_err(|error| crate::failures::noted(Status::invalid_argument("Remote Workspace output could not be restored safely"), &error))?;
                        }
                        if let Some(directory) = outputs.as_ref().and_then(|outputs| outputs.cleanup_directory()) {
                            let checkout = workspace.checkout.path.clone();
                            let directory = directory.to_owned();
                            tokio::task::spawn_blocking(move || {
                                supertag_workspaces::remove_output_directory(&checkout, &directory)
                                    .map_err(|error| crate::failures::noted(Status::failed_precondition("Task output directory could not be removed safely"), &error))
                            }).await.map_err(|error| crate::failures::noted(Status::internal("Task output cleanup failed"), &error))??;
                        }
                        workspaces
                            .finalize(&workspace, &result, (succeeded, file_scope.clone()), outputs.as_ref().map(|output| output.directory.as_str()), &cancellation)
                            .await
                            .map_err(|error| {
                                // The delivery check names the out-of-scope paths.
                                match error.downcast_ref::<supertag_workspaces::ScopeViolation>() {
                                    Some(violation) => Status::permission_denied(violation.to_string()),
                                    None => Status::invalid_argument(
                                        "Workspace output could not be captured safely",
                                    ),
                                }
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
                        quiet,
                        checkpoint,
                        workspace: Some(Box::new(pending)),
                        prepared: Some(workspace),
                        outputs,
                        failure_detail: if succeeded { vec![] } else { failures::take_detail() },
                    })?,
                    Err(_) if shutdown.is_cancelled() => return Ok(()),
                    Err(error) if retryable(&error) => wait_for_work(&shutdown).await,
                    Err(error) if error.code() == Code::PermissionDenied => {
                        save_finish(&journal, attempt, adapter::failed(error.message()))?
                    }
                    Err(error) => {
                        failures::note("Workspace output could not be captured safely", &error);
                        save_finish(
                            &journal,
                            attempt,
                            adapter::failed("Workspace output could not be captured safely"),
                        )?
                    }
                }
            }
            Entry::Finish {
                attempt,
                result,
                succeeded,
                objective_signal,
                waiting_approval_ids,
                quiet,
                checkpoint,
                workspace,
                prepared,
                outputs,
                failure_detail,
            } => {
                with_cleanup_authority(
                    &mut host, &attempt, &token, &shutdown,
                    ensure_providers_stopped(&worker, &journal, &attempt, &registration),
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
                        Err(error) => {
                            failures::note("Workspace output no longer matches its receipt", &error);
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
                                quiet,
                                checkpoint,
                                workspace: Some(pending),
                                prepared,
                                outputs,
                                failure_detail: failure_detail.clone(),
                            })?;
                        }
                        Err(error)
                            if retryable(&error) || error.code() == Code::ResourceExhausted =>
                        {
                            wait_for_work(&shutdown).await
                        }
                        Err(_) if shutdown.is_cancelled() => return Ok(()),
                        Err(error) => {
                            failures::note("Workspace output could not be committed", &error);
                            save_finish(
                                &journal,
                                attempt,
                                adapter::failed("Workspace output could not be committed"),
                            )?
                        }
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
                            let payload = journal.read_checkpoint(&pending).map_err(|error| crate::failures::noted(Status::data_loss("staged checkpoint could not be read"), &error))?;
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
                                quiet,
                                checkpoint: Some(pending),
                                workspace,
                                prepared,
                                outputs,
                                failure_detail: failure_detail.clone(),
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
                            supertag_protocol::terminal_text::warn(&format!(
                                "Task {} Attempt {}: the Control Plane refused its Session checkpoint ({:?}): {}",
                                attempt.task_id,
                                attempt.attempt_id,
                                error.code(),
                                error.message()
                            ));
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
                            result = pending.publish(&options.state_directory, &attempt, (&coordination, &storage), &token) => result,
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
                            quiet,
                            checkpoint,
                            workspace,
                            prepared,
                            outputs: Some(pending),
                            failure_detail: failure_detail.clone(),
                        })?,
                        Err(error) if retryable(&error) || error.code() == Code::ResourceExhausted => wait_for_work(&shutdown).await,
                        Err(_) if shutdown.is_cancelled() => return Ok(()),
                        Err(error) => {
                            failures::note("Task output could not be committed", &error);
                            save_finish(
                                &journal,
                                attempt,
                                adapter::failed("Task output could not be committed"),
                            )?
                        }
                    }
                    continue;
                }
                supertag_protocol::crash_point("worker-host.finish", "journaled");
                // A local Workspace's Session branch goes into its own repository before the
                // Task is reported, so whoever sees it succeed finds the branch. Best effort: the
                // delivery stands either way, and a later delivery writes the branch again.
                if let Some(pending) = workspace.as_ref().filter(|_| succeeded) {
                    write_session_branch(&mut host, &workspaces, &attempt, &token, pending, &shutdown).await;
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
                            quiet,
                            artifacts: outputs.as_ref().filter(|_| succeeded)
                                .and_then(|outputs| outputs.selection()).into_iter().collect(),
                            checkpoint_sha256: checkpoint.map(|pending| pending.sha256),
                            workspace_delivery: workspace
                                .as_ref()
                                .filter(|_| succeeded)
                                .map(|pending| workspaces.verify(pending))
                                .transpose()?,
                            failure_detail: if succeeded { vec![] } else { failure_detail.clone() },
                        },
                        &token,
                    )?)
                    .await;
                match outcome {
                    Ok(response) if response.get_ref().state() == TaskState::Uncertain => {
                        // Cleanup was observed, but the operator still owns the
                        // recovery decision. Preserve the checkout until its receipt.
                        // This host holds an outcome, so it never reclaims the Attempt itself.
                        supertag_protocol::terminal_text::warn(&format!(
                            "Task {} Attempt {} is uncertain: its execution lease lapsed before it finished, so the Control Plane cannot tell what it did (this host recorded it as {})",
                            attempt.task_id,
                            attempt.attempt_id,
                            if succeeded { "succeeded" } else { "failed" },
                        ));
                        journal.processes(&attempt).discard()?;
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
                    Ok(response) => {
                        ensure!(
                            matches!(
                                response.get_ref().state(),
                                TaskState::Succeeded | TaskState::Failed | TaskState::Cancelled
                            ),
                            "Finish returned a nonterminal Task"
                        );
                        supertag_protocol::crash_point("worker-host.finish", "answered");
                    }
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
                            quiet: false,
                            checkpoint: None,
                            workspace,
                            prepared,
                            outputs: None,
                            failure_detail: vec![],
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
                let discarded = cleanup_terminal(&journal, &workspaces, &options.state_directory, &attempt, prepared.as_deref())?;
                purge_discarded(discarded, options.once);
                landings.land_now(&shutdown).await;
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
    keep_awake.stop().await;
    if let Err(error) = &outcome
        && error
            .downcast_ref::<cleanup_failure::CleanupUnconfirmed>()
            .is_some()
        && let Ok(Some(entry)) = journal.load()
        && let Some(attempt) = entry.unsettled_attempt()
    {
        cleanup_failure::report(&mut host, attempt, &token, error).await;
    }
    let stopped = presence.stop().await;
    outcome.and(stopped)
}
