//! supertag.yaml never takes a PostgreSQL password inside `database.url`; it names a secret in
//! `database.password` instead. CI's PostgreSQL server requires a password while the local test
//! cluster trusts its user, so tests that write the test URL into supertag.yaml move any password
//! out of it here.
#![allow(dead_code)]

use std::{fs, os::unix::fs::PermissionsExt, path::Path};

use anyhow::{Context, Result};
use serde_json::{Value, json};

/// `url` without its password, and the decoded password if it had one.
pub fn split(url: &str) -> Result<(String, Option<String>)> {
    let mut parsed = url::Url::parse(url).context("parse the PostgreSQL test URL")?;
    let Some(encoded) = parsed.password().map(str::to_owned) else {
        return Ok((url.to_owned(), None));
    };
    parsed
        .set_password(None)
        .map_err(|()| anyhow::anyhow!("PostgreSQL test URL cannot drop its password"))?;
    Ok((parsed.to_string(), Some(decode(&encoded)?)))
}

/// The control-plane service's `database` section and the document's top-level `secrets` for
/// `url`. A password moves to a private file secret named `database` in `directory`.
pub fn config(url: &str, directory: &Path) -> Result<(Value, Value)> {
    let (url, password) = split(url)?;
    let Some(password) = password else {
        return Ok((json!({ "url": url }), json!({})));
    };
    let file = directory.join("database-password");
    fs::write(&file, password)?;
    fs::set_permissions(&file, fs::Permissions::from_mode(0o600))?;
    Ok((
        json!({ "url": url, "password": "database" }),
        json!({ "database": { "file": file } }),
    ))
}

fn decode(encoded: &str) -> Result<String> {
    let bytes = encoded.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = encoded
                .get(index + 1..index + 3)
                .context("truncated percent escape in the PostgreSQL test password")?;
            decoded.push(u8::from_str_radix(hex, 16)?);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    Ok(String::from_utf8(decoded)?)
}
