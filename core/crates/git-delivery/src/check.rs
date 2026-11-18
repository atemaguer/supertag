//! `supertag workspace check`: reads the remote and probes pushing with the Workspace's
//! credentials, without changing the remote, and states how strong the protection it found is.
//! It never claims more than the backend proves.
use std::time::Duration;

use anyhow::Result;
use supertag_protocol::{
    git_remote::RemoteTransport,
    v2::{
        Workspace, WorkspaceCheck, WorkspaceCheckStatus, WorkspaceCheckStep, WorkspaceForge,
        workspace_land,
    },
};
use tokio_util::sync::CancellationToken;

use crate::{Access, Credential, GitDelivery, Remote, git};

fn step(name: &str, status: WorkspaceCheckStatus, detail: impl Into<String>) -> WorkspaceCheckStep {
    WorkspaceCheckStep {
        step: name.into(),
        status: status as i32,
        detail: detail.into(),
    }
}

fn credential_label(remote: &Remote) -> String {
    match &remote.credential {
        Some((name, credential)) => format!("{} {name}", credential.describe()),
        None => "no credential".into(),
    }
}

impl GitDelivery {
    pub async fn check(
        &self,
        workspace: &Workspace,
        cancel: &CancellationToken,
    ) -> Result<WorkspaceCheck> {
        let mut steps = Vec::new();
        let land = workspace.land.as_ref().and_then(|land| land.mode.as_ref());

        // Read: the branch Sessions start from.
        let read = match self.remote(workspace, Access::Read).await {
            Ok(remote) => {
                let label = credential_label(&remote);
                match self.resolve(workspace, cancel).await {
                    Ok((branch, commit)) => step(
                        "read",
                        WorkspaceCheckStatus::Ok,
                        format!("{label}; {branch} is at {}", &commit[..12]),
                    ),
                    Err(error) => step(
                        "read",
                        WorkspaceCheckStatus::Failed,
                        format!("{label}: {error:#}"),
                    ),
                }
            }
            Err(error) => step("read", WorkspaceCheckStatus::Failed, format!("{error:#}")),
        };
        steps.push(read);

        // Push: a dry run of a new Session branch, which authenticates as a push without sending.
        // Every delivered Task pushes its Session's branch, whatever `land` says.
        let pushing = match self.remote(workspace, Access::Push).await {
            Ok(remote) => {
                let label = credential_label(&remote);
                match self.probe_push(&remote, cancel).await {
                    Ok(()) => step("push", WorkspaceCheckStatus::Ok, label),
                    Err(error) => step(
                        "push",
                        WorkspaceCheckStatus::Failed,
                        format!("{label}: {error:#}"),
                    ),
                }
            }
            Err(error) => step("push", WorkspaceCheckStatus::Failed, format!("{error:#}")),
        };
        let pushing_ok = pushing.status == WorkspaceCheckStatus::Ok as i32;
        steps.push(pushing);

        // Scope: SuperTag's ref allowlist always applies; the server's rules are unknown to it.
        let scope = match self.remote(workspace, Access::Push).await {
            Ok(Remote {
                transport: RemoteTransport::File,
                ..
            }) => step(
                "scope",
                WorkspaceCheckStatus::Warning,
                "a local repository: anyone who can write it can change any branch; SuperTag pushes only supertag/** and the merge target",
            ),
            Ok(Remote {
                credential: Some((_, Credential::GithubApp { .. })),
                ..
            }) if pushing_ok => step(
                "scope",
                WorkspaceCheckStatus::Warning,
                "one repository: each push uses a token minted for this repository with contents:write, which can still push any of its branches; protect your default branch (a ruleset can confine the App to supertag/**). SuperTag pushes only supertag/** and the merge target",
            ),
            Ok(Remote {
                credential: Some((_, Credential::Helper { .. })),
                ..
            }) => step(
                "scope",
                WorkspaceCheckStatus::Unknown,
                "depends on what the helper's credentials allow; SuperTag pushes only supertag/** and the merge target",
            ),
            Ok(_) if pushing_ok => step(
                "scope",
                WorkspaceCheckStatus::Warning,
                "broad: the credential can push any branch; protect your default branch on the server. SuperTag pushes only supertag/** and the merge target",
            ),
            Ok(_) | Err(_) => step(
                "scope",
                WorkspaceCheckStatus::NotApplicable,
                "no push credential",
            ),
        };
        steps.push(scope);

        steps.push(match land {
            Some(workspace_land::Mode::Merge(merge)) => step(
                "land",
                WorkspaceCheckStatus::Ok,
                format!("finished Sessions merge into {}", merge.target),
            ),
            Some(workspace_land::Mode::Review(review)) => step(
                "land",
                WorkspaceCheckStatus::Ok,
                format!(
                    "each delivered Task updates its Session's branch and its draft pull request against {}",
                    review.base
                ),
            ),
            None => step(
                "land",
                WorkspaceCheckStatus::Ok,
                "each delivered Task updates its Session's branch supertag/session/...",
            ),
        });
        let github = workspace.forge() == WorkspaceForge::Github;
        steps.push(match land {
            Some(workspace_land::Mode::Review(review)) => {
                let credential = workspace
                    .credentials
                    .as_ref()
                    .map(|names| {
                        if names.push.is_empty() {
                            names.read.clone()
                        } else {
                            names.push.clone()
                        }
                    })
                    .unwrap_or_default();
                match self.probe_review(&workspace.remote, &credential).await {
                    Ok(repository) => step(
                        "review",
                        WorkspaceCheckStatus::Ok,
                        format!(
                            "GitHub: draft pull requests against {} on {repository}",
                            review.base
                        ),
                    ),
                    Err(error) => {
                        step("review", WorkspaceCheckStatus::Failed, format!("{error:#}"))
                    }
                }
            }
            _ if github => step(
                "review",
                WorkspaceCheckStatus::NotApplicable,
                "GitHub: available with --land review",
            ),
            _ => step(
                "review",
                WorkspaceCheckStatus::NotApplicable,
                "plain git remote: branch and merge only",
            ),
        });
        steps.push(step(
            "ci",
            WorkspaceCheckStatus::Unknown,
            if github {
                "GitHub checks are not read yet"
            } else {
                "not a forge SuperTag can inspect"
            },
        ));
        Ok(WorkspaceCheck {
            workspace_id: workspace.workspace_id.clone(),
            steps,
        })
    }

    async fn probe_push(&self, remote: &Remote, cancel: &CancellationToken) -> Result<()> {
        let session = self.session(remote)?;
        let repository = session.directory.path().join("probe.git");
        git::init_bare(&repository, cancel).await?;
        let mut tree = session.command(&repository);
        tree.args(["hash-object", "-t", "tree", "-w", "/dev/null"]);
        let tree = git::oid(
            &git::run(
                tree,
                session.directory.path(),
                cancel,
                1024,
                Duration::from_secs(10),
            )
            .await?
            .require("creating the probe")?,
        )?;
        let mut commit = session.command(&repository);
        commit
            .env("GIT_AUTHOR_NAME", "SuperTag")
            .env(
                "GIT_AUTHOR_EMAIL",
                supertag_protocol::git_remote::tag_author_email("check"),
            )
            .env("GIT_COMMITTER_NAME", "SuperTag")
            .env(
                "GIT_COMMITTER_EMAIL",
                supertag_protocol::git_remote::tag_author_email("check"),
            )
            .args(["commit-tree", &tree, "-m", "SuperTag push check"]);
        let commit = git::oid(
            &git::run(
                commit,
                session.directory.path(),
                cancel,
                1024,
                Duration::from_secs(10),
            )
            .await?
            .require("creating the probe")?,
        )?;
        let branch = format!("supertag/session/{}", "0".repeat(64));
        let mut push = session.command(&repository);
        push.args([
            "push",
            "--dry-run",
            "--porcelain",
            "--no-verify",
            "--",
            &session.url,
        ])
        .arg(format!("{commit}:refs/heads/{branch}"));
        git::run(
            push,
            session.directory.path(),
            cancel,
            64 * 1024,
            Duration::from_secs(60),
        )
        .await?
        .require("checking push access")?;
        Ok(())
    }
}
