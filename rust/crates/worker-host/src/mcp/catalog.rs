use std::{
    collections::{BTreeMap, BTreeSet},
    fs::OpenOptions,
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::Path,
};

use anyhow::{Result, ensure};

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
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Config {
    version: u32,
    pub(super) servers: Vec<ServerConfig>,
}

/// Parses only the catalog's shape, resolving nothing, for `supertag mcp list` and login.
pub(super) fn read_config(path: &Path) -> Result<Config> {
    let bytes = read_private(path)?;
    let config: Config = serde_json::from_slice(&bytes)
        .map_err(|_| anyhow::anyhow!("invalid MCP catalog format"))?;
    ensure!(
        config.version == 1 && config.servers.len() <= mcp::MAX_SERVERS,
        "unsupported MCP catalog version or size"
    );
    Ok(config)
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
    #[serde(default)]
    pub(super) header_env: BTreeMap<String, String>,
    #[serde(default)]
    pub(super) oauth: bool,
    /// A stdio server: the executable and its arguments.
    pub(super) command: Option<Vec<String>>,
    /// A stdio server's environment: each variable it receives, mapped to the Worker Host
    /// variable that holds its value.
    #[serde(default)]
    pub(super) env: BTreeMap<String, String>,
    #[serde(default)]
    resources: ResourceMapping,
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
                let sources: Vec<_> = if server.command.is_some() {
                    server.env.values().cloned().collect()
                } else {
                    server.header_env.values().cloned().collect()
                };
                let missing = sources
                    .into_iter()
                    .filter(|source| {
                        std::env::var(source).map_or(true, |value| value.trim().is_empty())
                    })
                    .collect();
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
        let config: Config = serde_json::from_slice(bytes)
            .map_err(|_| anyhow::anyhow!("invalid MCP catalog format"))?;
        ensure!(
            config.version == 1 && config.servers.len() <= mcp::MAX_SERVERS,
            "unsupported MCP catalog version or size"
        );
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
            valid_server_env(variable) && valid_env(source),
            "MCP server {name}: env must map variable names to Worker Host variables not named SUPERTAG_*"
        );
        let value = environment(source)
            .filter(|value| {
                !value.trim().is_empty() && value.len() <= 4096 && !value.contains('\0')
            })
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "MCP server {name} reads {source}, which is not set on this Worker Host"
                )
            })?;
        if value.len() >= TRACKED_ENV_VALUE_BYTES {
            secrets.insert(value.clone());
        }
        env.insert(variable.clone(), value);
    }
    Ok(StdioServer {
        command: command.to_vec(),
        env,
        cwd: None,
    })
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
            |name: &str| (name == "ACME_DB_TOKEN").then(|| "stdio-secret-value-7f3a".into());
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
