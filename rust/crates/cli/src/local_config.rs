//! Bounded local process configuration. Credentials are references, never rendered values.
mod environment;
pub mod surfaces;

use crate::harness::AdapterOptions;
use anyhow::{Context, Result, bail, ensure};
use clap::Parser;
pub use environment::{Environment, UNIT_VARIABLES};
use serde::Deserialize;
use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet},
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
    #[serde(default)]
    surfaces: BTreeMap<String, surfaces::Surface>,
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
        /// Where the operator hears about Inbox items; `desktop` when unset.
        #[serde(default)]
        notify: Option<Notify>,
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
        workspaces: BTreeMap<String, WorkspaceMapping>,
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
/// A Workspace's local repository: a path, or a path and how deliveries reach it.
#[derive(Deserialize)]
#[serde(untagged, deny_unknown_fields)]
enum WorkspaceMapping {
    Path(PathBuf),
    Detailed {
        path: PathBuf,
        #[serde(default)]
        delivery: Delivery,
    },
}
/// `branch` imports each delivered Task into the repository as its Session branch; `patch`
/// leaves the repository alone, and the patch and bundle stay downloadable.
#[derive(Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum Delivery {
    #[default]
    Branch,
    Patch,
}
impl WorkspaceMapping {
    fn parts(&self) -> (&Path, Delivery) {
        match self {
            Self::Path(path) => (path, Delivery::Branch),
            Self::Detailed { path, delivery } => (path, *delivery),
        }
    }
}
#[derive(Deserialize)]
#[serde(untagged)]
enum Notify {
    One(String),
    Many(Vec<String>),
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
    /// The file's `name`, which labels its service unit.
    pub name: String,
    /// The file this configuration came from.
    pub path: PathBuf,
    /// SHA-256 of the file, so `supertag up` can leave an unchanged supervisor alone.
    pub digest: String,
    /// SHA-256 of the resolved configuration without any host's `concurrency`: when only this
    /// is unchanged, `supertag up` changes the running hosts' lanes instead of restarting.
    pub shape: String,
    /// Some service sets `restart: unless-stopped`, so `up` installs a per-user service unit.
    pub service_unit: bool,
    pub plane: Option<Plane>,
    pub hosts: Vec<Host>,
    /// `env_file` values behind the process environment, read only by the supervisor.
    pub environment: Environment,
    /// `${VAR}` references this shell's environment resolved.
    pub shell_variables: BTreeSet<String>,
    /// Surface Accounts the local Gateway connects; see `supertag setup surface`.
    pub surfaces: BTreeMap<String, surfaces::Surface>,
}
pub struct Plane {
    pub listen: SocketAddr,
    pub provision: Vec<crate::manifests::ProvisionSource>,
    pub notify: Notifications,
}
/// The Gateway's `--notify` destinations and the named secrets their webhooks send.
#[derive(Clone)]
pub struct Notifications {
    pub destinations: Vec<String>,
    pub secrets: BTreeMap<String, Secret>,
}
impl Notifications {
    /// The Gateway's `--notify` values and `SUPERTAG_NOTIFY_SECRET_<NAME>` environment. A
    /// missing secret fails only its own destination when it sends, as TypeScript does.
    pub fn resolve(&self, environment: &Environment) -> (Vec<String>, Vec<(String, String)>) {
        let secrets = self
            .secrets
            .iter()
            .filter_map(|(name, secret)| {
                let value = secret.read(environment).ok()?;
                Some((crate::notify_secret_variable(name), value))
            })
            .collect();
        (self.destinations.clone(), secrets)
    }
}
impl Default for Notifications {
    /// A local installation tells its operator on the desktop, as TypeScript does.
    fn default() -> Self {
        Self {
            destinations: vec!["desktop".into()],
            secrets: BTreeMap::new(),
        }
    }
}
#[derive(Clone)]
pub struct Host {
    pub name: String,
    pub gateway: Option<String>,
    pub key: Option<Secret>,
    /// One entry per configured harness, or the single protocol adapter.
    pub harnesses: Vec<AdapterOptions>,
    /// Attempts each harness runs at once; each is a separate execution lane.
    pub concurrency: u32,
    pub skills: Option<PathBuf>,
    pub restart: Restart,
    /// Repositories, by Workspace ID, that receive each delivered Task as its Session branch.
    /// Only a Host of this file's own Control Plane has them; the supervisor imports with the
    /// local operator credential.
    pub session_branches: crate::delivery_branches::Repositories,
}
/// The largest per-harness concurrency a Worker Host may declare.
pub const MAX_CONCURRENCY: u32 = 16;
/// Distinct built-in harnesses one named Host may serve.
const MAX_HARNESSES: usize = 5;
#[derive(Parser)]
struct AdapterArguments {
    #[command(flatten)]
    adapter: AdapterOptions,
}

/// The local state directory: `--state-directory`, else `SUPERTAG_STATE_DIR`, else
/// `~/.supertag`. A relative directory is resolved from the directory `supertag` runs in, so the
/// services it starts use the same files.
pub fn state_directory(explicit: Option<PathBuf>) -> Result<PathBuf> {
    resolve_state_directory(
        explicit,
        std::env::var_os("SUPERTAG_STATE_DIR").map(PathBuf::from),
        std::env::var_os("HOME").map(PathBuf::from),
        &std::env::current_dir().context("read the current directory")?,
    )
}

fn resolve_state_directory(
    explicit: Option<PathBuf>,
    configured: Option<PathBuf>,
    home: Option<PathBuf>,
    invocation: &Path,
) -> Result<PathBuf> {
    let directory = explicit
        .or(configured)
        .filter(|path| !path.as_os_str().is_empty())
        .or_else(|| {
            home.filter(|home| !home.as_os_str().is_empty())
                .map(|home| home.join(".supertag"))
        })
        .context("provide --state-directory or set HOME")?;
    Ok(invocation.join(directory))
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
    let shell = RefCell::new(BTreeSet::new());
    let mut config = parse(&bytes, &base, |name| {
        let value = std::env::var(name).ok();
        if value.is_some() {
            shell.borrow_mut().insert(name.to_owned());
        }
        value
    })?;
    config.shell_variables = shell.into_inner();
    config.path = path.canonicalize()?;
    config.digest = crate::lifecycle::hex(&<sha2::Sha256 as sha2::Digest>::digest(&bytes));
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
/// The environment a configuration in `state` without an `env_file` would read: `state/.env`.
pub fn default_environment(state: &Path) -> Result<Environment> {
    environment::resolve(&mut serde_json::json!({}), state, |_| None)
}
/// The document after `env_file` loading and interpolation, without `x-` keys.
fn resolved(
    bytes: &[u8],
    base: &Path,
    lookup: impl Fn(&str) -> Option<String>,
) -> Result<(serde_json::Value, Environment)> {
    let options = serde_saphyr::options! {budget:serde_saphyr::budget!{max_documents:1,max_depth:24,max_nodes:10000,max_total_scalar_bytes:MAX_BYTES}};
    // Do not echo YAML parse input: a mistaken inline secret must not reach logs.
    let mut value: serde_json::Value = serde_saphyr::from_slice_with_options(bytes, options)
        .map_err(|_| anyhow::anyhow!("invalid or unsupported local service configuration"))?;
    let environment = environment::resolve(&mut value, base, lookup)?;
    if let Some(object) = value.as_object_mut() {
        // Top-level x-* keys hold YAML anchors and are otherwise ignored.
        object.retain(|key, _| !key.starts_with("x-"));
    }
    Ok((value, environment))
}
/// The digest of a resolved configuration with each host's `concurrency` removed. Only a digest
/// is kept, never the resolved values, which may hold secrets.
fn shape_digest(value: &serde_json::Value) -> String {
    let mut shape = value.clone();
    if let Some(services) = shape
        .get_mut("services")
        .and_then(serde_json::Value::as_object_mut)
    {
        for service in services.values_mut() {
            if service.get("type").and_then(serde_json::Value::as_str) == Some("host")
                && let Some(service) = service.as_object_mut()
            {
                service.remove("concurrency");
            }
        }
    }
    crate::lifecycle::hex(&<sha2::Sha256 as sha2::Digest>::digest(
        shape.to_string().as_bytes(),
    ))
}

fn parse(bytes: &[u8], base: &Path, lookup: impl Fn(&str) -> Option<String>) -> Result<Config> {
    let invalid = || anyhow::anyhow!("invalid or unsupported local service configuration");
    let (value, environment) = resolved(bytes, base, lookup)?;
    let shape = shape_digest(&value);
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
            notify,
        } = service
        {
            ensure!(plane.is_none(), "configure at most one local Control Plane");
            ensure!(
                credentials.as_deref().is_none_or(|s| s == "file"),
                "local supervisor supports file credentials only"
            );
            // The supervisor stops when its Control Plane exits; `unless-stopped` asks for a
            // per-user service unit that starts the supervisor again.
            let _ = restart;
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
            let destinations = match notify {
                None => vec!["desktop".to_owned()],
                Some(Notify::One(value)) => vec![value.clone()],
                Some(Notify::Many(values)) => values.clone(),
            };
            // Refuse an invalid destination now; errors never echo a webhook URL.
            let parsed = supertag_gateway::notifications::parse_destinations(
                &destinations,
                crate::notify_loopback_http(),
            )?;
            let mut secrets = BTreeMap::new();
            for name in parsed.iter().filter_map(|d| d.secret_name.as_ref()) {
                let secret = document.secrets.get(name).with_context(|| {
                    format!("notify webhook secret {name} is not a named secret")
                })?;
                let mut secret = secret.clone();
                if let Secret::File(source) = &mut secret {
                    source.file = resolve_path(base, &source.file)?;
                }
                secrets.insert(name.clone(), secret);
            }
            plane = Some(Plane {
                listen,
                provision: sources,
                notify: Notifications {
                    destinations,
                    secrets,
                },
            });
            plane_name = Some(name.clone());
        }
    }
    let service_unit = document.services.values().any(|service| {
        matches!(
            service,
            Service::ControlPlane {
                restart: Restart::UnlessStopped,
                ..
            } | Service::Host {
                restart: Restart::UnlessStopped,
                ..
            }
        )
    });
    surfaces::validate(&document.surfaces)?;
    ensure!(
        plane.is_some() || document.surfaces.is_empty(),
        "surfaces require a control-plane service"
    );
    let instance = document.name.clone();
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
        // These name the supervisor's own logs and `ps` rows.
        ensure!(
            ![
                crate::lifecycle::SUPERVISOR,
                crate::lifecycle::CONTROL_PLANE,
                crate::lifecycle::GATEWAY,
            ]
            .contains(&name.as_str()),
            "a host cannot be named {name}; that name belongs to a fixed local service"
        );
        let concurrency = match concurrency {
            Some(n) => {
                ensure!(
                    (1..=MAX_CONCURRENCY).contains(&n),
                    "concurrency must be a whole number from 1 through {MAX_CONCURRENCY}"
                );
                n
            }
            // Each slot is a lane process with its own claim loop, so extra lanes cost Control
            // Plane polling even when idle. More than one Attempt per harness is opt-in.
            None => 1,
        };
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
                || (adapter.is_none() && (1..=MAX_HARNESSES).contains(&harnesses.len())),
            "configure one to {MAX_HARNESSES} harnesses or one protocol adapter per named host"
        );
        let mut distinct = harnesses.clone();
        distinct.sort_unstable();
        distinct.dedup();
        ensure!(
            distinct.len() == harnesses.len(),
            "each harness may be listed once per named host"
        );
        ensure!(
            workspaces.len() <= 128,
            "a named Worker Host maps at most 128 Workspaces"
        );
        let mut mapping = Vec::new();
        let mut session_branches = BTreeMap::new();
        for (id, workspace) in &workspaces {
            identifier(id)?;
            let (path, delivery) = workspace.parts();
            let path = resolve_path(base, path)?;
            if delivery == Delivery::Branch && remote.is_none() {
                session_branches.insert(id.clone(), path.clone());
            }
            mapping.extend([
                OsString::from("--workspace-id"),
                id.into(),
                "--workspace-source".into(),
                path.into_os_string(),
            ]);
        }
        let mut selections = Vec::new();
        if let Some(adapter) = adapter {
            ensure!(
                models.is_empty() && unsandboxed.is_empty(),
                "protocol adapters cannot configure native models or unsandboxed commands"
            );
            let mut args = vec![
                OsString::from("host"),
                "--adapter".into(),
                resolve_path(base, &adapter)?.into_os_string(),
            ];
            for arg in adapter_args {
                args.push(format!("--adapter-arg={arg}").into());
            }
            selections.push(args);
        } else {
            ensure!(
                adapter_args.is_empty(),
                "adapter-args requires a protocol adapter"
            );
            ensure!(
                models.keys().all(|name| harnesses.contains(name)),
                "model settings must name a selected harness"
            );
            ensure!(
                unsandboxed.iter().all(|h| harnesses.contains(h)),
                "unsandboxed command consent must name a selected harness"
            );
            for harness in &harnesses {
                let mut args = vec![OsString::from("host"), "--harness".into(), harness.into()];
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
                if unsandboxed.contains(harness) {
                    ensure!(
                        matches!(harness.as_str(), "opencode" | "cursor"),
                        "only OpenCode and Cursor accept unsandboxed command consent"
                    );
                    args.push("--allow-unsandboxed-commands".into());
                }
                selections.push(args);
            }
        }
        let mut selected = Vec::new();
        for mut args in selections {
            args.extend(mapping.iter().cloned());
            let adapter = AdapterArguments::try_parse_from(args)
                .map_err(|_| anyhow::anyhow!("invalid configured harness or adapter options"))?
                .adapter;
            adapter.execution_profile()?;
            adapter.provider_environment()?;
            selected.push(adapter);
        }
        let skills = skills.map(|p| resolve_path(base, &p)).transpose()?;
        hosts.push(Host {
            name,
            gateway: remote,
            key,
            harnesses: selected,
            concurrency,
            skills,
            restart,
            session_branches,
        });
    }
    ensure!(
        plane.is_some() || !hosts.is_empty(),
        "configuration has no runnable services"
    );
    Ok(Config {
        name: instance,
        path: PathBuf::new(),
        digest: String::new(),
        shape,
        service_unit,
        plane,
        hosts,
        environment,
        shell_variables: BTreeSet::new(),
        surfaces: document.surfaces,
    })
}

/// Checks a rewritten services file before it replaces `before`: it must load, and differ only
/// in its `surfaces` section. Returns the new surfaces.
pub fn check_surface_edit(
    before: &[u8],
    after: &[u8],
    base: &Path,
) -> Result<BTreeMap<String, surfaces::Surface>> {
    let lookup = |name: &str| std::env::var(name).ok();
    let config = parse(after, base, lookup)?;
    let strip = |bytes| -> Result<serde_json::Value> {
        let (mut value, _) = resolved(bytes, base, lookup)?;
        if let Some(object) = value.as_object_mut() {
            object.remove("surfaces");
        }
        Ok(value)
    };
    ensure!(
        strip(before)? == strip(after)?,
        "the surfaces section could not be edited without changing the rest of the file; edit it by hand"
    );
    Ok(config.surfaces)
}

/// Check that a per-user service unit, which sees only `unit` and `env_file`, can run this
/// configuration. Fails when the unit could not load the file at all, which would otherwise
/// restart it in a loop; returns a warning naming variables the unit resolves differently or
/// cannot see, as the TypeScript CLI's `unitWarnings` did.
pub fn unit_check(config: &Config, unit: &[(String, String)]) -> Result<Vec<String>> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(&config.path)
        .context("read local services file")?;
    let mut bytes = Vec::new();
    file.take((MAX_BYTES + 1) as u64).read_to_end(&mut bytes)?;
    ensure!(
        crate::lifecycle::hex(&<sha2::Sha256 as sha2::Digest>::digest(&bytes)) == config.digest,
        "{} changed while supertag up read it; run supertag up again",
        config.path.display()
    );
    let base = config
        .path
        .parent()
        .context("configuration directory missing")?;
    let in_unit = |name: &str| {
        unit.iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.clone())
    };
    if let Err(error) = parse(&bytes, base, in_unit) {
        bail!(
            "the service unit for {} cannot load it: {error:#}. A service unit does not inherit this shell's environment; put the variables it needs in env_file or a secret file",
            config.path.display()
        );
    }
    let shell = |name: &str| {
        std::env::var(name)
            .ok()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
    };
    let unit_has = |name: &str| in_unit(name).is_some_and(|value| !value.trim().is_empty());
    let mut unseen = BTreeSet::new();
    // An interpolation the unit resolves from env_file to another value, or from a default.
    for name in &config.shell_variables {
        if !unit_has(name) && config.environment.file_value(name).map(str::to_owned) != shell(name)
        {
            unseen.insert(name.clone());
        }
    }
    // What hosts read when they start: an environment Auth Key and their harness credentials.
    for host in &config.hosts {
        let mut names: Vec<&str> = Vec::new();
        for adapter in &host.harnesses {
            names.extend(adapter.provider_environment()?);
        }
        if let Some(Secret::Environment(secret)) = &host.key {
            names.push(&secret.environment);
        }
        for name in names {
            if shell(name).is_some()
                && !unit_has(name)
                && config.environment.file_value(name).is_none()
            {
                unseen.insert(name.to_owned());
            }
        }
    }
    if unseen.is_empty() {
        return Ok(Vec::new());
    }
    Ok(vec![format!(
        "Warning: the service unit for {} does not inherit this shell's environment, so it cannot see {}. Put them in env_file or a secret file, or unset them in this shell. supertag up does not restart the service for them.",
        config.path.display(),
        unseen.into_iter().collect::<Vec<_>>().join(", ")
    )])
}
/// `supertag config`: the file `up` would run, validated, with `env_file` values and `${VAR}`
/// references resolved and defaults filled in. Secrets stay references; `env_file` values that
/// no field references are never printed.
pub fn render(file: Option<PathBuf>, state: &Path, services_only: bool) -> Result<String> {
    let config = load(file, state)?.with_context(|| {
        format!(
            "no {} exists; supertag init writes one",
            state.join("supertag.yaml").display()
        )
    })?;
    let bytes = std::fs::read(&config.path)?;
    let base = config
        .path
        .parent()
        .context("configuration directory missing")?;
    let (mut value, _) = resolved(&bytes, base, |name| std::env::var(name).ok())?;
    let object = value
        .as_object_mut()
        .context("local configuration must be a map")?;
    object.entry("version").or_insert(1.into());
    object.entry("name").or_insert(instance().into());
    if let Some(services) = object.get_mut("services").and_then(|s| s.as_object_mut()) {
        for service in services.values_mut() {
            let Some(service) = service.as_object_mut() else {
                continue;
            };
            service.entry("restart").or_insert("no".into());
            if service.get("type").and_then(|t| t.as_str()) == Some("control-plane") {
                service
                    .entry("ports")
                    .or_insert(serde_json::json!(["127.0.0.1:3434"]));
            }
        }
    }
    if services_only {
        let names = object
            .get("services")
            .and_then(|services| services.as_object())
            .map(|services| services.keys().map(|name| format!("{name}\n")).collect())
            .unwrap_or_default();
        return Ok(names);
    }
    Ok(format!("# {}\n{}", config.path.display(), to_yaml(&value)))
}
/// Block-style YAML for a JSON value; strings are quoted unless plainly safe.
pub fn to_yaml(value: &serde_json::Value) -> String {
    let mut out = String::new();
    yaml(&mut out, value, 0);
    out
}
fn yaml(out: &mut String, value: &serde_json::Value, indent: usize) {
    use serde_json::Value;
    let pad = " ".repeat(indent);
    match value {
        Value::Object(map) => {
            for (key, value) in map {
                let key = scalar(&Value::String(key.clone()));
                match value {
                    Value::Object(inner) if !inner.is_empty() => {
                        out.push_str(&format!("{pad}{key}:\n"));
                        yaml(out, value, indent + 2);
                    }
                    Value::Array(items) if !items.is_empty() => {
                        out.push_str(&format!("{pad}{key}:\n"));
                        yaml(out, value, indent + 2);
                    }
                    _ => out.push_str(&format!("{pad}{key}: {}\n", scalar(value))),
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                match item {
                    Value::Object(inner) if !inner.is_empty() => {
                        let mut nested = String::new();
                        yaml(&mut nested, item, indent + 2);
                        out.push_str(&format!("{pad}- {}", &nested[indent + 2..]));
                    }
                    Value::Array(inner) if !inner.is_empty() => {
                        out.push_str(&format!("{pad}-\n"));
                        yaml(out, item, indent + 2);
                    }
                    _ => out.push_str(&format!("{pad}- {}\n", scalar(item))),
                }
            }
        }
        scalar_value => out.push_str(&format!("{pad}{}\n", scalar(scalar_value))),
    }
}
fn scalar(value: &serde_json::Value) -> String {
    use serde_json::Value;
    match value {
        Value::String(text)
            if !text.is_empty()
                && text
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_./:@".contains(&b))
                && !matches!(
                    text.as_str(),
                    "true" | "false" | "null" | "yes" | "no" | "on" | "off" | "~"
                )
                && text.parse::<f64>().is_err() =>
        {
            text.clone()
        }
        Value::Object(_) => "{}".into(),
        Value::Array(_) => "[]".into(),
        // JSON strings and numbers are valid YAML flow scalars.
        other => other.to_string(),
    }
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

    // packages/store/paths.test.ts
    #[test]
    fn state_lives_under_home_or_a_configured_directory_from_the_invocation_directory() {
        let invocation = Path::new("/srv/supertag");
        let home = || Some(PathBuf::from("/tmp/supertag-home"));
        assert_eq!(
            resolve_state_directory(None, None, home(), invocation).unwrap(),
            Path::new("/tmp/supertag-home/.supertag")
        );
        assert_eq!(
            resolve_state_directory(None, Some("state".into()), home(), invocation).unwrap(),
            Path::new("/srv/supertag/state")
        );
        assert_eq!(
            resolve_state_directory(None, Some("".into()), home(), invocation).unwrap(),
            Path::new("/tmp/supertag-home/.supertag")
        );
        assert_eq!(
            resolve_state_directory(
                Some("explicit".into()),
                Some("/var/lib/supertag".into()),
                home(),
                invocation
            )
            .unwrap(),
            Path::new("/srv/supertag/explicit")
        );
        assert_eq!(
            resolve_state_directory(None, Some("/var/lib/supertag".into()), None, invocation)
                .unwrap(),
            Path::new("/var/lib/supertag")
        );
        assert!(resolve_state_directory(None, None, None, invocation).is_err());
    }

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
            c.hosts[0].harnesses[0]
                .execution_profile()
                .unwrap()
                .model_ids,
            ["model-a", "model-b"]
        );
        assert!(
            c.hosts[0].harnesses[0]
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
    fn one_host_serves_several_harnesses_with_per_harness_settings() {
        let c = parse(
            br#"services:
  control-plane: {type: control-plane, ports: ["127.0.0.1:0"]}
  shared:
    type: host
    harnesses: [codex, cursor, openai-agents]
    concurrency: 3
    models: {codex: [model-a], cursor: cursor-model}
    allow-unsandboxed-commands: [cursor]
    workspaces: {repo: ./source}
  default: {type: host, adapter: ./adapter}
"#,
            Path::new("/trusted"),
            |_| None,
        )
        .unwrap();
        let shared = c.hosts.iter().find(|h| h.name == "shared").unwrap();
        assert_eq!(shared.concurrency, 3);
        let kinds = shared
            .harnesses
            .iter()
            .map(AdapterOptions::harness_kind)
            .collect::<Vec<_>>();
        use supertag_protocol::v2::HarnessKind;
        assert_eq!(
            kinds,
            [
                HarnessKind::Codex,
                HarnessKind::Cursor,
                HarnessKind::OpenaiAgents
            ]
        );
        let profiles = shared
            .harnesses
            .iter()
            .map(|h| h.execution_profile().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(profiles[0].model_ids, ["model-a"]);
        assert_eq!(profiles[1].model_ids, ["cursor-model"]);
        assert!(profiles[2].model_ids.is_empty());
        assert!(!profiles[0].allow_unsandboxed_commands && profiles[1].allow_unsandboxed_commands);
        // Every harness shares the Host's Workspace mappings.
        assert!(
            shared
                .harnesses
                .iter()
                .all(|h| h.worker_args().iter().any(|v| v == "/trusted/./source"))
        );
        // An unset concurrency runs one Attempt per harness.
        let default = c.hosts.iter().find(|h| h.name == "default").unwrap();
        assert_eq!(default.concurrency, 1);
        assert_eq!(default.harnesses.len(), 1);
    }
    #[test]
    fn mapped_workspaces_deliver_session_branches_unless_patch_or_remote() {
        let c = parse(
            br#"services:
  control-plane: {type: control-plane, ports: ["127.0.0.1:0"]}
  branch: {type: host, adapter: ./adapter, workspaces: {app: ./app}}
  explicit: {type: host, adapter: ./adapter, workspaces: {web: {path: ./web, delivery: branch}}}
  patch: {type: host, adapter: ./adapter, workspaces: {docs: {path: ./docs, delivery: patch}}}
  remote: {type: host, control-plane: "https://plane.example", adapter: ./adapter, workspaces: {api: ./api}}
"#,
            Path::new("/trusted"),
            |_| None,
        )
        .unwrap();
        let branches = |name: &str| {
            c.hosts
                .iter()
                .find(|h| h.name == name)
                .unwrap()
                .session_branches
                .clone()
        };
        assert_eq!(
            branches("branch"),
            [("app".to_owned(), PathBuf::from("/trusted/./app"))].into()
        );
        assert_eq!(
            branches("explicit"),
            [("web".to_owned(), PathBuf::from("/trusted/./web"))].into()
        );
        // The repository is still the host's source; only the import is off.
        assert!(branches("patch").is_empty());
        let patch = c.hosts.iter().find(|h| h.name == "patch").unwrap();
        assert!(
            patch.harnesses[0]
                .worker_args()
                .iter()
                .any(|v| v == "/trusted/./docs")
        );
        // Another Control Plane's host: this file has no operator credential for it.
        assert!(branches("remote").is_empty());
        let valid = br#"services: {h: {type: host, adapter: ./a, control-plane: "https://p.example", workspaces: {app: {path: ./app, delivery: patch}}}}"#;
        assert!(parse(valid, Path::new("/trusted"), |_| None).is_ok());
        for invalid in [
            &br#"services: {h: {type: host, adapter: ./a, control-plane: "https://p.example", workspaces: {app: {path: ./app, delivery: pull-request}}}}"#[..],
            br#"services: {h: {type: host, adapter: ./a, control-plane: "https://p.example", workspaces: {app: {path: ./app, typo: 1}}}}"#,
        ] {
            assert!(parse(invalid, Path::new("/trusted"), |_| None).is_err());
        }
    }
    #[test]
    fn one_host_maps_several_workspaces_each_with_its_own_source() {
        let c = parse(
            br#"services:
  control-plane: {type: control-plane, ports: ["127.0.0.1:0"]}
  shared:
    type: host
    harnesses: [codex, claude-code]
    workspaces: {docs: ./docs, app: ./app, alias: ./app}
"#,
            Path::new("/trusted"),
            |_| None,
        )
        .unwrap();
        for adapter in &c.hosts[0].harnesses {
            let mappings = adapter.workspace_mappings().unwrap();
            let pairs: Vec<_> = mappings
                .iter()
                .map(|mapping| match &mapping.source {
                    supertag_worker_host::WorkspaceSource::Local(path) => {
                        (mapping.workspace_id.as_str(), path.to_str().unwrap())
                    }
                    supertag_worker_host::WorkspaceSource::Gateway => unreachable!(),
                })
                .collect();
            assert_eq!(
                pairs,
                [
                    ("alias", "/trusted/./app"),
                    ("app", "/trusted/./app"),
                    ("docs", "/trusted/./docs")
                ]
            );
            // Each lane receives every mapping, each ID followed by its source.
            let args = adapter.worker_args();
            let ids: Vec<_> = args
                .iter()
                .enumerate()
                .filter(|(_, arg)| *arg == "--workspace-id")
                .map(|(index, _)| (&args[index + 1], &args[index + 2], &args[index + 3]))
                .collect();
            assert_eq!(ids.len(), 3);
            assert!(ids.iter().all(|(_, flag, _)| *flag == "--workspace-source"));
        }
        let workspaces = (0..129)
            .map(|index| format!("w{index}: ./w{index}"))
            .collect::<Vec<_>>()
            .join(", ");
        let many = format!(
            "services:\n  control-plane: {{type: control-plane}}\n  big: {{type: host, harnesses: [codex], workspaces: {{{workspaces}}}}}\n"
        );
        assert!(parse(many.as_bytes(), Path::new("/trusted"), |_| None).is_err());
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
            host.harnesses[0].execution_profile().unwrap().model_ids,
            ["fallback-model", "from-shell"]
        );
        // The process environment wins over env_file, and the first listed model is the default.
        assert!(
            host.harnesses[0]
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
            "services: {host: {type: host, control-plane: https://example.com, harnesses: [codex, codex]}}",
            "services: {host: {type: host, control-plane: https://example.com, harnesses: [codex], concurrency: 0}}",
            "services: {host: {type: host, control-plane: https://example.com, harnesses: [codex], concurrency: 17}}",
            "services: {host: {type: host, control-plane: https://example.com, harnesses: [codex], models: {cursor: [m]}}}",
            "services: {host: {type: host, control-plane: https://example.com, harnesses: [codex, cursor], allow-unsandboxed-commands: [codex]}}",
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

    #[test]
    fn shape_ignores_only_host_concurrency() {
        let shape = |text: &str| {
            parse(text.as_bytes(), Path::new("/trusted"), |_| None)
                .unwrap()
                .shape
        };
        let two = shape(
            "services:\n  cp: {type: control-plane}\n  laptop: {type: host, harnesses: [codex], concurrency: 2}\n",
        );
        let six = shape(
            "services:\n  cp: {type: control-plane}\n  laptop: {type: host, harnesses: [codex], concurrency: 6}\n",
        );
        let unset = shape(
            "services:\n  cp: {type: control-plane}\n  laptop: {type: host, harnesses: [codex]}\n",
        );
        let other = shape(
            "services:\n  cp: {type: control-plane}\n  laptop: {type: host, harnesses: [claude-code], concurrency: 2}\n",
        );
        assert_eq!(two, six);
        assert_eq!(two, unset);
        assert_ne!(two, other);
    }
}
