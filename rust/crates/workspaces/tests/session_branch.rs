//! Importing verified deliveries into an operator's repository as the Session branch.
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
};

use sha2::{Digest, Sha256};
use supertag_workspaces::session_branch::{
    BranchCheckedOut, BranchMoved, Imported, SessionDelivery, import,
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
async fn repository_hooks_do_not_run_during_an_import() {
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
    let base = fixture.base.clone();
    let (delivery, bundle) = fixture.deliver(&base, "a.txt");
    assert_eq!(
        run(&fixture, &delivery, &bundle).await.unwrap(),
        Imported::Created
    );
    assert!(!marker.exists(), "a repository hook ran during the import");
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
