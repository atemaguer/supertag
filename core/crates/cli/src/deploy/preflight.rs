//! The part of `supertag deploy` that changes nothing: `supertag deploy check`, the plan
//! `supertag deploy --dry-run` prints, and the first step of every deploy.
//!
//! It asks the target whether this machine can deploy, validates the configuration, and works
//! out for each secret and for the certificate whether a deploy would keep it or create it, and
//! for a secret only the user knows, how it would be supplied. Every problem is collected, so
//! one run names them all, each on one line.
use std::{collections::BTreeSet, path::Path};

use anyhow::{Result, bail};

use super::{
    CREDENTIALS, DATABASE, Missing, SET_PREFIX, TLS, ca_file_missing, ca_file_orphaned,
    certificate_names,
    config::{Config, TlsMode},
    image, plan,
    target::Target,
    tls, unsupplied, variable_of,
};

/// How much to work out.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Scope {
    /// Can this machine deploy: tooling, configuration, secrets, certificate.
    Check,
    /// Also what a deploy would roll out: the image by digest, the endpoint, the settings.
    Plan,
}

pub(super) struct Preflight {
    /// What was found and what a deploy would do, one item per line.
    pub text: String,
    problems: Vec<String>,
    /// The secrets the store holds, for the deploy that follows.
    pub stored: BTreeSet<String>,
    /// The image a deploy would roll out, when the scope is a plan and it resolved.
    pub image: Option<String>,
}

impl Preflight {
    /// Fails when there is a problem, after printing each on a line of its own.
    pub(super) fn problems(&self) -> Result<()> {
        if self.problems.is_empty() {
            return Ok(());
        }
        for problem in &self.problems {
            errln!("problem: {problem}");
        }
        bail!(
            "{} to fix before deploying; nothing was changed",
            match self.problems.len() {
                1 => "1 problem".to_owned(),
                count => format!("{count} problems"),
            }
        )
    }

    fn line(&mut self, kind: &str, text: impl AsRef<str>) {
        self.text
            .push_str(&format!("  {kind:<13} {}\n", text.as_ref()));
    }

    /// Records a problem on one line, whatever the tool that reported it printed.
    fn problem(&mut self, problem: impl AsRef<str>) {
        self.problems.push(
            problem
                .as_ref()
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" "),
        );
    }
}

pub(super) async fn run(
    config: &Config,
    directory: &Path,
    target: &dyn Target,
    interactive: bool,
    renew: bool,
    scope: Scope,
) -> Preflight {
    let name = target.platform().name();
    let mut preflight = Preflight {
        text: format!(
            "{} for the {name} target\n",
            match scope {
                Scope::Check => "Check",
                Scope::Plan => "Plan",
            }
        ),
        problems: Vec::new(),
        stored: BTreeSet::new(),
        image: None,
    };

    // Can this machine deploy at all? Without the target, nothing else can be asked.
    if let Err(error) = target.prepare() {
        preflight.line("target", "not ready");
        preflight.problem(format!("{error:#}"));
        return preflight;
    }
    let Some(store) = target.secrets() else {
        preflight.problem(format!(
            "the {name} target keeps no secrets, and supertag deploy has no other secret store yet"
        ));
        return preflight;
    };
    preflight.line("target", "ready: its tooling is installed and signed in");
    preflight.stored = match store.list() {
        Ok(stored) => stored.into_iter().collect(),
        Err(error) => {
            preflight.problem(format!("{error:#}"));
            return preflight;
        }
    };
    preflight.line("secret store", store.describe());

    // The configuration, by the rules `supertag check deployment` applies. A secret that is
    // missing is stood in for here and reported below.
    let stored = preflight.stored.clone();
    let planned = match plan(config, target, &stored, Missing::Assume) {
        Ok(planned) => {
            preflight.line("configuration", "valid");
            Some(planned)
        }
        Err(error) => {
            preflight.line("configuration", "not valid");
            for issue in format!("{error:#}").lines() {
                preflight.problem(issue);
            }
            None
        }
    };

    if let Some(planned) = &planned {
        for (secret, values) in &planned.secrets {
            let label = variable_of(secret).map_or_else(|| secret.clone(), |(label, _)| label);
            if stored.contains(secret) {
                preflight.line("secret", format!("keep     {label}"));
            } else if secret == CREDENTIALS {
                preflight.line(
                    "secret",
                    "create   credentials (none until `supertag deploy secret push`)",
                );
            } else if secret == DATABASE || secret.starts_with(SET_PREFIX) {
                // Only the user knows it.
                let key = values.keys().next().map_or(label.as_str(), String::as_str);
                let given = std::env::var(key).is_ok_and(|value| !value.trim().is_empty());
                if given {
                    preflight.line("secret", format!("create   {key} (from the environment)"));
                } else if interactive {
                    preflight.line(
                        "secret",
                        format!("ask      {key} (deploy asks for it at a masked prompt)"),
                    );
                } else {
                    preflight.line("secret", format!("missing  {key}"));
                    preflight.problem(unsupplied(key));
                }
            } else {
                preflight.line("secret", format!("create   {label} (generated)"));
            }
        }
        for secret in &stored {
            let planned = planned.secrets.iter().any(|(name, _)| name == secret);
            if let (false, true, Some((label, _))) =
                (planned, secret.starts_with(SET_PREFIX), variable_of(secret))
            {
                preflight.line("secret", format!("keep     {label}"));
            }
        }
    }

    match certificate(config, directory, target, &stored, renew) {
        Ok(text) => preflight.line("certificate", text),
        Err(problem) => {
            preflight.line("certificate", "cannot be used as it is");
            preflight.problem(problem);
        }
    }

    if scope == Scope::Plan {
        match image::resolve(config.image.as_deref(), config.version.as_deref()).await {
            Ok(image) => {
                preflight.line("image", &image);
                preflight.image = Some(image);
            }
            Err(error) => {
                preflight.line("image", "not resolved");
                preflight.problem(format!("{error:#}"));
            }
        }
        let scheme = if target.capabilities().native_grpc {
            "https://"
        } else {
            "wss://"
        };
        match target.hosts() {
            Ok(hosts) if !hosts.is_empty() => preflight.line(
                "endpoint",
                hosts
                    .iter()
                    .map(|host| format!("{scheme}{host}"))
                    .collect::<Vec<_>>()
                    .join(" or "),
            ),
            _ => preflight.line("endpoint", "reported by the rollout"),
        }
        preflight.line(
            "rollout",
            match config.gateway_flags() {
                Some(flags) => format!("the Control Plane and the Gateway ({})", flags.join(" ")),
                None => "the Control Plane".to_owned(),
            },
        );
        if let Some(planned) = &planned {
            for (key, value) in &planned.settings {
                preflight.line("setting", format!("{key}={value}"));
            }
        }
    }
    preflight
}

/// What a deploy would do about the Control Plane's certificate, or why it cannot go on.
fn certificate(
    config: &Config,
    directory: &Path,
    target: &dyn Target,
    stored: &BTreeSet<String>,
    renew: bool,
) -> Result<String, String> {
    let ca_file = config.ca_file(directory);
    let publish = renew || !stored.contains(TLS);
    match config.tls.mode {
        TlsMode::Generated => {
            let ca_file = ca_file.ok_or("a generated certificate has a CA file")?;
            if !publish {
                let text =
                    std::fs::read_to_string(&ca_file).map_err(|_| ca_file_missing(&ca_file))?;
                let names = tls::names(&text).map_or_else(
                    || "one that deploy did not issue".to_owned(),
                    |names| format!("for {}", names.join(", ")),
                );
                return Ok(match tls::days_left(&text) {
                    Some(days) if days < 0 => format!(
                        "keep     {names}; it ended {} days ago, so renew it with --renew-certificate",
                        -days
                    ),
                    Some(days) => format!("keep     {names}; ends in {days} days"),
                    None => format!("keep     {names}"),
                });
            }
            if !renew && ca_file.exists() {
                return Err(ca_file_orphaned(&ca_file));
            }
            let hosts = target.hosts().map_err(|error| format!("{error:#}"))?;
            Ok(format!(
                "{} for {}; writes its public CA certificate to {}",
                if stored.contains(TLS) {
                    "renew   "
                } else {
                    "issue   "
                },
                certificate_names(target, hosts).join(", "),
                ca_file.display()
            ))
        }
        TlsMode::Provided if publish => {
            for (path, what) in [
                (&config.tls.cert_file, "certificate"),
                (&config.tls.key_file, "private key"),
            ] {
                let path = directory.join(path.as_ref().ok_or("checked when parsed")?);
                if !path.is_file() {
                    return Err(format!(
                        "the provided {what} {} cannot be read",
                        path.display()
                    ));
                }
            }
            Ok("publish  the provided certificate and key".to_owned())
        }
        TlsMode::Provided => Ok("keep     the provided certificate".to_owned()),
    }
}
