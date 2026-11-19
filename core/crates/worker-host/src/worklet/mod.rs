//! The Worklet: the per-host program of a Worker Host. It registers the host, reports its
//! presence, claims Task Attempts and holds their leases, keeps the journal that recovery resumes
//! from, and owns the host's checkouts, Session checkpoints, held artifacts, landings, and
//! cleanup. It runs each claimed Attempt in a Worker.

pub(crate) mod artifact_direct;
pub(crate) mod authority;
pub(crate) mod background;
pub(crate) mod checkpoints;
pub(crate) mod claim;
pub(crate) mod cleanup_failure;
pub(crate) mod enrollment;
pub(crate) mod finish;
pub(crate) mod journal;
pub(crate) mod landing;
pub(crate) mod readiness;
pub(crate) mod recovery;
pub(crate) mod registration;
pub(crate) mod run;
pub(crate) mod shared_host;
pub(crate) mod volume_objects;
pub(crate) mod workspaces;

use std::{collections::BTreeMap, path::PathBuf};

use supertag_workspaces::artifact_volumes::FileVolume;
use tokio_util::sync::CancellationToken;

use crate::{
    ArtifactPeers, ArtifactSourceConfig, LaneObserver, McpCatalog, WorkspaceMapping,
    WorkspaceMounts, environment, worker::egress,
};

/// This Worker Host's enrolled credential, which authenticates its lease operations. Only the
/// Worklet reads it. The handles it lends a Worker (the lease, checkpoint and delivery transfers,
/// held artifact transfers, Volume object grants) hold it privately and make host calls with it,
/// so a Worker cannot read it but does make those host calls through them, until it runs as a
/// process of its own. A Worker's data calls carry its Attempt credential instead.
#[derive(Clone)]
pub(crate) struct HostToken(String);

impl HostToken {
    pub(in crate::worklet) fn new(secret: String) -> Self {
        Self(secret)
    }

    pub(in crate::worklet) fn secret(&self) -> &str {
        &self.0
    }
}

/// The host's own storage, which the Worklet owns and lends a Worker for what its Attempt reads,
/// delivers, or checkpoints: the artifact and delivery bytes this host holds, its artifact
/// peers, its mapped Volumes and their object transfers, checkpoint transfers, and the Git
/// cache a reviewed delivery is read through.
#[derive(Clone)]
pub(crate) struct HostStorage {
    pub(crate) transfers: checkpoints::Transfers,
    pub(crate) artifact_source: Option<artifact_direct::SourceStorage>,
    /// Redeems a direct artifact grant for bytes this host's own storage holds.
    pub(crate) held_transfers: artifact_direct::HeldTransfers,
    pub(crate) artifact_peers: ArtifactPeers,
    pub(crate) volumes: volume_objects::HostVolumes,
    pub(crate) volume_objects: volume_objects::VolumeObjects,
    /// Git for reading a reviewed delivery from its remote Workspace's Session branch.
    pub(crate) review_git: Option<supertag_git_delivery::GitDelivery>,
}

#[cfg(test)]
impl HostStorage {
    /// Host storage on `channel` with a fixed host credential and nothing held, for tests.
    pub(crate) fn unconnected(
        channel: tonic::transport::Channel,
        headers: crate::HostHeaders,
    ) -> Self {
        let credential = HostToken::new("host-token".into());
        Self {
            transfers: checkpoints::Transfers::new(
                channel.clone(),
                headers.clone(),
                credential.clone(),
            ),
            artifact_source: None,
            held_transfers: artifact_direct::HeldTransfers::new(
                supertag_protocol::v2::artifact_sources_client::ArtifactSourcesClient::with_interceptor(
                    channel.clone(),
                    headers.clone(),
                ),
                credential.clone(),
            ),
            review_git: None,
            artifact_peers: crate::ArtifactPeers::default(),
            volumes: Default::default(),
            volume_objects: volume_objects::VolumeObjects::new(
                supertag_protocol::v2::volume_objects_client::VolumeObjectsClient::with_interceptor(
                    channel, headers,
                ),
                credential,
            ),
        }
    }
}

/// What the Worklet reads: this host's identity and connection, its state, the Workspaces and
/// Volumes it maps, its secrets, and how it claims and recovers.
pub struct WorkletOptions {
    pub control_plane: supertag_transport::Target,
    pub token: Option<String>,
    pub state_directory: PathBuf,
    pub wait_for_recovery: bool,
    pub once: bool,
    /// Every Workspace this host can prepare. Several IDs may name one source.
    pub workspaces: Vec<WorkspaceMapping>,
    /// Where this host keeps the artifact and Workspace delivery bytes it holds; `None` keeps them in
    /// `STATE_DIRECTORY/artifacts`.
    pub artifact_source: Option<ArtifactSourceConfig>,
    pub artifact_peers: ArtifactPeers,
    /// File Volumes this host maps, by Volume ID. The work of a Tag that keeps it on one, such as
    /// its captures, is written there directly.
    pub volumes: BTreeMap<String, FileVolume>,
    /// The Volume mounts this host copies into Workspaces and writes back after a successful
    /// Attempt.
    pub workspace_mounts: WorkspaceMounts,
    /// The MCP servers this host offers, with the logins it keeps for them.
    pub mcp_catalog: McpCatalog,
    /// Credentials the egress proxy injects for Tasks whose network scope names them.
    pub network_credentials: Vec<egress::HostCredential>,
    /// Where reports sample free disk space, normally the state directory's filesystem.
    pub disk_space: environment::DiskSpaceSource,
    /// The OS command that keeps the machine awake while an Attempt runs, if any.
    pub keep_awake: Option<environment::KeepAwakeCommand>,
    /// Operator-declared placement labels. The host adds its operating system
    /// and architecture; the Control Plane derives harness and Workspace labels.
    pub labels: Vec<String>,
    /// Set when a supervisor runs this process as one execution lane of a shared Host.
    pub lane: Option<Lane>,
}

/// One supervised execution lane. Every lane of a Host registers the Host's single
/// incarnation, so sibling lanes never replace each other's generation. The supervisor
/// owns the Host's presence report and receives this lane's state instead.
#[derive(Clone)]
pub struct Lane {
    pub incarnation_id: String,
    pub observer: LaneObserver,
    /// Cancelled when the supervisor lowers the Host's concurrency below this lane: the lane
    /// claims no more work and returns once it holds no Attempt, so its journal is left empty.
    pub retire: CancellationToken,
}
