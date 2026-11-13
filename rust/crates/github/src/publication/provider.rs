use super::plan::{PullRequest, Target};
use crate::{
    auth::{AccessToken, Authentication},
    valid_id, valid_repository,
    workspaces::{GithubWorkspaceAccount, git_command, run_git},
};
use anyhow::{Context, Result, ensure};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use reqwest::{Client, Method, StatusCode, Url};
use serde_json::{Value, json};
use std::{
    os::unix::fs::MetadataExt as _,
    path::{Path, PathBuf},
    time::Duration,
};
use supertag_protocol::{v2::*, validate_workspace_delivery};
use supertag_workspaces::{TransferArtifact, source};
use tempfile::TempDir;
use tokio_util::sync::CancellationToken;

pub(super) struct Provider {
    pub account: String,
    repository_id: u64,
    repository: String,
    authentication: Authentication,
    http: Client,
    api: Url,
    git: Url,
    directory: PathBuf,
    blobs: PathBuf,
}
pub(super) struct Prepared {
    pub repository: PathBuf,
    pub token: AccessToken,
    _directory: TempDir,
}
pub(super) struct Observation {
    pub complete: bool,
    pub requests: Vec<PullRequest>,
    pub branch: Option<String>,
}

pub(super) fn target(job: &GithubPublication) -> Result<Target> {
    let delivery = job
        .delivery
        .as_ref()
        .context("publication delivery missing")?;
    validate_workspace_delivery(delivery)?;
    ensure!(
        delivery.committed,
        "publication must contain a committed change"
    );
    ensure!(
        job.head_branch.starts_with("supertag/session/")
            && job.head_branch[17..].len() == 64
            && job.head_branch[17..].bytes().all(|c| c.is_ascii_hexdigit()),
        "invalid publication branch"
    );
    Ok(Target {
        repository_id: job.repository_id,
        repository: job.repository.clone(),
        branch: job.head_branch.clone(),
        base: job.base_branch.clone(),
        commit: delivery.head_commit.clone(),
        title: job.title.clone(),
        body: job.body.clone(),
    })
}
pub(super) fn receipt(job: &GithubPublication, value: &PullRequest) -> GithubPullRequestReceipt {
    GithubPullRequestReceipt {
        number: value.number,
        url: format!(
            "https://github.com/{}/pull/{}",
            job.repository, value.number
        ),
        repository_id: value.base_repository_id,
        repository: value.base_repository.to_ascii_lowercase(),
        head_branch: value.head.clone(),
        base_branch: value.base.clone(),
        head_commit: value.commit.clone(),
        open: value.open,
        merged: value.merged,
        draft: value.draft,
        title: value.title.clone(),
        body: value.body.clone(),
    }
}
impl Provider {
    pub fn new(config: GithubWorkspaceAccount, directory: &Path, blobs: &Path) -> Result<Self> {
        ensure!(
            valid_id(config.repository_id) && valid_repository(&config.repository),
            "invalid GitHub publication repository"
        );
        ensure!(
            !config.account_id.is_empty() && config.account_id.len() <= 256,
            "GitHub publication account required"
        );
        for directory in [directory, blobs] {
            let meta = directory.symlink_metadata()?;
            ensure!(
                meta.is_dir()
                    && meta.uid() == unsafe { libc::geteuid() }
                    && meta.mode() & 0o077 == 0,
                "publication storage must be private"
            );
        }
        let repository = config.repository.to_ascii_lowercase();
        Ok(Self {
            account: config.account_id,
            repository_id: config.repository_id,
            authentication: Authentication::publisher(
                &config.authentication,
                config.repository_id,
                &repository,
            )?,
            repository,
            http: Client::builder()
                .connect_timeout(Duration::from_secs(3))
                .timeout(Duration::from_secs(15))
                .redirect(reqwest::redirect::Policy::none())
                .retry(reqwest::retry::never())
                .no_proxy()
                .build()?,
            api: "https://api.github.com/".parse()?,
            git: "https://github.com/".parse()?,
            directory: directory.canonicalize()?,
            blobs: blobs.canonicalize()?,
        })
    }
    #[cfg(any(test, feature = "test-fixtures"))]
    pub fn endpoints(&mut self, api: Url, git: Url) -> Result<()> {
        for value in [&api, &git] {
            ensure!(
                value.scheme() == "http"
                    && value.host_str() == Some("127.0.0.1")
                    && value.username().is_empty()
                    && value.password().is_none()
                    && value.query().is_none()
                    && value.fragment().is_none(),
                "fixture publication origin must be literal loopback HTTP"
            );
        }
        ensure!(
            api.path() == "/" && git.path().ends_with('/'),
            "fixture publication endpoints require canonical roots"
        );
        self.api = api;
        self.git = git;
        Ok(())
    }
    fn scope(&self, job: &GithubPublication) -> Result<()> {
        ensure!(
            job.account_id == self.account
                && job.repository_id == self.repository_id
                && job.repository == self.repository,
            "publication destination is not configured on this Control Plane"
        );
        target(job)?;
        Ok(())
    }
    pub async fn token(&self, job: &GithubPublication) -> Result<AccessToken> {
        self.scope(job)?;
        self.authentication
            .access_token(&self.http, &self.api)
            .await
    }
    pub async fn prepare(
        &self,
        job: &GithubPublication,
        token: AccessToken,
        cancel: &CancellationToken,
    ) -> Result<Prepared> {
        self.scope(job)?;
        let delivery = job.delivery.as_ref().context("delivery required")?;
        let bundle = delivery.bundle.as_ref().context("bundle required")?;
        let directory = TempDir::new_in(&self.directory)?;
        let repository = source::materialize(
            &directory.path().join("verified"),
            &TransferArtifact {
                path: self.blobs.join(&bundle.sha256),
                sha256: bundle.sha256.clone(),
                byte_length: bundle.byte_length,
            },
            &delivery.head_commit,
            cancel,
        )
        .await?;
        Ok(Prepared {
            repository,
            token,
            _directory: directory,
        })
    }
    async fn json(
        &self,
        method: Method,
        path: &str,
        token: &AccessToken,
        body: Option<Value>,
        missing: bool,
    ) -> Result<Option<Value>> {
        let mut request = self
            .http
            .request(method, self.api.join(path)?)
            .bearer_auth(token.expose())
            .header("accept", "application/vnd.github+json")
            .header("user-agent", "supertag-gateway")
            .header("x-github-api-version", "2022-11-28");
        if let Some(body) = body {
            request = request.json(&body);
        }
        let mut response = request
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("GitHub publication response unavailable"))?;
        if missing && response.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        ensure!(
            response.status().is_success(),
            "GitHub publication response rejected ({})",
            response.status().as_u16()
        );
        let mut bytes = vec![];
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| anyhow::anyhow!("GitHub publication response incomplete"))?
        {
            ensure!(
                chunk.len() <= 2_097_152 - bytes.len(),
                "GitHub publication response exceeds limit"
            );
            bytes.extend_from_slice(&chunk);
        }
        Ok(Some(
            serde_json::from_slice(&bytes).context("invalid GitHub publication response")?,
        ))
    }
    pub async fn inspect(
        &self,
        job: &GithubPublication,
        token: &AccessToken,
    ) -> Result<Observation> {
        self.scope(job)?;
        let repo = self
            .json(
                Method::GET,
                &format!("repositories/{}", self.repository_id),
                token,
                None,
                false,
            )
            .await?
            .context("repository absent")?;
        ensure!(
            repo["id"].as_u64() == Some(self.repository_id)
                && repo["full_name"]
                    .as_str()
                    .is_some_and(|name| name.eq_ignore_ascii_case(&self.repository)),
            "GitHub repository identity changed"
        );
        let mut url = self.api.join(&format!("repos/{}/pulls", self.repository))?;
        url.query_pairs_mut()
            .append_pair("state", "all")
            .append_pair(
                "head",
                &format!(
                    "{}:{}",
                    self.repository.split('/').next().unwrap_or_default(),
                    job.head_branch
                ),
            )
            .append_pair("per_page", "100");
        let path = &url.as_str()[self.api.as_str().len()..];
        let requests = self
            .json(Method::GET, path, token, None, false)
            .await?
            .context("pull request history absent")?;
        let requests = requests
            .as_array()
            .context("invalid pull request history")?;
        ensure!(requests.len() <= 100, "unbounded pull request history");
        let complete = requests.len() < 100;
        let requests = requests.iter().map(parse).collect::<Result<Vec<_>>>()?;
        let reference = self
            .json(
                Method::GET,
                &format!(
                    "repos/{}/git/ref/heads/{}",
                    self.repository, job.head_branch
                ),
                token,
                None,
                true,
            )
            .await?;
        let branch = reference
            .map(|value| {
                ensure!(
                    value["ref"].as_str()
                        == Some(format!("refs/heads/{}", job.head_branch).as_str())
                        && value.pointer("/object/type").and_then(Value::as_str) == Some("commit"),
                    "GitHub branch identity changed"
                );
                sha(value.pointer("/object/sha").and_then(Value::as_str)).map(str::to_string)
            })
            .transpose()?;
        Ok(Observation {
            complete,
            requests,
            branch,
        })
    }
    pub async fn push(
        &self,
        job: &GithubPublication,
        prepared: &Prepared,
        previous: Option<&str>,
        cancel: &CancellationToken,
    ) -> Result<()> {
        self.scope(job)?;
        let target = target(job)?;
        if let Some(previous) = previous {
            sha(Some(previous))?;
        }
        let url = self.git.join(&format!("{}.git", self.repository))?;
        let mut command = git_command(&prepared.repository);
        command
            .env("GIT_CONFIG_COUNT", "2")
            .env("GIT_CONFIG_KEY_0", "http.extraHeader")
            .env(
                "GIT_CONFIG_VALUE_0",
                format!(
                    "Authorization: Basic {}",
                    STANDARD.encode(format!("x-access-token:{}", prepared.token.expose()))
                ),
            )
            .env("GIT_CONFIG_KEY_1", "http.followRedirects")
            .env("GIT_CONFIG_VALUE_1", "false");
        if url.scheme() == "http" {
            ensure!(
                url.host_str() == Some("127.0.0.1"),
                "HTTP push requires loopback fixture"
            );
            command.args(["-c", "protocol.http.allow=always"]);
        }
        command
            .args(["push", "--porcelain", "--no-verify"])
            .arg(format!(
                "--force-with-lease=refs/heads/{}:{}",
                target.branch,
                previous.unwrap_or("")
            ))
            .arg(url.as_str())
            .arg(format!("{}:refs/heads/{}", target.commit, target.branch));
        run_git(command, &prepared.repository, cancel).await
    }
    pub async fn get(
        &self,
        job: &GithubPublication,
        number: u64,
        token: &AccessToken,
    ) -> Result<PullRequest> {
        let value = self
            .json(
                Method::GET,
                &format!("repos/{}/pulls/{number}", self.repository),
                token,
                None,
                false,
            )
            .await?
            .context("pull request absent")?;
        self.scope(job)?;
        parse(&value)
    }
    pub async fn create(
        &self,
        job: &GithubPublication,
        token: &AccessToken,
    ) -> Result<PullRequest> {
        self.scope(job)?;
        let value=self.json(Method::POST,&format!("repos/{}/pulls",self.repository),token,Some(json!({"head":job.head_branch,"base":job.base_branch,"title":job.title,"body":job.body,"draft":true})),false).await?.context("creation receipt absent")?;
        parse(&value)
    }
    pub async fn update(
        &self,
        job: &GithubPublication,
        number: u64,
        token: &AccessToken,
    ) -> Result<PullRequest> {
        self.scope(job)?;
        let value = self
            .json(
                Method::PATCH,
                &format!("repos/{}/pulls/{number}", self.repository),
                token,
                Some(json!({"title":job.title,"body":job.body})),
                false,
            )
            .await?
            .context("update receipt absent")?;
        parse(&value)
    }
}
fn sha(value: Option<&str>) -> Result<&str> {
    value
        .filter(|v| {
            v.len() == 40
                && v.bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        })
        .context("invalid GitHub commit identity")
}
fn parse(value: &Value) -> Result<PullRequest> {
    let string = |pointer: &str| {
        value
            .pointer(pointer)
            .and_then(Value::as_str)
            .map(str::to_string)
            .context("incomplete pull request identity")
    };
    let number = |pointer: &str| {
        value
            .pointer(pointer)
            .and_then(Value::as_u64)
            .filter(|n| valid_id(*n))
            .context("invalid pull request identity")
    };
    let state = string("/state")?;
    ensure!(
        matches!(state.as_str(), "open" | "closed"),
        "unknown pull request state"
    );
    Ok(PullRequest {
        number: number("/number")?,
        title: string("/title")?,
        body: value
            .get("body")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .into(),
        head_repository_id: number("/head/repo/id")?,
        head_repository: string("/head/repo/full_name")?,
        base_repository_id: number("/base/repo/id")?,
        base_repository: string("/base/repo/full_name")?,
        head: string("/head/ref")?,
        base: string("/base/ref")?,
        commit: sha(value.pointer("/head/sha").and_then(Value::as_str))?.into(),
        open: state == "open",
        merged: value["merged"].as_bool().unwrap_or(false),
        draft: value["draft"]
            .as_bool()
            .context("pull request draft state missing")?,
    })
}
