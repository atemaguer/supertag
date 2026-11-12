use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    path::{Path, PathBuf},
    process::Command,
};
use supertag_workspaces::{
    Checkout, FinalizeRequest, Outcome, PrepareRequest, Workspace, WorkspaceConfig,
};
use tokio_util::sync::CancellationToken;

fn git(path: &Path, args: &[&str]) -> String {
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
            "user.email=fixture@example.test",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "commit.gpgSign=false",
        ])
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {:?}: {}",
        args,
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().into()
}

struct Fixture {
    _root: tempfile::TempDir,
    source: PathBuf,
    state: PathBuf,
    base: String,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        fs::create_dir(&source).unwrap();
        git(&source, &["init", "--quiet", "--initial-branch=main"]);
        fs::write(source.join("README.md"), "original\n").unwrap();
        fs::write(source.join(".gitignore"), "*.log\nnode_modules/\n").unwrap();
        git(&source, &["add", "-A"]);
        git(&source, &["commit", "--quiet", "-m", "Initial commit"]);
        let base = git(&source, &["rev-parse", "HEAD"]);
        let state = root.path().join("state");
        Self {
            _root: root,
            source,
            state,
            base,
        }
    }
    fn workspace(&self) -> Workspace {
        Workspace::open(WorkspaceConfig {
            state_dir: self.state.clone(),
            source: self.source.clone(),
            base_commit: self.base.clone(),
        })
        .unwrap()
    }
}

fn request(task: &str, attempt: &str, head: Option<String>) -> PrepareRequest {
    PrepareRequest {
        task_id: task.into(),
        attempt_id: attempt.into(),
        session_id: "session".into(),
        expected_head: head,
    }
}
fn complete() -> FinalizeRequest {
    FinalizeRequest {
        summary: "Review complete\nChange: Add the requested behavior".into(),
        outcome: Outcome::Completed,
    }
}
async fn prepare(
    workspace: &Workspace,
    task: &str,
    attempt: &str,
    head: Option<String>,
) -> Checkout {
    workspace
        .prepare(request(task, attempt, head), &CancellationToken::new())
        .await
        .unwrap()
}

#[tokio::test]
async fn isolated_capture_is_durable_exact_and_continues_only_an_explicit_pin() {
    let fixture = Fixture::new();
    fs::write(
        fixture.source.join("README.md"),
        "operator's uncommitted edit\n",
    )
    .unwrap();
    fs::write(fixture.source.join("operator.txt"), "leave alone\n").unwrap();
    let original_status = git(&fixture.source, &["status", "--porcelain=v1"]);
    let workspace = fixture.workspace();
    assert!(
        Workspace::open(WorkspaceConfig {
            state_dir: fixture.state.clone(),
            source: fixture.source.clone(),
            base_commit: fixture.base.clone()
        })
        .is_err()
    );
    let checkout = prepare(&workspace, "task-1", "attempt-1", None).await;
    assert_eq!(
        fs::read_to_string(checkout.path.join("README.md")).unwrap(),
        "original\n"
    );
    assert!(!checkout.path.join("operator.txt").exists());
    fs::write(checkout.path.join("README.md"), "task change\n").unwrap();
    fs::write(checkout.path.join("binary.bin"), [0, 255, 2, 0, 4]).unwrap();
    fs::write(checkout.path.join("ignored.log"), "not delivered\n").unwrap();
    fs::write(checkout.path.join("script.sh"), "#!/bin/sh\necho done\n").unwrap();
    fs::set_permissions(
        checkout.path.join("script.sh"),
        fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    symlink("README.md", checkout.path.join("readme-link")).unwrap();
    let delivery = workspace
        .finalize(&checkout, complete(), &CancellationToken::new())
        .await
        .unwrap();
    assert!(delivery.committed);
    assert_eq!(delivery.changed_files, 4);
    let mut forged_receipt = delivery.clone();
    forged_receipt.head_commit = fixture.base.clone();
    assert!(workspace.verify_delivery(&forged_receipt).is_err());
    assert_eq!(delivery.start_commit, fixture.base);
    assert!(
        fs::read(&delivery.patch_path)
            .unwrap()
            .windows(b"GIT binary patch".len())
            .any(|part| part == b"GIT binary patch")
    );
    assert_eq!(
        git(&fixture.source, &["status", "--porcelain=v1"]),
        original_status
    );
    assert_eq!(git(&fixture.source, &["rev-parse", "HEAD"]), fixture.base);
    assert_eq!(
        fs::read_to_string(fixture.source.join("README.md")).unwrap(),
        "operator's uncommitted edit\n"
    );
    drop(workspace);
    let workspace = fixture.workspace();
    assert_eq!(
        workspace.delivery("task-1", "attempt-1").unwrap(),
        Some(delivery.clone())
    );
    assert_eq!(
        workspace
            .finalize(&checkout, complete(), &CancellationToken::new())
            .await
            .unwrap(),
        delivery
    );
    assert!(
        workspace
            .finalize(
                &checkout,
                FinalizeRequest {
                    summary: "Different result".into(),
                    outcome: Outcome::Completed
                },
                &CancellationToken::new()
            )
            .await
            .is_err()
    );
    assert!(
        workspace
            .prepare(
                request("task-2", "attempt-2", None),
                &CancellationToken::new()
            )
            .await
            .is_err()
    );
    let next = prepare(
        &workspace,
        "task-2",
        "attempt-2",
        Some(delivery.head_commit.clone()),
    )
    .await;
    assert_eq!(
        fs::read_to_string(next.path.join("README.md")).unwrap(),
        "task change\n"
    );
    assert!(!next.path.join("ignored.log").exists());
    assert_eq!(
        git(&next.path, &["rev-parse", "HEAD"]),
        delivery.head_commit
    );
    let unchanged = workspace
        .finalize(&next, complete(), &CancellationToken::new())
        .await
        .unwrap();
    assert!(!unchanged.committed);
    assert_eq!(unchanged.changed_files, 0);
    assert_eq!(unchanged.head_commit, delivery.head_commit);
    let imported = fixture._root.path().join("review");
    fs::create_dir(&imported).unwrap();
    git(&imported, &["init", "--quiet"]);
    git(
        &imported,
        &[
            "fetch",
            delivery.bundle_path.to_str().unwrap(),
            &format!("refs/heads/supertag-deliveries/{}", delivery.delivery_id),
        ],
    );
    assert_eq!(
        git(&imported, &["rev-parse", "FETCH_HEAD"]),
        delivery.head_commit
    );
    assert_eq!(
        git(
            &imported,
            &["show", &format!("{}:README.md", delivery.head_commit)]
        ),
        "task change"
    );
    assert_eq!(
        git(
            &imported,
            &["log", "-1", "--format=%s", &delivery.head_commit]
        ),
        "Add the requested behavior"
    );
    fs::write(&delivery.patch_path, "tampered").unwrap();
    assert!(workspace.delivery("task-1", "attempt-1").is_err());
}

#[tokio::test]
async fn source_and_harness_git_configuration_cannot_execute_during_capture() {
    let fixture = Fixture::new();
    let marks = fixture._root.path().join("marks");
    fs::create_dir(&marks).unwrap();
    let marker = marks.join("executed");
    let evil = format!(
        "[core]\n\tfsmonitor = sh -c 'touch {}'\n[filter \"evil\"]\n\tclean = sh -c 'touch {}; cat'\n\tsmudge = sh -c 'touch {}; cat'\n[diff]\n\texternal = sh -c 'touch {}'\n",
        marker.display(),
        marker.display(),
        marker.display(),
        marker.display()
    );
    let config = fixture.source.join(".git/config");
    let initial = fs::read(&config).unwrap();
    let mut poisoned = initial.clone();
    poisoned.extend_from_slice(evil.as_bytes());
    fs::write(&config, &poisoned).unwrap();
    let workspace = fixture.workspace();
    let checkout = prepare(&workspace, "task", "attempt", None).await;
    fs::write(checkout.path.join(".git/config"), evil).unwrap();
    fs::create_dir_all(checkout.path.join(".git/hooks")).unwrap();
    fs::write(
        checkout.path.join(".git/hooks/pre-commit"),
        format!("#!/bin/sh\ntouch {}\n", marker.display()),
    )
    .unwrap();
    fs::set_permissions(
        checkout.path.join(".git/hooks/pre-commit"),
        fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    fs::write(
        checkout.path.join(".gitattributes"),
        "* filter=evil diff=evil\n",
    )
    .unwrap();
    fs::write(checkout.path.join("README.md"), "safe capture\n").unwrap();
    let result = workspace
        .finalize(&checkout, complete(), &CancellationToken::new())
        .await
        .unwrap();
    assert!(result.committed);
    assert!(!marker.exists());
    assert_eq!(fs::read(config).unwrap(), poisoned);
}

#[tokio::test]
async fn symlinks_hardlinks_and_forged_checkout_paths_fail_without_external_reads_or_mutation() {
    let fixture = Fixture::new();
    let workspace = fixture.workspace();
    let checkout = prepare(&workspace, "task", "attempt", None).await;
    let outside = fixture._root.path().join("outside");
    fs::write(&outside, "do not capture\n").unwrap();
    symlink(&outside, checkout.path.join("escape")).unwrap();
    assert!(
        workspace
            .finalize(&checkout, complete(), &CancellationToken::new())
            .await
            .is_err()
    );
    fs::remove_file(checkout.path.join("escape")).unwrap();
    fs::hard_link(&outside, checkout.path.join("hardlink")).unwrap();
    assert!(
        workspace
            .finalize(&checkout, complete(), &CancellationToken::new())
            .await
            .is_err()
    );
    fs::remove_file(checkout.path.join("hardlink")).unwrap();
    let mut forged = checkout.clone();
    forged.path = fixture.source.clone();
    assert!(
        workspace
            .finalize(&forged, complete(), &CancellationToken::new())
            .await
            .is_err()
    );
    assert_eq!(fs::read_to_string(&outside).unwrap(), "do not capture\n");
    assert!(workspace.delivery("task", "attempt").unwrap().is_none());
}

#[tokio::test]
async fn changed_requests_cancellation_and_failed_outputs_never_select_a_session_head() {
    let fixture = Fixture::new();
    let workspace = fixture.workspace();
    let cancelled = CancellationToken::new();
    cancelled.cancel();
    assert!(
        workspace
            .prepare(request("task", "attempt", None), &cancelled)
            .await
            .is_err()
    );
    let checkout = prepare(&workspace, "task", "attempt", None).await;
    assert_eq!(
        workspace
            .prepare(request("task", "attempt", None), &CancellationToken::new())
            .await
            .unwrap(),
        checkout
    );
    let mut changed = request("task", "attempt", None);
    changed.session_id = "other".into();
    assert!(
        workspace
            .prepare(changed, &CancellationToken::new())
            .await
            .is_err()
    );
    fs::write(checkout.path.join("README.md"), "unaccepted work\n").unwrap();
    assert!(
        workspace
            .finalize(&checkout, complete(), &cancelled)
            .await
            .is_err()
    );
    let failed = workspace
        .finalize(
            &checkout,
            FinalizeRequest {
                summary: "Capture failed work".into(),
                outcome: Outcome::Failed,
            },
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert!(failed.committed);
    assert_eq!(failed.outcome, Outcome::Failed);
    // Explicit Control Plane base pin bypasses the failed attempt's output.
    let next = prepare(
        &workspace,
        "next",
        "next-attempt",
        Some(fixture.base.clone()),
    )
    .await;
    assert_eq!(
        fs::read_to_string(next.path.join("README.md")).unwrap(),
        "original\n"
    );
    let nested = fixture.source.join("should-not-create");
    assert!(
        Workspace::open(WorkspaceConfig {
            state_dir: nested.clone(),
            source: fixture.source.clone(),
            base_commit: fixture.base
        })
        .is_err()
    );
    assert!(!nested.exists());
}

#[tokio::test]
async fn an_approved_bundle_restores_continuation_on_another_host_and_cleanup_keeps_receipts() {
    let fixture = Fixture::new();
    let first = fixture.workspace();
    let checkout = prepare(&first, "original", "original-attempt", None).await;
    assert!(first.remove_checkout(&checkout).is_err());
    fs::write(checkout.path.join("README.md"), "approved continuation\n").unwrap();
    let delivery = first
        .finalize(&checkout, complete(), &CancellationToken::new())
        .await
        .unwrap();
    let second = Workspace::open(WorkspaceConfig {
        state_dir: fixture._root.path().join("second-host"),
        source: fixture.source.clone(),
        base_commit: fixture.base.clone(),
    })
    .unwrap();
    assert!(
        second
            .prepare(
                request("next", "next-attempt", Some(delivery.head_commit.clone())),
                &CancellationToken::new()
            )
            .await
            .is_err()
    );
    assert!(
        second
            .import_bundle(
                &delivery.bundle_path,
                &"0".repeat(64),
                &delivery.head_commit,
                &CancellationToken::new()
            )
            .await
            .is_err()
    );
    second
        .import_bundle(
            &delivery.bundle_path,
            &delivery.bundle_sha256,
            &delivery.head_commit,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    second
        .import_bundle(
            &delivery.bundle_path,
            &delivery.bundle_sha256,
            &delivery.head_commit,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    let continued = prepare(
        &second,
        "next",
        "next-attempt",
        Some(delivery.head_commit.clone()),
    )
    .await;
    assert_eq!(
        fs::read_to_string(continued.path.join("README.md")).unwrap(),
        "approved continuation\n"
    );
    first.remove_checkout(&checkout).unwrap();
    first.remove_checkout(&checkout).unwrap();
    assert!(!checkout.path.exists());
    assert_eq!(
        first.delivery("original", "original-attempt").unwrap(),
        Some(delivery.clone())
    );
    assert_eq!(
        first
            .finalize(&checkout, complete(), &CancellationToken::new())
            .await
            .unwrap(),
        delivery
    );
}

#[tokio::test]
async fn source_links_and_git_metadata_tampering_do_not_redirect_private_operations() {
    let fixture = Fixture::new();
    symlink("../../outside", fixture.source.join("escape")).unwrap();
    git(&fixture.source, &["add", "escape"]);
    git(&fixture.source, &["commit", "--quiet", "-m", "Unsafe link"]);
    let bad_base = git(&fixture.source, &["rev-parse", "HEAD"]);
    let workspace = Workspace::open(WorkspaceConfig {
        state_dir: fixture.state.clone(),
        source: fixture.source.clone(),
        base_commit: bad_base,
    })
    .unwrap();
    assert!(
        workspace
            .prepare(
                request("unsafe", "attempt", None),
                &CancellationToken::new()
            )
            .await
            .is_err()
    );
    drop(workspace);
    let safe = Workspace::open(WorkspaceConfig {
        state_dir: fixture._root.path().join("safe-host"),
        source: fixture.source.clone(),
        base_commit: fixture.base,
    })
    .unwrap();
    let checkout = prepare(&safe, "safe", "attempt", None).await;
    let config_path = fixture._root.path().join("safe-host/repository.git/config");
    fs::write(
        config_path,
        "[core]\nrepositoryformatversion=0\nbare=true\nfsmonitor=malicious\n",
    )
    .unwrap();
    assert!(
        safe.finalize(&checkout, complete(), &CancellationToken::new())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn sha256_repositories_keep_their_object_format() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("sha256-source");
    fs::create_dir(&source).unwrap();
    git(
        &source,
        &[
            "init",
            "--quiet",
            "--object-format=sha256",
            "--initial-branch=main",
        ],
    );
    fs::write(source.join("file.txt"), "first\n").unwrap();
    git(&source, &["add", "file.txt"]);
    git(&source, &["commit", "--quiet", "-m", "Initial"]);
    let base = git(&source, &["rev-parse", "HEAD"]);
    assert_eq!(base.len(), 64);
    let workspace = Workspace::open(WorkspaceConfig {
        state_dir: root.path().join("state"),
        source,
        base_commit: base,
    })
    .unwrap();
    let checkout = prepare(&workspace, "task", "attempt", None).await;
    fs::write(checkout.path.join("file.txt"), "second\n").unwrap();
    let delivery = workspace
        .finalize(&checkout, complete(), &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(delivery.head_commit.len(), 64);
    assert!(delivery.committed);
}
