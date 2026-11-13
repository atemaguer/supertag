//! A stdio MCP server the Worker Host launches for one Task Attempt.
//!
//! The process gets a minimal environment plus its catalog `env`, nothing else of the Worker
//! Host's; its stderr is discarded so server output cannot carry that environment into logs. It
//! runs in its own process group, which closing terminates: SIGTERM, then SIGKILL.

use std::{process::Stdio, time::Duration};

use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    time,
};

use super::{
    Failure,
    catalog::StdioServer,
    http::{PROTOCOL_VERSION, accepted_version, decode},
};

/// The only Worker Host variables a stdio server inherits, as in the TypeScript Worker.
const INHERITED: [&str; 11] = [
    "HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER", "LANG", "LC_ALL", "LC_CTYPE", "TZ",
    "TMPDIR",
];
const MESSAGE_BYTES: usize = 256 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const TERMINATE_GRACE: Duration = Duration::from_secs(2);

pub(super) struct Session {
    child: Option<Child>,
    /// The server's process ID, which is also its process group ID.
    pid: Option<libc::pid_t>,
    stdin: Option<ChildStdin>,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
    /// Set once the stream failed or a request went unanswered; nothing more is sent.
    broken: bool,
    pub(super) unconfirmed_call: bool,
}

/// The base environment every stdio server receives.
pub(super) fn base_environment() -> impl Iterator<Item = (&'static str, String)> {
    INHERITED.into_iter().filter_map(|key| {
        std::env::var(key)
            .ok()
            // Exported shell functions are never inherited.
            .filter(|value| !value.starts_with("()"))
            .map(|value| (key, value))
    })
}

impl Session {
    pub(super) fn start(server: &StdioServer) -> Result<Self, Failure> {
        let mut command = Command::new(&server.command[0]);
        command
            .args(&server.command[1..])
            .env_clear()
            .envs(base_environment())
            .envs(&server.env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .process_group(0)
            .kill_on_drop(true);
        if let Some(cwd) = &server.cwd {
            command.current_dir(cwd);
        }
        let mut child = command.spawn().map_err(|_| Failure::Unavailable)?;
        let pid = child.id().and_then(|pid| libc::pid_t::try_from(pid).ok());
        let stdin = child.stdin.take().ok_or(Failure::Unavailable)?;
        let stdout = child.stdout.take().ok_or(Failure::Unavailable)?;
        Ok(Self {
            child: Some(child),
            pid,
            stdin: Some(stdin),
            stdout: BufReader::new(stdout),
            next_id: 1,
            broken: false,
            unconfirmed_call: false,
        })
    }

    pub(super) async fn initialize(&mut self) -> Result<(), Failure> {
        let initialized = self
            .rpc(
                "initialize",
                json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": {"name":"supertag-worker-host", "version":env!("CARGO_PKG_VERSION")}
                }),
            )
            .await?;
        accepted_version(&initialized)?;
        if !initialized
            .get("capabilities")
            .and_then(|value| value.get("tools"))
            .is_some_and(Value::is_object)
        {
            return Err(Failure::InvalidResponse);
        }
        self.send(&json!({"jsonrpc":"2.0", "method":"notifications/initialized"}))
            .await
    }

    async fn send(&mut self, message: &Value) -> Result<(), Failure> {
        let stdin = self.stdin.as_mut().ok_or(Failure::Unavailable)?;
        let mut line = message.to_string();
        line.push('\n');
        let written = async {
            stdin.write_all(line.as_bytes()).await?;
            stdin.flush().await
        };
        match time::timeout(REQUEST_TIMEOUT, written).await {
            Ok(Ok(())) => Ok(()),
            _ => {
                self.broken = true;
                Err(Failure::Unavailable)
            }
        }
    }

    /// One newline-delimited message, bounded so a server cannot exhaust Worker memory.
    async fn read_message(&mut self) -> Result<Value, Failure> {
        let mut line = Vec::new();
        loop {
            let available = self
                .stdout
                .fill_buf()
                .await
                .map_err(|_| Failure::Unavailable)?;
            if available.is_empty() {
                return Err(Failure::Unavailable);
            }
            let end = available.iter().position(|byte| *byte == b'\n');
            let chunk = &available[..end.unwrap_or(available.len())];
            if line.len() + chunk.len() > MESSAGE_BYTES {
                return Err(Failure::ResponseTooLarge);
            }
            line.extend_from_slice(chunk);
            let consumed = end.map_or(chunk.len(), |end| end + 1);
            self.stdout.consume(consumed);
            if end.is_none() {
                continue;
            }
            if line.iter().all(u8::is_ascii_whitespace) {
                line.clear();
                continue;
            }
            return serde_json::from_slice(&line).map_err(|_| Failure::InvalidResponse);
        }
    }

    pub(super) async fn rpc(&mut self, method: &str, params: Value) -> Result<Value, Failure> {
        if self.broken {
            return Err(Failure::Unavailable);
        }
        let id = self.next_id;
        self.next_id = id.checked_add(1).ok_or(Failure::InvalidResponse)?;
        self.send(&json!({"jsonrpc":"2.0", "id":id, "method":method, "params":params}))
            .await?;
        let result = time::timeout(REQUEST_TIMEOUT, self.response(id)).await;
        // A malformed, closed, or silent stream cannot carry a later answer reliably, and an
        // unanswered request may still run: never send another on this stream.
        let result = result.unwrap_or(Err(Failure::Unavailable));
        if result.is_err() {
            self.broken = true;
        }
        result
    }

    async fn response(&mut self, id: u64) -> Result<Value, Failure> {
        loop {
            let message = self.read_message().await?;
            let bytes = serde_json::to_vec(&message).map_err(|_| Failure::InvalidResponse)?;
            if let (Some(request), Some(method)) = (
                message
                    .get("id")
                    .filter(|_| message.get("method").is_some()),
                message.get("method").and_then(Value::as_str),
            ) {
                // A server request. The Worker offers no client capabilities, so answer each
                // except ping with method-not-found.
                let reply = if method == "ping" {
                    json!({"jsonrpc":"2.0", "id":request, "result":{}})
                } else {
                    json!({"jsonrpc":"2.0", "id":request, "error":{"code":-32601, "message":"Method not found"}})
                };
                self.send(&reply).await?;
                continue;
            }
            if let Some(result) = decode(&bytes, id)? {
                return Ok(result);
            }
        }
    }

    /// Ends the server: closes its input, then signals its process group.
    pub(super) async fn close(&mut self) {
        self.broken = true;
        drop(self.stdin.take());
        let Some(mut child) = self.child.take() else {
            return;
        };
        let exited = matches!(
            time::timeout(Duration::from_millis(500), child.wait()).await,
            Ok(Ok(_))
        );
        if !exited {
            self.signal(libc::SIGTERM);
            if !matches!(
                time::timeout(TERMINATE_GRACE, child.wait()).await,
                Ok(Ok(_))
            ) {
                self.signal(libc::SIGKILL);
                let _ = child.wait().await;
            }
        }
        // Descendants that outlived the leader belong to the same group.
        self.signal(libc::SIGKILL);
        self.pid = None;
    }

    fn signal(&self, signal: libc::c_int) {
        if let Some(pid) = self.pid {
            // SAFETY: the group was created for this server by process_group(0).
            unsafe {
                libc::killpg(pid, signal);
            }
        }
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.signal(libc::SIGKILL);
    }
}

#[cfg(test)]
mod tests {
    use std::{collections::BTreeMap, path::PathBuf, time::Instant};

    use serde_json::{Value, json};

    use super::*;

    fn fixture() -> Option<(PathBuf, PathBuf)> {
        let node = std::env::var_os("SUPERTAG_RUST_TEST_NODE")?;
        let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(
            "../../../packages/runtime/harnesses/claude-code/fixtures/rust-mcp-stdio-provider.mjs",
        );
        Some((PathBuf::from(node), script))
    }

    fn server(journal: &std::path::Path, mode: &str) -> StdioServer {
        let (node, script) = fixture().expect("SUPERTAG_RUST_TEST_NODE");
        StdioServer {
            command: vec![
                node.display().to_string(),
                script.display().to_string(),
                journal.display().to_string(),
                mode.into(),
            ],
            env: BTreeMap::from([("CATALOG_TOKEN".into(), "stdio-secret-value-7f3a".into())]),
            cwd: None,
        }
    }

    fn launches(journal: &std::path::Path) -> Vec<Value> {
        let directory = journal.parent().unwrap();
        let prefix = format!("{}.", journal.file_name().unwrap().to_string_lossy());
        std::fs::read_dir(directory)
            .unwrap()
            .filter_map(|entry| {
                let name = entry.ok()?.file_name().to_string_lossy().into_owned();
                (name.starts_with(&prefix) && name.ends_with(".launch")).then(|| {
                    serde_json::from_slice(&std::fs::read(directory.join(name)).unwrap()).unwrap()
                })
            })
            .collect()
    }

    fn alive(pid: i64) -> bool {
        // SAFETY: signal 0 only checks for the process.
        unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
    }

    fn calls(journal: &std::path::Path) -> usize {
        std::fs::read_to_string(journal)
            .unwrap_or_default()
            .lines()
            .filter(|line| line.contains("\"tool\""))
            .count()
    }

    #[tokio::test]
    #[ignore = "requires SUPERTAG_RUST_TEST_NODE"]
    async fn launches_with_only_its_env_answers_server_requests_and_stops_on_close() {
        let directory = tempfile::tempdir().unwrap();
        let journal = directory.path().join("calls.jsonl");
        let mut session = Session::start(&server(&journal, "normal")).unwrap();
        session.initialize().await.unwrap();
        let tools = session.rpc("tools/list", json!({})).await.unwrap();
        assert_eq!(tools["tools"].as_array().unwrap().len(), 4);
        let result = session
            .rpc(
                "tools/call",
                json!({"name":"list_docs","arguments":{"owner":"acme","repo":"docs"}}),
            )
            .await
            .unwrap();
        assert_eq!(result["content"][0]["text"], "fixture release record");
        // The server's ping was answered while the call waited.
        let ping_file = directory.path().join("calls.jsonl.ping");
        for _ in 0..50 {
            if ping_file.exists() {
                break;
            }
            time::sleep(Duration::from_millis(20)).await;
        }
        let ping: Value = serde_json::from_slice(&std::fs::read(ping_file).unwrap()).unwrap();
        assert_eq!(
            ping,
            json!({"jsonrpc":"2.0","id":"server-ping","result":{}})
        );
        let [launch] = launches(&journal).try_into().unwrap();
        let environment = launch["env"].as_object().unwrap();
        assert_eq!(environment["CATALOG_TOKEN"], "stdio-secret-value-7f3a");
        // Nothing of the Worker Host's environment beyond the minimal default, such as the
        // test's own SUPERTAG_RUST_TEST_NODE, reaches the server.
        for key in environment.keys() {
            assert!(
                key == "CATALOG_TOKEN"
                    || INHERITED.contains(&key.as_str())
                    || key == "__CF_USER_TEXT_ENCODING",
                "unexpected variable {key}"
            );
        }
        let pid = launch["pid"].as_i64().unwrap();
        session.close().await;
        assert!(!alive(pid));
        assert!(
            std::fs::read_to_string(&journal)
                .unwrap()
                .contains("{\"closed\":true}")
        );
    }

    #[tokio::test]
    #[ignore = "requires SUPERTAG_RUST_TEST_NODE"]
    async fn times_out_a_hung_call_once_and_kills_a_server_that_ignores_sigterm() {
        let directory = tempfile::tempdir().unwrap();
        let journal = directory.path().join("calls.jsonl");
        let mut session = Session::start(&server(&journal, "hung")).unwrap();
        session.initialize().await.unwrap();
        let call = json!({"name":"list_docs","arguments":{"owner":"acme","repo":"docs"}});
        assert_eq!(
            session.rpc("tools/call", call.clone()).await,
            Err(Failure::Unavailable)
        );
        // The hung request may still run: nothing more is sent to this server.
        assert_eq!(
            session.rpc("tools/call", call).await,
            Err(Failure::Unavailable)
        );
        assert_eq!(calls(&journal), 1);
        let [launch] = launches(&journal).try_into().unwrap();
        let pid = launch["pid"].as_i64().unwrap();
        let started = Instant::now();
        session.close().await;
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(!alive(pid));
    }

    #[tokio::test]
    #[ignore = "requires SUPERTAG_RUST_TEST_NODE"]
    async fn fails_a_malformed_or_oversized_stream_without_waiting_for_the_timeout() {
        for (mode, failure) in [
            ("garbage", Failure::InvalidResponse),
            ("oversized", Failure::ResponseTooLarge),
        ] {
            let directory = tempfile::tempdir().unwrap();
            let journal = directory.path().join("calls.jsonl");
            let started = Instant::now();
            let mut session = Session::start(&server(&journal, mode)).unwrap();
            assert_eq!(session.initialize().await, Err(failure), "{mode}");
            assert!(started.elapsed() < Duration::from_secs(3), "{mode}");
            session.close().await;
        }
    }

    #[tokio::test]
    async fn reports_a_server_that_cannot_start() {
        let missing = StdioServer {
            command: vec!["/nonexistent/supertag-missing-mcp-server".into()],
            env: BTreeMap::new(),
            cwd: None,
        };
        assert!(matches!(
            Session::start(&missing),
            Err(Failure::Unavailable)
        ));
    }
}
