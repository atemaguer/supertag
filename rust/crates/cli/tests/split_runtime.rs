//! Exercises the shipped binary entry points in independent OS processes.
use std::{
    error::Error as _,
    fs::File,
    io::{BufRead, BufReader},
    net::SocketAddr,
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    str::FromStr,
    sync::{Arc, mpsc},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, anyhow, ensure};
use hmac::{Hmac, Mac};
use serde_json::Value;
use sha2::Sha256;
use sqlx::{ConnectOptions, Connection, Executor, PgConnection, postgres::PgConnectOptions};
use supertag_protocol::{
    HOST_GENERATION_HEADER, authenticated_request,
    v2::{
        AttemptDecision, CancelTaskRequest, ClaimConnectorRequest, ClaimReplyRequest,
        GetTaskRequest, InspectAttemptRequest, ListEventsRequest, PutTagRequest, ReplyState,
        ResolveAttemptRequest, SettleReplyRequest, SubmitTaskRequest, Task, TaskEvent, TaskState,
        connector_client::ConnectorClient, operator_client::OperatorClient,
        worker_host_client::WorkerHostClient,
    },
};
use tempfile::TempDir;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{Mutex, Semaphore},
    time::sleep,
};
use tonic::{Code, Request, transport::Channel};
use uuid::Uuid;

const BINARY: &str = env!("CARGO_BIN_EXE_supertag");
const ADAPTER: &str = env!("CARGO_BIN_EXE_supertag-fixture-adapter");
const WAIT: Duration = Duration::from_secs(20);

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
        // Never inherit an operator's real credentials, TLS settings, or state location.
        command
            .env_clear()
            .env("SUPERTAG_GATEWAY_TOKEN", &self.gateway)
            .env("SUPERTAG_OPERATOR_TOKEN", &self.operator)
            .env("SUPERTAG_HOST_TOKEN", &self.host)
            .env("SUPERTAG_BOOTSTRAP_HOST_TOKEN", &self.host)
            .stdin(Stdio::null());
        command
    }

    fn host_request<T>(&self, message: T) -> Result<Request<T>> {
        let mut request = authenticated_request(message, &self.host, None)?;
        request
            .metadata_mut()
            .insert(HOST_GENERATION_HEADER, "1".parse()?);
        Ok(request)
    }

    fn request<T>(&self, message: T) -> Result<Request<T>> {
        let mut request = authenticated_request(message, &self.operator, None)?;
        request.set_timeout(Duration::from_secs(3));
        Ok(request)
    }
}

/// Owns and reaps each service, including when an assertion or RPC fails.
struct Process {
    child: Child,
    log: PathBuf,
}

impl Process {
    fn spawn(mut command: Command, directory: &Path, name: &str, server: bool) -> Result<Self> {
        let log = directory.join(format!("{name}-{}.log", Uuid::new_v4()));
        command.stderr(File::create(&log)?);
        if server {
            command.stdout(Stdio::piped());
        } else {
            command.stdout(File::create(log.with_extension("stdout"))?);
        }
        Ok(Self {
            child: command.spawn().context("spawn SuperTag process")?,
            log,
        })
    }

    async fn endpoint(&mut self) -> Result<String> {
        Ok(self.endpoints(1).await?.remove(0))
    }

    async fn endpoints(&mut self, count: usize) -> Result<Vec<String>> {
        let stdout = self.child.stdout.take().context("server stdout missing")?;
        let (send, receive) = mpsc::sync_channel(1);
        // Read only the bound endpoint. The reader closes once the line arrives or the
        // owning process is killed, so startup failure cannot leave a blocked test thread.
        std::thread::spawn(move || {
            let mut stdout = BufReader::new(stdout);
            let result = (0..count)
                .map(|_| {
                    let mut line = String::new();
                    stdout.read_line(&mut line).map(|_| line)
                })
                .collect::<std::io::Result<Vec<_>>>();
            let _ = send.send(result);
        });
        let deadline = Instant::now() + WAIT;
        loop {
            match receive.try_recv() {
                Ok(lines) => {
                    return lines?
                        .into_iter()
                        .map(|line| {
                            let address: SocketAddr = line
                                .trim()
                                .trim_start_matches("http://")
                                .parse()
                                .with_context(|| {
                                    format!(
                                        "server did not report a bound endpoint: {}",
                                        self.logs()
                                    )
                                })?;
                            ensure!(
                                address.ip().is_loopback() && address.port() != 0,
                                "invalid test endpoint"
                            );
                            Ok(format!("http://{address}"))
                        })
                        .collect();
                }
                Err(mpsc::TryRecvError::Empty) => {}
                Err(mpsc::TryRecvError::Disconnected) => {
                    return Err(anyhow!("server output closed: {}", self.logs()));
                }
            }
            if let Some(status) = self.child.try_wait()? {
                return Err(anyhow!("server exited with {status}: {}", self.logs()));
            }
            ensure!(
                Instant::now() < deadline,
                "server startup timed out: {}",
                self.logs()
            );
            sleep(Duration::from_millis(10)).await;
        }
    }

    async fn successful_exit(&mut self) -> Result<()> {
        let status = self.exited().await?;
        ensure!(
            status.success(),
            "process exited with {status}: {}",
            self.logs()
        );
        Ok(())
    }

    async fn exited(&mut self) -> Result<ExitStatus> {
        let deadline = Instant::now() + WAIT;
        loop {
            if let Some(status) = self.child.try_wait()? {
                return Ok(status);
            }
            ensure!(
                Instant::now() < deadline,
                "process did not exit: {}",
                self.logs()
            );
            sleep(Duration::from_millis(10)).await;
        }
    }

    fn crash(&mut self) -> Result<ExitStatus> {
        if self.child.try_wait()?.is_none() {
            self.child.kill()?;
        }
        Ok(self.child.wait()?)
    }

    fn terminate(&self) -> Result<()> {
        ensure!(
            Command::new("/bin/kill")
                .args(["-TERM", &self.child.id().to_string()])
                .status()?
                .success(),
            "could not signal process {}",
            self.child.id()
        );
        Ok(())
    }

    fn logs(&self) -> String {
        std::fs::read_to_string(&self.log).unwrap_or_default()
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        if matches!(self.child.try_wait(), Ok(Some(_))) {
            return;
        }
        // Give the host's signal handler a bounded chance to stop its adapter. Services
        // that cannot drain are then killed and reaped; tests never leave background daemons.
        let _ = Command::new("/bin/kill")
            .args(["-TERM", &self.child.id().to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if matches!(self.child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

struct Services {
    gateway: Process,
    control_plane: Process,
    endpoint: String,
}

impl Services {
    async fn start(database: &str, directory: &Path, credentials: &Credentials) -> Result<Self> {
        let mut command = credentials.command();
        command
            .arg("control-plane")
            .env("SUPERTAG_DATABASE_URL", database);
        let mut control_plane = Process::spawn(command, directory, "control-plane", true)?;
        let private = control_plane.endpoint().await?;
        let mut command = credentials.command();
        command.args(["gateway", "--control-plane", &private]);
        let mut gateway = Process::spawn(command, directory, "gateway", true)?;
        let endpoint = gateway.endpoint().await?;
        Ok(Self {
            gateway,
            control_plane,
            endpoint,
        })
    }

    fn crash(&mut self) -> Result<()> {
        self.gateway.crash()?;
        self.control_plane.crash()?;
        Ok(())
    }

    async fn client(&self) -> Result<OperatorClient<Channel>> {
        let endpoint = Channel::from_shared(self.endpoint.clone())?
            .connect_timeout(Duration::from_secs(3))
            .timeout(Duration::from_secs(3));
        Ok(OperatorClient::new(endpoint.connect().await?))
    }
}

async fn cli(mut command: Command, directory: &Path, args: &[&str]) -> Result<Value> {
    command.args(args);
    let mut process = Process::spawn(command, directory, "cli", false)?;
    process.successful_exit().await?;
    let output = std::fs::read(process.log.with_extension("stdout"))?;
    Ok(serde_json::from_slice(&output)?)
}

fn worker(
    services: &Services,
    directory: &Path,
    credentials: &Credentials,
    cancel: bool,
) -> Result<Process> {
    let mut command = credentials.command();
    command
        .args([
            "worker-host",
            "--gateway",
            &services.endpoint,
            "--adapter",
            ADAPTER,
            "--once",
        ])
        .arg("--state-directory")
        .arg(directory.join(if cancel { "cancel-host" } else { "host" }));
    if cancel {
        command.arg("--adapter-arg=--wait-for-cancel");
    }
    Process::spawn(command, directory, "worker-host", false)
}

async fn task(
    client: &mut OperatorClient<Channel>,
    credentials: &Credentials,
    id: &str,
) -> Result<Task> {
    Ok(client
        .get_task(credentials.request(GetTaskRequest { task_id: id.into() })?)
        .await?
        .into_inner())
}

async fn events(
    client: &mut OperatorClient<Channel>,
    credentials: &Credentials,
    id: &str,
    after: u64,
) -> Result<Vec<TaskEvent>> {
    Ok(client
        .list_events(credentials.request(ListEventsRequest {
            task_id: id.into(),
            after_sequence: after,
            limit: 100,
        })?)
        .await?
        .into_inner()
        .events)
}

async fn wait_for_state(
    client: &mut OperatorClient<Channel>,
    credentials: &Credentials,
    id: &str,
    expected: TaskState,
) -> Result<Task> {
    let deadline = Instant::now() + WAIT;
    loop {
        let observed = task(client, credentials, id).await?;
        if observed.state() == expected {
            return Ok(observed);
        }
        ensure!(
            Instant::now() < deadline,
            "expected {expected:?}, observed {:?} with result {:?}",
            observed.state(),
            observed.result
        );
        sleep(Duration::from_millis(10)).await;
    }
}

async fn exercise_split_runtime(database: &str, directory: &Path) -> Result<()> {
    let credentials = Credentials::new();
    let mut services = Services::start(database, directory, &credentials).await?;
    cli(
        credentials.command(),
        directory,
        &[
            "put-tag",
            "--gateway",
            &services.endpoint,
            "engineer",
            "--instructions",
            "Review carefully",
            "--allow",
            "files:read",
        ],
    )
    .await?;
    let submitted = cli(
        credentials.command(),
        directory,
        &[
            "submit",
            "--gateway",
            &services.endpoint,
            "--tag",
            "engineer",
            "--session",
            "review",
            "--operation-id",
            "same-submit",
            "inspect repository",
        ],
    )
    .await?;
    let id = submitted["task_id"]
        .as_str()
        .context("submit CLI did not return a Task identity")?
        .to_owned();
    let mut client = services.client().await?;
    let accepted = task(&mut client, &credentials, &id).await?;
    assert_eq!(accepted.state(), TaskState::Queued);
    assert_eq!(accepted.tag_revision, 1);
    assert_eq!(accepted.instructions, "Review carefully");
    assert_eq!(accepted.allowed_actions, ["files:read"]);

    let edited = client
        .put_tag(credentials.request(PutTagRequest {
            name: None,
            expected_revision: None,
            approval_rules: vec![],
            harness_kind: 0,
            workspace: None,
            tag_id: "engineer".into(),
            instructions: "New responsibility".into(),
            execution: None,
            allowed_actions: vec!["files:write".into()],
        })?)
        .await?
        .into_inner();
    assert_eq!(edited.revision, 2);
    let submit = SubmitTaskRequest {
        output_policy: None,
        execution_limits: None,
        tag_id: "engineer".into(),
        session_id: "review".into(),
        operation_id: "same-submit".into(),
        prompt: "inspect repository".into(),
        input_artifacts: vec![],
    };
    let retried = client
        .submit_task(credentials.request(submit.clone())?)
        .await?
        .into_inner();
    assert_eq!(
        retried, accepted,
        "a retry must recover accepted policy, even after a Tag edit"
    );
    let conflict = client
        .submit_task(credentials.request(SubmitTaskRequest {
            prompt: "different intent".into(),
            ..submit.clone()
        })?)
        .await
        .unwrap_err();
    assert_eq!(conflict.code(), Code::AlreadyExists);

    let mut host = worker(&services, directory, &credentials, false)?;
    let completed = wait_for_state(&mut client, &credentials, &id, TaskState::Succeeded).await?;
    host.successful_exit().await?;
    assert_eq!(
        completed.result.as_deref(),
        Some("Review carefully: inspect repository [files:read]")
    );
    assert_eq!(completed.instructions, accepted.instructions);
    assert_eq!(completed.allowed_actions, accepted.allowed_actions);
    let recorded = events(&mut client, &credentials, &id, 0).await?;
    assert_eq!(
        recorded
            .iter()
            .map(|event| event.sequence)
            .collect::<Vec<_>>(),
        [1, 2]
    );
    assert_eq!(recorded[1].text, completed.result.as_deref().unwrap());

    // Hard stop independent service processes after completion, then reopen their real SQL state.
    drop(client);
    services.crash()?;
    services = Services::start(database, directory, &credentials).await?;
    client = services.client().await?;
    assert_eq!(task(&mut client, &credentials, &id).await?, completed);
    assert_eq!(
        client
            .submit_task(credentials.request(submit)?)
            .await?
            .into_inner(),
        completed
    );
    assert_eq!(events(&mut client, &credentials, &id, 0).await?, recorded);
    assert_eq!(
        events(&mut client, &credentials, &id, 1).await?,
        recorded[1..]
    );
    let mut restarted_host = worker(&services, directory, &credentials, false)?;
    restarted_host.successful_exit().await?;
    assert_eq!(
        events(&mut client, &credentials, &id, 0).await?,
        recorded,
        "restarting the host must not rerun completed work"
    );

    let cancel = client
        .submit_task(credentials.request(SubmitTaskRequest {
            output_policy: None,
            execution_limits: None,
            tag_id: "engineer".into(),
            session_id: "cancel".into(),
            operation_id: "cancel-submit".into(),
            prompt: "wait for an operator".into(),
            input_artifacts: vec![],
        })?)
        .await?
        .into_inner();
    assert_eq!(cancel.tag_revision, 2);
    assert_eq!(cancel.allowed_actions, ["files:write"]);
    let mut cancel_host = worker(&services, directory, &credentials, true)?;
    wait_for_state(
        &mut client,
        &credentials,
        &cancel.task_id,
        TaskState::Running,
    )
    .await?;
    let deadline = Instant::now() + WAIT;
    while events(&mut client, &credentials, &cancel.task_id, 0)
        .await?
        .is_empty()
    {
        ensure!(
            Instant::now() < deadline,
            "adapter never emitted its initial event"
        );
        sleep(Duration::from_millis(10)).await;
    }
    let adapters = descendants(cancel_host.child.id())?;
    assert!(
        !adapters.is_empty(),
        "the waiting fixture must still be running"
    );
    client
        .cancel_task(credentials.request(CancelTaskRequest {
            task_id: cancel.task_id.clone(),
        })?)
        .await?;
    cancel_host.successful_exit().await?;
    for pid in adapters {
        assert!(
            !process_exists(pid)?,
            "cancelled adapter {pid} was not reaped"
        );
    }
    let cancelled = task(&mut client, &credentials, &cancel.task_id).await?;
    assert_eq!(cancelled.state(), TaskState::Cancelled);
    assert!(cancelled.result.is_none());
    let cancelled_events = events(&mut client, &credentials, &cancel.task_id, 0).await?;
    assert_eq!(
        cancelled_events.len(),
        1,
        "cancelled adapter must not publish its final result"
    );
    assert_eq!(cancelled_events[0].sequence, 1);
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sqlite_separate_processes_preserve_work_and_cancel_execution() -> Result<()> {
    let directory = TempDir::new()?;
    let database = format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("state.db").display()
    );
    exercise_split_runtime(&database, directory.path()).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires an isolated PostgreSQL server via SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"]
async fn postgres_separate_processes_preserve_work_and_cancel_execution() -> Result<()> {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .context("PostgreSQL process integration requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")?;
    let admin_url = std::fs::read_to_string(path)?;
    let options = PgConnectOptions::from_str(admin_url.trim())?;
    let mut admin = PgConnection::connect_with(&options).await?;
    let name = format!("supertag_rust_split_{}", Uuid::new_v4().simple());
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await?;
    let database = options.database(&name).to_url_lossy().to_string();
    let directory = TempDir::new()?;
    let path = directory.path().to_owned();
    // Isolate assertion panics so database cleanup also runs when a behavioral check fails.
    let result = tokio::spawn(async move { exercise_split_runtime(&database, &path).await }).await;
    // Every process has been reaped before the disposable database is removed.
    let cleanup = admin
        .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
        .await;
    admin.close().await?;
    cleanup?;
    result.context("PostgreSQL process test panicked")?
}

fn local_command() -> Command {
    let mut command = Command::new(BINARY);
    command.env_clear().stdin(Stdio::null());
    command
}

fn direct_children(parent: u32) -> Result<Vec<u32>> {
    // The same ps fields work on supported macOS and Linux hosts. Listing only numeric
    // identifiers avoids collecting command arguments or credentials from unrelated processes.
    let output = Command::new("/bin/ps")
        .args(["-axo", "pid=,ppid="])
        .output()?;
    ensure!(
        output.status.success(),
        "could not inspect supervisor children"
    );
    let mut children = Vec::new();
    for line in String::from_utf8(output.stdout)?.lines() {
        let mut fields = line.split_whitespace();
        let pid = fields
            .next()
            .context("missing process ID")?
            .parse::<u32>()?;
        let ppid = fields.next().context("missing parent ID")?.parse::<u32>()?;
        if ppid == parent {
            children.push(pid);
        }
    }
    Ok(children)
}

fn process_exists(pid: u32) -> Result<bool> {
    Ok(Command::new("/bin/kill")
        .args(["-0", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()?
        .success())
}

fn descendants(parent: u32) -> Result<Vec<u32>> {
    let mut result = direct_children(parent)?;
    let mut index = 0;
    while index < result.len() {
        result.extend(direct_children(result[index])?);
        index += 1;
    }
    Ok(result)
}

fn local_credentials(state: &Path) -> Result<Credentials> {
    let value: Value = serde_json::from_slice(&std::fs::read(state.join("credentials.json"))?)?;
    let token = |name: &str| -> Result<String> {
        Ok(value[name]
            .as_str()
            .context("missing local credential")?
            .into())
    };
    Ok(Credentials {
        gateway: token("gateway_token")?,
        operator: token("operator_token")?,
        host: token("host_token")?,
    })
}

async fn local_up(
    directory: &Path,
    state: &Path,
    adapter: &Path,
    waiting: bool,
) -> Result<(Process, OperatorClient<Channel>)> {
    let mut command = local_command();
    command
        .arg("up")
        .arg("--state-directory")
        .arg(state)
        .arg("--adapter")
        .arg(adapter);
    if waiting {
        command.arg("--adapter-arg=--wait-for-cancel");
    }
    let mut supervisor = Process::spawn(command, directory, "up", true)?;
    let endpoint = supervisor.endpoint().await?;
    let channel = Channel::from_shared(endpoint)?
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(3))
        .connect()
        .await?;
    Ok((supervisor, OperatorClient::new(channel)))
}

fn recording_adapter(directory: &Path) -> Result<(PathBuf, PathBuf)> {
    use std::os::unix::fs::PermissionsExt;

    let script = directory.join("recording-adapter");
    let launches = directory.join("adapter-launches");
    let quote = |path: &Path| -> Result<String> {
        Ok(format!(
            "'{}'",
            path.to_str()
                .context("adapter path is not UTF-8")?
                .replace('\'', "'\\''")
        ))
    };
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\nprintf '%s\\n' \"$$\" >> {}\nexec {} \"$@\"\n",
            quote(&launches)?,
            quote(Path::new(ADAPTER))?
        ),
    )?;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700))?;
    Ok((script, launches))
}

/// Failure cleanup for descendants of a deliberately killed test-owned host.
/// Kill leaves first so a surviving guardian can reap its adapter before exiting.
struct DescendantCleanup(Vec<u32>);

impl DescendantCleanup {
    async fn wait_and_disarm(&mut self) -> Result<()> {
        let deadline = Instant::now() + WAIT;
        loop {
            let mut alive = Vec::new();
            for pid in &self.0 {
                if process_exists(*pid)? {
                    alive.push(*pid);
                }
            }
            if alive.is_empty() {
                self.0.clear();
                return Ok(());
            }
            ensure!(
                Instant::now() < deadline,
                "test-owned descendants did not exit: {alive:?}"
            );
            sleep(Duration::from_millis(10)).await;
        }
    }
}

impl Drop for DescendantCleanup {
    fn drop(&mut self) {
        for pid in self.0.iter().rev() {
            if !process_exists(*pid).unwrap_or(false) {
                continue;
            }
            let _ = Command::new("/bin/kill")
                .args(["-KILL", &pid.to_string()])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            let deadline = Instant::now() + Duration::from_secs(2);
            while Instant::now() < deadline && process_exists(*pid).unwrap_or(false) {
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn killed_worker_host_stops_adapter_and_restart_fails_closed_without_rerunning() -> Result<()>
{
    use std::os::unix::process::ExitStatusExt;

    let directory = TempDir::new()?;
    let database = format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("host-death.db").display()
    );
    let credentials = Credentials::new();
    let services = Services::start(&database, directory.path(), &credentials).await?;
    let mut client = services.client().await?;
    client
        .put_tag(credentials.request(PutTagRequest {
            name: None,
            expected_revision: None,
            approval_rules: vec![],
            harness_kind: 0,
            workspace: None,
            tag_id: "engineer".into(),
            instructions: "Require explicit recovery".into(),
            execution: None,
            allowed_actions: vec!["files:read".into()],
        })?)
        .await?;
    let accepted = client
        .submit_task(credentials.request(SubmitTaskRequest {
            output_policy: None,
            execution_limits: None,
            tag_id: "engineer".into(),
            session_id: "interrupted".into(),
            operation_id: "host-killed".into(),
            prompt: "wait for host death".into(),
            input_artifacts: vec![],
        })?)
        .await?
        .into_inner();
    let (adapter, launches) = recording_adapter(directory.path())?;
    let state = directory.path().join("host");
    let host_command = || {
        let mut command = credentials.command();
        command
            .args([
                "worker-host",
                "--gateway",
                &services.endpoint,
                "--once",
                "--state-directory",
            ])
            .arg(&state)
            .arg("--adapter")
            .arg(&adapter)
            .arg("--adapter-arg=--wait-for-cancel");
        command
    };
    let mut host = Process::spawn(host_command(), directory.path(), "killed-host", false)?;
    let running = wait_for_state(
        &mut client,
        &credentials,
        &accepted.task_id,
        TaskState::Running,
    )
    .await?;
    let deadline = Instant::now() + WAIT;
    let recorded = loop {
        let recorded = events(&mut client, &credentials, &accepted.task_id, 0).await?;
        if !recorded.is_empty() {
            break recorded;
        }
        ensure!(Instant::now() < deadline, "fixture never became active");
        sleep(Duration::from_millis(10)).await;
    };
    assert_eq!(recorded.len(), 1);
    let adapter_pids = std::fs::read_to_string(&launches)?
        .lines()
        .map(str::parse::<u32>)
        .collect::<std::result::Result<Vec<_>, _>>()?;
    assert_eq!(adapter_pids.len(), 1);
    let adapter_pid = adapter_pids[0];
    let descendants = descendants(host.child.id())?;
    assert!(
        descendants.contains(&adapter_pid),
        "wrapper PID must identify this host's actual adapter"
    );
    assert_eq!(
        descendants.len(),
        2,
        "fixture must run beneath its dedicated guardian"
    );
    let mut cleanup = DescendantCleanup(descendants);
    let journal_path = state.join("attempt.json");
    let journal = std::fs::read(&journal_path)?;
    let entry: Value = serde_json::from_slice(&journal)?;
    assert_eq!(entry["stage"], "executing");
    assert_eq!(entry["task_id"], accepted.task_id);
    assert_eq!(host.crash()?.signal(), Some(libc::SIGKILL));
    cleanup.wait_and_disarm().await?;
    assert!(
        !process_exists(adapter_pid)?,
        "actual fixture survived its host"
    );
    assert_eq!(
        std::fs::read(&journal_path)?,
        journal,
        "uncertain execution must retain its original recovery record"
    );

    let queued = client
        .submit_task(credentials.request(SubmitTaskRequest {
            output_policy: None,
            execution_limits: None,
            tag_id: "engineer".into(),
            session_id: "other-session".into(),
            operation_id: "work-after-host-death".into(),
            prompt: "do not claim before recovery".into(),
            input_artifacts: vec![],
        })?)
        .await?
        .into_inner();
    let mut restarted = Process::spawn(host_command(), directory.path(), "restarted-host", false)?;
    assert!(
        !restarted.exited().await?.success(),
        "uncertain host restart must fail closed"
    );
    assert!(
        restarted
            .logs()
            .contains("needs recovery before this host can claim work")
    );
    assert_eq!(
        std::fs::read_to_string(&launches)?.lines().count(),
        1,
        "restart must not launch the adapter again"
    );
    assert_eq!(std::fs::read(&journal_path)?, journal);
    assert_eq!(
        task(&mut client, &credentials, &accepted.task_id).await?,
        running,
        "host death must not invent a recovered or completed outcome"
    );
    assert_eq!(
        events(&mut client, &credentials, &accepted.task_id, 0).await?,
        recorded
    );
    assert_eq!(
        task(&mut client, &credentials, &queued.task_id)
            .await?
            .state(),
        TaskState::Queued
    );
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn killed_local_supervisor_stops_services_and_refuses_stale_endpoint() -> Result<()> {
    use std::os::unix::process::ExitStatusExt;

    let directory = TempDir::new()?;
    let state = directory.path().join("local-state");
    let (mut supervisor, client) =
        local_up(directory.path(), &state, Path::new(ADAPTER), false).await?;
    drop(client);
    let children = direct_children(supervisor.child.id())?;
    assert_eq!(children.len(), 3);
    let mut cleanup = DescendantCleanup(children);
    assert_eq!(supervisor.crash()?.signal(), Some(libc::SIGKILL));
    cleanup.wait_and_disarm().await?;
    let endpoint = state.join("endpoint");
    assert!(
        endpoint.exists(),
        "SIGKILL cannot run the supervisor's endpoint cleanup"
    );

    // A stale address could be reassigned to another process. Put a real listener
    // behind it and prove the CLI refuses local state before opening a connection.
    let stale = std::net::TcpListener::bind("127.0.0.1:0")?;
    stale.set_nonblocking(true)?;
    std::fs::write(&endpoint, format!("http://{}\n", stale.local_addr()?))?;
    let mut command = local_command();
    command
        .arg("get-task")
        .arg("--state-directory")
        .arg(&state)
        .arg("untrusted-stale-endpoint");
    let mut rejected = Process::spawn(command, directory.path(), "stale-cli", false)?;
    assert!(!rejected.exited().await?.success());
    assert!(
        rejected
            .logs()
            .contains("local SuperTag services are not running"),
        "unexpected stale-state rejection: {}",
        rejected.logs()
    );
    match stale.accept() {
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
        Err(error) => return Err(error.into()),
        Ok(_) => return Err(anyhow!("CLI connected to the stale local endpoint")),
    }
    drop(stale);

    let (mut restarted, mut client) =
        local_up(directory.path(), &state, Path::new(ADAPTER), false).await?;
    let credentials = local_credentials(&state)?;
    client
        .put_tag(credentials.request(PutTagRequest {
            name: None,
            expected_revision: None,
            approval_rules: vec![],
            harness_kind: 0,
            workspace: None,
            tag_id: "after-supervisor-death".into(),
            instructions: "Local startup is live".into(),
            execution: None,
            allowed_actions: vec!["files:read".into()],
        })?)
        .await?;
    let children = direct_children(restarted.child.id())?;
    assert_eq!(children.len(), 3);
    restarted.terminate()?;
    restarted.successful_exit().await?;
    for pid in children {
        assert!(
            !process_exists(pid)?,
            "restarted service {pid} was not reaped"
        );
    }
    assert!(!endpoint.exists());
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn local_shutdown_replays_finish_before_next_session_task_without_rerunning_adapter()
-> Result<()> {
    let directory = TempDir::new()?;
    let state = directory.path().join("local-state");
    let (adapter, launches) = recording_adapter(directory.path())?;
    let (mut supervisor, mut client) = local_up(directory.path(), &state, &adapter, true).await?;
    let credentials = local_credentials(&state)?;
    client
        .put_tag(credentials.request(PutTagRequest {
            name: None,
            expected_revision: None,
            approval_rules: vec![],
            harness_kind: 0,
            workspace: None,
            tag_id: "engineer".into(),
            instructions: "Resume safely".into(),
            execution: None,
            allowed_actions: vec!["files:read".into()],
        })?)
        .await?;
    let first = client
        .submit_task(credentials.request(SubmitTaskRequest {
            output_policy: None,
            execution_limits: None,
            tag_id: "engineer".into(),
            session_id: "same-session".into(),
            operation_id: "interrupted".into(),
            prompt: "wait during shutdown".into(),
            input_artifacts: vec![],
        })?)
        .await?
        .into_inner();
    wait_for_state(
        &mut client,
        &credentials,
        &first.task_id,
        TaskState::Running,
    )
    .await?;
    let deadline = Instant::now() + WAIT;
    let before = loop {
        let recorded = events(&mut client, &credentials, &first.task_id, 0).await?;
        if !recorded.is_empty() {
            break recorded;
        }
        ensure!(
            Instant::now() < deadline,
            "waiting adapter did not publish its first event"
        );
        sleep(Duration::from_millis(10)).await;
    };
    assert_eq!(before.len(), 1);
    assert_eq!(std::fs::read_to_string(&launches)?.lines().count(), 1);
    let running = task(&mut client, &credentials, &first.task_id).await?;
    let next = client
        .submit_task(credentials.request(SubmitTaskRequest {
            output_policy: None,
            execution_limits: None,
            tag_id: "engineer".into(),
            session_id: "same-session".into(),
            operation_id: "next".into(),
            prompt: "continue after shutdown".into(),
            input_artifacts: vec![],
        })?)
        .await?
        .into_inner();
    assert_eq!(next.state(), TaskState::Queued);

    let children = direct_children(supervisor.child.id())?;
    assert_eq!(children.len(), 3);
    let mut adapters = Vec::new();
    for child in &children {
        adapters.extend(descendants(*child)?);
    }
    assert!(
        !adapters.is_empty(),
        "waiting adapter must be alive before shutdown"
    );
    supervisor.terminate()?;
    supervisor.successful_exit().await?;
    drop(client);
    for pid in children.into_iter().chain(adapters) {
        assert!(!process_exists(pid)?, "shutdown did not reap process {pid}");
    }
    assert!(!state.join("endpoint").exists());
    let journal: Value = serde_json::from_slice(&std::fs::read(state.join("host/attempt.json"))?)?;
    assert_eq!(
        journal["stage"], "finish",
        "shutdown must durably record the stopped execution"
    );
    assert_eq!(journal["task_id"], first.task_id);
    assert_eq!(
        journal["attempt_id"].as_str(),
        running.attempt_id.as_deref()
    );
    assert_eq!(journal["succeeded"], false);

    let (mut restarted, mut client) = local_up(directory.path(), &state, &adapter, false).await?;
    let failed =
        wait_for_state(&mut client, &credentials, &first.task_id, TaskState::Failed).await?;
    assert_eq!(failed.attempt_id, running.attempt_id);
    assert_eq!(
        failed.result.as_deref(),
        Some("Harness execution was interrupted")
    );
    let completed = wait_for_state(
        &mut client,
        &credentials,
        &next.task_id,
        TaskState::Succeeded,
    )
    .await?;
    assert_eq!(
        completed.result.as_deref(),
        Some("Resume safely: continue after shutdown [files:read]")
    );
    assert_eq!(
        events(&mut client, &credentials, &first.task_id, 0).await?,
        before
    );
    assert_eq!(
        events(&mut client, &credentials, &next.task_id, 0)
            .await?
            .len(),
        2
    );
    assert_eq!(
        std::fs::read_to_string(&launches)?.lines().count(),
        2,
        "restart must run only the next Task, not replay the interrupted adapter"
    );
    let children = direct_children(restarted.child.id())?;
    restarted.terminate()?;
    restarted.successful_exit().await?;
    for pid in children {
        assert!(
            !process_exists(pid)?,
            "restarted service {pid} was not reaped"
        );
    }
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn local_up_runs_work_and_reaps_its_services() -> Result<()> {
    use std::os::unix::fs::PermissionsExt;

    let directory = TempDir::new()?;
    // Exercise state-directory paths requiring SQLite URL escaping as well as shell quoting.
    let state = directory.path().join("local state ?");
    let state_arg = state.to_str().context("temporary directory is not UTF-8")?;
    let mut command = local_command();
    command.args(["up", "--state-directory", state_arg, "--adapter", ADAPTER]);
    let mut supervisor = Process::spawn(command, directory.path(), "up", true)?;
    let endpoint = supervisor.endpoint().await?;
    assert_eq!(
        std::fs::read_to_string(state.join("endpoint"))?.trim(),
        endpoint
    );
    for name in ["credentials.json", "endpoint"] {
        assert_eq!(
            std::fs::metadata(state.join(name))?.permissions().mode() & 0o777,
            0o600,
            "local connection information must remain private"
        );
    }

    cli(
        local_command(),
        directory.path(),
        &[
            "put-tag",
            "--state-directory",
            state_arg,
            "local-engineer",
            "--instructions",
            "Check local startup",
            "--allow",
            "files:read",
        ],
    )
    .await?;
    let submitted = cli(
        local_command(),
        directory.path(),
        &[
            "submit",
            "--state-directory",
            state_arg,
            "--tag",
            "local-engineer",
            "--session",
            "local",
            "--operation-id",
            "local-startup",
            "inspect local repository",
        ],
    )
    .await?;
    let id = submitted["task_id"]
        .as_str()
        .context("submit did not return Task identity")?;
    let deadline = Instant::now() + WAIT;
    loop {
        let observed = cli(
            local_command(),
            directory.path(),
            &["get-task", "--state-directory", state_arg, id],
        )
        .await?;
        if observed["state"] == "TASK_STATE_SUCCEEDED" {
            assert_eq!(
                observed["result"],
                "Check local startup: inspect local repository [files:read]"
            );
            break;
        }
        ensure!(
            Instant::now() < deadline,
            "local Task did not complete: {observed}"
        );
        sleep(Duration::from_millis(10)).await;
    }

    let children = direct_children(supervisor.child.id())?;
    assert_eq!(
        children.len(),
        3,
        "local startup must supervise three separate services"
    );
    supervisor.terminate()?;
    supervisor.successful_exit().await?;
    assert!(
        !state.join("endpoint").exists(),
        "stopped endpoint must not remain discoverable"
    );
    for pid in children {
        assert!(
            !process_exists(pid)?,
            "supervised process {pid} was not reaped"
        );
    }
    let address: SocketAddr = endpoint.trim_start_matches("http://").parse()?;
    assert!(
        tokio::time::timeout(
            Duration::from_secs(2),
            tokio::net::TcpStream::connect(address)
        )
        .await?
        .is_err(),
        "Gateway still accepts connections after local shutdown"
    );
    Ok(())
}

const SLACK_ACCOUNT: &str = "slack-process-test";
const SLACK_TEAM: &str = "TTEAM1";
const SLACK_CHANNEL: &str = "CCHANNEL1";
const SLACK_USER: &str = "UALICE1";
const SLACK_EVENT: &str = "EvPROCESS1";
const SLACK_THREAD: &str = "1794469999.012345";
const SLACK_RECEIPT: &str = "1794470001.111111";
const SLACK_BOT_TOKEN: &str = "xoxb-synthetic-process-test";
const SLACK_SIGNING_SECRET: &str = "synthetic-process-test-signing-secret";

struct MockSlackRequest {
    path: String,
    authorization: String,
    body: Value,
}

struct MockSlackApi {
    endpoint: String,
    requests: Arc<Mutex<Vec<MockSlackRequest>>>,
    responses: Arc<Semaphore>,
    server: tokio::task::JoinHandle<Result<()>>,
}

impl MockSlackApi {
    async fn start() -> Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let endpoint = format!("http://{}/chat.postMessage", listener.local_addr()?);
        let requests = Arc::new(Mutex::new(Vec::new()));
        let responses = Arc::new(Semaphore::new(0));
        let recorded = requests.clone();
        let release = responses.clone();
        let server = tokio::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await?;
                let request =
                    tokio::time::timeout(Duration::from_secs(5), read_mock_request(&mut stream))
                        .await??;
                recorded.lock().await.push(request);
                // The test controls the provider acknowledgement, allowing it to make the
                // Control Plane unavailable before the Gateway stores the real receipt.
                release.acquire().await?.forget();
                let body =
                    serde_json::json!({"ok": true, "channel": SLACK_CHANNEL, "ts": SLACK_RECEIPT})
                        .to_string();
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(response.as_bytes()).await?;
                stream.shutdown().await?;
            }
        });
        Ok(Self {
            endpoint,
            requests,
            responses,
            server,
        })
    }

    async fn wait_for_request(&self) -> Result<()> {
        let deadline = Instant::now() + WAIT;
        loop {
            if !self.requests.lock().await.is_empty() {
                return Ok(());
            }
            ensure!(
                !self.server.is_finished(),
                "mock Slack server exited unexpectedly"
            );
            ensure!(
                Instant::now() < deadline,
                "Gateway did not send its reply to the mock Slack API"
            );
            sleep(Duration::from_millis(10)).await;
        }
    }
}

impl Drop for MockSlackApi {
    fn drop(&mut self) {
        self.server.abort();
    }
}

async fn read_mock_request(stream: &mut TcpStream) -> Result<MockSlackRequest> {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 4096];
    let header_end = loop {
        if let Some(offset) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            break offset + 4;
        }
        ensure!(bytes.len() < 16_384, "mock HTTP request headers too large");
        let count = stream.read(&mut buffer).await?;
        ensure!(count != 0, "mock HTTP request ended before its headers");
        bytes.extend_from_slice(&buffer[..count]);
    };
    let headers = std::str::from_utf8(&bytes[..header_end])?;
    let mut lines = headers.lines();
    let request = lines.next().context("missing mock request line")?;
    let path = request
        .strip_prefix("POST ")
        .and_then(|line| line.strip_suffix(" HTTP/1.1"))
        .context("unexpected mock HTTP request")?
        .to_owned();
    let mut length = None;
    let mut authorization = None;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.eq_ignore_ascii_case("content-length") {
            length = Some(value.trim().parse::<usize>()?);
        }
        if name.eq_ignore_ascii_case("authorization") {
            authorization = Some(value.trim().to_owned());
        }
    }
    let length = length.context("mock JSON request must have Content-Length")?;
    ensure!(length <= 1_048_576, "mock HTTP body too large");
    while bytes.len() < header_end + length {
        let count = stream.read(&mut buffer).await?;
        ensure!(count != 0, "mock HTTP request ended before its body");
        bytes.extend_from_slice(&buffer[..count]);
    }
    Ok(MockSlackRequest {
        path,
        authorization: authorization.context("mock request omitted Authorization")?,
        body: serde_json::from_slice(&bytes[header_end..header_end + length])?,
    })
}

async fn signed_slack_event(endpoint: &str, prompt: &str) -> Result<reqwest::StatusCode> {
    let body = serde_json::json!({
        "type": "event_callback", "team_id": SLACK_TEAM, "event_id": SLACK_EVENT,
        "event": { "type": "app_mention", "channel": SLACK_CHANNEL, "user": SLACK_USER,
            "text": prompt, "ts": "1794470000.123456", "thread_ts": SLACK_THREAD }
    })
    .to_string();
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)?
        .as_secs()
        .to_string();
    let mut mac = Hmac::<Sha256>::new_from_slice(SLACK_SIGNING_SECRET.as_bytes())?;
    mac.update(format!("v0:{timestamp}:{body}").as_bytes());
    let signature = format!("v0={:x}", mac.finalize().into_bytes());
    Ok(reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()?
        .post(format!("{endpoint}/slack/events"))
        .header("content-type", "application/json")
        .header("x-slack-request-timestamp", timestamp)
        .header("x-slack-signature", signature)
        .body(body)
        .send()
        .await?
        .status())
}

async fn slack_gateway(
    credentials: &Credentials,
    private_endpoint: &str,
    directory: &Path,
    mock: &MockSlackApi,
) -> Result<(Process, String, String)> {
    let mut command = credentials.command();
    command
        .args([
            "gateway",
            "--control-plane",
            private_endpoint,
            "--slack-listen",
            "127.0.0.1:0",
            "--slack-state-directory",
        ])
        .arg(directory.join("slack"))
        .env("SUPERTAG_SLACK_ACCOUNT_ID", SLACK_ACCOUNT)
        .env("SUPERTAG_SLACK_TEAM_ID", SLACK_TEAM)
        .env("SUPERTAG_SLACK_CHANNEL_ID", SLACK_CHANNEL)
        .env("SUPERTAG_SLACK_TAG_ID", "slack-engineer")
        .env("SUPERTAG_SLACK_ALLOWED_USERS", SLACK_USER)
        .env("SUPERTAG_SLACK_SIGNING_SECRET", SLACK_SIGNING_SECRET)
        .env("SUPERTAG_SLACK_BOT_TOKEN", SLACK_BOT_TOKEN)
        .env("SUPERTAG_TEST_SLACK_API_URL", &mock.endpoint);
    let mut gateway = Process::spawn(command, directory, "slack-gateway", true)?;
    let endpoints = gateway.endpoints(2).await?;
    Ok((gateway, endpoints[0].clone(), endpoints[1].clone()))
}

fn connector_request<T>(credentials: &Credentials, message: T) -> Result<Request<T>> {
    let mut request = authenticated_request(
        message,
        &credentials.gateway,
        Some(&format!("connector:{SLACK_ACCOUNT}")),
    )?;
    request.set_timeout(Duration::from_secs(3));
    Ok(request)
}

async fn wait_for_reply_journal(path: &Path, stage: &str) -> Result<Value> {
    let deadline = Instant::now() + WAIT;
    loop {
        match std::fs::read(path) {
            Ok(bytes) => {
                let value: Value = serde_json::from_slice(&bytes)?;
                if value["entry"]["stage"] == stage {
                    return Ok(value);
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        ensure!(
            Instant::now() < deadline,
            "Gateway did not persist reply journal stage {stage}"
        );
        sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn signed_slack_event_and_reply_receipt_survive_gateway_restart_without_resending()
-> Result<()> {
    use supertag_protocol::v2::{
        AcceptSlackEventRequest, DeleteSurfaceLocationRequest, PutSurfaceAccountRequest,
        PutSurfaceLocationRequest, SlackSurfaceChannel, SlackSurfaceIdentity, SurfaceAccount,
        SurfaceAccountIdentity, SurfaceLocation, SurfaceLocationScope, surface_account_identity,
        surface_location_scope, surface_policy_catalog_client::SurfacePolicyCatalogClient,
    };
    let directory = TempDir::new()?;
    let database = format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("slack.db").display()
    );
    let credentials = Credentials::new();
    let mock = MockSlackApi::start().await?;
    let mut command = credentials.command();
    command
        .arg("control-plane")
        .env("SUPERTAG_DATABASE_URL", &database);
    let mut control_plane = Process::spawn(command, directory.path(), "control-plane", true)?;
    let private_endpoint = control_plane.endpoint().await?;
    let (gateway, endpoint, http) =
        slack_gateway(&credentials, &private_endpoint, directory.path(), &mock).await?;
    let mut services = Services {
        gateway,
        control_plane,
        endpoint,
    };
    let mut operator = services.client().await?;
    operator
        .put_tag(credentials.request(PutTagRequest {
            name: None,
            expected_revision: None,
            approval_rules: vec![],
            harness_kind: 0,
            workspace: None,
            tag_id: "slack-engineer".into(),
            instructions: "Respond carefully".into(),
            execution: None,
            allowed_actions: vec!["files:read".into()],
        })?)
        .await?;
    let mut policy = SurfacePolicyCatalogClient::connect(services.endpoint.clone()).await?;
    policy
        .put_surface_account(credentials.request(PutSurfaceAccountRequest {
            operation_id: "account-fixture".into(),
            account: Some(SurfaceAccount {
                account_id: "slack-installation".into(),
                enabled: true,
                identity: Some(SurfaceAccountIdentity {
                    provider: Some(surface_account_identity::Provider::Slack(
                        SlackSurfaceIdentity {
                            team_id: SLACK_TEAM.into(),
                        },
                    )),
                }),
                ..Default::default()
            }),
            expected_revision: None,
        })?)
        .await?;
    let location = policy
        .put_surface_location(credentials.request(PutSurfaceLocationRequest {
            operation_id: "location-fixture".into(),
            location: Some(SurfaceLocation {
                location_id: "slack-release".into(),
                account_id: "slack-installation".into(),
                connector_account_id: SLACK_ACCOUNT.into(),
                tag_id: "slack-engineer".into(),
                enabled: true,
                scope: Some(SurfaceLocationScope {
                    provider: Some(surface_location_scope::Provider::Slack(
                        SlackSurfaceChannel {
                            channel_id: SLACK_CHANNEL.into(),
                        },
                    )),
                }),
                ..Default::default()
            }),
            expected_revision: None,
        })?)
        .await?
        .into_inner();
    let prompt = "inspect the fixture repository";
    assert_eq!(
        signed_slack_event(&http, prompt).await?,
        reqwest::StatusCode::OK
    );
    assert_eq!(
        signed_slack_event(&http, prompt).await?,
        reqwest::StatusCode::OK
    );
    // A conflict proves the HTTP acknowledgement followed durable admission. This
    // must succeed before an exact private replay is used to obtain the Task ID.
    assert_eq!(
        signed_slack_event(&http, "different intent").await?,
        reqwest::StatusCode::CONFLICT
    );
    let mut connector = ConnectorClient::connect(private_endpoint.clone()).await?;
    let accepted_input = AcceptSlackEventRequest {
        account_id: SLACK_ACCOUNT.into(),
        event_id: SLACK_EVENT.into(),
        mention_tag_id: Some("slack-engineer".into()),
        team_id: SLACK_TEAM.into(),
        channel_id: SLACK_CHANNEL.into(),
        message_ts: "1794470000.123456".into(),
        thread_ts: SLACK_THREAD.into(),
        prompt: prompt.into(),
    };
    let accepted = connector
        .accept_slack_event(connector_request(&credentials, accepted_input.clone())?)
        .await?
        .into_inner()
        .task
        .context("signed Slack event was not accepted")?;
    assert_eq!(accepted.state(), TaskState::Queued);
    assert_eq!(accepted.allowed_actions, ["files:read"]);
    assert_eq!(
        accepted
            .policy_snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.origin.as_ref())
            .context("verified location was not frozen")?
            .location_id,
        location.location_id
    );
    let mut host = worker(&services, directory.path(), &credentials, false)?;
    let completed = wait_for_state(
        &mut operator,
        &credentials,
        &accepted.task_id,
        TaskState::Succeeded,
    )
    .await?;
    host.successful_exit().await?;
    mock.wait_for_request().await?;
    {
        let requests = mock.requests.lock().await;
        assert_eq!(requests.len(), 1);
        let request = &requests[0];
        assert_eq!(request.path, "/chat.postMessage");
        assert_eq!(request.authorization, format!("Bearer {SLACK_BOT_TOKEN}"));
        assert_eq!(
            request.body,
            serde_json::json!({
                "channel": SLACK_CHANNEL, "thread_ts": SLACK_THREAD,
                "text": "Respond carefully: inspect the fixture repository [files:read]",
                "unfurl_links": false, "unfurl_media": false, "mrkdwn": false,
            })
        );
    }

    // Provider success is deliberately acknowledged while durable settlement is
    // unavailable. The real Gateway must preserve the receipt before it is killed.
    drop(operator);
    drop(connector);
    services.control_plane.crash()?;
    mock.responses.add_permits(1);
    let journal = directory.path().join("slack/reply.json");
    let pending = wait_for_reply_journal(&journal, "settle").await?;
    assert_eq!(pending["entry"]["outcome"]["state"], "delivered");
    assert_eq!(
        pending["entry"]["outcome"]["provider_receipt"],
        SLACK_RECEIPT
    );
    services.gateway.crash()?;

    let address = private_endpoint.trim_start_matches("http://");
    let mut command = credentials.command();
    command
        .args(["control-plane", "--listen", address])
        .env("SUPERTAG_DATABASE_URL", &database);
    services.control_plane =
        Process::spawn(command, directory.path(), "restarted-control-plane", true)?;
    assert_eq!(services.control_plane.endpoint().await?, private_endpoint);
    let (gateway, endpoint, http) =
        slack_gateway(&credentials, &private_endpoint, directory.path(), &mock).await?;
    services.gateway = gateway;
    services.endpoint = endpoint;
    let deadline = Instant::now() + WAIT;
    loop {
        match std::fs::read(&journal) {
            Ok(bytes) => {
                let value: Value = serde_json::from_slice(&bytes)?;
                if value["entry"]["stage"] == "claim" {
                    break;
                }
                ensure!(
                    value["entry"]["stage"] == "settle",
                    "restarted Gateway attempted to resend an acknowledged reply"
                );
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => return Err(error.into()),
        }
        ensure!(
            Instant::now() < deadline,
            "Gateway did not finish its recorded settlement"
        );
        sleep(Duration::from_millis(10)).await;
    }
    let mut policy = SurfacePolicyCatalogClient::connect(services.endpoint.clone()).await?;
    policy
        .delete_surface_location(credentials.request(DeleteSurfaceLocationRequest {
            operation_id: "retire-location".into(),
            location_id: location.location_id,
            expected_revision: location.revision,
        })?)
        .await?;
    assert_eq!(
        signed_slack_event(&http, prompt).await?,
        reqwest::StatusCode::OK
    );
    let mut connector = ConnectorClient::connect(private_endpoint).await?;
    let replayed = connector
        .accept_slack_event(connector_request(&credentials, accepted_input)?)
        .await?
        .into_inner()
        .task
        .context("signed Slack replay lost its accepted Task")?;
    assert_eq!(replayed, completed);
    // A replay of the recorded settlement must agree with the stored outcome;
    // settling as failed or uncertain during restart would conflict here.
    let delivered = connector
        .settle_reply(connector_request(
            &credentials,
            SettleReplyRequest {
                reply_id: pending["entry"]["target"]["reply_id"]
                    .as_str()
                    .context("journal omitted reply identity")?
                    .into(),
                lease_token: pending["entry"]["target"]["lease_token"]
                    .as_str()
                    .context("journal omitted reply lease")?
                    .into(),
                state: ReplyState::Delivered as i32,
                provider_receipt: Some(SLACK_RECEIPT.into()),
            },
        )?)
        .await?
        .into_inner();
    assert_eq!(delivered.state(), ReplyState::Delivered);
    assert_eq!(delivered.provider_receipt.as_deref(), Some(SLACK_RECEIPT));
    assert_eq!(delivered.task_id, completed.task_id);
    // Claim as the Gateway's own stable owner identity: only the owner may claim.
    let owner = std::fs::read_to_string(
        journal
            .parent()
            .context("journal has no state directory")?
            .join("connector-owner"),
    )?;
    let lease = connector
        .claim_connector(connector_request(
            &credentials,
            ClaimConnectorRequest {
                owner_id: owner.trim().into(),
            },
        )?)
        .await?
        .into_inner();
    ensure!(
        lease.granted,
        "the Gateway's owner identity was not granted"
    );
    let remaining = connector
        .claim_reply(connector_request(
            &credentials,
            ClaimReplyRequest {
                operation_id: "test-after-settlement".into(),
                connector_lease_token: lease.lease_token,
            },
        )?)
        .await?
        .into_inner();
    assert!(remaining.reply.is_none(), "settled reply was offered again");
    assert_eq!(
        mock.requests.lock().await.len(),
        1,
        "receipt replay must not repeat the provider send"
    );
    let mut operator = services.client().await?;
    assert_eq!(
        events(&mut operator, &credentials, &accepted.task_id, 0)
            .await?
            .len(),
        2
    );
    Ok(())
}

#[tokio::test]
async fn native_codex_records_usage_and_restores_session_after_services_restart() -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    use supertag_protocol::v2::{
        GetInputRequest, LiveInputState, QueueInputRequest, live_inputs_client::LiveInputsClient,
    };

    let directory = tempfile::tempdir()?;
    let state = directory.path().join("local");
    let home = directory.path().join("fixture-home");
    let codex_home = home.join(".codex");
    std::fs::create_dir_all(&codex_home)?;
    let auth = codex_home.join("auth.json");
    std::fs::write(
        &auth,
        r#"{"tokens":{"access_token":"fixture-native-sign-in","refresh_token":"fixture-native-refresh"}}"#,
    )?;
    std::fs::set_permissions(&auth, std::fs::Permissions::from_mode(0o600))?;
    let fake = directory.path().join("codex-fixture");
    std::fs::write(
        &fake,
        include_str!("../../codex-adapter/tests/fixtures/cli_app_server.py"),
    )?;
    std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o700))?;

    let start = || {
        let mut command = local_command();
        command
            .args(["up", "--state-directory"])
            .arg(&state)
            .args(["--harness", "codex", "--codex-path"])
            .arg(&fake)
            .args(["--codex-model", "fixture-model"])
            .env("HOME", &home);
        Process::spawn(command, directory.path(), "native-codex", true)
    };
    let mut supervisor = start()?;
    let endpoint = supervisor.endpoint().await?;
    let channel = Channel::from_shared(endpoint)?
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(3))
        .connect()
        .await?;
    let mut operator = OperatorClient::new(channel);
    let credentials = local_credentials(&state)?;
    let local = state
        .to_str()
        .context("local state directory is not UTF-8")?;
    cli(
        local_command(),
        directory.path(),
        &[
            "put-tag",
            "--state-directory",
            local,
            "native-engineer",
            "--instructions",
            "Validate the local runtime.",
            "--allow",
            "files:read",
        ],
    )
    .await?;
    let objective = cli(
        local_command(),
        directory.path(),
        &[
            "objective",
            "--state-directory",
            local,
            "create",
            "native-objective",
            "--ongoing",
            "--owner",
            "native-engineer",
            "--operation-id",
            "native-start",
            "Verify the native harness",
        ],
    )
    .await?;
    let task_id = objective["starting_task_id"]
        .as_str()
        .context("missing starting Task")?;
    let deadline = Instant::now() + WAIT;
    let settled = loop {
        let observed = task(&mut operator, &credentials, task_id).await?;
        if observed.state() == TaskState::Succeeded {
            break observed;
        }
        ensure!(
            observed.state() != TaskState::Failed,
            "native Codex fixture failed: {:?}",
            observed.result
        );
        ensure!(
            Instant::now() < deadline,
            "native Codex fixture did not finish"
        );
        sleep(Duration::from_millis(10)).await;
    };
    assert_eq!(settled.result.as_deref(), Some("Native adapter verified"));
    let stored = cli(
        local_command(),
        directory.path(),
        &[
            "objective",
            "--state-directory",
            local,
            "get",
            "native-objective",
        ],
    )
    .await?;
    assert_eq!(stored["starting_task_id"].as_str(), Some(task_id));
    assert_eq!(stored["status"], "OBJECTIVE_STATUS_WORKING");
    let usage = cli(
        local_command(),
        directory.path(),
        &[
            "task-usage",
            "--state-directory",
            local,
            task_id,
            settled.attempt_id.as_deref().context("missing Attempt")?,
        ],
    )
    .await?;
    assert_eq!(usage["sequence"], 1);
    assert_eq!(usage["input_tokens"], 4);
    assert_eq!(usage["cached_input_tokens"], 1);
    assert_eq!(usage["output_tokens"], 3);
    assert!(usage["observed_model"].is_null());
    let checkpoints: Vec<_> =
        std::fs::read_dir(state.join("checkpoints"))?.collect::<std::io::Result<_>>()?;
    assert_eq!(checkpoints.len(), 1);
    let archive = &checkpoints[0].path();
    assert_eq!(archive.metadata()?.permissions().mode() & 0o077, 0);
    let original = std::fs::read(archive)?;
    assert!(!String::from_utf8_lossy(&original).contains("fixture-native-sign-in"));

    supervisor.terminate()?;
    supervisor.successful_exit().await?;
    let mut supervisor = start()?;
    let endpoint = supervisor.endpoint().await?;
    let mut inputs =
        LiveInputsClient::new(Channel::from_shared(endpoint.clone())?.connect().await?);
    let mut operator = OperatorClient::new(Channel::from_shared(endpoint)?.connect().await?);
    let session_id = stored["session_id"]
        .as_str()
        .context("missing Session ID")?;
    let resume = |operation_id: &str| {
        credentials.request(SubmitTaskRequest {
            output_policy: None,
            execution_limits: None,
            tag_id: "native-engineer".into(),
            session_id: session_id.into(),
            prompt: "Resume the native harness".into(),
            operation_id: operation_id.into(),
            input_artifacts: vec![],
        })
    };
    // Same-size corruption must fail before another adapter receives the bytes.
    let mut corrupted = original.clone();
    corrupted[0] ^= 1;
    std::fs::write(archive, corrupted)?;
    let bad = operator
        .submit_task(resume("resume-corrupt")?)
        .await?
        .into_inner();
    let bad = wait_for_state(&mut operator, &credentials, &bad.task_id, TaskState::Failed).await?;
    assert_eq!(
        bad.result.as_deref(),
        Some("Session checkpoint could not be restored")
    );
    std::fs::write(archive, original)?;
    let next = operator
        .submit_task(resume("resume-clean")?)
        .await?
        .into_inner();
    let next = wait_for_state(
        &mut operator,
        &credentials,
        &next.task_id,
        TaskState::Succeeded,
    )
    .await?;
    assert_eq!(next.result.as_deref(), Some("Native adapter resumed"));
    let running = operator
        .submit_task(credentials.request(SubmitTaskRequest {
            output_policy: None,
            execution_limits: None,
            tag_id: "native-engineer".into(),
            session_id: session_id.into(),
            prompt: "Wait for live input".into(),
            operation_id: "native-live-steering".into(),
            input_artifacts: vec![],
        })?)
        .await?
        .into_inner();
    wait_for_state(
        &mut operator,
        &credentials,
        &running.task_id,
        TaskState::Running,
    )
    .await?;
    let input = inputs
        .queue_input(credentials.request(QueueInputRequest {
            task_id: running.task_id.clone(),
            operation_id: "native-live-input".into(),
            text: "Use the live correction".into(),
        })?)
        .await?
        .into_inner();
    let steered = wait_for_state(
        &mut operator,
        &credentials,
        &running.task_id,
        TaskState::Succeeded,
    )
    .await?;
    assert_eq!(steered.result.as_deref(), Some("Native adapter steered"));
    let receipt = inputs
        .get_input(credentials.request(GetInputRequest {
            input_id: input.input_id,
        })?)
        .await?
        .into_inner();
    assert_eq!(receipt.state(), LiveInputState::Accepted);
    let follower = task(&mut operator, &credentials, &receipt.follower_task_id).await?;
    assert_eq!(follower.state(), TaskState::Succeeded);
    assert!(
        follower.attempt_id.is_none(),
        "accepted input must not launch another native turn"
    );
    let ambiguous = operator
        .submit_task(credentials.request(SubmitTaskRequest {
            output_policy: None,
            execution_limits: None,
            tag_id: "native-engineer".into(),
            session_id: session_id.into(),
            prompt: "Wait for live input".into(),
            operation_id: "native-ambiguous-steering".into(),
            input_artifacts: vec![],
        })?)
        .await?
        .into_inner();
    wait_for_state(
        &mut operator,
        &credentials,
        &ambiguous.task_id,
        TaskState::Running,
    )
    .await?;
    let ambiguous_input = inputs
        .queue_input(credentials.request(QueueInputRequest {
            task_id: ambiguous.task_id.clone(),
            operation_id: "native-ambiguous-input".into(),
            text: "Simulate lost acknowledgement".into(),
        })?)
        .await?
        .into_inner();
    wait_for_state(
        &mut operator,
        &credentials,
        &ambiguous.task_id,
        TaskState::Failed,
    )
    .await?;
    let receipt = inputs
        .get_input(credentials.request(GetInputRequest {
            input_id: ambiguous_input.input_id,
        })?)
        .await?
        .into_inner();
    assert_eq!(receipt.state(), LiveInputState::Unknown);
    let follower = task(&mut operator, &credentials, &receipt.follower_task_id).await?;
    assert_eq!(follower.state(), TaskState::Queued);
    assert!(
        follower.attempt_id.is_none(),
        "ambiguous input must not be blindly replayed"
    );
    assert!(
        std::fs::read_dir(state.join("host"))?
            .collect::<std::io::Result<Vec<_>>>()?
            .iter()
            .all(|entry| !entry
                .file_name()
                .to_string_lossy()
                .starts_with("adapter-attempt-")),
        "guardian retained the disposable Codex state after completion",
    );
    supervisor.terminate()?;
    supervisor.successful_exit().await?;
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "exercises the real 30-second execution authority deadline"]
async fn gateway_partition_expires_execution_and_requires_audited_retry_before_replay() -> Result<()>
{
    let directory = TempDir::new()?;
    let database = format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("partition.db").display()
    );
    let credentials = Credentials::new();
    let mut command = credentials.command();
    command
        .arg("control-plane")
        .env("SUPERTAG_DATABASE_URL", &database);
    let mut control_plane =
        Process::spawn(command, directory.path(), "partition-control-plane", true)?;
    let private_endpoint = control_plane.endpoint().await?;
    let mut command = credentials.command();
    command.args(["gateway", "--control-plane", &private_endpoint]);
    let mut gateway = Process::spawn(command, directory.path(), "partition-gateway", true)?;
    let public_endpoint = gateway.endpoint().await?;
    let mut services = Services {
        control_plane,
        gateway,
        endpoint: public_endpoint.clone(),
    };
    let mut operator = services
        .client()
        .await
        .context("connect to initial Gateway")?;
    operator
        .put_tag(credentials.request(PutTagRequest {
            name: None,
            expected_revision: None,
            approval_rules: vec![],
            harness_kind: 0,
            workspace: None,
            tag_id: "engineer".into(),
            instructions: "Retry only with evidence".into(),
            execution: None,
            allowed_actions: vec!["files:read".into()],
        })?)
        .await?;
    let accepted = operator
        .submit_task(credentials.request(SubmitTaskRequest {
            output_policy: None,
            execution_limits: None,
            tag_id: "engineer".into(),
            session_id: "partitioned-session".into(),
            operation_id: "partitioned-work".into(),
            prompt: "inspect after recovery".into(),
            input_artifacts: vec![],
        })?)
        .await?
        .into_inner();
    let pending = operator
        .submit_task(credentials.request(SubmitTaskRequest {
            output_policy: None,
            execution_limits: None,
            tag_id: "engineer".into(),
            session_id: "partitioned-session".into(),
            operation_id: "later-session-work".into(),
            prompt: "continue the Session".into(),
            input_artifacts: vec![],
        })?)
        .await?
        .into_inner();
    let (adapter, launches) = recording_adapter(directory.path())?;
    let state = directory.path().join("host");
    let host_command = |waiting: bool| {
        let mut command = credentials.command();
        command
            .args([
                "worker-host",
                "--gateway",
                &public_endpoint,
                "--once",
                "--state-directory",
            ])
            .arg(&state)
            .arg("--adapter")
            .arg(&adapter);
        if waiting {
            command.arg("--adapter-arg=--wait-for-cancel");
        }
        command
    };
    let mut host = Process::spawn(
        host_command(true),
        directory.path(),
        "partition-host",
        false,
    )?;
    let running = wait_for_state(
        &mut operator,
        &credentials,
        &accepted.task_id,
        TaskState::Running,
    )
    .await?;
    let deadline = Instant::now() + WAIT;
    let original_events = loop {
        let events = events(&mut operator, &credentials, &accepted.task_id, 0).await?;
        if !events.is_empty() {
            break events;
        }
        ensure!(Instant::now() < deadline, "waiting fixture did not start");
        sleep(Duration::from_millis(10)).await;
    };
    assert_eq!(original_events.len(), 1);
    let launched: Vec<u32> = std::fs::read_to_string(&launches)?
        .lines()
        .map(str::parse)
        .collect::<std::result::Result<_, _>>()?;
    assert_eq!(launched.len(), 1);
    let mut cleanup = DescendantCleanup(descendants(host.child.id())?);
    assert!(cleanup.0.contains(&launched[0]));
    let journal: Value = serde_json::from_slice(&std::fs::read(state.join("attempt.json"))?)?;
    assert_eq!(journal["stage"], "executing");
    let old_attempt = InspectAttemptRequest {
        task_id: accepted.task_id.clone(),
        attempt_id: running
            .attempt_id
            .clone()
            .context("running Task omitted Attempt identity")?,
        lease_token: journal["lease_token"]
            .as_str()
            .context("host journal omitted ownership proof")?
            .into(),
    };

    // Keep the Control Plane alive but make the host's only authority route
    // unavailable. This uses the real monotonic deadline and never advances a clock.
    let partitioned_at = Instant::now();
    services.gateway.crash()?;
    drop(operator);
    let private_channel = Channel::from_shared(private_endpoint.clone())?
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(3))
        .connect()
        .await?;
    let mut private_operator = OperatorClient::new(private_channel);
    let deadline = partitioned_at + Duration::from_secs(45);
    let mut last_state = running.state();
    loop {
        match private_operator
            .get_task(authenticated_request(
                GetTaskRequest {
                    task_id: accepted.task_id.clone(),
                },
                &credentials.gateway,
                Some("operator:local"),
            )?)
            .await
        {
            Ok(response) => last_state = response.into_inner().state(),
            Err(error)
                if Instant::now() < deadline
                    && (matches!(error.code(), Code::Unavailable | Code::DeadlineExceeded)
                        || error.code() == Code::Cancelled && error.source().is_some()) => {}
            Err(error) => return Err(error).context("poll Task state during Gateway partition"),
        }
        let mut alive = false;
        for pid in &cleanup.0 {
            alive |= process_exists(*pid)?;
        }
        if !alive && last_state == TaskState::Uncertain {
            break;
        }
        ensure!(
            Instant::now() < deadline,
            "partition did not stop local execution and preserve uncertain ownership"
        );
        sleep(Duration::from_millis(50)).await;
    }
    cleanup.0.clear();
    assert!(
        partitioned_at.elapsed() >= Duration::from_secs(20),
        "a transient disconnect ended execution before its authority deadline"
    );
    assert!(
        !process_exists(launched[0])?,
        "fixture survived its authority deadline"
    );
    assert_eq!(std::fs::read_to_string(&launches)?.lines().count(), 1);
    let resolution_input = ResolveAttemptRequest {
        task_id: accepted.task_id.clone(),
        attempt_id: old_attempt.attempt_id.clone(),
        operation_id: "audited-partition-retry".into(),
        decision: AttemptDecision::Retry as i32,
        evidence: format!(
            "Observed fixture PID {} and its guardian stopped after lost authority; require the host's cleanup receipt before retry.",
            launched[0]
        ),
        confirmed_stopped: false,
    };
    let refused = private_operator
        .resolve_attempt(authenticated_request(
            resolution_input.clone(),
            &credentials.gateway,
            Some("operator:local"),
        )?)
        .await
        .unwrap_err();
    assert_eq!(
        refused.code(),
        Code::FailedPrecondition,
        "local process exit alone must not invent a stored cleanup receipt"
    );

    // Rebind the original route. The surviving host can now deliver its saved
    // cleanup receipt, which leaves the Task uncertain and the Session blocked.
    let mut command = credentials.command();
    command.args([
        "gateway",
        "--control-plane",
        &private_endpoint,
        "--listen",
        public_endpoint.trim_start_matches("http://"),
    ]);
    services.gateway = Process::spawn(command, directory.path(), "restored-gateway", true)?;
    assert_eq!(services.gateway.endpoint().await?, public_endpoint);
    host.successful_exit().await?;
    let mut operator = services
        .client()
        .await
        .context("connect to replacement Gateway")?;
    let uncertain = task(&mut operator, &credentials, &accepted.task_id).await?;
    assert_eq!(uncertain.state(), TaskState::Uncertain);
    assert_eq!(uncertain.attempt_id, running.attempt_id);
    assert!(uncertain.result.is_none());
    assert_eq!(
        events(&mut operator, &credentials, &accepted.task_id, 0).await?,
        original_events
    );
    let host_channel = Channel::from_shared(public_endpoint.clone())?
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(3))
        .connect()
        .await?;
    let mut host_client = WorkerHostClient::new(host_channel);
    let receipt = host_client
        .get_attempt_resolution(credentials.host_request(old_attempt.clone())?)
        .await
        .context("inspect cleanup receipt through replacement Gateway")?
        .into_inner();
    assert!(receipt.resolution.is_none());
    let mut no_replay =
        Process::spawn(host_command(false), directory.path(), "blocked-host", false)?;
    no_replay.successful_exit().await?;
    assert_eq!(
        std::fs::read_to_string(&launches)?.lines().count(),
        1,
        "restoring connectivity must not replay uncertain work"
    );
    assert_eq!(
        task(&mut operator, &credentials, &pending.task_id)
            .await?
            .state(),
        TaskState::Queued
    );

    let resolution = operator
        .resolve_attempt(credentials.request(resolution_input.clone())?)
        .await?
        .into_inner();
    assert_eq!(resolution.task_id, accepted.task_id);
    assert_eq!(resolution.attempt_id, old_attempt.attempt_id);
    assert_eq!(resolution.decision, AttemptDecision::Retry as i32);
    assert_eq!(resolution.operator_id, "local");
    assert_eq!(resolution.evidence, resolution_input.evidence);
    assert!(resolution.resolved_at_ms > 0);
    assert_eq!(
        operator
            .resolve_attempt(credentials.request(resolution_input)?)
            .await?
            .into_inner(),
        resolution
    );
    let receipt = host_client
        .get_attempt_resolution(credentials.host_request(old_attempt)?)
        .await?
        .into_inner();
    assert_eq!(receipt.resolution, Some(resolution));
    let retry_queued = task(&mut operator, &credentials, &accepted.task_id).await?;
    assert_eq!(retry_queued.state(), TaskState::Queued);
    assert!(retry_queued.attempt_id.is_none());
    let mut retried_host =
        Process::spawn(host_command(false), directory.path(), "retried-host", false)?;
    let completed = wait_for_state(
        &mut operator,
        &credentials,
        &accepted.task_id,
        TaskState::Succeeded,
    )
    .await?;
    retried_host.successful_exit().await?;
    assert_ne!(completed.attempt_id, running.attempt_id);
    assert_eq!(
        completed.result.as_deref(),
        Some("Retry only with evidence: inspect after recovery [files:read]")
    );
    assert_eq!(std::fs::read_to_string(&launches)?.lines().count(), 2);
    let history = events(&mut operator, &credentials, &accepted.task_id, 0).await?;
    assert_eq!(
        history
            .iter()
            .map(|event| event.sequence)
            .collect::<Vec<_>>(),
        [1, 2, 3]
    );
    assert_eq!(history[0], original_events[0]);
    assert_eq!(
        history[1].text,
        format!("{} started", completed.attempt_id.unwrap())
    );
    assert_eq!(history[2].text, completed.result.unwrap());
    let mut next_host = Process::spawn(
        host_command(false),
        directory.path(),
        "next-session-host",
        false,
    )?;
    wait_for_state(
        &mut operator,
        &credentials,
        &pending.task_id,
        TaskState::Succeeded,
    )
    .await?;
    next_host.successful_exit().await?;
    assert_eq!(std::fs::read_to_string(&launches)?.lines().count(), 3);
    Ok(())
}
