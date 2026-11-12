//! Native Codex execution through the supervising Worker Host's private Harness API.
mod app_server;
mod auth;
mod checkpoint;
mod config;
mod events;

use std::{collections::BTreeMap, ffi::OsString, path::PathBuf, process::Stdio, time::Duration};

use anyhow::{Context, Result, ensure};
use supertag_protocol::{
    MAX_CHECKPOINT_BYTES, MAX_MESSAGE_BYTES, authenticated_request,
    v2::{
        AdapterBootstrap, HarnessAttachRequest, HarnessCompleteRequest, HarnessPublishRequest,
        SessionCheckpoint, Task, harness_client::HarnessClient,
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
    let mut harness = HarnessClient::new(channel)
        .max_decoding_message_size(MAX_CHECKPOINT_BYTES + MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_CHECKPOINT_BYTES + MAX_MESSAGE_BYTES);
    let attached = harness
        .attach(request(HarnessAttachRequest {}, &bootstrap.token)?)
        .await
        .context("attach Codex adapter")?
        .into_inner();
    let task = attached.task.context("Worker Host returned no Task")?;
    let outcome = execute(
        &options,
        &task,
        attached.checkpoint.as_ref(),
        &attached.attempt_id,
        &mut harness,
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
    task: &Task,
    previous_checkpoint: Option<&SessionCheckpoint>,
    attempt_id: &str,
    harness: &mut HarnessClient<Channel>,
    token: &str,
) -> Result<(String, SessionCheckpoint)> {
    ensure!(
        !options.timeout.is_zero(),
        "Codex execution timeout must be positive"
    );
    let workspace = options
        .workspace
        .canonicalize()
        .context("Codex workspace is unavailable")?;
    ensure!(workspace.is_dir(), "Codex workspace must be a directory");
    let policy =
        config::Policy::from_actions(&task.allowed_actions, options.allow_workspace_write)?;
    let arguments = config::arguments(&workspace, options.model.as_deref(), &policy)?;
    let thread_parameters = config::thread_parameters(&workspace, &arguments)?;
    let authentication = auth::Prepared::new(&options.environment, &options.state_directory)?;
    let mut environment = authentication.environment(&options.environment);
    // Secrets belonging to the transport are never forwarded to the native process.
    environment.remove(&OsString::from("SUPERTAG_HOST_TOKEN"));
    let mut secrets = authentication.secrets();
    secrets.push(token.to_owned());
    let expected_thread = previous_checkpoint
        .map(|checkpoint| {
            checkpoint::restore(
                checkpoint,
                task,
                authentication.home(),
                &workspace,
                &secrets,
            )
        })
        .transpose()?;
    let baseline = match previous_checkpoint {
        Some(checkpoint) => checkpoint::usage_baseline(checkpoint)?,
        None => Some([0, 0, 0]),
    };
    verify_version(options, &environment).await?;

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
            expected_thread,
            baseline,
            harness,
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
        let checkpoint =
            checkpoint::capture(task, authentication.home(), &workspace, thread, &secrets)
                .context("could not preserve Codex Session continuity")?;
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
    outcome.context("Codex execution timed out")?
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
