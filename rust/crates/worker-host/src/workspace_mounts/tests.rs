use super::*;
use std::os::unix::fs::{PermissionsExt, symlink};
use supertag_protocol::v2::WorkspaceVolume;

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
            }),
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
