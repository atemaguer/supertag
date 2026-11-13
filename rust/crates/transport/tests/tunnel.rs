//! Every gRPC call shape through a WebSocket tunnel behind a TLS-terminating edge proxy,
//! with SuperTag's mutual TLS running end to end inside the tunnel, and the ways a tunnel
//! must refuse to connect rather than fall back to weaker security.

use std::{
    net::SocketAddr,
    path::{Path, PathBuf},
    pin::Pin,
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};

use anyhow::{Context, Result, ensure};
use supertag_protocol::v2::{
    ArtifactInputFile, RemoteMcpServerInput, RemoteMcpServerOutput, RemoteMcpServerStart,
    RemoteWorkspaceAllocateRequest, RemoteWorkspaceAllocation, RemoteWorkspaceCaptureChunk,
    RemoteWorkspaceCaptureRequest, RemoteWorkspaceOwner, RemoteWorkspaceStageChunk,
    RemoteWorkspaceStageResponse, RemoteWorkspaceStopRequest, RemoteWorkspaceStopResponse,
    remote_mcp_server_input, remote_workspace_capture_chunk,
    remote_workspace_provider_client::RemoteWorkspaceProviderClient,
    remote_workspace_provider_server::{RemoteWorkspaceProvider, RemoteWorkspaceProviderServer},
    remote_workspace_stage_chunk,
};
use supertag_transport::{Target, incoming, tunneled_uri};
use tokio::{
    net::{TcpListener, TcpStream},
    task::{AbortHandle, JoinHandle},
};
use tokio_rustls::{
    TlsAcceptor,
    rustls::{
        ServerConfig,
        pki_types::{CertificateDer, PrivateKeyDer, pem::PemObject},
    },
};
use tokio_stream::{Stream, StreamExt};
use tonic::{
    Request, Response, Status, Streaming,
    transport::{Certificate, ClientTlsConfig, Endpoint, Identity, Server, ServerTlsConfig},
};

const PAYLOAD: usize = 3 * 1024 * 1024 + 17;

// ---------------------------------------------------------------------------
// A provider service with one call of each shape

#[derive(Clone, Default)]
struct Provider;

type Boxed<T> = Pin<Box<dyn Stream<Item = Result<T, Status>> + Send>>;

#[tonic::async_trait]
impl RemoteWorkspaceProvider for Provider {
    async fn allocate(
        &self,
        request: Request<RemoteWorkspaceAllocateRequest>,
    ) -> Result<Response<RemoteWorkspaceAllocation>, Status> {
        let owner = request.into_inner().owner.unwrap_or_default();
        Ok(Response::new(RemoteWorkspaceAllocation {
            sandbox_id: format!("sandbox-for-{}", owner.task_id),
        }))
    }

    async fn stage(
        &self,
        request: Request<Streaming<RemoteWorkspaceStageChunk>>,
    ) -> Result<Response<RemoteWorkspaceStageResponse>, Status> {
        let mut stream = request.into_inner();
        let (mut chunks, mut bytes, mut sum) = (0_u64, 0_u64, 0_u64);
        while let Some(chunk) = stream.next().await {
            if let Some(remote_workspace_stage_chunk::Part::Payload(payload)) = chunk?.part {
                chunks += 1;
                bytes += payload.len() as u64;
                sum = payload.iter().fold(sum, |sum, byte| sum + u64::from(*byte));
            }
        }
        Ok(Response::new(RemoteWorkspaceStageResponse {
            input_files: vec![ArtifactInputFile {
                path: format!("{chunks}:{bytes}:{sum}"),
                blob: None,
            }],
        }))
    }

    type CaptureStream = Boxed<RemoteWorkspaceCaptureChunk>;

    async fn capture(
        &self,
        _: Request<RemoteWorkspaceCaptureRequest>,
    ) -> Result<Response<Self::CaptureStream>, Status> {
        let chunks = payload()
            .chunks(64 * 1024)
            .map(<[u8]>::to_vec)
            .collect::<Vec<_>>();
        Ok(Response::new(Box::pin(tokio_stream::iter(chunks).map(
            |payload| {
                Ok(RemoteWorkspaceCaptureChunk {
                    part: Some(remote_workspace_capture_chunk::Part::Payload(payload)),
                })
            },
        ))))
    }

    async fn stop(
        &self,
        _: Request<RemoteWorkspaceStopRequest>,
    ) -> Result<Response<RemoteWorkspaceStopResponse>, Status> {
        Ok(Response::new(RemoteWorkspaceStopResponse::default()))
    }

    type RunMcpServerStream = Boxed<RemoteMcpServerOutput>;

    /// Answers each stdin message as soon as it arrives, so the client can interleave.
    async fn run_mcp_server(
        &self,
        request: Request<Streaming<RemoteMcpServerInput>>,
    ) -> Result<Response<Self::RunMcpServerStream>, Status> {
        let mut inputs = request.into_inner();
        let output = async_stream(move |sender| async move {
            while let Some(input) = inputs.next().await {
                let reply = match input.map(|input| input.part) {
                    Ok(Some(remote_mcp_server_input::Part::Start(start))) => {
                        format!("started {}", start.name).into_bytes()
                    }
                    Ok(Some(remote_mcp_server_input::Part::Stdin(stdin))) => {
                        [b"echo ".as_slice(), &stdin].concat()
                    }
                    Ok(None) => continue,
                    Err(status) => {
                        let _ = sender.send(Err(status)).await;
                        return;
                    }
                };
                if sender
                    .send(Ok(RemoteMcpServerOutput { stdout: reply }))
                    .await
                    .is_err()
                {
                    return;
                }
            }
        });
        Ok(Response::new(output))
    }
}

fn async_stream<T, F, Fut>(body: F) -> Boxed<T>
where
    T: Send + 'static,
    F: FnOnce(tokio::sync::mpsc::Sender<Result<T, Status>>) -> Fut,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    let (sender, receiver) = tokio::sync::mpsc::channel(4);
    tokio::spawn(body(sender));
    Box::pin(tokio_stream::wrappers::ReceiverStream::new(receiver))
}

fn payload() -> Vec<u8> {
    (0..PAYLOAD).map(|index| (index % 251) as u8).collect()
}

// ---------------------------------------------------------------------------
// Certificates

struct Pki {
    directory: PathBuf,
}

struct Leaf {
    cert: PathBuf,
    key: PathBuf,
}

impl Leaf {
    fn identity(&self) -> Result<Identity> {
        Ok(Identity::from_pem(
            std::fs::read(&self.cert)?,
            std::fs::read(&self.key)?,
        ))
    }
}

impl Pki {
    fn openssl(&self, args: &[&str]) -> Result<()> {
        let output = std::process::Command::new("openssl")
            .args(args)
            .current_dir(&self.directory)
            .stdin(Stdio::null())
            .output()
            .context("openssl is required for TLS tests")?;
        ensure!(
            output.status.success(),
            "openssl {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        Ok(())
    }

    fn authority(root: &Path, name: &str) -> Result<Self> {
        let directory = root.join(name);
        std::fs::create_dir_all(&directory)?;
        let pki = Self { directory };
        pki.openssl(&[
            "req",
            "-x509",
            "-newkey",
            "ec",
            "-pkeyopt",
            "ec_paramgen_curve:prime256v1",
            "-nodes",
            "-days",
            "1",
            "-subj",
            &format!("/CN={name}"),
            "-addext",
            "basicConstraints=critical,CA:TRUE",
            "-addext",
            "keyUsage=critical,keyCertSign,cRLSign",
            "-keyout",
            "ca.key",
            "-out",
            "ca.pem",
        ])?;
        Ok(pki)
    }

    fn ca(&self) -> Result<Vec<u8>> {
        Ok(std::fs::read(self.directory.join("ca.pem"))?)
    }

    fn leaf(&self, name: &str) -> Result<Leaf> {
        std::fs::write(
            self.directory.join(format!("{name}.ext")),
            "subjectAltName=IP:127.0.0.1,DNS:localhost\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth,clientAuth\n",
        )?;
        self.openssl(&[
            "req",
            "-newkey",
            "ec",
            "-pkeyopt",
            "ec_paramgen_curve:prime256v1",
            "-nodes",
            "-subj",
            &format!("/CN={name}"),
            "-keyout",
            &format!("{name}.key"),
            "-out",
            &format!("{name}.csr"),
        ])?;
        self.openssl(&[
            "x509",
            "-req",
            "-in",
            &format!("{name}.csr"),
            "-CA",
            "ca.pem",
            "-CAkey",
            "ca.key",
            "-CAcreateserial",
            "-days",
            "1",
            "-extfile",
            &format!("{name}.ext"),
            "-out",
            &format!("{name}.pem"),
        ])?;
        Ok(Leaf {
            cert: self.directory.join(format!("{name}.pem")),
            key: self.directory.join(format!("{name}.key")),
        })
    }
}

struct Fixture {
    _directory: tempfile::TempDir,
    supertag: Pki,
    platform: Pki,
    server: Leaf,
    client: Leaf,
    rogue_client: Leaf,
    edge: Leaf,
}

impl Fixture {
    fn new() -> Result<Self> {
        let directory = tempfile::tempdir()?;
        let supertag = Pki::authority(directory.path(), "supertag-ca")?;
        let platform = Pki::authority(directory.path(), "platform-ca")?;
        let rogue = Pki::authority(directory.path(), "rogue-ca")?;
        Ok(Self {
            server: supertag.leaf("gateway")?,
            client: supertag.leaf("worker-host")?,
            rogue_client: rogue.leaf("worker-host")?,
            edge: platform.leaf("edge")?,
            supertag,
            platform,
            _directory: directory,
        })
    }

    /// A server with mutual TLS on its native listener and its tunnel listener.
    async fn server(&self, tls: bool) -> Result<Served> {
        let native = TcpListener::bind("127.0.0.1:0").await?;
        let tunnel = TcpListener::bind("127.0.0.1:0").await?;
        let addresses = (native.local_addr()?, tunnel.local_addr()?);
        let mut builder = Server::builder();
        if tls {
            builder = builder.tls_config(
                ServerTlsConfig::new()
                    .identity(self.server.identity()?)
                    .client_ca_root(Certificate::from_pem(self.supertag.ca()?)),
            )?;
        }
        let task = tokio::spawn(
            builder
                .add_service(RemoteWorkspaceProviderServer::new(Provider))
                .serve_with_incoming(incoming(native, Some(tunnel))),
        );
        Ok(Served {
            native: addresses.0,
            tunnel: addresses.1,
            task,
        })
    }

    /// A platform edge: terminates the outer TLS with the platform's certificate and
    /// relays the decrypted HTTP/1.1 bytes to `backend`.
    async fn edge(&self, backend: SocketAddr) -> Result<Edge> {
        self.edge_on(0, backend).await
    }

    async fn edge_on(&self, port: u16, backend: SocketAddr) -> Result<Edge> {
        let config = ServerConfig::builder_with_provider(Arc::new(
            tokio_rustls::rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()?
        .with_no_client_auth()
        .with_single_cert(
            CertificateDer::pem_file_iter(&self.edge.cert)?.collect::<Result<_, _>>()?,
            PrivateKeyDer::from_pem_file(&self.edge.key)?,
        )?;
        let acceptor = TlsAcceptor::from(Arc::new(config));
        let listener = TcpListener::bind(("127.0.0.1", port)).await?;
        let address = listener.local_addr()?;
        let links: Arc<Mutex<Vec<AbortHandle>>> = Arc::default();
        let open = links.clone();
        let task = tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let acceptor = acceptor.clone();
                let link = tokio::spawn(async move {
                    let Ok(mut downstream) = acceptor.accept(stream).await else {
                        return;
                    };
                    if let Ok(mut upstream) = TcpStream::connect(backend).await {
                        let _ = tokio::io::copy_bidirectional(&mut downstream, &mut upstream).await;
                    }
                });
                open.lock().unwrap().push(link.abort_handle());
            }
        });
        Ok(Edge {
            address,
            links,
            task,
        })
    }

    fn inner_tls(&self, client: Option<&Leaf>) -> Result<ClientTlsConfig> {
        let mut tls =
            ClientTlsConfig::new().ca_certificate(Certificate::from_pem(self.supertag.ca()?));
        if let Some(client) = client {
            tls = tls.identity(client.identity()?);
        }
        Ok(tls)
    }

    fn target(&self, url: &str, client: Option<&Leaf>) -> Result<Target> {
        let endpoint = Endpoint::from_shared(tunneled_uri(url).unwrap().context("tunnel URL")?)?
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(30))
            .tls_config(self.inner_tls(client)?)?;
        Target::tunnel(url, endpoint, Some(&self.platform.ca()?))
            .map_err(|error| anyhow::anyhow!(error))
    }
}

struct Edge {
    address: SocketAddr,
    links: Arc<Mutex<Vec<AbortHandle>>>,
    task: JoinHandle<()>,
}

impl Edge {
    fn port(&self) -> u16 {
        self.address.port()
    }

    /// Drops every open tunnel and stops accepting, as a crashed edge would.
    fn crash(&self) {
        self.task.abort();
        for link in self.links.lock().unwrap().drain(..) {
            link.abort();
        }
    }
}

impl Drop for Edge {
    fn drop(&mut self) {
        self.crash();
    }
}

struct Served {
    native: SocketAddr,
    tunnel: SocketAddr,
    task: JoinHandle<Result<(), tonic::transport::Error>>,
}

impl Drop for Served {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn exercise(
    client: &mut RemoteWorkspaceProviderClient<tonic::transport::Channel>,
) -> Result<()> {
    // Unary.
    let allocation = client
        .allocate(RemoteWorkspaceAllocateRequest {
            owner: Some(RemoteWorkspaceOwner {
                task_id: "task-1".into(),
                ..Default::default()
            }),
            ..Default::default()
        })
        .await?
        .into_inner();
    assert_eq!(allocation.sandbox_id, "sandbox-for-task-1");

    // Client streaming, larger than one WebSocket message.
    let bytes = payload();
    let chunks = bytes
        .chunks(60 * 1024)
        .map(|chunk| RemoteWorkspaceStageChunk {
            part: Some(remote_workspace_stage_chunk::Part::Payload(chunk.to_vec())),
        })
        .collect::<Vec<_>>();
    let count = chunks.len();
    let staged = client.stage(tokio_stream::iter(chunks)).await?.into_inner();
    let sum: u64 = bytes.iter().map(|byte| u64::from(*byte)).sum();
    assert_eq!(
        staged.input_files[0].path,
        format!("{count}:{PAYLOAD}:{sum}")
    );

    // Server streaming.
    let mut capture = client
        .capture(RemoteWorkspaceCaptureRequest {})
        .await?
        .into_inner();
    let mut received = Vec::new();
    while let Some(chunk) = capture.next().await {
        if let Some(remote_workspace_capture_chunk::Part::Payload(payload)) = chunk?.part {
            received.extend_from_slice(&payload);
        }
    }
    ensure!(received == bytes, "captured bytes differ");

    // Bidirectional: each reply arrives before the next input is sent.
    let (sender, receiver) = tokio::sync::mpsc::channel(1);
    sender
        .send(RemoteMcpServerInput {
            part: Some(remote_mcp_server_input::Part::Start(RemoteMcpServerStart {
                name: "files".into(),
                ..Default::default()
            })),
        })
        .await?;
    let mut outputs = client
        .run_mcp_server(tokio_stream::wrappers::ReceiverStream::new(receiver))
        .await?
        .into_inner();
    let first = outputs.next().await.context("start reply")??;
    assert_eq!(first.stdout, b"started files");
    for round in 0..20 {
        let line = format!("{{\"id\":{round}}}");
        sender
            .send(RemoteMcpServerInput {
                part: Some(remote_mcp_server_input::Part::Stdin(
                    line.clone().into_bytes(),
                )),
            })
            .await?;
        let reply = outputs.next().await.context("echo")??;
        assert_eq!(reply.stdout, format!("echo {line}").into_bytes());
    }
    drop(sender);
    ensure!(outputs.next().await.is_none(), "the call did not end");
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_call_shape_crosses_the_tunnel_with_mutual_tls() -> Result<()> {
    let fixture = Fixture::new()?;
    let served = fixture.server(true).await?;
    let edge = fixture.edge(served.tunnel).await?;
    let target = fixture.target(
        &format!("wss://localhost:{}/supertag", edge.port()),
        Some(&fixture.client),
    )?;
    assert!(target.tunnelled());
    let mut client = RemoteWorkspaceProviderClient::new(target.connect().await?)
        .max_decoding_message_size(4 << 20);
    exercise(&mut client).await?;
    // A lazy channel works the same way.
    let mut lazy = RemoteWorkspaceProviderClient::new(target.connect_lazy());
    exercise(&mut lazy).await?;

    // The native listener is unchanged on the same server.
    let native = Endpoint::from_shared(format!("https://localhost:{}", served.native.port()))?
        .tls_config(fixture.inner_tls(Some(&fixture.client))?)?;
    let mut native = RemoteWorkspaceProviderClient::new(Target::native(native).connect().await?);
    exercise(&mut native).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cleartext_ws_reaches_a_loopback_server_without_tls() -> Result<()> {
    let fixture = Fixture::new()?;
    let served = fixture.server(false).await?;
    let url = format!("ws://127.0.0.1:{}", served.tunnel.port());
    let endpoint = Endpoint::from_shared(tunneled_uri(&url).unwrap().context("tunnel URL")?)?;
    let target = Target::tunnel(&url, endpoint, None).map_err(|error| anyhow::anyhow!(error))?;
    let mut client = RemoteWorkspaceProviderClient::new(target.connect().await?);
    exercise(&mut client).await
}

/// Whether a call through `target` fails.
async fn refused(target: &Target) -> bool {
    match target.connect().await {
        Err(_) => true,
        Ok(channel) => RemoteWorkspaceProviderClient::new(channel)
            .allocate(RemoteWorkspaceAllocateRequest::default())
            .await
            .is_err(),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_tunnel_without_valid_inner_tls_fails_closed() -> Result<()> {
    let fixture = Fixture::new()?;
    let served = fixture.server(true).await?;
    let edge = fixture.edge(served.tunnel).await?;
    let url = format!("wss://localhost:{}", edge.port());

    // No client certificate, or one another authority issued.
    ensure!(
        refused(&fixture.target(&url, None)?).await,
        "anonymous client accepted"
    );
    ensure!(
        refused(&fixture.target(&url, Some(&fixture.rogue_client))?).await,
        "rogue client certificate accepted"
    );

    // A server certificate the client does not trust inside the tunnel.
    let endpoint = Endpoint::from_shared(tunneled_uri(&url).unwrap().unwrap())?.tls_config(
        ClientTlsConfig::new()
            .ca_certificate(Certificate::from_pem(fixture.platform.ca()?))
            .identity(fixture.client.identity()?),
    )?;
    let untrusted = Target::tunnel(&url, endpoint, Some(&fixture.platform.ca()?))
        .map_err(|error| anyhow::anyhow!(error))?;
    ensure!(
        refused(&untrusted).await,
        "untrusted inner server certificate accepted"
    );

    // A server that speaks cleartext gRPC inside its tunnel cannot complete inner TLS.
    let cleartext = fixture.server(false).await?;
    let cleartext_edge = fixture.edge(cleartext.tunnel).await?;
    let target = fixture.target(
        &format!("wss://localhost:{}", cleartext_edge.port()),
        Some(&fixture.client),
    )?;
    ensure!(refused(&target).await, "wss reached a cleartext server");

    // An edge certificate the client does not trust: the outer TLS fails first.
    let endpoint = Endpoint::from_shared(tunneled_uri(&url).unwrap().unwrap())?
        .tls_config(fixture.inner_tls(Some(&fixture.client))?)?;
    let target = Target::tunnel(&url, endpoint, None).map_err(|error| anyhow::anyhow!(error))?;
    ensure!(
        refused(&target).await,
        "untrusted edge certificate accepted"
    );

    // A wss URL cannot carry a cleartext inner endpoint.
    let downgrade = Target::tunnel(
        &url,
        Endpoint::from_shared(format!("http://localhost:{}", edge.port()))?,
        None,
    );
    ensure!(
        downgrade.is_err(),
        "wss accepted a cleartext inner endpoint"
    );

    // The real client still works against the same edge.
    let mut client = RemoteWorkspaceProviderClient::new(
        fixture
            .target(&url, Some(&fixture.client))?
            .connect()
            .await?,
    );
    client
        .allocate(RemoteWorkspaceAllocateRequest::default())
        .await?;
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_plain_http_request_to_the_tunnel_listener_is_not_served() -> Result<()> {
    let fixture = Fixture::new()?;
    let served = fixture.server(true).await?;
    let response = tokio::time::timeout(Duration::from_secs(15), async {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut stream = TcpStream::connect(served.tunnel).await?;
        stream
            .write_all(b"GET /supertag.runtime.v2.RemoteWorkspaceProvider/Allocate HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .await?;
        let mut response = Vec::new();
        stream.read_to_end(&mut response).await?;
        anyhow::Ok(response)
    })
    .await??;
    let text = String::from_utf8_lossy(&response);
    ensure!(!text.contains(" 200 "), "plain HTTP was served: {text}");
    Ok(())
}

/// Whether a Worker Host retries after this failure rather than giving up on its work.
fn retryable(status: &Status) -> bool {
    matches!(
        status.code(),
        tonic::Code::Unavailable | tonic::Code::DeadlineExceeded | tonic::Code::Cancelled
    ) || supertag_protocol::interrupted_transport(status)
        || supertag_protocol::local_transport_failure(status)
}

/// A tunnel that drops mid-call fails the call with a retryable transport status, the
/// next call while the edge is down is unavailable, and the same lazy channel works
/// again once a new edge serves the address.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_dropped_tunnel_fails_calls_as_retryable_and_the_channel_recovers() -> Result<()> {
    let fixture = Fixture::new()?;
    let served = fixture.server(true).await?;
    let edge = fixture.edge(served.tunnel).await?;
    let port = edge.port();
    let target = fixture.target(&format!("wss://localhost:{port}"), Some(&fixture.client))?;
    let mut client = RemoteWorkspaceProviderClient::new(target.connect_lazy());

    // A bidirectional call in progress when the edge crashes.
    let (sender, receiver) = tokio::sync::mpsc::channel(1);
    sender
        .send(RemoteMcpServerInput {
            part: Some(remote_mcp_server_input::Part::Start(RemoteMcpServerStart {
                name: "files".into(),
                ..Default::default()
            })),
        })
        .await?;
    let mut outputs = client
        .run_mcp_server(tokio_stream::wrappers::ReceiverStream::new(receiver))
        .await?
        .into_inner();
    outputs.next().await.context("start reply")??;
    edge.crash();
    let status = tokio::time::timeout(Duration::from_secs(10), outputs.next())
        .await
        .context("the call never noticed the dropped tunnel")?
        .context("the call ended cleanly")?
        .expect_err("the call succeeded after its tunnel dropped");
    ensure!(
        retryable(&status),
        "a dropped tunnel is not retryable: {status:?}"
    );
    // A Gateway forwarding this failure from its Control Plane link reports it as
    // Unavailable, because the local cause does not cross the wire.
    ensure!(
        supertag_protocol::upstream_status(status.clone()).code() == tonic::Code::Unavailable,
        "a dropped upstream tunnel is not forwarded as retryable: {status:?}"
    );
    drop(sender);

    // With the edge down, a new call cannot connect.
    let status = client
        .allocate(RemoteWorkspaceAllocateRequest::default())
        .await
        .expect_err("a call succeeded with the edge down");
    ensure!(
        retryable(&status),
        "an unreachable edge is not retryable: {status:?}"
    );

    // A new edge on the same address: the same channel reconnects.
    let listener = loop {
        match TcpListener::bind(("127.0.0.1", port)).await {
            Ok(listener) => break listener,
            Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
        }
    };
    drop(listener);
    let _restored = fixture.edge_on(port, served.tunnel).await?;
    let mut recovered = None;
    for _ in 0..50 {
        match client
            .allocate(RemoteWorkspaceAllocateRequest::default())
            .await
        {
            Ok(response) => {
                recovered = Some(response.into_inner());
                break;
            }
            Err(status) => {
                ensure!(
                    retryable(&status),
                    "reconnecting failed permanently: {status:?}"
                );
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
    }
    ensure!(recovered.is_some(), "the channel never reconnected");
    Ok(())
}
