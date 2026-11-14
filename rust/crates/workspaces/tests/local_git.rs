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
        setup: None,
    }
}
fn complete() -> FinalizeRequest {
    FinalizeRequest {
        output_directory: None,
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
                    output_directory: None,
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
                output_directory: None,
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

#[tokio::test]
async fn stopped_checkout_discard_reopens_without_source_and_preserves_receipts_and_other_paths() {
    let fixture = Fixture::new();
    let workspace = fixture.workspace();
    let delivered = prepare(&workspace, "delivered", "first", None).await;
    fs::write(delivered.path.join("README.md"), "delivered\n").unwrap();
    let receipt = workspace
        .finalize(&delivered, complete(), &CancellationToken::new())
        .await
        .unwrap();
    let cancelled = prepare(
        &workspace,
        "cancelled",
        "second",
        Some(fixture.base.clone()),
    )
    .await;
    fs::write(cancelled.path.join("README.md"), "cancelled edits\n").unwrap();
    assert!(workspace.remove_checkout(&cancelled).is_err());
    let outside = fixture._root.path().join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("keep"), "retain me").unwrap();
    symlink(&outside, cancelled.path.join("outside-link")).unwrap();
    drop(workspace);
    fs::remove_dir_all(&fixture.source).unwrap();
    let recorded = Workspace::open_existing(&fixture.state).unwrap();
    let mut forged = cancelled.clone();
    forged.path = outside.clone();
    assert!(recorded.discard_checkout(&forged).is_err());
    assert!(cancelled.path.exists());
    recorded.discard_checkout(&cancelled).unwrap();
    recorded.discard_checkout(&cancelled).unwrap();
    assert!(!cancelled.path.exists());
    assert_eq!(
        fs::read_to_string(outside.join("keep")).unwrap(),
        "retain me"
    );
    assert!(recorded.delivery("cancelled", "second").unwrap().is_none());
    recorded.discard_checkout(&delivered).unwrap();
    assert_eq!(
        recorded.delivery("delivered", "first").unwrap(),
        Some(receipt)
    );
}

/// TypeScript parity: `tests/worker-host-changed-paths.test.ts`.
#[tokio::test]
async fn changed_paths_cover_edits_untracked_files_renames_and_commits_but_not_git_metadata() {
    let fixture = Fixture::new();
    let workspace = fixture.workspace();
    let checkout = prepare(&workspace, "task", "attempt", None).await;
    let cancel = CancellationToken::new();
    let keep = |path: &str| supertag_protocol_path(path);
    assert_eq!(
        supertag_workspaces::changed_paths(&checkout, keep, 500, &cancel)
            .await
            .unwrap(),
        (vec![], false)
    );
    fs::write(checkout.path.join("README.md"), "changed\n").unwrap();
    fs::write(checkout.path.join("new.txt"), "new\n").unwrap();
    fs::rename(
        checkout.path.join(".gitignore"),
        checkout.path.join("renamed-ignore"),
    )
    .unwrap();
    git(&checkout.path, &["add", "-A"]);
    fs::create_dir_all(checkout.path.join("nested/.git")).unwrap();
    fs::write(checkout.path.join("nested/.git/metadata"), "ignored\n").unwrap();
    assert_eq!(
        supertag_workspaces::changed_paths(&checkout, keep, 500, &cancel)
            .await
            .unwrap(),
        (
            vec![
                ".gitignore".to_owned(),
                "README.md".into(),
                "new.txt".into(),
                "renamed-ignore".into()
            ],
            false
        )
    );
    // Committed changes since the start commit count, and more than the cap are truncated.
    git(&checkout.path, &["commit", "--quiet", "-m", "change"]);
    for index in 0..501 {
        fs::write(checkout.path.join(format!("file-{index:03}.txt")), "x").unwrap();
    }
    let (paths, truncated) = supertag_workspaces::changed_paths(&checkout, keep, 500, &cancel)
        .await
        .unwrap();
    assert!(truncated);
    assert_eq!(paths.len(), 500);
    assert_eq!(paths[0], ".gitignore");
    assert_eq!(paths.last().unwrap(), "file-497.txt");
}

fn supertag_protocol_path(path: &str) -> bool {
    !path.is_empty()
        && path
            .split('/')
            .all(|part| !matches!(part, "" | "." | ".." | ".git"))
}

fn setup_request(task: &str, attempt: &str, command: &str) -> PrepareRequest {
    PrepareRequest {
        setup: Some(command.into()),
        session_id: task.into(),
        ..request(task, attempt, None)
    }
}

#[tokio::test]
async fn setup_runs_in_each_checkout_and_leaves_private_ignored_outputs() {
    use std::os::unix::fs::MetadataExt;

    let fixture = Fixture::new();
    let outside = fixture.state.parent().unwrap().join("store");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("shared.js"), "store\n").unwrap();
    let runs = outside.join("runs");
    let quote = |path: &Path| format!("'{}'", path.display());
    let command = format!(
        "echo run >> {runs} && mkdir -p node_modules/dep node_modules/.bin && \
         echo dep > node_modules/dep/index.js && ln {store} node_modules/dep/shared.js && \
         ln -s ../dep/index.js node_modules/.bin/dep && ln -s /usr/bin/env node_modules/.bin/env && \
         pwd -P > node_modules/where && echo \"$TMPDIR\" > node_modules/tmpdir && \
         echo stray > stray.txt && echo changed > README.md && \
         test -z \"$SUPERTAG_SECRET_FIXTURE\"",
        runs = quote(&runs),
        store = quote(&outside.join("shared.js")),
    );
    let workspace = fixture.workspace();
    let cancel = CancellationToken::new();
    // SAFETY: the test sets a variable before any thread reads it.
    unsafe { std::env::set_var("SUPERTAG_SECRET_FIXTURE", "withheld") };
    let checkout = workspace
        .prepare(setup_request("task-1", "attempt-1", &command), &cancel)
        .await
        .unwrap();
    let modules = checkout.path.join("node_modules");
    assert_eq!(
        fs::read_to_string(modules.join("dep/index.js")).unwrap(),
        "dep\n"
    );
    assert_eq!(
        fs::read_link(modules.join(".bin/dep")).unwrap(),
        Path::new("../dep/index.js")
    );
    // An absolute link, such as a virtualenv's interpreter, stays as setup made it.
    assert_eq!(
        fs::read_link(modules.join(".bin/env")).unwrap(),
        Path::new("/usr/bin/env")
    );
    // Setup ran in the Task checkout itself, so outputs that embed their path keep working.
    assert_eq!(
        Path::new(fs::read_to_string(modules.join("where")).unwrap().trim()),
        checkout.path.canonicalize().unwrap()
    );
    // Setup's tracked edits and unignored files never reach the Task.
    assert_eq!(
        fs::read_to_string(checkout.path.join("README.md")).unwrap(),
        "original\n"
    );
    assert!(!checkout.path.join("stray.txt").exists());
    // A hard link into a store becomes a private copy.
    let copied = fs::metadata(modules.join("dep/shared.js")).unwrap();
    assert_eq!(copied.nlink(), 1);
    assert_ne!(
        copied.ino(),
        fs::metadata(outside.join("shared.js")).unwrap().ino()
    );
    fs::write(modules.join("dep/shared.js"), "task edit\n").unwrap();
    assert_eq!(
        fs::read_to_string(outside.join("shared.js")).unwrap(),
        "store\n"
    );
    // Setup had its own temporary directory, removed when it finished.
    let temporary = fs::read_to_string(modules.join("tmpdir")).unwrap();
    assert!(!Path::new(temporary.trim()).exists(), "{temporary}");
    assert!(!temporary.trim().is_empty());

    // Like TypeScript, each new checkout runs setup again.
    let second = workspace
        .prepare(setup_request("task-2", "attempt-2", &command), &cancel)
        .await
        .unwrap();
    assert!(second.path.join("node_modules/dep/index.js").exists());
    assert_eq!(fs::read_to_string(&runs).unwrap().lines().count(), 2);

    // Delivery ignores setup outputs; only the Task's own change is captured.
    fs::write(checkout.path.join("README.md"), "task change\n").unwrap();
    let delivery = workspace
        .finalize(&checkout, complete(), &cancel)
        .await
        .unwrap();
    assert!(delivery.committed);
    assert_eq!(delivery.changed_files, 1);
}

#[tokio::test]
async fn failed_setup_fails_preparation_with_its_untrusted_output() {
    let fixture = Fixture::new();
    let workspace = fixture.workspace();
    let cancel = CancellationToken::new();
    let error = workspace
        .prepare(
            setup_request(
                "task-1",
                "attempt-1",
                "echo installing; echo broken >&2; exit 3",
            ),
            &cancel,
        )
        .await
        .unwrap_err();
    let failed = error
        .downcast_ref::<supertag_workspaces::setup::SetupFailed>()
        .expect("a setup failure");
    assert!(
        failed.0.starts_with("Workspace setup failed"),
        "{}",
        failed.0
    );
    assert!(
        failed.0.contains("installing") && failed.0.contains("broken"),
        "{}",
        failed.0
    );
}
