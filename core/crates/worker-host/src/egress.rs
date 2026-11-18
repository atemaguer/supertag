//! The egress proxy that enforces a Task's network scope.
//!
//! One proxy runs for each Attempt whose Task has a network scope, on a loopback port, and only
//! for that Attempt. It accepts `CONNECT host:port` from a client that presents the Attempt's
//! proxy password, refuses an origin the scope does not allow before any TLS, and intercepts an
//! allowed one: it terminates TLS with a certificate from a CA generated for this Attempt, checks
//! each request's `Host` and method, replaces credential placeholders with the Worker Host's
//! secret where a rule binds that credential, and forwards the request over a verified TLS
//! connection to the address it resolved and checked. Every decision goes to the Attempt's
//! network log, without headers, bodies, or queries.
//!
//! The CA key lives only in this process and dies with the proxy. The harness's sandbox sees
//! the CA certificate, the proxy URL, and a placeholder for each credential, never a secret.

use std::{
    collections::{BTreeMap, HashMap},
    net::{IpAddr, SocketAddr},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, anyhow, ensure};
use base64::Engine as _;
use bytes::Bytes;
use http::{HeaderMap, HeaderValue, Request, Response, StatusCode, header};
use http_body_util::{BodyExt, Full, combinators::BoxBody};
use hyper::{body::Incoming, client::conn::http1::SendRequest};
use hyper_util::rt::TokioIo;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName};
use supertag_protocol::{
    network_scope::Rules,
    v2::{NetworkLog, NetworkRequestRecord, NetworkScope},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::Semaphore,
    task::JoinHandle,
    time,
};
use tokio_util::sync::CancellationToken;

/// Requests the log keeps; later ones are only counted.
pub const MAX_LOGGED_REQUESTS: usize = 500;
const MAX_LOGGED_PATH: usize = 200;
const MAX_HEAD_BYTES: usize = 16 * 1024;
const MAX_CONNECTIONS: usize = 256;
const HEAD_TIMEOUT: Duration = Duration::from_secs(30);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
/// The user name in the proxy URL; the password is the Attempt's.
const PROXY_USER: &str = "supertag";

type Body = BoxBody<Bytes, hyper::Error>;

/// A secret the proxy injects, and the placeholder the sandbox sees in its place.
#[derive(Clone)]
pub struct Credential {
    pub name: String,
    /// The variable that holds the placeholder in the sandbox, such as `GITHUB_TOKEN`.
    pub variable: String,
    pub placeholder: String,
    value: String,
}

impl Credential {
    /// A credential with a fresh placeholder for one Attempt.
    pub fn new(name: &str, variable: &str, value: String) -> Self {
        Self {
            name: name.to_owned(),
            variable: variable.to_owned(),
            placeholder: format!(
                "supertag-credential-{name}-{}",
                &uuid::Uuid::new_v4().simple().to_string()[..24]
            ),
            value,
        }
    }

    /// The secret, for redaction.
    pub fn value(&self) -> &str {
        &self.value
    }
}

/// What one proxy enforces.
pub struct Config {
    pub scope: NetworkScope,
    pub credentials: Vec<Credential>,
    /// Tests only: resolve these names to these addresses instead of DNS.
    #[doc(hidden)]
    pub resolve: BTreeMap<String, SocketAddr>,
    /// Whether a client must present the Attempt's proxy password. Claude Code's sandbox connects
    /// to a proxy port it is given without credentials, so its Attempts' proxies accept any local
    /// client and therefore carry no credentials.
    pub require_password: bool,
    /// Tests only: allow loopback and private destinations.
    #[doc(hidden)]
    pub allow_private: bool,
    /// Tests only: also trust these roots upstream.
    #[doc(hidden)]
    pub extra_roots: Vec<CertificateDer<'static>>,
}

impl Config {
    pub fn new(scope: NetworkScope, credentials: Vec<Credential>) -> Self {
        Self {
            scope,
            credentials,
            require_password: true,
            resolve: BTreeMap::new(),
            allow_private: false,
            extra_roots: vec![],
        }
    }
}

struct Authority {
    certificate: rcgen::Certificate,
    key: rcgen::KeyPair,
    leaves: Mutex<HashMap<String, Arc<rustls::ServerConfig>>>,
}

impl Authority {
    fn generate() -> Result<Self> {
        let key = rcgen::KeyPair::generate().context("generate the egress proxy's CA key")?;
        let mut params = rcgen::CertificateParams::default();
        params
            .distinguished_name
            .push(rcgen::DnType::CommonName, "SuperTag egress proxy");
        params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Constrained(0));
        params.key_usages = vec![
            rcgen::KeyUsagePurpose::KeyCertSign,
            rcgen::KeyUsagePurpose::CrlSign,
            rcgen::KeyUsagePurpose::DigitalSignature,
        ];
        validity(&mut params);
        let certificate = params
            .self_signed(&key)
            .context("sign the egress proxy's CA")?;
        Ok(Self {
            certificate,
            key,
            leaves: Mutex::default(),
        })
    }

    fn server_config(&self, host: &str) -> Result<Arc<rustls::ServerConfig>> {
        if let Some(config) = self.leaves.lock().expect("leaf cache").get(host) {
            return Ok(config.clone());
        }
        let key = rcgen::KeyPair::generate()?;
        let mut params = rcgen::CertificateParams::new(vec![host.to_owned()])?;
        params
            .distinguished_name
            .push(rcgen::DnType::CommonName, host);
        params.extended_key_usages = vec![rcgen::ExtendedKeyUsagePurpose::ServerAuth];
        params.key_usages = vec![rcgen::KeyUsagePurpose::DigitalSignature];
        validity(&mut params);
        let leaf = params.signed_by(&key, &self.certificate, &self.key)?;
        let mut config = rustls::ServerConfig::builder_with_provider(provider())
            .with_safe_default_protocol_versions()?
            .with_no_client_auth()
            .with_single_cert(
                vec![leaf.der().clone(), self.certificate.der().clone()],
                PrivateKeyDer::Pkcs8(key.serialize_der().into()),
            )?;
        config.alpn_protocols = vec![b"http/1.1".to_vec()];
        let config = Arc::new(config);
        self.leaves
            .lock()
            .expect("leaf cache")
            .insert(host.to_owned(), config.clone());
        Ok(config)
    }
}

fn validity(params: &mut rcgen::CertificateParams) {
    let now = ::time::OffsetDateTime::now_utc();
    params.not_before = now - ::time::Duration::hours(1);
    params.not_after = now + ::time::Duration::days(2);
}

fn provider() -> Arc<rustls::crypto::CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

/// The roots the proxy trusts upstream: the bundled web PKI and the host's own store.
fn system_roots() -> &'static rustls::RootCertStore {
    static ROOTS: OnceLock<rustls::RootCertStore> = OnceLock::new();
    ROOTS.get_or_init(|| {
        let mut roots = rustls::RootCertStore {
            roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
        };
        for certificate in rustls_native_certs::load_native_certs().certs {
            let _ = roots.add(certificate);
        }
        roots
    })
}

#[derive(Default)]
struct LogState {
    log: NetworkLog,
}

struct State {
    rules: Rules,
    credentials: Vec<Credential>,
    require_password: bool,
    password: String,
    authority: Authority,
    connector: tokio_rustls::TlsConnector,
    resolve: BTreeMap<String, SocketAddr>,
    allow_private: bool,
    log: Mutex<LogState>,
}

/// One Attempt's running proxy.
pub struct EgressProxy {
    address: SocketAddr,
    state: Arc<State>,
    stop: CancellationToken,
    task: JoinHandle<()>,
}

impl EgressProxy {
    pub async fn start(config: Config) -> Result<Self> {
        let Config {
            scope,
            credentials,
            require_password,
            resolve,
            allow_private,
            extra_roots,
        } = config;
        let mut roots = system_roots().clone();
        for root in extra_roots {
            roots.add(root).context("add an upstream root")?;
        }
        let mut client = rustls::ClientConfig::builder_with_provider(provider())
            .with_safe_default_protocol_versions()?
            .with_root_certificates(roots)
            .with_no_client_auth();
        client.alpn_protocols = vec![b"http/1.1".to_vec()];
        let state = Arc::new(State {
            rules: Rules::from(&scope),
            credentials,
            require_password,
            password: format!(
                "{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            ),
            authority: Authority::generate()?,
            connector: tokio_rustls::TlsConnector::from(Arc::new(client)),
            resolve,
            allow_private,
            log: Mutex::default(),
        });
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .context("start the egress proxy")?;
        let address = listener.local_addr()?;
        let stop = CancellationToken::new();
        // Claude Code's sandbox names the proxy `localhost`, which a client may resolve to ::1;
        // listen there on the same port too when it is free.
        if let Ok(loopback6) = TcpListener::bind(("::1", address.port())).await {
            tokio::spawn(serve(loopback6, state.clone(), stop.clone()));
        }
        let task = tokio::spawn(serve(listener, state.clone(), stop.clone()));
        Ok(Self {
            address,
            state,
            stop,
            task,
        })
    }

    /// `http://supertag:PASSWORD@127.0.0.1:PORT`, for the harness's proxy variables.
    pub fn url(&self) -> String {
        format!(
            "http://{PROXY_USER}:{}@{}",
            self.state.password, self.address
        )
    }

    pub fn address(&self) -> SocketAddr {
        self.address
    }

    /// The Attempt CA's certificate, PEM.
    pub fn ca_pem(&self) -> String {
        self.state.authority.certificate.pem()
    }

    pub fn credentials(&self) -> &[Credential] {
        &self.state.credentials
    }

    /// The log so far.
    pub fn log(&self) -> NetworkLog {
        self.state.log.lock().expect("network log").log.clone()
    }

    /// Stop accepting and drop every tunnel; the log is final.
    pub async fn stop(self) -> NetworkLog {
        self.stop.cancel();
        let _ = time::timeout(Duration::from_secs(2), self.task).await;
        self.state.log.lock().expect("network log").log.clone()
    }
}

async fn serve(listener: TcpListener, state: Arc<State>, stop: CancellationToken) {
    let connections = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    let mut running = tokio::task::JoinSet::new();
    loop {
        let accepted = tokio::select! {
            _ = stop.cancelled() => break,
            accepted = listener.accept() => accepted,
        };
        let Ok((stream, _)) = accepted else {
            continue;
        };
        let Ok(permit) = connections.clone().try_acquire_owned() else {
            drop(stream);
            continue;
        };
        let state = state.clone();
        let stop = stop.clone();
        running.spawn(async move {
            tokio::select! {
                _ = stop.cancelled() => {}
                _ = connection(state, stream) => {}
            }
            drop(permit);
        });
        while running.try_join_next().is_some() {}
    }
    running.shutdown().await;
}

struct Head {
    method: String,
    target: String,
    headers: Vec<(String, String)>,
}

async fn read_head(stream: &mut TcpStream) -> Result<Head> {
    let mut bytes = Vec::with_capacity(512);
    let mut byte = [0_u8; 1];
    while !bytes.ends_with(b"\r\n\r\n") {
        ensure!(bytes.len() < MAX_HEAD_BYTES, "request head is too large");
        let read = stream.read(&mut byte).await?;
        ensure!(read == 1, "connection closed before the request head ended");
        bytes.push(byte[0]);
    }
    let text = std::str::from_utf8(&bytes).context("request head is not UTF-8")?;
    let mut lines = text.split("\r\n");
    let mut request = lines.next().unwrap_or_default().split(' ');
    let (Some(method), Some(target), Some(version)) =
        (request.next(), request.next(), request.next())
    else {
        return Err(anyhow!("malformed request line"));
    };
    ensure!(version.starts_with("HTTP/1."), "unsupported HTTP version");
    let headers = lines
        .filter(|line| !line.is_empty())
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_owned()))
        .collect();
    Ok(Head {
        method: method.to_owned(),
        target: target.to_owned(),
        headers,
    })
}

fn authorized(head: &Head, password: &str) -> bool {
    let Some((_, value)) = head
        .headers
        .iter()
        .find(|(name, _)| name == "proxy-authorization")
    else {
        return false;
    };
    let Some(encoded) = value
        .get(..6)
        .filter(|scheme| scheme.eq_ignore_ascii_case("basic "))
        .map(|_| value[6..].trim())
    else {
        return false;
    };
    let Ok(decoded) = base64::engine::general_purpose::STANDARD.decode(encoded) else {
        return false;
    };
    let expected = format!("{PROXY_USER}:{password}");
    decoded.len() == expected.len()
        && decoded
            .iter()
            .zip(expected.as_bytes())
            .fold(0_u8, |difference, (left, right)| {
                difference | (left ^ right)
            })
            == 0
}

async fn reply(stream: &mut TcpStream, status: StatusCode, message: &str) {
    let response = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{message}",
        status.as_u16(),
        status.canonical_reason().unwrap_or(""),
        message.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

fn parse_authority(target: &str) -> Option<(String, u16)> {
    let (host, port) = target.rsplit_once(':')?;
    let port: u16 = port.parse().ok().filter(|port| *port != 0)?;
    let host = host.trim_start_matches('[').trim_end_matches(']');
    (!host.is_empty()).then(|| (host.to_ascii_lowercase(), port))
}

fn origin(host: &str, port: u16) -> String {
    if port == 443 {
        format!("https://{host}")
    } else {
        format!("https://{host}:{port}")
    }
}

async fn connection(state: Arc<State>, mut stream: TcpStream) {
    let head = match time::timeout(HEAD_TIMEOUT, read_head(&mut stream)).await {
        Ok(Ok(head)) => head,
        _ => return,
    };
    if state.require_password && !authorized(&head, &state.password) {
        // Not this Attempt's client: nothing to log against the Task.
        let response = "HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"supertag\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        let _ = stream.write_all(response.as_bytes()).await;
        return;
    }
    if !head.method.eq_ignore_ascii_case("CONNECT") {
        let (origin, path) = plain_target(&head.target);
        state.record(
            &head.method,
            &origin,
            &path,
            Err("only https:// origins are allowed"),
        );
        reply(
            &mut stream,
            StatusCode::FORBIDDEN,
            "SuperTag's egress proxy allows only https:// origins in the Task's network scope\n",
        )
        .await;
        return;
    }
    let Some((host, port)) = parse_authority(&head.target) else {
        reply(
            &mut stream,
            StatusCode::BAD_REQUEST,
            "invalid CONNECT target\n",
        )
        .await;
        return;
    };
    let origin = origin(&host, port);
    if !state.rules.allows_origin(&host, port) {
        state.record(
            "CONNECT",
            &origin,
            "",
            Err("origin is not in the Task's network scope"),
        );
        reply(
            &mut stream,
            StatusCode::FORBIDDEN,
            &format!("{origin} is not in the Task's network scope\n"),
        )
        .await;
        return;
    }
    let addresses = match state.resolve(&host, port).await {
        Ok(addresses) => addresses,
        Err(reason) => {
            state.record("CONNECT", &origin, "", Err(reason));
            reply(
                &mut stream,
                StatusCode::FORBIDDEN,
                &format!("{origin}: {reason}\n"),
            )
            .await;
            return;
        }
    };
    if stream
        .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        .await
        .is_err()
    {
        return;
    }
    let Ok(server) = state.authority.server_config(&host) else {
        return;
    };
    let Ok(tls) = tokio_rustls::TlsAcceptor::from(server).accept(stream).await else {
        state.record(
            "CONNECT",
            &origin,
            "",
            Err("the client's TLS handshake failed"),
        );
        return;
    };
    if tls
        .get_ref()
        .1
        .server_name()
        .is_some_and(|name| !name.eq_ignore_ascii_case(&host))
    {
        state.record(
            "CONNECT",
            &origin,
            "",
            Err("the TLS server name differs from the CONNECT target"),
        );
        return;
    }
    let tunnel = Arc::new(Tunnel {
        host,
        port,
        origin,
        addresses,
        upstream: tokio::sync::Mutex::new(None),
    });
    let service_state = state.clone();
    let service = hyper::service::service_fn(move |request| {
        let state = service_state.clone();
        let tunnel = tunnel.clone();
        async move { Ok::<_, std::convert::Infallible>(state.request(&tunnel, request).await) }
    });
    let _ = hyper::server::conn::http1::Builder::new()
        .timer(hyper_util::rt::TokioTimer::new())
        .header_read_timeout(HEAD_TIMEOUT)
        .serve_connection(TokioIo::new(tls), service)
        .await;
}

/// A request line target outside CONNECT: the origin and path to log.
fn plain_target(target: &str) -> (String, String) {
    match target.parse::<http::Uri>() {
        Ok(uri) => (
            match (uri.scheme_str(), uri.authority()) {
                (Some(scheme), Some(authority)) => format!("{scheme}://{authority}"),
                _ => String::new(),
            },
            uri.path().to_owned(),
        ),
        Err(_) => (String::new(), String::new()),
    }
}

struct Tunnel {
    host: String,
    port: u16,
    origin: String,
    addresses: Vec<SocketAddr>,
    upstream: tokio::sync::Mutex<Option<SendRequest<Incoming>>>,
}

fn deny(status: StatusCode, message: String) -> Response<Body> {
    let mut response = Response::new(
        Full::new(Bytes::from(message + "\n"))
            .map_err(|never| match never {})
            .boxed(),
    );
    *response.status_mut() = status;
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain"));
    response
}

/// Whether `address` is on the public internet: not loopback, private, link-local, shared
/// (CGNAT), unique local, multicast, documentation, or otherwise reserved.
pub fn public(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(v4) => {
            let [a, b, c, _] = v4.octets();
            !(v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_multicast()
                || v4.is_documentation()
                || a == 0
                || a >= 240
                || (a == 100 && (b & 0xc0) == 64)
                || (a == 198 && (b & 0xfe) == 18)
                || (a == 192 && b == 0 && c == 0))
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return public(IpAddr::V4(v4));
            }
            let segments = v6.segments();
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (segments[0] & 0xfe00) == 0xfc00
                || (segments[0] & 0xffc0) == 0xfe80
                || (segments[0] == 0x2001 && segments[1] == 0x0db8)
                || (segments[0] == 0x0064 && segments[1] == 0xff9b))
        }
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or_default()
}

const HOP_BY_HOP: &[&str] = &[
    "connection",
    "proxy-connection",
    "proxy-authorization",
    "proxy-authenticate",
    "keep-alive",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

impl State {
    async fn resolve(&self, host: &str, port: u16) -> Result<Vec<SocketAddr>, &'static str> {
        let addresses: Vec<SocketAddr> = if let Some(address) = self.resolve.get(host) {
            vec![*address]
        } else {
            match time::timeout(CONNECT_TIMEOUT, tokio::net::lookup_host((host, port))).await {
                Ok(Ok(found)) => found.collect(),
                _ => return Err("the host name could not be resolved"),
            }
        };
        if addresses.is_empty() {
            return Err("the host name could not be resolved");
        }
        if !self.allow_private && addresses.iter().any(|address| !public(address.ip())) {
            return Err("the host resolves to a loopback, private, or reserved address");
        }
        Ok(addresses)
    }

    /// Record a decision: `Ok(status, credential)` when forwarded, `Err(reason)` when denied.
    fn record(&self, method: &str, origin: &str, path: &str, outcome: Result<(u16, &str), &str>) {
        let mut state = self.log.lock().expect("network log");
        let log = &mut state.log;
        let allowed = outcome.is_ok();
        if allowed {
            log.allowed += 1;
        } else {
            log.denied += 1;
        }
        if log.requests.len() >= MAX_LOGGED_REQUESTS {
            log.unrecorded += 1;
            return;
        }
        let (status, credential, reason) = match outcome {
            Ok((status, credential)) => (u32::from(status), credential.to_owned(), String::new()),
            Err(reason) => (0, String::new(), reason.to_owned()),
        };
        log.requests.push(NetworkRequestRecord {
            at_ms: now_ms(),
            method: clean(method, 16).to_ascii_uppercase(),
            origin: clean(origin, 300),
            path: self.redact_path(path),
            allowed,
            reason,
            status,
            credential,
        });
    }

    /// The path without its query, at most 200 characters, with credential values and
    /// placeholders replaced.
    fn redact_path(&self, path: &str) -> String {
        let mut path = path.split(['?', '#']).next().unwrap_or_default().to_owned();
        for credential in &self.credentials {
            for value in [&credential.value, &credential.placeholder] {
                if !value.is_empty() {
                    path = path.replace(value.as_str(), "[credential]");
                }
            }
        }
        clean(&path, MAX_LOGGED_PATH)
    }

    async fn request(&self, tunnel: &Tunnel, mut request: Request<Incoming>) -> Response<Body> {
        let method = request.method().as_str().to_owned();
        let path = request
            .uri()
            .path_and_query()
            .map(|value| value.as_str().to_owned())
            .unwrap_or_else(|| "/".into());
        let denied = |state: &Self, reason: &str| {
            state.record(&method, &tunnel.origin, &path, Err(reason));
            deny(
                StatusCode::FORBIDDEN,
                format!(
                    "SuperTag's egress proxy refused {method} {}: {reason}",
                    tunnel.origin
                ),
            )
        };
        // The request must name the host the tunnel was opened and checked for.
        let named = request
            .uri()
            .authority()
            .map(|authority| authority.as_str().to_owned())
            .or_else(|| {
                request
                    .headers()
                    .get(header::HOST)
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_owned)
            });
        let matches = named.as_deref().is_some_and(|named| {
            let named = named.to_ascii_lowercase();
            named == format!("{}:{}", tunnel.host, tunnel.port)
                || (tunnel.port == 443 && named == tunnel.host)
        });
        if !matches {
            return denied(self, "the request's Host differs from the CONNECT target");
        }
        let bare = request.uri().path().to_owned();
        if !self.rules.allows(&tunnel.host, tunnel.port, &method, &bare) {
            return denied(self, "the method or path is not allowed for this origin");
        }
        if request.headers().contains_key(header::UPGRADE) {
            return denied(
                self,
                "connection upgrades such as WebSocket are not supported",
            );
        }
        let injected = match self.inject(request.headers_mut(), |name| {
            self.rules
                .binds(name, &tunnel.host, tunnel.port, &method, &bare)
        }) {
            Ok(injected) => injected,
            Err(reason) => return denied(self, &reason),
        };
        let connection_listed: Vec<String> = request
            .headers()
            .get_all(header::CONNECTION)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .flat_map(|value| value.split(','))
            .map(|name| name.trim().to_ascii_lowercase())
            .collect();
        for name in HOP_BY_HOP
            .iter()
            .map(|name| name.to_string())
            .chain(connection_listed)
        {
            request.headers_mut().remove(name.as_str());
        }
        let host_header = if tunnel.port == 443 {
            tunnel.host.clone()
        } else {
            format!("{}:{}", tunnel.host, tunnel.port)
        };
        if let Ok(value) = HeaderValue::from_str(&host_header) {
            request.headers_mut().insert(header::HOST, value);
        }
        *request.uri_mut() = match path.parse() {
            Ok(uri) => uri,
            Err(_) => return denied(self, "the request target is invalid"),
        };
        let response = match self.forward(tunnel, request).await {
            Ok(response) => response,
            Err(error) => {
                let reason = format!(
                    "the origin could not be reached: {}",
                    clean(&error.to_string(), 120)
                );
                self.record(&method, &tunnel.origin, &path, Err(&reason));
                return deny(
                    StatusCode::BAD_GATEWAY,
                    format!("SuperTag's egress proxy: {reason}"),
                );
            }
        };
        self.record(
            &method,
            &tunnel.origin,
            &path,
            Ok((
                response.status().as_u16(),
                injected.as_deref().unwrap_or(""),
            )),
        );
        response.map(|body| body.boxed())
    }

    /// Replace each credential's placeholder in the header values, also inside a Basic
    /// `Authorization` value, where `binds` allows that credential. A placeholder of a credential
    /// that is not bound here refuses the request. Returns the credential injected, if any.
    fn inject(
        &self,
        headers: &mut HeaderMap,
        binds: impl Fn(&str) -> bool,
    ) -> Result<Option<String>, String> {
        let mut injected = None;
        for (name, value) in headers.iter_mut() {
            let bytes = value.as_bytes();
            let present: Vec<&Credential> = self
                .credentials
                .iter()
                .filter(|credential| {
                    contains(bytes, credential.placeholder.as_bytes())
                        || (name == header::AUTHORIZATION
                            && basic(bytes).is_some_and(|decoded| {
                                contains(&decoded, credential.placeholder.as_bytes())
                            }))
                })
                .collect();
            if present.is_empty() {
                continue;
            }
            for credential in &present {
                if !binds(&credential.name) {
                    return Err(format!(
                        "credential {} is not allowed for this origin and method",
                        credential.name
                    ));
                }
            }
            let text = value
                .to_str()
                .map_err(|_| "a header holding a credential placeholder is not text".to_owned())?;
            let mut text = text.to_owned();
            if name == header::AUTHORIZATION
                && let Some(decoded) = basic(text.as_bytes())
            {
                let mut decoded = String::from_utf8(decoded)
                    .map_err(|_| "Basic credentials are not text".to_owned())?;
                for credential in &present {
                    decoded = decoded.replace(&credential.placeholder, &credential.value);
                }
                text = format!(
                    "Basic {}",
                    base64::engine::general_purpose::STANDARD.encode(decoded)
                );
            }
            for credential in &present {
                text = text.replace(&credential.placeholder, &credential.value);
            }
            let mut replaced = HeaderValue::from_str(&text)
                .map_err(|_| "a credential is not a valid header value".to_owned())?;
            replaced.set_sensitive(true);
            *value = replaced;
            injected = Some(present[0].name.clone());
        }
        Ok(injected)
    }

    async fn forward(
        &self,
        tunnel: &Tunnel,
        request: Request<Incoming>,
    ) -> Result<Response<Incoming>> {
        let mut upstream = tunnel.upstream.lock().await;
        let reusable = upstream.as_mut().is_some_and(|sender| !sender.is_closed());
        if !reusable {
            *upstream = Some(self.open(tunnel).await?);
        }
        let sender = upstream.as_mut().expect("upstream connection");
        sender.ready().await?;
        Ok(sender.send_request(request).await?)
    }

    async fn open(&self, tunnel: &Tunnel) -> Result<SendRequest<Incoming>> {
        let mut last = None;
        for address in &tunnel.addresses {
            match time::timeout(CONNECT_TIMEOUT, TcpStream::connect(address)).await {
                Ok(Ok(stream)) => {
                    let name = ServerName::try_from(tunnel.host.clone())?;
                    let tls = time::timeout(CONNECT_TIMEOUT, self.connector.connect(name, stream))
                        .await
                        .context("TLS handshake timed out")??;
                    let (sender, connection) =
                        hyper::client::conn::http1::handshake(TokioIo::new(tls)).await?;
                    tokio::spawn(connection);
                    return Ok(sender);
                }
                Ok(Err(error)) => last = Some(anyhow::Error::from(error)),
                Err(_) => last = Some(anyhow!("connection timed out")),
            }
        }
        Err(last.unwrap_or_else(|| anyhow!("no address to connect to")))
    }
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty()
        && haystack
            .windows(needle.len())
            .any(|window| window == needle)
}

/// The decoded credentials of a `Basic` authorization value.
fn basic(value: &[u8]) -> Option<Vec<u8>> {
    let text = std::str::from_utf8(value).ok()?;
    let encoded = text
        .get(..6)
        .filter(|scheme| scheme.eq_ignore_ascii_case("basic "))
        .map(|_| text[6..].trim())?;
    base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .ok()
}

fn clean(value: &str, limit: usize) -> String {
    value
        .chars()
        .filter(|character| !character.is_control())
        .take(limit)
        .collect()
}

/// Files and variables that give a harness's commands the proxy.
pub struct SandboxFiles {
    pub ca_certificate: std::path::PathBuf,
    pub ca_bundle: std::path::PathBuf,
}

/// Bundles of the host's system roots that a CA bundle starts from, first found.
const SYSTEM_BUNDLES: &[&str] = &[
    "/etc/ssl/cert.pem",
    "/etc/ssl/certs/ca-certificates.crt",
    "/etc/pki/tls/certs/ca-bundle.crt",
    "/etc/ssl/ca-bundle.pem",
];

/// Write the CA certificate and a bundle of the host's roots plus it into `directory`, readable
/// by the harness's sandbox.
pub fn write_sandbox_files(
    proxy: &EgressProxy,
    directory: &std::path::Path,
) -> Result<SandboxFiles> {
    std::fs::create_dir_all(directory)?;
    let ca = proxy.ca_pem();
    let ca_certificate = directory.join("egress-ca.pem");
    std::fs::write(&ca_certificate, &ca)?;
    let mut bundle = SYSTEM_BUNDLES
        .iter()
        .find_map(|path| std::fs::read_to_string(path).ok())
        .unwrap_or_default();
    if !bundle.is_empty() && !bundle.ends_with('\n') {
        bundle.push('\n');
    }
    bundle.push_str(&ca);
    let ca_bundle = directory.join("egress-ca-bundle.pem");
    std::fs::write(&ca_bundle, bundle)?;
    Ok(SandboxFiles {
        ca_certificate,
        ca_bundle,
    })
}

/// Variables the adapter receives: the proxy URL, the CA files, and each credential's variable
/// with its placeholder, as JSON.
pub const PROXY_VARIABLE: &str = "SUPERTAG_EGRESS_PROXY";
pub const CA_CERTIFICATE_VARIABLE: &str = "SUPERTAG_EGRESS_CA_CERTIFICATE";
pub const CA_BUNDLE_VARIABLE: &str = "SUPERTAG_EGRESS_CA_BUNDLE";
pub const PLACEHOLDERS_VARIABLE: &str = "SUPERTAG_EGRESS_PLACEHOLDERS";
/// Every variable [`adapter_environment`] sets.
pub const ADAPTER_VARIABLES: [&str; 4] = [
    PROXY_VARIABLE,
    CA_CERTIFICATE_VARIABLE,
    CA_BUNDLE_VARIABLE,
    PLACEHOLDERS_VARIABLE,
];

pub fn adapter_environment(
    proxy: &EgressProxy,
    files: &SandboxFiles,
) -> Result<Vec<(String, std::ffi::OsString)>> {
    let placeholders: BTreeMap<&str, &str> = proxy
        .credentials()
        .iter()
        .map(|credential| {
            (
                credential.variable.as_str(),
                credential.placeholder.as_str(),
            )
        })
        .collect();
    Ok(vec![
        (PROXY_VARIABLE.to_owned(), proxy.url().into()),
        (
            CA_CERTIFICATE_VARIABLE.to_owned(),
            files.ca_certificate.clone().into_os_string(),
        ),
        (
            CA_BUNDLE_VARIABLE.to_owned(),
            files.ca_bundle.clone().into_os_string(),
        ),
        (
            PLACEHOLDERS_VARIABLE.to_owned(),
            serde_json::to_string(&placeholders)?.into(),
        ),
    ])
}

/// An Attempt's running proxy, its sandbox files, and the variables its adapter receives.
pub(crate) struct AttemptEgress {
    proxy: EgressProxy,
    directory: std::path::PathBuf,
    pub(crate) environment: Vec<(String, std::ffi::OsString)>,
}

/// Start the proxy for an Attempt whose Task has `scope`, with the host credentials the scope
/// binds. A credential the scope names but this host lacks fails the Attempt before launch.
pub(crate) async fn start_for_attempt(
    scope: &NetworkScope,
    credentials: &[HostCredential],
    state_directory: &std::path::Path,
    attempt_id: &str,
    harness: supertag_protocol::v2::HarnessKind,
    remote: bool,
) -> Result<AttemptEgress> {
    let bound = supertag_protocol::network_scope::credentials(scope);
    let mut selected = Vec::new();
    for name in bound {
        let credential = credentials
            .iter()
            .find(|credential| credential.name == name)
            .with_context(|| format!("this Worker Host has no network credential {name}"))?;
        selected.push(credential.for_attempt());
    }
    let mut config = Config::new(scope.clone(), selected);
    // A remote sandbox's commands reach the proxy through the relay with the password; only
    // Claude Code's local sandbox cannot send it.
    config.require_password = remote || harness != supertag_protocol::v2::HarnessKind::ClaudeCode;
    ensure!(
        config.require_password || config.credentials.is_empty(),
        "Claude Code's sandbox cannot authenticate to the egress proxy, so it carries no network credentials"
    );
    let proxy = EgressProxy::start(config).await?;
    use sha2::Digest as _;
    let directory = state_directory
        .join("egress")
        .join(format!("{:x}", sha2::Sha256::digest(attempt_id.as_bytes())));
    let files = write_sandbox_files(&proxy, &directory)?;
    let environment = adapter_environment(&proxy, &files)?;
    Ok(AttemptEgress {
        proxy,
        directory,
        environment,
    })
}

impl AttemptEgress {
    /// What a remote sandbox needs for this Attempt's network: a fresh relay token, the proxy
    /// URL through the relay on loopback (with the Attempt's proxy password), each credential's
    /// placeholder, and the CA. No secret: the proxy swaps placeholders on this host.
    pub(crate) fn remote(&self, client_port: u16) -> supertag_protocol::v2::RemoteWorkspaceEgress {
        let proxy = self.proxy.url().replace(
            &self.proxy.address().to_string(),
            &format!("127.0.0.1:{client_port}"),
        );
        let mut variables = std::collections::HashMap::new();
        for name in ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"] {
            variables.insert(name.to_owned(), proxy.clone());
        }
        for credential in self.proxy.credentials() {
            variables.insert(credential.variable.clone(), credential.placeholder.clone());
        }
        supertag_protocol::v2::RemoteWorkspaceEgress {
            proxy: format!("127.0.0.1:{}", self.proxy.address().port()),
            variables,
            ca_pem: self.proxy.ca_pem(),
        }
    }

    /// Stop the proxy, remove its files, and report its log while the host still owns the
    /// Attempt. Best effort: a lost report leaves the Task without its network log.
    pub(crate) async fn finish(
        self,
        host: &mut crate::RegisteredHost,
        attempt: &crate::journal::Attempt,
        token: &str,
    ) {
        let log = self.proxy.stop().await;
        let _ = std::fs::remove_dir_all(&self.directory);
        let message = supertag_protocol::v2::ReportNetworkLogRequest {
            attempt: Some(attempt.inspect()),
            log: Some(log),
        };
        let Ok(mut request) = supertag_protocol::authenticated_request(message, token, None) else {
            return;
        };
        request.set_timeout(Duration::from_secs(10));
        if host.report_network_log(request).await.is_err() {
            supertag_protocol::terminal_text::warn(&format!(
                "Task {} Attempt {}: the Control Plane did not record its network log",
                attempt.task_id, attempt.attempt_id
            ));
        }
    }
}

/// A named credential this host injects: its name, the variable the sandbox sees, and the value
/// read from the host's environment.
#[derive(Clone)]
pub struct HostCredential {
    pub name: String,
    pub variable: String,
    value: String,
}

impl HostCredential {
    pub fn new(name: &str, variable: &str, value: String) -> Result<Self> {
        supertag_protocol::network_scope::validate_credential_name(name)
            .map_err(anyhow::Error::msg)?;
        validate_variable(variable)?;
        ensure!(
            !value.is_empty() && value.len() <= 16 * 1024 && !value.chars().any(char::is_control),
            "network credential {name} must be one line of at most 16 KiB"
        );
        Ok(Self {
            name: name.to_owned(),
            variable: variable.to_owned(),
            value,
        })
    }

    /// A fresh placeholder for one Attempt.
    pub fn for_attempt(&self) -> Credential {
        Credential::new(&self.name, &self.variable, self.value.clone())
    }

    pub fn value(&self) -> &str {
        &self.value
    }
}

/// The host variable that holds credential `name`'s value, such as
/// `SUPERTAG_NETWORK_CREDENTIAL_GITHUB` for `github`.
pub fn credential_source_variable(name: &str) -> String {
    format!(
        "SUPERTAG_NETWORK_CREDENTIAL_{}",
        name.to_ascii_uppercase().replace('-', "_")
    )
}

/// Parse `NAME=VARIABLE` from `--network-credential`.
pub fn parse_credential_flag(value: &str) -> Result<(String, String)> {
    let (name, variable) = value
        .split_once('=')
        .context("give --network-credential as NAME=VARIABLE, such as github=GITHUB_TOKEN")?;
    supertag_protocol::network_scope::validate_credential_name(name).map_err(anyhow::Error::msg)?;
    validate_variable(variable)?;
    Ok((name.to_owned(), variable.to_owned()))
}

/// Variables the harness or the proxy set themselves, or that steer a process, never a
/// credential's placeholder.
const RESERVED_VARIABLES: &[&str] = &[
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "PWD",
    "TERM",
    "NO_PROXY",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "REQUESTS_CA_BUNDLE",
    "CURL_CA_BUNDLE",
    "NODE_EXTRA_CA_CERTS",
    "NODE_OPTIONS",
    "PIP_CERT",
    "GIT_SSL_CAINFO",
];
const RESERVED_PREFIXES: &[&str] = &[
    "SUPERTAG_",
    "CODEX_",
    "OPENAI_",
    "ANTHROPIC_",
    "CLAUDE_",
    "CURSOR_",
    "LD_",
    "DYLD_",
    "GIT_",
    "NPM_CONFIG_",
    "XDG_",
    "LC_",
];

fn validate_variable(variable: &str) -> Result<()> {
    ensure!(
        !variable.is_empty()
            && variable.len() <= 64
            && variable.starts_with(|c: char| c.is_ascii_uppercase() || c == '_')
            && variable
                .chars()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_'),
        "network credential variable {variable:?} must be uppercase letters, digits, and _"
    );
    ensure!(
        !RESERVED_VARIABLES.contains(&variable)
            && !variable.ends_with("_PROXY")
            && !RESERVED_PREFIXES
                .iter()
                .any(|prefix| variable.starts_with(prefix)),
        "network credential variable {variable} is reserved; choose another name, such as GITHUB_TOKEN"
    );
    Ok(())
}

/// A TLS origin for tests of the proxy, here and in harness probes.
#[cfg(any(test, feature = "test-fixtures"))]
pub mod fixture {
    use super::*;

    /// A TLS origin on loopback for `host`, with a self-signed certificate, that answers each
    /// request with its method, path, and `Authorization` header.
    pub async fn origin_server(host: &str) -> (SocketAddr, CertificateDer<'static>) {
        let key = rcgen::KeyPair::generate().unwrap();
        let certificate = rcgen::CertificateParams::new(vec![host.to_owned()])
            .unwrap()
            .self_signed(&key)
            .unwrap();
        let der = certificate.der().clone();
        let mut config = rustls::ServerConfig::builder_with_provider(provider())
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(
                vec![der.clone()],
                PrivateKeyDer::Pkcs8(key.serialize_der().into()),
            )
            .unwrap();
        config.alpn_protocols = vec![b"http/1.1".to_vec()];
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    return;
                };
                let acceptor = acceptor.clone();
                tokio::spawn(async move {
                    let Ok(tls) = acceptor.accept(stream).await else {
                        return;
                    };
                    let service =
                        hyper::service::service_fn(|request: Request<Incoming>| async move {
                            let authorization = request
                                .headers()
                                .get(header::AUTHORIZATION)
                                .map(|value| value.to_str().unwrap_or_default().to_owned())
                                .unwrap_or_default();
                            let body = format!(
                                "{} {} {authorization}",
                                request.method(),
                                request.uri().path()
                            );
                            Ok::<_, std::convert::Infallible>(Response::new(Full::new(
                                Bytes::from(body),
                            )))
                        });
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(TokioIo::new(tls), service)
                        .await;
                });
            }
        });
        (address, der)
    }
}

/// Whether Claude Code's own sandbox can run here: always on macOS (Seatbelt). On Linux it needs
/// bubblewrap and socat on `PATH`, and a nested user namespace inside bubblewrap's, where the
/// sandbox runtime's seccomp helper writes its own `setgroups`. Ubuntu's AppArmor policy for
/// bubblewrap (`bwrap-userns-restrict`, as on GitHub's hosted runners) strips capabilities there,
/// and the sandbox cannot start. A Claude Code lane reports the answer so placement sends it
/// Tasks whose commands must stay inside a network scope only when it holds; the adapter still
/// fails closed if the sandbox does not start. Checked once per process.
pub fn claude_sandbox_available() -> bool {
    static AVAILABLE: OnceLock<bool> = OnceLock::new();
    *AVAILABLE.get_or_init(|| match std::env::consts::OS {
        "macos" => true,
        "linux" => linux_sandbox_available(),
        _ => false,
    })
}

fn on_path(tool: &str) -> Option<std::path::PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|directory| directory.join(tool))
        .find(|path| path.is_file())
}

/// Runs `unshare --user --map-root-user true` inside a bubblewrap user and network namespace,
/// as the sandbox runtime's seccomp helper nests one, within five seconds.
fn linux_sandbox_available() -> bool {
    let (Some(bwrap), Some(_), Some(unshare)) =
        (on_path("bwrap"), on_path("socat"), on_path("unshare"))
    else {
        return false;
    };
    let Ok(mut child) = std::process::Command::new(bwrap)
        .args(["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"])
        .args(["--unshare-user", "--unshare-net", "--die-with-parent", "--"])
        .arg(unshare)
        .args(["--user", "--map-root-user", "true"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    else {
        return false;
    };
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

#[cfg(test)]
#[path = "../../../test-support/prerequisites.rs"]
mod prerequisites;

#[cfg(test)]
mod tests;
