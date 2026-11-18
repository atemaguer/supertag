//! Native Codex execution through the supervising Worker Host's private Harness API.
mod app_server;
mod artifact;
mod auth;
mod checkpoint;
mod config;
mod coordination;
mod events;
pub mod launcher;
mod memory;
mod native_memory;
mod notifications;
mod pricing;
mod questions;
mod recap;
mod remote;
mod schedules;
mod skills;
mod tag_sessions;

use std::{
    collections::BTreeMap,
    ffi::{OsStr, OsString},
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use anyhow::{Context, Result, ensure};
use supertag_protocol::{
    MAX_CHECKPOINT_BYTES, MAX_MESSAGE_BYTES, authenticated_request,
    v2::{
        AdapterBootstrap, AppliedExecutionLimits, ExecutionLimitEnforcement, ExecutionLimits,
        HarnessAttachRequest, HarnessCompleteRequest, HarnessPublishRequest, ObjectiveSignal,
        SessionCheckpoint, Task, TaskEventKind, harness_client::HarnessClient,
    },
};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt},
    process::Command,
    time,
};
use tonic::{
    Request,
    transport::{Channel, Endpoint},
};

pub struct CodexOptions {
    pub executable: PathBuf,
    pub workspace: PathBuf,
    /// Private per-Attempt scratch owned and removed by the supervising guardian.
    pub state_directory: PathBuf,
    pub model: Option<String>,
    pub timeout: Duration,
    /// Set only for an isolated Task checkout or explicitly disposable workspace.
    pub allow_workspace_write: bool,
    /// The entry point supplies its environment; only explicit launch/auth keys are selected.
    pub environment: BTreeMap<OsString, OsString>,
}

/// The oldest Codex CLI whose app server this adapter speaks.
pub const MINIMUM_CODEX_VERSION: &str = "0.163.0";

/// Bounds one native app-server exchange and local process steps.
const RPC_TIMEOUT: Duration = Duration::from_secs(5);
/// Bounds the app server's first answer, which includes starting the Codex process.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);
/// Bounds one call to the supervising Worker Host. The host repeats an
/// idempotent upstream call across a Gateway partition until its execution
/// authority (a 30-second lease) ends, so the adapter waits longer than that
/// lease for the host's answer instead of failing the Task on its own timer.
const HOST_CALL_TIMEOUT: Duration = Duration::from_secs(65);
const MAX_LINE: usize = 4 * 1024 * 1024;
const MAX_STREAM: usize = 64 * 1024 * 1024;
const MAX_EVENT: usize = 16_384;
const MAX_RESULT: usize = 262_144;

/// Execute exactly one attached Task. Failure results contain controlled messages,
/// never native stderr, provider error bodies, or authentication material.
pub async fn run(options: CodexOptions, bootstrap: AdapterBootstrap) -> Result<()> {
    let endpoint = Endpoint::from_shared(bootstrap.endpoint).context("invalid Harness endpoint")?;
    let host = endpoint
        .uri()
        .host()
        .context("Harness endpoint has no host")?;
    ensure!(
        endpoint.uri().scheme_str() == Some("http")
            && host
                .trim_matches(['[', ']'])
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback()),
        "Harness endpoint must be loopback HTTP"
    );
    let artifact_channel = endpoint.clone().connect_timeout(RPC_TIMEOUT).connect_lazy();
    let channel = endpoint
        .connect_timeout(RPC_TIMEOUT)
        .connect()
        .await
        .context("connect to supervising Worker Host")?;
    let mut harness = HarnessClient::new(channel.clone())
        .max_decoding_message_size(MAX_CHECKPOINT_BYTES + MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_CHECKPOINT_BYTES + MAX_MESSAGE_BYTES);
    let attached = harness
        .attach(request(HarnessAttachRequest {}, &bootstrap.token)?)
        .await
        .context("attach Codex adapter")?
        .into_inner();
    let task = attached.task.context("Worker Host returned no Task")?;
    let capabilities =
        attached
            .coordination
            .unwrap_or_else(|| supertag_protocol::v2::AttemptCapabilities {
                may_ask_objective_question: attached.may_ask_objective_question,
                ..Default::default()
            });
    // A fresh thread's tools for this turn. A checkpointed thread that registered others is
    // not resumed (see `checkpoint::resumes`), so a Session gains new tools on its next turn.
    let inventory = if capabilities.may_ask_work_session_question {
        coordination::Inventory::ChildQuestions
    } else if capabilities.may_continue_work_session {
        coordination::Inventory::WorkSessionLifecycleReview
    } else if capabilities.may_start_work_session {
        coordination::Inventory::WorkSessionsReview
    } else if capabilities.may_use_workstream
        || capabilities.may_read_mailbox
        || capabilities.may_send_tag_message
        || capabilities.may_request_commit_review
    {
        coordination::Inventory::DirectReview
    } else if capabilities.may_ask_objective_question {
        coordination::Inventory::Ask
    } else {
        coordination::Inventory::None
    };
    let tools = questions::Tools {
        coordination: inventory,
        capture_artifact: attached.may_capture_artifacts,
        acquire_artifacts: attached.may_acquire_artifacts,
        attach_artifacts: attached.may_materialize_artifacts,
        tag_sessions: tag_sessions::Reads::new(&capabilities),
        schedule: capabilities.may_schedule,
        close_sessions: capabilities.may_start_work_session,
        memory: capabilities.may_remember,
        quiet: capabilities.may_stay_quiet,
        report_objective: questions::Reporting::new(&capabilities),
    };
    let reread = tools.tag_sessions.offered();
    let mut questions = questions::Bridge::new(
        (channel, artifact_channel),
        &bootstrap.token,
        &task,
        &attached.attempt_id,
        capabilities,
        tools,
        tools,
    );
    let outcome = execute(
        &options,
        (&task, &attached.resolved_skills),
        (attached.checkpoint.as_ref(), &attached.history, reread),
        &attached.attempt_id,
        &mut harness,
        &mut questions,
        &bootstrap.token,
    )
    .await;
    let (result, succeeded, checkpoint) = match outcome {
        Ok((result, checkpoint)) => (result, true, checkpoint),
        Err(error) => (error.to_string(), false, None),
    };
    // A reported Objective status applies only to a turn that succeeded without
    // asking a question or waiting for approvals; its summary is the result.
    let (result, objective_signal) = match questions.objective_report() {
        Some(report) if succeeded => (report.summary, report.signal as i32),
        _ => (result, ObjectiveSignal::Progress as i32),
    };
    // A quiet turn's note is its result: nothing is posted, and the note says why better than
    // whatever text Codex wrote first.
    let quiet = questions.quiet_note().filter(|_| succeeded);
    let result = quiet.clone().unwrap_or(result);
    harness
        .complete(request(
            HarnessCompleteRequest {
                result,
                succeeded,
                objective_signal,
                quiet: quiet.is_some(),
                checkpoint,
                waiting_approval_ids: if succeeded {
                    questions.waiting_approvals()
                } else {
                    vec![]
                },
            },
            &bootstrap.token,
        )?)
        .await
        .context("record Codex execution outcome")?;
    Ok(())
}

fn request<T>(message: T, token: &str) -> Result<Request<T>> {
    let mut request = authenticated_request(message, token, None)?;
    request.set_timeout(HOST_CALL_TIMEOUT);
    Ok(request)
}

/// A call whose outcome is unknown because the Worker Host could not reach
/// its Gateway in time, rather than a refusal.
fn transient(status: &tonic::Status) -> bool {
    matches!(
        status.code(),
        tonic::Code::Unavailable | tonic::Code::DeadlineExceeded | tonic::Code::Cancelled
    )
}

async fn execute(
    options: &CodexOptions,
    task_and_skills: (&Task, &[supertag_protocol::v2::ResolvedSkill]),
    (previous_checkpoint, history, reread): (
        Option<&SessionCheckpoint>,
        &[supertag_protocol::v2::AttemptHistoryEntry],
        bool,
    ),
    attempt_id: &str,
    harness: &mut HarnessClient<Channel>,
    questions: &mut questions::Bridge,
    token: &str,
) -> Result<(String, Option<SessionCheckpoint>)> {
    let (task, resolved_skills) = task_and_skills;
    let applied_limits = execution_limits(task.execution_limits.as_ref())?;
    let max_reported_tokens = applied_limits
        .as_ref()
        .and_then(|applied| applied.limits.as_ref())
        .and_then(|limits| limits.max_reported_tokens);
    ensure!(
        resolved_skills.is_empty()
            || !task
                .allowed_actions
                .iter()
                .any(|action| matches!(action.as_str(), "files:write" | "commands:execute")),
        "Codex Skill delivery currently requires read-only file access without command execution"
    );
    ensure!(
        !options.timeout.is_zero(),
        "Codex execution timeout must be positive"
    );
    let local_workspace = options
        .workspace
        .canonicalize()
        .context("Codex workspace is unavailable")?;
    ensure!(
        local_workspace.is_dir(),
        "Codex workspace must be a directory"
    );
    // On a remote Workspace, Codex works in the sandbox's checkout through the Worker Host's
    // executor socket; this host's directory only holds the process.
    let exec_socket = remote::socket(&options.environment)?;
    let workspace = match &exec_socket {
        Some(socket) => remote::checkout(socket, options.timeout).await?,
        None => local_workspace.clone(),
    };
    let model = match &task.attempt_execution {
        Some(attempt) => attempt
            .selection
            .as_ref()
            .and_then(|selection| selection.model.as_deref()),
        None => task
            .policy_snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.execution.as_ref())
            .and_then(|execution| execution.models.first())
            .map(String::as_str)
            .or(options.model.as_deref()),
    };
    let mut policy =
        config::Policy::from_actions(&task.allowed_actions, options.allow_workspace_write)?;
    policy.remote = exec_socket.is_some();
    policy.writable_roots = task
        .workspace
        .iter()
        .flat_map(|workspace| &workspace.mounts)
        .filter(|mount| mount.read_write)
        .map(|mount| PathBuf::from(&mount.destination))
        .collect();
    let output_directory = options
        .environment
        .get(&OsString::from("SUPERTAG_OUTPUT_DIR"))
        .map(|path| PathBuf::from(path).canonicalize())
        .transpose()?;
    if let Some(files) = supertag_protocol::file_scope::of_task(task) {
        ensure!(
            supertag_protocol::file_scope::harness_reason(
                task,
                supertag_protocol::v2::HarnessKind::Codex
            )
            .is_none(),
            "Codex cannot apply this Task's path scope; see supertag placement explain"
        );
        let home = config::user_home()?;
        let reserved = [workspace.as_path(), options.state_directory.as_path()];
        let resolve = |entries: &[String]| {
            supertag_protocol::file_scope::resolve_outside(entries, &home, &reserved)
                .map_err(anyhow::Error::msg)
        };
        policy.scope = Some(config::Scope {
            files: files.clone(),
            outside_write: resolve(&files.outside_write)?,
            outside_read: resolve(&files.outside_read)?,
            output_directory: output_directory.clone(),
        });
    }
    // A remote sandbox's commands reach the network only through its relay, set up by the
    // provider; Codex here takes no part.
    if let Some(scope) = supertag_protocol::network_scope::of_task(task).filter(|_| !policy.remote)
    {
        policy.egress = Some(egress(&options.environment, scope)?);
    }
    let effort = task
        .attempt_execution
        .as_ref()
        .and_then(|attempt| attempt.selection.as_ref())
        .and_then(|selection| selection.effort.as_deref());
    let native_memory = native_memory::directory(&options.environment)?;
    policy.memory = native_memory.is_some();
    let authentication = auth::Prepared::new(&options.environment, &options.state_directory)?;
    // The Tag's daily review consolidates the notes its turns kept into the summary Codex loads
    // into every later turn.
    if policy.memory
        && task
            .session_id
            .starts_with(supertag_protocol::MEMORY_REVIEW_SESSION_PREFIX)
    {
        policy.consolidate = Some(authentication.home().to_path_buf());
    }
    let arguments = config::arguments(&workspace, model, effort, &policy)?;
    let thread_parameters = config::thread_parameters(&workspace, &policy, &arguments)?;
    let skills = skills::prepare(task, resolved_skills, authentication.home())?;
    if let Some(directory) = &native_memory {
        native_memory::copy_in(directory, authentication.home())?;
    }
    if let Some(socket) = &exec_socket {
        remote::write_environments(
            authentication.home(),
            &std::env::current_exe().context("the SuperTag executable is unavailable")?,
            socket,
        )?;
    }
    let previous_checkpoint = previous_checkpoint.filter(|checkpoint| {
        checkpoint::resumes(checkpoint, &questions.manifest(), &skills.manifest)
    });
    let mut environment = authentication.environment(&options.environment);
    if let Some(path) = output_directory {
        let relative = path
            .strip_prefix(&workspace)?
            .to_str()
            .context("invalid Task output path")?;
        let expected = if let Some(policy) = &task.output_policy {
            policy.directory.as_deref().unwrap_or("outputs").to_owned()
        } else {
            supertag_protocol::artifacts::managed_output_directory(
                task.attempt_id
                    .as_deref()
                    .context("Task output directory requires an Attempt")?,
            )
        };
        ensure!(
            relative == expected,
            "Task output directory is outside this Attempt"
        );
        environment.insert("SUPERTAG_OUTPUT_DIR".into(), path.into_os_string());
    }
    // Under a narrowed network scope, Codex's managed proxy forwards to the Attempt's egress
    // proxy, which it reads from these; Codex's own traffic stays direct.
    if let Some(egress) = &policy.egress {
        for (name, value) in egress.process_environment() {
            environment.insert(name.into(), value.into());
        }
    }
    // Secrets belonging to the transport are never forwarded to the native process.
    environment.remove(&OsString::from("SUPERTAG_HOST_TOKEN"));
    let mut secrets = authentication.secrets();
    secrets.push(token.to_owned());
    questions.set_secrets(&secrets);
    let expected_thread = previous_checkpoint
        .map(|checkpoint| {
            checkpoint::restore(
                checkpoint,
                task,
                &questions.manifest(),
                authentication.home(),
                &workspace,
                &secrets,
            )
        })
        .transpose()?;
    let baseline = match previous_checkpoint {
        Some(checkpoint) => checkpoint::usage_baseline(checkpoint)?,
        None => Some(([0, 0, 0], Some(0))),
    };
    // A fresh thread starts from the Session's recap; a resumed one already holds it.
    let recap = if previous_checkpoint.is_none() {
        recap::render(history, &task.session_id, &secrets, reread)
    } else {
        String::new()
    };
    // The native binary behind the npm launcher, so no Node process starts with every Codex.
    let executable = launcher::resolve(
        &options.executable,
        environment.get(OsStr::new("PATH")).map(OsString::as_os_str),
    )
    .map_or_else(|| options.executable.clone(), |found| found.path);
    verify_version(&executable, &environment).await?;
    if let Some(applied) = applied_limits {
        harness
            .confirm_execution_limits(request(applied, token)?)
            .await
            .context("could not confirm Codex execution limits")?;
    }

    let mut command = Command::new(&executable);
    command
        .args(arguments)
        .current_dir(&local_workspace)
        .env_clear()
        .envs(environment)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        // Codex's own diagnostics reach the Worker Host log through the guardian, redacted.
        .stderr(Stdio::inherit())
        .kill_on_drop(true);
    // Do not create a new process group: the owning guardian must retain authority
    // over Codex and every tool process that Codex launches.
    let mut child = command
        .spawn()
        .context("Codex executable could not start")?;
    let outcome = time::timeout(options.timeout, async {
        let input = child
            .stdin
            .take()
            .context("Codex request pipe is unavailable")?;
        let output = child
            .stdout
            .take()
            .context("Codex event pipe is unavailable")?;
        let (result, thread) = app_server::execute(
            input,
            output,
            task,
            attempt_id,
            thread_parameters,
            policy,
            &skills.paths,
            expected_thread,
            &recap,
            baseline,
            max_reported_tokens,
            harness,
            questions,
            token,
            &secrets,
        )
        .await?;
        let status = child.wait().await.context("could not reap Codex process")?;
        ensure!(status.success(), "Codex process exited unsuccessfully");
        let result = auth::redact(result, &secrets);
        ensure!(
            result.len() <= MAX_RESULT,
            "Codex final response exceeds its limit"
        );
        // A thread too big to keep leaves no checkpoint: the turn succeeds, and the next one
        // starts fresh from the recap.
        let checkpoint = match checkpoint::capture(
            task,
            &questions.manifest(),
            authentication.home(),
            &workspace,
            thread,
            &secrets,
        )
        .and_then(|checkpoint| checkpoint::bind_context(checkpoint, &skills.manifest))
        {
            Ok(checkpoint) => Some(checkpoint),
            Err(error) if error.is::<checkpoint::TooBig>() => None,
            Err(error) => return Err(error.context("could not preserve Codex Session continuity")),
        };
        Ok::<_, anyhow::Error>((result, checkpoint))
    })
    .await;
    // On malformed streams, timeouts, or RPC failure, stop and reap the actual
    // native child before reporting a terminal outcome to the Worker Host.
    if child
        .try_wait()
        .context("could not inspect Codex process")?
        .is_none()
    {
        child.kill().await.context("could not stop Codex process")?;
    }
    child.wait().await.context("could not reap Codex process")?;
    // Whatever the outcome, the Worker Host decides what of the turn's memory to keep.
    if let Some(directory) = &native_memory {
        native_memory::copy_out(authentication.home(), directory)?;
    }
    outcome.context("Codex execution timed out")?
}

fn execution_limits(limits: Option<&ExecutionLimits>) -> Result<Option<AppliedExecutionLimits>> {
    let Some(limits) = limits else {
        return Ok(None);
    };
    ensure!(
        limits.max_reported_cost.is_none(),
        "Codex does not support a reported cost limit"
    );
    ensure!(
        limits.max_native_agents.is_none_or(|limit| limit == 0),
        "Codex native subagents are disabled"
    );
    ensure!(
        limits.max_reported_tokens != Some(0),
        "Codex reported token limit must be positive"
    );
    if limits.max_reported_tokens.is_none() && limits.max_native_agents.is_none() {
        return Ok(None);
    }
    let mut effective = limits.clone();
    effective.max_reported_tokens = effective
        .max_reported_tokens
        .map(|limit| limit.min(1_000_000));
    Ok(Some(AppliedExecutionLimits {
        limits: Some(effective),
        native_agents: limits
            .max_native_agents
            .map_or(0, |_| ExecutionLimitEnforcement::HarnessGuard as i32),
        reported_tokens: limits
            .max_reported_tokens
            .map_or(0, |_| ExecutionLimitEnforcement::InterruptOnReport as i32),
        reported_cost: 0,
    }))
}

async fn publish(
    harness: &mut HarnessClient<Channel>,
    token: &str,
    sequence: &mut u64,
    kind: TaskEventKind,
    mut text: &str,
) -> Result<()> {
    while !text.is_empty() {
        let mut end = text.len().min(MAX_EVENT);
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        *sequence += 1;
        harness
            .publish(request(
                HarnessPublishRequest {
                    sequence: *sequence,
                    text: text[..end].into(),
                    kind: kind as i32,
                },
                token,
            )?)
            .await
            .context("could not record Codex event")?;
        text = &text[end..];
    }
    Ok(())
}

async fn read_line(reader: &mut (impl AsyncBufRead + Unpin)) -> Result<Option<Vec<u8>>> {
    let mut line = Vec::new();
    loop {
        let available = reader
            .fill_buf()
            .await
            .context("could not read Codex event stream")?;
        if available.is_empty() {
            return Ok((!line.is_empty()).then_some(line));
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let count = newline.map_or(available.len(), |index| index + 1);
        ensure!(
            line.len() + count <= MAX_LINE,
            "Codex JSON event exceeds its limit"
        );
        line.extend_from_slice(&available[..count]);
        reader.consume(count);
        if newline.is_some() {
            return Ok(Some(line));
        }
    }
}

async fn verify_version(
    executable: &Path,
    environment: &BTreeMap<OsString, OsString>,
) -> Result<()> {
    let mut command = Command::new(executable);
    command
        .arg("--version")
        .env_clear()
        .envs(environment)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = command.spawn().context("Codex executable is unavailable")?;
    // A cold start of the Codex process, not one exchange: it gets the startup bound.
    let outcome = time::timeout(STARTUP_TIMEOUT, async {
        let mut output = Vec::new();
        child
            .stdout
            .take()
            .context("Codex version pipe is unavailable")?
            .take(1025)
            .read_to_end(&mut output)
            .await
            .context("could not read Codex version")?;
        ensure!(output.len() <= 1024, "invalid Codex version response");
        let status = child
            .wait()
            .await
            .context("could not reap Codex version probe")?;
        ensure!(status.success(), "Codex version probe failed");
        let version = std::str::from_utf8(&output)
            .ok()
            .and_then(|line| line.trim().strip_prefix("codex-cli "))
            .context("invalid Codex version response")?;
        let parts = version
            .split('.')
            .map(str::parse::<u64>)
            .collect::<std::result::Result<Vec<_>, _>>()
            .ok()
            .filter(|parts| parts.len() == 3)
            .context("unsupported Codex version format")?;
        let minimum = MINIMUM_CODEX_VERSION
            .split('.')
            .map(str::parse::<u64>)
            .collect::<std::result::Result<Vec<_>, _>>()?;
        ensure!(
            parts >= minimum,
            "Codex CLI {MINIMUM_CODEX_VERSION} or later is required"
        );
        Ok::<_, anyhow::Error>(())
    })
    .await;
    if child
        .try_wait()
        .context("could not inspect Codex version probe")?
        .is_none()
    {
        child
            .kill()
            .await
            .context("could not stop Codex version probe")?;
    }
    child
        .wait()
        .await
        .context("could not reap Codex version probe")?;
    outcome.context("Codex version probe timed out")?
}

/// The Worker Host's egress proxy for a Task with a network scope. Without it Codex cannot keep
/// the Task to its scope, so the Attempt fails before Codex starts.
fn egress(
    environment: &BTreeMap<OsString, OsString>,
    scope: &supertag_protocol::v2::NetworkScope,
) -> Result<config::Egress> {
    let variable = |name: &str| {
        environment
            .get(OsStr::new(name))
            .and_then(|value| value.to_str())
            .map(str::to_owned)
            .with_context(|| {
                format!("Codex cannot apply this Task's network scope without the Worker Host's egress proxy ({name} is missing)")
            })
    };
    let placeholders: BTreeMap<String, String> =
        serde_json::from_str(&variable("SUPERTAG_EGRESS_PLACEHOLDERS")?)
            .context("invalid egress placeholders")?;
    Ok(config::Egress {
        proxy: variable("SUPERTAG_EGRESS_PROXY")?,
        ca_certificate: PathBuf::from(variable("SUPERTAG_EGRESS_CA_CERTIFICATE")?),
        ca_bundle: PathBuf::from(variable("SUPERTAG_EGRESS_CA_BUNDLE")?),
        placeholders,
        hosts: if supertag_protocol::network_scope::narrows(scope) {
            supertag_protocol::network_scope::host_names(scope)
        } else {
            Default::default()
        },
        narrowed: supertag_protocol::network_scope::narrows(scope),
    })
}
