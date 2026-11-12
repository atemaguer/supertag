//! Cursor's private adapter and runner through real split services and disposable Workspaces.
use std::{
    net::SocketAddr,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use sqlx::Connection;
use supertag_protocol::{
    authenticated_request,
    v2::{
        CancelTaskRequest, GetTaskRequest, HarnessKind, ListEventsRequest, ListNativeUsageRequest,
        PutTagRequest, SubmitTaskRequest, Task, TaskEvent, TaskState, WorkspaceSpec,
        operator_client::OperatorClient,
    },
    valid_sha256,
};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    time::{Instant, sleep, timeout},
};
use tonic::{Request, transport::Channel};
use uuid::Uuid;

const BINARY: &str = env!("CARGO_BIN_EXE_supertag");
const WAIT: Duration = Duration::from_secs(30);
const PROVIDER_KEY: &str = "synthetic-cursor-provider-key";
const TAG: &str = "cursor-fixture";
const SESSION: &str = "cursor-session";
const WORKSPACE: &str = "cursor-project";

struct Fixture {
    root: PathBuf,
    node: PathBuf,
    adapter: PathBuf,
    runner: PathBuf,
    source: PathBuf,
    base: String,
}

impl Fixture {
    async fn prepare(root: &Path) -> Result<Self> {
        let node = Command::new("/usr/bin/which").arg("node").output().await?;
        ensure!(
            node.status.success(),
            "Node is required for the Cursor fixture"
        );
        let node = std::fs::canonicalize(String::from_utf8(node.stdout)?.trim())?;
        let repository = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .canonicalize()?;
        let adapter_module =
            repository.join("packages/runtime/harnesses/cursor/dist/rust-adapter/adapter.js");
        let bridge_module = repository.join("packages/runtime/sdk/dist/rust-harness/index.js");
        ensure!(
            adapter_module.is_file() && bridge_module.is_file(),
            "build Cursor first: pnpm --filter @supertag/worker-cursor build"
        );
        let root = root.canonicalize()?;
        let adapter = root.join("cursor-adapter.mjs");
        let runner = root.join("runner.mjs");
        std::fs::write(&adapter, include_str!("../fixtures/cursor/adapter.mjs"))?;
        std::fs::write(&runner, include_str!("../fixtures/cursor/runner.mjs"))?;
        std::fs::write(
            root.join("modules.json"),
            serde_json::to_vec(&json!({ "adapter": adapter_module, "bridge": bridge_module }))?,
        )?;
        let source = root.join("source");
        std::fs::create_dir(&source)?;
        git(&source, &["init", "--quiet", "-b", "main"]).await?;
        std::fs::write(source.join("workspace.txt"), "initial-content\n")?;
        git(&source, &["add", "workspace.txt"]).await?;
        git(&source, &["commit", "--quiet", "-m", "Fixture base"]).await?;
        let base = git(&source, &["rev-parse", "HEAD"]).await?;
        Ok(Self {
            root,
            node,
            adapter,
            runner,
            source,
            base,
        })
    }

    fn trace(&self) -> Result<Vec<Value>> {
        let contents = std::fs::read_to_string(self.root.join("calls.jsonl")).unwrap_or_default();
        contents
            .lines()
            .map(|line| Ok(serde_json::from_str(line)?))
            .collect()
    }

    fn started(&self, mode: &str) -> Result<Value> {
        let trace = self.trace()?;
        trace
            .iter()
            .find(|entry| entry["type"] == "started" && entry["mode"] == mode)
            .cloned()
            .with_context(|| format!("Cursor fixture never started {mode}: {trace:?}"))
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let Ok(trace) = self.trace() else { return };
        for entry in trace {
            for key in ["helperPid", "pid"] {
                let Ok(pid) = pid(&entry, key) else { continue };
                if unsafe { libc::kill(pid, 0) } != 0 {
                    continue;
                }
                let Ok(command) = std::process::Command::new("/bin/ps")
                    .args(["-p", &pid.to_string(), "-o", "command="])
                    .output()
                else {
                    continue;
                };
                if String::from_utf8_lossy(&command.stdout)
                    .contains(self.runner.to_string_lossy().as_ref())
                {
                    // The path is unique to this test's temporary directory.
                    unsafe { libc::kill(pid, libc::SIGKILL) };
                }
            }
        }
    }
}

async fn git(source: &Path, args: &[&str]) -> Result<String> {
    let result = Command::new("/usr/bin/git")
        .arg("-C")
        .arg(source)
        .args(args)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_AUTHOR_NAME", "Cursor fixture")
        .env("GIT_AUTHOR_EMAIL", "fixture@example.test")
        .env("GIT_COMMITTER_NAME", "Cursor fixture")
        .env("GIT_COMMITTER_EMAIL", "fixture@example.test")
        .kill_on_drop(true)
        .output()
        .await?;
    ensure!(
        result.status.success(),
        "Git fixture: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    Ok(String::from_utf8(result.stdout)?.trim().to_owned())
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

    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(BINARY);
        command
            .args(args)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("SUPERTAG_GATEWAY_TOKEN", &self.gateway)
            .env("SUPERTAG_OPERATOR_TOKEN", &self.operator)
            .env("SUPERTAG_HOST_TOKEN", &self.host)
            .env("SUPERTAG_BOOTSTRAP_HOST_TOKEN", &self.host)
            .stdin(Stdio::null())
            .kill_on_drop(true);
        command
    }

    fn request<T>(&self, value: T) -> Result<Request<T>> {
        let mut request = authenticated_request(value, &self.operator, None)?;
        request.set_timeout(Duration::from_secs(5));
        Ok(request)
    }
}

struct Runtime<'a> {
    gateway: Child,
    control: Child,
    endpoint: String,
    operator: OperatorClient<Channel>,
    database: String,
    credentials: &'a Credentials,
}

impl<'a> Runtime<'a> {
    async fn start(root: &Path, credentials: &'a Credentials) -> Result<Self> {
        let database = format!("sqlite://{}?mode=rwc", root.join("cursor.sqlite").display());
        let mut control = credentials.command(&["control-plane"]);
        control.env("SUPERTAG_DATABASE_URL", &database);
        let (control, private) = service(control).await?;
        let mut gateway = credentials.command(&["gateway", "--control-plane", &private]);
        gateway
            .arg("--checkpoint-directory")
            .arg(root.join("blobs"));
        let (gateway, endpoint) = service(gateway).await?;
        let channel = Channel::from_shared(endpoint.clone())?
            .connect_timeout(Duration::from_secs(5))
            .connect()
            .await?;
        Ok(Self {
            gateway,
            control,
            endpoint,
            operator: OperatorClient::new(channel),
            database,
            credentials,
        })
    }

    async fn stop(mut self) -> Result<()> {
        self.gateway.kill().await?;
        self.control.kill().await?;
        Ok(())
    }

    async fn tag(
        &mut self,
        fixture: &Fixture,
        tag_id: &str,
        harness: HarnessKind,
        actions: &[&str],
    ) -> Result<()> {
        self.operator
            .put_tag(self.credentials.request(PutTagRequest {
                tag_id: tag_id.into(),
                instructions: "Follow the fixture Task with its admitted tools.".into(),
                allowed_actions: actions.iter().map(|action| (*action).into()).collect(),
                workspace: Some(WorkspaceSpec {
                    workspace_id: WORKSPACE.into(),
                    base_commit: fixture.base.clone(),
                }),
                harness_kind: harness as i32,
                ..Default::default()
            })?)
            .await?;
        Ok(())
    }

    async fn submit(&mut self, tag_id: &str, mode: &str) -> Result<Task> {
        Ok(self
            .operator
            .submit_task(self.credentials.request(SubmitTaskRequest {
                tag_id: tag_id.into(),
                session_id: SESSION.into(),
                operation_id: Uuid::new_v4().to_string(),
                prompt: format!("fixture:{mode}"),
                ..Default::default()
            })?)
            .await?
            .into_inner())
    }

    fn worker(&self, fixture: &Fixture, label: &str, allow_commands: bool) -> Result<Child> {
        let mut command = self.credentials.command(&[
            "worker-host",
            "--gateway",
            &self.endpoint,
            "--once",
            "--harness",
            "cursor",
            "--harness-model",
            "fixture-model",
            "--workspace-id",
            WORKSPACE,
        ]);
        command
            .arg("--cursor-node")
            .arg(&fixture.node)
            .arg("--cursor-adapter")
            .arg(&fixture.adapter)
            .arg("--state-directory")
            .arg(fixture.root.join(format!("host-{label}")))
            .arg("--workspace-source")
            .arg(&fixture.source)
            .env("HOME", fixture.root.join("operator-home"))
            .env("CURSOR_API_KEY", PROVIDER_KEY)
            .env("OPENAI_API_KEY", "unrelated-provider-key")
            .env("ANTHROPIC_API_KEY", "unrelated-anthropic-key")
            .env("NODE_OPTIONS", "--invalid-fixture-option")
            .env("PYTHONPATH", "unrelated-python-path")
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        if allow_commands {
            command.arg("--allow-unsandboxed-commands");
        }
        Ok(command.spawn()?)
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

    async fn events(&mut self, id: &str) -> Result<Vec<TaskEvent>> {
        Ok(self
            .operator
            .list_events(self.credentials.request(ListEventsRequest {
                task_id: id.into(),
                after_sequence: 0,
                limit: 32,
            })?)
            .await?
            .into_inner()
            .events)
    }

    async fn wait_stream(&mut self, fixture: &Fixture, id: &str, mode: &str) -> Result<()> {
        let deadline = Instant::now() + WAIT;
        let marker = format!("cursor-stream:{mode}");
        loop {
            let task = self.task(id).await?;
            ensure!(
                matches!(
                    task.state(),
                    TaskState::Queued | TaskState::Claimed | TaskState::Running
                ),
                "Cursor settled before live output: {:?}; fixture: {:?}",
                task.result,
                fixture.trace()?
            );
            if self
                .events(id)
                .await?
                .iter()
                .any(|event| event.text.contains(&marker))
            {
                ensure!(task.state() == TaskState::Running);
                return Ok(());
            }
            ensure!(
                Instant::now() < deadline,
                "missing live Cursor output: {:?}",
                fixture.trace()?
            );
            sleep(Duration::from_millis(20)).await;
        }
    }

    async fn assert_success(&mut self, id: &str, mode: &str) -> Result<Task> {
        let task = self.task(id).await?;
        ensure!(
            task.state() == TaskState::Succeeded,
            "Cursor Task failed: {:?}",
            task.result
        );
        let result = task.result.as_deref().context("Cursor result missing")?;
        ensure!(result.contains(&format!("cursor-complete:{mode}")) && secret_free(result));
        ensure!(
            self.events(id)
                .await?
                .iter()
                .all(|event| secret_free(&event.text)),
            "Cursor leaked provider credential bytes in durable events"
        );
        Ok(task)
    }

    async fn checkpoint(&self) -> Result<(String, String, String, String, i64)> {
        sqlx::any::install_default_drivers();
        let mut db = sqlx::AnyConnection::connect(&self.database).await?;
        Ok(sqlx::query_as("SELECT c.task_id,c.harness,c.format,c.sha256,c.byte_length FROM supertag_v2_session_checkpoints s JOIN supertag_v2_checkpoints c ON s.attempt_id=c.attempt_id WHERE s.tag_id=$1 AND s.session_id=$2 AND c.committed=1")
            .bind(TAG).bind(SESSION).fetch_one(&mut db).await?)
    }

    async fn assert_usage(&mut self, task: &Task) -> Result<()> {
        let reports = self
            .operator
            .list_native_usage(self.credentials.request(ListNativeUsageRequest {
                task_id: task.task_id.clone(),
                attempt_id: task.attempt_id.clone().context("missing Cursor Attempt")?,
                after_sequence: 0,
                limit: 32,
            })?)
            .await?
            .into_inner()
            .reports;
        let (latest, interim) = reports
            .split_last()
            .context("Cursor did not report native usage")?;
        assert!(!interim.is_empty(), "Cursor did not report interim usage");
        assert!(interim.iter().all(|report| {
            report
                .native_usage
                .as_ref()
                .is_some_and(|usage| usage.observed_model.is_none())
        }));
        let native = latest
            .native_usage
            .as_ref()
            .context("Cursor token evidence missing")?;
        assert_eq!(
            (
                native.input_tokens,
                native.cached_input_tokens,
                native.output_tokens,
                native.total_tokens
            ),
            (10, 2, 5, Some(15))
        );
        assert_eq!(latest.amount_minor, Some(6));
        assert_eq!(latest.currency.as_deref(), Some("USD"));
        assert_eq!(native.observed_model.as_deref(), Some("fixture-model"));
        assert!(!latest.estimated);
        Ok(())
    }
}

async fn service(mut command: Command) -> Result<(Child, String)> {
    let mut child = command.stdout(Stdio::piped()).spawn()?;
    let mut stdout = BufReader::new(child.stdout.take().context("service stdout missing")?);
    let mut line = String::new();
    timeout(WAIT, stdout.read_line(&mut line)).await??;
    let address: SocketAddr = line.trim().parse().context("service did not bind")?;
    ensure!(address.ip().is_loopback() && address.port() != 0);
    Ok((child, format!("http://{address}")))
}

async fn worker_finished(worker: Child, fixture: &Fixture) -> Result<()> {
    let output = timeout(WAIT, worker.wait_with_output())
        .await
        .context("Cursor Worker did not settle")??;
    ensure!(
        output.status.success(),
        "Cursor Worker failed: {}; fixture: {:?}",
        String::from_utf8_lossy(&output.stderr),
        fixture.trace()?
    );
    Ok(())
}

fn pid(entry: &Value, field: &str) -> Result<i32> {
    let pid = i32::try_from(entry[field].as_i64().context("Cursor PID missing")?)?;
    ensure!(pid > 0, "invalid fixture PID");
    Ok(pid)
}

fn secret_free(text: &str) -> bool {
    let (first, second) = PROVIDER_KEY.split_at(13);
    !text.contains(first) && !text.contains(second)
}

async fn gone(pid: i32) -> Result<()> {
    let deadline = Instant::now() + WAIT;
    loop {
        if unsafe { libc::kill(pid, 0) } != 0
            && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
        {
            return Ok(());
        }
        ensure!(
            Instant::now() < deadline,
            "Cursor fixture process {pid} survived settlement"
        );
        sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn cursor_streams_scoped_tools_and_resumes_after_services_restart() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let fixture = Fixture::prepare(directory.path()).await?;
    let credentials = Credentials::new();
    let mut runtime = Runtime::start(&fixture.root, &credentials).await?;
    runtime
        .tag(
            &fixture,
            "other-harness",
            HarnessKind::Opencode,
            &["files:read"],
        )
        .await?;
    runtime
        .tag(
            &fixture,
            TAG,
            HarnessKind::Cursor,
            &["files:read", "files:write", "commands:execute"],
        )
        .await?;
    let wrong = runtime.submit("other-harness", "first").await?;
    let first = runtime.submit(TAG, "first").await?;
    let worker = runtime.worker(&fixture, "first", true)?;
    runtime
        .wait_stream(&fixture, &first.task_id, "first")
        .await?;
    let first_call = fixture.started("first")?;
    let runner = pid(&first_call, "pid")?;
    ensure!(
        unsafe { libc::kill(runner, 0) } == 0,
        "Cursor exited before streaming was observed"
    );
    std::fs::write(fixture.root.join(format!("release-{runner}")), b"go")?;
    worker_finished(worker, &fixture).await?;
    gone(runner).await?;
    let completed = runtime.assert_success(&first.task_id, "first").await?;
    assert!(
        completed
            .workspace_delivery
            .as_ref()
            .is_some_and(|delivery| delivery.committed)
    );
    runtime.assert_usage(&completed).await?;
    assert_eq!(
        runtime.task(&wrong.task_id).await?.state(),
        TaskState::Queued
    );
    let checkpoint = runtime.checkpoint().await?;
    assert_eq!(
        (&checkpoint.0, checkpoint.1.as_str(), checkpoint.2.as_str()),
        (&first.task_id, "cursor", "cursor-sdk-v1")
    );
    assert!(valid_sha256(&checkpoint.3) && checkpoint.4 > 0);
    runtime.stop().await?;

    let mut runtime = Runtime::start(&fixture.root, &credentials).await?;
    assert_eq!(runtime.checkpoint().await?, checkpoint);
    runtime
        .tag(&fixture, TAG, HarnessKind::Cursor, &["files:read"])
        .await?;
    let second = runtime.submit(TAG, "resume").await?;
    worker_finished(runtime.worker(&fixture, "second", false)?, &fixture).await?;
    let completed = runtime.assert_success(&second.task_id, "resume").await?;
    runtime.assert_usage(&completed).await?;
    let second_call = fixture.started("resume")?;
    assert_eq!(first_call["agentId"], second_call["agentId"]);
    assert_eq!(second_call["restoredFrom"], "first");
    assert_ne!(first_call["cwd"], second_call["cwd"]);
    assert_ne!(first_call["home"], second_call["home"]);
    assert_eq!(runtime.checkpoint().await?.0, second.task_id);
    assert_eq!(
        std::fs::read_to_string(fixture.source.join("workspace.txt"))?,
        "initial-content\n"
    );
    runtime.stop().await
}

#[tokio::test]
async fn cursor_cancellation_reaps_native_descendant_and_keeps_prior_checkpoint() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let fixture = Fixture::prepare(directory.path()).await?;
    let credentials = Credentials::new();
    let mut runtime = Runtime::start(&fixture.root, &credentials).await?;
    runtime
        .tag(&fixture, TAG, HarnessKind::Cursor, &["files:read"])
        .await?;
    let initial = runtime.submit(TAG, "baseline").await?;
    worker_finished(runtime.worker(&fixture, "baseline", false)?, &fixture).await?;
    runtime.assert_success(&initial.task_id, "baseline").await?;
    let prior = runtime.checkpoint().await?;

    let cancelled = runtime.submit(TAG, "cancel").await?;
    let worker = runtime.worker(&fixture, "cancel", false)?;
    runtime
        .wait_stream(&fixture, &cancelled.task_id, "cancel")
        .await?;
    let call = fixture.started("cancel")?;
    let runner = pid(&call, "pid")?;
    let helper = pid(&call, "helperPid")?;
    assert_eq!(unsafe { libc::kill(helper, 0) }, 0);
    runtime
        .operator
        .cancel_task(credentials.request(CancelTaskRequest {
            task_id: cancelled.task_id.clone(),
        })?)
        .await?;
    worker_finished(worker, &fixture).await?;
    gone(runner).await?;
    gone(helper).await?;
    assert_eq!(
        runtime.task(&cancelled.task_id).await?.state(),
        TaskState::Cancelled
    );
    assert!(
        runtime
            .events(&cancelled.task_id)
            .await?
            .iter()
            .all(|event| !event.text.contains("cursor-complete:cancel"))
    );
    assert_eq!(runtime.checkpoint().await?, prior);

    let continuation = runtime.submit(TAG, "after-cancel").await?;
    worker_finished(runtime.worker(&fixture, "after-cancel", false)?, &fixture).await?;
    runtime
        .assert_success(&continuation.task_id, "after-cancel")
        .await?;
    assert_eq!(fixture.started("after-cancel")?["agentId"], call["agentId"]);
    assert_eq!(runtime.checkpoint().await?.0, continuation.task_id);
    runtime.stop().await
}
