use sha2::{Digest, Sha256};
use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    path::{Path, PathBuf},
    process::Command,
};
use supertag_workspaces::{
    Checkout, FinalizeRequest, Outcome, PrepareRequest, TransferArtifact, Workspace,
    WorkspaceConfig,
};
use tokio_util::sync::CancellationToken;

fn git(path: &Path, arguments: &[&str]) -> String {
    let result = Command::new("/usr/bin/git")
        .current_dir(path)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .args([
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
        ])
        .args(arguments)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    String::from_utf8(result.stdout).unwrap().trim().to_owned()
}

struct Fixture {
    root: tempfile::TempDir,
    source: PathBuf,
    state: PathBuf,
    base: String,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        fs::create_dir(&source).unwrap();
        git(&source, &["init", "--quiet"]);
        fs::write(source.join("keep"), "original").unwrap();
        fs::write(source.join("delete"), "remove me").unwrap();
        git(&source, &["add", "."]);
        git(&source, &["commit", "--quiet", "-m", "Initial"]);
        let base = git(&source, &["rev-parse", "HEAD"]);
        let state = root.path().join("state");
        Self {
            root,
            source,
            state,
            base,
        }
    }
    fn open(&self) -> Workspace {
        Workspace::open(WorkspaceConfig {
            source: self.source.clone(),
            state_dir: self.state.clone(),
            base_commit: self.base.clone(),
        })
        .unwrap()
    }
    async fn prepare(&self, workspace: &Workspace, task: &str, pin: &str) -> Checkout {
        workspace
            .prepare(
                PrepareRequest {
                    task_id: task.into(),
                    attempt_id: format!("{task}-attempt"),
                    session_id: "session".into(),
                    expected_head: Some(pin.into()),
                },
                &CancellationToken::new(),
            )
            .await
            .unwrap()
    }
    fn archive(&self, name: &str, entries: &[(&str, &str, &[u8])]) -> TransferArtifact {
        let manifest = serde_json::json!({"entries": entries.iter().map(|(path,mode,data)|
            serde_json::json!({"path":path,"mode":mode,"size":data.len()})).collect::<Vec<_>>()});
        self.raw(
            name,
            &manifest,
            &entries
                .iter()
                .flat_map(|(_, _, data)| data.iter().copied())
                .collect::<Vec<_>>(),
        )
    }
    fn raw(&self, name: &str, manifest: &serde_json::Value, payload: &[u8]) -> TransferArtifact {
        let json = serde_json::to_vec(manifest).unwrap();
        let mut bytes = b"STWTREE1\n".to_vec();
        bytes.extend((json.len() as u32).to_be_bytes());
        bytes.extend(json);
        bytes.extend(payload);
        let path = self.root.path().canonicalize().unwrap().join(name);
        fs::write(&path, &bytes).unwrap();
        TransferArtifact {
            path,
            sha256: format!("{:x}", Sha256::digest(&bytes)),
            byte_length: bytes.len() as u64,
        }
    }
}
fn completed() -> FinalizeRequest {
    FinalizeRequest {
        summary: "Capture remote work".into(),
        outcome: Outcome::Completed,
    }
}

#[tokio::test]
async fn exports_runtime_only_ancestry_and_restores_data_with_exact_modes_and_deletions() {
    let fixture = Fixture::new();
    let workspace = fixture.open();
    let first = fixture.prepare(&workspace, "first", &fixture.base).await;
    fs::write(first.path.join("keep"), "first turn").unwrap();
    let delivered = workspace
        .finalize(&first, completed(), &CancellationToken::new())
        .await
        .unwrap();
    let second = fixture
        .prepare(&workspace, "second", &delivered.head_commit)
        .await;
    // The checkout's Git metadata is untrusted. Export must use the private runtime store.
    fs::write(
        second.path.join(".git/config"),
        "[include]\npath=/missing/host-config\n",
    )
    .unwrap();
    let exported = workspace
        .export_prepared(&second, &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(exported.checkout, second);
    assert_eq!(
        workspace
            .export_prepared(&second, &CancellationToken::new())
            .await
            .unwrap(),
        exported
    );
    let remote = fixture.root.path().join("remote");
    fs::create_dir(&remote).unwrap();
    git(&remote, &["init", "--quiet"]);
    git(
        &remote,
        &[
            "fetch",
            "--quiet",
            exported.bundle.path.to_str().unwrap(),
            &second.start_commit,
        ],
    );
    assert_eq!(
        git(&remote, &["rev-parse", "FETCH_HEAD"]),
        delivered.head_commit
    );
    assert_eq!(git(&remote, &["rev-parse", "FETCH_HEAD^"]), fixture.base);
    assert_eq!(git(&remote, &["show", "FETCH_HEAD:keep"]), "first turn");

    let archive = fixture.archive(
        "returned.tree",
        &[
            ("bin/run", "100755", b"#!/bin/sh\necho fixture\n"),
            ("keep", "100644", b"second turn\0binary"),
            ("link", "120000", b"bin/run"),
        ],
    );
    workspace
        .restore_tree(&second, &archive, &CancellationToken::new())
        .await
        .unwrap();
    assert!(!second.path.join("delete").exists());
    assert_eq!(
        git(&second.path, &["rev-parse", "HEAD"]),
        second.start_commit
    );
    assert!(
        !fs::read_to_string(second.path.join(".git/config"))
            .unwrap()
            .contains("host-config")
    );
    assert_eq!(
        fs::read(second.path.join("keep")).unwrap(),
        b"second turn\0binary"
    );
    assert_eq!(
        fs::metadata(second.path.join("bin/run"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o755
    );
    assert_eq!(
        fs::read_link(second.path.join("link")).unwrap(),
        Path::new("bin/run")
    );
    drop(workspace);
    let workspace = fixture.open();
    workspace
        .restore_tree(&second, &archive, &CancellationToken::new())
        .await
        .unwrap();
    let result = workspace
        .finalize(&second, completed(), &CancellationToken::new())
        .await
        .unwrap();
    git(
        &remote,
        &[
            "fetch",
            "--quiet",
            result.bundle_path.to_str().unwrap(),
            &result.head_commit,
        ],
    );
    assert_eq!(
        git(&remote, &["rev-parse", "FETCH_HEAD^"]),
        delivered.head_commit
    );
    assert_eq!(git(&fixture.source, &["rev-parse", "HEAD"]), fixture.base);
    assert_eq!(fs::read(fixture.source.join("keep")).unwrap(), b"original");
    let changed = fixture.archive("other.tree", &[]);
    assert!(
        workspace
            .restore_tree(&second, &changed, &CancellationToken::new())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn rejects_untrusted_returns_before_mutating_the_owned_checkout() {
    let fixture = Fixture::new();
    let workspace = fixture.open();
    let checkout = fixture.prepare(&workspace, "task", &fixture.base).await;
    let invalid: Vec<Vec<(&str, &str, &[u8])>> = vec![
        vec![("../outside", "100644", b"bad")],
        vec![(".git/config", "100644", b"bad")],
        vec![("nested/.Git/config", "100644", b"bad")],
        vec![("same", "100644", b"a"), ("same", "100644", b"b")],
        vec![
            ("parent", "120000", b"keep"),
            ("parent/child", "100644", b"bad"),
        ],
        vec![("link", "120000", b"../outside")],
        vec![("link", "120000", b"/outside")],
        vec![("file", "060000", b"bad")],
        vec![("z", "100644", b"a"), ("a", "100644", b"b")],
    ];
    for (index, entries) in invalid.iter().enumerate() {
        let archive = fixture.archive(&format!("invalid-{index}"), entries);
        assert!(
            workspace
                .restore_tree(&checkout, &archive, &CancellationToken::new())
                .await
                .is_err(),
            "case {index}"
        );
        assert_eq!(fs::read(checkout.path.join("keep")).unwrap(), b"original");
        assert!(checkout.path.join("delete").is_file());
    }
    for (index, size, bytes) in [
        (0, 3_u64, &b"a"[..]),
        (1, 0, &b"extra"[..]),
        (2, 67_108_865, &b""[..]),
    ] {
        let archive = fixture.raw(
            &format!("size-{index}"),
            &serde_json::json!({"entries":[{"path":"file","mode":"100644","size":size}]}),
            bytes,
        );
        assert!(
            workspace
                .restore_tree(&checkout, &archive, &CancellationToken::new())
                .await
                .is_err()
        );
    }
    let mut archive = fixture.archive("valid.tree", &[("keep", "100644", b"new")]);
    let valid_digest = archive.sha256.clone();
    archive.sha256 = "0".repeat(64);
    assert!(
        workspace
            .restore_tree(&checkout, &archive, &CancellationToken::new())
            .await
            .is_err()
    );
    archive.sha256 = valid_digest;
    let linked = fixture.root.path().join("linked.tree");
    symlink(&archive.path, &linked).unwrap();
    archive.path = linked;
    assert!(
        workspace
            .restore_tree(&checkout, &archive, &CancellationToken::new())
            .await
            .is_err()
    );
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert!(workspace.export_prepared(&checkout, &cancel).await.is_err());
    assert!(
        workspace
            .restore_tree(&checkout, &archive, &cancel)
            .await
            .is_err()
    );
    let mut forged = checkout.clone();
    forged.path = fixture.source.clone();
    assert!(
        workspace
            .export_prepared(&forged, &CancellationToken::new())
            .await
            .is_err()
    );
    assert!(
        workspace
            .restore_tree(&forged, &archive, &CancellationToken::new())
            .await
            .is_err()
    );
    assert_eq!(fs::read(checkout.path.join("keep")).unwrap(), b"original");
}

#[tokio::test]
async fn interrupted_replacement_resumes_from_validated_staging_without_source_or_input() {
    for phase in 0..3 {
        let fixture = Fixture::new();
        let workspace = fixture.open();
        let checkout = fixture.prepare(&workspace, "recover", &fixture.base).await;
        let export = workspace
            .export_prepared(&checkout, &CancellationToken::new())
            .await
            .unwrap();
        let record = export.bundle.path.parent().unwrap();
        let archive = fixture.archive(
            "returned.tree",
            &[("keep", "100644", b"verified remote tree")],
        );
        workspace
            .restore_tree(&checkout, &archive, &CancellationToken::new())
            .await
            .unwrap();

        // Recreate each durable boundary: intent before either rename, old
        // checkout moved aside, and new checkout installed before its receipt.
        fs::remove_file(record.join("restored.json")).unwrap();
        let staging = record.join("return-checkout");
        let backup = record.join("replaced-checkout");
        fs::rename(&checkout.path, &staging).unwrap();
        fs::create_dir(&checkout.path).unwrap();
        fs::write(checkout.path.join("keep"), "old checkout").unwrap();
        let outside = fixture.root.path().join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("retain"), "outside").unwrap();
        symlink(&outside, checkout.path.join("outside-link")).unwrap();
        if phase >= 1 {
            fs::rename(&checkout.path, &backup).unwrap();
        }
        if phase == 2 {
            fs::rename(&staging, &checkout.path).unwrap();
        }
        assert!(
            workspace
                .finalize(&checkout, completed(), &CancellationToken::new())
                .await
                .is_err()
        );
        drop(workspace);
        fs::remove_dir_all(&fixture.source).unwrap();
        fs::remove_file(&archive.path).unwrap();
        let workspace = Workspace::open_existing(&fixture.state).unwrap();
        workspace
            .restore_tree(&checkout, &archive, &CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(
            fs::read(checkout.path.join("keep")).unwrap(),
            b"verified remote tree"
        );
        assert!(!backup.exists());
        assert!(!staging.exists());
        assert_eq!(fs::read(outside.join("retain")).unwrap(), b"outside");
        workspace.discard_checkout(&checkout).unwrap();
        assert!(!checkout.path.exists());
    }
}

#[tokio::test]
async fn unchanged_tree_is_a_noop_and_empty_tree_removes_all_files() {
    let fixture = Fixture::new();
    // Accepted source has both an executable and a safe relative symlink.
    fs::set_permissions(
        fixture.source.join("keep"),
        fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    symlink("keep", fixture.source.join("link")).unwrap();
    git(&fixture.source, &["add", "."]);
    git(&fixture.source, &["commit", "--quiet", "-m", "Modes"]);
    let base = git(&fixture.source, &["rev-parse", "HEAD"]);
    let workspace = Workspace::open(WorkspaceConfig {
        source: fixture.source.clone(),
        state_dir: fixture.state.clone(),
        base_commit: base.clone(),
    })
    .unwrap();
    let checkout = fixture.prepare(&workspace, "noop", &base).await;
    let archive = fixture.archive(
        "unchanged.tree",
        &[
            ("delete", "100644", b"remove me"),
            ("keep", "100755", b"original"),
            ("link", "120000", b"keep"),
        ],
    );
    workspace
        .restore_tree(&checkout, &archive, &CancellationToken::new())
        .await
        .unwrap();
    let delivery = workspace
        .finalize(&checkout, completed(), &CancellationToken::new())
        .await
        .unwrap();
    assert!(!delivery.committed);
    assert_eq!(delivery.changed_files, 0);
    assert_eq!(delivery.head_commit, base);

    let empty = fixture.prepare(&workspace, "empty", &base).await;
    let archive = fixture.archive("empty.tree", &[]);
    workspace
        .restore_tree(&empty, &archive, &CancellationToken::new())
        .await
        .unwrap();
    let delivery = workspace
        .finalize(&empty, completed(), &CancellationToken::new())
        .await
        .unwrap();
    assert!(delivery.committed);
    assert_eq!(delivery.changed_files, 3);
    assert_eq!(git(&empty.path, &["rev-parse", "HEAD"]), base);
}

#[tokio::test]
async fn recovery_rechecks_staged_bytes_before_replacing_original_and_bounds_header() {
    let fixture = Fixture::new();
    let workspace = fixture.open();
    let checkout = fixture.prepare(&workspace, "task", &fixture.base).await;
    let export = workspace
        .export_prepared(&checkout, &CancellationToken::new())
        .await
        .unwrap();
    let mut archive = fixture.archive("returned.tree", &[("keep", "100644", b"new")]);
    archive.byte_length = 268_435_457;
    assert!(
        workspace
            .restore_tree(&checkout, &archive, &CancellationToken::new())
            .await
            .is_err()
    );
    let mut bad_header = b"STWTREE1\n".to_vec();
    bad_header.extend(16_777_217_u32.to_be_bytes());
    fs::write(&archive.path, &bad_header).unwrap();
    archive.byte_length = bad_header.len() as u64;
    archive.sha256 = format!("{:x}", Sha256::digest(&bad_header));
    assert!(
        workspace
            .restore_tree(&checkout, &archive, &CancellationToken::new())
            .await
            .is_err()
    );
    assert_eq!(fs::read(checkout.path.join("keep")).unwrap(), b"original");

    let archive = fixture.archive("clean.tree", &[("keep", "100644", b"new")]);
    workspace
        .restore_tree(&checkout, &archive, &CancellationToken::new())
        .await
        .unwrap();
    let record = export.bundle.path.parent().unwrap();
    fs::remove_file(record.join("restored.json")).unwrap();
    fs::rename(&checkout.path, record.join("return-checkout")).unwrap();
    fs::write(record.join("return-checkout/keep"), "changed staging").unwrap();
    fs::create_dir(&checkout.path).unwrap();
    fs::write(checkout.path.join("keep"), "original still present").unwrap();
    drop(workspace);
    let workspace = fixture.open();
    assert!(
        workspace
            .restore_tree(&checkout, &archive, &CancellationToken::new())
            .await
            .is_err()
    );
    assert_eq!(
        fs::read(checkout.path.join("keep")).unwrap(),
        b"original still present"
    );
    assert!(
        workspace
            .finalize(&checkout, completed(), &CancellationToken::new())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn terminal_discard_removes_only_transfer_copies_and_tolerates_incomplete_preparation() {
    let fixture = Fixture::new();
    let workspace = fixture.open();
    let checkout = fixture.prepare(&workspace, "complete", &fixture.base).await;
    let exported = workspace
        .export_prepared(&checkout, &CancellationToken::new())
        .await
        .unwrap();
    let record = exported.bundle.path.parent().unwrap();
    let returned = fixture.archive("return.tree", &[("keep", "100644", b"changed")]);
    workspace
        .restore_tree(&checkout, &returned, &CancellationToken::new())
        .await
        .unwrap();
    let delivery = workspace
        .finalize(&checkout, completed(), &CancellationToken::new())
        .await
        .unwrap();
    fs::write(record.join("retain-audit"), "unrelated record").unwrap();
    assert!(record.join("return.tree").is_file());
    assert!(exported.bundle.path.is_file());
    let mut forged = checkout.clone();
    forged.path = fixture.source.clone();
    assert!(workspace.discard_checkout(&forged).is_err());
    assert!(exported.bundle.path.is_file());
    // Terminal unlink must remove a substituted leaf link, never its target.
    fs::remove_file(&exported.bundle.path).unwrap();
    symlink(&returned.path, &exported.bundle.path).unwrap();

    workspace.remove_checkout(&checkout).unwrap();
    workspace.remove_checkout(&checkout).unwrap();
    assert!(!checkout.path.exists());
    assert!(!record.join("return.tree").exists());
    assert!(!exported.bundle.path.exists());
    for name in [
        "prepare.json",
        "export.json",
        "restore.json",
        "restored.json",
        "finalize.json",
        "retain-audit",
    ] {
        assert!(record.join(name).is_file(), "retained receipt {name}");
    }
    assert!(delivery.patch_path.is_file());
    assert!(delivery.bundle_path.is_file());
    assert_eq!(
        workspace.delivery("complete", "complete-attempt").unwrap(),
        Some(delivery)
    );
    // The external transfer's ownership is the Host's, not this Workspace's.
    assert!(returned.path.is_file());

    let failed = fixture.prepare(&workspace, "failed", &fixture.base).await;
    let exported = workspace
        .export_prepared(&failed, &CancellationToken::new())
        .await
        .unwrap();
    fs::remove_file(&exported.bundle.path).unwrap();
    assert!(workspace.remove_checkout(&failed).is_err());
    workspace.discard_checkout(&failed).unwrap();
    workspace.discard_checkout(&failed).unwrap();
    assert!(!failed.path.exists());
}
