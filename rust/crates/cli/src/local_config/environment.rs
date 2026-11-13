//! `env_file` loading, `${VAR}` interpolation and credential lookup for local configuration.
//!
//! Values stay in this process. The supervisor hands each child only the names its role needs,
//! so reading an `env_file` never widens what the Control Plane, Gateway or a Worker Host sees.
use super::{MAX_BYTES, resolve_path, valid_environment};
use anyhow::{Context, Result, bail, ensure};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    ffi::OsString,
    fs::OpenOptions,
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::Path,
};

const MAX_FILES: usize = 16;
const MAX_VARIABLES: usize = 1024;

/// Variables read from `env_file`. The process environment always wins over them.
#[derive(Clone, Default)]
pub struct Environment {
    file: BTreeMap<String, String>,
}

impl Environment {
    #[cfg(test)]
    pub(super) fn from_file(file: BTreeMap<String, String>) -> Self {
        Self { file }
    }

    /// A runtime variable: the process environment first, then `env_file`. Blank counts as unset.
    pub fn variable(&self, name: &str) -> Option<OsString> {
        self.lookup(name, std::env::var_os(name))
    }

    fn lookup(&self, name: &str, process: Option<OsString>) -> Option<OsString> {
        process
            .filter(|value| value.to_str().is_none_or(|value| !value.trim().is_empty()))
            .or_else(|| {
                self.file
                    .get(name)
                    .map(|value| value.trim())
                    .filter(|value| !value.is_empty())
                    .map(OsString::from)
            })
    }

    /// The trimmed, non-blank `env_file` value of a variable.
    pub fn file_value(&self, name: &str) -> Option<&str> {
        self.file
            .get(name)
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
    }

    /// The named variables that are available, for a child process allowlist.
    pub fn selected<'a>(
        &'a self,
        names: impl IntoIterator<Item = &'a str> + 'a,
    ) -> impl Iterator<Item = (&'a str, OsString)> + 'a {
        names
            .into_iter()
            .filter_map(|name| self.variable(name).map(|value| (name, value)))
    }
}

/// Read `env_file` (or the `.env` beside the configuration), then interpolate every string value
/// except under `x-` keys. Errors never include a resolved value.
pub(super) fn resolve(
    value: &mut Value,
    base: &Path,
    lookup: impl Fn(&str) -> Option<String>,
) -> Result<Environment> {
    let object = value
        .as_object_mut()
        .context("local configuration must be a map")?;
    let names = match object.remove("env_file") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::String(path)) => vec![path],
        Some(Value::Array(paths)) => paths
            .into_iter()
            .map(|path| match path {
                Value::String(path) => Ok(path),
                _ => bail!("env_file must be a path or a list of paths"),
            })
            .collect::<Result<Vec<_>>>()?,
        _ => bail!("env_file must be a path or a list of paths"),
    };
    ensure!(
        names.len() <= MAX_FILES,
        "configure at most {MAX_FILES} environment files"
    );
    let paths = if names.is_empty() {
        let path = base.join(".env");
        match std::fs::symlink_metadata(&path) {
            // A directory named .env is not an environment file; a symlink is rejected below.
            Ok(metadata) if metadata.is_dir() => Vec::new(),
            Ok(_) => vec![path],
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => return Err(error).context("inspect default environment file"),
        }
    } else {
        names
            .into_iter()
            .map(|path| resolve_path(base, Path::new(&path)))
            .collect::<Result<Vec<_>>>()?
    };
    let mut file = BTreeMap::new();
    let mut remaining = MAX_BYTES;
    for path in paths {
        let text = read_file(&path, remaining)
            .with_context(|| format!("env_file: cannot read {}", path.display()))?;
        remaining -= text.len();
        parse_into(&text, &mut file)?;
    }
    let mut remaining = MAX_BYTES;
    interpolate(
        value,
        &|name| lookup(name).or_else(|| file.get(name).cloned()),
        &mut remaining,
    )?;
    Ok(Environment { file })
}

fn read_file(path: &Path, limit: usize) -> Result<String> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file()
            // SAFETY: geteuid returns the calling process's effective user ID.
            && metadata.uid() == unsafe { libc::geteuid() }
            && metadata.mode() & 0o022 == 0,
        "environment files must be regular files owned by this user and not writable by others"
    );
    let mut text = String::new();
    file.take(limit as u64 + 1)
        .read_to_string(&mut text)
        .context("environment files must be UTF-8 text")?;
    ensure!(text.len() <= limit, "environment files exceed 1 MiB");
    Ok(text)
}

/// `KEY=value` lines. `#` comments, `export `, and surrounding quotes are allowed; later wins.
fn parse_into(text: &str, values: &mut BTreeMap<String, String>) -> Result<()> {
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line
            .strip_prefix("export")
            .filter(|rest| rest.starts_with(char::is_whitespace))
            .map(str::trim_start)
            .unwrap_or(line);
        let Some((name, value)) = line.split_once('=') else {
            continue;
        };
        let name = name.trim_end();
        if !valid_environment(name) {
            continue;
        }
        let value = value.trim_start();
        let quoted = value.len() >= 2
            && ((value.starts_with('"') && value.ends_with('"'))
                || (value.starts_with('\'') && value.ends_with('\'')));
        let value = if quoted {
            &value[1..value.len() - 1]
        } else {
            value
                .char_indices()
                .find(|&(index, c)| {
                    c == '#' && index > 0 && value[..index].ends_with(char::is_whitespace)
                })
                .map_or(value, |(index, _)| value[..index].trim_end())
        };
        ensure!(
            !value.contains('\0'),
            "environment file contains an invalid value"
        );
        values.insert(name.to_owned(), value.to_owned());
        ensure!(
            values.len() <= MAX_VARIABLES,
            "environment files contain too many variables"
        );
    }
    Ok(())
}

fn interpolate(
    value: &mut Value,
    lookup: &impl Fn(&str) -> Option<String>,
    remaining: &mut usize,
) -> Result<()> {
    match value {
        Value::String(text) => {
            *text = string(text, lookup, *remaining)?;
            *remaining = remaining
                .checked_sub(text.len())
                .context("resolved local configuration exceeds 1 MiB")?;
        }
        Value::Array(values) => {
            for value in values {
                interpolate(value, lookup, remaining)?;
            }
        }
        Value::Object(values) => {
            for (key, value) in values {
                if !key.starts_with("x-") {
                    interpolate(value, lookup, remaining)?;
                }
            }
        }
        _ => {}
    }
    Ok(())
}

fn name_length(text: &str) -> usize {
    text.bytes()
        .enumerate()
        .take_while(|&(index, byte)| {
            byte == b'_' || byte.is_ascii_alphabetic() || (index > 0 && byte.is_ascii_digit())
        })
        .count()
}

/// `${VAR}`, `${VAR:-default}`, `${VAR:?message}`, `$VAR` and `$$`.
fn string(text: &str, lookup: &impl Fn(&str) -> Option<String>, limit: usize) -> Result<String> {
    const FORMS: &str = "use ${NAME}, ${NAME:-default}, ${NAME:?message}, or $$ for a literal $";
    let mut output = String::new();
    let mut rest = text;
    while let Some(index) = rest.find('$') {
        append(&mut output, &rest[..index], limit)?;
        rest = &rest[index + 1..];
        if let Some(tail) = rest.strip_prefix('$') {
            append(&mut output, "$", limit)?;
            rest = tail;
            continue;
        }
        let (name, operator, argument) = if let Some(body) = rest.strip_prefix('{') {
            let close = body
                .find('}')
                .with_context(|| format!("unterminated ${{ in a configuration value; {FORMS}"))?;
            let expression = &body[..close];
            rest = &body[close + 1..];
            let (name, tail) = expression.split_at(name_length(expression));
            let (operator, argument) = if tail.is_empty() {
                ("", "")
            } else if let Some(argument) = tail.strip_prefix(":-") {
                (":-", argument)
            } else if let Some(argument) = tail.strip_prefix(":?") {
                (":?", argument)
            } else {
                bail!("invalid environment interpolation; {FORMS}");
            };
            ensure!(
                valid_environment(name),
                "invalid environment interpolation; {FORMS}"
            );
            (name, operator, argument)
        } else {
            let length = name_length(rest);
            if length == 0 {
                append(&mut output, "$", limit)?;
                continue;
            }
            let name = &rest[..length];
            rest = &rest[length..];
            ensure!(
                valid_environment(name),
                "invalid environment interpolation; {FORMS}"
            );
            (name, "", "")
        };
        let value = lookup(name);
        let present = value.as_deref().is_some_and(|value| !value.is_empty());
        match (operator, value) {
            (":-", _) if !present => append(&mut output, argument, limit)?,
            (":?", _) if !present => {
                let message = if argument.is_empty() {
                    format!("set {name}")
                } else {
                    argument.to_owned()
                };
                bail!("${{{name}}} is required: {message}");
            }
            (_, Some(value)) => append(&mut output, &value, limit)?,
            (_, None) => bail!(
                "${{{name}}} is not set. Set it in the environment or an env_file, or give a default with ${{{name}:-VALUE}}"
            ),
        }
    }
    append(&mut output, rest, limit)?;
    Ok(output)
}

fn append(output: &mut String, value: &str, limit: usize) -> Result<()> {
    ensure!(
        value.len() <= limit.saturating_sub(output.len()),
        "resolved local configuration exceeds 1 MiB"
    );
    output.push_str(value);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        os::unix::fs::{PermissionsExt, symlink},
    };

    fn none(_: &str) -> Option<String> {
        None
    }

    #[test]
    fn interpolation_follows_documented_precedence_defaults_and_literals() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(
            temp.path().join(".env"),
            "A=one\nB='literal#hash'\nexport C=three # comment\nEMPTY=file\r\nD = \"quoted value\"\n# skipped\n9BAD=x\nnot a line\n",
        )
        .unwrap();
        let mut value = serde_json::json!({
            "value": "$A ${B} ${C} ${EMPTY:-default} $$A $5 ${D} cost$",
            "list": ["${C}", {"nested": "${A:-unused}"}],
            "x-note": "${NOT_SET}",
            "number": 3,
        });
        let env = resolve(&mut value, temp.path(), |name| match name {
            "A" => Some("shell".into()),
            "EMPTY" => Some(String::new()),
            _ => None,
        })
        .unwrap();
        assert_eq!(
            value["value"],
            "shell literal#hash three default $A $5 quoted value cost$"
        );
        assert_eq!(
            value["list"],
            serde_json::json!(["three", {"nested": "shell"}])
        );
        assert_eq!(value["x-note"], "${NOT_SET}");
        assert_eq!(value["number"], 3);
        assert_eq!(env.file["A"], "one");
        assert_eq!(env.file["EMPTY"], "file");
        assert!(!env.file.contains_key("9BAD"));
        // A set-but-empty process value wins over env_file for interpolation.
        let mut empty = serde_json::json!({"value": "[${EMPTY}]"});
        resolve(&mut empty, temp.path(), |name| {
            (name == "EMPTY").then(String::new)
        })
        .unwrap();
        assert_eq!(empty["value"], "[]");
    }

    #[test]
    fn interpolation_errors_name_the_variable_but_never_a_value() {
        let secret = |_: &str| Some("never-print-this-value".to_owned());
        assert!(string("${A:?message}", &secret, MAX_BYTES).is_ok());
        let missing = string("x ${MISSING} y", &none, MAX_BYTES).unwrap_err();
        assert!(missing.to_string().contains("${MISSING} is not set"));
        let required = string("${TOKEN:?set TOKEN to the join key}", &none, MAX_BYTES)
            .unwrap_err()
            .to_string();
        assert_eq!(required, "${TOKEN} is required: set TOKEN to the join key");
        assert_eq!(
            string("${TOKEN:?}", &none, MAX_BYTES)
                .unwrap_err()
                .to_string(),
            "${TOKEN} is required: set TOKEN"
        );
        // The message may contain an operator; the name stops at the first non-name byte.
        assert!(
            string("${A:?use :- carefully}", &none, MAX_BYTES)
                .unwrap_err()
                .to_string()
                .ends_with("use :- carefully")
        );
        assert_eq!(string("${A:-x:?y}", &none, MAX_BYTES).unwrap(), "x:?y");
        for input in ["${bad-value}", "${missing", "${}", "${1A}", "${A?x}"] {
            let error = string(input, &secret, MAX_BYTES).unwrap_err().to_string();
            assert!(!error.contains("never-print"), "{error}");
            assert!(!error.contains("bad-value"), "{error}");
        }
        assert!(string("$A$A", &|_| Some("oversized".into()), 12).is_err());
    }

    #[test]
    fn explicit_files_override_in_order_and_reject_unsafe_inputs() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join(".env"), "A=default").unwrap();
        fs::write(temp.path().join("first.env"), "A=first\nB=first").unwrap();
        fs::write(temp.path().join("second.env"), "A=second").unwrap();
        let original = serde_json::json!({"env_file":["first.env","second.env"],"value":"$A $B"});
        let mut value = original.clone();
        let env = resolve(&mut value, temp.path(), none).unwrap();
        assert_eq!(value["value"], "second first");
        assert!(value.get("env_file").is_none());
        assert_eq!(env.file.len(), 2);
        let mut single = serde_json::json!({"env_file":"first.env","value":"$A"});
        resolve(&mut single, temp.path(), none).unwrap();
        assert_eq!(single["value"], "first");
        for invalid in [serde_json::json!(3), serde_json::json!(["first.env", 3])] {
            assert!(
                resolve(
                    &mut serde_json::json!({ "env_file": invalid }),
                    temp.path(),
                    none
                )
                .is_err()
            );
        }
        let many = (0..=MAX_FILES).map(|_| "first.env").collect::<Vec<_>>();
        assert!(
            resolve(
                &mut serde_json::json!({ "env_file": many }),
                temp.path(),
                none
            )
            .is_err()
        );
        fs::set_permissions(
            temp.path().join("second.env"),
            fs::Permissions::from_mode(0o666),
        )
        .unwrap();
        assert!(resolve(&mut original.clone(), temp.path(), none).is_err());
        fs::remove_file(temp.path().join("second.env")).unwrap();
        symlink("first.env", temp.path().join("second.env")).unwrap();
        assert!(resolve(&mut original.clone(), temp.path(), none).is_err());
        fs::remove_file(temp.path().join("second.env")).unwrap();
        let missing = resolve(&mut original.clone(), temp.path(), none)
            .err()
            .unwrap();
        assert!(format!("{missing:#}").contains("second.env"));
        fs::write(temp.path().join("second.env"), vec![b'x'; MAX_BYTES + 1]).unwrap();
        assert!(resolve(&mut original.clone(), temp.path(), none).is_err());
    }

    #[test]
    fn default_env_file_is_optional_and_never_followed_through_a_symlink() {
        let temp = tempfile::tempdir().unwrap();
        let env = resolve(&mut serde_json::json!({}), temp.path(), none).unwrap();
        assert!(env.file.is_empty());
        fs::create_dir(temp.path().join(".env")).unwrap();
        assert!(resolve(&mut serde_json::json!({}), temp.path(), none).is_ok());
        fs::remove_dir(temp.path().join(".env")).unwrap();
        fs::write(temp.path().join("real"), "A=1").unwrap();
        symlink("real", temp.path().join(".env")).unwrap();
        assert!(resolve(&mut serde_json::json!({}), temp.path(), none).is_err());
    }

    #[test]
    fn runtime_variables_prefer_a_nonblank_process_value_then_env_file() {
        let env = Environment::from_file(BTreeMap::from([
            ("KEY".to_owned(), "  from-file  ".to_owned()),
            ("BLANK".to_owned(), "   ".to_owned()),
        ]));
        assert_eq!(
            env.lookup("KEY", Some("from-shell".into())),
            Some("from-shell".into())
        );
        assert_eq!(
            env.lookup("KEY", Some(" ".into())),
            Some("from-file".into())
        );
        assert_eq!(env.lookup("KEY", None), Some("from-file".into()));
        assert_eq!(env.lookup("BLANK", None), None);
        assert_eq!(env.lookup("ABSENT", None), None);
    }
}
