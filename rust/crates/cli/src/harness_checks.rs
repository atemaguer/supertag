//! Harness sign-in probes (`supertag sign-in`, `supertag init`) and the startup checks a configured
//! host service runs before it takes work: the installed Codex CLI, and each harness's configured
//! models against its provider's model listing.
mod cursor;
mod models;
mod probe;
mod sign_in;

use std::{path::PathBuf, time::Duration};

use anyhow::{Context, Result, bail};
use clap::{Args, ValueEnum};
use supertag_protocol::v2::HarnessKind;

pub use models::ModelCheck;
use probe::Variables;

const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(30);
const CLI_TIMEOUT: Duration = Duration::from_secs(15);
const LISTING_TIMEOUT: Duration = Duration::from_secs(20);
const CURSOR_CLI_TIMEOUT: Duration = Duration::from_secs(5);

/// The harnesses a person signs in to on a Worker Host.
#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
pub enum Harness {
    ClaudeCode,
    Codex,
    Cursor,
    #[value(name = "opencode")]
    Opencode,
}

impl Harness {
    pub fn name(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude-code",
            Self::Codex => "codex",
            Self::Cursor => "cursor",
            Self::Opencode => "opencode",
        }
    }

    fn kind(self) -> HarnessKind {
        match self {
            Self::ClaudeCode => HarnessKind::ClaudeCode,
            Self::Codex => HarnessKind::Codex,
            Self::Cursor => HarnessKind::Cursor,
            Self::Opencode => HarnessKind::Opencode,
        }
    }

    fn of(kind: HarnessKind) -> Option<Self> {
        match kind {
            HarnessKind::ClaudeCode => Some(Self::ClaudeCode),
            HarnessKind::Codex => Some(Self::Codex),
            HarnessKind::Cursor => Some(Self::Cursor),
            HarnessKind::Opencode => Some(Self::Opencode),
            _ => None,
        }
    }
}

/// Exact sign-in steps and credential locations for a Worker Host harness. Never includes values.
pub fn instructions(harness: Harness) -> &'static str {
    match harness {
        Harness::ClaudeCode => {
            "Claude Code: run claude and use /login, or set ANTHROPIC_API_KEY in the host's env_file (default ~/.supertag/.env). A background host also inherits it from the shell; a service unit does not. Tasks read the secure sign-in store selected by CLAUDE_SECURESTORAGE_CONFIG_DIR, otherwise ~/.claude (macOS Keychain on macOS; .credentials.json on Linux). Task sessions and settings stay in a separate temporary directory."
        }
        Harness::Codex => {
            "Codex: run codex -c 'cli_auth_credentials_store=\"file\"' login, or set CODEX_API_KEY or OPENAI_API_KEY in the host's env_file (default ~/.supertag/.env). On macOS, a Keychain-only login is not copied to Task Attempts. A background host also inherits environment credentials from the shell; a service unit does not. Tasks use CODEX_API_KEY first, then copy $CODEX_HOME/auth.json (default ~/.codex/auth.json), then fall back to OPENAI_API_KEY if that file is missing. The file-backed sign-in check only verifies credential structure; it cannot verify account access without rotating a refresh token."
        }
        Harness::Cursor => {
            "Cursor: generate an API key at https://cursor.com/dashboard/api and set CURSOR_API_KEY in the host's env_file (default ~/.supertag/.env). The Cursor app and cursor-agent logins do not authenticate the Cursor SDK runner."
        }
        Harness::Opencode => {
            "OpenCode: set the API key for the selected provider/model in the Worker Host environment (for example OPENAI_API_KEY for openai, or ANTHROPIC_API_KEY for anthropic). Tasks use an isolated OpenCode home and do not read your usual OpenCode auth.json."
        }
    }
}

/// Where a Worker Host's supervisor gets its environment.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Supervisor {
    /// This process: the shell for `supertag sign-in` or `supertag init` with a background
    /// supervisor, and the supervisor itself for its startup checks.
    ThisProcess,
    /// A per-user service unit (`restart: unless-stopped`), which carries only
    /// `UNIT_VARIABLES` from this shell; every credential comes from env_file.
    ServiceUnit,
}

impl Supervisor {
    pub fn of(config: &crate::local_config::Config) -> Self {
        if config.service_unit {
            Self::ServiceUnit
        } else {
            Self::ThisProcess
        }
    }
}

/// The variables a Worker Host lane would give `harness`: the supervisor's identity and locale,
/// and the harness's credentials from the supervisor's environment or the configured env_file.
pub fn worker_variables(
    harness: Harness,
    model: Option<&str>,
    environment: &crate::local_config::Environment,
    supervisor: Supervisor,
) -> Result<Variables> {
    let credentials = supertag_worker_host::provider_environment_for(harness.kind(), model)?;
    Ok(match supervisor {
        Supervisor::ThisProcess => probe::variables(
            |name| std::env::var_os(name),
            credentials.iter().copied(),
            |name| environment.variable(name),
        ),
        Supervisor::ServiceUnit => probe::variables(
            |name| {
                crate::local_config::UNIT_VARIABLES
                    .contains(&name)
                    .then(|| std::env::var_os(name))
                    .flatten()
            },
            credentials.iter().copied(),
            |name| environment.unit_variable(name),
        ),
    })
}

/// The Cursor bridge this installation runs Cursor Tasks with.
fn cursor_bridge() -> Result<(PathBuf, PathBuf)> {
    crate::harness::cursor_bridge()
}

async fn cursor_listing(
    models: &[String],
    key: &str,
    variables: &Variables,
    stop: impl std::future::Future<Output = ()>,
) -> cursor::Listing {
    match cursor_bridge() {
        Ok((runtime, entry)) => {
            cursor::list_models(&runtime, &entry, models, key, variables, stop).await
        }
        Err(error) => cursor::Listing::Failed(format!(
            "Cursor model listing failed: {error:#}. Check CURSOR_API_KEY in the host service environment."
        )),
    }
}

/// Run a harness's sign-in probe with the Worker Host's credentials. OpenCode needs a model.
pub async fn probe_sign_in(
    harness: Harness,
    model: Option<&str>,
    variables: &Variables,
) -> SignInResult {
    let result = sign_in_once(harness, model, variables).await;
    // Ctrl-C stopped the probe; its process group and temporary directory are gone now.
    probe::exit_if_interrupted();
    result
}

async fn sign_in_once(
    harness: Harness,
    model: Option<&str>,
    variables: &Variables,
) -> SignInResult {
    let deadline = || probe::interactive_deadline(SIGN_IN_TIMEOUT);
    let signed_in = match harness {
        Harness::Codex => sign_in::codex(variables, model, deadline()).await,
        Harness::ClaudeCode => sign_in::claude_code(variables, model, deadline()).await,
        Harness::Opencode => match model {
            Some(model) => sign_in::opencode(variables, model, deadline()).await,
            None => {
                return SignInResult {
                    signed_in: false,
                    detail: Some(
                        "OpenCode needs a model, as provider/model, to check sign-in.".into(),
                    ),
                };
            }
        },
        Harness::Cursor => {
            let models: Vec<String> = model.map(str::to_owned).into_iter().collect();
            let checked = cursor::check_sign_in(
                variables,
                async |key| {
                    cursor_listing(
                        &models,
                        key,
                        variables,
                        probe::interactive_deadline(LISTING_TIMEOUT),
                    )
                    .await
                },
                || probe::interactive_deadline(CURSOR_CLI_TIMEOUT),
            )
            .await;
            return SignInResult {
                signed_in: checked.status == cursor::Status::SignedIn,
                detail: Some(checked.message),
            };
        }
    };
    SignInResult {
        signed_in,
        detail: None,
    }
}

pub struct SignInResult {
    pub signed_in: bool,
    /// A fixed explanation, never native output.
    pub detail: Option<String>,
}

#[derive(Args)]
pub struct SignInArgs {
    /// The harness to check: claude-code, codex, cursor or opencode.
    harness: Harness,
    /// Model to check with. OpenCode requires one, as provider/model.
    #[arg(long)]
    model: Option<String>,
    /// Local state directory (default: ~/.supertag or SUPERTAG_STATE_DIR).
    #[arg(long)]
    state_directory: Option<PathBuf>,
    /// Service configuration whose env_file supplies credentials; otherwise
    /// STATE_DIRECTORY/supertag.yaml when present.
    #[arg(short = 'f', long = "file")]
    file: Option<PathBuf>,
}

/// `supertag sign-in HARNESS`: check whether this machine's Worker Host credentials for a harness
/// work, and say how to sign in when they do not.
pub async fn sign_in(args: SignInArgs) -> Result<()> {
    let state = crate::local_config::state_directory(args.state_directory)?;
    let (environment, supervisor) = match crate::local_config::load(args.file, &state)? {
        Some(config) => (config.environment.clone(), Supervisor::of(&config)),
        None => (
            crate::local_config::default_environment(&state)?,
            Supervisor::ThisProcess,
        ),
    };
    if args.harness == Harness::Opencode && args.model.is_none() {
        bail!(
            "OpenCode needs a model to check sign-in. Run supertag sign-in opencode --model provider/model."
        );
    }
    let variables = worker_variables(
        args.harness,
        args.model.as_deref(),
        &environment,
        supervisor,
    )?;
    outln!(
        "Checking {} sign-in with the Worker Host credentials...",
        args.harness.name()
    );
    let result = probe_sign_in(args.harness, args.model.as_deref(), &variables).await;
    if let Some(detail) = &result.detail {
        outln!("  {detail}");
    }
    if result.signed_in {
        outln!("{}: signed in", args.harness.name());
        return Ok(());
    }
    bail!(
        "{}: not signed in (the credential check did not succeed). Check your sign-in, model access, and network connection.\n{}",
        args.harness.name(),
        instructions(args.harness)
    )
}

/// What a host service runs: its name and, for each configured harness, its models.
pub struct HostHarnesses<'a> {
    pub name: &'a str,
    pub harnesses: Vec<(HarnessKind, Vec<String>, Option<String>)>,
}

/// Startup checks for one host service, before it registers or takes work. A Codex CLI that
/// cannot run Tasks, or a configured model its provider does not offer, stops the host; checks
/// that could not decide return notes for its log.
pub async fn check_host(
    host: &HostHarnesses<'_>,
    environment: &crate::local_config::Environment,
) -> Result<Vec<String>> {
    let mut failures = Vec::new();
    for (kind, _, model) in &host.harnesses {
        if *kind == HarnessKind::Codex {
            let variables = worker_variables(
                Harness::Codex,
                model.as_deref(),
                environment,
                Supervisor::ThisProcess,
            )?;
            if let Some(failure) =
                models::check_cli(&models::CODEX, &variables, tokio::time::sleep(CLI_TIMEOUT)).await
            {
                failures.push(failure);
            }
        }
    }
    if !failures.is_empty() {
        bail!(
            "Host service {} can't run its harnesses:\n  {}\nInstall or upgrade them, or remove them from harnesses in supertag.yaml, then run supertag up again.",
            host.name,
            failures.join("\n  ")
        );
    }
    // The listings run together, so a host's checks take as long as its slowest listing.
    let listings = host
        .harnesses
        .iter()
        .filter_map(|(kind, configured, model)| {
            let harness = Harness::of(*kind)?;
            (!configured.is_empty()).then_some((harness, configured, model))
        });
    let checks = futures_util::future::join_all(listings.map(
        async |(harness, configured, model)| -> Result<ModelCheck> {
        let variables =
            worker_variables(harness, model.as_deref(), environment, Supervisor::ThisProcess)?;
        let checked = match harness {
            Harness::Codex => {
                // The listing uses the CLI's own sign-in, never an API key, so it cannot spend.
                let variables = variables
                    .into_iter()
                    .filter(|(name, _)| name != "CODEX_API_KEY" && name != "OPENAI_API_KEY")
                    .collect();
                models::check_codex_models(configured, &variables, tokio::time::sleep(LISTING_TIMEOUT))
                    .await
            }
            Harness::ClaudeCode => {
                models::check_claude_models(
                    configured,
                    &variables,
                    tokio::time::sleep(LISTING_TIMEOUT),
                )
                .await
            }
            Harness::Cursor => match probe::text(&variables, "CURSOR_API_KEY") {
                None => ModelCheck::Failed(
                    "Cursor model listing failed: CURSOR_API_KEY is not set. Check CURSOR_API_KEY in the host service environment."
                        .into(),
                ),
                Some(key) => match cursor_listing(
                    configured,
                    &key,
                    &variables,
                    tokio::time::sleep(LISTING_TIMEOUT),
                )
                .await
                {
                    cursor::Listing::Available(available) => {
                        let unknown: Vec<_> = configured
                            .iter()
                            .filter(|model| !available.contains(model))
                            .map(String::as_str)
                            .collect();
                        if unknown.is_empty() {
                            ModelCheck::Ok
                        } else {
                            ModelCheck::Failed(format!(
                                "Unknown Cursor model {}; available: {}",
                                unknown.join(", "),
                                available.join(", ")
                            ))
                        }
                    }
                    cursor::Listing::Failed(message) => ModelCheck::Failed(message),
                },
            },
            Harness::Opencode => ModelCheck::Skipped(
                "OpenCode offers no cheap model check; its models are not checked at startup."
                    .into(),
            ),
        };
        Ok(checked)
    }))
    .await;
    let mut notes = Vec::new();
    for checked in checks {
        match checked? {
            ModelCheck::Ok => {}
            ModelCheck::Failed(message) => failures.push(message),
            ModelCheck::Skipped(note) => notes.push(note),
        }
    }
    if !failures.is_empty() {
        bail!(
            "Host service models are not available: {} Change models in supertag.yaml and run supertag up again.",
            failures.join(" ")
        );
    }
    Ok(notes)
}

/// The harnesses and models of a configured host, for `check_host`.
pub fn host_harnesses(host: &crate::local_config::Host) -> Result<HostHarnesses<'_>> {
    let mut harnesses = Vec::new();
    for adapter in &host.harnesses {
        let profile = adapter
            .execution_profile()
            .context("invalid host harness settings")?;
        harnesses.push((
            adapter.harness_kind(),
            profile.model_ids,
            adapter.provider_model(),
        ));
    }
    Ok(HostHarnesses {
        name: &host.name,
        harnesses,
    })
}
