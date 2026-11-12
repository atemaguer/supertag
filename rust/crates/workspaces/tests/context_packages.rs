use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
};
use supertag_workspaces::packages::{capture, materialize};
use tokio_util::sync::CancellationToken;

#[test]
fn package_capture_is_bounded_pinned_and_does_not_follow_links() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let source = root.join("source");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("SKILL.md"), "Review only the requested change.").unwrap();
    fs::set_permissions(source.join("SKILL.md"), fs::Permissions::from_mode(0o644)).unwrap();
    fs::create_dir(source.join("empty")).unwrap();
    let cancel = CancellationToken::new();
    let first = capture(&source, &cancel).unwrap();
    assert!(first.digest.starts_with("sha256:"));
    let destination = root.join("delivery");
    materialize(&first, &destination, &cancel).unwrap();
    assert_eq!(capture(&destination, &cancel).unwrap().digest, first.digest);
    fs::write(source.join("SKILL.md"), "Changed").unwrap();
    assert_ne!(capture(&source, &cancel).unwrap().digest, first.digest);
    assert_eq!(
        fs::read_to_string(destination.join("SKILL.md")).unwrap(),
        "Review only the requested change."
    );
    assert!(materialize(&first, &destination, &cancel).is_err());
    symlink(root.join("delivery"), source.join("linked")).unwrap();
    assert!(capture(&source, &cancel).is_err());
    fs::remove_file(source.join("linked")).unwrap();
    fs::hard_link(source.join("SKILL.md"), root.join("external-link")).unwrap();
    assert!(capture(&source, &cancel).is_err());
    fs::remove_file(root.join("external-link")).unwrap();
    symlink(&source, root.join("alias")).unwrap();
    assert!(capture(&root.join("alias"), &cancel).is_err());
    cancel.cancel();
    assert!(capture(&source, &cancel).is_err());
}

#[test]
fn package_refuses_special_files_deep_paths_and_missing_skill() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let cancel = CancellationToken::new();
    assert!(capture(&root, &cancel).is_err());
    fs::write(root.join("SKILL.md"), "Skill").unwrap();
    let fifo = std::ffi::CString::new(root.join("pipe").to_str().unwrap()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    assert!(capture(&root, &cancel).is_err());
    fs::remove_file(root.join("pipe")).unwrap();
    let mut path = root.clone();
    for _ in 0..34 {
        path = path.join("nested");
        fs::create_dir(&path).unwrap();
    }
    assert!(capture(&root, &cancel).is_err());
}

#[test]
fn package_digest_matches_legacy_format() {
    use sha2::{Digest, Sha256};
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    fs::write(root.join("SKILL.md"), "hello").unwrap();
    fs::set_permissions(root.join("SKILL.md"), fs::Permissions::from_mode(0o644)).unwrap();
    let expected = Sha256::digest(b"directory\0\0file\0SKILL.md\x00420\x005\0hello\0");
    assert_eq!(
        capture(&root, &CancellationToken::new()).unwrap().digest,
        format!("sha256:{expected:x}")
    );
}

#[test]
fn package_rejects_excess_files_and_oversized_content_before_copying() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let cancel = CancellationToken::new();
    fs::write(root.join("SKILL.md"), "Skill").unwrap();
    let large = fs::File::create(root.join("large")).unwrap();
    large
        .set_len(supertag_workspaces::packages::MAX_BYTES as u64 + 1)
        .unwrap();
    assert!(capture(&root, &cancel).is_err());
    fs::remove_file(root.join("large")).unwrap();
    for index in 0..supertag_workspaces::packages::MAX_FILES {
        fs::write(root.join(format!("file-{index}")), "").unwrap();
    }
    assert!(capture(&root, &cancel).is_err());
}
