//! The Modal deployment target: one always-on container behind a web endpoint, defined by
//! `deploy/modal/app.py`, with the deployment's secrets in the workspace's Modal secrets.
//!
//! Every use of the `modal` program is in this file, through [`Modal::modal`]:
//!
//! | Invocation | For |
//! | --- | --- |
//! | `modal --version` | Is the Modal CLI installed |
//! | `modal profile list --json` | Which workspace the CLI is signed in to |
//! | `modal secret list --json` | Which of the deployment's secrets exist |
//! | `modal secret create NAME --from-json FILE [--force]` | Create or replace one secret |
//! | `modal secret delete NAME --yes` | Delete one secret |
//! | `modal deploy APP.PY` | Roll out, with the `SUPERTAG_MODAL_*` settings in its environment |
//! | `modal app list --json` | Whether the app is deployed, for `supertag deploy status` |
//!
//! Each takes `--env NAME` when the configuration names a Modal environment. A secret's values
//! reach `modal` in a private temporary file, never in its arguments, and Modal never returns
//! them. `app.py` is compiled into this program, so an installed release deploys without a
//! checkout.
use std::{
    cell::OnceCell,
    io::{BufRead as _, BufReader, Write as _},
    process::{Command, Stdio},
};

use anyhow::{Context, Result, bail, ensure};

use super::{
    config,
    target::{Deployment, Endpoint, Rollout, SecretStore, Target, Values},
};
use crate::deployment::Platform;

/// The Modal app definition, the same file a checkout deploys by hand.
const APP: &str = include_str!("../../../../../deploy/modal/app.py");
/// The Modal client release `app.py` is written for.
const REQUIREMENTS: &str = include_str!("../../../../../deploy/modal/requirements.txt");
const PROGRAM: &str = "modal";

pub(crate) struct Modal {
    app: String,
    label: String,
    workspace: Option<String>,
    environment: Option<String>,
    registry_secret: Option<String>,
    /// The workspace the Modal CLI is signed in to, once `prepare` has asked.
    signed_in: OnceCell<Option<String>>,
}

impl Modal {
    pub(crate) fn new(settings: Option<&config::Modal>) -> Result<Self> {
        let default = config::Modal::default();
        let settings = settings.unwrap_or(&default);
        let app = settings.app.clone().unwrap_or_else(|| "supertag".into());
        let label = settings.label.clone().unwrap_or_else(|| app.clone());
        for (key, value) in [
            ("app", Some(&app)),
            ("label", Some(&label)),
            ("workspace", settings.workspace.as_ref()),
            ("environment", settings.environment.as_ref()),
        ] {
            if let Some(value) = value {
                ensure!(
                    name(value),
                    "modal.{key} must be 1 to 40 lowercase letters, digits, and hyphens, starting and ending with a letter or digit"
                );
            }
        }
        // A secret you created yourself, under any name Modal allows.
        if let Some(secret) = &settings.registry_secret {
            ensure!(
                (1..64).contains(&secret.len())
                    && secret
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte)),
                "modal.registry-secret must be a Modal secret's name: letters, digits, hyphens, underscores, and periods, fewer than 64"
            );
        }
        Ok(Self {
            app,
            label,
            workspace: settings.workspace.clone(),
            environment: settings.environment.clone(),
            registry_secret: settings.registry_secret.clone(),
            signed_in: OnceCell::new(),
        })
    }

    /// The one place that names the `modal` program. `arguments` follow the subcommand, and
    /// `--env` is added for the commands that take it.
    fn modal(&self, subcommand: &[&str], arguments: &[&str]) -> Command {
        let mut command = Command::new(PROGRAM);
        command.args(subcommand);
        if let Some(environment) = &self.environment
            && matches!(subcommand, ["secret", _] | ["app", _] | ["deploy"])
        {
            command.args(["--env", environment]);
        }
        command
            .args(arguments)
            // Modal wraps its output to the terminal's width, 80 columns in a pipe; a wrapped
            // URL or JSON string could not be read back.
            .env("COLUMNS", "500")
            .stdin(Stdio::null());
        command
    }

    /// Runs a `modal` command to its end and returns its standard output.
    fn output(&self, mut command: Command, action: &str) -> Result<String> {
        let output = command
            .output()
            .with_context(|| format!("run `modal` to {action}; {}", install()))?;
        ensure!(
            output.status.success(),
            "Modal could not {action}:\n{}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }

    /// The secret's name in Modal: the app's name, then the deployment's own name for it.
    fn secret(&self, name: &str) -> String {
        format!("{}-{name}", self.app)
    }

    /// As [`Self::secret`], for a secret to write or delete: Modal's names are shorter than 64
    /// characters.
    fn writable_secret(&self, name: &str) -> Result<String> {
        let secret = self.secret(name);
        ensure!(
            secret.len() < 64,
            "the Modal secret {secret} would have a name of 64 characters or more; use a shorter variable name or modal.app"
        );
        Ok(secret)
    }

    fn workspace(&self) -> Result<&str> {
        self.workspace
            .as_deref()
            .or_else(|| self.signed_in.get().and_then(Option::as_deref))
            .context(
                "could not tell which Modal workspace the Modal CLI is signed in to; set modal.workspace in the deployment configuration",
            )
    }
}

/// The `major.minor.patch` at the end of `modal --version`, or after `==` in the
/// requirements file.
fn release(text: &str) -> Option<[u64; 3]> {
    let version = text.trim().rsplit([' ', '=']).next()?;
    let mut numbers = version.splitn(3, '.').map(|number| {
        number
            .split(|c: char| !c.is_ascii_digit())
            .next()
            .and_then(|digits| digits.parse().ok())
    });
    Some([numbers.next()??, numbers.next()??, numbers.next()??])
}

/// Refuses a Modal CLI older than the release `app.py` is written for, or of another major
/// version. A version that cannot be read is let through.
fn acceptable(version: &str) -> Result<()> {
    let (Some(found), Some(needed)) = (release(version), release(REQUIREMENTS)) else {
        return Ok(());
    };
    ensure!(
        found[0] == needed[0] && found >= needed,
        "the Modal CLI is version {}.{}.{}, but this deploys with {}.{}.{} or a later {}.x; install it with `pip install {}`",
        found[0],
        found[1],
        found[2],
        needed[0],
        needed[1],
        needed[2],
        needed[0],
        REQUIREMENTS.trim()
    );
    Ok(())
}

fn install() -> String {
    format!(
        "install the Modal CLI with `pip install {}` and sign in with `modal setup`, or set MODAL_TOKEN_ID and MODAL_TOKEN_SECRET",
        REQUIREMENTS.trim()
    )
}

fn name(value: &str) -> bool {
    let edge = |byte: &u8| byte.is_ascii_lowercase() || byte.is_ascii_digit();
    (1..=40).contains(&value.len())
        && value.bytes().all(|byte| edge(&byte) || byte == b'-')
        && value.as_bytes().first().is_some_and(edge)
        && value.as_bytes().last().is_some_and(edge)
}

/// The workspace `modal profile list --json` reports: the one the token in the environment
/// belongs to when there is one, else the active profile's.
fn signed_in(output: &str) -> Option<String> {
    let from_environment = output.lines().find_map(|line| {
        line.trim()
            .strip_prefix("Using ")?
            .strip_suffix(" workspace based on environment variables")
            .map(str::to_owned)
    });
    let from_profile = || {
        let json = output.get(output.find('[')?..=output.rfind(']')?)?;
        let profiles: Vec<serde_json::Value> = serde_json::from_str(json).ok()?;
        profiles
            .iter()
            .find(|profile| profile["active"] == true)
            .and_then(|profile| profile["workspace"].as_str())
            .map(str::to_owned)
    };
    from_environment
        .or_else(from_profile)
        // Modal reports a failed lookup as "Unknown (authentication failure)".
        .filter(|workspace| name(workspace))
}

/// The names in `modal secret list --json`.
fn secret_names(output: &str) -> Result<Vec<String>> {
    let unreadable = "Modal's secret list could not be read";
    let (start, end) = match (output.find('['), output.rfind(']')) {
        (Some(start), Some(end)) if start < end => (start, end),
        _ => bail!(unreadable),
    };
    let secrets: Vec<serde_json::Value> =
        serde_json::from_str(&output[start..=end]).context(unreadable)?;
    secrets
        .iter()
        .map(|secret| {
            secret["name"]
                .as_str()
                .or_else(|| secret["Name"].as_str())
                .map(str::to_owned)
                .context(unreadable)
        })
        .collect()
}

/// The state of the app named `app` in `modal app list --json`: `deployed` when one is, else
/// the state of one that is starting, else `None`. Stopped apps keep their name in the list.
fn app_state(output: &str, app: &str) -> Result<Option<String>> {
    let unreadable = "Modal's app list could not be read";
    let (start, end) = match (output.find('['), output.rfind(']')) {
        (Some(start), Some(end)) if start < end => (start, end),
        _ => bail!(unreadable),
    };
    let apps: Vec<serde_json::Value> =
        serde_json::from_str(&output[start..=end]).context(unreadable)?;
    let mut states = apps
        .iter()
        .filter(|entry| entry["description"] == app)
        .filter_map(|entry| entry["state"].as_str())
        .filter(|state| !state.starts_with("stopp") && *state != "disabled");
    let first = states.next();
    Ok(match first {
        Some("deployed") => first,
        other => states.find(|state| *state == "deployed").or(other),
    }
    .map(str::to_owned))
}

/// The endpoint at `authority`, a host with an optional port: clients use the tunnel, and the
/// tunnel listener's plain `/healthz` answers health checks.
fn endpoint(authority: &str) -> Endpoint {
    Endpoint {
        url: format!("wss://{authority}"),
        health: Some(format!("https://{authority}/healthz")),
    }
}

/// The web endpoint's URL in `modal deploy`'s output: the URL after `=>` on the line that
/// reports the endpoint, not the dashboard link.
fn endpoint_url(output: &str) -> Option<url::Url> {
    let urls = |line: &str| {
        line.split_whitespace()
            .filter_map(|word| url::Url::parse(word).ok())
            .filter(|url| {
                url.scheme() == "https" && url.host_str().is_some_and(|host| host != "modal.com")
            })
            .collect::<Vec<_>>()
    };
    output
        .lines()
        .filter(|line| line.contains("=>") && !line.contains("Custom domain"))
        .find_map(|line| urls(line).into_iter().next())
}

/// `arguments` as one string that Python's `shlex.split` reads back unchanged.
fn shell_words(arguments: &[String]) -> String {
    arguments
        .iter()
        .map(|argument| {
            let plain = !argument.is_empty()
                && argument
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"_@%+=:,./-".contains(&byte));
            if plain {
                argument.clone()
            } else {
                format!("'{}'", argument.replace('\'', "'\"'\"'"))
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

impl SecretStore for Modal {
    fn describe(&self) -> String {
        match (&self.workspace(), &self.environment) {
            (Ok(workspace), Some(environment)) => {
                format!("Modal secrets in workspace {workspace}, environment {environment}")
            }
            (Ok(workspace), None) => format!("Modal secrets in workspace {workspace}"),
            (Err(_), _) => "Modal secrets".into(),
        }
    }

    fn list(&self) -> Result<Vec<String>> {
        let output = self.output(
            self.modal(&["secret", "list"], &["--json"]),
            "list the workspace's secrets",
        )?;
        let prefix = self.secret("");
        Ok(secret_names(&output)?
            .into_iter()
            .filter_map(|name| name.strip_prefix(&prefix).map(str::to_owned))
            .collect())
    }

    /// Modal returns a secret's values only to a running container.
    fn read(&self, _name: &str) -> Result<Option<Values>> {
        Ok(None)
    }

    fn write(&self, name: &str, values: &Values, replace: bool) -> Result<()> {
        // A file only this user can read; it is removed when this function returns.
        let mut file = tempfile::Builder::new()
            .prefix("supertag-secret-")
            .suffix(".json")
            .tempfile()
            .context("create a private temporary file for the secret")?;
        file.write_all(&serde_json::to_vec(values)?)?;
        file.flush()?;
        let path = file.path().to_str().context("the temporary path")?;
        let secret = self.writable_secret(name)?;
        let mut arguments = vec![secret.as_str(), "--from-json", path];
        if replace {
            arguments.push("--force");
        }
        self.output(
            self.modal(&["secret", "create"], &arguments),
            &format!("write the secret {secret}"),
        )?;
        Ok(())
    }

    fn delete(&self, name: &str) -> Result<()> {
        let secret = self.writable_secret(name)?;
        self.output(
            self.modal(&["secret", "delete"], &[&secret, "--yes"]),
            &format!("delete the secret {secret}"),
        )?;
        Ok(())
    }
}

impl Target for Modal {
    fn platform(&self) -> Platform {
        Platform::Modal
    }

    fn name(&self) -> String {
        match &self.environment {
            Some(environment) => format!("{}-{environment}", self.app),
            None => self.app.clone(),
        }
    }

    fn prepare(&self) -> Result<()> {
        let version = self.output(self.modal(&["--version"], &[]), "report its version")?;
        acceptable(&version)?;
        let profiles = self
            .output(
                self.modal(&["profile", "list"], &["--json"]),
                "report the workspace it is signed in to",
            )
            .with_context(install)?;
        let signed_in = signed_in(&profiles);
        if let (Some(configured), Some(signed_in)) = (&self.workspace, &signed_in) {
            ensure!(
                configured == signed_in,
                "the Modal CLI is signed in to workspace {signed_in}, but the deployment configuration names {configured}; switch with `modal profile activate`, or use that workspace's MODAL_TOKEN_ID and MODAL_TOKEN_SECRET"
            );
        }
        let _ = self.signed_in.set(signed_in);
        self.workspace().map(|_| ())
    }

    fn secrets(&self) -> Option<&dyn SecretStore> {
        Some(self)
    }

    /// `WORKSPACE--LABEL.modal.run`, and with a named environment also
    /// `WORKSPACE-ENVIRONMENT--LABEL.modal.run`: Modal adds the environment's name unless it is
    /// the workspace's default, which this machine cannot tell.
    fn hosts(&self) -> Result<Vec<String>> {
        let workspace = self.workspace()?;
        let mut hosts = vec![format!("{workspace}--{}.modal.run", self.label)];
        if let Some(environment) = &self.environment {
            hosts.push(format!(
                "{workspace}-{environment}--{}.modal.run",
                self.label
            ));
        }
        Ok(hosts)
    }

    fn roll_out(&self, rollout: &Rollout<'_>) -> Result<Endpoint> {
        let directory = tempfile::tempdir().context("create a temporary directory")?;
        let definition = directory.path().join("app.py");
        std::fs::write(&definition, APP).context("write the Modal app definition")?;
        let secrets: Vec<String> = rollout
            .secrets
            .iter()
            .map(|name| self.secret(name))
            .collect();
        let mut command = self.modal(
            &["deploy"],
            &[definition.to_str().context("the temporary path")?],
        );
        command
            .env("SUPERTAG_MODAL_IMAGE", rollout.image)
            .env("SUPERTAG_MODAL_APP", &self.app)
            .env("SUPERTAG_MODAL_LABEL", &self.label)
            .env(
                "SUPERTAG_MODAL_GATEWAY",
                if rollout.gateway_flags.is_some() {
                    "on"
                } else {
                    "off"
                },
            )
            .env(
                "SUPERTAG_MODAL_GATEWAY_FLAGS",
                shell_words(rollout.gateway_flags.unwrap_or_default()),
            )
            .env("SUPERTAG_MODAL_SECRETS", secrets.join(","))
            .env(
                "SUPERTAG_MODAL_SETTINGS",
                serde_json::to_string(rollout.settings)?,
            );
        match &self.registry_secret {
            Some(secret) => command.env("SUPERTAG_MODAL_REGISTRY_SECRET", secret),
            None => command.env_remove("SUPERTAG_MODAL_REGISTRY_SECRET"),
        };
        // Modal's progress goes to this command's standard error as it arrives, and is kept
        // to find the endpoint in.
        let mut child = command
            .stdout(Stdio::piped())
            .spawn()
            .with_context(|| format!("run `modal deploy`; {}", install()))?;
        let mut output = String::new();
        for line in BufReader::new(child.stdout.take().context("modal deploy's output")?).lines() {
            let line = line.context("read modal deploy's output")?;
            errln!("  {line}");
            output.push_str(&line);
            output.push('\n');
        }
        ensure!(
            child.wait()?.success(),
            "`modal deploy` failed; its output is above"
        );
        let url = match endpoint_url(&output) {
            Some(url) => url,
            None => {
                let hosts = self.hosts()?;
                ensure!(
                    hosts.len() == 1,
                    "`modal deploy` succeeded but did not report the web endpoint's URL, and it could be either of {}",
                    hosts.join(" and ")
                );
                url::Url::parse(&format!("https://{}", hosts[0]))?
            }
        };
        let authority = match (url.host_str(), url.port()) {
            (Some(host), Some(port)) => format!("{host}:{port}"),
            (Some(host), None) => host.to_owned(),
            (None, _) => bail!("`modal deploy` reported an endpoint without a host"),
        };
        Ok(endpoint(&authority))
    }

    fn deployment(&self) -> Result<Deployment> {
        let apps = self.output(
            self.modal(&["app", "list"], &["--json"]),
            "list the workspace's apps",
        )?;
        Ok(Deployment {
            state: app_state(&apps, &self.app)?,
            endpoints: self.hosts()?.iter().map(|host| endpoint(host)).collect(),
        })
    }

    fn troubleshooting(&self) -> String {
        let environment = self
            .environment
            .as_ref()
            .map(|environment| format!(" --env {environment}"))
            .unwrap_or_default();
        format!(
            "Read the container's log with `modal app logs {}{environment}`: an unreachable database stops the Control Plane, and a connector without its settings or credentials stops the Gateway.",
            self.app
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn modal(settings: config::Modal) -> Modal {
        Modal::new(Some(&settings)).expect("valid settings")
    }

    #[test]
    fn the_signed_in_workspace_comes_from_the_environment_token_or_the_active_profile() {
        let profiles = r#"[
  {"name": "personal", "workspace": "someone", "active": false},
  {"name": "work", "workspace": "acme", "active": true}
]"#;
        assert_eq!(signed_in(profiles).as_deref(), Some("acme"));
        assert_eq!(
            signed_in(&format!(
                "{profiles}\nUsing ci-team workspace based on environment variables\n"
            ))
            .as_deref(),
            Some("ci-team")
        );
        assert_eq!(
            signed_in("[]\nUsing ci-team workspace based on environment variables\n").as_deref(),
            Some("ci-team")
        );
        for unknown in [
            "",
            "[]",
            "not json",
            r#"[{"name": "work", "workspace": "Unknown (authentication failure)", "active": true}]"#,
        ] {
            assert_eq!(signed_in(unknown), None, "{unknown}");
        }
    }

    #[test]
    fn secret_names_and_the_endpoint_are_read_from_modals_output() -> Result<()> {
        assert_eq!(
            secret_names(
                r#"[
  {"name": "supertag-tls", "created_at": "2026-11-22 10:00 UTC", "created_by": "a", "last_used_at": "-"},
  {"name": "other", "created_at": "x", "created_by": "a", "last_used_at": "-"}
]"#
            )?,
            ["supertag-tls", "other"]
        );
        assert!(secret_names("[]")?.is_empty());
        assert!(secret_names("Error: not signed in").is_err());
        assert!(secret_names(r#"[{"id": "x"}]"#).is_err());

        let output = "✓ Created objects.\n├── 🔨 Created mount app.py\n└── 🔨 Created web function serve => https://acme--supertag.modal.run\n✓ App deployed in 2.1s! 🎉\n\nView Deployment: https://modal.com/apps/acme/main/deployed/supertag\n";
        assert_eq!(
            endpoint_url(output).map(String::from).as_deref(),
            Some("https://acme--supertag.modal.run/")
        );
        assert_eq!(
            endpoint_url("View Deployment: https://modal.com/apps/acme"),
            None
        );
        Ok(())
    }

    #[test]
    fn the_modal_cli_must_be_the_pinned_release_or_a_later_one_of_its_major_version() {
        let needed = release(REQUIREMENTS).expect("requirements.txt pins modal==X.Y.Z");
        let version = |[major, minor, patch]: [u64; 3]| {
            format!("modal client version {major}.{minor}.{patch}\n")
        };
        assert_eq!(release("modal client version 1.5.5\n"), Some([1, 5, 5]));
        assert_eq!(release("modal client version 1.6.0.dev3"), Some([1, 6, 0]));
        assert_eq!(release("modal==1.5.5\n"), Some([1, 5, 5]));
        assert!(acceptable(&version(needed)).is_ok());
        assert!(acceptable(&version([needed[0], needed[1] + 1, 0])).is_ok());
        // Unreadable output does not block a deploy.
        assert!(acceptable("modal, some other way of saying it").is_ok());
        for refused in [[needed[0] + 1, 0, 0], [needed[0], 0, 0], [0, 99, 0]] {
            let error = acceptable(&version(refused)).unwrap_err().to_string();
            assert!(error.contains("pip install modal=="), "{error}");
        }
    }

    #[test]
    fn an_app_is_deployed_when_modal_lists_it_so() -> Result<()> {
        let apps = r#"[
  {"app_id": "ap-1", "description": "supertag", "state": "stopped", "tasks": "0", "created_at": "x", "stopped_at": "y"},
  {"app_id": "ap-2", "description": "supertag", "state": "deployed", "tasks": "1", "created_at": "x", "stopped_at": null},
  {"app_id": "ap-3", "description": "other", "state": "deployed", "tasks": "1", "created_at": "x", "stopped_at": null},
  {"app_id": "ap-4", "description": "starting", "state": "initializing...", "tasks": "0", "created_at": "x", "stopped_at": null}
]"#;
        assert_eq!(app_state(apps, "supertag")?.as_deref(), Some("deployed"));
        assert_eq!(
            app_state(apps, "starting")?.as_deref(),
            Some("initializing...")
        );
        assert_eq!(app_state(apps, "absent")?, None);
        assert_eq!(app_state("[]", "supertag")?, None);
        // A stopped app is not a deployment.
        assert_eq!(
            app_state(
                r#"[{"description": "supertag", "state": "stopped"}]"#,
                "supertag"
            )?,
            None
        );
        assert!(app_state("Error: not signed in", "supertag").is_err());
        Ok(())
    }

    #[test]
    fn names_hosts_and_gateway_flags_follow_modals_rules() -> Result<()> {
        let target = modal(config::Modal {
            workspace: Some("acme".into()),
            ..Default::default()
        });
        assert_eq!(target.hosts()?, ["acme--supertag.modal.run"]);
        assert_eq!(target.name(), "supertag");
        assert_eq!(target.secret("tls"), "supertag-tls");
        let staged = modal(config::Modal {
            app: Some("tags".into()),
            label: Some("api".into()),
            workspace: Some("acme".into()),
            environment: Some("staging".into()),
            ..Default::default()
        });
        assert_eq!(
            staged.hosts()?,
            ["acme--api.modal.run", "acme-staging--api.modal.run"]
        );
        assert_eq!(staged.name(), "tags-staging");
        // Without a configured workspace, the host needs the signed-in one.
        assert!(modal(config::Modal::default()).hosts().is_err());
        for refused in ["", "Upper", "-edge", "under_score", "has space"] {
            assert!(
                Modal::new(Some(&config::Modal {
                    app: Some(refused.into()),
                    ..Default::default()
                }))
                .is_err(),
                "{refused}"
            );
        }
        assert_eq!(
            shell_words(&[
                "--notify".into(),
                "webhook:https://h.example/x#ops".into(),
                "it's".into(),
                "/var/lib/supertag/slack".into(),
            ]),
            r#"--notify 'webhook:https://h.example/x#ops' 'it'"'"'s' /var/lib/supertag/slack"#
        );
        Ok(())
    }

    /// `--env` goes to the commands that read one, after the subcommand.
    #[test]
    fn a_named_environment_reaches_the_secret_and_deploy_commands() {
        let arguments = |command: Command| {
            command
                .get_args()
                .map(|argument| argument.to_string_lossy().into_owned())
                .collect::<Vec<_>>()
        };
        let staged = modal(config::Modal {
            environment: Some("staging".into()),
            ..Default::default()
        });
        assert_eq!(
            arguments(staged.modal(&["secret", "list"], &["--json"])),
            ["secret", "list", "--env", "staging", "--json"]
        );
        assert_eq!(
            arguments(staged.modal(&["deploy"], &["app.py"])),
            ["deploy", "--env", "staging", "app.py"]
        );
        assert_eq!(
            arguments(staged.modal(&["app", "list"], &["--json"])),
            ["app", "list", "--env", "staging", "--json"]
        );
        assert_eq!(
            arguments(staged.modal(&["profile", "list"], &["--json"])),
            ["profile", "list", "--json"]
        );
        assert_eq!(
            arguments(modal(config::Modal::default()).modal(&["secret", "list"], &["--json"])),
            ["secret", "list", "--json"]
        );
    }
}
