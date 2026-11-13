mod catalog;
mod http;
mod oauth;
mod stdio;
mod workspace;

use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
    time::Duration,
};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use supertag_protocol::{
    MAX_MESSAGE_BYTES, mcp,
    v2::{HarnessMcpTool, McpResourceRule, PolicyPermission, Task},
};
use tokio::time::{self, Instant};
use tokio::{sync::Mutex, task::JoinSet};
use tokio_util::sync::CancellationToken;
use tonic::Status;

pub use catalog::{McpCatalog, McpCatalogEntry};
pub use oauth::{
    LoginOptions as McpLoginOptions, McpLogin, McpLoginState, McpLoginStore, login_command,
    run_login as run_mcp_login,
};
pub(crate) use workspace::{WorkspaceMcp, host_variable as workspace_mcp_variable};

const SCHEMA_BYTES: usize = 16 * 1024;
const DISCOVERY_PAGES: usize = 16;
const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Failure {
    Denied,
    InvalidArguments,
    InvalidResponse,
    ResponseTooLarge,
    Unavailable,
    UnconfirmedCall,
    Cancelled,
}

impl From<Failure> for Status {
    fn from(failure: Failure) -> Self {
        match failure {
            Failure::Denied => {
                Self::permission_denied("MCP tool or resource is outside accepted Task permissions")
            }
            Failure::InvalidArguments => Self::invalid_argument("invalid MCP tool arguments"),
            Failure::InvalidResponse => {
                Self::data_loss("MCP provider returned an unverifiable response")
            }
            Failure::ResponseTooLarge => {
                Self::resource_exhausted("MCP provider response exceeds its limit")
            }
            Failure::Unavailable => Self::unavailable("MCP provider did not confirm the request"),
            Failure::UnconfirmedCall => {
                Self::failed_precondition("a prior MCP call is unconfirmed; this call was not sent")
            }
            Failure::Cancelled => Self::cancelled("MCP execution authority ended"),
        }
    }
}

pub(crate) struct AttemptMcp {
    servers: BTreeMap<String, AttemptServer>,
    secrets: Vec<String>,
}

/// One server's connection for an Attempt: HTTP, or a stdio process the Worker Host launched.
enum Session {
    Http(http::Session),
    Stdio(stdio::Session),
}

/// The Worker Host's private provider connection to a remote Workspace's staged sandbox.
pub(crate) struct SandboxConnection {
    pub(crate) channel: tonic::transport::Channel,
    pub(crate) token: String,
}

impl Session {
    fn open(
        client: &reqwest::Client,
        (name, server): (&str, &catalog::Server),
        logins: Option<&McpLoginStore>,
        sandbox: Option<&SandboxConnection>,
    ) -> Result<Self, Failure> {
        Ok(match &server.transport {
            catalog::Transport::Http(http) => {
                Self::Http(http::Session::new(client.clone(), http.clone(), logins))
            }
            catalog::Transport::Stdio(stdio) if stdio.sandboxed => {
                // A sandboxed server never receives a Worker Host variable.
                if !stdio.env.is_empty() || stdio.cwd.is_some() {
                    return Err(Failure::Denied);
                }
                Self::Stdio(stdio::Session::start_sandbox(
                    sandbox.ok_or(Failure::Unavailable)?,
                    name,
                    &stdio.command,
                )?)
            }
            catalog::Transport::Stdio(stdio) => Self::Stdio(stdio::Session::start(stdio)?),
        })
    }

    async fn initialize(&mut self) -> Result<(), Failure> {
        match self {
            Self::Http(session) => session.initialize().await,
            Self::Stdio(session) => session.initialize().await,
        }
    }

    async fn rpc(&mut self, method: &str, params: Value) -> Result<Value, Failure> {
        match self {
            Self::Http(session) => session.rpc(method, params).await,
            Self::Stdio(session) => session.rpc(method, params).await,
        }
    }

    /// Credentials this connection learned: an HTTP session ID and OAuth access tokens.
    fn credentials(&self) -> Vec<String> {
        match self {
            Self::Http(session) => session
                .session_id()
                .map(str::to_owned)
                .into_iter()
                .chain(session.tokens.iter().cloned())
                .collect(),
            Self::Stdio(_) => Vec::new(),
        }
    }

    fn unconfirmed_call(&mut self) -> &mut bool {
        match self {
            Self::Http(session) => &mut session.unconfirmed_call,
            Self::Stdio(session) => &mut session.unconfirmed_call,
        }
    }

    async fn close(&mut self) {
        match self {
            Self::Http(session) => session.close().await,
            Self::Stdio(session) => session.close().await,
        }
    }
}

struct AttemptServer {
    session: Arc<Mutex<Session>>,
    resources: BTreeMap<String, Vec<McpResourceRule>>,
    tools: BTreeMap<String, HarnessMcpTool>,
    provider_binding: String,
}

pub(crate) struct AdmittedCall {
    pub(crate) provider_binding: String,
    pub(crate) tool_schema_sha256: String,
    pub(crate) requires_approval: bool,
}

impl AttemptMcp {
    /// Opens each granted server: a Workspace server from `workspace`, which this Attempt
    /// already recorded with the Control Plane, and any other from the host catalog.
    pub(crate) async fn prepare(
        catalog: &McpCatalog,
        (workspace, sandbox): (Option<&WorkspaceMcp>, Option<&SandboxConnection>),
        task: &Task,
        cancel: &CancellationToken,
    ) -> Result<Option<Self>, Status> {
        let names = mcp::grants(task)
            .map(|(_, permission)| mcp::parse_action(&permission.action).map(|(server, _)| server))
            .collect::<Option<BTreeSet<_>>>()
            .ok_or(Failure::Denied)?;
        if names.is_empty() {
            return Ok(None);
        }
        let workspace_names = mcp::workspace_servers(task);
        let mut attempt = Self {
            servers: BTreeMap::new(),
            secrets: catalog
                .secrets
                .iter()
                .chain(workspace.iter().flat_map(|workspace| &workspace.secrets))
                .cloned()
                .collect(),
        };
        let client = http::client()?;
        let discovery_deadline = Instant::now() + DISCOVERY_TIMEOUT;
        let mut bytes = 0usize;
        let mut count = 0usize;
        for name in names {
            let config = if workspace_names.contains(name) {
                workspace
                    .and_then(|workspace| workspace.servers.get(name))
                    .filter(|config| {
                        workspace.is_some_and(|workspace| {
                            workspace.record.servers.contains(&config.capability)
                        })
                    })
            } else {
                catalog.servers.get(name).filter(|config| {
                    task.attempt_execution
                        .as_ref()
                        .is_some_and(|execution| execution.mcp_servers.contains(&config.capability))
                })
            };
            let Some(config) = config else {
                attempt.close().await;
                return Err(Failure::Denied.into());
            };
            let mut session =
                match Session::open(&client, (name, config), catalog.logins.as_ref(), sandbox) {
                    Ok(session) => session,
                    Err(failure) => {
                        attempt.close().await;
                        return Err(failure.into());
                    }
                };
            let tools = tokio::select! {
                biased;
                _ = cancel.cancelled() => Err(Failure::Cancelled),
                result = time::timeout_at(discovery_deadline, discover(&mut session, task, name, config, &attempt.secrets)) => result.unwrap_or(Err(Failure::Unavailable)),
            };
            attempt.secrets.extend(session.credentials());
            let tools = match tools {
                Ok(tools) => tools,
                Err(failure) => {
                    session.close().await;
                    attempt.close().await;
                    return Err(failure.into());
                }
            };
            bytes += tools
                .values()
                .map(|tool| {
                    tool.server.len()
                        + tool.name.len()
                        + tool.description.len()
                        + tool.input_schema_json.len()
                        + 32
                })
                .sum::<usize>();
            count += tools.len();
            attempt.servers.insert(
                name.into(),
                AttemptServer {
                    session: Arc::new(Mutex::new(session)),
                    resources: config.resources.clone(),
                    tools,
                    provider_binding: config
                        .capability
                        .provider_binding
                        .clone()
                        .expect("verified provider binding"),
                },
            );
            if bytes > MAX_MESSAGE_BYTES / 2 || count > mcp::MAX_TOOLS {
                attempt.close().await;
                return Err(Failure::ResponseTooLarge.into());
            }
        }
        // A later server's session credential must also be absent from all catalog output.
        if attempt.list().iter().any(|tool| {
            contains_secret(&tool.description, &attempt.secrets)
                || contains_secret(&tool.input_schema_json, &attempt.secrets)
                || contains_secret(&tool.name, &attempt.secrets)
                || contains_secret(&tool.server, &attempt.secrets)
        }) {
            attempt.close().await;
            return Err(Failure::InvalidResponse.into());
        }
        Ok(Some(attempt))
    }

    pub(crate) fn list(&self) -> Vec<HarnessMcpTool> {
        self.servers
            .values()
            .flat_map(|server| server.tools.values().cloned())
            .collect()
    }

    pub(crate) fn authorize(
        &self,
        task: &Task,
        server: &str,
        tool: &str,
        arguments: &str,
    ) -> Result<AdmittedCall, Status> {
        let server_config = self.servers.get(server).ok_or(Failure::Denied)?;
        let discovered = server_config.tools.get(tool).ok_or(Failure::Denied)?;
        if arguments.len() > mcp::MAX_ARGUMENT_BYTES {
            return Err(Failure::InvalidArguments.into());
        }
        // Only the parsed object reaches the provider, so it sees exactly the arguments checked here.
        let parsed: Value =
            serde_json::from_str(arguments).map_err(|_| Failure::InvalidArguments)?;
        if !parsed.is_object() || has_secret(&parsed, &self.secrets) {
            return Err(Failure::InvalidArguments.into());
        }
        let mapping = server_config
            .resources
            .get(tool)
            .map(Vec::as_slice)
            .unwrap_or_default();
        let authority =
            mcp::authorize(task, server, tool, mapping, &parsed).map_err(|_| Failure::Denied)?;
        Ok(AdmittedCall {
            provider_binding: server_config.provider_binding.clone(),
            tool_schema_sha256: format!(
                "{:x}",
                Sha256::digest(discovered.input_schema_json.as_bytes())
            ),
            requires_approval: !authority.gates.is_empty(),
        })
    }

    pub(crate) async fn call(
        &self,
        server: &str,
        tool: &str,
        arguments: Value,
    ) -> Result<String, Status> {
        let server = self.servers.get(server).ok_or(Failure::Denied)?;
        let mut session = server.session.lock().await;
        if *session.unconfirmed_call() {
            return Err(Failure::UnconfirmedCall.into());
        }
        *session.unconfirmed_call() = true;
        let result = session
            .rpc("tools/call", json!({"name":tool, "arguments":arguments}))
            .await?;
        let content = result
            .get("content")
            .and_then(Value::as_array)
            .ok_or(Failure::InvalidResponse)?;
        if result
            .get("isError")
            .is_some_and(|value| !value.is_boolean())
            || result
                .get("structuredContent")
                .is_some_and(|value| !value.is_object())
        {
            return Err(Failure::InvalidResponse.into());
        }
        // An upstream server can reflect a header or session ID. Check decoded strings as well
        // as raw JSON, and withhold the whole result rather than alter structured content.
        let mut sanitized = json!({"content":content});
        if let Some(value) = result.get("isError") {
            sanitized["isError"] = value.clone();
        }
        if let Some(value) = result.get("structuredContent") {
            sanitized["structuredContent"] = value.clone();
        }
        // A refreshed OAuth access token is as private as the catalog's own credentials.
        if has_secret(&sanitized, &self.secrets) || has_secret(&sanitized, &session.credentials()) {
            return Err(Failure::InvalidResponse.into());
        }
        *session.unconfirmed_call() = false;
        Ok(sanitized.to_string())
    }

    pub(crate) async fn close(&self) {
        let mut closing = JoinSet::new();
        for server in self.servers.values() {
            let session = server.session.clone();
            closing.spawn(async move {
                // A stdio server gets its grace period before SIGKILL.
                let _ = tokio::time::timeout(Duration::from_secs(5), async {
                    session.lock().await.close().await;
                })
                .await;
            });
        }
        while closing.join_next().await.is_some() {}
    }
}

fn matches<'a>(
    task: &'a Task,
    server: &str,
    tool: &str,
) -> impl Iterator<Item = &'a PolicyPermission> {
    mcp::grants(task).filter_map(move |(_, grant)| {
        let (name, pattern) = mcp::parse_action(&grant.action)?;
        (name == server && mcp::tool_matches(pattern, tool)).then_some(grant)
    })
}

async fn discover(
    session: &mut Session,
    task: &Task,
    name: &str,
    config: &catalog::Server,
    secrets: &[String],
) -> Result<BTreeMap<String, HarnessMcpTool>, Failure> {
    session.initialize().await?;
    let mut tools = BTreeMap::new();
    let mut names = BTreeSet::new();
    let mut cursor = None;
    let mut cursors = BTreeSet::new();
    for _ in 0..DISCOVERY_PAGES {
        let page = session
            .rpc(
                "tools/list",
                cursor.map_or_else(|| json!({}), |cursor| json!({"cursor": cursor})),
            )
            .await?;
        let definitions = page
            .get("tools")
            .and_then(Value::as_array)
            .ok_or(Failure::InvalidResponse)?;
        for definition in definitions {
            let name_of_tool = definition
                .get("name")
                .and_then(Value::as_str)
                .filter(|name| mcp::tool_name(name))
                .ok_or(Failure::InvalidResponse)?;
            if !names.insert(name_of_tool.to_owned()) || names.len() > 1024 {
                return Err(Failure::InvalidResponse);
            }
            if !matches(task, name, name_of_tool).any(|grant| {
                grant.resource.is_empty() || config.resources.contains_key(name_of_tool)
            }) {
                continue;
            }
            let schema = definition
                .get("inputSchema")
                .filter(|schema| schema.get("type").and_then(Value::as_str) == Some("object"))
                .ok_or(Failure::InvalidResponse)?;
            let description = definition
                .get("description")
                .map_or(Some(""), Value::as_str)
                .ok_or(Failure::InvalidResponse)?;
            let input_schema_json = schema.to_string();
            if input_schema_json.len() > SCHEMA_BYTES || description.len() > 2048 {
                return Err(Failure::ResponseTooLarge);
            }
            if has_secret(definition, secrets) || has_secret(definition, &session.credentials()) {
                return Err(Failure::InvalidResponse);
            }
            tools.insert(
                name_of_tool.to_owned(),
                HarnessMcpTool {
                    server: name.into(),
                    name: name_of_tool.into(),
                    description: description.into(),
                    input_schema_json,
                },
            );
        }
        let Some(next) = page.get("nextCursor") else {
            return Ok(tools);
        };
        let next = next
            .as_str()
            .filter(|cursor| !cursor.is_empty() && cursor.len() <= 1024)
            .ok_or(Failure::InvalidResponse)?;
        if !cursors.insert(next.to_owned()) {
            return Err(Failure::InvalidResponse);
        }
        cursor = Some(next.to_owned());
    }
    Err(Failure::ResponseTooLarge)
}

fn contains_secret(value: &str, secrets: &[String]) -> bool {
    secrets.iter().any(|secret| value.contains(secret))
}

fn has_secret(value: &Value, secrets: &[String]) -> bool {
    match value {
        Value::String(value) => contains_secret(value, secrets),
        Value::Array(entries) => entries.iter().any(|value| has_secret(value, secrets)),
        Value::Object(entries) => entries
            .iter()
            .any(|(key, value)| contains_secret(key, secrets) || has_secret(value, secrets)),
        _ => false,
    }
}

/// A raw loopback HTTP server for tests: answers each request with the next canned response
/// and reports every request as `METHOD PATH`, its headers, and its body.
/// Starts one sandboxed stdio server, lists its tools, calls the first, and closes it.
#[cfg(test)]
pub(crate) async fn sandbox_round_trip(
    connection: &SandboxConnection,
    name: &str,
    command: &[String],
) -> Result<Vec<String>, Status> {
    let mut session = stdio::Session::start_sandbox(connection, name, command)?;
    session.initialize().await?;
    let listed = session.rpc("tools/list", json!({})).await?;
    let tool = listed["tools"][0]["name"]
        .as_str()
        .ok_or(Failure::InvalidResponse)?
        .to_owned();
    let called = session
        .rpc("tools/call", json!({"name": tool, "arguments": {}}))
        .await?;
    let text = called["content"][0]["text"]
        .as_str()
        .ok_or(Failure::InvalidResponse)?
        .to_owned();
    session.close().await;
    Ok(vec![tool, text])
}

#[cfg(test)]
pub(super) mod test_http {
    use std::net::SocketAddr;

    use tokio::{
        io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
        net::TcpListener,
        task::JoinHandle,
    };

    pub(crate) struct Request {
        pub(crate) line: String,
        pub(crate) headers: Vec<String>,
        pub(crate) body: String,
    }

    pub(crate) async fn serve(
        responses: Vec<(u16, &'static str, String)>,
    ) -> (SocketAddr, JoinHandle<Vec<Request>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let mut requests = Vec::new();
            for (status, content_type, body) in responses {
                let (stream, _) = listener.accept().await.unwrap();
                let mut stream = BufReader::new(stream);
                let mut line = String::new();
                stream.read_line(&mut line).await.unwrap();
                let mut headers = Vec::new();
                let mut length = 0;
                loop {
                    let mut header = String::new();
                    stream.read_line(&mut header).await.unwrap();
                    if header == "\r\n" {
                        break;
                    }
                    let lower = header.to_ascii_lowercase();
                    if let Some(value) = lower.strip_prefix("content-length:") {
                        length = value.trim().parse().unwrap();
                    }
                    headers.push(lower.trim().to_owned());
                }
                let mut request_body = vec![0u8; length];
                stream.read_exact(&mut request_body).await.unwrap();
                requests.push(Request {
                    line: line.trim().to_owned(),
                    headers,
                    body: String::from_utf8(request_body).unwrap(),
                });
                stream
                    .write_all(
                        format!(
                            "HTTP/1.1 {status} X\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
            }
            requests
        });
        (address, task)
    }
}
