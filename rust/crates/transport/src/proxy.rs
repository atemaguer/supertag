//! HTTP `CONNECT` proxies, chosen as most HTTP clients choose them: `https_proxy` or
//! `HTTPS_PROXY` names the proxy, and `no_proxy` or `NO_PROXY` lists hosts reached
//! directly. A loopback target is always reached directly.
//!
//! The proxy only relays bytes: SuperTag's TLS, and the outer TLS of a `wss://`
//! tunnel, run end to end through it.

use std::{fmt, io, net::IpAddr};

use base64::{Engine, engine::general_purpose::STANDARD};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
};
use url::{Host, Url};

use crate::Error;

/// The most a proxy's `CONNECT` response head may hold.
const MAX_RESPONSE_HEAD: usize = 8 * 1024;

/// An HTTP proxy that SuperTag clients reach their services through with `CONNECT`.
///
/// A proxy URL SuperTag cannot use is an error only for a connection that would go
/// through it: a loopback or `NO_PROXY` target still connects directly.
#[derive(Clone)]
pub struct Proxy {
    server: Result<Server, String>,
    bypass: Vec<Bypass>,
}

/// The proxy URL without its credentials.
impl fmt::Debug for Proxy {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.server {
            Ok(server) => write!(f, "http://{}", authority(&server.host, server.port)),
            Err(_) => f.write_str("unusable proxy"),
        }
    }
}

/// Where the proxy listens, and the `Proxy-Authorization` its URL's credentials give.
#[derive(Clone)]
pub(crate) struct Server {
    host: Host<String>,
    port: u16,
    authorization: Option<String>,
}

#[derive(Clone)]
enum Bypass {
    Everything,
    Address(IpAddr),
    Domain(String),
}

impl Proxy {
    /// The proxy `https_proxy` or `HTTPS_PROXY` names in this process's environment, with
    /// the `no_proxy` or `NO_PROXY` exceptions. `None` when neither proxy variable is set.
    pub fn from_env() -> Option<Self> {
        Self::from_variables(|name| std::env::var(name).ok())
    }

    /// The proxy that the variables `variable` looks up name, read as [`Proxy::from_env`]
    /// reads this process's environment.
    pub fn from_variables(variable: impl Fn(&str) -> Option<String>) -> Option<Self> {
        let first = |lower: &str, upper: &str| {
            [lower, upper]
                .into_iter()
                .filter_map(&variable)
                .map(|value| value.trim().to_owned())
                .find(|value| !value.is_empty())
        };
        let url = first("https_proxy", "HTTPS_PROXY")?;
        let no_proxy = first("no_proxy", "NO_PROXY").unwrap_or_default();
        Some(Self::new(&url, &no_proxy))
    }

    /// A proxy at `url` (`http://[user:password@]host[:port]`; a URL without a scheme
    /// is `http://`) that is not used for the comma-separated hosts in `no_proxy`: `*`
    /// for every host, an IP address, or a domain that also covers its subdomains.
    pub fn new(url: &str, no_proxy: &str) -> Self {
        let bypass = no_proxy
            .split(',')
            .map(str::trim)
            .filter(|entry| !entry.is_empty())
            .map(|entry| {
                if entry == "*" {
                    return Bypass::Everything;
                }
                let entry = entry.trim_start_matches("*.").trim_start_matches('.');
                if let Ok(address) = entry.trim_matches(['[', ']']).parse::<IpAddr>() {
                    return Bypass::Address(address);
                }
                // A port in an entry is ignored: the entry covers the host on every port.
                let domain = entry.rsplit_once(':').map_or(entry, |(domain, _)| domain);
                Bypass::Domain(domain.to_ascii_lowercase())
            })
            .collect();
        Self {
            server: Server::parse(url).map_err(|error| error.to_string()),
            bypass,
        }
    }

    /// The proxy server, or why its URL cannot be used.
    pub(crate) fn server(&self) -> Result<Server, Error> {
        self.server.clone().map_err(Error::from)
    }

    /// Whether a connection to `host` goes through this proxy.
    pub(crate) fn applies_to(&self, host: &Host<String>) -> bool {
        match host {
            Host::Ipv4(address) if address.is_loopback() => false,
            Host::Ipv6(address) if address.is_loopback() => false,
            Host::Domain(domain) if domain.eq_ignore_ascii_case("localhost") => false,
            host => !self.bypass.iter().any(|bypass| match (bypass, host) {
                (Bypass::Everything, _) => true,
                (Bypass::Address(address), Host::Ipv4(target)) => *address == IpAddr::V4(*target),
                (Bypass::Address(address), Host::Ipv6(target)) => *address == IpAddr::V6(*target),
                (Bypass::Domain(domain), Host::Domain(target)) => {
                    let target = target.to_ascii_lowercase();
                    target == *domain
                        || target
                            .strip_suffix(domain.as_str())
                            .is_some_and(|prefix| prefix.ends_with('.'))
                }
                _ => false,
            }),
        }
    }
}

impl Server {
    fn parse(url: &str) -> Result<Self, Error> {
        let url = if url.contains("://") {
            Url::parse(url)
        } else {
            Url::parse(&format!("http://{url}"))
        }
        .map_err(|_| "the HTTPS proxy is not a valid URL")?;
        if url.scheme() != "http" {
            return Err("the HTTPS proxy must be an http:// URL".into());
        }
        if !matches!(url.path(), "" | "/") || url.query().is_some() || url.fragment().is_some() {
            return Err("the HTTPS proxy URL must name only a host and port".into());
        }
        let host = url
            .host()
            .ok_or("the HTTPS proxy URL needs a host")?
            .to_owned();
        let port = url
            .port_or_known_default()
            .ok_or("the HTTPS proxy URL needs a port")?;
        let authorization = if url.username().is_empty() && url.password().is_none() {
            None
        } else {
            let decode = |part: &str| {
                percent_decode(part).ok_or("the HTTPS proxy credentials are not valid UTF-8")
            };
            let user = decode(url.username())?;
            let password = decode(url.password().unwrap_or_default())?;
            Some(format!(
                "Basic {}",
                STANDARD.encode(format!("{user}:{password}"))
            ))
        };
        Ok(Self {
            host,
            port,
            authorization,
        })
    }
}

impl Server {
    /// A TCP connection to the proxy, already switched by `CONNECT` to `host:port`.
    pub(crate) async fn connect(&self, host: &Host<String>, port: u16) -> io::Result<TcpStream> {
        let mut stream = open(&self.host, self.port).await?;
        let target = authority(host, port);
        let mut request = format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n");
        if let Some(authorization) = &self.authorization {
            request.push_str(&format!("Proxy-Authorization: {authorization}\r\n"));
        }
        request.push_str("\r\n");
        stream.write_all(request.as_bytes()).await?;
        // Read the head one byte at a time so nothing the target sends after it is lost.
        let mut head = Vec::with_capacity(256);
        let mut byte = [0_u8; 1];
        while !head.ends_with(b"\r\n\r\n") {
            if head.len() >= MAX_RESPONSE_HEAD {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "the HTTPS proxy sent an oversized CONNECT response",
                ));
            }
            if stream.read(&mut byte).await? == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::ConnectionAborted,
                    "the HTTPS proxy closed the connection during CONNECT",
                ));
            }
            head.push(byte[0]);
        }
        let status = head
            .split(|byte| *byte == b'\r')
            .next()
            .and_then(|line| std::str::from_utf8(line).ok())
            .unwrap_or_default();
        let code = status
            .strip_prefix("HTTP/1.")
            .and_then(|rest| rest.get(2..5))
            .and_then(|code| code.parse::<u16>().ok());
        match code {
            Some(200..=299) => Ok(stream),
            _ => Err(io::Error::new(
                io::ErrorKind::ConnectionRefused,
                format!(
                    "the HTTPS proxy refused CONNECT to {target}: {}",
                    status.chars().take(128).collect::<String>()
                ),
            )),
        }
    }
}

/// A direct TCP connection.
pub(crate) async fn open(host: &Host<String>, port: u16) -> io::Result<TcpStream> {
    let stream = match host {
        Host::Domain(domain) => TcpStream::connect((domain.as_str(), port)).await?,
        Host::Ipv4(address) => TcpStream::connect((*address, port)).await?,
        Host::Ipv6(address) => TcpStream::connect((*address, port)).await?,
    };
    stream.set_nodelay(true)?;
    Ok(stream)
}

fn authority(host: &Host<String>, port: u16) -> String {
    match host {
        Host::Ipv6(address) => format!("[{address}]:{port}"),
        host => format!("{host}:{port}"),
    }
}

fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%'
            && let Some(byte) = text
                .get(index + 1..index + 3)
                .and_then(|hex| u8::from_str_radix(hex, 16).ok())
        {
            decoded.push(byte);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host(text: &str) -> Host<String> {
        Host::parse(text).unwrap()
    }

    #[test]
    fn loopback_and_listed_hosts_bypass_the_proxy() {
        let proxy = Proxy::new(
            "proxy.internal:3128",
            " example.com, .corp.test,*.svc.test, 10.1.2.3 ,[2001:db8::1], other.test:8443",
        );
        assert_eq!(format!("{proxy:?}"), "http://proxy.internal:3128");
        for direct in [
            "127.0.0.1",
            "[::1]",
            "localhost",
            "example.com",
            "API.Example.com",
            "corp.test",
            "gateway.corp.test",
            "a.svc.test",
            "10.1.2.3",
            "[2001:db8::1]",
            "other.test",
        ] {
            assert!(!proxy.applies_to(&host(direct)), "{direct} was proxied");
        }
        for proxied in [
            "notexample.com",
            "example.com.evil.test",
            "10.1.2.4",
            "gateway.test",
        ] {
            assert!(
                proxy.applies_to(&host(proxied)),
                "{proxied} was not proxied"
            );
        }
        let everything = Proxy::new("http://proxy.internal", "*");
        assert!(!everything.applies_to(&host("gateway.test")));
        assert_eq!(everything.server().unwrap().port, 80);
    }

    #[test]
    fn proxy_urls_are_plain_http_and_credentials_become_basic_authorization() {
        let proxy = Proxy::new("http://us%40er:p%3Ass@proxy.internal:8080/", "");
        assert_eq!(
            proxy.server().unwrap().authorization.as_deref(),
            Some(format!("Basic {}", STANDARD.encode("us@er:p:ss")).as_str())
        );
        assert_eq!(format!("{proxy:?}"), "http://proxy.internal:8080");
        for invalid in [
            "https://proxy.internal:443",
            "socks5://proxy.internal:1080",
            "http://proxy.internal:8080/path",
            "http://",
        ] {
            let proxy = Proxy::new(invalid, "localhost");
            let error = proxy.server().err().unwrap().to_string();
            assert!(error.contains("HTTPS proxy"), "{invalid}: {error}");
            assert_eq!(format!("{proxy:?}"), "unusable proxy");
            // Only a connection that would use the proxy fails because of its URL.
            assert!(!proxy.applies_to(&host("127.0.0.1")));
            assert!(!proxy.applies_to(&host("localhost")));
            assert!(proxy.applies_to(&host("gateway.test")));
        }
    }
}
