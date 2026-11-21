//! Repositories the size of a real monorepo: a history and a tree larger than any buffer a Git
//! read keeps, and a remote that advertises tens of thousands of refs.
use std::{
    fs,
    io::Write as _,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
use supertag_workspaces::{
    FinalizeRequest, Outcome, PrepareRequest, Workspace, WorkspaceConfig, advertised_output_remote,
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
