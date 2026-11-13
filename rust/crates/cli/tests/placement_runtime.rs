//! Two labelled Worker Hosts joined with one reusable Auth Key, through real
//! Control Plane and Worker Host processes. Mirrors
//! tests/label-placement.test.ts "places Session Tasks only on bound Worker
//! Hosts that carry the Tag's runsOn labels".

use std::{
    net::SocketAddr,
    path::Path,
    process::{Output, Stdio},
    str::FromStr,
    time::Duration,
};

use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use sqlx::{ConnectOptions, Connection, Executor, PgConnection, postgres::PgConnectOptions};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    time::timeout,
};
use uuid::Uuid;

const BINARY: &str = env!("CARGO_BIN_EXE_supertag");
const ADAPTER: &str = env!("CARGO_BIN_EXE_supertag-fixture-adapter");
const WAIT: Duration = Duration::from_secs(20);

fn binary(args: &[&str]) -> Command {
    let mut command = Command::new(BINARY);
    command
        .args(args)
        .env_clear()
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
        .context("service did not start")??;
    let address: SocketAddr = line.trim().parse().context("missing service address")?;
    ensure!(address.ip().is_loopback() && address.port() != 0);
    Ok((child, format!("http://{address}")))
}

async fn output(mut command: Command) -> Result<Output> {
    Ok(timeout(WAIT, command.output())
        .await
        .context("SuperTag command did not exit")??)
}

async fn json(command: Command) -> Result<Value> {
    let output = output(command).await?;
    ensure!(
        output.status.success(),
        "SuperTag command failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(serde_json::from_slice(&output.stdout)?)
}

/// `group` takes the connection flags before its subcommand, such as `host`.
fn operator(group: &[&str], rest: &[&str], gateway: &str, token: &str) -> Command {
    let mut command = binary(group);
    command
        .args(["--control-plane", gateway])
        .args(rest)
        .env("SUPERTAG_OPERATOR_TOKEN", token);
    command
}

fn enroll(gateway: &str, state: &Path, host: &str, key: &str) -> Command {
    let mut command = binary(&["host", "enroll", host, "--control-plane", gateway]);
    command
        .arg("--state-directory")
        .arg(state)
        .env("SUPERTAG_AUTH_KEY", key);
    command
}

async fn run_once(gateway: &str, state: &Path, labels: &[&str]) -> Result<()> {
    let mut command = binary(&[
        "worker-host",
        "--control-plane",
        gateway,
        "--adapter",
        ADAPTER,
        "--once",
    ]);
    command.arg("--state-directory").arg(state);
    for label in labels {
        command.args(["--label", label]);
    }
    let executed = output(command).await?;
    ensure!(
        executed.status.success(),
        "Worker Host failed: {}",
        String::from_utf8_lossy(&executed.stderr)
    );
    Ok(())
}

async fn exercise(database: &str, directory: &Path) -> Result<()> {
    let gateway_token = Uuid::new_v4().to_string();
    let token = Uuid::new_v4().to_string();
    let mut control = binary(&["control-plane"]);
    control
        .env("SUPERTAG_GATEWAY_TOKEN", &gateway_token)
        .env("SUPERTAG_DATABASE_URL", database);
    control.env("SUPERTAG_OPERATOR_TOKEN", &token);
    let (mut control, public) = service(control).await?;
    let op = |group: &[&str], rest: &[&str]| operator(group, rest, &public, &token);

    for tag in ["researcher", "trainer"] {
        json(op(
            &["tag", "put", tag, "--instructions", "Train the model"],
            &[],
        ))
        .await?;
    }
    // runsOn from a manifest; a separate command for the other Tag.
    let manifest = directory.join("trainer.yaml");
    std::fs::write(
        &manifest,
        "apiVersion: supertag/v1\nkind: Tag\nmetadata: {name: trainer}\nspec: {instructions: \"Train the model\", runsOn: [GPU]}\n",
    )?;
    let applied = output(op(&["apply", "-f", manifest.to_str().unwrap()], &[])).await?;
    ensure!(
        applied.status.success(),
        "apply failed: {}",
        String::from_utf8_lossy(&applied.stderr)
    );
    assert_eq!(
        json(op(&["get", "tag", "trainer"], &[])).await?["runs_on"],
        json!(["gpu"])
    );
    let researcher = json(op(&["placement"], &["runs-on", "researcher", "gpu", "TPU"])).await?;
    assert_eq!(researcher["runs_on"], json!(["gpu", "tpu"]));

    // One reusable key joins both hosts and grants each the same label.
    let issued = json(op(
        &[
            "auth-key",
            "create",
            "infra-pool",
            "--reusable",
            "--tag",
            "trainer",
            "--tag",
            "researcher",
            "--label",
            "team:infra",
        ],
        &[],
    ))
    .await?;
    assert_eq!(issued["host_id"], "");
    assert_eq!(issued["reusable"], true);
    assert_eq!(issued["labels"], json!(["team:infra"]));
    let key = issued["auth_key"].as_str().context("missing Auth Key")?;
    assert_eq!(issued["name"], "infra-pool");
    assert_eq!(issued["phase"], "active");
    // Without --expires-in-seconds a reusable key lives 90 days, never longer.
    let lifetime = issued["expires_at_ms"].as_i64().context("missing expiry")?
        - std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_millis() as i64;
    ensure!((90 * 86_400_000 - 60_000..=90 * 86_400_000).contains(&lifetime));
    let too_long = output(op(
        &[
            "auth-key",
            "create",
            "too-long",
            "--reusable",
            "--all-tags",
            "--expires-in-seconds",
            "7776001",
        ],
        &[],
    ))
    .await?;
    ensure!(!too_long.status.success(), "a 90-day-plus key was issued");
    let gpu_state = directory.join("gpu-host");
    let cpu_state = directory.join("cpu-host");
    for (host, state) in [("gpu-host", &gpu_state), ("cpu-host", &cpu_state)] {
        let joined = json(enroll(&public, state, host, key)).await?;
        assert_eq!(joined["host_id"], host);
    }

    let submit = |tag: &str, session: &str| {
        op(
            &[
                "task",
                "submit",
                "--tag",
                tag,
                "--session",
                session,
                "Train",
            ],
            &[],
        )
    };
    let trainer_task = json(submit("trainer", "train")).await?;
    let trainer_id = trainer_task["task_id"].as_str().context("missing Task")?;
    let research_task = json(submit("researcher", "research")).await?;
    let research_id = research_task["task_id"].as_str().context("missing Task")?;
    let state = |id: &str| op(&["get", "task", id], &[]);

    // The CPU host carries no gpu label, so both Tasks wait.
    run_once(&public, &cpu_state, &["cpu"]).await?;
    assert_eq!(json(state(trainer_id)).await?["state"], "TASK_STATE_QUEUED");
    assert_eq!(
        json(state(research_id)).await?["state"],
        "TASK_STATE_QUEUED"
    );
    let cpu = json(op(&["get"], &["host", "cpu-host"])).await?;
    let labels = cpu["labels"].as_array().context("missing labels")?;
    for label in ["cpu", "team:infra"] {
        ensure!(
            labels.contains(&json!(label)),
            "cpu-host lacks {label}: {cpu}"
        );
    }
    assert_eq!(cpu["granted_labels"], json!(["team:infra"]));

    let explained = json(op(&["placement"], &["explain", trainer_id])).await?;
    assert_eq!(explained["requirement"], "labels:gpu");
    assert_eq!(explained["summary"], "No bound Worker Host has labels: gpu");

    // The GPU host takes the trainer Task; the researcher Task still needs tpu.
    run_once(&public, &gpu_state, &["GPU"]).await?;
    let done = json(state(trainer_id)).await?;
    assert_eq!(done["state"], "TASK_STATE_SUCCEEDED", "{done}");
    assert_eq!(
        json(state(research_id)).await?["state"],
        "TASK_STATE_QUEUED"
    );
    let explained = json(op(&["placement"], &["explain", research_id])).await?;
    assert_eq!(explained["missing_labels"], json!(["tpu"]));
    assert_eq!(explained["summary"], "No bound Worker Host has labels: tpu");
    let hosts = explained["hosts"].as_array().context("missing hosts")?;
    assert_eq!(
        hosts
            .iter()
            .map(|host| (host["host_id"].clone(), host["missing_labels"].clone()))
            .collect::<Vec<_>>(),
        [
            (json!("cpu-host"), json!(["gpu", "tpu"])),
            (json!("gpu-host"), json!(["tpu"])),
        ]
    );
    run_once(&public, &gpu_state, &["gpu"]).await?;
    assert_eq!(
        json(state(research_id)).await?["state"],
        "TASK_STATE_QUEUED"
    );

    // Relaxing runsOn re-places the waiting Task, still only on a gpu host.
    json(op(&["placement"], &["runs-on", "researcher", "gpu"])).await?;
    run_once(&public, &cpu_state, &["cpu"]).await?;
    assert_eq!(
        json(state(research_id)).await?["state"],
        "TASK_STATE_QUEUED"
    );
    run_once(&public, &gpu_state, &["gpu"]).await?;
    assert_eq!(
        json(state(research_id)).await?["state"],
        "TASK_STATE_SUCCEEDED"
    );

    // Revoking the key stops new joins; hosts that joined keep working.
    let revoked = json(op(&["auth-key", "revoke", "infra-pool"], &[])).await?;
    assert_eq!(revoked["revoked"], true);
    assert_eq!(revoked["phase"], "revoked");
    assert_eq!(
        json(op(&["get", "auth-key", "infra-pool"], &[])).await?,
        revoked
    );
    let refused = output(enroll(
        &public,
        &directory.join("late-host"),
        "late-host",
        key,
    ))
    .await?;
    ensure!(!refused.status.success(), "a revoked key enrolled a host");
    run_once(&public, &cpu_state, &["cpu"]).await?;

    // Invalid declared labels fail before the host contacts the Control Plane.
    let mut invalid = binary(&[
        "worker-host",
        "--control-plane",
        &public,
        "--adapter",
        ADAPTER,
        "--once",
        "--label",
        "mcp:github",
    ]);
    invalid.arg("--state-directory").arg(&cpu_state);
    let invalid = output(invalid).await?;
    ensure!(!invalid.status.success());
    ensure!(
        String::from_utf8_lossy(&invalid.stderr).contains("reserved"),
        "{}",
        String::from_utf8_lossy(&invalid.stderr)
    );

    // An ephemeral key marks the hosts that join with it.
    let ephemeral = json(op(
        &[
            "auth-key",
            "create",
            "labelled-runners",
            "--reusable",
            "--ephemeral",
            "--all-tags",
        ],
        &[],
    ))
    .await?;
    let ephemeral_key = ephemeral["auth_key"].as_str().context("missing Auth Key")?;
    json(enroll(
        &public,
        &directory.join("ci-runner"),
        "ci-runner",
        ephemeral_key,
    ))
    .await?;
    assert_eq!(
        json(op(&["get"], &["host", "ci-runner"])).await?["ephemeral"],
        true
    );
    control.kill().await?;
    Ok(())
}

async fn host_get(op: &impl Fn(&[&str], &[&str]) -> Command, host: &str) -> Result<Value> {
    json(op(&["get"], &["host", host])).await
}

/// The real sweep loop removes an ephemeral host that went away, but a Control
/// Plane restart, however long, does not count as the host being offline.
async fn ephemeral(database: &str, directory: &Path) -> Result<()> {
    std::fs::create_dir_all(directory)?;
    let gateway_token = Uuid::new_v4().to_string();
    let token = Uuid::new_v4().to_string();
    let control_command = |listen: &str| {
        let mut control = binary(&["control-plane", "--listen", listen]);
        control
            .env("SUPERTAG_GATEWAY_TOKEN", &gateway_token)
            .env("SUPERTAG_OPERATOR_TOKEN", &token)
            .env("SUPERTAG_DATABASE_URL", database);
        control
    };
    let (mut control, public) = service(control_command("127.0.0.1:0")).await?;
    let private = public.clone();
    let op = |group: &[&str], rest: &[&str]| operator(group, rest, &public, &token);
    json(op(
        &["tag", "put", "builder", "--instructions", "Build"],
        &[],
    ))
    .await?;
    let issued = json(op(
        &[
            "auth-key",
            "create",
            "ephemeral-runners",
            "--reusable",
            "--ephemeral",
            "--all-tags",
        ],
        &[],
    ))
    .await?;
    let key = issued["auth_key"].as_str().context("missing Auth Key")?;
    let state = directory.join("runner");
    json(enroll(&public, &state, "runner", key)).await?;
    let mut runner = binary(&[
        "worker-host",
        "--control-plane",
        &public,
        "--adapter",
        ADAPTER,
    ]);
    runner.arg("--state-directory").arg(&state);
    let mut runner = runner.stdout(Stdio::null()).stderr(Stdio::null()).spawn()?;
    let deadline = tokio::time::Instant::now() + WAIT;
    while host_get(&op, "runner").await?["phase"] != "ready" {
        ensure!(
            tokio::time::Instant::now() < deadline,
            "runner never reported"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }

    // Down longer than a presence window plus one report interval.
    control.kill().await?;
    tokio::time::sleep(Duration::from_secs(36)).await;
    let (mut control, restarted) =
        service(control_command(private.trim_start_matches("http://"))).await?;
    assert_eq!(restarted, private);
    // The host reports again and stays enrolled through the restart grace.
    let seen = host_get(&op, "runner").await?["last_seen_at_ms"].as_i64();
    let deadline = tokio::time::Instant::now() + WAIT;
    loop {
        let status = host_get(&op, "runner").await?;
        ensure!(
            status["removed_at_ms"].is_null(),
            "restart removed the host: {status}"
        );
        if status["last_seen_at_ms"].as_i64() > seen && status["phase"] == "ready" {
            break;
        }
        ensure!(
            tokio::time::Instant::now() < deadline,
            "runner never reported again"
        );
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    tokio::time::sleep(Duration::from_secs(3)).await;
    ensure!(
        runner.try_wait()?.is_none(),
        "the Worker Host exited after the restart"
    );
    ensure!(host_get(&op, "runner").await?["removed_at_ms"].is_null());

    // An ephemeral host that goes away is removed by the sweep loop.
    runner.kill().await?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(45);
    loop {
        let status = host_get(&op, "runner").await?;
        if !status["removed_at_ms"].is_null() {
            assert_eq!(status["phase"], "revoked");
            break;
        }
        ensure!(
            tokio::time::Instant::now() < deadline,
            "runner was never removed: {status}"
        );
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    let listed = json(op(&["get"], &["hosts"])).await?;
    ensure!(
        !listed["hosts"]
            .as_array()
            .context("missing hosts")?
            .iter()
            .any(|host| host["host_id"] == "runner"),
        "a removed host is still listed: {listed}"
    );
    control.kill().await?;
    Ok(())
}

#[tokio::test]
async fn sqlite_ephemeral_host_survives_restart_and_is_removed_when_gone() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let database = format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("control.db").display()
    );
    ephemeral(&database, directory.path()).await
}

#[tokio::test]
async fn sqlite_labelled_hosts_share_a_reusable_key_and_take_only_matching_work() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let database = format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("control.db").display()
    );
    exercise(&database, directory.path()).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires an isolated PostgreSQL server via SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"]
async fn postgres_labelled_hosts_share_a_reusable_key_and_take_only_matching_work() -> Result<()> {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .context("PostgreSQL process integration requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")?;
    let admin_url = std::fs::read_to_string(path)?;
    let options = PgConnectOptions::from_str(admin_url.trim())?;
    let mut admin = PgConnection::connect_with(&options).await?;
    let name = format!("supertag_rust_placement_{}", Uuid::new_v4().simple());
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await?;
    let database = options.database(&name).to_url_lossy().to_string();
    let directory = tempfile::tempdir()?;
    let path = directory.path().to_owned();
    let result = tokio::spawn(async move {
        exercise(&database, &path).await?;
        ephemeral(&database, &path.join("ephemeral")).await
    })
    .await;
    let cleanup = admin
        .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
        .await;
    admin.close().await?;
    cleanup?;
    result.context("PostgreSQL placement process test panicked")?
}
