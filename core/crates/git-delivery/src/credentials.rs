//! Workspace Credentials as git delivery holds them: the secret half lives in the credential
//! vault of the machine that runs git delivery, under `workspace-credential/NAME`, and reaches
//! only the git child that talks to the remote, through its environment or a private file.
use std::{
    fs::{self, OpenOptions},
    io::Write as _,
    os::unix::fs::OpenOptionsExt as _,
    path::Path,
};

use anyhow::{Context, Result, bail, ensure};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use supertag_credential_vault::{CredentialValue, CredentialVault};
use supertag_protocol::git_remote::{RemoteTransport, credential_vault_id};

use crate::git::Settings;

/// The largest secret accepted: an SSH private key with a long certificate fits easily.
const MAX_SECRET_BYTES: usize = 65_536;

/// One Workspace Credential's secret. Do not derive Debug: it holds key material and tokens.
#[derive(Clone, PartialEq, Eq)]
pub enum Credential {
    /// An SSH private key, and optionally the server host keys to trust (`known_hosts` lines).
    SshKey {
        private_key: String,
        known_hosts: Option<String>,
    },
    /// An HTTPS user name and token or password.
    HttpsToken { username: String, token: String },
    /// A git credential helper, as git's `credential.helper` setting names it.
    Helper { helper: String },
}

impl Credential {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::SshKey { .. } => "ssh-key",
            Self::HttpsToken { .. } => "https-token",
            Self::Helper { .. } => "credential-helper",
        }
    }

    pub fn to_vault_value(&self) -> CredentialValue {
        let mut value = CredentialValue::new();
        value.insert("kind".into(), self.kind().into());
        match self {
            Self::SshKey {
                private_key,
                known_hosts,
            } => {
                value.insert("privateKey".into(), private_key.clone());
                if let Some(known_hosts) = known_hosts {
                    value.insert("knownHosts".into(), known_hosts.clone());
                }
            }
            Self::HttpsToken { username, token } => {
                value.insert("username".into(), username.clone());
                value.insert("token".into(), token.clone());
            }
            Self::Helper { helper } => {
                value.insert("helper".into(), helper.clone());
            }
        }
        value
    }

    /// Reads a vault value. Errors never repeat its contents.
    pub fn from_vault_value(value: &CredentialValue) -> Result<Self> {
        let field = |name: &str| -> Result<String> {
            let value = value
                .get(name)
                .with_context(|| format!("the stored Workspace Credential has no {name}"))?;
            ensure!(
                !value.is_empty() && value.len() <= MAX_SECRET_BYTES,
                "the stored Workspace Credential's {name} is empty or too long"
            );
            Ok(value.clone())
        };
        let credential = match value.get("kind").map(String::as_str) {
            Some("ssh-key") => Self::SshKey {
                private_key: field("privateKey")?,
                known_hosts: value.get("knownHosts").cloned(),
            },
            Some("https-token") => Self::HttpsToken {
                username: field("username")?,
                token: field("token")?,
            },
            Some("credential-helper") => Self::Helper {
                helper: field("helper")?,
            },
            _ => bail!("the stored Workspace Credential has an unknown kind"),
        };
        credential.validate()?;
        Ok(credential)
    }

    /// Refuses values git would misread or that could inject configuration.
    pub fn validate(&self) -> Result<()> {
        match self {
            Self::SshKey {
                private_key,
                known_hosts,
            } => {
                ensure!(
                    private_key.contains("PRIVATE KEY-----")
                        && private_key.len() <= MAX_SECRET_BYTES,
                    "an SSH Workspace Credential needs a PEM or OpenSSH private key"
                );
                ensure!(
                    !private_key.contains("ENCRYPTED")
                        && !private_key.contains("Proc-Type: 4,ENCRYPTED"),
                    "the SSH key is protected by a passphrase; git delivery cannot type it. Use a deploy key without a passphrase"
                );
                if let Some(known_hosts) = known_hosts {
                    ensure!(
                        known_hosts.len() <= MAX_SECRET_BYTES && !known_hosts.contains('\0'),
                        "invalid known_hosts for the SSH Workspace Credential"
                    );
                }
            }
            Self::HttpsToken { username, token } => {
                ensure!(
                    !username.is_empty()
                        && username.len() <= 256
                        && !username.contains(':')
                        && !username.chars().any(char::is_control),
                    "an HTTPS user name is 1 to 256 characters without ':'"
                );
                ensure!(
                    !token.is_empty()
                        && token.len() <= 8192
                        && !token.chars().any(|c| c.is_control()),
                    "an HTTPS token is 1 to 8192 printable characters"
                );
            }
            Self::Helper { helper } => {
                ensure!(
                    !helper.trim().is_empty()
                        && helper.len() <= 1024
                        && !helper.chars().any(|c| c == '\n' || c == '\r' || c == '\0'),
                    "a credential helper is one line of at most 1024 characters"
                );
            }
        }
        Ok(())
    }

    /// The git settings that present this credential to a remote over `transport`. Files it
    /// needs are written in `private`, a directory only this process can read, removed with it.
    pub(crate) fn settings(
        &self,
        transport: RemoteTransport,
        private: &Path,
        trusted_hosts: &Path,
    ) -> Result<Settings> {
        let mut settings = Settings::default();
        match (self, transport) {
            (Self::HttpsToken { username, token }, RemoteTransport::Http) => {
                settings.config.push((
                    "http.extraHeader".into(),
                    format!(
                        "Authorization: Basic {}",
                        STANDARD.encode(format!("{username}:{token}"))
                    ),
                ));
            }
            (Self::Helper { helper }, RemoteTransport::Http) => {
                settings
                    .config
                    .push(("credential.helper".into(), helper.clone()));
                settings
                    .config
                    .push(("credential.useHttpPath".into(), "true".into()));
                // A helper may be any program; it gets this process's own search path and home,
                // as it would from the operator's git.
                for name in ["PATH", "HOME"] {
                    if let Some(value) = std::env::var_os(name).and_then(|v| v.into_string().ok()) {
                        settings.environment.push((name.into(), value));
                    }
                }
            }
            (
                Self::SshKey {
                    private_key,
                    known_hosts,
                },
                RemoteTransport::Ssh,
            ) => {
                let key = private.join("identity");
                write_private(&key, ensure_newline(private_key).as_bytes())?;
                let (hosts, checking) = match known_hosts {
                    Some(lines) => {
                        let hosts = private.join("known_hosts");
                        write_private(&hosts, ensure_newline(lines).as_bytes())?;
                        (hosts, "yes")
                    }
                    // Trust on first use, remembered for every later connection.
                    None => (trusted_hosts.to_owned(), "accept-new"),
                };
                for path in [&key, &hosts] {
                    ensure!(
                        path.to_str().is_some_and(|value| !value.contains('\'')),
                        "git delivery's state directory path cannot be quoted"
                    );
                }
                settings.environment.push((
                    "GIT_SSH_COMMAND".into(),
                    format!(
                        "/usr/bin/ssh -F /dev/null -i '{}' -o IdentitiesOnly=yes -o IdentityAgent=none -o BatchMode=yes -o StrictHostKeyChecking={checking} -o UserKnownHostsFile='{}' -o ConnectTimeout=15",
                        key.display(),
                        hosts.display()
                    ),
                ));
                settings
                    .environment
                    .push(("GIT_SSH_VARIANT".into(), "ssh".into()));
            }
            (credential, transport) => bail!(
                "a Workspace Credential of kind {} cannot reach a {} remote",
                credential.kind(),
                match transport {
                    RemoteTransport::Http => "https://",
                    RemoteTransport::Ssh => "SSH",
                    RemoteTransport::File => "file://",
                }
            ),
        }
        Ok(settings)
    }

    /// What `workspace check` says about how far this credential reaches.
    pub(crate) fn describe(&self) -> &'static str {
        match self {
            Self::SshKey { .. } => "SSH key",
            Self::HttpsToken { .. } => "HTTPS token",
            Self::Helper { .. } => "credential helper",
        }
    }
}

/// Settings for an SSH remote without a Workspace Credential: no key is offered, so only a
/// server that needs none answers.
pub(crate) fn anonymous_ssh(private: &Path, trusted_hosts: &Path) -> Settings {
    Settings {
        config: Vec::new(),
        environment: vec![
            (
                "GIT_SSH_COMMAND".into(),
                format!(
                    "/usr/bin/ssh -F /dev/null -o IdentityAgent=none -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile='{}' -o ConnectTimeout=15",
                    trusted_hosts.display()
                ),
            ),
            ("HOME".into(), private.display().to_string()),
        ],
    }
}

fn ensure_newline(value: &str) -> String {
    if value.ends_with('\n') {
        value.to_owned()
    } else {
        format!("{value}\n")
    }
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .context("write a private git delivery file")?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

/// Reads Workspace Credentials from the credential vault.
pub struct Credentials {
    vault: CredentialVault,
}

impl Credentials {
    pub fn new(vault: CredentialVault) -> Self {
        Self { vault }
    }

    /// The named credential's secret. A name the vault does not hold is an error that says how
    /// to add it on this machine.
    pub async fn resolve(&self, name: &str) -> Result<Credential> {
        let value = self
            .vault
            .resolve(&credential_vault_id(name))
            .await
            .with_context(|| format!("read Workspace Credential {name}"))?
            .with_context(|| {
                format!(
                    "Workspace Credential {name} has no secret on the machine that runs git delivery; run supertag workspace credential add {name} there"
                )
            })?;
        Credential::from_vault_value(&value)
            .with_context(|| format!("Workspace Credential {name} is unusable"))
    }
}

/// Removes leftover private files of an earlier run. Only names git delivery creates are removed.
pub(crate) fn sweep(directory: &Path, prefix: &str) -> Result<()> {
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        if entry
            .file_name()
            .to_str()
            .is_some_and(|name| name.starts_with(prefix))
        {
            if entry.file_type()?.is_dir() {
                fs::remove_dir_all(entry.path())?;
            } else {
                fs::remove_file(entry.path())?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vault_values_round_trip_and_never_echo_secrets() {
        for credential in [
            Credential::SshKey {
                private_key:
                    "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n"
                        .into(),
                known_hosts: Some("git.example ssh-ed25519 AAAA".into()),
            },
            Credential::HttpsToken {
                username: "supertag".into(),
                token: "glpat-secret".into(),
            },
            Credential::Helper {
                helper: "!/usr/local/bin/mint-token".into(),
            },
        ] {
            let value = credential.to_vault_value();
            assert!(Credential::from_vault_value(&value).unwrap() == credential);
        }
        let mut broken = CredentialValue::new();
        broken.insert("kind".into(), "https-token".into());
        broken.insert("username".into(), "a:b".into());
        broken.insert("token".into(), "glpat-secret".into());
        let error = format!("{:#}", Credential::from_vault_value(&broken).err().unwrap());
        assert!(!error.contains("glpat-secret"), "{error}");
    }

    #[test]
    fn credentials_only_reach_their_own_transport() {
        let private = tempfile::tempdir().unwrap();
        let token = Credential::HttpsToken {
            username: "u".into(),
            token: "t".into(),
        };
        assert!(
            token
                .settings(
                    RemoteTransport::Ssh,
                    private.path(),
                    &private.path().join("h")
                )
                .is_err()
        );
        let settings = token
            .settings(
                RemoteTransport::Http,
                private.path(),
                &private.path().join("h"),
            )
            .unwrap();
        assert_eq!(settings.config[0].0, "http.extraHeader");
        assert_eq!(settings.config[0].1, "Authorization: Basic dTp0");
        let key = Credential::SshKey {
            private_key:
                "-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----".into(),
            known_hosts: None,
        };
        let settings = key
            .settings(
                RemoteTransport::Ssh,
                private.path(),
                &private.path().join("h"),
            )
            .unwrap();
        assert!(
            settings.environment[0]
                .1
                .contains("StrictHostKeyChecking=accept-new")
        );
        assert!(
            std::fs::read_to_string(private.path().join("identity"))
                .unwrap()
                .ends_with("KEY-----\n")
        );
    }
}
