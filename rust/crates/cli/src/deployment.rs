//! `supertag setup deployment`, `check deployment`, and `verify deployment` for the separately
//! deployed service roles: a public Control Plane, an optional Gateway for collaboration
//! surfaces, and outbound Worker Hosts.
//!
//! Ports `apps/cli/src/deploy.ts` and `deploy/shared/src/index.ts`. Setup writes one private
//! environment file per role instead of one file for a single Node service. Worker Hosts are not
//! configured here: each joins with an Auth Key (`supertag auth-key create`, then
//! `supertag host enroll`).
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::{self, BufRead, IsTerminal, Write},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    time::Duration,
};

use anyhow::{Context, Result, bail, ensure};
use clap::{Args, Subcommand, ValueEnum};
use supertag_protocol::{
    MAX_MESSAGE_BYTES, authenticated_request,
    v2::{
        HostPhase, ListHostsRequest, ReportHostRequest, operator_client::OperatorClient,
        worker_host_client::WorkerHostClient,
    },
};
use tonic::{Code, Request};
use tonic_health::pb::{
    HealthCheckRequest, health_check_response::ServingStatus, health_client::HealthClient,
};
use uuid::Uuid;

/// The Control Plane's native gRPC port inside its container in every definition.
pub const CONTROL_PLANE_PORT: u16 = 3434;
/// The WebSocket tunnel listener's port inside the container on platforms that forward only
/// HTTP (Render, Cloudflare, and Modal). Its plain `GET /healthz` serves platform health checks.
pub const TUNNEL_PORT: u16 = 8080;
/// The Gateway's test notification listener, reachable only inside its container.
#[cfg(test)]
const GATEWAY_LISTEN: &str = "127.0.0.1:3436";
/// Each service's persistent state mount: the Control Plane's transfer directory, and the
/// Gateway's file credential vault and connector state.
pub const STATE_DIRECTORY: &str = "/var/lib/supertag";
/// Where each container finds its TLS files, mounted (Compose) or written from secrets by
/// `deploy/docker/rust-hosted-entrypoint.sh` (every other platform).
pub const TLS_DIRECTORY: &str = "/run/supertag-tls";

const CONTROL_PLANE_FILE: &str = "control-plane.env";
const GATEWAY_FILE: &str = "gateway.env";
const OPERATOR_FILE: &str = "operator.env";
const POSTGRES_FILE: &str = "postgres.env";

/// TLS settings each service reads. Compose names files in the env files; the hosted entrypoint
/// derives them from the matching `..._PEM` secrets, so hosted env files must not name them.
const TLS_KEYS: [&str; 6] = [
    "SUPERTAG_TLS_CERT_FILE",
    "SUPERTAG_TLS_KEY_FILE",
    "SUPERTAG_TLS_CLIENT_CA_FILE",
    "SUPERTAG_SERVER_CA_FILE",
    "SUPERTAG_CLIENT_CERT_FILE",
    "SUPERTAG_CLIENT_KEY_FILE",
];
/// The GitHub Workspace account (`--github-workspace-directory`) and the credential vault it may
/// read its secret from are optional Control Plane settings.
const CONTROL_PLANE_KEYS: [&str; 18] = [
    "SUPERTAG_DATABASE_URL",
    "SUPERTAG_GATEWAY_TOKEN",
    "SUPERTAG_OPERATOR_TOKEN",
    "SUPERTAG_OPERATOR_PRINCIPAL",
    "SUPERTAG_STATE_DIR",
    "SUPERTAG_GITHUB_ACCOUNT_ID",
    "SUPERTAG_GITHUB_REPOSITORY_ID",
    "SUPERTAG_GITHUB_REPOSITORY",
    "SUPERTAG_GITHUB_TOKEN",
    "SUPERTAG_GITHUB_APP_ID",
    "SUPERTAG_GITHUB_INSTALLATION_ID",
    "SUPERTAG_GITHUB_PRIVATE_KEY_FILE",
    "SUPERTAG_CREDENTIAL_VAULT",
    "VAULT_ADDR",
    "VAULT_TOKEN",
    "VAULT_NAMESPACE",
    "SUPERTAG_VAULT_MOUNT",
    "SUPERTAG_VAULT_PATH_PREFIX",
];
/// The Gateway holds no operator credential: it reads Inbox notifications for
/// `SUPERTAG_OPERATOR_PRINCIPAL` with the Gateway credential.
const GATEWAY_KEYS: [&str; 9] = [
    "SUPERTAG_GATEWAY_TOKEN",
    "SUPERTAG_OPERATOR_PRINCIPAL",
    "SUPERTAG_STATE_DIR",
    "SUPERTAG_CREDENTIAL_VAULT",
    "VAULT_ADDR",
    "VAULT_TOKEN",
    "VAULT_NAMESPACE",
    "SUPERTAG_VAULT_MOUNT",
    "SUPERTAG_VAULT_PATH_PREFIX",
];
const OPERATOR_KEYS: [&str; 1] = ["SUPERTAG_OPERATOR_TOKEN"];
const POSTGRES_KEYS: [&str; 3] = ["POSTGRES_DB", "POSTGRES_USER", "POSTGRES_PASSWORD"];
const SECRET_KEYS: [&str; 5] = [
    "SUPERTAG_DATABASE_URL",
    "SUPERTAG_GATEWAY_TOKEN",
    "SUPERTAG_OPERATOR_TOKEN",
    "VAULT_TOKEN",
    "POSTGRES_PASSWORD",
];

/// A platform that hosts the public Control Plane, with its own TLS, and an optional Gateway
/// that reaches it as a client. Platforms that forward only HTTP carry the Control Plane's gRPC
/// in the WebSocket tunnel (`--websocket-listen`), with SuperTag's TLS running inside it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
pub enum Platform {
    /// Docker Compose on your own server: deploy/compose.native.yaml.
    Compose,
    /// Two Fly.io apps: deploy/native/fly.
    Fly,
    /// Two Railway services: deploy/native/railway.
    Railway,
    /// A Render Blueprint with a web service, PostgreSQL, and an optional Gateway worker:
    /// deploy/render.
    Render,
    /// A Cloudflare Worker in front of one Container that runs the Control Plane and the
    /// optional Gateway: deploy/cloudflare.
    Cloudflare,
    /// A Modal app whose web endpoint carries the tunnel to one container that runs the
    /// Control Plane and the optional Gateway: deploy/modal.
    Modal,
}

impl Platform {
    #[cfg(test)]
    pub const ALL: [Self; 6] = [
        Self::Compose,
        Self::Fly,
        Self::Railway,
        Self::Render,
        Self::Cloudflare,
        Self::Modal,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Self::Compose => "compose",
            Self::Fly => "fly",
            Self::Railway => "railway",
            Self::Render => "render",
            Self::Cloudflare => "cloudflare",
            Self::Modal => "modal",
        }
    }

    /// The Control Plane URL the Gateway dials in this platform's definitions. The Control
    /// Plane's certificate must name its host as well as the public host.
    pub fn gateway_upstream(self) -> &'static str {
        match self {
            Self::Compose => "https://control-plane:3434",
            Self::Fly => "https://supertag-control-plane.internal:3434",
            Self::Railway => "https://supertag-control-plane.railway.internal:3434",
            // Render's Gateway is a separate service that crosses the platform edge.
            Self::Render => "wss://supertag-control-plane.onrender.com",
            // The Gateway shares the Control Plane's container.
            Self::Cloudflare | Self::Modal => "https://127.0.0.1:3434",
        }
    }

    fn hosted(self) -> bool {
        self != Self::Compose
    }

    /// Platforms whose ingress forwards only HTTP, so clients use a `wss://` URL.
    pub fn tunnelled(self) -> bool {
        matches!(self, Self::Render | Self::Cloudflare | Self::Modal)
    }

    /// The platform's own definition supplies the database URL (Render's Blueprint).
    fn database_from_platform(self) -> bool {
        self == Self::Render
    }

    /// Platforms with no disk the Gateway's file credential vault can rely on: Cloudflare
    /// Containers have no persistent disk, and a Modal Volume does not give the file vault's
    /// atomic, durable replacement.
    fn requires_vault(self) -> bool {
        matches!(self, Self::Cloudflare | Self::Modal)
    }

    fn next_steps(self) -> &'static str {
        match self {
            Self::Compose => {
                "Put each role's TLS files in its own directory (see deploy/native/README.md), then start deploy/compose.native.yaml with deploy/compose.native.ingress.yaml, passing these files as SUPERTAG_POSTGRES_ENV_FILE, SUPERTAG_CONTROL_ENV_FILE, and SUPERTAG_GATEWAY_ENV_FILE. Add --profile gateway to run the Gateway for collaboration surfaces."
            }
            Self::Fly => {
                "Import control-plane.env into the supertag-control-plane app with `fly secrets import`, set its TLS PEM secrets, then deploy deploy/native/fly/control-plane.toml. For collaboration surfaces, also import gateway.env into the supertag-gateway app and deploy deploy/native/fly/gateway.toml (see deploy/native/README.md)."
            }
            Self::Railway => {
                "Paste control-plane.env into the supertag-control-plane service's variables, add its TLS PEM variables, and use deploy/native/railway/control-plane.json as its config file. For collaboration surfaces, also paste gateway.env into a supertag-gateway service configured by deploy/native/railway/gateway.json (see deploy/native/README.md)."
            }
            Self::Render => {
                "Set the hosted image digest in deploy/render/render.yaml and create the Blueprint; its database supplies SUPERTAG_DATABASE_URL. Render subdomains are global, so read the Control Plane's hostname on its service page; if it is not supertag-control-plane.onrender.com, issue the certificate for it and change the Gateway's --control-plane. Then add control-plane.env and the TLS PEM variables to supertag-control-plane, and, for Lark or webhook notifications, gateway.env, its connector settings, and its PEM variables to supertag-gateway, with its connector flags appended to its dockerCommand (see docs/guides/deploy-render.md)."
            }
            Self::Cloudflare => {
                "Tag the hosted image as supertag-hosted:local, upload control-plane.env and the TLS PEM values as Worker secrets with `wrangler secret bulk`, then run `wrangler deploy` in deploy/cloudflare. For Lark or webhook notifications, also upload gateway.env and the connector settings and set SUPERTAG_GATEWAY to on and SUPERTAG_GATEWAY_FLAGS in wrangler.json (see docs/guides/deploy-cloudflare.md)."
            }
            Self::Modal => {
                "Create the Modal secrets supertag-control-plane from control-plane.env plus its TLS PEM values and, for Lark or webhook notifications, supertag-gateway from gateway.env plus the connector settings and supertag-gateway-tls from its PEM values, then run `modal deploy deploy/modal/app.py` with SUPERTAG_MODAL_IMAGE set to the hosted image by digest, plus SUPERTAG_MODAL_GATEWAY=on and SUPERTAG_MODAL_GATEWAY_FLAGS for the Gateway (see docs/guides/deploy-modal.md)."
            }
        }
    }
}

#[derive(Subcommand)]
pub enum SetupCommand {
    /// Write private per-role environment files for a hosted deployment.
    Deployment(SetupArgs),
}

#[derive(Subcommand)]
pub enum CheckCommand {
    /// Validate a deployment's environment files without connecting.
    Deployment(CheckArgs),
}

#[derive(Subcommand)]
pub enum VerifyCommand {
    /// Check a deployed Control Plane: health, authentication, and readiness.
    Deployment(VerifyArgs),
}

#[derive(Args)]
#[command(
    after_help = "Setup reads SUPERTAG_DATABASE_URL, SUPERTAG_GATEWAY_TOKEN, SUPERTAG_OPERATOR_TOKEN, SUPERTAG_OPERATOR_PRINCIPAL, SUPERTAG_CREDENTIAL_VAULT, and VAULT_* from the environment and prompts for missing required values (secrets are masked). Tokens that are not supplied are generated. Secrets are never accepted as flags or printed. Compose generates its own PostgreSQL password when SUPERTAG_DATABASE_URL is not set, and Render's Blueprint supplies the database URL itself. Cloudflare and Modal keep connector credentials in HashiCorp Vault (SUPERTAG_CREDENTIAL_VAULT=vault). Setup never replaces an existing directory. Upload the files through your provider's secret controls; do not shell-source them."
)]
pub struct SetupArgs {
    platform: Platform,
    /// New private directory for the environment files.
    #[arg(long, default_value = "supertag-deployment")]
    output: PathBuf,
    /// Fail instead of prompting when a required value is missing.
    #[arg(long)]
    non_interactive: bool,
}

#[derive(Args)]
pub struct CheckArgs {
    platform: Platform,
    /// Directory written by `supertag setup deployment`.
    #[arg(long, default_value = "supertag-deployment")]
    directory: PathBuf,
}

#[derive(Args)]
#[command(
    after_help = "The operator token comes from SUPERTAG_OPERATOR_TOKEN or --env-file (the operator.env setup wrote). Use SUPERTAG_SERVER_CA_FILE when the Control Plane's certificate comes from a private CA, and SUPERTAG_CLIENT_CERT_FILE and SUPERTAG_CLIENT_KEY_FILE when the Control Plane requires client certificates. Verification registers no Worker Host and runs no Task."
)]
pub struct VerifyArgs {
    /// The Control Plane's public origin: https://HOST for native gRPC, or wss://HOST behind a
    /// platform that forwards only HTTP (Render, Cloudflare, Modal).
    url: String,
    /// Private env file that holds SUPERTAG_OPERATOR_TOKEN.
    #[arg(long)]
    env_file: Option<PathBuf>,
    /// Fail unless at least one Worker Host is ready.
    #[arg(long)]
    require_ready: bool,
}

/// One role's validated environment, in a fixed order.
type Environment = BTreeMap<String, String>;

#[derive(Debug)]
pub struct Files {
    control_plane: Environment,
    gateway: Environment,
    operator: Environment,
    postgres: Option<Environment>,
}

pub async fn setup(command: SetupCommand) -> Result<()> {
    let SetupCommand::Deployment(args) = command;
    let supplied = |key: &str| {
        std::env::var(key)
            .ok()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
    };
    let interactive = !args.non_interactive && io::stdin().is_terminal();
    let files = configure(args.platform, &supplied, &mut |key| {
        ensure!(
            interactive,
            "Missing {key}; set it in the environment or run setup in a terminal"
        );
        prompt(key)
    })?;
    write_directory(&args.output, &files)?;
    let directory = args
        .output
        .canonicalize()
        .context("resolve the deployment directory")?;
    let listener = if args.platform.tunnelled() {
        format!(
            "The Control Plane serves TLS itself inside the WebSocket tunnel on container port {TUNNEL_PORT}, which also answers the platform health check at /healthz. Clients use a wss:// URL; its certificate must name the public host, and for a platform hostname it comes from your own CA, which every client trusts through SUPERTAG_SERVER_CA_FILE."
        )
    } else {
        format!(
            "The Control Plane serves TLS itself on container port {CONTROL_PLANE_PORT}; its certificate must name the public host operators and Worker Hosts use."
        )
    };
    let upstream = args.platform.gateway_upstream();
    let host = upstream
        .split_once("://")
        .map_or(upstream, |(_, rest)| rest)
        .split(':')
        .next()
        .unwrap_or_default();
    out!(
        "Saved {platform} deployment configuration to {} (contains secrets; keep private).\n\
         {listener}\n\
         A Gateway reaches the Control Plane at {upstream}, so the certificate must also name {host}. It presents a client certificate, so a Control Plane serving a Gateway requires client certificates.\n\
         {}\n",
        directory.display(),
        args.platform.next_steps(),
        platform = args.platform.name(),
    );
    Ok(())
}

pub fn check(command: CheckCommand) -> Result<()> {
    let CheckCommand::Deployment(args) = command;
    read_directory(args.platform, &args.directory)?;
    outln!(
        "{} deployment configuration is valid. Connectivity, TLS files, and volume durability are not checked.",
        args.platform.name()
    );
    Ok(())
}

/// Builds the per-role files from supplied values, asking `missing` for required values that
/// were not supplied, then validates them exactly as `check` does.
pub fn configure(
    platform: Platform,
    supplied: &dyn Fn(&str) -> Option<String>,
    missing: &mut dyn FnMut(&str) -> Result<String>,
) -> Result<Files> {
    let token = || format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let mut required = |key: &str| match supplied(key) {
        Some(value) => Ok(value),
        None => missing(key),
    };
    let mut postgres = None;
    let database = match (platform, supplied("SUPERTAG_DATABASE_URL")) {
        (Platform::Render, Some(_)) => bail!(
            "Render's Blueprint sets SUPERTAG_DATABASE_URL from its own database; unset it before running setup"
        ),
        (Platform::Render, None) => None,
        (_, Some(url)) => Some(url),
        // Compose runs its own PostgreSQL service; give it a generated password.
        (Platform::Compose, None) => {
            let password = token();
            postgres = Some(Environment::from([
                ("POSTGRES_DB".into(), "supertag".into()),
                ("POSTGRES_USER".into(), "supertag".into()),
                ("POSTGRES_PASSWORD".into(), password.clone()),
            ]));
            Some(format!(
                "postgresql://supertag:{password}@postgres:5432/supertag"
            ))
        }
        (_, None) => Some(required("SUPERTAG_DATABASE_URL")?),
    };
    let gateway_token = supplied("SUPERTAG_GATEWAY_TOKEN").unwrap_or_else(token);
    let operator_token = supplied("SUPERTAG_OPERATOR_TOKEN").unwrap_or_else(token);

    let mut control_plane = Environment::from([
        ("SUPERTAG_GATEWAY_TOKEN".into(), gateway_token.clone()),
        ("SUPERTAG_OPERATOR_TOKEN".into(), operator_token.clone()),
        ("SUPERTAG_STATE_DIR".into(), STATE_DIRECTORY.into()),
    ]);
    if let Some(database) = database {
        control_plane.insert("SUPERTAG_DATABASE_URL".into(), database);
    }
    let mut gateway = Environment::from([
        ("SUPERTAG_GATEWAY_TOKEN".into(), gateway_token),
        ("SUPERTAG_STATE_DIR".into(), STATE_DIRECTORY.into()),
    ]);
    if let Some(principal) = supplied("SUPERTAG_OPERATOR_PRINCIPAL") {
        control_plane.insert("SUPERTAG_OPERATOR_PRINCIPAL".into(), principal.clone());
        gateway.insert("SUPERTAG_OPERATOR_PRINCIPAL".into(), principal);
    }
    let vault = supplied("SUPERTAG_CREDENTIAL_VAULT").unwrap_or_else(|| {
        if platform.requires_vault() {
            "vault".into()
        } else {
            "file".into()
        }
    });
    if vault == "vault" {
        for key in ["VAULT_ADDR", "VAULT_TOKEN"] {
            gateway.insert(key.into(), required(key)?);
        }
        for key in [
            "VAULT_NAMESPACE",
            "SUPERTAG_VAULT_MOUNT",
            "SUPERTAG_VAULT_PATH_PREFIX",
        ] {
            if let Some(value) = supplied(key) {
                gateway.insert(key.into(), value);
            }
        }
    }
    gateway.insert("SUPERTAG_CREDENTIAL_VAULT".into(), vault);
    if platform == Platform::Compose {
        let file = |name: &str| format!("{TLS_DIRECTORY}/{name}");
        // The Control Plane's server CA lets its own health probe check it.
        for (key, name) in [
            ("SUPERTAG_TLS_CERT_FILE", "server.pem"),
            ("SUPERTAG_TLS_KEY_FILE", "server.key"),
            ("SUPERTAG_SERVER_CA_FILE", "server-ca.pem"),
        ] {
            control_plane.insert(key.into(), file(name));
        }
        gateway.insert("SUPERTAG_SERVER_CA_FILE".into(), file("server-ca.pem"));
    }
    let files = Files {
        control_plane,
        gateway,
        operator: Environment::from([("SUPERTAG_OPERATOR_TOKEN".into(), operator_token)]),
        postgres,
    };
    validate(platform, &files)?;
    Ok(files)
}

/// The shared rules for every platform. Messages name keys, never values.
pub fn validate(platform: Platform, files: &Files) -> Result<()> {
    let mut issues = Vec::new();
    let tls_allowed = !platform.hosted();
    let mut known = |file: &str, environment: &Environment, keys: &[&str], tls: bool| {
        for key in environment.keys() {
            let tls_key = TLS_KEYS.contains(&key.as_str());
            if !(keys.contains(&key.as_str()) || tls && tls_key) {
                let service = file == CONTROL_PLANE_FILE || file == GATEWAY_FILE;
                issues.push(if tls_key && service && !tls_allowed {
                    format!(
                        "{file}: {key} is set by the hosted entrypoint from the matching _PEM secret; remove it"
                    )
                } else {
                    format!("{file}: unknown deployment environment key {key}")
                });
            }
        }
    };
    known(
        CONTROL_PLANE_FILE,
        &files.control_plane,
        &CONTROL_PLANE_KEYS,
        tls_allowed,
    );
    known(GATEWAY_FILE, &files.gateway, &GATEWAY_KEYS, tls_allowed);
    known(OPERATOR_FILE, &files.operator, &OPERATOR_KEYS, false);
    if let Some(postgres) = &files.postgres {
        known(POSTGRES_FILE, postgres, &POSTGRES_KEYS, false);
    }
    let control = |key: &str| files.control_plane.get(key).map(String::as_str);
    let gateway = |key: &str| files.gateway.get(key).map(String::as_str);

    match control("SUPERTAG_DATABASE_URL") {
        Some(_) if platform.database_from_platform() => issues.push(format!(
            "{CONTROL_PLANE_FILE}: SUPERTAG_DATABASE_URL is set by the {} definition from its own database; remove it",
            platform.name()
        )),
        None if platform.database_from_platform() => {}
        None => issues.push(format!("{CONTROL_PLANE_FILE}: Missing SUPERTAG_DATABASE_URL")),
        Some(url) if !postgres_url(url) => issues.push(format!(
            "{CONTROL_PLANE_FILE}: SUPERTAG_DATABASE_URL must be a PostgreSQL URL; hosted deployments require PostgreSQL"
        )),
        Some(_) => {}
    }
    for (file, key, value) in [
        (
            CONTROL_PLANE_FILE,
            "SUPERTAG_GATEWAY_TOKEN",
            control("SUPERTAG_GATEWAY_TOKEN"),
        ),
        (
            CONTROL_PLANE_FILE,
            "SUPERTAG_OPERATOR_TOKEN",
            control("SUPERTAG_OPERATOR_TOKEN"),
        ),
        (
            GATEWAY_FILE,
            "SUPERTAG_GATEWAY_TOKEN",
            gateway("SUPERTAG_GATEWAY_TOKEN"),
        ),
    ] {
        match value {
            None => issues.push(format!("{file}: Missing {key}")),
            Some(token) if !strong_token(token) => issues.push(format!(
                "{file}: {key} must be at least 32 characters of letters, digits, and -._~+/"
            )),
            Some(_) => {}
        }
    }
    if control("SUPERTAG_GATEWAY_TOKEN") != gateway("SUPERTAG_GATEWAY_TOKEN") {
        issues.push("SUPERTAG_GATEWAY_TOKEN differs between the Control Plane and Gateway".into());
    }
    if control("SUPERTAG_OPERATOR_PRINCIPAL") != gateway("SUPERTAG_OPERATOR_PRINCIPAL") {
        issues.push(
            "SUPERTAG_OPERATOR_PRINCIPAL differs between the Control Plane and Gateway".into(),
        );
    }
    if control("SUPERTAG_GATEWAY_TOKEN").is_some()
        && control("SUPERTAG_GATEWAY_TOKEN") == control("SUPERTAG_OPERATOR_TOKEN")
    {
        issues.push("SUPERTAG_OPERATOR_TOKEN must differ from SUPERTAG_GATEWAY_TOKEN".into());
    }
    if files
        .operator
        .get("SUPERTAG_OPERATOR_TOKEN")
        .map(String::as_str)
        != control("SUPERTAG_OPERATOR_TOKEN")
    {
        issues.push(format!(
            "{OPERATOR_FILE}: SUPERTAG_OPERATOR_TOKEN differs from the Control Plane's"
        ));
    }
    for (file, principal) in [
        (CONTROL_PLANE_FILE, control("SUPERTAG_OPERATOR_PRINCIPAL")),
        (GATEWAY_FILE, gateway("SUPERTAG_OPERATOR_PRINCIPAL")),
    ] {
        if let Some(principal) = principal
            && !principal.strip_prefix("operator:").is_some_and(|id| {
                !id.is_empty() && id.len() <= 255 && id.bytes().all(|byte| byte.is_ascii_graphic())
            })
        {
            issues.push(format!(
                "{file}: SUPERTAG_OPERATOR_PRINCIPAL must be operator:NAME"
            ));
        }
    }
    if control("SUPERTAG_STATE_DIR") != Some(STATE_DIRECTORY) {
        issues.push(format!(
            "{CONTROL_PLANE_FILE}: the transfer directory requires the persistent mount at SUPERTAG_STATE_DIR={STATE_DIRECTORY}"
        ));
    }
    match gateway("SUPERTAG_CREDENTIAL_VAULT") {
        Some("file") if platform.requires_vault() => issues.push(format!(
            "{GATEWAY_FILE}: {} has no disk the file credential vault can rely on; set SUPERTAG_CREDENTIAL_VAULT=vault with VAULT_ADDR and VAULT_TOKEN",
            platform.name()
        )),
        Some("file") => {
            if gateway("SUPERTAG_STATE_DIR") != Some(STATE_DIRECTORY) {
                issues.push(format!(
                    "{GATEWAY_FILE}: the file credential vault requires the persistent mount at SUPERTAG_STATE_DIR={STATE_DIRECTORY}"
                ));
            }
            for key in ["VAULT_ADDR", "VAULT_TOKEN"] {
                if gateway(key).is_some() {
                    issues.push(format!(
                        "{GATEWAY_FILE}: {key} requires SUPERTAG_CREDENTIAL_VAULT=vault"
                    ));
                }
            }
        }
        Some("vault") => {
            match gateway("VAULT_ADDR") {
                None => issues.push(format!("{GATEWAY_FILE}: Missing VAULT_ADDR")),
                Some(address) if !https_origin(address, true) => issues.push(format!(
                    "{GATEWAY_FILE}: VAULT_ADDR must be an HTTPS URL without credentials, query, or fragment"
                )),
                Some(_) => {}
            }
            if gateway("VAULT_TOKEN").is_none() {
                issues.push(format!("{GATEWAY_FILE}: Missing VAULT_TOKEN"));
            }
        }
        _ => issues.push(format!(
            "{GATEWAY_FILE}: SUPERTAG_CREDENTIAL_VAULT must be file or vault"
        )),
    }
    if !platform.hosted() {
        let required =
            |environment: &Environment, file: &str, keys: &[&str], issues: &mut Vec<String>| {
                for key in keys {
                    match environment.get(*key) {
                        None => issues.push(format!("{file}: Missing {key}")),
                        Some(path) if !path.starts_with('/') => {
                            issues.push(format!("{file}: {key} must name an absolute mounted file"))
                        }
                        Some(_) => {}
                    }
                }
            };
        // The Control Plane serves TLS; its server CA serves the container health probe.
        // Client certificates are an optional network filter in front of authentication.
        required(
            &files.control_plane,
            CONTROL_PLANE_FILE,
            &[
                "SUPERTAG_TLS_CERT_FILE",
                "SUPERTAG_TLS_KEY_FILE",
                "SUPERTAG_SERVER_CA_FILE",
            ],
            &mut issues,
        );
        required(
            &files.gateway,
            GATEWAY_FILE,
            &["SUPERTAG_SERVER_CA_FILE"],
            &mut issues,
        );
        for (environment, file) in [
            (&files.control_plane, CONTROL_PLANE_FILE),
            (&files.gateway, GATEWAY_FILE),
        ] {
            for key in TLS_KEYS {
                if let Some(path) = environment.get(key)
                    && !path.starts_with('/')
                {
                    issues.push(format!("{file}: {key} must name an absolute mounted file"));
                }
            }
            if environment.contains_key("SUPERTAG_CLIENT_CERT_FILE")
                != environment.contains_key("SUPERTAG_CLIENT_KEY_FILE")
            {
                issues.push(format!(
                    "{file}: set both SUPERTAG_CLIENT_CERT_FILE and SUPERTAG_CLIENT_KEY_FILE, or neither"
                ));
            }
        }
        if gateway("SUPERTAG_TLS_CERT_FILE").is_some() || gateway("SUPERTAG_TLS_KEY_FILE").is_some()
        {
            issues.push(format!(
                "{GATEWAY_FILE}: the Gateway listens on loopback and serves no TLS"
            ));
        }
    }
    if let Some(postgres) = &files.postgres {
        for key in POSTGRES_KEYS {
            if !postgres.contains_key(key) {
                issues.push(format!("{POSTGRES_FILE}: Missing {key}"));
            }
        }
    }
    if issues.is_empty() {
        Ok(())
    } else {
        bail!(issues.join("\n"))
    }
}

fn postgres_url(url: &str) -> bool {
    (url.starts_with("postgres://") || url.starts_with("postgresql://"))
        && url.split_once("://").is_some_and(|(_, rest)| {
            !rest.is_empty() && !rest.starts_with('/') && !rest.chars().any(char::is_whitespace)
        })
}

fn strong_token(token: &str) -> bool {
    token.len() >= 32
        && token.len() <= 512
        && token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-._~+/".contains(&byte))
}

/// An `https://host[:port]` origin, optionally with a path, and never with credentials, query,
/// or fragment.
fn https_origin(value: &str, path_allowed: bool) -> bool {
    origin(value, "https://", path_allowed)
}

/// A Control Plane URL `verify deployment` accepts: an `https://` origin for native gRPC, or a
/// `wss://` origin for a Control Plane behind an HTTP-only platform edge.
fn control_plane_origin(value: &str) -> bool {
    origin(value, "https://", false) || origin(value, "wss://", false)
}

fn origin(value: &str, scheme: &str, path_allowed: bool) -> bool {
    let Some(rest) = value.strip_prefix(scheme) else {
        return false;
    };
    let (authority, path) = match rest.find('/') {
        Some(index) => rest.split_at(index),
        None => (rest, ""),
    };
    !authority.is_empty()
        && !authority.contains('@')
        && authority
            .parse::<tonic::codegen::http::uri::Authority>()
            .is_ok()
        && !value.contains(['?', '#'])
        && !value.chars().any(|c| c.is_whitespace() || c.is_control())
        && (path_allowed || path.is_empty() || path == "/")
}

/// One `KEY=VALUE` per line. Values that need quoting are single-quoted, which Docker Compose,
/// `fly secrets import`, and Railway all read literally. A single quote cannot appear inside
/// such a value, and the double-quoted form is never written because Compose expands `$` and
/// backslash escapes inside it; nothing in a value is ever evaluated.
pub fn serialize(environment: &Environment) -> Result<String> {
    let mut output = String::new();
    for (key, value) in environment {
        ensure!(
            !value.contains(['\r', '\n', '\0', '\'']),
            "{key} cannot be represented in a deployment environment file; it contains a line break or a single quote (percent-encode a quote in a URL as %27)"
        );
        if plain(value) {
            output.push_str(&format!("{key}={value}\n"));
        } else {
            output.push_str(&format!("{key}='{value}'\n"));
        }
    }
    Ok(output)
}

/// A value Compose reads unchanged without quotes.
fn plain(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-._~+/:@%?&=,[]".contains(&byte))
}

/// Parses what `serialize` writes, plus blank lines and `#` comments. Anything Compose would
/// change on the way to a container is refused: double quotes, and `$`, quotes, or spaces in an
/// unquoted value. Errors name the line or key, never a value.
pub fn parse(text: &str) -> Result<Environment> {
    let mut environment = Environment::new();
    for (index, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (key, value) = line
            .split_once('=')
            .with_context(|| format!("line {} is not KEY=VALUE", index + 1))?;
        ensure!(
            !key.is_empty()
                && key
                    .bytes()
                    .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_'),
            "line {} has an invalid key",
            index + 1
        );
        let value = match value.as_bytes() {
            [b'\'', inner @ .., b'\''] if value.len() >= 2 => {
                ensure!(!inner.contains(&b'\''), "{key} has a stray single quote");
                &value[1..value.len() - 1]
            }
            [b'"', ..] => bail!(
                "{key} is double-quoted; use single quotes, because Compose expands $ and escapes inside double quotes"
            ),
            [b'\'', ..] => bail!("{key} has an unterminated quote"),
            _ => {
                ensure!(
                    value.is_empty() || plain(value),
                    "{key} must be single-quoted; it contains characters Compose would change"
                );
                value
            }
        };
        ensure!(
            environment
                .insert(key.to_owned(), value.to_owned())
                .is_none(),
            "{key} appears more than once"
        );
    }
    Ok(environment)
}

fn write_directory(directory: &Path, files: &Files) -> Result<()> {
    // Serialize first so an unrepresentable value leaves no directory behind.
    let mut contents = vec![
        (CONTROL_PLANE_FILE, serialize(&files.control_plane)?),
        (GATEWAY_FILE, serialize(&files.gateway)?),
        (OPERATOR_FILE, serialize(&files.operator)?),
    ];
    if let Some(postgres) = &files.postgres {
        contents.push((POSTGRES_FILE, serialize(postgres)?));
    }
    fs::DirBuilder::new()
        .mode(0o700)
        .create(directory)
        .with_context(|| {
            format!(
                "create {}; setup never replaces an existing directory",
                directory.display()
            )
        })?;
    for (name, text) in contents {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(directory.join(name))
            .with_context(|| format!("create {name}"))?;
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
    }
    fs::File::open(directory)?.sync_all()?;
    Ok(())
}

fn read_private(path: &Path) -> Result<Environment> {
    let metadata =
        fs::symlink_metadata(path).with_context(|| format!("read {}", path.display()))?;
    ensure!(
        metadata.is_file() && metadata.permissions().mode() & 0o077 == 0,
        "{} must be a private regular file (mode 0600)",
        path.display()
    );
    let text = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    parse(&text).with_context(|| format!("parse {}", path.display()))
}

pub fn read_directory(platform: Platform, directory: &Path) -> Result<Files> {
    let postgres = directory.join(POSTGRES_FILE);
    let files = Files {
        control_plane: read_private(&directory.join(CONTROL_PLANE_FILE))?,
        gateway: read_private(&directory.join(GATEWAY_FILE))?,
        operator: read_private(&directory.join(OPERATOR_FILE))?,
        postgres: match fs::symlink_metadata(&postgres) {
            Ok(_) => Some(read_private(&postgres)?),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(error).context("inspect postgres.env"),
        },
    };
    if files.postgres.is_some() {
        ensure!(
            platform == Platform::Compose,
            "postgres.env is only used by Compose"
        );
    }
    validate(platform, &files)?;
    Ok(files)
}

fn prompt(key: &str) -> Result<String> {
    let secret = SECRET_KEYS.contains(&key);
    out!("{key}: ");
    let echo = secret.then(EchoOff::new).transpose()?;
    let mut line = String::new();
    let read = io::stdin().lock().read_line(&mut line)?;
    drop(echo);
    if secret {
        outln!();
    }
    ensure!(read > 0, "setup stopped: no value was given for {key}");
    let value = line.trim().to_owned();
    ensure!(!value.is_empty(), "{key} must be nonempty");
    Ok(value)
}

/// Disables terminal echo for a masked answer and restores it when dropped.
struct EchoOff(libc::termios);

impl EchoOff {
    fn new() -> Result<Self> {
        // SAFETY: termios is plain data filled by tcgetattr on the standard input descriptor.
        let mut saved: libc::termios = unsafe { std::mem::zeroed() };
        ensure!(
            unsafe { libc::tcgetattr(libc::STDIN_FILENO, &mut saved) } == 0,
            "read terminal settings"
        );
        let mut quiet = saved;
        quiet.c_lflag &= !libc::ECHO;
        // SAFETY: applies a copy of the settings just read, with echo cleared.
        ensure!(
            unsafe { libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, &quiet) } == 0,
            "disable terminal echo"
        );
        Ok(Self(saved))
    }
}

impl Drop for EchoOff {
    fn drop(&mut self) {
        // SAFETY: restores the settings saved in `new`.
        unsafe {
            libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, &self.0);
        }
    }
}

/// An invalid but well-formed bearer value: the Control Plane must refuse it as a Worker Host.
const INVALID_HOST_CREDENTIAL: &str = "supertag-deployment-verification-invalid-credential";

pub async fn verify(command: VerifyCommand) -> Result<()> {
    let VerifyCommand::Deployment(args) = command;
    ensure!(
        control_plane_origin(&args.url),
        "Deployment URL must be an https:// or wss:// origin without credentials, path, query, or fragment"
    );
    let token = match &args.env_file {
        Some(path) => {
            let environment = read_private(path)?;
            for key in environment.keys() {
                ensure!(
                    OPERATOR_KEYS.contains(&key.as_str()),
                    "Unknown key in the verification env file: {key}"
                );
            }
            environment.get("SUPERTAG_OPERATOR_TOKEN").cloned()
        }
        None => std::env::var("SUPERTAG_OPERATOR_TOKEN").ok(),
    }
    .filter(|token| !token.trim().is_empty())
    .context("SUPERTAG_OPERATOR_TOKEN is required")?;
    let origin = args.url.trim_end_matches('/').to_owned();
    // The Control Plane refuses operator calls that skip protocol negotiation.
    let channel = crate::network::operator_channel(
        &crate::network::operator_endpoint(origin, Duration::from_secs(15), None).await?,
    )
    .await
    .context("could not reach the Control Plane over TLS; check the URL, its certificate, and SUPERTAG_SERVER_CA_FILE (a wss:// URL also needs the platform edge to forward the WebSocket upgrade)")?;
    out!(
        "{}",
        verify_channel(channel, &token, args.require_ready).await?
    );
    Ok(())
}

/// The verification steps over a connected channel. Each failure names what failed.
pub async fn verify_channel(
    channel: supertag_protocol::negotiation::ProtocolChannel,
    token: &str,
    require_ready: bool,
) -> Result<String> {
    let health = HealthClient::new(channel.clone())
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .check(HealthCheckRequest {
            service: "supertag.runtime.v2.Operator".into(),
        })
        .await
        .map(|response| response.into_inner().status);
    ensure!(
        matches!(health, Ok(status) if status == ServingStatus::Serving as i32),
        "Control Plane health check failed"
    );
    let operator = || {
        OperatorClient::new(channel.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    };
    let mut anonymous = Request::new(ListHostsRequest {
        limit: 1,
        cursor: String::new(),
    });
    anonymous.set_timeout(Duration::from_secs(15));
    match operator().list_hosts(anonymous).await {
        Err(status) if status.code() == Code::Unauthenticated => {}
        _ => bail!("Control Plane did not reject an anonymous operator request"),
    }
    let mut probe =
        authenticated_request(ReportHostRequest::default(), INVALID_HOST_CREDENTIAL, None)?;
    probe.set_timeout(Duration::from_secs(15));
    match WorkerHostClient::new(channel.clone())
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .report_host(probe)
        .await
    {
        Err(status) if status.code() == Code::Unauthenticated => {}
        Err(status) => bail!("Worker Host credential check failed ({:?})", status.code()),
        Ok(_) => bail!("Control Plane accepted an invalid Worker Host credential"),
    }
    // An authenticated read reaches the Control Plane's state.
    let mut ready = 0usize;
    let mut cursor = String::new();
    for _ in 0..64 {
        let mut request = authenticated_request(
            ListHostsRequest {
                limit: 100,
                cursor: cursor.clone(),
            },
            token,
            None,
        )?;
        request.set_timeout(Duration::from_secs(15));
        let page = operator()
            .list_hosts(request)
            .await
            .map_err(|status| {
                anyhow::anyhow!(
                    "Control Plane operator authentication failed ({:?})",
                    status.code()
                )
            })?
            .into_inner();
        ready += page
            .hosts
            .iter()
            .filter(|host| {
                !host.draining && matches!(host.phase(), HostPhase::Ready | HostPhase::Busy)
            })
            .count();
        if page.next_cursor.is_empty() {
            break;
        }
        cursor = page.next_cursor;
    }
    ensure!(
        ready > 0 || !require_ready,
        "Readiness check failed: no Worker Host is ready"
    );
    Ok(format!(
        "Control Plane health, anonymous and invalid Worker Host credential rejection, and operator authentication passed. Readiness: {}.\n",
        if ready > 0 {
            format!(
                "ready ({ready} Worker Host{})",
                if ready == 1 { "" } else { "s" }
            )
        } else {
            "not ready; enroll a Worker Host and inspect `supertag get hosts`".into()
        }
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    const DATABASE: &str = "postgresql://test:private-password@database.example.com/supertag";

    fn supplied(values: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let values: BTreeMap<String, String> = values
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect();
        move |key| values.get(key).cloned()
    }

    fn refuse(key: &str) -> Result<String> {
        bail!("Missing {key}")
    }

    fn configured(platform: Platform, values: &[(&str, &str)]) -> Result<Files> {
        configure(platform, &supplied(values), &mut refuse)
    }

    /// The values each platform needs from the operator: a database URL unless the platform
    /// supplies it, and Vault where the file credential vault has no reliable disk.
    fn minimal(platform: Platform) -> Vec<(&'static str, &'static str)> {
        let mut values = Vec::new();
        if !platform.database_from_platform() {
            values.push(("SUPERTAG_DATABASE_URL", DATABASE));
        }
        if platform.requires_vault() {
            values.extend([
                ("VAULT_ADDR", "https://vault.example.com"),
                ("VAULT_TOKEN", "private-vault-token"),
            ]);
        }
        values
    }

    #[test]
    fn every_platform_shares_one_role_contract() -> Result<()> {
        for platform in Platform::ALL {
            let files = configured(platform, &minimal(platform))?;
            assert_eq!(
                files.control_plane.get("SUPERTAG_DATABASE_URL").cloned(),
                (!platform.database_from_platform()).then(|| DATABASE.to_owned()),
                "{platform:?}"
            );
            assert_eq!(
                files.control_plane["SUPERTAG_GATEWAY_TOKEN"],
                files.gateway["SUPERTAG_GATEWAY_TOKEN"]
            );
            assert_eq!(
                files.operator["SUPERTAG_OPERATOR_TOKEN"],
                files.control_plane["SUPERTAG_OPERATOR_TOKEN"]
            );
            assert_ne!(
                files.control_plane["SUPERTAG_OPERATOR_TOKEN"],
                files.control_plane["SUPERTAG_GATEWAY_TOKEN"]
            );
            // A Gateway never holds an operator credential.
            assert!(!files.gateway.contains_key("SUPERTAG_OPERATOR_TOKEN"));
            assert_eq!(
                files.gateway["SUPERTAG_CREDENTIAL_VAULT"],
                if platform.requires_vault() {
                    "vault"
                } else {
                    "file"
                }
            );
            assert_eq!(files.gateway["SUPERTAG_STATE_DIR"], STATE_DIRECTORY);
            assert_eq!(files.control_plane["SUPERTAG_STATE_DIR"], STATE_DIRECTORY);
            // Role separation: only the Control Plane holds the database credential, and only
            // the Gateway holds surface credentials.
            assert!(!files.gateway.contains_key("SUPERTAG_DATABASE_URL"));
            assert!(
                !files
                    .control_plane
                    .contains_key("SUPERTAG_CREDENTIAL_VAULT")
            );
            assert!(files.postgres.is_none());
            // Client certificates are an optional filter, never generated by setup.
            assert!(
                !files
                    .control_plane
                    .contains_key("SUPERTAG_TLS_CLIENT_CA_FILE")
            );
            assert_eq!(
                files.control_plane.contains_key("SUPERTAG_TLS_CERT_FILE"),
                platform == Platform::Compose
            );
        }
        Ok(())
    }

    #[test]
    fn compose_generates_its_database_and_supplied_tokens_are_kept() -> Result<()> {
        let token = "a".repeat(40);
        let files = configured(
            Platform::Compose,
            &[
                ("SUPERTAG_GATEWAY_TOKEN", &token),
                ("SUPERTAG_OPERATOR_PRINCIPAL", "operator:ops"),
            ],
        )?;
        let postgres = files.postgres.as_ref().context("postgres.env")?;
        assert_eq!(
            files.control_plane["SUPERTAG_DATABASE_URL"],
            format!(
                "postgresql://supertag:{}@postgres:5432/supertag",
                postgres["POSTGRES_PASSWORD"]
            )
        );
        assert_eq!(files.gateway["SUPERTAG_GATEWAY_TOKEN"], token);
        assert_eq!(files.gateway["SUPERTAG_OPERATOR_PRINCIPAL"], "operator:ops");
        assert_eq!(
            files.control_plane["SUPERTAG_OPERATOR_PRINCIPAL"],
            "operator:ops"
        );
        assert_eq!(
            files.control_plane["SUPERTAG_TLS_CERT_FILE"],
            "/run/supertag-tls/server.pem"
        );
        assert_eq!(
            files.gateway["SUPERTAG_SERVER_CA_FILE"],
            "/run/supertag-tls/server-ca.pem"
        );
        assert!(!files.gateway.contains_key("SUPERTAG_TLS_CERT_FILE"));
        Ok(())
    }

    #[test]
    fn hosted_platforms_require_a_database_and_vault_values() {
        for platform in [Platform::Fly, Platform::Railway] {
            let error = configured(platform, &[]).unwrap_err().to_string();
            assert_eq!(error, "Missing SUPERTAG_DATABASE_URL");
            let error = configured(
                platform,
                &[
                    ("SUPERTAG_DATABASE_URL", DATABASE),
                    ("SUPERTAG_CREDENTIAL_VAULT", "vault"),
                ],
            )
            .unwrap_err()
            .to_string();
            assert_eq!(error, "Missing VAULT_ADDR");
        }
        let files = configured(
            Platform::Fly,
            &[
                ("SUPERTAG_DATABASE_URL", DATABASE),
                ("SUPERTAG_CREDENTIAL_VAULT", "vault"),
                ("VAULT_ADDR", "https://vault.example.com"),
                ("VAULT_TOKEN", "private-vault-token"),
                ("SUPERTAG_VAULT_MOUNT", "kv"),
            ],
        )
        .unwrap();
        assert_eq!(files.gateway["SUPERTAG_VAULT_MOUNT"], "kv");
    }

    #[test]
    fn http_only_platforms_take_the_database_and_vault_their_disks_allow() -> Result<()> {
        // Render's Blueprint supplies the database URL, so setup refuses one and check refuses
        // a file that names one.
        let error = configured(Platform::Render, &[("SUPERTAG_DATABASE_URL", DATABASE)])
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("Render's Blueprint sets SUPERTAG_DATABASE_URL"),
            "{error}"
        );
        assert!(!error.contains("private-password"), "{error}");
        let mut files = configured(Platform::Render, &[])?;
        assert_eq!(files.gateway["SUPERTAG_CREDENTIAL_VAULT"], "file");
        files
            .control_plane
            .insert("SUPERTAG_DATABASE_URL".into(), DATABASE.into());
        let error = validate(Platform::Render, &files).unwrap_err().to_string();
        assert!(
            error.contains("SUPERTAG_DATABASE_URL is set by the render definition"),
            "{error}"
        );
        assert!(!error.contains("private-password"), "{error}");
        // The same file set is valid where the operator supplies the database.
        validate(Platform::Fly, &files)?;
        // Cloudflare and Modal default to Vault and refuse the file credential vault.
        for platform in [Platform::Cloudflare, Platform::Modal] {
            let error = configured(platform, &[("SUPERTAG_DATABASE_URL", DATABASE)])
                .unwrap_err()
                .to_string();
            assert_eq!(error, "Missing VAULT_ADDR", "{platform:?}");
            let error = configured(
                platform,
                &[
                    ("SUPERTAG_DATABASE_URL", DATABASE),
                    ("SUPERTAG_CREDENTIAL_VAULT", "file"),
                ],
            )
            .unwrap_err()
            .to_string();
            assert!(
                error.contains("has no disk the file credential vault can rely on"),
                "{error}"
            );
            let files = configured(platform, &minimal(platform))?;
            assert_eq!(files.gateway["VAULT_ADDR"], "https://vault.example.com");
            assert!(!files.control_plane.contains_key("VAULT_TOKEN"));
            // Hosted TLS still arrives as PEM secrets.
            assert!(
                !files
                    .control_plane
                    .keys()
                    .any(|key| TLS_KEYS.contains(&key.as_str()))
            );
        }
        Ok(())
    }

    #[test]
    fn rejects_unsafe_values_without_echoing_them() {
        for (key, value, message) in [
            (
                "SUPERTAG_DATABASE_URL",
                "private-secret",
                "SUPERTAG_DATABASE_URL must be a PostgreSQL URL",
            ),
            (
                "SUPERTAG_DATABASE_URL",
                "sqlite:///tmp/private-secret.db",
                "hosted deployments require PostgreSQL",
            ),
            (
                "SUPERTAG_GATEWAY_TOKEN",
                "private-short",
                "SUPERTAG_GATEWAY_TOKEN must be at least 32 characters",
            ),
            (
                "SUPERTAG_CREDENTIAL_VAULT",
                "private-typo",
                "SUPERTAG_CREDENTIAL_VAULT must be file or vault",
            ),
            (
                "SUPERTAG_OPERATOR_PRINCIPAL",
                "private-admin",
                "SUPERTAG_OPERATOR_PRINCIPAL must be operator:NAME",
            ),
        ] {
            let mut values = vec![("SUPERTAG_DATABASE_URL", DATABASE)];
            values.retain(|(name, _)| *name != key);
            values.push((key, value));
            let error = configured(Platform::Railway, &values)
                .unwrap_err()
                .to_string();
            assert!(error.contains(message), "{error}");
            assert!(!error.contains("private-"), "{error}");
        }
        let error = configured(
            Platform::Fly,
            &[
                ("SUPERTAG_DATABASE_URL", DATABASE),
                ("SUPERTAG_CREDENTIAL_VAULT", "vault"),
                ("VAULT_ADDR", "http://user:private-pass@vault.example.com"),
                ("VAULT_TOKEN", "private-vault-token"),
            ],
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("VAULT_ADDR must be an HTTPS URL"), "{error}");
        assert!(!error.contains("private-"), "{error}");
        let same = "b".repeat(40);
        let error = configured(
            Platform::Fly,
            &[
                ("SUPERTAG_DATABASE_URL", DATABASE),
                ("SUPERTAG_GATEWAY_TOKEN", &same),
                ("SUPERTAG_OPERATOR_TOKEN", &same),
            ],
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("must differ"), "{error}");
    }

    #[test]
    fn checks_keys_per_role_and_platform() -> Result<()> {
        let mut files = configured(Platform::Compose, &[("SUPERTAG_DATABASE_URL", DATABASE)])?;
        // A Compose file set is not a hosted one: hosted TLS comes from _PEM secrets.
        let error = validate(Platform::Fly, &files).unwrap_err().to_string();
        assert!(
            error.contains("SUPERTAG_TLS_CERT_FILE is set by the hosted entrypoint"),
            "{error}"
        );
        files
            .gateway
            .insert("SUPERTAG_DATABASE_URL".into(), DATABASE.into());
        files
            .control_plane
            .remove("SUPERTAG_TLS_CERT_FILE")
            .context("server certificate")?;
        files
            .gateway
            .insert("SUPERTAG_TLS_CERT_FILE".into(), "relative.pem".into());
        let error = validate(Platform::Compose, &files).unwrap_err().to_string();
        for expected in [
            "gateway.env: unknown deployment environment key SUPERTAG_DATABASE_URL",
            "control-plane.env: Missing SUPERTAG_TLS_CERT_FILE",
            "gateway.env: SUPERTAG_TLS_CERT_FILE must name an absolute mounted file",
        ] {
            assert!(error.contains(expected), "{expected}: {error}");
        }
        let mut files = configured(Platform::Fly, &[("SUPERTAG_DATABASE_URL", DATABASE)])?;
        files
            .operator
            .insert("SUPERTAG_OPERATOR_TOKEN".into(), "c".repeat(40));
        files
            .control_plane
            .insert("SUPERTAG_GATEWAY_TOKEN".into(), "d".repeat(40));
        let error = validate(Platform::Fly, &files).unwrap_err().to_string();
        assert!(
            error.contains("SUPERTAG_GATEWAY_TOKEN differs between the Control Plane and Gateway")
        );
        assert!(error.contains("operator.env: SUPERTAG_OPERATOR_TOKEN differs"));
        files.postgres = Some(Environment::new());
        assert!(validate(Platform::Fly, &files).is_err());
        Ok(())
    }

    #[test]
    fn round_trips_shell_metacharacters_without_evaluating_them() -> Result<()> {
        let environment = Environment::from([
            ("ONE".into(), "a$HOME`cmd`${X}\\n".into()),
            ("TWO".into(), "a\"b\\c d".into()),
            ("THREE".into(), "#comment=not-a-comment".into()),
            (
                "FOUR".into(),
                "postgresql://u:p@db:5432/supertag?sslmode=require".into(),
            ),
            ("FIVE".into(), String::new()),
        ]);
        let text = serialize(&environment)?;
        assert!(text.contains("FOUR=postgresql://u:p@db:5432/supertag?sslmode=require\n"));
        // Only the literal single-quoted form; Compose expands double-quoted values.
        assert!(text.contains("ONE='a$HOME`cmd`${X}\\n'\n"), "{text}");
        assert!(!text.contains("=\""), "{text}");
        assert_eq!(parse(&text)?, environment);
        for value in ["injected\nBAD=1", "p'$HOME"] {
            let error = serialize(&Environment::from([("TOKEN".into(), value.into())]))
                .unwrap_err()
                .to_string();
            assert!(
                error.starts_with("TOKEN cannot be represented in a deployment environment file"),
                "{error}"
            );
            assert!(!error.contains("HOME") && !error.contains("BAD"), "{error}");
        }
        assert!(parse("A=1\nA=2\n").is_err());
        assert!(parse("lower=1\n").is_err());
        assert!(parse("A='open\n").is_err());
        assert!(parse("A='a'b'\n").is_err());
        for (text, message) in [
            ("A=\"x'y$HOME\"\n", "A is double-quoted"),
            ("A=p$HOME\n", "A must be single-quoted"),
            ("A=two words\n", "A must be single-quoted"),
        ] {
            let error = parse(text).unwrap_err().to_string();
            assert!(error.contains(message), "{error}");
            assert!(!error.contains("HOME"), "{error}");
        }
        Ok(())
    }

    #[test]
    fn deployment_urls_are_https_origins() {
        for url in [
            "https://supertag.example.com",
            "https://supertag.example.com/",
            "https://127.0.0.1:8443",
            "https://[::1]:8443",
        ] {
            assert!(https_origin(url, false), "{url}");
        }
        for url in [
            "http://supertag.example.com",
            "https://user:secret@supertag.example.com",
            "https://supertag.example.com/path",
            "https://supertag.example.com?query",
            "https://supertag.example.com#fragment",
            "https://",
            "supertag.example.com",
        ] {
            assert!(!https_origin(url, false), "{url}");
        }
        assert!(https_origin("https://vault.example.com/v1", true));
        // `verify deployment` also takes a wss:// origin behind an HTTP-only platform edge.
        for url in [
            "https://supertag.example.com",
            "wss://supertag-control-plane.onrender.com",
            "wss://workspace--supertag.modal.run/",
            "wss://127.0.0.1:8443",
        ] {
            assert!(control_plane_origin(url), "{url}");
        }
        for url in [
            "ws://127.0.0.1:8443",
            "http://supertag.example.com",
            "wss://user:secret@supertag.example.com",
            "wss://supertag.example.com/tunnel",
            "wss://supertag.example.com?query",
            "wss://",
        ] {
            assert!(!control_plane_origin(url), "{url}");
        }
    }

    /// How a fake Control Plane answers each verification step, to show that `verify deployment`
    /// fails closed. `None` health means an HTTPS edge that is not a gRPC service at all.
    #[derive(Clone, Copy)]
    struct Fake {
        health: Option<ServingStatus>,
        anonymous_operator: Code,
        invalid_host: Code,
        operator: Code,
    }

    const SAFE: Fake = Fake {
        health: Some(ServingStatus::Serving),
        anonymous_operator: Code::Unauthenticated,
        invalid_host: Code::Unauthenticated,
        operator: Code::Ok,
    };

    /// A unary gRPC reply: one message when `code` is OK, then the status trailer.
    fn grpc_reply(code: Code, message: Vec<u8>) -> axum::response::Response {
        use axum::{
            body::{Body, Bytes},
            http::{HeaderMap, HeaderValue},
        };
        let mut frames = Vec::new();
        if code == Code::Ok {
            let mut data = vec![0];
            data.extend(u32::try_from(message.len()).unwrap().to_be_bytes());
            data.extend(message);
            frames.push(http_body::Frame::data(Bytes::from(data)));
        }
        let mut trailers = HeaderMap::new();
        trailers.insert("grpc-status", HeaderValue::from(code as i32));
        frames.push(http_body::Frame::trailers(trailers));
        let body = http_body_util::StreamBody::new(futures_util::stream::iter(
            frames.into_iter().map(Ok::<_, std::convert::Infallible>),
        ));
        axum::response::Response::builder()
            .header("content-type", "application/grpc")
            .body(Body::new(body))
            .unwrap()
    }

    async fn fake_answer(
        fake: Fake,
        seen: std::sync::Arc<std::sync::Mutex<Vec<(String, String)>>>,
        request: axum::extract::Request,
    ) -> axum::response::Response {
        use axum::response::IntoResponse;
        use prost::Message;
        use supertag_protocol::v2::{ListHostsResponse, WorkerHostStatus};
        use tonic_health::pb::HealthCheckResponse;
        let path = request.uri().path().to_owned();
        let authorization = request
            .headers()
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_owned();
        seen.lock()
            .unwrap()
            .push((path.clone(), authorization.clone()));
        let Some(health) = fake.health else {
            return (
                axum::http::StatusCode::UNAUTHORIZED,
                "edge authentication required",
            )
                .into_response();
        };
        match path.as_str() {
            "/grpc.health.v1.Health/Check" => grpc_reply(
                Code::Ok,
                HealthCheckResponse {
                    status: health as i32,
                }
                .encode_to_vec(),
            ),
            "/supertag.runtime.v2.Operator/ListHosts" => grpc_reply(
                if authorization.is_empty() {
                    fake.anonymous_operator
                } else {
                    fake.operator
                },
                ListHostsResponse::default().encode_to_vec(),
            ),
            "/supertag.runtime.v2.WorkerHost/ReportHost" => grpc_reply(
                fake.invalid_host,
                WorkerHostStatus::default().encode_to_vec(),
            ),
            _ => grpc_reply(Code::Unimplemented, Vec::new()),
        }
    }

    /// Runs `verify_channel` against a loopback fake Control Plane and returns its outcome and the
    /// requests the fake received.
    async fn verify_against(fake: Fake) -> Result<(Result<String>, Vec<(String, String)>)> {
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let recorded = seen.clone();
        let router = axum::Router::new().fallback(move |request: axum::extract::Request| {
            fake_answer(fake, recorded.clone(), request)
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        let server = tokio::spawn(
            tonic::transport::Server::builder()
                .add_routes(tonic::service::Routes::from(router))
                .serve_with_incoming(tokio_stream::wrappers::TcpListenerStream::new(listener)),
        );
        let channel = tonic::transport::Channel::from_shared(format!("http://{address}"))?
            .connect()
            .await?;
        let channel = supertag_protocol::negotiation::bind_current(channel);
        let outcome = verify_channel(channel, &"t".repeat(40), false).await;
        server.abort();
        let seen = seen.lock().unwrap().clone();
        Ok((outcome, seen))
    }

    #[tokio::test]
    async fn verification_fails_closed_for_an_unsafe_or_broken_control_plane() -> Result<()> {
        let (outcome, seen) = verify_against(SAFE).await?;
        assert!(
            outcome?.contains("anonymous and invalid Worker Host credential rejection"),
            "safe Control Plane"
        );
        assert_eq!(
            seen,
            [
                ("/grpc.health.v1.Health/Check".into(), String::new()),
                (
                    "/supertag.runtime.v2.Operator/ListHosts".into(),
                    String::new()
                ),
                (
                    "/supertag.runtime.v2.WorkerHost/ReportHost".into(),
                    format!("Bearer {INVALID_HOST_CREDENTIAL}")
                ),
                (
                    "/supertag.runtime.v2.Operator/ListHosts".into(),
                    format!("Bearer {}", "t".repeat(40))
                ),
            ]
        );
        for (fake, expected) in [
            (
                Fake {
                    health: None,
                    ..SAFE
                },
                "Control Plane health check failed",
            ),
            (
                Fake {
                    health: Some(ServingStatus::NotServing),
                    ..SAFE
                },
                "Control Plane health check failed",
            ),
            (
                Fake {
                    anonymous_operator: Code::Ok,
                    ..SAFE
                },
                "Control Plane did not reject an anonymous operator request",
            ),
            // Refusing anonymous calls for another reason is not proof of authentication.
            (
                Fake {
                    anonymous_operator: Code::Unavailable,
                    ..SAFE
                },
                "Control Plane did not reject an anonymous operator request",
            ),
            (
                Fake {
                    invalid_host: Code::Ok,
                    ..SAFE
                },
                "Control Plane accepted an invalid Worker Host credential",
            ),
            (
                Fake {
                    invalid_host: Code::Unavailable,
                    ..SAFE
                },
                "Worker Host credential check failed (Unavailable)",
            ),
            (
                Fake {
                    invalid_host: Code::PermissionDenied,
                    ..SAFE
                },
                "Worker Host credential check failed (PermissionDenied)",
            ),
            (
                Fake {
                    operator: Code::Unauthenticated,
                    ..SAFE
                },
                "Control Plane operator authentication failed (Unauthenticated)",
            ),
        ] {
            let (outcome, _) = verify_against(fake).await?;
            let error = outcome.err().map(|error| error.to_string());
            assert!(
                error
                    .as_deref()
                    .is_some_and(|error| error.starts_with(expected)),
                "{expected}: {error:?}"
            );
        }
        Ok(())
    }

    /// The checked-in definitions must agree with the values setup and check use.
    #[test]
    fn platform_definitions_match_the_role_contract() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../deploy");
        let read = |path: &str| {
            fs::read_to_string(root.join(path)).unwrap_or_else(|error| panic!("{path}: {error}"))
        };
        let fly_control = read("native/fly/control-plane.toml");
        let fly_gateway = read("native/fly/gateway.toml");
        let railway_control = read("native/railway/control-plane.json");
        let railway_gateway = read("native/railway/gateway.json");
        let compose = read("compose.native.yaml");
        let ingress = read("compose.native.ingress.yaml");
        let entrypoint = read("docker/rust-hosted-entrypoint.sh");
        let dockerfile = read("docker/rust-service.Dockerfile");

        let listen_control = format!(
            "control-plane --listen [::]:{CONTROL_PLANE_PORT} --transfer-directory {STATE_DIRECTORY}/transfers"
        );
        let listen_gateway = format!("gateway --listen {GATEWAY_LISTEN}");
        for (platform, control, gateway) in [
            (Platform::Fly, &fly_control, &fly_gateway),
            (Platform::Railway, &railway_control, &railway_gateway),
        ] {
            let upstream = format!("--control-plane {}", platform.gateway_upstream());
            assert!(control.contains(&listen_control), "{platform:?}");
            assert!(gateway.contains(&listen_gateway), "{platform:?}");
            assert!(gateway.contains(&upstream), "{platform:?}");
        }
        // Fly: the Control Plane is public and passes raw TLS through; the Gateway has no
        // public service.
        assert!(fly_control.contains(&format!("internal_port = {CONTROL_PLANE_PORT}")));
        assert!(fly_control.contains("handlers = []"));
        assert!(!fly_control.contains("http_service") && !fly_control.contains("\"tls\""));
        assert!(fly_control.contains(&format!("destination = \"{STATE_DIRECTORY}\"")));
        assert!(!fly_gateway.contains("[[services]]") && !fly_gateway.contains("http_service"));
        assert!(fly_gateway.contains(&format!("destination = \"{STATE_DIRECTORY}\"")));
        // Railway: the start command replaces the image entrypoint, so it names it.
        for definition in [&railway_control, &railway_gateway] {
            assert!(definition.contains("/usr/local/bin/supertag-hosted-entrypoint"));
            assert!(!definition.contains("healthcheckPath"));
        }
        // The hosted entrypoint writes exactly the files setup and Compose name.
        for (key, name) in [
            ("TLS_CERT", "server.pem"),
            ("TLS_KEY", "server.key"),
            ("TLS_CLIENT_CA", "client-ca.pem"),
            ("SERVER_CA", "server-ca.pem"),
            ("CLIENT_CERT", "client.pem"),
            ("CLIENT_KEY", "client.key"),
        ] {
            assert!(
                entrypoint.contains(&format!("{key} {name}")),
                "{key} -> {name}"
            );
        }
        assert!(entrypoint.contains(TLS_DIRECTORY));
        assert!(dockerfile.contains("AS hosted"));
        // The image's default commands are the Compose commands: a public Control Plane and a
        // Gateway that only dials it.
        for (stage, command) in [
            (
                "AS control-plane",
                format!(
                    "[\"control-plane\", \"--listen\", \"0.0.0.0:{CONTROL_PLANE_PORT}\", \"--transfer-directory\", \"{STATE_DIRECTORY}/transfers\"]"
                ),
            ),
            (
                "AS gateway",
                format!(
                    "[\"gateway\", \"--listen\", \"{GATEWAY_LISTEN}\", \"--control-plane\", \"https://control-plane:{CONTROL_PLANE_PORT}\"]"
                ),
            ),
        ] {
            let stage = &dockerfile[dockerfile.find(stage).expect(stage)..];
            let stage = &stage[..stage[1..]
                .find("\nFROM ")
                .map_or(stage.len(), |end| end + 1)];
            assert!(stage.contains(&format!("CMD {command}")), "{stage}");
            assert!(
                compose.contains(&format!("command: {command}")),
                "{command}"
            );
        }
        let gateway_stage = &dockerfile[dockerfile.find("AS gateway").expect("gateway stage")..];
        assert!(
            !gateway_stage[..gateway_stage.find("\nFROM ").unwrap_or(gateway_stage.len())]
                .contains("EXPOSE")
        );
        // Compose: the private network publishes nothing; only the ingress override does. The
        // Gateway runs only with its profile.
        assert!(compose.contains(&format!("target: {TLS_DIRECTORY}")));
        assert!(!compose.contains("ports:"));
        assert!(compose.contains("profiles: [gateway]"));
        assert!(compose.contains(&format!(
            "\"--transfer-directory\", \"{STATE_DIRECTORY}/transfers\""
        )));
        // PostgreSQL is healthy only once it accepts TCP connections, not while its first-start
        // init server listens on the Unix socket alone; every service restarts after a failure.
        assert!(compose.contains("pg_isready -h 127.0.0.1 -p 5432"));
        assert_eq!(compose.matches("restart: unless-stopped").count(), 3);
        assert!(ingress.contains("ports:") && ingress.contains(&format!(":{CONTROL_PLANE_PORT}")));
        assert!(!ingress.contains("gateway:"));
    }

    /// The quoted strings of the array literal assigned to `name` in a Python or TypeScript
    /// definition, with the `ENTRYPOINT` constant expanded.
    fn command_literal(source: &str, name: &str) -> Vec<String> {
        let start = source
            .find(&format!("{name} = ["))
            .unwrap_or_else(|| panic!("{name}"));
        let body = &source[start..];
        let body = &body[body.find('[').unwrap() + 1..body.find(']').unwrap()];
        body.split(',')
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(|item| match item {
                "ENTRYPOINT" => "/usr/local/bin/supertag-hosted-entrypoint".to_owned(),
                quoted => quoted.trim_matches('"').to_owned(),
            })
            .collect()
    }

    #[test]
    fn http_only_platform_definitions_carry_the_tunnel() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../deploy");
        let read = |path: &str| {
            fs::read_to_string(root.join(path)).unwrap_or_else(|error| panic!("{path}: {error}"))
        };
        let render = read("render/render.yaml");
        let wrangler: serde_json::Value =
            serde_json::from_str(&read("cloudflare/wrangler.json")).unwrap();
        let routing = read("cloudflare/src/routing.ts");
        let worker = read("cloudflare/src/index.ts");
        let cloudflare_image = read("cloudflare/Dockerfile");
        let modal = read("modal/app.py");
        let pair = read("docker/rust-hosted-pair.sh");
        let entrypoint = read("docker/rust-hosted-entrypoint.sh");
        let dockerfile = read("docker/rust-service.Dockerfile");

        let hosted = "/usr/local/bin/supertag-hosted-entrypoint";
        // Native gRPC only on loopback; the platform reaches the tunnel listener alone.
        let control_plane = format!(
            "{hosted} control-plane --listen 127.0.0.1:{CONTROL_PLANE_PORT} --websocket-listen 0.0.0.0:{TUNNEL_PORT} --transfer-directory {STATE_DIRECTORY}/transfers"
        );
        let pair_command = format!("{hosted} pair 0.0.0.0:{TUNNEL_PORT}");

        // Render: a web service on the tunnel port with the health route, PostgreSQL from the
        // Blueprint, a disk for transfers, and a Gateway worker dialing the public wss:// URL.
        let commands: Vec<&str> = render
            .lines()
            .filter_map(|line| line.trim().strip_prefix("dockerCommand: "))
            .collect();
        assert_eq!(
            commands,
            [
                control_plane.as_str(),
                &format!(
                    "{hosted} gateway --listen {GATEWAY_LISTEN} --control-plane {}",
                    Platform::Render.gateway_upstream()
                ),
            ]
        );
        assert!(Platform::Render.gateway_upstream().starts_with("wss://"));
        for expected in [
            "type: web",
            "type: worker",
            "runtime: image",
            "healthCheckPath: /healthz",
            "- key: PORT\n        value: \"8080\"",
            "property: connectionString",
            "ipAllowList: []",
        ] {
            assert!(render.contains(expected), "{expected}");
        }
        assert_eq!(render.matches("healthCheckPath").count(), 1);
        assert_eq!(render.matches("numInstances: 1").count(), 2);
        assert_eq!(
            render
                .matches(&format!("mountPath: {STATE_DIRECTORY}"))
                .count(),
            2
        );
        assert!(!render.contains("SUPERTAG_GATEWAY_TOKEN") && !render.contains("_PEM"));
        assert_eq!(
            render.matches("@sha256:").count(),
            2,
            "images are pinned by digest"
        );

        // Cloudflare: one Container instance built from the hosted image, kept awake by cron,
        // running the Control Plane alone or the pair.
        let container = &wrangler["containers"][0];
        assert_eq!(container["max_instances"], 1);
        assert_eq!(container["image"], "./Dockerfile");
        assert_eq!(wrangler["vars"]["SUPERTAG_GATEWAY"], "off");
        // The Gateway's connector flags are the operator's; the Worker appends them to the pair.
        assert_eq!(wrangler["vars"]["SUPERTAG_GATEWAY_FLAGS"], "");
        assert!(routing.contains("[...PAIR_COMMAND, ...words]"));
        assert_eq!(wrangler["triggers"]["crons"][0], "* * * * *");
        assert!(cloudflare_image.contains("FROM supertag-hosted:local"));
        assert_eq!(
            command_literal(&routing, "CONTROL_PLANE_COMMAND").join(" "),
            control_plane
        );
        assert_eq!(
            command_literal(&routing, "PAIR_COMMAND").join(" "),
            pair_command
        );
        assert!(routing.contains(&format!("TUNNEL_PORT = {TUNNEL_PORT};")));
        assert!(routing.contains("HEALTH_PATH = \"/healthz\""));
        assert_eq!(
            supertag_transport::HEALTH_PATH,
            "/healthz",
            "the Worker, Render, and the listener name one health route"
        );
        // A client cannot pick another container port.
        assert!(routing.contains("headers.delete(\"cf-container-target-port\")"));
        assert!(worker.contains("pingEndpoint = `localhost${HEALTH_PATH}`"));
        // The Worker passes exactly the deployment settings and TLS PEM values.
        let passed: std::collections::BTreeSet<String> =
            command_literal(&routing, "CONTAINER_KEYS")
                .into_iter()
                .collect();
        let pem = [
            "SUPERTAG_TLS_CERT_PEM",
            "SUPERTAG_TLS_KEY_PEM",
            "SUPERTAG_TLS_CLIENT_CA_PEM",
            "SUPERTAG_SERVER_CA_PEM",
            "SUPERTAG_CLIENT_CERT_PEM",
            "SUPERTAG_CLIENT_KEY_PEM",
        ];
        let expected: std::collections::BTreeSet<String> = CONTROL_PLANE_KEYS
            .iter()
            .chain(GATEWAY_KEYS.iter())
            .chain(pem.iter())
            .map(|key| key.to_string())
            .collect();
        assert_eq!(passed, expected);
        for key in pem {
            let name = key.trim_start_matches("SUPERTAG_").trim_end_matches("_PEM");
            assert!(entrypoint.contains(&format!("\"{name} ")), "{key}");
        }
        // Plus the outbound connectors' settings, which the pair gives the Gateway alone.
        assert_eq!(
            command_literal(&routing, "CONTAINER_KEY_PREFIXES"),
            ["SUPERTAG_LARK_", "SUPERTAG_NOTIFY_SECRET_"]
        );
        for prefix in ["SUPERTAG_LARK_", "SUPERTAG_NOTIFY_SECRET_"] {
            assert!(
                pair.contains(&format!("^\\({prefix}[A-Z0-9_]*\\)=")),
                "{prefix}"
            );
        }

        // Modal: one always-on container behind a labelled web endpoint on the tunnel port.
        assert_eq!(
            command_literal(&modal, "CONTROL_PLANE_COMMAND").join(" "),
            control_plane
        );
        assert_eq!(
            command_literal(&modal, "PAIR_COMMAND").join(" "),
            pair_command
        );
        assert!(modal.contains(&format!("TUNNEL_PORT = {TUNNEL_PORT}")));
        assert!(modal.contains(&format!("STATE_DIRECTORY = \"{STATE_DIRECTORY}\"")));
        for expected in [
            "min_containers=1",
            "max_containers=1",
            "@modal.web_server(TUNNEL_PORT",
            "\"@sha256:\" not in image_ref",
            "return PAIR_COMMAND + flags",
            // A container whose service exited ends, so Modal replaces it; shutdown stops it.
            "exit=os._exit",
            "@modal.exit()",
        ] {
            assert!(modal.contains(expected), "{expected}");
        }

        // The pair: the same Control Plane command with the tunnel address, and a Gateway that
        // dials it on loopback without the Control Plane's credentials.
        assert!(pair.contains(&format!(
            "control-plane --listen 127.0.0.1:{CONTROL_PLANE_PORT} --websocket-listen \"$tunnel\""
        )));
        assert!(pair.contains(&format!("--transfer-directory {STATE_DIRECTORY}/transfers")));
        for platform in [Platform::Cloudflare, Platform::Modal] {
            assert!(pair.contains(&format!(
                "gateway --listen {GATEWAY_LISTEN} --control-plane {} \\\n    \"$@\" &",
                platform.gateway_upstream()
            )));
        }
        // tini reaps orphans even where it is not PID 1 (the Modal function).
        assert!(entrypoint.contains("/usr/bin/tini -s --"));
        for key in [
            "SUPERTAG_DATABASE_URL",
            "SUPERTAG_OPERATOR_TOKEN",
            "SUPERTAG_TLS_KEY_FILE",
            "SUPERTAG_TLS_CERT_FILE",
            "SUPERTAG_TLS_CLIENT_CA_FILE",
        ] {
            assert!(pair.contains(&format!("-u {key}")), "{key}");
        }
        assert!(entrypoint.contains("program=/usr/local/bin/supertag-hosted-pair"));
        assert!(dockerfile.contains("rust-hosted-pair.sh /usr/local/bin/supertag-hosted-pair"));
        for platform in Platform::ALL {
            assert_eq!(
                platform.tunnelled(),
                matches!(
                    platform,
                    Platform::Render | Platform::Cloudflare | Platform::Modal
                )
            );
        }
    }
}
