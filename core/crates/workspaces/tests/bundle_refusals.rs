//! A Worker Host imports a delivery bundle only when the bundle carries the delivered history
//! beyond the delivery's start commit, which the host must already hold: nothing else is
//! borrowed from the host's own repository and nothing extra is stored.
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};
use supertag_workspaces::{FinalizeRequest, Outcome, PrepareRequest, Workspace, WorkspaceConfig};
use tokio_util::sync::CancellationToken;

fn git_input(path: &Path, args: &[&str], input: &[u8]) -> Vec<u8> {
    let mut child = Command::new("/usr/bin/git")
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
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(input).unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    output.stdout
}
fn git(path: &Path, args: &[&str]) -> String {
    String::from_utf8(git_input(path, args, b""))
        .unwrap()
        .trim()
        .into()
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

struct Fixture {
    _root: tempfile::TempDir,
    /// The temporary directory with symlinks such as macOS `/var` resolved.
    path: PathBuf,
    source: PathBuf,
    base: String,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().canonicalize().unwrap();
        let source = path.join("source");
        fs::create_dir(&source).unwrap();
        git(&source, &["init", "--quiet", "--initial-branch=main"]);
        fs::write(source.join("README.md"), "original\n").unwrap();
        git(&source, &["add", "-A"]);
        git(&source, &["commit", "--quiet", "-m", "Initial commit"]);
        let base = git(&source, &["rev-parse", "HEAD"]);
        Self {
            _root: root,
            path,
            source,
            base,
        }
    }
    fn host(&self, name: &str) -> Workspace {
        Workspace::open(WorkspaceConfig {
            state_dir: self.path.join(name),
            source: self.source.clone(),
            base_commit: self.base.clone(),
        })
        .unwrap()
    }
    fn write(&self, name: &str, bytes: &[u8]) -> PathBuf {
        let path = self.path.join(name);
        fs::write(&path, bytes).unwrap();
        path
    }
    /// A bundle header naming `head` with no prerequisites, followed by a pack of `objects`.
    fn forged(&self, name: &str, head: &str, objects: &[&str]) -> (PathBuf, String) {
        let pack = git_input(
            &self.source,
            &["pack-objects", "--stdout"],
            format!("{}\n", objects.join("\n")).as_bytes(),
        );
        let mut bytes = format!("# v2 git bundle\n{head} refs/heads/candidate\n\n").into_bytes();
        bytes.extend(pack);
        let sha = digest(&bytes);
        (self.write(name, &bytes), sha)
    }
}

/// Every file under an `objects` directory of a host's state, with its size.
fn objects(state: &Path) -> Vec<(PathBuf, u64)> {
    let mut found = Vec::new();
    let mut pending = vec![state.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(&directory).unwrap() {
            let entry = entry.unwrap();
            let kind = entry.file_type().unwrap();
            if kind.is_dir() {
                pending.push(entry.path());
            } else if kind.is_file()
                && entry
                    .path()
                    .components()
                    .any(|part| part.as_os_str() == "objects")
            {
                found.push((entry.path(), entry.metadata().unwrap().len()));
            }
        }
    }
    found.sort();
    found
}

async fn refused(host: &(Workspace, PathBuf), path: &Path, sha: &str, head: &str) -> String {
    refused_from(host, path, sha, head, None).await
}

async fn refused_from(
    host: &(Workspace, PathBuf),
    path: &Path,
    sha: &str,
    head: &str,
    start: Option<&str>,
) -> String {
    let (host, state) = host;
    let before = objects(state);
    let error = tokio::time::timeout(
        Duration::from_secs(60),
        host.import_bundle(path, sha, head, start, &CancellationToken::new()),
    )
    .await
    .expect("import must not block")
    .expect_err(&format!("bundle must be refused: {}", path.display()));
    // The host's object store is unchanged: no object, pack, or index was added.
    assert_eq!(objects(state), before);
    // Nothing was imported: a Task pinned to the head still cannot start.
    assert!(
        host.prepare(
            PrepareRequest {
                task_id: "pinned".into(),
                attempt_id: "pinned-attempt".into(),
                session_id: "session".into(),
                expected_head: Some(head.into()),
                setup: None,
                merge_commit: None,
                author: None,
            },
            &CancellationToken::new(),
        )
        .await
        .is_err()
    );
    format!("{error:#}")
}

#[tokio::test]
async fn delivery_bundle_refusals_import_nothing_and_borrow_nothing_from_the_host() {
    let fixture = Fixture::new();
    let first = fixture.host("first-host");
    let checkout = first
        .prepare(
            PrepareRequest {
                task_id: "original".into(),
                attempt_id: "original-attempt".into(),
                session_id: "session".into(),
                expected_head: None,
                setup: None,
                merge_commit: None,
                author: None,
            },
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    fs::write(checkout.path.join("README.md"), "delivered\n").unwrap();
    let delivery = first
        .finalize(
            &checkout,
            FinalizeRequest {
                output_directory: None,
                file_scope: None,
                summary: "Change: deliver".into(),
                outcome: Outcome::Completed,
            },
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    let head = delivery.head_commit.clone();
    let good = fs::read(&delivery.bundle_path).unwrap();
    let second = (
        fixture.host("second-host"),
        fixture.path.join("second-host"),
    );

    // Over the size cap: refused from the file's size, before reading or importing it.
    let huge = fixture.path.join("huge.bundle");
    fs::File::create(&huge)
        .unwrap()
        .set_len(268_435_456 + 1)
        .unwrap();
    let error = refused(&second, &huge, &"0".repeat(64), &head).await;
    assert!(error.contains("size limit"), "{error}");

    // A FIFO is not a regular file and is refused without waiting for a writer.
    let fifo = fixture.path.join("fifo.bundle");
    let name = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
    // SAFETY: the path is a valid NUL-terminated string.
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
    let error = refused(&second, &fifo, &"0".repeat(64), &head).await;
    assert!(error.contains("regular file"), "{error}");

    // A damaged pack whose digest matches the damaged bytes.
    let mut damaged = good.clone();
    let last = damaged.len() - 30;
    damaged[last] ^= 0xff;
    let path = fixture.write("damaged.bundle", &damaged);
    let error = refused_from(
        &second,
        &path,
        &digest(&damaged),
        &head,
        Some(&delivery.start_commit),
    )
    .await;
    assert!(error.contains("damaged"), "{error}");

    // A bundle that needs a prerequisite, even one this host has, other than the delivery's
    // approved start commit; and one that names a prerequisite where none is accepted.
    git(&fixture.source, &["checkout", "--quiet", "-b", "candidate"]);
    fs::write(fixture.source.join("README.md"), "candidate\n").unwrap();
    git(&fixture.source, &["commit", "--quiet", "-am", "Candidate"]);
    let candidate = git(&fixture.source, &["rev-parse", "HEAD"]);
    let thin = fixture.path.join("thin.bundle");
    git(
        &fixture.source,
        &[
            "bundle",
            "create",
            thin.to_str().unwrap(),
            "candidate",
            &format!("^{}", fixture.base),
        ],
    );
    let bytes = fs::read(&thin).unwrap();
    let error = refused_from(&second, &thin, &digest(&bytes), &candidate, Some(&head)).await;
    assert!(error.contains("start commit"), "{error}");
    let error = refused(&second, &thin, &digest(&bytes), &candidate).await;
    assert!(error.contains("accepts none"), "{error}");

    // A commit whose parent the pack omits borrows that parent from the host.
    let tree = git(&fixture.source, &["rev-parse", "candidate^{tree}"]);
    let blob = git(&fixture.source, &["rev-parse", "candidate:README.md"]);
    let (path, sha) = fixture.forged("parent.bundle", &candidate, &[&candidate, &tree, &blob]);
    let error = refused(&second, &path, &sha, &candidate).await;
    assert!(error.contains("incomplete"), "{error}");

    // A tree naming a blob of the host's base commit that the pack does not carry.
    let base_blob = git(&fixture.source, &["rev-parse", "main:README.md"]);
    let borrowed_tree = String::from_utf8(git_input(
        &fixture.source,
        &["mktree"],
        format!("100644 blob {base_blob}\tborrowed.txt\n").as_bytes(),
    ))
    .unwrap()
    .trim()
    .to_owned();
    let borrowed = String::from_utf8(git_input(
        &fixture.source,
        &["commit-tree", &borrowed_tree],
        b"Borrow a blob\n",
    ))
    .unwrap()
    .trim()
    .to_owned();
    let (path, sha) = fixture.forged("blob.bundle", &borrowed, &[&borrowed, &borrowed_tree]);
    let error = refused(&second, &path, &sha, &borrowed).await;
    assert!(error.contains("incomplete"), "{error}");

    // A complete pack that also carries an object outside the delivered history.
    fs::write(fixture.source.join("hidden.txt"), "not delivered\n").unwrap();
    let hidden = git(&fixture.source, &["hash-object", "-w", "hidden.txt"]);
    let base_tree = git(&fixture.source, &["rev-parse", "main^{tree}"]);
    let (path, sha) = fixture.forged(
        "hidden.bundle",
        &candidate,
        &[
            &candidate,
            &tree,
            &blob,
            &fixture.base,
            &base_tree,
            &base_blob,
            &hidden,
        ],
    );
    let error = refused(&second, &path, &sha, &candidate).await;
    assert!(error.contains("outside the delivered history"), "{error}");

    // The approved delivery still imports, and continuation starts from it.
    second
        .0
        .import_bundle(
            &delivery.bundle_path,
            &delivery.bundle_sha256,
            &head,
            Some(&delivery.start_commit),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    let continued = second
        .0
        .prepare(
            PrepareRequest {
                task_id: "next".into(),
                attempt_id: "next-attempt".into(),
                session_id: "session".into(),
                expected_head: Some(head),
                setup: None,
                merge_commit: None,
                author: None,
            },
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        fs::read_to_string(continued.path.join("README.md")).unwrap(),
        "delivered\n"
    );
}

/// An incremental delivery bundle (`start..head`) imports on a host that holds its start commit;
/// one that does not is refused with `MissingPrerequisite` and keeps nothing, while a complete
/// bundle of the same head imports there. Its pack may borrow only the start commit's history:
/// an object outside `HEAD --not START`, and a delta against another Session's object, are
/// refused.
#[tokio::test]
async fn incremental_delivery_bundles_build_on_a_start_commit_the_host_holds() {
    let fixture = Fixture::new();
    let first = fixture.host("first-host");
    let deliver =
        async |session: &str, expected: Option<String>, name: &str, file: &str, text: &str| {
            let checkout = first
                .prepare(
                    PrepareRequest {
                        task_id: name.into(),
                        attempt_id: format!("{name}-attempt"),
                        session_id: session.into(),
                        expected_head: expected,
                        setup: None,
                        merge_commit: None,
                        author: None,
                    },
                    &CancellationToken::new(),
                )
                .await
                .unwrap();
            fs::write(checkout.path.join(file), text).unwrap();
            first
                .finalize(
                    &checkout,
                    FinalizeRequest {
                        output_directory: None,
                        file_scope: None,
                        summary: format!("Change: {name}"),
                        outcome: Outcome::Completed,
                    },
                    &CancellationToken::new(),
                )
                .await
                .unwrap()
        };
    let holder = format!(
        "--git-dir={}",
        fixture.path.join("first-host/repository.git").display()
    );
    // A bundle from the first host's repository: `head`, named as the delivery's ref, without
    // the history of `excluded`.
    let bundle = |name: &str, head: &str, excluded: &[&str]| -> (PathBuf, String) {
        let path = fixture.path.join(name);
        let reference = format!("refs/heads/bundles/{name}");
        git(&fixture.path, &[&holder, "update-ref", &reference, head]);
        let mut args = vec![holder.as_str(), "bundle", "create", path.to_str().unwrap()];
        args.push(&reference);
        let exclusions: Vec<String> = excluded.iter().map(|oid| format!("^{oid}")).collect();
        args.extend(exclusions.iter().map(String::as_str));
        git(&fixture.path, &args);
        let sha = digest(&fs::read(&path).unwrap());
        (path, sha)
    };
    // Large enough that Git stores later versions as deltas against earlier ones.
    let text = |line: &str| format!("{}{line}\n", "shared content line\n".repeat(400));
    let one = deliver("session", None, "one", "README.md", &text("one")).await;
    let two = deliver(
        "session",
        Some(one.head_commit.clone()),
        "two",
        "README.md",
        &text("two"),
    )
    .await;
    let other = deliver(
        "other",
        None,
        "other",
        "SECRET.md",
        &text("other session secret"),
    )
    .await;
    // A later turn whose file is closest to the other Session's: Git deltas it against that.
    let three = deliver(
        "session",
        Some(two.head_commit.clone()),
        "three",
        "SECRET.md",
        &format!("{}more\n", text("other session secret")),
    )
    .await;
    let (one_path, one_sha) = bundle("one.bundle", &one.head_commit, &[&one.start_commit]);
    let (two_path, two_sha) = bundle("two.bundle", &two.head_commit, &[&two.start_commit]);
    let (complete_path, complete_sha) = bundle("two-complete.bundle", &two.head_commit, &[]);
    assert!(fs::metadata(&two_path).unwrap().len() < fs::metadata(&complete_path).unwrap().len());
    // The Worker Host's own delivery bundles are incremental too.
    for delivery in [&one, &two] {
        let bytes = fs::read(&delivery.bundle_path).unwrap();
        let header = String::from_utf8_lossy(&bytes[..bytes.len().min(300)]).into_owned();
        assert!(
            header.contains(&format!("-{}", delivery.start_commit)),
            "{header}"
        );
    }

    // A host holding the base imports the first, then the second on top of it.
    let second = (
        fixture.host("second-host"),
        fixture.path.join("second-host"),
    );
    for (path, sha, delivery) in [(&one_path, &one_sha, &one), (&two_path, &two_sha, &two)] {
        second
            .0
            .import_bundle(
                path,
                sha,
                &delivery.head_commit,
                Some(&delivery.start_commit),
                &CancellationToken::new(),
            )
            .await
            .unwrap();
    }
    assert!(
        second
            .0
            .holds_commit(&two.head_commit, &CancellationToken::new())
            .await
    );

    // A host holding only the base lacks the second delivery's start: refused, nothing kept.
    let third = (fixture.host("third-host"), fixture.path.join("third-host"));
    assert!(
        third
            .0
            .holds_commit(&fixture.base, &CancellationToken::new())
            .await
    );
    let before = objects(&third.1);
    let error = third
        .0
        .import_bundle(
            &two_path,
            &two_sha,
            &two.head_commit,
            Some(&two.start_commit),
            &CancellationToken::new(),
        )
        .await
        .unwrap_err();
    let missing = error
        .downcast_ref::<supertag_workspaces::MissingPrerequisite>()
        .unwrap_or_else(|| panic!("{error:#}"));
    assert_eq!(missing.0, one.head_commit);
    assert_eq!(objects(&third.1), before);
    // The complete bundle of the same head, as the holder sends when asked, imports there.
    third
        .0
        .import_bundle(
            &complete_path,
            &complete_sha,
            &two.head_commit,
            Some(&two.start_commit),
            &CancellationToken::new(),
        )
        .await
        .unwrap();

    // A fourth host holds the first delivery and the other Session's commit.
    let fourth = (
        fixture.host("fourth-host"),
        fixture.path.join("fourth-host"),
    );
    for delivery in [&one, &other] {
        fourth
            .0
            .import_bundle(
                &delivery.bundle_path,
                &delivery.bundle_sha256,
                &delivery.head_commit,
                Some(&delivery.start_commit),
                &CancellationToken::new(),
            )
            .await
            .unwrap();
    }
    fourth
        .0
        .import_bundle(
            &two_path,
            &two_sha,
            &two.head_commit,
            Some(&two.start_commit),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    // A pack carrying an object outside `HEAD --not START` beside the delivered ones.
    let stray = String::from_utf8(git_input(
        &fixture.path,
        &[&holder, "hash-object", "-w", "--stdin"],
        b"not part of the delivery\n",
    ))
    .unwrap()
    .trim()
    .to_owned();
    let delivered = git(
        &fixture.path,
        &[
            &holder,
            "rev-list",
            "--objects",
            &three.head_commit,
            &format!("^{}", three.start_commit),
        ],
    );
    let mut listed: Vec<String> = delivered
        .lines()
        .map(|line| line.split(' ').next().unwrap().to_owned())
        .collect();
    listed.push(stray);
    let pack = git_input(
        &fixture.path,
        &[&holder, "pack-objects", "--stdout"],
        format!("{}\n", listed.join("\n")).as_bytes(),
    );
    let mut forged = format!(
        "# v2 git bundle\n-{} start\n{} refs/heads/candidate\n\n",
        three.start_commit, three.head_commit
    )
    .into_bytes();
    forged.extend(pack);
    let forged_path = fixture.write("stray.bundle", &forged);
    let error = refused_from(
        &fourth,
        &forged_path,
        &digest(&forged),
        &three.head_commit,
        Some(&three.start_commit),
    )
    .await;
    assert!(error.contains("outside the delivered history"), "{error}");

    // A pack that also carries the other Session's blob, which this host holds but which is not
    // in the start commit's history. Unbundling a thin pack copies its delta bases in the same
    // way, so a delta against that blob is refused by the same check.
    let foreign = git(
        &fixture.path,
        &[
            &holder,
            "rev-parse",
            &format!("{}:SECRET.md", other.head_commit),
        ],
    );
    let objects = git(
        &fixture.path,
        &[
            &holder,
            "rev-list",
            "--objects",
            &three.head_commit,
            &format!("^{}", three.start_commit),
        ],
    );
    let mut listed: Vec<&str> = objects
        .lines()
        .map(|line| line.split(' ').next().unwrap())
        .collect();
    listed.push(&foreign);
    let thin = git_input(
        &fixture.path,
        &[&holder, "pack-objects", "--stdout"],
        format!("{}\n", listed.join("\n")).as_bytes(),
    );
    let mut forged = format!(
        "# v2 git bundle\n-{} start\n{} refs/heads/candidate\n\n",
        three.start_commit, three.head_commit
    )
    .into_bytes();
    forged.extend(thin);
    let forged_path = fixture.write("foreign.bundle", &forged);
    let error = refused_from(
        &fourth,
        &forged_path,
        &digest(&forged),
        &three.head_commit,
        Some(&three.start_commit),
    )
    .await;
    assert!(error.contains("outside the delivered history"), "{error}");
    // The honest incremental bundle still imports there.
    let (three_path, three_sha) =
        bundle("three.bundle", &three.head_commit, &[&three.start_commit]);
    fourth
        .0
        .import_bundle(
            &three_path,
            &three_sha,
            &three.head_commit,
            Some(&three.start_commit),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
}
