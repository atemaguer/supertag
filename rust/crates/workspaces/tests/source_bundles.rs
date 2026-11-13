use std::{fs, os::unix::fs::symlink, path::Path, process::Command};
use supertag_workspaces::{PrepareRequest, Workspace, WorkspaceConfig, source};
use tokio_util::sync::CancellationToken;

fn git(path: &Path, arguments: &[&str]) -> String {
    let output = Command::new("/usr/bin/git")
        .current_dir(path)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .args([
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "commit.gpgSign=false",
        ])
        .args(arguments)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().into()
}

#[tokio::test]
async fn source_bundle_delivers_exact_git_parent_without_mutating_source() -> anyhow::Result<()> {
    let temporary = tempfile::tempdir()?;
    let repository = temporary.path().join("repository");
    fs::create_dir(&repository)?;
    git(&repository, &["init", "--quiet", "--initial-branch=main"]);
    fs::write(repository.join("workspace.txt"), "pinned source\n")?;
    git(&repository, &["add", "."]);
    git(&repository, &["commit", "--quiet", "-m", "Base"]);
    let base = git(&repository, &["rev-parse", "HEAD"]);
    git(&repository, &["switch", "--quiet", "-c", "unrelated"]);
    fs::write(
        repository.join("unrelated.txt"),
        "Unrelated private content\n",
    )?;
    git(&repository, &["add", "unrelated.txt"]);
    git(&repository, &["commit", "--quiet", "-m", "Unrelated"]);
    let unrelated = git(&repository, &["rev-parse", "HEAD:unrelated.txt"]);
    git(&repository, &["switch", "--quiet", "main"]);
    let cancel = CancellationToken::new();
    let bundle = source::capture(
        &temporary.path().join("capture"),
        &repository,
        &base,
        &cancel,
    )
    .await?;
    fs::write(repository.join("workspace.txt"), "later local edit\n")?;
    let received =
        source::materialize(&temporary.path().join("received"), &bundle, &base, &cancel).await?;
    assert_eq!(
        source::materialize(&temporary.path().join("received"), &bundle, &base, &cancel).await?,
        received
    );
    assert!(
        !Command::new("/usr/bin/git")
            .arg("--git-dir")
            .arg(&received)
            .args(["cat-file", "-e", &unrelated])
            .output()?
            .status
            .success(),
        "source bundle included unrelated objects"
    );
    let workspace = Workspace::open(WorkspaceConfig {
        state_dir: temporary.path().join("host"),
        source: received,
        base_commit: base.clone(),
    })?;
    let checkout = workspace
        .prepare(
            PrepareRequest {
                task_id: "task".into(),
                attempt_id: "attempt".into(),
                session_id: "session".into(),
                expected_head: Some(base.clone()),
                setup: None,
            },
            &cancel,
        )
        .await?;
    assert_eq!(checkout.start_commit, base);
    assert_eq!(
        fs::read_to_string(checkout.path.join("workspace.txt"))?,
        "pinned source\n"
    );
    assert_eq!(
        fs::read_to_string(repository.join("workspace.txt"))?,
        "later local edit\n"
    );
    let mut changed = bundle.clone();
    changed.sha256 = "0".repeat(64);
    assert!(
        source::materialize(
            &temporary.path().join("bad-digest"),
            &changed,
            &base,
            &cancel
        )
        .await
        .is_err()
    );
    let mut changed = bundle.clone();
    changed.byte_length += 1;
    assert!(
        source::materialize(&temporary.path().join("bad-size"), &changed, &base, &cancel)
            .await
            .is_err()
    );
    assert!(
        source::materialize(
            &temporary.path().join("wrong-commit"),
            &bundle,
            &"2".repeat(40),
            &cancel
        )
        .await
        .is_err()
    );
    let link = temporary.path().join("redirect.bundle");
    symlink(&bundle.path, &link)?;
    let mut redirected = bundle.clone();
    redirected.path = link;
    assert!(
        source::materialize(
            &temporary.path().join("symlink-source"),
            &redirected,
            &base,
            &cancel
        )
        .await
        .is_err()
    );
    let linked = temporary.path().join("hardlink.bundle");
    fs::hard_link(&bundle.path, &linked)?;
    assert!(
        source::materialize(
            &temporary.path().join("hardlink-source"),
            &bundle,
            &base,
            &cancel
        )
        .await
        .is_err()
    );
    fs::remove_file(linked)?;
    let cancelled = CancellationToken::new();
    cancelled.cancel();
    assert!(
        source::materialize(
            &temporary.path().join("cancelled"),
            &bundle,
            &base,
            &cancelled
        )
        .await
        .is_err()
    );
    Ok(())
}
