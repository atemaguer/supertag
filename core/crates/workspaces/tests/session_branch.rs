//! Importing verified deliveries into an operator's repository as the Session branch.
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
};

use sha2::{Digest, Sha256};
use supertag_workspaces::{
    MissingPrerequisite,
    session_branch::{BranchCheckedOut, BranchMoved, Imported, SessionDelivery, import},
};
use tokio_util::sync::CancellationToken;

const BRANCH: &str = "supertag/session/0123456789abcdef";

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

fn succeeds(path: &Path, args: &[&str]) -> bool {
    Command::new("/usr/bin/git")
        .current_dir(path)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .args(args)
        .output()
        .unwrap()
        .status
        .success()
}

struct Fixture {
    root: tempfile::TempDir,
    /// The operator's repository, which receives the Session branch.
    operator: PathBuf,
    /// A Worker Host's private repository, which produces the bundles.
    worker: PathBuf,
    base: String,
    deliveries: u32,
}

impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let operator = root.path().join("operator");
        fs::create_dir(&operator).unwrap();
        git(&operator, &["init", "--quiet", "--initial-branch=main"]);
        fs::write(operator.join("README.md"), "base\n").unwrap();
        git(&operator, &["add", "-A"]);
        git(&operator, &["commit", "--quiet", "-m", "Base"]);
        let base = git(&operator, &["rev-parse", "HEAD"]);
        let worker = root.path().join("worker");
        git(
            root.path(),
            &[
                "clone",
                "--quiet",
                "--no-local",
                operator.to_str().unwrap(),
                worker.to_str().unwrap(),
            ],
        );
        Self {
            root,
            operator,
            worker,
            base,
            deliveries: 0,
        }
    }

    /// Commit `file` on top of `start` in the worker repository and bundle it as a delivery.
    fn deliver(&mut self, start: &str, file: &str) -> (SessionDelivery, PathBuf) {
        self.deliveries += 1;
        git(&self.worker, &["checkout", "--quiet", "--detach", start]);
        fs::write(self.worker.join(file), format!("{file}\n")).unwrap();
        git(&self.worker, &["add", "-A"]);
        git(&self.worker, &["commit", "--quiet", "-m", file]);
        let head = git(&self.worker, &["rev-parse", "HEAD"]);
        let delivery_id = format!("{:x}", Sha256::digest(file.as_bytes()));
        let reference = format!("refs/heads/supertag-deliveries/{delivery_id}");
        git(&self.worker, &["update-ref", &reference, &head]);
        let bundle = self
            .root
            .path()
            .join(format!("delivery-{}.bundle", self.deliveries));
        git(
            &self.worker,
            &["bundle", "create", bundle.to_str().unwrap(), &reference],
        );
        let bytes = fs::read(&bundle).unwrap();
        (
            SessionDelivery {
                branch: BRANCH.into(),
                delivery_id,
                base_commit: self.base.clone(),
                start_commit: start.into(),
                head_commit: head,
                bundle_sha256: format!("{:x}", Sha256::digest(&bytes)),
                bundle_byte_length: bytes.len() as u64,
            },
            bundle,
        )
    }

    fn branch(&self) -> Option<String> {
        succeeds(
            &self.operator,
            &[
                "rev-parse",
                "-q",
                "--verify",
                &format!("refs/heads/{BRANCH}"),
            ],
        )
        .then(|| {
            git(
                &self.operator,
                &["rev-parse", &format!("refs/heads/{BRANCH}")],
            )
        })
    }

    fn has(&self, commit: &str) -> bool {
        succeeds(&self.operator, &["cat-file", "-e", commit])
    }
}

async fn run(
    fixture: &Fixture,
    delivery: &SessionDelivery,
    bundle: &Path,
) -> anyhow::Result<Imported> {
    import(
        &fixture.operator,
        delivery,
        bundle,
        false,
        &CancellationToken::new(),
    )
    .await
}

#[tokio::test]
async fn each_later_delivery_of_a_session_advances_one_branch() {
    let mut fixture = Fixture::new();
    fs::write(fixture.operator.join("README.md"), "operator edit\n").unwrap();
    let base = fixture.base.clone();
    let (first, first_bundle) = fixture.deliver(&base, "a.txt");
    assert_eq!(
        run(&fixture, &first, &first_bundle).await.unwrap(),
        Imported::Created
    );
    assert_eq!(
        fixture.branch().as_deref(),
        Some(first.head_commit.as_str())
    );
    assert_eq!(
        run(&fixture, &first, &first_bundle).await.unwrap(),
        Imported::Current
    );

    let (second, second_bundle) = fixture.deliver(&first.head_commit.clone(), "b.txt");
    assert_eq!(
        run(&fixture, &second, &second_bundle).await.unwrap(),
        Imported::Advanced
    );
    assert_eq!(
        fixture.branch().as_deref(),
        Some(second.head_commit.as_str())
    );
    assert_eq!(
        git(
            &fixture.operator,
            &["rev-parse", &format!("{}^", second.head_commit)]
        ),
        first.head_commit
    );
    // An earlier delivery imported late never moves the branch back.
    assert_eq!(
        run(&fixture, &first, &first_bundle).await.unwrap(),
        Imported::Current
    );
    assert_eq!(
        fixture.branch().as_deref(),
        Some(second.head_commit.as_str())
    );

    // The operator's checkout, its current branch, and its edits never change.
    assert_eq!(git(&fixture.operator, &["rev-parse", "HEAD"]), fixture.base);
    assert_eq!(
        git(&fixture.operator, &["branch", "--show-current"]),
        "main"
    );
    assert_eq!(
        fs::read_to_string(fixture.operator.join("README.md")).unwrap(),
        "operator edit\n"
    );
    assert!(!fixture.operator.join("a.txt").exists());
    // Only the Session branch was written; no delivery ref reaches the repository.
    assert_eq!(
        git(&fixture.operator, &["for-each-ref", "--format=%(refname)"]),
        format!("refs/heads/main\nrefs/heads/{BRANCH}")
    );
}

#[tokio::test]
async fn a_later_delivery_creates_the_branch_when_an_earlier_one_was_never_imported() {
    let mut fixture = Fixture::new();
    let base = fixture.base.clone();
    let (first, _) = fixture.deliver(&base, "a.txt");
    let (second, bundle) = fixture.deliver(&first.head_commit.clone(), "b.txt");
    assert_eq!(
        run(&fixture, &second, &bundle).await.unwrap(),
        Imported::Created
    );
    assert_eq!(
        fixture.branch().as_deref(),
        Some(second.head_commit.as_str())
    );
}

#[tokio::test]
async fn a_tampered_or_mislabelled_bundle_never_reaches_the_repository() {
    let mut fixture = Fixture::new();
    let base = fixture.base.clone();
    let (delivery, bundle) = fixture.deliver(&base, "a.txt");

    // Different bytes than the receipt.
    let tampered = fixture.root.path().join("tampered.bundle");
    let mut bytes = fs::read(&bundle).unwrap();
    let last = bytes.len() - 1;
    bytes[last] ^= 1;
    fs::write(&tampered, &bytes).unwrap();
    let error = run(&fixture, &delivery, &tampered).await.unwrap_err();
    assert!(
        error.to_string().contains("differs from its receipt"),
        "{error:#}"
    );

    // A receipt for different bytes of the right size.
    let mut wrong = delivery.clone();
    wrong.bundle_sha256 = "0".repeat(64);
    assert!(run(&fixture, &wrong, &bundle).await.is_err());

    // A second ref beside the delivery ref.
    git(&fixture.worker, &["branch", "extra", &delivery.head_commit]);
    let two = fixture.root.path().join("two.bundle");
    git(
        &fixture.worker,
        &[
            "bundle",
            "create",
            two.to_str().unwrap(),
            &format!("refs/heads/supertag-deliveries/{}", delivery.delivery_id),
            "refs/heads/extra",
        ],
    );
    let bytes = fs::read(&two).unwrap();
    let mut extra = delivery.clone();
    extra.bundle_sha256 = format!("{:x}", Sha256::digest(&bytes));
    extra.bundle_byte_length = bytes.len() as u64;
    let error = run(&fixture, &extra, &two).await.unwrap_err();
    assert!(error.to_string().contains("does not bind"), "{error:#}");

    // A bundle for another delivery's ref.
    let mut other = delivery.clone();
    other.delivery_id = "f".repeat(64);
    assert!(run(&fixture, &other, &bundle).await.is_err());

    // A delivered commit that does not descend from the Task's base.
    let unrelated = fixture.root.path().join("unrelated");
    fs::create_dir(&unrelated).unwrap();
    git(&unrelated, &["init", "--quiet"]);
    fs::write(unrelated.join("x.txt"), "x\n").unwrap();
    git(&unrelated, &["add", "-A"]);
    git(&unrelated, &["commit", "--quiet", "-m", "Unrelated"]);
    let head = git(&unrelated, &["rev-parse", "HEAD"]);
    let id = "e".repeat(64);
    let reference = format!("refs/heads/supertag-deliveries/{id}");
    git(&unrelated, &["update-ref", &reference, &head]);
    let foreign = fixture.root.path().join("foreign.bundle");
    git(
        &unrelated,
        &["bundle", "create", foreign.to_str().unwrap(), &reference],
    );
    let bytes = fs::read(&foreign).unwrap();
    let foreign_delivery = SessionDelivery {
        branch: BRANCH.into(),
        delivery_id: id,
        base_commit: fixture.base.clone(),
        start_commit: fixture.base.clone(),
        head_commit: head,
        bundle_sha256: format!("{:x}", Sha256::digest(&bytes)),
        bundle_byte_length: bytes.len() as u64,
    };
    let error = run(&fixture, &foreign_delivery, &foreign)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("does not descend"), "{error:#}");

    assert!(fixture.branch().is_none());
    assert!(!fixture.has(&delivery.head_commit));
}

#[tokio::test]
async fn a_branch_the_operator_moved_is_reported_and_kept() {
    let mut fixture = Fixture::new();
    let base = fixture.base.clone();
    let (first, first_bundle) = fixture.deliver(&base, "a.txt");
    run(&fixture, &first, &first_bundle).await.unwrap();
    let (second, second_bundle) = fixture.deliver(&first.head_commit.clone(), "b.txt");

    // A person commits on top of the Session branch: the delivery no longer continues it.
    git(
        &fixture.operator,
        &["worktree", "add", "--quiet", "../person", BRANCH],
    );
    let person = fixture.root.path().join("person");
    fs::write(person.join("person.txt"), "person\n").unwrap();
    git(&person, &["add", "-A"]);
    git(&person, &["commit", "--quiet", "-m", "Person"]);
    let moved = git(&person, &["rev-parse", "HEAD"]);
    git(&person, &["checkout", "--quiet", "--detach"]);
    let error = run(&fixture, &second, &second_bundle).await.unwrap_err();
    let moved_error = error.downcast_ref::<BranchMoved>().expect("branch moved");
    assert_eq!(moved_error.current, moved);
    assert!(
        error.to_string().contains("left the branch unchanged"),
        "{error:#}"
    );
    assert_eq!(fixture.branch().as_deref(), Some(moved.as_str()));

    // A branch reset to the base was moved by a person too.
    git(
        &fixture.operator,
        &["branch", "--force", BRANCH, &fixture.base],
    );
    let error = run(&fixture, &second, &second_bundle).await.unwrap_err();
    assert!(error.downcast_ref::<BranchMoved>().is_some(), "{error:#}");
    assert_eq!(fixture.branch().as_deref(), Some(fixture.base.as_str()));

    // Deleting the branch lets the next import recreate it.
    git(&fixture.operator, &["branch", "-D", BRANCH]);
    assert_eq!(
        run(&fixture, &second, &second_bundle).await.unwrap(),
        Imported::Created
    );
}

#[tokio::test]
async fn a_checked_out_session_branch_is_not_moved() {
    let mut fixture = Fixture::new();
    let base = fixture.base.clone();
    let (first, first_bundle) = fixture.deliver(&base, "a.txt");
    run(&fixture, &first, &first_bundle).await.unwrap();
    let (second, second_bundle) = fixture.deliver(&first.head_commit.clone(), "b.txt");
    git(&fixture.operator, &["switch", "--quiet", BRANCH]);
    let error = run(&fixture, &second, &second_bundle).await.unwrap_err();
    assert!(
        error.downcast_ref::<BranchCheckedOut>().is_some(),
        "{error:#}"
    );
    assert_eq!(
        fixture.branch().as_deref(),
        Some(first.head_commit.as_str())
    );
    git(&fixture.operator, &["switch", "--quiet", "main"]);
    assert_eq!(
        run(&fixture, &second, &second_bundle).await.unwrap(),
        Imported::Advanced
    );
}

#[tokio::test]
async fn repository_hooks_and_fsmonitor_do_not_run_during_an_import() {
    let mut fixture = Fixture::new();
    let hooks = fixture.root.path().join("hooks");
    fs::create_dir(&hooks).unwrap();
    let marker = fixture.root.path().join("hook-ran");
    for name in ["reference-transaction", "post-checkout", "post-merge"] {
        let hook = hooks.join(name);
        fs::write(
            &hook,
            format!("#!/bin/sh\necho {name} >> '{}'\n", marker.display()),
        )
        .unwrap();
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
    }
    git(
        &fixture.operator,
        &["config", "core.hooksPath", hooks.to_str().unwrap()],
    );
    // A Workspace harness that could write this repository could also set an fsmonitor.
    let monitor = hooks.join("fsmonitor");
    fs::write(
        &monitor,
        format!("#!/bin/sh\necho fsmonitor >> '{}'\n", marker.display()),
    )
    .unwrap();
    fs::set_permissions(&monitor, fs::Permissions::from_mode(0o755)).unwrap();
    git(
        &fixture.operator,
        &["config", "core.fsmonitor", monitor.to_str().unwrap()],
    );
    let base = fixture.base.clone();
    let (delivery, bundle) = fixture.deliver(&base, "a.txt");
    assert_eq!(
        run(&fixture, &delivery, &bundle).await.unwrap(),
        Imported::Created
    );
    assert!(
        !marker.exists(),
        "a repository hook or fsmonitor ran during the import"
    );
}

/// The packs and object counts in the operator's repository.
fn objects(fixture: &Fixture) -> (String, Vec<String>) {
    let counts = git(&fixture.operator, &["count-objects", "-v"]);
    let mut packs: Vec<String> = fs::read_dir(fixture.operator.join(".git/objects/pack"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    packs.sort();
    (counts, packs)
}

/// Bundle `head` from `repository` as a delivery whose receipt matches the bundle's bytes.
fn bundle_of(
    fixture: &Fixture,
    repository: &Path,
    head: &str,
    id: &str,
    name: &str,
) -> (SessionDelivery, PathBuf) {
    let reference = format!("refs/heads/supertag-deliveries/{id}");
    git(repository, &["update-ref", &reference, head]);
    let bundle = fixture.root.path().join(name);
    git(
        repository,
        &["bundle", "create", bundle.to_str().unwrap(), &reference],
    );
    let bytes = fs::read(&bundle).unwrap();
    (
        SessionDelivery {
            branch: BRANCH.into(),
            delivery_id: id.into(),
            base_commit: fixture.base.clone(),
            start_commit: fixture.base.clone(),
            head_commit: head.into(),
            bundle_sha256: format!("{:x}", Sha256::digest(&bytes)),
            bundle_byte_length: bytes.len() as u64,
        },
        bundle,
    )
}

#[tokio::test]
async fn a_refused_delivery_leaves_no_objects_in_the_repository() {
    let fixture = Fixture::new();
    let unrelated = fixture.root.path().join("unrelated");
    fs::create_dir(&unrelated).unwrap();
    git(&unrelated, &["init", "--quiet"]);
    fs::write(unrelated.join("x.txt"), "unrelated\n").unwrap();
    git(&unrelated, &["add", "-A"]);
    git(&unrelated, &["commit", "--quiet", "-m", "Unrelated"]);
    let head = git(&unrelated, &["rev-parse", "HEAD"]);
    let blob = git(&unrelated, &["rev-parse", "HEAD:x.txt"]);
    let (delivery, bundle) = bundle_of(&fixture, &unrelated, &head, &"d".repeat(64), "u.bundle");

    let before = objects(&fixture);
    let error = run(&fixture, &delivery, &bundle).await.unwrap_err();
    assert!(error.to_string().contains("does not descend"), "{error:#}");
    assert_eq!(objects(&fixture), before);
    assert!(!fixture.has(&head));
    assert!(!fixture.has(&blob));
    assert!(fixture.branch().is_none());
}

#[tokio::test]
async fn a_bundle_with_a_malformed_object_is_refused() {
    let mut fixture = Fixture::new();
    let base = fixture.base.clone();
    let (good, _) = fixture.deliver(&base, "a.txt");
    // The delivered commit, rewritten with an author line Git's strict checks reject.
    let text = git(&fixture.worker, &["cat-file", "commit", &good.head_commit]);
    let broken: String = text
        .lines()
        .map(|line| {
            if line.starts_with("author ") {
                "author no email or date".to_owned()
            } else {
                line.to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    let file = fixture.root.path().join("broken-commit");
    fs::write(&file, broken).unwrap();
    let head = git(
        &fixture.worker,
        &[
            "hash-object",
            "-t",
            "commit",
            "-w",
            "--literally",
            file.to_str().unwrap(),
        ],
    );
    let worker = fixture.worker.clone();
    let (delivery, bundle) = bundle_of(&fixture, &worker, &head, &"c".repeat(64), "m.bundle");

    let before = objects(&fixture);
    let error = run(&fixture, &delivery, &bundle).await.unwrap_err();
    assert!(error.to_string().contains("malformed objects"), "{error:#}");
    assert_eq!(objects(&fixture), before);
    assert!(!fixture.has(&head));
    assert!(fixture.branch().is_none());
}

/// Commit `file` on `start` in the worker repository and bundle only `start..head`, as a Worker
/// Host bundles a delivery.
fn incremental(fixture: &mut Fixture, start: &str, file: &str) -> (SessionDelivery, PathBuf) {
    let (mut delivery, complete) = fixture.deliver(start, file);
    let reference = format!("refs/heads/supertag-deliveries/{}", delivery.delivery_id);
    let path = complete.with_extension("incremental");
    git(
        &fixture.worker,
        &[
            "bundle",
            "create",
            path.to_str().unwrap(),
            &reference,
            &format!("^{start}"),
        ],
    );
    let bytes = fs::read(&path).unwrap();
    delivery.bundle_sha256 = format!("{:x}", Sha256::digest(&bytes));
    delivery.bundle_byte_length = bytes.len() as u64;
    (delivery, path)
}

/// A delivery's own bundle builds on its start commit. A repository that holds it imports the
/// bundle; one that does not refuses it with `MissingPrerequisite` and changes nothing, then
/// imports the holder's complete bundle of the same commit, which has no recorded digest.
#[tokio::test]
async fn an_incremental_delivery_needs_its_start_commit_or_a_complete_bundle() {
    let mut fixture = Fixture::new();
    let base = fixture.base.clone();
    let (first, first_bundle) = incremental(&mut fixture, &base, "one.txt");
    assert_eq!(
        run(&fixture, &first, &first_bundle).await.unwrap(),
        Imported::Created
    );
    // The second delivery builds on a commit the operator's repository holds now.
    let (second, second_bundle) = incremental(&mut fixture, &first.head_commit, "two.txt");
    assert_eq!(
        run(&fixture, &second, &second_bundle).await.unwrap(),
        Imported::Advanced
    );
    // A third, fetched into a fresh repository holding only the base, lacks its start.
    let (third, third_bundle) = incremental(&mut fixture, &second.head_commit, "three.txt");
    let fresh = Fixture::new();
    let error = run(&fresh, &third, &third_bundle).await.unwrap_err();
    let missing = error
        .downcast_ref::<MissingPrerequisite>()
        .unwrap_or_else(|| panic!("{error:#}"));
    assert_eq!(missing.0, second.head_commit);
    assert!(!fresh.has(&third.head_commit));
    // The holder's complete bundle: its digest differs from the receipt, as complete bundles are
    // built on demand, and it imports only as a complete bundle.
    let reference = format!("refs/heads/supertag-deliveries/{}", third.delivery_id);
    let complete = fixture.root.path().join("complete.bundle");
    git(
        &fixture.worker,
        &["bundle", "create", complete.to_str().unwrap(), &reference],
    );
    assert!(run(&fresh, &third, &complete).await.is_err());
    assert_eq!(
        import(
            &fresh.operator,
            &third,
            &complete,
            true,
            &CancellationToken::new(),
        )
        .await
        .unwrap(),
        Imported::Created
    );
    // A bundle whose prerequisite is not the delivery's start is refused even when held.
    let mut wrong = third.clone();
    wrong.start_commit = base.clone();
    assert!(
        format!(
            "{:#}",
            run(&fixture, &wrong, &third_bundle).await.unwrap_err()
        )
        .contains("other than its start commit")
    );
}

/// A merge follow-up's delivery merges a target the operator's repository moved ahead. Its bundle
/// carries the target's new commits beside the merge, so it names two prerequisites: its start
/// commit and the commit of the start's history those commits branch from. It imports like any
/// other delivery. A bundle that names a commit outside the start commit's history, or that does
/// not build on the start commit, is refused and leaves nothing behind.
#[tokio::test]
async fn a_merge_delivery_builds_on_its_start_commit_and_its_history_only() {
    let mut fixture = Fixture::new();
    let base = fixture.base.clone();
    let (first, first_bundle) = incremental(&mut fixture, &base, "one.txt");
    assert_eq!(
        run(&fixture, &first, &first_bundle).await.unwrap(),
        Imported::Created
    );
    // The operator's branch moves ahead, and the Worker Host copies it for the merge.
    fs::write(fixture.operator.join("target.txt"), "target\n").unwrap();
    git(&fixture.operator, &["add", "-A"]);
    git(&fixture.operator, &["commit", "--quiet", "-m", "Target"]);
    let target = git(&fixture.operator, &["rev-parse", "HEAD"]);
    git(&fixture.worker, &["fetch", "--quiet", "origin", "main"]);
    // An unrelated branch the operator's repository also holds.
    let tree = git(
        &fixture.operator,
        &["rev-parse", &format!("{base}^{{tree}}")],
    );
    let unrelated = git(
        &fixture.operator,
        &["commit-tree", &tree, "-p", &base, "-m", "Unrelated"],
    );
    git(
        &fixture.operator,
        &["update-ref", "refs/heads/unrelated", &unrelated],
    );
    git(
        &fixture.worker,
        &["fetch", "--quiet", "origin", "unrelated"],
    );

    let merge = |fixture: &Fixture, parents: &[&str], id: &str, exclusions: &[&str]| {
        let tree = git(
            &fixture.worker,
            &["merge-tree", "--write-tree", parents[0], parents[1]],
        );
        let mut args = vec!["commit-tree", tree.as_str(), "-m", "Merge"];
        for parent in parents {
            args.extend(["-p", parent]);
        }
        let head = git(&fixture.worker, &args);
        let delivery_id = id.repeat(64);
        let reference = format!("refs/heads/supertag-deliveries/{delivery_id}");
        git(&fixture.worker, &["update-ref", &reference, &head]);
        let path = fixture.root.path().join(format!("merge-{id}.bundle"));
        let mut args = vec!["bundle", "create", path.to_str().unwrap(), &reference];
        let excluded: Vec<String> = exclusions.iter().map(|oid| format!("^{oid}")).collect();
        args.extend(excluded.iter().map(String::as_str));
        git(&fixture.worker, &args);
        let bytes = fs::read(&path).unwrap();
        (
            SessionDelivery {
                branch: BRANCH.into(),
                delivery_id,
                base_commit: fixture.base.clone(),
                start_commit: first.head_commit.clone(),
                head_commit: head,
                bundle_sha256: format!("{:x}", Sha256::digest(&bytes)),
                bundle_byte_length: bytes.len() as u64,
            },
            path,
        )
    };
    let prerequisites = |bundle: &Path| -> Vec<String> {
        let bytes = fs::read(bundle).unwrap();
        let header = bytes.split(|byte| *byte == b'\n');
        let mut found: Vec<String> = header
            .take_while(|line| !line.is_empty())
            .filter_map(|line| line.strip_prefix(b"-"))
            .map(|line| String::from_utf8_lossy(&line[..40]).into_owned())
            .collect();
        found.sort();
        found
    };
    let sorted = |commits: &[&str]| {
        let mut commits: Vec<String> = commits.iter().map(|commit| (*commit).to_owned()).collect();
        commits.sort();
        commits
    };

    // A merge of an unrelated branch, bundled against it: the bundle builds on a commit the
    // repository holds, but not in the start commit's history.
    let (outside, outside_bundle) = merge(
        &fixture,
        &[&first.head_commit, &unrelated],
        "d",
        &[&first.head_commit, &unrelated],
    );
    assert_eq!(
        prerequisites(&outside_bundle),
        sorted(&[&first.head_commit, &unrelated])
    );
    let before = objects(&fixture);
    let error = run(&fixture, &outside, &outside_bundle).await.unwrap_err();
    let missing = error
        .downcast_ref::<MissingPrerequisite>()
        .unwrap_or_else(|| panic!("{error:#}"));
    assert_eq!(missing.0, unrelated);
    assert_eq!(objects(&fixture), before);
    assert!(!fixture.has(&outside.head_commit));
    assert_eq!(fixture.branch(), Some(first.head_commit.clone()));

    // The same merge bundled against the unrelated branch alone does not build on its start.
    let (unbased, unbased_bundle) = merge(
        &fixture,
        &[&first.head_commit, &unrelated],
        "e",
        &[&unrelated],
    );
    assert_eq!(prerequisites(&unbased_bundle), sorted(&[&base, &unrelated]));
    let before = objects(&fixture);
    let error = run(&fixture, &unbased, &unbased_bundle).await.unwrap_err();
    assert!(
        format!("{error:#}").contains("other than its start commit"),
        "{error:#}"
    );
    assert_eq!(objects(&fixture), before);
    assert_eq!(fixture.branch(), Some(first.head_commit.clone()));

    // The merge follow-up's own bundle, as a Worker Host writes it: everything but the start.
    let (merged, merged_bundle) = merge(
        &fixture,
        &[&first.head_commit, &target],
        "f",
        &[&first.head_commit],
    );
    assert_eq!(
        prerequisites(&merged_bundle),
        sorted(&[&first.head_commit, &base])
    );
    assert_eq!(
        run(&fixture, &merged, &merged_bundle).await.unwrap(),
        Imported::Advanced
    );
    assert_eq!(fixture.branch(), Some(merged.head_commit.clone()));
    assert_eq!(
        git(
            &fixture.operator,
            &["rev-list", "--parents", "-n", "1", BRANCH]
        ),
        format!("{} {} {target}", merged.head_commit, first.head_commit)
    );
    git(&fixture.operator, &["fsck", "--strict", "--no-dangling"]);
}
