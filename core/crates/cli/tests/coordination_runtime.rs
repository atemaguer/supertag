//! Coordination and safety features through separate Control Plane, Gateway, and Worker Host
//! processes: Objective overlap warnings, Worker-managed effect receipts, and a Slack message
//! that selects an authorized GitHub Workspace.
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
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    time::{sleep, timeout},
};
use uuid::Uuid;

const BINARY: &str = env!("CARGO_BIN_EXE_supertag");
const ADAPTER: &str = env!("CARGO_BIN_EXE_supertag-fixture-adapter");
/// Bounds one test wait for a service, a command, or a Task. Only the test waits this long; the
/// product's own deadlines are unchanged. Parallel cases on a loaded machine have stretched a
/// service's startup past 30 seconds.
const WAIT: Duration = Duration::from_secs(90);

struct Credentials {
    gateway: String,
    operator: String,
    host: String,
}

impl Credentials {
    fn new() -> Self {
        Self {
            gateway: supertag_protocol::new_secret(supertag_protocol::CREDENTIAL_SECRET_PREFIX),
            operator: Uuid::new_v4().to_string(),
            host: supertag_protocol::new_secret(supertag_protocol::CREDENTIAL_SECRET_PREFIX),
        }
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut command = reaped(Command::new(BINARY));
        command
            .args(args)
            .env_clear()
            .env("SUPERTAG_BOOTSTRAP_GATEWAY_CREDENTIAL", &self.gateway)
            .env("SUPERTAG_GATEWAY_CREDENTIAL", &self.gateway)
            .env("SUPERTAG_OPERATOR_TOKEN", &self.operator)
            .env("SUPERTAG_HOST_TOKEN", &self.host)
            .env("SUPERTAG_BOOTSTRAP_HOST_TOKEN", &self.host)
            .stdin(Stdio::null())
            .kill_on_drop(true);
        command
    }

    fn worker(&self, public: &str, state: &Path, source: Option<&Path>, modes: &[&str]) -> Command {
        let mut command = self.command(&[
            "worklet",
            "--control-plane",
            public,
            "--adapter",
            ADAPTER,
            "--once",
        ]);
        for mode in modes {
            command.arg(format!("--adapter-arg={mode}"));
        }
        command.arg("--state-directory").arg(state);
        if let Some(source) = source {
            command
                .args(["--workspace-id", "project", "--workspace-source"])
                .arg(source);
        }
        command
    }
}

/// A Control Plane with optional extra arguments.
struct Services {
    plane: Child,
    public: String,
}

impl Services {
    async fn start(
        credentials: &Credentials,
        database: &str,
        plane: impl Fn(&mut Command),
    ) -> Result<Self> {
        let mut command = credentials.command(&["control-plane"]);
        command.env("SUPERTAG_DATABASE_URL", database);
        plane(&mut command);
        let (plane, mut public) = service(command, 1).await?;
        Ok(Self {
            plane,
            public: public.remove(0),
        })
    }

    fn cli(&self, credentials: &Credentials, args: &[&str]) -> Command {
        let mut command = credentials.command(&[args[0], "--gateway", &self.public]);
        command.args(&args[1..]);
        command
    }

    async fn stop(mut self) -> Result<()> {
        self.plane.kill().await?;
        Ok(())
    }
}

async fn service(mut command: Command, lines: usize) -> Result<(Child, Vec<String>)> {
    let mut child = command.stdout(Stdio::piped()).spawn()?;
    let mut stdout = BufReader::new(child.stdout.take().context("service stdout missing")?);
    let mut endpoints = Vec::new();
    for _ in 0..lines {
        let mut line = String::new();
        timeout(WAIT, stdout.read_line(&mut line))
            .await
            .context("service startup timed out")??;
        let address: SocketAddr = line.trim().parse().context("service endpoint missing")?;
        ensure!(address.ip().is_loopback() && address.port() != 0);
        endpoints.push(format!("http://{address}"));
    }
    Ok((child, endpoints))
}

async fn output(mut command: Command) -> Result<std::process::Output> {
    Ok(timeout(WAIT, command.output())
        .await
        .context("command timed out")??)
}

async fn success(command: Command) -> Result<std::process::Output> {
    let output = output(command).await?;
    ensure!(
        output.status.success(),
        "command failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(output)
}

async fn json(command: Command) -> Result<Value> {
    Ok(serde_json::from_slice(&success(command).await?.stdout)?)
}

fn field<'a>(value: &'a Value, name: &str) -> Result<&'a str> {
    value[name]
        .as_str()
        .with_context(|| format!("missing {name}: {value}"))
}

async fn git(source: &Path, arguments: &[&str]) -> Result<String> {
    let mut command = Command::new("/usr/bin/git");
    command
        .arg("-C")
        .arg(source)
        .args(arguments)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_AUTHOR_NAME", "Fixture")
        .env("GIT_AUTHOR_EMAIL", "fixture@example.invalid")
        .env("GIT_COMMITTER_NAME", "Fixture")
        .env("GIT_COMMITTER_EMAIL", "fixture@example.invalid");
    Ok(String::from_utf8(success(command).await?.stdout)?
        .trim()
        .into())
}

async fn repository(root: &Path) -> Result<(PathBuf, String)> {
    let source = root.join("source");
    std::fs::create_dir(&source)?;
    git(&source, &["init", "--quiet"]).await?;
    std::fs::write(source.join("workspace.txt"), "base\n")?;
    git(&source, &["add", "workspace.txt"]).await?;
    git(&source, &["commit", "--quiet", "-m", "Initial source"]).await?;
    let base = git(&source, &["rev-parse", "HEAD"]).await?;
    Ok((source, base))
}

database_tests! {
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    overlapping_work_sessions_warn_their_objective_once;
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    worker_managed_effects_replay_and_stay_in_doubt_across_restart;
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    an_owner_report_finishes_its_objective_through_the_worker_host;
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    a_tag_schedules_a_follow_up_that_the_sweep_fires;
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    work_session_limits_show_and_an_operator_closes_one;
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    a_tag_keeps_a_note_that_people_read_and_delete;
}

/// A Tag's `max_work_sessions` is set with `tag put`, Tag and Work Session reads count its open
/// Work Sessions, and `session close` closes one so it stops counting.
async fn work_session_limits_show_and_an_operator_closes_one(database: String) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let root = directory.path();
    let credentials = Credentials::new();
    let services = Services::start(&credentials, &database, |_| {}).await?;
    let cli = |args: &[&str]| services.cli(&credentials, args);
    let tag = json(cli(&[
        "tag",
        "put",
        "lead",
        "--instructions",
        "Plan and delegate",
        "--allow",
        "files:read",
        "--max-work-sessions",
        "3",
    ]))
    .await?;
    ensure!(tag["max_work_sessions"] == 3, "{tag}");
    let refused = output(cli(&[
        "tag",
        "put",
        "lead",
        "--instructions",
        "Plan and delegate",
        "--max-work-sessions",
        "65",
    ]))
    .await?;
    ensure!(!refused.status.success(), "65 is above the limit");
    json(cli(&[
        "task",
        "submit",
        "--tag",
        "lead",
        "--session",
        "plan",
        "Split the work",
    ]))
    .await?;
    success(credentials.worker(
        &public(&services),
        &root.join("host"),
        None,
        &["--start-work-session"],
    ))
    .await?;
    let listed = json(cli(&[
        "get",
        "sessions",
        "--parent-tag",
        "lead",
        "--parent-session",
        "plan",
    ]))
    .await?;
    ensure!(
        listed["open_work_sessions"] == 1 && listed["max_work_sessions"] == 3,
        "{listed}"
    );
    let id = field(&listed["work_sessions"][0], "work_session_id")?.to_owned();
    let read = json(cli(&["get", "tag", "lead"])).await?;
    ensure!(
        read["max_work_sessions"] == 3 && read["open_work_sessions"] == 1,
        "{read}"
    );
    let closed = json(cli(&["session", "close", &id])).await?;
    ensure!(
        closed["close_reason"] == "WORK_SESSION_CLOSE_REASON_OPERATOR"
            && closed["closed_at_ms"].is_i64(),
        "{closed}"
    );
    let listed = json(cli(&[
        "get",
        "sessions",
        "--parent-tag",
        "lead",
        "--parent-session",
        "plan",
    ]))
    .await?;
    ensure!(listed["open_work_sessions"] == 0, "{listed}");
    services.stop().await
}

/// A built-in harness's `schedule` call reaches the Control Plane through the Worker Host and
/// takes effect when its turn succeeds. When the Control Plane's clock passes the time, the
/// maintenance sweep queues the Tag's next turn in the same Session, and a Worker Host runs it;
/// that turn may stay quiet, and a person's may not. The operator commands create, pause,
/// resume, read, and delete a Schedule.
async fn a_tag_schedules_a_follow_up_that_the_sweep_fires(database: String) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let root = directory.path();
    let offset = root.join("clock-offset");
    std::fs::write(&offset, "0")?;
    let credentials = Credentials::new();
    let services = Services::start(&credentials, &database, |plane| {
        plane
            .env("SUPERTAG_TEST_CLOCK_OFFSET_FILE", &offset)
            .env("SUPERTAG_TIME_ZONE", "UTC");
    })
    .await?;
    let cli = |args: &[&str]| services.cli(&credentials, args);
    json(cli(&[
        "tag",
        "put",
        "lead",
        "--instructions",
        "Release engineering",
        "--allow",
        "files:read",
        "--allow",
        "schedule:create",
    ]))
    .await?;
    let submitted = json(cli(&[
        "task",
        "submit",
        "--tag",
        "lead",
        "--session",
        "ops",
        "Check PR 412 again in two hours",
    ]))
    .await?;
    success(credentials.worker(
        &public(&services),
        &root.join("first"),
        None,
        &["--schedule=2h", "--stay-quiet"],
    ))
    .await?;
    let first = json(cli(&["get", "task", field(&submitted, "task_id")?])).await?;
    // A person's message is always answered, even when the harness asks to stay quiet.
    ensure!(
        first["state"] == "TASK_STATE_SUCCEEDED" && first["quiet"] == false,
        "{first}"
    );
    let listed = json(cli(&["get", "schedules", "--tag", "lead"])).await?;
    let schedules = listed["schedules"].as_array().context("schedules")?;
    ensure!(schedules.len() == 1, "{listed}");
    let schedule = &schedules[0];
    let id = field(schedule, "schedule_id")?.to_owned();
    ensure!(
        field(&first, "result")?.contains(&id),
        "the tool result names the Schedule: {first}"
    );
    ensure!(
        schedule["state"] == "SCHEDULE_STATE_ACTIVE"
            && schedule["session_id"] == "ops"
            && schedule["created_by"] == "tag:lead"
            && schedule["note"] == "Check PR 412",
        "{schedule}"
    );

    // Two hours and a minute later, the sweep queues the follow-up.
    std::fs::write(&offset, (2 * 3_600_000 + 60_000).to_string())?;
    let fired = timeout(WAIT, async {
        loop {
            let read = json(cli(&["get", "schedule", &id])).await?;
            if read["state"] == "SCHEDULE_STATE_DONE" {
                return Ok::<_, anyhow::Error>(read);
            }
            sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .context("the Schedule did not fire")??;
    ensure!(fired["fire_count"] == 1, "{fired}");
    let woken = field(&fired, "last_task_id")?.to_owned();
    success(credentials.worker(
        &public(&services),
        &root.join("second"),
        None,
        &["--schedule=2h", "--stay-quiet"],
    ))
    .await?;
    let woken = json(cli(&["get", "task", &woken])).await?;
    ensure!(
        woken["state"] == "TASK_STATE_SUCCEEDED"
            // No person waits on a Schedule's turn, so it may finish quietly.
            && woken["quiet"] == true
            && woken["session_id"] == "ops"
            // The fixture's result repeats the prompt it ran.
            && field(&woken, "result")?.contains("Scheduled wake-up.")
            && field(&woken, "result")?.contains("\"Check PR 412\""),
        "{woken}"
    );
    // The woken turn did not schedule again.
    let listed = json(cli(&["get", "schedules", "--tag", "lead"])).await?;
    ensure!(listed["schedules"] == json!([]), "{listed}");

    // An operator's Schedule, paused, resumed, read, and deleted.
    let created = json(cli(&[
        "schedule",
        "create",
        "--tag",
        "lead",
        "--every",
        "0 9 * * MON",
        "--time-zone",
        "Europe/Berlin",
        "Summarize open work",
    ]))
    .await?;
    let id = field(&created, "schedule_id")?.to_owned();
    ensure!(
        created["every"] == json!({"cron": "0 9 * * MON", "time_zone": "Europe/Berlin"})
            && created["created_by"] == "operator:local"
            && created["audience"] == "operator:local",
        "{created}"
    );
    let paused = json(cli(&["schedule", "pause", &id])).await?;
    ensure!(paused["state"] == "SCHEDULE_STATE_PAUSED", "{paused}");
    let resumed = json(cli(&["schedule", "resume", &id])).await?;
    ensure!(resumed["state"] == "SCHEDULE_STATE_ACTIVE", "{resumed}");
    let described = success(cli(&["describe", "schedule", &id])).await?;
    ensure!(
        String::from_utf8_lossy(&described.stdout).contains("Summarize open work"),
        "{}",
        String::from_utf8_lossy(&described.stdout)
    );
    let dry_run = success(cli(&["delete", "schedule", &id, "--dry-run"])).await?;
    ensure!(
        String::from_utf8_lossy(&dry_run.stdout).trim() == format!("delete Schedule/{id}"),
        "{}",
        String::from_utf8_lossy(&dry_run.stdout)
    );
    let deleted = json(cli(&["delete", "schedule", &id])).await?;
    ensure!(deleted["state"] == "SCHEDULE_STATE_CANCELLED", "{deleted}");
    let all = json(cli(&["get", "schedules", "--all"])).await?;
    ensure!(
        all["schedules"].as_array().map_or(0, Vec::len) == 2,
        "{all}"
    );
    let refused = output(cli(&[
        "schedule",
        "create",
        "--tag",
        "lead",
        "--every",
        "*/5 * * * *",
        "Too often",
    ]))
    .await?;
    ensure!(
        !refused.status.success()
            && String::from_utf8_lossy(&refused.stderr).contains("at least one hour"),
        "{}",
        String::from_utf8_lossy(&refused.stderr)
    );
    services.stop().await
}

/// A built-in harness's `report_objective` call reaches the Control Plane through the
/// Worker Host: the reported status finishes the Objective with the turn's result as its
/// summary, and a turn that reports nothing leaves it working.
async fn an_owner_report_finishes_its_objective_through_the_worker_host(
    database: String,
) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let root = directory.path();
    let credentials = Credentials::new();
    let services = Services::start(&credentials, &database, |_| {}).await?;
    let cli = |args: &[&str]| services.cli(&credentials, args);
    json(cli(&[
        "tag",
        "put",
        "owner",
        "--instructions",
        "Release engineering",
        "--allow",
        "files:read",
    ]))
    .await?;
    for (objective, status, expected) in [
        (
            "reviewed",
            "ready_for_review",
            "OBJECTIVE_STATUS_READY_FOR_REVIEW",
        ),
        ("shipped", "completed", "OBJECTIVE_STATUS_COMPLETED"),
    ] {
        json(cli(&[
            "objective",
            "create",
            objective,
            "--owner",
            "owner",
            "Ship the release notes",
        ]))
        .await?;
        success(credentials.worker(
            &public(&services),
            &root.join(objective),
            None,
            &[&format!("--report-objective={status}")],
        ))
        .await?;
        let read = json(cli(&["get", "objective", objective])).await?;
        ensure!(
            read["status"] == expected,
            "{objective} did not finish: {read}"
        );
        ensure!(
            read["completion_summary"]
                .as_str()
                .is_some_and(|summary| summary.contains("Ship the release notes")),
            "{objective} summary is not the turn's result: {read}"
        );
    }
    // A turn outside any Objective may not report one; the fixture sends progress.
    json(cli(&[
        "task",
        "submit",
        "--tag",
        "owner",
        "--session",
        "plain",
        "Say hello",
    ]))
    .await?;
    success(credentials.worker(
        &public(&services),
        &root.join("plain"),
        None,
        &["--report-objective=completed"],
    ))
    .await?;
    services.stop().await
}

/// TypeScript parity: `packages/control-plane/overlap-warnings.test.ts` and
/// `tests/worker-host-changed-paths.test.ts`.
async fn overlapping_work_sessions_warn_their_objective_once(database: String) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let root = directory.path();
    let (source, base) = repository(root).await?;
    let credentials = Credentials::new();
    let services = Services::start(&credentials, &database, |_| {}).await?;
    let cli = |args: &[&str]| services.cli(&credentials, args);
    json(cli(&[
        "tag",
        "put",
        "owner",
        "--instructions",
        "Coordinate the release",
        "--allow",
        "files:read",
        "--allow",
        "files:write",
        "--workspace-id",
        "project",
        "--workspace-base",
        &base,
    ]))
    .await?;
    let objective = json(cli(&[
        "objective",
        "create",
        "release",
        "--owner",
        "owner",
        "--ongoing",
        "Ship the release notes",
    ]))
    .await?;
    let session = field(&objective, "session_id")?.to_owned();
    success(credentials.worker(
        &public(&services),
        &root.join("owner"),
        Some(&source),
        &["--start-parallel-work-sessions"],
    ))
    .await?;
    let work = json(cli(&[
        "get",
        "sessions",
        "--parent-tag",
        "owner",
        "--parent-session",
        &session,
    ]))
    .await?;
    let children: Vec<String> = work["work_sessions"]
        .as_array()
        .context("Work Sessions")?
        .iter()
        .map(|work| field(work, "latest_task_id").map(str::to_owned))
        .collect::<Result<_>>()?;
    ensure!(children.len() == 2, "expected two Work Sessions: {work}");
    // Both children edit the same files of their own checkouts and stay running until released.
    let release = root.join("release");
    let wait = format!("--wait-for-file={}", release.display());
    // Two enrolled Worker Hosts, so both children run at once.
    let key = json(cli(&[
        "auth-key",
        "create",
        "children",
        "--role",
        "host",
        "--reusable",
        "--all-tags",
    ]))
    .await?;
    let key = field(&key, "auth_key")?;
    let mut hosts = Vec::new();
    for name in ["child-one", "child-two"] {
        let mut enroll =
            credentials.command(&["host", "enroll", name, "--control-plane", &services.public]);
        enroll
            .arg("--state-directory")
            .arg(root.join(name))
            .env_remove("SUPERTAG_HOST_TOKEN")
            .env("SUPERTAG_AUTH_KEY", key);
        success(enroll).await?;
        let mut host = credentials.worker(
            &public(&services),
            &root.join(name),
            Some(&source),
            &["--workspace-fixture", &wait],
        );
        host.env_remove("SUPERTAG_HOST_TOKEN")
            .env("SUPERTAG_TEST_CHANGED_PATHS_INTERVAL_MS", "100")
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        hosts.push(host.spawn()?);
    }
    let mut db = database::connect(&database).await?;
    let notices = || {
        sqlx::query_scalar::<_, String>(
            "SELECT task_id FROM supertag_v2_objective_notices WHERE objective_id='release' AND notice_key LIKE 'overlap:%' ORDER BY task_id",
        )
    };
    // The fixture writes workspace.txt, then artifact.bin. A scan between the two writes shares
    // only workspace.txt, so the overlap may be told as one notice or as two, one per newly shared
    // file. Either way each shared file is told exactly once.
    let overlaps = || {
        sqlx::query_scalar::<_, String>(
            "SELECT path FROM supertag_v2_attempt_overlaps WHERE objective_id='release' ORDER BY path",
        )
    };
    let waited = timeout(WAIT, async {
        loop {
            if overlaps().fetch_all(&mut db).await? == ["artifact.bin", "workspace.txt"]
                && !notices().fetch_all(&mut db).await?.is_empty()
            {
                return Ok::<_, anyhow::Error>(());
            }
            sleep(Duration::from_millis(50)).await;
        }
    })
    .await;
    match waited {
        Ok(waited) => waited?,
        Err(_) => {
            let mut logs = String::new();
            for mut host in hosts {
                host.start_kill()?;
                let output = host.wait_with_output().await?;
                logs.push_str(&String::from_utf8_lossy(&output.stderr));
            }
            anyhow::bail!("the Objective was not told about the overlap: {logs}");
        }
    }
    let told = notices().fetch_all(&mut db).await?;
    // Later scans of the same paths add nothing.
    sleep(Duration::from_millis(800)).await;
    assert_eq!(notices().fetch_all(&mut db).await?, told);
    let mut prompts = Vec::new();
    for notice in &told {
        let task = json(cli(&["get", "task", notice])).await?;
        assert_eq!(task["tag_id"], "owner");
        assert_eq!(task["session_id"], session.as_str());
        let prompt: String =
            sqlx::query_scalar("SELECT prompt FROM supertag_v2_tasks WHERE task_id=$1")
                .bind(notice)
                .fetch_one(&mut db)
                .await?;
        prompts.push(prompt);
    }
    // Each notice names the reporting Task first, so the order can differ between notices.
    let told_as = |files: &str, first: &str, second: &str| {
        format!(
            "Tasks {first} and {second} of this Objective are both changing {files} in Workspace project. Coordinate them before their changes conflict: continue one work Session with what the other changes, or let one finish first."
        )
    };
    let files_told = |prompt: &String| {
        [
            "artifact.bin, workspace.txt",
            "workspace.txt",
            "artifact.bin",
        ]
        .into_iter()
        .find(|files| {
            *prompt == told_as(files, &children[0], &children[1])
                || *prompt == told_as(files, &children[1], &children[0])
        })
    };
    let mut files: Vec<&str> = prompts
        .iter()
        .map(|prompt| files_told(prompt).with_context(|| format!("unexpected notice: {prompt}")))
        .collect::<Result<_>>()?;
    files.sort();
    ensure!(
        files == ["artifact.bin, workspace.txt"] || files == ["artifact.bin", "workspace.txt"],
        "each shared file must be told exactly once: {prompts:?}"
    );
    std::fs::write(&release, "")?;
    for host in hosts {
        let output = timeout(WAIT, host.wait_with_output()).await??;
        ensure!(
            output.status.success(),
            "child host failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    for child in &children {
        let task = json(cli(&["get", "task", child])).await?;
        assert_eq!(task["state"], "TASK_STATE_SUCCEEDED", "{task}");
    }
    // Finished Attempts are no longer compared: the notices told above stay the only ones.
    assert_eq!(notices().fetch_all(&mut db).await?, told);
    services.stop().await
}

fn public(services: &Services) -> String {
    services.public.clone()
}

/// TypeScript parity: `tests/runtime/tool-adapter.test.ts` and `sdks/python/tests/test_tools.py`.
async fn worker_managed_effects_replay_and_stay_in_doubt_across_restart(
    database: String,
) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let root = directory.path();
    let provider = root.join("provider.log");
    let mode = format!("--effect-fixture={}", provider.display());
    let credentials = Credentials::new();
    let services = Services::start(&credentials, &database, |_| {}).await?;
    json(services.cli(
        &credentials,
        &["tag", "put", "integrator", "--instructions", "File tickets"],
    ))
    .await?;
    let first = json(services.cli(
        &credentials,
        &[
            "task",
            "submit",
            "--tag",
            "integrator",
            "--session",
            "tickets",
            "first",
        ],
    ))
    .await?;
    success(credentials.worker(&services.public, &root.join("host-one"), None, &[&mode])).await?;
    let first =
        json(services.cli(&credentials, &["get", "task", field(&first, "task_id")?])).await?;
    assert_eq!(first["state"], "TASK_STATE_SUCCEEDED", "{first}");
    assert_eq!(
        first["result"],
        "ticket/1 created {\"ticket\":\"T-1\"}\nticket/1 replayed {\"ticket\":\"T-1\"}\nticket/1 reuse refused\nticket/2 left in doubt"
    );
    // Receipts are durable in the Control Plane, not on the host that made them.
    services.stop().await?;
    let services = Services::start(&credentials, &database, |_| {}).await?;
    let retry = json(services.cli(
        &credentials,
        &[
            "task",
            "submit",
            "--tag",
            "integrator",
            "--session",
            "later",
            "retry",
        ],
    ))
    .await?;
    success(credentials.worker(&services.public, &root.join("host-two"), None, &[&mode])).await?;
    let retry =
        json(services.cli(&credentials, &["get", "task", field(&retry, "task_id")?])).await?;
    assert_eq!(retry["state"], "TASK_STATE_SUCCEEDED", "{retry}");
    assert_eq!(
        retry["result"],
        "ticket/1 replayed {\"ticket\":\"T-1\"}\nticket/2 in doubt\nticket/2 replayed {\"ticket\":\"T-2\",\"reconciled\":true}\nticket/3 created {\"ticket\":\"T-3\"}"
    );
    // The provider saw each effect exactly once, including the in-doubt one.
    assert_eq!(
        std::fs::read_to_string(&provider)?,
        "ticket/1\nticket/2\nticket/3\n"
    );
    services.stop().await
}

/// A built-in harness's `remember` call reaches the Control Plane through the Worker Host and
/// takes effect when its turn succeeds. People list, read, and delete the note; a Tag without
/// memory has no `remember`.
async fn a_tag_keeps_a_note_that_people_read_and_delete(database: String) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let root = directory.path();
    let credentials = Credentials::new();
    let services = Services::start(&credentials, &database, |_| {}).await?;
    let cli = |args: &[&str]| services.cli(&credentials, args);
    let tag = json(cli(&[
        "tag",
        "put",
        "lead",
        "--instructions",
        "Release engineering",
        "--allow",
        "files:read",
    ]))
    .await?;
    ensure!(tag["memory"] == true, "{tag}");
    let submitted = json(cli(&[
        "task",
        "submit",
        "--tag",
        "lead",
        "--session",
        "ops",
        "I prefer squash merges",
    ]))
    .await?;
    success(credentials.worker(
        &public(&services),
        &root.join("first"),
        None,
        &["--remember=Atem prefers squash merges."],
    ))
    .await?;
    let first = json(cli(&["get", "task", field(&submitted, "task_id")?])).await?;
    ensure!(first["state"] == "TASK_STATE_SUCCEEDED", "{first}");
    let listed = json(cli(&["get", "memories", "--tag", "lead"])).await?;
    let notes = listed["memories"].as_array().context("memories")?;
    ensure!(notes.len() == 1, "{listed}");
    let id = field(&notes[0], "memory_id")?.to_owned();
    ensure!(
        notes[0]["text"] == "Atem prefers squash merges."
            && notes[0]["state"] == "MEMORY_STATE_ACTIVE"
            && notes[0]["created_by"] == "tag:lead"
            && field(&first, "result")?.contains(&id),
        "{listed}"
    );
    let described = success(cli(&["describe", "memory", &id])).await?;
    ensure!(
        String::from_utf8_lossy(&described.stdout).contains("Atem prefers squash merges."),
        "{}",
        String::from_utf8_lossy(&described.stdout)
    );
    let dry_run = success(cli(&["delete", "memory", &id, "--dry-run"])).await?;
    ensure!(
        String::from_utf8_lossy(&dry_run.stdout).trim() == format!("delete Memory/{id}"),
        "{}",
        String::from_utf8_lossy(&dry_run.stdout)
    );
    json(cli(&["delete", "memory", &id])).await?;
    let listed = json(cli(&["get", "memories"])).await?;
    ensure!(listed["memories"] == json!([]), "{listed}");

    // Without memory, a turn has no remember tool and keeps nothing.
    let tag = json(cli(&[
        "tag",
        "put",
        "lead",
        "--instructions",
        "Release engineering",
        "--allow",
        "files:read",
        "--memory",
        "false",
    ]))
    .await?;
    ensure!(tag["memory"] == false, "{tag}");
    let submitted = json(cli(&[
        "task",
        "submit",
        "--tag",
        "lead",
        "--session",
        "ops",
        "Remember this too",
    ]))
    .await?;
    success(credentials.worker(
        &public(&services),
        &root.join("second"),
        None,
        &["--remember=Never kept."],
    ))
    .await?;
    let second = json(cli(&["get", "task", field(&submitted, "task_id")?])).await?;
    ensure!(
        second["state"] == "TASK_STATE_SUCCEEDED"
            && !field(&second, "result")?.contains("Remembered"),
        "{second}"
    );
    let listed = json(cli(&["get", "memories"])).await?;
    ensure!(listed["memories"] == json!([]), "{listed}");
    services.stop().await
}
