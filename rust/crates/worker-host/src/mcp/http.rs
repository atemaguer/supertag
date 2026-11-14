use std::time::Duration;

use reqwest::{Client, Method, Response, StatusCode, header};
use serde_json::{Value, json};

use super::{
    Failure,
    catalog::{HttpServer, header_secrets, header_value},
    oauth::McpLoginStore,
};

pub(super) const PROTOCOL_VERSION: &str = "2025-11-25";
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
    server: HttpServer,
    version: &'static str,
    session_id: Option<header::HeaderValue>,
    next_id: u64,
    pub(super) unconfirmed_call: bool,
    login: Option<McpLoginStore>,
    access_token: Option<header::HeaderValue>,
    /// Headers a minted form supplied for this Attempt.
    minted: Box<header::HeaderMap>,
    /// Headers read from the server's `headerFile` files for this Attempt.
    files: Box<header::HeaderMap>,
    /// Every access token this session sent; all are withheld from Task-visible output.
    pub(super) tokens: Vec<String>,
}

pub(super) fn accepted_version(initialized: &Value) -> Result<&'static str, Failure> {
    match initialized.get("protocolVersion").and_then(Value::as_str) {
        Some(PROTOCOL_VERSION) => Ok(PROTOCOL_VERSION),
        Some("2025-06-18") => Ok("2025-06-18"),
        Some("2025-03-26") => Ok("2025-03-26"),
        _ => Err(Failure::InvalidResponse),
    }
}

impl Session {
    pub(super) fn new(client: Client, server: HttpServer, logins: Option<&McpLoginStore>) -> Self {
        let login = logins.filter(|_| server.oauth).cloned();
        Self {
            client,
            server,
            version: PROTOCOL_VERSION,
            session_id: None,
            next_id: 1,
            unconfirmed_call: false,
            login,
            access_token: None,
            minted: Box::default(),
            files: Box::default(),
            tokens: Vec::new(),
        }
    }

    /// Whether this server's credentials can be fetched again after a refusal.
    fn renewable(&self) -> bool {
        self.login.is_some() || self.server.minted.is_some() || !self.server.header_files.is_empty()
    }

    /// Reads this server's header files again.
    fn read_files(&mut self) -> Result<(), Failure> {
        let mut files = header::HeaderMap::new();
        for (name, file) in &self.server.header_files {
            let value = file.read().map_err(|_| Failure::Unavailable)?;
            files.insert(
                name.clone(),
                header_value(&value).map_err(|_| Failure::Unavailable)?,
            );
            for secret in header_secrets(&value) {
                if !secret.is_empty() && !self.tokens.contains(&secret) {
                    self.tokens.push(secret);
                }
            }
        }
        *self.files = files;
        Ok(())
    }

    /// Mints this server's headers and reads its header files again: again when the server
    /// refused `rejected`.
    async fn mint(&mut self, rejected: Option<&str>) -> Result<(), Failure> {
        self.read_files()?;
        let Some(minted) = self.server.minted.clone() else {
            return Ok(());
        };
        let minted = minted
            .headers(
                &self.client,
                &self.server.endpoint,
                &self.server.github_api,
                rejected,
            )
            .await
            .map_err(|_| Failure::Unavailable)?;
        for secret in minted.secrets {
            if !secret.is_empty() && !self.tokens.contains(&secret) {
                self.tokens.push(secret);
            }
        }
        *self.minted = minted.headers;
        Ok(())
    }

    /// Takes the access token from this host's login, refreshing it when it expires or when
    /// the server refused `rejected`.
    async fn authorize(&mut self, rejected: Option<&str>) -> Result<(), Failure> {
        let Some(login) = &self.login else {
            return if self.server.oauth {
                Err(Failure::Unavailable)
            } else {
                Ok(())
            };
        };
        let token = login
            .access_token(
                &self.client,
                &self.server.name,
                self.server.endpoint.as_str(),
                rejected,
            )
            .await
            .map_err(|_| Failure::Unavailable)?;
        let mut value = header::HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|_| Failure::Unavailable)?;
        value.set_sensitive(true);
        // The login's refresh token and client secret are as private as its access tokens:
        // the token endpoint shares the server's origin, so the server could echo them.
        let stored = login
            .read(&self.server.name)
            .ok()
            .flatten()
            .map(|login| {
                std::iter::once(login.refresh_token)
                    .chain(login.client_secret)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for secret in std::iter::once(token).chain(stored) {
            if !secret.is_empty() && !self.tokens.contains(&secret) {
                self.tokens.push(secret);
            }
        }
        self.access_token = Some(value);
        Ok(())
    }

    fn request(&self, method: Method) -> reqwest::RequestBuilder {
        let mut request = self
            .client
            .request(method, self.server.endpoint.clone())
            .headers(self.server.headers.clone())
            .headers((*self.files).clone())
            .headers((*self.minted).clone())
            .header(header::ACCEPT, "application/json, text/event-stream")
            .header(PROTOCOL, self.version);
        if let Some(token) = &self.access_token {
            request = request.header(header::AUTHORIZATION, token.clone());
        }
        if let Some(session) = &self.session_id {
            request = request.header(SESSION, session.clone());
        }
        request
    }

    pub(super) async fn initialize(&mut self) -> Result<(), Failure> {
        if self.server.oauth {
            self.authorize(None).await?;
        }
        self.mint(None).await?;
        let initialized = self.rpc("initialize", json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {"name":"supertag-worker-host", "version":env!("CARGO_PKG_VERSION")}
        })).await?;
        self.version = accepted_version(&initialized)?;
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
        let body = json!({"jsonrpc":"2.0", "id":id, "method":method, "params":params});
        let mut response = self
            .request(Method::POST)
            .json(&body)
            .send()
            .await
            .map_err(|_| Failure::Unavailable)?;
        // A refused access token (401, or 403 from servers that answer so for an expired token)
        // means the request was not processed: refresh the login once and resend. A refused
        // refresh marks the login lapsed.
        if matches!(
            response.status(),
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
        ) && self.renewable()
        {
            if self.login.is_some() {
                let rejected = self.access_token_text();
                self.authorize(rejected.as_deref()).await?;
                self.read_files()?;
            } else {
                let rejected = self.minted_token_text();
                self.mint(Some(&rejected)).await?;
            }
            response = self
                .request(Method::POST)
                .json(&body)
                .send()
                .await
                .map_err(|_| Failure::Unavailable)?;
        }
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

    /// The access token this session last sent.
    fn access_token_text(&self) -> Option<String> {
        self.access_token
            .as_ref()?
            .to_str()
            .ok()?
            .strip_prefix("Bearer ")
            .map(str::to_owned)
    }

    /// The bearer token a minted form last supplied, or empty for other headers.
    fn minted_token_text(&self) -> String {
        self.minted
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .unwrap_or_default()
            .to_owned()
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

pub(super) fn decode(bytes: &[u8], id: u64) -> Result<Option<Value>, Failure> {
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
        let crate::mcp::catalog::Transport::Http(server) =
            catalog.servers["catalog"].transport.clone()
        else {
            panic!("HTTP server expected");
        };
        let mut session = Session::new(client().unwrap(), server, None);
        assert_eq!(session.initialize().await, Err(Failure::Unavailable));
        serve.await.unwrap();
        assert!(
            timeout(Duration::from_millis(100), alternate.accept())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn oauth_login_supplies_the_bearer_and_refreshes_once_on_401_or_403() {
        for refused in [401, 403] {
            refresh_once_after(refused).await;
        }
    }

    #[tokio::test]
    async fn a_refused_login_reads_its_header_files_again() {
        use std::os::unix::fs::PermissionsExt;

        use crate::mcp::{
            oauth::{McpLogin, McpLoginStore, now_ms},
            test_http::serve,
        };
        let initialize = json!({"jsonrpc":"2.0","id":1,"result":{
            "protocolVersion":"2025-06-18","capabilities":{"tools":{}}
        }})
        .to_string();
        let (address, served) = serve(vec![
            (200, "application/json", initialize),
            (202, "application/json", String::new()),
            (401, "application/json", String::new()),
            (
                200,
                "application/json",
                json!({"access_token":"access-2","expires_in":3600}).to_string(),
            ),
            (
                200,
                "application/json",
                json!({"jsonrpc":"2.0","id":2,"result":{"tools":[]}}).to_string(),
            ),
        ])
        .await;
        let url = format!("http://127.0.0.1:{}/mcp", address.port());
        let root = tempfile::tempdir().unwrap();
        let store = McpLoginStore::new(root.path().join("mcp-logins"));
        store
            .store(
                "docs",
                &McpLogin {
                    url: url.clone(),
                    token_endpoint: format!("http://127.0.0.1:{}/token", address.port()),
                    client_id: "client".into(),
                    client_secret: None,
                    refresh_token: "refresh-1".into(),
                    access_token: Some("access-1".into()),
                    access_token_expires_at: Some(now_ms() + 3_600_000),
                    refresh_token_expires_at: None,
                    logged_in_at: 1,
                    lapsed_at: None,
                },
            )
            .unwrap();
        let key = root.path().join("api-key");
        let write = |value: &str| {
            std::fs::write(&key, value).unwrap();
            std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o600)).unwrap();
        };
        write("api-key-value-one\n");
        let config = json!({"version":1,"servers":[{"name":"docs","url":url,"oauth":true,
            "headerFile":{"X-Api-Key":key}}]});
        let catalog = McpCatalog::parse(config.to_string().as_bytes(), |_| None).unwrap();
        let crate::mcp::catalog::Transport::Http(server) =
            catalog.servers["docs"].transport.clone()
        else {
            panic!("HTTP server expected");
        };
        let mut session = Session::new(client().unwrap(), server, Some(&store));
        session.initialize().await.unwrap();
        // The server refuses the request after the file was replaced: the resend carries the
        // refreshed login and the file's new value.
        write("api-key-value-two\n");
        session.rpc("tools/list", json!({})).await.unwrap();
        assert!(session.tokens.contains(&"api-key-value-two".to_owned()));
        let requests = served.await.unwrap();
        assert!(
            requests[2]
                .headers
                .contains(&"x-api-key: api-key-value-one".into())
        );
        assert_eq!(requests[3].line, "POST /token HTTP/1.1");
        assert!(
            requests[4]
                .headers
                .contains(&"x-api-key: api-key-value-two".into())
        );
        assert!(
            requests[4]
                .headers
                .contains(&"authorization: bearer access-2".into())
        );
    }

    /// The server refuses the stored access token with `refused`; the session refreshes once,
    /// resends, and withholds every credential of the login, not only access tokens.
    async fn refresh_once_after(refused: u16) {
        use crate::mcp::{
            oauth::{McpLogin, McpLoginStore, now_ms},
            test_http::serve,
        };
        let initialize = json!({"jsonrpc":"2.0","id":1,"result":{
            "protocolVersion":"2025-06-18","capabilities":{"tools":{}}
        }})
        .to_string();
        let (address, served) = serve(vec![
            (refused, "application/json", String::new()),
            (
                200,
                "application/json",
                json!({"access_token":"access-2","expires_in":3600}).to_string(),
            ),
            (200, "application/json", initialize),
            (202, "application/json", String::new()),
        ])
        .await;
        let url = format!("http://127.0.0.1:{}/mcp", address.port());
        let root = tempfile::tempdir().unwrap();
        let store = McpLoginStore::new(root.path().join("mcp-logins"));
        store
            .store(
                "docs",
                &McpLogin {
                    url: url.clone(),
                    token_endpoint: format!("http://127.0.0.1:{}/token", address.port()),
                    client_id: "client".into(),
                    client_secret: Some("client-secret-value".into()),
                    refresh_token: "refresh-1".into(),
                    access_token: Some("access-1".into()),
                    access_token_expires_at: Some(now_ms() + 3_600_000),
                    refresh_token_expires_at: None,
                    logged_in_at: 1,
                    lapsed_at: None,
                },
            )
            .unwrap();
        let config = json!({"version":1,"servers":[{"name":"docs","url":url,"oauth":true}]});
        let catalog = McpCatalog::parse(config.to_string().as_bytes(), |_| None).unwrap();
        let crate::mcp::catalog::Transport::Http(server) =
            catalog.servers["docs"].transport.clone()
        else {
            panic!("HTTP server expected");
        };
        let mut session = Session::new(client().unwrap(), server, Some(&store));
        session.initialize().await.unwrap();
        assert_eq!(
            session.tokens,
            ["access-1", "refresh-1", "client-secret-value", "access-2"]
        );
        let requests = served.await.unwrap();
        assert!(
            requests[0]
                .headers
                .contains(&"authorization: bearer access-1".into())
        );
        assert_eq!(requests[1].line, "POST /token HTTP/1.1");
        for request in &requests[2..] {
            assert!(
                request
                    .headers
                    .contains(&"authorization: bearer access-2".into())
            );
        }
    }
}
