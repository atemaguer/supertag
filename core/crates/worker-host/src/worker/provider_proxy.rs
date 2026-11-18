//! Keeps a harness's model credentials out of its own processes on a host that runs commands
//! unsandboxed.
//!
//! With `allow-unsandboxed-commands`, a harness's shell commands run as the Worker Host's user
//! beside the harness, so whatever its environment holds they can read. For such an Attempt the
//! Worker Host starts this proxy: a loopback HTTP reverse proxy under a random path, which
//! forwards to the provider's one HTTPS origin, verified with the usual roots, and puts the real
//! credential in the request's `x-api-key` or `authorization` header in place of a placeholder.
//! The harness gets only the proxy's base URL and the placeholders. A placeholder sent anywhere
//! else never reaches this proxy, so it is never replaced; a command can still call the provider
//! through the proxy while the Attempt runs, but it cannot take the key away.
use std::{convert::Infallible, net::SocketAddr, sync::Arc, time::Duration};

use anyhow::{Context, Result, ensure};
use bytes::Bytes;
use http::{HeaderMap, HeaderName, HeaderValue, Request, Response, StatusCode, header};
use http_body_util::{BodyExt, Full, StreamBody, combinators::BoxBody};
use hyper::{body::Frame, body::Incoming, server::conn::http1, service::service_fn};
use hyper_util::rt::TokioIo;
use tokio::{net::TcpListener, task::JoinHandle};
use tokio_stream::StreamExt as _;
use tokio_util::sync::CancellationToken;

type Body = BoxBody<Bytes, Box<dyn std::error::Error + Send + Sync>>;

/// The largest request body forwarded; model requests with images stay well under this.
const MAX_REQUEST_BYTES: usize = 64 * 1024 * 1024;
/// Headers that hold credentials, the only ones a placeholder is replaced in.
const CREDENTIAL_HEADERS: [HeaderName; 2] =
    [HeaderName::from_static("x-api-key"), header::AUTHORIZATION];

/// One credential the proxy holds, and the placeholder the harness sees in its place.
pub(crate) struct Swap {
    /// The variable the harness reads it from, such as `ANTHROPIC_API_KEY`.
    pub(crate) variable: String,
    pub(crate) placeholder: String,
    value: String,
}

impl Swap {
    pub(crate) fn new(variable: &str, value: String) -> Self {
        Self {
            variable: variable.to_owned(),
            placeholder: format!("supertag-provider-{}", uuid::Uuid::new_v4().simple()),
            value,
        }
    }
}

struct Shared {
    upstream: String,
    prefix: String,
    swaps: Vec<Swap>,
    client: reqwest::Client,
}

/// A running proxy for one Attempt.
pub(crate) struct ProviderProxy {
    base_url: String,
    shared: Arc<Shared>,
    shutdown: CancellationToken,
    task: JoinHandle<()>,
}

fn hop_by_hop(name: &HeaderName) -> bool {
    matches!(
        name.as_str(),
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
            | "host"
            | "content-length"
    )
}

fn plain(status: StatusCode, text: &'static str) -> Response<Body> {
    let mut response = Response::new(
        Full::new(Bytes::from_static(text.as_bytes()))
            .map_err(|never| match never {})
            .boxed(),
    );
    *response.status_mut() = status;
    response
}

impl Shared {
    /// The request's headers for the provider: hop-by-hop headers dropped, and each placeholder
    /// replaced in the credential headers only.
    fn upstream_headers(&self, headers: &HeaderMap) -> Result<HeaderMap, &'static str> {
        let mut forwarded = HeaderMap::new();
        for (name, value) in headers {
            if hop_by_hop(name) {
                continue;
            }
            let mut value = value.clone();
            if CREDENTIAL_HEADERS.contains(name) {
                let text = value
                    .to_str()
                    .map_err(|_| "a credential header is not text")?;
                if let Some(swap) = self
                    .swaps
                    .iter()
                    .find(|swap| text.contains(&swap.placeholder))
                {
                    value = HeaderValue::from_str(&text.replace(&swap.placeholder, &swap.value))
                        .map_err(|_| "a credential header is not valid")?;
                    value.set_sensitive(true);
                }
            }
            forwarded.append(name.clone(), value);
        }
        Ok(forwarded)
    }

    async fn forward(&self, request: Request<Incoming>) -> Response<Body> {
        let path_and_query = request
            .uri()
            .path_and_query()
            .map_or("/", |value| value.as_str())
            .to_owned();
        let Some(rest) = path_and_query.strip_prefix(&self.prefix) else {
            return plain(StatusCode::NOT_FOUND, "not found");
        };
        let rest = if rest.starts_with('/') {
            rest.to_owned()
        } else {
            format!("/{rest}")
        };
        let headers = match self.upstream_headers(request.headers()) {
            Ok(headers) => headers,
            Err(reason) => return plain(StatusCode::BAD_REQUEST, reason),
        };
        let method = request.method().clone();
        let body = match http_body_util::Limited::new(request.into_body(), MAX_REQUEST_BYTES)
            .collect()
            .await
        {
            Ok(body) => body.to_bytes(),
            Err(_) => return plain(StatusCode::PAYLOAD_TOO_LARGE, "request body is too large"),
        };
        let sent = self
            .client
            .request(method, format!("{}{rest}", self.upstream))
            .headers(headers)
            .body(body)
            .send()
            .await;
        let upstream = match sent {
            Ok(response) => response,
            Err(_) => return plain(StatusCode::BAD_GATEWAY, "the provider could not be reached"),
        };
        let status = upstream.status();
        let mut headers = HeaderMap::new();
        for (name, value) in upstream.headers() {
            if !hop_by_hop(name) {
                headers.append(name.clone(), value.clone());
            }
        }
        let stream = upstream.bytes_stream().map(|chunk| {
            chunk
                .map(Frame::data)
                .map_err(|error| Box::new(error) as Box<dyn std::error::Error + Send + Sync>)
        });
        let mut response = Response::new(BodyExt::boxed(StreamBody::new(stream)));
        *response.status_mut() = status;
        *response.headers_mut() = headers;
        response
    }
}

impl ProviderProxy {
    /// Starts a proxy that forwards to `upstream`, an `https://` origin with no path, holding
    /// `swaps`.
    pub(crate) async fn start(upstream: &str, swaps: Vec<Swap>) -> Result<Self> {
        Self::start_with(upstream, swaps, reqwest::Client::builder()).await
    }

    async fn start_with(
        upstream: &str,
        swaps: Vec<Swap>,
        client: reqwest::ClientBuilder,
    ) -> Result<Self> {
        let parsed = reqwest::Url::parse(upstream).context("provider origin")?;
        ensure!(
            (parsed.scheme() == "https" || cfg!(any(test, feature = "test-fixtures")))
                && parsed.path() == "/"
                && parsed.query().is_none()
                && parsed.host_str().is_some(),
            "provider proxy upstream must be a bare https origin"
        );
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .context("bind the provider proxy")?;
        let address: SocketAddr = listener.local_addr()?;
        let prefix = format!("/{}", uuid::Uuid::new_v4().simple());
        let shared = Arc::new(Shared {
            upstream: upstream.trim_end_matches('/').to_owned(),
            prefix: prefix.clone(),
            swaps,
            client: client
                .redirect(reqwest::redirect::Policy::none())
                .no_proxy()
                .connect_timeout(Duration::from_secs(30))
                .build()
                .context("provider proxy client")?,
        });
        let shutdown = CancellationToken::new();
        let task = {
            let (shared, shutdown) = (shared.clone(), shutdown.clone());
            tokio::spawn(async move {
                loop {
                    let accepted = tokio::select! {
                        _ = shutdown.cancelled() => return,
                        accepted = listener.accept() => accepted,
                    };
                    let Ok((stream, _)) = accepted else { continue };
                    let (shared, shutdown) = (shared.clone(), shutdown.clone());
                    tokio::spawn(async move {
                        let service = service_fn(move |request| {
                            let shared = shared.clone();
                            async move { Ok::<_, Infallible>(shared.forward(request).await) }
                        });
                        let connection =
                            http1::Builder::new().serve_connection(TokioIo::new(stream), service);
                        tokio::select! {
                            _ = shutdown.cancelled() => {}
                            _ = connection => {}
                        }
                    });
                }
            })
        };
        Ok(Self {
            base_url: format!("http://{address}{prefix}"),
            shared,
            shutdown,
            task,
        })
    }

    /// The base URL the harness sends its model requests to.
    pub(crate) fn base_url(&self) -> &str {
        &self.base_url
    }

    /// Each credential variable with the placeholder the harness gets instead of the secret.
    pub(crate) fn placeholders(&self) -> impl Iterator<Item = (&str, &str)> {
        self.shared
            .swaps
            .iter()
            .map(|swap| (swap.variable.as_str(), swap.placeholder.as_str()))
    }

    pub(crate) async fn stop(self) {
        self.shutdown.cancel();
        let _ = self.task.await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Router, extract::Request as AxumRequest, routing::any};

    /// A provider that answers each request with what it received.
    async fn provider() -> (String, JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = Router::new().fallback(any(|request: AxumRequest| async move {
            let headers = request.headers();
            let echo = serde_json::json!({
                "path": request.uri().to_string(),
                "x-api-key": headers.get("x-api-key").map(|v| v.to_str().unwrap().to_owned()),
                "authorization": headers.get("authorization").map(|v| v.to_str().unwrap().to_owned()),
                "x-other": headers.get("x-other").map(|v| v.to_str().unwrap().to_owned()),
                "body": String::from_utf8(request.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap(),
            });
            axum::Json(echo)
        }));
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://{address}"), task)
    }

    #[tokio::test]
    async fn only_credential_headers_to_the_provider_get_the_secret() -> Result<()> {
        let (upstream, server) = provider().await;
        let proxy = ProviderProxy::start_with(
            &upstream,
            vec![Swap::new("ANTHROPIC_API_KEY", "sk-real-secret".into())],
            reqwest::Client::builder(),
        )
        .await?;
        let placeholder = proxy.placeholders().next().unwrap().1.to_owned();
        assert!(!placeholder.contains("sk-real"));
        let client = reqwest::Client::builder().no_proxy().build()?;
        let echo: serde_json::Value = client
            .post(format!("{}/v1/messages?beta=true", proxy.base_url()))
            .header("x-api-key", &placeholder)
            .header("authorization", format!("Bearer {placeholder}"))
            .header("x-other", &placeholder)
            .body(format!("{{\"echo\":\"{placeholder}\"}}"))
            .send()
            .await?
            .json()
            .await?;
        assert_eq!(echo["path"], "/v1/messages?beta=true");
        assert_eq!(echo["x-api-key"], "sk-real-secret");
        assert_eq!(echo["authorization"], "Bearer sk-real-secret");
        // Nothing else is touched: another header, and the body, keep the placeholder.
        assert_eq!(echo["x-other"], placeholder);
        assert!(echo["body"].as_str().unwrap().contains(&placeholder));

        // A request outside the Attempt's path never reaches the provider.
        let refused = client
            .post(format!(
                "{}/v1/messages",
                proxy.base_url().rsplit_once('/').unwrap().0
            ))
            .header("x-api-key", &placeholder)
            .send()
            .await?;
        assert_eq!(refused.status(), reqwest::StatusCode::NOT_FOUND);
        // Once the Attempt ends the proxy is gone: a command left running can't use it.
        let base = proxy.base_url().to_owned();
        proxy.stop().await;
        assert!(
            client
                .post(format!("{base}/v1/messages"))
                .header("x-api-key", &placeholder)
                .send()
                .await
                .is_err()
        );
        server.abort();
        Ok(())
    }

    #[tokio::test]
    async fn a_streamed_response_passes_through_as_it_arrives() -> Result<()> {
        // A provider that sends one server-sent event, then the next two seconds later.
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        let app = Router::new().fallback(any(|| async {
            let events = tokio_stream::iter([
                (Duration::ZERO, "event: delta\ndata: one\n\n"),
                (Duration::from_secs(2), "event: delta\ndata: two\n\n"),
            ])
            .then(|(delay, event)| async move {
                tokio::time::sleep(delay).await;
                Ok::<_, Infallible>(Bytes::from_static(event.as_bytes()))
            });
            (
                [(header::CONTENT_TYPE, "text/event-stream")],
                axum::body::Body::from_stream(events),
            )
        }));
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let proxy = ProviderProxy::start_with(
            &format!("http://{address}"),
            vec![],
            reqwest::Client::builder(),
        )
        .await?;
        let response = reqwest::Client::builder()
            .no_proxy()
            .build()?
            .post(format!("{}/v1/messages", proxy.base_url()))
            .send()
            .await?;
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            "text/event-stream"
        );
        let mut stream = response.bytes_stream();
        let first = tokio::time::timeout(Duration::from_secs(1), stream.next())
            .await
            .expect("the first event arrives before the provider sends the second")
            .unwrap()?;
        assert!(String::from_utf8_lossy(&first).contains("data: one"));
        let mut rest = Vec::new();
        while let Some(chunk) = stream.next().await {
            rest.extend_from_slice(&chunk?);
        }
        assert!(String::from_utf8_lossy(&rest).contains("data: two"));
        proxy.stop().await;
        server.abort();
        Ok(())
    }

    #[tokio::test]
    async fn the_upstream_is_a_bare_https_origin() {
        for bad in [
            "https://api.anthropic.com/v1",
            "https://api.anthropic.com/?x=1",
            "not a url",
        ] {
            assert!(ProviderProxy::start(bad, vec![]).await.is_err(), "{bad}");
        }
        let proxy = ProviderProxy::start("https://api.anthropic.com", vec![])
            .await
            .unwrap();
        assert!(proxy.base_url().starts_with("http://127.0.0.1:"));
        proxy.stop().await;
    }
}
