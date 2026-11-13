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

const COMMAND_TIMEOUT: Duration = Duration::from_secs(120);
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
            check_cancelled(cancel)?;
            let source_objects = source_objects(source)?;
            reject_object_links(&source_objects)?;
            let pack = repository
                .command(
                    &["pack-objects", "--stdout", "--revs"],
                    format!("{base}\n").as_bytes(),
                    &[("GIT_OBJECT_DIRECTORY", source_objects.into_os_string())],
                    cancel,
                )
                .await?;
            repository
                .command(&["index-pack", "--stdin", "--strict"], &pack, &[], cancel)
                .await?;
            repository.verify_commit(base, cancel).await?;
        }
        Ok(repository)
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
        ensure!(
            !self.git_dir.join("config.worktree").try_exists()?,
            "unexpected worktree Git configuration"
        );
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

    pub(crate) async fn checkout(
        &self,
        directory: &Path,
        start: &str,
        entries: &BTreeMap<String, TreeEntry>,
        cancel: &CancellationToken,
    ) -> Result<()> {
        for entry in entries.values().filter(|entry| entry.mode == "120000") {
            let target = self
                .command(&["cat-file", "blob", &entry.oid], &[], &[], cancel)
                .await?;
            paths::validate_link(&entry.path, &target)?;
        }
        let checkout = self.checkout_metadata(directory, start, cancel).await?;
        checkout
            .command(&["checkout-index", "--all", "--force"], &[], &[], cancel)
            .await?;
        // Verify bytes and modes after checkout rather than trusting config, name
        // normalization, or a successful Git exit to imply the exact pinned tree.
        let actual = paths::scan(directory, cancel)?;
        ensure!(
            actual.len() == entries.len(),
            "materialized checkout differs from its pinned tree"
        );
        for (path, expected) in entries {
            check_cancelled(cancel)?;
            let actual = paths::read_checkout_file(directory, path)?;
            ensure!(
                actual.mode == expected.mode
                    && blob_oid(&actual.bytes, self.oid_length) == expected.oid,
                "materialized file differs from its pinned tree: {path}"
            );
        }
        check_cancelled(cancel)?;
        Ok(())
    }

    /// Recreate minimal, trusted Git metadata without reading checkout metadata
    /// or modifying its file tree. Used when installing a remote tree snapshot.
    pub(crate) async fn checkout_metadata(
        &self,
        directory: &Path,
        start: &str,
        cancel: &CancellationToken,
    ) -> Result<Self> {
        paths::create_private_root(directory)?;
        let git_dir = directory.join(".git");
        initialize(&git_dir, self.oid_length, false)?;
        let checkout = Repository {
            root: directory.to_owned(),
            git_dir,
            oid_length: self.oid_length,
            bare: false,
        };
        let pack = self
            .command(
                &["pack-objects", "--stdout", "--revs"],
                format!("{start}\n").as_bytes(),
                &[],
                cancel,
            )
            .await?;
        checkout
            .command(&["index-pack", "--stdin", "--strict"], &pack, &[], cancel)
            .await?;
        checkout
            .command(&["update-ref", "HEAD", start], &[], &[], cancel)
            .await?;
        checkout
            .command(&["read-tree", "--reset", start], &[], &[], cancel)
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
        parent: &str,
        subject: &str,
        seconds: u64,
        cancel: &CancellationToken,
    ) -> Result<String> {
        let date = OsString::from(format!("{seconds} +0000"));
        let environment = [
            ("GIT_AUTHOR_NAME", "SuperTag".into()),
            ("GIT_AUTHOR_EMAIL", "supertag@localhost".into()),
            ("GIT_COMMITTER_NAME", "SuperTag".into()),
            ("GIT_COMMITTER_EMAIL", "supertag@localhost".into()),
            ("GIT_AUTHOR_DATE", date.clone()),
            ("GIT_COMMITTER_DATE", date),
        ];
        output_oid(
            self.command(
                &["commit-tree", tree, "-p", parent, "-m", subject],
                &[],
                &environment,
                cancel,
            )
            .await?,
        )
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

    pub(crate) async fn bundle(
        &self,
        head: &str,
        id: &str,
        file: &Path,
        cancel: &CancellationToken,
    ) -> Result<()> {
        let reference = format!("refs/heads/supertag-deliveries/{id}");
        self.command(&["update-ref", &reference, head], &[], &[], cancel)
            .await?;
        let file = file.to_str().context("bundle path is not UTF-8")?;
        self.command(&["bundle", "create", file, &reference], &[], &[], cancel)
            .await?;
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

    pub(crate) async fn import_bundle(
        &self,
        file: &Path,
        head: &str,
        cancel: &CancellationToken,
    ) -> Result<()> {
        let file = file.to_str().context("bundle path is not UTF-8")?;
        self.command(&["bundle", "verify", file], &[], &[], cancel)
            .await?;
        let heads = self
            .command(&["bundle", "list-heads", file], &[], &[], cancel)
            .await?;
        let advertised = String::from_utf8(heads)?;
        ensure!(
            advertised
                .lines()
                .any(|line| line.split_once(' ').is_some_and(|(oid, _)| oid == head)),
            "approved commit is not an advertised bundle head"
        );
        self.command(&["bundle", "unbundle", file], &[], &[], cancel)
            .await?;
        self.verify_commit(head, cancel).await
    }

    pub(crate) fn sync(&self) -> Result<()> {
        paths::sync_tree(&self.git_dir)
    }
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
struct GitExit {
    code: Option<i32>,
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

async fn run(
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
        tokio::time::timeout(Duration::from_secs(5), async {
            while !started.exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await?;
        let pid: i32 = fs::read_to_string(started)?.trim().parse()?;
        token.cancel();
        let result = tokio::time::timeout(Duration::from_secs(5), task).await??;
        ensure!(result.is_err());
        ensure!(unsafe { libc::kill(pid, 0) } == -1);
        ensure!(std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH));
        Ok(())
    }
}
