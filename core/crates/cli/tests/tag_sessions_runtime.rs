//! A Tag reads its other Sessions and Objectives, and creates an Objective on an explicit
//! command, through separate Control Plane and Worker Host processes and the harness tools
//! (`HarnessTagSessions`) its adapter calls.
#![cfg(feature = "test-fixtures")]
#[path = "support/children.rs"]
mod children;
use children::reaped;

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
    let mut command = reaped(Command::new(BINARY));
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
            "--adapter-arg=--tag-session-tools",
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
    conversations: conversations_client::ConversationsClient<ProtocolChannel>,
    operator: operator_client::OperatorClient<ProtocolChannel>,
    token: String,
}

impl Operator {
    async fn say(&mut self, text: &str) -> Result<Task> {
        self.conversations
            .send_message(authenticated_request(
                SendMessageRequest {
                    tag_id: "owner".into(),
                    text: text.into(),
                    operation_id: Uuid::new_v4().to_string(),
                    ..Default::default()
                },
                &self.token,
                None,
            )?)
            .await?
            .into_inner()
            .task
            .context("Task")
    }

    /// A turn in a Session of its own, as `supertag task submit` sends one.
    async fn submit(&mut self, session: &str, text: &str) -> Result<Task> {
        Ok(self
            .operator
            .submit_task(authenticated_request(
                SubmitTaskRequest {
                    tag_id: "owner".into(),
                    session_id: session.into(),
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

    async fn result(&mut self, task: &str) -> Result<String> {
        let task = self
            .operator
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
            "fixture failed: {:?}",
            task.result
        );
        task.result.context("result")
    }
}

database_tests! {
    #[tokio::test]
    tag_reads_its_sessions_and_the_objective_its_goal_created;
}

async fn tag_reads_its_sessions_and_the_objective_its_goal_created(database: String) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let service_token = supertag_protocol::new_secret(supertag_protocol::CREDENTIAL_SECRET_PREFIX);
    let alice_token = Uuid::new_v4().to_string();
    let host_token = supertag_protocol::new_secret(supertag_protocol::CREDENTIAL_SECRET_PREFIX);
    let mut plane = command(&["control-plane"]);
    plane
        .env("SUPERTAG_BOOTSTRAP_GATEWAY_CREDENTIAL", &service_token)
        .env("SUPERTAG_GATEWAY_CREDENTIAL", &service_token)
        .env("SUPERTAG_OPERATOR_TOKEN", &alice_token)
        .env("SUPERTAG_OPERATOR_PRINCIPAL", "operator:alice")
        .env("SUPERTAG_BOOTSTRAP_HOST_TOKEN", &host_token)
        .env("SUPERTAG_DATABASE_URL", &database);
    let (mut plane, public) = service(plane).await?;
    let created = timeout(
        WAIT,
        command(&["operator-token", "create", "bob", "--gateway", &public])
            .env("SUPERTAG_OPERATOR_TOKEN", &alice_token)
            .output(),
    )
    .await??;
    ensure!(
        created.status.success(),
        "{}",
        String::from_utf8_lossy(&created.stderr)
    );
    let bob_token = serde_json::from_slice::<Value>(&created.stdout)?["secret"]
        .as_str()
        .context("secret")?
        .to_owned();
    let connected = protocol::negotiated(
        Channel::from_shared(public.clone())?
            .timeout(WAIT)
            .connect()
            .await?,
    )
    .await?;
    let client = |token: &str| Operator {
        conversations: conversations_client::ConversationsClient::new(connected.clone()),
        operator: operator_client::OperatorClient::new(connected.clone()),
        token: token.to_owned(),
    };
    let mut alice = client(&alice_token);
    let mut bob = client(&bob_token);
    alice
        .operator
        .put_tag(authenticated_request(
            PutTagRequest {
                tag_id: "owner".into(),
                instructions: "Remember earlier work".into(),
                allowed_actions: vec!["files:read".into()],
                ..Default::default()
            },
            &alice_token,
            None,
        )?)
        .await?;
    let host = directory.path().join("host");

    // Alice drafted notes in a Session of her own; her conversation with the Tag recalls it.
    let notes = alice.submit("notes", "Draft release notes").await?;
    run_host(&public, &host_token, &host).await?;
    alice.result(&notes.task_id).await?;
    let hiring = bob.say("Plan the release hiring").await?;
    run_host(&public, &host_token, &host).await?;
    bob.result(&hiring.task_id).await?;

    // Alice's turn sees her own Sessions, never Bob's.
    let recall = alice.say("recall release").await?;
    run_host(&public, &host_token, &host).await?;
    let summary: Value = serde_json::from_str(&alice.result(&recall.task_id).await?)?;
    assert_eq!(summary["mayRead"], true, "{summary}");
    assert_eq!(summary["sessions"], json!([notes.session_id]), "{summary}");
    assert_eq!(summary["firstRequests"], json!(["Draft release notes"]));
    assert_eq!(
        summary["matches"],
        json!(["Release notes drafted: v2 adds search"])
    );
    assert_eq!(
        summary["read"],
        json!(["Release notes drafted: v2 adds search"])
    );
    assert_eq!(summary["objectives"], json!([]));
    assert_eq!(summary["readObjective"], "NotFound");
    assert!(
        summary["portfolio"]
            .as_str()
            .is_some_and(|text| text.starts_with("Tag portfolio: this Tag owns no open Objectives")),
        "{summary}"
    );

    // `/goal` creates the Objective in the Control Plane, as Alice, and answers without a turn.
    let command_turn = alice.say("/goal Publish the v2 release notes").await?;
    assert_eq!(command_turn.state(), TaskState::Succeeded);
    let answer = alice.result(&command_turn.task_id).await?;
    let objective = answer
        .strip_prefix("Created Objective ")
        .and_then(|rest| rest.split(':').next())
        .with_context(|| answer.clone())?
        .to_owned();
    assert!(objective.starts_with("publish-the-v2-"), "{answer}");
    let record = objectives_client::ObjectivesClient::new(connected.clone())
        .get_objective(authenticated_request(
            GetObjectiveRequest {
                objective_id: objective.clone(),
            },
            &alice_token,
            None,
        )?)
        .await?
        .into_inner();
    assert_eq!(record.owner_tag_id, "owner");
    assert_eq!(record.created_by, "operator:alice");
    assert_eq!(record.outcome, "Publish the v2 release notes");
    let started = record.starting_task_id;

    // The Objective's own turn reads only its own Objective, and sees itself in its portfolio.
    run_host(&public, &host_token, &host).await?;
    let summary: Value = serde_json::from_str(&alice.result(&started).await?)?;
    assert_eq!(summary["mayRead"], true, "{summary}");
    assert_eq!(summary["readObjective"], objective);
    assert_eq!(summary["readOther"], "FailedPrecondition");
    assert!(
        summary["portfolio"]
            .as_str()
            .is_some_and(|text| text.contains(&format!(
                "- {objective} [working] Publish the v2 release notes"
            ))),
        "{summary}"
    );
    // Cancelled, the Objective queues no idle wake ahead of Bob's next turn.
    objectives_client::ObjectivesClient::new(connected.clone())
        .cancel_objective(authenticated_request(
            ObjectiveActionRequest {
                objective_id: objective.clone(),
                operation_id: "stop".into(),
                reason: "Test complete".into(),
            },
            &alice_token,
            None,
        )?)
        .await?;

    // Bob's turn sees neither Alice's conversations nor the Objective she created.
    let bob_recall = bob.say("recall release").await?;
    run_host(&public, &host_token, &host).await?;
    let summary: Value = serde_json::from_str(&bob.result(&bob_recall.task_id).await?)?;
    assert_eq!(summary["sessions"], json!([]), "{summary}");
    assert_eq!(summary["matches"], json!([]), "{summary}");
    assert_eq!(summary["objectives"], json!([]), "{summary}");
    plane.kill().await?;
    Ok(())
}
