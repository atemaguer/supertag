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
use supertag_transport::{Target, tunneled_uri};
use tonic::transport::{Certificate, ClientTlsConfig, Endpoint, Identity, Server, ServerTlsConfig};

/// A gRPC server builder for a service listening on `listen` and, when set, accepting
/// WebSocket tunnels on `websocket`. TLS configured here also runs inside each tunnel.
pub async fn server(listen: SocketAddr, websocket: Option<SocketAddr>) -> Result<Server> {
    let identity = identity("SUPERTAG_TLS_CERT_FILE", "SUPERTAG_TLS_KEY_FILE").await?;
    let client_ca = read_pem("SUPERTAG_TLS_CLIENT_CA_FILE").await?;
    if let Some(identity) = identity {
        let mut tls = ServerTlsConfig::new().identity(identity);
        if let Some(ca) = client_ca {
            tls = tls.client_ca_root(Certificate::from_pem(ca));
        }
        return Ok(Server::builder().tls_config(tls)?);
    }
    ensure!(
        client_ca.is_none(),
        "client CA configuration requires server TLS"
    );
    ensure!(
        listen.ip().is_loopback() && websocket.is_none_or(|address| address.ip().is_loopback()),
        "listeners outside loopback require TLS"
    );
    Ok(Server::builder())
}

/// Connects to a Control Plane as an operator client and negotiates the protocol
/// version every later call names; the Control Plane refuses calls that skip this.
pub async fn operator_channel(target: &Target) -> Result<ProtocolChannel> {
    let channel = target.connect().await?;
    Ok(connect(channel, ServiceRole::Client, ServiceRole::ControlPlane).await?)
}

/// Connects to a Gateway as an operator client, for its test notification.
pub async fn gateway_operator_channel(target: &Target) -> Result<ProtocolChannel> {
    let channel = target.connect().await?;
    Ok(connect(channel, ServiceRole::Client, ServiceRole::Gateway).await?)
}

pub async fn endpoint(uri: String) -> Result<Target> {
    endpoint_with_timeout(uri, Duration::from_secs(15)).await
}

/// TLS files saved with a Control Plane profile. They replace the TLS environment
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
    configured_endpoint(uri, timeout, files).await
}

pub async fn endpoint_with_timeout(uri: String, timeout: Duration) -> Result<Target> {
    configured_endpoint(uri, timeout, None).await
}

/// `https://` and `http://` dial native gRPC. `wss://` and `ws://` carry the same gRPC
/// connection through a WebSocket tunnel; `wss://` always runs SuperTag's TLS inside it,
/// and `ws://` is cleartext and loopback-only, like `http://`.
async fn configured_endpoint(
    uri: String,
    timeout: Duration,
    files: Option<&TlsFiles>,
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
    if tunnel.is_none() {
        return Ok(Target::native(endpoint));
    }
    // The platform's edge certificate is checked against the system roots and, for a
    // private platform, the same server CA the inner TLS trusts.
    Target::tunnel(&uri, endpoint, server_ca.as_deref())
        .map_err(|error| anyhow!("invalid tunnel endpoint: {error}"))
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
