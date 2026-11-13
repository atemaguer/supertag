//! Private, Attempt-scoped transport to the remote Workspace provider helper.

use std::{
    ffi::OsString,
    fs::{self, DirBuilder, OpenOptions},
    future::Future,
    os::unix::{
        ffi::OsStrExt,
        fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    },
    path::{Component, Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use anyhow::{Context, Result, anyhow, ensure};
use prost::Message;
use sha2::{Digest, Sha256};
use supertag_protocol::{
    CHECKPOINT_CHUNK_BYTES, MAX_MESSAGE_BYTES, MAX_WORKSPACE_BLOB_BYTES, authenticated_request,
    v2::{remote_workspace_provider_client::RemoteWorkspaceProviderClient, *},
    valid_sha256,
};
use supertag_workspaces::TransferArtifact;
use tempfile::NamedTempFile;
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncSeekExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
    sync::mpsc,
    time::timeout,
};
use tokio_stream::wrappers::ReceiverStream;
use tokio_util::sync::CancellationToken;
use tonic::{
    Request,
    transport::{Channel, Endpoint},
};

const START_TIMEOUT: Duration = Duration::from_secs(10);
const ALLOCATE_TIMEOUT: Duration = Duration::from_secs(60);
/// A devcontainer image build, or the devcontainer's setup commands after staging.
const BUILD_TIMEOUT: Duration = Duration::from_secs(20 * 60);
const TRANSFER_TIMEOUT: Duration = Duration::from_secs(120);
const STOP_TIMEOUT: Duration = Duration::from_secs(30);
const REAP_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_ENDPOINT_BYTES: usize = 512;

/// Only explicit provider credentials enter the helper. Do not derive Debug:
/// configuration errors must never print the API key.
#[derive(Clone)]
pub struct ProviderConfig {
    pub executable: PathBuf,
    pub arguments: Vec<OsString>,
    pub authority: ProviderAuthority,
}

#[derive(Clone)]
pub enum ProviderAuthority {
    E2b {
        api_key: Option<String>,
        domain: Option<String>,
        template: Option<String>,
    },
    Modal {
        token_id: String,
        token_secret: String,
        endpoint: String,
        app: String,
        environment: String,
        image: Option<String>,
    },
}

impl ProviderConfig {
    /// The provider's name in operator-facing messages.
    pub(crate) fn label(&self) -> &'static str {
        match self.authority {
            ProviderAuthority::E2b { .. } => "E2B",
            ProviderAuthority::Modal { .. } => "Modal",
        }
    }

    /// A missing sandbox ID is meaningful only in the authority that allocated it.
    /// Bind that authority without retaining the provider credential in state.
    pub(crate) fn authority_fingerprint(&self) -> String {
        let mut hash = Sha256::new();
        hash.update(match &self.authority {
            ProviderAuthority::E2b { .. } => b"supertag-e2b-authority-v1\0".as_slice(),
            ProviderAuthority::Modal { .. } => b"supertag-modal-authority-v1\0".as_slice(),
        });
        let mut add = |value: &[u8]| {
            hash.update((value.len() as u64).to_be_bytes());
            hash.update(value);
        };
        match &self.authority {
            ProviderAuthority::E2b {
                domain, api_key, ..
            } => {
                add(domain
                    .as_deref()
                    .filter(|value| !value.is_empty())
                    .unwrap_or("e2b.app")
                    .as_bytes());
                add(api_key.as_deref().unwrap_or_default().as_bytes());
            }
            ProviderAuthority::Modal {
                token_id,
                token_secret,
                endpoint,
                app,
                environment,
                ..
            } => {
                for value in [endpoint, token_id, token_secret, app, environment] {
                    add(value.as_bytes());
                }
            }
        }
        add(self.executable.as_os_str().as_bytes());
        for arg in &self.arguments {
            add(arg.as_os_str().as_bytes());
        }
        format!("{:x}", hash.finalize())
    }

    fn configure_environment(&self, command: &mut Command) {
        match &self.authority {
            ProviderAuthority::E2b {
                api_key,
                domain,
                template,
            } => {
                for (name, value) in [
                    ("E2B_API_KEY", api_key),
                    ("E2B_DOMAIN", domain),
                    ("SUPERTAG_E2B_TEMPLATE", template),
                ] {
                    if let Some(value) = value {
                        command.env(name, value);
                    }
                }
            }
            ProviderAuthority::Modal {
                token_id,
                token_secret,
                endpoint,
                app,
                environment,
                image,
            } => {
                command.envs([
                    ("MODAL_TOKEN_ID", token_id.as_str()),
                    ("MODAL_TOKEN_SECRET", token_secret.as_str()),
                    ("MODAL_SERVER_URL", endpoint.as_str()),
                    ("SUPERTAG_MODAL_WORKSPACE_APP", app.as_str()),
                    ("SUPERTAG_MODAL_WORKSPACE_ENVIRONMENT", environment.as_str()),
                    ("MODAL_CONFIG_PATH", "/dev/null"),
                ]);
                if let Some(image) = image {
                    command.env("SUPERTAG_MODAL_WORKSPACE_IMAGE", image);
                }
            }
        }
    }
}

pub(crate) struct RemoteProvider {
    child: Option<Child>,
    channel: Channel,
    token: String,
}

impl RemoteProvider {
    pub async fn spawn(
        config: &ProviderConfig,
        scratch: &Path,
        cancel: &CancellationToken,
    ) -> Result<Self> {
        ensure!(!cancel.is_cancelled(), "provider startup cancelled");
        ensure!(
            config.executable.is_absolute(),
            "provider executable must be absolute"
        );
        let executable = config
            .executable
            .canonicalize()
            .context("provider executable unavailable")?;
        let metadata = executable.metadata()?;
        ensure!(
            metadata.is_file() && metadata.mode() & 0o111 != 0,
            "provider executable is not an executable file"
        );
        private_directory(scratch)?;
        let token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        let payload = RemoteWorkspaceProviderBootstrap {
            token: token.clone(),
        }
        .encode_to_vec();
        let mut command = Command::new(executable);
        command
            .args(&config.arguments)
            .current_dir(scratch)
            .env_clear()
            .env(
                "PATH",
                std::env::var_os("PATH").unwrap_or_else(|| "/usr/bin:/bin".into()),
            )
            .env("LANG", "C")
            .env("TMPDIR", scratch)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        config.configure_environment(&mut command);
        let mut child = command
            .spawn()
            .context("provider process could not start")?;
        let startup = bounded(START_TIMEOUT, cancel, async {
            let mut input = child
                .stdin
                .take()
                .context("provider bootstrap pipe missing")?;
            input.write_all(&payload).await?;
            input.shutdown().await?;
            drop(input);
            let stdout = child
                .stdout
                .take()
                .context("provider endpoint pipe missing")?;
            let mut reader = BufReader::new(stdout.take(MAX_ENDPOINT_BYTES as u64 + 1));
            let mut line = Vec::new();
            reader.read_until(b'\n', &mut line).await?;
            ensure!(
                line.len() <= MAX_ENDPOINT_BYTES && line.last() == Some(&b'\n'),
                "provider endpoint is missing or exceeds its limit"
            );
            let endpoint = parse_endpoint(&line[..line.len() - 1])?;
            Ok(Endpoint::from_shared(endpoint)?
                .connect_timeout(START_TIMEOUT)
                .connect()
                .await?)
        })
        .await;
        match startup {
            Ok(channel) => Ok(Self {
                child: Some(child),
                channel,
                token,
            }),
            Err(error) => {
                reap(&mut child)
                    .await
                    .context("failed provider startup could not be reaped")?;
                Err(error)
            }
        }
    }

    fn client(&self) -> RemoteWorkspaceProviderClient<Channel> {
        RemoteWorkspaceProviderClient::new(self.channel.clone())
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
    }

    fn request<T>(&self, message: T, deadline: Duration) -> Result<Request<T>> {
        let mut request = authenticated_request(message, &self.token, None)?;
        request.set_timeout(deadline);
        Ok(request)
    }

    pub async fn allocate(
        &self,
        owner: &RemoteWorkspaceOwner,
        lifetime: Duration,
        allowed_actions: &[String],
        environment: Option<RemoteWorkspaceEnvironment>,
        cancel: &CancellationToken,
    ) -> Result<String> {
        validate_owner(owner)?;
        let timeout_ms = u32::try_from(lifetime.as_millis())
            .context("sandbox lifetime exceeds provider range")?;
        ensure!(timeout_ms > 0, "sandbox lifetime must be positive");
        ensure!(
            allowed_actions.len() <= 64
                && allowed_actions
                    .iter()
                    .all(|action| matches!(action.as_str(), "files:read" | "files:write")),
            "remote provider supports only file actions"
        );
        // A devcontainer image is built before the sandbox starts.
        let deadline = if environment
            .as_ref()
            .is_some_and(|environment| !environment.dockerfile_commands.is_empty())
        {
            BUILD_TIMEOUT
        } else {
            ALLOCATE_TIMEOUT
        };
        bounded(deadline, cancel, async {
            let response = self
                .client()
                .allocate(self.request(
                    RemoteWorkspaceAllocateRequest {
                        owner: Some(owner.clone()),
                        timeout_ms,
                        allowed_actions: allowed_actions.to_vec(),
                        environment,
                    },
                    deadline,
                )?)
                .await?
                .into_inner();
            validate_sandbox_id(&response.sandbox_id)?;
            Ok(response.sandbox_id)
        })
        .await
    }

    pub async fn stage(
        &self,
        bundle: &TransferArtifact,
        start_commit: &str,
        inputs: &[(ArtifactInputFile, Vec<u8>)],
        mcp_commit: Option<&str>,
        setup: bool,
        cancel: &CancellationToken,
    ) -> Result<()> {
        ensure!(
            valid_commit(start_commit)
                && mcp_commit.is_none_or(|commit| {
                    valid_commit(commit) && commit.len() == start_commit.len()
                }),
            "invalid prepared commit"
        );
        validate_blob(bundle.byte_length, &bundle.sha256)?;
        let mut total = bundle.byte_length;
        for (input, bytes) in inputs {
            let blob = input
                .blob
                .as_ref()
                .context("Workspace input receipt is missing")?;
            ensure!(
                blob.byte_length == bytes.len() as u64
                    && format!("{:x}", Sha256::digest(bytes)) == blob.sha256,
                "Workspace input differs from its receipt"
            );
            total = total.saturating_add(blob.byte_length);
        }
        ensure!(
            total <= MAX_WORKSPACE_BLOB_BYTES as u64,
            "Workspace stage exceeds the transfer limit"
        );
        let manifest: Vec<_> = inputs.iter().map(|(file, _)| file.clone()).collect();
        // The devcontainer's setup commands run as the last step of staging.
        let deadline = if setup {
            BUILD_TIMEOUT
        } else {
            TRANSFER_TIMEOUT
        };
        bounded(deadline, cancel, async {
            let mut file = open_artifact(bundle).await?;
            let (sender, receiver) = mpsc::channel(2);
            let mut client = self.client();
            let request = self.request(ReceiverStream::new(receiver), deadline)?;
            let send = async {
                sender
                    .send(RemoteWorkspaceStageChunk {
                        part: Some(remote_workspace_stage_chunk::Part::Header(
                            RemoteWorkspaceStageHeader {
                                start_commit: start_commit.to_owned(),
                                bundle: Some(BlobReference {
                                    sha256: bundle.sha256.clone(),
                                    byte_length: bundle.byte_length,
                                }),
                                input_files: manifest.clone(),
                                mcp_commit: mcp_commit.map(str::to_owned),
                            },
                        )),
                    })
                    .await
                    .map_err(|_| anyhow!("provider closed workspace upload"))?;
                let mut buffer = vec![0; CHECKPOINT_CHUNK_BYTES];
                let mut length = 0_u64;
                let mut hash = Sha256::new();
                loop {
                    let size = file.read(&mut buffer).await?;
                    if size == 0 {
                        break;
                    }
                    length += size as u64;
                    ensure!(
                        length <= bundle.byte_length,
                        "workspace bundle grew during upload"
                    );
                    hash.update(&buffer[..size]);
                    sender
                        .send(RemoteWorkspaceStageChunk {
                            part: Some(remote_workspace_stage_chunk::Part::Payload(
                                buffer[..size].to_vec(),
                            )),
                        })
                        .await
                        .map_err(|_| anyhow!("provider closed workspace upload"))?;
                }
                ensure!(
                    length == bundle.byte_length
                        && format!("{:x}", hash.finalize()) == bundle.sha256,
                    "workspace bundle changed during upload"
                );
                for (_, bytes) in inputs {
                    for bytes in bytes.chunks(CHECKPOINT_CHUNK_BYTES) {
                        sender
                            .send(RemoteWorkspaceStageChunk {
                                part: Some(remote_workspace_stage_chunk::Part::Payload(
                                    bytes.to_vec(),
                                )),
                            })
                            .await
                            .map_err(|_| anyhow!("provider closed Workspace input upload"))?;
                    }
                }
                drop(sender);
                Ok::<(), anyhow::Error>(())
            };
            let receive = async {
                let receipt = client.stage(request).await?.into_inner();
                ensure!(
                    receipt.input_files == manifest,
                    "Workspace staging receipt differs from the accepted input files"
                );
                Ok::<(), anyhow::Error>(())
            };
            tokio::try_join!(send, receive)?;
            Ok(())
        })
        .await
    }

    pub async fn capture(
        &self,
        directory: &Path,
        cancel: &CancellationToken,
    ) -> Result<TransferArtifact> {
        private_directory(directory)?;
        bounded(TRANSFER_TIMEOUT, cancel, async {
            let mut stream = self
                .client()
                .capture(self.request(RemoteWorkspaceCaptureRequest {}, TRANSFER_TIMEOUT)?)
                .await?
                .into_inner();
            let reference = match stream.message().await?.and_then(|message| message.part) {
                Some(remote_workspace_capture_chunk::Part::Tree(reference)) => reference,
                _ => anyhow::bail!("workspace capture requires its opening receipt"),
            };
            validate_blob(reference.byte_length, &reference.sha256)?;
            let temporary = NamedTempFile::new_in(directory)?;
            let mut file = tokio::fs::File::from_std(temporary.as_file().try_clone()?);
            let mut length = 0_u64;
            let mut hash = Sha256::new();
            while let Some(message) = stream.message().await? {
                let Some(remote_workspace_capture_chunk::Part::Payload(bytes)) = message.part
                else {
                    anyhow::bail!("unexpected workspace capture record");
                };
                ensure!(
                    !bytes.is_empty() && bytes.len() <= CHECKPOINT_CHUNK_BYTES,
                    "invalid workspace capture chunk"
                );
                length += bytes.len() as u64;
                ensure!(
                    length <= reference.byte_length,
                    "workspace capture exceeds its receipt"
                );
                hash.update(&bytes);
                file.write_all(&bytes).await?;
            }
            ensure!(
                length == reference.byte_length
                    && format!("{:x}", hash.finalize()) == reference.sha256,
                "workspace capture differs from its receipt"
            );
            file.flush().await?;
            file.sync_all().await?;
            drop(file);
            let (_, path) = temporary.keep()?;
            if let Err(error) = fs::File::open(directory).and_then(|directory| directory.sync_all())
            {
                let _ = fs::remove_file(&path);
                return Err(error.into());
            }
            Ok(TransferArtifact {
                path,
                sha256: reference.sha256,
                byte_length: reference.byte_length,
            })
        })
        .await
    }

    pub async fn stop(
        &self,
        owner: &RemoteWorkspaceOwner,
        sandbox_id: Option<&str>,
        cancel: &CancellationToken,
    ) -> Result<Option<String>> {
        validate_owner(owner)?;
        if let Some(id) = sandbox_id {
            validate_sandbox_id(id)?;
        }
        bounded(STOP_TIMEOUT, cancel, async {
            let response = self
                .client()
                .stop(self.request(
                    RemoteWorkspaceStopRequest {
                        owner: Some(owner.clone()),
                        sandbox_id: sandbox_id.map(str::to_owned),
                    },
                    STOP_TIMEOUT,
                )?)
                .await?
                .into_inner();
            if let Some(stopped) = &response.stopped_sandbox_id {
                validate_sandbox_id(stopped)?;
                ensure!(
                    sandbox_id.is_none_or(|expected| expected == stopped),
                    "provider stopped proof names another sandbox"
                );
            }
            Ok(response.stopped_sandbox_id)
        })
        .await
    }

    /// The Host uses this connection for its authenticated HarnessWorkspace proxy.
    /// Never hand the provider bearer to the native Harness or its workspace.
    pub fn workspace_connection(&self) -> (Channel, String) {
        (self.channel.clone(), self.token.clone())
    }

    /// The Host's private connection for Workspace stdio MCP servers in the staged sandbox.
    pub(crate) fn mcp_connection(&self) -> crate::mcp::SandboxConnection {
        crate::mcp::SandboxConnection {
            channel: self.channel.clone(),
            token: self.token.clone(),
        }
    }

    /// Reaping the helper is not proof that any remote sandbox has stopped.
    pub async fn shutdown(&mut self) -> Result<()> {
        if let Some(mut child) = self.child.take() {
            reap(&mut child).await?;
        }
        Ok(())
    }
}

impl Drop for RemoteProvider {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.start_kill();
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn(async move {
                    let _ = timeout(REAP_TIMEOUT, child.wait()).await;
                });
            }
            // Child.kill_on_drop remains enabled if no runtime can reap it here.
        }
    }
}

async fn reap(child: &mut Child) -> Result<()> {
    if child.try_wait()?.is_none() {
        child.start_kill()?;
    }
    timeout(REAP_TIMEOUT, child.wait())
        .await
        .context("provider reap deadline expired")??;
    Ok(())
}

async fn bounded<T>(
    deadline: Duration,
    cancel: &CancellationToken,
    operation: impl Future<Output = Result<T>>,
) -> Result<T> {
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(anyhow!("remote provider operation cancelled")),
        result = timeout(deadline, operation) => result.context("remote provider operation deadline expired")?,
    }
}

fn parse_endpoint(bytes: &[u8]) -> Result<String> {
    let endpoint = std::str::from_utf8(bytes).context("provider endpoint is not UTF-8")?;
    let address: std::net::SocketAddr = endpoint
        .strip_prefix("http://")
        .context("provider endpoint must use loopback HTTP")?
        .parse()
        .context("provider endpoint must name a literal address")?;
    ensure!(
        address.ip().is_loopback()
            && address.port() != 0
            && endpoint == format!("http://{address}"),
        "provider endpoint must be a literal loopback address"
    );
    Ok(endpoint.to_owned())
}

fn valid_commit(commit: &str) -> bool {
    matches!(commit.len(), 40 | 64)
        && commit
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn validate_owner(owner: &RemoteWorkspaceOwner) -> Result<()> {
    ensure!(
        owner.host_generation > 0
            && [
                &owner.host_id,
                &owner.task_id,
                &owner.attempt_id,
                &owner.allocation_id
            ]
            .iter()
            .all(|value| !value.is_empty()
                && value.len() <= 256
                && !value.chars().any(char::is_control)),
        "invalid remote workspace owner"
    );
    Ok(())
}
fn validate_sandbox_id(id: &str) -> Result<()> {
    ensure!(
        crate::journal::valid_sandbox_id(id),
        "invalid provider sandbox identity"
    );
    Ok(())
}
fn validate_blob(length: u64, digest: &str) -> Result<()> {
    ensure!(
        length > 0 && length <= MAX_WORKSPACE_BLOB_BYTES as u64 && valid_sha256(digest),
        "invalid workspace transfer receipt"
    );
    Ok(())
}

fn real_directory(path: &Path) -> Result<()> {
    ensure!(path.is_absolute(), "provider storage must be absolute");
    let mut current = PathBuf::new();
    for component in path.components() {
        ensure!(
            !matches!(component, Component::ParentDir),
            "provider storage has parent traversal"
        );
        current.push(component);
        let metadata = fs::symlink_metadata(&current)?;
        ensure!(
            metadata.is_dir() && !metadata.file_type().is_symlink(),
            "provider storage is not a real directory"
        );
    }
    Ok(())
}

fn private_directory(path: &Path) -> Result<()> {
    let parent = path.parent().context("provider storage has no parent")?;
    real_directory(parent)?;
    match fs::symlink_metadata(path) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            DirBuilder::new().mode(0o700).create(path)?
        }
        Err(error) => return Err(error.into()),
    }
    real_directory(path)?;
    let metadata = fs::symlink_metadata(path)?;
    ensure!(
        metadata.mode() & 0o077 == 0 && metadata.uid() == unsafe { libc::geteuid() },
        "provider storage is not privately owned"
    );
    Ok(())
}

async fn open_artifact(artifact: &TransferArtifact) -> Result<tokio::fs::File> {
    real_directory(
        artifact
            .path
            .parent()
            .context("workspace bundle has no parent")?,
    )?;
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(&artifact.path)?;
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file() && metadata.nlink() == 1 && metadata.len() == artifact.byte_length,
        "workspace bundle is not an exact regular file"
    );
    let mut file = tokio::fs::File::from_std(file);
    let mut hash = Sha256::new();
    let mut length = 0_u64;
    let mut buffer = vec![0; CHECKPOINT_CHUNK_BYTES];
    loop {
        let size = file.read(&mut buffer).await?;
        if size == 0 {
            break;
        }
        length += size as u64;
        ensure!(
            length <= artifact.byte_length,
            "workspace bundle exceeds receipt"
        );
        hash.update(&buffer[..size]);
    }
    ensure!(
        length == artifact.byte_length && format!("{:x}", hash.finalize()) == artifact.sha256,
        "workspace bundle differs from receipt"
    );
    file.rewind().await?;
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_authority_binds_credentials_endpoint_and_helper() {
        let original = ProviderConfig {
            executable: "/fixture/provider".into(),
            arguments: vec!["fixture".into()],
            authority: ProviderAuthority::E2b {
                api_key: Some("first-test-key".into()),
                domain: None,
                template: None,
            },
        };
        let scope = original.authority_fingerprint();
        assert!(valid_sha256(&scope));
        let mut changed = original.clone();
        if let ProviderAuthority::E2b { domain, .. } = &mut changed.authority {
            *domain = Some("e2b.app".into());
        }
        assert_eq!(changed.authority_fingerprint(), scope);
        if let ProviderAuthority::E2b { domain, .. } = &mut changed.authority {
            *domain = Some("fixture.e2b.invalid".into());
        }
        assert_ne!(changed.authority_fingerprint(), scope);
        let mut changed = original.clone();
        if let ProviderAuthority::E2b { api_key, .. } = &mut changed.authority {
            *api_key = Some("second-test-key".into());
        }
        assert_ne!(changed.authority_fingerprint(), scope);
        let mut changed = original;
        changed.arguments.push("different-helper".into());
        assert_ne!(changed.authority_fingerprint(), scope);
    }

    #[test]
    fn modal_provider_scope_and_environment_are_explicit() {
        let config = ProviderConfig {
            executable: "/fixture/provider".into(),
            arguments: vec![],
            authority: ProviderAuthority::Modal {
                token_id: "fixture-token-id".into(),
                token_secret: "fixture-secret".into(),
                endpoint: "https://api.modal.com:443".into(),
                app: "fixture-app".into(),
                environment: "main".into(),
                image: None,
            },
        };
        let scope = config.authority_fingerprint();
        let mut changed = config.clone();
        if let ProviderAuthority::Modal { environment, .. } = &mut changed.authority {
            *environment = "staging".into();
        }
        assert_ne!(changed.authority_fingerprint(), scope);
        let mut changed = config.clone();
        if let ProviderAuthority::Modal { image, .. } = &mut changed.authority {
            *image = Some("changed-image".into());
        }
        assert_eq!(changed.authority_fingerprint(), scope);
        let mut command = Command::new(&config.executable);
        config.configure_environment(&mut command);
        let environment = command
            .as_std()
            .get_envs()
            .collect::<std::collections::BTreeMap<_, _>>();
        assert_eq!(
            environment.get(std::ffi::OsStr::new("MODAL_CONFIG_PATH")),
            Some(&Some(std::ffi::OsStr::new("/dev/null")))
        );
        assert_eq!(
            environment.get(std::ffi::OsStr::new("MODAL_TOKEN_SECRET")),
            Some(&Some(std::ffi::OsStr::new("fixture-secret")))
        );
        assert!(!environment.contains_key(std::ffi::OsStr::new("E2B_API_KEY")));
    }
    use std::os::unix::fs::PermissionsExt;
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicU8, Ordering},
    };
    use supertag_protocol::{
        matches_bearer,
        v2::{
            harness_workspace_client::HarnessWorkspaceClient,
            harness_workspace_server::{HarnessWorkspace, HarnessWorkspaceServer},
            remote_workspace_provider_server::{
                RemoteWorkspaceProvider, RemoteWorkspaceProviderServer,
            },
        },
    };
    use tokio_stream::wrappers::{ReceiverStream, TcpListenerStream};
    use tonic::{Response, Status, Streaming, transport::Server};

    #[derive(Clone)]
    struct Mock {
        bootstrap: PathBuf,
        mode: Arc<AtomicU8>,
        staged: Arc<Mutex<Vec<u8>>>,
        mcp_commit: Arc<Mutex<Option<String>>>,
        environment: Arc<Mutex<Option<RemoteWorkspaceEnvironment>>>,
        /// Each sandbox MCP start record, and whether its input ended.
        mcp: Arc<Mutex<Vec<(RemoteMcpServerStart, bool)>>>,
    }
    impl Mock {
        fn authorize<T>(&self, request: &Request<T>) -> Result<(), Status> {
            let bytes = std::fs::read(&self.bootstrap)
                .map_err(|_| Status::unauthenticated("missing bootstrap"))?;
            let bootstrap = RemoteWorkspaceProviderBootstrap::decode(bytes.as_slice())
                .map_err(|_| Status::unauthenticated("bad bootstrap"))?;
            if !matches_bearer(request, &bootstrap.token) {
                return Err(Status::unauthenticated("wrong bearer"));
            }
            Ok(())
        }
    }
    #[tonic::async_trait]
    impl RemoteWorkspaceProvider for Mock {
        async fn allocate(
            &self,
            request: Request<RemoteWorkspaceAllocateRequest>,
        ) -> Result<Response<RemoteWorkspaceAllocation>, Status> {
            self.authorize(&request)?;
            assert_eq!(
                request.get_ref().owner.as_ref().unwrap().allocation_id,
                "allocation"
            );
            *self.environment.lock().unwrap() = request.get_ref().environment.clone();
            Ok(Response::new(RemoteWorkspaceAllocation {
                sandbox_id: "sandbox-fixture".into(),
            }))
        }
        async fn stage(
            &self,
            request: Request<Streaming<RemoteWorkspaceStageChunk>>,
        ) -> Result<Response<RemoteWorkspaceStageResponse>, Status> {
            self.authorize(&request)?;
            let mut stream = request.into_inner();
            let Some(remote_workspace_stage_chunk::Part::Header(header)) =
                stream.message().await?.and_then(|chunk| chunk.part)
            else {
                return Err(Status::invalid_argument("missing header"));
            };
            let reference = header.bundle.unwrap();
            *self.mcp_commit.lock().unwrap() = header.mcp_commit;
            let mut bytes = Vec::new();
            while let Some(message) = stream.message().await? {
                let Some(remote_workspace_stage_chunk::Part::Payload(chunk)) = message.part else {
                    return Err(Status::invalid_argument("unexpected header"));
                };
                assert!(chunk.len() <= CHECKPOINT_CHUNK_BYTES);
                bytes.extend(chunk);
            }
            assert_eq!(bytes.len() as u64, reference.byte_length);
            assert_eq!(format!("{:x}", Sha256::digest(&bytes)), reference.sha256);
            *self.staged.lock().unwrap() = bytes;
            Ok(Response::new(RemoteWorkspaceStageResponse::default()))
        }
        type CaptureStream = ReceiverStream<Result<RemoteWorkspaceCaptureChunk, Status>>;
        async fn capture(
            &self,
            request: Request<RemoteWorkspaceCaptureRequest>,
        ) -> Result<Response<Self::CaptureStream>, Status> {
            self.authorize(&request)?;
            let body = b"STWTREE1\nreturned fixture".to_vec();
            let mode = self.mode.load(Ordering::SeqCst);
            let mut reference = BlobReference {
                sha256: format!("{:x}", Sha256::digest(&body)),
                byte_length: body.len() as u64,
            };
            if mode == 1 {
                reference.sha256 = "0".repeat(64);
            }
            if mode == 5 {
                reference.byte_length = MAX_WORKSPACE_BLOB_BYTES as u64 + 1;
            }
            let (sender, receiver) = tokio::sync::mpsc::channel(4);
            let header = RemoteWorkspaceCaptureChunk {
                part: Some(remote_workspace_capture_chunk::Part::Tree(reference)),
            };
            if mode != 3 {
                sender.send(Ok(header.clone())).await.unwrap();
            }
            if mode == 4 {
                sender.send(Ok(header)).await.unwrap();
            }
            sender
                .send(Ok(RemoteWorkspaceCaptureChunk {
                    part: Some(remote_workspace_capture_chunk::Part::Payload(
                        if mode == 6 {
                            vec![0; CHECKPOINT_CHUNK_BYTES + 1]
                        } else {
                            body
                        },
                    )),
                }))
                .await
                .unwrap();
            if mode == 2 {
                sender
                    .send(Ok(RemoteWorkspaceCaptureChunk {
                        part: Some(remote_workspace_capture_chunk::Part::Payload(vec![1])),
                    }))
                    .await
                    .unwrap();
            }
            drop(sender);
            Ok(Response::new(ReceiverStream::new(receiver)))
        }
        async fn stop(
            &self,
            request: Request<RemoteWorkspaceStopRequest>,
        ) -> Result<Response<RemoteWorkspaceStopResponse>, Status> {
            self.authorize(&request)?;
            match self.mode.load(Ordering::SeqCst) {
                9 => Err(Status::unavailable("fixture connection lost")),
                mode => Ok(Response::new(RemoteWorkspaceStopResponse {
                    stopped_sandbox_id: match mode {
                        7 => None,
                        8 => Some("different-sandbox".into()),
                        _ => Some("sandbox-fixture".into()),
                    },
                })),
            }
        }
        type RunMcpServerStream = ReceiverStream<Result<RemoteMcpServerOutput, Status>>;
        /// A line-oriented MCP server that answers from inside the fixture "sandbox".
        async fn run_mcp_server(
            &self,
            request: Request<Streaming<RemoteMcpServerInput>>,
        ) -> Result<Response<Self::RunMcpServerStream>, Status> {
            self.authorize(&request)?;
            let mut input = request.into_inner();
            let Some(remote_mcp_server_input::Part::Start(start)) =
                input.message().await?.and_then(|message| message.part)
            else {
                return Err(Status::invalid_argument("missing start"));
            };
            let index = {
                let mut started = self.mcp.lock().unwrap();
                started.push((start.clone(), false));
                started.len() - 1
            };
            let record = self.mcp.clone();
            let (sender, receiver) = tokio::sync::mpsc::channel(4);
            tokio::spawn(async move {
                let mut pending = Vec::new();
                while let Ok(Some(message)) = input.message().await {
                    let Some(remote_mcp_server_input::Part::Stdin(bytes)) = message.part else {
                        return;
                    };
                    pending.extend(bytes);
                    while let Some(end) = pending.iter().position(|byte| *byte == b'\n') {
                        let line: Vec<u8> = pending.drain(..=end).collect();
                        let message: serde_json::Value = serde_json::from_slice(&line).unwrap();
                        let Some(id) = message.get("id").cloned() else {
                            continue;
                        };
                        let result = match message["method"].as_str().unwrap() {
                            "initialize" => serde_json::json!({
                                "protocolVersion": "2025-06-18",
                                "capabilities": {"tools": {}},
                                "serverInfo": {"name": "sandbox", "version": "1"}
                            }),
                            "tools/list" => serde_json::json!({"tools": [
                                {"name": "read_marker", "inputSchema": {"type": "object"}}
                            ]}),
                            _ => serde_json::json!({"content": [
                                {"type": "text", "text": format!("sandbox:{}", start.command)}
                            ]}),
                        };
                        let mut reply = serde_json::to_vec(
                            &serde_json::json!({"jsonrpc": "2.0", "id": id, "result": result}),
                        )
                        .unwrap();
                        reply.push(b'\n');
                        // Split one reply across two frames, as a process pipe may.
                        let tail = reply.split_off(reply.len() / 2);
                        for stdout in [reply, tail] {
                            if sender
                                .send(Ok(RemoteMcpServerOutput { stdout }))
                                .await
                                .is_err()
                            {
                                return;
                            }
                        }
                    }
                }
                record.lock().unwrap()[index].1 = true;
            });
            Ok(Response::new(ReceiverStream::new(receiver)))
        }
    }
    #[tonic::async_trait]
    impl HarnessWorkspace for Mock {
        async fn execute(
            &self,
            request: Request<HarnessWorkspaceRequest>,
        ) -> Result<Response<HarnessWorkspaceResult>, Status> {
            self.authorize(&request)?;
            Ok(Response::new(HarnessWorkspaceResult {
                text: "remote fixture".into(),
                is_error: false,
            }))
        }
    }
    fn owner() -> RemoteWorkspaceOwner {
        RemoteWorkspaceOwner {
            host_id: "host".into(),
            host_generation: 2,
            task_id: "task".into(),
            attempt_id: "attempt".into(),
            allocation_id: "allocation".into(),
        }
    }
    fn config(endpoint: &str, directory: &Path) -> ProviderConfig {
        ProviderConfig {
            executable: "/bin/sh".into(),
            arguments: vec!["-c".into(), "printf '%s' $$ > \"$2/pid\"; /usr/bin/env > \"$2/env\"; /bin/cat > \"$2/bootstrap\"; printf '%s\\n' \"$1\"; exec /bin/sleep 600".into(), "fixture".into(), endpoint.into(), directory.as_os_str().to_owned()],
            authority: ProviderAuthority::E2b {
                api_key: Some("synthetic-e2b-key".into()),
                domain: Some("fixture.invalid".into()),
                template: Some("fixture-template".into()),
            },
        }
    }
    async fn fixture() -> (tempfile::TempDir, RemoteProvider, Mock, CancellationToken) {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().canonicalize().unwrap();
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let mock = Mock {
            bootstrap: directory.join("bootstrap"),
            mode: Arc::new(AtomicU8::new(0)),
            staged: Arc::new(Mutex::new(Vec::new())),
            mcp_commit: Arc::default(),
            environment: Arc::default(),
            mcp: Arc::default(),
        };
        let shutdown = CancellationToken::new();
        let stopped = shutdown.clone();
        let service = mock.clone();
        tokio::spawn(async move {
            Server::builder()
                .add_service(RemoteWorkspaceProviderServer::new(service.clone()))
                .add_service(HarnessWorkspaceServer::new(service))
                .serve_with_incoming_shutdown(TcpListenerStream::new(listener), stopped.cancelled())
                .await
                .unwrap();
        });
        let provider = RemoteProvider::spawn(
            &config(&endpoint, &directory),
            &directory,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
        (root, provider, mock, shutdown)
    }

    #[tokio::test]
    async fn private_process_bootstrap_streams_verified_files_and_shares_scoped_channel() {
        let (root, mut provider, mock, shutdown) = fixture().await;
        let directory = root.path().canonicalize().unwrap();
        let env = std::fs::read_to_string(directory.join("env")).unwrap();
        for line in env.lines() {
            let key = line.split_once('=').unwrap().0;
            assert!(
                matches!(
                    key,
                    "PATH"
                        | "LANG"
                        | "TMPDIR"
                        | "E2B_API_KEY"
                        | "E2B_DOMAIN"
                        | "SUPERTAG_E2B_TEMPLATE"
                        | "PWD"
                        | "SHLVL"
                        | "_"
                ),
                "unexpected inherited variable {key}"
            );
        }
        assert!(env.contains("E2B_API_KEY=synthetic-e2b-key"));
        let environment = RemoteWorkspaceEnvironment {
            image: Some("python:3.13-slim".into()),
            dockerfile_commands: vec!["USER nobody".into()],
            user: Some("nobody".into()),
            setup_commands: vec!["sh -c 'true'".into()],
        };
        assert_eq!(
            provider
                .allocate(
                    &owner(),
                    Duration::from_secs(60),
                    &["files:read".into(), "files:write".into()],
                    Some(environment.clone()),
                    &CancellationToken::new()
                )
                .await
                .unwrap(),
            "sandbox-fixture"
        );
        // The devcontainer translation reaches the provider only over the private channel.
        assert_eq!(*mock.environment.lock().unwrap(), Some(environment));
        let bytes = vec![b'x'; CHECKPOINT_CHUNK_BYTES * 2 + 7];
        let bundle = TransferArtifact {
            path: directory.join("source.bundle"),
            sha256: format!("{:x}", Sha256::digest(&bytes)),
            byte_length: bytes.len() as u64,
        };
        std::fs::write(&bundle.path, &bytes).unwrap();
        // A trusted copy commit must have the start commit's object format.
        assert!(
            provider
                .stage(
                    &bundle,
                    &"a".repeat(40),
                    &[],
                    Some(&"b".repeat(64)),
                    false,
                    &CancellationToken::new()
                )
                .await
                .is_err()
        );
        provider
            .stage(
                &bundle,
                &"a".repeat(40),
                &[],
                Some(&"b".repeat(40)),
                true,
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(*mock.staged.lock().unwrap(), bytes);
        assert_eq!(
            mock.mcp_commit.lock().unwrap().as_deref(),
            Some("b".repeat(40).as_str())
        );
        // A Workspace stdio server runs over the same private channel, framed by lines.
        let replies = crate::mcp::sandbox_round_trip(
            &provider.mcp_connection(),
            "tools",
            &["node".into(), "mcp-server.js".into()],
        )
        .await
        .unwrap();
        assert_eq!(replies, ["read_marker", "sandbox:node"]);
        let started = mock.mcp.lock().unwrap().clone();
        assert_eq!(started.len(), 1);
        assert_eq!(started[0].0.name, "tools");
        assert_eq!(started[0].0.command, "node");
        assert_eq!(started[0].0.args, ["mcp-server.js"]);
        assert!(started[0].1, "closing the session ends the server's input");
        let captured = provider
            .capture(&directory, &CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(
            std::fs::read(&captured.path).unwrap(),
            b"STWTREE1\nreturned fixture"
        );
        assert_eq!(
            std::fs::metadata(&captured.path).unwrap().mode() & 0o777,
            0o600
        );
        let (channel, token) = provider.workspace_connection();
        let mut tools = HarnessWorkspaceClient::new(channel);
        assert_eq!(
            tools
                .execute(
                    authenticated_request(
                        HarnessWorkspaceRequest { operation: None },
                        &token,
                        None
                    )
                    .unwrap()
                )
                .await
                .unwrap()
                .into_inner()
                .text,
            "remote fixture"
        );
        assert!(
            tools
                .execute(
                    authenticated_request(
                        HarnessWorkspaceRequest { operation: None },
                        "wrong",
                        None
                    )
                    .unwrap()
                )
                .await
                .is_err()
        );
        assert_eq!(
            provider
                .stop(&owner(), Some("sandbox-fixture"), &CancellationToken::new())
                .await
                .unwrap(),
            Some("sandbox-fixture".into())
        );
        provider.shutdown().await.unwrap();
        assert!(captured.path.is_file(), "capture must outlive the helper");
        let pid: i32 = std::fs::read_to_string(directory.join("pid"))
            .unwrap()
            .parse()
            .unwrap();
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1, "helper must be reaped");
        shutdown.cancel();
    }

    #[tokio::test]
    async fn rejects_corrupt_streams_and_does_not_turn_failed_stop_into_cleanup_proof() {
        let (root, mut provider, mock, shutdown) = fixture().await;
        let directory = root.path().canonicalize().unwrap().join("captures");
        private_directory(&directory).unwrap();
        for mode in 1..=6 {
            mock.mode.store(mode, Ordering::SeqCst);
            assert!(
                provider
                    .capture(&directory, &CancellationToken::new())
                    .await
                    .is_err(),
                "mode {mode}"
            );
            assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 0);
        }
        mock.mode.store(7, Ordering::SeqCst);
        assert_eq!(
            provider
                .stop(&owner(), Some("sandbox-fixture"), &CancellationToken::new())
                .await
                .unwrap(),
            None
        );
        for mode in 8..=9 {
            mock.mode.store(mode, Ordering::SeqCst);
            assert!(
                provider
                    .stop(&owner(), Some("sandbox-fixture"), &CancellationToken::new())
                    .await
                    .is_err()
            );
        }
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert!(provider.capture(&directory, &cancel).await.is_err());
        assert!(
            provider
                .allocate(
                    &owner(),
                    Duration::from_secs(60),
                    &["commands:execute".into()],
                    None,
                    &CancellationToken::new()
                )
                .await
                .is_err()
        );
        provider.shutdown().await.unwrap();
        shutdown.cancel();
    }

    #[tokio::test]
    async fn refuses_nonliteral_or_oversized_endpoint_and_reaps_startup_child() {
        for endpoint in [
            "http://localhost:1234",
            "http://192.0.2.1:1234",
            "http://127.0.0.1:1234/path",
            &"x".repeat(513),
        ] {
            let root = tempfile::tempdir().unwrap();
            let directory = root.path().canonicalize().unwrap();
            std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
            assert!(
                RemoteProvider::spawn(
                    &config(endpoint, &directory),
                    &directory,
                    &CancellationToken::new()
                )
                .await
                .is_err()
            );
            let pid: i32 = std::fs::read_to_string(directory.join("pid"))
                .unwrap()
                .parse()
                .unwrap();
            assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
        }
    }

    async fn await_pid(path: &Path) -> i32 {
        timeout(Duration::from_secs(2), async {
            loop {
                if let Ok(text) = tokio::fs::read_to_string(path).await
                    && let Ok(pid) = text.parse()
                {
                    return pid;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn startup_cancellation_and_drop_reap_the_owned_helper() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().canonicalize().unwrap();
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut configuration = config("unused", &directory);
        configuration.arguments[1] =
            "printf '%s' $$ > \"$2/pid\"; /bin/cat > \"$2/bootstrap\"; exec /bin/sleep 600".into();
        let cancel = CancellationToken::new();
        let startup = RemoteProvider::spawn(&configuration, &directory, &cancel);
        let cancellation = async {
            let pid = await_pid(&directory.join("pid")).await;
            cancel.cancel();
            pid
        };
        let (result, pid) = tokio::join!(startup, cancellation);
        assert!(result.is_err());
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1);

        let (root, provider, _, shutdown) = fixture().await;
        let pid = await_pid(&root.path().join("pid")).await;
        drop(provider);
        timeout(REAP_TIMEOUT, async {
            while unsafe { libc::kill(pid, 0) } == 0 {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        shutdown.cancel();
    }

    #[tokio::test]
    async fn invalid_local_bundle_is_rejected_before_any_upload() {
        let (root, mut provider, mock, shutdown) = fixture().await;
        let directory = root.path().canonicalize().unwrap();
        let mut artifact = TransferArtifact {
            path: directory.join("bundle"),
            sha256: "0".repeat(64),
            byte_length: 7,
        };
        std::fs::write(&artifact.path, "fixture").unwrap();
        assert!(
            provider
                .stage(
                    &artifact,
                    &"a".repeat(40),
                    &[],
                    None,
                    false,
                    &CancellationToken::new()
                )
                .await
                .is_err()
        );
        assert!(mock.staged.lock().unwrap().is_empty());
        artifact.sha256 = format!("{:x}", Sha256::digest(b"fixture"));
        let link = directory.join("bundle-link");
        std::os::unix::fs::symlink(&artifact.path, &link).unwrap();
        artifact.path = link;
        assert!(
            provider
                .stage(
                    &artifact,
                    &"a".repeat(40),
                    &[],
                    None,
                    false,
                    &CancellationToken::new()
                )
                .await
                .is_err()
        );
        assert!(mock.staged.lock().unwrap().is_empty());
        provider.shutdown().await.unwrap();
        shutdown.cancel();
    }
}
