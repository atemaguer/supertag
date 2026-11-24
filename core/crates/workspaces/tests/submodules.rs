//! A local Workspace whose repository has submodules. Each submodule is an empty directory in a
//! Task's checkout, nothing of it is fetched, and every delivery pins it where the repository
//! does, whatever the Task left at its path.
use std::{
    fs,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    process::Command,
};

use supertag_workspaces::{
    Checkout, Delivery, FinalizeRequest, Outcome, PrepareRequest, Workspace, WorkspaceConfig,
    complete_delivery_bundle, failure_cause,
    session_branch::{Imported, SessionDelivery, import},
};
use tokio_util::sync::CancellationToken;

const BRANCH: &str = "supertag/session/0123456789abcdef";
/// A commit no repository here holds: a submodule's pin is only ever a name.
const UNKNOWN: &str = "1234567890123456789012345678901234567890";
const MANY: usize = 300;

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

/// Records a submodule at `path` pinned to `commit`, as the index holds one.
fn pin(source: &Path, path: &str, commit: &str) {
    git(
        source,
        &[
            "update-index",
            "--add",
            "--cacheinfo",
            &format!("160000,{commit},{path}"),
        ],
    );
}

/// The submodules a commit pins, as Git lists them: `160000 commit <ID>\t<path>` lines.
fn pins(repository: &Path, commit: &str) -> String {
    git(repository, &["ls-tree", "-r", commit])
        .lines()
        .filter(|line| line.starts_with("160000 "))
        .collect::<Vec<_>>()
        .join("\n")
}

struct Fixture {
    _directory: tempfile::TempDir,
    root: PathBuf,
    source: PathBuf,
    base: String,
    /// Every submodule path of the base commit.
    paths: Vec<String>,
}

/// A repository with a submodule added the usual way, one deep in directories, one whose path
/// has spaces, one pinned to a commit nothing holds, and hundreds more.
fn fixture() -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    let library = root.join("library");
    fs::create_dir(&library).unwrap();
    git(&library, &["init", "--quiet"]);
    fs::write(library.join("lib.txt"), "library\n").unwrap();
    git(&library, &["add", "-A"]);
    git(&library, &["commit", "--quiet", "-m", "Library"]);
    let pinned = git(&library, &["rev-parse", "HEAD"]);

    let source = root.join("source");
    fs::create_dir_all(source.join("deep")).unwrap();
    git(&source, &["init", "--quiet"]);
    fs::write(source.join("README.md"), "hello\n").unwrap();
    fs::write(source.join("deep/keep.txt"), "kept\n").unwrap();
    fs::write(source.join(".gitignore"), "deps/\n").unwrap();
    git(&source, &["add", "-A"]);
    git(&source, &["commit", "--quiet", "-m", "Files"]);
    git(
        &source,
        &[
            "submodule",
            "--quiet",
            "add",
            library.to_str().unwrap(),
            "vendor/sub",
        ],
    );
    let mut paths = vec![
        "vendor/sub".to_owned(),
        "deep/er/path/lib".to_owned(),
        "third party/my lib".to_owned(),
        "unknown".to_owned(),
    ];
    pin(&source, "deep/er/path/lib", &pinned);
    pin(&source, "third party/my lib", &pinned);
    pin(&source, "unknown", UNKNOWN);
    for number in 0..MANY {
        let path = format!("many/mod-{number}");
        pin(&source, &path, &pinned);
        paths.push(path);
    }
    git(&source, &["commit", "--quiet", "-m", "Submodules"]);
    let base = git(&source, &["rev-parse", "HEAD"]);
    Fixture {
        _directory: directory,
        root,
        source,
        base,
        paths,
    }
}

fn open(state: &Path, source: &Path, base: &str) -> Workspace {
    Workspace::open(WorkspaceConfig {
        state_dir: state.to_owned(),
        source: source.to_owned(),
        base_commit: base.to_owned(),
    })
    .unwrap()
}

fn request(task: &str, head: Option<&str>) -> PrepareRequest {
    PrepareRequest {
        task_id: task.into(),
        attempt_id: "attempt".into(),
        session_id: "session".into(),
        expected_head: head.map(str::to_owned),
        setup: None,
        merge_commit: None,
        author: None,
    }
}

fn complete() -> FinalizeRequest {
    FinalizeRequest {
        summary: "Change".into(),
        outcome: Outcome::Completed,
        output_directory: None,
        file_scope: None,
    }
}

async fn finish(workspace: &Workspace, checkout: &Checkout) -> Delivery {
    workspace
        .finalize(checkout, complete(), &CancellationToken::new())
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

async fn land(source: &Path, delivery: &Delivery) -> Imported {
    import(
        source,
        &session(delivery),
        &delivery.bundle_path,
        false,
        &CancellationToken::new(),
    )
    .await
    .unwrap()
}

/// Every submodule path is an empty directory, not reached through a link.
fn assert_empty_directories(checkout: &Path, paths: &[String]) {
    for path in paths {
        let directory = checkout.join(path);
        assert!(
            fs::symlink_metadata(&directory).unwrap().is_dir(),
            "{path} is not a directory"
        );
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 0, "{path}");
    }
}

#[tokio::test]
async fn submodules_are_empty_directories_and_every_delivery_keeps_their_pins() {
    let fixture = fixture();
    let (source, base) = (&fixture.source, &fixture.base);
    let cancel = CancellationToken::new();
    let state = fixture.root.join("state");
    let private = state.join("repository.git");
    let workspace = open(&state, source, base);
    let checkout = workspace
        .prepare(request("first", None), &cancel)
        .await
        .unwrap();
    let path = &checkout.path;
    assert_eq!(fixture.paths.len(), MANY + 4);
    assert_empty_directories(path, &fixture.paths);
    assert_eq!(
        fs::read(path.join(".gitmodules")).unwrap(),
        fs::read(source.join(".gitmodules")).unwrap()
    );
    // Nothing of a submodule was cloned or fetched, here or in SuperTag's repository.
    assert!(!path.join(".git/modules").exists());
    assert!(!private.join("modules").exists());
    assert!(!run(&private, &["cat-file", "-e", UNKNOWN]).0);

    // The Tag's own Git finds a clean checkout that pins what the repository pins, and reports
    // only what the Tag changes.
    assert_eq!(git(path, &["status", "--porcelain"]), "");
    assert_eq!(pins(path, "HEAD"), pins(source, base));
    assert_eq!(git(path, &["diff", "--name-only", "HEAD"]), "");
    fs::write(path.join("README.md"), "changed\n").unwrap();
    assert_eq!(git(path, &["status", "--porcelain"]), "M README.md");
    let (changed, truncated) =
        supertag_workspaces::changed_paths(&checkout, |_| true, 100, &cancel)
            .await
            .unwrap();
    assert_eq!((changed, truncated), (vec!["README.md".to_owned()], false));

    // The Task fills one submodule as `git submodule update` would, leaves a file in another,
    // removes a third's directory, and puts a file and a link that leaves the checkout where
    // two more were.
    fs::write(
        path.join("vendor/sub/.git"),
        "gitdir: ../../.git/modules/vendor/sub\n",
    )
    .unwrap();
    fs::write(path.join("vendor/sub/lib.txt"), "library\n").unwrap();
    fs::create_dir(path.join("deep/er/path/lib/nested")).unwrap();
    fs::write(path.join("deep/er/path/lib/nested/new.txt"), "new\n").unwrap();
    fs::remove_dir(path.join("third party/my lib")).unwrap();
    fs::remove_dir(path.join("many/mod-7")).unwrap();
    fs::write(path.join("many/mod-7"), "a file\n").unwrap();
    fs::remove_dir(path.join("many/mod-8")).unwrap();
    std::os::unix::fs::symlink("/etc/hosts", path.join("many/mod-8")).unwrap();
    // The changed paths SuperTag reports while the Task runs are the repository's own.
    let (changed, _) = supertag_workspaces::changed_paths(&checkout, |_| true, 100, &cancel)
        .await
        .unwrap();
    assert_eq!(changed, ["README.md"]);
    let first = finish(&workspace, &checkout).await;
    assert!(first.committed);
    assert_eq!(first.changed_files, 1);
    assert_eq!(
        first.ignored_submodules,
        ["deep/er/path/lib", "many/mod-7", "many/mod-8", "vendor/sub"]
    );
    assert_eq!(
        first.submodule_note().unwrap(),
        "SuperTag did not deliver what this Task left inside Git submodules (`deep/er/path/lib`, `many/mod-7`, `many/mod-8`, `vendor/sub`). A delivery holds the repository's own files and keeps each submodule at the commit the repository pins."
    );
    // The delivered commit changes the one file and pins every submodule as before.
    assert_eq!(pins(&private, &first.head_commit), pins(source, base));
    assert_eq!(
        git(
            &private,
            &["diff", "--name-status", base, &first.head_commit]
        ),
        "M\tREADME.md"
    );
    let status = git(source, &["status", "--porcelain"]);
    assert_eq!(land(source, &first).await, Imported::Created);
    assert_eq!(
        git(source, &["diff", "--name-status", "HEAD", BRANCH]),
        "M\tREADME.md"
    );
    // The user's own working tree, index, and submodules are as they were.
    assert_eq!(git(source, &["status", "--porcelain"]), status);
    assert_eq!(
        git(&source.join("vendor/sub"), &["rev-parse", "HEAD"]),
        git(source, &["rev-parse", "HEAD:vendor/sub"])
    );
    workspace.park_checkout(&checkout).unwrap();

    // The Session's next Task starts with every submodule an empty directory again.
    let checkout = workspace
        .prepare(request("second", Some(&first.head_commit)), &cancel)
        .await
        .unwrap();
    let path = &checkout.path;
    assert_empty_directories(path, &fixture.paths);
    assert_eq!(fs::read(path.join("README.md")).unwrap(), b"changed\n");
    assert_eq!(git(path, &["status", "--porcelain"]), "");
    // A Task that changes no file of the repository delivers its start commit, whatever it
    // left in a submodule.
    fs::write(path.join("unknown/left.txt"), "left\n").unwrap();
    fs::remove_dir(path.join("many/mod-9")).unwrap();
    let second = finish(&workspace, &checkout).await;
    assert!(!second.committed);
    assert_eq!(second.head_commit, first.head_commit);
    assert_eq!(second.ignored_submodules, ["unknown"]);
    let kept = fs::metadata(path.join("deep/keep.txt")).unwrap().ino();
    workspace.park_checkout(&checkout).unwrap();

    // A kept checkout is reused, with what the last Task left in a submodule removed and the
    // directory it removed back.
    let checkout = workspace
        .prepare(request("third", Some(&first.head_commit)), &cancel)
        .await
        .unwrap();
    let path = &checkout.path;
    assert_eq!(
        fs::metadata(path.join("deep/keep.txt")).unwrap().ino(),
        kept,
        "the checkout was written again"
    );
    assert_empty_directories(path, &fixture.paths);
    assert_eq!(git(path, &["status", "--porcelain"]), "");
    fs::write(path.join("deep/keep.txt"), "third\n").unwrap();
    let third = finish(&workspace, &checkout).await;
    assert!(third.ignored_submodules.is_empty() && third.submodule_note().is_none());
    assert_eq!(pins(&private, &third.head_commit), pins(source, base));
    assert_eq!(land(source, &third).await, Imported::Advanced);
}

#[tokio::test]
async fn a_file_where_a_submodules_parent_directory_was_refuses_the_delivery() {
    let fixture = fixture();
    let cancel = CancellationToken::new();
    let state = fixture.root.join("state");
    let workspace = open(&state, &fixture.source, &fixture.base);
    let checkout = workspace
        .prepare(request("first", None), &cancel)
        .await
        .unwrap();
    let path = &checkout.path;
    fs::remove_dir_all(path.join("deep/er")).unwrap();
    std::os::unix::fs::symlink("keep.txt", path.join("deep/er")).unwrap();
    let error = workspace
        .finalize(&checkout, complete(), &cancel)
        .await
        .unwrap_err();
    assert_eq!(
        failure_cause(&error),
        "the Task replaced `deep/er`, the directory that holds the Git submodule `deep/er/path/lib`, with a file, and a delivery cannot remove a submodule. Have the Tag restore the directory"
    );
    fs::remove_file(path.join("deep/er")).unwrap();
    fs::remove_dir_all(path.join("deep")).unwrap();
    fs::write(path.join("deep"), "now a file\n").unwrap();
    let error = workspace
        .finalize(&checkout, complete(), &cancel)
        .await
        .unwrap_err();
    assert!(
        failure_cause(&error).starts_with("the Task replaced `deep`, the directory that holds"),
        "{error:#}"
    );
    // Removing the directories a submodule is under removes nothing from the delivery but the
    // files that were tracked there.
    fs::remove_file(path.join("deep")).unwrap();
    fs::remove_dir_all(path.join("many")).unwrap();
    let delivery = finish(&workspace, &checkout).await;
    let private = state.join("repository.git");
    assert_eq!(
        git(
            &private,
            &[
                "diff",
                "--name-status",
                &fixture.base,
                &delivery.head_commit
            ]
        ),
        "D\tdeep/keep.txt"
    );
    assert_eq!(
        pins(&private, &delivery.head_commit),
        pins(&fixture.source, &fixture.base)
    );
    assert!(delivery.ignored_submodules.is_empty());
}

#[tokio::test]
async fn a_merge_follow_up_takes_the_targets_pins_and_refuses_a_submodule_conflict() {
    let fixture = fixture();
    let (source, base) = (&fixture.source, &fixture.base);
    let cancel = CancellationToken::new();
    let state = fixture.root.join("state");
    let private = state.join("repository.git");
    let workspace = open(&state, source, base);
    let checkout = workspace
        .prepare(request("first", None), &cancel)
        .await
        .unwrap();
    fs::write(checkout.path.join("README.md"), "session\n").unwrap();
    let first = finish(&workspace, &checkout).await;

    // The target moves a submodule to another commit and adds one.
    let moved = "a".repeat(40);
    pin(source, "unknown", &moved);
    pin(source, "added", UNKNOWN);
    fs::write(source.join("deep/keep.txt"), "target\n").unwrap();
    git(source, &["add", "deep/keep.txt"]);
    git(source, &["commit", "--quiet", "-m", "Target"]);
    let target = git(source, &["rev-parse", "HEAD"]);
    workspace
        .import_source_commit(&target, &cancel)
        .await
        .unwrap();
    let checkout = workspace
        .prepare(
            PrepareRequest {
                merge_commit: Some(target.clone()),
                ..request("merge", Some(&first.head_commit))
            },
            &cancel,
        )
        .await
        .unwrap();
    let path = &checkout.path;
    assert_eq!(fs::read(path.join("README.md")).unwrap(), b"session\n");
    assert_eq!(fs::read(path.join("deep/keep.txt")).unwrap(), b"target\n");
    let mut paths = fixture.paths.clone();
    paths.push("added".into());
    assert_empty_directories(path, &paths);
    let merged = finish(&workspace, &checkout).await;
    assert_eq!(pins(&private, &merged.head_commit), pins(source, &target));
    assert_eq!(
        git(
            &private,
            &["diff", "--name-status", &target, &merged.head_commit]
        ),
        "M\tREADME.md"
    );
    // The merge and its history import into the user's repository as a complete bundle.
    let bytes = complete_delivery_bundle(&state, &merged.head_commit, &merged.delivery_id, &cancel)
        .await
        .unwrap();
    let bundle = fixture.root.join("merged.bundle");
    fs::write(&bundle, bytes).unwrap();
    assert_eq!(
        import(source, &session(&merged), &bundle, true, &cancel)
            .await
            .unwrap(),
        Imported::Created
    );

    // A target that moved a submodule one way from a commit the Session's base moved another.
    git(source, &["checkout", "--quiet", "-b", "side", "HEAD~1"]);
    let before = git(source, &["rev-parse", "HEAD~1"]);
    git(source, &["checkout", "--quiet", "-b", "apart", &before]);
    pin(source, "vendor/sub", &"b".repeat(40));
    git(source, &["commit", "--quiet", "-m", "Apart"]);
    let apart = git(source, &["rev-parse", "HEAD"]);
    workspace
        .import_source_commit(&apart, &cancel)
        .await
        .unwrap();
    let error = workspace
        .prepare(
            PrepareRequest {
                session_id: "apart".into(),
                merge_commit: Some(apart),
                ..request("conflict", None)
            },
            &cancel,
        )
        .await
        .unwrap_err();
    assert_eq!(
        failure_cause(&error),
        "merging the target into the Session conflicts in the Git submodule at `vendor/sub`, and a Task cannot change which commit a submodule pins. Merge the Session's branch by hand"
    );
}

#[tokio::test]
async fn setup_cannot_fill_a_submodule_and_a_remote_sandbox_refuses_one() {
    let fixture = fixture();
    let cancel = CancellationToken::new();
    let workspace = open(&fixture.root.join("state"), &fixture.source, &fixture.base);
    // What setup writes in a submodule's directory is not one of its outputs; what it writes
    // where Git ignores it still is.
    let checkout = workspace
        .prepare(
            PrepareRequest {
                setup: Some("echo fetched > vendor/sub/lib.txt && mkdir deps && echo installed > deps/marker".into()),
                ..request("first", None)
            },
            &cancel,
        )
        .await
        .unwrap();
    assert_empty_directories(&checkout.path, &fixture.paths);
    assert_eq!(
        fs::read(checkout.path.join("deps/marker")).unwrap(),
        b"installed\n"
    );
    let delivery = finish(&workspace, &checkout).await;
    assert!(!delivery.committed && delivery.ignored_submodules.is_empty());

    // A remote sandbox takes a bundle and returns files, with no place for a submodule, so it
    // says so before anything leaves the host.
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
            "the repository has a Git submodule at `deep/er/path/lib`, and a Task that runs in a remote sandbox does not support repositories with submodules. Run the Tag on the Worker Host itself"
        );
    }
}

/// Git's strict checks of `.gitmodules`, which guard whoever later runs `git submodule update`
/// on a delivered branch, are the same as for any repository.
#[tokio::test]
async fn an_unsafe_gitmodules_file_is_still_refused() {
    let fixture = fixture();
    let source = &fixture.source;
    fs::write(
        source.join(".gitmodules"),
        "[submodule \"vendor/sub\"]\n\tpath = vendor/sub\n\turl = -u./payload\n",
    )
    .unwrap();
    git(source, &["add", ".gitmodules"]);
    git(source, &["commit", "--quiet", "-m", "Unsafe"]);
    let head = git(source, &["rev-parse", "HEAD"]);
    let error = open(&fixture.root.join("state"), source, &head)
        .prepare(request("first", None), &CancellationToken::new())
        .await
        .unwrap_err();
    let cause = failure_cause(&error);
    assert!(
        cause.starts_with(
            "the repository's history holds objects that fail Git's strict checks (gitmodulesUrl)"
        ),
        "{cause}"
    );
}
