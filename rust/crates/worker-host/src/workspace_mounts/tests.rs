use super::*;
use std::os::unix::fs::{PermissionsExt, symlink};
use supertag_protocol::v2::{WorkspaceMountWrite, WorkspaceMountWriteStatus, WorkspaceVolume};

struct Fixture {
    _scratch: tempfile::TempDir,
    base: PathBuf,
    source: PathBuf,
    root: PathBuf,
    state: PathBuf,
    checkout: PathBuf,
    mounts: WorkspaceMounts,
}

fn source_url(path: &Path) -> String {
    // Test paths are ASCII apart from names that are never part of a source.
    format!("file://{}", path.display())
}

fn private_dir(path: &Path) {
    fs::create_dir_all(path).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}

fn fixture() -> Fixture {
    let scratch = tempfile::tempdir().unwrap();
    let base = scratch.path().canonicalize().unwrap();
    let source = base.join("source");
    let root = base.join("root");
    let state = base.join("state");
    let checkout = base.join("checkout");
    fs::create_dir_all(source.join("nested")).unwrap();
    fs::write(source.join("rows.csv"), "a,b\n1,2\n").unwrap();
    fs::write(source.join("nested/notes.txt"), "notes").unwrap();
    private_dir(&root);
    private_dir(&state);
    fs::create_dir_all(&checkout).unwrap();
    let mounts = load(&base, &source, &root, &state, &checkout).unwrap();
    Fixture {
        _scratch: scratch,
        base,
        source,
        root,
        state,
        checkout,
        mounts,
    }
}

fn load(
    base: &Path,
    source: &Path,
    root: &Path,
    state: &Path,
    checkout: &Path,
) -> Result<WorkspaceMounts> {
    let config = base.join("mappings.json");
    fs::write(
        &config,
        serde_json::to_vec(&serde_json::json!([{
            "volumeId": "data",
            "source": source_url(source),
            "destinationRoot": root,
        }]))?,
    )?;
    let mut mounts = WorkspaceMounts::load(&config)?;
    mounts.protect(state, &[checkout], None)?;
    Ok(mounts)
}

impl Fixture {
    fn pin(&self, name: &str) -> WorkspaceCopyMount {
        WorkspaceCopyMount {
            volume_id: "data".into(),
            destination: self.root.join(name).to_str().unwrap().into(),
            max_bytes: 1024 * 1024,
            volume: Some(WorkspaceVolume {
                volume_id: "data".into(),
                source: source_url(&self.source),
                revision: 1,
                credential: String::new(),
            }),
            read_write: false,
        }
    }

    fn writable(&self, name: &str, max_bytes: u64) -> WorkspaceCopyMount {
        WorkspaceCopyMount {
            read_write: true,
            max_bytes,
            ..self.pin(name)
        }
    }

    fn stage(&self, attempt: &str, pins: &[WorkspaceCopyMount]) -> Result<Mounted> {
        self.mounts.stage(
            &self.state,
            attempt,
            &self.checkout,
            pins,
            &[],
            &CancellationToken::new(),
        )
    }

    fn root_names(&self) -> Vec<String> {
        let mut names: Vec<_> = fs::read_dir(&self.root)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        names
    }

    fn receipts(&self, attempt: &str) -> PathBuf {
        journal_directory(&self.state, attempt).unwrap()
    }
}

fn mode(path: &Path) -> u32 {
    path.symlink_metadata().unwrap().mode() & 0o777
}

#[test]
fn stages_a_read_only_copy_and_removes_it_with_its_receipts() {
    let fixture = fixture();
    let mounted = fixture.stage("attempt-a", &[fixture.pin("data")]).unwrap();
    let copy = fixture.root.join("data");
    assert_eq!(
        fs::read_to_string(copy.join("rows.csv")).unwrap(),
        "a,b\n1,2\n"
    );
    assert_eq!(
        fs::read_to_string(copy.join("nested/notes.txt")).unwrap(),
        "notes"
    );
    assert_eq!(mode(&copy), 0o500);
    assert_eq!(mode(&copy.join("nested")), 0o500);
    assert_eq!(mode(&copy.join("rows.csv")), 0o400);
    assert!(
        mounted
            .instructions()
            .unwrap()
            .contains(copy.to_str().unwrap())
    );
    // Staging names are never left beside the published copy.
    assert_eq!(fixture.root_names(), ["data"]);
    cleanup(&fixture.state, "attempt-a").unwrap();
    assert!(fixture.root_names().is_empty());
    assert!(!fixture.receipts("attempt-a").exists());
    // The source is never modified.
    assert_eq!(
        fs::read_to_string(fixture.source.join("rows.csv")).unwrap(),
        "a,b\n1,2\n"
    );
    cleanup(&fixture.state, "attempt-a").unwrap();
}

#[test]
fn refuses_links_and_oversized_sources_and_cleans_staging() {
    for (case, prepare) in [
        (
            "symlink",
            Box::new(|source: &Path| symlink("/etc", source.join("escape")).unwrap())
                as Box<dyn Fn(&Path)>,
        ),
        (
            "hard link",
            Box::new(|source: &Path| {
                fs::hard_link(source.join("rows.csv"), source.join("alias")).unwrap()
            }),
        ),
        (
            "reserved",
            Box::new(|source: &Path| fs::create_dir(source.join(".git")).unwrap()),
        ),
    ] {
        let fixture = fixture();
        prepare(&fixture.source);
        assert!(
            fixture.stage("attempt", &[fixture.pin("data")]).is_err(),
            "{case} was copied"
        );
        assert!(!fixture.root.join("data").exists(), "{case}");
        cleanup(&fixture.state, "attempt").unwrap();
        assert!(fixture.root_names().is_empty(), "{case} left staging");
    }
    let fixture = fixture();
    let mut pin = fixture.pin("data");
    pin.max_bytes = 4;
    assert!(fixture.stage("attempt", &[pin]).is_err());
    cleanup(&fixture.state, "attempt").unwrap();
    assert!(fixture.root_names().is_empty());
}

#[test]
fn never_clobbers_an_existing_destination_or_a_competing_attempt() {
    let fixture = fixture();
    // A foreign directory at the destination is left untouched.
    fs::create_dir(fixture.root.join("data")).unwrap();
    fs::write(fixture.root.join("data/keep"), "foreign").unwrap();
    assert!(fixture.stage("attempt-a", &[fixture.pin("data")]).is_err());
    cleanup(&fixture.state, "attempt-a").unwrap();
    assert_eq!(
        fs::read_to_string(fixture.root.join("data/keep")).unwrap(),
        "foreign"
    );
    fs::remove_dir_all(fixture.root.join("data")).unwrap();

    // Two Attempts racing for one destination: exactly one publishes, and the
    // loser's cleanup never removes the winner's copy.
    let barrier = std::sync::Barrier::new(2);
    let results: Vec<bool> = std::thread::scope(|scope| {
        let handles: Vec<_> = ["attempt-b", "attempt-c"]
            .into_iter()
            .map(|attempt| {
                let fixture = &fixture;
                let barrier = &barrier;
                scope.spawn(move || {
                    barrier.wait();
                    fixture.stage(attempt, &[fixture.pin("data")]).is_ok()
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect()
    });
    assert_eq!(results.iter().filter(|won| **won).count(), 1, "{results:?}");
    let (winner, loser) = if results[0] {
        ("attempt-b", "attempt-c")
    } else {
        ("attempt-c", "attempt-b")
    };
    cleanup(&fixture.state, loser).unwrap();
    assert_eq!(fixture.root_names(), ["data"]);
    assert_eq!(
        fs::read_to_string(fixture.root.join("data/rows.csv")).unwrap(),
        "a,b\n1,2\n"
    );
    cleanup(&fixture.state, winner).unwrap();
    assert!(fixture.root_names().is_empty());
}

#[test]
fn case_and_unicode_aliases_cannot_replace_a_published_copy() {
    let fixture = fixture();
    // Detect the filesystem's alias behavior instead of assuming it.
    fs::write(fixture.base.join("Probe-é"), "").unwrap();
    let case_insensitive = fixture.base.join("probe-é").exists();
    let normalization_insensitive = fixture.base.join("Probe-e\u{301}").exists();
    fixture.stage("attempt-a", &[fixture.pin("Café")]).unwrap();
    for alias in ["café", "Cafe\u{301}", "CAFÉ"] {
        let aliased = fixture.base.join("root").join(alias).exists();
        let staged = fixture.stage("attempt-b", &[fixture.pin(alias)]);
        // An alias of the published copy is occupied; a distinct name stages.
        assert_eq!(staged.is_err(), aliased, "{alias}");
        cleanup(&fixture.state, "attempt-b").unwrap();
    }
    assert!(fixture.root.join("Café").join("rows.csv").exists());
    cleanup(&fixture.state, "attempt-a").unwrap();
    assert!(fixture.root_names().is_empty());
    if cfg!(target_os = "macos") {
        // Shared protocol validation folds both aliases on macOS.
        let mut pair = [fixture.pin("Café"), fixture.pin("cafe\u{301}")];
        assert!(supertag_protocol::workspace_mounts::normalize_mounts(&mut pair).is_err());
    }
    eprintln!(
        "case-insensitive={case_insensitive} normalization-insensitive={normalization_insensitive}"
    );
}

#[test]
fn rejects_paths_outside_the_exact_mapping() {
    let fixture = fixture();
    for destination in [
        format!("{}/nested/data", fixture.root.display()),
        format!("{}/../data", fixture.root.display()),
        format!("{}/./data", fixture.root.display()),
        format!("{}/.data", fixture.root.display()),
        "relative/data".into(),
        fixture
            .base
            .join("other")
            .join("data")
            .display()
            .to_string(),
    ] {
        let mut pin = fixture.pin("data");
        pin.destination = destination.clone();
        assert!(fixture.stage("attempt", &[pin]).is_err(), "{destination}");
    }
    // A pin naming a different source than the host mapping is refused.
    let mut pin = fixture.pin("data");
    pin.volume.as_mut().unwrap().source = source_url(&fixture.base);
    assert!(fixture.stage("attempt", &[pin]).is_err());
    // An unfrozen pin is refused.
    let mut pin = fixture.pin("data");
    pin.volume = None;
    assert!(fixture.stage("attempt", &[pin]).is_err());
    cleanup(&fixture.state, "attempt").unwrap();
    assert!(fixture.root_names().is_empty());
}

#[test]
fn mapping_load_rejects_aliases_and_protected_storage() {
    let fixture = fixture();
    let link = fixture.base.join("root-link");
    symlink(&fixture.root, &link).unwrap();
    // A symbolic-link root is not canonical.
    assert!(
        load(
            &fixture.base,
            &fixture.source,
            &link,
            &fixture.state,
            &fixture.checkout
        )
        .is_err()
    );
    // A group-readable root is not private.
    let open = fixture.base.join("open");
    fs::create_dir(&open).unwrap();
    fs::set_permissions(&open, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(
        load(
            &fixture.base,
            &fixture.source,
            &open,
            &fixture.state,
            &fixture.checkout
        )
        .is_err()
    );
    // Sources and roots may not overlap Host state or the repository.
    let inside_state = fixture.state.join("data");
    private_dir(&inside_state);
    assert!(
        load(
            &fixture.base,
            &inside_state,
            &fixture.root,
            &fixture.state,
            &fixture.checkout
        )
        .is_err()
    );
    assert!(
        load(
            &fixture.base,
            &fixture.source,
            &inside_state,
            &fixture.state,
            &fixture.checkout
        )
        .is_err()
    );
    assert!(
        load(
            &fixture.base,
            &fixture.checkout,
            &fixture.root,
            &fixture.state,
            &fixture.checkout
        )
        .is_err()
    );
    // A disclosed artifact Volume path that overlaps a mapping is refused.
    let pins = [fixture.pin("data")];
    assert!(
        fixture
            .mounts
            .preflight(
                &pins,
                WorkspaceMountPreflight {
                    protected_file_sources: vec![source_url(&fixture.source.join("artifacts"))],
                },
            )
            .is_err()
    );
    assert!(
        fixture
            .mounts
            .preflight(
                &pins,
                WorkspaceMountPreflight {
                    protected_file_sources: vec![source_url(&fixture.base.join("artifacts"))],
                },
            )
            .is_ok()
    );
}

#[test]
fn a_replaced_root_is_never_written_or_cleaned() {
    let fixture = fixture();
    let moved = fixture.base.join("root-old");
    let elsewhere = fixture.base.join("elsewhere");
    private_dir(&elsewhere);
    fs::rename(&fixture.root, &moved).unwrap();
    symlink(&elsewhere, &fixture.root).unwrap();
    assert!(fixture.stage("attempt", &[fixture.pin("data")]).is_err());
    fs::remove_file(&fixture.root).unwrap();
    // A fresh private directory at the same path is a different identity.
    private_dir(&fixture.root);
    assert!(fixture.stage("attempt", &[fixture.pin("data")]).is_err());
    assert!(fs::read_dir(&elsewhere).unwrap().next().is_none());
    assert!(fs::read_dir(&fixture.root).unwrap().next().is_none());
    assert!(fs::read_dir(&moved).unwrap().next().is_none());
    cleanup(&fixture.state, "attempt").unwrap();

    // Replacing the root after publication leaves the copy in the moved root.
    let fixture = self::fixture();
    fixture.stage("attempt", &[fixture.pin("data")]).unwrap();
    let moved = fixture.base.join("root-moved");
    fs::rename(&fixture.root, &moved).unwrap();
    private_dir(&fixture.root);
    fs::create_dir(fixture.root.join("data")).unwrap();
    fs::write(fixture.root.join("data/keep"), "new").unwrap();
    cleanup(&fixture.state, "attempt").unwrap();
    assert_eq!(
        fs::read_to_string(fixture.root.join("data/keep")).unwrap(),
        "new"
    );
    assert!(moved.join("data/rows.csv").exists());
    assert!(!fixture.receipts("attempt").exists());
    let _ = fs::set_permissions(moved.join("data"), fs::Permissions::from_mode(0o700));
    let _ = fs::set_permissions(moved.join("data/nested"), fs::Permissions::from_mode(0o700));
}

#[test]
fn a_replaced_destination_is_not_removed() {
    let fixture = fixture();
    fixture.stage("attempt", &[fixture.pin("data")]).unwrap();
    // Someone swaps the published copy for a link to other data.
    let elsewhere = fixture.base.join("elsewhere");
    fs::create_dir(&elsewhere).unwrap();
    fs::write(elsewhere.join("keep"), "x").unwrap();
    fs::set_permissions(fixture.root.join("data"), fs::Permissions::from_mode(0o700)).unwrap();
    fs::rename(fixture.root.join("data"), fixture.base.join("published")).unwrap();
    symlink(&elsewhere, fixture.root.join("data")).unwrap();
    cleanup(&fixture.state, "attempt").unwrap();
    assert!(elsewhere.join("keep").exists());
    assert!(
        fixture
            .root
            .join("data")
            .symlink_metadata()
            .unwrap()
            .is_symlink()
    );
    let _ = fs::set_permissions(
        fixture.base.join("published"),
        fs::Permissions::from_mode(0o700),
    );
    let _ = fs::set_permissions(
        fixture.base.join("published/nested"),
        fs::Permissions::from_mode(0o700),
    );
}

/// Simulate a crash at each point between the journaled receipt and the
/// published copy, then recover with ordinary cleanup.
#[test]
fn recovers_from_crashes_before_and_during_the_ownership_marker() {
    for marker in [None, Some(0), Some(10), Some(36)] {
        let fixture = fixture();
        let receipts = fixture.receipts("attempt");
        private_dir(&receipts);
        let token = uuid::Uuid::new_v4().to_string();
        let root = open_directory(&fixture.root).unwrap();
        let entry = Receipt {
            destination: fixture.root.join("data"),
            staging: format!("{STAGING_PREFIX}{}", uuid::Uuid::new_v4().simple()),
            token: token.clone(),
            root_device: identity(&root).unwrap().0,
            root_inode: identity(&root).unwrap().1,
            volume_id: "data".into(),
            source: source_url(&fixture.source),
            read_write: false,
            max_bytes: 1,
        };
        save_receipt(&receipts.join("0.json"), &entry).unwrap();
        // Also leave the temporary file an interrupted receipt write creates.
        fs::write(receipts.join(".tmpABC"), "partial").unwrap();
        let staging = fixture.root.join(&entry.staging);
        private_dir(&staging);
        if let Some(length) = marker {
            fs::write(staging.join(MARKER), &token.as_bytes()[..length]).unwrap();
        }
        cleanup(&fixture.state, "attempt").unwrap();
        assert!(fixture.root_names().is_empty(), "marker {marker:?}");
        assert!(!receipts.exists());
    }
    // A staging name holding anything besides a partial marker is not ours.
    let fixture = fixture();
    let receipts = fixture.receipts("attempt");
    private_dir(&receipts);
    let root = open_directory(&fixture.root).unwrap();
    let entry = Receipt {
        destination: fixture.root.join("data"),
        staging: format!("{STAGING_PREFIX}{}", uuid::Uuid::new_v4().simple()),
        token: uuid::Uuid::new_v4().to_string(),
        root_device: identity(&root).unwrap().0,
        root_inode: identity(&root).unwrap().1,
        volume_id: "data".into(),
        source: source_url(&fixture.source),
        read_write: false,
        max_bytes: 1,
    };
    save_receipt(&receipts.join("0.json"), &entry).unwrap();
    let staging = fixture.root.join(&entry.staging);
    private_dir(&staging);
    fs::write(staging.join("foreign"), "keep").unwrap();
    cleanup(&fixture.state, "attempt").unwrap();
    assert!(staging.join("foreign").exists());
}

#[test]
fn a_restarted_attempt_restages_and_cancellation_leaves_nothing() {
    let fixture = fixture();
    fixture.stage("attempt", &[fixture.pin("data")]).unwrap();
    // A Host restart in PreparingInputs stages the same Attempt again.
    fixture.stage("attempt", &[fixture.pin("data")]).unwrap();
    assert_eq!(fixture.root_names(), ["data"]);
    cleanup(&fixture.state, "attempt").unwrap();
    assert!(fixture.root_names().is_empty());

    let cancel = CancellationToken::new();
    cancel.cancel();
    assert!(
        fixture
            .mounts
            .stage(
                &fixture.state,
                "cancelled",
                &fixture.checkout,
                &[fixture.pin("data")],
                &[],
                &cancel,
            )
            .is_err()
    );
    cleanup(&fixture.state, "cancelled").unwrap();
    assert!(fixture.root_names().is_empty());
}

#[test]
fn large_and_sparse_copies_stream_within_typescript_limits() {
    use supertag_protocol::workspace_mounts::{
        DEFAULT_WORKSPACE_MOUNT_BYTES, MAX_WORKSPACE_MOUNT_BYTES, MAX_WORKSPACE_MOUNT_FILES,
    };
    let fixture = fixture();
    // A sparse file above the former 256 MiB cap is copied and written back through
    // fixed-size buffers under the 1 GiB default.
    let large = 300 * 1024 * 1024;
    let file = File::create(fixture.source.join("large.bin")).unwrap();
    file.set_len(large).unwrap();
    drop(file);
    fixture
        .stage(
            "large",
            &[fixture.writable("data", DEFAULT_WORKSPACE_MOUNT_BYTES)],
        )
        .unwrap();
    let copy = fixture.root.join("data");
    assert_eq!(copy.join("large.bin").metadata().unwrap().len(), large);
    {
        use std::os::unix::fs::FileExt;
        let file = fs::OpenOptions::new()
            .write(true)
            .open(copy.join("large.bin"))
            .unwrap();
        file.write_all_at(b"end", large - 3).unwrap();
    }
    let writes = write_back(
        &fixture.mounts,
        &fixture.state,
        "large",
        &CancellationToken::new(),
    )
    .unwrap();
    assert_eq!(status(&writes[0]), WorkspaceMountWriteStatus::Complete);
    assert_eq!(keys(&writes[0]), ["large.bin"]);
    {
        use std::os::unix::fs::FileExt;
        let written = File::open(fixture.source.join("large.bin")).unwrap();
        assert_eq!(written.metadata().unwrap().len(), large);
        let mut tail = [0u8; 3];
        written.read_exact_at(&mut tail, large - 3).unwrap();
        assert_eq!(&tail, b"end");
    }
    cleanup(&fixture.state, "large").unwrap();
    fs::remove_file(fixture.source.join("large.bin")).unwrap();

    // A sparse file beyond 20 GiB is refused before any byte is read, even under the largest
    // declared limit.
    let file = File::create(fixture.source.join("huge.bin")).unwrap();
    file.set_len(MAX_WORKSPACE_MOUNT_BYTES + 1).unwrap();
    drop(file);
    let mut pin = fixture.pin("data");
    pin.max_bytes = MAX_WORKSPACE_MOUNT_BYTES;
    assert!(fixture.stage("huge", &[pin]).is_err());
    cleanup(&fixture.state, "huge").unwrap();
    assert!(fixture.root_names().is_empty());
    fs::remove_file(fixture.source.join("huge.bin")).unwrap();

    // TypeScript's 10,000-file limit: one more file is refused.
    let many = fixture.source.join("many");
    fs::create_dir(&many).unwrap();
    // The fixture source already holds two files.
    for index in 0..MAX_WORKSPACE_MOUNT_FILES - 2 {
        fs::write(many.join(index.to_string()), "").unwrap();
    }
    fixture.stage("many", &[fixture.pin("data")]).unwrap();
    cleanup(&fixture.state, "many").unwrap();
    fs::write(many.join("one-more"), "").unwrap();
    let refused = fixture.stage("too-many", &[fixture.pin("data")]);
    assert!(
        format!("{:#}", refused.err().unwrap()).contains("file limit"),
        "a copy over 10,000 files is refused"
    );
    cleanup(&fixture.state, "too-many").unwrap();
    assert!(fixture.root_names().is_empty());
}

#[test]
fn write_back_refuses_a_file_over_five_gib() {
    let fixture = fixture();
    let max = supertag_protocol::workspace_mounts::MAX_WORKSPACE_MOUNT_BYTES;
    fixture
        .stage("attempt", &[fixture.writable("data", max)])
        .unwrap();
    let copy = fixture.root.join("data");
    let file = File::create(copy.join("over.bin")).unwrap();
    file.set_len(supertag_protocol::workspace_mounts::MAX_WRITE_FILE_BYTES + 1)
        .unwrap();
    drop(file);
    let writes = write_back(
        &fixture.mounts,
        &fixture.state,
        "attempt",
        &CancellationToken::new(),
    )
    .unwrap();
    assert_eq!(status(&writes[0]), WorkspaceMountWriteStatus::Refused);
    assert_eq!(writes[0].error_key, "over.bin");
    assert!(!fixture.source.join("over.bin").exists());
    cleanup(&fixture.state, "attempt").unwrap();
}

#[test]
fn remote_listings_replace_the_walk_and_captured_files_are_written_back() {
    let fixture = fixture();
    let mounted = fixture
        .stage("remote", &[fixture.writable("data", 1024 * 1024)])
        .unwrap();
    let [copy] = mounted.copies() else {
        panic!("one copy staged")
    };
    assert!(copy.read_write);
    assert_eq!(
        copy.sandbox_path("remote"),
        format!(
            "{}/data",
            supertag_protocol::workspace_mounts::remote_copy_root("remote")
        )
    );
    let mut staged: Vec<_> = copy.files.iter().map(|file| file.key.as_str()).collect();
    staged.sort_unstable();
    assert_eq!(staged, ["nested/notes.txt", "rows.csv"]);
    assert!(
        mounted
            .remote_instructions("remote")
            .unwrap()
            .contains("relative to the remote Workspace")
    );
    let file = |key: &str, body: &[u8]| Copied {
        key: key.into(),
        size: body.len() as u64,
        sha256: format!("{:x}", Sha256::digest(body)),
    };
    let send = |file: &Copied, chunks: &[&[u8]]| {
        let writer = remote_writer(&fixture.mounts, &fixture.state, "remote", copy.index).unwrap();
        let (sender, mut receiver) = tokio::sync::mpsc::channel(8);
        for chunk in chunks {
            sender.try_send(chunk.to_vec()).unwrap();
        }
        drop(sender);
        writer.write(file, &mut receiver)
    };
    // Bytes that differ from their listing never replace the host copy.
    assert!(send(&file("rows.csv", b"x\ny\n"), &[b"x\nz\n"]).is_err());
    let copy_root = fixture.root.join("data");
    assert_eq!(
        fs::read_to_string(copy_root.join("rows.csv")).unwrap(),
        "a,b\n1,2\n"
    );
    let changed = [file("deep/new.txt", b"new\n"), file("rows.csv", b"x\ny\n")];
    send(&changed[0], &[b"ne", b"w\n"]).unwrap();
    send(&changed[1], &[b"x\ny\n"]).unwrap();
    record_remote(
        &fixture.state,
        "remote",
        copy.index,
        &RemoteListing {
            files: changed.to_vec(),
            skipped: 3,
            refusal: None,
        },
    )
    .unwrap();
    let writes = write_back(
        &fixture.mounts,
        &fixture.state,
        "remote",
        &CancellationToken::new(),
    )
    .unwrap();
    assert_eq!(status(&writes[0]), WorkspaceMountWriteStatus::Complete);
    assert_eq!(keys(&writes[0]), ["deep/new.txt", "rows.csv"]);
    assert_eq!(writes[0].skipped, 3, "the sandbox's count");
    assert_eq!(
        fs::read_to_string(fixture.source.join("rows.csv")).unwrap(),
        "x\ny\n"
    );
    assert_eq!(
        fs::read_to_string(fixture.source.join("deep/new.txt")).unwrap(),
        "new\n"
    );
    cleanup(&fixture.state, "remote").unwrap();

    // A refusal the sandbox found refuses the copy with its key and reason.
    let mounted = fixture
        .stage("refused", &[fixture.writable("data", 1024 * 1024)])
        .unwrap();
    record_remote(
        &fixture.state,
        "refused",
        mounted.copies()[0].index,
        &RemoteListing {
            files: vec![file("a.txt", b"a")],
            skipped: 0,
            refusal: Some(("b.txt".into(), "a file has another link or changed".into())),
        },
    )
    .unwrap();
    assert!(
        !RemoteListing {
            files: vec![],
            skipped: 0,
            refusal: Some(("b.txt".into(), "x".into())),
        }
        .writable(1024)
    );
    let writes = write_back(
        &fixture.mounts,
        &fixture.state,
        "refused",
        &CancellationToken::new(),
    )
    .unwrap();
    assert_eq!(status(&writes[0]), WorkspaceMountWriteStatus::Refused);
    assert_eq!(writes[0].error_key, "b.txt");
    assert_eq!(writes[0].not_attempted, ["a.txt", "b.txt"]);
    assert!(!fixture.source.join("a.txt").exists());
    cleanup(&fixture.state, "refused").unwrap();
    assert!(fixture.root_names().is_empty());
}

fn status(write: &WorkspaceMountWrite) -> WorkspaceMountWriteStatus {
    WorkspaceMountWriteStatus::try_from(write.status).unwrap()
}

fn keys(write: &WorkspaceMountWrite) -> Vec<&str> {
    write.files.iter().map(|file| file.key.as_str()).collect()
}

#[test]
fn read_write_copies_write_changed_and_created_files_back_once() {
    let fixture = fixture();
    let mounted = fixture
        .stage("attempt", &[fixture.writable("data", 1024 * 1024)])
        .unwrap();
    let copy = fixture.root.join("data");
    assert!(
        mounted
            .instructions()
            .unwrap()
            .contains("Read-write Workspace data")
    );
    assert_eq!(mode(&copy), 0o700);
    assert_eq!(mode(&copy.join("nested")), 0o700);
    assert_eq!(mode(&copy.join("rows.csv")), 0o600);
    // The Task changes one file, creates two, deletes one, adds a link,
    // and even removes the ownership marker.
    fs::write(copy.join("rows.csv"), "a,b\n1,3\n").unwrap();
    fs::create_dir_all(copy.join("deep/er")).unwrap();
    fs::write(copy.join("deep/er/new.txt"), "new").unwrap();
    fs::write(copy.join("nested/added.txt"), "added").unwrap();
    fs::remove_file(copy.join("nested/notes.txt")).unwrap();
    symlink("/etc/hosts", copy.join("link")).unwrap();
    fs::remove_file(copy.join(MARKER)).unwrap();
    let writes = write_back(
        &fixture.mounts,
        &fixture.state,
        "attempt",
        &CancellationToken::new(),
    )
    .unwrap();
    assert_eq!(writes.len(), 1);
    let write = &writes[0];
    assert_eq!(status(write), WorkspaceMountWriteStatus::Complete);
    assert_eq!(write.volume_id, "data");
    assert_eq!(write.destination, copy.to_str().unwrap());
    let mut written = keys(write);
    written.sort();
    assert_eq!(written, ["deep/er/new.txt", "nested/added.txt", "rows.csv"]);
    assert_eq!(write.skipped, 1, "the link is skipped");
    assert_eq!(
        write
            .files
            .iter()
            .find(|file| file.key == "rows.csv")
            .unwrap()
            .sha256,
        format!("{:x}", Sha256::digest(b"a,b\n1,3\n"))
    );
    assert_eq!(
        fs::read_to_string(fixture.source.join("rows.csv")).unwrap(),
        "a,b\n1,3\n"
    );
    assert_eq!(
        fs::read_to_string(fixture.source.join("deep/er/new.txt")).unwrap(),
        "new"
    );
    // Deletions and links are never written back.
    assert!(fixture.source.join("nested/notes.txt").exists());
    assert!(!fixture.source.join("link").exists());
    // A retry after a restart reports the journaled summary without writing.
    fs::write(fixture.source.join("rows.csv"), "operator edit").unwrap();
    let again = write_back(
        &fixture.mounts,
        &fixture.state,
        "attempt",
        &CancellationToken::new(),
    )
    .unwrap();
    assert_eq!(again, writes);
    assert_eq!(
        fs::read_to_string(fixture.source.join("rows.csv")).unwrap(),
        "operator edit"
    );
    // Cleanup recognizes the copy by identity even without its marker.
    cleanup(&fixture.state, "attempt").unwrap();
    assert!(fixture.root_names().is_empty());
}

#[test]
fn write_back_refuses_over_bounds_and_stops_at_the_first_failure() {
    let fixture = fixture();
    // Read-only copies are never written back.
    fixture.stage("read-only", &[fixture.pin("data")]).unwrap();
    assert!(
        write_back(
            &fixture.mounts,
            &fixture.state,
            "read-only",
            &CancellationToken::new()
        )
        .unwrap()
        .is_empty()
    );
    cleanup(&fixture.state, "read-only").unwrap();

    fixture
        .stage("refused", &[fixture.writable("data", 64)])
        .unwrap();
    let copy = fixture.root.join("data");
    fs::write(copy.join("big.bin"), vec![b'x'; 65]).unwrap();
    let refused = write_back(
        &fixture.mounts,
        &fixture.state,
        "refused",
        &CancellationToken::new(),
    )
    .unwrap();
    assert_eq!(status(&refused[0]), WorkspaceMountWriteStatus::Refused);
    assert_eq!(refused[0].error_key, "big.bin");
    assert_eq!(refused[0].not_attempted, ["big.bin"]);
    assert!(refused[0].files.is_empty());
    assert!(!fixture.source.join("big.bin").exists());
    cleanup(&fixture.state, "refused").unwrap();

    fixture
        .stage("partial", &[fixture.writable("data", 1024)])
        .unwrap();
    fs::write(copy.join("a.txt"), "a").unwrap();
    fs::create_dir(copy.join("blocked")).unwrap();
    fs::write(copy.join("blocked/x.txt"), "x").unwrap();
    fs::write(copy.join("c.txt"), "c").unwrap();
    // A file in the Volume is in the way of the new directory.
    fs::write(fixture.source.join("blocked"), "file").unwrap();
    let partial = write_back(
        &fixture.mounts,
        &fixture.state,
        "partial",
        &CancellationToken::new(),
    )
    .unwrap();
    let write = &partial[0];
    assert_eq!(status(write), WorkspaceMountWriteStatus::Partial);
    assert_eq!(keys(write), ["a.txt"]);
    assert_eq!(write.error_key, "blocked/x.txt");
    assert_eq!(write.not_attempted, ["blocked/x.txt", "c.txt"]);
    assert!(!fixture.source.join("c.txt").exists());
    assert!(
        supertag_protocol::workspace_mounts::validate_writes(
            &partial,
            &[fixture.writable("data", 1024)]
        )
        .is_ok()
    );
    cleanup(&fixture.state, "partial").unwrap();
}

#[test]
fn write_back_refuses_names_and_links_it_cannot_write_instead_of_dropping_them() {
    let fixture = fixture();
    let copy = fixture.root.join("data");
    let refuse = |attempt: &str, change: &dyn Fn(), key: &str, reason: &str| {
        fixture
            .stage(attempt, &[fixture.writable("data", 1024)])
            .unwrap();
        fs::write(copy.join("a.txt"), "a").unwrap();
        change();
        let writes = write_back(
            &fixture.mounts,
            &fixture.state,
            attempt,
            &CancellationToken::new(),
        )
        .unwrap();
        assert_eq!(status(&writes[0]), WorkspaceMountWriteStatus::Refused);
        assert_eq!(writes[0].error_key, key, "{attempt}");
        assert!(writes[0].error_reason.contains(reason), "{attempt}");
        assert!(writes[0].files.is_empty());
        assert!(!fixture.source.join("a.txt").exists(), "{attempt}");
        assert!(
            supertag_protocol::workspace_mounts::validate_writes(
                &writes,
                &[fixture.writable("data", 1024)]
            )
            .is_ok(),
            "{attempt}"
        );
        cleanup(&fixture.state, attempt).unwrap();
    };
    refuse(
        "git",
        &|| {
            fs::create_dir_all(copy.join("nested/.git")).unwrap();
            fs::write(copy.join("nested/.git/HEAD"), "ref").unwrap();
        },
        "nested",
        "file name",
    );
    refuse(
        "reserved",
        &|| fs::write(copy.join(".supertag-x"), "x").unwrap(),
        "",
        "file name",
    );
    refuse(
        "hardlink",
        &|| fs::hard_link(copy.join("a.txt"), copy.join("b.txt")).unwrap(),
        "a.txt",
        "another link",
    );
    refuse(
        "deep",
        &|| {
            let deep = (0..=MAX_DEPTH).fold(copy.clone(), |path, n| path.join(format!("d{n}")));
            fs::create_dir_all(&deep).unwrap();
        },
        &(0..=MAX_DEPTH)
            .map(|n| format!("d{n}"))
            .collect::<Vec<_>>()
            .join("/"),
        "too deeply",
    );
}

#[test]
fn a_rewrite_after_a_restart_replaces_the_interrupted_temporary_file() {
    let fixture = fixture();
    fixture
        .stage("attempt", &[fixture.writable("data", 1024)])
        .unwrap();
    fs::write(fixture.root.join("data/nested/new.txt"), "new").unwrap();
    let receipt: serde_json::Value =
        serde_json::from_slice(&fs::read(fixture.receipts("attempt").join("0.json")).unwrap())
            .unwrap();
    let token = receipt["token"].as_str().unwrap();
    let digest = Sha256::digest(format!("{token}\0nested/new.txt").as_bytes());
    let leftover = fixture
        .source
        .join(format!("nested/{STAGING_PREFIX}write-{digest:x}"));
    fs::write(&leftover, "interrupted").unwrap();
    let writes = write_back(
        &fixture.mounts,
        &fixture.state,
        "attempt",
        &CancellationToken::new(),
    )
    .unwrap();
    assert_eq!(status(&writes[0]), WorkspaceMountWriteStatus::Complete);
    assert!(!leftover.exists());
    assert_eq!(
        fs::read_to_string(fixture.source.join("nested/new.txt")).unwrap(),
        "new"
    );
    cleanup(&fixture.state, "attempt").unwrap();
}

#[test]
fn write_back_never_follows_a_link_in_the_volume() {
    let fixture = fixture();
    fixture
        .stage("attempt", &[fixture.writable("data", 1024)])
        .unwrap();
    let outside = fixture.base.join("outside");
    fs::create_dir(&outside).unwrap();
    // The Volume's directory is swapped for a link after the copy.
    fs::remove_dir_all(fixture.source.join("nested")).unwrap();
    symlink(&outside, fixture.source.join("nested")).unwrap();
    fs::write(fixture.root.join("data/nested/escape.txt"), "x").unwrap();
    let writes = write_back(
        &fixture.mounts,
        &fixture.state,
        "attempt",
        &CancellationToken::new(),
    )
    .unwrap();
    assert_eq!(status(&writes[0]), WorkspaceMountWriteStatus::Partial);
    assert_eq!(writes[0].error_key, "nested/escape.txt");
    assert!(fs::read_dir(&outside).unwrap().next().is_none());
    cleanup(&fixture.state, "attempt").unwrap();
}

mod object_store {
    use super::*;
    use crate::workspace_mounts::s3::fake;

    struct S3Fixture {
        _scratch: tempfile::TempDir,
        root: PathBuf,
        state: PathBuf,
        checkout: PathBuf,
        mounts: WorkspaceMounts,
        store: fake::Store,
    }

    async fn s3_fixture() -> S3Fixture {
        let scratch = tempfile::tempdir().unwrap();
        let base = scratch.path().canonicalize().unwrap();
        let root = base.join("root");
        let state = base.join("state");
        let checkout = base.join("checkout");
        private_dir(&root);
        private_dir(&state);
        fs::create_dir_all(&checkout).unwrap();
        let store = fake::Store::default();
        {
            let mut objects = store.objects.lock().unwrap();
            for (key, value) in [
                ("bucket-a/data/rows.csv", "a,b\n1,2\n"),
                ("bucket-a/data/nested/notes.txt", "notes"),
                ("bucket-a/data/nested/more/deep.txt", "deep"),
                ("bucket-a/data/folder/", ""),
                ("bucket-a/database/outside.txt", "not under the prefix"),
            ] {
                objects.insert(key.into(), value.as_bytes().to_vec());
            }
        }
        let endpoint = fake::start(store.clone()).await;
        // SAFETY: the variables are unique to this test module.
        unsafe {
            std::env::set_var("WSMOUNT_TEST_ACCESS_KEY_ID", "FIXTUREKEY");
            std::env::set_var("WSMOUNT_TEST_SECRET_ACCESS_KEY", "fixture-secret");
        }
        let config = base.join("mappings.json");
        fs::write(
            &config,
            serde_json::to_vec(&serde_json::json!([{
                "volumeId": "data",
                "source": "s3://bucket-a/data",
                "credential": "team-data",
                "endpoint": endpoint,
                "region": "us-east-1",
                "credentialEnvPrefix": "WSMOUNT_TEST",
                "destinationRoot": root,
            }]))
            .unwrap(),
        )
        .unwrap();
        let mut mounts = WorkspaceMounts::load(&config).unwrap();
        mounts.protect(&state, &[&checkout], None).unwrap();
        assert_eq!(mounts.capabilities()[0].credential, "team-data");
        S3Fixture {
            _scratch: scratch,
            root,
            state,
            checkout,
            mounts,
            store,
        }
    }

    impl S3Fixture {
        fn pin(&self, read_write: bool, credential: &str) -> WorkspaceCopyMount {
            WorkspaceCopyMount {
                volume_id: "data".into(),
                destination: self.root.join("data").to_str().unwrap().into(),
                max_bytes: 16 * 1024 * 1024,
                volume: Some(WorkspaceVolume {
                    volume_id: "data".into(),
                    source: "s3://bucket-a/data".into(),
                    revision: 1,
                    credential: credential.into(),
                }),
                read_write,
            }
        }

        async fn stage(&self, attempt: &str, pin: WorkspaceCopyMount) -> Result<()> {
            let mounts = self.mounts.clone();
            let (state, checkout, attempt) = (
                self.state.clone(),
                self.checkout.clone(),
                attempt.to_owned(),
            );
            tokio::task::spawn_blocking(move || {
                mounts
                    .stage(
                        &state,
                        &attempt,
                        &checkout,
                        &[pin],
                        &[],
                        &CancellationToken::new(),
                    )
                    .map(|_| ())
            })
            .await
            .unwrap()
        }

        async fn write_back(&self, attempt: &str) -> Vec<WorkspaceMountWrite> {
            let mounts = self.mounts.clone();
            let (state, attempt) = (self.state.clone(), attempt.to_owned());
            tokio::task::spawn_blocking(move || {
                write_back(&mounts, &state, &attempt, &CancellationToken::new())
            })
            .await
            .unwrap()
            .unwrap()
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn s3_copies_list_every_page_and_write_changes_back() {
        let fixture = s3_fixture().await;
        let copy = fixture.root.join("data");
        // The pin must name the mapped credential.
        assert!(
            fixture
                .stage("wrong", fixture.pin(false, "other"))
                .await
                .is_err()
        );
        cleanup(&fixture.state, "wrong").unwrap();

        fixture
            .stage("read", fixture.pin(false, "team-data"))
            .await
            .unwrap();
        assert_eq!(
            fs::read_to_string(copy.join("rows.csv")).unwrap(),
            "a,b\n1,2\n"
        );
        assert_eq!(
            fs::read_to_string(copy.join("nested/more/deep.txt")).unwrap(),
            "deep"
        );
        assert!(!copy.join("folder").exists() && !copy.join("outside.txt").exists());
        assert_eq!(mode(&copy), 0o500);
        assert_eq!(mode(&copy.join("nested/more")), 0o500);
        assert_eq!(mode(&copy.join("rows.csv")), 0o400);
        assert!(fixture.write_back("read").await.is_empty());
        cleanup(&fixture.state, "read").unwrap();
        assert!(!copy.exists());

        fixture
            .stage("write", fixture.pin(true, "team-data"))
            .await
            .unwrap();
        fs::write(copy.join("rows.csv"), "changed").unwrap();
        fs::write(copy.join("nested/new.txt"), "created").unwrap();
        fs::write(copy.join("bad name+é.txt"), "any key").unwrap();
        // Bodies stream in bounded chunks: a file of many chunks arrives whole.
        let large: Vec<u8> = (0..3 * 1024 * 1024 + 7)
            .map(|index| (index % 251) as u8)
            .collect();
        fs::write(copy.join("large.bin"), &large).unwrap();
        let writes = fixture.write_back("write").await;
        assert_eq!(status(&writes[0]), WorkspaceMountWriteStatus::Complete);
        let mut written = keys(&writes[0]);
        written.sort();
        assert_eq!(
            written,
            ["bad name+é.txt", "large.bin", "nested/new.txt", "rows.csv"]
        );
        assert_eq!(writes[0].skipped, 2, "two unchanged files");
        {
            let objects = fixture.store.objects.lock().unwrap();
            assert_eq!(objects["bucket-a/data/large.bin"], large);
            assert_eq!(objects["bucket-a/data/rows.csv"], b"changed");
            assert_eq!(objects["bucket-a/data/nested/new.txt"], b"created");
            assert_eq!(objects["bucket-a/data/bad name+é.txt"], b"any key");
        }
        cleanup(&fixture.state, "write").unwrap();

        // A refused PUT stops the write-back as partial.
        fixture
            .stage("fail", fixture.pin(true, "team-data"))
            .await
            .unwrap();
        fs::write(copy.join("a.txt"), "a").unwrap();
        fs::write(copy.join("z.txt"), "z").unwrap();
        fixture
            .store
            .fail_puts
            .lock()
            .unwrap()
            .push("bucket-a/data/a.txt".into());
        let writes = fixture.write_back("fail").await;
        assert_eq!(status(&writes[0]), WorkspaceMountWriteStatus::Partial);
        assert_eq!(writes[0].error_key, "a.txt");
        assert_eq!(writes[0].not_attempted, ["a.txt", "z.txt"]);
        assert!(
            !fixture
                .store
                .objects
                .lock()
                .unwrap()
                .contains_key("bucket-a/data/z.txt")
        );
        cleanup(&fixture.state, "fail").unwrap();
    }

    #[test]
    fn s3_mappings_need_their_connection_and_file_mappings_take_none() {
        let scratch = tempfile::tempdir().unwrap();
        let base = scratch.path().canonicalize().unwrap();
        let root = base.join("root");
        private_dir(&root);
        let config = base.join("mappings.json");
        for entry in [
            serde_json::json!({"volumeId":"data","source":"s3://bucket-a/data","credential":"team","destinationRoot":root}),
            serde_json::json!({"volumeId":"data","source":"s3://bucket-a/data","destinationRoot":root,"endpoint":"https://s3.example.com","region":"us-east-1","credentialEnvPrefix":"WSMOUNT_MISSING"}),
            serde_json::json!({"volumeId":"data","source":format!("file://{}", base.display()),"destinationRoot":root,"endpoint":"https://s3.example.com","region":"us-east-1","credentialEnvPrefix":"WSMOUNT_TEST"}),
        ] {
            fs::write(&config, serde_json::to_vec(&[entry]).unwrap()).unwrap();
            assert!(WorkspaceMounts::load(&config).is_err());
        }
    }
}
