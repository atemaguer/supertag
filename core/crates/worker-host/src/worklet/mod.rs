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
pub(crate) mod launch;
pub(crate) mod pool;
pub(crate) mod readiness;
pub(crate) mod recovery;
pub(crate) mod registration;
pub(crate) mod run;
pub(crate) mod shared_host;
pub(crate) mod volume_objects;
pub(crate) mod workspaces;

use std::{collections::BTreeMap, path::PathBuf};

use supertag_workspaces::artifact_volumes::FileVolume;

use crate::{
    ArtifactPeers, ArtifactSourceConfig, McpCatalog, WorkerOptions, WorkspaceMapping,
    WorkspaceMounts, environment, worker::egress,
};

/// This Worker Host's enrolled credential, which authenticates its lease operations. Only the
/// Worklet process holds it. A Worker's data calls carry its Attempt credential instead, and
/// the host calls a Worker needs (lease checks, Volume grants, held transfers, review reads) go
/// to its Worklet over the local contract: see `HostSigner`.
#[derive(Clone)]
pub(crate) struct HostToken(String);

/// Who signs a host call a handle makes: the Worklet, with the host credential it holds, or, in
/// a Worker, its Worklet over the local contract, which makes the call for the Worker's own
/// Attempt only.
#[derive(Clone)]
pub(crate) enum HostSigner {
    Host(HostToken),
    Worklet(crate::local::WorkletLink),
}

impl HostSigner {
    /// The host credential, which only the Worklet's own handles hold.
    pub(crate) fn host(&self) -> Result<&HostToken, tonic::Status> {
        match self {
            Self::Host(token) => Ok(token),
            Self::Worklet(_) => Err(tonic::Status::permission_denied(
                "only the Worklet makes this host call",
            )),
        }
    }
}

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
        let credential = HostSigner::Host(HostToken::new("host-token".into()));
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
    /// Where reports sample free disk space, normally the state directory's filesystem.
    pub disk_space: environment::DiskSpaceSource,
    /// The OS command that keeps the machine awake while an Attempt runs, if any.
    pub keep_awake: Option<environment::KeepAwakeCommand>,
    /// Operator-declared placement labels. The host adds its operating system
    /// and architecture; the Control Plane derives harness and Workspace labels.
    pub labels: Vec<String>,
    /// The harnesses this host runs, each in its own slots of the Worker pool.
    pub harnesses: Vec<HarnessService>,
    /// How many Attempts of each harness run at once: the pool's slots per harness. A change
    /// takes effect without a restart; a lowered size lets running Attempts finish.
    pub concurrency: tokio::sync::watch::Receiver<u32>,
}

/// One harness a Worklet runs: what its Workers run, how one is started, and the secrets the
/// Worklet keeps for it and hands each of its Workers.
pub struct HarnessService {
    pub worker: WorkerOptions,
    pub launch: WorkerLaunch,
    /// This harness's provider keys and tokens, read from the file its supervisor wrote.
    pub provider_credentials: BTreeMap<String, String>,
    /// Credentials the egress proxy injects for Tasks whose network scope names them.
    pub network_credentials: Vec<egress::HostCredential>,
}

/// How the Worklet starts a Worker: the program and its arguments. The Worker reads its
/// options from them, as the Worklet read the harness's.
#[derive(Clone)]
pub struct WorkerLaunch {
    pub program: PathBuf,
    pub args: Vec<std::ffi::OsString>,
}
