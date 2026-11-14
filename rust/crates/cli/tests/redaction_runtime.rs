//! Secrets in harness output never leave the Worker Host (`tests/worker-event-redaction.test.ts`,
//! `tests/event-redaction-structure.test.ts`): a real Control Plane and Worker Host
//! run the fixture adapter, whose event and result repeat a prompt carrying a credential the host
//! holds, a URL password, and a Basic authorization value.
#[path = "../../../test-support/prerequisites.rs"]
mod prerequisites;
#[macro_use]
#[path = "support/database.rs"]
mod database;

use std::{net::SocketAddr, process::Stdio, time::Duration};

use anyhow::{Context, Result, ensure};
use serde_json::Value;
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    time::timeout,
};
use uuid::Uuid;

const BINARY: &str = env!("CARGO_BIN_EXE_supertag");
const ADAPTER: &str = env!("CARGO_BIN_EXE_supertag-fixture-adapter");
const WAIT: Duration = Duration::from_secs(30);
/// A credential only the Worker Host's environment holds.
const HOST_SECRET: &str = "sk-host-only-credential-4242";

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

async fn json(mut command: Command) -> Result<Value> {
    let output = timeout(WAIT, command.output())
        .await
        .context("SuperTag command did not exit")??;
    ensure!(
        output.status.success(),
        "SuperTag command failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(serde_json::from_slice(&output.stdout)?)
}

database_tests! {
    #[tokio::test]
    harness_output_is_redacted_before_it_leaves_the_worker_host;
    #[tokio::test]
    redaction_keeps_harness_text_within_its_limit;
}

/// `[REDACTED]` is longer than a short secret, so redacting an event the Control Plane would accept
/// may lengthen it past the 16,384-byte event limit; the Worker Host keeps it within the limit
/// instead of failing the Attempt.
async fn redaction_keeps_harness_text_within_its_limit(database: String) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let gateway_token = supertag_protocol::new_secret(supertag_protocol::CREDENTIAL_SECRET_PREFIX);
    let operator_token = Uuid::new_v4().to_string();
    let host_token = supertag_protocol::new_secret(supertag_protocol::CREDENTIAL_SECRET_PREFIX);
    let mut control = binary(&["control-plane", "--listen", "127.0.0.1:0"]);
    control
        .env("SUPERTAG_BOOTSTRAP_GATEWAY_CREDENTIAL", &gateway_token)
        .env("SUPERTAG_GATEWAY_CREDENTIAL", &gateway_token)
        .env("SUPERTAG_BOOTSTRAP_HOST_TOKEN", &host_token)
        .env("SUPERTAG_DATABASE_URL", &database);
    control.env("SUPERTAG_OPERATOR_TOKEN", &operator_token);
    let (_control, public) = service(control).await?;
    let operator = |args: &[&str]| {
        let mut command = binary(args);
        command
            .args(["--control-plane", &public])
            .env("SUPERTAG_OPERATOR_TOKEN", &operator_token);
        command
    };
    json(operator(&[
        "tag",
        "put",
        "reviewer",
        "--instructions",
        "Echo",
    ]))
    .await?;
    // The fixture publishes `Echo: PROMPT []`: 15,009 bytes, 33,009 once redacted.
    let prompt = "pw42 ".repeat(3_000);
    let submitted = json(operator(&[
        "task",
        "submit",
        "--tag",
        "reviewer",
        "--session",
        "review",
        &prompt,
    ]))
    .await?;
    let task_id = submitted["task_id"].as_str().context("task_id")?.to_owned();
    let mut worker = binary(&[
        "worker-host",
        "--control-plane",
        &public,
        "--adapter",
        ADAPTER,
        "--once",
    ]);
    worker
        .arg("--state-directory")
        .arg(directory.path().join("worker"))
        .env("SUPERTAG_HOST_TOKEN", &host_token)
        .env("FIXTURE_PROVIDER_PASSWORD", "pw42");
    let status = timeout(WAIT, worker.status()).await??;
    ensure!(status.success(), "Worker Host exited with {status}");

    let task = json(operator(&["get", "task", &task_id])).await?;
    assert_eq!(task["state"], "TASK_STATE_SUCCEEDED", "{task}");
    let result = task["result"].as_str().context("result")?;
    let mut connection = database::connect(&database).await?;
    let events: Vec<String> =
        sqlx::query_scalar("SELECT text FROM supertag_v2_task_events WHERE task_id=$1")
            .bind(&task_id)
            .fetch_all(&mut connection)
            .await?;
    let echoed = events
        .iter()
        .find(|text| text.starts_with("Echo:"))
        .context("echoed event")?;
    assert_eq!(echoed.len(), 16_384);
    assert!(
        echoed.starts_with("Echo: [REDACTED] [REDACTED] "),
        "{echoed:.64}"
    );
    assert!(!echoed.contains("pw42"));
    assert_eq!(result.len(), 33_009);
    assert!(!result.contains("pw42"));
    Ok(())
}

async fn harness_output_is_redacted_before_it_leaves_the_worker_host(
    database: String,
) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let gateway_token = supertag_protocol::new_secret(supertag_protocol::CREDENTIAL_SECRET_PREFIX);
    let operator_token = Uuid::new_v4().to_string();
    let host_token = supertag_protocol::new_secret(supertag_protocol::CREDENTIAL_SECRET_PREFIX);
    let mut control = binary(&["control-plane", "--listen", "127.0.0.1:0"]);
    control
        .env("SUPERTAG_BOOTSTRAP_GATEWAY_CREDENTIAL", &gateway_token)
        .env("SUPERTAG_GATEWAY_CREDENTIAL", &gateway_token)
        .env("SUPERTAG_BOOTSTRAP_HOST_TOKEN", &host_token)
        .env("SUPERTAG_DATABASE_URL", &database);
    control.env("SUPERTAG_OPERATOR_TOKEN", &operator_token);
    let (_control, public) = service(control).await?;
    let operator = |args: &[&str]| {
        let mut command = binary(args);
        command
            .args(["--control-plane", &public])
            .env("SUPERTAG_OPERATOR_TOKEN", &operator_token);
        command
    };

    json(operator(&[
        "tag",
        "put",
        "reviewer",
        "--instructions",
        "Echo",
    ]))
    .await?;
    let prompt = format!(
        "key {HOST_SECRET} clone https://bot:url-password-77@git.example/repo.git auth Basic dXNlcjpwYXNzd29yZA== at https://api.example/v1?access_token=query-token-99&page=2"
    );
    let submitted = json(operator(&[
        "task",
        "submit",
        "--tag",
        "reviewer",
        "--session",
        "review",
        &prompt,
    ]))
    .await?;
    let task_id = submitted["task_id"].as_str().context("task_id")?.to_owned();

    let state = directory.path().join("worker");
    let mut worker = binary(&[
        "worker-host",
        "--control-plane",
        &public,
        "--adapter",
        ADAPTER,
        "--once",
    ]);
    worker
        .arg("--state-directory")
        .arg(&state)
        .env("SUPERTAG_HOST_TOKEN", &host_token)
        .env("FIXTURE_PROVIDER_API_KEY", HOST_SECRET);
    let status = timeout(WAIT, worker.status()).await??;
    ensure!(status.success(), "Worker Host exited with {status}");

    let task = json(operator(&["get", "task", &task_id])).await?;
    assert_eq!(task["state"], "TASK_STATE_SUCCEEDED", "{task}");
    let result = task["result"].as_str().context("result")?;
    let mut connection = database::connect(&database).await?;
    let events: Vec<String> =
        sqlx::query_scalar("SELECT text FROM supertag_v2_task_events WHERE task_id=$1")
            .bind(&task_id)
            .fetch_all(&mut connection)
            .await?;
    ensure!(!events.is_empty(), "no events");
    for text in events.iter().map(String::as_str).chain([result]) {
        for secret in [
            HOST_SECRET,
            "url-password-77",
            "dXNlcjpwYXNzd29yZA",
            "query-token-99",
        ] {
            ensure!(!text.contains(secret), "{secret} leaked in {text:?}");
        }
    }
    let echoed = events
        .iter()
        .find(|text| text.contains("clone"))
        .context("echoed event")?;
    assert_eq!(
        echoed,
        "Echo: key [REDACTED] clone https://[REDACTED]@git.example/repo.git auth Basic [REDACTED] at https://api.example/v1?access_token=[REDACTED]&page=2 []"
    );
    assert_eq!(result, echoed);
    Ok(())
}
