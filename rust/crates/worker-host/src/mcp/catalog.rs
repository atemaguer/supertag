use std::{
    collections::{BTreeMap, BTreeSet},
    fs::OpenOptions,
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::Path,
};

use anyhow::{Context, Result, ensure};

use super::oauth::McpLoginStore;
use prost::Message;
use reqwest::{
    Url,
    header::{HeaderMap, HeaderName, HeaderValue},
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use supertag_protocol::{
    mcp,
    v2::{
        HarnessExecutionProfile, McpResourceBinding, McpResourceComponent, McpResourceCondition,
        McpResourceRule, McpServerCapability,
    },
};

const CATALOG_BYTES: u64 = 128 * 1024;

#[derive(Clone, Default)]
pub struct McpCatalog {
    pub(super) servers: BTreeMap<String, Server>,
    pub(super) secrets: Vec<String>,
    pub(super) logins: Option<McpLoginStore>,
}

#[derive(Clone)]
pub(super) struct Server {
    pub(super) transport: Transport,
    pub(super) resources: BTreeMap<String, Vec<McpResourceRule>>,
    pub(super) capability: McpServerCapability,
}

#[derive(Clone)]
pub(super) enum Transport {
    Http(HttpServer),
    Stdio(StdioServer),
}

#[derive(Clone)]
pub(super) struct HttpServer {
    pub(super) name: String,
    pub(super) endpoint: Url,
    pub(super) headers: HeaderMap,
    /// Whether the Authorization header comes from this host's `supertag mcp login`.
    pub(super) oauth: bool,
}

/// A server the Worker Host launches for each Task Attempt. Only `env`, resolved from the
/// Worker Host environment when the catalog loads, and a minimal default environment reach it.
#[derive(Clone)]
pub(super) struct StdioServer {
    pub(super) command: Vec<String>,
    pub(super) env: BTreeMap<String, String>,
    /// A Workspace server runs in the Worker-owned snapshot of its Task's base commit.
    pub(super) cwd: Option<std::path::PathBuf>,
    /// A Workspace server of a remote Workspace runs inside the Task's sandbox, in the
    /// provider's trusted copy of the base commit, with no `env` and no `cwd` of the host.
    pub(super) sandboxed: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Config {
    version: u32,
    pub(super) servers: Vec<ServerConfig>,
}

/// Parses only the catalog's shape, resolving nothing, for `supertag mcp list` and login.
pub(super) fn read_config(path: &Path) -> Result<Config> {
    decode(&read_private(path)?)
}

/// Decodes a catalog and expands each server's `preset` to its official URL and mapping.
fn decode(bytes: &[u8]) -> Result<Config> {
    let mut config: Config =
        serde_json::from_slice(bytes).map_err(|_| anyhow::anyhow!("invalid MCP catalog format"))?;
    ensure!(
        config.version == 1 && config.servers.len() <= mcp::MAX_SERVERS,
        "unsupported MCP catalog version or size"
    );
    for server in &mut config.servers {
        apply_preset(server)?;
    }
    Ok(config)
}

/// The official HTTP servers SuperTag knows, as in the TypeScript host service. A preset fixes
/// the URL its resource mapping was written for, so Permission Set grants on its tools can name
/// a `resource`. The Teams server's URL names the Microsoft tenant.
fn apply_preset(server: &mut ServerConfig) -> Result<()> {
    let Some(preset) = server.preset.as_deref() else {
        ensure!(
            server.tenant_id.is_none(),
            "MCP server {}: tenantId belongs only with preset teams",
            server.name
        );
        return Ok(());
    };
    if preset == "lark" {
        return apply_lark_preset(server);
    }
    ensure!(
        server.url.is_none() && server.command.is_none(),
        "MCP server {}: url must not be set with a preset; the {preset} preset uses its official URL and resource mapping. For another server, drop preset and give url",
        server.name
    );
    ensure!(
        server.resources.tools.is_empty(),
        "MCP server {}: the {preset} preset supplies its own resource mapping",
        server.name
    );
    let rule = |prefix: &str, separator: &str, components: &[&[&str]]| ResourceRule {
        prefix: prefix.into(),
        separator: separator.into(),
        components: components
            .iter()
            .map(|arguments| Component {
                arguments: arguments
                    .iter()
                    .map(|argument| (*argument).into())
                    .collect(),
            })
            .collect(),
        when: None,
    };
    let (url, tools, rule) = match preset {
        "github" => (
            "https://api.githubcopilot.com/mcp/".to_owned(),
            &[
                "get_file_contents",
                "issue_read",
                "add_issue_comment",
                "pull_request_read",
                "create_branch",
                "create_pull_request",
                "merge_pull_request",
            ][..],
            rule("repository:", "/", &[&["owner"], &["repo", "repository"]]),
        ),
        "slack" => (
            "https://mcp.slack.com/mcp".to_owned(),
            &[
                "slack_read_channel",
                "slack_read_thread",
                "slack_send_message",
            ][..],
            rule("channel:", "", &[&["channel_id", "channelId", "channel"]]),
        ),
        "linear" => (
            "https://mcp.linear.app/mcp".to_owned(),
            &["list_issues", "create_issue"][..],
            rule("team:", "", &[&["team_id", "teamId", "team"]]),
        ),
        "teams" => {
            let tenant = server
                .tenant_id
                .as_deref()
                .map(str::trim)
                .filter(|tenant| {
                    !tenant.is_empty()
                        && tenant.len() <= 253
                        && tenant
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || b".-".contains(&byte))
                })
                .with_context(|| {
                    format!(
                        "MCP server {}: tenantId is required for the teams preset: the Microsoft Entra tenant ID or domain",
                        server.name
                    )
                })?;
            (
                format!(
                    "https://agent365.svc.cloud.microsoft/agents/tenants/{tenant}/servers/mcp_TeamsServer"
                ),
                &[
                    "mcp_graph_teams_listChannelMessages",
                    "mcp_graph_teams_postChannelMessage",
                    "mcp_graph_teams_replyToChannelMessage",
                ][..],
                rule(
                    "team:",
                    "/channel:",
                    &[&["team_id", "teamId"], &["channel_id", "channelId"]],
                ),
            )
        }
        _ => anyhow::bail!(
            "MCP server {}: preset must be github, slack, linear, teams, or lark",
            server.name
        ),
    };
    if preset != "teams" {
        ensure!(
            server.tenant_id.is_none(),
            "MCP server {}: tenantId belongs only with preset teams",
            server.name
        );
    }
    server.url = Some(url);
    server.resources.tools = tools
        .iter()
        .map(|tool| ((*tool).to_owned(), vec![rule.clone()]))
        .collect();
    Ok(())
}

/// The official Lark stdio server, as in the TypeScript host service: the pinned
/// `@larksuiteoapi/lark-mcp` package, run through `npx` on the Worker Host, which gives its App
/// credentials in `env` (`APP_ID`, `APP_SECRET`, and optionally `LARK_DOMAIN`). Only a chat
/// recipient is checkable; a user or email recipient names no chat resource.
pub(super) const LARK_PACKAGE: &str = "@larksuiteoapi/lark-mcp@0.5.1";

fn apply_lark_preset(server: &mut ServerConfig) -> Result<()> {
    ensure!(
        server.url.is_none() && server.command.is_none(),
        "MCP server {}: command must not be set with a preset; the lark preset runs its official server",
        server.name
    );
    ensure!(
        server.tenant_id.is_none(),
        "MCP server {}: tenantId belongs only with preset teams",
        server.name
    );
    ensure!(
        server.resources.tools.is_empty(),
        "MCP server {}: the lark preset supplies its own resource mapping",
        server.name
    );
    server.command = Some(
        [
            "npx",
            "-y",
            LARK_PACKAGE,
            "mcp",
            "--tool-name-case",
            "snake",
        ]
        .map(str::to_owned)
        .to_vec(),
    );
    let chat = |argument: &str, equals: &str, component: &str| ResourceRule {
        prefix: "chat:".into(),
        separator: String::new(),
        components: vec![Component {
            arguments: vec![component.into()],
        }],
        when: Some(Condition {
            argument: argument.into(),
            equals: equals.into(),
        }),
    };
    server.resources.tools = BTreeMap::from([
        (
            "im_v1_message_list".to_owned(),
            vec![chat(
                "params.container_id_type",
                "chat",
                "params.container_id",
            )],
        ),
        (
            "im_v1_message_create".to_owned(),
            vec![chat("params.receive_id_type", "chat_id", "data.receive_id")],
        ),
    ]);
    Ok(())
}

fn read_private(path: &Path) -> Result<Vec<u8>> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| anyhow::anyhow!("MCP catalog could not be opened"))?;
    let metadata = file.metadata()?;
    // SAFETY: geteuid takes no parameters and has no caller invariants.
    let uid = unsafe { libc::geteuid() };
    ensure!(
        metadata.is_file()
            && metadata.nlink() == 1
            && metadata.uid() == uid
            && metadata.mode() & 0o077 == 0
            && metadata.len() <= CATALOG_BYTES,
        "MCP catalog must be a bounded, owner-only regular file"
    );
    let mut bytes = Vec::new();
    file.take(CATALOG_BYTES + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= CATALOG_BYTES,
        "MCP catalog exceeds its limit"
    );
    Ok(bytes)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ServerConfig {
    pub(super) name: String,
    pub(super) url: Option<String>,
    /// An official server SuperTag knows: HTTP `github`, `slack`, `linear`, or `teams`, or
    /// stdio `lark`.
    pub(super) preset: Option<String>,
    /// The Microsoft Entra tenant, for the `teams` preset only.
    pub(super) tenant_id: Option<String>,
    #[serde(default)]
    pub(super) header_env: BTreeMap<String, String>,
    #[serde(default)]
    pub(super) oauth: bool,
    /// A stdio server: the executable and its arguments.
    pub(super) command: Option<Vec<String>>,
    /// A stdio server's environment: each variable it receives, mapped to the Worker Host
    /// variable that holds its value, or to `{"file": PATH}`, an owner-only file that holds it.
    #[serde(default)]
    pub(super) env: BTreeMap<String, EnvSource>,
    #[serde(default)]
    resources: ResourceMapping,
}

/// Where a stdio server's variable comes from. Never the value itself.
#[derive(Clone, Deserialize)]
#[serde(untagged)]
pub(super) enum EnvSource {
    /// A Worker Host environment variable.
    Variable(String),
    File(FileSource),
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct FileSource {
    file: std::path::PathBuf,
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct ResourceMapping {
    tools: BTreeMap<String, Vec<ResourceRule>>,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct ResourceRule {
    #[serde(default)]
    prefix: String,
    #[serde(default)]
    separator: String,
    components: Vec<Component>,
    when: Option<Condition>,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Component {
    arguments: Vec<String>,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Condition {
    argument: String,
    equals: String,
}

/// One catalog server as `supertag mcp list` shows it: references and states, never values.
#[derive(Debug, PartialEq, Eq)]
pub struct McpCatalogEntry {
    pub name: String,
    /// The URL of an HTTP server, or `stdio: EXECUTABLE` (never its arguments).
    pub target: String,
    /// `none`, `headers`, `oauth login`, or `env`.
    pub auth: &'static str,
    /// The URL an `"oauth": true` server's login is for.
    pub login_url: Option<String>,
    /// Worker Host variables the server reads that are unset here.
    pub missing: Vec<String>,
}

impl McpCatalog {
    /// Each server of the catalog at `path`, resolving nothing.
    pub fn entries(path: &Path) -> Result<Vec<McpCatalogEntry>> {
        let config = read_config(path)?;
        Ok(config
            .servers
            .into_iter()
            .map(|server| {
                let variable_missing = |source: &String| {
                    std::env::var(source).map_or(true, |value| value.trim().is_empty())
                };
                let missing = if server.command.is_some() {
                    server
                        .env
                        .values()
                        .filter_map(|source| match source {
                            EnvSource::Variable(variable) => {
                                variable_missing(variable).then(|| variable.clone())
                            }
                            EnvSource::File(source) => read_env_file(&source.file)
                                .is_err()
                                .then(|| source.file.display().to_string()),
                        })
                        .collect()
                } else {
                    server
                        .header_env
                        .values()
                        .filter(|source| variable_missing(source))
                        .cloned()
                        .collect()
                };
                let (target, auth, login_url) = match (&server.url, &server.command) {
                    (_, Some(command)) => (
                        format!(
                            "stdio: {}",
                            command.first().map(String::as_str).unwrap_or_default()
                        ),
                        if server.env.is_empty() { "none" } else { "env" },
                        None,
                    ),
                    (Some(url), None) if server.oauth => {
                        (url.clone(), "oauth login", Some(url.clone()))
                    }
                    (Some(url), None) => (
                        url.clone(),
                        if server.header_env.is_empty() {
                            "none"
                        } else {
                            "headers"
                        },
                        None,
                    ),
                    (None, None) => (String::new(), "none", None),
                };
                McpCatalogEntry {
                    name: server.name,
                    target,
                    auth,
                    login_url,
                    missing,
                }
            })
            .collect())
    }

    /// Loads the catalog. Servers with `"oauth": true` take their tokens from `logins`, the
    /// store `supertag mcp login` writes. As in the TypeScript host service, a server this host
    /// never logged in to refuses the start; one whose login lapsed is advertised as needing a
    /// new login, so Tasks that need it wait.
    pub fn load(path: Option<&Path>, logins: Option<McpLoginStore>) -> Result<Self> {
        let Some(path) = path else {
            return Ok(Self::default());
        };
        let bytes = read_private(path)?;
        let mut catalog = Self::parse(&bytes, |name| std::env::var(name).ok())?;
        for server in catalog.servers.values() {
            if let Transport::Http(http) = &server.transport
                && http.oauth
            {
                let store = logins.as_ref().ok_or_else(|| {
                    anyhow::anyhow!("MCP server {} needs an MCP login store", http.name)
                })?;
                if let Err(error) = store.check(&http.name, http.endpoint.as_str())
                    && store.state(&http.name, http.endpoint.as_str(), super::oauth::now_ms())
                        == super::oauth::McpLoginState::Missing
                {
                    return Err(error);
                }
            }
        }
        catalog.logins = logins;
        Ok(catalog)
    }

    /// OAuth servers without a current login on this host: never logged in, logged in for
    /// another URL, or lapsed. Each needs `supertag mcp login NAME`.
    pub fn lapsed_logins(&self) -> Vec<String> {
        self.servers
            .iter()
            .filter(|(name, server)| match &server.transport {
                Transport::Http(http) if http.oauth => self
                    .logins
                    .as_ref()
                    .is_none_or(|store| store.check(name, http.endpoint.as_str()).is_err()),
                _ => false,
            })
            .map(|(name, _)| name.clone())
            .collect()
    }

    /// The profile this host advertises now: each server in `lapsed` moves from `mcp_servers`
    /// to `mcp_login_servers`, so no Task that needs it is placed here until its login.
    pub fn advertised(
        profile: &HarnessExecutionProfile,
        lapsed: &[String],
    ) -> HarnessExecutionProfile {
        let mut advertised = profile.clone();
        advertised
            .mcp_servers
            .retain(|server| !lapsed.contains(&server.name));
        advertised.mcp_login_servers = lapsed.to_vec();
        advertised.mcp_login_servers.sort_unstable();
        advertised
    }

    pub(super) fn parse(
        bytes: &[u8],
        environment: impl Fn(&str) -> Option<String>,
    ) -> Result<Self> {
        let config = decode(bytes)?;
        let mut catalog = Self::default();
        let mut secrets = BTreeSet::new();
        for server in config.servers {
            ensure!(
                mcp::server_name(&server.name),
                "invalid or reserved MCP server name"
            );
            let transport = match (&server.url, &server.command) {
                (Some(url), None) => {
                    ensure!(
                        server.env.is_empty(),
                        "MCP server {}: env is for stdio servers; an HTTP server uses headerEnv",
                        server.name
                    );
                    Transport::Http(http_server(&server, url, &environment, &mut secrets)?)
                }
                (None, Some(command)) => {
                    ensure!(
                        server.header_env.is_empty() && !server.oauth,
                        "MCP server {}: a stdio server has no HTTP authentication; pass its credentials in env",
                        server.name
                    );
                    Transport::Stdio(stdio_server(&server, command, &environment, &mut secrets)?)
                }
                _ => anyhow::bail!(
                    "MCP server {} needs exactly one of url (HTTP) or command (stdio)",
                    server.name
                ),
            };
            let resources: BTreeMap<_, Vec<McpResourceRule>> = server
                .resources
                .tools
                .into_iter()
                .map(|(name, rules)| (name, rules.into_iter().map(Into::into).collect()))
                .collect();
            ensure!(
                resources.len() <= mcp::MAX_TOOLS
                    && resources.iter().all(|(tool, rules)| {
                        mcp::tool_name(tool)
                            && !rules.is_empty()
                            && rules.len() <= 16
                            && rules.iter().all(mcp::valid_resource_rule)
                    }),
                "invalid MCP tool resource mapping"
            );
            let bindings: Vec<_> = resources
                .iter()
                .map(|(tool, rules)| McpResourceBinding {
                    tool: tool.clone(),
                    rules: rules.clone(),
                })
                .collect();
            let mut identity = Sha256::new();
            match &transport {
                Transport::Http(http) => {
                    identity.update(b"supertag-mcp-provider-binding-v1\0");
                    let headers_by_name: BTreeMap<_, _> = http
                        .headers
                        .iter()
                        .map(|(name, value)| (name.as_str(), value.as_bytes()))
                        .collect();
                    identity.update(serde_json::to_vec(&(
                        http.endpoint.as_str(),
                        headers_by_name,
                    ))?);
                    // A login's tokens rotate; the binding names the login, not a token.
                    if http.oauth {
                        identity.update(b"\0oauth-login\0");
                        identity.update(server.name.as_bytes());
                    }
                }
                Transport::Stdio(stdio) => {
                    identity.update(b"supertag-mcp-stdio-provider-binding-v1\0");
                    identity.update(serde_json::to_vec(&(&stdio.command, &stdio.env))?);
                }
            }
            for binding in &bindings {
                let mut frame = Vec::new();
                binding.encode_length_delimited(&mut frame)?;
                identity.update(frame);
            }
            let capability = McpServerCapability {
                name: server.name.clone(),
                mapped_tools: resources.keys().cloned().collect(),
                provider_binding: Some(format!("{:x}", identity.finalize())),
                resource_bindings: bindings,
            };
            ensure!(
                catalog
                    .servers
                    .insert(
                        server.name,
                        Server {
                            transport,
                            resources,
                            capability,
                        }
                    )
                    .is_none(),
                "duplicate MCP server name"
            );
        }
        catalog.secrets = secrets.into_iter().collect();
        catalog
            .secrets
            .sort_unstable_by_key(|value| std::cmp::Reverse(value.len()));
        let private = |value: &str| catalog.secrets.iter().any(|secret| value.contains(secret));
        ensure!(
            catalog
                .servers
                .values()
                .flat_map(|server| server.resources.values().flatten())
                .all(|rule| !private(&rule.prefix)
                    && !private(&rule.separator)
                    && !rule
                        .components
                        .iter()
                        .flat_map(|component| &component.arguments)
                        .any(|path| private(path))
                    && rule
                        .when
                        .as_ref()
                        .is_none_or(|condition| !private(&condition.argument)
                            && !private(&condition.equals))),
            "MCP resource mappings must not contain provider credentials"
        );
        Ok(catalog)
    }

    pub fn capabilities(&self) -> Vec<McpServerCapability> {
        self.servers
            .values()
            .map(|server| server.capability.clone())
            .collect()
    }
}

fn http_server(
    server: &ServerConfig,
    url: &str,
    environment: &impl Fn(&str) -> Option<String>,
    secrets: &mut BTreeSet<String>,
) -> Result<HttpServer> {
    let endpoint = validate_url(url)?;
    secrets.insert(endpoint.as_str().into());
    ensure!(
        server.header_env.len() <= 16,
        "too many MCP request headers"
    );
    let mut headers = HeaderMap::new();
    for (name, variable) in &server.header_env {
        let name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| anyhow::anyhow!("invalid MCP request header"))?;
        ensure!(
            valid_header(&name) && valid_env(variable),
            "invalid MCP request header binding"
        );
        ensure!(
            !(server.oauth && name == reqwest::header::AUTHORIZATION),
            "MCP server {}: with oauth, its login supplies the Authorization header",
            server.name
        );
        let value = environment(variable)
            .filter(|value| !value.trim().is_empty() && value.len() <= 4096)
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "a configured MCP header environment variable is missing or invalid"
                )
            })?;
        let mut header = HeaderValue::from_str(&value)
            .map_err(|_| anyhow::anyhow!("invalid MCP header environment value"))?;
        header.set_sensitive(true);
        ensure!(
            headers.insert(name, header).is_none(),
            "duplicate MCP request header"
        );
        if let Some((scheme, credential)) = value.split_once(' ')
            && (scheme.eq_ignore_ascii_case("bearer") || scheme.eq_ignore_ascii_case("basic"))
            && !credential.trim().is_empty()
        {
            secrets.insert(credential.trim().into());
        }
        secrets.insert(value);
    }
    Ok(HttpServer {
        name: server.name.clone(),
        endpoint,
        headers,
        oauth: server.oauth,
    })
}

/// Values shorter than this are passed to a stdio server but are too short to recognize in its
/// output; `env` is meant for credentials, which are longer.
pub(super) const TRACKED_ENV_VALUE_BYTES: usize = 8;

fn stdio_server(
    server: &ServerConfig,
    command: &[String],
    environment: &impl Fn(&str) -> Option<String>,
    secrets: &mut BTreeSet<String>,
) -> Result<StdioServer> {
    let name = &server.name;
    ensure!(
        !command.is_empty()
            && command.len() <= 64
            && !command[0].trim().is_empty()
            && command
                .iter()
                .all(|part| { part.len() <= 4096 && !part.contains('\0') && !part.contains("${") }),
        "MCP server {name}: command must list the executable and its arguments, without environment references"
    );
    ensure!(
        server.env.len() <= 32,
        "MCP server {name} sets too many environment variables"
    );
    let mut env = BTreeMap::new();
    for (variable, source) in &server.env {
        ensure!(
            valid_server_env(variable),
            "MCP server {name}: env must map variable names to Worker Host variables not named SUPERTAG_*"
        );
        let value = match source {
            EnvSource::Variable(source) => {
                ensure!(
                    valid_env(source),
                    "MCP server {name}: env must map variable names to Worker Host variables not named SUPERTAG_*"
                );
                environment(source)
                    .map(|value| value.trim().to_owned())
                    .filter(|value| {
                        !value.is_empty() && value.len() <= 4096 && !value.contains('\0')
                    })
                    .ok_or_else(|| {
                        anyhow::anyhow!(
                            "MCP server {name} reads {source}, which is not set on this Worker Host"
                        )
                    })?
            }
            EnvSource::File(source) => read_env_file(&source.file).with_context(|| {
                format!(
                    "MCP server {name}: {variable} reads {}, which must be an absolute path to an owner-only file holding one value",
                    source.file.display()
                )
            })?,
        };
        if value.len() >= TRACKED_ENV_VALUE_BYTES {
            secrets.insert(value.clone());
        }
        env.insert(variable.clone(), value);
    }
    Ok(StdioServer {
        command: command.to_vec(),
        env,
        cwd: None,
        sandboxed: false,
    })
}

/// A credential file a stdio server's variable reads: absolute, owner-only, regular, and at
/// most 4 KiB, holding one value. Surrounding whitespace is not part of the value, as in
/// TypeScript.
fn read_env_file(path: &Path) -> Result<String> {
    ensure!(path.is_absolute(), "credential file path is not absolute");
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    let metadata = file.metadata()?;
    // SAFETY: geteuid takes no parameters and has no caller invariants.
    let uid = unsafe { libc::geteuid() };
    ensure!(
        metadata.is_file()
            && metadata.uid() == uid
            && metadata.mode() & 0o077 == 0
            && metadata.len() <= 4097,
        "credential file must be a bounded, owner-only regular file"
    );
    let mut bytes = Vec::new();
    file.take(4098).read_to_end(&mut bytes)?;
    let value = String::from_utf8(bytes)?;
    let value = value.trim();
    ensure!(
        !value.is_empty() && value.len() <= 4096 && !value.contains(['\0', '\n']),
        "credential file must hold one value"
    );
    Ok(value.to_owned())
}

pub(super) fn valid_server_env(value: &str) -> bool {
    value.len() <= 128
        && value
            .as_bytes()
            .first()
            .is_some_and(|c| c.is_ascii_alphabetic() || *c == b'_')
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_')
}

pub(super) fn validate_url(value: &str) -> Result<Url> {
    let url = Url::parse(value).map_err(|_| anyhow::anyhow!("invalid MCP endpoint"))?;
    let loopback = value
        .strip_prefix("http://")
        .and_then(|rest| rest.split('/').next())
        .is_some_and(|authority| {
            ["127.0.0.1", "[::1]"].iter().any(|host| {
                authority == *host
                    || authority
                        .strip_prefix(host)
                        .is_some_and(|rest| rest.starts_with(':'))
            })
        })
        && url
            .host_str()
            .is_some_and(|host| matches!(host, "127.0.0.1" | "[::1]"));
    ensure!(
        value.len() <= 2048
            && value.trim() == value
            && !value.chars().any(char::is_control)
            && url.host().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.fragment().is_none()
            && url.query().is_none()
            && (url.scheme() == "https" || (url.scheme() == "http" && loopback)),
        "MCP endpoint must be HTTPS or literal loopback HTTP without embedded credentials"
    );
    Ok(url)
}

pub(super) fn valid_header(name: &HeaderName) -> bool {
    let name = name.as_str();
    !name.starts_with("mcp-")
        && !name.starts_with("x-supertag-")
        && !matches!(
            name,
            "accept"
                | "accept-encoding"
                | "content-type"
                | "content-length"
                | "connection"
                | "host"
                | "transfer-encoding"
                | "te"
                | "upgrade"
                | "origin"
                | "proxy-authorization"
                | "last-event-id"
        )
}

fn valid_env(value: &str) -> bool {
    !value.starts_with("SUPERTAG_")
        && value.len() <= 128
        && value.as_bytes().first().is_some_and(u8::is_ascii_uppercase)
        && value
            .bytes()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'_')
}

impl From<ResourceRule> for McpResourceRule {
    fn from(rule: ResourceRule) -> Self {
        Self {
            prefix: rule.prefix,
            separator: rule.separator,
            components: rule
                .components
                .into_iter()
                .map(|component| McpResourceComponent {
                    arguments: component.arguments,
                })
                .collect(),
            when: rule.when.map(|condition| McpResourceCondition {
                argument: condition.argument,
                equals: condition.equals,
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{fs, os::unix::fs::PermissionsExt};

    use serde_json::{Value, json};

    use super::*;

    #[test]
    fn configuration_accepts_only_private_pinned_header_bindings() {
        let valid = json!({"version":1,"servers":[{
            "name":"catalog", "url":"https://catalog.example.test/mcp",
            "headerEnv":{"Authorization":"CATALOG_AUTH"}
        }]});
        let environment =
            |name: &str| (name == "CATALOG_AUTH").then(|| "Bearer fixture-secret".into());
        let parse = |value: &Value| McpCatalog::parse(value.to_string().as_bytes(), environment);
        let catalog = parse(&valid).unwrap();
        assert_eq!(catalog.capabilities()[0].name, "catalog");
        let changed = McpCatalog::parse(valid.to_string().as_bytes(), |_| {
            Some("Bearer another-fixture-secret".into())
        })
        .unwrap();
        assert_ne!(
            catalog.capabilities()[0].provider_binding,
            changed.capabilities()[0].provider_binding
        );
        assert!(
            catalog
                .secrets
                .iter()
                .any(|value| value == "fixture-secret")
        );
        for endpoint in [
            "http://localhost/mcp",
            "http://127.1/mcp",
            "http://0x7f000001/mcp",
            "http://192.0.2.1/mcp",
            "https://user:secret@catalog.example.test/mcp",
            "https://catalog.example.test/mcp?token=secret",
            "ftp://127.0.0.1/mcp",
        ] {
            let mut invalid = valid.clone();
            invalid["servers"][0]["url"] = json!(endpoint);
            assert!(parse(&invalid).is_err(), "{endpoint}");
        }
        for (name, variable) in [
            ("Host", "CATALOG_AUTH"),
            ("Mcp-Session-Id", "CATALOG_AUTH"),
            ("Authorization", "SUPERTAG_HOST_TOKEN"),
            ("Authorization", "ABSENT_AUTH"),
        ] {
            let mut invalid = valid.clone();
            invalid["servers"][0]["headerEnv"] = json!({(name):variable});
            assert!(parse(&invalid).is_err());
        }
    }

    #[test]
    fn stdio_servers_take_only_named_host_variables_and_pin_their_launch() {
        let valid = json!({"version":1,"servers":[{
            "name":"db", "command":["npx","-y","@acme/db-mcp"],
            "env":{"DB_TOKEN":"ACME_DB_TOKEN"}
        }]});
        let environment =
            |name: &str| (name == "ACME_DB_TOKEN").then(|| " stdio-secret-value-7f3a\n".into());
        let parse = |value: &Value| McpCatalog::parse(value.to_string().as_bytes(), environment);
        let catalog = parse(&valid).unwrap();
        let Transport::Stdio(server) = &catalog.servers["db"].transport else {
            panic!("stdio server expected");
        };
        assert_eq!(server.command, ["npx", "-y", "@acme/db-mcp"]);
        assert_eq!(server.env["DB_TOKEN"], "stdio-secret-value-7f3a");
        assert!(
            catalog
                .secrets
                .iter()
                .any(|secret| secret == "stdio-secret-value-7f3a")
        );
        let changed = McpCatalog::parse(valid.to_string().as_bytes(), |_| {
            Some("another-secret-value".into())
        })
        .unwrap();
        assert_ne!(
            catalog.capabilities()[0].provider_binding,
            changed.capabilities()[0].provider_binding
        );
        for invalid in [
            json!({"name":"db","command":[]}),
            json!({"name":"db","command":["npx","${SECRET}"]}),
            json!({"name":"db","command":["npx"],"env":{"DB_TOKEN":"SUPERTAG_HOST_TOKEN"}}),
            json!({"name":"db","command":["npx"],"env":{"DB_TOKEN":"ABSENT_TOKEN"}}),
            json!({"name":"db","command":["npx"],"env":{"1BAD":"ACME_DB_TOKEN"}}),
            json!({"name":"db","command":["npx"],"headerEnv":{"Authorization":"ACME_DB_TOKEN"}}),
            json!({"name":"db","command":["npx"],"oauth":true}),
            json!({"name":"db","command":["npx"],"url":"https://db.example.test/mcp"}),
            json!({"name":"db"}),
            json!({"name":"db","url":"https://db.example.test/mcp","env":{"DB_TOKEN":"ACME_DB_TOKEN"}}),
        ] {
            let config = json!({"version":1,"servers":[invalid]});
            assert!(parse(&config).is_err(), "{config}");
        }
    }

    #[test]
    fn the_lark_preset_runs_its_pinned_server_with_chat_scoped_resources() {
        let environment = |name: &str| (name == "LARK_APP_ID").then(|| "cli_app_id_value".into());
        let catalog = McpCatalog::parse(
            json!({"version":1,"servers":[
                {"name":"lark","preset":"lark","env":{"APP_ID":"LARK_APP_ID"}}
            ]})
            .to_string()
            .as_bytes(),
            environment,
        )
        .unwrap();
        let Transport::Stdio(server) = &catalog.servers["lark"].transport else {
            panic!("stdio server expected");
        };
        assert_eq!(
            server.command,
            [
                "npx",
                "-y",
                "@larksuiteoapi/lark-mcp@0.5.1",
                "mcp",
                "--tool-name-case",
                "snake"
            ]
        );
        assert_eq!(server.env["APP_ID"], "cli_app_id_value");
        let resource = |tool: &str, arguments: serde_json::Value| {
            mcp::resource(&catalog.servers["lark"].resources[tool], &arguments).unwrap()
        };
        let list =
            |id: &str, kind: &str| json!({"params":{"container_id_type":kind,"container_id":id}});
        let create = |id: &str, kind: &str| json!({"params":{"receive_id_type":kind},"data":{"receive_id":id,"msg_type":"text","content":"{}"}});
        assert_eq!(
            resource("im_v1_message_list", list("oc_1", "chat")).as_deref(),
            Some("chat:oc_1")
        );
        assert_eq!(resource("im_v1_message_list", list("oc_1", "thread")), None);
        assert_eq!(
            resource("im_v1_message_list", json!({"chat_id":"oc_1"})),
            None
        );
        assert_eq!(
            resource("im_v1_message_create", create("oc_2", "chat_id")).as_deref(),
            Some("chat:oc_2")
        );
        assert_eq!(
            resource("im_v1_message_create", create("oc_1", "open_id")),
            None
        );
        for refused in [
            json!({"name":"lark","preset":"lark","command":["lark-mcp"]}),
            json!({"name":"lark","preset":"lark","url":"https://open.larksuite.com/mcp"}),
            json!({"name":"lark","preset":"lark","resources":{"tools":{"x":[{"components":[{"arguments":["a"]}]}]}}}),
            json!({"name":"lark","preset":"lark","tenantId":"contoso"}),
        ] {
            assert!(
                McpCatalog::parse(
                    json!({"version":1,"servers":[refused]})
                        .to_string()
                        .as_bytes(),
                    |_| None
                )
                .is_err()
            );
        }
    }

    #[test]
    fn stdio_env_reads_owner_only_credential_files() {
        let directory = tempfile::tempdir().unwrap();
        let file = |name: &str, contents: &str, mode: u32| {
            let path = directory.path().join(name);
            fs::write(&path, contents).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
            path
        };
        let parse = |source: Value| {
            McpCatalog::parse(
                json!({"version":1,"servers":[
                    {"name":"db","command":["db-mcp"],"env":{"DB_TOKEN":source}}
                ]})
                .to_string()
                .as_bytes(),
                |_| None,
            )
        };
        // Surrounding whitespace is trimmed, as TypeScript trims a file reference.
        let private = file("token", "  file-secret-value-1c9e \r\n", 0o600);
        let catalog = parse(json!({"file": private})).unwrap();
        let Transport::Stdio(server) = &catalog.servers["db"].transport else {
            panic!("stdio server expected");
        };
        assert_eq!(server.env["DB_TOKEN"], "file-secret-value-1c9e");
        assert!(
            catalog
                .secrets
                .contains(&"file-secret-value-1c9e".to_owned())
        );
        let shared = file("shared", "file-secret-value-1c9e", 0o644);
        let multiple = file("multiple", "one\ntwo\n", 0o600);
        let empty = file("empty", " \n\t", 0o600);
        for refused in [
            json!({"file": shared}),
            json!({"file": multiple}),
            json!({"file": empty}),
            json!({"file": "token"}),
            json!({"file": directory.path().join("absent")}),
            json!({"file": private, "env": "DB_TOKEN"}),
            json!({"secretRef": "db"}),
        ] {
            let error = parse(refused.clone())
                .err()
                .map(|error| format!("{error:#}"));
            assert!(error.is_some(), "{refused}");
            assert!(
                !error.unwrap().contains("file-secret-value-1c9e"),
                "{refused}"
            );
        }
    }

    #[test]
    fn presets_use_the_official_url_and_resource_mapping() {
        let environment =
            |name: &str| (name == "GITHUB_MCP_AUTH").then(|| "Bearer preset-secret-value".into());
        let catalog = McpCatalog::parse(
            json!({"version":1,"servers":[
                {"name":"github","preset":"github","headerEnv":{"Authorization":"GITHUB_MCP_AUTH"}},
                {"name":"slack","preset":"slack"},
                {"name":"linear","preset":"linear"},
                {"name":"teams","preset":"teams","tenantId":"contoso.onmicrosoft.com"},
                {"name":"custom","url":"https://mcp.example.com/mcp"}
            ]})
            .to_string()
            .as_bytes(),
            environment,
        )
        .unwrap();
        let url = |name: &str| {
            let Transport::Http(server) = &catalog.servers[name].transport else {
                panic!("HTTP server expected");
            };
            server.endpoint.to_string()
        };
        assert_eq!(url("github"), "https://api.githubcopilot.com/mcp/");
        assert_eq!(url("slack"), "https://mcp.slack.com/mcp");
        assert_eq!(url("linear"), "https://mcp.linear.app/mcp");
        assert_eq!(
            url("teams"),
            "https://agent365.svc.cloud.microsoft/agents/tenants/contoso.onmicrosoft.com/servers/mcp_TeamsServer"
        );
        let tools = |name: &str| {
            catalog.servers[name]
                .resources
                .keys()
                .cloned()
                .collect::<Vec<_>>()
        };
        assert_eq!(
            tools("github"),
            [
                "add_issue_comment",
                "create_branch",
                "create_pull_request",
                "get_file_contents",
                "issue_read",
                "merge_pull_request",
                "pull_request_read"
            ]
        );
        assert_eq!(
            tools("slack"),
            [
                "slack_read_channel",
                "slack_read_thread",
                "slack_send_message"
            ]
        );
        assert_eq!(tools("linear"), ["create_issue", "list_issues"]);
        assert_eq!(tools("teams").len(), 3);
        let rule = &catalog.servers["github"].resources["create_pull_request"][0];
        assert_eq!(
            (rule.prefix.as_str(), rule.separator.as_str()),
            ("repository:", "/")
        );
        assert_eq!(
            rule.components
                .iter()
                .map(|component| component.arguments.clone())
                .collect::<Vec<_>>(),
            [
                vec!["owner".to_owned()],
                vec!["repo".into(), "repository".into()]
            ]
        );
        let rule = &catalog.servers["teams"].resources["mcp_graph_teams_postChannelMessage"][0];
        assert_eq!(
            (rule.prefix.as_str(), rule.separator.as_str()),
            ("team:", "/channel:")
        );
        // Preset tools name resources, so the capability advertises them.
        let github = catalog
            .capabilities()
            .into_iter()
            .find(|server| server.name == "github")
            .unwrap();
        assert_eq!(github.mapped_tools.len(), 7);
        assert!(catalog.servers["custom"].resources.is_empty());
        for (server, message) in [
            (
                json!({"name":"github","preset":"github","url":"https://example.com/mcp"}),
                "must not be set with a preset",
            ),
            (
                json!({"name":"github","preset":"github","resources":{"tools":{"x":[{"components":[{"arguments":["a"]}]}]}}}),
                "supplies its own resource mapping",
            ),
            (
                json!({"name":"teams","preset":"teams"}),
                "tenantId is required",
            ),
            (
                json!({"name":"teams","preset":"teams","tenantId":"bad/tenant"}),
                "tenantId is required",
            ),
            (
                json!({"name":"slack","preset":"slack","tenantId":"contoso"}),
                "belongs only with preset teams",
            ),
            (
                json!({"name":"x","url":"https://example.com/mcp","tenantId":"contoso"}),
                "belongs only with preset teams",
            ),
            (json!({"name":"x","preset":"jira"}), "preset must be github"),
        ] {
            let error = McpCatalog::parse(
                json!({"version":1,"servers":[server]})
                    .to_string()
                    .as_bytes(),
                |_| None,
            )
            .err()
            .unwrap()
            .to_string();
            assert!(error.contains(message), "{server}: {error}");
        }
    }

    #[test]
    fn oauth_servers_need_a_login_for_their_url() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("catalog.json");
        fs::write(
            &file,
            json!({"version":1,"servers":[{"name":"docs","url":"https://docs.example.test/mcp","oauth":true}]}).to_string(),
        )
        .unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
        let store = McpLoginStore::new(root.path().join("mcp-logins"));
        assert!(McpCatalog::load(Some(&file), None).is_err());
        // A host that never logged in refuses to start, naming the command.
        let error = McpCatalog::load(Some(&file), Some(store.clone()))
            .err()
            .unwrap()
            .to_string();
        assert!(error.contains("supertag mcp login docs"), "{error}");
        store
            .store(
                "docs",
                &super::super::oauth::McpLogin {
                    url: "https://docs.example.test/mcp".into(),
                    token_endpoint: "https://docs.example.test/token".into(),
                    client_id: "client".into(),
                    client_secret: None,
                    refresh_token: "refresh".into(),
                    access_token: None,
                    access_token_expires_at: None,
                    refresh_token_expires_at: None,
                    logged_in_at: 1,
                    lapsed_at: None,
                },
            )
            .unwrap();
        let catalog = McpCatalog::load(Some(&file), Some(store.clone())).unwrap();
        assert!(catalog.lapsed_logins().is_empty());
        let profile = HarnessExecutionProfile {
            mcp_servers: catalog.capabilities(),
            ..Default::default()
        };
        assert_eq!(
            McpCatalog::advertised(&profile, &catalog.lapsed_logins()),
            profile
        );
        // A login refused later is advertised as needing a new one, without a restart.
        let mut lapsed = store.read("docs").unwrap().unwrap();
        lapsed.lapsed_at = Some(2);
        store.store("docs", &lapsed).unwrap();
        assert_eq!(catalog.lapsed_logins(), ["docs"]);
        let advertised = McpCatalog::advertised(&profile, &catalog.lapsed_logins());
        assert!(advertised.mcp_servers.is_empty());
        assert_eq!(advertised.mcp_login_servers, ["docs"]);
        // A host whose login already lapsed still starts, advertising the hold.
        let restarted = McpCatalog::load(Some(&file), Some(store.clone())).unwrap();
        assert_eq!(restarted.lapsed_logins(), ["docs"]);
        let Transport::Http(server) = &catalog.servers["docs"].transport else {
            panic!("HTTP server expected");
        };
        assert!(server.oauth && server.headers.is_empty());
        let entries = McpCatalog::entries(&file).unwrap();
        assert_eq!(entries[0].auth, "oauth login");
        let header = json!({"version":1,"servers":[{"name":"docs","url":"https://docs.example.test/mcp","oauth":true,"headerEnv":{"Authorization":"DOCS_AUTH"}}]});
        assert!(
            McpCatalog::parse(header.to_string().as_bytes(), |_| Some("Bearer x".into())).is_err()
        );
    }

    #[test]
    fn catalog_loader_refuses_shared_files_and_symlinks() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("catalog.json");
        fs::write(&file, br#"{"version":1,"servers":[]}"#).unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(McpCatalog::load(Some(&file), None).is_err());
        fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(McpCatalog::load(Some(&file), None).is_ok());
        let link = root.path().join("link.json");
        std::os::unix::fs::symlink(&file, &link).unwrap();
        assert!(McpCatalog::load(Some(&link), None).is_err());
    }
}
