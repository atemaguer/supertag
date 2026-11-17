//! A Session's native checkpoint is a cache of its log. Through separate Control Plane and Worker
//! Host processes: a turn resumes the Session's checkpoint, a turn whose checkpoint is too big to
//! resume still succeeds without one, and the next turn starts from the recap of the Session's
//! earlier turns and the messages the Tag wrote in them.
#![cfg(feature = "test-fixtures")]

#[path = "../../../test-support/prerequisites.rs"]
mod prerequisites;
#[path = "support/protocol.rs"]
mod protocol;
#[macro_use]
#[path = "support/database.rs"]
mod database;

use std::{net::SocketAddr, path::Path, process::Stdio, time::Duration};

use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use supertag_protocol::{authenticated_request, negotiation::ProtocolChannel, v2::*};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    time::timeout,
};
use tonic::transport::Channel;
use uuid::Uuid;

const BINARY: &str = env!("CARGO_BIN_EXE_supertag");
const ADAPTER: &str = env!("CARGO_BIN_EXE_supertag-fixture-adapter");
const WAIT: Duration = Duration::from_secs(30);

fn command(args: &[&str]) -> Command {
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
    let mut output = BufReader::new(child.stdout.take().context("service stdout")?);
    let mut ready = String::new();
    timeout(WAIT, output.read_line(&mut ready)).await??;
    let address: SocketAddr = ready.trim().parse().context("service bind address")?;
    ensure!(address.ip().is_loopback() && address.port() != 0);
    Ok((child, format!("http://{address}")))
}

async fn run_host(public: &str, token: &str, state: &Path) -> Result<()> {
    let output = timeout(
        WAIT,
        command(&[
            "worker-host",
            "--control-plane",
            public,
            "--state-directory",
            state.to_str().context("Host state path")?,
            "--adapter",
            ADAPTER,
            "--adapter-arg=--checkpoint-fixture",
            "--once",
        ])
        .env("SUPERTAG_HOST_TOKEN", token)
        .output(),
    )
    .await??;
    ensure!(
        output.status.success(),
        "Worker Host failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(())
}

struct Operator {
    client: operator_client::OperatorClient<ProtocolChannel>,
    token: String,
}

impl Operator {
    async fn submit(&mut self, text: &str) -> Result<Task> {
        Ok(self
            .client
            .submit_task(authenticated_request(
                SubmitTaskRequest {
                    tag_id: "keeper".into(),
                    session_id: "long-running".into(),
                    operation_id: Uuid::new_v4().to_string(),
                    prompt: text.into(),
                    ..Default::default()
                },
                &self.token,
                None,
            )?)
            .await?
            .into_inner())
    }

    /// The turn's summary of what it started from.
    async fn summary(&mut self, task: &str) -> Result<Value> {
        let task = self
            .client
            .get_task(authenticated_request(
                GetTaskRequest {
                    task_id: task.into(),
                },
                &self.token,
                None,
            )?)
            .await?
            .into_inner();
        ensure!(
            task.state() == TaskState::Succeeded,
            "{:?} failed: {:?}",
            task.prompt,
            task.result
        );
        Ok(serde_json::from_str(&task.result.context("result")?)?)
    }
}

database_tests! {
    #[tokio::test]
    oversized_checkpoint_is_dropped_and_the_next_turn_starts_from_the_recap;
}

async fn oversized_checkpoint_is_dropped_and_the_next_turn_starts_from_the_recap(
    database: String,
) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let checkpoints = directory.path().join("checkpoints");
    let service_token = supertag_protocol::new_secret(supertag_protocol::CREDENTIAL_SECRET_PREFIX);
    let operator_token = Uuid::new_v4().to_string();
    let host_token = supertag_protocol::new_secret(supertag_protocol::CREDENTIAL_SECRET_PREFIX);
    let mut plane = command(&["control-plane"]);
    plane
        .arg("--checkpoint-directory")
        .arg(&checkpoints)
        .env("SUPERTAG_BOOTSTRAP_GATEWAY_CREDENTIAL", &service_token)
        .env("SUPERTAG_GATEWAY_CREDENTIAL", &service_token)
        .env("SUPERTAG_OPERATOR_TOKEN", &operator_token)
        .env("SUPERTAG_BOOTSTRAP_HOST_TOKEN", &host_token)
        .env("SUPERTAG_DATABASE_URL", &database);
    let (mut plane, public) = service(plane).await?;
    let connected = protocol::negotiated(
        Channel::from_shared(public.clone())?
            .timeout(WAIT)
            .connect()
            .await?,
    )
    .await?;
    let mut operator = Operator {
        client: operator_client::OperatorClient::new(connected),
        token: operator_token.clone(),
    };
    operator
        .client
        .put_tag(authenticated_request(
            PutTagRequest {
                tag_id: "keeper".into(),
                instructions: "Keep the thread".into(),
                allowed_actions: vec!["files:read".into()],
                ..Default::default()
            },
            &operator_token,
            None,
        )?)
        .await?;
    let host = directory.path().join("host");

    // The first turn starts fresh; the second resumes its checkpoint.
    let first = operator.submit("plan the release").await?;
    run_host(&public, &host_token, &host).await?;
    let summary = operator.summary(&first.task_id).await?;
    assert_eq!(summary["resumed"], Value::Null, "{summary}");
    assert_eq!(summary["recap"], json!([]), "{summary}");
    let second = operator.submit("draft the oversized notes").await?;
    run_host(&public, &host_token, &host).await?;
    let summary = operator.summary(&second.task_id).await?;
    assert_eq!(summary["resumed"], "plan the release", "{summary}");

    // The second turn's checkpoint was too big to resume, yet the turn succeeded. The third
    // starts fresh from the recap of both earlier turns, with the messages the Tag wrote.
    let third = operator.submit("what were we doing?").await?;
    run_host(&public, &host_token, &host).await?;
    let summary = operator.summary(&third.task_id).await?;
    assert_eq!(summary["resumed"], Value::Null, "{summary}");
    let recap = summary["recap"].as_array().context("recap")?;
    assert_eq!(
        recap
            .iter()
            .map(|turn| turn["taskId"].as_str().unwrap_or_default())
            .collect::<Vec<_>>(),
        [first.task_id.as_str(), second.task_id.as_str()],
        "{summary}"
    );
    assert_eq!(recap[1]["prompt"], "draft the oversized notes");
    assert_eq!(
        recap[1]["messages"],
        json!(["Noted: draft the oversized notes"])
    );
    assert!(
        recap[0]["result"]
            .as_str()
            .is_some_and(|result| result.contains(r#""resumed":null"#)),
        "{summary}"
    );

    // The fourth resumes the third's checkpoint again.
    let fourth = operator.submit("carry on").await?;
    run_host(&public, &host_token, &host).await?;
    let summary = operator.summary(&fourth.task_id).await?;
    assert_eq!(summary["resumed"], "what were we doing?", "{summary}");
    plane.kill().await?;
    Ok(())
}
