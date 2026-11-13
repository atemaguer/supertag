use std::path::PathBuf;

use anyhow::{Context, Result};
use clap::{Args, Subcommand};
use serde_json::{Value, json};
use supertag_protocol::negotiation::ProtocolChannel;
use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};

use crate::{Connection, connect_operator, request};

#[derive(Subcommand)]
pub enum HostCommand {
    /// Stop assigning new Tasks while the Worker Host finishes current work.
    Drain { host_id: String },
    /// Allow the Worker Host to claim new Tasks again.
    Resume { host_id: String },
    /// Enroll this installation with a one-time Auth Key. Its own --control-plane and
    /// --state-directory name the Control Plane to enroll with and the new Worker Host's state.
    Enroll {
        /// Control Plane URL to enroll with.
        #[arg(long)]
        control_plane: String,
        /// Private directory for this Worker Host's enrollment and execution journal.
        #[arg(long)]
        state_directory: PathBuf,
        host_id: String,
        /// Auth Key or file:PATH. Also reads SUPERTAG_AUTH_KEY.
        #[arg(long)]
        auth_key: Option<String>,
    },
    /// Revoke a Worker Host and its execution authority.
    Revoke { host_id: String },
    /// Replace an enrolled Worker Host's credential. The previous one stops working at once.
    RotateCredential {
        host_id: String,
        /// Write the new credential to this new owner-only file, for a host that reads
        /// SUPERTAG_HOST_TOKEN from its own secret manager.
        #[arg(
            long,
            required_unless_present = "host_state_directory",
            conflicts_with = "host_state_directory"
        )]
        out: Option<PathBuf>,
        /// Install the new credential in the state directory of this machine's stopped,
        /// enrolled Worker Host. It uses the credential when it next starts.
        #[arg(long)]
        host_state_directory: Option<PathBuf>,
    },
}

// Options for `supertag get hosts`.
#[derive(Args)]
pub struct ListArgs {
    /// Most entries to return on one page.
    #[arg(long, default_value_t = 32, conflicts_with = "id")]
    limit: u32,
    /// Continue from the cursor the previous page returned.
    #[arg(long, default_value = "", conflicts_with = "id")]
    cursor: String,
}

fn client(channel: ProtocolChannel) -> operator_client::OperatorClient<ProtocolChannel> {
    operator_client::OperatorClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
}

pub async fn run(connection: Connection, command: HostCommand) -> Result<()> {
    let output = match command {
        HostCommand::Drain { host_id } => set_draining(connection, host_id, true).await?,
        HostCommand::Resume { host_id } => set_draining(connection, host_id, false).await?,
        HostCommand::Enroll {
            control_plane,
            state_directory,
            host_id,
            auth_key,
        } => {
            let control_plane = crate::network::endpoint(control_plane).await?;
            let auth_key = auth_key.or_else(|| std::env::var("SUPERTAG_AUTH_KEY").ok());
            let auth_key = match auth_key {
                Some(key) if key.starts_with("file:") => {
                    let path = key.strip_prefix("file:").expect("checked prefix");
                    let contents = tokio::fs::read_to_string(path)
                        .await
                        .context("read Auth Key file")?;
                    Some(contents.trim().to_owned())
                }
                other => other,
            };
            let record = supertag_worker_host::enroll(
                control_plane,
                &state_directory,
                host_id,
                auth_key.as_deref(),
            )
            .await?;
            json!({ "host_id": record.host_id, "generation": record.generation })
        }
        HostCommand::Revoke { host_id } => {
            let (channel, token) = connect_operator(connection).await?;
            let record = client(channel)
                .revoke_host(request(RevokeHostRequest { host_id }, &token)?)
                .await?
                .into_inner();
            json!({ "host_id": record.host_id, "revoked": record.revoked })
        }
        HostCommand::RotateCredential {
            host_id,
            out,
            host_state_directory,
        } => {
            return crate::placement::rotate_host_credential(
                connection,
                host_id,
                out,
                host_state_directory,
            )
            .await;
        }
    };
    crate::terminal::print_json(&output)?;
    Ok(())
}

async fn set_draining(connection: Connection, host_id: String, draining: bool) -> Result<Value> {
    let (channel, token) = connect_operator(connection).await?;
    Ok(status_json(
        client(channel)
            .set_host_draining(request(
                SetHostDrainingRequest { host_id, draining },
                &token,
            )?)
            .await?
            .into_inner(),
    ))
}

pub(crate) async fn fetch(channel: ProtocolChannel, token: &str, host_id: String) -> Result<Value> {
    Ok(status_json(
        client(channel)
            .get_host(request(GetHostRequest { host_id }, token)?)
            .await?
            .into_inner(),
    ))
}

pub(crate) async fn list(connection: Connection, args: ListArgs) -> Result<Value> {
    let (channel, token) = connect_operator(connection).await?;
    let page = client(channel)
        .list_hosts(request(
            ListHostsRequest {
                limit: args.limit,
                cursor: args.cursor,
            },
            &token,
        )?)
        .await?
        .into_inner();
    Ok(json!({
        "hosts": page.hosts.into_iter().map(status_json).collect::<Vec<_>>(),
        "next_cursor": page.next_cursor,
    }))
}

pub(crate) fn status_json(host: WorkerHostStatus) -> Value {
    let phase = host
        .phase()
        .as_str_name()
        .trim_start_matches("HOST_PHASE_")
        .to_ascii_lowercase();
    let reason = host
        .reason()
        .as_str_name()
        .trim_start_matches("HOST_READINESS_REASON_")
        .to_ascii_lowercase();
    json!({
        "host_id": host.host_id,
        "generation": host.generation,
        "phase": phase,
        "draining": host.draining,
        "capacity": host.capacity,
        "available_slots": host.available_slots,
        "active_attempts": host.active_attempts,
        "disk_space": host.disk_space.as_ref().map(|disk| json!({
            "free_bytes": disk.free_bytes,
            "total_bytes": disk.total_bytes,
        })),
        "disk_warning": supertag_worker_host::environment::low_disk_warning(host.disk_space.as_ref()),
        "reason": reason,
        "harness_kind": host.harness_kind().as_str_name(),
        "harnesses": host.harnesses.iter().map(|harness| json!({
            "harness_kind": harness.harness_kind().as_str_name(),
            "capacity": harness.capacity,
            "available_slots": harness.available_slots,
            "model_ids": harness.execution_profile.as_ref().map(|profile| profile.model_ids.clone()).unwrap_or_default(),
        })).collect::<Vec<_>>(),
        "workspace_ids": host.workspace_ids,
        "enrolled_at_ms": host.enrolled_at_ms,
        "last_seen_at_ms": host.last_seen_at_ms,
        "presence_expires_at_ms": host.presence_expires_at_ms,
        "revoked_at_ms": host.revoked_at_ms,
        "labels": host.labels,
        "granted_labels": host.granted_labels,
        "ephemeral": host.ephemeral,
        "removed_at_ms": host.removed_at_ms,
        "credential_revision": host.credential_revision,
    })
}
