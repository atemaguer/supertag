use std::{path::Path, process::Stdio, time::Duration};

use anyhow::{Context, Result, ensure};
use serde_json::Value;
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    time::{sleep, timeout},
};

const BINARY: &str = env!("CARGO_BIN_EXE_supertag");
const ADAPTER: &str = env!("CARGO_BIN_EXE_supertag-fixture-adapter");
const WAIT: Duration = Duration::from_secs(15);

fn command(state: &Path, arguments: &[&str]) -> Command {
    let (name, arguments) = arguments.split_first().expect("command required");
    let mut command = Command::new(BINARY);
    command
        .arg(name)
        .arg("--state-directory")
        .arg(state)
        .args(arguments)
        .env_clear()
        .stdin(Stdio::null())
        .kill_on_drop(true);
    command
}

async fn cli(state: &Path, arguments: &[&str]) -> Result<Value> {
    let output = timeout(WAIT, command(state, arguments).output()).await??;
    ensure!(
        output.status.success(),
        "SuperTag {arguments:?} failed: {}",
        String::from_utf8_lossy(&output.stderr),
    );
    Ok(serde_json::from_slice(&output.stdout)?)
}

async fn up(state: &Path, adapter_flag: &str) -> Result<Child> {
    let mut child = command(state, &["up", "--adapter", ADAPTER, adapter_flag])
        .stdout(Stdio::piped())
        .spawn()?;
    let mut stdout = BufReader::new(child.stdout.take().context("supervisor stdout")?);
    let mut endpoint = String::new();
    timeout(WAIT, stdout.read_line(&mut endpoint)).await??;
    ensure!(
        endpoint.starts_with("http://127.0.0.1:"),
        "supervisor did not report a local Gateway"
    );
    cli(
        state,
        &["put-tag", "reviewer", "--instructions", "Review changes"],
    )
    .await?;
    Ok(child)
}

async fn stop(child: &mut Child) -> Result<()> {
    let pid = i32::try_from(child.id().context("supervisor already exited")?)?;
    // SAFETY: the PID belongs to the running supervisor owned by this test.
    ensure!(
        unsafe { libc::kill(pid, libc::SIGTERM) } == 0,
        "signal local supervisor"
    );
    ensure!(
        timeout(WAIT, child.wait()).await??.success(),
        "local supervisor failed"
    );
    Ok(())
}

fn field<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key]
        .as_str()
        .with_context(|| format!("missing {key}"))
}

async fn submit(state: &Path, session: &str) -> Result<String> {
    let task = cli(
        state,
        &[
            "submit",
            "--tag",
            "reviewer",
            "--session",
            session,
            "Review the patch",
        ],
    )
    .await?;
    Ok(field(&task, "task_id")?.into())
}

async fn wait_for_state(state: &Path, command: &[&str], expected: &str) -> Result<Value> {
    timeout(WAIT, async {
        loop {
            let record = cli(state, command).await?;
            if record["state"] == expected {
                return Ok(record);
            }
            sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .with_context(|| format!("{command:?} did not reach {expected}"))?
}

#[tokio::test]
async fn local_adapter_takes_input_and_records_a_single_durable_receipt() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let state = directory.path().join("accepted");
    let mut supervisor = up(&state, "--adapter-arg=--take-live-input").await?;
    let task = submit(&state, "active").await?;
    wait_for_state(&state, &["get-task", &task], "TASK_STATE_RUNNING").await?;
    let queue = [
        "input",
        "queue",
        &task,
        "Check the changed API",
        "--operation-id",
        "message",
    ];
    let input = cli(&state, &queue).await?;
    let input_id = field(&input, "input_id")?;
    let completed = wait_for_state(&state, &["get-task", &task], "TASK_STATE_SUCCEEDED").await?;
    assert!(field(&completed, "result")?.ends_with("Live input: Check the changed API"));
    let receipt = cli(&state, &["input", "get", input_id]).await?;
    assert_eq!(receipt["state"], "LIVE_INPUT_STATE_ACCEPTED");
    assert_eq!(cli(&state, &queue).await?, receipt);
    let follower = cli(&state, &["get-task", field(&receipt, "follower_task_id")?]).await?;
    assert_eq!(follower["state"], "TASK_STATE_SUCCEEDED");
    assert!(follower["attempt_id"].is_null());
    stop(&mut supervisor).await
}

#[tokio::test]
async fn cancellation_releases_the_adapter_while_live_input_is_waiting_for_a_receipt() -> Result<()>
{
    let directory = tempfile::tempdir()?;
    let state = directory.path().join("cancelled");
    let mut supervisor = up(&state, "--adapter-arg=--take-then-wait").await?;
    let first = submit(&state, "waiting-for-receipt").await?;
    wait_for_state(&state, &["get-task", &first], "TASK_STATE_RUNNING").await?;
    let input = cli(&state, &["input", "queue", &first, "One message"]).await?;
    let input_id = field(&input, "input_id")?;
    wait_for_state(
        &state,
        &["input", "get", input_id],
        "LIVE_INPUT_STATE_DISPATCHING",
    )
    .await?;

    assert_eq!(
        cli(&state, &["cancel", &first]).await?["state"],
        "TASK_STATE_CANCELLED"
    );
    let next = submit(&state, "independent").await?;
    wait_for_state(&state, &["get-task", &next], "TASK_STATE_RUNNING").await?;
    assert_eq!(
        cli(&state, &["input", "get", input_id]).await?["state"],
        "LIVE_INPUT_STATE_DISPATCHING"
    );
    let follower = cli(&state, &["get-task", field(&input, "follower_task_id")?]).await?;
    assert_eq!(follower["state"], "TASK_STATE_QUEUED");
    assert!(follower["attempt_id"].is_null());
    cli(&state, &["cancel", &next]).await?;
    stop(&mut supervisor).await
}
