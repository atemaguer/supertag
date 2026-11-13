//! An external connector, in its own process, admits a surface event through the Control
//! Plane's public Connector contract and delivers the Task's reply exactly once. The connector
//! is `fixtures/example_connector.rs`; it depends only on the protocol, not on any SuperTag
//! service code.
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
const CONNECTOR: &str = env!("CARGO_BIN_EXE_supertag-example-connector");
const WAIT: Duration = Duration::from_secs(20);
const ACCOUNT: &str = "example/acme";

struct Tokens {
    gateway: String,
    operator: String,
    host: String,
}

fn command(program: &str, args: &[&str], tokens: &Tokens) -> Command {
    let mut command = Command::new(program);
    command
        .args(args)
        .env_clear()
        .env("SUPERTAG_GATEWAY_TOKEN", &tokens.gateway)
        .env("SUPERTAG_OPERATOR_TOKEN", &tokens.operator)
        .env("SUPERTAG_HOST_TOKEN", &tokens.host)
        .env("SUPERTAG_BOOTSTRAP_HOST_TOKEN", &tokens.host)
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
    Ok((child, format!("http://{address}")))
}

async fn json(mut command: Command) -> Result<Value> {
    let output = timeout(WAIT, command.output())
        .await
        .context("command did not exit")??;
    ensure!(
        output.status.success(),
        "command failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(serde_json::from_slice(&output.stdout)?)
}

database_tests! {
    #[tokio::test]
    an_external_connector_admits_an_event_and_delivers_its_reply_once;
}

async fn an_external_connector_admits_an_event_and_delivers_its_reply_once(
    database: String,
) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let tokens = Tokens {
        gateway: Uuid::new_v4().to_string(),
        operator: Uuid::new_v4().to_string(),
        host: Uuid::new_v4().to_string(),
    };
    let mut plane = command(BINARY, &["control-plane"], &tokens);
    plane.env("SUPERTAG_DATABASE_URL", &database);
    let (mut plane, url) = service(plane).await?;
    let operator = |args: &[&str]| {
        let mut full = vec![args[0], "--control-plane", url.as_str()];
        full.extend_from_slice(&args[1..]);
        command(BINARY, &full, &tokens)
    };
    json(operator(&[
        "tag",
        "put",
        "helper",
        "--instructions",
        "Help",
    ]))
    .await?;

    // The connector admits one surface event; a replay of the same event is the same Task.
    let accept = || {
        command(
            CONNECTOR,
            &[
                "accept",
                &url,
                ACCOUNT,
                "event-1",
                "helper",
                "room-1",
                "room-1",
                "Summarize the thread",
            ],
            &tokens,
        )
    };
    let accepted = json(accept()).await?;
    let task_id = accepted["task_id"].as_str().context("task_id")?.to_owned();
    assert_eq!(json(accept()).await?["task_id"], task_id.as_str());

    // A connector cannot act for another account.
    let mut forged = command(
        CONNECTOR,
        &[
            "accept",
            &url,
            "example/other",
            "event-2",
            "helper",
            "room-1",
            "room-1",
            "Not mine",
        ],
        &tokens,
    );
    forged.env("SUPERTAG_GATEWAY_TOKEN", Uuid::new_v4().to_string());
    let refused = timeout(WAIT, forged.output()).await??;
    ensure!(
        !refused.status.success(),
        "a connector without the Gateway credential was admitted"
    );

    let mut host = command(
        BINARY,
        &[
            "worker-host",
            "--control-plane",
            &url,
            "--adapter",
            ADAPTER,
            "--once",
        ],
        &tokens,
    );
    host.arg("--state-directory")
        .arg(directory.path().join("host"));
    let status = timeout(WAIT, host.status()).await??;
    ensure!(status.success(), "Worker Host failed with {status}");

    let delivered = json(command(CONNECTOR, &["deliver", &url, ACCOUNT], &tokens)).await?;
    assert_eq!(delivered["task_id"], task_id.as_str());
    assert_eq!(delivered["conversation_id"], "room-1");
    assert_eq!(delivered["state"], "REPLY_STATE_DELIVERED");
    assert_eq!(delivered["text"], "Help: Summarize the thread []");
    let reply_id = delivered["reply_id"].as_str().context("reply_id")?;
    let recorded = json(operator(&["get", "reply", reply_id])).await?;
    assert_eq!(recorded["state"], "REPLY_STATE_DELIVERED", "{recorded}");
    plane.kill().await?;
    Ok(())
}
