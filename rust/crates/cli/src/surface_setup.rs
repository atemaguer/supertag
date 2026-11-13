//! `supertag setup surface`, `supertag tag update --add-location|--remove-location`, and
//! `supertag permission-set|context-set activate|deactivate`.
//!
//! Setup matches the TypeScript wizard (`apps/cli/src/setup.ts`): each value comes from its
//! provider environment variable, or else a prompt (masked for secrets); the provider verifies
//! the credentials before anything is saved. The verified account becomes a Control Plane
//! Surface Account named `--name`, its secrets go to the credential vault at
//! `surface/<provider>/<name>`, and its non-secret settings to the `surfaces` section of
//! `supertag.yaml`, which `supertag up` turns into the local Gateway's connectors.

use std::{
    io::{BufRead as _, IsTerminal as _, Read as _, Write as _},
    net::SocketAddr,
    os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _},
    path::PathBuf,
};

use anyhow::{Context, Result, bail, ensure};
use clap::{Args, Subcommand, ValueEnum};
use supertag_gateway::{
    credential_vault::CredentialVault,
    surface_setup::{self, Endpoints, Verified},
};
use supertag_protocol::negotiation::ProtocolChannel;
use supertag_protocol::{
    MAX_MESSAGE_BYTES,
    v2::{
        DeleteSurfaceLocationRequest, GetPolicyResourceRequest, GetSurfaceAccountRequest,
        GetSurfaceLocationRequest, GithubSurfaceIdentity, GithubSurfaceRepository, LarkSurfaceChat,
        LarkSurfaceIdentity, LinearSurfaceIdentity, LinearSurfaceTeam,
        MicrosoftTeamsSurfaceChannel, MicrosoftTeamsSurfaceIdentity, PutSurfaceAccountRequest,
        PutSurfaceLocationRequest, SlackSurfaceChannel, SlackSurfaceIdentity, SurfaceAccount,
        SurfaceAccountIdentity, SurfaceLocation, SurfaceLocationScope,
        policy_catalog_client::PolicyCatalogClient, surface_account_identity,
        surface_location_scope, surface_policy_catalog_client::SurfacePolicyCatalogClient,
    },
};
use tonic::Code;
use uuid::Uuid;

use crate::{
    Connection,
    local::CREDENTIAL_VAULT_ENVIRONMENT,
    local_config::{
        self,
        surfaces::{Location, Provider, Surface},
    },
    request,
};

/// Where the account is recorded: the operator connection, and the services file and state
/// directory (which also holds the file credential vault).
#[derive(Args, Clone)]
pub struct Target {
    /// Gateway URL or saved Gateway name. Defaults to this machine's running local services.
    #[arg(long, value_name = "URL|NAME")]
    gateway: Option<String>,
    /// State directory with supertag.yaml and the file credential vault. Defaults to
    /// SUPERTAG_STATE_DIR, then ~/.supertag.
    #[arg(long)]
    state_directory: Option<PathBuf>,
    /// Services file to record the surface in. Defaults to STATE_DIRECTORY/supertag.yaml.
    #[arg(short = 'f', long = "file")]
    file: Option<PathBuf>,
}

#[derive(Subcommand)]
pub enum SetupCommand {
    /// Connect a Slack, GitHub, Lark, Linear, or Microsoft Teams account.
    Surface {
        #[command(subcommand)]
        provider: ProviderSetup,
    },
}

#[derive(Args)]
pub struct Common {
    /// The Surface Account name, used in supertag.yaml and the credential vault.
    /// Defaults to the provider name.
    #[arg(long)]
    name: Option<String>,
    #[command(flatten)]
    target: Target,
}

#[derive(Args)]
pub struct Listen {
    /// Loopback address of this account's webhook listener on the local Gateway.
    #[arg(long)]
    listen: Option<SocketAddr>,
}

#[derive(Subcommand)]
pub enum ProviderSetup {
    /// Enroll a Slack app for HTTP events: its bot token and signing secret.
    #[command(
        after_help = "Guide: docs/surfaces/slack.md (app manifest: docs/surfaces/slack-app-manifest.yaml)

Optional environment variables:
  SLACK_BOT_TOKEN
  SLACK_SIGNING_SECRET"
    )]
    Slack {
        #[command(flatten)]
        common: Common,
        #[command(flatten)]
        listen: Listen,
        /// Event transport. The Gateway receives Slack events over HTTP.
        #[arg(long, default_value = "http")]
        transport: String,
    },
    /// Enroll a GitHub fine-grained token (default) or, with --auth app, a GitHub App.
    #[command(
        after_help = "With token authentication, --webhook also enrolls a repository webhook secret.
Guide: docs/surfaces/github.md

Optional environment variables:
  SUPERTAG_GITHUB_TOKEN
  GITHUB_APP_ID
  GITHUB_INSTALLATION_ID
  GITHUB_PRIVATE_KEY_PATH
  GITHUB_WEBHOOK_SECRET"
    )]
    Github {
        #[command(flatten)]
        common: Common,
        #[command(flatten)]
        listen: Listen,
        /// How SuperTag authenticates to GitHub: a personal access token or a GitHub App.
        #[arg(long, value_enum, default_value = "token")]
        auth: GithubAuth,
        /// With token authentication, also enroll a repository webhook secret.
        #[arg(long)]
        webhook: bool,
    },
    /// Enroll a Linear workspace API key and webhook signing secret.
    #[command(after_help = "Team locations and webhooks are configured separately.
Guide: docs/surfaces/linear.md

Optional environment variables:
  LINEAR_API_KEY
  LINEAR_WEBHOOK_SECRET")]
    Linear {
        #[command(flatten)]
        common: Common,
        #[command(flatten)]
        listen: Listen,
    },
    /// Enroll a Lark or Feishu app for long-connection events and thread replies.
    #[command(
        after_help = "Create and publish the app separately. Guide: docs/surfaces/lark.md

Optional environment variables:
  LARK_APP_ID
  LARK_APP_SECRET
  LARK_TENANT_KEY"
    )]
    Lark {
        #[command(flatten)]
        common: Common,
        /// The app's platform: Lark, or Feishu in mainland China.
        #[arg(long, value_enum, default_value = "lark")]
        domain: LarkDomain,
    },
    /// Enroll the Microsoft Entra application and tenant of a Teams bot.
    #[command(
        after_help = "Create and install the Teams app separately. Guide: docs/surfaces/teams.md

Optional environment variables:
  TEAMS_APP_ID
  TEAMS_APP_SECRET
  TEAMS_TENANT_ID
  TEAMS_TENANT_NAME"
    )]
    Teams {
        #[command(flatten)]
        common: Common,
        #[command(flatten)]
        listen: Listen,
    },
}

#[derive(Clone, Copy, ValueEnum)]
pub enum GithubAuth {
    Token,
    App,
}

#[derive(Clone, Copy, ValueEnum)]
pub enum LarkDomain {
    Lark,
    Feishu,
}

/// A location's provider scope. A flag a provider does not use is refused.
#[derive(Args, Clone, Default)]
pub struct ScopeArgs {
    /// Surface Account name from `supertag setup surface`. Needed when several accounts of the
    /// provider exist.
    #[arg(long)]
    account: Option<String>,
    /// Slack or Teams channel ID.
    #[arg(long)]
    channel_id: Option<String>,
    /// Linear team ID or Microsoft Teams team ID.
    #[arg(long)]
    team_id: Option<String>,
    /// Lark chat ID.
    #[arg(long)]
    chat_id: Option<String>,
    /// GitHub repository as OWNER/NAME.
    #[arg(long = "repo")]
    repository: Option<String>,
    /// GitHub numeric repository ID.
    #[arg(long = "repo-id")]
    repository_id: Option<u64>,
}

impl ScopeArgs {
    fn given(&self) -> bool {
        self.channel_id.is_some()
            || self.team_id.is_some()
            || self.chat_id.is_some()
            || self.repository.is_some()
            || self.repository_id.is_some()
    }
    fn location(&self, tag: &str, allowed_users: Vec<String>) -> Location {
        Location {
            tag: tag.to_owned(),
            allowed_users,
            channel_id: self.channel_id.clone(),
            team_id: self.team_id.clone(),
            chat_id: self.chat_id.clone(),
            repository: self.repository.clone(),
            repository_id: self.repository_id,
        }
    }
}

#[derive(Args)]
pub struct UpdateTag {
    tag: String,
    /// Admit work for the Tag at a location of a connected surface account.
    #[arg(
        long,
        value_enum,
        value_name = "PROVIDER",
        required_unless_present = "remove_location",
        conflicts_with = "remove_location"
    )]
    add_location: Option<Provider>,
    /// Stop admitting work for the Tag at the location.
    #[arg(long, value_enum, value_name = "PROVIDER")]
    remove_location: Option<Provider>,
    #[command(flatten)]
    scope: ScopeArgs,
    /// Provider user ID allowed to ask the Tag for work there (numeric on GitHub). Repeat for more users.
    #[arg(long = "allowed-user")]
    allowed_users: Vec<String>,
    #[command(flatten)]
    target: Target,
}

/// The kind of set `permission-set activate` and `context-set activate` apply.
#[derive(Clone, Copy)]
pub enum SetKind {
    PermissionSet,
    ContextSet,
}

#[derive(Args)]
pub struct ActivationArgs {
    /// The set's ID or name.
    set: String,
    /// The Tag whose surface location the set applies to.
    #[arg(long)]
    tag: String,
    /// The surface the location belongs to.
    #[arg(long, value_enum)]
    provider: Provider,
    /// Location flags; defaults to the account's location in supertag.yaml.
    #[command(flatten)]
    scope: ScopeArgs,
    #[command(flatten)]
    target: Target,
}

struct Local {
    state: PathBuf,
    config: Option<local_config::Config>,
    target: Target,
}

impl Local {
    fn load(target: Target) -> Result<Self> {
        let state = local_config::state_directory(target.state_directory.clone())?;
        let config = local_config::load(target.file.clone(), &state)?;
        Ok(Self {
            state,
            config,
            target,
        })
    }

    async fn policy(
        &self,
    ) -> Result<(
        SurfacePolicyCatalogClient<ProtocolChannel>,
        ProtocolChannel,
        String,
    )> {
        let local = self.target.gateway.is_none() && crate::ROOT_GATEWAY.get().is_none();
        let (channel, token) = crate::connect_operator(Connection {
            gateway: self.target.gateway.clone(),
            state_directory: local.then(|| self.state.clone()),
        })
        .await?;
        Ok((
            SurfacePolicyCatalogClient::new(channel.clone())
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_MESSAGE_BYTES),
            channel,
            token,
        ))
    }

    /// The vault the Gateway that serves these accounts reads.
    ///
    /// With a local Control Plane, that is the vault `supertag up` gives its Gateway: the
    /// selection from this shell or else `env_file`, falling back to this state directory's
    /// file. Without one, the Gateway runs elsewhere and cannot read this machine's file, so
    /// only a shared HashiCorp Vault is accepted.
    fn vault(&self) -> Result<CredentialVault> {
        let Some(config) = self.services_file() else {
            ensure!(
                std::env::var("SUPERTAG_CREDENTIAL_VAULT")
                    .is_ok_and(|selected| selected.trim() == "vault"),
                "{} has no control-plane service, so the Gateway that serves this account cannot read this machine's credential file. Run setup where the Control Plane runs, or select the HashiCorp Vault that Gateway reads with SUPERTAG_CREDENTIAL_VAULT=vault, VAULT_ADDR, and VAULT_TOKEN.",
                self.services_path().display()
            );
            return CredentialVault::from_environment(|key| {
                CREDENTIAL_VAULT_ENVIRONMENT
                    .contains(&key)
                    .then(|| std::env::var(key).ok())
                    .flatten()
            });
        };
        let state = self.state.to_string_lossy().into_owned();
        CredentialVault::from_environment(|key| {
            if key == "SUPERTAG_STATE_DIR" {
                Some(state.clone())
            } else if CREDENTIAL_VAULT_ENVIRONMENT.contains(&key) {
                config
                    .environment
                    .variable(key)
                    .and_then(|value| value.into_string().ok())
            } else {
                None
            }
        })
    }

    fn services_path(&self) -> PathBuf {
        self.target
            .file
            .clone()
            .unwrap_or_else(|| self.state.join("supertag.yaml"))
    }

    /// The services file that can hold surfaces: one with a control-plane service.
    fn services_file(&self) -> Option<&local_config::Config> {
        self.config.as_ref().filter(|config| config.plane.is_some())
    }

    fn required_file(&self) -> Result<&local_config::Config> {
        self.services_file().with_context(|| {
            format!(
                "{} has no control-plane service; set up surfaces where the local Control Plane runs",
                self.services_path().display()
            )
        })
    }

    /// The Surface Account selected by `--account`, or the provider's only one.
    fn account(&self, provider: Provider, selector: Option<&str>) -> Result<(String, Surface)> {
        let config = self.required_file()?;
        let accounts: Vec<_> = config
            .surfaces
            .iter()
            .filter(|(name, surface)| {
                surface.provider == provider && selector.is_none_or(|s| s == name.as_str())
            })
            .collect();
        match accounts.as_slice() {
            [(name, surface)] => Ok(((*name).clone(), (*surface).clone())),
            [] => match selector {
                None => bail!(
                    "No connected {0} account exists. Run supertag setup surface {0}.",
                    provider.name()
                ),
                Some(selector) => bail!(
                    "No connected {} account matches --account {selector:?}",
                    provider.name()
                ),
            },
            many => bail!(
                "Multiple connected {} accounts exist; select one with --account NAME:\n{}",
                provider.name(),
                many.iter()
                    .map(|(name, surface)| format!(
                        "  {name}\t{}",
                        surface.display_name.as_deref().unwrap_or(&surface.account)
                    ))
                    .collect::<Vec<_>>()
                    .join("\n")
            ),
        }
    }

    /// Prepares `surfaces.<name>` = `entry` in the services file without writing it yet.
    fn edit(&self, name: &str, entry: Option<&Surface>) -> Result<Edit> {
        let config = self.required_file()?;
        let before = std::fs::read(&config.path).context("read services file")?;
        let text = std::str::from_utf8(&before).context("services file must be UTF-8")?;
        let after = set_entry(text, name, entry)?;
        let base = config.path.parent().context("services file directory")?;
        let surfaces = local_config::check_surface_edit(&before, after.as_bytes(), base)?;
        let mut expected = config.surfaces.clone();
        match entry {
            Some(entry) => expected.insert(name.to_owned(), entry.clone()),
            None => expected.remove(name),
        };
        ensure!(
            surfaces == expected,
            "the surfaces section could not be edited safely; edit {} by hand",
            config.path.display()
        );
        Ok(Edit {
            path: config.path.clone(),
            before,
            after,
        })
    }
}

/// A validated services-file change, written only after the Control Plane accepted it.
struct Edit {
    path: PathBuf,
    before: Vec<u8>,
    after: String,
}

impl Edit {
    fn write(self) -> Result<()> {
        let current = std::fs::read(&self.path).context("read services file")?;
        ensure!(
            current == self.before,
            "{} changed while it was being updated; run the command again",
            self.path.display()
        );
        let mode = std::fs::metadata(&self.path)?.permissions().mode() & 0o777;
        let directory = self.path.parent().context("services file directory")?;
        let mut file = tempfile::NamedTempFile::new_in(directory)?;
        file.as_file()
            .set_permissions(std::fs::Permissions::from_mode(mode))?;
        file.write_all(self.after.as_bytes())?;
        file.as_file().sync_all()?;
        file.persist(&self.path).context("replace services file")?;
        Ok(())
    }
}

fn indentation(line: &str) -> usize {
    line.len() - line.trim_start_matches(' ').len()
}

fn content(line: &str) -> bool {
    let trimmed = line.trim();
    !trimmed.is_empty() && !trimmed.starts_with('#')
}

/// Replaces, adds, or removes one entry of the top-level block-style `surfaces` map, leaving
/// every other line as written.
fn set_entry(text: &str, name: &str, entry: Option<&Surface>) -> Result<String> {
    ensure!(
        !text
            .lines()
            .find(|line| content(line))
            .is_some_and(|line| line.trim_start().starts_with('{')),
        "supertag.yaml must use block style for its surfaces to be edited; edit it by hand"
    );
    let mut lines: Vec<String> = text.lines().map(str::to_owned).collect();
    let rendered = |indent: usize| -> Result<Vec<String>> {
        let Some(entry) = entry else {
            return Ok(Vec::new());
        };
        let mut value = serde_json::to_value(entry)?;
        escape_interpolation(&mut value);
        let yaml = local_config::to_yaml(&serde_json::json!({ name: value }));
        Ok(yaml
            .lines()
            .map(|line| format!("{}{line}", " ".repeat(indent)))
            .collect())
    };
    let header = lines
        .iter()
        .position(|line| line == "surfaces" || line.starts_with("surfaces:"));
    let Some(header) = header else {
        if entry.is_some() {
            while lines.last().is_some_and(|line| line.trim().is_empty()) {
                lines.pop();
            }
            lines.push(String::new());
            lines.push("surfaces:".into());
            lines.extend(rendered(2)?);
        }
        return Ok(lines.join("\n") + "\n");
    };
    let rest = lines[header]["surfaces:".len().min(lines[header].len())..].trim();
    if rest == "{}" {
        lines[header] = "surfaces:".into();
    } else {
        ensure!(
            rest.is_empty() || rest.starts_with('#'),
            "the surfaces section of supertag.yaml must use block style to be edited; edit it by hand"
        );
    }
    let end = (header + 1..lines.len())
        .find(|&i| content(&lines[i]) && indentation(&lines[i]) == 0)
        .unwrap_or(lines.len());
    let child = (header + 1..end)
        .find(|&i| content(&lines[i]))
        .map(|i| indentation(&lines[i]))
        .unwrap_or(2);
    ensure!(
        child > 0,
        "the surfaces section of supertag.yaml must be indented"
    );
    let key = format!("{}{name}:", " ".repeat(child));
    let start = (header + 1..end).find(|&i| {
        lines[i] == key
            || lines[i]
                .strip_prefix(&key)
                .is_some_and(|r| r.starts_with(" #"))
    });
    let stop = |from: usize| {
        let mut stop = (from..end)
            .find(|&i| content(&lines[i]) && indentation(&lines[i]) <= child)
            .unwrap_or(end);
        while stop > from && !content(&lines[stop - 1]) {
            stop -= 1;
        }
        stop
    };
    match start {
        Some(start) => {
            let finish = stop(start + 1);
            lines.splice(start..finish, rendered(child)?);
        }
        None => {
            let finish = stop(header + 1);
            let finish = if (header + 1..end).any(|i| content(&lines[i])) {
                (header + 1..end)
                    .rev()
                    .find(|&i| content(&lines[i]))
                    .map_or(finish, |i| i + 1)
            } else {
                header + 1
            };
            lines.splice(finish..finish, rendered(child)?);
        }
    }
    Ok(lines.join("\n") + "\n")
}

/// `supertag.yaml` interpolates `$`; a literal one is written `$$`.
fn escape_interpolation(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::String(text) => *text = text.replace('$', "$$"),
        serde_json::Value::Array(items) => items.iter_mut().for_each(escape_interpolation),
        serde_json::Value::Object(map) => map.values_mut().for_each(escape_interpolation),
        _ => {}
    }
}

/// Values come from the environment, then from a prompt on standard input. A terminal hides
/// secret input; piped input supplies one value per line.
struct Prompter {
    terminal: bool,
}

impl Prompter {
    fn new() -> Self {
        Self {
            terminal: std::io::stdin().is_terminal(),
        }
    }

    fn environment(variable: &str) -> Option<String> {
        std::env::var(variable)
            .ok()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
    }

    fn line(&self, label: &str, secret: bool) -> Result<Option<String>> {
        crate::terminal::write_stderr(&format!("{label}: "));
        let echo = if secret && self.terminal {
            hide_input()
        } else {
            None
        };
        let mut line = String::new();
        let read = std::io::stdin().lock().take(64 * 1024).read_line(&mut line);
        if let Some(saved) = echo {
            restore_input(saved);
            errln!("");
        }
        Ok((read.context("read standard input")? > 0).then(|| line.trim().to_owned()))
    }

    fn value(&self, variable: &str, label: &str, secret: bool) -> Result<String> {
        if let Some(value) = Self::environment(variable) {
            return Ok(value);
        }
        loop {
            match self.line(label, secret)? {
                Some(value) if !value.is_empty() => return Ok(value),
                Some(_) if self.terminal => errln!("A value is required"),
                _ => bail!("{label} is required: set {variable} or enter it when prompted"),
            }
        }
    }

    fn optional(&self, variable: &str, label: &str) -> Result<Option<String>> {
        if let Some(value) = Self::environment(variable) {
            return Ok(Some(value));
        }
        Ok(self.line(label, false)?.filter(|value| !value.is_empty()))
    }
}

pub(crate) fn hide_input() -> Option<libc::termios> {
    // SAFETY: tcgetattr and tcsetattr only read and write the termios value for fd 0.
    unsafe {
        let mut saved = std::mem::zeroed::<libc::termios>();
        if libc::tcgetattr(0, &mut saved) != 0 {
            return None;
        }
        let mut hidden = saved;
        hidden.c_lflag &= !libc::ECHO;
        (libc::tcsetattr(0, libc::TCSANOW, &hidden) == 0).then_some(saved)
    }
}

pub(crate) fn restore_input(saved: libc::termios) {
    // SAFETY: restores the attributes read by hide_input.
    unsafe {
        libc::tcsetattr(0, libc::TCSANOW, &saved);
    }
}

fn endpoints() -> Result<Endpoints> {
    #[allow(unused_mut)]
    let mut endpoints = Endpoints::default();
    #[cfg(feature = "test-fixtures")]
    {
        let loopback = |variable: &str| -> Result<Option<surface_setup::Url>> {
            let Ok(value) = std::env::var(variable) else {
                return Ok(None);
            };
            let url: surface_setup::Url = value.parse()?;
            ensure!(
                url.scheme() == "http"
                    && url
                        .host_str()
                        .and_then(|host| host.parse::<std::net::IpAddr>().ok())
                        .is_some_and(|ip| ip.is_loopback()),
                "{variable} must be a loopback HTTP URL"
            );
            Ok(Some(url))
        };
        if let Some(url) = loopback("SUPERTAG_TEST_SLACK_API_URL")? {
            endpoints.slack = url;
        }
        if let Some(url) = loopback("SUPERTAG_TEST_GITHUB_API_URL")? {
            endpoints.github = url;
        }
        if let Some(url) = loopback("SUPERTAG_TEST_LINEAR_API_URL")? {
            endpoints.linear = url;
        }
        if let Some(url) = loopback("SUPERTAG_TEST_LARK_ORIGIN")? {
            endpoints.lark = Some(url);
        }
        if let Some(url) = loopback("SUPERTAG_TEST_MICROSOFT_TEAMS_ORIGIN")? {
            endpoints.microsoft_login = url;
        }
    }
    Ok(endpoints)
}

fn read_private_key(path: &str) -> Result<String> {
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .context("open GitHub App private key")?;
    ensure!(
        file.metadata()?.is_file(),
        "GitHub App private key must be a regular file"
    );
    let mut key = String::new();
    file.take(65_537)
        .read_to_string(&mut key)
        .context("read GitHub App private key")?;
    ensure!(key.len() <= 65_536, "GitHub App private key is too large");
    Ok(key)
}

fn default_listen(provider: Provider) -> Option<&'static str> {
    match provider {
        Provider::Slack => Some("127.0.0.1:3480"),
        Provider::Github => Some("127.0.0.1:3481"),
        Provider::Linear => Some("127.0.0.1:3482"),
        Provider::Teams => Some("127.0.0.1:3483"),
        Provider::Lark => None,
    }
}

fn identity(verified: &Verified) -> Result<SurfaceAccountIdentity> {
    use surface_account_identity::Provider as Identity;
    let setting = |key: &str| verified.configuration.get(key).cloned().unwrap_or_default();
    let account = verified.external_account_id.clone();
    Ok(SurfaceAccountIdentity {
        provider: Some(match verified.provider {
            "slack" => Identity::Slack(SlackSurfaceIdentity { team_id: account }),
            "github" => Identity::Github(GithubSurfaceIdentity {
                external_account_id: account,
            }),
            "linear" => Identity::Linear(LinearSurfaceIdentity {
                workspace_id: account,
            }),
            "lark" => Identity::Lark(LarkSurfaceIdentity {
                feishu: setting("domain") == "feishu",
                app_id: account,
                tenant_key: setting("tenant-key"),
            }),
            "teams" => Identity::MicrosoftTeams(MicrosoftTeamsSurfaceIdentity {
                app_id: setting("app-id"),
                tenant_id: account,
            }),
            other => bail!("unsupported surface provider {other}"),
        }),
    })
}

fn not_found(status: &tonic::Status) -> bool {
    status.code() == Code::NotFound
}

pub async fn setup(command: SetupCommand) -> Result<()> {
    let SetupCommand::Surface { provider } = command;
    let prompter = Prompter::new();
    let endpoints = endpoints()?;
    let (common, listen, provider, kind) = match provider {
        ProviderSetup::Slack {
            common,
            listen,
            transport,
        } => (
            common,
            listen.listen,
            Provider::Slack,
            Kind::Slack { transport },
        ),
        ProviderSetup::Github {
            common,
            listen,
            auth,
            webhook,
        } => (
            common,
            listen.listen,
            Provider::Github,
            Kind::Github { auth, webhook },
        ),
        ProviderSetup::Linear { common, listen } => {
            (common, listen.listen, Provider::Linear, Kind::Linear)
        }
        ProviderSetup::Lark { common, domain } => (
            common,
            None,
            Provider::Lark,
            Kind::Lark {
                feishu: matches!(domain, LarkDomain::Feishu),
            },
        ),
        ProviderSetup::Teams { common, listen } => {
            (common, listen.listen, Provider::Teams, Kind::Teams)
        }
    };
    let name = common
        .name
        .clone()
        .unwrap_or_else(|| provider.name().to_owned());
    ensure!(
        (1..=63).contains(&name.len())
            && name.as_bytes()[0].is_ascii_alphanumeric()
            && name
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_'),
        "--name must use 1-63 lowercase letters, numbers, hyphens, or underscores"
    );
    if let Some(listen) = listen {
        ensure!(
            listen.ip().is_loopback() && listen.port() != 0,
            "--listen must be a loopback address with a fixed port"
        );
    }
    let context = Local::load(common.target.clone())?;
    let prior = context
        .services_file()
        .and_then(|config| config.surfaces.get(&name))
        .cloned();
    if let Some(prior) = &prior {
        ensure!(
            prior.provider == provider,
            "surface {name} is a {} account; choose another --name",
            prior.provider.name()
        );
    }

    // Choose where the secrets go before asking for them.
    let vault = context.vault()?;
    let verified = verify(&kind, &prompter, &endpoints).await?;
    finish(context, vault, name, provider, listen, prior, verified).await
}

/// The verification arguments of each provider.
enum Kind {
    Slack { transport: String },
    Github { auth: GithubAuth, webhook: bool },
    Linear,
    Lark { feishu: bool },
    Teams,
}

async fn verify(kind: &Kind, prompter: &Prompter, endpoints: &Endpoints) -> Result<Verified> {
    match kind {
        Kind::Slack { transport } => {
            ensure!(
                transport == "http",
                "--transport must be http: the Gateway receives Slack events over HTTP"
            );
            outln!(
                "Slack requires an installed app. Guide: docs/surfaces/slack.md\nSlack app manifest: docs/surfaces/slack-app-manifest.yaml"
            );
            let bot_token = prompter.value("SLACK_BOT_TOKEN", "Slack bot token (xoxb-…)", true)?;
            let signing_secret =
                prompter.value("SLACK_SIGNING_SECRET", "Slack signing secret", true)?;
            surface_setup::verify_slack(endpoints, &bot_token, &signing_secret).await
        }
        Kind::Github { auth, webhook } => match auth {
            GithubAuth::Token => {
                outln!(
                    "GitHub setup enrolls credentials only. Tag locations and webhooks are configured separately. See docs/surfaces/github.md."
                );
                let token = prompter.value(
                    "SUPERTAG_GITHUB_TOKEN",
                    "GitHub fine-grained personal access token",
                    true,
                )?;
                let secret = webhook
                    .then(|| {
                        prompter.value(
                            "GITHUB_WEBHOOK_SECRET",
                            "GitHub repository webhook secret",
                            true,
                        )
                    })
                    .transpose()?;
                surface_setup::verify_github_token(endpoints, &token, secret.as_deref()).await
            }
            GithubAuth::App => {
                let app_id = prompter.value("GITHUB_APP_ID", "GitHub App ID", false)?;
                let installation_id = prompter.value(
                    "GITHUB_INSTALLATION_ID",
                    "GitHub App installation ID",
                    false,
                )?;
                let path = prompter.value(
                    "GITHUB_PRIVATE_KEY_PATH",
                    "Path to the GitHub App private key (.pem)",
                    false,
                )?;
                let key = read_private_key(&path)?;
                let secret =
                    prompter.value("GITHUB_WEBHOOK_SECRET", "GitHub App webhook secret", true)?;
                surface_setup::verify_github_app(
                    endpoints,
                    &app_id,
                    &installation_id,
                    &key,
                    &secret,
                )
                .await
            }
        },
        Kind::Linear => {
            outln!(
                "Linear setup enrolls credentials only. Tag locations and webhooks are configured separately. See docs/surfaces/linear.md."
            );
            let api_key = prompter.value("LINEAR_API_KEY", "Linear personal API key", true)?;
            let secret = prompter.value(
                "LINEAR_WEBHOOK_SECRET",
                "Linear webhook signing secret",
                true,
            )?;
            surface_setup::verify_linear(endpoints, &api_key, &secret).await
        }
        Kind::Lark { feishu } => {
            outln!(
                "Lark uses an app with bot messaging and im.message.receive_v1 over a long connection. See docs/surfaces/lark.md."
            );
            let app_id = prompter.value("LARK_APP_ID", "Lark App ID", false)?;
            let secret = prompter.value("LARK_APP_SECRET", "Lark App Secret", true)?;
            let tenant_key = prompter.value("LARK_TENANT_KEY", "Lark tenant key", false)?;
            surface_setup::verify_lark(endpoints, *feishu, &app_id, &secret, &tenant_key).await
        }
        Kind::Teams => {
            outln!(
                "Teams requires an installed bot app with the Gateway messaging endpoint. See docs/surfaces/teams.md."
            );
            let app_id =
                prompter.value("TEAMS_APP_ID", "Microsoft application (client) ID", false)?;
            let secret = prompter.value("TEAMS_APP_SECRET", "Microsoft client secret", true)?;
            let tenant_id = prompter.value("TEAMS_TENANT_ID", "Microsoft tenant ID", false)?;
            let tenant_name =
                prompter.optional("TEAMS_TENANT_NAME", "Tenant display name (optional)")?;
            surface_setup::verify_teams(
                endpoints,
                &app_id,
                &secret,
                &tenant_id,
                tenant_name.as_deref(),
            )
            .await
        }
    }
}

async fn finish(
    context: Local,
    vault: CredentialVault,
    name: String,
    provider: Provider,
    listen: Option<SocketAddr>,
    prior: Option<Surface>,
    verified: Verified,
) -> Result<()> {
    let identity = identity(&verified)?;
    let setting = |key: &str| verified.configuration.get(key).cloned();
    let entry = Surface {
        provider,
        account: verified.external_account_id.clone(),
        display_name: Some(verified.display_name.clone()),
        listen: listen
            .map(|listen| listen.to_string())
            .or_else(|| prior.as_ref().and_then(|prior| prior.listen.clone()))
            .or_else(|| default_listen(provider).map(str::to_owned)),
        auth: setting("auth"),
        app_id: setting("app-id"),
        installation_id: setting("installation-id"),
        domain: setting("domain"),
        tenant_key: setting("tenant-key"),
        bot_open_id: setting("bot-open-id"),
        bot_id: setting("bot-id"),
        bot_user_id: setting("bot-user-id"),
        location: prior.as_ref().and_then(|prior| prior.location.clone()),
    };
    // Check the services file change before anything is saved.
    let edit = context
        .services_file()
        .map(|_| context.edit(&name, Some(&entry)))
        .transpose()?;

    let (mut policy, _, token) = context.policy().await?;
    let existing = match policy
        .get_surface_account(request(
            GetSurfaceAccountRequest {
                account_id: name.clone(),
            },
            &token,
        )?)
        .await
    {
        Ok(account) => Some(account.into_inner()),
        Err(status) if not_found(&status) => None,
        Err(status) => return Err(status.into()),
    };
    if let Some(existing) = &existing {
        ensure!(
            existing.identity.as_ref() == Some(&identity),
            "Surface Account {name} is connected to a different {} account; choose another --name",
            provider.name()
        );
    }
    let account = policy
        .put_surface_account(request(
            PutSurfaceAccountRequest {
                operation_id: Uuid::new_v4().to_string(),
                expected_revision: existing.as_ref().map(|account| account.revision),
                account: Some(SurfaceAccount {
                    account_id: name.clone(),
                    identity: Some(identity),
                    enabled: true,
                    revision: 0,
                }),
            },
            &token,
        )?)
        .await?
        .into_inner();
    let credential = entry.credential_id(&name);
    vault.store(&credential, &verified.secrets).await?;
    let recorded = match edit {
        Some(edit) => {
            let path = edit.path.clone();
            edit.write()?;
            Some(path)
        }
        None => None,
    };
    outln!(
        "Connected {} account {} ({}).",
        provider.name(),
        verified.display_name,
        verified.external_account_id
    );
    match recorded {
        Some(path) => outln!(
            "Saved Surface Account {} (revision {}) in {} with credentials in {credential}.",
            account.account_id,
            account.revision,
            path.display()
        ),
        None => outln!(
            "Saved Surface Account {} with credentials in Vault at {credential}. No local Control Plane is configured, so configure its Gateway with SUPERTAG_CREDENTIAL_VAULT=vault and SUPERTAG_*_CREDENTIAL_ID={credential}.",
            account.account_id
        ),
    }
    Ok(())
}

fn location_scope(provider: Provider, location: &Location) -> SurfaceLocationScope {
    use surface_location_scope::Provider as Scope;
    let text = |value: &Option<String>| value.clone().unwrap_or_default();
    SurfaceLocationScope {
        provider: Some(match provider {
            Provider::Slack => Scope::Slack(SlackSurfaceChannel {
                channel_id: text(&location.channel_id),
            }),
            Provider::Github => Scope::Github(GithubSurfaceRepository {
                repository_id: location.repository_id.unwrap_or_default(),
            }),
            Provider::Linear => Scope::Linear(LinearSurfaceTeam {
                team_id: text(&location.team_id),
            }),
            Provider::Lark => Scope::Lark(LarkSurfaceChat {
                chat_id: text(&location.chat_id),
            }),
            Provider::Teams => Scope::MicrosoftTeams(MicrosoftTeamsSurfaceChannel {
                team_id: text(&location.team_id),
                channel_id: text(&location.channel_id),
            }),
        }),
    }
}

async fn location(
    policy: &mut SurfacePolicyCatalogClient<ProtocolChannel>,
    token: &str,
    id: &str,
) -> Result<Option<SurfaceLocation>> {
    match policy
        .get_surface_location(request(
            GetSurfaceLocationRequest {
                location_id: id.to_owned(),
            },
            token,
        )?)
        .await
    {
        Ok(location) => Ok(Some(location.into_inner())),
        Err(status) if not_found(&status) => Ok(None),
        Err(status) => Err(status.into()),
    }
}

pub async fn update_tag(args: UpdateTag) -> Result<()> {
    let context = Local::load(args.target.clone())?;
    let adding = args.add_location.is_some();
    let provider = args
        .add_location
        .or(args.remove_location)
        .context("pass --add-location or --remove-location")?;
    let (name, mut surface) = context.account(provider, args.scope.account.as_deref())?;
    let display = surface
        .display_name
        .clone()
        .unwrap_or_else(|| surface.account.clone());
    let location = if args.scope.given() || adding {
        args.scope.location(&args.tag, args.allowed_users.clone())
    } else {
        surface
            .location
            .clone()
            .filter(|location| location.tag == args.tag)
            .with_context(|| {
                format!(
                    "{} is not configured on {} for {display}",
                    args.tag,
                    provider.name()
                )
            })?
    };
    let id = surface.location_id(&name, &location)?;
    let place = location.describe(provider);
    let (mut policy, _, token) = context.policy().await?;
    let current = self::location(&mut policy, &token, &id).await?;
    if adding {
        if let Some(prior) = &surface.location {
            ensure!(
                surface.location_id(&name, prior)? == id,
                "surface {name} already serves {} at {} {}; remove it first: supertag tag update {} --remove-location {} --account {name}",
                prior.tag,
                provider.name(),
                prior.describe(provider),
                prior.tag,
                provider.name()
            );
        }
        surface.location = Some(location.clone());
        let edit = context.edit(&name, Some(&surface))?;
        let mut value = current.clone().unwrap_or_else(|| SurfaceLocation {
            location_id: id.clone(),
            account_id: name.clone(),
            connector_account_id: String::new(),
            tag_id: args.tag.clone(),
            scope: Some(location_scope(provider, &location)),
            enabled: true,
            permission_set_ids: Vec::new(),
            context_set_ids: Vec::new(),
            revision: 0,
        });
        value.connector_account_id = surface.connector_alias(&name, &location)?;
        if current.as_ref().is_none_or(|current| !current.enabled) {
            value.enabled = true;
            policy
                .put_surface_location(request(
                    PutSurfaceLocationRequest {
                        operation_id: Uuid::new_v4().to_string(),
                        expected_revision: current.as_ref().map(|current| current.revision),
                        location: Some(value),
                    },
                    &token,
                )?)
                .await?;
        }
        edit.write()?;
        outln!(
            "Added {} to {} {place} on {display}.",
            args.tag,
            provider.name()
        );
    } else {
        let recorded = surface
            .location
            .as_ref()
            .map(|prior| surface.location_id(&name, prior))
            .transpose()?
            .is_some_and(|prior| prior == id);
        ensure!(
            current.is_some() || recorded,
            "{} is not configured on {} {place} for {display}",
            args.tag,
            provider.name()
        );
        let edit = recorded
            .then(|| {
                surface.location = None;
                context.edit(&name, Some(&surface))
            })
            .transpose()?;
        // supertag.yaml first: if the Control Plane delete then fails, no connector serves the
        // location and rerunning the command deletes it.
        if let Some(edit) = edit {
            edit.write()?;
        }
        if let Some(current) = current {
            policy
                .delete_surface_location(request(
                    DeleteSurfaceLocationRequest {
                        operation_id: Uuid::new_v4().to_string(),
                        location_id: id,
                        expected_revision: current.revision,
                    },
                    &token,
                )?)
                .await?;
        }
        outln!(
            "Removed {} from {} {place} on {display}.",
            args.tag,
            provider.name()
        );
    }
    Ok(())
}

pub async fn activation(activate: bool, kind: SetKind, args: ActivationArgs) -> Result<()> {
    let context = Local::load(args.target.clone())?;
    let (name, surface) = context.account(args.provider, args.scope.account.as_deref())?;
    let location = if args.scope.given() {
        args.scope.location(&args.tag, Vec::new())
    } else {
        surface
            .location
            .clone()
            .filter(|location| location.tag == args.tag)
            .with_context(|| {
                format!(
                    "{} has no location on {} account {name}; pass its location flags or add one with supertag tag update {} --add-location {}",
                    args.tag,
                    args.provider.name(),
                    args.tag,
                    args.provider.name()
                )
            })?
    };
    let id = surface.location_id(&name, &location)?;
    let place = location.describe(args.provider);
    let (mut policy, channel, token) = context.policy().await?;
    let mut catalog = PolicyCatalogClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES);
    let reference = GetPolicyResourceRequest {
        reference: args.set.clone(),
    };
    let set_id = match kind {
        SetKind::PermissionSet => {
            catalog
                .get_permission_set(request(reference, &token)?)
                .await?
                .into_inner()
                .set_id
        }
        SetKind::ContextSet => {
            catalog
                .get_context_set(request(reference, &token)?)
                .await?
                .into_inner()
                .set_id
        }
    };
    let mut current = self::location(&mut policy, &token, &id)
        .await?
        .with_context(|| {
            format!(
                "{} is not configured on {} {place}; add it with supertag tag update {} --add-location {}",
                args.tag,
                args.provider.name(),
                args.tag,
                args.provider.name()
            )
        })?;
    let ids = match kind {
        SetKind::PermissionSet => &mut current.permission_set_ids,
        SetKind::ContextSet => &mut current.context_set_ids,
    };
    let changed = if activate {
        !ids.contains(&set_id) && {
            ids.push(set_id);
            true
        }
    } else {
        let before = ids.len();
        ids.retain(|id| id != &set_id);
        ids.len() != before
    };
    if changed {
        let revision = current.revision;
        policy
            .put_surface_location(request(
                PutSurfaceLocationRequest {
                    operation_id: Uuid::new_v4().to_string(),
                    expected_revision: Some(revision),
                    location: Some(current),
                },
                &token,
            )?)
            .await?;
    }
    outln!(
        "{} {} for {} {place}.",
        if activate { "Activated" } else { "Deactivated" },
        args.set,
        args.provider.name()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn slack(account: &str) -> Surface {
        Surface {
            provider: Provider::Slack,
            account: account.into(),
            display_name: Some("Cost $5 ${HOME}".into()),
            listen: Some("127.0.0.1:3480".into()),
            auth: None,
            app_id: None,
            installation_id: None,
            domain: None,
            tenant_key: None,
            bot_open_id: None,
            bot_id: None,
            bot_user_id: None,
            location: None,
        }
    }

    fn surfaces(text: &str) -> std::collections::BTreeMap<String, Surface> {
        local_config::check_surface_edit(text.as_bytes(), text.as_bytes(), Path::new("/")).unwrap()
    }

    #[test]
    fn edits_only_the_named_entry_and_keeps_comments_and_other_entries() {
        let original = "# my services\nservices:\n  plane: {type: control-plane}  # keep\n\nsurfaces:\n    # team accounts\n    other:\n        provider: slack\n        account: T999\n\n# trailing comment\n";
        let added = set_entry(original, "acme", Some(&slack("T123"))).unwrap();
        assert!(
            added.starts_with("# my services\nservices:\n  plane: {type: control-plane}  # keep\n")
        );
        assert!(added.contains("    # team accounts\n    other:\n"));
        assert!(added.ends_with("# trailing comment\n"));
        let parsed =
            local_config::check_surface_edit(original.as_bytes(), added.as_bytes(), Path::new("/"))
                .unwrap();
        assert_eq!(parsed["acme"], slack("T123"));
        assert_eq!(parsed["other"].account, "T999");

        let mut located = slack("T123");
        located.location = Some(Location {
            tag: "builder".into(),
            allowed_users: vec!["U1".into()],
            channel_id: Some("C1".into()),
            team_id: None,
            chat_id: None,
            repository: None,
            repository_id: None,
        });
        let replaced = set_entry(&added, "acme", Some(&located)).unwrap();
        assert_eq!(surfaces(&replaced)["acme"], located);
        assert_eq!(surfaces(&replaced)["other"].account, "T999");
        let removed = set_entry(&replaced, "acme", None).unwrap();
        assert!(!surfaces(&removed).contains_key("acme"));
        assert_eq!(removed, original);
    }

    #[test]
    fn appends_a_section_and_refuses_flow_style() {
        let original = "services: {plane: {type: control-plane}}";
        let added = set_entry(original, "acme", Some(&slack("T1"))).unwrap();
        assert_eq!(surfaces(&added)["acme"], slack("T1"));
        let empty = set_entry(
            "services: {plane: {type: control-plane}}\nsurfaces: {}\n",
            "acme",
            Some(&slack("T1")),
        )
        .unwrap();
        assert_eq!(surfaces(&empty)["acme"], slack("T1"));
        assert!(
            set_entry(
                "surfaces: {a: {provider: slack}}\n",
                "acme",
                Some(&slack("T1"))
            )
            .is_err()
        );
    }
}
