//! A local Workspace whose repository is a shallow clone: it prepares, delivers, and lands like a
//! complete one, with SuperTag's private repositories cut where the clone is, and keeps working
//! when the clone is deepened or made complete between Tasks.
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
    process::Command,
};

use supertag_workspaces::{
    Checkout, Delivery, FinalizeRequest, MissingPrerequisite, Outcome, PrepareRequest, Workspace,
    WorkspaceConfig, complete_delivery_bundle, failure_cause,
    session_branch::{Imported, SessionDelivery, import},
};
use tokio_util::sync::CancellationToken;

const BRANCH: &str = "supertag/session/0123456789abcdef";

fn run(path: &Path, args: &[&str]) -> (bool, String, String) {
    let output = Command::new("/usr/bin/git")
        .current_dir(path)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_AUTHOR_NAME", "Fixture")
        .env("GIT_AUTHOR_EMAIL", "fixture@example.test")
        .env("GIT_COMMITTER_NAME", "Fixture")
        .env("GIT_COMMITTER_EMAIL", "fixture@example.test")
        .args([
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "commit.gpgSign=false",
            "-c",
            "protocol.file.allow=always",
            "-c",
            "init.defaultBranch=main",
            "-c",
            "gc.auto=0",
        ])
        .args(args)
        .output()
        .unwrap();
    (
        output.status.success(),
        String::from_utf8_lossy(&output.stdout).trim().to_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

fn git(path: &Path, args: &[&str]) -> String {
    let (ok, out, err) = run(path, args);
    assert!(ok, "git {args:?}: {err}");
    out
}

/// A repository with `commits` commits on `main`, each changing `a.txt` and adding a file.
fn origin(root: &Path, commits: usize) -> PathBuf {
    let origin = root.join("origin");
    fs::create_dir(&origin).unwrap();
    git(&origin, &["init", "--quiet"]);
    fs::write(origin.join("keep.txt"), "kept\n").unwrap();
    for number in 1..=commits {
        advance(&origin, &format!("{number}"));
    }
    origin
}

fn advance(origin: &Path, name: &str) -> String {
    fs::write(origin.join("a.txt"), format!("{name}\n")).unwrap();
    fs::write(origin.join(format!("file-{name}.txt")), "x\n").unwrap();
    git(origin, &["add", "-A"]);
    git(origin, &["commit", "--quiet", "-m", name]);
    git(origin, &["rev-parse", "HEAD"])
}

fn shallow_clone(root: &Path, origin: &Path, name: &str, depth: usize) -> PathBuf {
    git(
        root,
        &[
            "clone",
            "--quiet",
            &format!("--depth={depth}"),
            &format!("file://{}", origin.display()),
            name,
        ],
    );
    root.join(name)
}

fn lines(path: &Path) -> BTreeSet<String> {
    fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .map(str::to_owned)
        .collect()
}

fn open(state: &Path, source: &Path, base: &str) -> Workspace {
    Workspace::open(WorkspaceConfig {
        state_dir: state.to_owned(),
        source: source.to_owned(),
        base_commit: base.to_owned(),
    })
    .unwrap()
}

fn request(task: &str, head: Option<&str>, merge: Option<&str>) -> PrepareRequest {
    PrepareRequest {
        task_id: task.into(),
        attempt_id: "attempt".into(),
        session_id: "session".into(),
        expected_head: head.map(str::to_owned),
        setup: None,
        merge_commit: merge.map(str::to_owned),
        author: None,
    }
}

async fn finish(workspace: &Workspace, checkout: &Checkout, summary: &str) -> Delivery {
    workspace
        .finalize(
            checkout,
            FinalizeRequest {
                summary: summary.into(),
                outcome: Outcome::Completed,
                output_directory: None,
                file_scope: None,
            },
            &CancellationToken::new(),
        )
        .await
        .unwrap()
}

fn session(delivery: &Delivery) -> SessionDelivery {
    SessionDelivery {
        branch: BRANCH.into(),
        delivery_id: delivery.delivery_id.clone(),
        base_commit: delivery.base_commit.clone(),
        start_commit: delivery.start_commit.clone(),
        head_commit: delivery.head_commit.clone(),
        bundle_sha256: delivery.bundle_sha256.clone(),
        bundle_byte_length: fs::metadata(&delivery.bundle_path).unwrap().len(),
    }
}

/// Lands a delivery in the user's repository as the Worklet does.
async fn land(source: &Path, delivery: &Delivery) -> anyhow::Result<Imported> {
    import(
        source,
        &session(delivery),
        &delivery.bundle_path,
        false,
        &CancellationToken::new(),
    )
    .await
}

/// The prerequisite commits a bundle's header names.
fn prerequisites(bundle: &Path) -> Vec<String> {
    let bytes = fs::read(bundle).unwrap();
    let end = bytes.windows(2).position(|part| part == b"\n\n").unwrap();
    std::str::from_utf8(&bytes[..end])
        .unwrap()
        .lines()
        .filter_map(|line| line.strip_prefix('-'))
        .map(|line| line.split(' ').next().unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn a_shallow_clone_prepares_delivers_and_lands_like_a_complete_one() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    let origin = origin(&root, 4);
    let source = shallow_clone(&root, &origin, "source", 1);
    let base = git(&source, &["rev-parse", "HEAD"]);
    let boundary = lines(&source.join(".git/shallow"));
    assert_eq!(boundary, BTreeSet::from([base.clone()]));
    let cancel = CancellationToken::new();

    let state = root.join("state");
    let workspace = open(&state, &source, &base);
    let checkout = workspace
        .prepare(request("first", None, None), &cancel)
        .await
        .unwrap();
    assert_eq!(fs::read(checkout.path.join("a.txt")).unwrap(), b"4\n");
    assert_eq!(fs::read(checkout.path.join("keep.txt")).unwrap(), b"kept\n");
    // SuperTag's repository stops where the clone does, and so does the checkout's.
    assert_eq!(lines(&state.join("repository.git/shallow")), boundary);
    assert_eq!(lines(&checkout.path.join(".git/shallow")), boundary);
    // The Tag's own Git works in the checkout and sees the history the clone has.
    assert_eq!(git(&checkout.path, &["status", "--porcelain"]), "");
    assert_eq!(git(&checkout.path, &["rev-list", "--count", "HEAD"]), "1");
    git(&checkout.path, &["fsck", "--strict", "--no-dangling"]);

    // The first delivery builds on the boundary commit itself, and names only it.
    fs::write(checkout.path.join("a.txt"), "first\n").unwrap();
    let first = finish(&workspace, &checkout, "First").await;
    assert!(first.committed);
    assert_eq!(first.start_commit, base);
    assert_eq!(prerequisites(&first.bundle_path), [base.as_str()]);
    assert_eq!(land(&source, &first).await.unwrap(), Imported::Created);
    assert_eq!(git(&source, &["rev-parse", BRANCH]), first.head_commit);
    assert_eq!(
        git(&source, &["rev-list", "--count", BRANCH]),
        "2",
        "the Session branch is the clone's history and the delivery"
    );
    assert_eq!(git(&source, &["show", &format!("{BRANCH}:a.txt")]), "first");
    // Landing changed neither where the clone's history stops nor its soundness.
    assert_eq!(lines(&source.join(".git/shallow")), boundary);
    git(&source, &["fsck", "--strict", "--no-dangling"]);
    workspace.park_checkout(&checkout).unwrap();

    // The Session's next Task continues its delivery, in the checkout it kept.
    let checkout = workspace
        .prepare(request("second", Some(&first.head_commit), None), &cancel)
        .await
        .unwrap();
    assert_eq!(fs::read(checkout.path.join("a.txt")).unwrap(), b"first\n");
    assert_eq!(git(&checkout.path, &["status", "--porcelain"]), "");
    assert_eq!(git(&checkout.path, &["rev-list", "--count", "HEAD"]), "2");
    assert_eq!(lines(&checkout.path.join(".git/shallow")), boundary);
    fs::write(checkout.path.join("new.txt"), "second\n").unwrap();
    let second = finish(&workspace, &checkout, "Second").await;
    assert_eq!(
        prerequisites(&second.bundle_path),
        [first.head_commit.as_str()]
    );
    assert_eq!(land(&source, &second).await.unwrap(), Imported::Advanced);
    assert_eq!(git(&source, &["rev-parse", BRANCH]), second.head_commit);

    // A Task that changes nothing on the boundary commit still has its delivery: the commit
    // itself, with the history the clone holds and no more.
    let other = open(&root.join("other"), &source, &base);
    let checkout = other
        .prepare(request("unchanged", None, None), &cancel)
        .await
        .unwrap();
    let unchanged = finish(&other, &checkout, "Nothing").await;
    assert!(!unchanged.committed);
    assert_eq!(unchanged.head_commit, base);
    assert!(prerequisites(&unchanged.bundle_path).is_empty());
}

#[tokio::test]
async fn a_clone_deepened_or_made_complete_between_tasks_keeps_working() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    let origin = origin(&root, 4);
    let source = shallow_clone(&root, &origin, "source", 1);
    let base = git(&source, &["rev-parse", "HEAD"]);
    let cancel = CancellationToken::new();
    let state = root.join("state");
    let private = state.join("repository.git/shallow");
    // Another lane of the host copies the base while the clone is shallow, for later.
    assert!(
        open(&root.join("early"), &source, &base)
            .holds_commit(&base, &cancel)
            .await
    );
    let workspace = open(&state, &source, &base);
    let checkout = workspace
        .prepare(request("first", None, None), &cancel)
        .await
        .unwrap();
    fs::write(checkout.path.join("new.txt"), "first\n").unwrap();
    let first = finish(&workspace, &checkout, "First").await;
    assert_eq!(land(&source, &first).await.unwrap(), Imported::Created);

    // The clone is deepened by one commit. The Session's next Task starts as before: its
    // delivery is already held, so nothing is read from the clone.
    git(&source, &["fetch", "--quiet", "--deepen=1"]);
    let deepened = lines(&source.join(".git/shallow"));
    assert!(!deepened.contains(&base) && deepened.len() == 1);
    let checkout = workspace
        .prepare(request("second", Some(&first.head_commit), None), &cancel)
        .await
        .unwrap();
    fs::write(checkout.path.join("new.txt"), "second\n").unwrap();
    let second = finish(&workspace, &checkout, "Second").await;
    assert_eq!(land(&source, &second).await.unwrap(), Imported::Advanced);
    assert_eq!(lines(&private), BTreeSet::from([base.clone()]));

    // The branch moves on and the clone fetches it. A merge follow-up copies the target from
    // the clone, and with it the history the clone has gained behind the old boundary.
    let target = advance(&origin, "5");
    git(&source, &["fetch", "--quiet", "origin", "main"]);
    workspace
        .import_source_commit(&target, &cancel)
        .await
        .unwrap();
    assert_eq!(lines(&private), deepened);
    let checkout = workspace
        .prepare(
            request("merge", Some(&second.head_commit), Some(&target)),
            &cancel,
        )
        .await
        .unwrap();
    assert_eq!(fs::read(checkout.path.join("a.txt")).unwrap(), b"5\n");
    assert_eq!(
        fs::read(checkout.path.join("new.txt")).unwrap(),
        b"second\n"
    );
    let merged = finish(&workspace, &checkout, "Merge").await;
    // The merge's own bundle carries the target's new commits beside it, and builds on the
    // Session's last commit and on the commit of its history the target moved on from, both of
    // which the clone holds.
    assert_eq!(land(&source, &merged).await.unwrap(), Imported::Advanced);
    assert_eq!(
        git(&source, &["rev-list", "--parents", "-n", "1", BRANCH]),
        format!("{} {} {target}", merged.head_commit, second.head_commit)
    );
    git(&source, &["fsck", "--strict", "--no-dangling"]);

    // The clone is made complete. Another lane of the host opens the same base with its whole
    // history and takes the Session's commits from the lane that holds them, whose own copy
    // of the merged target's history still stops at the deepened boundary.
    git(&source, &["fetch", "--quiet", "--unshallow"]);
    assert!(!source.join(".git/shallow").exists());
    let lane = root.join("lane");
    let other = open(&lane, &source, &base);
    other
        .import_held_commit(&state, &merged.head_commit, &cancel)
        .await
        .unwrap();
    // Every commit it now holds has its parents, so it records no boundary of its own.
    assert!(!lane.join("repository.git/shallow").exists());
    let checkout = other
        .prepare(request("third", Some(&merged.head_commit), None), &cancel)
        .await
        .unwrap();
    fs::write(checkout.path.join("new.txt"), "third\n").unwrap();
    let third = finish(&other, &checkout, "Third").await;
    assert_eq!(land(&source, &third).await.unwrap(), Imported::Advanced);

    // The first lane's next copy from the now complete clone removes its boundary.
    let later = advance(&origin, "6");
    git(&source, &["fetch", "--quiet", "origin", "main"]);
    workspace
        .import_source_commit(&later, &cancel)
        .await
        .unwrap();
    assert!(!private.exists(), "{:?}", lines(&private));
    let whole: usize = git(&origin, &["rev-list", "--count", "HEAD"])
        .parse()
        .unwrap();
    let held = Command::new("/usr/bin/git")
        .arg(format!(
            "--git-dir={}",
            state.join("repository.git").display()
        ))
        .args(["rev-list", "--count", &later])
        .output()
        .unwrap();
    assert_eq!(
        String::from_utf8_lossy(&held.stdout).trim(),
        whole.to_string()
    );
    // A lane that opened the base while the clone was shallow takes a delivery from one that
    // opened it complete, and still stops where it did.
    let early = open(&root.join("early"), &source, &base);
    early
        .import_held_commit(&lane, &third.head_commit, &cancel)
        .await
        .unwrap();
    early
        .prepare(request("fourth", Some(&third.head_commit), None), &cancel)
        .await
        .unwrap();
    assert_eq!(
        lines(&root.join("early/repository.git/shallow")),
        BTreeSet::from([base.clone()])
    );
}

/// The user's repository lost the commit a delivery continues, such as a deleted Session
/// branch that was then pruned. The Worklet lands the delivered commit's whole history instead,
/// which for a shallow clone is the history the clone has.
#[tokio::test]
async fn a_delivery_whose_start_the_clone_lost_lands_with_the_history_supertag_holds() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    let origin = origin(&root, 3);
    let source = shallow_clone(&root, &origin, "source", 2);
    let base = git(&source, &["rev-parse", "HEAD"]);
    let cancel = CancellationToken::new();
    let state = root.join("state");
    let workspace = open(&state, &source, &base);
    let checkout = workspace
        .prepare(request("first", None, None), &cancel)
        .await
        .unwrap();
    assert_eq!(git(&checkout.path, &["rev-list", "--count", "HEAD"]), "1");
    fs::write(checkout.path.join("new.txt"), "first\n").unwrap();
    let first = finish(&workspace, &checkout, "First").await;
    assert_eq!(land(&source, &first).await.unwrap(), Imported::Created);
    git(&source, &["branch", "--quiet", "-D", BRANCH]);
    git(&source, &["reflog", "expire", "--expire=now", "--all"]);
    git(&source, &["gc", "--quiet", "--prune=now"]);
    assert!(!run(&source, &["cat-file", "-e", &first.head_commit]).0);

    let checkout = workspace
        .prepare(request("second", Some(&first.head_commit), None), &cancel)
        .await
        .unwrap();
    fs::write(checkout.path.join("new.txt"), "second\n").unwrap();
    let second = finish(&workspace, &checkout, "Second").await;
    let error = land(&source, &second).await.unwrap_err();
    assert!(error.is::<MissingPrerequisite>(), "{error:#}");
    let bytes = complete_delivery_bundle(&state, &second.head_commit, &second.delivery_id, &cancel)
        .await
        .unwrap();
    let complete = root.join("complete.bundle");
    fs::write(&complete, bytes).unwrap();
    assert!(prerequisites(&complete).is_empty());
    assert_eq!(
        import(&source, &session(&second), &complete, true, &cancel)
            .await
            .unwrap(),
        Imported::Created
    );
    assert_eq!(git(&source, &["rev-parse", BRANCH]), second.head_commit);
    // Two commits of the clone and the Session's two.
    assert_eq!(git(&source, &["rev-list", "--count", BRANCH]), "4");
    git(&source, &["fsck", "--strict", "--no-dangling"]);
}

#[tokio::test]
async fn a_shallow_clone_in_other_shapes_prepares_too() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    let cancel = CancellationToken::new();

    // SHA-256 object names.
    let sha256 = root.join("sha256-origin");
    fs::create_dir(&sha256).unwrap();
    git(&sha256, &["init", "--quiet", "--object-format=sha256"]);
    advance(&sha256, "1");
    advance(&sha256, "2");
    git(
        &root,
        &[
            "clone",
            "--quiet",
            "--depth=1",
            &format!("file://{}", sha256.display()),
            "sha256",
        ],
    );
    let source = root.join("sha256");
    let base = git(&source, &["rev-parse", "HEAD"]);
    assert_eq!(base.len(), 64);
    let workspace = open(&root.join("sha256-state"), &source, &base);
    let checkout = workspace
        .prepare(request("first", None, None), &cancel)
        .await
        .unwrap();
    fs::write(checkout.path.join("a.txt"), "changed\n").unwrap();
    let delivery = finish(&workspace, &checkout, "Change").await;
    assert_eq!(land(&source, &delivery).await.unwrap(), Imported::Created);

    // A linked worktree of a shallow clone, whose boundary is its repository's; a clone cut by
    // date, with a merge whose two sides both stop; and a base that is not a boundary commit.
    let origin = origin(&root, 3);
    git(&origin, &["checkout", "--quiet", "-b", "side", "HEAD~1"]);
    fs::write(origin.join("side.txt"), "side\n").unwrap();
    git(&origin, &["add", "-A"]);
    git(&origin, &["commit", "--quiet", "-m", "side"]);
    git(&origin, &["checkout", "--quiet", "main"]);
    git(
        &origin,
        &["merge", "--quiet", "--no-ff", "-m", "merge", "side"],
    );
    advance(&origin, "after");
    let source = shallow_clone(&root, &origin, "merged", 2);
    let base = git(&source, &["rev-parse", "HEAD"]);
    let boundary = lines(&source.join(".git/shallow"));
    assert!(!boundary.contains(&base), "{boundary:?}");
    git(
        &source,
        &["worktree", "add", "--quiet", "-b", "work", "../linked"],
    );
    let state = root.join("merged-state");
    let workspace = open(&state, &root.join("linked"), &base);
    let checkout = workspace
        .prepare(request("first", None, None), &cancel)
        .await
        .unwrap();
    assert_eq!(lines(&state.join("repository.git/shallow")), boundary);
    // The checkout holds its base alone, as for any repository.
    assert_eq!(
        lines(&checkout.path.join(".git/shallow")),
        BTreeSet::from([base.clone()])
    );
    fs::write(checkout.path.join("a.txt"), "changed\n").unwrap();
    let delivery = finish(&workspace, &checkout, "Change").await;
    assert_eq!(land(&source, &delivery).await.unwrap(), Imported::Created);
}

/// The `shallow` file is the one part of a private repository's metadata that varies. It is read
/// only as a list of commit IDs, from the user's repository and from SuperTag's own.
#[tokio::test]
async fn a_shallow_file_that_is_not_a_list_of_commits_is_refused() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    let origin = origin(&root, 3);
    let cancel = CancellationToken::new();
    let source = shallow_clone(&root, &origin, "source", 1);
    let base = git(&source, &["rev-parse", "HEAD"]);
    let good = fs::read_to_string(source.join(".git/shallow")).unwrap();

    // In the user's repository: nothing is copied.
    for (name, content) in [
        ("words", "not a commit\n".to_owned()),
        ("short", format!("{}\n", &base[..39])),
        ("upper", good.to_uppercase()),
        ("option", format!("{base}\n--all\n")),
        ("sha256", format!("{base}{}\n", &base[..24])),
    ] {
        fs::write(source.join(".git/shallow"), content).unwrap();
        let state = root.join(format!("state-{name}"));
        let error = open(&state, &source, &base)
            .prepare(request("first", None, None), &cancel)
            .await
            .unwrap_err();
        assert!(
            format!("{error:#}").contains("Git shallow file"),
            "{name}: {error:#}"
        );
        assert!(!state.join("repository.git/shallow").exists(), "{name}");
    }
    fs::write(source.join(".git/shallow"), &good).unwrap();

    // In SuperTag's repository, and in a checkout, whose `.git` the harness can write: no Git
    // command runs there.
    let state = root.join("state");
    let workspace = open(&state, &source, &base);
    let checkout = workspace
        .prepare(request("first", None, None), &cancel)
        .await
        .unwrap();
    let private = state.join("repository.git/shallow");
    fs::write(&private, "refs/heads/main\n").unwrap();
    let another = || PrepareRequest {
        session_id: "another".into(),
        ..request("second", None, None)
    };
    let error = workspace.prepare(another(), &cancel).await.unwrap_err();
    assert!(
        format!("{error:#}").contains("unexpected Git metadata: shallow"),
        "{error:#}"
    );
    fs::remove_file(&private).unwrap();
    std::os::unix::fs::symlink(source.join(".git/shallow"), &private).unwrap();
    assert!(workspace.prepare(another(), &cancel).await.is_err());
    fs::remove_file(&private).unwrap();
    fs::write(&private, &good).unwrap();
    fs::write(checkout.path.join(".git/shallow"), "garbage\n").unwrap();
    let error = supertag_workspaces::changed_paths(&checkout, |_| true, 10, &cancel)
        .await
        .unwrap_err();
    assert!(
        format!("{error:#}").contains("unexpected Git metadata: shallow"),
        "{error:#}"
    );
    // The harness's Git metadata is not what a delivery is read from.
    fs::write(checkout.path.join("a.txt"), "changed\n").unwrap();
    let delivery = finish(&workspace, &checkout, "Change").await;
    assert_eq!(land(&source, &delivery).await.unwrap(), Imported::Created);
}

/// Remote Workspaces and remote sandboxes move a commit's whole history between hosts as a
/// bundle, so they keep refusing a shallow clone, and say what to do.
#[tokio::test]
async fn what_needs_the_whole_history_still_refuses_a_shallow_clone() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    let origin = origin(&root, 3);
    let cancel = CancellationToken::new();
    let source = shallow_clone(&root, &origin, "source", 1);
    let base = git(&source, &["rev-parse", "HEAD"]);

    // A remote Workspace's source, as fetched from a remote that is itself a shallow clone.
    let error =
        supertag_workspaces::source::capture(&root.join("capture"), &source, &base, &cancel)
            .await
            .unwrap_err();
    let cause = failure_cause(&error);
    assert!(
        cause.starts_with("the Workspace's remote is a shallow clone")
            && cause.contains("`git fetch --unshallow`"),
        "{cause}"
    );
    assert!(!root.join("capture/repository.git/shallow").exists());

    // A Task that would run in a remote sandbox.
    let state = root.join("state");
    let workspace = open(&state, &source, &base);
    let checkout = workspace
        .prepare(request("first", None, None), &cancel)
        .await
        .unwrap();
    for error in [
        workspace
            .export_prepared(&checkout, &cancel)
            .await
            .err()
            .unwrap(),
        workspace
            .export_trusted(&checkout, &cancel)
            .await
            .err()
            .unwrap(),
    ] {
        assert_eq!(
            failure_cause(&error),
            "the repository is a shallow clone, and a Task that runs in a remote sandbox needs the whole history of the commit it starts from. Run `git fetch --unshallow` in the repository and try again"
        );
    }
    // What the cause says to run is enough: the history the clone gained is copied.
    git(&source, &["fetch", "--quiet", "--unshallow"]);
    workspace.export_prepared(&checkout, &cancel).await.unwrap();
    assert!(!state.join("repository.git/shallow").exists());
    supertag_workspaces::source::capture(&root.join("capture"), &source, &base, &cancel)
        .await
        .unwrap();
}
