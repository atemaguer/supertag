use anyhow::Result;
use clap::Subcommand;
use serde_json::{Value, json};
use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};

use crate::{Connection, connect_operator, request};

#[derive(Subcommand)]
pub enum HostCommand {
    /// List Worker Hosts and their readiness.
    List {
        /// Most entries to return on one page.
        #[arg(long, default_value_t = 32)]
        limit: u32,
        /// Continue from the cursor the previous page returned.
        #[arg(long, default_value = "")]
        cursor: String,
    },
    /// Read one Worker Host.
    Get { host_id: String },
    /// Stop assigning new Tasks while the Worker Host finishes current work.
    Drain { host_id: String },
    /// Allow the Worker Host to claim new Tasks again.
    Resume { host_id: String },
}

pub async fn run(connection: Connection, command: HostCommand) -> Result<()> {
    let (channel, token) = connect_operator(connection).await?;
    let mut client = operator_client::OperatorClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES);
    let draining = matches!(&command, HostCommand::Drain { .. });
    let output = match command {
        HostCommand::List { limit, cursor } => {
            let page = client
                .list_hosts(request(ListHostsRequest { limit, cursor }, &token)?)
                .await?
                .into_inner();
            json!({
                "hosts": page.hosts.into_iter().map(status_json).collect::<Vec<_>>(),
                "next_cursor": page.next_cursor,
            })
        }
        HostCommand::Get { host_id } => status_json(
            client
                .get_host(request(GetHostRequest { host_id }, &token)?)
                .await?
                .into_inner(),
        ),
        HostCommand::Drain { host_id } | HostCommand::Resume { host_id } => status_json(
            client
                .set_host_draining(request(
                    SetHostDrainingRequest { host_id, draining },
                    &token,
                )?)
                .await?
                .into_inner(),
        ),
    };
    crate::terminal::print_json(&output)?;
    Ok(())
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
