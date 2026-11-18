//! A Session's next Attempt on the same host reuses its last delivered checkout instead of
//! writing every file again, and still starts from exactly its pinned commit with Git metadata
//! SuperTag built, never the previous harness's.
use std::{
    fs,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    process::Command,
};
use supertag_workspaces::{
    Checkout, Delivery, FinalizeRequest, Outcome, PrepareRequest, Workspace, WorkspaceConfig,
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
    root: tempfile::TempDir,
    workspace: Workspace,
    base: String,
}

impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        fs::create_dir(&source).unwrap();
        git(&source, &["init", "--quiet", "--initial-branch=main"]);
        fs::write(source.join("README.md"), "original\n").unwrap();
        fs::write(source.join("keep.txt"), "unchanged\n").unwrap();
        fs::create_dir(source.join("docs")).unwrap();
        fs::write(source.join("docs/guide.md"), "guide\n").unwrap();
        fs::write(source.join(".gitignore"), "*.log\nnode_modules/\n").unwrap();
        git(&source, &["add", "-A"]);
        git(&source, &["commit", "--quiet", "-m", "Base commit"]);
        let base = git(&source, &["rev-parse", "HEAD"]);
        let workspace = Workspace::open(WorkspaceConfig {
            state_dir: root.path().join("state"),
            source,
            base_commit: base.clone(),
        })
        .unwrap();
        Self {
            root,
            workspace,
            base,
        }
    }

    async fn prepare(&self, attempt: &str, head: Option<&str>, setup: Option<&str>) -> Checkout {
        self.workspace
            .prepare(
                PrepareRequest {
                    task_id: format!("task-{attempt}"),
                    attempt_id: attempt.into(),
                    session_id: "session".into(),
                    expected_head: head.map(str::to_owned),
                    setup: setup.map(str::to_owned),
                    merge_commit: None,
                    author: None,
                },
                &CancellationToken::new(),
            )
            .await
            .unwrap()
    }

    async fn finish(&self, checkout: &Checkout, outcome: Outcome) -> Delivery {
        let delivery = self
            .workspace
            .finalize(
                checkout,
                FinalizeRequest {
                    summary: "Change things".into(),
                    outcome,
                    output_directory: None,
                    file_scope: None,
                },
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        self.workspace.park_checkout(checkout).unwrap();
        delivery
    }

    fn parked(&self) -> Vec<PathBuf> {
        fs::read_dir(self.root.path().join("state/parked"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect()
    }
}

fn inode(path: &Path) -> u64 {
    fs::metadata(path).unwrap().ino()
}

#[tokio::test]
async fn a_sessions_next_attempt_reuses_its_delivered_checkout_with_fresh_git_metadata() {
    let fixture = Fixture::new();
    let first = fixture.prepare("first", None, None).await;
    let unchanged = inode(&first.path.join("keep.txt"));
    fs::write(first.path.join("README.md"), "continued\n").unwrap();
    fs::write(first.path.join("new.txt"), "added\n").unwrap();
    fs::remove_file(first.path.join("docs/guide.md")).unwrap();
    // Left by the harness: an ignored file, and Git metadata a later Git run would obey.
    fs::write(first.path.join("debug.log"), "noise\n").unwrap();
    let mut config = fs::read_to_string(first.path.join(".git/config")).unwrap();
    config.push_str("[core]\n\tfsmonitor = /tmp/planted\n");
    fs::write(first.path.join(".git/config"), config).unwrap();
    fs::write(first.path.join(".git/hooks-planted"), "#!/bin/sh\n").unwrap();
    let delivery = fixture.finish(&first, Outcome::Completed).await;
    assert!(!first.path.exists());
    assert_eq!(fixture.parked().len(), 1);

    let next = fixture
        .prepare("next", Some(&delivery.head_commit), None)
        .await;
    assert!(fixture.parked().is_empty());
    // The files were moved, not written again.
    assert_eq!(inode(&next.path.join("keep.txt")), unchanged);
    assert_eq!(
        fs::read_to_string(next.path.join("README.md")).unwrap(),
        "continued\n"
    );
    assert!(next.path.join("new.txt").exists());
    // What a fresh checkout would not have is gone, including the emptied directory.
    assert!(!next.path.join("debug.log").exists());
    assert!(!next.path.join("docs").exists());
    // The Git metadata is SuperTag's own and reads the Session's history.
    let config = fs::read_to_string(next.path.join(".git/config")).unwrap();
    assert!(!config.contains("planted"), "{config}");
    assert!(!next.path.join(".git/hooks-planted").exists());
    assert_eq!(git(&next.path, &["status", "--porcelain"]), "");
    assert_eq!(
        git(&next.path, &["rev-parse", "HEAD"]),
        delivery.head_commit
    );
    assert_eq!(git(&next.path, &["rev-list", "--count", "HEAD"]), "2");

    // And again: a third Attempt builds on the second's packs.
    fs::write(next.path.join("README.md"), "third\n").unwrap();
    let second = fixture.finish(&next, Outcome::Completed).await;
    let third = fixture
        .prepare("third", Some(&second.head_commit), None)
        .await;
    assert_eq!(inode(&third.path.join("keep.txt")), unchanged);
    assert_eq!(git(&third.path, &["status", "--porcelain"]), "");
    assert_eq!(git(&third.path, &["rev-list", "--count", "HEAD"]), "3");
    assert_eq!(git(&third.path, &["show", "HEAD~1:README.md"]), "continued");
    assert_eq!(
        git(
            &third.path,
            &["show", &format!("{}:README.md", fixture.base)]
        ),
        "original"
    );
}

#[tokio::test]
async fn a_changed_parked_checkout_or_another_start_takes_a_fresh_checkout() {
    let fixture = Fixture::new();
    let first = fixture.prepare("first", None, None).await;
    fs::write(first.path.join("README.md"), "continued\n").unwrap();
    let delivery = fixture.finish(&first, Outcome::Completed).await;

    // Another start leaves the parked checkout where it is.
    let other = fixture.prepare("other", Some(&fixture.base), None).await;
    assert_eq!(
        fs::read_to_string(other.path.join("README.md")).unwrap(),
        "original\n"
    );
    assert_eq!(fixture.parked().len(), 1);

    // A tracked file changed after parking fails verification: the checkout is written afresh.
    let parked = fixture.parked().remove(0).join("checkout");
    fs::write(parked.join("README.md"), "tampered\n").unwrap();
    let tampered = inode(&parked.join("keep.txt"));
    let next = fixture
        .prepare("next", Some(&delivery.head_commit), None)
        .await;
    assert_ne!(inode(&next.path.join("keep.txt")), tampered);
    assert_eq!(
        fs::read_to_string(next.path.join("README.md")).unwrap(),
        "continued\n"
    );
    assert_eq!(git(&next.path, &["status", "--porcelain"]), "");
    assert!(fixture.parked().is_empty());

    // So does a tracked file hard-linked outside the checkout, though its bytes match.
    let delivery = fixture.finish(&next, Outcome::Completed).await;
    let parked = fixture.parked().remove(0).join("checkout");
    let outside = fixture.root.path().join("outside.txt");
    fs::hard_link(parked.join("keep.txt"), &outside).unwrap();
    let last = fixture
        .prepare("last", Some(&delivery.head_commit), None)
        .await;
    assert_ne!(inode(&last.path.join("keep.txt")), inode(&outside));
    assert_eq!(fs::metadata(last.path.join("keep.txt")).unwrap().nlink(), 1);
}

#[tokio::test]
async fn only_a_completed_attempt_is_parked_and_setup_outputs_stay_without_rerunning_setup() {
    let fixture = Fixture::new();
    let first = fixture.prepare("first", None, None).await;
    fs::write(first.path.join("README.md"), "failed work\n").unwrap();
    fixture.finish(&first, Outcome::Failed).await;
    assert!(fixture.parked().is_empty());
    assert!(!first.path.exists());

    let runs = fixture.root.path().join("runs");
    let setup = format!(
        "echo run >> '{}' && mkdir -p node_modules && echo dep > node_modules/dep.js",
        runs.display()
    );
    let with_setup = fixture
        .prepare("setup", Some(&fixture.base), Some(&setup))
        .await;
    let module = inode(&with_setup.path.join("node_modules/dep.js"));
    fs::write(with_setup.path.join("README.md"), "with setup\n").unwrap();
    let delivery = fixture.finish(&with_setup, Outcome::Completed).await;
    let next = fixture
        .prepare("next", Some(&delivery.head_commit), Some(&setup))
        .await;
    assert_eq!(inode(&next.path.join("node_modules/dep.js")), module);
    assert_eq!(fs::read_to_string(&runs).unwrap().lines().count(), 1);
    assert_eq!(git(&next.path, &["status", "--porcelain"]), "");
    // A delivery from the reused checkout still skips the setup outputs.
    fs::write(next.path.join("README.md"), "after reuse\n").unwrap();
    let delivered = fixture.finish(&next, Outcome::Completed).await;
    assert_eq!(delivered.changed_files, 1);
}
