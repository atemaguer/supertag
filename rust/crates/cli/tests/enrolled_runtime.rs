#[path = "../../../test-support/prerequisites.rs"]
mod prerequisites;
#[path = "support/protocol.rs"]
mod protocol;
#[macro_use]
#[path = "support/database.rs"]
mod database;

use std::{
    net::SocketAddr,
    os::unix::fs::PermissionsExt,
    path::Path,
    process::{Output, Stdio},
    time::Duration,
};

use anyhow::{Context, Result, ensure};
use serde_json::Value;
use sha2::{Digest, Sha256};
use supertag_protocol::{
    authenticated_request,
    v2::{EnrollHostRequest, host_enrollment_client::HostEnrollmentClient},
};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    time::timeout,
};
use uuid::Uuid;

const BINARY: &str = env!("CARGO_BIN_EXE_supertag");
const ADAPTER: &str = env!("CARGO_BIN_EXE_supertag-fixture-adapter");
const WAIT: Duration = Duration::from_secs(15);

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

fn field<'a>(value: &'a Value, name: &str) -> Result<&'a str> {
    value[name]
        .as_str()
        .with_context(|| format!("missing {name}"))
}

fn operator(args: &[&str], gateway: &str, token: &str) -> Command {
    let mut command = binary(args);
    command
        .args(["--gateway", gateway])
        .env("SUPERTAG_OPERATOR_TOKEN", token);
    command
}

fn worker(gateway: &str, state: &Path) -> Command {
    let mut command = binary(&[
        "worker-host",
        "--gateway",
        gateway,
        "--adapter",
        ADAPTER,
        "--once",
    ]);
    command.arg("--state-directory").arg(state);
    command
}

database_tests! {
    #[tokio::test]
    cli_enrollment_replays_pending_credential_and_limits_assignment_until_revocation;
}

async fn cli_enrollment_replays_pending_credential_and_limits_assignment_until_revocation(
    database: String,
) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let gateway_token = Uuid::new_v4().to_string();
    let operator_token = Uuid::new_v4().to_string();
    let mut control = binary(&["control-plane"]);
    control
        .env("SUPERTAG_GATEWAY_TOKEN", &gateway_token)
        .env("SUPERTAG_DATABASE_URL", database);
    let (mut control, private) = service(control).await?;
    let mut gateway = binary(&["gateway", "--control-plane", &private]);
    gateway
        .env("SUPERTAG_GATEWAY_TOKEN", &gateway_token)
        .env("SUPERTAG_OPERATOR_TOKEN", &operator_token);
    let (mut gateway, public) = service(gateway).await?;

    for tag in ["other-team", "reviewer"] {
        json(operator(
            &["put-tag", tag, "--instructions", "Review the change"],
            &public,
            &operator_token,
        ))
        .await?;
    }
    let issued = json(operator(
        &["create-auth-key", "review-host", "--tag", "reviewer"],
        &public,
        &operator_token,
    ))
    .await?;
    assert_eq!(issued["host_id"], "review-host");
    assert_eq!(issued["allowed_tag_ids"], serde_json::json!(["reviewer"]));
    let auth_key = field(&issued, "auth_key")?;
    let key_file = directory.path().join("join.key");
    std::fs::write(&key_file, "unissued-test-key\n")?;
    std::fs::set_permissions(&key_file, std::fs::Permissions::from_mode(0o600))?;
    let key_argument = format!("file:{}", key_file.display());
    let state = directory.path().join("worker-state");
    let enroll = || {
        let mut command = binary(&[
            "enroll-host",
            "review-host",
            "--gateway",
            &public,
            "--auth-key",
            &key_argument,
        ]);
        command.arg("--state-directory").arg(&state);
        command
    };
    let failed = output(enroll()).await?;
    assert!(!failed.status.success());
    let failure = String::from_utf8_lossy(&failed.stderr);
    ensure!(
        failure.contains("valid Worker Host credential required"),
        "enrollment failed for an unexpected reason: {failure}"
    );
    let enrollment_file = state.join("enrollment.json");
    assert_eq!(
        std::fs::metadata(&enrollment_file)?.permissions().mode() & 0o777,
        0o600
    );
    let pending: Value = serde_json::from_slice(&std::fs::read(&enrollment_file)?)?;
    assert!(pending["receipt"].is_null());
    let candidate = field(&pending, "token")?;
    let operation_id = field(&pending, "operation_id")?;

    // Commit the CLI's pending operation without delivering its receipt to that
    // process. The retry must keep both the candidate credential and operation ID.
    let mut enrollment = HostEnrollmentClient::new(protocol::dial(public.clone()).await?);
    let mut request = authenticated_request(
        EnrollHostRequest {
            host_id: "review-host".into(),
            operation_id: operation_id.into(),
            token_digest: Sha256::digest(candidate).to_vec(),
        },
        auth_key,
        None,
    )?;
    request.set_timeout(WAIT);
    enrollment.enroll_host(request).await?;
    std::fs::write(&key_file, format!("{auth_key}\n"))?;
    let joined = json(enroll()).await?;
    assert_eq!(
        joined,
        serde_json::json!({"host_id": "review-host", "generation": 0})
    );
    let saved: Value = serde_json::from_slice(&std::fs::read(&enrollment_file)?)?;
    ensure!(
        field(&saved, "token")? == candidate,
        "pending credential changed"
    );
    assert_eq!(field(&saved, "operation_id")?, operation_id);
    assert_eq!(saved["receipt"]["generation"], 0);

    let submit = |tag| {
        operator(
            &[
                "submit",
                "--tag",
                tag,
                "--session",
                "review",
                "Check the diff",
            ],
            &public,
            &operator_token,
        )
    };
    let excluded = json(submit("other-team")).await?;
    let included = json(submit("reviewer")).await?;
    let excluded_id = field(&excluded, "task_id")?;
    let included_id = field(&included, "task_id")?;
    let executed = output(worker(&public, &state)).await?;
    ensure!(
        executed.status.success(),
        "enrolled Worker Host failed: {}",
        String::from_utf8_lossy(&executed.stderr)
    );
    let read_task = |id| operator(&["get-task", id], &public, &operator_token);
    let completed = json(read_task(included_id)).await?;
    assert_eq!(completed["state"], "TASK_STATE_SUCCEEDED");
    assert_eq!(completed["result"], "Review the change: Check the diff []");
    assert_eq!(
        json(read_task(excluded_id)).await?["state"],
        "TASK_STATE_QUEUED"
    );

    let revoked = json(operator(
        &["revoke-host", "review-host"],
        &public,
        &operator_token,
    ))
    .await?;
    assert_eq!(
        revoked,
        serde_json::json!({"host_id": "review-host", "revoked": true})
    );
    let denied = output(worker(&public, &state)).await?;
    assert!(!denied.status.success());
    let failure = String::from_utf8_lossy(&denied.stderr);
    ensure!(
        failure.contains("valid Worker Host credential required"),
        "revoked Worker Host failed for an unexpected reason: {failure}"
    );
    gateway.kill().await?;
    control.kill().await?;
    Ok(())
}
