use std::{
    net::{IpAddr, SocketAddr},
    path::PathBuf,
    time::Duration,
};

use anyhow::{Context, Result, bail, ensure};
use supertag_protocol::{
    negotiation::{ProtocolChannel, connect},
    v2::ServiceRole,
};
use tonic::transport::{Certificate, ClientTlsConfig, Endpoint, Identity, Server, ServerTlsConfig};

pub async fn server(listen: SocketAddr, private: bool) -> Result<Server> {
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
        return Ok(Server::builder().tls_config(tls)?);
    }
    ensure!(
        client_ca.is_none(),
        "client CA configuration requires server TLS"
    );
    ensure!(
        listen.ip().is_loopback(),
        "listeners outside loopback require TLS"
    );
    Ok(Server::builder())
}

/// Connects to a Gateway as an operator client and negotiates the protocol
/// version every later call names; the Gateway refuses calls that skip this.
pub async fn operator_channel(endpoint: &Endpoint) -> Result<ProtocolChannel> {
    let channel = endpoint.connect().await?;
    Ok(connect(channel, ServiceRole::Operator, ServiceRole::Gateway).await?)
}

pub async fn endpoint(uri: String, private: bool) -> Result<Endpoint> {
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
) -> Result<Endpoint> {
    configured_endpoint(uri, false, timeout, files).await
}

pub async fn endpoint_with_timeout(
    uri: String,
    private: bool,
    timeout: Duration,
) -> Result<Endpoint> {
    configured_endpoint(uri, private, timeout, None).await
}

async fn configured_endpoint(
    uri: String,
    private: bool,
    timeout: Duration,
    files: Option<&TlsFiles>,
) -> Result<Endpoint> {
    let mut endpoint = Endpoint::from_shared(uri)?
        .connect_timeout(Duration::from_secs(5))
        .timeout(timeout);
    match endpoint.uri().scheme_str() {
        Some("https") => {
            let mut tls = ClientTlsConfig::new();
            let ca = match files {
                Some(files) => read_file(files.server_ca.as_ref()).await?,
                None => read_pem("SUPERTAG_SERVER_CA_FILE").await?,
            };
            if let Some(ca) = ca {
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
        _ => bail!("endpoint must use http or https"),
    }
    Ok(endpoint)
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
