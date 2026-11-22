//! `supertag deploy`: deploy the Control Plane and its optional Gateway from one configuration
//! file, the same way from a laptop and from CI.
//!
//! This file is the part that is the same on every deployment target. It reads
//! `supertag-deploy.yaml`, validates it with the rules `supertag check deployment` applies,
//! creates the secrets that are missing (and never replaces one), issues the Control Plane's
//! certificate, rolls the image out, waits for health, runs `supertag verify deployment`'s
//! checks, and prints what to run next. Where the services run and where their secrets are kept
//! are behind the two interfaces in `deploy/target.rs`; `deploy/modal.rs` is the one
//! implementation.
mod config;
mod deployed;
mod image;
mod modal;
mod preflight;
mod target;
mod tls;

use std::{
    collections::BTreeSet,
    io::{IsTerminal as _, Read as _},
    os::unix::fs::DirBuilderExt as _,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use anyhow::{Context, Result, bail, ensure};
use clap::{Args, Subcommand};
use serde_json::json;

use self::{
    config::{Config, TlsMode},
    target::{Endpoint, Rollout, SecretStore, Target, Values},
};
use crate::{deployment, network, profiles};

// Reserved for later, so nothing else takes the names: `supertag deploy logs` and
// `supertag deploy down`.

/// The deployment's secrets, by the names the secret store is given. Each is written whole, so
/// each holds only variables that change together.
const OPERATOR: &str = "operator-token";
const GATEWAY: &str = "gateway-credential";
const DATABASE: &str = "database-url";
const CREDENTIALS: &str = "credentials";
const TLS: &str = "tls";
/// A secret set with `supertag deploy secret set NAME`: this prefix, then the variable's name in
/// lowercase with hyphens.
const SET_PREFIX: &str = "env-";

const OPERATOR_TOKEN: &str = "SUPERTAG_OPERATOR_TOKEN";
const DATABASE_URL: &str = "SUPERTAG_DATABASE_URL";
const GATEWAY_CREDENTIALS: [&str; 2] = [
    "SUPERTAG_BOOTSTRAP_GATEWAY_CREDENTIAL",
    "SUPERTAG_GATEWAY_CREDENTIAL",
];
const TLS_VARIABLES: [&str; 3] = [
    "SUPERTAG_TLS_CERT_PEM",
    "SUPERTAG_TLS_KEY_PEM",
    "SUPERTAG_SERVER_CA_PEM",
];
/// Stands in for a value the secret store already holds, which validation cannot read.
const STORED_DATABASE: &str = "postgresql://held-by-the-secret-store.invalid/supertag";
const STORED: &str = "held-by-the-secret-store";
const MAX_SECRET_BYTES: u64 = 1024 * 1024;

#[derive(Args)]
#[command(
    args_conflicts_with_subcommands = true,
    after_help = "Reads supertag-deploy.yaml from the current directory; `supertag deploy init TARGET` writes one. The file holds no secret. The first deploy generates the admin Operator Token and the Gateway's credential straight into the target's secret store, issues the Control Plane's certificate, and writes the public CA certificate beside the configuration. It asks for SUPERTAG_DATABASE_URL, or reads it from the environment, when the store does not hold it yet. Later deploys change no secret. In CI, give the target's own credentials (Modal: MODAL_TOKEN_ID and MODAL_TOKEN_SECRET) and optionally SUPERTAG_OPERATOR_TOKEN, without which only the checks that need no credential run."
)]
pub struct DeployArgs {
    #[command(subcommand)]
    command: Option<DeployCommand>,
    #[command(flatten)]
    file: ConfigFile,
    /// Fail instead of prompting when a required secret is not stored yet.
    #[arg(long)]
    non_interactive: bool,
    /// Issue a new certificate authority and certificate (or publish the provided files
    /// again), replacing the stored ones. Every client and Worker Host then needs the new CA
    /// file.
    #[arg(long)]
    renew_certificate: bool,
    /// Print what a deploy would do and stop: the image by digest, the endpoint, each secret
    /// and the certificate it would create or keep, and what would roll out. Creates nothing.
    #[arg(long)]
    dry_run: bool,
    /// How long to wait for the deployment to become healthy.
    #[arg(long, default_value_t = 300, value_parser = clap::value_parser!(u64).range(1..=3600))]
    wait_seconds: u64,
}

#[derive(Args)]
struct ConfigFile {
    /// The deployment configuration (default: supertag-deploy.yaml in the current directory).
    #[arg(long, global = true, value_name = "FILE")]
    config: Option<PathBuf>,
}

#[derive(Subcommand)]
enum DeployCommand {
    /// Write a starting supertag-deploy.yaml for a deployment target.
    Init {
        /// The deployment target: modal.
        target: String,
    },
    /// Check that this machine can deploy, without changing anything.
    ///
    /// Checks that the target's tooling is present and signed in to the account the
    /// configuration names, that the configuration is valid, and which secrets the target
    /// holds: for each missing one, whether deploy would generate it or how to supply it.
    /// Every deploy runs the same checks first. Prints one line per problem and fails when
    /// there is one.
    Check {
        /// Treat a secret deploy would ask for at a terminal as missing.
        #[arg(long)]
        non_interactive: bool,
    },
    /// Report what the target runs now: whether it is deployed, its endpoint and health, the
    /// running SuperTag release, the names of its secrets, and whether the committed CA file
    /// belongs to the deployed certificate.
    ///
    /// The target is asked each time; this machine's files are only compared with it. Prints
    /// JSON, and fails only when the target cannot be asked.
    Status,
    /// Set, list, and remove the deployment's secrets in the target's secret store.
    Secret {
        #[command(subcommand)]
        command: SecretCommand,
    },
}

#[derive(Subcommand)]
enum SecretCommand {
    /// Store one secret the services read from their environment, from standard input.
    ///
    /// For example SUPERTAG_DATABASE_URL, or a connector's token. The value comes from standard
    /// input (a masked prompt in a terminal) and is never printed or accepted as an argument.
    /// Run `supertag deploy` afterwards: the services read secrets only when they start.
    Set {
        /// The environment variable's name.
        name: String,
    },
    /// Print the names of the deployment's secrets, never a value.
    List,
    /// Remove one secret.
    ///
    /// Run `supertag deploy` afterwards. It generates the Operator Token or the Gateway's
    /// credential again when that was the one removed, which is how to rotate either.
    Unset {
        /// The environment variable's name.
        name: String,
    },
    /// Upload the surface, Workspace, and Volume credentials stored on this machine.
    ///
    /// For services that read credentials from their environment (credential-vault: env).
    /// Store them first with `supertag setup surface`, `supertag workspace credential add`, or
    /// `supertag volume credential set` while SUPERTAG_CREDENTIAL_FILE names the file. Push
    /// replaces what was uploaded before with the file's contents and prints credential IDs,
    /// never values. Run `supertag deploy` afterwards.
    Push {
        /// The credential file (default: SUPERTAG_CREDENTIAL_FILE, else this deployment's
        /// private file on this machine).
        #[arg(long)]
        credential_file: Option<PathBuf>,
    },
}

pub async fn run(args: DeployArgs) -> Result<()> {
    let path = args
        .file
        .config
        .unwrap_or_else(|| PathBuf::from(config::FILE));
    match args.command {
        Some(DeployCommand::Init { target }) => init(&path, &target),
        Some(DeployCommand::Secret { command }) => secret(&path, command),
        Some(DeployCommand::Check { non_interactive }) => {
            let (config, directory, target) = load(&path)?;
            let checked = preflight::run(
                &config,
                &directory,
                target.as_ref(),
                !non_interactive && std::io::stdin().is_terminal(),
                false,
                preflight::Scope::Check,
            )
            .await;
            out!("{}", checked.text);
            checked.problems()?;
            outln!("This machine can deploy. Nothing was changed.");
            Ok(())
        }
        Some(DeployCommand::Status) => {
            let (config, directory, target) = load(&path)?;
            deployed::run(&config, &directory, target.as_ref()).await
        }
        None => {
            deploy(
                &path,
                !args.non_interactive && std::io::stdin().is_terminal(),
                args.renew_certificate,
                args.dry_run,
                Duration::from_secs(args.wait_seconds),
            )
            .await
        }
    }
}

fn init(path: &Path, target: &str) -> Result<()> {
    let text = config::scaffold(target)?;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .with_context(|| {
            format!(
                "create {}; init never replaces an existing file",
                path.display()
            )
        })?;
    std::io::Write::write_all(&mut file, text.as_bytes())?;
    outln!(
        "Wrote {}. It holds no secret: review it, commit it, then run `supertag deploy`.",
        path.display()
    );
    Ok(())
}

/// The configuration, the directory its relative paths resolve against, and its target.
fn load(path: &Path) -> Result<(Config, PathBuf, Box<dyn Target>)> {
    let config = Config::read(path)?;
    let directory = std::path::absolute(path)
        .context("resolve the deployment configuration's path")?
        .parent()
        .context("the deployment configuration has no directory")?
        .to_owned();
    let target: Box<dyn Target> = match config.target.as_str() {
        "modal" => Box::new(modal::Modal::new(config.modal.as_ref())?),
        other => bail!("supertag deploy has no target named {other}; the targets are: modal"),
    };
    Ok((config, directory, target))
}

/// The store that holds the deployment's secrets: the target's own. A target without one needs
/// another store, and none is implemented yet.
fn store(target: &dyn Target) -> Result<&dyn SecretStore> {
    target.secrets().with_context(|| {
        format!(
            "the {} target keeps no secrets, and supertag deploy has no other secret store yet",
            target.platform().name()
        )
    })
}

/// Where the services read credentials: what the configuration says, else a file on the
/// target's durable disk, else the secret store.
fn credential_vault(config: &Config, target: &dyn Target) -> String {
    config.credential_vault.clone().unwrap_or_else(|| {
        if target.capabilities().durable_disk {
            "file".to_owned()
        } else {
            "env".to_owned()
        }
    })
}

/// This deployment's private directory on this machine: the Operator Token of whoever ran the
/// first deploy, and the credentials `secret push` uploads. Never in the repository.
fn private_directory(target: &dyn Target) -> Result<PathBuf> {
    let directory = profiles::deployment_directory(&target.name())?;
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&directory)
        .with_context(|| format!("create {}", directory.display()))?;
    Ok(directory)
}

/// The secret a variable is stored in, or why `secret set` does not store it.
fn secret_of(name: &str) -> Result<String> {
    ensure!(
        !name.is_empty()
            && name.len() <= 40
            && name.bytes().enumerate().all(|(index, byte)| {
                byte.is_ascii_uppercase() || index > 0 && (byte.is_ascii_digit() || byte == b'_')
            }),
        "{name} is not an environment variable's name: use uppercase letters, digits, and underscores, at most 40"
    );
    let holders = deployment::CREDENTIAL_HOLDERS;
    Ok(match name {
        OPERATOR_TOKEN => OPERATOR.to_owned(),
        DATABASE_URL => DATABASE.to_owned(),
        _ if GATEWAY_CREDENTIALS.contains(&name) => GATEWAY.to_owned(),
        _ if TLS_VARIABLES.contains(&name) || name.ends_with("_PEM") => bail!(
            "{name} is the Control Plane's TLS material, which deploy publishes; renew it with `supertag deploy --renew-certificate`"
        ),
        _ if holders.iter().any(|(_, holder)| holder.is_variable(name)) => bail!(
            "{name} holds the credentials `supertag deploy secret push` uploads; store a credential on this machine and push"
        ),
        _ if matches!(name, "SUPERTAG_STATE_DIR" | "SUPERTAG_CREDENTIAL_VAULT")
            || name.starts_with("SUPERTAG_MODAL_")
            || deployment::TLS_KEYS.contains(&name) =>
        {
            bail!(
                "{name} is a setting deploy derives from the deployment configuration, not a secret"
            )
        }
        _ => format!(
            "{SET_PREFIX}{}",
            name.to_ascii_lowercase().replace('_', "-")
        ),
    })
}

/// The variable a stored secret's name stands for, for `secret list`.
fn variable_of(secret: &str) -> Option<(String, &'static str)> {
    Some(match secret {
        OPERATOR => (OPERATOR_TOKEN.to_owned(), "generated by the first deploy"),
        GATEWAY => (
            "SUPERTAG_GATEWAY_CREDENTIAL".to_owned(),
            "generated by the first deploy",
        ),
        DATABASE => (DATABASE_URL.to_owned(), "set"),
        CREDENTIALS => (
            "credentials".to_owned(),
            "uploaded by supertag deploy secret push",
        ),
        TLS => (
            "certificate".to_owned(),
            "the Control Plane's certificate and key, published by deploy",
        ),
        _ => (
            secret
                .strip_prefix(SET_PREFIX)?
                .to_ascii_uppercase()
                .replace('-', "_"),
            "set",
        ),
    })
}

fn redeploy() -> &'static str {
    "The running services still have what they started with: run `supertag deploy` to restart them."
}

fn secret(path: &Path, command: SecretCommand) -> Result<()> {
    let (config, _, target) = load(path)?;
    target.prepare()?;
    let store = store(target.as_ref())?;
    match command {
        SecretCommand::List => {
            let mut secrets: Vec<_> = store
                .list()?
                .iter()
                .filter_map(|name| variable_of(name))
                .map(|(name, source)| json!({"name": name, "source": source}))
                .collect();
            secrets.sort_by_key(|secret| secret["name"].as_str().map(str::to_owned));
            crate::terminal::print_json(&json!({"store": store.describe(), "secrets": secrets}))?;
        }
        SecretCommand::Set { name } => {
            let secret = secret_of(&name)?;
            ensure!(
                secret != GATEWAY,
                "{name} is generated by deploy and never leaves the secret store; to replace it, run `supertag deploy secret unset {name}` and then `supertag deploy`"
            );
            let value = read_secret(&name)?;
            match name.as_str() {
                DATABASE_URL => ensure!(
                    deployment::postgres_url(&value),
                    "{name} must be a PostgreSQL URL; hosted deployments require PostgreSQL"
                ),
                OPERATOR_TOKEN => ensure!(
                    deployment::strong_token(&value)
                        && !["stop_", "stak_", "stcr_"]
                            .iter()
                            .any(|prefix| value.starts_with(prefix)),
                    "{name} must be at least 32 characters of letters, digits, and -._~+/, and must not look like an issued credential"
                ),
                _ => {}
            }
            store.write(
                &secret,
                &Values::from([(name.clone(), value.clone())]),
                true,
            )?;
            if name == OPERATOR_TOKEN {
                // This machine keeps the token it just set, as after a first deploy.
                save_operator_token(target.as_ref(), &value)?;
            }
            outln!("Stored {name} in {}. {}", store.describe(), redeploy());
        }
        SecretCommand::Unset { name } => {
            let secret = secret_of(&name)?;
            store.delete(&secret)?;
            outln!("Removed {name} from {}. {}", store.describe(), redeploy());
        }
        SecretCommand::Push { credential_file } => {
            let backend = credential_vault(&config, target.as_ref());
            ensure!(
                backend == "env",
                "this deployment sets credential-vault: {backend}, so its services do not read credentials from their environment; only credential-vault: env is pushed"
            );
            let source = match credential_file
                .or_else(|| std::env::var_os("SUPERTAG_CREDENTIAL_FILE").map(PathBuf::from))
            {
                Some(path) => std::path::absolute(path)?,
                None => credential_file_of(target.as_ref())?,
            };
            ensure!(
                source.is_file(),
                "no credentials are stored at {source}. Store one first: export SUPERTAG_CREDENTIAL_FILE={source}, then run `supertag setup surface`, `supertag workspace credential add`, or `supertag volume credential set` against the deployment",
                source = source.display()
            );
            let (variables, credentials) = deployment::credential_documents(&source)?;
            store.write(CREDENTIALS, &variables, true)?;
            crate::terminal::print_json(&json!({
                "result": "pushed",
                "store": store.describe(),
                "credential_file": source,
                "credentials": credentials,
                "next": redeploy(),
            }))?;
        }
    }
    Ok(())
}

/// One secret from standard input: a masked line in a terminal, otherwise everything up to the
/// end of input, without its final line break.
fn read_secret(name: &str) -> Result<String> {
    let value = if std::io::stdin().is_terminal() {
        deployment::prompt_masked(name)?
    } else {
        let mut input = String::new();
        std::io::stdin()
            .take(MAX_SECRET_BYTES + 1)
            .read_to_string(&mut input)
            .with_context(|| format!("read {name} from standard input"))?;
        ensure!(
            input.len() as u64 <= MAX_SECRET_BYTES,
            "{name} is too large"
        );
        input.trim_end_matches(['\r', '\n']).to_owned()
    };
    ensure!(!value.trim().is_empty(), "{name} must not be empty");
    ensure!(!value.contains('\0'), "{name} must be text");
    Ok(value)
}

fn operator_file(target: &dyn Target) -> Result<PathBuf> {
    Ok(private_directory(target)?.join("operator.env"))
}

fn credential_file_of(target: &dyn Target) -> Result<PathBuf> {
    Ok(private_directory(target)?.join("credentials.json"))
}

fn save_operator_token(target: &dyn Target, token: &str) -> Result<PathBuf> {
    let path = operator_file(target)?;
    let text = deployment::serialize(&deployment::Environment::from([(
        OPERATOR_TOKEN.to_owned(),
        token.to_owned(),
    )]))?;
    tls::write_private(&path, &text)?;
    Ok(path)
}

/// Where a verification's operator token came from.
enum TokenSource {
    Environment,
    ThisMachine,
    SecretStore,
}

/// The admin Operator Token for verification: the environment's (as CI supplies it), else the
/// one this machine kept from the first deploy, else the secret store's when it returns values.
fn operator_token(
    target: &dyn Target,
    store: &dyn SecretStore,
) -> Result<Option<(String, TokenSource)>> {
    let filled = |token: String| Some(token.trim().to_owned()).filter(|token| !token.is_empty());
    if let Some(token) = std::env::var(OPERATOR_TOKEN).ok().and_then(filled) {
        return Ok(Some((token, TokenSource::Environment)));
    }
    let file = operator_file(target)?;
    if file.exists() {
        let token = deployment::read_private(&file)?.remove(OPERATOR_TOKEN);
        if let Some(token) = token.and_then(filled) {
            return Ok(Some((token, TokenSource::ThisMachine)));
        }
    }
    Ok(store
        .read(OPERATOR)?
        .and_then(|mut values| values.remove(OPERATOR_TOKEN))
        .and_then(filled)
        .map(|token| (token, TokenSource::SecretStore)))
}

/// What the services run with, split into the secrets to keep in the store and the settings
/// that are not secret. Built and validated by `supertag setup deployment`'s own rules.
struct Plan {
    /// Each secret's name and variables, with newly generated values for the ones deploy
    /// generates; only those the store lacks are written.
    secrets: Vec<(String, Values)>,
    settings: Values,
}

/// What to do about a secret only the user knows when neither the store nor the environment
/// has it.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Missing {
    /// Ask for it at a masked prompt.
    Ask,
    /// Fail, naming how to supply it.
    Refuse,
    /// Carry on with a stand-in: for a check that creates nothing.
    Assume,
}

fn plan(
    config: &Config,
    target: &dyn Target,
    stored: &BTreeSet<String>,
    missing: Missing,
) -> Result<Plan> {
    let platform = target.platform();
    let backend = credential_vault(config, target);
    let environment = |key: &str| {
        std::env::var(key)
            .ok()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
    };
    let vault_token = format!("{SET_PREFIX}vault-token");
    let supplied = |key: &str| match key {
        "SUPERTAG_CREDENTIAL_VAULT" => Some(backend.clone()),
        // A stored secret is never replaced, so only its presence matters here.
        DATABASE_URL if stored.contains(DATABASE) => Some(STORED_DATABASE.to_owned()),
        "VAULT_TOKEN" if stored.contains(&vault_token) => Some(STORED.to_owned()),
        // What only you know may come from the environment on the deploy that first needs it.
        DATABASE_URL | "VAULT_TOKEN" => environment(key),
        // Always generated: an Operator Token in the environment is for verification, and
        // may belong to another Control Plane.
        OPERATOR_TOKEN | "SUPERTAG_GATEWAY_CREDENTIAL" => None,
        _ => config.env.get(key).cloned(),
    };
    let files = deployment::configure(platform, &supplied, &mut |key| match missing {
        Missing::Ask => deployment::prompt(key),
        Missing::Refuse => bail!("{}", unsupplied(key)),
        Missing::Assume if key == DATABASE_URL => Ok(STORED_DATABASE.to_owned()),
        Missing::Assume => Ok(STORED.to_owned()),
    })
    .context("the deployment configuration is not valid for this target")?;
    let mut settings = files.services();
    let documents: Vec<String> = settings
        .keys()
        .filter(|key| {
            deployment::CREDENTIAL_HOLDERS
                .iter()
                .any(|(_, holder)| holder.is_variable(key))
        })
        .cloned()
        .collect();
    let mut take = |keys: &[&str]| -> Values {
        keys.iter()
            .filter_map(|key| {
                settings
                    .remove(*key)
                    .map(|value| ((*key).to_owned(), value))
            })
            .collect()
    };
    let mut secrets = vec![
        (OPERATOR.to_owned(), take(&[OPERATOR_TOKEN])),
        (GATEWAY.to_owned(), take(&GATEWAY_CREDENTIALS)),
        (DATABASE.to_owned(), take(&[DATABASE_URL])),
        (vault_token.clone(), take(&["VAULT_TOKEN"])),
    ];
    let documents: Vec<&str> = documents.iter().map(String::as_str).collect();
    secrets.push((CREDENTIALS.to_owned(), take(&documents)));
    secrets.retain(|(_, values)| !values.is_empty());
    // The settings the role contract does not know, such as a connector's account IDs.
    for (key, value) in &config.env {
        settings.entry(key.clone()).or_insert_with(|| value.clone());
    }
    if let Some(key) = settings
        .keys()
        .find(|key| deployment::SECRET_KEYS.contains(&key.as_str()))
    {
        bail!("{key} is a secret and cannot be a setting");
    }
    Ok(Plan { secrets, settings })
}

/// How to supply a secret only the user knows, when a run cannot ask for it.
fn unsupplied(key: &str) -> String {
    format!(
        "{key} is not stored yet and this run cannot prompt for it; set it in the environment for this run, or store it with `supertag deploy secret set {key}`"
    )
}

/// Why a stored certificate cannot be used without its public CA file.
fn ca_file_missing(ca_file: &Path) -> String {
    format!(
        "the certificate is already stored, but its public CA certificate {} is missing. Restore the file from version control; or issue a new certificate with `supertag deploy --renew-certificate`, after which every client and Worker Host needs the new file",
        ca_file.display()
    )
}

/// Why a CA file without a stored certificate is not replaced unasked.
fn ca_file_orphaned(ca_file: &Path) -> String {
    format!(
        "{} exists, but the secret store holds no certificate for it. Issuing one replaces that file, which clients may already trust: run `supertag deploy --renew-certificate` to do so",
        ca_file.display()
    )
}

/// What `ensure_tls` did, for the checks after the rollout.
struct Certificate {
    /// The public CA file clients trust, when the certificate is not publicly trusted.
    ca_file: Option<PathBuf>,
    /// The names a generated certificate carries, when known.
    names: Option<Vec<String>>,
    /// Whether this run issued it, so it may be issued again for the endpoint's real host.
    issued_now: bool,
}

/// The names a generated certificate carries: the endpoint's hosts, and the host the Gateway
/// dials when it reaches the Control Plane inside the deployment rather than through the
/// endpoint.
fn certificate_names(target: &dyn Target, hosts: Vec<String>) -> Vec<String> {
    let mut names = hosts;
    let upstream = target.platform().gateway_upstream();
    if let Some(inside) = upstream.strip_prefix("https://") {
        let host = inside.split([':', '/']).next().unwrap_or_default();
        if !host.is_empty() && !names.iter().any(|name| name == host) {
            names.push(host.to_owned());
        }
    }
    names
}

fn publish_generated(
    store: &dyn SecretStore,
    ca_file: &Path,
    names: &[String],
    replace: bool,
) -> Result<()> {
    let issued = tls::issue(names)?;
    let values = Values::from([
        (TLS_VARIABLES[0].to_owned(), issued.certificate),
        (TLS_VARIABLES[1].to_owned(), issued.key),
        (
            TLS_VARIABLES[2].to_owned(),
            tls::blocks(&issued.ca).to_owned(),
        ),
    ]);
    store.write(TLS, &values, replace)?;
    tls::write_public(ca_file, &issued.ca)?;
    errln!(
        "Issued a certificate for {} and wrote its public CA certificate to {}.",
        names.join(", "),
        ca_file.display()
    );
    Ok(())
}

fn ensure_tls(
    config: &Config,
    directory: &Path,
    target: &dyn Target,
    store: &dyn SecretStore,
    stored: &BTreeSet<String>,
    renew: bool,
) -> Result<Certificate> {
    let ca_file = config.ca_file(directory);
    let publish = renew || !stored.contains(TLS);
    match config.tls.mode {
        TlsMode::Generated => {
            let ca_file = ca_file.context("a generated certificate has a CA file")?;
            if !publish {
                let text =
                    std::fs::read_to_string(&ca_file).with_context(|| ca_file_missing(&ca_file))?;
                match tls::days_left(&text) {
                    Some(days) if days < 0 => errln!(
                        "Warning: the Control Plane's certificate ended {} days ago. Run `supertag deploy --renew-certificate` and give the new CA file to every client and Worker Host.",
                        -days
                    ),
                    Some(days) if days < 60 => errln!(
                        "Warning: the Control Plane's certificate ends in {days} days. Run `supertag deploy --renew-certificate` and give the new CA file to every client and Worker Host."
                    ),
                    _ => {}
                }
                return Ok(Certificate {
                    names: tls::names(&text),
                    ca_file: Some(ca_file),
                    issued_now: false,
                });
            }
            ensure!(renew || !ca_file.exists(), "{}", ca_file_orphaned(&ca_file));
            let names = certificate_names(target, target.hosts()?);
            publish_generated(store, &ca_file, &names, renew)?;
            Ok(Certificate {
                ca_file: Some(ca_file),
                names: Some(names),
                issued_now: true,
            })
        }
        TlsMode::Provided => {
            if publish {
                let read = |path: &Option<PathBuf>, what: &str| -> Result<String> {
                    let path = directory.join(path.as_ref().context("checked when parsed")?);
                    std::fs::read_to_string(&path)
                        .with_context(|| format!("read the provided {what} {}", path.display()))
                };
                let mut values = Values::from([
                    (
                        TLS_VARIABLES[0].to_owned(),
                        read(&config.tls.cert_file, "certificate")?,
                    ),
                    (
                        TLS_VARIABLES[1].to_owned(),
                        read(&config.tls.key_file, "private key")?,
                    ),
                ]);
                if let Some(ca_file) = &ca_file {
                    let text = std::fs::read_to_string(ca_file)
                        .with_context(|| format!("read tls.ca-file {}", ca_file.display()))?;
                    values.insert(TLS_VARIABLES[2].to_owned(), tls::blocks(&text).to_owned());
                }
                store.write(TLS, &values, renew)?;
                errln!("Published the provided certificate and key.");
            }
            Ok(Certificate {
                ca_file,
                names: None,
                issued_now: false,
            })
        }
    }
}

/// The endpoint's host, once its URL is the kind the target's capabilities promise.
fn host_of(target: &dyn Target, endpoint: &Endpoint) -> Result<String> {
    let url = &endpoint.url;
    let scheme = if target.capabilities().native_grpc {
        "https://"
    } else {
        "wss://"
    };
    ensure!(
        url.starts_with(scheme),
        "the {} target reported the endpoint {url}, but its clients use a {scheme} URL",
        target.platform().name()
    );
    url::Url::parse(url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned))
        .with_context(|| format!("the endpoint {url} has no host"))
}

async fn deploy(
    path: &Path,
    interactive: bool,
    renew: bool,
    dry_run: bool,
    wait: Duration,
) -> Result<()> {
    let (config, directory, target) = load(path)?;
    let target = target.as_ref();
    let name = target.platform().name();

    // 1. Check everything that can be checked without changing anything, and say what this
    //    deploy will do. A problem stops here.
    let checked = preflight::run(
        &config,
        &directory,
        target,
        interactive,
        renew,
        preflight::Scope::Plan,
    )
    .await;
    if dry_run {
        out!("{}", checked.text);
        checked.problems()?;
        outln!("Dry run: nothing was created or rolled out.");
        return Ok(());
    }
    crate::terminal::write_stderr(&checked.text);
    checked.problems()?;
    let store = store(target)?;
    let mut stored = checked.stored;
    let image = checked.image.context("the plan names an image")?;
    let plan = plan(
        &config,
        target,
        &stored,
        if interactive {
            Missing::Ask
        } else {
            Missing::Refuse
        },
    )?;

    // 2. Create the secrets the store lacks. One that exists is never written, so a deploy
    //    never rotates a credential.
    let mut generated_token = None;
    let mut created = 0;
    for (secret, values) in &plan.secrets {
        if stored.contains(secret) {
            continue;
        }
        if secret == OPERATOR {
            // Kept on this machine before it is stored, so it cannot be lost in between.
            let token = &values[OPERATOR_TOKEN];
            let file = save_operator_token(target, token)?;
            errln!(
                "Generated the admin Operator Token; this machine's copy is {}.",
                file.display()
            );
            generated_token = Some(token.clone());
        }
        store.write(secret, values, false)?;
        errln!(
            "Created the secret {secret} ({}) in {}.",
            values.keys().cloned().collect::<Vec<_>>().join(", "),
            store.describe()
        );
        stored.insert(secret.clone());
        created += 1;
    }

    if created == 0 {
        errln!("Every secret is already stored; none was changed.");
    }

    // 3. The Control Plane's certificate.
    let mut certificate = ensure_tls(&config, &directory, target, store, &stored, renew)?;
    stored.insert(TLS.to_owned());

    // 4. Roll out, with every secret the plan names and every one set with `secret set`.
    let mut secrets: Vec<String> = stored
        .iter()
        .filter(|secret| {
            **secret == TLS
                || secret.starts_with(SET_PREFIX)
                || plan.secrets.iter().any(|(name, _)| name == *secret)
        })
        .cloned()
        .collect();
    secrets.sort();
    let rollout = Rollout {
        image: &image,
        gateway_flags: config.gateway_flags(),
        settings: &plan.settings,
        secrets: &secrets,
    };
    errln!("Deploying {image} to {name}.");
    let mut endpoint = target.roll_out(&rollout)?;

    // The certificate must name the host the rollout reports.
    let host = host_of(target, &endpoint)?;
    if let Some(names) = &certificate.names
        && !names.contains(&host)
    {
        let ca_file = certificate
            .ca_file
            .as_deref()
            .context("a generated CA file")?;
        ensure!(
            certificate.issued_now,
            "the endpoint is {host}, but the Control Plane's certificate names {}. Run `supertag deploy --renew-certificate`; it issues a new certificate authority, so every client and Worker Host then needs the new {}",
            names.join(", "),
            ca_file.display()
        );
        errln!(
            "The endpoint is {host}, which the new certificate does not name; issuing it again."
        );
        let names = certificate_names(target, vec![host.clone()]);
        publish_generated(store, ca_file, &names, true)?;
        certificate.names = Some(names);
        let again = target.roll_out(&rollout)?;
        ensure!(
            host_of(target, &again)? == host,
            "the endpoint changed from {host} to {} between two rollouts",
            again.url
        );
        endpoint = again;
    }

    // 5. Wait for health, verify, and say what to do next.
    let deadline = Instant::now() + wait;
    let ca = match &certificate.ca_file {
        Some(file) => Some(
            std::fs::read_to_string(file).with_context(|| format!("read {}", file.display()))?,
        ),
        None => None,
    };
    wait_healthy(&endpoint, ca.as_deref(), deadline, target).await?;
    let token = match generated_token {
        Some(token) => Some((token, TokenSource::ThisMachine)),
        None => operator_token(target, store)?,
    };
    let report = verify(
        &endpoint,
        certificate.ca_file.clone(),
        &token,
        deadline,
        target,
    )
    .await?;
    let saved = match &token {
        Some((token, TokenSource::ThisMachine | TokenSource::SecretStore)) => {
            save_gateway(target, &endpoint, token, certificate.ca_file.clone())
        }
        _ => None,
    };
    out!(
        "{}",
        summary(
            target,
            &endpoint,
            certificate.ca_file.as_deref(),
            &report,
            saved.as_deref(),
            token.is_some(),
        )?
    );
    Ok(())
}

/// A client for a deployment's plain health URL.
fn health_client(ca: Option<&str>) -> Result<reqwest::Client> {
    let mut client = reqwest::Client::builder()
        .user_agent(concat!("supertag/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20));
    // A private edge may present a certificate from the deployment's own authority.
    if let Some(ca) = ca {
        client = client.add_root_certificate(
            reqwest::Certificate::from_pem(tls::blocks(ca).as_bytes())
                .context("the CA file is not a PEM certificate")?,
        );
    }
    client.build().context("set up the HTTPS client")
}

/// Whether the health URL answers 200, or what it gave instead.
async fn healthy(client: &reqwest::Client, health: &str) -> Result<(), String> {
    match client.get(health).send().await {
        Ok(response) if response.status() == reqwest::StatusCode::OK => Ok(()),
        Ok(response) => Err(format!("HTTP {}", response.status())),
        Err(error) => Err(format!("{error}")),
    }
}

async fn wait_healthy(
    endpoint: &Endpoint,
    ca: Option<&str>,
    deadline: Instant,
    target: &dyn Target,
) -> Result<()> {
    let Some(health) = &endpoint.health else {
        return Ok(());
    };
    let client = health_client(ca)?;
    errln!("Waiting for {health} to answer.");
    loop {
        let Err(last) = healthy(&client, health).await else {
            return Ok(());
        };
        ensure!(
            Instant::now() < deadline,
            "the deployment did not become healthy in time: {health} last gave {last}. {}",
            target.troubleshooting()
        );
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

/// `supertag verify deployment`'s checks against the endpoint. The edge may refuse a tunnel
/// for a moment after the health check first passes, so connecting is retried until `deadline`.
async fn verify(
    endpoint: &Endpoint,
    ca_file: Option<PathBuf>,
    token: &Option<(String, TokenSource)>,
    deadline: Instant,
    target: &dyn Target,
) -> Result<String> {
    let files = network::TlsFiles {
        server_ca: ca_file,
        ..Default::default()
    };
    // Health has passed, so a failure that lasts is the certificate, not a starting service.
    let deadline = deadline.min(Instant::now() + Duration::from_secs(45));
    let channel = loop {
        let connected = network::operator_channel(
            &network::operator_endpoint(
                endpoint.url.clone(),
                Duration::from_secs(15),
                Some(&files),
            )
            .await?,
        )
        .await;
        match connected {
            Ok(channel) => break channel,
            Err(error) if Instant::now() >= deadline => {
                return Err(error).with_context(|| {
                    format!(
                        "the deployment answers its health check, but {} could not be reached over SuperTag's TLS; if the certificate is not the one the CA file belongs to, run `supertag deploy --renew-certificate`. {}",
                        endpoint.url,
                        target.troubleshooting()
                    )
                });
            }
            Err(_) => tokio::time::sleep(Duration::from_secs(3)).await,
        }
    };
    let source = match token {
        Some((_, TokenSource::Environment)) => "the SUPERTAG_OPERATOR_TOKEN in the environment",
        Some((_, TokenSource::ThisMachine)) => "the Operator Token this machine kept",
        Some((_, TokenSource::SecretStore)) => "the Operator Token in the secret store",
        None => "no Operator Token",
    };
    deployment::verify_channel(
        channel,
        token.as_ref().map(|(token, _)| token.as_str()),
        false,
    )
    .await
    .with_context(|| format!("verifying {} with {source}", endpoint.url))
}

/// Saves the deployment as a Gateway for this CLI, as `supertag connect` does. Returns its
/// name, or `None` when the name is taken by another URL.
fn save_gateway(
    target: &dyn Target,
    endpoint: &Endpoint,
    token: &str,
    ca_file: Option<PathBuf>,
) -> Option<String> {
    let name = target.name();
    let saved = profiles::save(
        &profiles::NewGateway {
            name: name.clone(),
            url: endpoint.url.clone(),
            token: token.to_owned(),
            server_ca_file: ca_file,
            client_cert_file: None,
            client_key_file: None,
        },
        true,
    );
    match saved {
        Ok(_) => Some(name),
        Err(error) => {
            errln!("Did not save the deployment as Gateway {name:?} for this CLI: {error:#}");
            None
        }
    }
}

fn summary(
    target: &dyn Target,
    endpoint: &Endpoint,
    ca_file: Option<&Path>,
    report: &str,
    saved: Option<&str>,
    token: bool,
) -> Result<String> {
    let url = &endpoint.url;
    let name = target.name();
    let mut text = format!("\nDeployed. The Control Plane is at {url}\n{report}");
    let ca = ca_file.map(|file| shell_word(&file.display().to_string()));
    if let Some(ca) = &ca {
        text.push_str(&format!(
            "Clients and Worker Hosts trust it through the public CA certificate {ca} (commit it).\n"
        ));
    }
    text.push_str("\nNext:\n");
    let gateway = match saved {
        Some(saved) => {
            text.push_str(&format!(
                "  # This CLI saved the deployment as the Gateway \"{saved}\":\n  supertag status --gateway {saved}\n"
            ));
            saved.to_owned()
        }
        None => {
            let trust = ca
                .as_ref()
                .map(|ca| format!(" --server-ca-file {ca}"))
                .unwrap_or_default();
            text.push_str(&format!(
                "  # Save the deployment for this CLI; it reads the admin Operator Token from\n  # SUPERTAG_OPERATOR_TOKEN or standard input{}:\n  supertag connect {url} --name {name}{trust}\n",
                if token {
                    ""
                } else {
                    " (whoever ran the first deploy has it; `supertag deploy secret set SUPERTAG_OPERATOR_TOKEN` replaces it)"
                }
            ));
            name.clone()
        }
    };
    let trust = ca
        .as_ref()
        .map(|ca| format!("  export SUPERTAG_SERVER_CA_FILE={ca}\n"))
        .unwrap_or_default();
    text.push_str(&format!(
        "  # Create a one-time Auth Key for a Worker Host that may run every Tag (or name them\n  # with --tag TAG), and save the printed key in a private file (mode 0600):\n  supertag auth-key create HOST --role host --all-tags --gateway {gateway}\n  # On the Worker Host, with the CA certificate copied there:\n{trust}  supertag host enroll HOST --control-plane {url} --state-directory ~/.supertag-HOST --auth-key file:HOST.key\n  supertag worklet --control-plane {url} --state-directory ~/.supertag-HOST --harness codex\n"
    ));
    text.push_str(&format!(
        "  # Store a collaboration surface, Workspace, or Volume credential, then upload it:\n  export SUPERTAG_CREDENTIAL_FILE={}\n  supertag deploy secret push && supertag deploy\n",
        shell_word(&credential_file_of(target)?.display().to_string())
    ));
    Ok(text)
}

/// `text` as one word of a shell command: as it is, or in single quotes.
fn shell_word(text: &str) -> String {
    let plain = !text.is_empty()
        && text
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_@%+=:,./-".contains(&byte));
    if plain {
        text.to_owned()
    } else {
        format!("'{}'", text.replace('\'', "'\"'\"'"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_variable_has_one_secret_and_managed_ones_are_refused() -> Result<()> {
        assert_eq!(secret_of("SUPERTAG_DATABASE_URL")?, DATABASE);
        assert_eq!(secret_of("SUPERTAG_OPERATOR_TOKEN")?, OPERATOR);
        assert_eq!(secret_of("SUPERTAG_GATEWAY_CREDENTIAL")?, GATEWAY);
        assert_eq!(secret_of("VAULT_TOKEN")?, "env-vault-token");
        assert_eq!(
            secret_of("SUPERTAG_NOTIFY_SECRET_OPS")?,
            "env-supertag-notify-secret-ops"
        );
        for (name, message) in [
            ("SUPERTAG_TLS_KEY_PEM", "--renew-certificate"),
            ("SUPERTAG_GATEWAY_CREDENTIALS", "secret push"),
            ("SUPERTAG_CONTROL_PLANE_CREDENTIALS_2", "secret push"),
            ("SUPERTAG_STATE_DIR", "not a secret"),
            ("SUPERTAG_MODAL_IMAGE", "not a secret"),
            ("lower", "not an environment variable's name"),
            ("1ST", "not an environment variable's name"),
            ("", "not an environment variable's name"),
        ] {
            let error = secret_of(name).unwrap_err().to_string();
            assert!(error.contains(message), "{name}: {error}");
        }
        // `secret list` names each stored secret by the variable it was set as.
        for name in [
            "SUPERTAG_DATABASE_URL",
            "VAULT_TOKEN",
            "SUPERTAG_NOTIFY_SECRET_OPS",
        ] {
            assert_eq!(
                variable_of(&secret_of(name)?)
                    .map(|(variable, _)| variable)
                    .as_deref(),
                Some(name)
            );
        }
        // Another deployment's or a hand-made secret with the same prefix is not listed.
        assert_eq!(variable_of("control-plane"), None);
        Ok(())
    }
}
