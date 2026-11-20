//! A Worker sends its Task Attempt's data calls to the data endpoint the Control Plane names, and
//! only there. Through a Gateway, its events, streamed text, and question reach the Control Plane;
//! a data endpoint that refuses connections fails the Attempt once, with failure detail naming
//! that endpoint, and nothing falls back to the Control Plane.
#[path = "support/children.rs"]
mod children;
use children::reaped;
#[path = "../../../test-support/prerequisites.rs"]
mod prerequisites;
#[macro_use]
#[path = "support/database.rs"]
mod database;

use std::{
    net::SocketAddr,
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use anyhow::{Context, Result, ensure};
use serde_json::Value;
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    net::{TcpListener, TcpStream},
    process::{Child, Command},
    time::timeout,
};
use uuid::Uuid;

const BINARY: &str = env!("CARGO_BIN_EXE_supertag");
const ADAPTER: &str = env!("CARGO_BIN_EXE_supertag-fixture-adapter");
const WAIT: Duration = Duration::from_secs(60);

database_tests! {
    #[tokio::test]
    a_workers_data_calls_reach_the_control_plane_through_the_gateway;
    #[tokio::test]
    an_unreachable_data_endpoint_fails_the_attempt_once_and_names_it;
    #[tokio::test]
    a_gateway_serves_on_the_listener_its_supervisor_handed_it;
}

/// A Control Plane that names `data_endpoint` to Worker Hosts, and a Gateway in front of it.
struct Services {
    operator: String,
    host: String,
    control_plane: String,
    gateway: String,
    _children: Vec<Child>,
}

impl Services {
    async fn start(database: &str, data_endpoint: &str) -> Result<Self> {
        Self::start_with(database, data_endpoint, |gateway| {
            gateway.args(["--listen", "127.0.0.1:0"]);
        })
        .await
    }

    /// Like `start`, with `listen` choosing where the Gateway serves.
    async fn start_with(
        database: &str,
        data_endpoint: &str,
        listen: impl FnOnce(&mut Command),
    ) -> Result<Self> {
        let gateway = supertag_protocol::new_secret(supertag_protocol::CREDENTIAL_SECRET_PREFIX);
        let operator = Uuid::new_v4().to_string();
        let host = supertag_protocol::new_secret(supertag_protocol::CREDENTIAL_SECRET_PREFIX);
        let mut plane = bare(&["control-plane"]);
        plane
            .env("SUPERTAG_BOOTSTRAP_GATEWAY_CREDENTIAL", &gateway)
            .env("SUPERTAG_OPERATOR_TOKEN", &operator)
            .env("SUPERTAG_BOOTSTRAP_HOST_TOKEN", &host)
            .env("SUPERTAG_DATA_ENDPOINT", data_endpoint)
            .env("SUPERTAG_DATABASE_URL", database);
        let (plane, control_plane) = service(plane).await?;
        let mut forwarder = bare(&["gateway", "--control-plane", &control_plane]);
        listen(&mut forwarder);
        forwarder.env("SUPERTAG_GATEWAY_CREDENTIAL", &gateway);
        let (forwarder, gateway) = service(forwarder).await?;
        Ok(Self {
            operator,
            host,
            control_plane,
            gateway,
            _children: vec![plane, forwarder],
        })
    }

    fn cli(&self, args: &[&str]) -> Command {
        let mut command = bare(&[args[0], "--gateway", &self.gateway]);
        command
            .args(&args[1..])
            .env("SUPERTAG_OPERATOR_TOKEN", &self.operator);
        command
    }

    /// A Worker Host on the Control Plane itself, which runs one Task Attempt and exits.
    fn worklet(&self, state: &std::path::Path, args: &[&str]) -> Command {
        let mut command = bare(&[
            "worklet",
            "--control-plane",
            &self.control_plane,
            "--adapter",
            ADAPTER,
            "--once",
        ]);
        command
            .args(args)
            .arg("--state-directory")
            .arg(state)
            .env("SUPERTAG_HOST_TOKEN", &self.host)
            .stdout(Stdio::null());
        command
    }
}

/// Relays every connection `listener` accepts to `upstream`, counting them.
fn relay(listener: TcpListener, upstream: SocketAddr) -> Arc<AtomicUsize> {
    let relayed = Arc::new(AtomicUsize::new(0));
    let counted = relayed.clone();
    tokio::spawn(async move {
        while let Ok((mut inbound, _)) = listener.accept().await {
            counted.fetch_add(1, Ordering::SeqCst);
            tokio::spawn(async move {
                if let Ok(mut outbound) = TcpStream::connect(upstream).await {
                    let _ = tokio::io::copy_bidirectional(&mut inbound, &mut outbound).await;
                }
            });
        }
    });
    relayed
}

/// The Worker's data path is a relay in front of the Gateway, so the test sees the connections it
/// opens; the Worklet's own calls go to the Control Plane.
async fn a_workers_data_calls_reach_the_control_plane_through_the_gateway(
    database: String,
) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let data_endpoint = format!("http://{}", listener.local_addr()?);
    let services = Services::start(&database, &data_endpoint).await?;
    let gateway: SocketAddr = services.gateway.trim_start_matches("http://").parse()?;
    let relayed = relay(listener, gateway);
    json(services.cli(&[
        "tag",
        "put",
        "engineer",
        "--instructions",
        "Release engineering",
    ]))
    .await?;
    json(services.cli(&[
        "objective",
        "create",
        "release",
        "--owner",
        "engineer",
        "Ask which branch to release",
    ]))
    .await?;
    let status = timeout(
        WAIT,
        services
            .worklet(
                &directory.path().join("host"),
                &[
                    // An event, streamed text, and a question, each a data call.
                    "--adapter-arg=--conversation-fixture=10",
                    "--adapter-arg=--objective-question",
                ],
            )
            .status(),
    )
    .await
    .context("the Worklet did not exit")??;
    ensure!(status.success(), "the Worklet exited with {status}");
    ensure!(
        relayed.load(Ordering::SeqCst) > 0,
        "the Worker opened no connection to its data endpoint"
    );
    let tasks = json(services.cli(&["get", "tasks"])).await?;
    let task = tasks
        .as_array()
        .or_else(|| tasks["tasks"].as_array())
        .and_then(|tasks| tasks.first())
        .with_context(|| format!("no Task: {tasks}"))?;
    let task_id = field(task, "task_id")?;
    let settled = json(services.cli(&["get", "task", task_id])).await?;
    // The fixture fails its turn when any of its data calls fails, and the Worker has no other
    // connection for them: each went through the data endpoint.
    assert_eq!(settled["state"], "TASK_STATE_SUCCEEDED", "{settled}");
    let events = text(services.cli(&["task", "events", task_id])).await?;
    ensure!(
        events.contains("I'll check the fixture, then answer"),
        "the Worker's event is missing: {events}"
    );
    // The question reached the Control Plane: the operator inbox holds it.
    let inbox = text(services.cli(&["get", "inbox-items"])).await?;
    ensure!(
        inbox.contains("Which branch should I release?"),
        "the question is missing: {inbox}"
    );
    Ok(())
}

/// Nothing listens at the data endpoint: the Worker's data calls retry within the Attempt's
/// authority, then the Attempt fails once with failure detail naming the endpoint.
async fn an_unreachable_data_endpoint_fails_the_attempt_once_and_names_it(
    database: String,
) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let refusing = std::net::TcpListener::bind("127.0.0.1:0")?;
    let data_endpoint = format!("http://{}", refusing.local_addr()?);
    drop(refusing);
    let services = Services::start(&database, &data_endpoint).await?;
    json(services.cli(&["tag", "put", "builder", "--instructions", "Build it"])).await?;
    let task = json(services.cli(&[
        "task",
        "submit",
        "--tag",
        "builder",
        "--session",
        "refused",
        "build it",
    ]))
    .await?;
    let task_id = field(&task, "task_id")?.to_owned();
    let state = directory.path().join("host");
    let status = timeout(
        WAIT,
        services
            .worklet(&state, &["--attempt-timeout-seconds", "8"])
            .status(),
    )
    .await
    .context("the Worklet did not exit")??;
    ensure!(status.success(), "the Worklet exited with {status}");
    let settled = json(services.cli(&["get", "task", &task_id])).await?;
    assert_eq!(settled["state"], "TASK_STATE_FAILED", "{settled}");
    let detail = settled["execution_report"]["failure_detail"].to_string();
    ensure!(
        detail.contains(&format!("the data endpoint {data_endpoint} is unreachable")),
        "the failure detail does not name the data endpoint: {settled}"
    );
    // One Attempt, finished once: a later host finds nothing to do and changes nothing.
    let again = timeout(WAIT, services.worklet(&state, &[]).status()).await??;
    ensure!(again.success(), "the second Worklet exited with {again}");
    let after = json(services.cli(&["get", "task", &task_id])).await?;
    assert_eq!(after["state"], "TASK_STATE_FAILED", "{after}");
    assert_eq!(after["attempt_id"], settled["attempt_id"], "{after}");
    assert_eq!(
        after["finished_at_ms"], settled["finished_at_ms"],
        "{after}"
    );
    Ok(())
}

/// `supertag up` binds the Gateway's port and hands the socket over, so the port is never free
/// between being chosen and the Gateway serving on it: a program binding it in a loop all the
/// while never gets it, and the Gateway still starts and serves there.
async fn a_gateway_serves_on_the_listener_its_supervisor_handed_it(database: String) -> Result<()> {
    use std::os::fd::{AsRawFd as _, OwnedFd};
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    let address = listener.local_addr()?;
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let competitor = {
        let stop = stop.clone();
        std::thread::spawn(move || {
            let mut attempts = 0_usize;
            while !stop.load(Ordering::SeqCst) {
                if std::net::TcpListener::bind(address).is_ok() {
                    return Err(attempts);
                }
                attempts += 1;
                std::thread::sleep(Duration::from_millis(1));
            }
            Ok(attempts)
        })
    };
    let socket = OwnedFd::from(listener);
    let fd = socket.as_raw_fd();
    let services = Services::start_with(&database, "http://127.0.0.1:9", move |gateway| {
        gateway.args(["--listen-fd", &fd.to_string()]);
        // SAFETY: clearing close-on-exec with fcntl is async-signal-safe.
        unsafe {
            gateway.pre_exec(move || {
                if libc::fcntl(socket.as_raw_fd(), libc::F_SETFD, 0) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    })
    .await?;
    assert_eq!(services.gateway, format!("http://{address}"));
    // The Gateway serves operator calls on the handed-over socket.
    json(services.cli(&["tag", "put", "handed", "--instructions", "Serve here"])).await?;
    let tags = text(services.cli(&["get", "tags"])).await?;
    ensure!(tags.contains("handed"), "the Tag is missing: {tags}");
    stop.store(true, Ordering::SeqCst);
    let attempts = competitor
        .join()
        .expect("the competing bind loop panicked")
        .map_err(|attempts| {
            anyhow::anyhow!("another program bound {address} after {attempts} attempts")
        })?;
    ensure!(attempts > 0, "the competing bind loop never ran");
    Ok(())
}

fn bare(args: &[&str]) -> Command {
    let mut command = reaped(Command::new(BINARY));
    command
        .args(args)
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .stdin(Stdio::null())
        .kill_on_drop(true);
    command
}

async fn service(mut command: Command) -> Result<(Child, String)> {
    let mut child = command.stdout(Stdio::piped()).spawn()?;
    let mut stdout = BufReader::new(child.stdout.take().context("service stdout missing")?);
    let mut line = String::new();
    timeout(WAIT, stdout.read_line(&mut line))
        .await
        .context("service startup timed out")??;
    let address: SocketAddr = line.trim().parse().context("service endpoint missing")?;
    ensure!(address.ip().is_loopback() && address.port() != 0);
    // Keep reading so the service never blocks on a full pipe.
    tokio::spawn(async move {
        let mut sink = String::new();
        while stdout.read_line(&mut sink).await.is_ok_and(|read| read > 0) {
            sink.clear();
        }
    });
    Ok((child, format!("http://{address}")))
}

async fn json(command: Command) -> Result<Value> {
    Ok(serde_json::from_str(&text(command).await?)?)
}

async fn text(mut command: Command) -> Result<String> {
    let output = timeout(WAIT, command.output())
        .await
        .context("CLI command timed out")??;
    ensure!(
        output.status.success(),
        "CLI failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(String::from_utf8(output.stdout)?)
}

fn field<'a>(value: &'a Value, name: &str) -> Result<&'a str> {
    value[name]
        .as_str()
        .with_context(|| format!("missing {name}: {value}"))
}
