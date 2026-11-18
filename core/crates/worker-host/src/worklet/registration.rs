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
use tonic::{service::interceptor::InterceptedService, transport::Channel};

use crate::{
    ArtifactPeers, AttemptClients, HostHeaders, request, retryable, wait_for_work,
    worklet::{HostStorage, artifact_direct::SourceStorage, checkpoints},
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

/// The Attempt-scoped clients a registered host's Workers and finalization call, and the host
/// storage the Worklet lends them.
pub(crate) fn coordination(
    channel: &Channel,
    headers: &HostHeaders,
    acquisitions: AttemptArtifactsClient<InterceptedService<Channel, HostHeaders>>,
    storage: &SourceStorage,
    artifact_peers: &ArtifactPeers,
    volumes: &BTreeMap<String, FileVolume>,
    state_directory: &Path,
) -> (AttemptClients, HostStorage) {
    let host_storage = HostStorage {
        review_git: supertag_git_delivery::GitDelivery::for_host(
            &state_directory.join("review-git"),
        )
        .ok(),
        artifact_source: Some(storage.clone()),
        artifact_peers: artifact_peers.clone(),
        volumes: std::sync::Arc::new(volumes.clone()),
        volume_objects:
            supertag_protocol::v2::volume_objects_client::VolumeObjectsClient::with_interceptor(
                channel.clone(),
                headers.clone(),
            )
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES),
        transfers: checkpoints::Transfers::new(channel.clone(), headers.clone())
            .with_storage(storage.clone()),
    };
    let clients = AttemptClients {
        acquisitions,
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
    };
    (clients, host_storage)
}
