//! Workspace MCP servers: the `.mcp.json` entries a Task's Workspace selects, read from a
//! Worker-owned snapshot of the Task's base commit.
//!
//! The harness may write the Task checkout, and a failed Attempt keeps its changes for the
//! retry, so nothing is read from or run in the checkout. A stdio server runs in the snapshot,
//! so editing `.mcp.json` or a server's script there cannot change what the Worker Host launches.
//! References may name only `SUPERTAG_MCP_*` variables of the Worker Host, so a repository can
//! never read the host's own credentials.

use std::{
    collections::{BTreeMap, BTreeSet},
    fs::OpenOptions,
    io::Read,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
};

use anyhow::{Result, bail, ensure};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde::Serialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use supertag_protocol::v2::{McpServerCapability, WorkspaceMcpRecord};

use super::catalog::{
    HttpServer, Server, StdioServer, TRACKED_ENV_VALUE_BYTES, Transport, valid_header,
    valid_server_env, validate_url,
};

/// The only Worker Host variables a repository's `.mcp.json` may reference.
pub const VARIABLE_PREFIX: &str = "SUPERTAG_MCP_";
const CONFIG_BYTES: u64 = 1024 * 1024;

/// The selected servers as one Attempt resolved them. Values stay on the Worker Host; only
/// `record` crosses to the Control Plane.
pub(crate) struct WorkspaceMcp {
    pub(super) servers: BTreeMap<String, Server>,
    pub(super) secrets: Vec<String>,
    pub(crate) record: WorkspaceMcpRecord,
}

/// One selected entry as declared, with no value resolved: what the digest covers.
#[derive(Serialize)]
#[serde(untagged)]
enum Declared<'a> {
    Stdio {
        name: &'a str,
        command: &'a str,
        args: &'a [String],
        env: &'a BTreeMap<String, String>,
    },
    Http {
        name: &'a str,
        url: &'a str,
        headers: &'a BTreeMap<String, String>,
    },
}

impl WorkspaceMcp {
    /// Reads the `names` servers from `.mcp.json` in `snapshot`, which must be a Worker-owned
    /// snapshot of the Task's base commit. `variables` supplies `SUPERTAG_MCP_*` values.
    ///
    /// `sandbox` names the remote Workspace provider whose sandbox runs the stdio servers. There
    /// the Task could read a server's environment, so a stdio server that references a host
    /// variable is refused, naming it, before its value is read.
    pub(crate) fn resolve(
        snapshot: &Path,
        names: &BTreeSet<&str>,
        variables: impl Fn(&str) -> Option<String>,
        sandbox: Option<&str>,
    ) -> Result<Self> {
        let path = snapshot.join(".mcp.json");
        let document = read_config(&path)?;
        let declared = document
            .get("mcpServers")
            .and_then(Value::as_object)
            .ok_or_else(|| {
                anyhow::anyhow!("Workspace MCP configuration .mcp.json must contain mcpServers")
            })?;
        let mut servers = BTreeMap::new();
        let mut secrets = BTreeSet::new();
        let mut selected = Vec::new();
        let mut owned = Vec::new();
        for name in names {
            let entry = declared
                .get(*name)
                .and_then(Value::as_object)
                .ok_or_else(|| {
                    anyhow::anyhow!("Workspace MCP server {name} is not defined in .mcp.json")
                })?;
            let stdio = entry.contains_key("command")
                || entry.get("type").and_then(Value::as_str) == Some("stdio");
            let (transport, declaration) = if stdio {
                stdio_server(name, entry, (snapshot, sandbox), &variables, &mut secrets)?
            } else {
                http_server(name, entry, &variables, &mut secrets)?
            };
            owned.push(((*name).to_owned(), transport, declaration));
        }
        for (name, _, declaration) in &owned {
            selected.push(declaration.as_declared(name));
        }
        let digest = format!(
            "sha256:{:x}",
            Sha256::digest(serde_json::to_vec(&selected)?)
        );
        let mut capabilities = Vec::new();
        for (name, transport, _) in owned {
            let mut identity = Sha256::new();
            identity.update(b"supertag-workspace-mcp-provider-binding-v1\0");
            identity.update(digest.as_bytes());
            identity.update(b"\0");
            identity.update(name.as_bytes());
            identity.update(b"\0");
            // The resolved launch, without the snapshot path: an approval stays bound to it
            // across the Task's Attempts and its continuations.
            match &transport {
                Transport::Stdio(stdio) if stdio.sandboxed => {
                    identity.update(serde_json::to_vec(&("sandbox-stdio", &stdio.command))?)
                }
                Transport::Stdio(stdio) => {
                    identity.update(serde_json::to_vec(&("stdio", &stdio.command, &stdio.env))?)
                }
                Transport::Http(http) => {
                    let headers: BTreeMap<_, _> = http
                        .headers
                        .iter()
                        .map(|(name, value)| (name.as_str(), value.as_bytes()))
                        .collect();
                    identity.update(serde_json::to_vec(&(
                        "http",
                        http.endpoint.as_str(),
                        headers,
                    ))?);
                }
            }
            let capability = McpServerCapability {
                name: name.clone(),
                mapped_tools: Vec::new(),
                provider_binding: Some(format!("{:x}", identity.finalize())),
                resource_bindings: Vec::new(),
            };
            capabilities.push(capability.clone());
            servers.insert(
                name,
                Server {
                    transport,
                    resources: BTreeMap::new(),
                    capability,
                },
            );
        }
        let mut secrets: Vec<String> = secrets.into_iter().collect();
        secrets.sort_unstable_by_key(|value| std::cmp::Reverse(value.len()));
        Ok(Self {
            servers,
            secrets,
            record: WorkspaceMcpRecord {
                digest,
                servers: capabilities,
            },
        })
    }
}

impl WorkspaceMcp {
    /// Whether a selected stdio server runs inside a remote Workspace's sandbox.
    pub(crate) fn sandboxed(&self) -> bool {
        self.servers
            .values()
            .any(|server| matches!(&server.transport, Transport::Stdio(stdio) if stdio.sandboxed))
    }
}

/// What the digest records of one entry: its declaration, never a resolved value.
enum Declaration {
    Stdio {
        command: String,
        args: Vec<String>,
        env: BTreeMap<String, String>,
    },
    Http {
        url: String,
        headers: BTreeMap<String, String>,
    },
}

impl Declaration {
    fn as_declared<'a>(&'a self, name: &'a str) -> Declared<'a> {
        match self {
            Self::Stdio { command, args, env } => Declared::Stdio {
                name,
                command,
                args,
                env,
            },
            Self::Http { url, headers } => Declared::Http { name, url, headers },
        }
    }
}

fn read_config(path: &Path) -> Result<Map<String, Value>> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| {
            anyhow::anyhow!("Workspace MCP configuration .mcp.json is missing at the base commit")
        })?;
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file() && metadata.len() <= CONFIG_BYTES,
        "Workspace MCP configuration .mcp.json must be a regular file no larger than 1 MiB"
    );
    let mut bytes = Vec::new();
    file.take(CONFIG_BYTES + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= CONFIG_BYTES,
        "Workspace MCP configuration .mcp.json must be a regular file no larger than 1 MiB"
    );
    match serde_json::from_slice(&bytes) {
        Ok(Value::Object(document)) => Ok(document),
        _ => bail!("Workspace MCP configuration .mcp.json is not a JSON object"),
    }
}

fn control(value: &str) -> bool {
    value.chars().any(|c| c.is_control())
}

/// Expands each `${SUPERTAG_MCP_*}` reference in `value`.
fn expand(value: &str, name: &str, variables: &impl Fn(&str) -> Option<String>) -> Result<String> {
    let mut expanded = String::new();
    let mut rest = value;
    while let Some(start) = rest.find("${") {
        expanded.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let end = after.find('}').ok_or_else(|| {
            anyhow::anyhow!("Workspace MCP server {name} has an invalid environment reference")
        })?;
        let key = &after[..end];
        ensure!(
            valid_server_env(key) && !key.is_empty(),
            "Workspace MCP server {name} has an invalid environment reference"
        );
        ensure!(
            key.starts_with(VARIABLE_PREFIX),
            "Workspace MCP server {name} references ${{{key}}}, but a repository's .mcp.json may reference only variables named {VARIABLE_PREFIX}*, such as ${{{VARIABLE_PREFIX}{key}}}. Set that variable on the Worker Host"
        );
        let resolved = variables(key)
            .filter(|value| !value.is_empty() && value.len() <= 4096)
            .ok_or_else(|| {
                anyhow::anyhow!("Workspace MCP server {name} needs environment variable {key}")
            })?;
        ensure!(
            !control(&resolved),
            "Workspace MCP server {name}: {key} contains control characters"
        );
        expanded.push_str(&resolved);
        rest = &after[end + 1..];
    }
    expanded.push_str(rest);
    Ok(expanded)
}

fn strings(value: Option<&Value>) -> Option<Vec<String>> {
    match value {
        None => Some(Vec::new()),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| item.as_str().map(str::to_owned))
            .collect(),
        _ => None,
    }
}

fn string_map(value: Option<&Value>) -> Option<BTreeMap<String, String>> {
    match value {
        None => Some(BTreeMap::new()),
        Some(Value::Object(entries)) => entries
            .iter()
            .map(|(key, value)| Some((key.clone(), value.as_str()?.to_owned())))
            .collect(),
        _ => None,
    }
}

/// A single `${NAME}` reference, and nothing else.
fn sole_reference(value: &str) -> Option<&str> {
    value
        .strip_prefix("${")?
        .strip_suffix('}')
        .filter(|key| valid_server_env(key))
}

fn stdio_server(
    name: &str,
    entry: &Map<String, Value>,
    (snapshot, sandbox): (&Path, Option<&str>),
    variables: &impl Fn(&str) -> Option<String>,
    secrets: &mut BTreeSet<String>,
) -> Result<(Transport, Declaration)> {
    let command = entry
        .get("command")
        .and_then(Value::as_str)
        .filter(|command| !command.trim().is_empty() && !control(command) && command.len() <= 4096)
        .ok_or_else(|| anyhow::anyhow!("Workspace MCP server {name} needs a command"))?;
    let args = strings(entry.get("args"))
        .filter(|args| {
            args.len() <= 64 && args.iter().all(|arg| !control(arg) && arg.len() <= 4096)
        })
        .ok_or_else(|| {
            anyhow::anyhow!("Workspace MCP server {name} args must be a list of strings")
        })?;
    ensure!(
        !std::iter::once(command)
            .chain(args.iter().map(String::as_str))
            .any(|part| part.contains("${")),
        "Workspace MCP server {name} command and args must not reference environment variables; put credentials in env"
    );
    let declared_env = string_map(entry.get("env"))
        .filter(|env| {
            env.len() <= 32
                && env
                    .iter()
                    .all(|(key, value)| valid_server_env(key) && sole_reference(value).is_some())
        })
        .ok_or_else(|| {
            anyhow::anyhow!(
                "Workspace MCP server {name} env must map variable names to references like ${{SUPERTAG_MCP_NAME}}; literal values are not allowed"
            )
        })?;
    if let Some(provider) = sandbox {
        let variables: BTreeSet<_> = declared_env
            .values()
            .filter_map(|value| sole_reference(value))
            .collect();
        ensure!(
            variables.is_empty(),
            "Workspace MCP server {name} references host credential {} in its env, but {provider} runs Workspace stdio servers inside the Task's sandbox, where the Task could read it. Run this Workspace on a local Worker Host, or serve {name} over HTTP so its credential stays on the Worker Host",
            variables.into_iter().collect::<Vec<_>>().join(", ")
        );
        // The provider resolves the command in its trusted copy of the base commit.
        let mut launch = vec![command.to_owned()];
        launch.extend(args.iter().cloned());
        return Ok((
            Transport::Stdio(StdioServer {
                command: launch,
                env: BTreeMap::new(),
                cwd: None,
                sandboxed: true,
            }),
            Declaration::Stdio {
                command: command.to_owned(),
                args,
                env: declared_env,
            },
        ));
    }
    let mut env = BTreeMap::new();
    for (key, value) in &declared_env {
        let resolved = expand(value, name, variables)?;
        // Every value is a credential the host opted in: withhold it from Task output.
        if resolved.len() >= TRACKED_ENV_VALUE_BYTES {
            secrets.insert(resolved.clone());
        }
        env.insert(key.clone(), resolved);
    }
    // A repository-relative executable resolves in the snapshot, never against the Worker
    // Host's own working directory.
    let program = if command.contains('/') && !Path::new(command).is_absolute() {
        snapshot.join(command).display().to_string()
    } else {
        command.to_owned()
    };
    let mut launch = vec![program];
    launch.extend(args.iter().cloned());
    Ok((
        Transport::Stdio(StdioServer {
            command: launch,
            env,
            cwd: Some(PathBuf::from(snapshot)),
            sandboxed: false,
        }),
        Declaration::Stdio {
            command: command.to_owned(),
            args,
            env: declared_env,
        },
    ))
}

fn http_server(
    name: &str,
    entry: &Map<String, Value>,
    variables: &impl Fn(&str) -> Option<String>,
    secrets: &mut BTreeSet<String>,
) -> Result<(Transport, Declaration)> {
    if let Some(kind) = entry.get("type") {
        ensure!(
            kind.as_str() == Some("http"),
            "Workspace MCP server {name} must have type http or stdio"
        );
    }
    let declared_url = entry
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("Workspace MCP server {name} needs a URL"))?;
    let url = expand(declared_url, name, variables)?;
    let endpoint = validate_url(&url).map_err(|_| {
        anyhow::anyhow!(
            "Workspace MCP server {name} needs an HTTPS or literal loopback HTTP URL without embedded credentials"
        )
    })?;
    if url != declared_url {
        secrets.insert(url.clone());
    }
    let declared_headers = string_map(entry.get("headers"))
        .filter(|headers| headers.len() <= 16)
        .ok_or_else(|| {
            anyhow::anyhow!("Workspace MCP server {name} headers must map names to strings")
        })?;
    let mut headers = HeaderMap::new();
    for (key, value) in &declared_headers {
        let header = HeaderName::from_bytes(key.as_bytes())
            .ok()
            .filter(valid_header)
            .ok_or_else(|| anyhow::anyhow!("Workspace MCP server {name} has an invalid header"))?;
        ensure!(
            value.contains("${"),
            "Workspace MCP server {name} headers must reference environment variables"
        );
        let resolved = expand(value, name, variables)?;
        let mut header_value = HeaderValue::from_str(&resolved).map_err(|_| {
            anyhow::anyhow!("Workspace MCP server {name} headers contain control characters")
        })?;
        header_value.set_sensitive(true);
        if let Some((scheme, credential)) = resolved.split_once(' ')
            && !credential.trim().is_empty()
            && (scheme.eq_ignore_ascii_case("bearer") || scheme.eq_ignore_ascii_case("basic"))
        {
            secrets.insert(credential.trim().to_owned());
        }
        secrets.insert(resolved);
        ensure!(
            headers.insert(header, header_value).is_none(),
            "Workspace MCP server {name} repeats a header"
        );
    }
    Ok((
        Transport::Http(HttpServer {
            name: name.to_owned(),
            endpoint,
            headers,
            oauth: false,
            minted: None,
            github_api: Box::new(reqwest::Url::parse(super::auth::GITHUB_API)?),
        }),
        Declaration::Http {
            url: declared_url.to_owned(),
            headers: declared_headers,
        },
    ))
}

/// The Worker Host's `SUPERTAG_MCP_*` variables, read when an Attempt resolves its servers.
pub(crate) fn host_variable(name: &str) -> Option<String> {
    name.starts_with(VARIABLE_PREFIX)
        .then(|| std::env::var(name).ok())
        .flatten()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn snapshot(config: &Value) -> tempfile::TempDir {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join(".mcp.json"), config.to_string()).unwrap();
        directory
    }

    fn variables(name: &str) -> Option<String> {
        match name {
            "SUPERTAG_MCP_LOG" => Some("/tmp/workspace-mcp-log".into()),
            "SUPERTAG_MCP_TOKEN" => Some("workspace-token-value-81c2".into()),
            _ => None,
        }
    }

    #[test]
    fn resolves_selected_entries_in_the_snapshot_and_digests_only_their_declaration() {
        let config = json!({"mcpServers":{
            "local":{"command":"node","args":["server.mjs"],"env":{"FAKE_MCP_LOG":"${SUPERTAG_MCP_LOG}","TOKEN":"${SUPERTAG_MCP_TOKEN}"}},
            "script":{"command":"./bin/server.sh"},
            "docs":{"type":"http","url":"https://docs.example.test/mcp","headers":{"Authorization":"Bearer ${SUPERTAG_MCP_TOKEN}"}},
            "unselected":{"command":"/bin/sh","args":["-c","exit 1"]}
        }});
        let directory = snapshot(&config);
        let names = BTreeSet::from(["docs", "local", "script"]);
        let resolved = WorkspaceMcp::resolve(directory.path(), &names, variables, None).unwrap();
        assert_eq!(
            resolved.servers.keys().collect::<Vec<_>>(),
            ["docs", "local", "script"]
        );
        let Transport::Stdio(local) = &resolved.servers["local"].transport else {
            panic!("stdio server expected");
        };
        assert_eq!(local.command, ["node", "server.mjs"]);
        assert_eq!(local.cwd.as_deref(), Some(directory.path()));
        assert_eq!(local.env["TOKEN"], "workspace-token-value-81c2");
        let Transport::Stdio(script) = &resolved.servers["script"].transport else {
            panic!("stdio server expected");
        };
        assert_eq!(
            script.command,
            [directory
                .path()
                .join("./bin/server.sh")
                .display()
                .to_string()]
        );
        assert!(
            resolved
                .secrets
                .iter()
                .any(|secret| secret == "workspace-token-value-81c2")
        );
        let digest = &resolved.record.digest;
        assert!(digest.starts_with("sha256:") && digest.len() == 71);
        assert_eq!(resolved.record.servers.len(), 3);
        // Another value of a referenced variable keeps the digest; the launch binding changes.
        let other = WorkspaceMcp::resolve(
            directory.path(),
            &names,
            |name| {
                (name == "SUPERTAG_MCP_TOKEN")
                    .then(|| "another-token-value-1234".into())
                    .or_else(|| variables(name))
            },
            None,
        )
        .unwrap();
        assert_eq!(&other.record.digest, digest);
        assert_ne!(
            other.record.servers[1].provider_binding,
            resolved.record.servers[1].provider_binding
        );
        // The same declaration in another snapshot directory binds the same launch.
        let moved = snapshot(&config);
        let again = WorkspaceMcp::resolve(moved.path(), &names, variables, None).unwrap();
        assert_eq!(
            again.record.servers[1].provider_binding,
            resolved.record.servers[1].provider_binding
        );
        // Changing a selected entry changes the digest.
        let mut changed = config.clone();
        changed["mcpServers"]["local"]["args"] = json!(["server.mjs", "--changed"]);
        let changed_directory = snapshot(&changed);
        let changed =
            WorkspaceMcp::resolve(changed_directory.path(), &names, variables, None).unwrap();
        assert_ne!(&changed.record.digest, digest);
    }

    #[test]
    fn refuses_host_credentials_literals_and_argument_references() {
        for (entry, message) in [
            (
                json!({"command":"node","env":{"KEY":"${GITHUB_TOKEN}"}}),
                "may reference only variables named SUPERTAG_MCP_",
            ),
            (
                json!({"command":"node","env":{"KEY":"literal"}}),
                "literal values are not allowed",
            ),
            (
                json!({"command":"node","args":["${SUPERTAG_MCP_TOKEN}"]}),
                "must not reference environment variables",
            ),
            (
                json!({"command":"node","env":{"KEY":"${SUPERTAG_MCP_ABSENT}"}}),
                "needs environment variable SUPERTAG_MCP_ABSENT",
            ),
            (
                json!({"type":"sse","url":"https://x.example.test/mcp"}),
                "must have type http or stdio",
            ),
            (
                json!({"url":"http://192.0.2.1/mcp"}),
                "HTTPS or literal loopback",
            ),
            (
                json!({"url":"https://x.example.test/mcp","headers":{"Authorization":"Bearer fixed"}}),
                "headers must reference environment variables",
            ),
            (json!({"command":""}), "needs a command"),
        ] {
            let directory = snapshot(&json!({"mcpServers":{"local":entry}}));
            let error = WorkspaceMcp::resolve(
                directory.path(),
                &BTreeSet::from(["local"]),
                variables,
                None,
            )
            .err()
            .unwrap()
            .to_string();
            assert!(error.contains(message), "{entry}: {error}");
        }
        let directory = snapshot(&json!({"mcpServers":{}}));
        let error = WorkspaceMcp::resolve(
            directory.path(),
            &BTreeSet::from(["local"]),
            variables,
            None,
        )
        .err()
        .unwrap()
        .to_string();
        assert!(error.contains("is not defined in .mcp.json"), "{error}");
        let missing = tempfile::tempdir().unwrap();
        assert!(
            WorkspaceMcp::resolve(missing.path(), &BTreeSet::from(["local"]), variables, None)
                .is_err()
        );
        // A symlinked configuration is never followed.
        let linked = tempfile::tempdir().unwrap();
        let target = snapshot(&json!({"mcpServers":{"local":{"command":"node"}}}));
        std::os::unix::fs::symlink(
            target.path().join(".mcp.json"),
            linked.path().join(".mcp.json"),
        )
        .unwrap();
        assert!(
            WorkspaceMcp::resolve(linked.path(), &BTreeSet::from(["local"]), variables, None)
                .is_err()
        );
    }

    #[test]
    fn a_sandbox_runs_the_declared_command_and_refuses_host_credentials_by_name() {
        let config = json!({"mcpServers":{
            "tools":{"command":"node","args":["mcp-server.js"]},
            "script":{"command":"./bin/server.sh"},
            "docs":{"type":"http","url":"https://docs.example.test/mcp","headers":{"Authorization":"Bearer ${SUPERTAG_MCP_TOKEN}"}},
            "db":{"command":"node","args":["db.js"],"env":{"DB_TOKEN":"${SUPERTAG_MCP_TOKEN}","LOG":"${SUPERTAG_MCP_ABSENT}"}}
        }});
        let directory = snapshot(&config);
        let names = BTreeSet::from(["docs", "script", "tools"]);
        let sandboxed =
            WorkspaceMcp::resolve(directory.path(), &names, variables, Some("E2B")).unwrap();
        for (name, command) in [
            ("tools", vec!["node", "mcp-server.js"]),
            ("script", vec!["./bin/server.sh"]),
        ] {
            let Transport::Stdio(server) = &sandboxed.servers[name].transport else {
                panic!("stdio server expected");
            };
            // The provider resolves the command in its trusted copy, never in the host snapshot.
            assert!(server.sandboxed && server.cwd.is_none() && server.env.is_empty());
            assert_eq!(server.command, command);
        }
        // HTTP servers stay on the Worker Host with their host-held headers.
        assert!(matches!(
            sandboxed.servers["docs"].transport,
            Transport::Http(_)
        ));
        // The same declaration digests alike, but a sandbox launch binds differently.
        let local = WorkspaceMcp::resolve(directory.path(), &names, variables, None).unwrap();
        assert_eq!(sandboxed.record.digest, local.record.digest);
        assert_ne!(
            sandboxed.servers["tools"].capability.provider_binding,
            local.servers["tools"].capability.provider_binding
        );
        // A host credential in a sandboxed server's env is refused, naming the server and each
        // variable, before any value is read: an absent variable is named, not reported missing.
        let read = std::cell::Cell::new(false);
        let error = WorkspaceMcp::resolve(
            directory.path(),
            &BTreeSet::from(["db", "tools"]),
            |name| {
                read.set(true);
                variables(name)
            },
            Some("Modal"),
        )
        .err()
        .unwrap()
        .to_string();
        assert!(
            error.contains("Workspace MCP server db references host credential SUPERTAG_MCP_ABSENT, SUPERTAG_MCP_TOKEN in its env, but Modal runs Workspace stdio servers inside the Task's sandbox"),
            "{error}"
        );
        assert!(!error.contains("workspace-token-value-81c2"));
        assert!(!read.get());
    }

    #[test]
    fn host_variables_are_limited_to_the_workspace_prefix() {
        assert_eq!(host_variable("PATH"), None);
        assert_eq!(host_variable("SUPERTAG_AUTH_KEY"), None);
    }
}
