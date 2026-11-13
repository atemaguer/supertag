//! The supported `devcontainer.json` subset, read as data from a trusted Git commit.
//!
//! Ports TypeScript `packages/runtime/sdk/src/devcontainer-subset.ts` and
//! `devcontainerCommands` in `sandbox-workspace-environment.ts`. Nothing here checks out
//! repository content or runs a repository command on the Worker Host; translation into a
//! sandbox image and lifecycle script happens inside the sandbox provider.

use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{DirBuilder, OpenOptions},
    io::Write as _,
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::Path,
    process::{Command, Stdio},
};

use anyhow::{Context, Result, anyhow, bail, ensure};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

const FILE_LIMIT: usize = 1024 * 1024;
const CONTEXT_LIMIT: usize = 512 * 1024 * 1024;
const CANDIDATES: [&str; 2] = [".devcontainer/devcontainer.json", ".devcontainer.json"];
const FIELDS: [&str; 14] = [
    "image",
    "build",
    "onCreateCommand",
    "updateContentCommand",
    "postCreateCommand",
    "containerEnv",
    "remoteEnv",
    "remoteUser",
    "containerUser",
    "workspaceFolder",
    // Accepted and discarded.
    "postStartCommand",
    "postAttachCommand",
    "forwardPorts",
    "customizations",
];
const BUILD_FIELDS: [&str; 3] = ["dockerfile", "context", "args"];
const DOCKERFILE_INSTRUCTIONS: [&str; 10] = [
    "FROM",
    "RUN",
    "ENV",
    "ARG",
    "WORKDIR",
    "USER",
    "EXPOSE",
    "VOLUME",
    "CMD",
    "ENTRYPOINT",
];

/// One entry of a lifecycle command: a shell string or an argv list.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum CommandEntry {
    Shell(String),
    Argv(Vec<String>),
}

/// A devcontainer lifecycle command in any of its three forms. Named commands are kept in
/// name order; the devcontainer format runs them in parallel, so their order is not meaningful.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum DevcontainerCommand {
    Shell(String),
    Argv(Vec<String>),
    Named(BTreeMap<String, CommandEntry>),
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DevcontainerBuild {
    pub dockerfile: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<BTreeMap<String, String>>,
    /// Resolved repository path, bytes, and SHA-256 read with Git from the trusted commit.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dockerfile_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dockerfile_content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dockerfile_digest: Option<String>,
}

/// The validated subset of a trusted commit's `devcontainer.json`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DevcontainerSubset {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub build: Option<DevcontainerBuild>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub on_create_command: Option<DevcontainerCommand>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub update_content_command: Option<DevcontainerCommand>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub post_create_command: Option<DevcontainerCommand>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub container_env: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_env: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_user: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub container_user: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_folder: Option<String>,
}

fn object<'a>(value: &'a Value, property: &str) -> Result<&'a serde_json::Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| anyhow!("devcontainer property {property} must be an object"))
}

fn string(value: &Value, property: &str, allow_empty: bool) -> Result<String> {
    let text = value
        .as_str()
        .filter(|text| (allow_empty || !text.is_empty()) && !text.contains('\0'))
        .ok_or_else(|| {
            anyhow!(
                "devcontainer property {property} must be a string{}",
                if allow_empty { "" } else { " with content" }
            )
        })?;
    ensure!(
        !text.to_ascii_lowercase().contains("${localenv:"),
        "devcontainer property {property} cannot reference localEnv on the Worker Host"
    );
    Ok(text.to_owned())
}

fn valid_env_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && (bytes[0].is_ascii_alphabetic() || bytes[0] == b'_')
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || *b == b'_')
}

fn assert_env_name(key: &str, property: &str) -> Result<()> {
    ensure!(
        valid_env_name(key),
        "devcontainer property {property}.{key} has an invalid variable name"
    );
    if property == "containerEnv" || property == "remoteEnv" {
        let upper = key.to_ascii_uppercase();
        let reserved = [
            "ANTHROPIC_",
            "OPENAI_",
            "CLAUDE_",
            "CODEX_",
            "GIT_",
            "SUPERTAG_",
            "LD_",
            "DYLD_",
            "E2B_",
            "MODAL_",
            "AWS_",
        ]
        .iter()
        .any(|prefix| upper.starts_with(prefix))
            || upper == "NODE_OPTIONS"
            || upper == "PATH"
            || upper.ends_with("_PROXY");
        ensure!(
            !reserved,
            "devcontainer property {property}.{key} is a reserved variable name"
        );
    }
    Ok(())
}

fn strings(value: &Value, property: &str) -> Result<BTreeMap<String, String>> {
    object(value, property)?
        .iter()
        .map(|(key, entry)| {
            assert_env_name(key, property)?;
            Ok((
                key.clone(),
                string(entry, &format!("{property}.{key}"), true)?,
            ))
        })
        .collect()
}

fn argv(value: &[Value], property: &str) -> Result<Vec<String>> {
    value
        .iter()
        .enumerate()
        .map(|(index, part)| string(part, &format!("{property}[{index}]"), false))
        .collect()
}

fn command(value: &Value, property: &str) -> Result<DevcontainerCommand> {
    match value {
        Value::String(_) => Ok(DevcontainerCommand::Shell(string(value, property, false)?)),
        Value::Array(items) => {
            ensure!(
                !items.is_empty(),
                "devcontainer property {property} needs a command"
            );
            Ok(DevcontainerCommand::Argv(argv(items, property)?))
        }
        _ => {
            let entries = object(value, property)?;
            ensure!(
                !entries.is_empty(),
                "devcontainer property {property} needs a command"
            );
            entries
                .iter()
                .map(|(name, entry)| {
                    let path = format!("{property}.{name}");
                    let entry = match entry {
                        Value::String(_) => CommandEntry::Shell(string(entry, &path, false)?),
                        Value::Array(items) if !items.is_empty() => {
                            CommandEntry::Argv(argv(items, &path)?)
                        }
                        _ => bail!("devcontainer property {path} must be a string or argv list"),
                    };
                    Ok((name.clone(), entry))
                })
                .collect::<Result<_>>()
                .map(DevcontainerCommand::Named)
        }
    }
}

/// POSIX path normalization exactly as Node's `path.posix.normalize`, which keeps a trailing slash.
fn normalize(path: &str) -> String {
    let absolute = path.starts_with('/');
    let trailing = path.ends_with('/');
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.last().is_some_and(|last| *last != "..") {
                    parts.pop();
                } else if !absolute {
                    parts.push("..");
                }
            }
            part => parts.push(part),
        }
    }
    let joined = parts.join("/");
    let mut normalized = match (absolute, joined.is_empty()) {
        (true, _) => format!("/{joined}"),
        (false, true) => ".".into(),
        (false, false) => joined,
    };
    if trailing && !normalized.ends_with('/') {
        normalized.push('/');
    }
    normalized
}

fn relative_path(value: &Value, property: &str) -> Result<String> {
    let path = string(value, property, false)?;
    ensure!(
        !path.starts_with('/') && !path.contains(['\\', '\r', '\n']),
        "devcontainer property {property} must be a relative repository path"
    );
    // Deliberate difference: TS keeps `tools/`, and its build-context prefix then becomes
    // `tools//`, which matches no tracked file. Repository paths here never end in a slash.
    Ok(normalize(path.trim_end_matches('/')))
}

/// Strips comments and trailing commas, as the devcontainer format allows.
fn jsonc(source: &str) -> Result<Value> {
    let chars: Vec<char> = source.chars().collect();
    let mut output = String::with_capacity(source.len());
    let (mut quoted, mut escaped) = (false, false);
    let mut index = 0;
    while index < chars.len() {
        let char = chars[index];
        let next = chars.get(index + 1).copied();
        if quoted {
            output.push(char);
            if escaped {
                escaped = false;
            } else if char == '\\' {
                escaped = true;
            } else if char == '"' {
                quoted = false;
            }
        } else if char == '"' {
            quoted = true;
            output.push(char);
        } else if char == '/' && next == Some('/') {
            while index < chars.len() && chars[index] != '\n' {
                index += 1;
            }
            output.push('\n');
        } else if char == '/' && next == Some('*') {
            index += 2;
            while index < chars.len()
                && !(chars[index] == '*' && chars.get(index + 1) == Some(&'/'))
            {
                if chars[index] == '\n' {
                    output.push('\n');
                }
                index += 1;
            }
            ensure!(index < chars.len(), "devcontainer has an unclosed comment");
            index += 1;
        } else {
            output.push(char);
        }
        index += 1;
    }
    // Remove commas only when the next nonspace character closes an array or object.
    let chars: Vec<char> = output.chars().collect();
    let mut cleaned = String::with_capacity(output.len());
    let (mut quoted, mut escaped) = (false, false);
    for (index, &char) in chars.iter().enumerate() {
        if quoted {
            cleaned.push(char);
            if escaped {
                escaped = false;
            } else if char == '\\' {
                escaped = true;
            } else if char == '"' {
                quoted = false;
            }
        } else if char == '"' {
            quoted = true;
            cleaned.push(char);
        } else if char == ','
            && chars[index + 1..]
                .iter()
                .find(|next| !next.is_whitespace())
                .is_some_and(|next| *next == '}' || *next == ']')
        {
        } else {
            cleaned.push(char);
        }
    }
    Ok(serde_json::from_str(&cleaned)?)
}

/// Refuses every out-of-subset property by name. Ignored properties are discarded.
pub fn parse_devcontainer_subset(source: &str) -> Result<DevcontainerSubset> {
    ensure!(source.len() <= FILE_LIMIT, "devcontainer.json is too large");
    let parsed = jsonc(source)
        .and_then(|value| {
            object(&value, "root")?;
            Ok(value)
        })
        .map_err(|error| anyhow!("Invalid devcontainer.json: {error}"))?;
    let parsed = parsed.as_object().expect("checked object");
    for property in parsed.keys() {
        ensure!(
            FIELDS.contains(&property.as_str()),
            "Unsupported devcontainer property {property}"
        );
    }
    ensure!(
        !(parsed.contains_key("image") && parsed.contains_key("build")),
        "devcontainer properties image and build are mutually exclusive"
    );
    let mut result = DevcontainerSubset::default();
    if let Some(image) = parsed.get("image") {
        let image = string(image, "image", false)?;
        ensure!(
            !image.chars().any(char::is_whitespace),
            "devcontainer property image must be an image reference"
        );
        result.image = Some(image);
    }
    if let Some(build) = parsed.get("build") {
        let build = object(build, "build")?;
        for property in build.keys() {
            ensure!(
                BUILD_FIELDS.contains(&property.as_str()),
                "Unsupported devcontainer property build.{property}"
            );
        }
        result.build = Some(DevcontainerBuild {
            dockerfile: relative_path(
                build.get("dockerfile").unwrap_or(&Value::Null),
                "build.dockerfile",
            )?,
            context: build
                .get("context")
                .map(|context| relative_path(context, "build.context"))
                .transpose()?,
            args: build
                .get("args")
                .map(|args| strings(args, "build.args"))
                .transpose()?,
            ..Default::default()
        });
    }
    let lifecycle = |name: &str| {
        parsed
            .get(name)
            .map(|value| command(value, name))
            .transpose()
    };
    result.on_create_command = lifecycle("onCreateCommand")?;
    result.update_content_command = lifecycle("updateContentCommand")?;
    result.post_create_command = lifecycle("postCreateCommand")?;
    let environment = |name: &str| {
        parsed
            .get(name)
            .map(|value| strings(value, name))
            .transpose()
    };
    result.container_env = environment("containerEnv")?;
    result.remote_env = environment("remoteEnv")?;
    let user = |name: &str| {
        parsed
            .get(name)
            .map(|value| {
                let user = string(value, name, false)?;
                ensure!(
                    user.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b)),
                    "devcontainer property {name} must be a user name or ID"
                );
                Ok(user)
            })
            .transpose()
    };
    result.remote_user = user("remoteUser")?;
    result.container_user = user("containerUser")?;
    if let Some(folder) = parsed.get("workspaceFolder") {
        let folder = string(folder, "workspaceFolder", false)?;
        ensure!(
            folder.starts_with('/')
                && folder != "/"
                && normalize(&folder) == folder
                && !folder.contains(['\r', '\n']),
            "devcontainer property workspaceFolder must be a normalized absolute path"
        );
        result.workspace_folder = Some(folder);
    }
    Ok(result)
}

fn git(repository: &Path, args: &[&str], limit: usize) -> Result<Vec<u8>> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repository)
        .args(["-c", "core.hooksPath=/dev/null"])
        .args(args)
        .env_clear()
        .env(
            "PATH",
            std::env::var_os("PATH").unwrap_or_else(|| "/usr/bin:/bin".into()),
        )
        .env("LANG", "C")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .output()
        .context("run git")?;
    ensure!(
        output.status.success(),
        "git {} failed",
        args.first().copied().unwrap_or_default()
    );
    ensure!(output.stdout.len() <= limit, "git output is too large");
    Ok(output.stdout)
}

fn valid_commit(commit: &str) -> bool {
    matches!(commit.len(), 40 | 64) && commit.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Parses one `git ls-tree` entry: mode, object ID, and path.
fn tree_entry(line: &str) -> Option<(&str, &str, &str)> {
    let (meta, path) = line.split_once('\t')?;
    let mut fields = meta.split(' ');
    let (mode, kind, oid) = (fields.next()?, fields.next()?, fields.next()?);
    (kind == "blob"
        && fields.next().is_none()
        && matches!(oid.len(), 40 | 64)
        && oid.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')))
    .then_some((mode, oid, path))
}

fn blob(repository: &Path, commit: &str, path: &str) -> Result<Option<String>> {
    let listed = git(
        repository,
        &["ls-tree", "-r", commit, "--", path],
        FILE_LIMIT,
    )?;
    let listed = String::from_utf8(listed).context("git listed a non-UTF-8 path")?;
    let Some(line) = listed
        .lines()
        .find(|line| line.ends_with(&format!("\t{path}")))
    else {
        return Ok(None);
    };
    ensure!(
        tree_entry(line).is_some_and(|(mode, _, _)| mode == "100644" || mode == "100755"),
        "devcontainer file {path} must be a regular file"
    );
    let bytes = git(
        repository,
        &["cat-file", "blob", &format!("{commit}:{path}")],
        FILE_LIMIT,
    )?;
    Ok(Some(String::from_utf8(bytes).with_context(|| {
        format!("devcontainer file {path} is not UTF-8")
    })?))
}

fn escapes(path: &str) -> bool {
    path == ".." || path.starts_with("../") || path.starts_with('/')
}

/// Reads only the trusted commit. A missing file means the provider's default toolchain.
pub fn read_trusted_devcontainer(
    repository: &Path,
    trusted_commit: &str,
) -> Result<Option<DevcontainerSubset>> {
    ensure!(valid_commit(trusted_commit), "invalid trusted commit");
    for path in CANDIDATES {
        let Some(source) = blob(repository, trusted_commit, path)? else {
            continue;
        };
        let mut parsed = parse_devcontainer_subset(&source)?;
        let Some(build) = parsed.build.as_mut() else {
            return Ok(Some(parsed));
        };
        let directory = Path::new(path)
            .parent()
            .and_then(Path::to_str)
            .filter(|directory| !directory.is_empty())
            .unwrap_or(".");
        let dockerfile_path = normalize(&format!("{directory}/{}", build.dockerfile));
        ensure!(
            !escapes(&dockerfile_path),
            "devcontainer property build.dockerfile escapes the trusted repository"
        );
        let context = normalize(&format!(
            "{directory}/{}",
            build.context.as_deref().unwrap_or(".")
        ));
        ensure!(
            !escapes(&context),
            "devcontainer property build.context escapes the trusted repository"
        );
        let dockerfile = blob(repository, trusted_commit, &dockerfile_path)?.ok_or_else(|| {
            anyhow!(
                "devcontainer build.dockerfile {dockerfile_path} is missing at the trusted commit"
            )
        })?;
        build.dockerfile_digest = Some(format!("{:x}", Sha256::digest(dockerfile.as_bytes())));
        build.dockerfile_path = Some(dockerfile_path);
        build.dockerfile_content = Some(dockerfile);
        build.context = Some(context);
        return Ok(Some(parsed));
    }
    Ok(None)
}

/// Materializes only tracked regular blobs from the trusted commit for a Docker build.
/// No checkout, smudge filter, hook, archive extraction, or repository script runs.
pub fn materialize_trusted_build_context(
    repository: &Path,
    trusted_commit: &str,
    context: &str,
    destination: &Path,
) -> Result<()> {
    ensure!(valid_commit(trusted_commit), "invalid trusted commit");
    ensure!(
        !escapes(context) && normalize(context) == context,
        "devcontainer build.context contains an unsafe path"
    );
    let prefix = if context == "." {
        String::new()
    } else {
        format!("{context}/")
    };
    let listed = git(
        repository,
        &["ls-tree", "-r", "-z", trusted_commit, "--", context],
        16 * 1024 * 1024,
    )?;
    let listed = String::from_utf8(listed).context("git listed a non-UTF-8 path")?;
    let mut total = 0usize;
    for entry in listed.split('\0').filter(|entry| !entry.is_empty()) {
        let (mode, oid, path) = tree_entry(entry)
            .filter(|(mode, _, _)| matches!(*mode, "100644" | "100755" | "120000"))
            .ok_or_else(|| {
                anyhow!("devcontainer build.context contains an unsupported git entry")
            })?;
        let Some(relative) = path.strip_prefix(&prefix) else {
            continue;
        };
        ensure!(
            !relative.is_empty()
                && !relative.starts_with('/')
                && relative
                    .split('/')
                    .all(|part| !part.is_empty() && part != ".." && part != "."),
            "devcontainer build.context contains an unsafe path"
        );
        ensure!(
            mode != "120000",
            "devcontainer build.context contains symlink {path}"
        );
        let bytes = git(repository, &["cat-file", "blob", oid], 32 * 1024 * 1024)?;
        total += bytes.len();
        ensure!(
            total <= CONTEXT_LIMIT,
            "devcontainer build.context exceeds 512 MiB"
        );
        let target = destination.join(relative);
        if let Some(parent) = target.parent() {
            DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(parent)?;
        }
        // Parent directories come only from validated components; refuse to follow a link.
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(if mode == "100755" { 0o700 } else { 0o600 })
            .custom_flags(libc::O_NOFOLLOW)
            .open(&target)
            .with_context(|| format!("write build context file {relative}"))?;
        file.write_all(&bytes)?;
    }
    Ok(())
}

/// Splits Dockerfile text into logical lines with line continuations joined.
fn logical_lines(source: &str) -> Vec<String> {
    let joined = source
        .replace("\\\r\n", " ")
        .replace("\\\r", " ")
        .replace("\\\n", " ");
    joined
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .split('\n')
        .map(str::to_owned)
        .collect()
}

fn instruction(line: &str) -> Option<String> {
    let word: String = line.chars().take_while(char::is_ascii_alphabetic).collect();
    let rest = &line[word.len()..];
    (!word.is_empty() && (rest.is_empty() || rest.starts_with(char::is_whitespace)))
        .then(|| word.to_ascii_uppercase())
}

/// Applies declared build arguments to `ARG` instructions without consulting host variables.
pub fn apply_devcontainer_build_args(
    dockerfile: &str,
    args: Option<&BTreeMap<String, String>>,
) -> Result<String> {
    let Some(args) = args.filter(|args| !args.is_empty()) else {
        return Ok(dockerfile.to_owned());
    };
    let mut lines: Vec<String> = dockerfile.split('\n').map(str::to_owned).collect();
    for (name, value) in args {
        ensure!(
            !value.contains(['\r', '\n', '\0']),
            "devcontainer property build.args.{name} cannot contain a newline"
        );
        let mut found = false;
        for line in &mut lines {
            let indent = line.len() - line.trim_start().len();
            let rest = &line[indent..];
            // Repository Dockerfiles may hold multibyte text; `get` refuses non-boundaries.
            if !rest
                .get(..3)
                .is_some_and(|word| word.eq_ignore_ascii_case("ARG"))
            {
                continue;
            }
            let after = &rest[3..];
            let spaces = after.len() - after.trim_start().len();
            if spaces == 0 {
                continue;
            }
            let declared = &after[spaces..];
            if !declared
                .get(..name.len())
                .is_some_and(|declared| declared.eq_ignore_ascii_case(name))
            {
                continue;
            }
            let tail = &declared[name.len()..];
            if !(tail.trim().is_empty() || tail.starts_with('=')) {
                continue;
            }
            let prefix_length = indent + 3 + spaces + name.len();
            *line = format!("{}={value}", &line[..prefix_length]);
            found = true;
        }
        ensure!(
            found,
            "devcontainer property build.args.{name} has no ARG in build.dockerfile"
        );
    }
    Ok(lines.join("\n"))
}

/// Restricts Dockerfiles to instructions sandbox providers translate without host file reads.
pub fn validated_devcontainer_dockerfile(
    content: &str,
    args: Option<&BTreeMap<String, String>>,
) -> Result<String> {
    let source = apply_devcontainer_build_args(content, args)?;
    ensure!(
        !source.chars().any(|character| {
            let code = character as u32;
            (code < 32 && code != 9 && code != 10 && code != 13)
                || code == 127
                || code == 133
                || code == 0x2028
                || code == 0x2029
        }),
        "devcontainer build.dockerfile contains a control character"
    );
    let mut seen_from = false;
    for raw in logical_lines(&source) {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(comment) = line.strip_prefix('#') {
            let directive = comment.trim_start().to_ascii_lowercase();
            let parser = ["syntax", "escape", "check"].iter().any(|name| {
                directive
                    .strip_prefix(name)
                    .is_some_and(|rest| rest.trim_start().starts_with('='))
            });
            ensure!(
                !parser,
                "devcontainer build.dockerfile cannot use parser directives"
            );
            continue;
        }
        let instruction = instruction(line)
            .ok_or_else(|| anyhow!("devcontainer build.dockerfile has an invalid instruction"))?;
        ensure!(
            DOCKERFILE_INSTRUCTIONS.contains(&instruction.as_str()),
            "devcontainer build.dockerfile cannot use {instruction}"
        );
        if instruction == "FROM" {
            ensure!(
                !seen_from,
                "devcontainer build.dockerfile cannot use multiple FROM stages"
            );
            seen_from = true;
        } else {
            ensure!(
                seen_from || instruction == "ARG",
                "devcontainer build.dockerfile needs FROM before {instruction}"
            );
        }
    }
    ensure!(seen_from, "devcontainer build.dockerfile needs FROM");
    Ok(source)
}

fn literal_user_part(part: &str) -> bool {
    let bytes = part.as_bytes();
    !bytes.is_empty()
        && (bytes[0].is_ascii_alphanumeric() || bytes[0] == b'_')
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(b))
}

/// The user that owns prepared directories: `remoteUser`, then `containerUser`, then the last
/// `USER` in `build.dockerfile`, which must be a literal name or `user:group`.
pub fn devcontainer_image_user(
    devcontainer: Option<&DevcontainerSubset>,
) -> Result<Option<String>> {
    let Some(devcontainer) = devcontainer else {
        return Ok(None);
    };
    let declared = devcontainer
        .remote_user
        .clone()
        .or_else(|| devcontainer.container_user.clone());
    let Some(content) = devcontainer
        .build
        .as_ref()
        .and_then(|build| build.dockerfile_content.as_deref())
    else {
        return Ok(declared);
    };
    let build = devcontainer.build.as_ref().expect("checked build");
    let source = validated_devcontainer_dockerfile(content, build.args.as_ref())?;
    let mut last = None;
    for line in logical_lines(&source) {
        let line = line.trim();
        if instruction(line).as_deref() != Some("USER") {
            continue;
        }
        let user = line[4..].trim();
        let mut parts = user.splitn(2, ':');
        let valid = parts.next().is_some_and(literal_user_part)
            && parts.next().is_none_or(literal_user_part);
        ensure!(
            valid,
            "devcontainer build.dockerfile USER must name a literal user or user:group"
        );
        last = Some(user.to_owned());
    }
    Ok(declared.or(last))
}

/// A registry image plus supported Dockerfile instructions applied as layers, for providers
/// that build from a base image rather than a local Docker context.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DevcontainerBase {
    pub image: String,
    pub commands: Vec<String>,
}

pub fn devcontainer_base(
    devcontainer: Option<&DevcontainerSubset>,
    fallback: &str,
) -> Result<DevcontainerBase> {
    if let Some(image) = devcontainer.and_then(|devcontainer| devcontainer.image.clone()) {
        return Ok(DevcontainerBase {
            image,
            commands: vec![],
        });
    }
    let Some(build) = devcontainer.and_then(|devcontainer| devcontainer.build.as_ref()) else {
        return Ok(DevcontainerBase {
            image: fallback.into(),
            commands: vec![],
        });
    };
    let content = build
        .dockerfile_content
        .as_deref()
        .context("devcontainer build.dockerfile content is missing")?;
    let source = validated_devcontainer_dockerfile(content, build.args.as_ref())?;
    let mut lines = logical_lines(&source)
        .into_iter()
        .map(|line| line.trim().to_owned())
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .collect::<std::collections::VecDeque<_>>();
    let mut args = BTreeMap::new();
    while lines
        .front()
        .is_some_and(|line| instruction(line).as_deref() == Some("ARG"))
    {
        let line = lines.pop_front().expect("checked line");
        let declaration = line[3..].trim();
        let (name, value) = declaration.split_once('=').unwrap_or((declaration, ""));
        ensure!(
            valid_env_name(name),
            "devcontainer build.dockerfile has an invalid ARG"
        );
        args.insert(name.to_owned(), value.to_owned());
    }
    let first = lines.pop_front().unwrap_or_default();
    let words: Vec<&str> = first.split_whitespace().collect();
    let reference = match words.as_slice() {
        [from, image] if from.eq_ignore_ascii_case("FROM") => *image,
        [from, image, alias, _]
            if from.eq_ignore_ascii_case("FROM") && alias.eq_ignore_ascii_case("AS") =>
        {
            *image
        }
        _ => bail!("devcontainer build.dockerfile needs a registry FROM as its first instruction"),
    };
    let image = substitute_arguments(reference, &args)?;
    let mut commands = Vec::new();
    for line in lines {
        match instruction(&line).as_deref() {
            Some("FROM") => {
                bail!("devcontainer build.dockerfile does not support multiple FROM stages")
            }
            Some(_) => commands.push(line),
            None => bail!("devcontainer build.dockerfile has an invalid instruction"),
        }
    }
    Ok(DevcontainerBase { image, commands })
}

/// Replaces `$NAME` and `${NAME}` in a FROM reference with declared, nonempty ARG values.
fn substitute_arguments(reference: &str, args: &BTreeMap<String, String>) -> Result<String> {
    let mut result = String::new();
    let mut rest = reference;
    while let Some(index) = rest.find('$') {
        result.push_str(&rest[..index]);
        let after = &rest[index + 1..];
        let braced = after.starts_with('{');
        let body = if braced { &after[1..] } else { after };
        let length = body
            .bytes()
            .position(|b| !(b.is_ascii_alphanumeric() || b == b'_'))
            .unwrap_or(body.len());
        let name = &body[..length];
        if !valid_env_name(name) {
            result.push('$');
            rest = after;
            continue;
        }
        let value = args
            .get(name)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                anyhow!("devcontainer build.dockerfile has an undefined FROM argument {name}")
            })?;
        result.push_str(value);
        let mut consumed = usize::from(braced) + length;
        if body[length..].starts_with('}') {
            consumed += 1;
        }
        rest = &after[consumed..];
    }
    result.push_str(rest);
    Ok(result)
}

/// Resolves `${workspaceFolder}` and `${containerEnv:NAME}` from repository values alone.
/// Host environment variables are never read.
pub fn resolved_devcontainer_env(
    devcontainer: Option<&DevcontainerSubset>,
    workspace_folder: &str,
) -> Result<BTreeMap<String, String>> {
    let Some(devcontainer) = devcontainer else {
        return Ok(BTreeMap::new());
    };
    let empty = BTreeMap::new();
    let container = devcontainer.container_env.as_ref().unwrap_or(&empty);
    let mut resolved = BTreeMap::new();
    let mut result = BTreeMap::new();
    for name in container.keys() {
        assert_env_name(name, "containerEnv")?;
        let value = resolve_container(
            name,
            container,
            workspace_folder,
            &mut resolved,
            &mut BTreeSet::new(),
        )?;
        result.insert(name.clone(), value);
    }
    for (name, value) in devcontainer.remote_env.as_ref().unwrap_or(&empty) {
        assert_env_name(name, "remoteEnv")?;
        let value = expand(
            value,
            &format!("remoteEnv.{name}"),
            container,
            workspace_folder,
            &mut resolved,
            &mut BTreeSet::new(),
        )?;
        result.insert(name.clone(), value);
    }
    Ok(result)
}

fn resolve_container(
    name: &str,
    container: &BTreeMap<String, String>,
    workspace_folder: &str,
    resolved: &mut BTreeMap<String, String>,
    visiting: &mut BTreeSet<String>,
) -> Result<String> {
    if let Some(value) = resolved.get(name) {
        return Ok(value.clone());
    }
    ensure!(
        visiting.insert(name.to_owned()),
        "devcontainer property containerEnv.{name} has a cycle"
    );
    let value = expand(
        &container[name],
        &format!("containerEnv.{name}"),
        container,
        workspace_folder,
        resolved,
        visiting,
    )?;
    visiting.remove(name);
    resolved.insert(name.to_owned(), value.clone());
    Ok(value)
}

fn expand(
    value: &str,
    property: &str,
    container: &BTreeMap<String, String>,
    workspace_folder: &str,
    resolved: &mut BTreeMap<String, String>,
    visiting: &mut BTreeSet<String>,
) -> Result<String> {
    let mut result = String::new();
    let mut rest = value;
    while let Some(start) = rest.find("${") {
        let Some(length) = rest[start + 2..].find('}') else {
            break;
        };
        result.push_str(&rest[..start]);
        if length == 0 {
            result.push_str("${}");
            rest = &rest[start + 3..];
            continue;
        }
        let reference = &rest[start + 2..start + 2 + length];
        if reference == "workspaceFolder" {
            result.push_str(workspace_folder);
        } else {
            let variable = reference
                .strip_prefix("containerEnv:")
                .filter(|name| valid_env_name(name) && container.contains_key(*name))
                .ok_or_else(|| {
                    anyhow!("devcontainer property {property} has unsupported reference ${{{reference}}}")
                })?;
            result.push_str(&resolve_container(
                variable,
                container,
                workspace_folder,
                resolved,
                visiting,
            )?);
        }
        rest = &rest[start + 3 + length..];
    }
    result.push_str(rest);
    Ok(result)
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r#"'"'"'"#))
}

/// The shell lines a sandbox runs during preparation: exported environment, then
/// `onCreateCommand`, `updateContentCommand`, and `postCreateCommand`. A warm preparation of
/// an existing environment runs only `updateContentCommand`.
pub fn devcontainer_commands(
    devcontainer: Option<&DevcontainerSubset>,
    warm: bool,
    workspace_folder: &str,
) -> Result<Vec<String>> {
    let Some(devcontainer) = devcontainer else {
        return Ok(vec![]);
    };
    let mut out: Vec<String> = resolved_devcontainer_env(Some(devcontainer), workspace_folder)?
        .into_iter()
        .map(|(name, value)| format!("export {name}={}", shell_quote(&value)))
        .collect();
    let mut add = |command: Option<&DevcontainerCommand>| {
        let entries: Vec<CommandEntry> = match command {
            None => vec![],
            Some(DevcontainerCommand::Shell(shell)) => vec![CommandEntry::Shell(shell.clone())],
            Some(DevcontainerCommand::Argv(argv)) => vec![CommandEntry::Argv(argv.clone())],
            Some(DevcontainerCommand::Named(named)) => named.values().cloned().collect(),
        };
        for entry in entries {
            out.push(match entry {
                CommandEntry::Shell(shell) => format!("sh -c {}", shell_quote(&shell)),
                CommandEntry::Argv(argv) => argv
                    .iter()
                    .map(|part| shell_quote(part))
                    .collect::<Vec<_>>()
                    .join(" "),
            });
        }
    };
    if !warm {
        add(devcontainer.on_create_command.as_ref());
    }
    add(devcontainer.update_content_command.as_ref());
    if !warm {
        add(devcontainer.post_create_command.as_ref());
    }
    Ok(out)
}
