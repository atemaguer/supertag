//! Codex's exec-server for a Codex Attempt on a remote Workspace.
//!
//! Codex's app-server runs on this host with its keys; every command and file operation it makes
//! runs in the Attempt's sandbox, through `codex exec-server --listen stdio` there. The app-server
//! starts its executor as a program from its `environments.toml`: `supertag __codex-exec-bridge`,
//! which connects to this Attempt's socket and carries bytes only. Each connection here opens one
//! `RemoteWorkspaceProvider.RunStdioServer` call with the Codex kind and pipes the connection
//! through it. The socket lives in a private directory only this user can enter, and goes with
//! the bridge when the Attempt ends.
use std::{
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    sync::Arc,
};

use anyhow::{Context, Result, ensure};
use supertag_protocol::{
    MAX_MESSAGE_BYTES, authenticated_request,
    v2::{
        RemoteCodexExecServerStart, RemoteStdioServerInput, RemoteStdioServerStart,
        remote_stdio_server_input, remote_stdio_server_start,
        remote_workspace_provider_client::RemoteWorkspaceProviderClient,
    },
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{UnixListener, UnixStream},
    sync::{Semaphore, mpsc},
    task::JoinHandle,
};
use tokio_stream::wrappers::ReceiverStream;

use crate::adapter::workspace::SandboxSource;

/// The bytes one stdin message carries to the sandbox.
const CHUNK_BYTES: usize = 64 * 1024;
/// Codex opens one executor connection and reopens it after a failure; a few at once suffice.
const MAX_CONNECTIONS: usize = 4;
/// The socket's file name in the bridge's private directory.
const SOCKET: &str = "exec.sock";

/// One Attempt's executor socket.
pub(crate) struct CodexExecBridge {
    directory: tempfile::TempDir,
    accepting: JoinHandle<()>,
}

impl CodexExecBridge {
    /// Binds the socket in a new private directory. A connection waits until `sandbox` is staged,
    /// and fails when it could not be.
    pub(crate) fn bind(sandbox: SandboxSource) -> Result<Self> {
        // A short temporary path: a Unix socket's path is limited to about 100 bytes.
        let directory = tempfile::Builder::new()
            .prefix("supertag-codex-")
            .tempdir()
            .context("create the Codex executor directory")?;
        std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700))?;
        let path = directory.path().join(SOCKET);
        let listener = UnixListener::bind(&path).context("bind the Codex executor socket")?;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
        let accepting = tokio::spawn(accept(listener, sandbox));
        Ok(Self {
            directory,
            accepting,
        })
    }

    /// The socket `supertag __codex-exec-bridge` connects to.
    pub(crate) fn socket(&self) -> PathBuf {
        self.directory.path().join(SOCKET)
    }
}

impl Drop for CodexExecBridge {
    fn drop(&mut self) {
        // Ends every connection's pipe; the directory and socket are removed with `directory`.
        self.accepting.abort();
    }
}

async fn accept(listener: UnixListener, sandbox: SandboxSource) {
    let slots = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    let mut connections = tokio::task::JoinSet::new();
    loop {
        let Ok((stream, _)) = listener.accept().await else {
            return;
        };
        // Only this user can reach the private directory; check the peer anyway.
        if !same_user(&stream) {
            continue;
        }
        let Ok(slot) = slots.clone().try_acquire_owned() else {
            continue;
        };
        let sandbox = sandbox.clone();
        connections.spawn(async move {
            let _slot = slot;
            if let Err(error) = serve(stream, sandbox).await {
                tracing::debug!("Codex executor connection ended: {error:#}");
            }
        });
    }
}

fn same_user(stream: &UnixStream) -> bool {
    stream
        .peer_cred()
        .is_ok_and(|peer| peer.uid() == unsafe { libc::geteuid() })
}

/// Pipes one connection through one exec-server in the current sandbox, until either side ends.
async fn serve(stream: UnixStream, mut sandbox: SandboxSource) -> Result<()> {
    let (channel, token) = sandbox
        .wait_for(Option::is_some)
        .await
        .context("the Attempt ended before its sandbox was staged")?
        .clone()
        .context("no sandbox")?
        .map_err(anyhow::Error::msg)?;
    let (sender, receiver) = mpsc::channel(4);
    sender
        .send(RemoteStdioServerInput {
            part: Some(remote_stdio_server_input::Part::Start(
                RemoteStdioServerStart {
                    server: Some(remote_stdio_server_start::Server::CodexExecServer(
                        RemoteCodexExecServerStart {},
                    )),
                },
            )),
        })
        .await?;
    let request: tonic::Request<ReceiverStream<RemoteStdioServerInput>> =
        authenticated_request(ReceiverStream::new(receiver), &token, None)?;
    let mut client = RemoteWorkspaceProviderClient::new(channel)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
        .max_decoding_message_size(MAX_MESSAGE_BYTES);
    let (mut reader, mut writer) = stream.into_split();
    let forward_input = async move {
        let mut buffer = vec![0; CHUNK_BYTES];
        loop {
            let size = reader.read(&mut buffer).await?;
            if size == 0 {
                return Ok::<_, anyhow::Error>(());
            }
            let chunk = RemoteStdioServerInput {
                part: Some(remote_stdio_server_input::Part::Stdin(
                    buffer[..size].to_vec(),
                )),
            };
            if sender.send(chunk).await.is_err() {
                return Ok(());
            }
        }
    };
    let forward_output = async move {
        let mut output = client.run_stdio_server(request).await?.into_inner();
        while let Some(message) = output.message().await? {
            ensure!(
                message.stdout.len() <= MAX_MESSAGE_BYTES,
                "exec-server output exceeds its limit"
            );
            writer.write_all(&message.stdout).await?;
        }
        Ok::<_, anyhow::Error>(())
    };
    // Output ending means the server or the provider stopped it; input ending closes its stdin
    // and waits for the server to finish.
    tokio::select! {
        result = forward_output => result,
        result = async { forward_input.await?; std::future::pending::<Result<()>>().await } => result,
    }
}

/// `supertag __codex-exec-bridge`: connects to an Attempt's executor socket and carries this
/// process's stdin and stdout through it, bytes only. The executor's output ending ends the
/// bridge, even with stdin still open.
pub fn run_bridge(socket: &Path) -> Result<()> {
    let stream = std::os::unix::net::UnixStream::connect(socket)
        .context("connect to the Attempt's Codex executor")?;
    let mut input = stream.try_clone()?;
    std::thread::spawn(move || {
        let _ = std::io::copy(&mut std::io::stdin().lock(), &mut input);
        let _ = input.shutdown(std::net::Shutdown::Write);
    });
    let mut output = stream;
    // terminal-safe: Codex's executor protocol, piped as bytes to the app-server, not a terminal.
    let mut stdout = std::io::stdout().lock();
    std::io::copy(&mut output, &mut stdout)?;
    std::io::Write::flush(&mut stdout)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::MetadataExt;
    use supertag_protocol::v2::{
        RemoteStdioServerOutput,
        remote_workspace_provider_server::{
            RemoteWorkspaceProvider, RemoteWorkspaceProviderServer,
        },
        *,
    };
    use tokio::io::AsyncBufReadExt;
    use tonic::{Request, Response, Status, Streaming};

    /// A provider whose Codex exec-server answers each input line with `echo LINE`.
    struct Provider(mpsc::UnboundedSender<String>);

    #[tonic::async_trait]
    impl RemoteWorkspaceProvider for Provider {
        type CaptureStream = ReceiverStream<Result<RemoteWorkspaceCaptureChunk, Status>>;
        type CaptureCopyStream = ReceiverStream<Result<RemoteWorkspaceCopyDownload, Status>>;
        type RunStdioServerStream = ReceiverStream<Result<RemoteStdioServerOutput, Status>>;
        async fn allocate(
            &self,
            _: Request<RemoteWorkspaceAllocateRequest>,
        ) -> Result<Response<RemoteWorkspaceAllocation>, Status> {
            Err(Status::unimplemented("not used"))
        }
        async fn stage(
            &self,
            _: Request<Streaming<RemoteWorkspaceStageChunk>>,
        ) -> Result<Response<RemoteWorkspaceStageResponse>, Status> {
            Err(Status::unimplemented("not used"))
        }
        async fn capture(
            &self,
            _: Request<RemoteWorkspaceCaptureRequest>,
        ) -> Result<Response<Self::CaptureStream>, Status> {
            Err(Status::unimplemented("not used"))
        }
        async fn stop(
            &self,
            _: Request<RemoteWorkspaceStopRequest>,
        ) -> Result<Response<RemoteWorkspaceStopResponse>, Status> {
            Err(Status::unimplemented("not used"))
        }
        async fn stage_copy(
            &self,
            _: Request<Streaming<RemoteWorkspaceCopyUpload>>,
        ) -> Result<Response<RemoteWorkspaceCopyStaged>, Status> {
            Err(Status::unimplemented("not used"))
        }
        async fn capture_copy(
            &self,
            _: Request<RemoteWorkspaceCaptureCopyRequest>,
        ) -> Result<Response<Self::CaptureCopyStream>, Status> {
            Err(Status::unimplemented("not used"))
        }
        async fn snapshot(
            &self,
            _: Request<RemoteWorkspaceSnapshotRequest>,
        ) -> Result<Response<RemoteWorkspaceSnapshot>, Status> {
            Err(Status::unimplemented("not used"))
        }
        async fn remove_artifact(
            &self,
            _: Request<RemoteWorkspaceRemoveArtifactRequest>,
        ) -> Result<Response<RemoteWorkspaceRemoveArtifactResponse>, Status> {
            Err(Status::unimplemented("not used"))
        }
        async fn run_stdio_server(
            &self,
            request: Request<Streaming<RemoteStdioServerInput>>,
        ) -> Result<Response<Self::RunStdioServerStream>, Status> {
            let authorization = request
                .metadata()
                .get("authorization")
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default()
                .to_owned();
            let mut input = request.into_inner();
            let Some(remote_stdio_server_input::Part::Start(RemoteStdioServerStart {
                server: Some(remote_stdio_server_start::Server::CodexExecServer(_)),
            })) = input.message().await?.and_then(|message| message.part)
            else {
                return Err(Status::invalid_argument("expected the Codex exec-server"));
            };
            let _ = self.0.send(authorization);
            let (sender, receiver) = mpsc::channel(4);
            tokio::spawn(async move {
                let mut pending = Vec::new();
                while let Ok(Some(message)) = input.message().await {
                    let Some(remote_stdio_server_input::Part::Stdin(bytes)) = message.part else {
                        return;
                    };
                    pending.extend(bytes);
                    while let Some(end) = pending.iter().position(|byte| *byte == b'\n') {
                        let line: Vec<u8> = pending.drain(..=end).collect();
                        let stdout = [b"echo ".as_slice(), &line].concat();
                        if sender
                            .send(Ok(RemoteStdioServerOutput { stdout }))
                            .await
                            .is_err()
                        {
                            return;
                        }
                    }
                }
            });
            Ok(Response::new(ReceiverStream::new(receiver)))
        }
    }

    #[tokio::test]
    async fn pipes_each_connection_through_an_exec_server_in_the_current_sandbox() -> Result<()> {
        let (ready, source) = tokio::sync::watch::channel(None);
        let bridge = CodexExecBridge::bind(source)?;
        let socket = bridge.socket();
        // Owner-only: the directory and the socket.
        let directory = socket.parent().unwrap().to_owned();
        assert_eq!(std::fs::metadata(&directory)?.mode() & 0o777, 0o700);
        assert_eq!(std::fs::symlink_metadata(&socket)?.mode() & 0o777, 0o600);

        // A connection before the sandbox is staged waits for it.
        let early = UnixStream::connect(&socket).await?;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        let (opened, mut starts) = mpsc::unbounded_channel();
        tokio::spawn(
            tonic::transport::Server::builder()
                .add_service(RemoteWorkspaceProviderServer::new(Provider(opened)))
                .serve_with_incoming(tokio_stream::wrappers::TcpListenerStream::new(listener)),
        );
        let channel =
            tonic::transport::Endpoint::from_shared(format!("http://{address}"))?.connect_lazy();
        ready.send_replace(Some(Ok((channel, "provider-token".to_owned()))));
        let (reader, mut writer) = early.into_split();
        let mut lines = tokio::io::BufReader::new(reader).lines();
        writer.write_all(b"{\"id\":1}\n{\"id\":2}\n").await?;
        assert_eq!(lines.next_line().await?.as_deref(), Some("echo {\"id\":1}"));
        assert_eq!(lines.next_line().await?.as_deref(), Some("echo {\"id\":2}"));
        assert_eq!(
            starts.recv().await.as_deref(),
            Some("Bearer provider-token")
        );

        // The Attempt's end removes the directory and its socket.
        drop(bridge);
        tokio::task::yield_now().await;
        assert!(!directory.exists());
        Ok(())
    }
}
