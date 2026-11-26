//! Registering this Worker Host's incarnation with the Control Plane, and the clients the
//! Worklet and its Workers call once it is registered.

use std::{
    collections::{BTreeMap, HashSet},
    path::Path,
};

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
    let mut logged_failures = HashSet::new();
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
            Err(NegotiationError::Unavailable(status)) => {
                log_failure(
                    &mut logged_failures,
                    &control_plane.url(),
                    &status_cause(&status),
                );
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
            Err(error) if retryable(&error) => {
                log_failure(
                    &mut logged_failures,
                    &control_plane.url(),
                    &cause_chain(&error),
                );
                wait_for_work(shutdown).await;
            }
            Err(error) => return Err(error.into()),
        }
    }
}

fn cause_chain(error: &dyn std::error::Error) -> String {
    let mut text = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        text.push_str(": ");
        text.push_str(&cause.to_string());
        source = cause.source();
    }
    text
}

/// A status's message and, when the message leaves it out, its innermost transport cause,
/// such as "tcp connect error: Connection refused".
fn status_cause(status: &tonic::Status) -> String {
    let mut text = status.message().to_owned();
    let mut source = std::error::Error::source(status);
    let mut root = None;
    while let Some(cause) = source {
        root = Some(cause.to_string());
        source = cause.source();
    }
    if let Some(root) = root.filter(|root| !text.contains(root.as_str())) {
        text.push_str(": ");
        text.push_str(&root);
    }
    text
}

fn log_failure(previous: &mut HashSet<String>, url: &str, cause: &str) {
    if !previous.insert(cause.to_owned()) {
        return;
    }
    let hint = if cause.contains("certificate") || cause.contains("UnknownIssuer") {
        "; export SUPERTAG_SERVER_CA_FILE with the issuing CA and run supertag up again"
    } else {
        ""
    };
    supertag_protocol::terminal_text::warn(&format!("Error: Control Plane {url}: {cause}{hint}"));
}

/// Where this Worklet's Workers send their Task Attempts' data calls: the data endpoint the
/// Control Plane named when this incarnation registered, or, when it named none, the Control
/// Plane itself at `control_plane`, the URL the Worklet dials.
pub(crate) fn data_endpoint(registration: &HostRecord, control_plane: &str) -> String {
    if registration.data_endpoint.is_empty() {
        control_plane.to_owned()
    } else {
        registration.data_endpoint.clone()
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connection_failure_includes_nested_certificate_cause() {
        let error = anyhow::anyhow!("invalid peer certificate: UnknownIssuer")
            .context("TLS handshake failed");
        let cause = cause_chain(error.as_ref());
        assert!(cause.contains("TLS handshake failed: invalid peer certificate: UnknownIssuer"));
    }

    #[test]
    fn workers_send_data_calls_to_the_endpoint_registration_named() {
        let control_plane = "https://control-plane.example:3433/";
        let mut registration = HostRecord::default();
        // None named: the Control Plane itself, as the Worklet reaches it.
        assert_eq!(data_endpoint(&registration, control_plane), control_plane);
        registration.data_endpoint = "https://gateway.example:3434".into();
        assert_eq!(
            data_endpoint(&registration, control_plane),
            "https://gateway.example:3434"
        );
    }
}
