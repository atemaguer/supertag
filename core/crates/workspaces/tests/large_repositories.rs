//! Repositories the size of a real monorepo: a history and a tree larger than any buffer a Git
//! read keeps, more tracked files and longer paths than any fixed count allows for, and a remote
//! that advertises tens of thousands of refs.
use std::{
    fs,
    io::Write as _,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
use supertag_workspaces::{
    FinalizeRequest, Outcome, PrepareRequest, Workspace, WorkspaceConfig, advertised_output_remote,
    changed_paths, git_output_files,
};
use tokio_util::sync::CancellationToken;

fn git(path: &Path, args: &[&str]) -> String {
    git_with(path, args, &[])
}

fn git_with(path: &Path, args: &[&str], input: &[u8]) -> String {
    let mut child = Command::new("/usr/bin/git")
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
            // Random fixture bytes do not compress; storing them is faster.
            "-c",
            "core.compression=0",
            "-c",
            "pack.compression=0",
        ])
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let input = input.to_vec();
    let writer = std::thread::spawn(move || stdin.write_all(&input));
    let output = child.wait_with_output().unwrap();
    writer.join().unwrap().unwrap();
    assert!(
        output.status.success(),
        "git {:?}: {}",
        args,
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().into()
}

/// Incompressible bytes, so Git's packs are as large as the files.
fn noise(seed: u64, length: usize) -> Vec<u8> {
    let mut state = seed.wrapping_mul(2).wrapping_add(1);
    let mut bytes = Vec::with_capacity(length + 8);
    while bytes.len() < length {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        bytes.extend_from_slice(&state.to_le_bytes());
    }
    bytes.truncate(length);
    bytes
}

const MIB: usize = 1024 * 1024;

/// A bare source repository whose base commit's tree, and so its history, holds `files` files of
/// `size` incompressible bytes each, with an older commit beneath it.
fn large_source(root: &Path, files: usize, size: usize) -> (PathBuf, String) {
    let source = root.join("source.git");
    fs::create_dir(&source).unwrap();
    git(&source, &["init", "--quiet", "--bare"]);
    let readme = git_with(&source, &["hash-object", "-w", "--stdin"], b"monorepo\n");
    let mut tree = format!("100644 blob {readme}\tREADME.md\n");
    let first_tree = git_with(&source, &["mktree"], tree.as_bytes());
    let first = git(
        &source,
        &["commit-tree", &first_tree, "-m", "Initial commit"],
    );
    for index in 0..files {
        let blob = git_with(
            &source,
            &["hash-object", "-w", "--stdin"],
            &noise(index as u64 + 7, size),
        );
        tree.push_str(&format!("100644 blob {blob}\tassets/large-{index}.bin\n"));
    }
    // `mktree` needs entries sorted and one level deep, so the assets get their own tree.
    let assets: String = tree
        .lines()
        .filter_map(|line| line.split_once("\tassets/"))
        .map(|(header, name)| format!("{header}\t{name}\n"))
        .collect();
    let assets = git_with(&source, &["mktree"], assets.as_bytes());
    let base_tree = git_with(
        &source,
        &["mktree"],
        format!("100644 blob {readme}\tREADME.md\n040000 tree {assets}\tassets\n").as_bytes(),
    );
    let base = git(
        &source,
        &["commit-tree", &base_tree, "-p", &first, "-m", "Add assets"],
    );
    git(&source, &["update-ref", "refs/heads/main", &base]);
    // Packed, as a real repository's objects are.
    git(&source, &["repack", "-a", "-d", "--quiet"]);
    (source, base)
}

fn request(task: &str, attempt: &str, head: Option<String>) -> PrepareRequest {
    PrepareRequest {
        task_id: task.into(),
        attempt_id: attempt.into(),
        session_id: "session".into(),
        expected_head: head,
        setup: None,
        merge_commit: None,
        author: None,
    }
}

/// A first Task fails on a repository this size when any step buffers the base's history or tree:
/// the import from the source, and the checkout's own objects, are each larger than 256 MiB.
#[tokio::test]
async fn a_workspace_larger_than_any_git_buffer_prepares_and_delivers() {
    let root = tempfile::tempdir().unwrap();
    let (source, base) = large_source(root.path(), 7, 40 * MIB);
    let workspace = Workspace::open(WorkspaceConfig {
        state_dir: root.path().join("state"),
        source: source.clone(),
        base_commit: base.clone(),
    })
    .unwrap();
    let cancel = CancellationToken::new();
    let checkout = workspace
        .prepare(request("task-1", "attempt-1", None), &cancel)
        .await
        .unwrap();
    assert_eq!(
        fs::read(checkout.path.join("assets/large-3.bin")).unwrap(),
        noise(3 + 7, 40 * MIB)
    );
    assert_eq!(git(&checkout.path, &["status", "--porcelain"]), "");
    fs::write(checkout.path.join("README.md"), "monorepo, changed\n").unwrap();
    let delivery = workspace
        .finalize(
            &checkout,
            FinalizeRequest {
                output_directory: None,
                file_scope: None,
                summary: "Change the README".into(),
                outcome: Outcome::Completed,
            },
            &cancel,
        )
        .await
        .unwrap();
    assert!(delivery.committed);
    // The next Task of the Session continues from the delivery, on this lane and on another lane
    // of the same host, whose repository imports the delivery from this one.
    let next = workspace
        .prepare(
            request("task-2", "attempt-2", Some(delivery.head_commit.clone())),
            &cancel,
        )
        .await
        .unwrap();
    assert_eq!(
        fs::read_to_string(next.path.join("README.md")).unwrap(),
        "monorepo, changed\n"
    );
    let other = Workspace::open(WorkspaceConfig {
        state_dir: root.path().join("other-lane"),
        source,
        base_commit: base,
    })
    .unwrap();
    other
        .import_held_commit(&root.path().join("state"), &delivery.head_commit, &cancel)
        .await
        .unwrap();
    let continued = other
        .prepare(
            request("task-3", "attempt-3", Some(delivery.head_commit.clone())),
            &cancel,
        )
        .await
        .unwrap();
    assert_eq!(
        git(&continued.path, &["rev-parse", "HEAD"]),
        delivery.head_commit
    );
    assert_eq!(
        fs::read_to_string(continued.path.join("README.md")).unwrap(),
        "monorepo, changed\n"
    );
}

/// A GitHub monorepo advertises every branch, tag, and pull request ref: tens of thousands of
/// lines, megabytes in all. Its pushed commit is still found, wherever it sorts, and a source
/// whose configuration has thousands of branch sections still names its remote.
#[tokio::test]
async fn a_remote_advertising_tens_of_thousands_of_refs_still_verifies_an_output_commit() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    let source = root.join("source");
    fs::create_dir(&source).unwrap();
    git(&source, &["init", "--quiet", "--initial-branch=main"]);
    fs::write(source.join("README.md"), "one\n").unwrap();
    git(&source, &["add", "-A"]);
    git(&source, &["commit", "--quiet", "-m", "One"]);
    let old = git(&source, &["rev-parse", "HEAD"]);
    fs::write(source.join("README.md"), "two\n").unwrap();
    git(&source, &["commit", "--quiet", "-am", "Two"]);
    let pushed = git(&source, &["rev-parse", "HEAD"]);
    fs::write(source.join("README.md"), "three\n").unwrap();
    git(&source, &["commit", "--quiet", "-am", "Three"]);
    let unpushed = git(&source, &["rev-parse", "HEAD"]);

    let remote = root.join("remote.git");
    fs::create_dir(&remote).unwrap();
    git(&remote, &["init", "--quiet", "--bare"]);
    git(
        &source,
        &[
            "push",
            "--quiet",
            remote.to_str().unwrap(),
            &format!("{pushed}:refs/heads/main"),
        ],
    );
    fs::remove_file(remote.join("refs/heads/main")).unwrap();
    // Old refs everywhere, as `refs/pull/*` and stale branches are, and the pushed commit only on
    // a tag that sorts after all of them.
    let mut refs = format!("{old} refs/heads/main\n");
    for number in 0..20_000 {
        refs.push_str(&format!(
            "{old} refs/heads/feature/long-lived-branch-name-{number:05}\n"
        ));
    }
    for number in 0..20_000 {
        refs.push_str(&format!("{old} refs/pull/{number:05}/head\n"));
    }
    // One ref with a name longer than any line worth keeping: only its commit is read.
    refs.push_str(&format!(
        "{old} refs/heads/generated/{}/end\n",
        vec!["a-long-path-component"; 400].join("/")
    ));
    refs.push_str(&format!("{pushed} refs/tags/zz-release\n"));
    fs::write(remote.join("packed-refs"), refs).unwrap();
    let listing = git(&source, &["ls-remote", remote.to_str().unwrap()]);
    assert!(listing.len() > 2 * MIB, "{} bytes", listing.len());

    git(
        &source,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    );
    let mut config = fs::read_to_string(source.join(".git/config")).unwrap();
    for number in 0..3_000 {
        config.push_str(&format!(
            "[branch \"feature/long-lived-branch-name-{number:05}\"]\n\tremote = origin\n\tmerge = refs/heads/feature/long-lived-branch-name-{number:05}\n"
        ));
    }
    assert!(config.len() > 256 * 1024);
    fs::write(source.join(".git/config"), config).unwrap();

    let disposable = root.join("host");
    fs::create_dir(&disposable).unwrap();
    let cancel = CancellationToken::new();
    let expected = url::Url::from_file_path(remote.canonicalize().unwrap())
        .unwrap()
        .to_string();
    assert_eq!(
        advertised_output_remote(&source, &disposable, &pushed, &cancel)
            .await
            .unwrap(),
        Some(expected)
    );
    assert_eq!(
        advertised_output_remote(&source, &disposable, &unpushed, &cancel)
            .await
            .unwrap(),
        None
    );
}

/// A bare source whose one commit tracks `directories * 1000` files, each under a path of about
/// 300 bytes. Every directory holds the same thousand files, so the fixture is a few trees.
fn wide_source(root: &Path, directories: usize) -> (PathBuf, String) {
    let source = root.join("wide.git");
    fs::create_dir(&source).unwrap();
    git(&source, &["init", "--quiet", "--bare"]);
    let blob = git_with(&source, &["hash-object", "-w", "--stdin"], b"export {};\n");
    let long = "a-descriptive-directory-name-as-generated-code-has-them".repeat(2);
    let files: String = (0..1000)
        .map(|number| format!("100644 blob {blob}\tgenerated-module-{number:04}.{long}.ts\n"))
        .collect();
    let mut tree = git_with(&source, &["mktree"], files.as_bytes());
    for name in ["implementation", "source"] {
        tree = git_with(
            &source,
            &["mktree"],
            format!("040000 tree {tree}\t{name}-{long}\n").as_bytes(),
        );
    }
    let packages: String = (0..directories)
        .map(|number| format!("040000 tree {tree}\tpackage-{number:04}\n"))
        .collect();
    let packages = git_with(&source, &["mktree"], packages.as_bytes());
    let ignore = git_with(&source, &["hash-object", "-w", "--stdin"], b"dist/\n");
    let top = git_with(
        &source,
        &["mktree"],
        format!("100644 blob {ignore}\t.gitignore\n040000 tree {packages}\tpackages\n").as_bytes(),
    );
    let base = git(&source, &["commit-tree", &top, "-m", "A wide tree"]);
    git(&source, &["update-ref", "refs/heads/main", &base]);
    (source, base)
}

/// A monorepo tracks more files than any fixed count: 120,000 here, under long paths, so the
/// checkout's index alone is larger than 32 MiB. A Task prepares, reports and delivers its
/// change, and its Session's next Task reuses the checkout after the first left 30,000 files of
/// build output and dependencies in it.
#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_LARGE_REPOSITORIES=1: writes 120,000 files and hashes them several times, minutes in a debug build"]
async fn a_workspace_tracking_more_files_than_any_fixed_count_prepares_and_delivers() {
    // Runs of every ignored test, as CI's are, leave this one out unless it is asked for.
    if std::env::var_os("SUPERTAG_RUST_TEST_LARGE_REPOSITORIES").is_none() {
        eprintln!("skipped: SUPERTAG_RUST_TEST_LARGE_REPOSITORIES is not set");
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let (source, base) = wide_source(root.path(), 120);
    let workspace = Workspace::open(WorkspaceConfig {
        state_dir: root.path().join("state"),
        source,
        base_commit: base,
    })
    .unwrap();
    let cancel = CancellationToken::new();
    let started = std::time::Instant::now();
    let checkout = workspace
        .prepare(request("task-1", "attempt-1", None), &cancel)
        .await
        .unwrap();
    eprintln!("prepared 120,001 files in {:?}", started.elapsed());
    let index = fs::metadata(checkout.path.join(".git/index"))
        .unwrap()
        .len();
    assert!(index > 32 * MIB as u64, "index of {index} bytes");
    let long = "a-descriptive-directory-name-as-generated-code-has-them".repeat(2);
    let changed = format!(
        "packages/package-0119/source-{long}/implementation-{long}/generated-module-0999.{long}.ts"
    );
    fs::write(
        checkout.path.join(&changed),
        "export const changed = true;\n",
    )
    .unwrap();
    // What a turn leaves behind: ignored build output, and dependencies nothing ignores by name
    // but SuperTag's own delivery excludes.
    for (directory, count) in [
        ("dist", 10_000),
        ("packages/package-0000/node_modules", 20_000),
    ] {
        for number in 0..count {
            let file = checkout
                .path
                .join(format!("{directory}/chunk-{:03}/{number}.js", number / 500));
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(file, "built\n").unwrap();
        }
    }
    let started = std::time::Instant::now();
    let (paths, truncated) = changed_paths(
        &checkout,
        |path| !path.contains("node_modules/"),
        10,
        &cancel,
    )
    .await
    .unwrap();
    eprintln!("changed paths in {:?}", started.elapsed());
    assert_eq!((paths, truncated), (vec![changed.clone()], false));
    let outputs = git_output_files(
        &checkout,
        std::slice::from_ref(&changed),
        |_| false,
        10,
        &cancel,
    )
    .await
    .unwrap();
    assert_eq!(outputs.tracked, std::slice::from_ref(&changed));
    let started = std::time::Instant::now();
    let delivery = workspace
        .finalize(
            &checkout,
            FinalizeRequest {
                output_directory: None,
                file_scope: None,
                summary: "Change one generated module".into(),
                outcome: Outcome::Completed,
            },
            &cancel,
        )
        .await
        .unwrap();
    eprintln!("delivered in {:?}", started.elapsed());
    assert!(delivery.committed);
    assert_eq!(delivery.changed_files, 1);
    // The next Task takes over the checkout: what the first left behind is gone.
    workspace.park_checkout(&checkout).unwrap();
    let started = std::time::Instant::now();
    let next = workspace
        .prepare(
            request("task-2", "attempt-2", Some(delivery.head_commit.clone())),
            &cancel,
        )
        .await
        .unwrap();
    eprintln!("prepared again in {:?}", started.elapsed());
    assert_eq!(
        fs::read_to_string(next.path.join(&changed)).unwrap(),
        "export const changed = true;\n"
    );
    assert!(!next.path.join("dist").exists());
    assert!(
        !next
            .path
            .join("packages/package-0000/node_modules")
            .exists()
    );
    assert_eq!(git(&next.path, &["status", "--porcelain"]), "");
}
