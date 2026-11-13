use std::{
    net::{IpAddr, SocketAddr},
    path::PathBuf,
    time::Duration,
};

use anyhow::{Context, Result, anyhow, bail, ensure};
use supertag_protocol::{
    negotiation::{ProtocolChannel, connect},
    v2::ServiceRole,
};
use supertag_transport::{KEEPALIVE_INTERVAL, KEEPALIVE_TIMEOUT, Proxy, Target, tunneled_uri};
use tonic::transport::{Certificate, ClientTlsConfig, Endpoint, Identity, Server, ServerTlsConfig};

/// A gRPC server builder for a service listening on `listen` and, when set, accepting
/// WebSocket tunnels on `websocket`. TLS configured here also runs inside each tunnel.
pub async fn server(
    listen: SocketAddr,
    websocket: Option<SocketAddr>,
    private: bool,
) -> Result<Server> {
    let identity = identity("SUPERTAG_TLS_CERT_FILE", "SUPERTAG_TLS_KEY_FILE").await?;
    let client_ca = read_pem("SUPERTAG_TLS_CLIENT_CA_FILE").await?;
    if let Some(identity) = identity {
        ensure!(
            !private || client_ca.is_some(),
            "Control Plane TLS requires a client certificate authority",
        );
        let mut tls = ServerTlsConfig::new().identity(identity);
        if let Some(ca) = client_ca {
            tls = tls.client_ca_root(Certificate::from_pem(ca));
        }
        return Ok(keepalive(Server::builder()).tls_config(tls)?);
    }
    ensure!(
        client_ca.is_none(),
        "client CA configuration requires server TLS"
    );
    ensure!(
        listen.ip().is_loopback() && websocket.is_none_or(|address| address.ip().is_loopback()),
        "listeners outside loopback require TLS"
    );
    Ok(keepalive(Server::builder()))
}

/// Pings every accepted HTTP/2 connection, so a client that vanished without closing its
/// connection releases what it held (a Watch stream, an upload) within a bounded time.
fn keepalive(server: Server) -> Server {
    server
        .http2_keepalive_interval(Some(KEEPALIVE_INTERVAL))
        .http2_keepalive_timeout(Some(KEEPALIVE_TIMEOUT))
}

/// Connects to a Gateway as an operator client and negotiates the protocol
/// version every later call names; the Gateway refuses calls that skip this.
pub async fn operator_channel(target: &Target) -> Result<ProtocolChannel> {
    let channel = target.connect().await?;
    Ok(connect(channel, ServiceRole::Operator, ServiceRole::Gateway).await?)
}

pub async fn endpoint(uri: String, private: bool) -> Result<Target> {
    endpoint_with_timeout(uri, private, Duration::from_secs(15)).await
}

/// TLS files saved with a Gateway profile. They replace the TLS environment
/// variables for that connection.
#[derive(Clone, Debug, Default)]
pub struct TlsFiles {
    pub server_ca: Option<PathBuf>,
    pub client_cert: Option<PathBuf>,
    pub client_key: Option<PathBuf>,
}

/// A public operator endpoint, using saved profile TLS files when present.
pub async fn operator_endpoint(
    uri: String,
    timeout: Duration,
    files: Option<&TlsFiles>,
) -> Result<Target> {
    configured_endpoint(uri, false, timeout, files, Proxy::from_env()).await
}

pub async fn endpoint_with_timeout(
    uri: String,
    private: bool,
    timeout: Duration,
) -> Result<Target> {
    configured_endpoint(uri, private, timeout, None, Proxy::from_env()).await
}

/// A private endpoint reached through `proxy` instead of the one this process's
/// environment names: a supervisor's Worker Host reads it from `env_file` too.
pub async fn endpoint_through(uri: String, proxy: Option<Proxy>) -> Result<Target> {
    configured_endpoint(uri, false, Duration::from_secs(15), None, proxy).await
}

/// `https://` and `http://` dial native gRPC. `wss://` and `ws://` carry the same gRPC
/// connection through a WebSocket tunnel; `wss://` always runs SuperTag's TLS inside it,
/// and `ws://` is cleartext and loopback-only, like `http://`. Either goes through the
/// HTTP proxy `HTTPS_PROXY` names unless `NO_PROXY` lists its host or the host is loopback.
async fn configured_endpoint(
    uri: String,
    private: bool,
    timeout: Duration,
    files: Option<&TlsFiles>,
    proxy: Option<Proxy>,
) -> Result<Target> {
    let tunnel = tunneled_uri(&uri).map_err(|error| anyhow!("invalid endpoint URL: {error}"))?;
    let native = tunnel.clone().unwrap_or_else(|| uri.clone());
    // A tunnel dial also covers the outer TLS and the WebSocket upgrade, and a platform
    // proxy may hold the upgrade while it starts a container that scaled to zero.
    let connect_timeout = Duration::from_secs(if tunnel.is_some() { 30 } else { 5 });
    let mut endpoint = Endpoint::from_shared(native)?
        .connect_timeout(connect_timeout)
        .timeout(timeout);
    let mut server_ca = None;
    match endpoint.uri().scheme_str() {
        Some("https") => {
            let mut tls = ClientTlsConfig::new();
            server_ca = match files {
                Some(files) => read_file(files.server_ca.as_ref()).await?,
                None => read_pem("SUPERTAG_SERVER_CA_FILE").await?,
            };
            if let Some(ca) = server_ca.clone() {
                tls = tls.ca_certificate(Certificate::from_pem(ca));
            } else if private {
                bail!("private Control Plane TLS requires SUPERTAG_SERVER_CA_FILE");
            } else {
                tls = tls.with_native_roots();
            }
            let identity = match files {
                Some(files) => match (
                    read_file(files.client_cert.as_ref()).await?,
                    read_file(files.client_key.as_ref()).await?,
                ) {
                    (Some(cert), Some(key)) => Some(Identity::from_pem(cert, key)),
                    (None, None) => None,
                    _ => bail!("configure both the TLS certificate and key"),
                },
                None => identity("SUPERTAG_CLIENT_CERT_FILE", "SUPERTAG_CLIENT_KEY_FILE").await?,
            };
            ensure!(
                !private || identity.is_some(),
                "private Control Plane TLS requires a client identity"
            );
            if let Some(identity) = identity {
                tls = tls.identity(identity);
            }
            endpoint = endpoint.tls_config(tls)?;
        }
        Some("http") => {
            let host = endpoint.uri().host().context("endpoint host required")?;
            let loopback = host
                .trim_matches(['[', ']'])
                .parse::<IpAddr>()
                .is_ok_and(|address| address.is_loopback());
            ensure!(
                loopback,
                "cleartext endpoint must use a loopback IP address"
            );
        }
        _ => bail!("endpoint must use https, wss, or a loopback http or ws URL"),
    }
    let target = if tunnel.is_none() {
        Target::native(endpoint)
    } else {
        // The platform's edge certificate is checked against the system roots and, for a
        // private platform, the same server CA the inner TLS trusts.
        Target::tunnel(&uri, endpoint, server_ca.as_deref())
            .map_err(|error| anyhow!("invalid tunnel endpoint: {error}"))?
    };
    target
        .proxy(proxy)
        .map_err(|error| anyhow!("invalid endpoint URL: {error}"))
}

async fn identity(cert: &str, key: &str) -> Result<Option<Identity>> {
    match (read_pem(cert).await?, read_pem(key).await?) {
        (Some(cert), Some(key)) => Ok(Some(Identity::from_pem(cert, key))),
        (None, None) => Ok(None),
        _ => bail!("configure both the TLS certificate and key"),
    }
}

async fn read_pem(name: &str) -> Result<Option<Vec<u8>>> {
    match std::env::var_os(name) {
        Some(path) => Ok(Some(
            tokio::fs::read(PathBuf::from(path))
                .await
                .with_context(|| format!("read {name}"))?,
        )),
        None => Ok(None),
    }
}

async fn read_file(path: Option<&PathBuf>) -> Result<Option<Vec<u8>>> {
    match path {
        Some(path) => Ok(Some(
            tokio::fs::read(path)
                .await
                .with_context(|| format!("read {}", path.display()))?,
        )),
        None => Ok(None),
    }
}
