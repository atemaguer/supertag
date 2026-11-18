//! Path scopes on a Task's file access.
//!
//! A Permission Set's runtime `files:write` and `files:read` permissions may name Workspace
//! `paths` (writes only), `exclude` entries, and `additionalDirectories` outside the Workspace.
//! The Control Plane validates them here, composes the accepted sets into one [`FileScope`] when
//! it accepts a Task, and every harness adapter, the remote file tools, and the delivery check
//! apply that scope with the one matcher in this module. Patterns are never passed through to a
//! harness: each adapter translates the composed scope into its own rules.
//!
//! Precedence is hidden (a `files:read` exclude) over read-only (a `files:write` exclude) over
//! write. Hidden and read-only entries match case-insensitively, because a case-insensitive
//! filesystem opens `SECRETS/x` as `secrets/x`; write entries match case-sensitively.

use std::collections::BTreeSet;

use crate::v2::{FileScope, HarnessExecutionProfile, HarnessKind, Task};

pub const FILES_READ: &str = "files:read";
pub const FILES_WRITE: &str = "files:write";
/// Entries per field of one permission.
pub const MAX_ENTRIES: usize = 64;
/// Bytes per entry.
pub const MAX_ENTRY_BYTES: usize = 1024;

/// Names a harness or SuperTag keeps read-only in every writable root, or that hold harness
/// configuration or credentials. A path scope may hide or exclude them but never grant them.
pub const PROTECTED_NAMES: &[&str] = &[
    ".git",
    ".codex",
    ".agents",
    ".aws",
    ".claude",
    ".cursor",
    ".opencode",
    ".supertag",
];

/// Directories under the Worker Host user's home that hold SuperTag or harness state or
/// credentials. An additional directory may not equal, contain, or lie inside one.
const RESERVED_HOME: &[&str] = &[
    ".supertag",
    ".codex",
    ".claude",
    ".claude.json",
    ".cursor",
    ".agents",
    ".aws",
    ".ssh",
    ".gnupg",
    ".config/opencode",
    ".config/gh",
    ".config/cursor",
    ".local/share/opencode",
    ".local/state/opencode",
    ".cache/opencode",
    "Library/Application Support/Cursor",
];

/// Absolute directories that contain users' home directories.
const RESERVED_ABSOLUTE: &[&str] = &["/Users", "/home", "/root", "/var/root"];

/// One permission's path fields, as a manifest names them.
pub struct PermissionPaths<'a> {
    pub paths: &'a mut Vec<String>,
    pub exclude: &'a mut Vec<String>,
    pub additional_directories: &'a mut Vec<String>,
}

/// Validate and canonicalize one runtime permission's path fields in place: trimmed, `dir/**`
/// written as `dir/`, sorted, and deduplicated. The error names the entry and how to fix it.
pub fn normalize_permission(action: &str, fields: PermissionPaths<'_>) -> Result<(), String> {
    let PermissionPaths {
        paths,
        exclude,
        additional_directories,
    } = fields;
    // On web:fetch, `paths` are URL path prefixes, which `network_scope` checks.
    if action == crate::network_scope::WEB_FETCH
        && exclude.is_empty()
        && additional_directories.is_empty()
    {
        return Ok(());
    }
    let scoped = !paths.is_empty() || !exclude.is_empty() || !additional_directories.is_empty();
    if !scoped {
        return Ok(());
    }
    if action != FILES_WRITE && action != FILES_READ {
        return Err(format!(
            "{action} takes no paths, exclude, or additionalDirectories: only runtime files:write and files:read permissions are path-scoped"
        ));
    }
    if action == FILES_READ && !paths.is_empty() {
        return Err(
            "files:read takes no paths: reads cover the whole Workspace except its exclude entries. List paths to hide under exclude; read allow-lists are not supported yet"
                .into(),
        );
    }
    for (field, values) in [
        ("paths", &*paths),
        ("exclude", &*exclude),
        ("additionalDirectories", &*additional_directories),
    ] {
        if values.len() > MAX_ENTRIES {
            return Err(format!(
                "{action} {field} may list at most {MAX_ENTRIES} entries"
            ));
        }
    }
    let canonical = |values: &mut Vec<String>,
                     parse: &dyn Fn(&str) -> Result<String, String>|
     -> Result<(), String> {
        let parsed = values
            .iter()
            .map(|value| parse(value))
            .collect::<Result<BTreeSet<_>, _>>()?;
        *values = parsed.into_iter().collect();
        Ok(())
    };
    canonical(paths, &|value| {
        let entry = workspace_entry(value, "paths", false)?;
        if let Some(name) = protected_segment(&entry) {
            return Err(format!(
                "files:write paths entry {value:?} names {name}, which stays read-only for every Task; a path scope cannot make it writable"
            ));
        }
        Ok(entry)
    })?;
    let globs = action == FILES_READ;
    canonical(exclude, &|value| workspace_entry(value, "exclude", globs))?;
    canonical(additional_directories, &outside_entry)?;
    Ok(())
}

/// A Workspace-relative entry, canonical: `/`-separated segments, with a trailing `/` when the
/// author marked a directory (`dir/` or `dir/**`).
fn workspace_entry(raw: &str, field: &str, globs: bool) -> Result<String, String> {
    let value = common_entry(raw, field)?;
    if value.starts_with('!') {
        return Err(format!(
            "{field} entry {raw:?} starts with !: list paths to leave out under exclude instead"
        ));
    }
    if value.starts_with('~') {
        return Err(format!(
            "{field} entry {raw:?} starts with ~, which is allowed only in additionalDirectories"
        ));
    }
    if value.starts_with('/') {
        return Err(format!(
            "{field} entry {raw:?} must be relative to the Workspace; list directories outside it under additionalDirectories"
        ));
    }
    let (body, directory) = match value.strip_suffix("/**") {
        Some(body) if !body.is_empty() => (body, true),
        _ => match value.strip_suffix('/') {
            Some(body) => (body, true),
            None => (value, false),
        },
    };
    for segment in body.split('/') {
        if matches!(segment, "" | "." | "..") {
            return Err(format!(
                "{field} entry {raw:?} must not contain empty, . or .. segments"
            ));
        }
        let wildcard = segment.contains(['*', '?']);
        if segment.contains(['[', ']', '{', '}']) {
            return Err(format!(
                "{field} entry {raw:?} uses [ ] or {{ }}; path scopes support only *, ** and ? globs"
            ));
        }
        if wildcard && !globs {
            return Err(format!(
                "{field} entry {raw:?} is a glob: write paths and files:write exclude entries are directories or exact paths. Globs are allowed only in files:read exclude"
            ));
        }
        if segment.contains("**") && segment != "**" {
            return Err(format!(
                "{field} entry {raw:?} uses ** inside a segment; ** must be a whole path segment, as in **/.env"
            ));
        }
    }
    Ok(if directory {
        format!("{body}/")
    } else {
        body.to_owned()
    })
}

/// An entry outside the Workspace: absolute or `~/`, literal, and clear of SuperTag and harness
/// state. The Worker Host expands `~` to its user's home and checks the result again at launch.
fn outside_entry(raw: &str) -> Result<String, String> {
    let field = "additionalDirectories";
    let value = common_entry(raw, field)?;
    if value.contains(['*', '?', '[', ']', '{', '}']) {
        return Err(format!(
            "{field} entry {raw:?} is a glob; additional directories are literal paths"
        ));
    }
    let (prefix, rest) = if let Some(rest) = value.strip_prefix("~/") {
        ("~/", rest)
    } else if let Some(rest) = value.strip_prefix('/') {
        ("/", rest)
    } else if value == "~" {
        ("~/", "")
    } else {
        return Err(format!(
            "{field} entry {raw:?} must be absolute or start with ~/; list Workspace paths under paths"
        ));
    };
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    if rest.is_empty() {
        return Err(format!(
            "{field} entry {raw:?} names the whole {}; name a narrower directory",
            if prefix == "/" {
                "filesystem"
            } else {
                "home directory"
            }
        ));
    }
    if rest
        .split('/')
        .any(|segment| matches!(segment, "" | "." | ".."))
    {
        return Err(format!(
            "{field} entry {raw:?} must not contain empty, . or .. segments"
        ));
    }
    let overlaps = |reserved: &str| {
        let (left, right) = (rest.to_ascii_lowercase(), reserved.to_ascii_lowercase());
        left == right
            || left.starts_with(&format!("{right}/"))
            || right.starts_with(&format!("{left}/"))
    };
    let reserved = if prefix == "~/" {
        RESERVED_HOME.iter().copied().find(|path| overlaps(path))
    } else {
        RESERVED_ABSOLUTE
            .iter()
            .map(|path| &path[1..])
            .find(|path| overlaps(path))
    };
    let credentials = rest.split('/').any(|segment| {
        [".ssh", ".gnupg"]
            .iter()
            .any(|name| segment.eq_ignore_ascii_case(name))
    });
    if reserved.is_some() || protected_segment(rest).is_some() || credentials {
        return Err(format!(
            "{field} entry {raw:?} overlaps SuperTag or harness state or credentials, which a path scope cannot grant"
        ));
    }
    Ok(format!("{prefix}{rest}"))
}

fn common_entry<'a>(raw: &'a str, field: &str) -> Result<&'a str, String> {
    let value = raw.trim();
    if value.is_empty() {
        return Err(format!("{field} entries must not be empty"));
    }
    if value.len() > MAX_ENTRY_BYTES {
        return Err(format!("{field} entry exceeds {MAX_ENTRY_BYTES} bytes"));
    }
    if value.contains('\\') || value.chars().any(char::is_control) {
        return Err(format!(
            "{field} entry {raw:?} must use / separators and no control characters"
        ));
    }
    Ok(value)
}

fn protected_segment(entry: &str) -> Option<&'static str> {
    entry.split('/').find_map(|segment| {
        PROTECTED_NAMES
            .iter()
            .copied()
            .find(|name| segment.eq_ignore_ascii_case(name))
    })
}

/// One permission's path fields, read-only.
pub struct Grant<'a> {
    pub action: &'a str,
    pub paths: &'a [String],
    pub exclude: &'a [String],
    pub additional_directories: &'a [String],
    /// Whether this grant's action is admitted. A gated or missing grant adds no access, but its
    /// exclude entries still narrow the Task.
    pub admitted: bool,
}

/// Compose the accepted grants into a Task's scope. `whole_workspace_write` is true when a grant
/// with no Workspace `paths`, such as a Tag's direct `files:write`, already covers the Workspace.
/// Returns `None` when nothing is scoped, which keeps today's unrestricted behaviour.
pub fn compose<'a>(
    grants: impl IntoIterator<Item = Grant<'a>>,
    whole_workspace_write: bool,
) -> Option<FileScope> {
    let mut write = BTreeSet::new();
    let mut whole = whole_workspace_write;
    let mut read_only = BTreeSet::new();
    let mut hidden = BTreeSet::new();
    let mut outside_write = BTreeSet::new();
    let mut outside_read = BTreeSet::new();
    let mut restricted = false;
    for grant in grants {
        match grant.action {
            FILES_WRITE => {
                read_only.extend(grant.exclude.iter().cloned());
                if grant.admitted {
                    if grant.paths.is_empty() {
                        whole = true;
                    } else {
                        restricted = true;
                        write.extend(grant.paths.iter().cloned());
                    }
                    outside_write.extend(grant.additional_directories.iter().cloned());
                }
            }
            FILES_READ => {
                hidden.extend(grant.exclude.iter().cloned());
                if grant.admitted {
                    outside_read.extend(grant.additional_directories.iter().cloned());
                }
            }
            _ => {}
        }
    }
    let scope = FileScope {
        write: if whole || !restricted {
            vec![]
        } else {
            write.into_iter().collect()
        },
        read_only: read_only.into_iter().collect(),
        hidden: hidden.into_iter().collect(),
        outside_write: outside_write.into_iter().collect(),
        outside_read: outside_read.into_iter().collect(),
    };
    (!is_empty(&scope)).then_some(scope)
}

/// A delegated write: the member's own write allow and outside write directories, the union of
/// both Tags' read-only and hidden entries, and the outside read directories both Tags have.
pub fn delegate(member: Option<&FileScope>, delegator: Option<&FileScope>) -> Option<FileScope> {
    let empty = FileScope::default();
    let (member, delegator) = (member.unwrap_or(&empty), delegator.unwrap_or(&empty));
    let union = |left: &[String], right: &[String]| -> Vec<String> {
        left.iter()
            .chain(right)
            .cloned()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect()
    };
    let scope = FileScope {
        write: member.write.clone(),
        read_only: union(&member.read_only, &delegator.read_only),
        hidden: union(&member.hidden, &delegator.hidden),
        outside_write: member.outside_write.clone(),
        outside_read: member
            .outside_read
            .iter()
            .filter(|path| delegator.outside_read.contains(path))
            .cloned()
            .collect(),
    };
    (!is_empty(&scope)).then_some(scope)
}

pub fn is_empty(scope: &FileScope) -> bool {
    scope.write.is_empty()
        && scope.read_only.is_empty()
        && scope.hidden.is_empty()
        && scope.outside_write.is_empty()
        && scope.outside_read.is_empty()
}

/// The accepted Task's scope, or `None` when it has none.
pub fn of_task(task: &Task) -> Option<&FileScope> {
    task.policy_snapshot
        .as_ref()
        .and_then(|snapshot| snapshot.runtime_authority.as_ref())
        .and_then(|authority| authority.files.as_ref())
        .filter(|scope| !is_empty(scope))
}

/// Why a Workspace path is refused, from the strongest rule.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Denial {
    /// A `files:read` exclude: neither read nor written.
    Hidden,
    /// A `files:write` exclude: readable, never written.
    ReadOnly,
    /// Outside every `files:write` path.
    OutsideWrite,
}

impl Denial {
    pub fn describe(self) -> &'static str {
        match self {
            Self::Hidden => "hidden by the Task's path scope",
            Self::ReadOnly => "read-only in the Task's path scope",
            Self::OutsideWrite => "outside the paths the Task may write",
        }
    }
}

/// The Workspace part of a scope, ready to match Workspace-relative paths.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Rules {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub write: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub read_only: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hidden: Vec<String>,
}

impl From<&FileScope> for Rules {
    fn from(scope: &FileScope) -> Self {
        Self {
            write: scope.write.clone(),
            read_only: scope.read_only.clone(),
            hidden: scope.hidden.clone(),
        }
    }
}

impl Rules {
    pub fn is_empty(&self) -> bool {
        self.write.is_empty() && self.read_only.is_empty() && self.hidden.is_empty()
    }

    /// Whether the Workspace-relative `path` (`/`-separated; empty or `.` is the root) is hidden.
    pub fn hidden(&self, path: &str) -> bool {
        let path = segments(path);
        self.hidden
            .iter()
            .any(|pattern| matches_subtree(&segments(pattern), &path, true))
    }

    /// Why reading `path` is refused, if it is.
    pub fn read_denial(&self, path: &str) -> Option<Denial> {
        self.hidden(path).then_some(Denial::Hidden)
    }

    /// Why writing `path` is refused, if it is.
    pub fn write_denial(&self, path: &str) -> Option<Denial> {
        if self.hidden(path) {
            return Some(Denial::Hidden);
        }
        let parts = segments(path);
        if self
            .read_only
            .iter()
            .any(|entry| matches_subtree(&segments(entry), &parts, true))
        {
            return Some(Denial::ReadOnly);
        }
        (!self.write.is_empty()
            && !self
                .write
                .iter()
                .any(|entry| matches_subtree(&segments(entry), &parts, false)))
        .then_some(Denial::OutsideWrite)
    }

    /// Whether some path inside the directory `path` could be hidden, which a search rooted
    /// there would have to filter.
    pub fn may_contain_hidden(&self, path: &str) -> bool {
        let path = segments(path);
        self.hidden
            .iter()
            .any(|pattern| prefix_alive(&segments(pattern), &path))
    }
}

fn segments(path: &str) -> Vec<&str> {
    path.split('/')
        .filter(|segment| !segment.is_empty() && *segment != ".")
        .collect()
}

/// Whether `pattern` matches `path` or one of its ancestors: an entry names a file or a whole
/// subtree.
fn matches_subtree(pattern: &[&str], path: &[&str], fold: bool) -> bool {
    (1..=path.len()).any(|length| matches_exact(pattern, &path[..length], fold))
}

/// Segment-wise glob match. `**` matches zero or more whole segments.
fn matches_exact(pattern: &[&str], path: &[&str], fold: bool) -> bool {
    // states[i]: pattern[..i] matches the path consumed so far.
    let mut states = vec![false; pattern.len() + 1];
    states[0] = true;
    close(pattern, &mut states);
    for segment in path {
        let mut next = vec![false; pattern.len() + 1];
        for index in 0..pattern.len() {
            if !states[index] {
                continue;
            }
            if pattern[index] == "**" {
                next[index] = true;
            } else if segment_matches(pattern[index], segment, fold) {
                next[index + 1] = true;
            }
        }
        close(pattern, &mut next);
        states = next;
    }
    states[pattern.len()]
}

/// Whether, after `path`, some continuation could still complete `pattern`.
fn prefix_alive(pattern: &[&str], path: &[&str]) -> bool {
    let mut states = vec![false; pattern.len() + 1];
    states[0] = true;
    close(pattern, &mut states);
    for segment in path {
        if states[pattern.len()] {
            // An ancestor is hidden, so the whole directory is.
            return true;
        }
        let mut next = vec![false; pattern.len() + 1];
        for index in 0..pattern.len() {
            if !states[index] {
                continue;
            }
            if pattern[index] == "**" {
                next[index] = true;
            } else if segment_matches(pattern[index], segment, true) {
                next[index + 1] = true;
            }
        }
        close(pattern, &mut next);
        states = next;
    }
    states.iter().any(|alive| *alive)
}

fn close(pattern: &[&str], states: &mut [bool]) {
    for index in 0..pattern.len() {
        if states[index] && pattern[index] == "**" {
            states[index + 1] = true;
        }
    }
}

/// `*` matches any run within a segment and `?` one character.
fn segment_matches(pattern: &str, segment: &str, fold: bool) -> bool {
    let fold_char = |c: char| if fold { c.to_ascii_lowercase() } else { c };
    let pattern: Vec<char> = pattern.chars().map(fold_char).collect();
    let segment: Vec<char> = segment.chars().map(fold_char).collect();
    let mut states = vec![false; pattern.len() + 1];
    states[0] = true;
    let star_close = |states: &mut [bool]| {
        for index in 0..pattern.len() {
            if states[index] && pattern[index] == '*' {
                states[index + 1] = true;
            }
        }
    };
    star_close(&mut states);
    for character in segment {
        let mut next = vec![false; pattern.len() + 1];
        for index in 0..pattern.len() {
            if !states[index] {
                continue;
            }
            match pattern[index] {
                '*' => next[index] = true,
                '?' => next[index + 1] = true,
                literal if literal == character => next[index + 1] = true,
                _ => {}
            }
        }
        star_close(&mut next);
        states = next;
    }
    states[pattern.len()]
}

/// How strongly a harness applies a scope part.
fn harness_name(harness: HarnessKind) -> &'static str {
    match harness {
        HarnessKind::Unspecified => "A custom harness",
        HarnessKind::Codex => "Codex",
        HarnessKind::ClaudeCode => "Claude Code",
        HarnessKind::OpenaiAgents => "OpenAI Agents",
        HarnessKind::Opencode => "OpenCode",
        HarnessKind::Cursor => "Cursor",
    }
}

fn has(task: &Task, action: &str) -> bool {
    task.allowed_actions.iter().any(|value| value == action)
}

fn listed(values: &[String]) -> String {
    let mut shown: Vec<&str> = values.iter().take(4).map(String::as_str).collect();
    if values.len() > shown.len() {
        shown.push("…");
    }
    shown.join(", ")
}

/// Why `harness` can never apply this Task's scope, whatever host runs it, or `None`.
///
/// Commands need an operating-system boundary for hidden paths. A Workspace write restriction
/// against commands is otherwise enforced when the Worker Host delivers the Workspace's changes,
/// so a Task without a Workspace needs the boundary too. Outside directories are reachable by
/// unsandboxed commands anyway, so they need only the file tools to honour them.
pub fn harness_reason(task: &Task, harness: HarnessKind) -> Option<String> {
    let scope = of_task(task)?;
    let name = harness_name(harness);
    let commands = has(task, "commands:execute");
    let restricted_write = !scope.write.is_empty() || !scope.read_only.is_empty();
    match harness {
        // Codex applies every part at the operating-system level through SuperTag's permission
        // profile, with or without web:fetch.
        HarnessKind::Codex => None,
        HarnessKind::ClaudeCode | HarnessKind::Opencode => {
            if commands && !scope.hidden.is_empty() {
                Some(format!(
                    "{name} cannot keep commands from reading hidden paths ({}); run the Tag on Codex, or remove commands:execute from its Permission Sets",
                    listed(&scope.hidden)
                ))
            } else if commands && restricted_write && task.workspace.is_none() {
                Some(format!(
                    "{name} cannot keep commands inside the write paths without a Workspace whose changes it checks at delivery; run the Tag on Codex, give the Task a Workspace, or remove commands:execute"
                ))
            } else {
                None
            }
        }
        HarnessKind::Cursor => (!scope.outside_write.is_empty() || !scope.outside_read.is_empty())
            .then(|| {
                "Cursor's tools reach only the Workspace, so it cannot grant additionalDirectories; run the Tag on Codex, Claude Code, or OpenCode".to_owned()
            }),
        HarnessKind::OpenaiAgents | HarnessKind::Unspecified => Some(format!(
            "{name} cannot enforce path scopes; run the Tag on Codex, Claude Code, OpenCode, or Cursor"
        )),
    }
}

/// Why a host lane with `profile` cannot apply this Task's scope, or `None` when it can.
pub fn reason(
    task: &Task,
    harness: HarnessKind,
    profile: &HarnessExecutionProfile,
) -> Option<String> {
    if let Some(reason) = harness_reason(task, harness) {
        return Some(reason);
    }
    let scope = of_task(task)?;
    // A remote sandbox holds the whole checkout, hidden paths included, and its commands can
    // read any of it.
    if profile.remote_file_workspace
        && (!scope.outside_write.is_empty() || !scope.outside_read.is_empty())
    {
        return Some(
            "tools in a remote Workspace sandbox reach only the Workspace, so they cannot grant additionalDirectories; run the Tag on a local Worker Host".to_owned(),
        );
    }
    // Codex's exec-server reads and writes the sandbox directly, past the provider's file tools.
    if profile.remote_file_workspace && harness == HarnessKind::Codex {
        return Some(
            "Codex on a remote Workspace cannot apply a path scope yet; run the Tag on a local Codex Worker Host, or remove the path scope from the Tag's Permission Sets".to_owned(),
        );
    }
    if profile.remote_file_workspace && has(task, "commands:execute") && !scope.hidden.is_empty() {
        return Some(format!(
            "commands in a remote Workspace sandbox can read hidden paths ({}); remove commands:execute or the hidden paths from the Tag's Permission Sets, or run the Tag on a local Codex Worker Host",
            listed(&scope.hidden)
        ));
    }
    if harness != HarnessKind::Cursor {
        return None;
    }
    if profile.shared_execution.is_some() {
        let restricted =
            !scope.write.is_empty() || !scope.read_only.is_empty() || !scope.hidden.is_empty();
        return (restricted && has(task, "commands:execute")).then(|| {
            "Cursor shared execution cannot keep commands inside a path scope; remove commands:execute or the path scope from the Tag's Permission Sets".to_owned()
        });
    }
    (!profile.remote_file_workspace).then(|| {
        "Cursor's local tools cannot apply path scopes yet; run the Tag on a Worker Host with a remote Cursor Workspace or shared execution, or on Codex".to_owned()
    })
}

/// Whether a host lane with `profile` can apply this Task's scope.
pub fn supports(task: &Task, harness: HarnessKind, profile: &HarnessExecutionProfile) -> bool {
    reason(task, harness, profile).is_none()
}

/// Expand and check a scope's outside directories on the Worker Host, before the harness starts.
/// `~/` expands to `home`, the Worker Host user's home from the password database (adapters give
/// harnesses a private `HOME`). Each directory must exist; the result is its canonical path. A
/// directory that equals, contains, or lies inside one of `reserved` (the Workspace, the
/// harness's private home, SuperTag's state), or that contains `home`, is refused.
pub fn resolve_outside(
    entries: &[String],
    home: &std::path::Path,
    reserved: &[&std::path::Path],
) -> Result<Vec<std::path::PathBuf>, String> {
    let canonical = |path: &std::path::Path| path.canonicalize().unwrap_or(path.to_path_buf());
    let mut fixed: Vec<std::path::PathBuf> = reserved.iter().map(|path| canonical(path)).collect();
    for name in [".supertag", ".codex", ".claude", ".cursor", ".ssh", ".aws"] {
        fixed.push(canonical(&home.join(name)));
    }
    let home = canonical(home);
    entries
        .iter()
        .map(|entry| {
            let expanded = match entry.strip_prefix("~/") {
                Some(rest) => home.join(rest),
                None => std::path::PathBuf::from(entry),
            };
            let path = expanded.canonicalize().map_err(|_| {
                format!("additional directory {entry} does not exist on this Worker Host")
            })?;
            if !path.is_dir() {
                return Err(format!("additional directory {entry} is not a directory"));
            }
            if home.starts_with(&path)
                || fixed
                    .iter()
                    .any(|reserved| reserved.starts_with(&path) || path.starts_with(reserved))
            {
                return Err(format!(
                    "additional directory {entry} overlaps the Workspace, SuperTag, or harness state on this Worker Host"
                ));
            }
            Ok(path)
        })
        .collect()
}

/// A short summary of a scope for `describe`: `Writes src/, tests/ · Read-only … · Hidden …`.
pub fn summary(scope: &FileScope) -> String {
    let mut parts = vec![];
    let writes: Vec<&String> = scope.write.iter().chain(&scope.outside_write).collect();
    if !writes.is_empty() {
        let mut text = if scope.write.is_empty() {
            "Writes the Workspace, ".to_owned()
        } else {
            "Writes ".to_owned()
        };
        text.push_str(
            &writes
                .iter()
                .map(|value| value.as_str())
                .collect::<Vec<_>>()
                .join(", "),
        );
        parts.push(text);
    }
    for (label, values) in [
        ("Read-only", &scope.read_only),
        ("Hidden", &scope.hidden),
        ("Also reads", &scope.outside_read),
    ] {
        if !values.is_empty() {
            parts.push(format!("{label} {}", values.join(", ")));
        }
    }
    parts.join(" · ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    type Fields = (Vec<String>, Vec<String>, Vec<String>);

    fn normalized(
        action: &str,
        paths: &[&str],
        exclude: &[&str],
        extra: &[&str],
    ) -> Result<Fields, String> {
        let (mut paths, mut exclude, mut extra) =
            (strings(paths), strings(exclude), strings(extra));
        normalize_permission(
            action,
            PermissionPaths {
                paths: &mut paths,
                exclude: &mut exclude,
                additional_directories: &mut extra,
            },
        )?;
        Ok((paths, exclude, extra))
    }

    #[test]
    fn canonicalizes_entries() {
        let (paths, exclude, extra) = normalized(
            FILES_WRITE,
            &["tests/", "src/**", " src/ ", "package.json"],
            &["src/generated/**"],
            &["~/.cache/pip/", "/opt/data"],
        )
        .unwrap();
        assert_eq!(paths, strings(&["package.json", "src/", "tests/"]));
        assert_eq!(exclude, strings(&["src/generated/"]));
        assert_eq!(extra, strings(&["/opt/data", "~/.cache/pip"]));
        let (_, exclude, _) =
            normalized(FILES_READ, &[], &["**/.env", "**/.env.*", "secrets/"], &[]).unwrap();
        assert_eq!(exclude, strings(&["**/.env", "**/.env.*", "secrets/"]));
    }

    #[test]
    fn refuses_invalid_entries_with_a_reason() {
        let refused =
            |action: &str, paths: &[&str], exclude: &[&str], extra: &[&str], needle: &str| {
                let error = normalized(action, paths, exclude, extra).unwrap_err();
                assert!(error.contains(needle), "{error} lacks {needle}");
            };
        refused("commands:execute", &["src/"], &[], &[], "takes no paths");
        refused(
            "files:delegate-write",
            &[],
            &["src/"],
            &[],
            "takes no paths",
        );
        refused(FILES_READ, &["src/"], &[], &[], "files:read takes no paths");
        refused(FILES_WRITE, &["src/*.rs"], &[], &[], "is a glob");
        refused(FILES_WRITE, &[], &["**/gen"], &[], "is a glob");
        refused(FILES_READ, &[], &["src/{a,b}"], &[], "only *, ** and ?");
        refused(FILES_READ, &[], &["a**b"], &[], "whole path segment");
        refused(FILES_WRITE, &["../x"], &[], &[], ". or ..");
        refused(FILES_WRITE, &["src/./x"], &[], &[], ". or ..");
        refused(FILES_WRITE, &["src//x"], &[], &[], ". or ..");
        refused(FILES_WRITE, &["src\\x"], &[], &[], "/ separators");
        refused(FILES_WRITE, &["src\nx"], &[], &[], "control");
        refused(
            FILES_WRITE,
            &["/etc"],
            &[],
            &[],
            "relative to the Workspace",
        );
        refused(
            FILES_WRITE,
            &["~/x"],
            &[],
            &[],
            "only in additionalDirectories",
        );
        refused(FILES_READ, &[], &["!secrets/"], &[], "starts with !");
        refused(FILES_WRITE, &[".git/"], &[], &[], "stays read-only");
        refused(
            FILES_WRITE,
            &["app/.GIT/hooks"],
            &[],
            &[],
            "stays read-only",
        );
        refused(
            FILES_WRITE,
            &[".claude/settings.json"],
            &[],
            &[],
            "stays read-only",
        );
        refused(FILES_WRITE, &[".cursor/"], &[], &[], "stays read-only");
        refused(FILES_WRITE, &[".codex"], &[], &[], "stays read-only");
        refused(FILES_WRITE, &[], &[], &["~"], "whole home");
        refused(FILES_WRITE, &[], &[], &["~/"], "whole home");
        refused(FILES_WRITE, &[], &[], &["/"], "whole filesystem");
        refused(FILES_WRITE, &[], &[], &["~/.supertag"], "overlaps");
        refused(FILES_WRITE, &[], &[], &["~/.supertag/state"], "overlaps");
        refused(FILES_READ, &[], &[], &["~/.config"], "overlaps");
        refused(FILES_READ, &[], &[], &["~/.ssh"], "overlaps");
        refused(FILES_WRITE, &[], &[], &["/Users"], "overlaps");
        refused(FILES_WRITE, &[], &[], &["/srv/repo/.git"], "overlaps");
        refused(
            FILES_WRITE,
            &[],
            &[],
            &["relative"],
            "absolute or start with ~/",
        );
        refused(
            FILES_WRITE,
            &[],
            &[],
            &["~other/x"],
            "absolute or start with ~/",
        );
        refused(FILES_WRITE, &[], &[], &["/opt/*"], "is a glob");
        refused(FILES_WRITE, &[], &[], &["/opt/../etc"], ". or ..");
        let many: Vec<String> = (0..65).map(|index| format!("d{index}")).collect();
        let many: Vec<&str> = many.iter().map(String::as_str).collect();
        refused(FILES_WRITE, &many, &[], &[], "at most 64");
        refused(FILES_WRITE, &[&"x".repeat(1025)], &[], &[], "exceeds 1024");
        // Hiding or excluding protected entries narrows access and is allowed.
        assert!(normalized(FILES_READ, &[], &[".git/"], &[]).is_ok());
        assert!(normalized(FILES_WRITE, &["src/"], &[".agents/"], &[]).is_ok());
        assert!(normalized(FILES_WRITE, &[], &[], &["~/.cache/pip"]).is_ok());
    }

    #[derive(serde::Deserialize)]
    struct Vectors {
        cases: Vec<Case>,
    }
    #[derive(serde::Deserialize)]
    struct Case {
        name: String,
        #[serde(default)]
        write: Vec<String>,
        #[serde(default, rename = "readOnly")]
        read_only: Vec<String>,
        #[serde(default)]
        hidden: Vec<String>,
        checks: Vec<Check>,
    }
    #[derive(serde::Deserialize)]
    struct Check {
        path: String,
        read: bool,
        write: bool,
        #[serde(default, rename = "searchMayContainHidden")]
        search: Option<bool>,
    }

    /// The vectors the TypeScript matcher also runs, so every enforcement point agrees.
    #[test]
    fn shared_vectors() {
        let vectors: Vectors =
            serde_json::from_str(include_str!("../testdata/file_scope_vectors.json")).unwrap();
        for case in vectors.cases {
            let rules = Rules {
                write: case.write,
                read_only: case.read_only,
                hidden: case.hidden,
            };
            for check in case.checks {
                assert_eq!(
                    rules.read_denial(&check.path).is_none(),
                    check.read,
                    "{}: read {}",
                    case.name,
                    check.path
                );
                assert_eq!(
                    rules.write_denial(&check.path).is_none(),
                    check.write,
                    "{}: write {}",
                    case.name,
                    check.path
                );
                if let Some(search) = check.search {
                    assert_eq!(
                        rules.may_contain_hidden(&check.path),
                        search,
                        "{}: search {}",
                        case.name,
                        check.path
                    );
                }
            }
        }
    }

    fn grant<'a>(
        action: &'a str,
        paths: &'a [String],
        exclude: &'a [String],
        extra: &'a [String],
    ) -> Grant<'a> {
        Grant {
            action,
            paths,
            exclude,
            additional_directories: extra,
            admitted: true,
        }
    }

    #[test]
    fn composes_union_and_precedence_across_sets() {
        let (src, tests, generated) = (
            strings(&["src/"]),
            strings(&["tests/"]),
            strings(&["src/generated/"]),
        );
        let (env, pip, none) = (strings(&["**/.env"]), strings(&["~/.cache/pip"]), vec![]);
        let scope = compose(
            [
                grant(FILES_WRITE, &src, &generated, &pip),
                grant(FILES_WRITE, &tests, &none, &none),
                grant(FILES_READ, &none, &env, &none),
                grant("commands:execute", &none, &none, &none),
            ],
            false,
        )
        .unwrap();
        assert_eq!(scope.write, strings(&["src/", "tests/"]));
        assert_eq!(scope.read_only, generated);
        assert_eq!(scope.hidden, env);
        assert_eq!(scope.outside_write, pip);
        // A grant without Workspace paths, or a direct files:write, widens writes to the whole
        // Workspace; exclude entries from every set still apply.
        let whole = compose(
            [
                grant(FILES_WRITE, &src, &generated, &none),
                grant(FILES_WRITE, &none, &none, &pip),
            ],
            false,
        )
        .unwrap();
        assert!(whole.write.is_empty());
        assert_eq!(whole.read_only, generated);
        let direct = compose([grant(FILES_WRITE, &src, &none, &none)], true);
        assert!(direct.is_none());
        // A hide-only set adds no access of its own.
        let hide = compose([grant(FILES_READ, &none, &env, &none)], false).unwrap();
        assert_eq!(hide.hidden, env);
        assert!(hide.write.is_empty());
        // A gated grant adds no access but keeps its exclusions.
        let mut gated = grant(FILES_WRITE, &src, &generated, &pip);
        gated.admitted = false;
        let gated = compose([gated], false).unwrap();
        assert!(gated.write.is_empty() && gated.outside_write.is_empty());
        assert_eq!(gated.read_only, generated);
        assert!(compose([grant(FILES_READ, &none, &none, &none)], false).is_none());
    }

    #[test]
    fn delegation_keeps_member_writes_and_both_restrictions() {
        let member = FileScope {
            write: strings(&["src/"]),
            read_only: strings(&["src/gen/"]),
            hidden: strings(&["a/"]),
            outside_write: strings(&["~/.cache/pip"]),
            outside_read: strings(&["/opt/a", "/opt/b"]),
        };
        let delegator = FileScope {
            write: strings(&["docs/"]),
            read_only: strings(&["README.md"]),
            hidden: strings(&["**/.env"]),
            outside_write: strings(&["/tmp/x"]),
            outside_read: strings(&["/opt/b"]),
        };
        let scope = delegate(Some(&member), Some(&delegator)).unwrap();
        assert_eq!(scope.write, strings(&["src/"]));
        assert_eq!(scope.read_only, strings(&["README.md", "src/gen/"]));
        assert_eq!(scope.hidden, strings(&["**/.env", "a/"]));
        assert_eq!(scope.outside_write, strings(&["~/.cache/pip"]));
        assert_eq!(scope.outside_read, strings(&["/opt/b"]));
        assert!(delegate(None, None).is_none());
    }

    fn task(actions: &[&str], scope: FileScope, workspace: bool) -> Task {
        use crate::v2::{TaskPolicySnapshot, TaskRuntimeAuthority, WorkspaceSpec};
        Task {
            allowed_actions: strings(actions),
            workspace: workspace.then(WorkspaceSpec::default),
            policy_snapshot: Some(TaskPolicySnapshot {
                runtime_authority: Some(TaskRuntimeAuthority {
                    files: Some(scope),
                    ..Default::default()
                }),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    #[test]
    fn infers_the_strength_each_harness_needs() {
        let local = HarnessExecutionProfile::default();
        let remote = HarnessExecutionProfile {
            remote_file_workspace: true,
            ..Default::default()
        };
        let shared = HarnessExecutionProfile {
            shared_execution: Some(Default::default()),
            ..Default::default()
        };
        let hidden = FileScope {
            hidden: strings(&["**/.env"]),
            ..Default::default()
        };
        let writes = FileScope {
            write: strings(&["src/"]),
            ..Default::default()
        };
        let outside = FileScope {
            outside_write: strings(&["~/.cache/pip"]),
            ..Default::default()
        };
        let commands = ["files:read", "files:write", "commands:execute"];
        let tools = ["files:read", "files:write"];
        // Codex enforces every part at the operating-system level, with web:fetch too.
        for scope in [&hidden, &writes, &outside] {
            for actions in [
                &commands[..],
                &["files:write", "commands:execute", "web:fetch"],
            ] {
                assert!(supports(
                    &task(actions, scope.clone(), false),
                    HarnessKind::Codex,
                    &local
                ));
                // On a remote Workspace its exec-server reads and writes past any scope.
                let remote_codex = reason(
                    &task(actions, scope.clone(), true),
                    HarnessKind::Codex,
                    &remote,
                )
                .unwrap();
                assert!(remote_codex.contains("local"), "{remote_codex}");
            }
        }
        for harness in [HarnessKind::ClaudeCode, HarnessKind::Opencode] {
            // Tool-level is enough without commands.
            assert!(supports(
                &task(&tools, hidden.clone(), false),
                harness,
                &local
            ));
            // Commands could read hidden paths.
            let reason = harness_reason(&task(&commands, hidden.clone(), true), harness).unwrap();
            assert!(reason.contains("hidden paths (**/.env)"), "{reason}");
            // Delivery covers a write restriction, but only with a Workspace.
            assert!(supports(
                &task(&commands, writes.clone(), true),
                harness,
                &local
            ));
            assert!(!supports(
                &task(&commands, writes.clone(), false),
                harness,
                &local
            ));
            // Unsandboxed commands already reach outside directories.
            assert!(supports(
                &task(&commands, outside.clone(), false),
                harness,
                &local
            ));
        }
        // Cursor: refused locally, tool-level on remote and shared tools, commands only unscoped.
        let cursor = task(&tools, hidden.clone(), true);
        assert!(
            reason(&cursor, HarnessKind::Cursor, &local)
                .unwrap()
                .contains("local tools")
        );
        assert!(supports(&cursor, HarnessKind::Cursor, &remote));
        assert!(supports(&cursor, HarnessKind::Cursor, &shared));
        assert!(!supports(
            &task(&commands, writes.clone(), true),
            HarnessKind::Cursor,
            &shared
        ));
        assert!(!supports(
            &task(&tools, outside.clone(), true),
            HarnessKind::Cursor,
            &remote
        ));
        // Remote commands run in a sandbox holding the whole checkout: hidden paths are refused,
        // and a write restriction is checked at delivery.
        let remote_hidden = reason(
            &task(&commands, hidden.clone(), true),
            HarnessKind::Cursor,
            &remote,
        )
        .unwrap();
        assert!(
            remote_hidden.contains("remote Workspace sandbox"),
            "{remote_hidden}"
        );
        assert!(supports(
            &task(&commands, writes.clone(), true),
            HarnessKind::Cursor,
            &remote
        ));
        // Claude Code in a remote sandbox: no outside directories, no hidden paths with commands.
        assert!(supports(
            &task(&commands, writes.clone(), true),
            HarnessKind::ClaudeCode,
            &remote
        ));
        assert!(!supports(
            &task(&commands, hidden.clone(), true),
            HarnessKind::ClaudeCode,
            &remote
        ));
        let outside_remote = reason(
            &task(&tools, outside.clone(), true),
            HarnessKind::ClaudeCode,
            &remote,
        )
        .unwrap();
        assert!(
            outside_remote.contains("additionalDirectories"),
            "{outside_remote}"
        );
        assert!(!supports(
            &task(&tools, writes.clone(), true),
            HarnessKind::OpenaiAgents,
            &local
        ));
        // No scope: nothing to apply.
        assert!(supports(
            &task(&commands, FileScope::default(), false),
            HarnessKind::Unspecified,
            &local
        ));
    }

    #[test]
    fn resolves_outside_directories_on_the_host() {
        let root = tempfile_dir();
        let home = root.join("home");
        let workspace = root.join("workspace");
        for path in [
            home.join(".cache/pip"),
            home.join(".supertag"),
            workspace.join(".git"),
            root.join("opt/data"),
        ] {
            std::fs::create_dir_all(&path).unwrap();
        }
        std::os::unix::fs::symlink(home.join(".supertag"), home.join(".cache/state")).unwrap();
        std::fs::write(root.join("file"), "x").unwrap();
        let resolve = |entry: &str| resolve_outside(&[entry.to_owned()], &home, &[&workspace]);
        assert_eq!(
            resolve("~/.cache/pip").unwrap(),
            [home.join(".cache/pip").canonicalize().unwrap()]
        );
        let data = root.join("opt/data");
        assert!(resolve(data.to_str().unwrap()).is_ok());
        for (entry, needle) in [
            ("~/.cache/missing".to_owned(), "does not exist"),
            (root.join("file").display().to_string(), "not a directory"),
            ("~/.cache/state".to_owned(), "overlaps"),
            (workspace.join(".git").display().to_string(), "overlaps"),
            (root.display().to_string(), "overlaps"),
        ] {
            let error = resolve(&entry).unwrap_err();
            assert!(error.contains(needle), "{entry}: {error}");
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    fn tempfile_dir() -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("file-scope-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        path.canonicalize().unwrap()
    }

    #[test]
    fn summarizes_a_scope() {
        let scope = FileScope {
            write: strings(&["src/", "tests/"]),
            read_only: strings(&["src/generated/"]),
            hidden: strings(&["**/.env", "secrets/"]),
            outside_write: strings(&["~/.cache/pip"]),
            outside_read: vec![],
        };
        assert_eq!(
            summary(&scope),
            "Writes src/, tests/, ~/.cache/pip · Read-only src/generated/ · Hidden **/.env, secrets/"
        );
    }
}
