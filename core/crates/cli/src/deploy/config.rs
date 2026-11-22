//! `supertag-deploy.yaml`: what `supertag deploy` deploys and where. It holds no secret, so it
//! is committed with the repository, and a laptop and a CI job deploy the same thing from it.
//!
//! Settings that mean the same on every target sit at the top level: the release or image, the
//! Gateway and its connectors, where the services read credentials, non-secret settings, and how
//! the Control Plane gets its certificate. Everything only one target understands sits in a
//! block named after that target, so a new target adds a block and no top-level key.
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, bail, ensure};
use serde::Deserialize;

use crate::deployment;

/// The file `supertag deploy` reads from the current directory unless `--config` names another.
pub(crate) const FILE: &str = "supertag-deploy.yaml";
/// The public CA certificate `supertag deploy` writes beside the configuration.
const CA_FILE: &str = "supertag-deploy-ca.pem";
const MAX_BYTES: usize = 256 * 1024;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "kebab-case")]
pub(crate) struct Config {
    /// The deployment target: the name of the block below that describes it.
    pub target: String,
    /// The SuperTag release whose official hosted image runs. Defaults to this CLI's release.
    pub version: Option<String>,
    /// An image reference pinned by digest, instead of a release's official image.
    pub image: Option<String>,
    /// Where the services read collaboration surface, Workspace, and Volume credentials.
    /// Defaults to what the target supports best.
    pub credential_vault: Option<String>,
    /// The optional Gateway beside the Control Plane.
    pub gateway: Option<Gateway>,
    /// Non-secret settings the services read from their environment.
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub tls: Tls,
    /// Settings only the Modal target reads.
    pub modal: Option<Modal>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "kebab-case")]
pub(crate) struct Gateway {
    /// `false` keeps the connector flags in the file while the Gateway is off.
    #[serde(default = "enabled")]
    pub enabled: bool,
    /// The Gateway's connector flags, one argument per item.
    #[serde(default)]
    pub flags: Vec<String>,
}

fn enabled() -> bool {
    true
}

/// Where the Control Plane's certificate comes from.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum TlsMode {
    /// `supertag deploy` issues a certificate authority and a certificate for the endpoint.
    #[default]
    Generated,
    /// You supply the certificate and key as files.
    Provided,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "kebab-case")]
pub(crate) struct Tls {
    #[serde(default)]
    pub mode: TlsMode,
    /// The certificate authority clients trust. Generated: where deploy writes it. Provided:
    /// the authority that issued your certificate, or absent for a publicly trusted one.
    pub ca_file: Option<PathBuf>,
    /// Provided: the certificate chain and its private key, read when deploy publishes them.
    pub cert_file: Option<PathBuf>,
    pub key_file: Option<PathBuf>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "kebab-case")]
pub(crate) struct Modal {
    /// The Modal app's name. It also names the state Volume and prefixes the secrets.
    pub app: Option<String>,
    /// The web endpoint's label, the last part of its host name. Defaults to the app's name.
    pub label: Option<String>,
    /// The Modal workspace this deploys to. Deploy refuses any other.
    pub workspace: Option<String>,
    /// The Modal environment, when not the workspace's default.
    pub environment: Option<String>,
    /// A Modal secret with REGISTRY_USERNAME and REGISTRY_PASSWORD, for a private image.
    pub registry_secret: Option<String>,
}

impl Config {
    /// Reads and checks `path`. Errors never quote the file: a secret pasted into it by mistake
    /// must not reach a log.
    pub(crate) fn read(path: &Path) -> Result<Self> {
        let bytes = std::fs::read(path).with_context(|| {
            format!(
                "read {}; create it with `supertag deploy init TARGET`",
                path.display()
            )
        })?;
        Self::parse(&bytes).with_context(|| format!("in {}", path.display()))
    }

    pub(crate) fn parse(bytes: &[u8]) -> Result<Self> {
        ensure!(
            bytes.len() <= MAX_BYTES,
            "the deployment configuration is too large"
        );
        let options = serde_saphyr::options! {budget:serde_saphyr::budget!{max_documents:1,max_depth:16,max_nodes:4000,max_total_scalar_bytes:MAX_BYTES}};
        // The parser's message names the key and its position, never a value.
        let config: Self = serde_saphyr::from_slice_with_options(bytes, options)
            .map_err(|error| anyhow::anyhow!("{}", describe(&error.to_string())))?;
        config.check()?;
        Ok(config)
    }

    fn check(&self) -> Result<()> {
        ensure!(
            self.version.is_none() || self.image.is_none(),
            "set version or image, not both"
        );
        if let Some(image) = &self.image {
            ensure!(
                pinned(image),
                "image must be pinned by digest: NAME@sha256:DIGEST"
            );
        }
        if let Some(gateway) = &self.gateway {
            for flag in &gateway.flags {
                ensure!(
                    !flag.is_empty() && !flag.contains(['\0', '\n', '\r']),
                    "gateway.flags holds an empty item or a line break"
                );
            }
            ensure!(
                !gateway.enabled || !gateway.flags.is_empty(),
                "gateway.flags must name the Gateway's connectors, such as --slack-socket-mode; a Gateway without one serves nothing"
            );
        }
        for (key, value) in &self.env {
            ensure!(
                key.bytes()
                    .enumerate()
                    .all(|(index, byte)| byte.is_ascii_uppercase()
                        || index > 0 && (byte.is_ascii_digit() || byte == b'_'))
                    && !key.is_empty(),
                "env key {key} must be uppercase letters, digits, and underscores"
            );
            ensure!(
                !value.contains(['\0', '\n', '\r']),
                "env {key} holds a line break"
            );
            if let Some(owner) = managed(key) {
                bail!("env {key} is set by {owner}; remove it from env");
            }
            ensure!(
                !secret(key),
                "env {key} looks like a secret, and this file is not private; store it with `supertag deploy secret set {key}`"
            );
        }
        match self.tls.mode {
            TlsMode::Generated => ensure!(
                self.tls.cert_file.is_none() && self.tls.key_file.is_none(),
                "tls.cert-file and tls.key-file need tls.mode: provided"
            ),
            TlsMode::Provided => ensure!(
                self.tls.cert_file.is_some() && self.tls.key_file.is_some(),
                "tls.mode: provided needs tls.cert-file and tls.key-file"
            ),
        }
        Ok(())
    }

    /// The Gateway's connector flags when the Gateway is on.
    pub(crate) fn gateway_flags(&self) -> Option<&[String]> {
        self.gateway
            .as_ref()
            .filter(|gateway| gateway.enabled)
            .map(|gateway| gateway.flags.as_slice())
    }

    /// The certificate authority file clients trust, resolved against the configuration's
    /// directory. `None` for a provided certificate from a publicly trusted authority.
    pub(crate) fn ca_file(&self, directory: &Path) -> Option<PathBuf> {
        match (&self.tls.ca_file, self.tls.mode) {
            (Some(path), _) => Some(directory.join(path)),
            (None, TlsMode::Generated) => Some(directory.join(CA_FILE)),
            (None, TlsMode::Provided) => None,
        }
    }
}

/// An image reference with a SHA-256 digest.
pub(crate) fn pinned(image: &str) -> bool {
    image.split_once("@sha256:").is_some_and(|(name, digest)| {
        !name.is_empty()
            && !name.chars().any(|c| c.is_whitespace() || c.is_control())
            && digest.len() == 64
            && digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    })
}

/// What sets `key` when it is not the `env` map's to set.
fn managed(key: &str) -> Option<&'static str> {
    match key {
        "SUPERTAG_CREDENTIAL_VAULT" => Some("credential-vault"),
        "SUPERTAG_STATE_DIR" => Some("the deployment target"),
        _ if deployment::TLS_KEYS.contains(&key) => Some("the tls section"),
        _ if key.starts_with("SUPERTAG_MODAL_") => Some("the modal section"),
        _ => None,
    }
}

/// Whether `key` names a value that belongs in the target's secret store, not in this file.
pub(crate) fn secret(key: &str) -> bool {
    deployment::SECRET_KEYS.contains(&key)
        || ["TOKEN", "SECRET", "PASSWORD", "CREDENTIAL", "PRIVATE_KEY"]
            .iter()
            .any(|word| key.contains(word))
        || key.ends_with("_PEM")
}

/// The parser's message without the snippet of the file it appends.
fn describe(message: &str) -> String {
    let first = message.lines().next().unwrap_or("invalid YAML");
    format!("invalid deployment configuration: {first}")
}

/// The file `supertag deploy init` writes for `target`.
pub(crate) fn scaffold(target: &str) -> Result<String> {
    ensure!(
        target == "modal",
        "supertag deploy has no target named {target}; the targets are: modal"
    );
    Ok(format!(
        "# What `supertag deploy` deploys and where. This file holds no secret: commit it.\n\
         # Reference: https://github.com/atemaguer/supertag/blob/main/docs/reference/supertag-deploy-yaml.md\n\
         target: modal\n\
         \n\
         # The SuperTag release to run. Defaults to the release of the CLI that deploys.\n\
         version: {version}\n\
         # Or your own build of the hosted image, pinned by digest:\n\
         # image: REGISTRY/supertag-hosted@sha256:DIGEST\n\
         \n\
         # The optional Gateway, which connects collaboration surfaces such as Slack.\n\
         # gateway:\n\
         #   flags: [--slack-socket-mode, --slack-state-directory, /var/lib/supertag/slack]\n\
         \n\
         # Non-secret settings the services read. Secrets go to `supertag deploy secret set`.\n\
         # env:\n\
         #   SUPERTAG_SLACK_TEAM_ID: T0123456789\n\
         \n\
         modal:\n\
         \x20 app: supertag\n\
         \x20 # workspace: NAME         # refuse to deploy to any other Modal workspace\n\
         \x20 # environment: NAME       # a Modal environment other than the default\n\
         \x20 # registry-secret: NAME   # Modal secret with REGISTRY_USERNAME and REGISTRY_PASSWORD\n",
        version = env!("CARGO_PKG_VERSION"),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_scaffold_parses_and_unknown_keys_are_refused() -> Result<()> {
        let config = Config::parse(scaffold("modal")?.as_bytes())?;
        assert_eq!(config.target, "modal");
        assert_eq!(config.version.as_deref(), Some(env!("CARGO_PKG_VERSION")));
        assert_eq!(config.tls.mode, TlsMode::Generated);
        let modal = config.modal.as_ref().expect("the modal block");
        assert_eq!(modal.app.as_deref(), Some("supertag"));
        assert_eq!(modal.workspace, None);
        assert!(config.gateway_flags().is_none());
        assert_eq!(
            config.ca_file(Path::new("/repo")),
            Some(PathBuf::from("/repo/supertag-deploy-ca.pem"))
        );
        assert!(scaffold("fly").is_err());

        for (text, message) in [
            ("target: modal\nplatfrom: x\n", "platfrom"),
            ("target: modal\nmodal: {apps: x}\n", "apps"),
            ("target: modal\ngateway: {flag: [x]}\n", "flag"),
            ("target: modal\ntls: {mode: none}\n", "generated, provided"),
            (
                "target: modal\nversion: 1.0.0\nimage: a@sha256:b\n",
                "not both",
            ),
            (
                "target: modal\nimage: registry/x:latest\n",
                "pinned by digest",
            ),
            ("target: modal\ngateway: {}\n", "connectors"),
            ("target: modal\nenv: {lower: x}\n", "uppercase"),
            (
                "target: modal\nenv: {SUPERTAG_DATABASE_URL: x}\n",
                "supertag deploy secret set SUPERTAG_DATABASE_URL",
            ),
            (
                "target: modal\nenv: {SUPERTAG_SLACK_BOT_TOKEN: x}\n",
                "looks like a secret",
            ),
            (
                "target: modal\nenv: {SUPERTAG_CREDENTIAL_VAULT: env}\n",
                "credential-vault",
            ),
            ("target: modal\ntls: {cert-file: a.pem}\n", "provided"),
            ("target: modal\ntls: {mode: provided}\n", "cert-file"),
        ] {
            let error = format!("{:#}", Config::parse(text.as_bytes()).unwrap_err());
            assert!(error.contains(message), "{text}: {error}");
        }
        Ok(())
    }

    #[test]
    fn a_secret_pasted_into_the_file_is_not_echoed() {
        let error = format!(
            "{:#}",
            Config::parse(b"target: modal\ndatabase: postgresql://u:hunter2@db/x\n").unwrap_err()
        );
        assert!(!error.contains("hunter2"), "{error}");
    }

    #[test]
    fn a_gateway_keeps_its_flags_while_off_and_a_provided_certificate_names_its_files() -> Result<()>
    {
        let config = Config::parse(
            b"target: modal\ngateway: {enabled: false, flags: [--slack-socket-mode]}\ntls: {mode: provided, cert-file: tls/server.pem, key-file: /secure/server.key}\n",
        )?;
        assert!(config.gateway_flags().is_none());
        assert_eq!(config.ca_file(Path::new("/repo")), None);
        let config = Config::parse(
            b"target: modal\ngateway: {flags: [--notify, 'webhook:https://h.example/x#ops']}\nenv: {SUPERTAG_SLACK_TEAM_ID: T1}\n",
        )?;
        assert_eq!(
            config.gateway_flags(),
            Some(
                [
                    "--notify".to_owned(),
                    "webhook:https://h.example/x#ops".to_owned()
                ]
                .as_slice()
            )
        );
        Ok(())
    }
}
