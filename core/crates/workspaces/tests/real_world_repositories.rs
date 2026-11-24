//! The kinds of repository a real checkout on a developer's machine can be. Each either
//! prepares, with files that are exactly the bytes Git stores, or is refused with a cause that
//! says what the repository is and what to do about it. `shallow_clones.rs` and `submodules.rs`
//! follow those two kinds through delivery.
use std::{
    fs,
    io::Write as _,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
use supertag_workspaces::{PrepareRequest, Workspace, WorkspaceConfig};
use tokio_util::sync::CancellationToken;

fn git_in(path: &Path, args: &[&str], input: &[u8], check: bool) -> (bool, String, String) {
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
            "-c",
            "protocol.file.allow=always",
            "-c",
            "init.defaultBranch=main",
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
    let _ = writer.join().unwrap();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    assert!(!check || output.status.success(), "git {args:?}: {stderr}");
    (
        output.status.success(),
        String::from_utf8_lossy(&output.stdout).trim().to_owned(),
        stderr,
    )
}

fn git(path: &Path, args: &[&str]) -> String {
    git_in(path, args, &[], true).1
}

fn git_with(path: &Path, args: &[&str], input: &[u8]) -> String {
    git_in(path, args, input, true).1
}

/// A repository with one commit holding `files`.
fn repository(root: &Path, name: &str, files: &[(&str, &[u8])]) -> PathBuf {
    let source = root.join(name);
    fs::create_dir_all(&source).unwrap();
    git(&source, &["init", "--quiet"]);
    for (path, bytes) in files {
        let file = source.join(path);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, bytes).unwrap();
    }
    git(&source, &["add", "-A"]);
    git(&source, &["commit", "--quiet", "-m", "Base"]);
    source
}

fn head(source: &Path) -> String {
    git(source, &["rev-parse", "HEAD"])
}

async fn prepare(root: &Path, source: &Path, base: &str) -> anyhow::Result<PathBuf> {
    let state = root.join(format!("state-{}", fs::read_dir(root).unwrap().count()));
    let workspace = Workspace::open(WorkspaceConfig {
        state_dir: state,
        source: source.to_owned(),
        base_commit: base.to_owned(),
    })?;
    let checkout = workspace
        .prepare(
            PrepareRequest {
                task_id: "task".into(),
                attempt_id: "attempt".into(),
                session_id: "session".into(),
                expected_head: None,
                setup: None,
                merge_commit: None,
                author: None,
            },
            &CancellationToken::new(),
        )
        .await?;
    Ok(checkout.path)
}

/// The cause a failed Task would show.
fn shown_cause(result: anyhow::Result<PathBuf>) -> String {
    supertag_workspaces::failure_cause(&result.expect_err("the repository is refused"))
}

#[tokio::test]
async fn ordinary_repositories_prepare_wherever_and_however_they_are_kept() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();

    // Under a path with spaces, with spaces in its own paths.
    let spaced = repository(&root, "My Projects/the repo", &[("a b/c d.txt", b"x\n")]);
    let checkout = prepare(&root, &spaced, &head(&spaced)).await.unwrap();
    assert_eq!(fs::read(checkout.join("a b/c d.txt")).unwrap(), b"x\n");

    // SHA-256 object names.
    let sha256 = root.join("sha256");
    fs::create_dir(&sha256).unwrap();
    git(&sha256, &["init", "--quiet", "--object-format=sha256"]);
    fs::write(sha256.join("a.txt"), "a\n").unwrap();
    git(&sha256, &["add", "-A"]);
    git(&sha256, &["commit", "--quiet", "-m", "Base"]);
    prepare(&root, &sha256, &head(&sha256)).await.unwrap();

    // A linked worktree, whose `.git` is a file, of a repository with an unfinished merge, an
    // untracked file, hooks, and configuration SuperTag's own Git commands must not obey.
    let origin = repository(&root, "origin", &[("a.txt", b"one\n")]);
    git(&origin, &["checkout", "--quiet", "-b", "other"]);
    fs::write(origin.join("a.txt"), "other\n").unwrap();
    git(&origin, &["commit", "--quiet", "-am", "Other"]);
    git(&origin, &["checkout", "--quiet", "main"]);
    fs::write(origin.join("a.txt"), "main\n").unwrap();
    git(&origin, &["commit", "--quiet", "-am", "Main"]);
    assert!(!git_in(&origin, &["merge", "other"], &[], false).0);
    fs::write(origin.join("untracked.txt"), "new\n").unwrap();
    fs::write(
        origin.join(".git/hooks/post-checkout"),
        "#!/bin/sh\nexit 1\n",
    )
    .unwrap();
    for setting in [
        "core.fsmonitor",
        "core.untrackedCache",
        "core.sparseCheckout",
    ] {
        git(&origin, &["config", setting, "true"]);
    }
    let checkout = prepare(&root, &origin, &head(&origin)).await.unwrap();
    assert_eq!(fs::read(checkout.join("a.txt")).unwrap(), b"main\n");
    assert!(!checkout.join("untracked.txt").exists());
    git(
        &origin,
        &[
            "worktree",
            "add",
            "--quiet",
            "-b",
            "side",
            "../linked",
            "other",
        ],
    );
    let linked = root.join("linked");
    let checkout = prepare(&root, &linked, &head(&linked)).await.unwrap();
    assert_eq!(fs::read(checkout.join("a.txt")).unwrap(), b"other\n");
}

/// `.gitattributes` that ask Git to change a file on checkout: CRLF line endings for batch files,
/// `$Id$` expansion, a working-tree encoding, and Git LFS's filter. The checkout holds the bytes
/// Git stores, so it verifies, and the repository's own Git agrees nothing has changed.
#[tokio::test]
async fn attributes_that_convert_files_on_checkout_leave_the_checkout_as_git_stores_it() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    let pointer: &[u8] = b"version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 12345\n";
    let files: &[(&str, &[u8])] = &[
        (
            ".gitattributes",
            b"*.bat text eol=crlf\n*.txt text=auto\n*.c ident\n*.rc text working-tree-encoding=UTF-16LE\n*.bin filter=lfs diff=lfs merge=lfs -text\n",
        ),
        ("run.bat", b"echo one\necho two\n"),
        ("crlf.txt", b"one\r\ntwo\r\n"),
        ("a.c", b"/* $Id$ */\n"),
        ("a.rc", b"hello\n"),
        ("big.bin", pointer),
    ];
    let source = root.join("source");
    fs::create_dir(&source).unwrap();
    git(&source, &["init", "--quiet"]);
    // Stored exactly as given, whatever the attributes would make of them on `git add`.
    let mut listing = String::new();
    let mut sorted = files.to_vec();
    sorted.sort();
    for (path, bytes) in sorted {
        let blob = git_with(
            &source,
            &["hash-object", "-w", "--stdin", "--no-filters"],
            bytes,
        );
        listing.push_str(&format!("100644 blob {blob}\t{path}\n"));
    }
    let tree = git_with(&source, &["mktree"], listing.as_bytes());
    let commit = git(&source, &["commit-tree", &tree, "-m", "Base"]);
    // As `git lfs install --local` configures a repository.
    git(&source, &["config", "filter.lfs.required", "true"]);
    git(&source, &["config", "filter.lfs.smudge", "false"]);
    let checkout = prepare(&root, &source, &commit).await.unwrap();
    for (path, bytes) in files {
        assert_eq!(&fs::read(checkout.join(path)).unwrap(), bytes, "{path}");
    }
    assert_eq!(git(&checkout, &["status", "--porcelain"]), "");
}

/// Old histories hold commits and trees Git's strict checks refuse for their format alone. They
/// are copied; a history with an object that is unsafe, not just old, is still refused.
#[tokio::test]
async fn a_history_with_harmless_format_flaws_is_copied_and_an_unsafe_one_is_refused() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    let old = root.join("old");
    fs::create_dir(&old).unwrap();
    git(&old, &["init", "--quiet"]);
    let blob = git_with(&old, &["hash-object", "-w", "--stdin"], b"x\n");
    let raw_oid: Vec<u8> = (0..20)
        .map(|i| u8::from_str_radix(&blob[i * 2..i * 2 + 2], 16).unwrap())
        .collect();
    let raw_tree = |entry: &[u8]| {
        let mut raw = entry.to_vec();
        raw.push(0);
        raw.extend(&raw_oid);
        git_with(
            &old,
            &["hash-object", "-w", "-t", "tree", "--literally", "--stdin"],
            &raw,
        )
    };
    // A file mode written with a leading zero, then a commit with a malformed time zone.
    let padded = raw_tree(b"0100644 padded.txt");
    let first = git(&old, &["commit-tree", &padded, "-m", "Old"]);
    let tree = git_with(
        &old,
        &["mktree"],
        format!("100644 blob {blob}\tclean.txt\n").as_bytes(),
    );
    let zoned = git_with(
        &old,
        &["hash-object", "-w", "-t", "commit", "--literally", "--stdin"],
        format!(
            "tree {tree}\nparent {first}\nauthor A <a@example.test> 1234567890 +051800\ncommitter A <a@example.test> 1234567890 +051800\n\nZoned\n"
        )
        .as_bytes(),
    );
    let commit = git(&old, &["commit-tree", &tree, "-p", &zoned, "-m", "New"]);
    let checkout = prepare(&root, &old, &commit).await.unwrap();
    assert_eq!(fs::read(checkout.join("clean.txt")).unwrap(), b"x\n");

    // A tree in the history with a `.git` entry is not a matter of format.
    let unsafe_tree = raw_tree(b"100644 .git");
    let first = git(&old, &["commit-tree", &unsafe_tree, "-m", "Unsafe"]);
    let commit = git(&old, &["commit-tree", &tree, "-p", &first, "-m", "Later"]);
    let cause = shown_cause(prepare(&root, &old, &commit).await);
    assert!(
        cause.starts_with(
            "the repository's history holds objects that fail Git's strict checks (hasDotgit)"
        ),
        "{cause}"
    );
}

#[tokio::test]
async fn a_clone_without_all_its_objects_prepares_or_says_how_to_fix_it() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    let origin = repository(&root, "origin", &[("a.txt", b"one\n"), ("b.txt", b"b\n")]);
    fs::write(origin.join("a.txt"), "two\n").unwrap();
    git(&origin, &["commit", "--quiet", "-am", "Two"]);
    git(&origin, &["config", "uploadpack.allowFilter", "true"]);
    let url = format!("file://{}", origin.display());

    // A partial clone lacks the files of commits it never checked out.
    git(
        &root,
        &["clone", "--quiet", "--filter=blob:none", &url, "partial"],
    );
    let partial = root.join("partial");
    let cause = shown_cause(prepare(&root, &partial, &head(&partial)).await);
    assert!(
        cause.starts_with("the repository is a partial clone (made with `git clone --filter`)")
            && cause.contains("`git fetch --refetch --no-filter`"),
        "{cause}"
    );
    // What the cause says to run makes it a full clone.
    git(&partial, &["fetch", "--quiet", "--refetch", "--no-filter"]);
    let checkout = prepare(&root, &partial, &head(&partial)).await.unwrap();
    assert_eq!(fs::read(checkout.join("a.txt")).unwrap(), b"two\n");

    // A shallow clone lacks the history before its boundary, and prepares with what it has:
    // the Task's checkout never held more than the commit it starts from.
    git(&root, &["clone", "--quiet", "--depth=1", &url, "shallow"]);
    let shallow = root.join("shallow");
    let checkout = prepare(&root, &shallow, &head(&shallow)).await.unwrap();
    assert_eq!(fs::read(checkout.join("a.txt")).unwrap(), b"two\n");
    assert_eq!(git(&checkout, &["status", "--porcelain"]), "");
    git(&shallow, &["fetch", "--quiet", "--unshallow"]);
    prepare(&root, &shallow, &head(&shallow)).await.unwrap();

    // A clone that is both shallow and partial is still a partial clone.
    git(
        &root,
        &[
            "clone",
            "--quiet",
            "--depth=1",
            "--filter=blob:none",
            "--no-checkout",
            &url,
            "both",
        ],
    );
    let both = root.join("both");
    let cause = shown_cause(prepare(&root, &both, &head(&both)).await);
    assert!(
        cause.starts_with("the repository is a partial clone"),
        "{cause}"
    );

    // A clone that borrows its objects from another repository.
    git(
        &root,
        &[
            "clone",
            "--quiet",
            "--shared",
            origin.to_str().unwrap(),
            "borrowing",
        ],
    );
    let borrowing = root.join("borrowing");
    let cause = shown_cause(prepare(&root, &borrowing, &head(&borrowing)).await);
    assert!(
        cause.starts_with("the repository borrows objects from another repository")
            && cause.contains("`git repack -a -d`"),
        "{cause}"
    );
    git(&borrowing, &["repack", "-a", "-d", "--quiet"]);
    fs::remove_file(borrowing.join(".git/objects/info/alternates")).unwrap();
    prepare(&root, &borrowing, &head(&borrowing)).await.unwrap();
}

#[tokio::test]
async fn a_tree_checks_out_or_names_the_path_and_the_reason() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();

    let sub = repository(&root, "sub", &[("lib.txt", b"lib\n")]);
    let with_sub = repository(&root, "with-sub", &[("README.md", b"hello\n")]);
    git(
        &with_sub,
        &[
            "submodule",
            "--quiet",
            "add",
            sub.to_str().unwrap(),
            "vendor/sub",
        ],
    );
    git(&with_sub, &["commit", "--quiet", "-m", "Add submodule"]);
    // A submodule is an empty directory in the checkout: its content is another repository's,
    // and nothing fetches it. `.gitmodules` is a file like any other.
    let checkout = prepare(&root, &with_sub, &head(&with_sub)).await.unwrap();
    assert_eq!(
        fs::read_dir(checkout.join("vendor/sub")).unwrap().count(),
        0
    );
    assert_eq!(
        fs::read(checkout.join(".gitmodules")).unwrap(),
        fs::read(with_sub.join(".gitmodules")).unwrap()
    );
    assert_eq!(fs::read(checkout.join("README.md")).unwrap(), b"hello\n");
    assert_eq!(git(&checkout, &["status", "--porcelain"]), "");

    for (name, target) in [("absolute", "/etc/hosts"), ("escaping", "../outside")] {
        let linked = repository(&root, name, &[("README.md", b"hello\n")]);
        std::os::unix::fs::symlink(target, linked.join("link")).unwrap();
        git(&linked, &["add", "-A"]);
        git(&linked, &["commit", "--quiet", "-m", "Link"]);
        assert_eq!(
            shown_cause(prepare(&root, &linked, &head(&linked)).await),
            "the repository tracks a symbolic link that points outside the repository (`link`), which SuperTag does not check out",
            "{target}"
        );
    }
    // Many links that stay inside are read with one Git command and checked out.
    let links = repository(&root, "links", &[("README.md", b"hello\n")]);
    for number in 0..300 {
        std::os::unix::fs::symlink("README.md", links.join(format!("link-{number}"))).unwrap();
    }
    git(&links, &["add", "-A"]);
    git(&links, &["commit", "--quiet", "-m", "Links"]);
    let checkout = prepare(&root, &links, &head(&links)).await.unwrap();
    assert_eq!(
        fs::read_link(checkout.join("link-299")).unwrap(),
        Path::new("README.md")
    );

    let named = root.join("named");
    fs::create_dir(&named).unwrap();
    git(&named, &["init", "--quiet"]);
    let blob = git_with(&named, &["hash-object", "-w", "--stdin"], b"x\n");
    let mut listing = format!("100644 blob {blob}\tcaf").into_bytes();
    listing.extend([0xe9, b'\n']);
    let tree = git_with(&named, &["mktree"], &listing);
    let commit = git(&named, &["commit-tree", &tree, "-m", "Latin-1"]);
    let shown = shown_cause(prepare(&root, &named, &commit).await);
    assert!(
        shown.starts_with("the repository tracks a file whose name is not UTF-8"),
        "{shown}"
    );
    let tree = git_with(
        &named,
        &["mktree"],
        format!("100644 blob {blob}\ta\\b.txt\n").as_bytes(),
    );
    let commit = git(&named, &["commit-tree", &tree, "-m", "Backslash"]);
    let shown = shown_cause(prepare(&root, &named, &commit).await);
    assert!(
        shown.starts_with("the repository tracks `a\\b.txt`, a path SuperTag does not check out"),
        "{shown}"
    );

    // Two paths that differ only by case, where the disk cannot hold both.
    fs::write(root.join("probe"), "").unwrap();
    if root.join("PROBE").exists() {
        let other = git_with(&named, &["hash-object", "-w", "--stdin"], b"y\n");
        let tree = git_with(
            &named,
            &["mktree"],
            format!("100644 blob {blob}\tReadme.md\n100644 blob {other}\treadme.md\n").as_bytes(),
        );
        let commit = git(&named, &["commit-tree", &tree, "-m", "Case"]);
        assert_eq!(
            shown_cause(prepare(&root, &named, &commit).await),
            "the repository tracks paths that differ only by letter case (`Readme.md` and `readme.md`), and the disk SuperTag keeps its checkouts on cannot hold both"
        );
    }
}
