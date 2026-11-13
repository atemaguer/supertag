//! `supertag metrics` through separate Control Plane, Gateway, and Worker Host processes
//! (`packages/store/coordination-metrics.test.ts`): every figure is an aggregate, so it counts
//! past any list page limit, and a claimed Attempt is counted as `supertag spend` counts it.
#[path = "../../../test-support/prerequisites.rs"]
mod prerequisites;
#[macro_use]
#[path = "support/database.rs"]
mod database;
#[path = "support/protocol.rs"]
mod protocol;

use std::{net::SocketAddr, process::Stdio, time::Duration};

use anyhow::{Context, Result, ensure};
use serde_json::Value;
use supertag_protocol::{
    authenticated_request,
    v2::{SubmitTaskRequest, operator_client::OperatorClient},
};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    time::timeout,
};
use uuid::Uuid;

const BINARY: &str = env!("CARGO_BIN_EXE_supertag");
const ADAPTER: &str = env!("CARGO_BIN_EXE_supertag-fixture-adapter");
const WAIT: Duration = Duration::from_secs(30);
/// More Tasks than one page of any list API returns.
const TASKS: usize = 120;

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

async fn output(mut command: Command) -> Result<String> {
    let output = timeout(WAIT, command.output())
        .await
        .context("SuperTag command did not exit")??;
    ensure!(
        output.status.success(),
        "SuperTag command failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(String::from_utf8(output.stdout)?)
}

database_tests! {
    #[tokio::test]
    metrics_count_every_record_beyond_list_pages;
}

async fn metrics_count_every_record_beyond_list_pages(database: String) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let gateway_token = Uuid::new_v4().to_string();
    let operator_token = Uuid::new_v4().to_string();
    let host_token = Uuid::new_v4().to_string();
    let mut control = binary(&["control-plane", "--listen", "127.0.0.1:0"]);
    control
        .env("SUPERTAG_GATEWAY_TOKEN", &gateway_token)
        .env("SUPERTAG_BOOTSTRAP_HOST_TOKEN", &host_token)
        .env("SUPERTAG_DATABASE_URL", &database);
    let (_control, private) = service(control).await?;
    let mut gateway = binary(&["gateway", "--control-plane", &private]);
    gateway
        .env("SUPERTAG_GATEWAY_TOKEN", &gateway_token)
        .env("SUPERTAG_OPERATOR_TOKEN", &operator_token);
    let (_gateway, public) = service(gateway).await?;
    let operator = |args: &[&str]| {
        let mut command = binary(args);
        command
            .args(["--gateway", &public])
            .env("SUPERTAG_OPERATOR_TOKEN", &operator_token);
        command
    };
    let metrics = async || -> Result<Value> {
        Ok(serde_json::from_str(
            &output(operator(&["metrics", "--output", "json"])).await?,
        )?)
    };

    let empty = metrics().await?;
    assert_eq!(empty["tags"], 0, "{empty}");
    assert_eq!(empty["tasks"]["total"], 0, "{empty}");
    assert_eq!(empty["usage"]["attempts"], 0, "{empty}");
    assert!(empty["usage"]["reported_tokens"].is_null(), "{empty}");
    assert_eq!(empty["mailbox"]["pending"], 0, "{empty}");
    assert!(empty["mailbox"]["oldest_pending_at"].is_null(), "{empty}");
    assert_eq!(empty["reply_delivery"]["backlog"], 0, "{empty}");

    for tag in ["reviewer", "writer"] {
        output(operator(&["put-tag", tag, "--instructions", "Echo"])).await?;
    }
    let mut client = OperatorClient::new(protocol::dial(public.clone()).await?);
    let mut submitted = vec![];
    for index in 0..TASKS {
        let task = client
            .submit_task(authenticated_request(
                SubmitTaskRequest {
                    tag_id: "reviewer".into(),
                    session_id: format!("session-{}", index % 3),
                    operation_id: format!("submit-{index}"),
                    prompt: format!("Check change {index}"),
                    ..Default::default()
                },
                &operator_token,
                None,
            )?)
            .await?
            .into_inner();
        submitted.push(task.task_id);
    }
    output(operator(&["cancel", submitted.last().context("no Task")?])).await?;
    let mut worker = binary(&[
        "worker-host",
        "--gateway",
        &public,
        "--adapter",
        ADAPTER,
        "--once",
    ]);
    worker
        .arg("--state-directory")
        .arg(directory.path().join("worker"))
        .env("SUPERTAG_HOST_TOKEN", &host_token);
    let status = timeout(WAIT, worker.status()).await??;
    ensure!(status.success(), "Worker Host exited with {status}");

    let snapshot = metrics().await?;
    assert_eq!(snapshot["tags"], 2, "{snapshot}");
    assert_eq!(snapshot["sessions"], 3, "{snapshot}");
    assert_eq!(
        snapshot["tasks"],
        serde_json::json!({
            "total": TASKS,
            "queued": TASKS - 2,
            "claimed": 0,
            "running": 0,
            "uncertain": 0,
            "succeeded": 1,
            "failed": 0,
            "cancelled": 1,
        }),
        "{snapshot}"
    );
    assert_eq!(snapshot["scheduling"]["queued"], TASKS - 2, "{snapshot}");
    let hosts = snapshot["scheduling"]["worker_hosts"]
        .as_array()
        .context("worker_hosts")?;
    ensure!(!hosts.is_empty(), "{snapshot}");
    ensure!(
        hosts.iter().all(|host| host["active_attempts"] == 0),
        "{snapshot}"
    );
    // The one claimed Attempt, as `supertag spend` counts it.
    let spend: Value = serde_json::from_str(
        &output(operator(&["spend", "--by", "tag", "--output", "json"])).await?,
    )?;
    assert_eq!(snapshot["usage"]["attempts"], 1, "{snapshot}");
    assert_eq!(spend["groups"][0]["attempts"], 1, "{spend}");
    assert_eq!(snapshot["mailbox"]["pending"], 0, "{snapshot}");
    assert_eq!(snapshot["reply_delivery"]["backlog"], 0, "{snapshot}");
    ensure!(
        snapshot["captured_at"]
            .as_str()
            .is_some_and(|at| at.ends_with('Z')),
        "{snapshot}"
    );

    let text = output(operator(&["metrics"])).await?;
    ensure!(
        text.contains(&format!(
            "Tasks {TASKS}: {} queued, 0 claimed, 0 running, 0 uncertain, 1 succeeded, 0 failed, 1 cancelled",
            TASKS - 2
        )),
        "{text}"
    );
    Ok(())
}
