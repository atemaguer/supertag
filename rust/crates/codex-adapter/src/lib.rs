//! Native Codex execution through the supervising Worker Host's private Harness API.
mod app_server;
mod auth;
mod checkpoint;
mod config;
mod coordination;
mod events;
mod pricing;
mod questions;
mod skills;

use std::{collections::BTreeMap, ffi::OsString, path::PathBuf, process::Stdio, time::Duration};

use anyhow::{Context, Result, ensure};
use supertag_protocol::{
    MAX_CHECKPOINT_BYTES, MAX_MESSAGE_BYTES, authenticated_request,
    v2::{
        AdapterBootstrap, AppliedExecutionLimits, ExecutionLimitEnforcement, ExecutionLimits,
        HarnessAttachRequest, HarnessCompleteRequest, HarnessPublishRequest, SessionCheckpoint,
        Task, harness_client::HarnessClient,
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

const RPC_TIMEOUT: Duration = Duration::from_secs(5);
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
    let channel = endpoint
        .connect_timeout(RPC_TIMEOUT)
        .timeout(RPC_TIMEOUT)
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
    let inventory = if let Some(previous) = &attached.checkpoint
        && let Some(inventory) = checkpoint::coordination_inventory(previous)
    {
        inventory
    } else if capabilities.may_ask_work_session_question && attached.checkpoint.is_none() {
        coordination::Inventory::ChildQuestions
    } else if capabilities.may_continue_work_session && attached.checkpoint.is_none() {
        coordination::Inventory::WorkSessionLifecycleReview
    } else if capabilities.may_start_work_session && attached.checkpoint.is_none() {
        coordination::Inventory::WorkSessionsReview
    } else if attached.checkpoint.is_none()
        && (capabilities.may_use_workstream
            || capabilities.may_read_mailbox
            || capabilities.may_send_tag_message
            || capabilities.may_request_commit_review)
    {
        coordination::Inventory::DirectReview
    } else if capabilities.may_ask_objective_question {
        coordination::Inventory::Ask
    } else {
        coordination::Inventory::None
    };
    let mut questions = questions::Bridge::new(
        channel,
        &bootstrap.token,
        &task,
        &attached.attempt_id,
        capabilities,
        inventory,
    );
    let outcome = execute(
        &options,
        (&task, &attached.resolved_skills),
        attached.checkpoint.as_ref(),
        &attached.attempt_id,
        &mut harness,
        &mut questions,
        &bootstrap.token,
    )
    .await;
    let (result, succeeded, checkpoint) = match outcome {
        Ok((result, checkpoint)) => (result, true, Some(checkpoint)),
        Err(error) => (error.to_string(), false, None),
    };
    harness
        .complete(request(
            HarnessCompleteRequest {
                result,
                succeeded,
                objective_signal: 0,
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
    request.set_timeout(RPC_TIMEOUT);
    Ok(request)
}

async fn execute(
    options: &CodexOptions,
    task_and_skills: (&Task, &[supertag_protocol::v2::ResolvedSkill]),
    previous_checkpoint: Option<&SessionCheckpoint>,
    attempt_id: &str,
    harness: &mut HarnessClient<Channel>,
    questions: &mut questions::Bridge,
    token: &str,
) -> Result<(String, SessionCheckpoint)> {
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
    let workspace = options
        .workspace
        .canonicalize()
        .context("Codex workspace is unavailable")?;
    ensure!(workspace.is_dir(), "Codex workspace must be a directory");
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
    let policy =
        config::Policy::from_actions(&task.allowed_actions, options.allow_workspace_write)?;
    let effort = task
        .attempt_execution
        .as_ref()
        .and_then(|attempt| attempt.selection.as_ref())
        .and_then(|selection| selection.effort.as_deref());
    let arguments = config::arguments(&workspace, model, effort, &policy)?;
    let thread_parameters = config::thread_parameters(&workspace, &arguments)?;
    let authentication = auth::Prepared::new(&options.environment, &options.state_directory)?;
    let skills = skills::prepare(task, resolved_skills, authentication.home())?;
    if let Some(checkpoint) = previous_checkpoint {
        checkpoint::check_context(checkpoint, &skills.manifest)?;
    }
    let mut environment = authentication.environment(&options.environment);
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
                questions.manifest(),
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
    verify_version(options, &environment).await?;
    if let Some(applied) = applied_limits {
        harness
            .confirm_execution_limits(request(applied, token)?)
            .await
            .context("could not confirm Codex execution limits")?;
    }

    let mut command = Command::new(&options.executable);
    command
        .args(arguments)
        .current_dir(&workspace)
        .env_clear()
        .envs(environment)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
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
        let checkpoint = checkpoint::capture(
            task,
            questions.manifest(),
            authentication.home(),
            &workspace,
            thread,
            &secrets,
        )
        .context("could not preserve Codex Session continuity")?;
        Ok::<_, anyhow::Error>((
            result,
            checkpoint::bind_context(checkpoint, &skills.manifest)?,
        ))
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
    options: &CodexOptions,
    environment: &BTreeMap<OsString, OsString>,
) -> Result<()> {
    let mut command = Command::new(&options.executable);
    command
        .arg("--version")
        .env_clear()
        .envs(environment)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = command.spawn().context("Codex executable is unavailable")?;
    let outcome = time::timeout(RPC_TIMEOUT, async {
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
        ensure!(
            parts.as_slice() >= [0, 163, 0].as_slice(),
            "Codex CLI 0.163.0 or later is required"
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
