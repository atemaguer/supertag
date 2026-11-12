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
        PolicyExecutionSettings, PutTagRequest, SubmitTaskRequest, Task, TaskEvent, TaskState,
        WorkspaceSpec, operator_client::OperatorClient,
    },
    valid_sha256,
};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    time::{Instant, sleep, timeout},
};
use tokio_stream::wrappers::TcpListenerStream;
use tonic::{
    Request,
    transport::{Channel, Server},
};
use uuid::Uuid;

const BINARY: &str = env!("CARGO_BIN_EXE_supertag");
const WAIT: Duration = Duration::from_secs(30);
const PROVIDER_KEY: &str = "synthetic-cursor-provider-key";
const TAG: &str = "cursor-fixture";
const SESSION: &str = "cursor-session";
const WORKSPACE: &str = "cursor-project";

#[cfg(target_os = "linux")]
#[path = "support/shared_command_runtime.rs"]
mod shared_command_runtime;

#[derive(Clone, Copy)]
enum RemoteWorkspace {
    E2b,
    Modal,
}

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
        let provider_transport =
            repository.join("packages/runtime/sdk/dist/rust-workspace-provider/transport.js");
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
            root.join("remote-provider.mjs"),
            include_str!("../fixtures/cursor/remote-provider.mjs"),
        )?;
        std::fs::write(
            root.join("modules.json"),
            serde_json::to_vec(
                &json!({ "adapter": adapter_module, "bridge": bridge_module, "providerTransport": provider_transport }),
            )?,
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

    fn provider_trace(&self) -> Result<Vec<Value>> {
        std::fs::read_to_string(self.root.join("provider-calls.jsonl"))
            .unwrap_or_default()
            .lines()
            .map(|line| Ok(serde_json::from_str(line)?))
            .collect()
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
                    github_source: None,
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
        self.worker_with_provider(fixture, label, allow_commands, false)
    }

    fn worker_with_provider(
        &self,
        fixture: &Fixture,
        label: &str,
        allow_commands: bool,
        remote: bool,
    ) -> Result<Child> {
        self.worker_with_remote(
            fixture,
            label,
            allow_commands,
            remote.then_some(RemoteWorkspace::E2b),
        )
    }

    fn worker_with_remote(
        &self,
        fixture: &Fixture,
        label: &str,
        allow_commands: bool,
        remote: Option<RemoteWorkspace>,
    ) -> Result<Child> {
        let mut command = self.worker_command(fixture, label);
        command
            .arg("--workspace-id")
            .arg(WORKSPACE)
            .arg("--workspace-source")
            .arg(&fixture.source);
        if allow_commands {
            command.arg("--allow-unsandboxed-commands");
        }
        if let Some(remote) = remote {
            let (provider_flag, argument_flag) = match remote {
                RemoteWorkspace::E2b => {
                    ("--e2b-workspace-provider", "--e2b-workspace-provider-arg")
                }
                RemoteWorkspace::Modal => (
                    "--modal-workspace-provider",
                    "--modal-workspace-provider-arg",
                ),
            };
            command
                .arg(provider_flag)
                .arg(&fixture.node)
                .arg(argument_flag)
                .arg(fixture.root.join("remote-provider.mjs"))
                .env("E2B_API_KEY", "synthetic-e2b-provider-key")
                .env("E2B_DOMAIN", "fixture.e2b.invalid")
                .env("SUPERTAG_E2B_TEMPLATE", "fixture-template");
        }
        Ok(command.spawn()?)
    }

    fn worker_command(&self, fixture: &Fixture, label: &str) -> Command {
        let mut command = self.credentials.command(&[
            "worker-host",
            "--gateway",
            &self.endpoint,
            "--once",
            "--harness",
            "cursor",
            "--harness-model",
            "fixture-model",
        ]);
        command
            .arg("--cursor-node")
            .arg(&fixture.node)
            .arg("--cursor-adapter")
            .arg(&fixture.adapter)
            .arg("--state-directory")
            .arg(fixture.root.join(format!("host-{label}")))
            .env("HOME", fixture.root.join("operator-home"))
            .env("CURSOR_API_KEY", PROVIDER_KEY)
            .env("OPENAI_API_KEY", "unrelated-provider-key")
            .env("ANTHROPIC_API_KEY", "unrelated-anthropic-key")
            .env("MODAL_TOKEN_ID", "synthetic-modal-token-id")
            .env("MODAL_TOKEN_SECRET", "synthetic-modal-token-secret")
            .env("MODAL_SERVER_URL", "https://fixture.modal.invalid:443")
            .env("MODAL_CONFIG_PATH", "/fixture/untrusted-modal-profile")
            .env("MODAL_ENVIRONMENT", "unrelated-modal-profile")
            .env("SUPERTAG_MODAL_WORKSPACE_APP", "fixture-modal-app")
            .env(
                "SUPERTAG_MODAL_WORKSPACE_ENVIRONMENT",
                "fixture-modal-environment",
            )
            .env("SUPERTAG_MODAL_WORKSPACE_IMAGE", "fixture-modal-image")
            .env("NODE_OPTIONS", "--invalid-fixture-option")
            .env("PYTHONPATH", "unrelated-python-path")
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        command
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
                "Cursor settled before live output: {:?}; fixture: {:?}; provider: {:?}",
                task.result,
                fixture.trace()?,
                fixture.provider_trace()?
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

#[tokio::test]
async fn cursor_shared_execution_reopens_the_fixed_root_and_revokes_each_access() -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    use supertag_shared_execution::{Config, Provider, v2::AccessState};

    const ENVIRONMENT: &str = "fixture-fixed-root";
    let directory = tempfile::tempdir()?;
    let fixture = Fixture::prepare(directory.path()).await?;
    let root = fixture.root.join("shared-root");
    let state = fixture.root.join("shared-provider");
    std::fs::create_dir(&root)?;
    std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700))?;
    std::fs::write(root.join("workspace.txt"), "initial-content\n")?;
    let admin = Uuid::new_v4().to_string();
    let provider = Provider::open(Config {
        environment_id: ENVIRONMENT.into(),
        root: root.clone(),
        state_directory: state.clone(),
        admin_token: admin.clone(),
        process_identity: None,
    })
    .await?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let endpoint = format!("http://{}", listener.local_addr()?);
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let provider_task = tokio::spawn(async move {
        Server::builder()
            .add_service(provider.service())
            .serve_with_incoming_shutdown(TcpListenerStream::new(listener), async {
                let _ = stopped.await;
            })
            .await
    });
    let credentials = Credentials::new();
    let mut runtime = Runtime::start(&fixture.root, &credentials).await?;
    runtime
        .operator
        .put_tag(runtime.credentials.request(PutTagRequest {
            tag_id: TAG.into(),
            instructions: "Follow the fixed root fixture.".into(),
            allowed_actions: vec!["files:read".into(), "files:write".into()],
            harness_kind: HarnessKind::Cursor as i32,
            execution: Some(PolicyExecutionSettings {
                shared_execution_environment_id: Some(ENVIRONMENT.into()),
                ..Default::default()
            }),
            ..Default::default()
        })?)
        .await?;
    let mut database = sqlx::SqliteConnection::connect(&format!(
        "sqlite://{}",
        state.join("state.sqlite").display()
    ))
    .await?;
    let start_host = |runtime: &Runtime<'_>| {
        runtime
            .worker_command(&fixture, "shared")
            .arg("--shared-execution-endpoint")
            .arg(&endpoint)
            .arg("--shared-execution-environment")
            .arg(ENVIRONMENT)
            .env("SUPERTAG_EXECUTION_ADMIN_TOKEN", &admin)
            .spawn()
    };
    // A real provider storage failure during revocation must fence completion until
    // the same Host can replay and verify cleanup. No model call should run twice.
    sqlx::query(
        "CREATE TRIGGER hold_revoke BEFORE UPDATE OF state ON accesses
         BEGIN SELECT RAISE(ABORT, 'fixture holds access cleanup'); END",
    )
    .execute(&mut database)
    .await?;
    for (index, mode) in ["shared-first", "shared-resume"].into_iter().enumerate() {
        let queued = runtime.submit(TAG, mode).await?;
        if index == 0 {
            let output = timeout(WAIT, start_host(&runtime)?.wait_with_output()).await??;
            assert!(!output.status.success());
            assert!(
                String::from_utf8_lossy(&output.stderr).contains("cleanup receipt is unavailable")
            );
            let unsettled = runtime.task(&queued.task_id).await?;
            assert_eq!(unsettled.state(), TaskState::Running);
            assert!(unsettled.result.is_none());
            fixture.started(mode)?;
            sqlx::query("DROP TRIGGER hold_revoke")
                .execute(&mut database)
                .await?;
        }
        let worker = start_host(&runtime)?;
        let output = timeout(WAIT, worker.wait_with_output()).await??;
        ensure!(
            output.status.success(),
            "shared Worker Host failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let result = runtime
            .assert_success(&queued.task_id, mode)
            .await
            .with_context(|| format!("Cursor runner trace: {:?}", fixture.trace()))?;
        assert!(result.workspace.is_none() && result.workspace_delivery.is_none());
        assert_eq!(
            result
                .attempt_execution
                .and_then(|execution| execution.shared_execution)
                .map(|shared| shared.environment_id)
                .as_deref(),
            Some(ENVIRONMENT),
        );
        let revoked: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM accesses WHERE state=$1")
            .bind(AccessState::Revoked as i64)
            .fetch_one(&mut database)
            .await?;
        assert_eq!(revoked, (index + 1) as i64);
        assert_eq!(
            std::fs::read_to_string(root.join("workspace.txt"))?,
            "first-turn-content\n"
        );
        assert_eq!(
            std::fs::read_to_string(fixture.source.join("workspace.txt"))?,
            "initial-content\n"
        );
        assert_eq!(
            fixture
                .trace()?
                .iter()
                .filter(|entry| entry["type"] == "started" && entry["mode"] == mode)
                .count(),
            1,
        );
    }
    assert_eq!(
        fixture.started("shared-resume")?["restoredFrom"],
        "shared-first"
    );
    runtime.stop().await?;
    let _ = stop.send(());
    timeout(WAIT, provider_task).await???;
    Ok(())
}

#[tokio::test]
async fn cursor_remote_workspace_delivers_and_resumes_from_the_approved_head() -> Result<()> {
    remote_workspace_round_trip(RemoteWorkspace::E2b).await
}

#[tokio::test]
async fn cursor_modal_workspace_delivers_and_resumes_with_isolated_provider_credentials()
-> Result<()> {
    remote_workspace_round_trip(RemoteWorkspace::Modal).await
}

async fn remote_workspace_round_trip(provider: RemoteWorkspace) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let fixture = Fixture::prepare(directory.path()).await?;
    let provider_name = match provider {
        RemoteWorkspace::E2b => "e2b",
        RemoteWorkspace::Modal => "modal",
    };
    std::fs::write(fixture.root.join("provider-kind"), provider_name)?;
    let credentials = Credentials::new();
    let mut runtime = Runtime::start(&fixture.root, &credentials).await?;
    runtime
        .tag(
            &fixture,
            TAG,
            HarnessKind::Cursor,
            &["files:read", "files:write"],
        )
        .await?;
    let first = runtime.submit(TAG, "remote-first").await?;
    std::fs::write(fixture.root.join("hold-stop"), b"enabled")?;
    let worker = runtime.worker_with_remote(&fixture, "remote-first", false, Some(provider))?;
    runtime
        .wait_stream(&fixture, &first.task_id, "remote-first")
        .await?;
    let first_call = fixture.started("remote-first")?;
    let runner = pid(&first_call, "pid")?;
    std::fs::write(fixture.root.join(format!("release-{runner}")), b"go")?;
    let deadline = Instant::now() + WAIT;
    while !fixture
        .provider_trace()?
        .iter()
        .any(|value| value["type"] == "stop-wait")
    {
        ensure!(
            Instant::now() < deadline,
            "provider never reached held Stop: {:?}",
            fixture.provider_trace()?
        );
        sleep(Duration::from_millis(20)).await;
    }
    sqlx::any::install_default_drivers();
    let mut database = sqlx::AnyConnection::connect(&runtime.database).await?;
    let before: i64 =
        sqlx::query_scalar("SELECT lease_expires_at_ms FROM supertag_v2_tasks WHERE task_id=$1")
            .bind(&first.task_id)
            .fetch_one(&mut database)
            .await?;
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        let renewed: i64 = sqlx::query_scalar(
            "SELECT lease_expires_at_ms FROM supertag_v2_tasks WHERE task_id=$1",
        )
        .bind(&first.task_id)
        .fetch_one(&mut database)
        .await?;
        if renewed > before + 500 {
            break;
        }
        ensure!(
            Instant::now() < deadline,
            "execution lease did not renew during remote Stop"
        );
        sleep(Duration::from_millis(30)).await;
    }
    let during_stop = runtime.task(&first.task_id).await?;
    assert_eq!(during_stop.state(), TaskState::Running);
    assert!(during_stop.workspace_delivery.is_none());
    std::fs::remove_file(fixture.root.join("hold-stop"))?;
    worker_finished(worker, &fixture).await?;
    gone(runner).await?;
    let first = runtime
        .assert_success(&first.task_id, "remote-first")
        .await?;
    let first_delivery = first
        .workspace_delivery
        .as_ref()
        .context("remote delivery missing")?;
    ensure!(first_delivery.committed && first_delivery.changed_files == 1);
    ensure!(first_delivery.start_commit == fixture.base);
    runtime.assert_usage(&first).await?;
    let checkpoint = runtime.checkpoint().await?;
    runtime.stop().await?;

    let mut runtime = Runtime::start(&fixture.root, &credentials).await?;
    assert_eq!(runtime.checkpoint().await?, checkpoint);
    runtime
        .tag(&fixture, TAG, HarnessKind::Cursor, &["files:read"])
        .await?;
    let second = runtime.submit(TAG, "remote-resume").await?;
    worker_finished(
        runtime.worker_with_remote(&fixture, "remote-resume", false, Some(provider))?,
        &fixture,
    )
    .await?;
    let second = runtime
        .assert_success(&second.task_id, "remote-resume")
        .await?;
    let delivery = second
        .workspace_delivery
        .as_ref()
        .context("second remote delivery missing")?;
    assert_eq!(delivery.start_commit, first_delivery.head_commit);
    assert_eq!(delivery.head_commit, first_delivery.head_commit);
    assert!(!delivery.committed);
    let resumed = fixture.started("remote-resume")?;
    assert_eq!(resumed["agentId"], first_call["agentId"]);
    assert_eq!(resumed["restoredFrom"], "remote-first");
    assert_ne!(resumed["cwd"], first_call["cwd"]);
    assert_eq!(
        std::fs::read_to_string(fixture.source.join("workspace.txt"))?,
        "initial-content\n"
    );
    assert_eq!(
        git(&fixture.source, &["rev-parse", "HEAD"]).await?,
        fixture.base
    );
    assert_eq!(git(&fixture.source, &["status", "--porcelain"]).await?, "");

    let trace: Vec<Value> = std::fs::read_to_string(fixture.root.join("provider-calls.jsonl"))?
        .lines()
        .map(serde_json::from_str)
        .collect::<Result<_, _>>()?;
    let allocations: Vec<_> = trace
        .iter()
        .filter(|value| value["type"] == "allocate")
        .collect();
    let stages: Vec<_> = trace
        .iter()
        .filter(|value| value["type"] == "stage")
        .collect();
    let stops: Vec<_> = trace
        .iter()
        .filter(|value| value["type"] == "stop")
        .collect();
    assert_eq!((allocations.len(), stages.len(), stops.len()), (2, 2, 2));
    assert_eq!(stages[0]["startCommit"], fixture.base);
    assert_eq!(stages[0]["before"], "initial-content\n");
    assert_eq!(stages[1]["startCommit"], first_delivery.head_commit);
    assert_eq!(stages[1]["before"], "first-turn-content\n");
    for (allocation, task) in allocations.iter().zip([&first, &second]) {
        assert_eq!(allocation["provider"], provider_name);
        assert_eq!(allocation["owner"]["taskId"], task.task_id);
        assert_eq!(
            allocation["owner"]["attemptId"],
            task.attempt_id.as_deref().unwrap()
        );
        let stop = stops
            .iter()
            .find(|stop| stop["sandboxId"] == allocation["sandboxId"])
            .context("allocation never stopped")?;
        assert_eq!(stop["owner"], allocation["owner"]);
        assert_eq!(stop["stopped"], true);
        gone(pid(allocation, "pid")?).await?;
    }
    runtime.stop().await
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

#[tokio::test]
async fn cursor_remote_lost_allocation_ack_keeps_work_fenced_until_absence_is_confirmed()
-> Result<()> {
    let directory = tempfile::tempdir()?;
    let fixture = Fixture::prepare(directory.path()).await?;
    std::fs::write(fixture.root.join("lose-allocate-ack"), b"enabled")?;
    std::fs::write(fixture.root.join("refuse-stop"), b"enabled")?;
    let credentials = Credentials::new();
    let mut runtime = Runtime::start(&fixture.root, &credentials).await?;
    runtime
        .tag(
            &fixture,
            TAG,
            HarnessKind::Cursor,
            &["files:read", "files:write"],
        )
        .await?;
    let first = runtime.submit(TAG, "remote-first").await?;
    for _ in 0..2 {
        let output = timeout(
            WAIT,
            runtime
                .worker_with_provider(&fixture, "lost-ack", false, true)?
                .wait_with_output(),
        )
        .await??;
        ensure!(
            !output.status.success(),
            "ambiguous remote allocation was treated as stopped"
        );
        let error = String::from_utf8_lossy(&output.stderr);
        ensure!(
            error.contains("termination could not be confirmed"),
            "unexpected remote recovery error: {error}; provider: {:?}",
            fixture.provider_trace()?
        );
        ensure!(!error.contains(PROVIDER_KEY) && !error.contains("synthetic-e2b-provider-key"));
    }
    ensure!(
        fixture.trace()?.is_empty(),
        "native execution started without a prepared sandbox"
    );
    assert!(matches!(
        runtime.task(&first.task_id).await?.state(),
        TaskState::Running | TaskState::Uncertain
    ));
    let follow = runtime.submit(TAG, "remote-first").await?;
    assert_eq!(
        runtime.task(&follow.task_id).await?.state(),
        TaskState::Queued
    );
    std::fs::remove_file(fixture.root.join("refuse-stop"))?;
    let recovered = timeout(
        WAIT,
        runtime
            .worker_with_provider(&fixture, "lost-ack", false, true)?
            .wait_with_output(),
    )
    .await??;
    ensure!(
        !recovered.status.success(),
        "remote stop bypassed the required operator recovery"
    );
    ensure!(
        String::from_utf8_lossy(&recovered.stderr).contains("needs recovery"),
        "unexpected settled cleanup state: {}; provider: {:?}",
        String::from_utf8_lossy(&recovered.stderr),
        fixture.provider_trace()?
    );
    let trace = fixture.provider_trace()?;
    let allocations: Vec<_> = trace
        .iter()
        .filter(|value| value["type"] == "allocate")
        .collect();
    let stopped: Vec<_> = trace
        .iter()
        .filter(|value| value["type"] == "stop")
        .collect();
    assert_eq!((allocations.len(), stopped.len()), (1, 1));
    assert_eq!(allocations[0]["owner"], stopped[0]["owner"]);
    assert_eq!(allocations[0]["sandboxId"], stopped[0]["sandboxId"]);
    assert!(!trace.iter().any(|value| {
        ["stage", "capture", "write"].contains(&value["type"].as_str().unwrap_or(""))
    }));
    // A new local Host incarnation must respect the unresolved Session. Start
    // it after the original generation records its own provider cleanup.
    worker_finished(
        runtime.worker_with_provider(&fixture, "blocked-by-lost-ack", false, true)?,
        &fixture,
    )
    .await?;
    assert_eq!(
        runtime.task(&follow.task_id).await?.state(),
        TaskState::Queued
    );
    assert_eq!(
        std::fs::read_to_string(fixture.source.join("workspace.txt"))?,
        "initial-content\n"
    );
    runtime.stop().await
}
