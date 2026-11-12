mod catalog;
mod http;

use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
    time::Duration,
};

use serde_json::{Value, json};
use supertag_protocol::{
    MAX_MESSAGE_BYTES, mcp,
    v2::{HarnessMcpTool, PolicyPermission, Task},
};
use tokio::time::{self, Instant};
use tokio::{sync::Mutex, task::JoinSet};
use tokio_util::sync::CancellationToken;
use tonic::Status;

pub use catalog::McpCatalog;

const SCHEMA_BYTES: usize = 16 * 1024;
const ARGUMENT_BYTES: usize = 64 * 1024;
const DISCOVERY_PAGES: usize = 16;
const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Failure {
    Denied,
    ApprovalRequired,
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
            Failure::ApprovalRequired => {
                Self::failed_precondition("MCP call requires approval and was not sent")
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

struct AttemptServer {
    session: Arc<Mutex<http::Session>>,
    resources: BTreeMap<String, Vec<catalog::ResourceRule>>,
    tools: BTreeMap<String, HarnessMcpTool>,
}

impl AttemptMcp {
    pub(crate) async fn prepare(
        catalog: &McpCatalog,
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
        let mut attempt = Self {
            servers: BTreeMap::new(),
            secrets: catalog.secrets.clone(),
        };
        let client = http::client()?;
        let discovery_deadline = Instant::now() + DISCOVERY_TIMEOUT;
        let mut bytes = 0usize;
        let mut count = 0usize;
        for name in names {
            let Some(config) = catalog.servers.get(name) else {
                attempt.close().await;
                return Err(Failure::Denied.into());
            };
            let mut session = http::Session::new(client.clone(), config.clone());
            let tools = tokio::select! {
                biased;
                _ = cancel.cancelled() => Err(Failure::Cancelled),
                result = time::timeout_at(discovery_deadline, discover(&mut session, task, name, config, &attempt.secrets)) => result.unwrap_or(Err(Failure::Unavailable)),
            };
            if let Some(session_id) = session.session_id() {
                attempt.secrets.push(session_id.into());
            }
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
    ) -> Result<Value, Status> {
        let server_config = self
            .servers
            .get(server)
            .filter(|config| config.tools.contains_key(tool))
            .ok_or(Failure::Denied)?;
        if arguments.len() > ARGUMENT_BYTES {
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
        authorize(task, server, tool, mapping, &parsed)?;
        Ok(parsed)
    }

    pub(crate) async fn call(
        &self,
        server: &str,
        tool: &str,
        arguments: Value,
    ) -> Result<String, Status> {
        let server = self.servers.get(server).ok_or(Failure::Denied)?;
        let mut session = server.session.lock().await;
        if session.unconfirmed_call {
            return Err(Failure::UnconfirmedCall.into());
        }
        session.unconfirmed_call = true;
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
        if has_secret(&sanitized, &self.secrets) {
            return Err(Failure::InvalidResponse.into());
        }
        session.unconfirmed_call = false;
        Ok(sanitized.to_string())
    }

    pub(crate) async fn close(&self) {
        let mut closing = JoinSet::new();
        for server in self.servers.values() {
            let session = server.session.clone();
            closing.spawn(async move {
                let _ = tokio::time::timeout(Duration::from_secs(3), async {
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

fn authorize(
    task: &Task,
    server: &str,
    tool: &str,
    mapping: &[catalog::ResourceRule],
    arguments: &Value,
) -> Result<(), Failure> {
    let resource = catalog::resource(mapping, arguments).map_err(|_| Failure::Denied)?;
    let mut allowed = false;
    for grant in matches(task, server, tool) {
        let covers = grant.resource.is_empty() || resource.as_deref() == Some(&grant.resource);
        if grant.approval_required && (covers || resource.is_none()) {
            return Err(Failure::ApprovalRequired);
        }
        allowed |= covers;
    }
    if !allowed {
        return Err(Failure::Denied);
    }
    Ok(())
}

async fn discover(
    session: &mut http::Session,
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
            if has_secret(definition, secrets)
                || session
                    .session_id()
                    .is_some_and(|id| has_secret(definition, &[id.into()]))
            {
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
