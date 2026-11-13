//! Actual idle presence expiry and restart through separate CP/Gateway/Host processes.

#[path = "../../../test-support/prerequisites.rs"]
mod prerequisites;
#[path = "support/protocol.rs"]
mod protocol;
#[macro_use]
#[path = "support/database.rs"]
mod database;

use anyhow::{Context, Result, ensure};
use std::{
    fs::File,
    io::{BufRead, BufReader},
    net::SocketAddr,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};
use supertag_protocol::{authenticated_request, v2::*};
use tokio::time::sleep;
use tonic::{Code, Request, transport::Endpoint};
use uuid::Uuid;

const BINARY: &str = env!("CARGO_BIN_EXE_supertag");
const ADAPTER: &str = env!("CARGO_BIN_EXE_supertag-fixture-adapter");
const WAIT: Duration = Duration::from_secs(15);

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
            .stdin(Stdio::null())
            .env("SUPERTAG_GATEWAY_TOKEN", &self.gateway)
            .env("SUPERTAG_OPERATOR_TOKEN", &self.operator)
            .env("SUPERTAG_HOST_TOKEN", &self.host)
            .env("SUPERTAG_BOOTSTRAP_HOST_TOKEN", &self.host);
        command
    }
    fn request<T>(&self, value: T) -> Result<Request<T>> {
        let mut request = authenticated_request(value, &self.operator, None)?;
        request.set_timeout(Duration::from_secs(2));
        Ok(request)
    }
}

struct Process {
    child: Child,
    log: PathBuf,
}
impl Process {
    fn spawn(mut command: Command, directory: &Path) -> Result<Self> {
        let log = directory.join(format!("{}.log", Uuid::new_v4()));
        let child = command
            .stdout(Stdio::piped())
            .stderr(File::create(&log)?)
            .spawn()?;
        Ok(Self { child, log })
    }
    async fn line(&mut self) -> Result<String> {
        let stdout = self.child.stdout.take().context("missing stdout")?;
        let (tx, rx) = mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let mut line = String::new();
            let result = BufReader::new(stdout).read_line(&mut line).map(|_| line);
            let _ = tx.send(result);
        });
        let end = Instant::now() + WAIT;
        loop {
            match rx.try_recv() {
                Ok(line) => return Ok(line?.trim().to_owned()),
                Err(mpsc::TryRecvError::Empty) => {}
                Err(error) => return Err(error.into()),
            }
            ensure!(
                self.child.try_wait()?.is_none(),
                "service exited: {}",
                std::fs::read_to_string(&self.log)?
            );
            ensure!(Instant::now() < end, "service readiness timed out");
            sleep(Duration::from_millis(20)).await;
        }
    }
    async fn address(&mut self) -> Result<String> {
        let line = self.line().await?;
        let address: SocketAddr = line
            .parse()
            .with_context(|| std::fs::read_to_string(&self.log).unwrap_or_default())?;
        ensure!(address.ip().is_loopback() && address.port() > 0);
        Ok(format!("http://{address}"))
    }
    fn kill(&mut self) -> Result<()> {
        if self.child.try_wait()?.is_none() {
            self.child.kill()?;
        }
        self.child.wait()?;
        Ok(())
    }
}
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.kill();
    }
}

async fn wait_phase(
    client: &mut operator_client::OperatorClient<supertag_protocol::negotiation::ProtocolChannel>,
    credentials: &Credentials,
    phase: HostPhase,
    timeout: Duration,
) -> Result<WorkerHostStatus> {
    let end = Instant::now() + timeout;
    loop {
        match client
            .get_host(credentials.request(GetHostRequest {
                host_id: "local".into(),
            })?)
            .await
        {
            Ok(response) if response.get_ref().phase() == phase => return Ok(response.into_inner()),
            Ok(_) => {}
            Err(error) if matches!(error.code(), Code::Unavailable | Code::DeadlineExceeded) => {}
            Err(error) => return Err(error.into()),
        }
        ensure!(Instant::now() < end, "host never reached {phase:?}");
        sleep(Duration::from_millis(50)).await;
    }
}

fn host_command(credentials: &Credentials, gateway: &str, state: &Path) -> Command {
    let mut command =
        credentials.command(&["worker-host", "--gateway", gateway, "--adapter", ADAPTER]);
    command.arg("--state-directory").arg(state);
    command
}

database_tests! {
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    idle_host_expires_and_restart_preserves_drain_until_operator_resumes;
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    executing_capacity_and_recovery_suppression_are_reported_by_the_actual_host;
}

async fn idle_host_expires_and_restart_preserves_drain_until_operator_resumes(
    database: String,
) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let credentials = Credentials::new();
    let mut command = credentials.command(&["control-plane"]);
    command.env("SUPERTAG_DATABASE_URL", &database);
    let mut control = Process::spawn(command, directory.path())?;
    let private = control.address().await?;
    let mut gateway = Process::spawn(
        credentials.command(&["gateway", "--control-plane", &private]),
        directory.path(),
    )?;
    let public = gateway.address().await?;
    let mut operator = operator_client::OperatorClient::new(
        protocol::negotiated(Endpoint::from_shared(public.clone())?.connect_lazy()).await?,
    );
    let initial = operator
        .get_host(credentials.request(GetHostRequest {
            host_id: "local".into(),
        })?)
        .await?
        .into_inner();
    assert_eq!(initial.phase(), HostPhase::Pending);
    assert_eq!(initial.available_slots, 0);
    let mut forged = authenticated_request(
        ListHostsRequest::default(),
        &credentials.host,
        Some("operator:forged"),
    )?;
    forged.set_timeout(Duration::from_secs(2));
    assert_eq!(
        operator.list_hosts(forged).await.unwrap_err().code(),
        Code::Unauthenticated
    );

    let state = directory.path().join("worker");
    let mut host = Process::spawn(
        host_command(&credentials, &public, &state),
        directory.path(),
    )?;
    assert_eq!(host.line().await?, "ready");
    let ready = wait_phase(&mut operator, &credentials, HostPhase::Ready, WAIT).await?;
    assert_eq!(
        (ready.capacity, ready.available_slots, ready.active_attempts),
        (1, 1, 0)
    );
    host.kill()?;
    // The real presence lease, independent of any Task, is allowed to expire.
    let offline = wait_phase(
        &mut operator,
        &credentials,
        HostPhase::Offline,
        Duration::from_secs(40),
    )
    .await?;
    assert_eq!(offline.available_slots, 0);
    assert!(offline.last_seen_at_ms.is_some());
    operator
        .set_host_draining(credentials.request(SetHostDrainingRequest {
            host_id: "local".into(),
            draining: true,
        })?)
        .await?;
    gateway.kill()?;
    control.kill()?;

    let mut command = credentials.command(&[
        "control-plane",
        "--listen",
        private.trim_start_matches("http://"),
    ]);
    command.env("SUPERTAG_DATABASE_URL", &database);
    control = Process::spawn(command, directory.path())?;
    assert_eq!(control.address().await?, private);
    gateway = Process::spawn(
        credentials.command(&[
            "gateway",
            "--control-plane",
            &private,
            "--listen",
            public.trim_start_matches("http://"),
        ]),
        directory.path(),
    )?;
    assert_eq!(gateway.address().await?, public);
    let restored = wait_phase(&mut operator, &credentials, HostPhase::Offline, WAIT).await?;
    assert!(restored.draining);
    assert_eq!(restored.last_seen_at_ms, offline.last_seen_at_ms);
    host = Process::spawn(
        host_command(&credentials, &public, &state),
        directory.path(),
    )?;
    assert_eq!(host.line().await?, "ready");
    let draining = wait_phase(&mut operator, &credentials, HostPhase::Draining, WAIT).await?;
    assert_eq!(draining.generation, ready.generation);
    assert_eq!(draining.available_slots, 0);
    assert!(draining.last_seen_at_ms > offline.last_seen_at_ms);
    operator
        .set_host_draining(credentials.request(SetHostDrainingRequest {
            host_id: "local".into(),
            draining: false,
        })?)
        .await?;
    wait_phase(&mut operator, &credentials, HostPhase::Ready, WAIT).await?;
    let listed = operator
        .list_hosts(credentials.request(ListHostsRequest::default())?)
        .await?
        .into_inner();
    assert_eq!(listed.hosts.len(), 1);
    assert_eq!(listed.hosts[0].host_id, "local");
    host.kill()?;
    gateway.kill()?;
    control.kill()?;
    Ok(())
}

async fn executing_capacity_and_recovery_suppression_are_reported_by_the_actual_host(
    database: String,
) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let credentials = Credentials::new();
    let mut command = credentials.command(&["control-plane"]);
    command.env("SUPERTAG_DATABASE_URL", &database);
    let mut control = Process::spawn(command, directory.path())?;
    let private = control.address().await?;
    let mut gateway = Process::spawn(
        credentials.command(&["gateway", "--control-plane", &private]),
        directory.path(),
    )?;
    let public = gateway.address().await?;
    let mut operator = operator_client::OperatorClient::new(
        protocol::negotiated(Endpoint::from_shared(public.clone())?.connect_lazy()).await?,
    );
    operator
        .put_tag(credentials.request(PutTagRequest {
            tag_id: "reviewer".into(),
            instructions: "Review".into(),
            ..Default::default()
        })?)
        .await?;
    let task = operator
        .submit_task(credentials.request(SubmitTaskRequest {
            output_policy: None,
            execution_limits: None,
            tag_id: "reviewer".into(),
            session_id: "review".into(),
            operation_id: "review-turn".into(),
            prompt: "Wait for operator".into(),
            input_artifacts: vec![],
        })?)
        .await?
        .into_inner();
    let state = directory.path().join("worker");
    let mut command = host_command(&credentials, &public, &state);
    command.arg("--adapter-arg=--wait-for-cancel");
    let mut host = Process::spawn(command, directory.path())?;
    assert_eq!(host.line().await?, "ready");
    let end = Instant::now() + WAIT;
    loop {
        let events = operator
            .list_events(credentials.request(ListEventsRequest {
                task_id: task.task_id.clone(),
                ..Default::default()
            })?)
            .await?
            .into_inner();
        if !events.events.is_empty() {
            break;
        }
        ensure!(Instant::now() < end, "adapter never began execution");
        sleep(Duration::from_millis(20)).await;
    }
    let busy = wait_phase(&mut operator, &credentials, HostPhase::Busy, WAIT).await?;
    assert_eq!(
        (busy.capacity, busy.available_slots, busy.active_attempts),
        (1, 0, 1)
    );
    let first_seen = busy.last_seen_at_ms;
    // Wait for a newer presence observation while the adapter remains blocked.
    // This proves reporting is independent of the synchronous execution loop.
    let end = Instant::now() + WAIT;
    loop {
        let busy = wait_phase(&mut operator, &credentials, HostPhase::Busy, WAIT).await?;
        if busy.last_seen_at_ms > first_seen {
            break;
        }
        ensure!(Instant::now() < end, "busy host stopped reporting presence");
        sleep(Duration::from_millis(20)).await;
    }
    host.kill()?;
    let mut command = host_command(&credentials, &public, &state);
    command.arg("--wait-for-recovery");
    host = Process::spawn(command, directory.path())?;
    assert_eq!(host.line().await?, "ready");
    let blocked = wait_phase(&mut operator, &credentials, HostPhase::Suppressed, WAIT).await?;
    assert_eq!(blocked.reason(), HostReadinessReason::RecoveryRequired);
    assert_eq!(blocked.available_slots, 0);
    assert_eq!(blocked.active_attempts, 1);
    assert_eq!(blocked.generation, busy.generation);
    host.kill()?;
    gateway.kill()?;
    control.kill()?;
    Ok(())
}

async fn wait_for_log(path: &Path, expected: &[String]) -> Result<()> {
    let end = Instant::now() + WAIT;
    loop {
        let log = std::fs::read_to_string(path).unwrap_or_default();
        if log.lines().map(str::to_owned).collect::<Vec<_>>() == expected {
            return Ok(());
        }
        ensure!(
            Instant::now() < end,
            "keep-awake log {log:?} never became {expected:?}"
        );
        sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn running_attempt_keeps_the_machine_awake_and_low_disk_is_reported() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let database = format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("control.db").display()
    );
    let credentials = Credentials::new();
    let mut command = credentials.command(&["control-plane"]);
    command.env("SUPERTAG_DATABASE_URL", &database);
    let mut control = Process::spawn(command, directory.path())?;
    let private = control.address().await?;
    let mut gateway = Process::spawn(
        credentials.command(&["gateway", "--control-plane", &private]),
        directory.path(),
    )?;
    let public = gateway.address().await?;
    let mut operator = operator_client::OperatorClient::new(
        protocol::negotiated(Endpoint::from_shared(public.clone())?.connect_lazy()).await?,
    );
    operator
        .put_tag(credentials.request(PutTagRequest {
            tag_id: "reviewer".into(),
            instructions: "Review".into(),
            ..Default::default()
        })?)
        .await?;

    // A fake OS command records the platform arguments it receives and its termination.
    let log = directory.path().join("keep-awake.log");
    let script = directory.path().join("keep-awake");
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\necho \"start $*\" >> '{0}'\ntrap 'echo term >> \"{0}\"; exit 0' TERM\nwhile :; do sleep 0.05; done\n",
            log.display()
        ),
    )?;
    use std::os::unix::fs::PermissionsExt as _;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700))?;
    let gib = 1u64 << 30;
    let state = directory.path().join("worker");
    let mut command = host_command(&credentials, &public, &state);
    command
        .arg("--adapter-arg=--wait-for-cancel")
        .env("SUPERTAG_TEST_KEEP_AWAKE_COMMAND", &script)
        .env("SUPERTAG_TEST_DISK_SPACE", format!("{gib},{}", 100 * gib));
    let mut host = Process::spawn(command, directory.path())?;
    assert_eq!(host.line().await?, "ready");
    let ready = wait_phase(&mut operator, &credentials, HostPhase::Ready, WAIT).await?;
    assert_eq!(
        ready.disk_space,
        Some(HostDiskSpace {
            free_bytes: gib,
            total_bytes: 100 * gib
        })
    );
    // Preflight warns before any work is claimed; idle hosts hold nothing.
    let preflight = std::fs::read_to_string(&host.log)?;
    assert!(
        preflight.contains("Warning: Worker Host free disk 1 GiB is below 5 GiB"),
        "{preflight}"
    );
    assert!(!log.exists());
    let output = credentials
        .command(&["host", "--gateway", &public, "get", "local"])
        .output()?;
    ensure!(output.status.success(), "{output:?}");
    let shown: serde_json::Value = serde_json::from_slice(&output.stdout)?;
    assert_eq!(shown["disk_space"]["free_bytes"], gib);
    assert!(
        shown["disk_warning"]
            .as_str()
            .is_some_and(|warning| warning.contains("below 5 GiB")),
        "{shown}"
    );

    let task = operator
        .submit_task(credentials.request(SubmitTaskRequest {
            output_policy: None,
            execution_limits: None,
            tag_id: "reviewer".into(),
            session_id: "review".into(),
            operation_id: "review-turn".into(),
            prompt: "Wait for operator".into(),
            input_artifacts: vec![],
        })?)
        .await?
        .into_inner();
    wait_phase(&mut operator, &credentials, HostPhase::Busy, WAIT).await?;
    let arguments = match std::env::consts::OS {
        "macos" => format!("start -i -w {}", host.child.id()),
        "linux" => format!(
            "start --what=idle:sleep --who=SuperTag --why=Running Task Attempts --mode=block tail --pid={} -f /dev/null",
            host.child.id()
        ),
        other => anyhow::bail!("unsupported test platform {other}"),
    };
    wait_for_log(&log, std::slice::from_ref(&arguments)).await?;
    operator
        .cancel_task(credentials.request(CancelTaskRequest {
            task_id: task.task_id.clone(),
        })?)
        .await?;
    wait_phase(&mut operator, &credentials, HostPhase::Ready, WAIT).await?;
    wait_for_log(&log, &[arguments, "term".into()]).await?;
    host.kill()?;
    gateway.kill()?;
    control.kill()?;
    Ok(())
}
