//! The GitHub review adapter: after git delivery pushes a Session's branch, it opens a draft pull
//! request from it against the Workspace's base, or updates the title and description of the one
//! it opened before. It calls the forge's REST API and never pushes.
//!
//! Its token is narrowed to `pull_requests: write` on the one repository when the Workspace
//! Credential is a GitHub App; an HTTPS token is used as it is.
pub mod plan;

use anyhow::{Context, Result, ensure};
use plan::{Discovery, PullRequest, Target};
use reqwest::{Method, StatusCode, Url};
use serde_json::{Value, json};
use supertag_protocol::{
    git_remote::github_remote,
    v2::{WorkspaceLanding, WorkspacePullRequest},
};

use crate::{Credential, GitDelivery};

/// The most a pull request response may be.
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
/// The permission the review adapter's token carries.
const PULL_REQUESTS: &[(&str, &str)] = &[("pull_requests", "write")];

/// What the review step ended with.
pub enum Reviewed {
    /// The pull request is open from the Session's branch with this delivery's title and body.
    Done(WorkspacePullRequest),
    /// Refused until someone acts, such as a pull request someone closed.
    Held(String),
}

struct Github {
    http: reqwest::Client,
    api: Url,
    repository: String,
    token: String,
}

impl Github {
    async fn json(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        missing: bool,
    ) -> Result<Option<Value>> {
        let mut request = self
            .http
            .request(method, self.api.join(path)?)
            .bearer_auth(&self.token)
            .header("accept", "application/vnd.github+json")
            .header("user-agent", "supertag")
            .header("x-github-api-version", "2022-11-28");
        if let Some(body) = body {
            request = request.json(&body);
        }
        let mut response = request
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("the GitHub API is unavailable"))?;
        if missing && response.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        ensure!(
            response.status().is_success(),
            "the GitHub API refused the request (HTTP {})",
            response.status().as_u16()
        );
        let mut bytes = vec![];
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| anyhow::anyhow!("the GitHub API response was interrupted"))?
        {
            ensure!(
                chunk.len() <= MAX_RESPONSE_BYTES - bytes.len(),
                "the GitHub API response is too large"
            );
            bytes.extend_from_slice(&chunk);
        }
        Ok(Some(
            serde_json::from_slice(&bytes).context("invalid GitHub API response")?,
        ))
    }

    /// The repository's numeric ID, after checking GitHub still calls it by this name.
    async fn repository_id(&self) -> Result<u64> {
        let value = self
            .json(
                Method::GET,
                &format!("repos/{}", self.repository),
                None,
                false,
            )
            .await?
            .context("repository absent")?;
        ensure!(
            value["full_name"]
                .as_str()
                .is_some_and(|name| name.eq_ignore_ascii_case(&self.repository)),
            "the GitHub repository was renamed or moved; update the Workspace's remote"
        );
        value["id"]
            .as_u64()
            .filter(|id| supertag_github::valid_id(*id))
            .context("invalid GitHub repository identity")
    }

    /// Every pull request, open or closed, from `branch` in this repository, and whether the
    /// page holds all of them.
    async fn pulls(&self, branch: &str) -> Result<(bool, Vec<PullRequest>)> {
        let mut url = self.api.join(&format!("repos/{}/pulls", self.repository))?;
        url.query_pairs_mut()
            .append_pair("state", "all")
            .append_pair(
                "head",
                &format!(
                    "{}:{branch}",
                    self.repository.split('/').next().unwrap_or_default()
                ),
            )
            .append_pair("per_page", "100");
        let path = url.as_str()[self.api.as_str().len()..].to_owned();
        let value = self
            .json(Method::GET, &path, None, false)
            .await?
            .context("pull request history absent")?;
        let requests = value.as_array().context("invalid pull request history")?;
        ensure!(requests.len() <= 100, "unbounded pull request history");
        Ok((
            requests.len() < 100,
            requests.iter().map(parse).collect::<Result<Vec<_>>>()?,
        ))
    }

    async fn get(&self, number: u64) -> Result<PullRequest> {
        parse(
            &self
                .json(
                    Method::GET,
                    &format!("repos/{}/pulls/{number}", self.repository),
                    None,
                    false,
                )
                .await?
                .context("pull request absent")?,
        )
    }

    async fn create(&self, target: &Target) -> Result<PullRequest> {
        parse(
            &self
                .json(
                    Method::POST,
                    &format!("repos/{}/pulls", self.repository),
                    Some(json!({
                        "head": target.branch,
                        "base": target.base,
                        "title": target.title,
                        "body": target.body,
                        "draft": true,
                    })),
                    false,
                )
                .await?
                .context("creation receipt absent")?,
        )
    }

    async fn update(&self, number: u64, target: &Target) -> Result<PullRequest> {
        parse(
            &self
                .json(
                    Method::PATCH,
                    &format!("repos/{}/pulls/{number}", self.repository),
                    Some(json!({"title": target.title, "body": target.body})),
                    false,
                )
                .await?
                .context("update receipt absent")?,
        )
    }
}

impl GitDelivery {
    /// Opens or updates the pull request of `landing`, whose branch already names `head` on the
    /// remote. A refusal someone must act on is `Held`; an error is retried later.
    pub(crate) async fn review(
        &self,
        landing: &WorkspaceLanding,
        credential: &str,
        head: &str,
    ) -> Result<Reviewed> {
        let Some(remote) = github_remote(&landing.remote) else {
            return Ok(Reviewed::Held(
                "review needs a GitHub remote that names OWNER/NAME".into(),
            ));
        };
        let (token, minted_for) = if credential.is_empty() {
            return Ok(Reviewed::Held(
                "review needs a Workspace Credential that can call the GitHub API: a GitHub App or an HTTPS token".into(),
            ));
        } else {
            match self.0.credentials.resolve(credential).await {
                Ok(app @ Credential::GithubApp { .. }) => {
                    let (token, id) = self
                        .github_token(&landing.remote, &app, PULL_REQUESTS)
                        .await
                        .context("mint the pull request token")?;
                    (token, Some(id))
                }
                Ok(Credential::HttpsToken { token, .. }) => (token, None),
                Ok(other) => {
                    return Ok(Reviewed::Held(format!(
                        "review needs a GitHub App or HTTPS token Workspace Credential to call the GitHub API; {credential} is a {}",
                        other.describe()
                    )));
                }
                Err(error) => return Ok(Reviewed::Held(format!("{error:#}"))),
            }
        };
        let github = Github {
            http: self.0.http.clone(),
            api: remote.api.parse()?,
            repository: remote.repository.clone(),
            token,
        };
        let repository_id = github.repository_id().await?;
        ensure!(
            minted_for.is_none_or(|id| id == repository_id),
            "the GitHub App token names another repository"
        );
        let target = Target {
            repository_id,
            repository: remote.repository.clone(),
            branch: landing.branch.clone(),
            base: landing.target.clone(),
            commit: head.to_owned(),
            title: landing.title.clone(),
            body: landing.body.clone(),
        };
        let receipt = |request: &PullRequest| WorkspacePullRequest {
            repository: remote.repository.clone(),
            repository_id,
            number: request.number,
            url: format!(
                "{}/{}/pull/{}",
                remote.web, remote.repository, request.number
            ),
        };
        let (complete, requests) = github.pulls(&target.branch).await?;
        match target.discover(complete, &requests) {
            Discovery::Hold(reason) => Ok(Reviewed::Held(format!(
                "{reason}; SuperTag opens or updates only the one open pull request of the Session's branch"
            ))),
            Discovery::Open(prior) => {
                if prior.title == target.title && prior.body == target.body {
                    return Ok(Reviewed::Done(receipt(&prior)));
                }
                let current = github.get(prior.number).await?;
                if !target.may_update_after_push(prior.number, &current) {
                    return Ok(Reviewed::Held(
                        "the pull request was closed or changed before its update".into(),
                    ));
                }
                let updated = github.update(prior.number, &target).await?;
                ensure!(
                    target.may_update_after_push(prior.number, &updated)
                        && updated.title == target.title
                        && updated.body == target.body,
                    "the pull request update was not confirmed; trying again"
                );
                Ok(Reviewed::Done(receipt(&updated)))
            }
            Discovery::New => {
                let created = github.create(&target).await;
                let proved = match created {
                    Ok(value)
                        if target.matches(&value)
                            && value.open
                            && !value.merged
                            && value.commit == target.commit
                            && value.title == target.title
                            && value.body == target.body =>
                    {
                        Some(value)
                    }
                    // An ambiguous create is never resent blindly: only the exact pull request
                    // read back finishes it. GitHub refuses a second open pull request for the
                    // same branches, so the retry that follows a lost answer finds this one.
                    _ => {
                        let (complete, requests) = github.pulls(&target.branch).await?;
                        target.reconcile_create(complete, &requests)
                    }
                };
                let created = proved.context(
                    "the pull request creation was not confirmed; trying again, which never opens a second one",
                )?;
                Ok(Reviewed::Done(receipt(&created)))
            }
        }
    }

    /// `workspace check`'s review step: the review adapter's token reaches the repository.
    pub(crate) async fn probe_review(&self, remote: &str, credential: &str) -> Result<String> {
        let github_repository =
            github_remote(remote).context("review needs a GitHub remote that names OWNER/NAME")?;
        ensure!(
            !credential.is_empty(),
            "review needs a GitHub App or HTTPS token Workspace Credential"
        );
        let token = match self.0.credentials.resolve(credential).await? {
            app @ Credential::GithubApp { .. } => {
                self.github_token(remote, &app, PULL_REQUESTS).await?.0
            }
            Credential::HttpsToken { token, .. } => token,
            other => anyhow::bail!(
                "review needs a GitHub App or HTTPS token Workspace Credential; {credential} is a {}",
                other.describe()
            ),
        };
        let github = Github {
            http: self.0.http.clone(),
            api: github_repository.api.parse()?,
            repository: github_repository.repository.clone(),
            token,
        };
        github.repository_id().await?;
        Ok(github_repository.repository)
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
            .filter(|n| supertag_github::valid_id(*n))
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
