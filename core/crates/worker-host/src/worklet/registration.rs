//! Registering this Worker Host's incarnation with the Control Plane, and the clients the
//! Worklet and its Workers call once it is registered.

use std::{collections::BTreeMap, path::Path};

use anyhow::{Result, ensure};
use supertag_protocol::{
    MAX_MESSAGE_BYTES,
    negotiation::{self, NegotiationError},
    v2::{
        HostRecord, RegisterHostRequest, ServiceRole,
        attempt_artifacts_client::AttemptArtifactsClient,
        attempt_changed_paths_client::AttemptChangedPathsClient,
        attempt_effects_client::AttemptEffectsClient, attempt_mailbox_client::AttemptMailboxClient,
        attempt_mcp_effects_client::AttemptMcpEffectsClient,
        attempt_memory_client::AttemptMemoryClient,
        attempt_schedules_client::AttemptSchedulesClient,
        attempt_tag_sessions_client::AttemptTagSessionsClient,
        attempt_task_files_client::AttemptTaskFilesClient,
        attempt_work_sessions_client::AttemptWorkSessionsClient,
        attempt_workspace_mounts_client::AttemptWorkspaceMountsClient,
        attempt_workstreams_client::AttemptWorkstreamsClient, worker_host_client::WorkerHostClient,
    },
};
use supertag_workspaces::artifact_volumes::FileVolume;
use tokio_util::sync::CancellationToken;
use tonic::transport::Channel;

use crate::{
    ArtifactPeers, AttemptClients, HostHeaders, request, retryable, wait_for_work,
    worklet::{
        HostSigner, HostStorage, artifact_direct::SourceStorage, authority::AttemptClient,
        checkpoints,
    },
};

/// Negotiates the protocol with the Control Plane and registers this host's incarnation, waiting
/// while the Control Plane is unreachable. `None` when shutdown comes first.
pub(crate) async fn register(
    channel: &Channel,
    control_plane: &supertag_transport::Target,
    incarnation_id: &str,
    token: &str,
    shutdown: &CancellationToken,
) -> Result<Option<(HostRecord, u32)>> {
    loop {
        if shutdown.is_cancelled() {
            return Ok(None);
        }
        // Refuse an incompatible Control Plane before registering for work.
        let protocol = match negotiation::negotiate(
            channel.clone(),
            ServiceRole::WorkerHost,
            ServiceRole::ControlPlane,
        )
        .await
        {
            Ok(version) => version,
            Err(NegotiationError::Unavailable(_)) => {
                wait_for_work(shutdown).await;
                continue;
            }
            Err(error) => return Err(error.at(control_plane.url()).into()),
        };
        let response = WorkerHostClient::new(negotiation::bind(channel.clone(), protocol))
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
            .register_host(request(
                RegisterHostRequest {
                    incarnation_id: incarnation_id.to_owned(),
                },
                token,
            )?)
            .await;
        match response {
            Ok(response) => {
                let host = response.into_inner();
                ensure!(
                    !host.revoked && host.generation > 0,
                    "Worker Host registration is inactive"
                );
                break Ok(Some((host, protocol)));
            }
            Err(error) if retryable(&error) => wait_for_work(shutdown).await,
            Err(error) => return Err(error.into()),
        }
    }
}

/// The host's own storage, signed by `signer`: the Worklet's, with the host credential, or a
/// Worker's, whose host calls its Worklet makes. `git` is where a reviewed delivery is read.
pub(crate) fn host_storage(
    channel: &Channel,
    headers: &HostHeaders,
    storage: Option<&SourceStorage>,
    artifact_peers: &ArtifactPeers,
    volumes: &BTreeMap<String, FileVolume>,
    (git, signer): (&Path, &HostSigner),
) -> HostStorage {
    let transfers = checkpoints::Transfers::new(channel.clone(), headers.clone(), signer.clone());
    HostStorage {
        review_git: supertag_git_delivery::GitDelivery::for_host(git).ok(),
        artifact_source: storage.cloned(),
        held_transfers: crate::worklet::artifact_direct::HeldTransfers::new(
            supertag_protocol::v2::artifact_sources_client::ArtifactSourcesClient::with_interceptor(
                channel.clone(),
                headers.clone(),
            )
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES),
            signer.clone(),
        ),
        artifact_peers: artifact_peers.clone(),
        volumes: std::sync::Arc::new(volumes.clone()),
        volume_objects: crate::worklet::volume_objects::VolumeObjects::new(
            supertag_protocol::v2::volume_objects_client::VolumeObjectsClient::with_interceptor(
                channel.clone(),
                headers.clone(),
            )
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES),
            signer.clone(),
        ),
        transfers: match storage {
            Some(storage) => transfers.with_storage(storage.clone()),
            None => transfers,
        },
    }
}

/// The Attempt-scoped clients a Worker's data calls go through, each call carrying its Attempt
/// credential.
pub(crate) fn attempt_clients(channel: &Channel, headers: &HostHeaders) -> AttemptClients {
    AttemptClients {
        attempt: AttemptClient::new(
            WorkerHostClient::with_interceptor(channel.clone(), headers.clone())
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_MESSAGE_BYTES),
        ),
        acquisitions: AttemptArtifactsClient::with_interceptor(channel.clone(), headers.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES),
        workstreams: AttemptWorkstreamsClient::with_interceptor(channel.clone(), headers.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES),
        mailbox: AttemptMailboxClient::with_interceptor(channel.clone(), headers.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES),
        work_sessions: AttemptWorkSessionsClient::with_interceptor(
            channel.clone(),
            headers.clone(),
        )
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES),
        tag_sessions: AttemptTagSessionsClient::with_interceptor(channel.clone(), headers.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES),
        schedules: AttemptSchedulesClient::with_interceptor(channel.clone(), headers.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES),
        memory: AttemptMemoryClient::with_interceptor(channel.clone(), headers.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES),
        mcp_effects: AttemptMcpEffectsClient::with_interceptor(channel.clone(), headers.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES),
        changed_paths: AttemptChangedPathsClient::with_interceptor(
            channel.clone(),
            headers.clone(),
        )
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES),
        task_files: AttemptTaskFilesClient::with_interceptor(channel.clone(), headers.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES),
        effects: AttemptEffectsClient::with_interceptor(channel.clone(), headers.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES),
        workspace_mounts: AttemptWorkspaceMountsClient::with_interceptor(
            channel.clone(),
            headers.clone(),
        )
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES),
    }
}
