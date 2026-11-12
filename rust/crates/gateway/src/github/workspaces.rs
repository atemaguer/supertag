//! Trusted GitHub source acquisition. Credentials never enter a Host or bundle.
use anyhow::{Context, Result, ensure};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use reqwest::{Client, Url};
use serde_json::Value;
use std::{
    fs,
    os::unix::fs::MetadataExt as _,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::Duration,
};
use supertag_protocol::v2::GithubWorkspace;
use supertag_workspaces::{TransferArtifact, source};
use tempfile::TempDir;
use tokio::{io::AsyncReadExt, process::Command, time};
use tokio_util::sync::CancellationToken;

use super::{GithubAuthentication, auth::Authentication, valid_id, valid_repository};

mod refs;
#[cfg(test)]
mod tests;

pub struct GithubWorkspaceAccount {
    pub account_id: String,
    pub repository_id: u64,
    pub repository: String,
    pub authentication: GithubAuthentication,
}

#[derive(Clone)]
pub struct GithubWorkspaceSources(Arc<SourceClient>);
struct SourceClient {
    account: String,
    repository_id: u64,
    repository: String,
    authentication: Authentication,
    http: Client,
    api: Url,
    git: Url,
    directory: PathBuf,
}

pub(crate) struct FetchedSource {
    pub bundle: TransferArtifact,
    // Keep private source state alive until its stream is complete or dropped.
    pub _directory: TempDir,
}

impl GithubWorkspaceSources {
    pub fn new(configuration: GithubWorkspaceAccount, directory: &Path) -> Result<Self> {
        ensure!(
            !configuration.account_id.is_empty() && configuration.account_id.len() <= 256,
            "GitHub Workspace account is required"
        );
        ensure!(
            valid_id(configuration.repository_id) && valid_repository(&configuration.repository),
            "invalid GitHub Workspace repository"
        );
        let repository = configuration.repository.to_ascii_lowercase();
        let authentication = Authentication::source_reader(
            &configuration.authentication,
            configuration.repository_id,
            &repository,
        )?;
        let metadata = directory.symlink_metadata()?;
        ensure!(
            metadata.is_dir()
                && metadata.uid() == unsafe { libc::geteuid() }
                && metadata.mode() & 0o077 == 0,
            "Gateway source directory must be private"
        );
        let directory = directory
            .canonicalize()
            .context("find private Gateway source directory")?;
        Ok(Self(Arc::new(SourceClient {
            account: configuration.account_id,
            repository_id: configuration.repository_id,
            repository,
            authentication,
            http: Client::builder()
                .connect_timeout(Duration::from_secs(3))
                .timeout(Duration::from_secs(10))
                .redirect(reqwest::redirect::Policy::none())
                .retry(reqwest::retry::never())
                .no_proxy()
                .build()?,
            api: "https://api.github.com/".parse()?,
            git: "https://github.com/".parse()?,
            directory,
        })))
    }

    #[cfg(any(test, feature = "test-fixtures"))]
    pub fn with_test_endpoints(mut self, api: Url, git: Url) -> Result<Self> {
        for url in [&api, &git] {
            ensure!(
                url.scheme() == "http"
                    && url.host_str() == Some("127.0.0.1")
                    && url.username().is_empty()
                    && url.password().is_none(),
                "fixture endpoints must be literal loopback HTTP"
            );
        }
        let inner = Arc::get_mut(&mut self.0).context("source client is already shared")?;
        inner.api = api;
        inner.git = git;
        Ok(self)
    }

    pub(crate) async fn fetch(
        &self,
        workspace: &GithubWorkspace,
        cancel: &CancellationToken,
    ) -> Result<FetchedSource> {
        ensure!(!cancel.is_cancelled(), "source retrieval cancelled");
        let input = workspace
            .source
            .as_ref()
            .context("accepted GitHub source is missing")?;
        ensure!(
            input.account_id == self.0.account
                && input.repository_id == self.0.repository_id
                && input.repository == self.0.repository,
            "accepted GitHub source is not configured on this Gateway"
        );
        ensure!(
            input.commit_sha.len() == 40
                && input
                    .commit_sha
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
            "invalid accepted GitHub source commit"
        );
        let token = self
            .0
            .authentication
            .access_token(&self.0.http, &self.0.api)
            .await?;
        let repository = self
            .json(
                &format!("repositories/{}", input.repository_id),
                token.expose(),
            )
            .await?;
        ensure!(
            repository.get("id").and_then(Value::as_u64) == Some(input.repository_id)
                && repository
                    .get("full_name")
                    .and_then(Value::as_str)
                    .is_some_and(|name| name.eq_ignore_ascii_case(&input.repository)),
            "GitHub returned another repository"
        );
        let commit = self
            .json(
                &format!("repos/{}/commits/{}", input.repository, input.commit_sha),
                token.expose(),
            )
            .await?;
        ensure!(
            commit.get("sha").and_then(Value::as_str) == Some(input.commit_sha.as_str()),
            "GitHub returned another source commit"
        );
        ensure!(!cancel.is_cancelled(), "source retrieval cancelled");
        let directory = TempDir::new_in(&self.0.directory)?;
        let repository = directory.path().join("fetched.git");
        fs::create_dir(&repository)?;
        let mut initialize = git_command(&repository);
        initialize.args(["init", "--bare", "--quiet"]);
        run_git(initialize, &repository, cancel).await?;
        let url = self.0.git.join(&format!("{}.git", input.repository))?;
        let mut fetch = git_command(&repository);
        // This environment belongs only to the trusted Git child. It is never
        // serialized, included in argv, inherited from the Host, or logged.
        fetch
            .env("GIT_CONFIG_COUNT", "2")
            .env("GIT_CONFIG_KEY_0", "http.extraHeader")
            .env(
                "GIT_CONFIG_VALUE_0",
                format!(
                    "Authorization: Basic {}",
                    STANDARD.encode(format!("x-access-token:{}", token.expose()))
                ),
            )
            .env("GIT_CONFIG_KEY_1", "http.followRedirects")
            .env("GIT_CONFIG_VALUE_1", "false");
        if url.scheme() == "http" {
            ensure!(
                url.host_str() == Some("127.0.0.1"),
                "HTTP source fetch requires a loopback fixture"
            );
            fetch.args(["-c", "protocol.http.allow=always"]);
        }
        fetch
            .args([
                "fetch",
                "--no-tags",
                "--no-auto-maintenance",
                "--no-recurse-submodules",
                "--no-write-fetch-head",
                "--quiet",
            ])
            .arg(url.as_str())
            .arg(format!("{}:refs/heads/pinned", input.commit_sha));
        run_git(fetch, &repository, cancel).await?;
        let bundle = source::capture(
            &directory.path().join("verified"),
            &repository,
            &input.commit_sha,
            cancel,
        )
        .await?;
        Ok(FetchedSource {
            bundle,
            _directory: directory,
        })
    }

    async fn json(&self, path: &str, token: &str) -> Result<Value> {
        self.json_url(self.0.api.join(path)?, token).await
    }

    async fn json_url(&self, url: Url, token: &str) -> Result<Value> {
        let mut response = self
            .0
            .http
            .get(url)
            .bearer_auth(token)
            .header("accept", "application/vnd.github+json")
            .header("user-agent", "supertag-gateway")
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("GitHub source lookup unavailable"))?;
        ensure!(
            response.status() == reqwest::StatusCode::OK,
            "GitHub source lookup rejected ({})",
            response.status().as_u16()
        );
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| anyhow::anyhow!("GitHub source response incomplete"))?
        {
            ensure!(
                chunk.len() <= 131_072 - bytes.len(),
                "GitHub source response exceeds its limit"
            );
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes)
            .map_err(|_| anyhow::anyhow!("invalid GitHub source response"))
    }
}

pub(super) fn git_command(directory: &Path) -> Command {
    let mut command = Command::new("/usr/bin/git");
    command
        .current_dir(directory)
        .env_clear()
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .env("LANG", "C")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_NO_REPLACE_OBJECTS", "1")
        .env("GIT_NO_LAZY_FETCH", "1")
        .args([
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "gc.auto=0",
            "-c",
            "protocol.allow=never",
            "-c",
            "protocol.https.allow=always",
            "-c",
            "fetch.fsckObjects=true",
            "-c",
            "transfer.fsckObjects=true",
        ]);
    command
}

struct ProcessGroup(u32);
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        unsafe {
            libc::kill(-(self.0 as i32), libc::SIGKILL);
        }
    }
}

pub(super) async fn run_git(
    mut command: Command,
    directory: &Path,
    cancel: &CancellationToken,
) -> Result<()> {
    use std::os::unix::process::CommandExt as _;
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    command.as_std_mut().process_group(0);
    let mut child = command
        .spawn()
        .context("start trusted Git source transfer")?;
    let group = ProcessGroup(child.id().context("Git source process has no ID")?);
    let mut stdout = child
        .stdout
        .take()
        .context("Git source output unavailable")?
        .take(16_385);
    let mut stderr = child
        .stderr
        .take()
        .context("Git source error output unavailable")?
        .take(16_385);
    let result = {
        let operation = async {
            let mut out = Vec::new();
            let mut err = Vec::new();
            let (status, _, _) = tokio::try_join!(
                child.wait(),
                stdout.read_to_end(&mut out),
                stderr.read_to_end(&mut err)
            )?;
            ensure!(
                out.len() <= 16_384 && err.len() <= 16_384,
                "Git source output exceeded its bound"
            );
            ensure!(status.success(), "Git source transfer failed");
            Ok::<_, anyhow::Error>(())
        };
        tokio::pin!(operation);
        let started = time::Instant::now();
        loop {
            tokio::select! {
                biased;
                _ = cancel.cancelled() => break Err(anyhow::anyhow!("Git source retrieval cancelled")),
                _ = time::sleep_until(started + Duration::from_secs(90)) => break Err(anyhow::anyhow!("Git source retrieval timed out")),
                result = &mut operation => break result,
                _ = time::sleep(Duration::from_millis(100)) => { if let Err(error) = check_size(directory) { break Err(error); } },
            }
        }
    };
    drop(group);
    time::timeout(Duration::from_secs(5), child.wait())
        .await
        .context("trusted Git source cleanup timed out")??;
    result?;
    check_size(directory)
}

fn check_size(directory: &Path) -> Result<()> {
    let mut pending = vec![directory.to_owned()];
    let mut size = 0u64;
    let mut entries = 0usize;
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            let metadata = entry.path().symlink_metadata()?;
            entries += 1;
            ensure!(entries <= 100_000, "Git source has too many objects");
            if metadata.is_dir() {
                pending.push(entry.path());
            } else {
                ensure!(
                    metadata.is_file() && metadata.nlink() == 1,
                    "Git source contains a special file"
                );
                size = size.saturating_add(metadata.len());
                ensure!(size <= 268_435_456, "Git source exceeds its storage bound");
            }
        }
    }
    Ok(())
}
