use std::{
    collections::BTreeMap,
    ffi::OsString,
    fs::{File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, bail, ensure};
use serde_json::Value;
use tempfile::TempDir;

pub(crate) struct Prepared {
    directory: TempDir,
    key: Option<String>,
    secrets: Vec<String>,
}

impl Prepared {
    pub(crate) fn new(
        source: &BTreeMap<OsString, OsString>,
        state_directory: &Path,
    ) -> Result<Self> {
        let metadata = std::fs::symlink_metadata(state_directory)
            .context("Codex Attempt scratch is unavailable")?;
        ensure!(
            metadata.is_dir()
                && metadata.uid() == unsafe { libc::geteuid() }
                && metadata.mode() & 0o077 == 0,
            "Codex Attempt scratch must be a private directory owned by this user"
        );
        let directory = tempfile::Builder::new()
            .prefix("supertag-codex-")
            .permissions(std::fs::Permissions::from_mode(0o700))
            .tempdir_in(state_directory)
            .context("could not create private Codex home")?;
        let mut prepared = Self {
            directory,
            key: None,
            secrets: Vec::new(),
        };
        if let Some(key) = variable(source, "CODEX_API_KEY")? {
            prepared.secrets.push(key.clone());
            prepared.key = Some(key);
            return Ok(prepared);
        }
        let source_home = source
            .get(&OsString::from("CODEX_HOME"))
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .or_else(|| {
                source
                    .get(&OsString::from("HOME"))
                    .filter(|value| !value.is_empty())
                    .map(|home| PathBuf::from(home).join(".codex"))
            });
        if let Some(home) = source_home {
            ensure!(
                home.is_absolute(),
                "Codex authentication home must be absolute"
            );
            match OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
                .open(home.join("auth.json"))
            {
                Ok(file) => {
                    let (bytes, secrets) = read_auth(file)?;
                    let mut destination = OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .mode(0o600)
                        .open(prepared.directory.path().join("auth.json"))
                        .context("could not stage selected Codex sign-in")?;
                    destination
                        .write_all(&bytes)
                        .context("could not stage selected Codex sign-in")?;
                    prepared.secrets = secrets;
                    return Ok(prepared);
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => bail!("could not safely read selected Codex sign-in"),
            }
        }
        if let Some(key) = variable(source, "OPENAI_API_KEY")? {
            prepared.secrets.push(key.clone());
            prepared.key = Some(key);
            return Ok(prepared);
        }
        bail!("Codex requires CODEX_API_KEY, a file-backed Codex sign-in, or OPENAI_API_KEY")
    }

    pub(crate) fn environment(
        &self,
        source: &BTreeMap<OsString, OsString>,
    ) -> BTreeMap<OsString, OsString> {
        let mut environment = BTreeMap::new();
        for name in ["PATH", "LANG", "LC_ALL", "TERM", "TMPDIR", "TMP", "TEMP"] {
            if let Some(value) = source.get(&OsString::from(name)) {
                environment.insert(name.into(), value.clone());
            }
        }
        // Keep native user config, hooks, Skills, and tool credentials out of the
        // child environment. Only the selected auth.json is copied into this home.
        environment.insert("HOME".into(), self.directory.path().as_os_str().to_owned());
        environment.insert(
            "CODEX_HOME".into(),
            self.directory.path().as_os_str().to_owned(),
        );
        if let Some(key) = &self.key {
            environment.insert("CODEX_API_KEY".into(), key.into());
        }
        environment
    }

    pub(crate) fn secrets(&self) -> Vec<String> {
        self.secrets.clone()
    }

    pub(crate) fn home(&self) -> &Path {
        self.directory.path()
    }
}

fn variable(source: &BTreeMap<OsString, OsString>, name: &str) -> Result<Option<String>> {
    source
        .get(&OsString::from(name))
        .map(|value| {
            let value = value
                .to_str()
                .context("Codex credential environment is not valid UTF-8")?
                .trim();
            ensure!(
                value.len() <= 65_536 && !value.contains(['\r', '\n', '\0']),
                "Codex credential environment is invalid"
            );
            Ok((!value.is_empty()).then(|| value.to_owned()))
        })
        .transpose()
        .map(Option::flatten)
}

fn read_auth(file: File) -> Result<(Vec<u8>, Vec<String>)> {
    let metadata = file
        .metadata()
        .context("could not inspect selected Codex sign-in")?;
    ensure!(
        metadata.is_file() && metadata.len() <= 65_536,
        "Codex sign-in must be a regular JSON file no larger than 64 KiB"
    );
    let mut bytes = Vec::new();
    file.take(65_537)
        .read_to_end(&mut bytes)
        .context("could not read selected Codex sign-in")?;
    ensure!(
        bytes.len() <= 65_536,
        "Codex sign-in exceeds its size limit"
    );
    let value: Value = serde_json::from_slice(&bytes).context("Codex sign-in is not valid JSON")?;
    ensure!(value.is_object(), "Codex sign-in must be a JSON object");
    let api_key = value
        .get("OPENAI_API_KEY")
        .and_then(Value::as_str)
        .is_some_and(|key| !key.trim().is_empty());
    let oauth = value
        .get("tokens")
        .and_then(|tokens| tokens.get("refresh_token"))
        .and_then(Value::as_str)
        .is_some_and(|token| !token.trim().is_empty());
    ensure!(
        api_key || oauth,
        "Codex sign-in does not contain a supported credential"
    );
    let mut secrets = Vec::new();
    collect_secrets(&value, &mut secrets);
    Ok((bytes, secrets))
}

fn collect_secrets(value: &Value, secrets: &mut Vec<String>) {
    match value {
        Value::Object(object) => {
            for (name, value) in object {
                if ["token", "key", "secret", "password"]
                    .iter()
                    .any(|part| name.to_ascii_lowercase().contains(part))
                    && let Some(value) = value.as_str().filter(|value| !value.is_empty())
                {
                    secrets.push(value.into());
                }
                collect_secrets(value, secrets);
            }
        }
        Value::Array(values) => {
            for value in values {
                collect_secrets(value, secrets);
            }
        }
        _ => {}
    }
}

pub(crate) fn redact(mut text: String, secrets: &[String]) -> String {
    let mut ordered = secrets
        .iter()
        .filter(|secret| !secret.is_empty())
        .collect::<Vec<_>>();
    ordered.sort_by_key(|secret| std::cmp::Reverse(secret.len()));
    for secret in ordered {
        text = text.replace(secret, "[REDACTED]");
    }
    text
}
