//! How SuperTag's gRPC services reach each other: native gRPC over TCP, or the same
//! HTTP/2 connection carried inside a WebSocket for hosts that only forward HTTP/1.1.
//!
//! The tunnel is only a byte pipe. SuperTag's own TLS, including client certificates, runs
//! end to end inside it, so a platform proxy that terminates the outer `wss://` TLS sees
//! only ciphertext and cannot impersonate either side. A `wss://` target always requires
//! that inner TLS; a `ws://` target is cleartext and, like `http://`, is limited to loopback
//! by the caller.
//!
//! A tunnel listener also answers one plain HTTP request, `GET /healthz`, so a platform's
//! HTTP health check can probe it. It reports only that the listener is accepting
//! connections, and it is refused to browsers like every upgrade.
//!
//! Every target can reach its service through an HTTP `CONNECT` proxy ([`Proxy`]), and
//! every connection sends HTTP/2 keepalive pings, so a connection that a proxy or NAT
//! drops without closing it fails within [`KEEPALIVE_INTERVAL`] plus
//! [`KEEPALIVE_TIMEOUT`] instead of at a call's deadline.

mod proxy;
mod websocket;

use std::{
    fmt,
    future::Future,
    io,
    pin::Pin,
    sync::{Arc, OnceLock},
    task::{Context, Poll},
    time::Duration,
};

use hyper_util::rt::TokioIo;
use rustls::{
    ClientConfig, RootCertStore,
    pki_types::{CertificateDer, pem::PemObject},
};
use tokio::net::{TcpListener, TcpStream};
use tokio_stream::{Stream, wrappers::TcpListenerStream};
use tokio_tungstenite::{Connector, MaybeTlsStream};
use tonic::transport::{
    Channel, Endpoint,
    server::{Connected, TcpConnectInfo},
};
use tower_service::Service;
use url::Url;

pub use proxy::Proxy;
pub use websocket::{HEALTH_PATH, Replayed, WebSocketIo};

/// How often each end of a tunnel pings the other. Platform proxies close idle
/// connections (about 100 seconds on Cloudflare, five minutes on Render), and a
/// peer that stops answering for three intervals is treated as gone.
pub const PING_INTERVAL: Duration = Duration::from_secs(20);

/// How often an HTTP/2 connection is pinged, idle or not. Servers use the same values
/// for the connections they accept. With [`KEEPALIVE_TIMEOUT`], a connection dropped
/// without a close fails within 20 seconds: inside the Control Plane's 30-second
/// execution lease, so a Worker Host reconnects and renews its running Attempt before
/// the lease lapses and the Task becomes Uncertain.
pub const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(10);
/// How long a ping may go unanswered before the connection is treated as gone.
pub const KEEPALIVE_TIMEOUT: Duration = Duration::from_secs(10);

pub type Error = Box<dyn std::error::Error + Send + Sync>;

/// Where a SuperTag client connects: a native gRPC endpoint, or one reached through
/// a WebSocket tunnel. Every connection a target makes applies the endpoint's own
/// settings, including its TLS configuration, to the HTTP/2 connection.
#[derive(Clone)]
pub struct Target {
    endpoint: Endpoint,
    /// `None` uses tonic's own TCP connector: a native target reached directly.
    dialer: Option<Dialer>,
}

impl fmt::Debug for Target {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.url())
    }
}

impl Target {
    /// A native gRPC endpoint.
    pub fn native(endpoint: Endpoint) -> Self {
        Self {
            endpoint: keepalive(endpoint, KEEPALIVE_INTERVAL, KEEPALIVE_TIMEOUT),
            dialer: None,
        }
    }

    /// A `ws://` or `wss://` URL tunnelling the native gRPC `endpoint`, which must be
    /// [`tunneled_uri`] of the URL. A `wss://` URL trusts the platform's public
    /// certificate through the system roots and any extra PEM roots given here.
    pub fn tunnel(
        url: &str,
        endpoint: Endpoint,
        extra_roots: Option<&[u8]>,
    ) -> Result<Self, Error> {
        let parsed = Url::parse(url)?;
        let expected = tunneled_uri(url)?.ok_or("a tunnel URL must use ws or wss")?;
        if endpoint.uri().to_string().trim_end_matches('/') != expected {
            return Err("the tunnelled endpoint does not match the tunnel URL".into());
        }
        let outer = match parsed.scheme() {
            "wss" => Some(Arc::new(outer_tls(extra_roots)?)),
            _ => None,
        };
        let host = parsed.host().ok_or("a tunnel URL needs a host")?.to_owned();
        let port = parsed
            .port_or_known_default()
            .ok_or("a tunnel URL needs a port")?;
        Ok(Self {
            endpoint: keepalive(endpoint, KEEPALIVE_INTERVAL, KEEPALIVE_TIMEOUT),
            dialer: Some(Dialer {
                host,
                port,
                proxy: None,
                tunnel: Some(Tunnel {
                    url: Arc::new(parsed),
                    outer,
                    ping: PING_INTERVAL,
                }),
            }),
        })
    }

    /// The same target reached through `proxy`, unless the proxy's exceptions or a
    /// loopback address exclude its host. `None` leaves the target unchanged. A proxy URL
    /// SuperTag cannot use is an error only when the proxy applies to this target.
    pub fn proxy(mut self, proxy: Option<Proxy>) -> Result<Self, Error> {
        let Some(proxy) = proxy else {
            return Ok(self);
        };
        let (host, port) = match &self.dialer {
            Some(dialer) => (dialer.host.clone(), dialer.port),
            None => {
                let uri = self.endpoint.uri();
                let host = url::Host::parse(uri.host().ok_or("the endpoint needs a host")?)?;
                let port = uri
                    .port_u16()
                    .unwrap_or(if uri.scheme_str() == Some("https") {
                        443
                    } else {
                        80
                    });
                (host, port)
            }
        };
        if !proxy.applies_to(&host) {
            return Ok(self);
        }
        let server = proxy.server()?;
        let dialer = self.dialer.get_or_insert(Dialer {
            host,
            port,
            proxy: None,
            tunnel: None,
        });
        dialer.proxy = Some(Arc::new(server));
        Ok(self)
    }

    /// The same target with other HTTP/2 keepalive timing than [`KEEPALIVE_INTERVAL`]
    /// and [`KEEPALIVE_TIMEOUT`].
    pub fn keepalive(mut self, interval: Duration, timeout: Duration) -> Self {
        self.endpoint = keepalive(self.endpoint, interval, timeout);
        self
    }

    /// Whether connections go through an HTTP proxy.
    pub fn proxied(&self) -> bool {
        self.dialer
            .as_ref()
            .is_some_and(|dialer| dialer.proxy.is_some())
    }

    /// The URL this target was configured with. Stable across connections, so it can
    /// identify the target in saved state.
    pub fn url(&self) -> String {
        match self
            .dialer
            .as_ref()
            .and_then(|dialer| dialer.tunnel.as_ref())
        {
            Some(tunnel) => tunnel.url.to_string(),
            None => self.endpoint.uri().to_string(),
        }
    }

    /// Whether connections go through a WebSocket tunnel.
    pub fn tunnelled(&self) -> bool {
        self.dialer
            .as_ref()
            .is_some_and(|dialer| dialer.tunnel.is_some())
    }

    /// The same target with a different per-call timeout.
    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.endpoint = self.endpoint.timeout(timeout);
        self
    }

    pub async fn connect(&self) -> Result<Channel, tonic::transport::Error> {
        match &self.dialer {
            Some(dialer) => self.endpoint.connect_with_connector(dialer.clone()).await,
            None => self.endpoint.connect().await,
        }
    }

    /// A channel that connects on first use and reconnects after a failure.
    pub fn connect_lazy(&self) -> Channel {
        match &self.dialer {
            Some(dialer) => self.endpoint.connect_with_connector_lazy(dialer.clone()),
            None => self.endpoint.connect_lazy(),
        }
    }
}

/// The native gRPC URI a tunnel URL carries: `wss://` becomes `https://` and `ws://`
/// becomes `http://` on the same host and port, without the WebSocket path. `None` for
/// any other scheme.
pub fn tunneled_uri(url: &str) -> Result<Option<String>, Error> {
    let parsed = Url::parse(url)?;
    let scheme = match parsed.scheme() {
        "wss" => "https",
        "ws" => "http",
        _ => return Ok(None),
    };
    let host = match parsed.host().ok_or("a tunnel URL needs a host")? {
        url::Host::Domain(domain) => domain.to_owned(),
        url::Host::Ipv4(address) => address.to_string(),
        url::Host::Ipv6(address) => format!("[{address}]"),
    };
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("a tunnel URL must not carry credentials".into());
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err("a tunnel URL must not carry a query or fragment".into());
    }
    let port = parsed
        .port_or_known_default()
        .ok_or("a tunnel URL needs a port")?;
    Ok(Some(format!("{scheme}://{host}:{port}")))
}

fn keepalive(endpoint: Endpoint, interval: Duration, timeout: Duration) -> Endpoint {
    endpoint
        .http2_keep_alive_interval(interval)
        .keep_alive_timeout(timeout)
        .keep_alive_while_idle(true)
}

/// The system roots, loaded once per process: loading them can block for a while
/// (the macOS keychain), and clients build a new target on every reconnect.
fn system_roots() -> &'static RootCertStore {
    static ROOTS: OnceLock<RootCertStore> = OnceLock::new();
    ROOTS.get_or_init(|| {
        let mut roots = RootCertStore::empty();
        for certificate in rustls_native_certs::load_native_certs().certs {
            // Unparseable system roots are skipped, as every rustls client does.
            let _ = roots.add(certificate);
        }
        roots
    })
}

fn outer_tls(extra_roots: Option<&[u8]>) -> Result<ClientConfig, Error> {
    let mut roots = system_roots().clone();
    if let Some(pem) = extra_roots {
        for certificate in CertificateDer::pem_slice_iter(pem) {
            roots.add(certificate?)?;
        }
    }
    Ok(
        ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()?
            .with_root_certificates(roots)
            .with_no_client_auth(),
    )
}

/// Opens each HTTP/2 connection tonic asks for: TCP to the service or, through an HTTP
/// proxy, `CONNECT` to it, then the WebSocket upgrade when the target is a tunnel.
#[derive(Clone)]
struct Dialer {
    host: url::Host<String>,
    port: u16,
    proxy: Option<Arc<proxy::Server>>,
    tunnel: Option<Tunnel>,
}

#[derive(Clone)]
struct Tunnel {
    url: Arc<Url>,
    outer: Option<Arc<ClientConfig>>,
    ping: Duration,
}

impl Dialer {
    async fn dial(self) -> io::Result<TokioIo<Dialed>> {
        let stream = match &self.proxy {
            Some(proxy) => proxy.connect(&self.host, self.port).await?,
            None => proxy::open(&self.host, self.port).await?,
        };
        let Some(tunnel) = self.tunnel else {
            return Ok(TokioIo::new(Dialed::Tcp(stream)));
        };
        let connector = match &tunnel.outer {
            Some(config) => Connector::Rustls(config.clone()),
            None => Connector::Plain,
        };
        let (socket, _) = tokio_tungstenite::client_async_tls_with_config(
            tunnel.url.as_str(),
            stream,
            Some(websocket::config()),
            Some(connector),
        )
        .await
        .map_err(websocket::io_error)?;
        Ok(TokioIo::new(Dialed::Tunnel(Box::new(WebSocketIo::new(
            socket,
            tunnel.ping,
        )))))
    }
}

impl Service<http::Uri> for Dialer {
    type Response = TokioIo<Dialed>;
    type Error = io::Error;
    type Future = Pin<Box<dyn Future<Output = io::Result<Self::Response>> + Send>>;

    fn poll_ready(&mut self, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, _: http::Uri) -> Self::Future {
        Box::pin(self.clone().dial())
    }
}

/// A connection a [`Dialer`] opened.
enum Dialed {
    Tcp(TcpStream),
    Tunnel(Box<WebSocketIo<MaybeTlsStream<TcpStream>>>),
}

impl tokio::io::AsyncRead for Dialed {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Tcp(stream) => Pin::new(stream).poll_read(cx, buf),
            Self::Tunnel(stream) => Pin::new(stream.as_mut()).poll_read(cx, buf),
        }
    }
}

impl tokio::io::AsyncWrite for Dialed {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            Self::Tcp(stream) => Pin::new(stream).poll_write(cx, buf),
            Self::Tunnel(stream) => Pin::new(stream.as_mut()).poll_write(cx, buf),
        }
    }

    fn poll_write_vectored(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            Self::Tcp(stream) => Pin::new(stream).poll_write_vectored(cx, bufs),
            Self::Tunnel(stream) => Pin::new(stream.as_mut()).poll_write_vectored(cx, bufs),
        }
    }

    fn is_write_vectored(&self) -> bool {
        match self {
            Self::Tcp(stream) => stream.is_write_vectored(),
            Self::Tunnel(stream) => stream.is_write_vectored(),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Tcp(stream) => Pin::new(stream).poll_flush(cx),
            Self::Tunnel(stream) => Pin::new(stream.as_mut()).poll_flush(cx),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Tcp(stream) => Pin::new(stream).poll_shutdown(cx),
            Self::Tunnel(stream) => Pin::new(stream.as_mut()).poll_shutdown(cx),
        }
    }
}

/// One accepted connection: native gRPC, or gRPC that arrived inside a WebSocket.
/// A server's own TLS configuration applies to both.
pub enum Connection {
    Native(TcpStream),
    Tunnel(Box<WebSocketIo<Replayed<TcpStream>>>, TcpConnectInfo),
}

impl Connected for Connection {
    type ConnectInfo = TcpConnectInfo;

    fn connect_info(&self) -> TcpConnectInfo {
        match self {
            Self::Native(stream) => stream.connect_info(),
            Self::Tunnel(_, info) => info.clone(),
        }
    }
}

impl tokio::io::AsyncRead for Connection {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Native(stream) => Pin::new(stream).poll_read(cx, buf),
            Self::Tunnel(stream, _) => Pin::new(stream.as_mut()).poll_read(cx, buf),
        }
    }
}

impl tokio::io::AsyncWrite for Connection {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            Self::Native(stream) => Pin::new(stream).poll_write(cx, buf),
            Self::Tunnel(stream, _) => Pin::new(stream.as_mut()).poll_write(cx, buf),
        }
    }

    fn poll_write_vectored(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            Self::Native(stream) => Pin::new(stream).poll_write_vectored(cx, bufs),
            Self::Tunnel(stream, _) => Pin::new(stream.as_mut()).poll_write_vectored(cx, bufs),
        }
    }

    fn is_write_vectored(&self) -> bool {
        match self {
            Self::Native(stream) => stream.is_write_vectored(),
            Self::Tunnel(stream, _) => stream.is_write_vectored(),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Native(stream) => Pin::new(stream).poll_flush(cx),
            Self::Tunnel(stream, _) => Pin::new(stream.as_mut()).poll_flush(cx),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Native(stream) => Pin::new(stream).poll_shutdown(cx),
            Self::Tunnel(stream, _) => Pin::new(stream.as_mut()).poll_shutdown(cx),
        }
    }
}

/// The connections a gRPC server accepts: every native connection on `native`, plus
/// every completed WebSocket upgrade on `tunnel` when one is configured. Pass it to
/// tonic's `serve_with_incoming*`; the server's TLS then runs inside each tunnel.
pub fn incoming(native: TcpListener, tunnel: Option<TcpListener>) -> Incoming {
    Incoming {
        native: TcpListenerStream::new(native),
        tunnel: tunnel.map(|listener| websocket::Upgrades::spawn(listener, PING_INTERVAL)),
        prefer_tunnel: false,
    }
}

pub struct Incoming {
    native: TcpListenerStream,
    tunnel: Option<websocket::Upgrades>,
    prefer_tunnel: bool,
}

impl Stream for Incoming {
    type Item = io::Result<Connection>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        // Alternate which source goes first so neither can starve the other.
        this.prefer_tunnel = !this.prefer_tunnel;
        if this.prefer_tunnel
            && let Some(upgrades) = &mut this.tunnel
            && let Poll::Ready(Some(connection)) = upgrades.poll_next(cx)
        {
            return Poll::Ready(Some(Ok(connection)));
        }
        if let Poll::Ready(next) = Pin::new(&mut this.native).poll_next(cx) {
            return Poll::Ready(next.map(|result| result.map(Connection::Native)));
        }
        if !this.prefer_tunnel
            && let Some(upgrades) = &mut this.tunnel
            && let Poll::Ready(Some(connection)) = upgrades.poll_next(cx)
        {
            return Poll::Ready(Some(Ok(connection)));
        }
        Poll::Pending
    }
}
