use anyhow::{Context, Result, ensure};
use sha2::Digest;
use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::OsString,
    fs,
    os::unix::process::CommandExt,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::Command,
};
use tokio_util::sync::CancellationToken;

use crate::{GitOutputFiles, check_cancelled, paths};

pub(crate) const COMMAND_TIMEOUT: Duration = Duration::from_secs(120);
const REMOTE_TIMEOUT: Duration = Duration::from_secs(15);

const MAX_OUTPUT: usize = 268_435_456;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct TreeEntry {
    pub path: String,
    pub mode: String,
    pub oid: String,
}

pub(crate) struct Repository {
    root: PathBuf,
    git_dir: PathBuf,
    oid_length: usize,
    bare: bool,
}

fn config(oid_length: usize, bare: bool) -> Vec<u8> {
    let version = if oid_length == 64 { 1 } else { 0 };
    format!(
        "[core]\n\trepositoryformatversion = {version}\n\tfilemode = true\n\tbare = {bare}\n{}",
        if oid_length == 64 {
            "[extensions]\n\tobjectformat = sha256\n"
        } else {
            ""
        }
    )
    .into_bytes()
}

fn initialize(git_dir: &Path, oid_length: usize, bare: bool) -> Result<()> {
    for path in [
        git_dir.to_owned(),
        git_dir.join("objects"),
        git_dir.join("objects/pack"),
        git_dir.join("objects/info"),
        git_dir.join("refs"),
        git_dir.join("refs/heads"),
        git_dir.join("refs/tags"),
    ] {
        paths::create_private_root(&path)?;
    }
    let expected = config(oid_length, bare);
    match paths::read_regular(&git_dir.join("config"), 65_536) {
        Ok(actual) => ensure!(actual == expected, "private Git configuration changed"),
        Err(error)
            if error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
        {
            crate::write_synced(&git_dir.join("config"), &expected)?
        }
        Err(error) => return Err(error),
    }
    if !git_dir.join("HEAD").try_exists()? {
        crate::write_synced(&git_dir.join("HEAD"), b"ref: refs/heads/main\n")?;
    }
    Ok(())
}

impl Repository {
    pub(crate) fn empty(root: &Path, oid_length: usize) -> Result<Self> {
        let git_dir = root.join("repository.git");
        initialize(&git_dir, oid_length, true)?;
        Ok(Self {
            root: root.to_owned(),
            git_dir,
            oid_length,
            bare: true,
        })
    }

    /// The repository of a Workspace state directory another process may own, for reading only:
    /// nothing here writes to it, so it needs neither the state's lock nor its gate.
    pub(crate) fn existing(root: &Path, oid_length: usize) -> Result<Self> {
        let git_dir = root.join("repository.git");
        paths::verify_directory(&git_dir)?;
        Ok(Self {
            root: root.to_owned(),
            git_dir,
            oid_length,
            bare: true,
        })
    }

    /// A complete bundle of `head`, its whole history, naming it as `reference`. Built with
    /// `pack-objects` and a written header, so no ref is created in the repository.
    pub(crate) async fn complete_bundle(
        &self,
        head: &str,
        reference: &str,
        cancel: &CancellationToken,
    ) -> Result<Vec<u8>> {
        self.verify_commit(head, cancel).await?;
        let pack = self
            .command(
                &["pack-objects", "--stdout", "--revs"],
                format!("{head}\n").as_bytes(),
                &[],
                cancel,
            )
            .await?;
        let mut bundle = if self.oid_length == 64 {
            format!("# v3 git bundle\n@object-format=sha256\n{head} {reference}\n\n")
        } else {
            format!("# v2 git bundle\n{head} {reference}\n\n")
        }
        .into_bytes();
        bundle.extend(pack);
        Ok(bundle)
    }

    pub(crate) fn path(&self) -> &Path {
        &self.git_dir
    }

    pub(crate) async fn open(
        root: &Path,
        source: &Path,
        base: &str,
        cancel: &CancellationToken,
    ) -> Result<Self> {
        let git_dir = root.join("repository.git");
        initialize(&git_dir, base.len(), true)?;
        let repository = Self {
            root: root.to_owned(),
            git_dir,
            oid_length: base.len(),
            bare: true,
        };
        if repository.verify_commit(base, cancel).await.is_err() {
            repository.import_from_source(source, base, cancel).await?;
        }
        Ok(repository)
    }

    /// Copies `commit` and its history from a local source repository's object store, without
    /// reading its configuration, refs, or hooks.
    pub(crate) async fn import_from_source(
        &self,
        source: &Path,
        commit: &str,
        cancel: &CancellationToken,
    ) -> Result<()> {
        if self.verify_commit(commit, cancel).await.is_ok() {
            return Ok(());
        }
        check_cancelled(cancel)?;
        let source_objects = source_objects(source)?;
        reject_object_links(&source_objects)?;
        let pack = self
            .command(
                &["pack-objects", "--stdout", "--revs"],
                format!("{commit}\n").as_bytes(),
                &[("GIT_OBJECT_DIRECTORY", source_objects.into_os_string())],
                cancel,
            )
            .await?;
        self.command(&["index-pack", "--stdin", "--strict"], &pack, &[], cancel)
            .await?;
        self.verify_commit(commit, cancel).await
    }

    /// Merges `theirs` into `ours` without a work tree: the merged tree, conflicting files holding
    /// conflict markers, and the conflicting paths. Nothing is resolved.
    pub(crate) async fn merge_tree(
        &self,
        ours: &str,
        theirs: &str,
        cancel: &CancellationToken,
    ) -> Result<(String, Vec<String>)> {
        validate_oid(ours)?;
        validate_oid(theirs)?;
        paths::verify_directory(&self.git_dir)?;
        let mut command = Command::new("/usr/bin/git");
        command
            .current_dir(&self.root)
            .env_clear()
            .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
            .env("LANG", "C")
            .env("LC_ALL", "C")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_ATTR_NOSYSTEM", "1")
            .env("GIT_NO_REPLACE_OBJECTS", "1")
            .env("GIT_NO_LAZY_FETCH", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .arg(format!("--git-dir={}", self.git_dir.display()))
            .args([
                "-c",
                "core.attributesFile=/dev/null",
                "-c",
                "core.hooksPath=/dev/null",
            ])
            .args([
                "merge-tree",
                "--write-tree",
                "-z",
                "--name-only",
                "--no-messages",
                ours,
                theirs,
            ]);
        // `merge-tree` exits 1 for a merge with conflicts; its output is still the merged tree.
        let output = run_status(command, cancel, MAX_OUTPUT, COMMAND_TIMEOUT).await?;
        ensure!(
            matches!(output.0, Some(0) | Some(1)),
            "merging the target into the Session failed"
        );
        let mut fields = output.1.split(|byte| *byte == 0);
        let tree = std::str::from_utf8(fields.next().unwrap_or_default())?
            .trim()
            .to_owned();
        validate_oid(&tree)?;
        let conflicts = fields
            .map(|name| String::from_utf8_lossy(name).into_owned())
            .take_while(|name| !name.is_empty())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        ensure!(
            output.0 == Some(0) || !conflicts.is_empty(),
            "the merge conflicted without naming files"
        );
        Ok((tree, conflicts))
    }

    async fn command(
        &self,
        args: &[&str],
        input: &[u8],
        extra: &[(&str, OsString)],
        cancel: &CancellationToken,
    ) -> Result<Vec<u8>> {
        paths::verify_directory(&self.git_dir)?;
        ensure!(
            paths::read_regular(&self.git_dir.join("config"), 65_536)?
                == config(self.oid_length, self.bare),
            "private Git configuration changed"
        );
        // A checkout's Git directory is writable by the harness. Git reads the configuration of
        // a `commondir` instead of the one checked above, so a redirect could name a filter.
        for name in ["config.worktree", "commondir", "gitdir"] {
            ensure!(
                fs::symlink_metadata(self.git_dir.join(name))
                    .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound),
                "unexpected Git metadata: {name}"
            );
        }
        reject_object_links(&self.git_dir.join("objects"))?;
        let mut command = Command::new("/usr/bin/git");
        command
            .current_dir(&self.root)
            .env_clear()
            .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
            .env("LANG", "C")
            .env("LC_ALL", "C")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_ATTR_NOSYSTEM", "1")
            .env("GIT_NO_REPLACE_OBJECTS", "1")
            .env("GIT_NO_LAZY_FETCH", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_OPTIONAL_LOCKS", "0")
            .arg(format!("--git-dir={}", self.git_dir.display()));
        for value in [
            "core.hooksPath=/dev/null",
            "core.fsmonitor=false",
            "core.attributesFile=/dev/null",
            "core.autocrlf=false",
            "core.safecrlf=false",
            "core.untrackedCache=false",
            "commit.gpgSign=false",
            "tag.gpgSign=false",
            "protocol.allow=never",
            "protocol.ext.allow=never",
            "core.pager=cat",
            "diff.external=",
        ] {
            command.arg("-c").arg(value);
        }
        for (name, value) in extra {
            command.env(name, value);
        }
        command.args(args);
        run(command, input, cancel, MAX_OUTPUT, COMMAND_TIMEOUT).await
    }

    pub(crate) async fn verify_commit(&self, oid: &str, cancel: &CancellationToken) -> Result<()> {
        validate_oid(oid)?;
        let kind = self
            .command(&["cat-file", "-t", oid], &[], &[], cancel)
            .await?;
        ensure!(kind == b"commit\n", "pinned Git object is not a commit");
        Ok(())
    }

    pub(crate) async fn assert_ancestor(
        &self,
        base: &str,
        head: &str,
        cancel: &CancellationToken,
    ) -> Result<()> {
        self.verify_commit(head, cancel).await?;
        self.command(
            &["merge-base", "--is-ancestor", base, head],
            &[],
            &[],
            cancel,
        )
        .await
        .context("continuation does not contain its accepted base")?;
        Ok(())
    }

    pub(crate) async fn tree(
        &self,
        commit: &str,
        cancel: &CancellationToken,
    ) -> Result<BTreeMap<String, TreeEntry>> {
        let bytes = self
            .command(&["ls-tree", "-rz", "--full-tree", commit], &[], &[], cancel)
            .await?;
        let mut entries = BTreeMap::new();
        for entry in bytes
            .split(|byte| *byte == 0)
            .filter(|entry| !entry.is_empty())
        {
            let tab = entry
                .iter()
                .position(|byte| *byte == b'\t')
                .context("invalid Git tree entry")?;
            let header = std::str::from_utf8(&entry[..tab])?;
            let mut fields = header.split(' ');
            let mode = fields.next().context("missing Git mode")?.to_owned();
            let kind = fields.next().context("missing Git object kind")?;
            ensure!(
                kind == "blob",
                "submodules require an explicit workspace implementation"
            );
            let oid = fields.next().context("missing Git object ID")?.to_owned();
            validate_oid(&oid)?;
            ensure!(
                matches!(mode.as_str(), "100644" | "100755" | "120000"),
                "unsupported Git file mode"
            );
            let path = std::str::from_utf8(&entry[tab + 1..])
                .context("repository path is not UTF-8")?
                .to_owned();
            paths::validate_repo_path(&path)?;
            ensure!(
                entries
                    .insert(path.clone(), TreeEntry { path, mode, oid })
                    .is_none(),
                "duplicate Git tree path"
            );
        }
        Ok(entries)
    }

    /// Writes a checkout of `start`, or with `index_tree` of that tree on top of `start` (a merge
    /// follow-up's merge), and verifies every file against `entries`.
    pub(crate) async fn checkout(
        &self,
        directory: &Path,
        (base, start): (&str, &str),
        index_tree: Option<&str>,
        entries: &BTreeMap<String, TreeEntry>,
        cancel: &CancellationToken,
    ) -> Result<()> {
        for entry in entries.values().filter(|entry| entry.mode == "120000") {
            let target = self
                .command(&["cat-file", "blob", &entry.oid], &[], &[], cancel)
                .await?;
            paths::validate_link(&entry.path, &target)?;
        }
        let checkout = self
            .checkout_metadata_with(directory, base, start, index_tree, cancel)
            .await?;
        // Git writes the files on several workers.
        let workers = format!("checkout.workers={}", parallelism());
        checkout
            .command(
                &[
                    "-c",
                    &workers,
                    "-c",
                    "checkout.thresholdForParallelism=64",
                    "checkout-index",
                    "--all",
                    "--force",
                ],
                &[],
                &[],
                cancel,
            )
            .await?;
        // Verify bytes and modes after checkout rather than trusting config, name
        // normalization, or a successful Git exit to imply the exact pinned tree. Reading and
        // hashing every file runs on blocking threads, so the caller's lease renewal goes on.
        let (directory, entries, cancel) = (directory.to_owned(), entries.clone(), cancel.clone());
        let oid_length = self.oid_length;
        tokio::task::spawn_blocking(move || {
            let actual = paths::scan(&directory, &cancel)?;
            ensure!(
                actual.len() == entries.len(),
                "materialized checkout differs from its pinned tree"
            );
            let entries: Vec<_> = entries.iter().collect();
            let chunk = entries.len().div_ceil(parallelism()).max(1);
            std::thread::scope(|scope| {
                let verifiers: Vec<_> = entries
                    .chunks(chunk)
                    .map(|part| {
                        let (directory, cancel) = (&directory, &cancel);
                        scope.spawn(move || -> Result<()> {
                            for (path, expected) in part {
                                check_cancelled(cancel)?;
                                let actual = paths::read_checkout_file(directory, path)?;
                                ensure!(
                                    actual.mode == expected.mode
                                        && blob_oid(&actual.bytes, oid_length) == expected.oid,
                                    "materialized file differs from its pinned tree: {path}"
                                );
                            }
                            Ok(())
                        })
                    })
                    .collect();
                verifiers.into_iter().try_for_each(|verifier| {
                    verifier
                        .join()
                        .map_err(|_| anyhow::anyhow!("checkout verification stopped"))?
                })
            })?;
            check_cancelled(&cancel)
        })
        .await
        .context("checkout verification stopped")?
    }

    /// Recreate minimal, trusted Git metadata without reading checkout metadata
    /// or modifying its file tree. Used when installing a remote tree snapshot.
    ///
    /// The checkout's `.git` holds only the Session's commits since `base`, `base` itself, and
    /// the complete tree of each, as a shallow repository cut at `base`. Nothing older, and
    /// nothing of another Session or Tag in this host's repository, is copied into it.
    pub(crate) async fn checkout_metadata(
        &self,
        directory: &Path,
        base: &str,
        start: &str,
        cancel: &CancellationToken,
    ) -> Result<Self> {
        self.checkout_metadata_with(directory, base, start, None, cancel)
            .await
    }

    /// As [`Self::checkout_metadata`], with the index holding `index_tree` instead of `start`'s
    /// tree, and that tree's objects copied too.
    async fn checkout_metadata_with(
        &self,
        directory: &Path,
        base: &str,
        start: &str,
        index_tree: Option<&str>,
        cancel: &CancellationToken,
    ) -> Result<Self> {
        validate_oid(base)?;
        validate_oid(start)?;
        if let Some(tree) = index_tree {
            validate_oid(tree)?;
        }
        paths::create_private_root(directory)?;
        let git_dir = directory.join(".git");
        initialize(&git_dir, self.oid_length, false)?;
        let checkout = Repository {
            root: directory.to_owned(),
            git_dir,
            oid_length: self.oid_length,
            bare: false,
        };
        let not_base = format!("^{base}");
        let since = self
            .command(&["rev-list", start, &not_base], &[], &[], cancel)
            .await?;
        let mut commits = BTreeSet::from([base.to_owned()]);
        commits.extend(std::str::from_utf8(&since)?.lines().map(str::to_owned));
        let list: String = commits.iter().map(|commit| format!("{commit}\n")).collect();
        // Every commit with a parent the checkout does not hold is a shallow boundary.
        let parents = self
            .command(
                &["rev-list", "--parents", "--no-walk", "--stdin"],
                list.as_bytes(),
                &[],
                cancel,
            )
            .await?;
        let mut shallow = String::new();
        for line in std::str::from_utf8(&parents)?.lines() {
            let mut oids = line.split(' ');
            let Some(commit) = oids.next() else { continue };
            if oids.any(|parent| !commits.contains(parent)) {
                shallow.push_str(commit);
                shallow.push('\n');
            }
        }
        if !shallow.is_empty() {
            crate::write_synced(&checkout.git_dir.join("shallow"), shallow.as_bytes())?;
        }
        let mut objects = self
            .command(
                &["rev-list", "--objects", "--no-walk", "--stdin"],
                list.as_bytes(),
                &[],
                cancel,
            )
            .await?;
        if let Some(tree) = index_tree {
            objects.extend_from_slice(format!("{tree}\n").as_bytes());
            let listed = self
                .command(&["ls-tree", "-r", "-t", "-z", tree], &[], &[], cancel)
                .await?;
            for entry in listed
                .split(|byte| *byte == 0)
                .filter(|entry| !entry.is_empty())
            {
                let header = entry
                    .split(|byte| *byte == b'\t')
                    .next()
                    .unwrap_or_default();
                if let Some(oid) = std::str::from_utf8(header)?.split(' ').nth(2) {
                    validate_oid(oid)?;
                    objects.extend_from_slice(format!("{oid}\n").as_bytes());
                }
            }
        }
        let pack = self
            .command(&["pack-objects", "--stdout"], &objects, &[], cancel)
            .await?;
        checkout
            .command(&["index-pack", "--stdin", "--strict"], &pack, &[], cancel)
            .await?;
        checkout
            .command(&["update-ref", "HEAD", start], &[], &[], cancel)
            .await?;
        checkout
            .command(
                &["read-tree", "--reset", index_tree.unwrap_or(start)],
                &[],
                &[],
                cancel,
            )
            .await?;
        check_cancelled(cancel)?;
        Ok(checkout)
    }

    pub(crate) async fn ignored(
        &self,
        checkout: &Path,
        start: &str,
        names: &[String],
        cancel: &CancellationToken,
    ) -> Result<BTreeSet<String>> {
        if names.is_empty() {
            return Ok(BTreeSet::new());
        }
        let temporary = tempfile::tempdir_in(self.root.join("temporary"))?;
        let environment = [
            (
                "GIT_INDEX_FILE",
                temporary.path().join("index").into_os_string(),
            ),
            ("GIT_WORK_TREE", checkout.as_os_str().to_owned()),
        ];
        self.command(&["read-tree", start], &[], &environment, cancel)
            .await?;
        // --non-matching makes exit 1 unnecessary and gives one framed answer for each path.
        let mut input = Vec::new();
        for name in names {
            input.extend_from_slice(name.as_bytes());
            input.push(0);
        }
        let bytes = self
            .command(
                &[
                    "check-ignore",
                    "--stdin",
                    "-z",
                    "--verbose",
                    "--non-matching",
                ],
                &input,
                &environment,
                cancel,
            )
            .await;
        let bytes = match bytes {
            Ok(value) => value,
            Err(error)
                if error
                    .downcast_ref::<GitExit>()
                    .is_some_and(|exit| exit.code == Some(1)) =>
            {
                return Ok(BTreeSet::new());
            }
            Err(error) => return Err(error),
        };
        let parts: Vec<_> = bytes.split(|byte| *byte == 0).collect();
        let mut ignored = BTreeSet::new();
        for entry in parts[..parts.len().saturating_sub(1)].chunks_exact(4) {
            let pattern = std::str::from_utf8(entry[2])?;
            if !pattern.is_empty() && !pattern.starts_with('!') {
                ignored.insert(std::str::from_utf8(entry[3])?.to_owned());
            }
        }
        Ok(ignored)
    }

    fn output_repository(checkout: &Path, oid_length: usize) -> Result<Self> {
        let repository = Self {
            root: checkout.to_owned(),
            git_dir: checkout.join(".git"),
            oid_length,
            bare: false,
        };
        paths::read_regular(&repository.git_dir.join("HEAD"), 1024)?;
        paths::read_regular(&repository.git_dir.join("index"), 32 * 1024 * 1024)?;
        Ok(repository)
    }

    pub(crate) async fn tracked_outputs(
        checkout: &Path,
        oid_length: usize,
        selected: &[String],
        cancel: &CancellationToken,
    ) -> Result<BTreeSet<String>> {
        Self::output_repository(checkout, oid_length)?
            .selected_tracked(selected, cancel)
            .await
    }

    /// Paths changed since the checkout's start commit: committed, staged, unstaged, untracked,
    /// and both sides of a rename. TypeScript parity: `scanChangedPaths` in
    /// `apps/cli/src/worker-changed-paths.ts`. `keep` filters each path before counting.
    pub(crate) async fn changed_paths(
        checkout: &crate::Checkout,
        keep: impl Fn(&str) -> bool,
        cancel: &CancellationToken,
    ) -> Result<BTreeSet<String>> {
        let repository = Self::output_repository(&checkout.path, checkout.start_commit.len())?;
        validate_oid(&checkout.start_commit)?;
        let diff = repository
            .command(
                &[
                    "diff",
                    "--name-status",
                    "-z",
                    "-M",
                    "--no-ext-diff",
                    &checkout.start_commit,
                    "--",
                ],
                &[],
                &[],
                cancel,
            )
            .await?;
        let status = repository
            .command(
                &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
                &[],
                &[],
                cancel,
            )
            .await?;
        let mut paths = BTreeSet::new();
        let mut add = |field: &[u8]| {
            if let Ok(path) = std::str::from_utf8(field)
                && keep(path)
            {
                paths.insert(path.to_owned());
            }
        };
        let mut fields = diff.split(|byte| *byte == 0);
        while let Some(status) = fields.next().filter(|field| !field.is_empty()) {
            add(fields.next().unwrap_or_default());
            if matches!(status.first(), Some(b'R' | b'C')) {
                add(fields.next().unwrap_or_default());
            }
        }
        let mut fields = status.split(|byte| *byte == 0);
        while let Some(entry) = fields.next().filter(|field| field.len() > 3) {
            add(&entry[3..]);
            if entry[..2].iter().any(|code| matches!(code, b'R' | b'C')) {
                add(fields.next().unwrap_or_default());
            }
        }
        Ok(paths)
    }

    pub(crate) async fn prepared_tracked_outputs(
        checkout: &crate::Checkout,
        cancel: &CancellationToken,
    ) -> Result<BTreeSet<String>> {
        Ok(
            Self::output_repository(&checkout.path, checkout.start_commit.len())?
                .tree(&checkout.start_commit, cancel)
                .await?
                .into_keys()
                .collect(),
        )
    }

    async fn selected_tracked(
        &self,
        selected: &[String],
        cancel: &CancellationToken,
    ) -> Result<BTreeSet<String>> {
        if selected.is_empty() {
            return Ok(BTreeSet::new());
        }
        let mut index = vec!["--literal-pathspecs", "ls-files", "-z", "--cached", "--"];
        let mut tree = vec![
            "--literal-pathspecs",
            "ls-tree",
            "-rz",
            "--name-only",
            "HEAD",
            "--",
        ];
        index.extend(selected.iter().map(String::as_str));
        tree.extend(selected.iter().map(String::as_str));
        let mut tracked = BTreeSet::new();
        for arguments in [index, tree] {
            let bytes = self.command(&arguments, &[], &[], cancel).await?;
            for path in bytes
                .split(|byte| *byte == 0)
                .filter(|path| !path.is_empty())
            {
                tracked.insert(std::str::from_utf8(path)?.to_owned());
            }
        }
        Ok(tracked)
    }

    pub(crate) async fn output_files(
        checkout: &crate::Checkout,
        selected: &[String],
        permits: impl Fn(&str) -> bool,
        maximum: usize,
        prepared_head: bool,
        cancel: &CancellationToken,
    ) -> Result<GitOutputFiles> {
        let repository = Self::output_repository(&checkout.path, checkout.start_commit.len())?;
        let (head_commit, mut tracked) = if prepared_head {
            (checkout.start_commit.clone(), BTreeSet::new())
        } else {
            (
                output_oid(
                    repository
                        .command(
                            &["rev-parse", "--verify", "HEAD^{commit}"],
                            &[],
                            &[],
                            cancel,
                        )
                        .await?,
                )?,
                repository.selected_tracked(selected, cancel).await?,
            )
        };
        let head = repository.tree(&head_commit, cancel).await?;
        let base = if checkout.start_commit == head_commit {
            None
        } else {
            Some(repository.tree(&checkout.start_commit, cancel).await?)
        };
        let base = base.as_ref().unwrap_or(&head);
        let selected: BTreeSet<&str> = selected.iter().map(String::as_str).collect();
        let deleted: Vec<_> = base
            .values()
            .filter(|entry| {
                entry.mode != "120000"
                    && !selected.contains(entry.path.as_str())
                    && permits(&entry.path)
            })
            .take(maximum + 1)
            .map(|entry| entry.path.clone())
            .collect();
        ensure!(deleted.len() <= maximum, "too many selected Git deletions");
        tracked.extend(
            selected
                .iter()
                .filter(|path| base.contains_key(**path))
                .map(|path| path.to_string()),
        );
        tracked.retain(|path| selected.contains(path.as_str()));
        let committed = head
            .into_values()
            .filter(|entry| entry.mode != "120000" && tracked.contains(&entry.path))
            .map(|entry| (entry.path, entry.oid))
            .collect();
        Ok(GitOutputFiles {
            head_commit,
            tracked: tracked.into_iter().collect(),
            deleted,
            committed,
        })
    }

    pub(crate) async fn write_blob(
        &self,
        bytes: &[u8],
        cancel: &CancellationToken,
    ) -> Result<String> {
        output_oid(
            self.command(&["hash-object", "-w", "--stdin"], bytes, &[], cancel)
                .await?,
        )
    }

    pub(crate) async fn write_tree(
        &self,
        entries: &BTreeMap<String, TreeEntry>,
        cancel: &CancellationToken,
    ) -> Result<String> {
        let temporary = tempfile::tempdir_in(self.root.join("temporary"))?;
        let environment = [(
            "GIT_INDEX_FILE",
            temporary.path().join("index").into_os_string(),
        )];
        self.command(&["read-tree", "--empty"], &[], &environment, cancel)
            .await?;
        let mut input = Vec::new();
        for entry in entries.values() {
            input.extend_from_slice(
                format!("{} {}\t{}\0", entry.mode, entry.oid, entry.path).as_bytes(),
            );
        }
        self.command(
            &["update-index", "-z", "--index-info"],
            &input,
            &environment,
            cancel,
        )
        .await?;
        output_oid(
            self.command(&["write-tree"], &[], &environment, cancel)
                .await?,
        )
    }

    pub(crate) async fn tree_oid(
        &self,
        commit: &str,
        cancel: &CancellationToken,
    ) -> Result<String> {
        output_oid(
            self.command(
                &["rev-parse", "--verify", &format!("{commit}^{{tree}}")],
                &[],
                &[],
                cancel,
            )
            .await?,
        )
    }

    pub(crate) async fn commit(
        &self,
        tree: &str,
        parents: &[&str],
        message: &str,
        author: Option<&crate::CommitAuthor>,
        seconds: u64,
        cancel: &CancellationToken,
    ) -> Result<String> {
        let date = OsString::from(format!("{seconds} +0000"));
        let usable = |value: &str| {
            !value.is_empty()
                && value.len() <= 256
                && !value
                    .chars()
                    .any(|c| c.is_control() || c == '<' || c == '>')
        };
        let (name, email) = match author {
            Some(author) if usable(&author.name) && usable(&author.email) => {
                (author.name.as_str(), author.email.as_str())
            }
            _ => ("SuperTag", "supertag@localhost"),
        };
        let environment = [
            ("GIT_AUTHOR_NAME", OsString::from(name)),
            ("GIT_AUTHOR_EMAIL", OsString::from(email)),
            ("GIT_COMMITTER_NAME", OsString::from(name)),
            ("GIT_COMMITTER_EMAIL", OsString::from(email)),
            ("GIT_AUTHOR_DATE", date.clone()),
            ("GIT_COMMITTER_DATE", date),
        ];
        let mut args = vec!["commit-tree", tree];
        for parent in parents {
            validate_oid(parent)?;
            args.extend(["-p", parent]);
        }
        args.extend(["-m", message]);
        output_oid(self.command(&args, &[], &environment, cancel).await?)
    }

    pub(crate) async fn patch(
        &self,
        start: &str,
        head: &str,
        cancel: &CancellationToken,
    ) -> Result<Vec<u8>> {
        self.command(
            &[
                "diff",
                "--binary",
                "--full-index",
                "--no-ext-diff",
                "--no-textconv",
                start,
                head,
                "--",
            ],
            &[],
            &[],
            cancel,
        )
        .await
    }

    /// A delivery's bundle: only what the Attempt added to `start`, the commit every reader of
    /// the delivery already holds or gets a complete bundle in place of. Its prerequisite is
    /// `start`; a delivery that changed nothing (`head == start`) carries the start commit itself
    /// against its parents, since Git writes no empty bundle, and a root start commit is bundled
    /// whole.
    pub(crate) async fn delivery_bundle(
        &self,
        start: &str,
        head: &str,
        id: &str,
        file: &Path,
        cancel: &CancellationToken,
    ) -> Result<()> {
        let exclusions = if head == start {
            parents_in(self, start, &[], cancel).await?
        } else {
            vec![start.to_owned()]
        };
        self.bundle_excluding(head, id, file, &exclusions, cancel)
            .await
    }

    pub(crate) async fn bundle(
        &self,
        head: &str,
        id: &str,
        file: &Path,
        cancel: &CancellationToken,
    ) -> Result<()> {
        self.bundle_excluding(head, id, file, &[], cancel).await
    }

    async fn bundle_excluding(
        &self,
        head: &str,
        id: &str,
        file: &Path,
        exclusions: &[String],
        cancel: &CancellationToken,
    ) -> Result<()> {
        let reference = format!("refs/heads/supertag-deliveries/{id}");
        self.command(&["update-ref", &reference, head], &[], &[], cancel)
            .await?;
        let file = file.to_str().context("bundle path is not UTF-8")?;
        let excluded: Vec<String> = exclusions.iter().map(|oid| format!("^{oid}")).collect();
        let mut args = vec!["bundle", "create", file, reference.as_str()];
        args.extend(excluded.iter().map(String::as_str));
        self.command(&args, &[], &[], cancel).await?;
        self.command(&["bundle", "verify", file], &[], &[], cancel)
            .await?;
        let heads = self
            .command(&["bundle", "list-heads", file], &[], &[], cancel)
            .await?;
        ensure!(
            heads == format!("{head} {reference}\n").as_bytes(),
            "bundle does not contain the exact delivered commit"
        );
        Ok(())
    }

    /// Imports a delivery bundle whose head is `head`. A complete bundle is unpacked into an
    /// empty quarantine repository, so a thin delta, or a tree or parent naming an object the
    /// bundle does not carry, fails there instead of borrowing an object from this host's
    /// repository.
    ///
    /// An incremental bundle (see [`Self::delivery_bundle`]) may borrow only the history of the
    /// delivery's `start` commit, which the caller took from the approved delivery receipt. Its
    /// prerequisites must be exactly `start`, or the head's parents when the delivery changed
    /// nothing, and this host must already hold them: otherwise the import fails with
    /// [`MissingPrerequisite`] and the caller asks for a complete bundle instead. Its quarantine
    /// reads this repository as an alternate, and the pack must hold exactly the objects the
    /// head reaches beyond its prerequisites.
    pub(crate) async fn import_bundle(
        &self,
        file: &Path,
        head: &str,
        start: Option<&str>,
        cancel: &CancellationToken,
    ) -> Result<()> {
        let prerequisites = bundle_prerequisites(file)?;
        if !prerequisites.is_empty() {
            let start = start.context(
                "delivery bundle names prerequisite commits, and this import accepts none",
            )?;
            validate_oid(start)?;
            for prerequisite in &prerequisites {
                validate_oid(prerequisite)?;
                if self.verify_commit(prerequisite, cancel).await.is_err() {
                    return Err(MissingPrerequisite(prerequisite.clone()).into());
                }
            }
        }
        let file = file.to_str().context("bundle path is not UTF-8")?;
        let temporary = self.root.join("temporary");
        paths::create_private_root(&temporary)?;
        let quarantine = tempfile::Builder::new()
            .prefix("import-")
            .tempdir_in(&temporary)?;
        let isolated = Self::empty(quarantine.path(), self.oid_length)?;
        // Only an incremental bundle reads this repository, for its prerequisites' history.
        let own_objects = self.git_dir.join("objects");
        let borrowing: Vec<(&str, OsString)> = if prerequisites.is_empty() {
            vec![]
        } else {
            vec![(
                "GIT_ALTERNATE_OBJECT_DIRECTORIES",
                own_objects.clone().into_os_string(),
            )]
        };
        isolated
            .command(&["bundle", "verify", file], &[], &borrowing, cancel)
            .await
            .context("delivery bundle is incomplete or damaged")?;
        let heads = isolated
            .command(&["bundle", "list-heads", file], &[], &borrowing, cancel)
            .await?;
        let advertised = String::from_utf8(heads)?;
        ensure!(
            advertised
                .lines()
                .any(|line| line.split_once(' ').is_some_and(|(oid, _)| oid == head)),
            "approved commit is not an advertised bundle head"
        );
        isolated
            .command(&["bundle", "unbundle", file], &[], &borrowing, cancel)
            .await
            .context("delivery bundle pack is damaged or incomplete")?;
        validate_oid(head)?;
        let kind = isolated
            .command(&["cat-file", "-t", head], &[], &borrowing, cancel)
            .await?;
        ensure!(kind == b"commit\n", "pinned Git object is not a commit");
        if let Some(start) = start.filter(|_| !prerequisites.is_empty()) {
            let allowed: BTreeSet<String> = if head == start {
                parents_in(&isolated, head, &borrowing, cancel)
                    .await?
                    .into_iter()
                    .collect()
            } else {
                ensure!(
                    isolated
                        .command(
                            &["merge-base", "--is-ancestor", start, head],
                            &[],
                            &borrowing,
                            cancel,
                        )
                        .await
                        .is_ok(),
                    "delivered commit does not descend from its start commit"
                );
                BTreeSet::from([start.to_owned()])
            };
            ensure!(
                prerequisites == allowed,
                "delivery bundle needs commits other than its start commit"
            );
        }
        let mut range = vec!["rev-list", "--objects", head];
        let excluded: Vec<String> = prerequisites.iter().map(|oid| format!("^{oid}")).collect();
        range.extend(excluded.iter().map(String::as_str));
        let reachable = isolated
            .command(&range, &[], &borrowing, cancel)
            .await
            .context("delivery bundle history is incomplete")?;
        // The quarantine's own objects: what the bundle carried, never this repository's.
        let stored = isolated
            .command(
                &[
                    "cat-file",
                    "--batch-all-objects",
                    "--batch-check=%(objectname)",
                ],
                &[],
                &[],
                cancel,
            )
            .await?;
        let names = |bytes: &[u8]| -> Result<BTreeSet<String>> {
            Ok(std::str::from_utf8(bytes)?
                .lines()
                .filter_map(|line| line.split(' ').next())
                .map(str::to_owned)
                .collect())
        };
        let (reachable, stored) = (names(&reachable)?, names(&stored)?);
        ensure!(
            reachable.is_subset(&stored),
            "delivery bundle history is incomplete"
        );
        // Unbundling an incremental bundle completes its thin pack with the delta bases it names,
        // copied from this repository. They must belong to the prerequisites' history: a delta
        // against any other object here, such as another Session's, is refused.
        let extra: BTreeSet<&String> = stored.difference(&reachable).collect();
        if !extra.is_empty() {
            ensure!(
                !prerequisites.is_empty(),
                "delivery bundle pack carries objects outside the delivered history"
            );
            let mut history = vec!["rev-list", "--objects"];
            history.extend(prerequisites.iter().map(String::as_str));
            let history = names(&isolated.command(&history, &[], &borrowing, cancel).await?)?;
            ensure!(
                extra.iter().all(|object| history.contains(*object)),
                "delivery bundle pack carries objects outside the delivered history"
            );
        }
        let mut revisions = format!("{head}\n");
        for prerequisite in &prerequisites {
            revisions.push_str(&format!("^{prerequisite}\n"));
        }
        let mut objects = vec![(
            "GIT_OBJECT_DIRECTORY",
            isolated.git_dir.join("objects").into_os_string(),
        )];
        objects.extend(borrowing.iter().cloned());
        let pack = self
            .command(
                &["pack-objects", "--stdout", "--revs"],
                revisions.as_bytes(),
                &objects,
                cancel,
            )
            .await?;
        self.command(&["index-pack", "--stdin", "--strict"], &pack, &[], cancel)
            .await?;
        self.verify_commit(head, cancel).await
    }

    pub(crate) fn sync(&self) -> Result<()> {
        paths::sync_tree(&self.git_dir)
    }
}

/// How many workers write and verify a checkout: the machine's cores, at most 8.
fn parallelism() -> usize {
    std::thread::available_parallelism().map_or(1, |cores| cores.get().min(8))
}

/// A delivery bundle names a prerequisite commit this host does not hold, so it cannot be
/// imported here; the caller asks for a complete bundle instead.
#[derive(Debug)]
pub struct MissingPrerequisite(pub String);

impl std::fmt::Display for MissingPrerequisite {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "delivery bundle needs commit {}, which this repository does not hold",
            self.0
        )
    }
}

impl std::error::Error for MissingPrerequisite {}

/// The prerequisite commits a bundle's header names, read without Git so a damaged or hostile
/// header is refused before Git parses the pack. Version 2 and 3 headers.
pub(crate) fn bundle_prerequisites(file: &Path) -> Result<BTreeSet<String>> {
    use std::io::{BufRead, BufReader, Read};
    let reader = BufReader::new(fs::File::open(file)?.take(1 << 20));
    let mut lines = reader.split(b'\n');
    let signature = lines.next().context("bundle is empty")??;
    ensure!(
        signature == b"# v2 git bundle" || signature == b"# v3 git bundle",
        "not a Git bundle"
    );
    let mut prerequisites = BTreeSet::new();
    for line in lines {
        let line = line?;
        if line.is_empty() {
            return Ok(prerequisites);
        }
        if let Some(rest) = line.strip_prefix(b"-") {
            let oid = std::str::from_utf8(rest)?
                .split(' ')
                .next()
                .unwrap_or_default();
            validate_oid(oid)?;
            prerequisites.insert(oid.to_owned());
        }
    }
    anyhow::bail!("bundle header is incomplete")
}

async fn parents_in(
    repository: &Repository,
    commit: &str,
    extra: &[(&str, OsString)],
    cancel: &CancellationToken,
) -> Result<Vec<String>> {
    validate_oid(commit)?;
    let listed = repository
        .command(
            &["rev-list", "--parents", "-n", "1", commit],
            &[],
            extra,
            cancel,
        )
        .await?;
    let line = String::from_utf8(listed)?;
    let mut oids = line.split_whitespace().map(str::to_owned);
    ensure!(oids.next().as_deref() == Some(commit), "commit is missing");
    oids.map(|oid| {
        validate_oid(&oid)?;
        Ok(oid)
    })
    .collect()
}

pub(crate) fn validate_oid(value: &str) -> Result<()> {
    ensure!(
        matches!(value.len(), 40 | 64)
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
        "expected a full lowercase Git commit ID"
    );
    Ok(())
}
fn output_oid(bytes: Vec<u8>) -> Result<String> {
    let value = String::from_utf8(bytes)?.trim().to_owned();
    validate_oid(&value)?;
    Ok(value)
}
pub(crate) fn blob_oid(bytes: &[u8], length: usize) -> String {
    let header = format!("blob {}\0", bytes.len());
    if length == 64 {
        let mut digest = sha2::Sha256::new();
        digest.update(header);
        digest.update(bytes);
        format!("{:x}", digest.finalize())
    } else {
        let mut digest = sha1::Sha1::new();
        digest.update(header);
        digest.update(bytes);
        format!("{:x}", digest.finalize())
    }
}

fn source_git_directory(source: &Path) -> Result<PathBuf> {
    let git = source.join(".git");
    let mut directory = if fs::symlink_metadata(&git).is_ok_and(|metadata| metadata.is_dir()) {
        paths::verify_directory(&git)?;
        git
    } else if fs::symlink_metadata(&git).is_ok() {
        let bytes = paths::read_regular(&git, 16_384)?;
        let target = std::str::from_utf8(&bytes)?
            .trim()
            .strip_prefix("gitdir: ")
            .context("invalid local worktree Git pointer")?;
        let target = Path::new(target);
        (if target.is_absolute() {
            target.to_owned()
        } else {
            source.join(target)
        })
        .canonicalize()?
    } else {
        ensure!(
            source.join("objects").is_dir() && source.join("HEAD").is_file(),
            "source is not a local Git repository"
        );
        source.to_owned()
    };
    paths::verify_directory(&directory)?;
    let common = directory.join("commondir");
    if common.try_exists()? {
        let bytes = paths::read_regular(&common, 16_384)?;
        let target = Path::new(std::str::from_utf8(&bytes)?.trim());
        directory = (if target.is_absolute() {
            target.to_owned()
        } else {
            directory.join(target)
        })
        .canonicalize()?;
        paths::verify_directory(&directory)?;
    }
    Ok(directory)
}

fn source_objects(source: &Path) -> Result<PathBuf> {
    let objects = source_git_directory(source)?.join("objects");
    paths::verify_directory(&objects)?;
    Ok(objects)
}

pub(crate) async fn advertised_output_remote(
    source: &Path,
    disposable: &Path,
    commit: &str,
    cancel: &CancellationToken,
) -> Result<Option<String>> {
    validate_oid(commit)?;
    let config = paths::read_regular(&source_git_directory(source)?.join("config"), 65_536)?;
    let mut read = isolated_remote_command();
    read.args([
        "config",
        "--file",
        "-",
        "--no-includes",
        "--null",
        "--get-regexp",
        r"^remote\..*\.url$",
    ]);
    let configured = run(read, &config, cancel, 65_536, REMOTE_TIMEOUT).await?;
    let Some((_, value)) = std::str::from_utf8(&configured)?
        .split('\0')
        .filter_map(|row| row.split_once('\n'))
        .min_by(|left, right| left.0.cmp(right.0))
    else {
        return Ok(None);
    };
    let Some(remote) = output_remote_url(source, disposable, value) else {
        return Ok(None);
    };
    let mut lookup = isolated_remote_command();
    lookup
        .args(["-c", "protocol.allow=never", "-c"])
        .arg(format!("protocol.{}.allow=always", remote.scheme()))
        .args(["-c", "http.followRedirects=false", "ls-remote", "--"])
        .arg(remote.as_str());
    let advertised = run(lookup, &[], cancel, 1024 * 1024, REMOTE_TIMEOUT).await?;
    Ok(std::str::from_utf8(&advertised)?
        .lines()
        .any(|line| line.split_once('\t').is_some_and(|(oid, _)| oid == commit))
        .then(|| remote.into()))
}

fn isolated_remote_command() -> Command {
    let mut command = Command::new("/usr/bin/git");
    command
        .current_dir("/")
        .env_clear()
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .env("LC_ALL", "C")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_TERMINAL_PROMPT", "0");
    command
}

fn output_remote_url(source: &Path, disposable: &Path, value: &str) -> Option<url::Url> {
    if value.is_empty()
        || value.len() > 1024
        || value.chars().any(char::is_control)
        || value.starts_with('-')
    {
        return None;
    }
    let local = match url::Url::parse(value) {
        Ok(url) => match url.scheme() {
            "https"
                if url.host_str().is_some()
                    && url.username().is_empty()
                    && url.password().is_none()
                    && url.query().is_none()
                    && url.fragment().is_none()
                    && url.path() != "/" =>
            {
                return Some(url);
            }
            "file"
                if url.host_str().is_none()
                    && url.query().is_none()
                    && url.fragment().is_none() =>
            {
                url.to_file_path().ok()?
            }
            _ => return None,
        },
        Err(_) if !value.contains(':') => source.join(value),
        Err(_) => return None,
    };
    let remote = local.canonicalize().ok()?;
    if remote.starts_with(disposable.canonicalize().ok()?) || remote == Path::new("/") {
        return None;
    }
    url::Url::from_file_path(remote).ok()
}

fn reject_object_links(directory: &Path) -> Result<()> {
    paths::verify_directory(directory)?;
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let metadata = entry.file_type()?;
        ensure!(
            !metadata.is_symlink(),
            "Git object directory contains a symlink"
        );
        if metadata.is_dir() {
            reject_object_links(&entry.path())?;
        } else {
            ensure!(
                metadata.is_file(),
                "Git object directory contains a special file"
            );
        }
    }
    let alternates = directory.join("info/alternates");
    ensure!(
        !alternates.try_exists()? || fs::metadata(&alternates)?.len() == 0,
        "Git object alternates require an explicit import"
    );
    Ok(())
}

#[derive(Debug)]
pub(crate) struct GitExit {
    pub(crate) code: Option<i32>,
    stderr: String,
}
impl std::fmt::Display for GitExit {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "Git command failed ({:?}): {}",
            self.code, self.stderr
        )
    }
}
impl std::error::Error for GitExit {}

async fn limited(mut reader: impl AsyncRead + Unpin, maximum: usize) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    (&mut reader)
        .take(maximum as u64 + 1)
        .read_to_end(&mut bytes)
        .await?;
    ensure!(bytes.len() <= maximum, "Git output exceeds its size limit");
    Ok(bytes)
}

pub(crate) async fn run(
    mut command: Command,
    input: &[u8],
    cancel: &CancellationToken,
    maximum: usize,
    timeout: Duration,
) -> Result<Vec<u8>> {
    check_cancelled(cancel)?;
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    command.as_std_mut().process_group(0);
    let mut child = command.spawn().context("start trusted Git executable")?;
    let pid = child.id().context("Git child has no process ID")?;
    let mut stdin = child.stdin.take().context("Git stdin unavailable")?;
    let stdout = child.stdout.take().context("Git stdout unavailable")?;
    let stderr = child.stderr.take().context("Git stderr unavailable")?;
    let result = tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(anyhow::anyhow!("workspace operation cancelled")),
        _ = tokio::time::sleep(timeout) => Err(anyhow::anyhow!("Git command exceeded its deadline")),
        result = async {
            let ((), stdout, stderr, status) = tokio::try_join!(async { stdin.write_all(input).await?; stdin.shutdown().await?; drop(stdin); Ok::<_, anyhow::Error>(()) }, limited(stdout, maximum), limited(stderr, 65_536), async { Ok::<_, anyhow::Error>(child.wait().await?) })?;
            if !status.success() { return Err(GitExit { code: status.code(), stderr: String::from_utf8_lossy(&stderr).trim().into() }.into()); }
            Ok(stdout)
        } => result,
    };
    if result.is_err() {
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
        let _ = child.wait().await;
    }
    result
}

/// Runs `command` without input and returns its exit code and output whatever the code, for a
/// command whose failure code carries meaning.
pub(crate) async fn run_status(
    mut command: Command,
    cancel: &CancellationToken,
    maximum: usize,
    timeout: Duration,
) -> Result<(Option<i32>, Vec<u8>)> {
    check_cancelled(cancel)?;
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    command.as_std_mut().process_group(0);
    let mut child = command.spawn().context("start trusted Git executable")?;
    let pid = child.id().context("Git child has no process ID")?;
    let stdout = child.stdout.take().context("Git stdout unavailable")?;
    let stderr = child.stderr.take().context("Git stderr unavailable")?;
    let result = tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(anyhow::anyhow!("workspace operation cancelled")),
        _ = tokio::time::sleep(timeout) => Err(anyhow::anyhow!("Git command exceeded its deadline")),
        result = async {
            let (stdout, _, status) = tokio::try_join!(limited(stdout, maximum), limited(stderr, 65_536), async { Ok::<_, anyhow::Error>(child.wait().await?) })?;
            Ok((status.code(), stdout))
        } => result,
    };
    if result.is_err() {
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
        let _ = child.wait().await;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cancelling_a_native_command_reaps_its_process_group() -> Result<()> {
        let root = tempfile::tempdir()?;
        let started = root.path().join("started");
        let mut command = Command::new("/bin/sh");
        command
            .args(["-c", "echo $$ > \"$1\"; exec /bin/sleep 60", "fixture"])
            .arg(&started);
        let token = CancellationToken::new();
        let task_token = token.clone();
        let task =
            tokio::spawn(
                async move { run(command, &[], &task_token, 1024, COMMAND_TIMEOUT).await },
            );
        // The shell's redirect creates the file before `echo` writes the PID and its newline.
        let pid: i32 = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Ok(text) = fs::read_to_string(&started)
                    && text.ends_with('\n')
                {
                    return text;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await?
        .trim()
        .parse()?;
        token.cancel();
        let result = tokio::time::timeout(Duration::from_secs(5), task).await??;
        ensure!(result.is_err());
        ensure!(unsafe { libc::kill(pid, 0) } == -1);
        ensure!(std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH));
        Ok(())
    }
}
