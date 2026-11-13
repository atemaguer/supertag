use std::{
    fs,
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, ensure};
use clap::Subcommand;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use supertag_protocol::{
    MAX_MESSAGE_BYTES,
    v2::{operator_client::OperatorClient, *},
};
use tonic::Code;
use uuid::Uuid;

use crate::{Connection, connect_operator, request};

#[derive(Subcommand)]
pub enum PlacementCommand {
    /// Replace the labels a bound Worker Host must carry to run a Tag's Tasks.
    RunsOn {
        tag_id: String,
        /// Required labels. Omit every label to allow any bound host.
        labels: Vec<String>,
    },
    /// Explain which bound Worker Hosts can take a Task, and why others cannot.
    Explain { task_id: String },
}

pub async fn run(connection: Connection, command: PlacementCommand) -> Result<()> {
    let (channel, token) = connect_operator(connection).await?;
    let mut client = placement_client::PlacementClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES);
    let output = match command {
        PlacementCommand::RunsOn { tag_id, labels } => {
            let tag = client
                .set_tag_runs_on(request(
                    SetTagRunsOnRequest {
                        tag_id,
                        runs_on: labels,
                    },
                    &token,
                )?)
                .await?
                .into_inner();
            json!({ "tag_id": tag.tag_id, "runs_on": tag.runs_on })
        }
        PlacementCommand::Explain { task_id } => {
            let diagnosis = client
                .diagnose_task(request(DiagnoseTaskPlacementRequest { task_id }, &token)?)
                .await?
                .into_inner();
            let state = diagnosis
                .state()
                .as_str_name()
                .trim_start_matches("TASK_STATE_")
                .to_ascii_lowercase();
            json!({
                "task_id": diagnosis.task_id,
                "tag_id": diagnosis.tag_id,
                "state": state,
                "required_labels": diagnosis.required_labels,
                "missing_labels": diagnosis.missing_labels,
                "requirement": diagnosis.requirement,
                "summary": diagnosis.summary,
                "hosts": diagnosis.hosts.into_iter().map(|host| {
                    let phase = host
                        .phase()
                        .as_str_name()
                        .trim_start_matches("HOST_PHASE_")
                        .to_ascii_lowercase();
                    json!({
                        "host_id": host.host_id,
                        "phase": phase,
                        "labels": host.labels,
                        "missing_labels": host.missing_labels,
                        "eligible": host.eligible,
                    })
                }).collect::<Vec<_>>(),
            })
        }
    };
    println!("{output}");
    Ok(())
}

fn auth_keys(
    channel: tonic::transport::Channel,
) -> auth_keys_client::AuthKeysClient<tonic::transport::Channel> {
    auth_keys_client::AuthKeysClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
}

/// An Auth Key without its secret. Its phase follows packages/core/src/auth-key.ts:
/// revocation wins over expiry, and expiry over a one-time key's use.
pub fn auth_key_view(key: &AuthKey) -> Value {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as i64);
    let phase = if key.revoked {
        "revoked"
    } else if key.expires_at_ms <= now {
        "expired"
    } else if key.used && !key.reusable {
        "used"
    } else {
        "active"
    };
    json!({
        "name": key.name,
        "phase": phase,
        "host_id": key.host_id,
        "reusable": key.reusable,
        "ephemeral": key.ephemeral,
        "labels": key.labels,
        "allowed_tag_ids": key.allowed_tag_ids,
        "all_tags": key.all_tags,
        "used": key.used,
        "revoked": key.revoked,
        "created_at_ms": key.created_at_ms,
        "expires_at_ms": key.expires_at_ms,
    })
}

pub async fn list_auth_keys(connection: Connection, limit: u32, cursor: String) -> Result<()> {
    let (channel, token) = connect_operator(connection).await?;
    let page = auth_keys(channel)
        .list_auth_keys(request(ListAuthKeysRequest { limit, cursor }, &token)?)
        .await?
        .into_inner();
    println!(
        "{}",
        json!({
            "auth_keys": page.auth_keys.iter().map(auth_key_view).collect::<Vec<_>>(),
            "next_cursor": page.next_cursor,
        })
    );
    Ok(())
}

pub async fn get_auth_key(connection: Connection, name: String) -> Result<()> {
    let (channel, token) = connect_operator(connection).await?;
    let key = auth_keys(channel)
        .get_auth_key(request(GetAuthKeyRequest { name }, &token)?)
        .await?
        .into_inner();
    println!("{}", auth_key_view(&key));
    Ok(())
}

pub async fn revoke_auth_key(connection: Connection, name: String) -> Result<()> {
    let (channel, token) = connect_operator(connection).await?;
    let key = auth_keys(channel)
        .revoke_auth_key(request(RevokeAuthKeyRequest { name }, &token)?)
        .await?
        .into_inner();
    println!("{}", auth_key_view(&key));
    Ok(())
}

/// Rotates a Worker Host's credential. The CLI generates the secret, so the Control Plane only
/// ever receives its digest. With `--out`, the credential is written to a new owner-only file
/// after the Control Plane accepts it. With `--host-state-directory`, the replacement is recorded in the
/// host's state first, so running the command again after a lost response completes the same
/// rotation instead of locking the host out.
pub async fn rotate_host_credential(
    connection: Connection,
    host_id: String,
    out: Option<PathBuf>,
    state_directory: Option<PathBuf>,
) -> Result<()> {
    let (channel, token) = connect_operator(connection).await?;
    let current = OperatorClient::new(channel.clone())
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .get_host(request(
            GetHostRequest {
                host_id: host_id.clone(),
            },
            &token,
        )?)
        .await?
        .into_inner()
        .credential_revision;
    let mut client = host_credentials_client::HostCredentialsClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES);
    let rotate = |secret: &str, expected: u64| {
        request(
            RotateHostCredentialRequest {
                host_id: host_id.clone(),
                expected_credential_revision: expected,
                token_digest: Sha256::digest(secret.as_bytes()).to_vec(),
            },
            &token,
        )
    };
    let rotation = if let Some(directory) = state_directory {
        let pending =
            supertag_worker_host::begin_credential_rotation(&directory, &host_id, current)?;
        match client
            .rotate_host_credential(rotate(&pending.token, pending.expected_revision)?)
            .await
        {
            Ok(response) => {
                supertag_worker_host::finish_credential_rotation(&directory, &pending)?;
                response.into_inner()
            }
            Err(status) => {
                if !matches!(
                    status.code(),
                    Code::Unavailable | Code::DeadlineExceeded | Code::Unknown | Code::Cancelled
                ) {
                    supertag_worker_host::abandon_credential_rotation(&directory, &pending)?;
                }
                return Err(status.into());
            }
        }
    } else {
        let out = out.context("choose --out or --host-state-directory")?;
        // Refuse an existing path before the old credential stops working.
        ensure!(
            fs::symlink_metadata(&out).is_err(),
            "{} already exists; choose a new file",
            out.display()
        );
        let secret = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let rotation = client
            .rotate_host_credential(rotate(&secret, current)?)
            .await?
            .into_inner();
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&out)
            .with_context(|| format!("write the new credential to {}", out.display()))?;
        file.write_all(secret.as_bytes())?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        rotation
    };
    println!(
        "{}",
        json!({
            "host_id": rotation.host_id,
            "credential_revision": rotation.credential_revision,
        })
    );
    Ok(())
}
