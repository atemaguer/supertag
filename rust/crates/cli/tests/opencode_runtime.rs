//! Real Control Plane and Worker Host processes with a provider-shaped OpenCode CLI.
#[path = "../../../test-support/prerequisites.rs"]
mod prerequisites;
#[path = "support/protocol.rs"]
mod protocol;
#[macro_use]
#[path = "support/database.rs"]
mod database;

use anyhow::{Context, Result, anyhow, ensure};
use prost::Message;
use serde_json::Value;
use sqlx::Connection;
use std::{
    fs::File,
    io::{BufRead, BufReader},
    net::SocketAddr,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};
use supertag_protocol::negotiation::ProtocolChannel;
use supertag_protocol::{
    authenticated_request,
    v2::{
        AssignRoleRequest, CancelTaskRequest, ClaimTaskRequest, ExecutionLimits, GetTaskRequest,
        HarnessExecutionProfile, HarnessKind, ListEventsRequest, ListTagsRequest, ModelSource,
        PolicyExecutionSettings, PutRoleRequest, PutTagRequest, Role, SubmitTaskRequest, Task,
        TaskState, operator_client::OperatorClient, policy_catalog_client::PolicyCatalogClient,
    },
};
use tokio::time::sleep;
use tonic::{Request, transport::Channel};
use uuid::Uuid;

const BINARY: &str = env!("CARGO_BIN_EXE_supertag");
const WAIT: Duration = Duration::from_secs(25);
const FIXTURE_MODEL: &str = "openai/fixture-model";
const NATIVE: &str =
    include_str!("../../../../packages/runtime/harnesses/opencode/fixtures/native-opencode.mjs");

struct Process {
    child: Child,
    log: PathBuf,
}
impl Process {
    fn spawn(mut command: Command, directory: &Path, name: &str, service: bool) -> Result<Self> {
        let log = directory.join(format!("{name}-{}.log", Uuid::new_v4()));
        command.stderr(File::create(&log)?).stdout(if service {
            Stdio::piped()
        } else {
            Stdio::null()
        });
        Ok(Self {
            child: command.spawn()?,
            log,
        })
    }
    fn logs(&self) -> String {
        std::fs::read_to_string(&self.log).unwrap_or_default()
    }
    async fn endpoint(&mut self) -> Result<String> {
        let stdout = self.child.stdout.take().context("service stdout missing")?;
        let (send, receive) = mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let mut line = String::new();
            let result = BufReader::new(stdout).read_line(&mut line).map(|_| line);
            let _ = send.send(result);
        });
        let deadline = Instant::now() + WAIT;
        loop {
            match receive.try_recv() {
                Ok(line) => {
                    let address: SocketAddr = line?
                        .trim()
                        .parse()
                        .with_context(|| format!("service did not bind: {}", self.logs()))?;
                    ensure!(address.ip().is_loopback() && address.port() != 0);
                    return Ok(format!("http://{address}"));
                }
                Err(mpsc::TryRecvError::Disconnected) => {
                    return Err(anyhow!("service closed stdout: {}", self.logs()));
                }
                Err(mpsc::TryRecvError::Empty) => {}
            }
            ensure!(
                self.child.try_wait()?.is_none(),
                "service exited: {}",
                self.logs()
            );
            ensure!(
                Instant::now() < deadline,
                "service startup timed out: {}",
                self.logs()
            );
            sleep(Duration::from_millis(10)).await;
        }
    }
    async fn success(&mut self) -> Result<()> {
        let deadline = Instant::now() + WAIT;
        loop {
            if let Some(status) = self.child.try_wait()? {
                ensure!(
                    status.success(),
                    "worker exited with {status}: {}",
                    self.logs()
                );
                return Ok(());
            }
            ensure!(
                Instant::now() < deadline,
                "worker did not exit: {}",
                self.logs()
            );
            sleep(Duration::from_millis(10)).await;
        }
    }
}
impl Drop for Process {
    fn drop(&mut self) {
        if matches!(self.child.try_wait(), Ok(Some(_))) {
            return;
        }
        // All processes are test-owned. Let Host clean its guardian before forceful cleanup.
        unsafe {
            libc::kill(self.child.id() as i32, libc::SIGTERM);
        }
        let until = Instant::now() + Duration::from_secs(2);
        while Instant::now() < until {
            if matches!(self.child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
struct Credentials {
    gateway: String,
    operator: String,
    host: String,
}
impl Credentials {
    fn new() -> Self {
        Self {
            gateway: Uuid::new_v4().to_string(),
            operator: Uuid::new_v4().to_string(),
            host: Uuid::new_v4().to_string(),
        }
    }
    fn command(&self) -> Command {
        let mut command = Command::new(BINARY);
        command
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("SUPERTAG_GATEWAY_TOKEN", &self.gateway)
            .env("SUPERTAG_OPERATOR_TOKEN", &self.operator)
            .env("SUPERTAG_HOST_TOKEN", &self.host)
            .env("SUPERTAG_BOOTSTRAP_HOST_TOKEN", &self.host)
            .stdin(Stdio::null());
        command
    }
    fn request<T>(&self, value: T) -> Result<Request<T>> {
        let mut request = authenticated_request(value, &self.operator, None)?;
        request.set_timeout(Duration::from_secs(3));
        Ok(request)
    }
}
struct Runtime {
    // Drop the public service before its private dependency.
    _control: Process,
    operator: OperatorClient<ProtocolChannel>,
    endpoint: String,
    credentials: Credentials,
    database: String,
    node: PathBuf,
    entry: PathBuf,
    native: PathBuf,
    fixture: PathBuf,
}
impl Runtime {
    async fn start(directory: &Path, database: String) -> Result<Self> {
        sqlx::any::install_default_drivers();
        let credentials = Credentials::new();
        let output = Command::new("/usr/bin/which").arg("node").output()?;
        ensure!(
            output.status.success(),
            "Node is required for the OpenCode adapter fixture"
        );
        let node = std::fs::canonicalize(String::from_utf8(output.stdout)?.trim())?;
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .canonicalize()?;
        let entry = root.join("packages/runtime/harnesses/opencode/dist/rust-adapter/entry.js");
        ensure!(
            entry.is_file(),
            "build OpenCode first: pnpm --filter @supertag/worker-opencode build"
        );
        let fixture = directory.join("native-fixture");
        std::fs::create_dir(&fixture)?;
        let native = fixture.join("opencode.mjs");
        std::fs::write(&native, format!("#!{}\n{NATIVE}", node.display()))?;
        std::fs::set_permissions(&native, std::fs::Permissions::from_mode(0o700))?;
        let mut control = credentials.command();
        control
            .arg("control-plane")
            .env("SUPERTAG_DATABASE_URL", &database);
        let mut control = Process::spawn(control, directory, "control", true)?;
        let endpoint = control.endpoint().await?;
        let channel = protocol::negotiated(
            Channel::from_shared(endpoint.clone())?
                .connect_timeout(Duration::from_secs(3))
                .timeout(Duration::from_secs(3))
                .connect()
                .await?,
        )
        .await?;
        Ok(Self {
            _control: control,
            operator: OperatorClient::new(channel),
            endpoint,
            credentials,
            database,
            node,
            entry,
            native,
            fixture,
        })
    }
    async fn tag(&mut self, name: &str, harness: HarnessKind, actions: &[&str]) -> Result<()> {
        self.operator
            .put_tag(self.credentials.request(PutTagRequest {
                tag_id: name.into(),
                instructions: "Follow the fixture Task with the accepted permissions.".into(),
                harness_kind: harness as i32,
                allowed_actions: actions.iter().map(|s| (*s).into()).collect(),
                ..Default::default()
            })?)
            .await?;
        Ok(())
    }
    async fn submit(
        &mut self,
        tag: &str,
        session: &str,
        mode: &str,
        limits: Option<ExecutionLimits>,
    ) -> Result<Task> {
        Ok(self
            .operator
            .submit_task(self.credentials.request(SubmitTaskRequest {
                output_policy: None,
                tag_id: tag.into(),
                session_id: session.into(),
                operation_id: Uuid::new_v4().to_string(),
                prompt: format!("fixture:{mode}"),
                execution_limits: limits,
                input_artifacts: vec![],
            })?)
            .await?
            .into_inner())
    }
    fn host(&self, directory: &Path) -> Result<Process> {
        self.host_with_auth_file(directory, None)
    }
    fn host_with_auth_file(&self, directory: &Path, auth_file: Option<&Path>) -> Result<Process> {
        self.host_with_models(directory, auth_file, FIXTURE_MODEL, &[])
    }
    fn host_with_models(
        &self,
        directory: &Path,
        auth_file: Option<&Path>,
        default_model: &str,
        models: &[&str],
    ) -> Result<Process> {
        let home = directory.join("operator-home");
        std::fs::create_dir_all(&home)?;
        let mut host = self.credentials.command();
        host.args([
            "worker-host",
            "--control-plane",
            &self.endpoint,
            "--once",
            "--harness",
            "opencode",
            "--harness-model",
            default_model,
        ])
        .arg("--opencode-node")
        .arg(&self.node)
        .arg("--opencode-adapter")
        .arg(&self.entry)
        .arg("--opencode-path")
        .arg(&self.native)
        .arg("--state-directory")
        .arg(directory.join("host"))
        .env("HOME", &home)
        .env("ANTHROPIC_API_KEY", "unused-anthropic-key")
        .env("CODEX_API_KEY", "unused-codex-key")
        .env("CLAUDE_CODE_OAUTH_TOKEN", "unused-claude-token")
        .env("NODE_OPTIONS", "--synthetic-disallowed-option")
        .env("PYTHONPATH", "unused-python-path");
        for model in models {
            host.args(["--harness-models", model]);
        }
        if let Some(path) = auth_file {
            host.arg("--opencode-auth-file").arg(path);
        } else {
            host.env("OPENAI_API_KEY", "synthetic-opencode-provider-key");
        }
        Process::spawn(host, directory, "host", false)
    }
    async fn task(&mut self, id: &str) -> Result<Task> {
        Ok(self
            .operator
            .get_task(
                self.credentials
                    .request(GetTaskRequest { task_id: id.into() })?,
            )
            .await?
            .into_inner())
    }
    async fn wait_text(&mut self, id: &str, text: &str) -> Result<Task> {
        let until = Instant::now() + WAIT;
        loop {
            let current = self.task(id).await?;
            let events = self
                .operator
                .list_events(self.credentials.request(ListEventsRequest {
                    task_id: id.into(),
                    after_sequence: 0,
                    limit: 100,
                })?)
                .await?
                .into_inner()
                .events;
            if events.iter().any(|event| event.text.contains(text)) {
                return Ok(current);
            }
            ensure!(
                !matches!(current.state(), TaskState::Failed | TaskState::Cancelled),
                "Task failed before expected stream: {:?}; native fixture: {}",
                current.result,
                self.native_errors()
            );
            ensure!(
                Instant::now() < until,
                "missing streamed output; state={:?}, result={:?}",
                current.state(),
                current.result
            );
            sleep(Duration::from_millis(10)).await;
        }
    }
    fn native_errors(&self) -> String {
        std::fs::read_to_string(self.fixture.join("errors.log")).unwrap_or_default()
    }
    fn calls(&self) -> Result<Vec<Value>> {
        let text = std::fs::read_to_string(self.fixture.join("calls.jsonl")).unwrap_or_default();
        text.lines()
            .map(|line| Ok(serde_json::from_str(line)?))
            .collect()
    }
    async fn assert_no_checkpoint(&self) -> Result<()> {
        let mut connection = sqlx::AnyConnection::connect(&self.database).await?;
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM supertag_v2_session_checkpoints")
            .fetch_one(&mut connection)
            .await?;
        ensure!(
            count == 0,
            "OpenCode must not publish unsupported native Session checkpoints"
        );
        connection.close().await?;
        Ok(())
    }
}

database_tests! {
    #[tokio::test]
    opencode_stages_only_selected_provider_from_explicit_auth_file;
    #[tokio::test]
    opencode_streams_through_split_services_and_starts_fresh_turns;
    #[tokio::test]
    opencode_cancellation_reaps_native_process;
    #[tokio::test]
    opencode_bad_streams_fail_closed;
    #[tokio::test]
    opencode_recovers_missing_terminal_from_credential_free_local_export;
    #[tokio::test]
    opencode_leaves_unsupported_limits_and_unapproved_commands_queued;
    #[tokio::test]
    opencode_claims_and_runs_the_accepted_role_model;
    #[tokio::test]
    put_tag_cli_preserves_model_and_effort_order_at_admission;
    #[tokio::test]
    opencode_manager_coordination_uses_real_private_harness_with_child_denials;
}

async fn opencode_stages_only_selected_provider_from_explicit_auth_file(
    database: String,
) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let mut runtime = Runtime::start(directory.path(), database).await?;
    let auth_file = directory.path().join("operator-auth.json");
    let source = br#"{"openai":{"type":"api","key":"synthetic-opencode-provider-key"},"anthropic":{"type":"api","key":"unused-file-provider-key"}}"#;
    std::fs::write(&auth_file, source)?;
    std::fs::set_permissions(&auth_file, std::fs::Permissions::from_mode(0o600))?;
    runtime
        .tag("native", HarnessKind::Opencode, &["files:read"])
        .await?;
    let task = runtime.submit("native", "file-auth", "fresh", None).await?;
    let mut host = runtime.host_with_auth_file(directory.path(), Some(&auth_file))?;
    host.success().await?;
    let result = runtime.task(&task.task_id).await?;
    ensure!(
        result.state() == TaskState::Succeeded,
        "file auth failed: {:?}; fixture: {}",
        result.result,
        runtime.native_errors()
    );
    ensure!(
        !result
            .result
            .as_deref()
            .unwrap_or_default()
            .contains("synthetic-opencode-provider-key")
    );
    let calls = runtime.calls()?;
    ensure!(calls.len() == 1 && calls[0]["credentialSource"] == "file");
    ensure!(
        std::fs::read(&auth_file)? == source,
        "source credentials changed"
    );
    gone(calls[0]["pid"].as_i64().context("native PID missing")? as i32).await?;
    runtime.assert_no_checkpoint().await?;
    Ok(())
}
impl Drop for Runtime {
    fn drop(&mut self) {
        // Only kill an unreaped process if it still runs this test's exact fixture.
        if let Ok(calls) = self.calls() {
            for call in calls {
                if let Some(pid) = call["pid"].as_i64()
                    && unsafe { libc::kill(pid as i32, 0) } == 0
                    && let Ok(command) = Command::new("/bin/ps")
                        .args(["-p", &pid.to_string(), "-o", "command="])
                        .output()
                    && String::from_utf8_lossy(&command.stdout)
                        .contains(self.native.to_string_lossy().as_ref())
                {
                    unsafe {
                        libc::kill(pid as i32, libc::SIGKILL);
                    }
                }
            }
        }
    }
}
async fn gone(pid: i32) -> Result<()> {
    let until = Instant::now() + WAIT;
    while unsafe { libc::kill(pid, 0) } == 0 {
        ensure!(
            Instant::now() < until,
            "native OpenCode PID {pid} survived settlement"
        );
        sleep(Duration::from_millis(10)).await;
    }
    Ok(())
}

async fn opencode_streams_through_split_services_and_starts_fresh_turns(
    database: String,
) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let mut runtime = Runtime::start(directory.path(), database).await?;
    runtime
        .tag("wrong", HarnessKind::ClaudeCode, &["files:read"])
        .await?;
    runtime
        .tag("native", HarnessKind::Opencode, &["files:read"])
        .await?;
    let wrong = runtime.submit("wrong", "routing", "fresh", None).await?;
    let first = runtime
        .submit("native", "same-session", "stream", None)
        .await?;
    let mut host = runtime.host(directory.path())?;
    let running = runtime.wait_text(&first.task_id, "native-partial:").await?;
    ensure!(
        running.state() == TaskState::Running,
        "partial output was buffered until completion"
    );
    let calls = runtime.calls()?;
    ensure!(calls.len() == 1);
    let pid = calls[0]["pid"].as_i64().context("native PID missing")? as i32;
    ensure!(
        unsafe { libc::kill(pid, 0) } == 0,
        "native exited before streamed output observation"
    );
    ensure!(
        runtime.task(&wrong.task_id).await?.state() == TaskState::Queued,
        "OpenCode host claimed another harness"
    );
    std::fs::write(runtime.fixture.join(format!("release-{pid}")), b"go")?;
    host.success().await?;
    gone(pid).await?;
    let completed = runtime.task(&first.task_id).await?;
    ensure!(
        completed.state() == TaskState::Succeeded,
        "{:?}",
        completed.result
    );
    ensure!(
        completed
            .result
            .as_deref()
            .unwrap_or_default()
            .contains("native-complete:")
    );
    let second = runtime
        .submit("native", "same-session", "fresh", None)
        .await?;
    let mut host = runtime.host(directory.path())?;
    host.success().await?;
    ensure!(runtime.task(&second.task_id).await?.state() == TaskState::Succeeded);
    let events = runtime
        .operator
        .list_events(runtime.credentials.request(ListEventsRequest {
            task_id: first.task_id.clone(),
            after_sequence: 0,
            limit: 100,
        })?)
        .await?
        .into_inner()
        .events;
    ensure!(
        events
            .iter()
            .all(|event| !event.text.contains("synthetic-opencode-provider-key")),
        "provider credential leaked into durable native events"
    );
    ensure!(
        !completed
            .result
            .as_deref()
            .unwrap_or_default()
            .contains("synthetic-opencode-provider-key"),
        "provider credential leaked into final result"
    );
    let calls = runtime.calls()?;
    ensure!(calls.len() == 2);
    ensure!(
        calls[1]["mode"] == "fresh",
        "fixture did not identify the fresh current prompt"
    );
    ensure!(
        calls[1]["priorPrompt"] == true && calls[1]["priorResult"] == true,
        "fresh native turn lost completed same-Session engine history"
    );
    ensure!(
        calls[0]["home"] != calls[1]["home"],
        "native HOME persisted across fresh turns"
    );
    ensure!(calls.iter().all(|c| {
        c["args"].as_array().is_some_and(|args| {
            !args.iter().any(|a| {
                a.as_str()
                    .is_some_and(|a| a.contains("resume") || a.contains("synthetic-"))
            })
        })
    }));
    runtime.assert_no_checkpoint().await?;
    Ok(())
}

async fn opencode_cancellation_reaps_native_process(database: String) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let mut runtime = Runtime::start(directory.path(), database).await?;
    runtime
        .tag("native", HarnessKind::Opencode, &["files:read"])
        .await?;
    let pending = runtime.submit("native", "cancel", "wait", None).await?;
    let mut host = runtime.host(directory.path())?;
    runtime
        .wait_text(&pending.task_id, "native-partial:")
        .await?;
    let calls = runtime.calls()?;
    let pid = calls[0]["pid"].as_i64().context("native PID missing")? as i32;
    runtime
        .operator
        .cancel_task(runtime.credentials.request(CancelTaskRequest {
            task_id: pending.task_id.clone(),
        })?)
        .await?;
    host.success()
        .await
        .context("cancelled native fixture cleanup")?;
    gone(pid).await?;
    let cancelled = runtime.task(&pending.task_id).await?;
    ensure!(cancelled.state() == TaskState::Cancelled);
    let mut connection = sqlx::AnyConnection::connect(&runtime.database).await?;
    let cleanup: i64 =
        sqlx::query_scalar("SELECT cleanup_pending FROM supertag_v2_tasks WHERE task_id=$1")
            .bind(&pending.task_id)
            .fetch_one(&mut connection)
            .await?;
    ensure!(
        cleanup == 0,
        "cancelled native execution was not durably settled"
    );
    connection.close().await?;
    runtime.assert_no_checkpoint().await?;
    Ok(())
}

async fn opencode_bad_streams_fail_closed(database: String) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let mut runtime = Runtime::start(directory.path(), database).await?;
    runtime
        .tag("native", HarnessKind::Opencode, &["files:read"])
        .await?;
    for mode in [
        "bad-json",
        "missing-terminal",
        "native-error",
        "process-failure",
    ] {
        let prior_calls = runtime.calls()?.len();
        let task = runtime.submit("native", mode, mode, None).await?;
        let mut host = runtime.host(directory.path())?;
        host.success()
            .await
            .with_context(|| format!("native {mode} cleanup"))?;
        let result = runtime.task(&task.task_id).await?;
        ensure!(
            result.state() == TaskState::Failed,
            "bad native stream succeeded: {mode}"
        );
        let calls = runtime.calls()?;
        let call = calls.last().context("native call missing")?;
        ensure!(
            calls.len() == prior_calls + 1 && call["mode"] == mode,
            "failed before exercising the requested native stream: {mode}"
        );
        let pid = call["pid"].as_i64().context("PID missing")? as i32;
        gone(pid).await?;
    }
    runtime.assert_no_checkpoint().await?;
    Ok(())
}

async fn opencode_recovers_missing_terminal_from_credential_free_local_export(
    database: String,
) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let mut runtime = Runtime::start(directory.path(), database).await?;
    let auth_file = directory.path().join("operator-auth.json");
    let source = br#"{"openai":{"type":"api","key":"synthetic-opencode-provider-key"},"anthropic":{"type":"api","key":"unused-file-provider-key"}}"#;
    std::fs::write(&auth_file, source)?;
    std::fs::set_permissions(&auth_file, std::fs::Permissions::from_mode(0o600))?;
    runtime
        .tag("native", HarnessKind::Opencode, &["files:read"])
        .await?;
    let task = runtime
        .submit("native", "export-fallback", "fallback", None)
        .await?;
    let mut host = runtime.host_with_auth_file(directory.path(), Some(&auth_file))?;
    host.success().await?;
    let result = runtime.task(&task.task_id).await?;
    ensure!(
        result.state() == TaskState::Succeeded,
        "export recovery failed: {:?}; fixture: {}",
        result.result,
        runtime.native_errors()
    );
    ensure!(
        result
            .result
            .as_deref()
            .unwrap_or_default()
            .contains("native-fallback-complete")
    );
    let exports = std::fs::read_to_string(runtime.fixture.join("exports.jsonl"))?;
    let exports: Vec<Value> = exports
        .lines()
        .map(serde_json::from_str)
        .collect::<Result<_, _>>()?;
    ensure!(
        exports.len() == 1,
        "fallback did not perform exactly one local export"
    );
    let calls = runtime.calls()?;
    ensure!(
        calls.len() == 1
            && calls[0]["mode"] == "fallback"
            && calls[0]["credentialSource"] == "file"
    );
    ensure!(
        std::fs::read(&auth_file)? == source,
        "export changed the operator's original credentials"
    );
    for call in calls.iter().chain(exports.iter()) {
        gone(call["pid"].as_i64().context("native PID missing")? as i32).await?;
    }
    runtime.assert_no_checkpoint().await?;
    Ok(())
}

async fn opencode_leaves_unsupported_limits_and_unapproved_commands_queued(
    database: String,
) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let mut runtime = Runtime::start(directory.path(), database).await?;
    runtime
        .tag("native", HarnessKind::Opencode, &["files:read"])
        .await?;
    let limited = runtime
        .submit(
            "native",
            "limited",
            "fresh",
            Some(ExecutionLimits {
                max_native_agents: Some(0),
                ..Default::default()
            }),
        )
        .await?;
    let mut host = runtime.host(directory.path())?;
    host.success().await?;
    let task = runtime.task(&limited.task_id).await?;
    ensure!(
        task.state() == TaskState::Queued,
        "unsupported bound was assigned to OpenCode: {:?}",
        task.state()
    );
    ensure!(
        task.attempt_id.is_none(),
        "unsupported bound gained execution authority"
    );
    ensure!(
        runtime.calls()?.is_empty(),
        "native process started with an unenforceable bound"
    );
    runtime
        .tag(
            "commands",
            HarnessKind::Opencode,
            &["files:read", "commands:execute"],
        )
        .await?;
    let commands = runtime
        .submit("commands", "unsupported-commands", "fresh", None)
        .await?;
    let mut host = runtime.host(directory.path())?;
    host.success().await?;
    let task = runtime.task(&commands.task_id).await?;
    ensure!(
        task.state() == TaskState::Queued,
        "unapproved unsandboxed commands were assigned to OpenCode: {:?}",
        task.state()
    );
    ensure!(
        task.attempt_id.is_none() && task.attempt_execution.is_none(),
        "unapproved unsandboxed commands gained execution authority"
    );
    ensure!(
        runtime.calls()?.is_empty(),
        "native process started despite unsupported commands"
    );
    Ok(())
}

async fn opencode_claims_and_runs_the_accepted_role_model(database: String) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let mut runtime = Runtime::start(directory.path(), database).await?;
    runtime
        .tag("reviewer", HarnessKind::Opencode, &["files:read"])
        .await?;
    let default_model = "openai/host-default";
    let mut policy = PolicyCatalogClient::new(
        protocol::negotiated(
            Channel::from_shared(runtime.endpoint.clone())?
                .connect_timeout(Duration::from_secs(3))
                .timeout(Duration::from_secs(3))
                .connect()
                .await?,
        )
        .await?,
    );
    let role = policy
        .put_role(runtime.credentials.request(PutRoleRequest {
            operation_id: "reviewer-model-role".into(),
            role: Some(Role {
                role_id: "reviewer-model".into(),
                name: "Reviewer model".into(),
                purpose: "Use the selected native model".into(),
                execution: Some(PolicyExecutionSettings {
                    harness: Some("opencode".into()),
                    models: vec![FIXTURE_MODEL.into(), default_model.into()],
                    ..Default::default()
                }),
                ..Default::default()
            }),
            ..Default::default()
        })?)
        .await?
        .into_inner();
    policy
        .assign_role(runtime.credentials.request(AssignRoleRequest {
            operation_id: "assign-reviewer-model".into(),
            tag_id: "reviewer".into(),
            role: role.role_id,
        })?)
        .await?;
    let task = runtime
        .submit("reviewer", "model-choice", "fresh", None)
        .await?;
    let selected = task
        .execution_selection
        .as_ref()
        .context("Role model selection was not accepted")?;
    assert_eq!(selected.model.as_deref(), Some(FIXTURE_MODEL));

    // Simulate a crash after the old host saved an eligible Claim, before sending it.
    let wrong_directory = directory.path().join("wrong-host");
    let wrong_state = wrong_directory.join("host");
    std::fs::create_dir_all(&wrong_state)?;
    std::fs::set_permissions(&wrong_state, std::fs::Permissions::from_mode(0o700))?;
    let stale_claim = ClaimTaskRequest {
        operation_id: Uuid::new_v4().to_string(),
        harness_kind: HarnessKind::Opencode as i32,
        execution_profile: Some(HarnessExecutionProfile {
            mcp_login_servers: vec![],
            workspace_mounts: vec![],
            declared_task_outputs: false,
            model_ids: vec![FIXTURE_MODEL.into()],
            default_model: Some(FIXTURE_MODEL.into()),
            allow_unsandboxed_commands: false,
            remote_file_workspace: false,
            mcp_servers: vec![],
            shared_execution: None,
            task_artifact_inputs: false,
        }),
        ..Default::default()
    };
    let journal = wrong_state.join("attempt.json");
    std::fs::write(
        &journal,
        serde_json::to_vec(&serde_json::json!({
            "stage": "claim",
            "operation_id": stale_claim.operation_id,
            "request": stale_claim.encode_to_vec(),
        }))?,
    )?;
    std::fs::set_permissions(&journal, std::fs::Permissions::from_mode(0o600))?;
    let mut wrong = runtime.host_with_models(&wrong_directory, None, default_model, &[])?;
    wrong.success().await?;
    assert!(!journal.try_exists()?);
    let queued = runtime.task(&task.task_id).await?;
    assert_eq!(queued.state(), TaskState::Queued);
    assert!(queued.attempt_id.is_none() && queued.attempt_execution.is_none());
    assert!(runtime.calls()?.is_empty() && runtime.native_errors().is_empty());

    let mut matching =
        runtime.host_with_models(directory.path(), None, default_model, &[FIXTURE_MODEL])?;
    matching.success().await?;
    let completed = runtime.task(&task.task_id).await?;
    ensure!(
        completed.state() == TaskState::Succeeded,
        "matched host failed: {:?}; native fixture: {}",
        completed.result,
        runtime.native_errors()
    );
    assert_eq!(completed.execution_selection, task.execution_selection);
    let attempt = completed
        .attempt_execution
        .context("Attempt selection missing")?;
    assert_eq!(attempt.harness_kind(), HarnessKind::Opencode);
    assert_eq!(attempt.model_source(), ModelSource::Task);
    assert_eq!(attempt.selection.as_ref(), Some(selected));
    let calls = runtime.calls()?;
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["args"][3], "--model");
    assert_eq!(calls[0]["args"][4], FIXTURE_MODEL);
    gone(calls[0]["pid"].as_i64().context("native PID missing")? as i32).await?;
    Ok(())
}

async fn put_tag_cli_preserves_model_and_effort_order_at_admission(database: String) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let mut runtime = Runtime::start(directory.path(), database).await?;
    let put_tag = |runtime: &Runtime, flags: &[&str]| {
        let mut command = runtime.credentials.command();
        command
            .args([
                "tag",
                "put",
                "reviewer",
                "--control-plane",
                &runtime.endpoint,
                "--instructions",
                "Review the fixture change",
                "--harness",
                "opencode",
            ])
            .args(flags);
        Process::spawn(command, directory.path(), "tag-put", false)
    };
    let alternate = "openai/alternate";
    put_tag(
        &runtime,
        &[
            "--model",
            FIXTURE_MODEL,
            "--model",
            alternate,
            "--effort",
            "high",
            "--effort",
            "low",
        ],
    )?
    .success()
    .await?;
    let tag = runtime
        .operator
        .list_tags(runtime.credentials.request(ListTagsRequest::default())?)
        .await?
        .into_inner()
        .tags
        .pop()
        .context("tag put did not create the reviewer")?;
    assert_eq!(tag.tag_id, "reviewer");
    assert_eq!(tag.harness_kind(), HarnessKind::Opencode);
    let range = tag.execution.context("Tag execution range missing")?;
    assert_eq!(range.models, [FIXTURE_MODEL, alternate]);
    assert_eq!(range.efforts, ["high", "low"]);
    let first = runtime
        .submit("reviewer", "configured", "fresh", None)
        .await?;
    let selection = first
        .execution_selection
        .as_ref()
        .context("Task selection missing")?;
    assert_eq!(selection.model.as_deref(), Some(FIXTURE_MODEL));
    assert_eq!(selection.effort.as_deref(), Some("high"));

    put_tag(&runtime, &[])?.success().await?;
    let next = runtime
        .submit("reviewer", "defaults", "fresh", None)
        .await?;
    let selection = next.execution_selection.context("Task default missing")?;
    assert!(selection.model.is_none());
    assert_eq!(selection.effort.as_deref(), Some("low"));
    assert_eq!(runtime.task(&first.task_id).await?, first);
    Ok(())
}

async fn opencode_manager_coordination_uses_real_private_harness_with_child_denials(
    database: String,
) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let mut runtime = Runtime::start(directory.path(), database).await?;
    runtime
        .tag("native", HarnessKind::Opencode, &["files:read"])
        .await?;
    let task = runtime
        .submit("native", "coordination", "coordination", None)
        .await?;
    let mut host = runtime.host(directory.path())?;
    host.success().await?;
    let result = runtime.task(&task.task_id).await?;
    ensure!(
        result.state() == TaskState::Succeeded,
        "manager coordination failed: {:?}; native fixture: {}",
        result.result,
        runtime.native_errors()
    );
    ensure!(
        result
            .result
            .as_deref()
            .unwrap_or_default()
            .contains("native-coordination-ok")
    );
    let calls = runtime.calls()?;
    ensure!(
        calls.len() == 1
            && calls[0]["mcpNames"]
                .as_array()
                .is_some_and(|names| names.iter().any(|name| name == "supertag"))
    );
    gone(calls[0]["pid"].as_i64().context("native PID missing")? as i32).await?;
    Ok(())
}
