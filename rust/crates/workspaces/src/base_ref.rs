//! Resolve the branch a Tag's local Workspace follows to the commit a Session starts from.
use std::path::Path;

use anyhow::{Context, Result, ensure};
use tokio_util::sync::CancellationToken;

use crate::{git, session_branch};

/// The commit `refs/heads/BRANCH` names in the host's mapped source repository now. Only a local
/// branch counts: a tag, a remote-tracking ref, or an abbreviated commit with the same name never
/// does, so the operator's checkout decides what a branch means. The caller validates the name.
pub async fn resolve(source: &Path, branch: &str, cancel: &CancellationToken) -> Result<String> {
    ensure!(
        !branch.is_empty() && !branch.starts_with('-') && !branch.starts_with("refs/"),
        "Workspace ref is not a branch name"
    );
    let reference = format!("refs/heads/{branch}^{{commit}}");
    let commit = session_branch::output(
        source,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            "--end-of-options",
            &reference,
        ],
        cancel,
    )
    .await
    .with_context(|| format!("branch {branch} does not name a commit in the Workspace"))?;
    git::validate_oid(&commit)
        .with_context(|| format!("branch {branch} resolved to an unexpected object name"))?;
    Ok(commit)
}

#[cfg(test)]
mod tests {
    use std::process::Command;

    use super::resolve;

    fn git(directory: &std::path::Path, args: &[&str]) -> String {
        let output = Command::new("/usr/bin/git")
            .arg("-C")
            .arg(directory)
            .args(args)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_AUTHOR_NAME", "Fixture")
            .env("GIT_AUTHOR_EMAIL", "fixture@example.invalid")
            .env("GIT_COMMITTER_NAME", "Fixture")
            .env("GIT_COMMITTER_EMAIL", "fixture@example.invalid")
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
        String::from_utf8(output.stdout).unwrap().trim().into()
    }

    #[tokio::test]
    async fn resolves_only_local_branches() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path();
        git(source, &["init", "--quiet"]);
        std::fs::write(source.join("file.txt"), "one\n").unwrap();
        git(source, &["add", "file.txt"]);
        git(source, &["commit", "--quiet", "-m", "one"]);
        let first = git(source, &["rev-parse", "HEAD"]);
        git(source, &["branch", "release"]);
        std::fs::write(source.join("file.txt"), "two\n").unwrap();
        git(source, &["commit", "--quiet", "-am", "two"]);
        git(source, &["tag", "only-a-tag"]);
        let cancel = tokio_util::sync::CancellationToken::new();
        assert_eq!(resolve(source, "release", &cancel).await.unwrap(), first);
        assert!(resolve(source, "only-a-tag", &cancel).await.is_err());
        assert!(resolve(source, "missing", &cancel).await.is_err());
        assert!(
            resolve(source, "refs/heads/release", &cancel)
                .await
                .is_err()
        );
    }
}
