//! The Worker process: it reads its `Assign` from the channel its Worklet passed it, runs that one
//! Task Attempt, hands the outcome over, and exits. It holds the Attempt credential and the
//! secrets its Attempt may use, never the host credential.

use std::{
    collections::BTreeMap, future::Future, os::fd::FromRawFd as _, path::PathBuf, pin::Pin,
    sync::Arc,
};

use anyhow::{Context, Result, anyhow, ensure};
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

/// Opens the connection to a data endpoint URL with the transport options the Worker Host uses
/// for its Control Plane: the same scheme rules, TLS roots and client identity, and proxy.
pub type DataDialer = Box<
    dyn FnOnce(String) -> Pin<Box<dyn Future<Output = Result<supertag_transport::Target>> + Send>>
        + Send,
>;

/// What a Worker reads from its own arguments, as its Worklet read the same harness's: what it
/// runs, and the host's Workspaces, storage, Volumes, and catalogs. Its Attempt, the data
/// endpoint its data calls go to, and the secrets it may use come in its `Assign`.
pub struct WorkerProcessOptions {
    pub worker: WorkerOptions,
    /// Dials the data endpoint the Worker's `Assign` names.
    pub data_dialer: DataDialer,
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
    let registration = assign.registration.0.clone();
    // Every call the Attempt credential authorizes goes to the data endpoint, and only there:
    // the Worker has no connection to the Control Plane. Its host calls go to its Worklet.
    let channel = data_target(&assign.data_endpoint, options.data_dialer)
        .await?
        .connect_lazy();
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

/// The Worker's one connection for its Attempt's data calls: to `endpoint`, the data endpoint
/// its Worklet assigned. A connection it cannot open fails `Unavailable`, as an unreachable
/// Control Plane does, and names the endpoint. There is no fallback to another address.
async fn data_target(endpoint: &str, dial: DataDialer) -> Result<supertag_transport::Target> {
    ensure!(
        !endpoint.is_empty(),
        "the Worklet assigned no data endpoint"
    );
    dial(endpoint.to_owned())
        .await
        .with_context(|| format!("the data endpoint {endpoint} is not usable"))?
        .named("the data endpoint")
        .map_err(|error| anyhow!("the data endpoint {endpoint} is not usable: {error}"))
}

fn failures_remember(credential: &str) {
    crate::failures::remember_credential(credential);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A loopback URL nothing listens on.
    fn refusing() -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        format!("http://{address}")
    }

    /// A dialer that records the URL it was asked for.
    fn recording(dialed: Arc<std::sync::Mutex<Vec<String>>>) -> DataDialer {
        Box::new(move |url: String| {
            dialed.lock().unwrap().push(url.clone());
            Box::pin(async move {
                Ok(supertag_transport::Target::native(
                    tonic::transport::Endpoint::from_shared(url)?,
                ))
            })
        })
    }

    #[tokio::test]
    async fn a_worker_dials_only_the_data_endpoint_it_was_assigned() {
        let endpoint = refusing();
        let dialed = Arc::new(std::sync::Mutex::new(vec![]));
        let target = data_target(&endpoint, recording(dialed.clone()))
            .await
            .unwrap();
        assert_eq!(*dialed.lock().unwrap(), vec![endpoint.clone()]);
        assert_eq!(target.url(), format!("{endpoint}/"));
    }

    #[tokio::test]
    async fn an_unreachable_data_endpoint_fails_retryably_and_names_itself() {
        let endpoint = refusing();
        let target = data_target(&endpoint, recording(Arc::default()))
            .await
            .unwrap();
        let headers = crate::HostHeaders::new(1, 1);
        let mut clients =
            crate::worklet::registration::attempt_clients(&target.connect_lazy(), &headers);
        let status = clients
            .attempt
            .append_event(tonic::Request::new(Default::default()))
            .await
            .unwrap_err();
        // Retried exactly as an unreachable Control Plane is.
        assert!(crate::retryable(&status), "{status:?}");
        assert!(
            status
                .message()
                .starts_with(&format!("the data endpoint {endpoint} is unreachable: ")),
            "{status:?}"
        );
    }

    #[tokio::test]
    async fn an_unusable_data_endpoint_is_an_error_naming_it() {
        let failing: DataDialer = Box::new(|_| {
            Box::pin(async { Err(anyhow!("cleartext endpoint must use a loopback IP address")) })
        });
        let error = data_target("http://gateway.example:3434", failing)
            .await
            .unwrap_err();
        assert_eq!(
            format!("{error:#}"),
            "the data endpoint http://gateway.example:3434 is not usable: cleartext endpoint must use a loopback IP address"
        );
        let error = data_target("", recording(Arc::default()))
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "the Worklet assigned no data endpoint");
    }
}
