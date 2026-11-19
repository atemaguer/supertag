//! A Worklet and its Worker killed at the journal stages of a Task that delivers to a local
//! Workspace: Finalizing (the Worklet journaled that the turn ended, and either it or its Worker
//! died before the Worker kept the turn's captures, which a new Worker then resumes; or the
//! Worklet journaled the Worker's outcome, or the Worker handed it over and died before it
//! exited) and Terminal (the Worklet journaled the settled Task, before
//! its cleanup). Each case runs the shipped `supertag` Control Plane and Worklet processes
//! with a test-only crash point, restarts only the Worklet when it was the one killed, and
//! asserts the Task succeeds once: one harness launch, its delivery committed, one Attempt, and
//! the host's entry and checkout cleared. The earlier stages (Claim, Starting, Executing, and a
//! Task without a Workspace) are in `crash_durability.rs`; PreparingInputs, which only a harness
//! with Task artifact inputs reaches, in `support/task_artifact_inputs_runtime.rs`.
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
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use anyhow::{Context, Result, ensure};
use serde_json::Value;
use supertag_protocol::{CRASH_MARKER_ENV, CRASH_POINT_ENV};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    time::timeout,
};
use uuid::Uuid;

const BINARY: &str = env!("CARGO_BIN_EXE_supertag");
const ADAPTER: &str = env!("CARGO_BIN_EXE_supertag-fixture-adapter");
const WAIT: Duration = Duration::from_secs(45);

/// Which process kills itself.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Killed {
    Worklet,
    Worker,
}

database_tests! {
    #[tokio::test]
    worklet_killed_before_the_captures_resumes_them_on_restart;
    #[tokio::test]
    worker_killed_before_the_captures_leaves_them_to_another_worker;
    #[tokio::test]
    worklet_killed_with_its_outcome_journaled_finalizes_on_restart;
    #[tokio::test]
    worker_killed_after_its_outcome_leaves_its_worklet_to_finalize;
    #[tokio::test]
    worklet_killed_after_the_terminal_record_cleans_up_on_restart;
}

async fn worklet_killed_before_the_captures_resumes_them_on_restart(
    database: String,
) -> Result<()> {
    scenario(
        &database,
        Killed::Worklet,
        "worker-host.finalizing.journaled",
        "finalizing",
    )
    .await
}

async fn worker_killed_before_the_captures_leaves_them_to_another_worker(
    database: String,
) -> Result<()> {
    scenario(
        &database,
        Killed::Worker,
        "worker.finalizing.journaled",
        "finalizing",
    )
    .await
}

async fn worklet_killed_with_its_outcome_journaled_finalizes_on_restart(
    database: String,
) -> Result<()> {
    scenario(
        &database,
        Killed::Worklet,
        "worker-host.outcome.journaled",
        "finalizing",
    )
    .await
}

async fn worker_killed_after_its_outcome_leaves_its_worklet_to_finalize(
    database: String,
) -> Result<()> {
    scenario(
        &database,
        Killed::Worker,
        "worker.outcome.handed",
        "finalizing",
    )
    .await
}

async fn worklet_killed_after_the_terminal_record_cleans_up_on_restart(
    database: String,
) -> Result<()> {
    scenario(
        &database,
        Killed::Worklet,
        "worker-host.terminal.journaled",
        "terminal",
    )
    .await
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

    /// A Worklet that runs one Task Attempt, with `crash` selecting its crash point.
    fn worklet(
        &self,
        state: &Path,
        (adapter, source): (&Path, &Path),
        crash: Option<(&str, &Path)>,
    ) -> Command {
        let mut command = bare(&[
            "worklet",
            "--control-plane",
            &self.public,
            "--adapter-arg=--workspace-fixture",
            "--once",
        ]);
        command
            .arg("--adapter")
            .arg(adapter)
            .arg("--state-directory")
            .arg(state)
            .args(["--workspace-id", "app", "--workspace-source"])
            .arg(source)
            .env("SUPERTAG_HOST_TOKEN", &self.host)
            .stdout(Stdio::null());
        if let Some((point, marker)) = crash {
            command
                .env(CRASH_POINT_ENV, point)
                .env(CRASH_MARKER_ENV, marker);
        }
        command
    }
}

async fn scenario(database: &str, killed: Killed, point: &str, stage: &str) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let root = directory.path();
    let source = root.join("app");
    std::fs::create_dir(&source)?;
    git(&source, &["init", "--quiet"]).await?;
    std::fs::write(source.join("workspace.txt"), "app source\n")?;
    git(&source, &["add", "workspace.txt"]).await?;
    git(&source, &["commit", "--quiet", "-m", "Initial source"]).await?;
    let base = git(&source, &["rev-parse", "HEAD"]).await?;
    let (adapter, launches) = recording_adapter(root)?;
    let services = Services::start(database).await?;
    json(services.cli(&[
        "tag",
        "put",
        "builder",
        "--instructions",
        "Edit the Workspace",
        "--allow",
        "files:read",
        "--allow",
        "files:write",
        "--workspace-id",
        "app",
        "--workspace-base",
        &base,
    ]))
    .await?;
    let task = json(services.cli(&[
        "task",
        "submit",
        "--tag",
        "builder",
        "--session",
        "kill",
        "add a line",
    ]))
    .await?;
    let task_id = field(&task, "task_id")?.to_owned();
    let state = root.join("host");
    let marker = root.join("crash-marker");
    let status = timeout(
        WAIT,
        services
            .worklet(&state, (&adapter, &source), Some((point, &marker)))
            .status(),
    )
    .await
    .context("the Worklet did not exit")??;
    ensure!(
        std::fs::read_to_string(&marker)? == point,
        "crash point {point} was never reached"
    );
    let entry = state.join("slots/adapter-0/attempt.json");
    match killed {
        Killed::Worklet => {
            ensure!(
                status.signal() == Some(libc::SIGKILL),
                "the Worklet exited with {status} instead of SIGKILL"
            );
            // The journal entry still names the stage the Worklet died at.
            let journal: Value = serde_json::from_slice(&std::fs::read(&entry)?)?;
            assert_eq!(journal["stage"], stage);
            assert_eq!(journal["task_id"], task_id.as_str());
            // Only the killed process restarts.
            let restarted = timeout(
                WAIT,
                services.worklet(&state, (&adapter, &source), None).status(),
            )
            .await
            .context("the restarted Worklet did not exit")??;
            ensure!(
                restarted.success(),
                "the restarted Worklet exited with {restarted}"
            );
        }
        // The Worklet recovered its Worker's Attempt itself and settled it.
        Killed::Worker => ensure!(status.success(), "the Worklet exited with {status}"),
    }
    let settled = json(services.cli(&["get", "task", &task_id])).await?;
    assert_eq!(settled["state"], "TASK_STATE_SUCCEEDED", "{settled}");
    assert_eq!(
        settled["result"]
            .as_str()
            .map(|result| result.starts_with("add a line")),
        Some(true),
        "{settled}"
    );
    assert_eq!(
        settled["workspace_delivery"]["committed"], true,
        "{settled}"
    );
    // Nothing ran or finished twice: one launch, and the Attempt that started is the one that
    // settled.
    let launched = std::fs::read_to_string(&launches)?.lines().count();
    assert_eq!(launched, 1, "the harness launched {launched} times");
    let attempts = json(services.cli(&["get", "task", &task_id])).await?;
    assert_eq!(attempts["attempt_id"], settled["attempt_id"]);
    assert!(!entry.exists(), "the settled Attempt's entry was cleared");
    // A later host finds nothing left to do for it.
    let again = timeout(
        WAIT,
        services.worklet(&state, (&adapter, &source), None).status(),
    )
    .await??;
    ensure!(again.success());
    assert_eq!(std::fs::read_to_string(&launches)?.lines().count(), 1);
    assert_eq!(
        json(services.cli(&["get", "task", &task_id])).await?["state"],
        "TASK_STATE_SUCCEEDED"
    );
    Ok(())
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

async fn json(mut command: Command) -> Result<Value> {
    let output = timeout(WAIT, command.output())
        .await
        .context("CLI command timed out")??;
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

async fn git(directory: &Path, arguments: &[&str]) -> Result<String> {
    let output = Command::new("git")
        .args(arguments)
        .current_dir(directory)
        .env("GIT_AUTHOR_NAME", "Fixture")
        .env("GIT_AUTHOR_EMAIL", "fixture@example.com")
        .env("GIT_COMMITTER_NAME", "Fixture")
        .env("GIT_COMMITTER_EMAIL", "fixture@example.com")
        .output()
        .await?;
    ensure!(
        output.status.success(),
        "git {arguments:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(String::from_utf8(output.stdout)?.trim().to_owned())
}
