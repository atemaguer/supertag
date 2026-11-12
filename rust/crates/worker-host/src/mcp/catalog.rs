use std::{
    collections::{BTreeMap, BTreeSet},
    fs::OpenOptions,
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::Path,
};

use anyhow::{Result, ensure};
use reqwest::{
    Url,
    header::{HeaderMap, HeaderName, HeaderValue},
};
use serde::Deserialize;
use serde_json::Value;
use supertag_protocol::{mcp, v2::McpServerCapability};

const CATALOG_BYTES: u64 = 128 * 1024;

#[derive(Clone, Default)]
pub struct McpCatalog {
    pub(super) servers: BTreeMap<String, Server>,
    pub(super) secrets: Vec<String>,
}

#[derive(Clone)]
pub(super) struct Server {
    pub(super) endpoint: Url,
    pub(super) headers: HeaderMap,
    pub(super) resources: BTreeMap<String, Vec<ResourceRule>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    version: u32,
    servers: Vec<ServerConfig>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ServerConfig {
    name: String,
    url: String,
    #[serde(default)]
    header_env: BTreeMap<String, String>,
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
pub(super) struct ResourceRule {
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

impl McpCatalog {
    pub fn load(path: Option<&Path>) -> Result<Self> {
        let Some(path) = path else {
            return Ok(Self::default());
        };
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
        Self::parse(&bytes, |name| std::env::var(name).ok())
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
            let endpoint = validate_url(&server.url)?;
            secrets.insert(endpoint.as_str().into());
            ensure!(
                server.header_env.len() <= 16,
                "too many MCP request headers"
            );
            let mut headers = HeaderMap::new();
            for (name, variable) in server.header_env {
                let name = HeaderName::from_bytes(name.as_bytes())
                    .map_err(|_| anyhow::anyhow!("invalid MCP request header"))?;
                ensure!(
                    valid_header(&name) && valid_env(&variable),
                    "invalid MCP request header binding"
                );
                let value = environment(&variable)
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
                    && (scheme.eq_ignore_ascii_case("bearer")
                        || scheme.eq_ignore_ascii_case("basic"))
                    && !credential.trim().is_empty()
                {
                    secrets.insert(credential.trim().into());
                }
                secrets.insert(value);
            }
            let resources = server.resources.tools;
            ensure!(
                resources.len() <= mcp::MAX_TOOLS
                    && resources.iter().all(|(tool, rules)| {
                        mcp::tool_name(tool)
                            && !rules.is_empty()
                            && rules.len() <= 16
                            && rules.iter().all(ResourceRule::valid)
                    }),
                "invalid MCP tool resource mapping"
            );
            ensure!(
                catalog
                    .servers
                    .insert(
                        server.name,
                        Server {
                            endpoint,
                            headers,
                            resources
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
        Ok(catalog)
    }

    pub fn capabilities(&self) -> Vec<McpServerCapability> {
        self.servers
            .iter()
            .map(|(name, server)| McpServerCapability {
                name: name.clone(),
                mapped_tools: server.resources.keys().cloned().collect(),
            })
            .collect()
    }
}

fn validate_url(value: &str) -> Result<Url> {
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

fn valid_header(name: &HeaderName) -> bool {
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

impl ResourceRule {
    fn valid(&self) -> bool {
        let ascii =
            |value: &str, max| value.len() <= max && value.bytes().all(|c| (33..=126).contains(&c));
        ascii(&self.prefix, 64)
            && ascii(&self.separator, 8)
            && !self.components.is_empty()
            && self.components.len() <= 8
            && self.components.iter().all(|component| {
                !component.arguments.is_empty()
                    && component.arguments.len() <= 8
                    && component.arguments.iter().all(|path| valid_path(path))
            })
            && self
                .when
                .as_ref()
                .is_none_or(|when| valid_path(&when.argument) && ascii(&when.equals, 200))
    }

    fn resolve(&self, arguments: &Value) -> Result<Option<String>, ()> {
        if self.when.as_ref().is_some_and(|when| {
            argument_at(arguments, &when.argument).and_then(Value::as_str) != Some(&when.equals)
        }) {
            return Ok(None);
        }
        let mut components = Vec::new();
        for component in &self.components {
            let mut values = component
                .arguments
                .iter()
                .filter_map(|path| argument_at(arguments, path))
                .filter(|value| !value.is_null());
            let Some(value) = values.next() else {
                return Ok(None);
            };
            let text = value.as_str().ok_or(())?;
            if values.any(|alternative| alternative != value)
                || text.is_empty()
                || text.len() > 400
                || !text.bytes().all(|c| (33..=126).contains(&c))
                || (!self.separator.is_empty() && text.contains(&self.separator))
            {
                return Err(());
            }
            components.push(text);
        }
        Ok(Some(format!(
            "{}{}",
            self.prefix,
            components.join(&self.separator)
        )))
    }
}

fn valid_path(path: &str) -> bool {
    path.len() <= 128
        && path.split('.').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-'))
        })
}

fn argument_at<'a>(arguments: &'a Value, path: &str) -> Option<&'a Value> {
    path.split('.')
        .try_fold(arguments, |current, part| current.as_object()?.get(part))
}

pub(super) fn resource(rules: &[ResourceRule], arguments: &Value) -> Result<Option<String>, ()> {
    let mut selected = None;
    for rule in rules {
        if let Some(value) = rule.resolve(arguments)? {
            if selected.as_ref().is_some_and(|prior| prior != &value) {
                return Err(());
            }
            selected = Some(value);
        }
    }
    Ok(selected)
}

#[cfg(test)]
mod tests {
    use std::{fs, os::unix::fs::PermissionsExt};

    use serde_json::json;

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
    fn catalog_loader_refuses_shared_files_and_symlinks() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("catalog.json");
        fs::write(&file, br#"{"version":1,"servers":[]}"#).unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(McpCatalog::load(Some(&file)).is_err());
        fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(McpCatalog::load(Some(&file)).is_ok());
        let link = root.path().join("link.json");
        std::os::unix::fs::symlink(&file, &link).unwrap();
        assert!(McpCatalog::load(Some(&link)).is_err());
    }
}
