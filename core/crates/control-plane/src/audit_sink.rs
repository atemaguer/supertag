//! One more destination for committed audit entries besides the database: standard error, or an
//! owner-only JSON-lines file, as TypeScript's `logging.audit` sink. Each entry is one JSON object
//! on its own line with `"type": "supertag.audit"`. Entries are written after the change they
//! record commits, in the order this process settles them; the database stays the record that
//! `supertag audit` reads. A failed write is reported on standard error and never fails the call.

use std::{
    fs::OpenOptions,
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    sync::Mutex,
};

use sqlx::Row;

use crate::Store;

/// Where committed audit entries are also written.
#[derive(Debug)]
pub struct AuditSink {
    destination: Destination,
    /// Serializes writes so concurrent calls never interleave lines.
    lock: Mutex<()>,
}

#[derive(Debug)]
enum Destination {
    Stderr,
    File(PathBuf),
}

impl AuditSink {
    /// `stderr`, or an absolute file path that is created owner-only and appended to.
    pub fn parse(value: &str) -> anyhow::Result<Self> {
        let destination = if value == "stderr" {
            Destination::Stderr
        } else {
            let path = Path::new(value);
            anyhow::ensure!(
                path.is_absolute(),
                "the audit log must be stderr or an absolute file path"
            );
            Destination::File(path.to_owned())
        };
        let sink = Self {
            destination,
            lock: Mutex::new(()),
        };
        // Refuse an unwritable file at startup rather than on the first change.
        if let Destination::File(path) = &sink.destination {
            open(path).map_err(|error| {
                anyhow::anyhow!("could not open the audit log {}: {error}", path.display())
            })?;
        }
        Ok(sink)
    }

    fn write(&self, lines: &str) {
        let _guard = self
            .lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let result = match &self.destination {
            // terminal-safe: `escaped` writes every unsafe character as a JSON `\u` escape.
            Destination::Stderr => std::io::stderr().lock().write_all(lines.as_bytes()),
            Destination::File(path) => {
                open(path).and_then(|mut file| file.write_all(lines.as_bytes()))
            }
        };
        if let Err(error) = result {
            supertag_protocol::terminal_text::warn(&format!(
                "Could not write the audit event to {}: {error}",
                match &self.destination {
                    Destination::Stderr => "standard error".to_owned(),
                    Destination::File(path) => path.display().to_string(),
                }
            ));
        }
    }
}

/// A JSON line with every character that could drive a terminal written as a `\u` escape, as the
/// CLI writes JSON. serde_json already escapes C0 controls; outside strings a line is ASCII.
fn escaped(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    for c in line.chars() {
        if supertag_protocol::terminal_text::unsafe_char(c) {
            let mut units = [0; 2];
            for unit in c.encode_utf16(&mut units) {
                out.push_str(&format!("\\u{unit:04x}"));
            }
        } else {
            out.push(c);
        }
    }
    out
}

fn open(path: &Path) -> std::io::Result<std::fs::File> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
}

impl Store {
    /// Also writes every committed audit entry to `sink`.
    pub fn with_audit_sink(mut self, sink: AuditSink) -> Self {
        self.audit_sink = Some(std::sync::Arc::new(sink));
        self
    }

    /// Writes the committed entries of one call to the sink, if one is configured.
    pub(crate) async fn emit_audit_call(&self, call_id: &str) {
        let Some(sink) = self.audit_sink.clone() else {
            return;
        };
        let rows = sqlx::query("SELECT entry_id, at_ms, actor, action, target, outcome, code, method FROM supertag_v2_audit_entries WHERE call_id=$1 ORDER BY sequence, entry_id")
            .bind(call_id)
            .fetch_all(&self.pool)
            .await;
        let lines = rows.map_err(anyhow::Error::from).and_then(|rows| {
            rows.iter()
                .map(|row| {
                    let at_ms: i64 = row.try_get("at_ms")?;
                    let line = serde_json::to_string(&serde_json::json!({
                        "type": "supertag.audit",
                        "id": row.try_get::<String, _>("entry_id")?,
                        "at": chrono::DateTime::from_timestamp_millis(at_ms)
                            .map(|time| time.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
                        "actor": row.try_get::<String, _>("actor")?,
                        "action": row.try_get::<String, _>("action")?,
                        "target": row.try_get::<String, _>("target")?,
                        "outcome": if row.try_get::<i64, _>("outcome")? == 1 { "succeeded" } else { "failed" },
                        "code": row.try_get::<String, _>("code")?,
                        "method": row.try_get::<String, _>("method")?,
                    }))?;
                    Ok(escaped(&line) + "\n")
                })
                .collect::<anyhow::Result<String>>()
        });
        match lines {
            Ok(lines) if !lines.is_empty() => sink.write(&lines),
            Ok(_) => {}
            Err(error) => supertag_protocol::terminal_text::warn(&format!(
                "Could not read the audit entries to write to the audit log: {error}"
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::AuditSink;

    #[test]
    fn lines_escape_every_terminal_control() {
        let line =
            serde_json::to_string(&serde_json::json!({ "target": "Tag/\u{1b}[2J\u{9b}\u{202e}x" }))
                .unwrap();
        let escaped = super::escaped(&line);
        assert_eq!(escaped, r#"{"target":"Tag/\u001b[2J\u009b\u202ex"}"#);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&escaped).unwrap(),
            serde_json::from_str::<serde_json::Value>(&line).unwrap()
        );
    }

    #[test]
    fn accepts_stderr_or_an_absolute_owner_only_file() {
        assert!(AuditSink::parse("relative/audit.jsonl").is_err());
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("audit.jsonl");
        AuditSink::parse(path.to_str().unwrap()).unwrap();
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        AuditSink::parse("stderr").unwrap();
        assert!(
            AuditSink::parse(
                directory
                    .path()
                    .join("missing/audit.jsonl")
                    .to_str()
                    .unwrap()
            )
            .is_err()
        );
    }
}
