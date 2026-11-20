//! A conversation turn whose Worklet died while it ran becomes uncertain once its lease lapses,
//! and the person's next message waits behind it. The operator inbox shows the turn with what
//! waits behind it; a decision recorded with `supertag task resolve-attempt` frees the Session,
//! and the queued message then runs. The shipped `supertag` Control Plane and Worklet processes,
//! on SQLite and PostgreSQL.
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
    os::unix::process::ExitStatusExt as _,
    path::Path,
    process::Stdio,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, ensure};
use serde_json::Value;
use supertag_protocol::{CRASH_MARKER_ENV, CRASH_POINT_ENV};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    time::{sleep, timeout},
};
use uuid::Uuid;

const BINARY: &str = env!("CARGO_BIN_EXE_supertag");
const ADAPTER: &str = env!("CARGO_BIN_EXE_supertag-fixture-adapter");
const WAIT: Duration = Duration::from_secs(45);
/// An unrenewed lease lapses after 30 s; the Control Plane's sweep then marks it uncertain.
const LAPSE: Duration = Duration::from_secs(90);
const TAG: &str = "chat";

database_tests! {
    #[tokio::test]
    an_uncertain_turn_shows_in_the_inbox_and_its_decision_lets_the_next_turn_run;
}

async fn an_uncertain_turn_shows_in_the_inbox_and_its_decision_lets_the_next_turn_run(
    database: String,
) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let root = directory.path();
    let services = Services::start(database.as_str()).await?;
    json(services.cli(&["tag", "put", TAG, "--instructions", "Answer"])).await?;

    // The Worklet dies while the first turn executes, and nothing restarts it.
    success(services.cli(&["message", TAG, "Check CI", "--no-wait"])).await?;
    let first = only_task(&services).await?;
    let state = root.join("host");
    let marker = root.join("crash-marker");
    let point = "worker-host.execute.journaled";
    let status = timeout(
        WAIT,
        services
            .worklet(&state)
            .env(CRASH_POINT_ENV, point)
            .env(CRASH_MARKER_ENV, &marker)
            .status(),
    )
    .await
    .context("the Worklet did not exit")??;
    ensure!(
        status.signal() == Some(libc::SIGKILL),
        "the Worklet exited with {status}"
    );
    let attempt = field(&task(&services, &first).await?, "attempt_id")?.to_owned();

    // Its lease lapses: the turn is uncertain, and the person's next message waits behind it.
    let deadline = Instant::now() + LAPSE;
    while task(&services, &first).await?["state"] != "TASK_STATE_UNCERTAIN" {
        ensure!(Instant::now() < deadline, "the turn never became uncertain");
        sleep(Duration::from_millis(250)).await;
    }
    success(services.cli(&["message", TAG, "Any news?", "--no-wait"])).await?;
    let next = json(services.cli(&["get", "tasks", "--tag", TAG])).await?["tasks"]
        .as_array()
        .context("no Tasks")?
        .iter()
        .find_map(|task| task["task_id"].as_str().filter(|id| *id != first))
        .context("the second message has no Task")?
        .to_owned();
    assert_eq!(task(&services, &next).await?["state"], "TASK_STATE_QUEUED");

    // The operator inbox shows the conversation turn, what waits behind it, and that its host
    // never confirmed it stopped, so SuperTag leaves it for a person.
    let inbox = json(services.cli(&["get", "inbox-items", "--kind", "task-attention"])).await?;
    let items = inbox["items"].as_array().context("no inbox items")?;
    let item = items
        .iter()
        .find(|item| item["task_id"] == first.as_str())
        .with_context(|| format!("the uncertain turn is not in the inbox: {inbox}"))?;
    assert_eq!(item["attempt_id"], attempt.as_str(), "{item}");
    let uncertain = &item["uncertain_attempt"];
    assert_eq!(uncertain["tag_id"], TAG, "{item}");
    assert_eq!(uncertain["blocked_tasks"], 1, "{item}");
    assert_eq!(uncertain["cleanup"], "unknown", "{item}");
    assert!(uncertain["auto_resolve_at_ms"].is_null(), "{item}");
    assert!(
        uncertain["held_reason"]
            .as_str()
            .is_some_and(|reason| reason.contains("not confirmed")),
        "{item}"
    );

    // The operator checked the host and records the turn as failed.
    success(services.cli(&[
        "task",
        "resolve-attempt",
        &first,
        &attempt,
        "--decision",
        "failed",
        "--confirmed-stopped",
        "--evidence",
        "The test killed the Worklet; its Worker died with it.",
    ]))
    .await?;
    assert_eq!(task(&services, &first).await?["state"], "TASK_STATE_FAILED");
    let inbox = json(services.cli(&["get", "inbox-items", "--kind", "task-attention"])).await?;
    assert!(
        !inbox["items"]
            .as_array()
            .context("no inbox items")?
            .iter()
            .any(|item| item["task_id"] == first.as_str()),
        "the decided turn left the inbox: {inbox}"
    );

    // A Worklet settles the dead Attempt and runs the queued message.
    for _ in 0..3 {
        let ran = timeout(WAIT, services.worklet(&state).status()).await??;
        ensure!(ran.success(), "the Worklet exited with {ran}");
        if task(&services, &next).await?["state"] == "TASK_STATE_SUCCEEDED" {
            break;
        }
    }
    let answered = task(&services, &next).await?;
    assert_eq!(answered["state"], "TASK_STATE_SUCCEEDED", "{answered}");
    assert_eq!(task(&services, &first).await?["state"], "TASK_STATE_FAILED");
    Ok(())
}

struct Services {
    operator: String,
    host: String,
    public: String,
    _plane: Child,
}

impl Services {
    async fn start(database: &str) -> Result<Self> {
        let gateway = supertag_protocol::new_secret(supertag_protocol::CREDENTIAL_SECRET_PREFIX);
        let operator = Uuid::new_v4().to_string();
        let host = supertag_protocol::new_secret(supertag_protocol::CREDENTIAL_SECRET_PREFIX);
        let mut plane = bare(&["control-plane"]);
        plane
            .env("SUPERTAG_BOOTSTRAP_GATEWAY_CREDENTIAL", &gateway)
            .env("SUPERTAG_GATEWAY_CREDENTIAL", &gateway)
            .env("SUPERTAG_OPERATOR_TOKEN", &operator)
            .env("SUPERTAG_BOOTSTRAP_HOST_TOKEN", &host)
            .env("SUPERTAG_DATABASE_URL", database);
        let (plane, public) = service(plane).await?;
        Ok(Self {
            operator,
            host,
            public,
            _plane: plane,
        })
    }

    fn cli(&self, args: &[&str]) -> Command {
        let mut command = bare(&[args[0], "--gateway", &self.public]);
        command
            .args(&args[1..])
            .env("SUPERTAG_OPERATOR_TOKEN", &self.operator);
        command
    }

    /// A Worklet that runs one Task Attempt with the fixture adapter.
    fn worklet(&self, state: &Path) -> Command {
        let mut command = bare(&["worklet", "--control-plane", &self.public, "--once"]);
        command
            .arg("--adapter")
            .arg(ADAPTER)
            .arg("--state-directory")
            .arg(state)
            .env("SUPERTAG_HOST_TOKEN", &self.host)
            .stdout(Stdio::null());
        command
    }
}

/// The only Task of the Tag, the first turn.
async fn only_task(services: &Services) -> Result<String> {
    let listed = json(services.cli(&["get", "tasks", "--tag", TAG])).await?;
    let tasks = listed["tasks"].as_array().context("no Tasks")?;
    ensure!(tasks.len() == 1, "{listed}");
    Ok(field(&tasks[0], "task_id")?.to_owned())
}

async fn task(services: &Services, id: &str) -> Result<Value> {
    json(services.cli(&["get", "task", id])).await
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
    Ok((child, format!("http://{address}")))
}

async fn output(mut command: Command) -> Result<std::process::Output> {
    Ok(timeout(WAIT, command.output())
        .await
        .context("CLI command timed out")??)
}

async fn success(command: Command) -> Result<()> {
    let output = output(command).await?;
    ensure!(
        output.status.success(),
        "CLI failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(())
}

async fn json(command: Command) -> Result<Value> {
    let output = output(command).await?;
    ensure!(
        output.status.success(),
        "CLI failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(serde_json::from_slice(&output.stdout)?)
}

fn field<'a>(value: &'a Value, name: &str) -> Result<&'a str> {
    value[name]
        .as_str()
        .with_context(|| format!("missing {name}: {value}"))
}
