//! A Task's files, read where they live (contributing/client-file-access-design.md, slice 1).
//! The Control Plane's `TaskFiles.Locate` says where a running Task's checkout is; when it is on
//! this machine (the caller presents its own machine identifier), the app lists and reads the
//! directory itself. No file content ever crosses the Control Plane. Everything is read-only: text
//! files open in a viewer, binary files are listed only, and nothing outside the located root,
//! nothing under `.git`, and no symbolic link is followed.
use std::{
    collections::HashMap,
    fs::File,
    io::Read,
    os::unix::fs::OpenOptionsExt,
    path::{Component, Path, PathBuf},
    sync::Mutex,
    time::UNIX_EPOCH,
};

use serde::Serialize;
use supertag_protocol::{
    MAX_MESSAGE_BYTES,
    v2::{self, task_file_location::Kind, task_files_client::TaskFilesClient},
};

use super::{GatewayState, Result, rpc_error};

/// The largest file the viewer shows.
const MAX_VIEW_BYTES: u64 = 1024 * 1024;
/// How much of a file is checked for a NUL byte.
const SNIFF_BYTES: usize = 8 * 1024;
/// The most entries one directory listing returns.
const MAX_ENTRIES: usize = 1000;
/// Extensions that are binary whatever their bytes look like.
const BINARY_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "ico", "icns", "bmp", "tiff", "pdf", "zip", "gz", "tgz",
    "bz2", "xz", "zst", "7z", "rar", "tar", "jar", "class", "so", "dylib", "dll", "exe", "o", "a",
    "wasm", "bin", "dat", "db", "sqlite", "sqlite3", "woff", "woff2", "ttf", "otf", "mp3", "mp4",
    "mov", "avi", "wav", "flac", "ogg", "psd", "sketch",
];

/// The roots `Locate` gave this app, by connection and Task. Listing and reading resolve only
/// beneath one of these, so the window can't name another directory.
static ROOTS: Mutex<Option<HashMap<(String, String), PathBuf>>> = Mutex::new(None);

fn remember(connection: &str, task: &str, root: Option<PathBuf>) {
    let mut roots = ROOTS.lock().unwrap_or_else(|error| error.into_inner());
    let roots = roots.get_or_insert_with(HashMap::new);
    let key = (connection.to_owned(), task.to_owned());
    match root {
        Some(root) => {
            roots.insert(key, root);
        }
        None => {
            roots.remove(&key);
        }
    }
}

fn root_of(connection: &str, task: &str) -> std::result::Result<PathBuf, String> {
    ROOTS
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .as_ref()
        .and_then(|roots| {
            roots
                .get(&(connection.to_owned(), task.to_owned()))
                .cloned()
        })
        .ok_or_else(|| "This Task's files aren't on this machine.".to_owned())
}

/// Where a Task's files are, as the panel shows it.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskFilesPlace {
    /// The files are on this machine and can be listed.
    pub local: bool,
    /// The Task is running, so its files can still change.
    pub live: bool,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub host_id: String,
    /// Why the files can't be read here, when they can't.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub reason: String,
}

/// One entry of a directory listing.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskFileEntry {
    pub name: String,
    /// Relative to the Task's root, with `/` separators.
    pub path: String,
    /// `directory`, `file`, or `link` (listed, never followed).
    pub kind: &'static str,
    pub size: u64,
    pub modified_ms: i64,
    /// A file that opens in the viewer; binary files are listed only.
    pub text: bool,
}

/// One text file's content for the viewer.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskFileText {
    pub path: String,
    pub text: String,
    pub size: u64,
}

impl GatewayState {
    /// Asks the Control Plane where the Task's files are, presenting this machine's identifier,
    /// and remembers a local root for listing and reading.
    pub async fn locate_task_files(
        &self,
        connection_id: &str,
        task_id: String,
    ) -> Result<TaskFilesPlace> {
        let session = self.session(connection_id).await?;
        let machine_id = supertag_local_state::machine_id().unwrap_or_default();
        let locations = TaskFilesClient::new(session.channel.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
            .locate(session.request(v2::LocateTaskFilesRequest {
                task_id: task_id.clone(),
                machine_id,
            }))
            .await
            .map_err(rpc_error)?
            .into_inner()
            .locations;
        let place = place(connection_id, &task_id, locations.into_iter().next());
        self.current(&session, place).await
    }
}

fn place(connection: &str, task: &str, location: Option<v2::TaskFileLocation>) -> TaskFilesPlace {
    let Some(location) = location else {
        remember(connection, task, None);
        return TaskFilesPlace {
            local: false,
            live: false,
            host_id: String::new(),
            reason: "SuperTag doesn't know where this Task's files are.".into(),
        };
    };
    // A local path counts only when it is a directory this user can open here.
    let root = match &location.kind {
        Some(Kind::LocalPath(local)) => std::fs::canonicalize(&local.path)
            .ok()
            .filter(|root| root.is_dir()),
        None => None,
    };
    let reason = match (&root, &location.kind) {
        (Some(_), _) => String::new(),
        (None, Some(Kind::LocalPath(_))) => format!(
            "Files on Worker Host {} are unreachable from here.",
            location.host_id
        ),
        (None, None) => location.unavailable_reason.clone(),
    };
    let local = root.is_some();
    remember(connection, task, root);
    TaskFilesPlace {
        local,
        live: location.live,
        host_id: location.host_id,
        reason,
    }
}

/// `relative` resolved beneath `root`, refusing absolute paths, `..`, `.git`, and any symbolic
/// link on the way.
fn resolve(root: &Path, relative: &str) -> std::result::Result<PathBuf, String> {
    let mut path = root.to_path_buf();
    for component in Path::new(relative).components() {
        match component {
            Component::CurDir => {}
            Component::Normal(name) if name != ".git" => {
                path.push(name);
                let metadata = std::fs::symlink_metadata(&path)
                    .map_err(|_| "That file is no longer there.".to_owned())?;
                if metadata.file_type().is_symlink() {
                    return Err("Links aren't followed.".into());
                }
            }
            _ => return Err("That path is outside the Task's files.".into()),
        }
    }
    Ok(path)
}

fn binary_name(name: &str) -> bool {
    Path::new(name)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            BINARY_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str())
        })
}

/// Whether the first bytes look like text: no NUL, and valid UTF-8 up to a cut character.
fn looks_like_text(bytes: &[u8]) -> bool {
    if bytes.contains(&0) {
        return false;
    }
    match std::str::from_utf8(bytes) {
        Ok(_) => true,
        // A sample may end inside a character.
        Err(error) => error.error_len().is_none(),
    }
}

fn open_regular(path: &Path) -> std::result::Result<File, String> {
    std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|_| "That file can't be opened.".to_owned())
}

/// Lists one directory of the Task's files: directories first, then by name.
pub fn list(
    connection: &str,
    task: &str,
    relative: &str,
) -> std::result::Result<Vec<TaskFileEntry>, String> {
    let root = root_of(connection, task)?;
    let directory = resolve(&root, relative)?;
    let reader =
        std::fs::read_dir(&directory).map_err(|_| "That folder can't be read.".to_owned())?;
    let mut entries = Vec::new();
    for entry in reader.flatten().take(MAX_ENTRIES + 1) {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == ".git" {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let kind = if metadata.file_type().is_symlink() {
            "link"
        } else if metadata.is_dir() {
            "directory"
        } else {
            "file"
        };
        let text = kind == "file" && !binary_name(&name) && {
            let mut sample = vec![0; SNIFF_BYTES];
            open_regular(&entry.path())
                .ok()
                .and_then(|mut file| file.read(&mut sample).ok())
                .is_some_and(|read| looks_like_text(&sample[..read]))
        };
        let path = Path::new(relative)
            .join(&name)
            .components()
            .filter_map(|part| match part {
                Component::Normal(part) => Some(part.to_string_lossy().into_owned()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("/");
        entries.push(TaskFileEntry {
            name,
            path,
            kind,
            size: metadata.len(),
            modified_ms: metadata
                .modified()
                .ok()
                .and_then(|at| at.duration_since(UNIX_EPOCH).ok())
                .map_or(0, |since| since.as_millis() as i64),
            text,
        });
    }
    entries.truncate(MAX_ENTRIES);
    entries.sort_by(|a, b| {
        (a.kind != "directory")
            .cmp(&(b.kind != "directory"))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

/// Reads one text file of the Task's files for the viewer. Binary files are refused.
pub fn read(
    connection: &str,
    task: &str,
    relative: &str,
) -> std::result::Result<TaskFileText, String> {
    let root = root_of(connection, task)?;
    let path = resolve(&root, relative)?;
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    if binary_name(&name) {
        return Err("Binary files are listed only.".into());
    }
    let mut file = open_regular(&path)?;
    let metadata = file
        .metadata()
        .map_err(|_| "That file can't be opened.".to_owned())?;
    if !metadata.is_file() {
        return Err("Only files open in the viewer.".into());
    }
    if metadata.len() > MAX_VIEW_BYTES {
        return Err("This file is larger than 1 MiB, too large for the viewer.".into());
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.by_ref()
        .take(MAX_VIEW_BYTES)
        .read_to_end(&mut bytes)
        .map_err(|_| "That file can't be read.".to_owned())?;
    if bytes.contains(&0) {
        return Err("Binary files are listed only.".into());
    }
    let text = String::from_utf8(bytes).map_err(|_| "Binary files are listed only.".to_owned())?;
    Ok(TaskFileText {
        path: relative.to_owned(),
        size: metadata.len(),
        text,
    })
}

/// The absolute path of one of the Task's files, to reveal it in Finder.
pub fn absolute(
    connection: &str,
    task: &str,
    relative: &str,
) -> std::result::Result<PathBuf, String> {
    let root = root_of(connection, task)?;
    resolve(&root, relative)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn located(root: &Path) -> v2::TaskFileLocation {
        v2::TaskFileLocation {
            id: "attempt:a".into(),
            kind: Some(Kind::LocalPath(v2::TaskFilesLocalPath {
                path: root.to_string_lossy().into_owned(),
            })),
            live: true,
            unavailable_reason: String::new(),
            host_id: "laptop".into(),
        }
    }

    #[test]
    fn lists_and_reads_text_only_beneath_the_located_root() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join("src/app.py"), "print('hi')\n").unwrap();
        std::fs::write(root.join("logo.png"), b"\x89PNG").unwrap();
        std::fs::write(root.join("blob"), b"a\0b").unwrap();
        std::os::unix::fs::symlink("/etc/hosts", root.join("hosts")).unwrap();

        let place = place("c1", "t1", Some(located(root)));
        assert!(place.local && place.live && place.reason.is_empty());

        let top = list("c1", "t1", "").unwrap();
        let names: Vec<_> = top
            .iter()
            .map(|entry| (entry.name.as_str(), entry.kind, entry.text))
            .collect();
        assert_eq!(
            names,
            [
                ("src", "directory", false),
                ("blob", "file", false),
                ("hosts", "link", false),
                ("logo.png", "file", false),
            ]
        );
        let nested = list("c1", "t1", "src").unwrap();
        assert_eq!(nested[0].path, "src/app.py");
        assert!(nested[0].text);
        assert_eq!(
            read("c1", "t1", "src/app.py").unwrap().text,
            "print('hi')\n"
        );

        for refused in [
            "blob",
            "logo.png",
            "hosts",
            "../etc/passwd",
            "/etc/hosts",
            ".git/config",
        ] {
            assert!(read("c1", "t1", refused).is_err(), "{refused} was read");
        }
        assert!(list("c1", "t1", "..").is_err());
        assert!(
            list("c1", "other-task", "").is_err(),
            "a Task never located has no root"
        );
    }

    #[test]
    fn a_path_on_another_machine_is_unreachable_and_forgets_the_root() {
        let directory = tempfile::tempdir().unwrap();
        place("c2", "t2", Some(located(directory.path())));
        let gone = place("c2", "t2", Some(located(Path::new("/no/such/checkout"))));
        assert!(!gone.local);
        assert_eq!(
            gone.reason,
            "Files on Worker Host laptop are unreachable from here."
        );
        assert!(list("c2", "t2", "").is_err());

        let remote = place(
            "c2",
            "t3",
            Some(v2::TaskFileLocation {
                unavailable_reason: "Files on Worker Host build-1 are unreachable from here."
                    .into(),
                host_id: "build-1".into(),
                ..Default::default()
            }),
        );
        assert_eq!(
            remote.reason,
            "Files on Worker Host build-1 are unreachable from here."
        );
    }

    #[test]
    fn text_is_sniffed_from_its_first_bytes() {
        assert!(looks_like_text(b"plain text"));
        assert!(!looks_like_text(b"nul\0inside"));
        assert!(looks_like_text("caf\u{e9}".as_bytes()));
        assert!(
            looks_like_text(&"caf\u{e9}".as_bytes()[..4]),
            "a cut character is still text"
        );
        assert!(!looks_like_text(&[0xff, 0xfe, 0x41]));
    }
}
