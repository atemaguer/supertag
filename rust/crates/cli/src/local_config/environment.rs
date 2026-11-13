//! Local configuration interpolation and credential sources, without process-global mutation.
use super::{MAX_BYTES, resolve_path, valid_environment};
use anyhow::{Context, Result, bail, ensure};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs::OpenOptions,
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::Path,
};

pub(super) struct Environment {
    pub values: BTreeMap<String, String>,
    pub loaded_file: bool,
}

pub(super) fn resolve(
    value: &mut Value,
    base: &Path,
    lookup: impl Fn(&str) -> Option<String>,
) -> Result<Environment> {
    let object = value.as_object_mut().context("local configuration must be a map")?;
    let declared = object.remove("env_file");
    let names = match declared {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::String(path)) => vec![path],
        Some(Value::Array(paths)) => paths
            .into_iter()
            .map(|path| path.as_str().map(str::to_owned).context("env_file must name paths"))
            .collect::<Result<Vec<_>>>()?,
        _ => bail!("env_file must be a path or list of paths"),
    };
    ensure!(names.len() <= 16, "configure at most 16 environment files");
    let paths = if names.is_empty() {
        let path = base.join(".env");
        match std::fs::symlink_metadata(&path) {
            Ok(_) => vec![path],
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => return Err(error).context("inspect default environment file"),
        }
    } else {
        names.into_iter().map(|path| resolve_path(base, Path::new(&path))).collect::<Result<Vec<_>>>()?
    };
    let loaded_file = !paths.is_empty();
    let mut values = BTreeMap::new();
    let mut remaining = MAX_BYTES;
    for path in paths {
        let file = OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(path).context("read environment file")?;
        let metadata = file.metadata()?;
        ensure!(metadata.is_file() && metadata.uid() == unsafe { libc::geteuid() }
            && metadata.mode() & 0o022 == 0,
            "environment files must be regular files owned by this user and not writable by others");
        let mut text = String::new();
        file.take(remaining as u64 + 1).read_to_string(&mut text).context("read environment file text")?;
        ensure!(text.len() <= remaining, "environment files exceed 1 MiB");
        remaining -= text.len();
        for raw in text.lines() {
            let line = raw.trim();
            if line.is_empty() || line.starts_with('#') { continue; }
            let line = line.strip_prefix("export").filter(|s| s.starts_with(char::is_whitespace)).map(str::trim_start).unwrap_or(line);
            let Some((name, raw)) = line.split_once('=') else { continue; };
            let name = name.trim();
            if !valid_environment(name) { continue; }
            let raw = raw.trim_start();
            let value = if raw.len() >= 2 && ((raw.starts_with('"') && raw.ends_with('"')) || (raw.starts_with('\'') && raw.ends_with('\''))) {
                &raw[1..raw.len()-1]
            } else {
                raw.char_indices().find_map(|(index, c)| (c == '#' && index > 0 && raw[..index].ends_with(char::is_whitespace)).then_some(&raw[..index])).unwrap_or(raw).trim_end()
            };
            ensure!(!value.contains('\0'), "environment file contains an invalid value");
            values.insert(name.to_owned(), value.to_owned());
            ensure!(values.len() <= 1024, "environment files contain too many variables");
        }
    }
    let mut remaining = MAX_BYTES;
    interpolate(value, &|name| lookup(name).or_else(|| values.get(name).cloned()), &mut remaining)?;
    Ok(Environment { values, loaded_file })
}

fn interpolate(value: &mut Value, lookup: &impl Fn(&str) -> Option<String>, remaining: &mut usize) -> Result<()> {
    match value {
        Value::String(text) => {
            *text = string(text, lookup, *remaining)?;
            *remaining = remaining.checked_sub(text.len()).context("resolved local configuration exceeds 1 MiB")?;
        }
        Value::Array(values) => for value in values { interpolate(value, lookup, remaining)?; },
        Value::Object(values) => for (key, value) in values { if !key.starts_with("x-") { interpolate(value, lookup, remaining)?; } },
        _ => {}
    }
    Ok(())
}

fn string(text: &str, lookup: &impl Fn(&str) -> Option<String>, limit: usize) -> Result<String> {
    let mut output = String::new();
    let mut rest = text;
    while let Some(index) = rest.find('$') {
        append(&mut output, &rest[..index], limit)?;
        rest = &rest[index+1..];
        if let Some(tail) = rest.strip_prefix('$') {
            append(&mut output, "$", limit)?;
            rest = tail;
            continue;
        }
        let (name, operator, argument) = if let Some(body) = rest.strip_prefix('{') {
            let close = body.find('}').context("unterminated environment interpolation")?;
            let expression = &body[..close];
            rest = &body[close+1..];
            let (name, operator, argument) = if let Some((name, default)) = expression.split_once(":-") {
                (name, ":-", default)
            } else if let Some((name, message)) = expression.split_once(":?") {
                (name, ":?", message)
            } else { (expression, "", "") };
            ensure!(valid_environment(name), "invalid environment interpolation");
            (name, operator, argument)
        } else {
            let length = rest.bytes().enumerate().take_while(|(i,b)| *b == b'_' || b.is_ascii_alphabetic() || (*i > 0 && b.is_ascii_digit())).count();
            if length == 0 { append(&mut output, "$", limit)?; continue; }
            let name = &rest[..length];
            rest = &rest[length..];
            ensure!(valid_environment(name), "invalid environment interpolation");
            (name, "", "")
        };
        let value = lookup(name);
        let present = value.as_deref().is_some_and(|v| !v.is_empty());
        match operator {
            ":-" if !present => append(&mut output, argument, limit)?,
            ":?" if !present => bail!("required environment variable {name} is unavailable"),
            _ => append(&mut output, &value.with_context(|| format!("environment variable {name} is unavailable"))?, limit)?,
        }
    }
    append(&mut output, rest, limit)?;
    Ok(output)
}

fn append(output: &mut String, value: &str, limit: usize) -> Result<()> {
    ensure!(value.len() <= limit.saturating_sub(output.len()), "resolved local configuration exceeds 1 MiB");
    output.push_str(value);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, os::unix::fs::{PermissionsExt, symlink}};

    #[test]
    fn interpolation_preserves_legacy_precedence_defaults_and_literal_values() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join(".env"), "A=one\nB='literal#hash'\nexport C=three # comment\nEMPTY=file\n").unwrap();
        let mut value = serde_json::json!({"value":"$A ${B} ${C} ${EMPTY:-default} $$A $5", "x-note":"${NOT_SET}"});
        let env = resolve(&mut value, temp.path(), |name| match name { "A" => Some("shell".into()), "EMPTY" => Some("".into()), _=>None }).unwrap();
        assert_eq!(value["value"], "shell literal#hash three default $A $5");
        assert_eq!(value["x-note"], "${NOT_SET}");
        assert_eq!(env.values["A"], "one");
        assert!(env.loaded_file);
        for input in ["${MISSING}", "${EMPTY:?never print this secret}", "${bad-value}", "${missing"] {
            let error = string(input, &|_|None, MAX_BYTES).unwrap_err().to_string();
            assert!(!error.contains("never print"));
        }
        assert!(string("$A$A", &|_|Some("oversized".into()), 12).is_err());
    }

    #[test]
    fn explicit_files_override_in_order_and_reject_unsafe_inputs() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join(".env"), "A=default").unwrap();
        fs::write(temp.path().join("first.env"), "A=first").unwrap();
        fs::write(temp.path().join("second.env"), "A=second").unwrap();
        let original = serde_json::json!({"env_file":["first.env","second.env"],"value":"$A"});
        let mut value = original.clone();
        resolve(&mut value, temp.path(), |_|None).unwrap();
        assert_eq!(value["value"], "second");
        fs::set_permissions(temp.path().join("second.env"), fs::Permissions::from_mode(0o666)).unwrap();
        assert!(resolve(&mut original.clone(), temp.path(), |_|None).is_err());
        fs::remove_file(temp.path().join("second.env")).unwrap();
        symlink("first.env", temp.path().join("second.env")).unwrap();
        assert!(resolve(&mut original.clone(), temp.path(), |_|None).is_err());
        fs::remove_file(temp.path().join("second.env")).unwrap();
        assert!(resolve(&mut original.clone(), temp.path(), |_|None).is_err());
        fs::write(temp.path().join("second.env"), vec![b'x'; MAX_BYTES+1]).unwrap();
        assert!(resolve(&mut original.clone(), temp.path(), |_|None).is_err());
    }
}
