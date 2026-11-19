//! The Worker process: it reads its `Assign` from the channel its Worklet passed it, runs that one
//! Task Attempt, hands the outcome over, and exits. It holds the Attempt credential and the
//! secrets its Attempt may use, never the host credential.

use std::{collections::BTreeMap, os::fd::FromRawFd as _, path::PathBuf, sync::Arc};

use anyhow::{Context, Result, ensure};
use supertag_protocol::{
    MAX_MESSAGE_BYTES,
    v2::{attempt_inputs_client::AttemptInputsClient, worker_host_client::WorkerHostClient},
};
use supertag_workspaces::artifact_volumes::FileVolume;
use tokio_util::sync::CancellationToken;

use crate::{
    ArtifactPeers, HostHeaders, McpCatalog, WorkerOptions, WorkspaceMapping, WorkspaceMounts,
    local::{CHANNEL_FD, WorkletLink},
    worker::{Settings, authority::WorkerAuthority, egress::HostCredential, run::Worker},
    worklet::{
        HostSigner, artifact_direct::SourceStorage, journal::Journal, registration, workspaces,
    },
};

/// What a Worker reads from its own arguments, as its Worklet read the same harness's: what it
/// runs, and the host's Workspaces, storage, Volumes, and catalogs. Its Attempt, and the secrets
/// it may use, come in its `Assign`.
pub struct WorkerProcessOptions {
    pub worker: WorkerOptions,
    pub control_plane: supertag_transport::Target,
    pub workspaces: Vec<WorkspaceMapping>,
    /// The host's artifact storage, which the Worklet serves and its Workers write captures to.
    pub artifact_directory: PathBuf,
    pub artifact_peers: ArtifactPeers,
    pub volumes: BTreeMap<String, FileVolume>,
    pub workspace_mounts: WorkspaceMounts,
    pub mcp_catalog: McpCatalog,
}

/// Marks the channel its Worklet passed this Worker close-on-exec, so that nothing the Worker
/// starts inherits it. A Worker calls it first, before it starts any process, even to read its
/// options.
pub fn protect_worker_channel() -> Result<()> {
    // SAFETY: F_GETFD only reads the descriptor's flags.
    ensure!(
        unsafe { libc::fcntl(CHANNEL_FD, libc::F_GETFD) } >= 0,
        "a Worker runs only under its Worklet, which passes it descriptor {CHANNEL_FD}"
    );
    // SAFETY: setting FD_CLOEXEC on a descriptor this process owns.
    if unsafe { libc::fcntl(CHANNEL_FD, libc::F_SETFD, libc::FD_CLOEXEC) } != 0 {
        return Err(std::io::Error::last_os_error()).context("protect the Worklet channel");
    }
    Ok(())
}

/// Runs the one Attempt its Worklet assigns on the inherited channel. Returns once the outcome is
/// handed over and the Attempt's processes and sandbox are stopped; exits at once if the Worklet
/// dies.
pub async fn run_worker(options: WorkerProcessOptions) -> Result<()> {
    protect_worker_channel()?;
    // SAFETY: the Worklet passed its end of a socket pair as this descriptor, which nothing else
    // in this process owns. The harness and its adapter never inherit it.
    let channel = unsafe { std::os::unix::net::UnixStream::from_raw_fd(CHANNEL_FD) };
    channel.set_nonblocking(true)?;
    let stop = CancellationToken::new();
    let (link, assign) = WorkletLink::connect(
        tokio::net::UnixStream::from_std(channel)?,
        stop.clone(),
        // The Worklet died: the Worker dies with it. Its guardian reaps the harness, and the
        // Worklet's next start recovers the Attempt from its journal.
        || std::process::exit(70),
    )
    .await?;
    failures_remember(&assign.attempt.attempt_credential);
    crate::credentials::set_provider_credentials(assign.secrets.provider.clone())?;
    let network = assign
        .secrets
        .network
        .iter()
        .map(|credential| {
            HostCredential::new(
                &credential.name,
                &credential.variable,
                credential.value.clone(),
            )
        })
        .collect::<Result<Vec<_>>>()?;
    ensure!(
        assign.data_endpoint == options.control_plane.url(),
        "the Worklet assigned another data endpoint than this Worker's Control Plane"
    );
    let registration = assign.registration.0.clone();
    let channel = options.control_plane.clone().connect_lazy();
    let headers = HostHeaders::new(registration.generation, assign.protocol);
    let coordination = registration::attempt_clients(&channel, &headers);
    let inputs = AttemptInputsClient::with_interceptor(channel.clone(), headers.clone())
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES);
    let signer = HostSigner::Worklet(link.clone());
    let directory = options.artifact_directory.clone();
    let source = tokio::task::spawn_blocking(move || SourceStorage::open(&directory)).await??;
    let storage = registration::host_storage(
        &channel,
        &headers,
        Some(&source),
        &options.artifact_peers,
        &options.volumes,
        (&assign.state_directory.join("review-git"), &signer),
    );
    let transfers = storage
        .transfers
        .clone()
        .with_volumes(Arc::new(options.volumes.clone()));
    let state_directory = assign.state_directory.clone();
    let workspaces = workspaces::Workspaces::new(&state_directory, options.workspaces.clone())?;
    let journal = Journal::view(&state_directory)?;
    let host = WorkerHostClient::with_interceptor(channel, headers)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES);
    let run = Box::pin(
        Worker {
            options: Settings {
                options: &options.worker,
                state_directory: &state_directory,
                mcp_catalog: &options.mcp_catalog,
                network_credentials: &network,
                workspace_mounts: &options.workspace_mounts,
            },
            journal: journal.for_attempt(),
            workspaces: &workspaces,
            inputs: &inputs,
            coordination: &coordination,
            storage: &storage,
            transfers: &transfers,
            shutdown: &stop,
            authority: WorkerAuthority::new(
                link,
                host,
                &registration,
                journal.for_attempt(),
                &stop,
            ),
        }
        .run(assign),
    )
    .await;
    // The harness's reply may still be on its way to the Control Plane.
    crate::worker::milestones::flush().await;
    run
}

fn failures_remember(credential: &str) {
    crate::failures::remember_credential(credential);
}
