//! A Worker Host imports a delivery bundle only when the bundle alone carries the delivered
//! history: nothing is borrowed from the host's own repository and nothing extra is stored.
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

async fn refused(host: &Workspace, path: &Path, sha: &str, head: &str) -> String {
    let error = tokio::time::timeout(
        Duration::from_secs(60),
        host.import_bundle(path, sha, head, &CancellationToken::new()),
    )
    .await
    .expect("import must not block")
    .expect_err("bundle must be refused");
    // Nothing was imported: a Task pinned to the head still cannot start.
    assert!(
        host.prepare(
            PrepareRequest {
                task_id: "pinned".into(),
                attempt_id: "pinned-attempt".into(),
                session_id: "session".into(),
                expected_head: Some(head.into()),
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
                summary: "Change: deliver".into(),
                outcome: Outcome::Completed,
            },
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    let head = delivery.head_commit.clone();
    let good = fs::read(&delivery.bundle_path).unwrap();
    let second = fixture.host("second-host");

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
    let error = refused(&second, &path, &digest(&damaged), &head).await;
    assert!(error.contains("damaged"), "{error}");

    // A thin bundle that needs a prerequisite, even one this host has.
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
    let error = refused(&second, &thin, &digest(&bytes), &candidate).await;
    assert!(error.contains("incomplete"), "{error}");

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
        .import_bundle(
            &delivery.bundle_path,
            &delivery.bundle_sha256,
            &head,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    let continued = second
        .prepare(
            PrepareRequest {
                task_id: "next".into(),
                attempt_id: "next-attempt".into(),
                session_id: "session".into(),
                expected_head: Some(head),
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
