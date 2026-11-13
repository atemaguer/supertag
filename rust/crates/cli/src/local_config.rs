//! Bounded local process configuration. Credentials are references, never rendered values.
mod environment;

use crate::harness::AdapterOptions;
use anyhow::{Context, Result, bail, ensure};
use clap::Parser;
pub use environment::Environment;
use serde::Deserialize;
use std::{
    collections::BTreeMap,
    ffi::OsString,
    fs::OpenOptions,
    io::Read,
    net::SocketAddr,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

const MAX_BYTES: usize = 1024 * 1024;
const MAX_PROVISION_SOURCES: usize = 256;
#[derive(Clone, Copy, Default, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum Restart {
    #[default]
    No,
    UnlessStopped,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Document {
    #[serde(default = "version")]
    version: u32,
    #[serde(default = "instance")]
    name: String,
    services: BTreeMap<String, Service>,
    #[serde(default)]
    secrets: BTreeMap<String, Secret>,
}
fn version() -> u32 {
    1
}
fn instance() -> String {
    "supertag".into()
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
enum Service {
    ControlPlane {
        #[serde(default)]
        ports: Vec<String>,
        #[serde(default)]
        url: Option<String>,
        #[serde(default)]
        credentials: Option<String>,
        #[serde(default)]
        restart: Restart,
        #[serde(default)]
        provision: Vec<ProvisionEntry>,
    },
    Host {
        #[serde(default, rename = "control-plane")]
        gateway: Option<String>,
        #[serde(default, rename = "auth-key")]
        auth_key: Option<String>,
        #[serde(default)]
        harnesses: Vec<String>,
        #[serde(default)]
        adapter: Option<PathBuf>,
        #[serde(default, rename = "adapter-args")]
        adapter_args: Vec<String>,
        #[serde(default)]
        models: BTreeMap<String, Models>,
        #[serde(default)]
        workspaces: BTreeMap<String, PathBuf>,
        #[serde(default)]
        skills: Option<PathBuf>,
        #[serde(default, rename = "allow-unsandboxed-commands")]
        unsandboxed: Vec<String>,
        #[serde(default)]
        restart: Restart,
        #[serde(default)]
        depends_on: Vec<String>,
        #[serde(default)]
        concurrency: Option<u32>,
    },
}
#[derive(Deserialize)]
#[serde(untagged)]
enum ProvisionEntry {
    File(PathBuf),
    Inline(serde_json::Value),
}
#[derive(Deserialize)]
#[serde(untagged)]
enum Models {
    One(String),
    Many(Vec<String>),
}
#[derive(Clone, Deserialize)]
#[serde(untagged)]
pub enum Secret {
    Environment(EnvironmentSecret),
    File(FileSecret),
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EnvironmentSecret {
    environment: String,
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FileSecret {
    file: PathBuf,
}

pub struct Config {
    pub plane: Option<Plane>,
    pub hosts: Vec<Host>,
    /// `env_file` values behind the process environment, read only by the supervisor.
    pub environment: Environment,
}
pub struct Plane {
    pub listen: SocketAddr,
    pub provision: Vec<crate::manifests::ProvisionSource>,
}
#[derive(Clone)]
pub struct Host {
    pub name: String,
    pub gateway: Option<String>,
    pub key: Option<Secret>,
    pub adapter: AdapterOptions,
    pub skills: Option<PathBuf>,
    pub restart: Restart,
}
#[derive(Parser)]
struct AdapterArguments {
    #[command(flatten)]
    adapter: AdapterOptions,
}

pub fn state_directory(explicit: Option<PathBuf>) -> Result<PathBuf> {
    explicit
        .or_else(|| std::env::var_os("SUPERTAG_STATE_DIR").map(PathBuf::from))
        .or_else(|| std::env::var_os("HOME").map(|p| PathBuf::from(p).join(".supertag")))
        .context("provide --state-directory or set HOME")
}
pub fn load(file: Option<PathBuf>, state: &Path) -> Result<Option<Config>> {
    let explicit = file.is_some();
    let mut path = file.unwrap_or_else(|| state.join("supertag.yaml"));
    if path.is_dir() {
        path = path.join("supertag.yaml");
    }
    let file = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(&path)
    {
        Ok(file) => file,
        Err(e) if !explicit && e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e).context("read local services file"),
    };
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file(),
        "local services configuration must be a regular file"
    );
    let mut bytes = Vec::new();
    file.take((MAX_BYTES + 1) as u64).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= MAX_BYTES,
        "local services file exceeds 1 MiB"
    );
    let base = path
        .canonicalize()?
        .parent()
        .context("configuration directory missing")?
        .to_owned();
    let config = parse(&bytes, &base, |name| std::env::var(name).ok())?;
    if config
        .plane
        .as_ref()
        .is_some_and(|plane| !plane.provision.is_empty())
    {
        ensure!(
            metadata.uid() == unsafe { libc::geteuid() } && metadata.mode() & 0o022 == 0,
            "provisioning configuration must be owned by this user and not writable by others"
        );
    }
    Ok(Some(config))
}
fn parse(bytes: &[u8], base: &Path, lookup: impl Fn(&str) -> Option<String>) -> Result<Config> {
    let options = serde_saphyr::options! {budget:serde_saphyr::budget!{max_documents:1,max_depth:24,max_nodes:10000,max_total_scalar_bytes:MAX_BYTES}};
    // Do not echo YAML parse input: a mistaken inline secret must not reach logs.
    let invalid = || anyhow::anyhow!("invalid or unsupported local service configuration");
    let mut value: serde_json::Value =
        serde_saphyr::from_slice_with_options(bytes, options).map_err(|_| invalid())?;
    let environment = environment::resolve(&mut value, base, lookup)?;
    if let Some(object) = value.as_object_mut() {
        // Top-level x-* keys hold YAML anchors and are otherwise ignored.
        object.retain(|key, _| !key.starts_with("x-"));
    }
    // Interpolated values may be secrets, so deserialization errors stay generic too.
    let document: Document = serde_json::from_value(value).map_err(|_| invalid())?;
    ensure!(
        document.version == 1,
        "local configuration version must be 1"
    );
    identifier(&document.name)?;
    ensure!(
        !document.services.is_empty() && document.services.len() <= 33,
        "configure one to 33 services"
    );
    let mut plane = None;
    let mut plane_name = None;
    for (name, service) in &document.services {
        identifier(name)?;
        if let Service::ControlPlane {
            ports,
            url,
            credentials,
            restart,
            provision,
        } = service
        {
            ensure!(plane.is_none(), "configure at most one local Control Plane");
            ensure!(
                credentials.as_deref().is_none_or(|s| s == "file"),
                "local supervisor supports file credentials only"
            );
            ensure!(
                *restart == Restart::No,
                "automatic local Control Plane restart is not supported"
            );
            ensure!(ports.len() <= 1, "configure one public Gateway listener");
            let port = ports
                .first()
                .map(String::as_str)
                .unwrap_or("127.0.0.1:3434");
            let listen = if let Ok(port) = port.parse::<u16>() {
                SocketAddr::from(([127, 0, 0, 1], port))
            } else {
                port.parse::<SocketAddr>()
                    .context("invalid Gateway listener")?
            };
            ensure!(
                listen.ip().is_loopback(),
                "local Gateway listener must be loopback"
            );
            if let Some(url) = url {
                ensure!(
                    url.trim_end_matches('/') == format!("http://{listen}"),
                    "local Gateway URL must match its listener"
                );
            }
            ensure!(
                provision.len() <= MAX_PROVISION_SOURCES,
                "configure at most 256 provisioning sources"
            );
            let mut sources = Vec::new();
            for source in provision {
                match source {
                    ProvisionEntry::File(path) => {
                        sources.extend(provision_files(base, path)?);
                    }
                    ProvisionEntry::Inline(value) => {
                        ensure!(
                            value.is_object(),
                            "inline provision entries must be resource objects"
                        );
                        sources.push(crate::manifests::ProvisionSource::Inline(value.clone()));
                    }
                }
                ensure!(
                    sources.len() <= MAX_PROVISION_SOURCES,
                    "configure at most 256 provisioning sources"
                );
            }
            plane = Some(Plane {
                listen,
                provision: sources,
            });
            plane_name = Some(name.clone());
        }
    }
    let mut secrets = document.secrets;
    for (name, secret) in &mut secrets {
        identifier(name)?;
        match secret {
            Secret::Environment(source) => ensure!(
                valid_environment(&source.environment),
                "invalid secret environment variable name"
            ),
            Secret::File(source) => source.file = resolve_path(base, &source.file)?,
        }
    }
    let mut hosts = Vec::new();
    for (name, service) in document.services {
        let Service::Host {
            gateway,
            auth_key,
            harnesses,
            adapter,
            adapter_args,
            models,
            workspaces,
            skills,
            unsandboxed,
            restart,
            depends_on,
            concurrency,
        } = service
        else {
            continue;
        };
        ensure!(hosts.len() < 32, "configure at most 32 named Worker Hosts");
        ensure!(
            concurrency.is_none_or(|n| n == 1),
            "each native Worker Host currently runs one Attempt; use independent named hosts for more capacity"
        );
        let target = gateway
            .as_deref()
            .or(plane_name.as_deref())
            .context("host requires a control-plane service or Gateway URL")?;
        let remote = if Some(target) == plane_name.as_deref() {
            None
        } else {
            validate_endpoint(target)?;
            Some(target.trim_end_matches('/').to_owned())
        };
        ensure!(
            depends_on
                .iter()
                .all(|d| Some(d.as_str()) == plane_name.as_deref() && remote.is_none()),
            "depends_on supports only this host's local Control Plane"
        );
        let key = auth_key
            .as_ref()
            .map(|name| {
                secrets
                    .get(name)
                    .cloned()
                    .context("Auth Key must reference a named environment or file secret")
            })
            .transpose()?;
        ensure!(
            remote.is_some() || key.is_none(),
            "local hosts enroll using the local operator credential"
        );
        ensure!(
            (adapter.is_some() && harnesses.is_empty())
                || (adapter.is_none() && harnesses.len() == 1),
            "configure one harness or protocol adapter per named host; multiple harnesses under one identity are not supported"
        );
        ensure!(
            workspaces.len() <= 1,
            "each native Worker Host currently supports one Workspace mapping"
        );
        let mut args = vec![OsString::from("host")];
        if let Some(adapter) = adapter {
            ensure!(
                models.is_empty() && unsandboxed.is_empty(),
                "protocol adapters cannot configure native models or unsandboxed commands"
            );
            args.extend([
                "--adapter".into(),
                resolve_path(base, &adapter)?.into_os_string(),
            ]);
            for arg in adapter_args {
                args.push(format!("--adapter-arg={arg}").into());
            }
        } else {
            ensure!(
                adapter_args.is_empty(),
                "adapter-args requires a protocol adapter"
            );
            let harness = &harnesses[0];
            args.extend(["--harness".into(), harness.into()]);
            ensure!(
                models.keys().all(|name| name == harness),
                "model settings must name the selected harness"
            );
            if let Some(models) = models.get(harness) {
                let values = match models {
                    Models::One(s) => vec![s.clone()],
                    Models::Many(v) => v.clone(),
                };
                ensure!(!values.is_empty(), "model list must not be empty");
                args.extend(["--harness-model".into(), values[0].clone().into()]);
                for model in values {
                    args.extend(["--harness-models".into(), model.into()]);
                }
            }
            ensure!(
                unsandboxed.len() <= 1 && unsandboxed.iter().all(|h| h == harness),
                "unsandboxed command consent must name the selected harness"
            );
            if !unsandboxed.is_empty() {
                ensure!(
                    matches!(harness.as_str(), "opencode" | "cursor"),
                    "only OpenCode and Cursor accept unsandboxed command consent"
                );
                args.push("--allow-unsandboxed-commands".into());
            }
        }
        for (id, path) in workspaces {
            identifier(&id)?;
            args.extend([
                "--workspace-id".into(),
                id.into(),
                "--workspace-source".into(),
                resolve_path(base, &path)?.into_os_string(),
            ]);
        }
        let adapter = AdapterArguments::try_parse_from(args)
            .map_err(|_| anyhow::anyhow!("invalid configured harness or adapter options"))?
            .adapter;
        adapter.execution_profile()?;
        adapter.provider_environment()?;
        let skills = skills.map(|p| resolve_path(base, &p)).transpose()?;
        hosts.push(Host {
            name,
            gateway: remote,
            key,
            adapter,
            skills,
            restart,
        });
    }
    ensure!(
        plane.is_some() || !hosts.is_empty(),
        "configuration has no runnable services"
    );
    Ok(Config {
        plane,
        hosts,
        environment,
    })
}
fn identifier(value: &str) -> Result<()> {
    ensure!(
        (1..=63).contains(&value.len())
            && value.as_bytes()[0].is_ascii_alphanumeric()
            && value
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_'),
        "service, instance and mapping names must use lowercase letters, numbers, hyphens or underscores"
    );
    Ok(())
}
fn valid_environment(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .enumerate()
            .all(|(i, b)| b == b'_' || b.is_ascii_alphabetic() || (i > 0 && b.is_ascii_digit()))
}
fn resolve_path(base: &Path, path: &Path) -> Result<PathBuf> {
    if let Some(tail) = path.to_str().and_then(|p| p.strip_prefix("~/")) {
        return Ok(PathBuf::from(
            std::env::var_os("HOME").context("HOME is required for ~/ paths")?,
        )
        .join(tail));
    }
    ensure!(
        !path.as_os_str().is_empty(),
        "configuration path must not be empty"
    );
    Ok(if path.is_absolute() {
        path.to_owned()
    } else {
        base.join(path)
    })
}
fn provision_files(base: &Path, path: &Path) -> Result<Vec<crate::manifests::ProvisionSource>> {
    let path = resolve_path(base, path)?;
    let metadata = std::fs::symlink_metadata(&path).context("inspect provisioning source")?;
    if !metadata.is_dir() {
        // The shared manifest loader validates every selected leaf with O_NOFOLLOW.
        return Ok(vec![crate::manifests::ProvisionSource::File(path)]);
    }
    let directory = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY)
        .open(&path)
        .context("open provisioning directory")?;
    let opened = directory.metadata()?;
    ensure!(
        opened.uid() == unsafe { libc::geteuid() }
            && opened.mode() & 0o022 == 0
            && opened.dev() == metadata.dev()
            && opened.ino() == metadata.ino(),
        "provisioning directories must be owned by this user and not writable by others"
    );
    let mut paths = Vec::new();
    for (index, entry) in std::fs::read_dir(&path)
        .context("read provisioning directory")?
        .enumerate()
    {
        ensure!(index < 4096, "provisioning directory has too many entries");
        let path = entry?.path();
        if matches!(
            path.extension().and_then(|extension| extension.to_str()),
            Some("yaml" | "yml" | "json")
        ) {
            // Include selected symlinks and nonregular files so the shared loader
            // rejects them instead of silently omitting intended configuration.
            paths.push(path);
            ensure!(
                paths.len() <= MAX_PROVISION_SOURCES,
                "configure at most 256 provisioning sources"
            );
        }
    }
    let after = std::fs::symlink_metadata(&path)?;
    ensure!(
        after.is_dir() && after.dev() == opened.dev() && after.ino() == opened.ino(),
        "provisioning directory changed during selection"
    );
    paths.sort();
    Ok(paths
        .into_iter()
        .map(crate::manifests::ProvisionSource::File)
        .collect())
}
fn validate_endpoint(value: &str) -> Result<()> {
    let uri: tonic::transport::Uri = value.parse().context("invalid Gateway endpoint")?;
    ensure!(
        uri.authority().is_some_and(|a| !a.as_str().contains('@'))
            && uri.query().is_none()
            && uri.path() == "/",
        "Gateway endpoint must be an origin without credentials"
    );
    match uri.scheme_str() {
        Some("https") => {}
        Some("http") => ensure!(
            uri.host().is_some_and(|h| h
                .trim_matches(['[', ']'])
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())),
            "cleartext Gateway must use a literal loopback address"
        ),
        _ => bail!("Gateway must use HTTPS or loopback HTTP"),
    };
    Ok(())
}
impl Secret {
    /// Read the secret when a service starts: an `environment` secret falls back to `env_file`.
    pub fn read(&self, environment: &Environment) -> Result<String> {
        let value = match self {
            Self::Environment(source) => environment
                .variable(&source.environment)
                .and_then(|value| value.into_string().ok())
                .context("Auth Key environment variable is unavailable")?,
            Self::File(source) => {
                let file = OpenOptions::new()
                    .read(true)
                    .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
                    .open(&source.file)
                    .context("read Auth Key file")?;
                let metadata = file.metadata()?;
                ensure!(
                    metadata.is_file()
                        && metadata.nlink() == 1
                        && metadata.uid() == unsafe { libc::geteuid() }
                        && metadata.mode() & 0o077 == 0,
                    "Auth Key file must be a private regular file owned by this user"
                );
                let mut value = String::new();
                file.take(4097).read_to_string(&mut value)?;
                value
            }
        };
        let value = value.trim();
        ensure!(
            !value.is_empty() && value.len() <= 4096 && !value.chars().any(char::is_control),
            "invalid Auth Key source"
        );
        Ok(value.into())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    #[test]
    fn local_and_remote_named_services_preserve_selection() {
        let c=parse(br#"version: 1
name: fixture
services:
  control-plane: {type: control-plane, ports: ["127.0.0.1:0"]}
  reviewer: {type: host, harnesses: [codex], models: {codex: [model-a, model-b]}, workspaces: {repo: ./source}}
  writer: {type: host, harnesses: [claude-code], skills: ./skills, restart: unless-stopped}
"#,Path::new("/trusted"), |_| None).unwrap();
        assert_eq!(c.hosts.len(), 2);
        assert_eq!(c.plane.unwrap().listen.port(), 0);
        assert_eq!(
            c.hosts[0].adapter.execution_profile().unwrap().model_ids,
            ["model-a", "model-b"]
        );
        assert!(
            c.hosts[0]
                .adapter
                .worker_args()
                .iter()
                .any(|v| v == "/trusted/./source")
        );
        let c = parse(
            br#"services:
  laptop: {type: host, control-plane: https://gateway.example, auth-key: key, harnesses: [cursor]}
secrets:
  key: {environment: JOIN_KEY}
"#,
            Path::new("/trusted"),
            |_| None,
        )
        .unwrap();
        assert!(c.plane.is_none());
        assert!(c.hosts[0].key.is_some());
    }
    #[test]
    fn env_file_interpolates_services_and_backs_environment_secrets() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let env = temp.path().join("fixture.env");
        fs::write(
            &env,
            "GATEWAY=https://gateway.example\nJOIN_KEY=file-join-key\nMODEL=from-file\n",
        )
        .unwrap();
        fs::set_permissions(&env, fs::Permissions::from_mode(0o600)).unwrap();
        let input = br#"env_file: fixture.env
x-defaults: &host {type: host, harnesses: [codex]}
services:
  laptop:
    <<: *host
    control-plane: ${GATEWAY}
    auth-key: key
    models: {codex: ["${MODEL}", "${SECOND:-fallback-model}"]}
secrets:
  key: {environment: JOIN_KEY}
"#;
        let config = parse(input, temp.path(), |name| {
            (name == "MODEL").then(|| "from-shell".to_owned())
        })
        .unwrap();
        let host = &config.hosts[0];
        assert_eq!(host.gateway.as_deref(), Some("https://gateway.example"));
        assert_eq!(
            host.adapter.execution_profile().unwrap().model_ids,
            ["fallback-model", "from-shell"]
        );
        // The process environment wins over env_file, and the first listed model is the default.
        assert!(
            host.adapter
                .worker_args()
                .windows(2)
                .any(|pair| pair[0] == "--harness-model" && pair[1] == "from-shell")
        );
        // The environment secret falls back to env_file when the process lacks it.
        assert_eq!(
            host.key
                .as_ref()
                .unwrap()
                .read(&config.environment)
                .unwrap(),
            "file-join-key"
        );
        assert!(
            host.key
                .as_ref()
                .unwrap()
                .read(&Environment::default())
                .is_err()
        );
        // Missing variables and values that fail validation never echo resolved values.
        let missing = parse(
            b"services: {laptop: {type: host, control-plane: '${ABSENT}', harnesses: [codex]}}",
            temp.path(),
            |_| None,
        )
        .err()
        .unwrap();
        assert!(missing.to_string().contains("${ABSENT} is not set"));
        let invalid = parse(
            b"services: {laptop: {type: host, control-plane: https://gateway.example, harnesses: [codex], concurrency: '${N}'}}",
            temp.path(),
            |_| Some("secret-looking-value".into()),
        )
        .err()
        .unwrap();
        assert!(!format!("{invalid:#}").contains("secret-looking-value"));
    }
    #[test]
    fn invalid_unsupported_and_credential_bearing_config_fails_closed() {
        for input in [
            "services: {host: {type: host, control-plane: http://example.com, harnesses: [codex]}}",
            "services: {host: {type: host, control-plane: https://user:secret@example.com, harnesses: [codex]}}",
            "services: {host: {type: host, control-plane: https://example.com, harnesses: [codex, cursor]}}",
            "services: {control-plane: {type: control-plane, ports: ['0.0.0.0:3434']}}",
            "services: {host: {type: host, control-plane: https://example.com, harnesses: [codex], auth-key: literal-secret}}",
            "services: {host: {type: host, control-plane: https://example.com, harnesses: [codex], environment: e2b}}",
            "version: 2\nservices: {control-plane: {type: control-plane}}",
        ] {
            let error = parse(input.as_bytes(), Path::new("/trusted"), |_| None)
                .err()
                .expect("must reject");
            assert!(!error.to_string().contains("literal-secret"));
        }
    }
    #[test]
    fn provisioning_configuration_requires_owner_control() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("supertag.yaml");
        fs::write(
            &path,
            r#"services:
  control-plane:
    type: control-plane
    provision:
      - apiVersion: supertag/v1
        kind: Tag
        metadata: {name: engineer}
        spec: {instructions: Work}
"#,
        )
        .unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o666)).unwrap();
        assert!(load(Some(path.clone()), temp.path()).is_err());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(
            load(Some(path), temp.path())
                .unwrap()
                .unwrap()
                .plane
                .unwrap()
                .provision
                .len(),
            1
        );
    }
    #[test]
    fn provisioning_directories_are_bounded_and_do_not_hide_unsafe_leaves() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let temp = tempfile::tempdir().unwrap();
        let resources = temp.path().join("resources");
        fs::create_dir(&resources).unwrap();
        fs::set_permissions(&resources, fs::Permissions::from_mode(0o755)).unwrap();
        fs::write(resources.join("b.yaml"), "{}").unwrap();
        fs::write(resources.join("a.json"), "{}").unwrap();
        fs::write(resources.join("ignored.txt"), "not a manifest").unwrap();
        symlink(resources.join("a.json"), resources.join("c.yml")).unwrap();
        let sources = provision_files(temp.path(), Path::new("resources")).unwrap();
        let paths = sources
            .iter()
            .map(|source| match source {
                crate::manifests::ProvisionSource::File(path) => {
                    path.file_name().unwrap().to_str().unwrap()
                }
                _ => panic!("directory must expand to leaf paths"),
            })
            .collect::<Vec<_>>();
        assert_eq!(paths, ["a.json", "b.yaml", "c.yml"]);
        fs::set_permissions(&resources, fs::Permissions::from_mode(0o777)).unwrap();
        assert!(provision_files(temp.path(), Path::new("resources")).is_err());
        fs::set_permissions(&resources, fs::Permissions::from_mode(0o755)).unwrap();
        for i in 0..254 {
            fs::write(resources.join(format!("{i}.yaml")), "{}").unwrap();
        }
        assert!(provision_files(temp.path(), Path::new("resources")).is_err());
    }
    #[test]
    fn private_file_secrets_are_bounded_and_no_follow() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("key");
        fs::write(&file, "fixture-key\n").unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
        let source = Secret::File(FileSecret { file: file.clone() });
        assert!(source.read(&Environment::default()).is_err());
        fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(source.read(&Environment::default()).unwrap(), "fixture-key");
        let link = temp.path().join("link");
        std::os::unix::fs::symlink(file, &link).unwrap();
        assert!(
            Secret::File(FileSecret { file: link })
                .read(&Environment::default())
                .is_err()
        );
    }
}
