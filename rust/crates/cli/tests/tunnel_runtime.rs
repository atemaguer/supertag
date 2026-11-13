//! The WebSocket tunnel between the shipped Control Plane, Gateway, Worker Host, and
//! operator CLI processes. Each tunnel crosses a platform-style edge that terminates the
//! outer `wss://` TLS and forwards plain HTTP/1.1, while SuperTag's mutual TLS runs end to
//! end inside the tunnel:
//!
//! - every Control Plane call shape (unary, client-streaming Workspace upload,
//!   server-streaming artifact download and Watch), a Gateway's calls to the Control Plane,
//!   and the operator's call to the Gateway;
//! - severing either client's tunnel mid-Attempt, after which the Worker Host and Gateway
//!   reconnect and the Attempt completes once;
//! - refusal of clients without valid inner TLS;
//! - with Docker, the same deployment behind a real HTTP/1.1-only nginx that forwards only
//!   WebSocket upgrades and closes connections idle longer than 25 seconds.
#[path = "../../../test-support/prerequisites.rs"]
mod prerequisites;
#[path = "support/protocol.rs"]
mod protocol;
#[macro_use]
#[path = "support/database.rs"]
mod database;

use std::{
    net::SocketAddr,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use anyhow::{Context, Result, anyhow, ensure};
use serde_json::Value;
use sha2::{Digest, Sha256};
use supertag_protocol::{
    authenticated_request,
    negotiation::ProtocolChannel,
    v2::{
        ListTagsRequest, WatchChange, WatchEvent, WatchKind, WatchRequest,
        operator_client::OperatorClient, operator_events_client::OperatorEventsClient,
        watch_event::Update,
    },
};
use supertag_transport::{Target, tunneled_uri};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    net::{TcpListener, TcpStream},
    process::{Child, ChildStdout, Command},
    task::{AbortHandle, JoinHandle},
    time::{sleep, timeout},
};
use tokio_rustls::{
    TlsAcceptor,
    rustls::{
        ServerConfig,
        pki_types::{CertificateDer, PrivateKeyDer, pem::PemObject},
    },
};
use tonic::transport::{Certificate, ClientTlsConfig, Endpoint, Identity};
use uuid::Uuid;

const BINARY: &str = env!("CARGO_BIN_EXE_supertag");
const ADAPTER: &str = env!("CARGO_BIN_EXE_supertag-fixture-adapter");
const STARTUP: Duration = Duration::from_secs(20);

database_tests! {
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    tunnel_carries_every_service_role_and_call_shape_with_mutual_tls;
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    severed_tunnels_reconnect_and_the_attempt_completes_once;
}

// ---------------------------------------------------------------------------
// Processes

/// A test-owned SuperTag process. Dropping it asks the process to stop, then kills it.
struct Service {
    child: Child,
    stdout: Option<BufReader<ChildStdout>>,
    log: PathBuf,
}

impl Service {
    fn spawn(mut command: Command, directory: &Path, name: &str) -> Result<Self> {
        let log = directory.join(format!("{name}.log"));
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(std::fs::File::create(&log)?)
            .kill_on_drop(true);
        let mut child = command.spawn().with_context(|| format!("spawn {name}"))?;
        let stdout = child.stdout.take().map(BufReader::new);
        Ok(Self { child, stdout, log })
    }

    /// Reads the next bound address the server reports on stdout.
    async fn address(&mut self) -> Result<SocketAddr> {
        let stdout = self.stdout.as_mut().context("server stdout missing")?;
        let mut line = String::new();
        match timeout(STARTUP, stdout.read_line(&mut line)).await {
            Ok(Ok(bytes)) if bytes > 0 => {}
            _ => return Err(anyhow!("server did not report an address: {}", self.logs())),
        }
        let address: SocketAddr = line
            .trim()
            .parse()
            .with_context(|| format!("invalid address line {line:?}: {}", self.logs()))?;
        ensure!(address.ip().is_loopback() && address.port() != 0);
        Ok(address)
    }

    fn running(&mut self) -> Result<bool> {
        Ok(self.child.try_wait()?.is_none())
    }

    fn logs(&self) -> String {
        std::fs::read_to_string(&self.log).unwrap_or_default()
    }
}

impl Drop for Service {
    fn drop(&mut self) {
        let Some(pid) = self.child.id() else {
            return;
        };
        // A Worker Host stops its adapter on SIGTERM; anything still alive is killed.
        unsafe {
            libc::kill(pid as i32, libc::SIGTERM);
        }
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if matches!(self.child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let _ = self.child.start_kill();
    }
}

fn binary(args: &[&str]) -> Command {
    let mut command = Command::new(BINARY);
    // Never inherit an operator's credentials, TLS settings, or state location.
    command.args(args).env_clear();
    command
}

async fn run(mut command: Command) -> Result<std::process::Output> {
    command.stdin(Stdio::null()).kill_on_drop(true);
    Ok(timeout(STARTUP, command.output())
        .await
        .context("SuperTag command did not exit")??)
}

async fn run_json(command: Command) -> Result<Value> {
    let output = run(command).await?;
    ensure!(
        output.status.success(),
        "SuperTag command failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(serde_json::from_slice(&output.stdout)?)
}

async fn git(source: &Path, arguments: &[&str]) -> Result<String> {
    let mut command = Command::new("/usr/bin/git");
    command
        .arg("-C")
        .arg(source)
        .args(arguments)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_AUTHOR_NAME", "Fixture")
        .env("GIT_AUTHOR_EMAIL", "fixture@example.invalid")
        .env("GIT_COMMITTER_NAME", "Fixture")
        .env("GIT_COMMITTER_EMAIL", "fixture@example.invalid");
    let output = run(command).await?;
    ensure!(
        output.status.success(),
        "git {arguments:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(String::from_utf8(output.stdout)?.trim().into())
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
    async fn openssl(&self, args: &[&str]) -> Result<()> {
        let output = Command::new("openssl")
            .args(args)
            .current_dir(&self.directory)
            .stdin(Stdio::null())
            .output()
            .await
            .context("openssl is required for TLS process tests")?;
        ensure!(
            output.status.success(),
            "openssl {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        Ok(())
    }

    async fn authority(directory: &Path, name: &str) -> Result<Self> {
        let directory = directory.join(name);
        std::fs::create_dir_all(&directory)?;
        let pki = Self { directory };
        let subject = format!("/CN={name}");
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
            &subject,
            "-addext",
            "basicConstraints=critical,CA:TRUE",
            "-addext",
            "keyUsage=critical,keyCertSign,cRLSign",
            "-keyout",
            "ca.key",
            "-out",
            "ca.pem",
        ])
        .await?;
        Ok(pki)
    }

    fn ca(&self) -> PathBuf {
        self.directory.join("ca.pem")
    }

    async fn leaf(&self, name: &str) -> Result<Leaf> {
        let extensions = format!("{name}.ext");
        std::fs::write(
            self.directory.join(&extensions),
            "subjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth,clientAuth\n",
        )?;
        let (key, request, cert, subject) = (
            format!("{name}.key"),
            format!("{name}.csr"),
            format!("{name}.pem"),
            format!("/CN={name}"),
        );
        self.openssl(&[
            "req",
            "-newkey",
            "ec",
            "-pkeyopt",
            "ec_paramgen_curve:prime256v1",
            "-nodes",
            "-subj",
            &subject,
            "-keyout",
            &key,
            "-out",
            &request,
        ])
        .await?;
        self.openssl(&[
            "x509",
            "-req",
            "-in",
            &request,
            "-CA",
            "ca.pem",
            "-CAkey",
            "ca.key",
            "-CAcreateserial",
            "-days",
            "1",
            "-extfile",
            &extensions,
            "-out",
            &cert,
        ])
        .await?;
        Ok(Leaf {
            cert: self.directory.join(cert),
            key: self.directory.join(key),
        })
    }
}

fn server_tls(command: &mut Command, leaf: &Leaf, client_ca: &Path) {
    command
        .env("SUPERTAG_TLS_CERT_FILE", &leaf.cert)
        .env("SUPERTAG_TLS_KEY_FILE", &leaf.key)
        .env("SUPERTAG_TLS_CLIENT_CA_FILE", client_ca);
}

fn client_tls(command: &mut Command, server_ca: &Path, leaf: Option<&Leaf>) {
    command.env("SUPERTAG_SERVER_CA_FILE", server_ca);
    if let Some(leaf) = leaf {
        command
            .env("SUPERTAG_CLIENT_CERT_FILE", &leaf.cert)
            .env("SUPERTAG_CLIENT_KEY_FILE", &leaf.key);
    }
}

// ---------------------------------------------------------------------------
// Platform edge

#[derive(Default)]
struct EdgeState {
    partitioned: AtomicBool,
    accepted: AtomicU64,
    refused: AtomicU64,
    links: Mutex<Vec<AbortHandle>>,
}

/// What a hosting platform puts in front of a service: it terminates the outer TLS with
/// its own certificate and relays the decrypted HTTP/1.1 bytes to the service's WebSocket
/// listener. A partition severs every open link and refuses new ones until restored.
struct Edge {
    address: SocketAddr,
    state: Arc<EdgeState>,
    task: JoinHandle<()>,
}

impl Edge {
    async fn start(backend: SocketAddr, leaf: &Leaf) -> Result<Self> {
        let config = ServerConfig::builder_with_provider(Arc::new(
            tokio_rustls::rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()?
        .with_no_client_auth()
        .with_single_cert(
            CertificateDer::pem_file_iter(&leaf.cert)?.collect::<Result<_, _>>()?,
            PrivateKeyDer::from_pem_file(&leaf.key)?,
        )?;
        let acceptor = TlsAcceptor::from(Arc::new(config));
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        let state = Arc::new(EdgeState::default());
        let shared = state.clone();
        let task = tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let mut links = shared.links.lock().unwrap();
                if shared.partitioned.load(Ordering::SeqCst) {
                    shared.refused.fetch_add(1, Ordering::SeqCst);
                    continue;
                }
                shared.accepted.fetch_add(1, Ordering::SeqCst);
                let acceptor = acceptor.clone();
                let link = tokio::spawn(async move {
                    let Ok(mut downstream) = acceptor.accept(stream).await else {
                        return;
                    };
                    if let Ok(mut upstream) = TcpStream::connect(backend).await {
                        let _ = tokio::io::copy_bidirectional(&mut downstream, &mut upstream).await;
                    }
                });
                links.retain(|link| !link.is_finished());
                links.push(link.abort_handle());
            }
        });
        Ok(Self {
            address,
            state,
            task,
        })
    }

    fn partition(&self) {
        let mut links = self.state.links.lock().unwrap();
        self.state.partitioned.store(true, Ordering::SeqCst);
        for link in links.drain(..) {
            link.abort();
        }
    }

    fn restore(&self) {
        let _links = self.state.links.lock().unwrap();
        self.state.partitioned.store(false, Ordering::SeqCst);
    }

    fn accepted(&self) -> u64 {
        self.state.accepted.load(Ordering::SeqCst)
    }

    fn refused(&self) -> u64 {
        self.state.refused.load(Ordering::SeqCst)
    }

    fn url(&self) -> String {
        format!("wss://{}/supertag", self.address)
    }
}

impl Drop for Edge {
    fn drop(&mut self) {
        self.partition();
        self.task.abort();
    }
}

// ---------------------------------------------------------------------------
// Deployment

struct Tokens {
    gateway: String,
    operator: String,
}

/// A Control Plane and Gateway that both require client certificates and also accept
/// WebSocket tunnels. Operators and Worker Hosts reach the Control Plane through its edge;
/// the Gateway reaches it through an edge of its own.
struct Deployment {
    root: PathBuf,
    tokens: Tokens,
    pki: Pki,
    operator_leaf: Leaf,
    host_leaf: Leaf,
    edge_leaf: Leaf,
    control_plane: Service,
    control_native: SocketAddr,
    control_tunnel: SocketAddr,
    control_edge: Edge,
    gateway: Service,
    gateway_link: Edge,
    gateway_edge: Edge,
}

impl Deployment {
    async fn start(database: &str, root: &Path) -> Result<Self> {
        let tokens = Tokens {
            gateway: Uuid::new_v4().to_string(),
            operator: Uuid::new_v4().to_string(),
        };
        let pki = Pki::authority(root, "supertag-tunnel-ca").await?;
        let control_leaf = pki.leaf("control-plane").await?;
        let gateway_leaf = pki.leaf("gateway").await?;
        let edge_leaf = pki.leaf("edge").await?;

        let mut command = binary(&["control-plane", "--websocket-listen", "127.0.0.1:0"]);
        command
            .arg("--transfer-directory")
            .arg(root.join("transfers"))
            .env("SUPERTAG_GATEWAY_TOKEN", &tokens.gateway)
            .env("SUPERTAG_OPERATOR_TOKEN", &tokens.operator)
            .env("SUPERTAG_DATABASE_URL", database);
        server_tls(&mut command, &control_leaf, &pki.ca());
        let mut control_plane = Service::spawn(command, root, "control-plane")?;
        let control_native = control_plane.address().await?;
        let control_tunnel = control_plane.address().await?;
        let control_edge = Edge::start(control_tunnel, &edge_leaf).await?;
        let gateway_link = Edge::start(control_tunnel, &edge_leaf).await?;

        // The Gateway's notification outbox polls the Control Plane, so its link carries
        // calls on its own.
        let mut command = binary(&[
            "gateway",
            "--control-plane",
            &gateway_link.url(),
            "--websocket-listen",
            "127.0.0.1:0",
            "--notify",
            "desktop",
        ]);
        command
            .env("SUPERTAG_GATEWAY_TOKEN", &tokens.gateway)
            .env("SUPERTAG_OPERATOR_TOKEN", &tokens.operator);
        server_tls(&mut command, &gateway_leaf, &pki.ca());
        client_tls(&mut command, &pki.ca(), Some(&gateway_leaf));
        let mut gateway = Service::spawn(command, root, "gateway")?;
        gateway.address().await?;
        let gateway_tunnel = gateway.address().await?;
        let gateway_edge = Edge::start(gateway_tunnel, &edge_leaf).await?;
        Ok(Self {
            root: root.into(),
            tokens,
            operator_leaf: pki.leaf("operator").await?,
            host_leaf: pki.leaf("worker-host").await?,
            edge_leaf,
            pki,
            control_plane,
            control_native,
            control_tunnel,
            control_edge,
            gateway,
            gateway_link,
            gateway_edge,
        })
    }

    /// An operator command against `url` with the operator's client certificate.
    fn operator_at(&self, url: &str, args: &[&str], leaf: Option<&Leaf>) -> Command {
        let mut command = binary(args);
        command
            .args(["--control-plane", url])
            .env("SUPERTAG_OPERATOR_TOKEN", &self.tokens.operator);
        client_tls(&mut command, &self.pki.ca(), leaf);
        command
    }

    fn operator(&self, args: &[&str]) -> Command {
        self.operator_at(&self.control_edge.url(), args, Some(&self.operator_leaf))
    }

    /// An operator command on the Control Plane's native listener, which no edge partition
    /// affects.
    fn native_operator(&self, args: &[&str]) -> Command {
        self.operator_at(
            &format!("https://{}", self.control_native),
            args,
            Some(&self.operator_leaf),
        )
    }

    /// A tunnel target through `url` with the operator's client certificate.
    fn operator_target(&self, url: &str) -> Result<Target> {
        let endpoint = Endpoint::from_shared(
            tunneled_uri(url)
                .map_err(|error| anyhow!(error))?
                .context("tunnel URL")?,
        )?
        .connect_timeout(Duration::from_secs(5))
        .tls_config(
            ClientTlsConfig::new()
                .ca_certificate(Certificate::from_pem(std::fs::read(self.pki.ca())?))
                .identity(self.operator_leaf.identity()?),
        )?;
        Target::tunnel(url, endpoint, Some(&std::fs::read(self.pki.ca())?))
            .map_err(|error| anyhow!(error))
    }

    async fn operator_channel(&self, url: &str) -> Result<ProtocolChannel> {
        protocol::negotiated(self.operator_target(url)?.connect().await?).await
    }

    /// Issues an Auth Key for `host`, enrolls it through `url`, and returns its state.
    async fn enroll(&self, host: &str, tag: &str, url: &str) -> Result<PathBuf> {
        let issued =
            run_json(self.operator(&["auth-key", "create", host, "--host", host, "--tag", tag]))
                .await?;
        let key = self.root.join(format!("{host}.key"));
        std::fs::write(&key, issued["auth_key"].as_str().context("Auth Key")?)?;
        std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o600))?;
        let state = self.root.join(host);
        let mut enroll = binary(&["host", "enroll", host, "--control-plane", url]);
        enroll
            .arg("--state-directory")
            .arg(&state)
            .arg("--auth-key")
            .arg(format!("file:{}", key.display()));
        client_tls(&mut enroll, &self.pki.ca(), Some(&self.host_leaf));
        ensure!(run_json(enroll).await?["host_id"] == host);
        Ok(state)
    }

    fn worker_host(&self, url: &str, state: &Path, adapter: &Path) -> Command {
        let mut command = binary(&["worker-host", "--control-plane", url, "--adapter"]);
        command.arg(adapter).arg("--state-directory").arg(state);
        client_tls(&mut command, &self.pki.ca(), Some(&self.host_leaf));
        command
    }

    fn running(&mut self) -> Result<bool> {
        Ok(self.gateway.running()? && self.control_plane.running()?)
    }
}

async fn watch(channel: ProtocolChannel, token: &str) -> Result<tonic::Streaming<WatchEvent>> {
    let request = authenticated_request(
        WatchRequest {
            resume_token: String::new(),
            kinds: vec![WatchKind::Task as i32],
        },
        token,
        None,
    )?;
    Ok(OperatorEventsClient::new(channel)
        .watch(request)
        .await?
        .into_inner())
}

async fn watched_change(watch: &mut tonic::Streaming<WatchEvent>, task_id: &str) -> Result<()> {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let event = timeout(remaining, watch.message())
            .await
            .context("Watch never reported the Task")??
            .context("Watch ended")?;
        if let Some(Update::Change(WatchChange { id, .. })) = event.update
            && id == task_id
        {
            return Ok(());
        }
    }
}

async fn wait_for_task(
    command: impl Fn() -> Command,
    done: impl Fn(&Value) -> bool,
    context: impl Fn() -> String,
) -> Result<Value> {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let task = run_json(command()).await?;
        if done(&task) {
            return Ok(task);
        }
        ensure!(
            Instant::now() < deadline,
            "Task never reached the expected state: {task}\n{}",
            context()
        );
        sleep(Duration::from_millis(100)).await;
    }
}

fn finished(task: &Value) -> bool {
    matches!(
        task["state"].as_str(),
        Some("TASK_STATE_SUCCEEDED" | "TASK_STATE_FAILED" | "TASK_STATE_CANCELLED")
    )
}

// ---------------------------------------------------------------------------
// Call shapes

/// The Control Plane's whole public surface runs through a tunnel: unary operator and Worker
/// Host calls, the client-streaming Workspace upload, the server-streaming artifact download,
/// and a Watch stream. A Gateway reaches the Control Plane, and an operator the Gateway,
/// through tunnels too. The native listener keeps working beside the tunnel, and clients
/// without valid inner TLS are refused.
async fn tunnel_carries_every_service_role_and_call_shape_with_mutual_tls(
    database: String,
) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let root = directory.path();
    let mut deployment = Deployment::start(&database, root).await?;
    let public = deployment.control_edge.url();

    let source = root.join("source");
    std::fs::create_dir(&source)?;
    git(&source, &["init", "--quiet"]).await?;
    std::fs::write(source.join("workspace.txt"), "base\n")?;
    git(&source, &["add", "workspace.txt"]).await?;
    git(&source, &["commit", "--quiet", "-m", "Initial source"]).await?;
    let base = git(&source, &["rev-parse", "HEAD"]).await?;

    run_json(deployment.operator(&[
        "tag",
        "put",
        "builder",
        "--instructions",
        "Improve the repository",
        "--allow",
        "file:write",
        "--workspace-id",
        "project",
        "--workspace-base",
        &base,
    ]))
    .await?;

    // A Watch stream opened through the tunnel before any work exists.
    let mut events = watch(
        deployment.operator_channel(&public).await?,
        &deployment.tokens.operator,
    )
    .await?;

    let state = deployment.enroll("tunnel-host", "builder", &public).await?;
    let submitted = run_json(deployment.operator(&[
        "task",
        "submit",
        "--tag",
        "builder",
        "--session",
        "tunnel",
        "through the tunnel",
    ]))
    .await?;
    let task_id = submitted["task_id"].as_str().context("task_id")?.to_owned();
    let mut host = deployment.worker_host(&public, &state, Path::new(ADAPTER));
    host.args([
        "--once",
        "--adapter-arg=--workspace-fixture",
        "--workspace-id",
        "project",
        "--workspace-source",
    ])
    .arg(&source);
    let output = run(host).await?;
    ensure!(
        output.status.success(),
        "tunnelled Worker Host failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let task = run_json(deployment.operator(&["get", "task", &task_id])).await?;
    assert_eq!(task["state"], "TASK_STATE_SUCCEEDED", "{task}");
    assert_eq!(
        task["result"],
        "Change: through the tunnel\nWorkspace before:\nbase\n"
    );
    watched_change(&mut events, &task_id).await?;

    // The Workspace the host uploaded comes back as a streamed download.
    let delivery = &task["workspace_delivery"];
    assert_eq!(delivery["changed_files"], 2, "{task}");
    let bundle = root.join("delivery.bundle");
    let mut download = deployment.operator(&["task", "download", &task_id, "--kind", "bundle"]);
    download.arg("--output").arg(&bundle);
    let receipt = run_json(download).await?;
    let bytes = std::fs::read(&bundle)?;
    assert_eq!(
        format!("{:x}", Sha256::digest(&bytes)),
        delivery["bundle"]["sha256"]
    );
    assert_eq!(receipt["sha256"], delivery["bundle"]["sha256"]);

    // The native listener still answers on the same Control Plane.
    let native = run_json(deployment.native_operator(&["get", "task", &task_id])).await?;
    assert_eq!(native["state"], "TASK_STATE_SUCCEEDED");

    // Inner TLS is required inside the tunnel: no client certificate, or one from another
    // authority, is refused even though the edge accepted the outer connection.
    let rogue = Pki::authority(root, "rogue-ca")
        .await?
        .leaf("operator")
        .await?;
    for (leaf, case) in [
        (None, "no client certificate"),
        (Some(&rogue), "a rogue certificate"),
    ] {
        let output = run(deployment.operator_at(&public, &["get", "tags"], leaf)).await?;
        ensure!(
            !output.status.success(),
            "an operator with {case} reached the Control Plane through the tunnel"
        );
    }
    let accepted = deployment.control_edge.accepted();
    let mut client = OperatorClient::new(deployment.operator_channel(&public).await?);
    let tags = client
        .list_tags(authenticated_request(
            ListTagsRequest::default(),
            &deployment.tokens.operator,
            None,
        )?)
        .await?
        .into_inner();
    assert_eq!(tags.tags.len(), 1);
    ensure!(deployment.control_edge.accepted() > accepted);
    ensure!(deployment.gateway_link.accepted() >= 1);

    // The Gateway's own listener takes the operator's test notification through its tunnel.
    let mut test = binary(&[
        "test",
        "notification",
        "--gateway",
        &deployment.gateway_edge.url(),
    ]);
    test.env("SUPERTAG_OPERATOR_TOKEN", &deployment.tokens.operator);
    client_tls(
        &mut test,
        &deployment.pki.ca(),
        Some(&deployment.operator_leaf),
    );
    let output = run(test).await?;
    ensure!(
        output.status.success() && String::from_utf8_lossy(&output.stdout).starts_with("desktop: "),
        "test notification through the Gateway tunnel: {}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    ensure!(deployment.gateway_edge.accepted() >= 1);

    // The Control Plane requires a client certificate inside its tunnel too.
    let anonymous = Endpoint::from_shared(
        tunneled_uri(&deployment.control_edge.url())
            .map_err(|error| anyhow!(error))?
            .context("tunnel URL")?,
    )?
    .tls_config(
        ClientTlsConfig::new()
            .ca_certificate(Certificate::from_pem(std::fs::read(deployment.pki.ca())?)),
    )?;
    let anonymous = Target::tunnel(
        &deployment.control_edge.url(),
        anonymous,
        Some(&std::fs::read(deployment.pki.ca())?),
    )
    .map_err(|error| anyhow!(error))?;
    let refused = match anonymous.connect().await {
        Err(_) => true,
        Ok(channel) => supertag_protocol::negotiation::negotiate(
            channel,
            supertag_protocol::v2::ServiceRole::Gateway,
            supertag_protocol::v2::ServiceRole::ControlPlane,
        )
        .await
        .is_err(),
    };
    ensure!(
        refused,
        "the Control Plane accepted a tunnelled client without a certificate"
    );
    ensure!(deployment.running()?);
    Ok(())
}

// ---------------------------------------------------------------------------
// Severed tunnels

fn recording_adapter(directory: &Path) -> Result<(PathBuf, PathBuf)> {
    let script = directory.join("recording-adapter");
    let launches = directory.join("adapter-launches");
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\nprintf '%s\\n' \"$$\" >> '{}'\nexec '{}' \"$@\"\n",
            launches.display(),
            ADAPTER,
        ),
    )?;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700))?;
    Ok((script, launches))
}

/// While an Attempt runs, the edge in front of the Control Plane severs the Worker Host's
/// tunnel and refuses reconnects, then the Gateway's edge to the Control Plane severs the
/// Gateway's tunnel. Both clients classify the dropped tunnel as a retryable
/// transport failure, reconnect once the edges recover, and the Attempt finishes
/// exactly once with the adapter launched once.
async fn severed_tunnels_reconnect_and_the_attempt_completes_once(database: String) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let root = directory.path();
    let mut deployment = Deployment::start(&database, root).await?;
    // The Worker Host has its own edge, so operator checks never cross the partition.
    let host_edge = Edge::start(deployment.control_tunnel, &deployment.edge_leaf).await?;
    run_json(deployment.operator(&["tag", "put", "steady", "--instructions", "Answer"])).await?;
    let state = deployment
        .enroll("steady-host", "steady", &host_edge.url())
        .await?;
    let (adapter, launches) = recording_adapter(root)?;
    let release = root.join("release");
    let mut command = deployment.worker_host(&host_edge.url(), &state, &adapter);
    command.arg(format!(
        "--adapter-arg=--wait-for-file={}",
        release.display()
    ));
    let mut host = Service::spawn(command, root, "worker-host")?;

    let submitted = run_json(deployment.operator(&[
        "task",
        "submit",
        "--tag",
        "steady",
        "--session",
        "steady",
        "Survive the drop",
    ]))
    .await?;
    let task_id = submitted["task_id"].as_str().context("task_id")?.to_owned();
    let get = || deployment.native_operator(&["get", "task", &task_id]);
    let running = wait_for_task(
        get,
        |task| task["state"] == "TASK_STATE_RUNNING" && launches.exists(),
        || host.logs(),
    )
    .await?;
    let attempt = running["attempt_id"].clone();

    // Sever the Worker Host's tunnel mid-Attempt and keep refusing it for a while.
    let refused = host_edge.refused();
    host_edge.partition();
    sleep(Duration::from_secs(5)).await;
    ensure!(
        host_edge.refused() > refused,
        "the Worker Host never tried to reconnect: {}",
        host.logs()
    );
    let current = run_json(get()).await?;
    ensure!(
        current["state"] == "TASK_STATE_RUNNING" && current["attempt_id"] == attempt,
        "the Attempt did not survive the severed tunnel: {current}\n{}",
        host.logs()
    );
    ensure!(host.running()?, "the Worker Host stopped: {}", host.logs());
    let accepted = host_edge.accepted();
    host_edge.restore();
    let deadline = Instant::now() + Duration::from_secs(20);
    while host_edge.accepted() == accepted {
        ensure!(
            Instant::now() < deadline,
            "the Worker Host never reconnected: {}",
            host.logs()
        );
        sleep(Duration::from_millis(20)).await;
    }

    // Sever the Gateway's tunnel to the Control Plane; the Gateway reconnects on demand.
    deployment.gateway_link.partition();
    sleep(Duration::from_secs(3)).await;
    let accepted = deployment.gateway_link.accepted();
    deployment.gateway_link.restore();
    sleep(Duration::from_secs(4)).await;

    std::fs::write(&release, "")?;
    let task = wait_for_task(get, finished, || host.logs()).await?;
    assert_eq!(task["state"], "TASK_STATE_SUCCEEDED", "{task}");
    assert_eq!(task["result"], "Answer: Survive the drop []");
    assert_eq!(task["attempt_id"], attempt, "the Task was retried: {task}");
    let launched = std::fs::read_to_string(&launches)?.lines().count();
    assert_eq!(launched, 1, "the adapter ran {launched} times");
    ensure!(
        deployment.gateway_link.accepted() > accepted,
        "the Gateway never reconnected to the Control Plane"
    );
    ensure!(host.running()? && deployment.running()?);
    Ok(())
}

// ---------------------------------------------------------------------------
// A real HTTP/1.1-only reverse proxy

/// nginx in Docker, terminating TLS and forwarding only WebSocket upgrades over HTTP/1.1
/// to the Control Plane's tunnel listener. It closes a connection that carries nothing for 25
/// seconds, as platform proxies do.
struct Nginx {
    docker: std::ffi::OsString,
    name: String,
    address: SocketAddr,
}

impl Nginx {
    async fn start(
        docker: std::ffi::OsString,
        directory: &Path,
        leaf: &Leaf,
        backend: SocketAddr,
    ) -> Result<Self> {
        let config = directory.join("nginx");
        std::fs::create_dir_all(&config)?;
        std::fs::copy(&leaf.cert, config.join("edge.pem"))?;
        std::fs::copy(&leaf.key, config.join("edge.key"))?;
        std::fs::set_permissions(
            config.join("edge.key"),
            std::fs::Permissions::from_mode(0o644),
        )?;
        // Docker Desktop reaches host loopback through host.docker.internal; Linux shares
        // the host network instead.
        let linux = cfg!(target_os = "linux");
        let port = TcpListener::bind("127.0.0.1:0").await?.local_addr()?.port();
        let (listen, upstream) = if linux {
            (
                format!("127.0.0.1:{port}"),
                format!("127.0.0.1:{}", backend.port()),
            )
        } else {
            (
                "8443".to_owned(),
                format!("host.docker.internal:{}", backend.port()),
            )
        };
        std::fs::write(
            config.join("nginx.conf"),
            format!(
                r#"worker_processes 1;
events {{ worker_connections 256; }}
http {{
  access_log /dev/stdout;
  map $http_upgrade $websocket {{ websocket 1; default 0; }}
  server {{
    listen {listen} ssl;
    ssl_certificate /etc/edge/edge.pem;
    ssl_certificate_key /etc/edge/edge.key;
    location / {{
      if ($websocket = 0) {{ return 426; }}
      proxy_pass http://{upstream};
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
      proxy_set_header Host $host;
      proxy_read_timeout 25s;
      proxy_send_timeout 25s;
    }}
  }}
}}
"#
            ),
        )?;
        let name = format!("supertag-tunnel-nginx-{}", Uuid::new_v4().simple());
        let mut command = Command::new(&docker);
        command.args(["run", "--detach", "--rm", "--name", &name]);
        if linux {
            command.args(["--network", "host"]);
        } else {
            command.args(["--publish", &format!("127.0.0.1:{port}:8443")]);
        }
        command
            .arg("--volume")
            .arg(format!("{}:/etc/edge:ro", config.display()))
            .args([
                "nginx:1.27-alpine",
                "nginx",
                "-c",
                "/etc/edge/nginx.conf",
                "-g",
                "daemon off;",
            ]);
        let output = timeout(Duration::from_secs(300), command.output())
            .await
            .context("docker run timed out")??;
        ensure!(
            output.status.success(),
            "docker run failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let nginx = Self {
            docker,
            name,
            address: SocketAddr::from(([127, 0, 0, 1], port)),
        };
        let deadline = Instant::now() + STARTUP;
        while TcpStream::connect(nginx.address).await.is_err() {
            ensure!(Instant::now() < deadline, "nginx never listened");
            sleep(Duration::from_millis(100)).await;
        }
        Ok(nginx)
    }

    fn url(&self) -> String {
        format!("wss://{}/supertag", self.address)
    }

    /// Completed WebSocket connections, which nginx logs when each one closes.
    async fn closed_tunnels(&self) -> Result<usize> {
        let output = Command::new(&self.docker)
            .args(["logs", &self.name])
            .output()
            .await?;
        Ok(String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter(|line| line.contains("\" 101 "))
            .count())
    }
}

impl Drop for Nginx {
    fn drop(&mut self) {
        let _ = std::process::Command::new(&self.docker)
            .args(["rm", "--force", &self.name])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires Docker via SUPERTAG_RUST_TEST_DOCKER and pulls nginx:1.27-alpine"]
async fn tunnel_crosses_an_http1_only_nginx_and_outlives_its_idle_timeout() -> Result<()> {
    let Some(docker) = prerequisites::env("docker", "SUPERTAG_RUST_TEST_DOCKER")? else {
        return Ok(());
    };
    let directory = tempfile::tempdir()?;
    let root = directory.path();
    let database = format!("sqlite://{}?mode=rwc", root.join("control.db").display());
    let mut deployment = Deployment::start(&database, root).await?;
    let nginx = Nginx::start(
        docker,
        root,
        &deployment.edge_leaf,
        deployment.control_tunnel,
    )
    .await?;
    let public = nginx.url();

    // Native gRPC cannot cross this proxy: it speaks only HTTP/1.1.
    let native = run(deployment.operator_at(
        &format!("https://{}", nginx.address),
        &["get", "tags"],
        Some(&deployment.operator_leaf),
    ))
    .await?;
    ensure!(
        !native.status.success(),
        "native gRPC crossed the HTTP/1.1 proxy"
    );

    let operator =
        |args: &[&str]| deployment.operator_at(&public, args, Some(&deployment.operator_leaf));
    run_json(operator(&[
        "tag",
        "put",
        "edge",
        "--instructions",
        "Answer through nginx",
    ]))
    .await?;
    let state = deployment.enroll("nginx-host", "edge", &public).await?;
    let submitted = run_json(operator(&[
        "task",
        "submit",
        "--tag",
        "edge",
        "--session",
        "edge",
        "Cross the proxy",
    ]))
    .await?;
    let task_id = submitted["task_id"].as_str().context("task_id")?.to_owned();
    let mut host = deployment.worker_host(&public, &state, Path::new(ADAPTER));
    host.arg("--once");
    let output = run(host).await?;
    ensure!(
        output.status.success(),
        "Worker Host through nginx failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let task = run_json(operator(&["get", "task", &task_id])).await?;
    assert_eq!(task["state"], "TASK_STATE_SUCCEEDED", "{task}");
    assert_eq!(task["result"], "Answer through nginx: Cross the proxy []");

    // An idle tunnel outlives nginx's 25-second idle timeout because both ends ping.
    let mut client = OperatorClient::new(deployment.operator_channel(&public).await?);
    let list = |client: &mut OperatorClient<ProtocolChannel>| {
        let request = authenticated_request(
            ListTagsRequest::default(),
            &deployment.tokens.operator,
            None,
        );
        let mut client = client.clone();
        async move { anyhow::Ok(client.list_tags(request?).await?.into_inner()) }
    };
    list(&mut client).await?;
    // The CLI commands above each closed their tunnel, so nginx's log records closures.
    let closed = nginx.closed_tunnels().await?;
    ensure!(closed > 0, "nginx logged no closed WebSocket connection");
    sleep(Duration::from_secs(40)).await;
    assert_eq!(list(&mut client).await?.tags.len(), 1);
    assert_eq!(
        nginx.closed_tunnels().await?,
        closed,
        "nginx closed the idle tunnel"
    );
    ensure!(deployment.running()?);
    Ok(())
}
