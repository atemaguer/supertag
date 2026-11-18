//! One Task Attempt's run: start it under its lease, prepare its Workspace, inputs, Context
//! Items, MCP servers, proxies, and sandbox, run the harness, and capture what it produced.

use std::{sync::Arc, time::Duration};

use anyhow::{Context, Result, ensure};
use supertag_protocol::v2::{Assignment, TaskState};
use tokio::time::{self, Instant};
use tokio_util::sync::CancellationToken;
use tonic::{Code, Status};

use crate::worker::Settings;
use crate::worker::milestones::{WORKSPACE_READY, report_harness_finished, report_milestone};
use crate::worker::setup::{prepare_context, workspace_mcp};
use crate::worklet::authority::{AUTHORITY_EXPIRED, Authority};
use crate::{
    AttemptClients, ProviderConfig, RegisteredInputs, ensure_attempt, failures, lost_ownership,
    request, retryable, wait_for_work,
    worker::{
        adapter, changed_paths, egress, mcp, remote, remote_provider, shared_execution,
        task_artifact_inputs, task_outputs,
    },
    worklet::{
        HostStorage, checkpoints,
        journal::{self, Attempt, AttemptJournal},
        workspaces,
    },
};

/// What a turn is told about its Task output directory. Changes to the repository belong in the
/// checkout, where they become the Session's commits; a model told to "save deliverables" in the
/// output directory once wrote a requested repository file there, and nothing was committed.
pub(crate) const OUTPUT_DIRECTORY_USE: &str = "Make every change to the repository's files in the Workspace itself, where it becomes this Task's commit; that includes files the request asks you to create. Use the Task output directory only for files that are not part of the repository, such as a report or a generated file nobody asked to commit: SuperTag keeps them with the Task result, outside any commit.";

pub(crate) const DEVCONTAINER_REFUSAL: &str = "Remote Workspace devcontainer: ";

/// One Task Attempt on this host: what it reads, the Worklet state it is lent, and the
/// `Authority` it takes lease-bound actions through.
pub(crate) struct Worker<'a> {
    pub(crate) options: Settings<'a>,
    pub(crate) journal: AttemptJournal<'a>,
    pub(crate) workspaces: &'a workspaces::Workspaces,
    pub(crate) inputs: &'a RegisteredInputs,
    pub(crate) coordination: &'a AttemptClients,
    pub(crate) storage: &'a HostStorage,
    pub(crate) transfers: &'a checkpoints::Transfers,
    pub(crate) shutdown: &'a CancellationToken,
    pub(crate) authority: Authority<'a>,
}

impl Worker<'_> {
    /// Runs the journaled Attempt from Starting until its outcome is journaled for the Worklet.
    /// `ready` is called once the host has answered for it.
    pub(crate) async fn run(self, attempt: Attempt, ready: impl FnOnce()) -> Result<()> {
        let Worker {
            options,
            journal,
            workspaces,
            inputs,
            coordination,
            storage,
            transfers,
            shutdown,
            mut authority,
        } = self;
        let options = &options;
        let (token, registration) = (authority.token(), authority.registration());
        // Starting is durable before requesting authority and never records a launch.
        // A lost start response can therefore be retried using this exact Attempt.
        let can_launch = attempt.can_launch(options)?;
        let start = if can_launch {
            authority.start(&attempt).await?
        } else {
            authority.inspect(&attempt).await?
        };
        let task = match start {
            Ok(task) => {
                if can_launch {
                    supertag_protocol::crash_point("worker-host.start", "answered");
                }
                task
            }
            Err(error) if retryable(&error) => {
                wait_for_work(shutdown).await;
                return Ok(());
            }
            Err(error) if lost_ownership(&error) => {
                match authority.inspect(&attempt).await? {
                    Ok(task) => task,
                    Err(error) if retryable(&error) => {
                        wait_for_work(shutdown).await;
                        return Ok(());
                    }
                    // No adapter was launched for Starting. The Control Plane can
                    // safely retire a reservation that expired before start.
                    Err(error) if lost_ownership(&error) => {
                        return authority.discard_prelaunch(&attempt);
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
                // Starting never launched an adapter.
                return authority.release_unstarted();
            }
            return authority.finish(
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
            return authority.finish(attempt, adapter::failed("Task Attempt ended before launch"));
        }
        ensure!(
            task.state() == TaskState::Running,
            "Control Plane did not authorize the Task Attempt to start"
        );

        let sent = Instant::now();
        let renewed = authority.renew(&attempt).await?;
        let granted = match renewed {
            Ok(granted) => granted,
            Err(error) if retryable(&error) => {
                wait_for_work(shutdown).await;
                return Ok(());
            }
            Err(error) if lost_ownership(&error) => {
                return authority.discard_prelaunch(&attempt);
            }
            Err(error) => return Err(error.into()),
        };
        ready();
        let mut task = granted.task.context("execution authority has no Task")?;
        ensure_attempt(&task, &attempt)?;
        if let Some(workspace) = task
            .workspace
            .as_ref()
            .filter(|spec| !spec.base_ref.is_empty() && spec.base_commit.is_empty())
        {
            // A Tag that follows a branch: this Session's first Attempt resolves it here, and the
            // Control Plane records the first resolution for every Task of the Session.
            let branch = workspace.base_ref.clone();
            let commit = match workspaces
                .resolve_ref(&workspace.workspace_id, &branch, shutdown)
                .await
            {
                workspaces::BranchResolution::Commit(commit) => commit,
                // Shutdown keeps the Starting entry, so recovery retries this exact Attempt.
                workspaces::BranchResolution::Interrupted => return Ok(()),
                workspaces::BranchResolution::Failed(message) => {
                    return authority.finish(attempt, adapter::failed(&message));
                }
            };
            match authority.resolve_workspace_ref(&attempt, commit).await? {
                Ok(resolved) => {
                    task = resolved;
                    ensure_attempt(&task, &attempt)?;
                }
                Err(error) if retryable(&error) => {
                    wait_for_work(shutdown).await;
                    return Ok(());
                }
                Err(error) if lost_ownership(&error) => {
                    return authority.discard_prelaunch(&attempt);
                }
                Err(error) => return Err(error.into()),
            }
        }
        let valid_until = sent
            .checked_add(Duration::from_millis(granted.valid_for_ms))
            .context("invalid execution authority duration")?;
        if task.state() != TaskState::Running || valid_until <= Instant::now() {
            return authority.finish(
                attempt,
                adapter::failed("Execution authority expired before launch"),
            );
        }
        if !supertag_protocol::mcp::supports(&task, options.harness, &options.execution_profile) {
            return authority.finish(
                attempt,
                adapter::failed("Worker Host cannot enforce accepted MCP grants"),
            );
        }
        if !supertag_protocol::shared_execution::supports(
            &task,
            options.harness,
            options.execution_profile.shared_execution.as_ref(),
        ) {
            return authority.finish(
                attempt,
                adapter::failed("Worker Host cannot enforce accepted shared execution placement"),
            );
        }
        if !supertag_protocol::network_scope::supports(
            &task,
            options.harness,
            &options.execution_profile,
        ) {
            return authority.finish(
                attempt,
                adapter::failed("Worker Host cannot enforce the Task's network scope"),
            );
        }
        if !supertag_protocol::output_policy::supports(
            &task,
            options.harness,
            &options.execution_profile,
        ) {
            return authority.finish(
                attempt,
                adapter::failed("Worker Host cannot enforce accepted Task output requirements"),
            );
        }
        if !supertag_protocol::task_artifact_inputs::supports(
            &task,
            options.harness,
            &options.execution_profile,
        ) || (!task.input_artifacts.is_empty()
            && !task
                .attempt_execution
                .as_ref()
                .is_some_and(|execution| execution.task_artifact_inputs))
        {
            return authority.finish(
                attempt,
                adapter::failed("Worker Host cannot materialize accepted Task artifact inputs"),
            );
        }
        let mount_pins = task
            .workspace
            .as_ref()
            .map(|workspace| workspace.mounts.clone())
            .unwrap_or_default();
        if !mount_pins.is_empty() {
            let check = match coordination
                .workspace_mounts
                .clone()
                .preflight(request(attempt.inspect(), token)?)
                .await
            {
                Err(error) if retryable(&error) => {
                    wait_for_work(shutdown).await;
                    return Ok(());
                }
                check => check,
            };
            let permitted = supertag_protocol::workspace_mounts::supports(
                &task,
                options.harness,
                &options.execution_profile,
            ) && check.ok().is_some_and(|response| {
                options
                    .workspace_mounts
                    .preflight(&mount_pins, response.into_inner())
                    .is_ok()
            });
            if !permitted {
                return authority.finish(
                    attempt,
                    adapter::failed("Workspace Volume path admission failed"),
                );
            }
        }
        let checkpoint = match time::timeout_at(
            valid_until,
            transfers.download(&attempt, token, (&task.tag_id, &task.session_id)),
        )
        .await
        {
            Ok(Ok(checkpoint)) => {
                checkpoint.filter(|checkpoint| checkpoints::resumable(options.harness, checkpoint))
            }
            Ok(Err(error)) if retryable(&error) || error.code() == Code::ResourceExhausted => {
                wait_for_work(shutdown).await;
                return Ok(());
            }
            Ok(Err(error)) if lost_ownership(&error) || error.code() == Code::DataLoss => {
                return authority.finish(
                    attempt,
                    adapter::failed("Session checkpoint could not be restored"),
                );
            }
            Ok(Err(error)) => return Err(error.into()),
            Err(_) => {
                return authority.finish(
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
            let context_host = authority.client();
            match authority
                .keep(
                    &attempt,
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
                Err(error) => {
                    failures::note("Task Context Items could not be resolved safely", &error);
                    return authority.finish(
                        attempt,
                        adapter::failed("Task Context Items could not be resolved safely"),
                    );
                }
            }
        } else {
            vec![]
        };
        let operation_cancel = shutdown.child_token();
        let prepared = authority
            .keep(&attempt, &operation_cancel, async {
                workspaces
                    .prepare(&task, &attempt, transfers, token, &operation_cancel)
                    .await
                    .map_err(|error| {
                        error.downcast::<Status>().unwrap_or_else(|error| {
                            failures::noted(
                                Status::invalid_argument(
                                    "Task workspace could not be prepared safely",
                                ),
                                &format!("{error:#}"),
                            )
                        })
                    })
            })
            .await;
        let (workspace, mut valid_until) = match prepared {
            Ok(prepared) => {
                if task.waiting_for_holder.is_some() {
                    authority.report_waiting_for_holder(&attempt, false).await;
                }
                // A remote Attempt's Workspace is ready once its sandbox is.
                if options.remote_provider.is_none() {
                    report_milestone(
                        &authority.client(),
                        &attempt.inspect(),
                        token,
                        WORKSPACE_READY,
                    );
                }
                prepared
            }
            Err(error) if retryable(&error) && !shutdown.is_cancelled() => {
                // The Session's last delivery is not readable here yet: its holder has not pushed it,
                // or holds a local Workspace. Say so once, so the Task shows what it waits for, then
                // keep trying.
                if error.code() == Code::Unavailable
                    && error
                        .message()
                        .contains(supertag_protocol::WAITS_FOR_HOLDER)
                    && task.waiting_for_holder.is_none()
                {
                    authority.report_waiting_for_holder(&attempt, true).await;
                }
                wait_for_work(shutdown).await;
                return Ok(());
            }
            Err(error) => {
                // A failed setup names itself and keeps its untrusted output, as TypeScript's
                // `workspace-setup` failure does.
                let message = if error.message().starts_with("Workspace setup") {
                    error.message()
                } else if error.message() == AUTHORITY_EXPIRED {
                    "Execution authority expired while the Task workspace was prepared"
                } else {
                    "Task workspace could not be prepared safely"
                };
                return authority.finish(attempt, adapter::failed(message));
            }
        };
        if !task.input_artifacts.is_empty() && options.remote_provider.is_none() {
            let prepared = workspace
                .as_ref()
                .context("Task artifact input Workspace is missing")?;
            journal.preparing_inputs(&attempt, prepared)?;
            let cancel = shutdown.child_token();
            let staged = Box::pin(authority.keep(
                &attempt,
                &cancel,
                task_artifact_inputs::prepare(
                    (options.state_directory, &prepared.checkout.path),
                    &task,
                    &attempt,
                    (coordination, storage),
                    token,
                    &cancel,
                ),
            ))
            .await;
            match staged {
                Ok((instructions, expires)) => {
                    task.instructions.push_str(&instructions);
                    valid_until = expires;
                }
                Err(_) if shutdown.is_cancelled() => return Ok(()),
                Err(error) if retryable(&error) => {
                    wait_for_work(shutdown).await;
                    return Ok(());
                }
                Err(error) => {
                    failures::note(
                        "Task artifact inputs could not be materialized safely",
                        &error,
                    );
                    return authority.finish(
                        attempt,
                        adapter::failed("Task artifact inputs could not be materialized safely"),
                    );
                }
            }
        }
        let mounted = if mount_pins.is_empty() {
            None
        } else {
            let checkout = workspace
                .as_ref()
                .context("Workspace mount checkout is missing")?;
            journal.preparing_inputs(&attempt, checkout)?;
            let state = options.state_directory.clone();
            let checkout = checkout.checkout.path.clone();
            let attempt_id = attempt.attempt_id.clone();
            let mappings = options.workspace_mounts.clone();
            let cancel = shutdown.child_token();
            let copy_cancel = cancel.clone();
            let operation = async {
                let current = coordination
                    .workspace_mounts
                    .clone()
                    .preflight(request(attempt.inspect(), token).map_err(|error| {
                        crate::failures::noted(
                            Status::internal("Workspace Volume request failed"),
                            &error,
                        )
                    })?)
                    .await?
                    .into_inner();
                let protected = mappings.preflight(&mount_pins, current).map_err(|error| {
                    crate::failures::noted(
                        Status::failed_precondition("Workspace Volume path admission failed"),
                        &error,
                    )
                })?;
                tokio::task::spawn_blocking(move || {
                    mappings.stage(
                        &state,
                        &attempt_id,
                        &checkout,
                        &mount_pins,
                        &protected,
                        &copy_cancel,
                    )
                })
                .await
                .map_err(|error| {
                    crate::failures::noted(
                        Status::internal("Workspace Volume staging failed"),
                        &error,
                    )
                })?
                .map_err(|error| {
                    supertag_protocol::terminal_text::warn(&format!(
                        "Workspace Volume staging failed: {error:#}"
                    ));
                    Status::failed_precondition("Workspace Volume staging failed")
                })
            };
            match Box::pin(authority.keep(&attempt, &cancel, operation)).await {
                Ok((mounted, expires)) => {
                    // A remote Workspace names its copies where the sandbox holds them.
                    if options.remote_provider.is_none() {
                        task.instructions.push_str(&mounted.instructions()?);
                    }
                    valid_until = expires;
                    Some(mounted)
                }
                Err(_) if shutdown.is_cancelled() => return Ok(()),
                Err(error) => {
                    failures::note("Workspace Volume staging failed", &error);
                    return authority
                        .finish(attempt, adapter::failed("Workspace Volume staging failed"));
                }
            }
        };
        let processes = journal.processes(&attempt);
        processes.begin(options.remote_provider.is_none() && options.shared_execution.is_none())?;
        journal.executing(&attempt, workspace.as_ref())?;
        supertag_protocol::crash_point("worker-host.execute", "journaled");
        let workspace_mcp = if supertag_protocol::mcp::workspace_servers(&task).is_empty() {
            None
        } else {
            let cancel = shutdown.child_token();
            let resolved = authority
                .keep(
                    &attempt,
                    &cancel,
                    workspace_mcp(
                        workspaces,
                        (
                            workspace.as_ref(),
                            options.remote_provider.as_ref().map(ProviderConfig::label),
                        ),
                        &task,
                        (&coordination.mcp_effects, &attempt, token),
                        &cancel,
                    ),
                )
                .await;
            match resolved {
                Ok((resolved, expires)) => {
                    valid_until = expires;
                    Some(resolved)
                }
                Err(error) => {
                    if let Some(prepared) = workspace.as_ref() {
                        workspaces.remove_mcp_snapshot(prepared);
                    }
                    let message = if error.code() == Code::InvalidArgument
                        || error.code() == Code::FailedPrecondition
                    {
                        error.message().to_owned()
                    } else {
                        "Workspace MCP servers could not be resolved safely".into()
                    };
                    return authority.finish(attempt, adapter::failed(&message));
                }
            }
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
            Err(error) => {
                failures::note("Task output directory could not be prepared safely", &error);
                return authority.finish(
                    attempt,
                    adapter::failed("Task output directory could not be prepared safely"),
                );
            }
        };
        // A network scope runs this Attempt's egress proxy for as long as its harness runs. It starts
        // before a remote sandbox, whose commands reach it through the sandbox's relay.
        let egress = match supertag_protocol::network_scope::of_task(&task) {
            Some(scope) => Some(
                egress::start_for_attempt(
                    scope,
                    options.network_credentials,
                    options.state_directory,
                    &attempt.attempt_id,
                    options.harness,
                    options.remote_provider.is_some(),
                )
                .await
                .context("start the Attempt's egress proxy")?,
            ),
            None => None,
        };
        let mut sandbox_execution_ends = None;
        // A remote sandbox nothing needs before the Harness starts is prepared while it runs, so the
        // model starts without waiting for it; its first tool waits instead. Task artifact inputs and
        // Workspace copies are named by path at launch and staged in the background. MCP servers
        // need the sandbox first, since the Harness lists their tools when it starts, so then it is
        // prepared before.
        let defer_sandbox = options.remote_provider.is_some()
            && options.shared_execution.is_none()
            && workspace_mcp.is_none()
            && supertag_protocol::mcp::grants(&task).next().is_none();
        let mut deferred = None;
        let mut deferred_inputs = None;
        if defer_sandbox {
            let prepared = workspace
                .as_ref()
                .context("remote Attempt has no prepared Workspace")?;
            // The base commit's devcontainer subset is still read and refused before launch.
            let cancel = shutdown.child_token();
            match workspaces.remote_environment(prepared, &cancel).await {
                Ok(environment) => {
                    // Inputs download now, without the sandbox, so the Harness reads their paths.
                    if !task.input_artifacts.is_empty() || mounted.is_some() {
                        let downloaded = Box::pin(authority.keep(
                            &attempt,
                            &cancel,
                            remote::download_inputs(
                                &attempt,
                                &task,
                                (coordination, storage, token),
                                &cancel,
                            ),
                        ))
                        .await;
                        let inputs = match downloaded {
                            Ok((inputs, expires)) => {
                                valid_until = expires;
                                inputs
                            }
                            Err(error) => {
                                return authority.finish(
                                    attempt,
                                    adapter::failed(&format!(
                                        "Remote Workspace could not be prepared: {}",
                                        error.message()
                                    )),
                                );
                            }
                        };
                        match remote::launch_instructions(&inputs, mounted.as_ref(), &attempt) {
                            Ok(Some(instructions)) => task.instructions.push_str(&instructions),
                            Ok(None) => {}
                            Err(error) => {
                                return authority.finish(
                                    attempt,
                                    adapter::failed(&format!(
                                        "Remote Workspace could not be prepared: {error:#}"
                                    )),
                                );
                            }
                        }
                        deferred_inputs = Some(inputs);
                    }
                    let (pending, ready) = adapter::RemoteWorkspace::pending();
                    sandbox_execution_ends =
                        Some(remote::execution_ends(options, mounted.as_ref()));
                    deferred = Some((environment, pending, ready));
                }
                Err(error) => {
                    return authority.finish(
                        attempt,
                        adapter::failed(&format!("{DEVCONTAINER_REFUSAL}{error:#}")),
                    );
                }
            }
        }
        // What a replacement for a lost sandbox starts from, once the first sandbox is prepared.
        let mut first_restart = None;
        let mut provider = if options.remote_provider.is_some() && !defer_sandbox {
            let workspace = workspace
                .as_ref()
                .context("remote Attempt has no prepared Workspace")?;
            let cancel = shutdown.child_token();
            let prepared = Box::pin(authority.keep(&attempt, &cancel, async {
                // The base commit's devcontainer subset is read and refused here, before any
                // provider call. A refusal names the property; nothing else reaches the Task.
                let environment = workspaces
                    .remote_environment(workspace, &cancel)
                    .await
                    .map_err(|error| {
                        Status::invalid_argument(format!("{DEVCONTAINER_REFUSAL}{error:#}"))
                    })?;
                remote::prepare(
                    options,
                    journal,
                    workspaces,
                    (&attempt, workspace, &task),
                    (
                        // Only a sandboxed stdio server needs the trusted copy beside the checkout.
                        workspace_mcp
                            .as_ref()
                            .filter(|resolved| resolved.sandboxed())
                            .map(|_| workspace.checkout.base_commit.as_str()),
                        environment,
                        mounted.as_ref(),
                        None,
                    ),
                    (registration, (coordination, storage), token),
                    (egress.as_ref(), &cancel),
                )
                .await
                .map_err(|error| {
                    crate::failures::noted(
                        Status::failed_precondition("Remote Workspace could not be prepared"),
                        &error,
                    )
                })
            }))
            .await;
            match prepared {
                Ok(((provider, instructions, execution_ends, restart), expires)) => {
                    report_milestone(
                        &authority.client(),
                        &attempt.inspect(),
                        token,
                        WORKSPACE_READY,
                    );
                    if let Some(instructions) = instructions {
                        task.instructions.push_str(&instructions);
                    }
                    valid_until = expires;
                    sandbox_execution_ends = Some(execution_ends);
                    first_restart = Some(restart);
                    Some(provider)
                }
                Err(error) => {
                    authority
                        .keep_for_cleanup(
                            &attempt,
                            remote::ensure_stopped(options, journal, &attempt, registration),
                        )
                        .await?;
                    let message = if error.message().starts_with(DEVCONTAINER_REFUSAL) {
                        error.message()
                    } else {
                        "Remote Workspace could not be prepared"
                    };
                    return authority.finish(attempt, adapter::failed(message));
                }
            }
        } else {
            None
        };
        // A remote Workspace's stdio servers run in its staged sandbox, so they start after it.
        let sandbox = provider
            .as_ref()
            .map(remote_provider::RemoteProvider::mcp_connection);
        let mcp = if supertag_protocol::mcp::grants(&task).next().is_some() {
            let cancel = shutdown.child_token();
            match authority
                .keep(
                    &attempt,
                    &cancel,
                    mcp::AttemptMcp::prepare(
                        options.mcp_catalog,
                        (workspace_mcp.as_ref(), sandbox.as_ref()),
                        &task,
                        &processes,
                        &cancel,
                    ),
                )
                .await
            {
                Ok((mcp, expires)) => {
                    valid_until = expires;
                    mcp.map(Arc::new)
                }
                Err(error) => {
                    failures::note("Workspace MCP servers could not be prepared", &error);
                    if let Some(prepared) = workspace.as_ref().filter(|_| workspace_mcp.is_some()) {
                        workspaces.remove_mcp_snapshot(prepared);
                    }
                    if let Some(provider) = provider.as_mut() {
                        authority
                            .keep_for_cleanup(&attempt, async {
                                let closed = provider.shutdown().await;
                                remote::ensure_stopped(options, journal, &attempt, registration)
                                    .await?;
                                closed
                            })
                            .await?;
                    }
                    // A login that lapsed since this host claimed the Task names its command.
                    let lapsed = options.mcp_catalog.lapsed_logins();
                    let message = supertag_protocol::mcp::grants(&task)
                    .filter_map(|(_, grant)| supertag_protocol::mcp::parse_action(&grant.action))
                    .find(|(server, _)| lapsed.iter().any(|name| name == server))
                    .map_or_else(
                        || "Task MCP tools could not be resolved safely".to_owned(),
                        |(server, _)| {
                            format!(
                                "MCP server {server}: its login lapsed on this Worker Host; run {} there to log in again",
                                mcp::login_command(server)
                            )
                        },
                    );
                    return authority.finish(attempt, adapter::failed(&message));
                }
            }
        } else {
            None
        };
        let shared_access = if let Some(config) = options.shared_execution.as_ref() {
            let cancel = shutdown.child_token();
            match authority
                .keep(&attempt, &cancel, async {
                    shared_execution::prepare(
                        config,
                        journal,
                        &attempt,
                        &task,
                        registration,
                        options.attempt_timeout,
                    )
                    .await
                    .map_err(|error| {
                        crate::failures::noted(
                            Status::failed_precondition(
                                "shared execution access could not be prepared",
                            ),
                            &error,
                        )
                    })
                })
                .await
            {
                Ok((access, expires)) => {
                    valid_until = expires;
                    Some(access)
                }
                Err(error) => {
                    failures::note(
                        "Shared execution access could not be prepared safely",
                        &error,
                    );
                    authority.finish(
                        attempt.clone(),
                        adapter::failed("Shared execution access could not be prepared safely"),
                    )?;
                    authority
                        .keep_for_cleanup(
                            &attempt,
                            shared_execution::ensure_released(
                                options,
                                journal,
                                &attempt,
                                registration,
                            ),
                        )
                        .await?;
                    return Ok(());
                }
            }
        } else {
            None
        };
        let uses_shared_access = shared_access.is_some();
        let (sandbox_environment, sandbox_ready) = match deferred {
            Some((environment, pending, ready)) => (Some((environment, pending)), Some(ready)),
            None => (None, None),
        };
        let (sandbox_environment, pending_workspace) = match sandbox_environment {
            Some((environment, pending)) => (Some(environment), Some(pending)),
            None => (None, None),
        };
        // A provider that finds the sandbox gone asks for a replacement here; see `replacer` below.
        let (replace_requests, mut replace_inbox) = tokio::sync::mpsc::channel(1);
        let (restart_ready, restart_watch) = tokio::sync::watch::channel(first_restart);
        let remote_workspace = provider
            .as_ref()
            .map(|provider: &remote_provider::RemoteProvider| {
                let (channel, token) = provider.workspace_connection();
                adapter::RemoteWorkspace::new(channel, token)
            })
            .or(pending_workspace)
            .map(|workspace| workspace.with_replacer(replace_requests.clone()))
            .or_else(|| shared_access.map(adapter::RemoteWorkspace::shared));
        drop(replace_requests);
        let adapter_workspace = workspace
            .as_ref()
            .filter(|_| remote_workspace.is_none())
            .map(|prepared| prepared.checkout.path.as_path());
        let output_directory = outputs
            .as_ref()
            .zip(adapter_workspace)
            .map(|(outputs, checkout)| outputs.absolute(checkout));
        if let Some(output) = outputs
            .as_ref()
            .filter(|_| options.remote_provider.is_some())
        {
            task.instructions.push_str(&format!(
            "\n\nTask output directory: {}\n{OUTPUT_DIRECTORY_USE} Use paths relative to the remote Workspace in the admitted file tools.",
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
                "\n\nTask output directory: {}\n{OUTPUT_DIRECTORY_USE}",
                directory.display(),
            ));
        }
        let has_inputs = !task.input_artifacts.is_empty();
        // A client on this machine reads a local checkout itself; the Control Plane only learns
        // where it is. A failed report only means the client can't find it.
        if let Some(prepared) = workspace.as_ref().filter(|_| adapter_workspace.is_some()) {
            let mut task_files = coordination.task_files.clone();
            let location = supertag_protocol::v2::ReportTaskFilesLocationRequest {
                attempt: Some(attempt.inspect()),
                local_path: prepared.checkout.path.to_string_lossy().into_owned(),
            };
            if let Ok(request) = request(location, token) {
                tokio::spawn(async move {
                    let _ = task_files.report_location(request).await;
                });
            }
        }
        // Overlap warnings compare the changed paths of local checkouts only.
        let stop_reports = shutdown.child_token();
        let reports = workspace
            .as_ref()
            .filter(|_| adapter_workspace.is_some())
            .map(|prepared| {
                tokio::spawn(changed_paths::report(
                    coordination.changed_paths.clone(),
                    attempt.inspect(),
                    token.to_owned(),
                    prepared.checkout.clone(),
                    stop_reports.clone(),
                ))
            });
        // The delivery check applies the Task's path scope to what it changed.
        let file_scope = supertag_protocol::file_scope::of_task(&task)
            .map(supertag_protocol::file_scope::Rules::from);
        let sandbox_task = defer_sandbox.then(|| task.clone());
        // The harness answers the joined messages in the same turn. The Task's stored prompt keeps
        // only the person's own text.
        task.prompt = joined_prompt(&task.prompt, &attempt.joined);
        let assignment = Assignment {
            native_memory: attempt.native_memory.as_ref().map(|grant| {
                supertag_protocol::v2::NativeMemoryGrant {
                    scope: grant.scope.clone(),
                    reset_generation: grant.reset_generation,
                    volume_head: grant.volume_head.as_ref().map(|(revision, sha256, bytes)| {
                        supertag_protocol::v2::NativeMemoryVolumeHead {
                            revision: *revision,
                            manifest: Some(supertag_protocol::v2::BlobReference {
                                sha256: sha256.clone(),
                                byte_length: *bytes,
                            }),
                        }
                    }),
                }
            }),
            volume: attempt
                .volume
                .as_ref()
                .map(|volume| supertag_protocol::v2::AssignedVolume {
                    volume_id: volume.volume_id.clone(),
                    source: volume.source.clone(),
                    revision: volume.revision,
                }),
            task: Some(task),
            attempt_id: attempt.attempt_id.clone(),
            lease_token: attempt.lease_token.clone(),
            joined: attempt
                .joined
                .iter()
                .map(|message| supertag_protocol::v2::JoinedMessage {
                    task_id: message.task_id.clone(),
                    text: message.text.clone(),
                    sent_at_ms: message.sent_at_ms,
                })
                .collect(),
        };
        let sandbox_cancel = shutdown.child_token();
        let run = async {
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
                    processes: processes.clone(),
                    sandbox_execution_ends,
                    egress_environment: egress
                        .as_ref()
                        .map(|egress| egress.environment.clone())
                        .unwrap_or_default(),
                },
                (
                    authority.client(),
                    authority.lease(&attempt),
                    inputs.clone(),
                    coordination.clone(),
                    storage.clone(),
                ),
                token,
                valid_until,
                shutdown,
            )
            .await;
            // A sandbox still being prepared, or replaced, when the Harness ends is no longer needed.
            sandbox_cancel.cancel();
            outcome
        };
        let background_sandbox = async {
            let (Some(ready), Some(prepared), Some(sandbox_task)) =
                (sandbox_ready, workspace.as_ref(), sandbox_task.as_ref())
            else {
                return None;
            };
            let result = remote::prepare(
                options,
                journal,
                workspaces,
                (&attempt, prepared, sandbox_task),
                (
                    None,
                    sandbox_environment.flatten(),
                    mounted.as_ref(),
                    deferred_inputs.take(),
                ),
                (registration, (coordination, storage), token),
                (egress.as_ref(), &sandbox_cancel),
            )
            .await;
            // Whether it failed while the Harness still ran, rather than being stopped after.
            let while_running = !sandbox_cancel.is_cancelled();
            if let Ok((_, _, _, restart)) = &result {
                report_milestone(
                    &authority.client(),
                    &attempt.inspect(),
                    token,
                    WORKSPACE_READY,
                );
                restart_ready.send_replace(Some(restart.clone()));
            }
            let _ = ready.send(Some(match &result {
                Ok((provider, _, _, _)) => Ok(provider.workspace_connection()),
                Err(_) => Err("Remote Workspace could not be prepared".to_owned()),
            }));
            Some((result, while_running))
        };
        // Replaces a sandbox its provider found gone, from the Attempt's starting files, while the
        // Harness runs. Returns the replacements, the last of which is the Attempt's sandbox now.
        let replacer = async {
            let mut replacements = Vec::new();
            loop {
                let reply = tokio::select! {
                    request = replace_inbox.recv() => match request {
                        Some(reply) => reply,
                        None => break,
                    },
                    () = sandbox_cancel.cancelled() => break,
                };
                let Some(mut restart) = restart_watch.borrow().clone() else {
                    let _ = reply.send(Err("the sandbox is not prepared yet"));
                    continue;
                };
                let Some(prepared) = workspace.as_ref() else {
                    let _ = reply.send(Err("the Attempt has no Workspace"));
                    continue;
                };
                match remote::replace(
                    options,
                    journal,
                    workspaces,
                    (&attempt, prepared),
                    (mounted.as_ref(), registration),
                    &mut restart,
                    &sandbox_cancel,
                )
                .await
                {
                    Ok(replacement) => {
                        supertag_protocol::terminal_text::warn(&format!(
                            "Task {} Attempt {}: its remote sandbox was lost and replaced from the turn's starting files",
                            attempt.task_id, attempt.attempt_id
                        ));
                        let _ = reply.send(Ok(replacement.workspace_connection()));
                        replacements.push(replacement);
                    }
                    Err(error) => {
                        failures::note("A lost remote sandbox could not be replaced", &error);
                        let _ = reply.send(Err(if restart.replaced >= remote::MAX_REPLACEMENTS {
                            "this turn already replaced its sandbox twice"
                        } else {
                            "a new sandbox could not be prepared"
                        }));
                    }
                }
                restart_ready.send_replace(Some(restart));
            }
            replacements
        };
        let (outcome, sandbox, mut replacements) = tokio::join!(run, background_sandbox, replacer);
        // A turn that succeeded and waits for no approval shows its reply now; capture, delivery and
        // the checkpoint follow. A sandbox that failed while the harness ran fails the turn instead.
        let reply = outcome
            .as_ref()
            .ok()
            .filter(|outcome| {
                outcome.succeeded
                    && outcome.waiting_approval_ids.is_empty()
                    && !matches!(&sandbox, Some((Err(_), true)))
            })
            .map(|outcome| {
                (
                    outcome.result.clone(),
                    outcome.quiet,
                    outcome.objective_signal,
                )
            });
        report_harness_finished(&authority.client(), &attempt.inspect(), token, reply);
        let outcome = match sandbox {
            None => outcome,
            Some((Ok((prepared, _, _, _)), _)) => {
                provider = Some(prepared);
                outcome
            }
            Some((Err(error), while_running)) => {
                failures::note("Remote Workspace could not be prepared", &error);
                authority
                    .keep_for_cleanup(
                        &attempt,
                        remote::ensure_stopped(options, journal, &attempt, registration),
                    )
                    .await?;
                // A sandbox that failed while the Harness ran fails the turn, as one that failed
                // before launch did; one stopped because the Harness ended first changes nothing.
                if while_running {
                    outcome.map(|_| adapter::failed("Remote Workspace could not be prepared"))
                } else {
                    outcome
                }
            }
        }
        // The adapter run's errors carry its cleanup marker and the Attempt's values to redact.
        .with_context(|| {
            format!(
                "Task {} Attempt {} needs recovery",
                attempt.task_id, attempt.attempt_id
            )
        });
        // The last replacement is the Attempt's sandbox now: capture and cleanup use it. The lost
        // sandboxes were stopped and their records retired; their provider processes only end here.
        if let Some(latest) = replacements.pop() {
            for mut lost in replacements.into_iter().chain(provider.replace(latest)) {
                let _ = lost.shutdown().await;
            }
        }
        stop_reports.cancel();
        if let Some(reports) = reports {
            let _ = reports.await;
        }
        if let Some(egress) = egress {
            egress
                .finish(&mut authority.client(), &attempt, token)
                .await;
        }
        if let Some(mcp) = mcp {
            mcp.close().await;
        }
        if let Some(prepared) = workspace.as_ref().filter(|_| workspace_mcp.is_some()) {
            workspaces.remove_mcp_snapshot(prepared);
        }
        let saved = async {
            let mut outcome = outcome?;
            let remote_tree =
                if let Some(provider) = provider.as_ref().filter(|_| outcome.succeeded) {
                    let cancel = shutdown.child_token();
                    let workspace = workspace.as_ref().expect("remote Workspace prepared");
                    let captured = authority
                        .keep(
                            &attempt,
                            &cancel,
                            remote::capture(
                                provider,
                                journal,
                                (workspace, workspaces, has_inputs),
                                outputs.take(),
                                (
                                    options.state_directory,
                                    mounted
                                        .as_ref()
                                        .map(|mounted| (mounted, options.workspace_mounts)),
                                ),
                                (transfers, &attempt, token),
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
                                remote::COPY_CAPTURE_FAILED => remote::COPY_CAPTURE_FAILED,
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
                journal.finalizing(
                    &attempt,
                    outcome,
                    journal::Captured {
                        workspace,
                        remote_tree,
                        outputs,
                        file_scope,
                    },
                )
            } else {
                authority.record_finish(attempt.clone(), outcome)
            }
        }
        .await;
        if uses_shared_access {
            authority
                .keep_for_cleanup(
                    &attempt,
                    shared_execution::ensure_released(options, journal, &attempt, registration),
                )
                .await?;
        }
        if let Some(provider) = provider.as_mut() {
            authority
                .keep_for_cleanup(&attempt, async {
                    let closed = provider.shutdown().await;
                    remote::ensure_stopped(options, journal, &attempt, registration).await?;
                    closed
                })
                .await?;
        }
        saved
    }
}

/// A Task's prompt followed by the messages joined into its Attempt, oldest first.
pub(crate) fn joined_prompt(prompt: &str, joined: &[journal::JoinedMessage]) -> String {
    if joined.is_empty() {
        return prompt.to_owned();
    }
    let mut text = format!("{prompt}\n\nMore messages sent before you started (oldest first):");
    for message in joined {
        let minutes = message.sent_at_ms.max(0) / 60_000 % (24 * 60);
        text.push_str(&format!(
            "\n[{:02}:{:02} UTC] {}",
            minutes / 60,
            minutes % 60,
            message.text
        ));
    }
    text.push_str("\nAnswer them together.");
    text
}

#[cfg(test)]
mod joined_prompt_tests {
    use super::*;

    #[test]
    fn joined_messages_follow_the_prompt_oldest_first() {
        assert_eq!(joined_prompt("Check CI", &[]), "Check CI");
        let joined = [
            journal::JoinedMessage {
                task_id: "a".into(),
                text: "also the flaky test".into(),
                sent_at_ms: 1_794_470_160_000,
            },
            journal::JoinedMessage {
                task_id: "b".into(),
                text: "and open a PR".into(),
                sent_at_ms: 1_794_470_220_000,
            },
        ];
        assert_eq!(
            joined_prompt("Check CI", &joined),
            "Check CI\n\nMore messages sent before you started (oldest first):\n[07:56 UTC] also the flaky test\n[07:57 UTC] and open a PR\nAnswer them together."
        );
    }
}
