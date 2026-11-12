use std::time::Duration;

use reqwest::{Client, Method, Response, StatusCode, header};
use serde_json::{Value, json};

use super::{Failure, catalog::Server};

const PROTOCOL_VERSION: &str = "2025-11-25";
const SESSION: &str = "mcp-session-id";
const PROTOCOL: &str = "mcp-protocol-version";
const HTTP_BYTES: usize = 256 * 1024;

pub(super) fn client() -> Result<Client, Failure> {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .no_proxy()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| Failure::Unavailable)
}

pub(super) struct Session {
    client: Client,
    server: Server,
    version: &'static str,
    session_id: Option<header::HeaderValue>,
    next_id: u64,
    pub(super) unconfirmed_call: bool,
}

impl Session {
    pub(super) fn new(client: Client, server: Server) -> Self {
        Self {
            client,
            server,
            version: PROTOCOL_VERSION,
            session_id: None,
            next_id: 1,
            unconfirmed_call: false,
        }
    }

    fn request(&self, method: Method) -> reqwest::RequestBuilder {
        let mut request = self
            .client
            .request(method, self.server.endpoint.clone())
            .headers(self.server.headers.clone())
            .header(header::ACCEPT, "application/json, text/event-stream")
            .header(PROTOCOL, self.version);
        if let Some(session) = &self.session_id {
            request = request.header(SESSION, session.clone());
        }
        request
    }

    pub(super) async fn initialize(&mut self) -> Result<(), Failure> {
        let initialized = self.rpc("initialize", json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {"name":"supertag-worker-host", "version":env!("CARGO_PKG_VERSION")}
        })).await?;
        self.version = match initialized.get("protocolVersion").and_then(Value::as_str) {
            Some(PROTOCOL_VERSION) => PROTOCOL_VERSION,
            Some("2025-06-18") => "2025-06-18",
            Some("2025-03-26") => "2025-03-26",
            _ => return Err(Failure::InvalidResponse),
        };
        if !initialized
            .get("capabilities")
            .and_then(|value| value.get("tools"))
            .is_some_and(Value::is_object)
        {
            return Err(Failure::InvalidResponse);
        }
        let response = self
            .request(Method::POST)
            .json(&json!({"jsonrpc":"2.0", "method":"notifications/initialized"}))
            .send()
            .await
            .map_err(|_| Failure::Unavailable)?;
        if response.status() != StatusCode::ACCEPTED {
            return Err(Failure::InvalidResponse);
        }
        self.validate_session(&response, false)
    }

    pub(super) async fn rpc(&mut self, method: &str, params: Value) -> Result<Value, Failure> {
        let id = self.next_id;
        self.next_id = id.checked_add(1).ok_or(Failure::InvalidResponse)?;
        let response = self
            .request(Method::POST)
            .json(&json!({"jsonrpc":"2.0", "id":id, "method":method, "params":params}))
            .send()
            .await
            .map_err(|_| Failure::Unavailable)?;
        if response.status() != StatusCode::OK {
            return Err(Failure::Unavailable);
        }
        self.validate_session(&response, method == "initialize")?;
        read_response(response, id).await
    }

    fn validate_session(&mut self, response: &Response, initializing: bool) -> Result<(), Failure> {
        let mut headers = response.headers().get_all(SESSION).iter();
        let received = headers.next();
        if headers.next().is_some() {
            return Err(Failure::InvalidResponse);
        }
        if let Some(received) = received {
            if initializing {
                let valid = received.as_bytes();
                if valid.is_empty()
                    || valid.len() > 512
                    || !valid.iter().all(|byte| (33..=126).contains(byte))
                {
                    return Err(Failure::InvalidResponse);
                }
                let mut session_id = received.clone();
                session_id.set_sensitive(true);
                self.session_id = Some(session_id);
            } else if self.session_id.as_ref() != Some(received) {
                return Err(Failure::InvalidResponse);
            }
        }
        Ok(())
    }

    pub(super) fn session_id(&self) -> Option<&str> {
        self.session_id.as_ref()?.to_str().ok()
    }

    pub(super) async fn close(&self) {
        if self.session_id.is_some() {
            let _ = self
                .request(Method::DELETE)
                .timeout(Duration::from_secs(2))
                .send()
                .await;
        }
    }
}

fn decode(bytes: &[u8], id: u64) -> Result<Option<Value>, Failure> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| Failure::InvalidResponse)?;
    if value.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Err(Failure::InvalidResponse);
    }
    if value.get("id").is_none() && value.get("method").is_some_and(Value::is_string) {
        return Ok(None);
    }
    if value.get("id").and_then(Value::as_u64) != Some(id) || value.get("method").is_some() {
        return Err(Failure::InvalidResponse);
    }
    if value.get("error").is_some() {
        return Err(Failure::Unavailable);
    }
    value
        .get("result")
        .filter(|result| result.is_object())
        .cloned()
        .map(Some)
        .ok_or(Failure::InvalidResponse)
}

async fn read_response(mut response: Response, id: u64) -> Result<Value, Failure> {
    let media = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|header| header.to_str().ok())
        .and_then(|value| value.split(';').next());
    let streaming = match media {
        Some("application/json") => false,
        Some("text/event-stream") => true,
        _ => return Err(Failure::InvalidResponse),
    };
    let mut total = 0usize;
    let mut buffer = Vec::new();
    let mut event = Vec::new();
    let mut line_start = 0;
    let mut scanned = 0;
    while let Some(chunk) = response.chunk().await.map_err(|_| Failure::Unavailable)? {
        total = total
            .checked_add(chunk.len())
            .filter(|total| *total <= HTTP_BYTES)
            .ok_or(Failure::ResponseTooLarge)?;
        buffer.extend_from_slice(&chunk);
        if !streaming {
            continue;
        }
        while let Some(length) = buffer[scanned..].iter().position(|byte| *byte == b'\n') {
            let line_end = scanned + length;
            let line = &buffer[line_start..line_end];
            let line = line.strip_suffix(b"\r").unwrap_or(line);
            line_start = line_end + 1;
            scanned = line_start;
            if line.is_empty() && !event.is_empty() {
                event.pop();
                if let Some(result) = decode(&event, id)? {
                    return Ok(result);
                }
                event.clear();
            } else if let Some(data) = line.strip_prefix(b"data:") {
                event.extend_from_slice(data.strip_prefix(b" ").unwrap_or(data));
                event.push(b'\n');
            }
        }
        buffer.drain(..line_start);
        line_start = 0;
        scanned = buffer.len();
    }
    if streaming {
        return Err(Failure::InvalidResponse);
    }
    decode(&buffer, id)?.ok_or(Failure::InvalidResponse)
}

#[cfg(test)]
mod tests {
    use tokio::{
        io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
        net::TcpListener,
        time::timeout,
    };

    use super::*;
    use crate::mcp::catalog::McpCatalog;

    #[tokio::test]
    async fn refuses_redirect_even_to_another_loopback_origin() {
        let provider = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let alternate = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let provider_address = provider.local_addr().unwrap();
        let alternate_address = alternate.local_addr().unwrap();
        let serve = tokio::spawn(async move {
            let (stream, _) = provider.accept().await.unwrap();
            let mut stream = BufReader::new(stream);
            let mut line = String::new();
            stream.read_line(&mut line).await.unwrap();
            assert_eq!(line, "POST /mcp HTTP/1.1\r\n");
            let mut authorized = false;
            let mut length = 0;
            loop {
                line.clear();
                assert!(stream.read_line(&mut line).await.unwrap() > 0);
                if line == "\r\n" {
                    break;
                }
                if line == "authorization: Bearer fixture-secret\r\n" {
                    authorized = true;
                }
                if let Some(value) = line.strip_prefix("content-length:") {
                    length = value.trim().parse().unwrap();
                }
            }
            assert!(authorized && length > 0);
            stream.read_exact(&mut vec![0u8; length]).await.unwrap();
            stream.write_all(format!("HTTP/1.1 307 Temporary Redirect\r\nLocation: http://{alternate_address}/other\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
        });
        let config = json!({"version":1,"servers":[{
            "name":"catalog", "url":format!("http://{provider_address}/mcp"),
            "headerEnv":{"Authorization":"CATALOG_AUTH"}
        }]});
        let catalog = McpCatalog::parse(config.to_string().as_bytes(), |_| {
            Some("Bearer fixture-secret".into())
        })
        .unwrap();
        let mut session = Session::new(client().unwrap(), catalog.servers["catalog"].clone());
        assert_eq!(session.initialize().await, Err(Failure::Unavailable));
        serve.await.unwrap();
        assert!(
            timeout(Duration::from_millis(100), alternate.accept())
                .await
                .is_err()
        );
    }
}
