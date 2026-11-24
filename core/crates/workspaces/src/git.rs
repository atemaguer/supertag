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

use crate::{GitOutputFiles, check_cancelled, failure::Refusal, paths};

pub(crate) const COMMAND_TIMEOUT: Duration = Duration::from_secs(120);
const REMOTE_TIMEOUT: Duration = Duration::from_secs(15);
/// How long one object copy between repositories may take. Packing and strictly indexing a
/// monorepo's multi-gigabyte history takes minutes, not the seconds of every other Git command,
/// and the copy holds no memory of its own while it runs.
const COPY_TIMEOUT: Duration = Duration::from_secs(30 * 60);
/// How long writing a checkout's files may take. A monorepo's hundreds of thousands of files take
/// minutes on a laptop whose disk is also being indexed or scanned.
const CHECKOUT_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// The most one buffered Git read keeps. Object copies, which grow with a repository's history
/// and tree, stream between Git children instead (see [`pipeline`]), and a remote's ref
/// advertisement is read line by line, so what stays buffered is a listing of one tree or of a
/// checkout's changes: 256 MiB holds the `ls-tree` of a tree of about two million files.
const MAX_OUTPUT: usize = 268_435_456;
/// How much of a line of a remote's ref listing is read: an object ID, a tab, and a ref name.
const MAX_LINE: usize = 4096;
/// The longest entry of a tree listing: a mode, an object ID, and a path. No file system this
/// runs on holds a path longer than 4 KiB.
const MAX_TREE_ENTRY: usize = 8192;
/// Flaws in the format of old commits and trees that Git's strict checks refuse but every Git
/// reads the same way: a malformed date, time zone, name or email, or a file mode written with a
/// leading zero. Old histories, such as those converted from another version control system, hold
/// them, and hosting services accept them. They are let through when copying objects this host
/// already trusts as its operator's repository; every other strict check stays, including those
/// on paths, `.gitmodules`, and links between objects.
const HISTORY_FORMAT_FLAWS: &str = "badDate=ignore,badDateOverflow=ignore,badEmail=ignore,badName=ignore,badTimezone=ignore,missingEmail=ignore,missingNameBeforeEmail=ignore,missingSpaceBeforeDate=ignore,missingSpaceBeforeEmail=ignore,zeroPaddedDate=ignore,zeroPaddedFilemode=ignore";
/// The attributes written to a checkout's `.git/info/attributes`, which override the
/// repository's own `.gitattributes`: no line-ending, encoding, `$Id$`, or filter conversion.
/// A checkout's files are the bytes Git stores, which is what verification and delivery compare;
/// a repository that asks for CRLF batch files would otherwise fail its own verification.
const CHECKOUT_ATTRIBUTES: &[u8] = b"* -text -crlf -ident -filter -working-tree-encoding\n";

/// Which objects a copy between repositories lets through.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Checks {
    /// Every strict check: for objects that came from another host.
    Strict,
    /// Every strict check except [`HISTORY_FORMAT_FLAWS`]: for the operator's own repository
    /// and objects already copied from it.
    OwnHistory,
}
/// The largest local source configuration read to find its remote.
const MAX_SOURCE_CONFIG: usize = 8 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct TreeEntry {
    pub path: String,
    pub mode: String,
    pub oid: String,
}

/// What a commit's tree holds: its files, and its submodules.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Tree {
    /// Regular files and symbolic links, by path.
    pub files: BTreeMap<String, TreeEntry>,
    /// The commit each submodule path pins (a tree entry of mode 160000). A checkout holds an
    /// empty directory at each, and a delivery carries every one through unchanged.
    pub submodules: BTreeMap<String, String>,
}

/// What to do when the source repository of a copy is a shallow clone.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum ShallowSource {
    /// Copy the history the source holds and record where it stops: a local Workspace.
    Adopted,
    /// Refuse: a remote Workspace's source is bundled whole for other hosts.
    Refused,
}

/// The largest `shallow` file read: about 200,000 boundary commits.
const MAX_SHALLOW: usize = 8 * 1024 * 1024;

/// The commits a `shallow` file lists, the ones whose parents the repository does not hold.
/// Its whole content must be full object IDs of this repository's format, one to a line.
fn parse_shallow(bytes: &[u8], oid_length: usize) -> Result<BTreeSet<String>> {
    let text = std::str::from_utf8(bytes).context("Git shallow file is not text")?;
    text.lines()
        .map(|line| {
            ensure!(
                line.len() == oid_length && validate_oid(line).is_ok(),
                "Git shallow file holds something other than commit IDs"
            );
            Ok(line.to_owned())
        })
        .collect()
}

/// The validated `shallow` file of the Git directory `git_dir`; empty when it has none.
fn read_shallow(git_dir: &Path, oid_length: usize) -> Result<BTreeSet<String>> {
    match paths::read_regular(&git_dir.join("shallow"), MAX_SHALLOW) {
        Ok(bytes) => parse_shallow(&bytes, oid_length),
        Err(error)
            if error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
        {
            Ok(BTreeSet::new())
        }
        Err(error) => Err(error),
    }
}

fn shallow_bytes(commits: &BTreeSet<String>) -> Vec<u8> {
    commits
        .iter()
        .flat_map(|commit| format!("{commit}\n").into_bytes())
        .collect()
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

/// Removes every empty directory under `directory` (`prefix` relative to the checkout), except
/// `.git` and `keep`, without following links. Returns whether `directory` itself is now empty.
fn remove_empty_directories(directory: &Path, prefix: &str, keep: &[String]) -> Result<bool> {
    let mut empty = true;
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_str().context("checkout path is not UTF-8")?;
        let path = if prefix.is_empty() {
            name.to_owned()
        } else {
            format!("{prefix}/{name}")
        };
        if entry.file_type()?.is_dir()
            && !(prefix.is_empty() && name == ".git")
            && !keep.contains(&path)
            && remove_empty_directories(&entry.path(), &path, keep)?
        {
            fs::remove_dir(entry.path())?;
        } else {
            empty = false;
        }
    }
    Ok(empty)
}

/// Copies the pack and index files in `from` to `to`. Copies, not links: a checkout's packs are
/// writable by its harness, and a trusted copy must not change with them. Copying clones the file
/// where the file system can.
pub(crate) fn copy_packs(from: &Path, to: &Path) -> Result<()> {
    paths::verify_directory(from)?;
    paths::verify_directory(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_str().context("pack file name is not UTF-8")?;
        ensure!(
            name.starts_with("pack-")
                && [".pack", ".idx", ".rev"]
                    .iter()
                    .any(|suffix| name.ends_with(suffix))
                && entry.file_type()?.is_file(),
            "unexpected file among packs: {name}"
        );
        let target = to.join(name);
        if fs::symlink_metadata(&target).is_ok() {
            continue;
        }
        fs::copy(entry.path(), &target)?;
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
        shallow: ShallowSource,
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
            repository
                .import_from_source(source, base, shallow, cancel)
                .await?;
        }
        Ok(repository)
    }

    /// Copies `commit` and its history from a local source repository's object store, without
    /// reading its configuration, refs, or hooks.
    ///
    /// A shallow source ([`ShallowSource::Adopted`]) gives the history it holds, and this
    /// repository records where that stops (see [`Self::copy_cut`]). When the source has since
    /// been deepened, the history it gained behind this repository's boundary is copied too.
    pub(crate) async fn import_from_source(
        &self,
        source: &Path,
        commit: &str,
        shallow: ShallowSource,
        cancel: &CancellationToken,
    ) -> Result<()> {
        if self.verify_commit(commit, cancel).await.is_ok() {
            return Ok(());
        }
        self.copy_from_source(source, Some(commit), shallow, cancel)
            .await?;
        self.verify_commit(commit, cancel).await
    }

    /// Copies from the source `commit`, if any, and whatever history the source now holds behind
    /// this repository's shallow boundary.
    async fn copy_from_source(
        &self,
        source: &Path,
        commit: Option<&str>,
        shallow: ShallowSource,
        cancel: &CancellationToken,
    ) -> Result<()> {
        check_cancelled(cancel)?;
        let source_objects = source_objects(source)?;
        refuse_borrowed_objects(&source_objects)?;
        reject_object_links(&source_objects)?;
        let from_source = [(
            "GIT_OBJECT_DIRECTORY",
            source_objects.clone().into_os_string(),
        )];
        let mut revisions: BTreeSet<String> = commit.map(str::to_owned).into_iter().collect();
        let boundary = match shallow {
            // The walk meets the source's missing history and fails; the failure is explained.
            ShallowSource::Refused => BTreeSet::new(),
            ShallowSource::Adopted => {
                let boundary = source_shallow(source, self.oid_length)?;
                // A commit this repository stops at, and the source no longer does: the source
                // was deepened, and holds the parents this repository lacks.
                let stale: BTreeSet<String> =
                    self.shallow()?.difference(&boundary).cloned().collect();
                let parents = self.recorded_parents(&stale, cancel).await?;
                let named: BTreeSet<String> = parents.values().flatten().cloned().collect();
                let in_source = self.held(&named, &from_source, cancel).await?;
                for parents in parents.into_values() {
                    if parents.iter().all(|parent| in_source.contains(parent)) {
                        revisions.extend(parents);
                    }
                }
                boundary
            }
        };
        if revisions.is_empty() {
            return Ok(());
        }
        let revisions: String = revisions.iter().map(|oid| format!("{oid}\n")).collect();
        self.copy_cut(&source_objects, &boundary, revisions.as_bytes(), cancel)
            .await
            .map_err(|error| explain_source_copy(&source_objects, shallow, error))
            .context("copy the commit's history from the source repository")
    }

    /// Makes this repository hold the whole history of its commits, copying from the source
    /// what the source gained since it was a shallow clone, and refuses when history is still
    /// missing: `needs` says what cannot do without it.
    pub(crate) async fn require_whole_history(
        &self,
        source: &Path,
        needs: &str,
        cancel: &CancellationToken,
    ) -> Result<()> {
        if self.shallow()?.is_empty() {
            return Ok(());
        }
        self.copy_from_source(source, None, ShallowSource::Adopted, cancel)
            .await?;
        if self.shallow()?.is_empty() {
            return Ok(());
        }
        Err(Refusal(format!(
            "the repository is a shallow clone, and {needs} needs the whole history of the commit it starts from. Run `git fetch --unshallow` in the repository and try again"
        ))
        .into())
    }

    /// The commits whose parents this repository does not hold: its `shallow` file, which must
    /// be a plain file listing commit IDs and nothing else.
    pub(crate) fn shallow(&self) -> Result<BTreeSet<String>> {
        read_shallow(&self.git_dir, self.oid_length).context("unexpected Git metadata: shallow")
    }

    /// Replaces the `shallow` file in one step, so a reader sees the old list or the new one.
    fn write_shallow(&self, commits: &BTreeSet<String>) -> Result<()> {
        let path = self.git_dir.join("shallow");
        if commits.is_empty() {
            match fs::remove_file(&path) {
                Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                    return Err(error.into());
                }
                _ => {}
            }
        } else {
            let mut file = tempfile::NamedTempFile::new_in(&self.git_dir)?;
            std::io::Write::write_all(&mut file, &shallow_bytes(commits))?;
            file.as_file().sync_all()?;
            file.persist(&path)?;
        }
        fs::File::open(&self.git_dir)?.sync_all()?;
        Ok(())
    }

    /// Copies what `revisions` select from the object store `objects`, whose history stops at
    /// `boundary` (its own `shallow` list), and keeps this repository's `shallow` file true.
    ///
    /// The walk over `objects` is cut where that store is cut, never where this repository is.
    /// This repository's list first grows to cover every commit that may arrive without its
    /// parents, so the strict check of the incoming pack accepts them and a crash leaves a list
    /// that hides too much history rather than one that names missing commits. Once the objects
    /// are in, the list shrinks to exactly the commits here with a parent that is not.
    async fn copy_cut(
        &self,
        objects: &Path,
        boundary: &BTreeSet<String>,
        revisions: &[u8],
        cancel: &CancellationToken,
    ) -> Result<()> {
        let mut environment = vec![("GIT_OBJECT_DIRECTORY", objects.as_os_str().to_owned())];
        let own = self.shallow()?;
        if boundary.is_empty() && own.is_empty() {
            let pack = self.git(&["pack-objects", "--stdout", "--revs"], &environment)?;
            return self
                .copy_objects(vec![pack], revisions, Checks::OwnHistory, cancel)
                .await;
        }
        let temporary = self.root.join("temporary");
        paths::create_private_root(&temporary)?;
        let scratch = tempfile::Builder::new()
            .prefix("shallow-")
            .tempdir_in(&temporary)?;
        // Read in place of this repository's own list, even when it is empty.
        let cut = scratch.path().join("shallow");
        crate::write_synced(&cut, &shallow_bytes(boundary))?;
        environment.push(("GIT_SHALLOW_FILE", cut.into_os_string()));
        let candidates: BTreeSet<String> = own.union(boundary).cloned().collect();
        if candidates != own {
            self.write_shallow(&candidates)?;
        }
        let pack = self.git(&["pack-objects", "--stdout", "--revs"], &environment)?;
        let copied = self
            .copy_objects(vec![pack], revisions, Checks::OwnHistory, cancel)
            .await;
        // Also after a failed copy, which brought nothing the wider list was for.
        let settled = self.settle_shallow(&candidates, cancel).await;
        copied.and(settled)
    }

    /// Rewrites the `shallow` file as exactly those of `candidates` that are commits here with
    /// a parent that is not.
    async fn settle_shallow(
        &self,
        candidates: &BTreeSet<String>,
        cancel: &CancellationToken,
    ) -> Result<()> {
        let parents = self.recorded_parents(candidates, cancel).await?;
        let named: BTreeSet<String> = parents.values().flatten().cloned().collect();
        let here = self.held(&named, &[], cancel).await?;
        let cut_here: BTreeSet<String> = parents
            .into_iter()
            .filter(|(_, parents)| parents.iter().any(|parent| !here.contains(parent)))
            .map(|(commit, _)| commit)
            .collect();
        if cut_here != *candidates {
            self.write_shallow(&cut_here)?;
        }
        Ok(())
    }

    /// The parents each of `commits` names, read from the commit itself and so whatever a
    /// `shallow` file hides. A name that is not a commit in this repository has no entry.
    async fn recorded_parents(
        &self,
        commits: &BTreeSet<String>,
        cancel: &CancellationToken,
    ) -> Result<BTreeMap<String, Vec<String>>> {
        let mut parents = BTreeMap::new();
        if commits.is_empty() {
            return Ok(parents);
        }
        let wanted: String = commits.iter().map(|oid| format!("{oid}\n")).collect();
        let bytes = self
            .command(&["cat-file", "--batch"], wanted.as_bytes(), &[], cancel)
            .await?;
        // Each answer: `<object ID> missing`, or `<object ID> <kind> <size>`, a newline, the
        // object, and a newline.
        let mut rest = bytes.as_slice();
        for commit in commits {
            let end = rest
                .iter()
                .position(|byte| *byte == b'\n')
                .context("Git did not answer for a commit")?;
            let header = std::str::from_utf8(&rest[..end])?
                .strip_prefix(commit.as_str())
                .context("Git answered for another object")?;
            if header == " missing" {
                rest = &rest[end + 1..];
                continue;
            }
            let (kind, size) = header
                .trim_start()
                .split_once(' ')
                .context("invalid Git object header")?;
            let size: usize = size.parse()?;
            let object = rest
                .get(end + 1..end + 1 + size)
                .context("Git cut an object short")?;
            if kind == "commit" {
                let mut named = Vec::new();
                for line in object.split(|byte| *byte == b'\n') {
                    if line.is_empty() {
                        break;
                    }
                    if let Some(parent) = line.strip_prefix(b"parent ") {
                        let parent = std::str::from_utf8(parent)?;
                        validate_oid(parent)?;
                        named.push(parent.to_owned());
                    }
                }
                parents.insert(commit.clone(), named);
            }
            rest = rest.get(end + size + 2..).unwrap_or_default();
        }
        Ok(parents)
    }

    /// Which of `objects` an object store holds: this repository's, or with `environment` the
    /// one it names.
    async fn held(
        &self,
        objects: &BTreeSet<String>,
        environment: &[(&str, OsString)],
        cancel: &CancellationToken,
    ) -> Result<BTreeSet<String>> {
        if objects.is_empty() {
            return Ok(BTreeSet::new());
        }
        let wanted: String = objects.iter().map(|oid| format!("{oid}\n")).collect();
        let bytes = self
            .command(
                &["cat-file", "--batch-check"],
                wanted.as_bytes(),
                environment,
                cancel,
            )
            .await?;
        Ok(std::str::from_utf8(&bytes)?
            .lines()
            .filter(|line| !line.ends_with(" missing"))
            .filter_map(|line| line.split(' ').next())
            .map(str::to_owned)
            .collect())
    }

    /// Copies `head`, a commit that contains `base`, from another Workspace state directory of
    /// the same source and base, such as another lane's: only the objects `head` reaches beyond
    /// `base`, which this repository already holds with its history. Nothing is bundled.
    pub(crate) async fn import_held(
        &self,
        holder: &Repository,
        base: &str,
        head: &str,
        cancel: &CancellationToken,
    ) -> Result<()> {
        validate_oid(base)?;
        validate_oid(head)?;
        ensure!(
            holder.oid_length == self.oid_length,
            "the holding Workspace uses another object format"
        );
        self.verify_commit(base, cancel).await?;
        if self.verify_commit(head, cancel).await.is_ok() {
            return self.assert_ancestor(base, head, cancel).await;
        }
        holder.assert_ancestor(base, head, cancel).await?;
        let objects = holder.git_dir.join("objects");
        reject_object_links(&objects)?;
        // `--revs` without `--thin`: every object comes whole or as a delta within the pack.
        // The holder may have copied the source when it was cut elsewhere than it was for this
        // repository, and a merged commit's history stops where the holder's does.
        self.copy_cut(
            &objects,
            &holder.shallow()?,
            format!("{head}\n^{base}\n").as_bytes(),
            cancel,
        )
        .await
        .context("copy the Session's commits from the Workspace that holds them")?;
        self.assert_ancestor(base, head, cancel).await
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
        self.command_within(args, input, extra, COMMAND_TIMEOUT, cancel)
            .await
    }

    async fn command_within(
        &self,
        args: &[&str],
        input: &[u8],
        extra: &[(&str, OsString)],
        timeout: Duration,
        cancel: &CancellationToken,
    ) -> Result<Vec<u8>> {
        run(self.git(args, extra)?, input, cancel, MAX_OUTPUT, timeout).await
    }

    /// Writes into this repository the objects one or more stages before it select:
    /// `stages | pack-objects --stdout | index-pack --stdin --strict`, the pack streaming between
    /// the Git children and never through this process. A monorepo's history or tree packs to
    /// gigabytes, so the pack has no size bound here; the copy only has its deadline.
    async fn copy_objects(
        &self,
        stages: Vec<Command>,
        input: &[u8],
        checks: Checks,
        cancel: &CancellationToken,
    ) -> Result<()> {
        let mut stages = stages;
        let strict = match checks {
            Checks::Strict => "--strict".to_owned(),
            Checks::OwnHistory => format!("--strict={HISTORY_FORMAT_FLAWS}"),
        };
        stages.push(self.git(&["index-pack", "--stdin", &strict], &[])?);
        pipeline(stages, input, cancel, 64 * 1024, COPY_TIMEOUT).await?;
        Ok(())
    }

    /// A hardened Git command for this repository, after checking its configuration and
    /// metadata have not changed.
    fn git(&self, args: &[&str], extra: &[(&str, OsString)]) -> Result<Command> {
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
        // The one file besides the configuration that changes what Git reads as history. It
        // may only list commits whose parents are hidden, which can hide history and never
        // add any: a plain file of object IDs, or absent.
        self.shallow()?;
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
        Ok(command)
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

    pub(crate) async fn tree(&self, commit: &str, cancel: &CancellationToken) -> Result<Tree> {
        // Read an entry at a time: the listing of a monorepo's tree is larger than any buffer
        // worth keeping beside the entries themselves.
        let mut entries = BTreeMap::new();
        let mut submodules = BTreeMap::new();
        records(
            self.git(&["ls-tree", "-rz", "--full-tree", commit], &[])?,
            (0, MAX_TREE_ENTRY, Overlong::Fail),
            cancel,
            COMMAND_TIMEOUT,
            |entry| {
                if entry.is_empty() {
                    return Ok(true);
                }
                let tab = entry
                    .iter()
                    .position(|byte| *byte == b'\t')
                    .context("invalid Git tree entry")?;
                let header = std::str::from_utf8(&entry[..tab])?;
                let mut fields = header.split(' ');
                let mode = fields.next().context("missing Git mode")?.to_owned();
                let kind = fields.next().context("missing Git object kind")?;
                let name = String::from_utf8_lossy(&entry[tab + 1..]);
                let oid = fields.next().context("missing Git object ID")?.to_owned();
                validate_oid(&oid)?;
                // A submodule: a commit of another repository, which this one only names.
                let submodule = kind == "commit" && mode == "160000";
                ensure!(submodule || kind == "blob", "unexpected Git tree entry");
                if !submodule && !matches!(mode.as_str(), "100644" | "100755" | "120000") {
                    return Err(Refusal(format!(
                        "the repository tracks `{name}` with the file mode {mode}, which SuperTag does not support"
                    ))
                    .into());
                }
                let Ok(path) = std::str::from_utf8(&entry[tab + 1..]) else {
                    return Err(Refusal(format!(
                        "the repository tracks a file whose name is not UTF-8 (`{name}`), which SuperTag does not support"
                    ))
                    .into());
                };
                if paths::validate_repo_path(path).is_err() {
                    return Err(Refusal(format!(
                        "the repository tracks `{path}`, a path SuperTag does not check out: no part of a path may be `.git`, `.` or `..`, or contain a backslash"
                    ))
                    .into());
                }
                let path = path.to_owned();
                ensure!(
                    if submodule {
                        submodules.insert(path, oid).is_none()
                    } else {
                        entries
                            .insert(path.clone(), TreeEntry { path, mode, oid })
                            .is_none()
                    },
                    "duplicate Git tree path"
                );
                Ok(true)
            },
        )
        .await?;
        Ok(Tree {
            files: entries,
            submodules,
        })
    }

    /// Checks that every symbolic link in `entries` points inside the repository. The targets
    /// are read with one Git command, however many links there are.
    async fn validate_links(
        &self,
        entries: &BTreeMap<String, TreeEntry>,
        cancel: &CancellationToken,
    ) -> Result<()> {
        let links: Vec<&TreeEntry> = entries
            .values()
            .filter(|entry| entry.mode == "120000")
            .collect();
        if links.is_empty() {
            return Ok(());
        }
        let wanted: String = links.iter().map(|link| format!("{}\n", link.oid)).collect();
        let bytes = self
            .command(&["cat-file", "--batch"], wanted.as_bytes(), &[], cancel)
            .await?;
        // Each answer: `<object ID> blob <size>`, a newline, the bytes, a newline.
        let mut rest = bytes.as_slice();
        for link in links {
            let end = rest
                .iter()
                .position(|byte| *byte == b'\n')
                .context("Git did not answer for a symbolic link")?;
            let header = std::str::from_utf8(&rest[..end])?;
            let size: usize = header
                .strip_prefix(link.oid.as_str())
                .and_then(|header| header.strip_prefix(" blob "))
                .context("a symbolic link is not a blob")?
                .parse()?;
            let target = rest
                .get(end + 1..end + 1 + size)
                .context("Git cut a symbolic link's target short")?;
            if paths::validate_link(&link.path, target).is_err() {
                return Err(Refusal(format!(
                    "the repository tracks a symbolic link that points outside the repository (`{}`), which SuperTag does not check out",
                    link.path
                ))
                .into());
            }
            rest = rest.get(end + size + 2..).unwrap_or_default();
        }
        Ok(())
    }

    /// Writes a checkout of `start`, or with `index_tree` of that tree on top of `start` (a merge
    /// follow-up's merge), and verifies every file against `entries`.
    pub(crate) async fn checkout(
        &self,
        directory: &Path,
        (base, start): (&str, &str),
        index_tree: Option<&str>,
        entries: &Tree,
        cancel: &CancellationToken,
    ) -> Result<()> {
        self.validate_links(&entries.files, cancel).await?;
        let checkout = self
            .checkout_metadata_with(directory, base, start, index_tree, None, cancel)
            .await?;
        // Git writes the files on several workers.
        let workers = format!("checkout.workers={}", parallelism());
        checkout
            .command_within(
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
                CHECKOUT_TIMEOUT,
                cancel,
            )
            .await?;
        // Git makes a directory for each submodule; made here too, so none depends on that.
        for path in entries.submodules.keys() {
            paths::create_directories(directory, path)?;
        }
        // Verify bytes and modes after checkout rather than trusting config, name
        // normalization, or a successful Git exit to imply the exact pinned tree.
        self.verify_files(directory, entries, &[], cancel).await
    }

    /// Moves a Session's previous checkout, whose files are its delivered head `start`, to the
    /// next Attempt without writing its files again. The previous `.git` must already be gone:
    /// the harness could write it. The new one is built from `packs`, the objects SuperTag wrote
    /// for the previous Attempt from `prior_start` (kept where the harness cannot write), and a
    /// pack of only the commits since. Files Git does not track at `start` are removed, except
    /// `keep` (setup outputs), and every tracked file is verified: an error means the caller takes
    /// a fresh checkout.
    pub(crate) async fn reuse_checkout(
        &self,
        directory: &Path,
        (base, start, prior_start): (&str, &str, &str),
        (packs, keep): (&Path, &[String]),
        entries: &Tree,
        cancel: &CancellationToken,
    ) -> Result<()> {
        validate_oid(prior_start)?;
        self.assert_ancestor(prior_start, start, cancel).await?;
        self.validate_links(&entries.files, cancel).await?;
        ensure!(
            fs::symlink_metadata(directory.join(".git"))
                .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound),
            "a reused checkout still has the harness's Git metadata"
        );
        self.checkout_metadata_with(
            directory,
            base,
            start,
            None,
            Some((packs, prior_start)),
            cancel,
        )
        .await?;
        let (root, tracked, kept, stop) = (
            directory.to_owned(),
            entries.files.clone(),
            keep.to_vec(),
            cancel.clone(),
        );
        let submodules: Vec<String> = entries.submodules.keys().cloned().collect();
        tokio::task::spawn_blocking(move || -> Result<()> {
            // Whatever the last Attempt left that Git does not track, such as build output and
            // dependencies, is removed as the walk meets it, so none of it is listed.
            paths::walk(&root, &kept, &stop, &mut |entry| {
                if entry.found == paths::Found::Directory {
                    return Ok(true);
                }
                if !tracked.contains_key(entry.path) {
                    entry.remove()?;
                }
                Ok(false)
            })?;
            // Empty directories go too, as a fresh checkout has none but one for each submodule,
            // which holds nothing: whatever the last Attempt left in one went with the rest.
            remove_empty_directories(&root, "", &kept)?;
            for path in &submodules {
                paths::create_directories(&root, path)?;
            }
            // A file hard-linked elsewhere would let this Attempt write outside its checkout.
            for path in tracked.keys() {
                if let Some((_, _, links)) = paths::file_identity(&root, path)? {
                    ensure!(links == 1, "a reused checkout file has other links: {path}");
                }
            }
            Ok(())
        })
        .await
        .context("reused checkout cleanup stopped")??;
        self.verify_files(directory, entries, keep, cancel).await
    }

    /// Checks that the checkout's files, besides `skip`, are exactly `entries`, bytes and modes,
    /// and that each submodule path is an empty directory. Reading and hashing every file runs
    /// on blocking threads, so the caller's lease renewal goes on.
    async fn verify_files(
        &self,
        directory: &Path,
        entries: &Tree,
        skip: &[String],
        cancel: &CancellationToken,
    ) -> Result<()> {
        let (directory, submodules, entries, skip, cancel) = (
            directory.to_owned(),
            entries.submodules.clone(),
            entries.files.clone(),
            skip.to_vec(),
            cancel.clone(),
        );
        let oid_length = self.oid_length;
        tokio::task::spawn_blocking(move || {
            // The checkout must hold exactly the tracked files, so the scan stops at one more.
            let actual = match paths::scan(&directory, &skip, entries.len(), &cancel) {
                Ok(actual) => actual.len(),
                Err(error) if error.is::<paths::TooManyFiles>() => entries.len() + 1,
                Err(error) => return Err(error),
            };
            if actual < entries.len()
                && let Some((one, other)) = case_collision(&entries)
            {
                return Err(Refusal(format!(
                    "the repository tracks paths that differ only by letter case (`{one}` and `{other}`), and the disk SuperTag keeps its checkouts on cannot hold both"
                ))
                .into());
            }
            ensure!(
                actual == entries.len(),
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
                                let actual =
                                    paths::hash_checkout_file(directory, path, oid_length)?;
                                ensure!(
                                    actual.mode == expected.mode && actual.oid == expected.oid,
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
            // A submodule is an empty directory here: nothing of it was fetched or checked out.
            for path in submodules.keys() {
                ensure!(
                    paths::directory_content(&directory, path)? == paths::Content::Empty,
                    "materialized submodule is not an empty directory: {path}"
                );
            }
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
        self.checkout_metadata_with(directory, base, start, None, None, cancel)
            .await
    }

    /// As [`Self::checkout_metadata`], with the index holding `index_tree` instead of `start`'s
    /// tree, and that tree's objects copied too. With `reuse`, the objects reachable from its
    /// commit are copied from its trusted packs instead of packed again.
    async fn checkout_metadata_with(
        &self,
        directory: &Path,
        base: &str,
        start: &str,
        index_tree: Option<&str>,
        reuse: Option<(&Path, &str)>,
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
        let information = checkout.git_dir.join("info");
        paths::create_private_root(&information)?;
        let attributes = information.join("attributes");
        if fs::symlink_metadata(&attributes).is_ok() {
            ensure!(
                paths::read_regular(&attributes, 65_536)? == CHECKOUT_ATTRIBUTES,
                "private Git attributes changed"
            );
        } else {
            crate::write_synced(&attributes, CHECKOUT_ATTRIBUTES)?;
        }
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
        // This repository hides the parents of the commits its own history stops at, so they
        // are listed with none; the checkout's history stops there too.
        let own = self.shallow()?;
        let mut shallow = String::new();
        for line in std::str::from_utf8(&parents)?.lines() {
            let mut oids = line.split(' ');
            let Some(commit) = oids.next() else { continue };
            if own.contains(commit) || oids.any(|parent| !commits.contains(parent)) {
                shallow.push_str(commit);
                shallow.push('\n');
            }
        }
        if !shallow.is_empty() {
            crate::write_synced(&checkout.git_dir.join("shallow"), shallow.as_bytes())?;
        }
        let mut listed = list.clone();
        if let Some((packs, prior_start)) = reuse {
            validate_oid(prior_start)?;
            copy_packs(packs, &checkout.git_dir.join("objects/pack"))?;
            listed.push_str(&format!("^{prior_start}\n"));
        }
        // The listed commits with their complete trees, and the merge's tree with everything in
        // it: `rev-list` names them and `pack-objects` packs them for the checkout, streaming. A
        // monorepo's tree alone packs to gigabytes.
        if let Some(tree) = index_tree {
            listed.push_str(&format!("{tree}\n"));
        }
        checkout
            .copy_objects(
                vec![
                    self.git(&["rev-list", "--objects", "--no-walk", "--stdin"], &[])?,
                    self.git(&["pack-objects", "--stdout"], &[])?,
                ],
                listed.as_bytes(),
                Checks::OwnHistory,
                cancel,
            )
            .await
            .context("copy the checkout's objects")?;
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

    /// The `names` Git ignores at `start`. With `excludes`, a file of patterns read like
    /// `core.excludesFile` also applies, below the repository's own ignore files, so its
    /// `.gitignore` can still re-include a path.
    pub(crate) async fn ignored(
        &self,
        checkout: &Path,
        start: &str,
        names: &[String],
        excludes: Option<&Path>,
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
        let setting = excludes.map(|path| format!("core.excludesFile={}", path.display()));
        let mut args: Vec<&str> = Vec::new();
        if let Some(setting) = &setting {
            args.extend(["-c", setting.as_str()]);
        }
        args.extend([
            "check-ignore",
            "--stdin",
            "-z",
            "--verbose",
            "--non-matching",
        ]);
        let bytes = self.command(&args, &input, &environment, cancel).await;
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
        // The harness can write these. They must be plain files of the checkout; their size is
        // Git's to read, and a monorepo's index is hundreds of megabytes.
        paths::verify_private_file(&repository.git_dir.join("HEAD"))?;
        paths::verify_private_file(&repository.git_dir.join("index"))?;
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
                    // Never run Git inside a submodule's directory, which the harness fills.
                    "--ignore-submodules=all",
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
                &[
                    "status",
                    "--porcelain=v1",
                    "-z",
                    "--untracked-files=all",
                    "--ignore-submodules=all",
                ],
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
                .files
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
        let head = repository.tree(&head_commit, cancel).await?.files;
        let base = if checkout.start_commit == head_commit {
            None
        } else {
            Some(repository.tree(&checkout.start_commit, cancel).await?.files)
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

    /// Writes the tree that holds the files `entries` and the `submodules`, each a path and the
    /// commit it pins. A submodule's commit is only named: this repository does not hold it.
    pub(crate) async fn write_tree(
        &self,
        entries: &BTreeMap<String, TreeEntry>,
        submodules: &BTreeMap<String, String>,
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
        for (path, commit) in submodules {
            validate_oid(commit)?;
            input.extend_from_slice(format!("160000 {commit}\t{path}\0").as_bytes());
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

    /// A bundle of `head` and its whole history, for a reader that holds none of it.
    pub(crate) async fn bundle(
        &self,
        head: &str,
        id: &str,
        file: &Path,
        cancel: &CancellationToken,
    ) -> Result<()> {
        // Git would write the history this repository holds and call it complete.
        ensure!(
            self.shallow()?.is_empty(),
            "a repository without its whole history cannot be bundled whole"
        );
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
            // The prerequisites' history is this repository's whole history: it is read a line
            // at a time, and only until every such object is found in it.
            let mut history = vec!["rev-list", "--objects"];
            history.extend(prerequisites.iter().map(String::as_str));
            let mut missing: BTreeSet<&str> = extra.iter().map(|object| object.as_str()).collect();
            records(
                isolated.git(&history, &borrowing)?,
                (b'\n', MAX_LINE, Overlong::Cut),
                cancel,
                COPY_TIMEOUT,
                |line| {
                    let name = line.split(|byte| *byte == b' ').next().unwrap_or_default();
                    if let Ok(name) = std::str::from_utf8(name) {
                        missing.remove(name);
                    }
                    Ok(!missing.is_empty())
                },
            )
            .await
            .context("delivery bundle history is incomplete")?;
            ensure!(
                missing.is_empty(),
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
        let pack = self.git(&["pack-objects", "--stdout", "--revs"], &objects)?;
        self.copy_objects(vec![pack], revisions.as_bytes(), Checks::Strict, cancel)
            .await
            .context("copy the delivery's objects from its quarantine")?;
        self.verify_commit(head, cancel).await
    }

    pub(crate) fn sync(&self) -> Result<()> {
        paths::sync_tree(&self.git_dir)
    }
}

/// How many workers write and verify a checkout: the machine's cores, at most 8.
pub(crate) fn parallelism() -> usize {
    std::thread::available_parallelism().map_or(1, |cores| cores.get().min(8))
}

/// A delivery bundle names a prerequisite commit this host does not hold, or does not hold in
/// the history of the delivery's start commit, so it cannot be imported here; the caller asks
/// for a complete bundle instead.
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

/// A Git blob ID computed a block at a time, for a blob of `size` bytes: the same ID
/// [`blob_oid`] gives the whole bytes.
pub(crate) enum BlobHasher {
    Sha1(sha1::Sha1),
    Sha256(sha2::Sha256),
}
impl BlobHasher {
    pub(crate) fn new(oid_length: usize, size: u64) -> Self {
        let header = format!("blob {size}\0");
        if oid_length == 64 {
            let mut digest = sha2::Sha256::new();
            digest.update(header);
            Self::Sha256(digest)
        } else {
            let mut digest = sha1::Sha1::new();
            digest.update(header);
            Self::Sha1(digest)
        }
    }
    pub(crate) fn update(&mut self, bytes: &[u8]) {
        match self {
            Self::Sha1(digest) => digest.update(bytes),
            Self::Sha256(digest) => digest.update(bytes),
        }
    }
    pub(crate) fn finish(self) -> String {
        match self {
            Self::Sha1(digest) => format!("{:x}", digest.finalize()),
            Self::Sha256(digest) => format!("{:x}", digest.finalize()),
        }
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

/// The commits a local source repository's history stops at: none unless it is a shallow clone.
/// A linked worktree shares its repository's list.
fn source_shallow(source: &Path, oid_length: usize) -> Result<BTreeSet<String>> {
    read_shallow(&source_git_directory(source)?, oid_length).map_err(|error| {
        error.context(Refusal(
            "the repository's `.git/shallow` file, which says where a shallow clone's history stops, could not be read as a list of commit IDs".into(),
        ))
    })
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
    // A repository's configuration grows a section for each branch that tracks a remote, about a
    // hundred bytes each: a monorepo's thousands of branches pass 64 KiB.
    let config = paths::read_regular(
        &source_git_directory(source)?.join("config"),
        MAX_SOURCE_CONFIG,
    )?;
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
    // A GitHub monorepo advertises every branch, tag, and pull request ref, megabytes in all, so
    // the advertisement is read a line at a time and the lookup stops at the commit.
    let mut advertised = false;
    records(
        lookup,
        (b'\n', MAX_LINE, Overlong::Cut),
        cancel,
        REMOTE_TIMEOUT,
        |line| {
            advertised = line.split(|byte| *byte == b'\t').next() == Some(commit.as_bytes());
            Ok(!advertised)
        },
    )
    .await?;
    Ok(advertised.then(|| remote.into()))
}

/// What a streamed listing does with a record longer than its bound.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Overlong {
    /// Fails: the record is needed whole, such as a tracked path.
    Fail,
    /// Passes on only its start: what matters comes first, such as the object ID before a
    /// remote's ref name of any length.
    Cut,
}

/// Calls `visit` with each record `command` prints, split at `delimiter`, until it answers
/// `false` or the listing ends; the command is stopped at a `false`. Only one record is held at
/// a time, at most `maximum` bytes of it, so a listing of any length, such as a monorepo's tree
/// or a remote's refs, takes no more memory than what `visit` keeps. The deadline bounds its time.
async fn records(
    mut command: Command,
    (delimiter, maximum, overlong): (u8, usize, Overlong),
    cancel: &CancellationToken,
    timeout: Duration,
    mut visit: impl FnMut(&[u8]) -> Result<bool>,
) -> Result<()> {
    use tokio::io::{AsyncBufReadExt, BufReader};
    check_cancelled(cancel)?;
    let operation = operation(&command);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    command.as_std_mut().process_group(0);
    let mut child = command
        .spawn()
        .with_context(|| format!("start trusted Git executable for `{operation}`"))?;
    let pid = child.id().context("Git child has no process ID")?;
    let mut stdout = BufReader::with_capacity(
        65_536,
        child.stdout.take().context("Git stdout unavailable")?,
    );
    let stderr = child.stderr.take().context("Git stderr unavailable")?;
    let errors = tokio::spawn(tail(stderr, MAX_STDERR));
    // Whether the listing was read to its end, rather than stopped by `visit`.
    let result: Result<bool> = tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(anyhow::anyhow!("workspace operation cancelled")),
        _ = tokio::time::sleep(timeout) => Err(anyhow::anyhow!("`{operation}` exceeded its deadline")),
        result = async {
            let mut record = Vec::with_capacity(256);
            let mut cut = false;
            loop {
                let buffer = stdout.fill_buf().await?;
                if buffer.is_empty() {
                    if (!record.is_empty() || cut) && !visit(&record)? {
                        return Ok(false);
                    }
                    break;
                }
                let end = buffer.iter().position(|byte| *byte == delimiter);
                let part = &buffer[..end.unwrap_or(buffer.len())];
                let room = maximum - record.len();
                if part.len() > room {
                    ensure!(
                        overlong == Overlong::Cut,
                        "`{operation}` lists an entry longer than its {} size limit",
                        size(maximum)
                    );
                    cut = true;
                }
                record.extend_from_slice(&part[..part.len().min(room)]);
                let used = part.len() + usize::from(end.is_some());
                stdout.consume(used);
                if end.is_some() {
                    if !visit(&record)? {
                        return Ok(false);
                    }
                    record.clear();
                    cut = false;
                }
            }
            let stderr = errors.await.context("read Git error output")??;
            let status = child.wait().await?;
            if !status.success() {
                return Err(GitExit::new(status.code(), &operation, &stderr).into());
            }
            Ok(true)
        } => result,
    };
    // Stopped by `visit`, or failed: the rest of the listing is not wanted.
    if !matches!(result, Ok(true)) {
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
        let _ = child.wait().await;
    }
    result.map(|_| ())
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

/// Two tracked paths that are the same but for letter case, which a case-insensitive disk
/// writes to one file.
fn case_collision(entries: &BTreeMap<String, TreeEntry>) -> Option<(String, String)> {
    let mut seen: BTreeMap<String, &str> = BTreeMap::new();
    for path in entries.keys() {
        if let Some(other) = seen.insert(path.to_lowercase(), path) {
            return Some((other.to_owned(), path.clone()));
        }
    }
    None
}

/// Refuses a source repository whose objects are partly in another repository.
fn refuse_borrowed_objects(objects: &Path) -> Result<()> {
    let alternates = objects.join("info/alternates");
    if fs::metadata(&alternates).is_ok_and(|metadata| metadata.len() > 0) {
        return Err(Refusal(
            "the repository borrows objects from another repository (it has `objects/info/alternates`, as `git clone --shared` or `--reference` makes), and SuperTag reads only the repository's own objects. Run `git repack -a -d` in it and then delete `.git/objects/info/alternates`".into(),
        )
        .into());
    }
    Ok(())
}

/// Says why copying a commit's history out of the source repository failed, when the repository
/// is one whose history cannot be copied whole: Git's own message, kept as the cause, names an
/// object and not the reason.
fn explain_source_copy(objects: &Path, mode: ShallowSource, error: anyhow::Error) -> anyhow::Error {
    let Some(exit) = error.downcast_ref::<GitExit>() else {
        return error;
    };
    if exit.stderr().contains("fsck error") {
        // `error: object <ID>: <check>: <explanation>`, one line for each object.
        let mut checks: Vec<&str> = exit
            .stderr()
            .lines()
            .filter_map(|line| line.strip_prefix("error: object "))
            .filter_map(|line| line.split(": ").nth(1))
            .filter(|check| {
                check
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric())
            })
            .collect();
        checks.sort_unstable();
        checks.dedup();
        let named = if checks.is_empty() {
            String::new()
        } else {
            format!(" ({})", checks.join(", "))
        };
        return error.context(Refusal(format!(
            "the repository's history holds objects that fail Git's strict checks{named}, and SuperTag does not copy them. `git fsck --strict` in the repository lists them"
        )));
    }
    // A shallow source that is adopted copies whole; this one is a remote Workspace's.
    let shallow = objects
        .parent()
        .and_then(|directory| fs::metadata(directory.join("shallow")).ok())
        .is_some_and(|metadata| metadata.len() > 0);
    if shallow && mode == ShallowSource::Refused {
        return error.context(Refusal(
            "the Workspace's remote is a shallow clone, and a remote Workspace needs the whole history of the commit it starts from. Run `git fetch --unshallow` in the repository the remote names, or map a checkout of it on the Worker Host as a local Workspace instead".into(),
        ));
    }
    let partial = fs::read_dir(objects.join("pack")).is_ok_and(|entries| {
        entries.flatten().any(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.ends_with(".promisor"))
        })
    });
    if partial {
        return error.context(Refusal(
            "the repository is a partial clone (made with `git clone --filter`), so some of its files and history were never downloaded, and SuperTag copies history from the local repository without contacting its remote. Use a full clone, or download everything with `git fetch --refetch --no-filter` in the repository, and try again".into(),
        ));
    }
    error
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
    operation: String,
    stderr: String,
}
impl GitExit {
    pub(crate) fn new(code: Option<i32>, operation: &str, stderr: &[u8]) -> Self {
        Self {
            code,
            operation: operation.to_owned(),
            stderr: String::from_utf8_lossy(stderr).trim().to_owned(),
        }
    }

    /// The failed command by name and exit code, without anything it printed.
    pub(crate) fn summary(&self) -> String {
        match self.code {
            Some(code) => format!("`{}` failed (exit {code})", self.operation),
            None => format!("`{}` was stopped by a signal", self.operation),
        }
    }

    /// What the command printed to its standard error, or the end of it.
    pub(crate) fn stderr(&self) -> &str {
        &self.stderr
    }
}
/// The command, then the last line it printed, which is Git's own `fatal:` reason, then
/// whatever came before it: a reader of a shortened message sees the reason first.
impl std::fmt::Display for GitExit {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}", self.summary())?;
        let mut lines = self
            .stderr
            .lines()
            .rev()
            .filter(|line| !line.trim().is_empty());
        let Some(last) = lines.next() else {
            return Ok(());
        };
        write!(formatter, ": {}", last.trim())?;
        if lines.next().is_some() {
            let earlier = &self.stderr[..self.stderr.rfind(last).unwrap_or_default()];
            write!(formatter, "\nearlier output:\n{}", earlier.trim_end())?;
        }
        Ok(())
    }
}
impl std::error::Error for GitExit {}

/// What a child runs, such as `git pack-objects`, so an error names the Git operation that hit a
/// limit or failed. Global options and their values are skipped.
pub(crate) fn operation(command: &Command) -> String {
    let command = command.as_std();
    let program = Path::new(command.get_program())
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut arguments = command.get_args();
    while let Some(argument) = arguments.next() {
        match argument.to_str() {
            Some("-c" | "-C") => {
                arguments.next();
            }
            Some(option) if option.starts_with('-') => {}
            Some(subcommand) if program == "git" => return format!("git {subcommand}"),
            _ => break,
        }
    }
    program
}

fn size(bytes: usize) -> String {
    const MIB: usize = 1024 * 1024;
    if bytes >= MIB && bytes.is_multiple_of(MIB) {
        format!("{} MiB", bytes / MIB)
    } else if bytes >= 1024 && bytes.is_multiple_of(1024) {
        format!("{} KiB", bytes / 1024)
    } else {
        format!("{bytes}-byte")
    }
}

/// Reads at most `maximum` bytes of `operation`'s `stream`, failing when it writes more.
async fn limited(
    mut reader: impl AsyncRead + Unpin,
    maximum: usize,
    operation: &str,
    stream: &str,
) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    (&mut reader)
        .take(maximum as u64 + 1)
        .read_to_end(&mut bytes)
        .await?;
    ensure!(
        bytes.len() <= maximum,
        "`{operation}` {stream} exceeds its {} size limit",
        size(maximum)
    );
    Ok(bytes)
}

/// The most of one Git child's standard error that is kept: its end, where Git says why it
/// failed. A child may print any amount, such as a warning for each of a history's thousands of
/// malformed old objects; the rest is read and dropped.
const MAX_STDERR: usize = 65_536;

/// Reads all of a child's standard error and keeps its last `maximum` bytes. Reading to the end
/// never fails a command for being noisy and never leaves it blocked on a full pipe.
async fn tail(mut reader: impl AsyncRead + Unpin, maximum: usize) -> Result<Vec<u8>> {
    let mut kept: Vec<u8> = Vec::new();
    let mut block = vec![0_u8; 16_384];
    loop {
        let count = reader.read(&mut block).await?;
        if count == 0 {
            kept.drain(..kept.len().saturating_sub(maximum));
            return Ok(kept);
        }
        kept.extend_from_slice(&block[..count]);
        if kept.len() > 2 * maximum {
            kept.drain(..kept.len() - maximum);
        }
    }
}

pub(crate) async fn run(
    mut command: Command,
    input: &[u8],
    cancel: &CancellationToken,
    maximum: usize,
    timeout: Duration,
) -> Result<Vec<u8>> {
    check_cancelled(cancel)?;
    let operation = operation(&command);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    command.as_std_mut().process_group(0);
    let mut child = command
        .spawn()
        .with_context(|| format!("start trusted Git executable for `{operation}`"))?;
    let pid = child.id().context("Git child has no process ID")?;
    let mut stdin = child.stdin.take().context("Git stdin unavailable")?;
    let stdout = child.stdout.take().context("Git stdout unavailable")?;
    let stderr = child.stderr.take().context("Git stderr unavailable")?;
    let result = tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(anyhow::anyhow!("workspace operation cancelled")),
        _ = tokio::time::sleep(timeout) => Err(anyhow::anyhow!("`{operation}` exceeded its deadline")),
        result = async {
            let ((), stdout, stderr, status) = tokio::try_join!(
                async {
                    stdin.write_all(input).await?;
                    stdin.shutdown().await?;
                    drop(stdin);
                    Ok::<_, anyhow::Error>(())
                },
                limited(stdout, maximum, &operation, "output"),
                tail(stderr, MAX_STDERR),
                async { Ok::<_, anyhow::Error>(child.wait().await?) }
            )?;
            if !status.success() {
                return Err(GitExit::new(status.code(), &operation, &stderr).into());
            }
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

/// Runs `stages` as a pipeline: each stage's output is the next stage's input through an
/// operating-system pipe, never through this process, so what flows between them, such as a pack
/// of a monorepo's whole history, takes no memory here and has no size bound of its own. `input`
/// feeds the first stage, and the last stage's output is bounded by `maximum`. Every stage shares
/// the deadline, each stage's error output keeps its bound, and an error, a cancellation, or the
/// deadline kills every stage's process group before this returns.
pub(crate) async fn pipeline(
    stages: Vec<Command>,
    input: &[u8],
    cancel: &CancellationToken,
    maximum: usize,
    timeout: Duration,
) -> Result<Vec<u8>> {
    check_cancelled(cancel)?;
    ensure!(!stages.is_empty(), "a Git pipeline needs a stage");
    let operations: Vec<String> = stages.iter().map(operation).collect();
    let last = stages.len() - 1;
    let mut children = Vec::with_capacity(stages.len());
    let mut groups: Vec<i32> = Vec::with_capacity(stages.len());
    let mut errors = Vec::with_capacity(stages.len());
    let (mut first_input, mut last_output) = (None, None);
    let mut started = Ok(());
    let mut previous: Option<Stdio> = None;
    for (index, mut command) in stages.into_iter().enumerate() {
        command
            .stdin(previous.take().unwrap_or_else(Stdio::piped))
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        command.as_std_mut().process_group(0);
        let spawned = (|| {
            let mut child = command.spawn().with_context(|| {
                format!("start trusted Git executable for `{}`", operations[index])
            })?;
            groups.push(child.id().context("Git child has no process ID")? as i32);
            let stdin = child.stdin.take();
            let stdout = child.stdout.take().context("Git stdout unavailable")?;
            let stderr = child.stderr.take().context("Git stderr unavailable")?;
            children.push(child);
            if index == 0 {
                first_input = Some(stdin.context("Git stdin unavailable")?);
            }
            if index == last {
                last_output = Some(stdout);
            } else {
                previous = Some(
                    stdout
                        .try_into()
                        .context("connect a Git pipeline stage to the next")?,
                );
            }
            errors.push(tokio::spawn(tail(stderr, MAX_STDERR)));
            anyhow::Ok(())
        })();
        if spawned.is_err() {
            started = spawned;
            break;
        }
    }
    let result = match (started, first_input, last_output) {
        (Err(error), _, _) => Err(error),
        (Ok(()), Some(mut stdin), Some(stdout)) => tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(anyhow::anyhow!("workspace operation cancelled")),
            _ = tokio::time::sleep(timeout) => Err(anyhow::anyhow!(
                "`{}` exceeded its deadline",
                operations.join(" | ")
            )),
            result = async {
                let (written, stdout) = tokio::join!(
                    async {
                        stdin.write_all(input).await?;
                        stdin.shutdown().await?;
                        drop(stdin);
                        Ok::<_, std::io::Error>(())
                    },
                    limited(stdout, maximum, &operations[last], "output"),
                );
                let stdout = stdout?;
                // A failing stage makes the stages before it die writing to it, by SIGPIPE or,
                // through a shell or Git's own check, with code 141 (128 + SIGPIPE). The first
                // failure that is not such a broken pipe explains the rest.
                let mut failures = Vec::new();
                let mut broken_pipes = Vec::new();
                for ((child, errors), operation) in
                    children.iter_mut().zip(&mut errors).zip(&operations)
                {
                    let status = child.wait().await?;
                    let stderr = errors.await.context("read Git error output")??;
                    if !status.success() {
                        broken_pipes.push(
                            std::os::unix::process::ExitStatusExt::signal(&status)
                                == Some(libc::SIGPIPE)
                                || status.code() == Some(128 + libc::SIGPIPE),
                        );
                        failures.push(GitExit::new(status.code(), operation, &stderr));
                    }
                }
                if !failures.is_empty() {
                    let explaining = broken_pipes
                        .iter()
                        .position(|broken| !broken)
                        .unwrap_or(0);
                    return Err(failures.swap_remove(explaining).into());
                }
                written.with_context(|| format!("write the input of `{}`", operations[0]))?;
                Ok(stdout)
            } => result,
        },
        _ => Err(anyhow::anyhow!("Git pipeline streams unavailable")),
    };
    if result.is_err() {
        for group in &groups {
            unsafe {
                libc::kill(-group, libc::SIGKILL);
            }
        }
        for child in &mut children {
            let _ = child.wait().await;
        }
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
    let operation = operation(&command);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    command.as_std_mut().process_group(0);
    let mut child = command
        .spawn()
        .with_context(|| format!("start trusted Git executable for `{operation}`"))?;
    let pid = child.id().context("Git child has no process ID")?;
    let stdout = child.stdout.take().context("Git stdout unavailable")?;
    let stderr = child.stderr.take().context("Git stderr unavailable")?;
    let result = tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(anyhow::anyhow!("workspace operation cancelled")),
        _ = tokio::time::sleep(timeout) => Err(anyhow::anyhow!("`{operation}` exceeded its deadline")),
        result = async {
            let (stdout, _, status) = tokio::try_join!(
                limited(stdout, maximum, &operation, "output"),
                tail(stderr, MAX_STDERR),
                async { Ok::<_, anyhow::Error>(child.wait().await?) }
            )?;
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

    fn shell(script: &str) -> Command {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", script]);
        command
    }

    #[test]
    fn an_operation_is_named_by_its_git_subcommand() {
        let mut command = Command::new("/usr/bin/git");
        command.arg("--git-dir=/tmp/x").args([
            "-c",
            "core.pager=cat",
            "-C",
            "/",
            "pack-objects",
            "--stdout",
        ]);
        assert_eq!(operation(&command), "git pack-objects");
        assert_eq!(operation(&shell("true")), "sh");
    }

    #[tokio::test]
    async fn a_read_over_its_limit_names_the_git_operation() -> Result<()> {
        let mut command = Command::new("/usr/bin/git");
        command
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .args(["-c", "core.pager=cat", "version"]);
        let error = run(command, &[], &CancellationToken::new(), 8, COMMAND_TIMEOUT)
            .await
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "`git version` output exceeds its 8-byte size limit"
        );
        Ok(())
    }

    #[tokio::test]
    async fn a_pipeline_streams_more_than_any_buffer_between_its_stages() -> Result<()> {
        // 64 MiB flows from the first stage to the second; only the count reaches this process.
        let output = pipeline(
            vec![
                shell("/bin/dd if=/dev/zero bs=1048576 count=64 2>/dev/null"),
                shell("/usr/bin/wc -c"),
            ],
            &[],
            &CancellationToken::new(),
            64,
            COMMAND_TIMEOUT,
        )
        .await?;
        assert_eq!(String::from_utf8(output)?.trim(), "67108864");
        Ok(())
    }

    #[tokio::test]
    async fn a_pipeline_reports_the_stage_that_failed_not_the_one_it_starved() -> Result<()> {
        let error = pipeline(
            vec![
                shell("/bin/cat"),
                shell("/bin/cat >/dev/null; echo refused >&2; exit 3"),
            ],
            b"input",
            &CancellationToken::new(),
            64,
            COMMAND_TIMEOUT,
        )
        .await
        .unwrap_err();
        let exit = error.downcast_ref::<GitExit>().context("a stage exit")?;
        assert_eq!((exit.code, exit.stderr()), (Some(3), "refused"));
        assert_eq!(exit.to_string(), "`sh` failed (exit 3): refused");
        // The first stage dies writing to a stage that stopped reading; the stage that stopped
        // explains it.
        let error = pipeline(
            vec![
                shell("/usr/bin/yes"),
                shell("/usr/bin/head -c 10 >/dev/null; exit 4"),
            ],
            &[],
            &CancellationToken::new(),
            64,
            COMMAND_TIMEOUT,
        )
        .await
        .unwrap_err();
        assert_eq!(
            error.downcast_ref::<GitExit>().and_then(|exit| exit.code),
            Some(4)
        );
        // A stage that a shell or Git reports as 141 (128 + SIGPIPE) broke on its pipe too.
        let error = pipeline(
            vec![
                shell("/bin/cat >/dev/null; exit 141"),
                shell("/bin/cat >/dev/null; exit 5"),
            ],
            b"input",
            &CancellationToken::new(),
            64,
            COMMAND_TIMEOUT,
        )
        .await
        .unwrap_err();
        assert_eq!(
            error.downcast_ref::<GitExit>().and_then(|exit| exit.code),
            Some(5)
        );
        Ok(())
    }

    #[tokio::test]
    async fn a_cancelled_pipeline_reaps_every_stage() -> Result<()> {
        let root = tempfile::tempdir()?;
        let started = root.path().join("started");
        let mut first = shell("echo $$ >> \"$1\"; exec /bin/sleep 60");
        first.arg("fixture").arg(&started);
        let mut second = shell("echo $$ >> \"$1\"; exec /bin/cat");
        second.arg("fixture").arg(&started);
        let token = CancellationToken::new();
        let task_token = token.clone();
        let task = tokio::spawn(async move {
            pipeline(vec![first, second], &[], &task_token, 64, COMMAND_TIMEOUT).await
        });
        let pids: Vec<i32> = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Ok(text) = fs::read_to_string(&started)
                    && text.lines().count() == 2
                    && text.ends_with('\n')
                {
                    return text;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await?
        .lines()
        .map(str::parse)
        .collect::<Result<_, _>>()?;
        token.cancel();
        let result = tokio::time::timeout(Duration::from_secs(5), task).await??;
        ensure!(result.is_err());
        for pid in pids {
            ensure!(unsafe { libc::kill(pid, 0) } == -1);
            ensure!(std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH));
        }
        Ok(())
    }

    async fn any_line(command: Command, matches: impl Fn(&[u8]) -> bool) -> Result<bool> {
        let mut found = false;
        records(
            command,
            (b'\n', MAX_LINE, Overlong::Cut),
            &CancellationToken::new(),
            COMMAND_TIMEOUT,
            |line| {
                found = matches(line);
                Ok(!found)
            },
        )
        .await?;
        Ok(found)
    }

    #[tokio::test]
    async fn a_streamed_listing_stops_at_its_match_and_bounds_each_record() -> Result<()> {
        // An endless listing: only the line read so far is held, and the match stops it.
        ensure!(any_line(shell("/usr/bin/yes"), |line| line == b"y").await?);
        ensure!(!any_line(shell("printf 'a\\nb\\n'"), |line| line == b"c").await?);
        // A last record without its delimiter still counts.
        ensure!(any_line(shell("printf 'a\\nb'"), |line| line == b"b").await?);
        // A line longer than the bound is cut to its start, where a ref listing has the commit,
        // and the listing goes on after it.
        ensure!(
            any_line(
                shell("printf 'commit\\t'; /bin/dd if=/dev/zero bs=8192 count=1 2>/dev/null | /usr/bin/tr '\\0' x; printf '\\nnext\\n'"),
                |line| line.len() == MAX_LINE && line.starts_with(b"commit\t")
            )
            .await?
        );
        ensure!(
            any_line(
                shell("/bin/dd if=/dev/zero bs=8192 count=1 2>/dev/null | /usr/bin/tr '\\0' x; printf '\\nnext\\n'"),
                |line| line == b"next"
            )
            .await?
        );
        // A listing whose records are needed whole refuses one that is too long, by name.
        let error = records(
            shell("/bin/dd if=/dev/zero bs=8192 count=3 2>/dev/null | /usr/bin/tr '\\0' x"),
            (0, 16_384, Overlong::Fail),
            &CancellationToken::new(),
            COMMAND_TIMEOUT,
            |_| Ok(true),
        )
        .await
        .unwrap_err();
        assert_eq!(
            error.to_string(),
            "`sh` lists an entry longer than its 16 KiB size limit"
        );
        let error = any_line(shell("echo gone >&2; exit 2"), |_| false)
            .await
            .unwrap_err();
        assert_eq!(
            error.downcast_ref::<GitExit>().and_then(|exit| exit.code),
            Some(2)
        );
        Ok(())
    }

    #[tokio::test]
    async fn a_noisy_command_keeps_only_the_end_of_its_error_output() -> Result<()> {
        // 4 MiB of warnings, far past any pipe's buffer, then the output and a clean exit.
        let noisy = "i=0; while [ $i -lt 40000 ]; do echo \"warning: object $i: zeroPaddedFilemode: contains zero-padded file modes, which is harmless\" >&2; i=$((i+1)); done";
        let output = run(
            shell(&format!("{noisy}; echo done")),
            &[],
            &CancellationToken::new(),
            64,
            COMMAND_TIMEOUT,
        )
        .await?;
        assert_eq!(output, b"done\n");
        // A failure after the noise still says why, in the last line.
        let error = run(
            shell(&format!("{noisy}; echo 'fatal: the reason' >&2; exit 128")),
            &[],
            &CancellationToken::new(),
            64,
            COMMAND_TIMEOUT,
        )
        .await
        .unwrap_err();
        let exit = error.downcast_ref::<GitExit>().context("a Git exit")?;
        ensure!(exit.stderr().len() <= MAX_STDERR);
        ensure!(
            error
                .to_string()
                .starts_with("`sh` failed (exit 128): fatal: the reason\nearlier output:\n"),
            "{error}"
        );
        Ok(())
    }
}
