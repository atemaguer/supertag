//! Several Control Plane replicas on one PostgreSQL database.
//!
//! Three shipped `supertag control-plane` processes start together on one empty PostgreSQL
//! database, each behind its own Gateway. Operators submit Tasks and create Objectives through
//! every replica, a Worker Host executes through one of them, every Gateway delivers operator
//! notifications from the shared outbox, and a Watch stream follows each replica. Replicas are
//! killed mid-operation and restarted. The lane asserts that no work is lost or repeated: each
//! Task runs exactly once, each operator notification is delivered once, and every Watch stream
//! sees the same gap-free positions, resuming on another replica after its own is killed. With
//! two replicas killed, the survivor runs the periodic maintenance pass that expires a stranded
//! Attempt.
//!
//! SQLite serves one Control Plane process; a second process on the same file is refused.

// This lane runs only on PostgreSQL, so it calls the runner without `database_tests!`.
#[allow(unused_macros)]
#[path = "support/database.rs"]
mod database;
#[path = "../../../test-support/prerequisites.rs"]
mod prerequisites;
#[path = "support/protocol.rs"]
mod protocol;

use std::{
    collections::{BTreeMap, BTreeSet},
    fs::File,
    io::{BufRead, BufReader},
    net::SocketAddr,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, mpsc},
    time::{Duration, Instant},
};

use anyhow::{Context, Result, anyhow, bail, ensure};
use serde_json::Value;
use sqlx::Row;
use supertag_protocol::{
    authenticated_request,
    negotiation::ProtocolChannel,
    v2::{
        ListEventsRequest, PutTagRequest, SubmitTaskRequest, Task, TaskState, WatchEvent,
        WatchRequest, operator_client::OperatorClient,
        operator_events_client::OperatorEventsClient, watch_event::Update,
    },
};
use tempfile::TempDir;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{Mutex, watch},
    time::sleep,
};
use tonic::{Request, transport::Channel};
use uuid::Uuid;

const BINARY: &str = env!("CARGO_BIN_EXE_supertag");
const ADAPTER: &str = env!("CARGO_BIN_EXE_supertag-fixture-adapter");
const WAIT: Duration = Duration::from_secs(60);
const REPLICAS: usize = 3;
const TAG: &str = "engineer";
const INSTRUCTIONS: &str = "Work across replicas";
const QUESTION: &str = "Ask which branch to release";

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

    fn request<T>(&self, message: T) -> Result<Request<T>> {
        let mut request = authenticated_request(message, &self.operator, None)?;
        request.set_timeout(Duration::from_secs(5));
        Ok(request)
    }
}

/// Owns and reaps one service process, including when an assertion fails.
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

    /// The first address the server reports on stdout.
    async fn endpoint(&mut self) -> Result<String> {
        let stdout = self.child.stdout.take().context("server stdout missing")?;
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
                    let line = line?;
                    let address: SocketAddr = line
                        .trim()
                        .trim_start_matches("http://")
                        .parse()
                        .with_context(|| format!("no bound endpoint: {}", self.logs()))?;
                    ensure!(address.ip().is_loopback(), "invalid test endpoint");
                    return Ok(format!("http://{address}"));
                }
                Err(mpsc::TryRecvError::Empty) => {}
                Err(mpsc::TryRecvError::Disconnected) => {
                    bail!("server output closed: {}", self.logs());
                }
            }
            if let Some(status) = self.child.try_wait()? {
                bail!("server exited with {status}: {}", self.logs());
            }
            ensure!(Instant::now() < deadline, "server startup timed out");
            sleep(Duration::from_millis(10)).await;
        }
    }

    async fn exit(&mut self) -> Result<std::process::ExitStatus> {
        let deadline = Instant::now() + WAIT;
        loop {
            if let Some(status) = self.child.try_wait()? {
                return Ok(status);
            }
            ensure!(Instant::now() < deadline, "process did not exit");
            sleep(Duration::from_millis(10)).await;
        }
    }

    /// SIGKILL: no graceful drain, no chance to settle in-flight work.
    fn kill(&mut self) -> Result<()> {
        if self.child.try_wait()?.is_none() {
            self.child.kill()?;
        }
        self.child.wait()?;
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

/// One Control Plane replica and the Gateway in front of it.
struct Replica {
    control_plane: Process,
    /// Kept alive for the replica's lifetime.
    _gateway: Process,
    /// The replica's own address, reused when it restarts.
    listen: String,
    endpoint: String,
}

fn control_plane(
    credentials: &Credentials,
    database: &str,
    directory: &Path,
    listen: &str,
) -> Result<Process> {
    let mut command = credentials.command();
    command
        .args(["control-plane", "--listen", listen])
        .env("SUPERTAG_DATABASE_URL", database);
    Process::spawn(command, directory, "control-plane", true)
}

/// Restarts a killed replica's Control Plane on its address; its Gateway reconnects.
async fn restart(
    replica: &mut Replica,
    credentials: &Credentials,
    database: &str,
    directory: &Path,
) -> Result<()> {
    let deadline = Instant::now() + WAIT;
    loop {
        let mut process = control_plane(credentials, database, directory, &replica.listen)?;
        match process.endpoint().await {
            Ok(_) => {
                replica.control_plane = process;
                return Ok(());
            }
            // The killed process's port may linger briefly.
            Err(error) if Instant::now() < deadline => {
                drop(error);
                sleep(Duration::from_millis(200)).await;
            }
            Err(error) => return Err(error),
        }
    }
}

async fn client(endpoint: &str) -> Result<ProtocolChannel> {
    let channel = Channel::from_shared(endpoint.to_owned())?
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(10));
    protocol::negotiated(channel.connect().await?).await
}

async fn operator(endpoint: &str) -> Result<OperatorClient<ProtocolChannel>> {
    Ok(OperatorClient::new(client(endpoint).await?))
}

async fn cli(command: Command, directory: &Path) -> Result<Value> {
    let mut process = Process::spawn(command, directory, "cli", false)?;
    let status = process.exit().await?;
    ensure!(status.success(), "CLI failed: {}", process.logs());
    Ok(serde_json::from_slice(&std::fs::read(
        process.log.with_extension("stdout"),
    )?)?)
}

/// Records every request a webhook receives and acknowledges it.
struct Webhook {
    url: String,
    bodies: Arc<Mutex<Vec<Value>>>,
    server: tokio::task::JoinHandle<Result<()>>,
}

impl Webhook {
    async fn start() -> Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let url = format!("http://{}/hook", listener.local_addr()?);
        let bodies = Arc::new(Mutex::new(Vec::new()));
        let recorded = bodies.clone();
        let server = tokio::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await?;
                let recorded = recorded.clone();
                tokio::spawn(async move {
                    let Ok(Ok(body)) =
                        tokio::time::timeout(Duration::from_secs(5), read_body(&mut stream)).await
                    else {
                        return;
                    };
                    recorded.lock().await.push(body);
                    let _ = stream
                        .write_all(
                            b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                        )
                        .await;
                    let _ = stream.shutdown().await;
                });
            }
        });
        Ok(Self {
            url,
            bodies,
            server,
        })
    }
}

impl Drop for Webhook {
    fn drop(&mut self) {
        self.server.abort();
    }
}

async fn read_body(stream: &mut TcpStream) -> Result<Value> {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 4096];
    let header_end = loop {
        if let Some(offset) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            break offset + 4;
        }
        ensure!(bytes.len() < 16_384, "webhook headers too large");
        let count = stream.read(&mut buffer).await?;
        ensure!(count != 0, "webhook request ended before its headers");
        bytes.extend_from_slice(&buffer[..count]);
    };
    let headers = std::str::from_utf8(&bytes[..header_end])?;
    let length: usize = headers
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse().ok())?
        })
        .context("webhook request without Content-Length")?;
    while bytes.len() < header_end + length {
        let count = stream.read(&mut buffer).await?;
        ensure!(count != 0, "webhook request ended before its body");
        bytes.extend_from_slice(&buffer[..count]);
    }
    Ok(serde_json::from_slice(
        &bytes[header_end..header_end + length],
    )?)
}

/// Positions a Watch stream reported, across the replicas it had to resume on.
#[derive(Default)]
struct Followed {
    start: i64,
    changes: Vec<i64>,
    resumed: usize,
}

fn position(event: &WatchEvent) -> Result<i64> {
    event
        .resume_token
        .rsplit('.')
        .next()
        .context("Watch resume token")?
        .parse()
        .context("Watch position")
}

async fn open_watch(
    endpoint: &str,
    credentials: &Credentials,
    resume_token: String,
) -> Result<tonic::Streaming<WatchEvent>> {
    let mut events = OperatorEventsClient::new(client(endpoint).await?);
    let request = authenticated_request(
        WatchRequest {
            resume_token,
            ..Default::default()
        },
        &credentials.operator,
        None,
    )?;
    Ok(events.watch(request).await?.into_inner())
}

/// Follows the operator Watch from `first`. When that replica fails, the stream resumes from
/// its last token on the next replica. Stops once it reaches `until`.
async fn follow(
    endpoints: Arc<Vec<String>>,
    first: usize,
    credentials: Arc<Credentials>,
    opened: tokio::sync::oneshot::Sender<i64>,
    mut until: watch::Receiver<i64>,
) -> Result<Followed> {
    let mut followed = Followed::default();
    let mut stream = open_watch(&endpoints[first], &credentials, String::new()).await?;
    let initial = tokio::time::timeout(WAIT, stream.message())
        .await??
        .context("Watch handshake")?;
    ensure!(matches!(initial.update, Some(Update::Heartbeat(_))));
    followed.start = position(&initial)?;
    let mut token = initial.resume_token;
    let mut at = followed.start;
    let _ = opened.send(at);
    let mut next = first;
    let deadline = Instant::now() + Duration::from_secs(300);
    loop {
        if at >= *until.borrow() {
            return Ok(followed);
        }
        ensure!(Instant::now() < deadline, "Watch did not reach the head");
        let message = tokio::select! {
            message = stream.message() => message,
            changed = until.changed() => {
                changed?;
                continue;
            }
        };
        match message {
            Ok(Some(event)) => {
                let reached = position(&event)?;
                match event.update {
                    Some(Update::Change(_)) => followed.changes.push(reached),
                    Some(Update::Resync(_)) => bail!("Watch resynchronized at {reached}"),
                    _ => {}
                }
                at = reached;
                token = event.resume_token;
            }
            // The replica behind this stream failed: resume from the last token elsewhere.
            Ok(None) | Err(_) => loop {
                next = (next + 1) % endpoints.len();
                if let Ok(resumed) = open_watch(&endpoints[next], &credentials, token.clone()).await
                {
                    stream = resumed;
                    followed.resumed += 1;
                    break;
                }
                ensure!(Instant::now() < deadline, "no replica resumed the Watch");
                sleep(Duration::from_millis(100)).await;
            },
        }
    }
}

fn submission(session: &str) -> SubmitTaskRequest {
    SubmitTaskRequest {
        output_policy: None,
        execution_limits: None,
        tag_id: TAG.into(),
        session_id: session.into(),
        operation_id: format!("submit-{session}"),
        prompt: format!("handle {session}"),
        input_artifacts: vec![],
    }
}

/// Submits through `first`, then retries the same operation through `retry`: the retry
/// must resolve to the Task the first replica accepted.
async fn submit(
    endpoints: &[String],
    credentials: &Credentials,
    first: usize,
    retry: usize,
    session: String,
) -> Result<Task> {
    let accepted = operator(&endpoints[first])
        .await?
        .submit_task(credentials.request(submission(&session))?)
        .await?
        .into_inner();
    let retried = operator(&endpoints[retry])
        .await?
        .submit_task(credentials.request(submission(&session))?)
        .await?
        .into_inner();
    ensure!(
        retried.task_id == accepted.task_id,
        "replicas accepted one operation twice"
    );
    Ok(accepted)
}

async fn submit_all(
    endpoints: &[String],
    credentials: &Credentials,
    sessions: impl Iterator<Item = (usize, usize, String)>,
) -> Result<Vec<Task>> {
    let mut accepted = Vec::new();
    let mut pending = tokio::task::JoinSet::new();
    for (first, retry, session) in sessions {
        let endpoints = endpoints.to_vec();
        let credentials = Credentials {
            gateway: credentials.gateway.clone(),
            operator: credentials.operator.clone(),
            host: credentials.host.clone(),
        };
        pending.spawn(async move { submit(&endpoints, &credentials, first, retry, session).await });
    }
    while let Some(task) = pending.join_next().await {
        accepted.push(task??);
    }
    Ok(accepted)
}

/// Waits until some Attempt runs, as recorded in the shared database.
async fn first_running(database: &str) -> Result<()> {
    let mut connection = database::connect(database).await?;
    let deadline = Instant::now() + WAIT;
    loop {
        let running: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM supertag_v2_tasks WHERE state=$1")
                .bind(TaskState::Running as i64)
                .fetch_one(&mut connection)
                .await?;
        if running > 0 {
            return Ok(());
        }
        ensure!(Instant::now() < deadline, "no Attempt started");
        sleep(Duration::from_millis(50)).await;
    }
}

async fn task_state(connection: &mut sqlx::AnyConnection, task_id: &str) -> Result<i64> {
    Ok(
        sqlx::query_scalar("SELECT state FROM supertag_v2_tasks WHERE task_id=$1")
            .bind(task_id)
            .fetch_one(connection)
            .await?,
    )
}

/// A Worker Host adapter that records each launch, then runs the fixture adapter.
fn recording_adapter(directory: &Path) -> Result<(PathBuf, PathBuf)> {
    use std::os::unix::fs::PermissionsExt;
    let script = directory.join("recording-adapter");
    let launches = directory.join("adapter-launches");
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\nprintf '%s\\n' \"$$\" >> '{}'\nexec '{}' \"$@\"\n",
            launches.display(),
            ADAPTER
        ),
    )?;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700))?;
    Ok((script, launches))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires an isolated PostgreSQL server via SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"]
async fn replicas_share_one_postgresql_database_and_survive_killed_replicas() -> Result<()> {
    database::run(database::Backend::Postgres, |database| async move {
        let directory = TempDir::new()?;
        Box::pin(exercise_replicas(&database, directory.path())).await
    })
    .await
}

async fn exercise_replicas(database: &str, directory: &Path) -> Result<()> {
    let credentials = Arc::new(Credentials::new());
    let webhook = Webhook::start().await?;

    // Replicas that start together on an empty database migrate it once between them.
    let mut planes = (0..REPLICAS)
        .map(|_| control_plane(&credentials, database, directory, "127.0.0.1:0"))
        .collect::<Result<Vec<_>>>()?;
    let mut replicas = Vec::new();
    for mut plane in planes.drain(..) {
        let private = plane.endpoint().await?;
        let mut command = credentials.command();
        command
            .args(["gateway", "--control-plane", &private])
            .arg("--notify")
            .arg(format!("webhook:{}#hook-token", webhook.url))
            .env("SUPERTAG_TEST_NOTIFY_LOOPBACK_HTTP", "1")
            .env("SUPERTAG_NOTIFY_SECRET_HOOK_TOKEN", "synthetic-hook-secret");
        let mut gateway = Process::spawn(command, directory, "gateway", true)?;
        let endpoint = gateway.endpoint().await?;
        replicas.push(Replica {
            control_plane: plane,
            _gateway: gateway,
            listen: private.trim_start_matches("http://").to_owned(),
            endpoint,
        });
    }
    let endpoints: Arc<Vec<String>> =
        Arc::new(replicas.iter().map(|r| r.endpoint.clone()).collect());

    // A Watch follows each replica from the same head.
    let (until, target) = watch::channel(i64::MAX);
    let mut followers = Vec::new();
    for replica in 0..REPLICAS {
        let (opened, started) = tokio::sync::oneshot::channel();
        followers.push(tokio::spawn(follow(
            endpoints.clone(),
            replica,
            credentials.clone(),
            opened,
            target.clone(),
        )));
        started.await.context("Watch did not open")?;
    }

    operator(&endpoints[0])
        .await?
        .put_tag(credentials.request(PutTagRequest {
            tag_id: TAG.into(),
            instructions: INSTRUCTIONS.into(),
            allowed_actions: vec!["files:read".into()],
            ..Default::default()
        })?)
        .await?;
    // Each Objective owner asks the operator a question, which every Gateway may notify.
    for (replica, objective) in [(1, "release"), (2, "hotfix")] {
        let mut command = credentials.command();
        command
            .args(["objective", "--gateway", &endpoints[replica]])
            .args(["create", objective, "--owner", TAG, QUESTION]);
        cli(command, directory).await?;
    }
    let mut tasks = submit_all(
        &endpoints,
        &credentials,
        (0..9).map(|n| (n % REPLICAS, (n + 1) % REPLICAS, format!("first-{n}"))),
    )
    .await?;

    // The Worker Host executes through replica 1; each Attempt waits for the release file.
    let release = directory.join("release");
    let (adapter, launches) = recording_adapter(directory)?;
    let mut host = credentials.command();
    host.args(["worker-host", "--gateway", &endpoints[1], "--adapter"])
        .arg(&adapter)
        .arg("--adapter-arg=--objective-question")
        .arg(format!(
            "--adapter-arg=--wait-for-file={}",
            release.display()
        ))
        .arg("--state-directory")
        .arg(directory.join("host"));
    let mut host = Process::spawn(host, directory, "worker-host", false)?;
    first_running(database).await?;

    // Kill replica 1 while its Worker Host holds a running Attempt. Work continues through
    // the other replicas, then replica 1 restarts and its host carries on.
    replicas[1].control_plane.kill()?;
    tasks.extend(
        submit_all(
            &endpoints,
            &credentials,
            (0..4).map(|n| {
                (
                    if n % 2 == 0 { 0 } else { 2 },
                    2 - 2 * (n % 2),
                    format!("during-{n}"),
                )
            }),
        )
        .await?,
    );
    sleep(Duration::from_millis(1_500)).await;
    restart(&mut replicas[1], &credentials, database, directory).await?;
    std::fs::write(&release, b"")?;

    // Kill replica 2 while Attempts finish and notifications are claimed, then restart it.
    sleep(Duration::from_millis(300)).await;
    replicas[2].control_plane.kill()?;
    tasks.extend(
        submit_all(
            &endpoints,
            &credentials,
            (0..2).map(|n| (0, 1 - n, format!("after-{n}"))),
        )
        .await?,
    );
    sleep(Duration::from_millis(1_000)).await;
    restart(&mut replicas[2], &credentials, database, directory).await?;

    // Every Task succeeds, through whichever replica observes it.
    let mut connection = database::connect(database).await?;
    let deadline = Instant::now() + Duration::from_secs(120);
    let all = loop {
        let rows = sqlx::query("SELECT task_id, state FROM supertag_v2_tasks")
            .fetch_all(&mut connection)
            .await?;
        let states: BTreeMap<String, i64> = rows
            .iter()
            .map(|row| Ok((row.try_get("task_id")?, row.try_get("state")?)))
            .collect::<Result<_>>()?;
        let succeeded = states
            .values()
            .all(|state| *state == TaskState::Succeeded as i64);
        let delivered = webhook.bodies.lock().await.len() >= 2;
        if succeeded && delivered && states.len() == tasks.len() + 2 {
            break states;
        }
        if let Some(status) = host.child.try_wait()? {
            bail!("Worker Host exited with {status}: {}", host.logs());
        }
        ensure!(
            Instant::now() < deadline,
            "work did not finish: {states:?}, {} notifications; host: {}",
            webhook.bodies.lock().await.len(),
            host.logs()
        );
        sleep(Duration::from_millis(100)).await;
    };
    for task in &tasks {
        ensure!(all.contains_key(&task.task_id), "a submitted Task was lost");
    }

    // No Attempt ran twice: one adapter launch per Task, and each Task recorded its events once.
    let launched = std::fs::read_to_string(&launches)?.lines().count();
    ensure!(
        launched == all.len(),
        "{launched} adapter launches for {} Tasks",
        all.len()
    );
    for (index, task_id) in all.keys().enumerate() {
        let mut client = operator(&endpoints[index % REPLICAS]).await?;
        let events = client
            .list_events(credentials.request(ListEventsRequest {
                task_id: task_id.clone(),
                after_sequence: 0,
                limit: 100,
            })?)
            .await?
            .into_inner()
            .events;
        let sequences: Vec<u64> = events.iter().map(|event| event.sequence).collect();
        let expected: Vec<u64> = (1..=sequences.len() as u64).collect();
        ensure!(
            !sequences.is_empty() && sequences == expected,
            "{task_id} events {sequences:?}"
        );
    }

    // Every Gateway delivers from the one outbox, and each notification goes out once. Leave
    // every notifier several polls to repeat one.
    sleep(Duration::from_secs(6)).await;
    let bodies = webhook.bodies.lock().await.clone();
    let mut objectives: Vec<String> = bodies
        .iter()
        .map(|body| body["objectiveId"].as_str().unwrap_or_default().to_owned())
        .collect();
    objectives.sort();
    ensure!(
        objectives == ["hotfix", "release"],
        "notifications delivered: {bodies:?}"
    );
    let mut keys = BTreeSet::new();
    for body in &bodies {
        ensure!(body["kinds"] == serde_json::json!(["question"]), "{body}");
        for key in body["itemKeys"].as_array().context("itemKeys")? {
            ensure!(keys.insert(key.to_string()), "{key} notified twice");
        }
    }
    let unsettled: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM supertag_v2_operator_notifications WHERE status<>3 OR attempt_count<>1",
    )
    .fetch_one(&mut connection)
    .await?;
    ensure!(
        unsettled == 0,
        "{unsettled} notifications not delivered once"
    );

    // Every Watch saw the same gap-free positions, whichever replicas served it.
    let head: i64 = sqlx::query_scalar("SELECT head FROM supertag_v2_watch_state")
        .fetch_one(&mut connection)
        .await?;
    until.send(head)?;
    let mut followed = Vec::new();
    for follower in followers {
        followed.push(tokio::time::timeout(WAIT, follower).await???);
    }
    let start = followed.iter().map(|f| f.start).max().unwrap_or_default();
    let expected: Vec<i64> = (start + 1..=head).collect();
    for (replica, stream) in followed.iter().enumerate() {
        let seen: Vec<i64> = stream
            .changes
            .iter()
            .copied()
            .filter(|position| *position > start)
            .collect();
        ensure!(
            seen == expected,
            "Watch on replica {replica} saw {seen:?}, expected {start}..={head}"
        );
    }
    ensure!(
        followed[1].resumed > 0 && followed[2].resumed > 0,
        "the killed replicas' Watch streams never resumed elsewhere"
    );

    // Maintenance moves to whichever replica survives. A Worker Host is killed while its
    // Attempt runs; only the periodic maintenance pass expires that Attempt's lease, and two of
    // the three replicas are killed before it is due.
    host.kill()?;
    let never = directory.join("never");
    let mut stranding = credentials.command();
    stranding
        .args(["worker-host", "--gateway", &endpoints[0], "--adapter"])
        .arg(&adapter)
        .arg(format!("--adapter-arg=--wait-for-file={}", never.display()))
        .arg("--state-directory")
        .arg(directory.join("stranding-host"));
    let mut stranding = Process::spawn(stranding, directory, "stranding-host", false)?;
    let stranded = submit(&endpoints, &credentials, 0, 2, "stranded".into()).await?;
    let deadline = Instant::now() + WAIT;
    // The Attempt runs once its adapter launched.
    while task_state(&mut connection, &stranded.task_id).await? != TaskState::Running as i64
        || std::fs::read_to_string(&launches)?.lines().count() <= all.len()
    {
        ensure!(
            Instant::now() < deadline,
            "the stranded Task never ran: {}",
            stranding.logs()
        );
        sleep(Duration::from_millis(50)).await;
    }
    stranding.kill()?;
    replicas[0].control_plane.kill()?;
    replicas[1].control_plane.kill()?;
    let deadline = Instant::now() + Duration::from_secs(90);
    while task_state(&mut connection, &stranded.task_id).await? != TaskState::Uncertain as i64 {
        ensure!(
            Instant::now() < deadline,
            "no surviving replica expired the stranded Attempt: {}",
            replicas[2].control_plane.logs()
        );
        sleep(Duration::from_millis(200)).await;
    }
    let launched = std::fs::read_to_string(&launches)?.lines().count();
    ensure!(
        launched == all.len() + 1,
        "{launched} adapter launches for {} Tasks",
        all.len() + 1
    );
    // Release the killed host's orphaned adapter.
    std::fs::write(&never, b"")?;
    drop(replicas);
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sqlite_refuses_a_second_control_plane_process() -> Result<()> {
    let directory = TempDir::new()?;
    let directory = directory.path();
    let database = format!(
        "sqlite://{}?mode=rwc",
        directory.join("control-plane.db").display()
    );
    let credentials = Credentials::new();
    let mut first = control_plane(&credentials, &database, directory, "127.0.0.1:0")?;
    first.endpoint().await?;
    let mut second = control_plane(&credentials, &database, directory, "127.0.0.1:0")?;
    let status = second.exit().await?;
    ensure!(!status.success(), "a second SQLite Control Plane started");
    let logs = second.logs();
    ensure!(
        logs.contains("another Control Plane process is using the SQLite database")
            && logs.contains("use PostgreSQL to run several Control Plane replicas"),
        "{logs}"
    );
    // The first process still serves; once it stops, the database is free again.
    ensure!(first.child.try_wait()?.is_none(), "{}", first.logs());
    first.kill()?;
    let mut third = control_plane(&credentials, &database, directory, "127.0.0.1:0")?;
    third
        .endpoint()
        .await
        .map_err(|error| anyhow!("restart after the first stopped: {error}"))?;
    Ok(())
}
