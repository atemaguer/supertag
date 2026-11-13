//! Durable Gateway collaboration credentials, kept apart from the Control Plane database.
//!
//! Matches the TypeScript `GatewayCredentialVault` contract
//! (`packages/store/src/index.ts` `FileGatewayCredentialVault`,
//! `packages/store/src/vault-credential-vault.ts` `VaultGatewayCredentialVault`, and
//! `apps/cli/src/credential-vault.ts` `createCredentialVaultFromEnvironment`). A credential is a
//! flat string map addressed by a logical ID such as `surface/slack/<account>`. Values never enter
//! errors, logs, or Worker Host sandboxes: only the Gateway resolves them.

use std::{
    collections::BTreeMap,
    fs::{self, DirBuilder, File, OpenOptions},
    io::Write as _,
    os::{
        fd::AsRawFd,
        unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt},
    },
    path::{Path, PathBuf},
    time::Duration,
};

use anyhow::{Context, Result, anyhow, bail, ensure};
use reqwest::{Method, StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// One credential: field names to secret strings, such as `botToken` and `signingSecret`.
pub type CredentialValue = BTreeMap<String, String>;

const FILE_NAME: &str = "gateway-credentials.json";
const FILE_VERSION: u32 = 1;
const VAULT_TIMEOUT: Duration = Duration::from_secs(10);

/// The configured backend. Do not derive Debug: the Vault variant holds a token.
pub enum CredentialVault {
    File(FileCredentialVault),
    Vault(HashicorpVault),
}

impl CredentialVault {
    /// Selects the backend the way the TypeScript Control Plane does:
    /// `SUPERTAG_CREDENTIAL_VAULT` is `file` (the default) or `vault`. The file backend lives in
    /// `SUPERTAG_STATE_DIR`, else `~/.supertag`. The Vault backend requires `VAULT_ADDR` and
    /// `VAULT_TOKEN` and accepts `SUPERTAG_VAULT_MOUNT`, `SUPERTAG_VAULT_PATH_PREFIX`, and
    /// `VAULT_NAMESPACE`.
    pub fn from_environment(environment: impl Fn(&str) -> Option<String>) -> Result<Self> {
        let value = |key: &str| {
            environment(key)
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty())
        };
        match value("SUPERTAG_CREDENTIAL_VAULT")
            .as_deref()
            .unwrap_or("file")
        {
            "file" => {
                let directory = value("SUPERTAG_STATE_DIR")
                    .map(PathBuf::from)
                    .or_else(|| value("HOME").map(|home| PathBuf::from(home).join(".supertag")))
                    .context(
                        "SUPERTAG_STATE_DIR or HOME is required for the file credential vault",
                    )?;
                Ok(Self::File(FileCredentialVault::new(
                    directory.join(FILE_NAME),
                )))
            }
            "vault" => {
                let required = |key: &str| {
                    value(key).ok_or_else(|| {
                        anyhow!("{key} is required when SUPERTAG_CREDENTIAL_VAULT=vault")
                    })
                };
                Ok(Self::Vault(HashicorpVault::new(VaultOptions {
                    address: required("VAULT_ADDR")?,
                    token: required("VAULT_TOKEN")?,
                    mount: value("SUPERTAG_VAULT_MOUNT"),
                    path_prefix: value("SUPERTAG_VAULT_PATH_PREFIX"),
                    namespace: value("VAULT_NAMESPACE"),
                })?))
            }
            _ => bail!("SUPERTAG_CREDENTIAL_VAULT must be file or vault"),
        }
    }

    /// The process environment.
    pub fn from_process_environment() -> Result<Self> {
        Self::from_environment(|key| std::env::var(key).ok())
    }

    pub async fn store(&self, id: &str, value: &CredentialValue) -> Result<()> {
        validate_id(id)?;
        validate_value(value)?;
        match self {
            Self::File(file) => file.store(id, value).await,
            Self::Vault(vault) => vault.store(id, value).await,
        }
    }

    /// Atomically keeps an existing value or creates `value`, returning the winner.
    pub async fn store_if_absent(
        &self,
        id: &str,
        value: &CredentialValue,
    ) -> Result<CredentialValue> {
        validate_id(id)?;
        validate_value(value)?;
        match self {
            Self::File(file) => file.store_if_absent(id, value).await,
            Self::Vault(vault) => vault.store_if_absent(id, value).await,
        }
    }

    pub async fn resolve(&self, id: &str) -> Result<Option<CredentialValue>> {
        validate_id(id)?;
        match self {
            Self::File(file) => file.resolve(id).await,
            Self::Vault(vault) => vault.resolve(id).await,
        }
    }

    pub async fn delete(&self, id: &str) -> Result<()> {
        validate_id(id)?;
        match self {
            Self::File(file) => file.delete(id).await,
            Self::Vault(vault) => vault.delete(id).await,
        }
    }
}

/// Same identifier rule as TypeScript `validateCredentialId`.
pub fn validate_id(id: &str) -> Result<()> {
    let bytes = id.as_bytes();
    ensure!(
        (3..=201).contains(&bytes.len())
            && bytes[0].is_ascii_alphanumeric()
            && bytes
                .iter()
                .all(|b| b.is_ascii_alphanumeric() || b"/_-".contains(b)),
        "Credential identifier contains unsupported characters"
    );
    Ok(())
}

fn validate_value(value: &CredentialValue) -> Result<()> {
    ensure!(
        !value.is_empty() && value.len() <= 64,
        "a credential needs between 1 and 64 fields"
    );
    ensure!(
        value
            .iter()
            .all(|(key, item)| !key.is_empty() && key.len() <= 128 && item.len() <= 65_536),
        "credential fields must be named and at most 64 KiB"
    );
    Ok(())
}

#[derive(Serialize, Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct CredentialFile {
    version: u32,
    gateway: BTreeMap<String, CredentialValue>,
}

/// Lock-protected private JSON file for local deployments.
pub struct FileCredentialVault {
    path: PathBuf,
}

impl FileCredentialVault {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    async fn store(&self, id: &str, value: &CredentialValue) -> Result<()> {
        let (id, value) = (id.to_owned(), value.clone());
        self.locked(move |file| {
            file.gateway.insert(id, value);
            Ok(true)
        })
        .await
        .map(|_| ())
    }

    async fn store_if_absent(&self, id: &str, value: &CredentialValue) -> Result<CredentialValue> {
        let (id, value) = (id.to_owned(), value.clone());
        let path = self.path.clone();
        tokio::task::spawn_blocking(move || {
            with_lock(&path, |file| match file.gateway.get(&id) {
                Some(existing) => Ok((false, existing.clone())),
                None => {
                    file.gateway.insert(id, value.clone());
                    Ok((true, value))
                }
            })
        })
        .await?
    }

    async fn resolve(&self, id: &str) -> Result<Option<CredentialValue>> {
        let path = self.path.clone();
        let id = id.to_owned();
        tokio::task::spawn_blocking(move || Ok(read_file(&path)?.gateway.remove(&id))).await?
    }

    async fn delete(&self, id: &str) -> Result<()> {
        let id = id.to_owned();
        self.locked(move |file| Ok(file.gateway.remove(&id).is_some()))
            .await
            .map(|_| ())
    }

    async fn locked(
        &self,
        change: impl FnOnce(&mut CredentialFile) -> Result<bool> + Send + 'static,
    ) -> Result<()> {
        let path = self.path.clone();
        tokio::task::spawn_blocking(move || {
            with_lock(&path, |file| Ok((change(file)?, ()))).map(|_| ())
        })
        .await?
    }
}

/// Holds an exclusive advisory lock beside the file while it reads, changes, and atomically
/// replaces it. Returns the closure's value; writes only when the closure reports a change.
fn with_lock<T>(
    path: &Path,
    change: impl FnOnce(&mut CredentialFile) -> Result<(bool, T)>,
) -> Result<T> {
    let directory = path
        .parent()
        .context("credential vault path has no directory")?;
    if !directory.exists() {
        DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(directory)
            .context("create credential vault directory")?;
    }
    let lock_path = path.with_extension("lock");
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&lock_path)
        .context("open credential vault lock")?;
    // SAFETY: flock only inspects the open descriptor owned by `lock`.
    ensure!(
        unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX) } == 0,
        "lock credential vault: {}",
        std::io::Error::last_os_error()
    );
    let mut file = read_file(path)?;
    let (changed, result) = change(&mut file)?;
    if changed {
        write_file(path, &file)?;
    }
    drop(lock);
    Ok(result)
}

fn read_file(path: &Path) -> Result<CredentialFile> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(CredentialFile {
                version: FILE_VERSION,
                ..Default::default()
            });
        }
        Err(error) => return Err(error).context("read credential vault"),
    };
    ensure!(
        metadata.file_type().is_file(),
        "Credential store is not a regular file: {}",
        path.display()
    );
    ensure!(
        metadata.permissions().mode() & 0o077 == 0,
        "Credential store must not be readable by other users: {}",
        path.display()
    );
    let bytes = fs::read(path).context("read credential vault")?;
    // Parsing errors stay generic because this file contains credentials.
    let file: CredentialFile = serde_json::from_slice(&bytes).map_err(|_| {
        anyhow!(
            "Credential store has an unsupported format: {}; expected version {FILE_VERSION} with only version and gateway fields",
            path.display()
        )
    })?;
    ensure!(
        file.version == FILE_VERSION,
        "Credential store has an unsupported format: {}; expected version {FILE_VERSION}",
        path.display()
    );
    Ok(file)
}

fn write_file(path: &Path, file: &CredentialFile) -> Result<()> {
    let directory = path
        .parent()
        .context("credential vault path has no directory")?;
    let mut temporary = tempfile::Builder::new()
        .prefix(".gateway-credentials-")
        .permissions(fs::Permissions::from_mode(0o600))
        .tempfile_in(directory)
        .context("create credential vault update")?;
    let mut bytes = serde_json::to_vec_pretty(file)?;
    bytes.push(b'\n');
    temporary.write_all(&bytes)?;
    temporary.as_file().sync_all()?;
    temporary
        .persist(path)
        .map_err(|error| anyhow!("replace credential vault: {}", error.error))?;
    File::open(directory)?.sync_all()?;
    Ok(())
}

/// Options for [`HashicorpVault`]. Do not derive Debug: it holds the token.
pub struct VaultOptions {
    pub address: String,
    pub token: String,
    pub mount: Option<String>,
    /// Provider-side namespace applied before SuperTag's logical credential IDs.
    pub path_prefix: Option<String>,
    /// Vault Enterprise namespace, sent as `X-Vault-Namespace`.
    pub namespace: Option<String>,
}

/// HashiCorp Vault KV v2 backend.
pub struct HashicorpVault {
    address: Url,
    token: String,
    mount: String,
    path_prefix: String,
    namespace: Option<String>,
    http: reqwest::Client,
}

impl HashicorpVault {
    pub fn new(options: VaultOptions) -> Result<Self> {
        let token = options.token.trim().to_owned();
        ensure!(!token.is_empty(), "Vault token must not be empty");
        ensure!(
            token.bytes().all(|b| b.is_ascii_graphic()),
            "Vault token contains unsupported characters"
        );
        let namespace = options
            .namespace
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty());
        if let Some(namespace) = &namespace {
            ensure!(
                namespace.bytes().all(|b| b.is_ascii_graphic()),
                "Vault namespace contains unsupported characters"
            );
        }
        Ok(Self {
            address: normalize_address(&options.address)?,
            token,
            mount: path_component(options.mount.as_deref().unwrap_or("secret"), "Vault mount")?,
            path_prefix: path_prefix(options.path_prefix.as_deref().unwrap_or("supertag"))?,
            namespace,
            http: reqwest::Client::builder()
                .timeout(VAULT_TIMEOUT)
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
        })
    }

    fn url(&self, area: &str, id: &str) -> Result<Url> {
        let mut url = self.address.clone();
        {
            let mut segments = url
                .path_segments_mut()
                .map_err(|_| anyhow!("Vault address cannot be a base URL"))?;
            segments
                .pop_if_empty()
                .push("v1")
                .push(&self.mount)
                .push(area);
            for part in self.path_prefix.split('/').chain(id.split('/')) {
                segments.push(part);
            }
        }
        Ok(url)
    }

    async fn call(
        &self,
        method: Method,
        area: &str,
        id: &str,
        body: Option<Value>,
    ) -> Result<reqwest::Response> {
        let mut request = self
            .http
            .request(method, self.url(area, id)?)
            .header("X-Vault-Token", &self.token);
        if let Some(namespace) = &self.namespace {
            request = request.header("X-Vault-Namespace", namespace);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        // Transport errors can include the URL but never the token header.
        request
            .send()
            .await
            .map_err(|error| anyhow!("Vault request failed: {}", error.without_url()))
    }

    async fn store(&self, id: &str, value: &CredentialValue) -> Result<()> {
        let response = self
            .call(Method::POST, "data", id, Some(json!({ "data": value })))
            .await?;
        ensure_ok(response.status(), "store")
    }

    async fn store_if_absent(&self, id: &str, value: &CredentialValue) -> Result<CredentialValue> {
        let response = self
            .call(
                Method::POST,
                "data",
                id,
                Some(json!({ "options": { "cas": 0 }, "data": value })),
            )
            .await?;
        if response.status().is_success() {
            return Ok(value.clone());
        }
        // KV v2 reports create-only CAS conflicts as HTTP 400. Never retry unconditionally.
        if response.status() == StatusCode::BAD_REQUEST
            && let Some(existing) = self.resolve(id).await?
        {
            return Ok(existing);
        }
        Err(vault_error("initialize", response.status()))
    }

    async fn resolve(&self, id: &str) -> Result<Option<CredentialValue>> {
        let response = self.call(Method::GET, "data", id, None).await?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        ensure_ok(response.status(), "resolve")?;
        let body: Value = response
            .json()
            .await
            .map_err(|_| anyhow!("Vault returned an invalid credential payload"))?;
        let value = body
            .get("data")
            .and_then(|data| data.get("data"))
            .and_then(Value::as_object)
            .and_then(|fields| {
                fields
                    .iter()
                    .map(|(key, item)| Some((key.clone(), item.as_str()?.to_owned())))
                    .collect::<Option<CredentialValue>>()
            })
            .ok_or_else(|| anyhow!("Vault returned an invalid credential payload"))?;
        Ok(Some(value))
    }

    async fn delete(&self, id: &str) -> Result<()> {
        let response = self.call(Method::DELETE, "metadata", id, None).await?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(());
        }
        ensure_ok(response.status(), "delete")
    }
}

fn ensure_ok(status: StatusCode, operation: &str) -> Result<()> {
    if status.is_success() {
        Ok(())
    } else {
        Err(vault_error(operation, status))
    }
}

/// Response bodies are never included: Vault can echo request details.
fn vault_error(operation: &str, status: StatusCode) -> anyhow::Error {
    anyhow!(
        "Vault could not {operation} Gateway credentials (HTTP {})",
        status.as_u16()
    )
}

fn normalize_address(input: &str) -> Result<Url> {
    let url = Url::parse(input.trim()).context("Vault address must be a URL")?;
    match url.scheme() {
        "https" => {}
        "http" => {
            let host = url.host_str().unwrap_or_default();
            let loopback = host == "localhost"
                || host
                    .trim_start_matches('[')
                    .trim_end_matches(']')
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|address| address.is_loopback());
            ensure!(loopback, "Non-loopback Vault addresses must use HTTPS");
        }
        _ => bail!("Vault address must use http: or https:"),
    }
    ensure!(
        url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none(),
        "Vault address must not contain credentials, query parameters, or fragments"
    );
    Ok(url)
}

fn path_component(value: &str, label: &str) -> Result<String> {
    let value = value.trim();
    let bytes = value.as_bytes();
    ensure!(
        (1..=63).contains(&bytes.len())
            && bytes[0].is_ascii_alphanumeric()
            && bytes
                .iter()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(b)),
        "{label} contains unsupported characters"
    );
    Ok(value.to_owned())
}

fn path_prefix(value: &str) -> Result<String> {
    let value = value.trim().trim_matches('/');
    ensure!(
        !value.is_empty(),
        "Vault path prefix contains unsupported characters"
    );
    for part in value.split('/') {
        path_component(part, "Vault path")?;
    }
    Ok(value.to_owned())
}

#[cfg(test)]
mod tests {
    use std::{
        collections::HashMap,
        sync::{Arc, Mutex},
    };

    use axum::{
        Json, Router,
        body::Bytes,
        extract::{Path as UrlPath, State},
        http::{HeaderMap, Method as HttpMethod, StatusCode as HttpStatus},
        response::{IntoResponse, Response},
        routing::any,
    };

    use super::*;

    /// Method, path, and Vault namespace of one request.
    type Observed = (String, String, Option<String>);

    #[derive(Clone, Default)]
    struct FakeVault {
        entries: Arc<Mutex<HashMap<String, Value>>>,
        requests: Arc<Mutex<Vec<Observed>>>,
    }

    /// A loopback KV v2 endpoint: `/v1/<mount>/{data,metadata}/<path>`.
    async fn kv(
        State(state): State<FakeVault>,
        method: HttpMethod,
        headers: HeaderMap,
        UrlPath(path): UrlPath<String>,
        body: Bytes,
    ) -> Response {
        let header = |name: &str| {
            headers
                .get(name)
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned)
        };
        state.requests.lock().unwrap().push((
            method.to_string(),
            format!("/v1/{path}"),
            header("x-vault-namespace"),
        ));
        if header("x-vault-token").as_deref() != Some("root-token") {
            return (
                HttpStatus::FORBIDDEN,
                "permission denied: echoed-body-detail",
            )
                .into_response();
        }
        let (mount, rest) = path.split_once('/').unwrap();
        let (area, key) = rest.split_once('/').unwrap();
        let key = format!("{mount}/{key}");
        let mut entries = state.entries.lock().unwrap();
        match (method, area) {
            (HttpMethod::GET, "data") => match entries.get(&key) {
                Some(value) => Json(json!({ "data": { "data": value } })).into_response(),
                None => HttpStatus::NOT_FOUND.into_response(),
            },
            (HttpMethod::POST, "data") => {
                let body: Value = serde_json::from_slice(&body).unwrap();
                if body["options"]["cas"] == json!(0) && entries.contains_key(&key) {
                    return HttpStatus::BAD_REQUEST.into_response();
                }
                entries.insert(key, body["data"].clone());
                Json(json!({ "data": { "version": 1 } })).into_response()
            }
            (HttpMethod::DELETE, "metadata") => {
                entries.remove(&key);
                HttpStatus::NO_CONTENT.into_response()
            }
            _ => HttpStatus::METHOD_NOT_ALLOWED.into_response(),
        }
    }

    async fn fake_vault() -> (FakeVault, String) {
        let state = FakeVault::default();
        let app = Router::new()
            .route("/v1/{*path}", any(kv))
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await });
        (state, format!("http://{address}"))
    }

    fn credential(pairs: &[(&str, &str)]) -> CredentialValue {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect()
    }

    fn environment(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect();
        move |key| map.get(key).cloned()
    }

    #[test]
    fn selects_file_by_default_and_requires_a_supported_provider() {
        let vault =
            CredentialVault::from_environment(environment(&[("SUPERTAG_STATE_DIR", "/state")]))
                .unwrap();
        let CredentialVault::File(file) = vault else {
            panic!("expected the file vault")
        };
        assert_eq!(file.path(), Path::new("/state/gateway-credentials.json"));
        let error = CredentialVault::from_environment(environment(&[
            ("SUPERTAG_CREDENTIAL_VAULT", "typo"),
            ("HOME", "/home/test"),
        ]))
        .err()
        .unwrap();
        assert!(error.to_string().contains("must be file or vault"));
    }

    #[test]
    fn vault_fails_closed_without_address_or_token_and_requires_tls_off_loopback() {
        for missing in ["VAULT_ADDR", "VAULT_TOKEN"] {
            let error = CredentialVault::from_environment(environment(&[
                ("SUPERTAG_CREDENTIAL_VAULT", "vault"),
                ("VAULT_ADDR", "https://vault.example.com"),
                ("VAULT_TOKEN", "secret-token"),
                (missing, " "),
            ]))
            .err()
            .unwrap();
            assert!(
                error
                    .to_string()
                    .contains(&format!("{missing} is required"))
            );
        }
        for (address, message) in [
            ("http://vault.example.com", "must use HTTPS"),
            ("ftp://127.0.0.1", "http: or https:"),
            ("https://user:pass@vault.example.com", "must not contain"),
            ("https://vault.example.com/?token=x", "must not contain"),
        ] {
            let error = HashicorpVault::new(VaultOptions {
                address: address.into(),
                token: "secret-token".into(),
                mount: None,
                path_prefix: None,
                namespace: None,
            })
            .err()
            .unwrap();
            assert!(error.to_string().contains(message), "{address}: {error}");
            assert!(!error.to_string().contains("secret-token"));
        }
        for (mount, prefix) in [("bad mount", "ok"), ("ok", "a/../b"), ("ok", "/")] {
            assert!(
                HashicorpVault::new(VaultOptions {
                    address: "http://[::1]:8200".into(),
                    token: "t".into(),
                    mount: Some(mount.into()),
                    path_prefix: Some(prefix.into()),
                    namespace: None,
                })
                .is_err()
            );
        }
    }

    #[test]
    fn credential_identifiers_match_the_typescript_rule() {
        for id in [
            "surface/slack/T123",
            "control-plane/coordination-signing-key",
        ] {
            validate_id(id).unwrap();
        }
        for id in [
            "ab",
            "/leading",
            "has space",
            "dot.ted",
            "../escape",
            &"a".repeat(202),
        ] {
            assert!(validate_id(id).is_err(), "{id}");
        }
    }

    #[tokio::test]
    async fn vault_stores_rotates_resolves_deletes_and_uses_mount_prefix_and_namespace() {
        let (state, address) = fake_vault().await;
        let vault = CredentialVault::from_environment(environment(&[
            ("SUPERTAG_CREDENTIAL_VAULT", "vault"),
            ("VAULT_ADDR", &address),
            ("VAULT_TOKEN", "root-token"),
            ("SUPERTAG_VAULT_MOUNT", "organization"),
            ("SUPERTAG_VAULT_PATH_PREFIX", "/production/"),
            ("VAULT_NAMESPACE", "team"),
        ]))
        .unwrap();
        let id = "surface/slack/T123";
        assert_eq!(vault.resolve(id).await.unwrap(), None);
        let first = credential(&[("botToken", "vault-v1"), ("signingSecret", "signing-v1")]);
        vault.store(id, &first).await.unwrap();
        assert_eq!(vault.resolve(id).await.unwrap(), Some(first));
        let second = credential(&[("botToken", "vault-v2"), ("signingSecret", "signing-v2")]);
        vault.store(id, &second).await.unwrap();
        assert_eq!(vault.resolve(id).await.unwrap(), Some(second.clone()));
        // Create-only initialization keeps the existing value.
        let winner = vault
            .store_if_absent(id, &credential(&[("botToken", "loser")]))
            .await
            .unwrap();
        assert_eq!(winner, second);
        vault.delete(id).await.unwrap();
        vault.delete(id).await.unwrap();
        assert_eq!(vault.resolve(id).await.unwrap(), None);
        let created = credential(&[("key", "durable")]);
        assert_eq!(
            vault
                .store_if_absent("control-plane/coordination-signing-key", &created)
                .await
                .unwrap(),
            created
        );
        let requests = state.requests.lock().unwrap().clone();
        assert_eq!(
            requests[0],
            (
                "GET".into(),
                "/v1/organization/data/production/surface/slack/T123".into(),
                Some("team".into())
            )
        );
        assert!(requests.iter().any(|(method, path, _)| method == "DELETE"
            && path == "/v1/organization/metadata/production/surface/slack/T123"));
    }

    #[tokio::test]
    async fn vault_errors_fail_closed_without_response_bodies_or_tokens() {
        let (_, address) = fake_vault().await;
        let denied = HashicorpVault::new(VaultOptions {
            address,
            token: "invalid-validation-token".into(),
            mount: Some("supertag".into()),
            path_prefix: Some("validation".into()),
            namespace: None,
        })
        .unwrap();
        let denied = CredentialVault::Vault(denied);
        let error = denied.resolve("surface/slack/denied").await.unwrap_err();
        assert_eq!(
            error.to_string(),
            "Vault could not resolve Gateway credentials (HTTP 403)"
        );
        let error = denied
            .store("surface/slack/denied", &credential(&[("botToken", "x")]))
            .await
            .unwrap_err()
            .to_string();
        assert_eq!(
            error,
            "Vault could not store Gateway credentials (HTTP 403)"
        );
        assert!(!error.contains("echoed-body-detail"));
    }

    #[tokio::test]
    async fn file_vault_is_private_atomic_and_refuses_unsafe_files() {
        let directory = tempfile::tempdir().unwrap();
        let state = directory.path().join("state");
        let vault = CredentialVault::from_environment(environment(&[(
            "SUPERTAG_STATE_DIR",
            state.to_str().unwrap(),
        )]))
        .unwrap();
        let id = "surface/slack/T123";
        assert_eq!(vault.resolve(id).await.unwrap(), None);
        let first = credential(&[("botToken", "file-v1"), ("signingSecret", "signing-v1")]);
        vault.store(id, &first).await.unwrap();
        let path = state.join("gateway-credentials.json");
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(&state).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(vault.resolve(id).await.unwrap(), Some(first.clone()));
        // Concurrent create-only initialization has exactly one winner.
        let vault = Arc::new(vault);
        let racers = (0..8).map(|index| {
            let vault = vault.clone();
            tokio::spawn(async move {
                vault
                    .store_if_absent(
                        "control-plane/coordination-signing-key",
                        &credential(&[("key", &format!("candidate-{index}"))]),
                    )
                    .await
                    .unwrap()
            })
        });
        let mut winners = Vec::new();
        for racer in racers {
            winners.push(racer.await.unwrap());
        }
        winners.dedup();
        assert_eq!(winners.len(), 1);
        assert_eq!(vault.resolve(id).await.unwrap(), Some(first));
        vault.delete(id).await.unwrap();
        assert_eq!(vault.resolve(id).await.unwrap(), None);

        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(
            vault
                .resolve(id)
                .await
                .unwrap_err()
                .to_string()
                .contains("must not be readable")
        );
        fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(directory.path().join("elsewhere"), &path).unwrap();
        assert!(
            vault
                .resolve(id)
                .await
                .unwrap_err()
                .to_string()
                .contains("not a regular file")
        );
        fs::remove_file(&path).unwrap();
        fs::write(
            &path,
            r#"{"version":1,"gateway":{},"operator":{"x":{"y":"leak"}}}"#,
        )
        .unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let error = vault.resolve(id).await.unwrap_err().to_string();
        assert!(error.contains("unsupported format") && !error.contains("leak"));
        assert!(
            vault
                .store(id, &CredentialValue::new())
                .await
                .unwrap_err()
                .to_string()
                .contains("between 1 and 64")
        );
    }
}
