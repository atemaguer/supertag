//! Workspace MCP servers and OAuth MCP logins through a real Control Plane, Gateway, Worker
//! Host, and Claude Code adapter, on SQLite and PostgreSQL.
//!
//! TypeScript parity: `tests/workspace-mcp-snapshot.test.ts` (the base commit's server runs from
//! a Worker-owned snapshot after the harness rewrote the worktree) and
//! `tests/mcp-oauth-login.test.ts` (refresh on a refused token, `mcp-login` hold and Inbox item).
use super::*;
use std::{io::Write, os::unix::fs::OpenOptionsExt};

fn private_file(path: &Path, contents: &[u8]) -> Result<()> {
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?
        .write_all(contents)?;
    Ok(())
}

async fn grant(
    services: &LanguageServices,
    directory: &Path,
    tag: &str,
    actions: &[&str],
) -> Result<()> {
    let permissions = directory.join(format!("{tag}-grants.json"));
    std::fs::write(
        &permissions,
        serde_json::json!({
            "set_id": format!("{tag}-grants"), "name": format!("{tag}-grants"),
            "permissions": actions
                .iter()
                .map(|action| serde_json::json!({"target":"mcp","action":action}))
                .collect::<Vec<_>>(),
        })
        .to_string(),
    )?;
    let role = directory.join(format!("{tag}-role.json"));
    std::fs::write(
        &role,
        serde_json::json!({
            "role_id": format!("{tag}-role"), "name": format!("{tag}-role"),
            "purpose": "Use MCP tools", "permission_set_ids": [format!("{tag}-grants")]
        })
        .to_string(),
    )?;
    services
        .operator(&[
            "policy",
            "put",
            "permission-set",
            permissions.to_str().context("permission set path")?,
        ])
        .await?;
    services
        .operator(&["policy", "put", "role", role.to_str().context("role path")?])
        .await?;
    services
        .operator(&["policy", "assign", &format!("{tag}-role"), tag])
        .await?;
    Ok(())
}

database_tests! {
    #[tokio::test]
    #[ignore = "requires SUPERTAG_RUST_TEST_NODE and a built Claude Code language adapter"]
    workspace_mcp_runs_the_base_commit_server_from_its_snapshot;
    #[tokio::test]
    #[ignore = "requires SUPERTAG_RUST_TEST_NODE and a built Claude Code language adapter"]
    oauth_mcp_refreshes_withholds_and_holds_tasks_after_a_lapse;
}

async fn workspace_mcp_runs_the_base_commit_server_from_its_snapshot(
    database: String,
) -> Result<()> {
    let directory = tempfile::tempdir()?;
    exercise_workspace_mcp(directory.path(), &database).await
}

/// The repository's `.mcp.json` and server are committed; the harness rewrites both in its
/// worktree before it calls the tool. The Worker Host still runs the committed server, from a
/// snapshot of the base commit outside the worktree, with only the `SUPERTAG_MCP_*` value its
/// `env` references, and removes the snapshot when the Attempt ends.
async fn exercise_workspace_mcp(directory: &Path, database: &str) -> Result<()> {
    let node =
        std::env::var_os("SUPERTAG_RUST_TEST_NODE").context("Node test executable required")?;
    let node = Path::new(&node).to_str().context("Node path")?.to_owned();
    let entry = repo_path("packages/runtime/harnesses/claude-code/dist/rust-adapter/entry.js")?;
    let native = claude_fixture(directory)?;
    let source = directory.join("source");
    std::fs::create_dir(&source)?;
    let git = |args: &[&str]| {
        let mut command = Command::new("git");
        command
            .current_dir(&source)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .arg("-c")
            .arg("user.name=SuperTag Fixture")
            .arg("-c")
            .arg("user.email=fixture@example.invalid")
            .args(args);
        command
    };
    success(git(&["init", "--quiet"])).await?;
    std::fs::copy(
        repo_path("packages/runtime/harnesses/claude-code/fixtures/rust-mcp-workspace-server.mjs")?,
        source.join("server.mjs"),
    )?;
    std::fs::write(
        source.join(".mcp.json"),
        serde_json::json!({"mcpServers":{"local":{
            "command": node, "args":["server.mjs"],
            "env":{"FAKE_MCP_LOG":"${SUPERTAG_MCP_LOG}"}
        }}})
        .to_string(),
    )?;
    success(git(&["add", "server.mjs", ".mcp.json"])).await?;
    success(git(&[
        "commit",
        "--quiet",
        "-m",
        "Add a repository MCP server",
    ]))
    .await?;
    let base = String::from_utf8(success(git(&["rev-parse", "HEAD"])).await?)?;
    let log = directory.join("workspace-mcp.jsonl");
    std::fs::write(&log, "")?;
    let services = LanguageServices::start(directory, database).await?;
    services
        .operator(&[
            "tag",
            "put",
            "repository",
            "--harness",
            "claude-code",
            "--instructions",
            "Use the repository's tool.",
            "--allow",
            "files:read",
            "--allow",
            "files:write",
            "--workspace-id",
            "app",
            "--workspace-base",
            base.trim(),
            "--workspace-mcp",
            "local",
        ])
        .await?;
    grant(&services, directory, "repository", &["local/read_env"]).await?;
    let task = services
        .operator(&[
            "task",
            "submit",
            "--tag",
            "repository",
            "--session",
            "workspace",
            "workspace-mcp",
        ])
        .await?;
    assert_eq!(
        task["workspace"]["mcp_servers"],
        serde_json::json!(["local"])
    );
    let task_id = task["task_id"].as_str().context("Task ID")?;
    let state = directory.join("host");
    let mut host = services.worker("claude-code", &state, Path::new(&node), &entry);
    host.arg("--claude-path")
        .arg(&native)
        .arg("--workspace-id")
        .arg("app")
        .arg("--workspace-source")
        .arg(&source)
        .env("ANTHROPIC_API_KEY", "fixture-workspace-provider-key")
        .env("SUPERTAG_MCP_LOG", &log)
        .env("UNREFERENCED_HOST_SECRET", "never-reaches-the-server");
    success(host).await?;
    let completed = services.operator(&["get", "task", task_id]).await?;
    assert_eq!(completed["state"], "TASK_STATE_SUCCEEDED", "{completed}");
    let served = completed["result"]
        .as_str()
        .and_then(|result| result.strip_prefix("workspace MCP served from "))
        .context("Workspace MCP result")?;
    // The snapshot is the Worker Host's own, outside the Task worktree, and is gone now.
    let state = state.canonicalize()?;
    let served = Path::new(served);
    assert!(served.starts_with(&state), "{}", served.display());
    assert!(
        !served
            .components()
            .any(|part| part.as_os_str() == "checkouts"),
        "{}",
        served.display()
    );
    assert!(!served.exists(), "the MCP snapshot outlived its Attempt");
    let entries = std::fs::read_to_string(&log)?
        .lines()
        .map(serde_json::from_str)
        .collect::<Result<Vec<Value>, _>>()?;
    let starts: Vec<_> = entries
        .iter()
        .filter(|entry| entry.get("started").is_some())
        .collect();
    // The committed server, not the rewritten one, started for the Attempt and served its call.
    assert_eq!(starts.len(), 1, "{entries:?}");
    assert_eq!(starts[0]["cwd"], served.display().to_string());
    assert_eq!(starts[0]["args"], serde_json::json!([]));
    assert!(entries.iter().any(|entry| entry["tool"] == "read_env"));
    assert!(entries.iter().any(|entry| entry.get("closed").is_some()));
    services.stop().await
}

async fn oauth_mcp_refreshes_withholds_and_holds_tasks_after_a_lapse(
    database: String,
) -> Result<()> {
    let directory = tempfile::tempdir()?;
    exercise_oauth_mcp(directory.path(), &database).await
}

fn write_login(store: &Path, login: &Value) -> Result<()> {
    std::fs::create_dir_all(store)?;
    std::fs::set_permissions(store, std::fs::Permissions::from_mode(0o700))?;
    let path = store.join("catalog.json");
    let _ = std::fs::remove_file(&path);
    private_file(&path, login.to_string().as_bytes())
}

/// An OAuth server refuses the stored access token: the Worker Host refreshes once, resends,
/// and withholds a result that echoes the login's refresh token. When the authorization server
/// later refuses the refresh, the login lapses: the Attempt fails naming the login command,
/// the host stops offering the server, an Objective Task that needs it waits with an
/// `mcp_login` Inbox item, and a new login releases it.
async fn exercise_oauth_mcp(directory: &Path, database: &str) -> Result<()> {
    let node =
        std::env::var_os("SUPERTAG_RUST_TEST_NODE").context("Node test executable required")?;
    let entry = repo_path("packages/runtime/harnesses/claude-code/dist/rust-adapter/entry.js")?;
    let native = claude_fixture(directory)?;
    let journal = directory.join("oauth-provider.jsonl");
    let mut provider = Command::new(&node);
    provider
        .arg(repo_path(
            "packages/runtime/harnesses/claude-code/fixtures/rust-mcp-oauth-provider.mjs",
        )?)
        .arg(&journal)
        .env_clear()
        .stdin(Stdio::null())
        .kill_on_drop(true);
    let (mut provider, endpoint) = service(provider).await?;
    let url = format!("{endpoint}/mcp");
    let catalog = directory.join("mcp-catalog.json");
    let mapping = serde_json::json!([{
        "prefix":"repository:", "separator":"/",
        "components":[{"arguments":["owner","org"]},{"arguments":["repo"]}]
    }]);
    private_file(
        &catalog,
        serde_json::json!({"version":1,"servers":[{
            "name":"catalog","url":url,"oauth":true,
            "resources":{"tools":{"list_docs":mapping,"publish":mapping}}
        }]})
        .to_string()
        .as_bytes(),
    )?;
    let supertag_state = directory.join("supertag-state");
    let logins = supertag_state.join("mcp-logins");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_millis() as i64;
    let login = |refresh: &str, access: &str, expires: i64| {
        serde_json::json!({
            "url": url, "tokenEndpoint": format!("{endpoint}/token"),
            "clientId": "fixture-client", "clientSecret": "fixture-client-secret-value",
            "refreshToken": refresh, "accessToken": access, "accessTokenExpiresAt": expires,
            "loggedInAt": now,
        })
    };
    // The stored access token is current by its expiry, but the server no longer accepts it.
    write_login(
        &logins,
        &login("refresh-1", "stale-access", now + 3_600_000),
    )?;
    let services = LanguageServices::start(directory, database).await?;
    services
        .operator(&[
            "tag",
            "put",
            "mcp-reader",
            "--harness",
            "claude-code",
            "--instructions",
            "Read the scoped catalog.",
        ])
        .await?;
    let permissions = directory.join("mcp-grants.json");
    std::fs::write(&permissions, serde_json::json!({
        "set_id":"mcp-grants", "name":"mcp-grants", "approvers":["operator:local"],
        "permissions":[
            {"target":"mcp","action":"catalog/list_*","resource":"repository:acme/docs"},
            {"target":"mcp","action":"catalog/publish"},
            {"target":"mcp","action":"catalog/publish","resource":"repository:acme/docs","approval_required":true}
        ]
    }).to_string())?;
    let role = directory.join("mcp-role.json");
    std::fs::write(&role, serde_json::json!({
        "role_id":"mcp-role", "name":"mcp-role", "purpose":"Read the catalog", "permission_set_ids":["mcp-grants"]
    }).to_string())?;
    services
        .operator(&[
            "policy",
            "put",
            "permission-set",
            permissions.to_str().context("permission set path")?,
        ])
        .await?;
    services
        .operator(&["policy", "put", "role", role.to_str().context("role path")?])
        .await?;
    services
        .operator(&["policy", "assign", "mcp-role", "mcp-reader"])
        .await?;
    let configure = |host: &mut Command| {
        host.arg("--claude-path")
            .arg(&native)
            .arg("--mcp-catalog")
            .arg(&catalog)
            .env("SUPERTAG_STATE_DIR", &supertag_state)
            .env("ANTHROPIC_API_KEY", "fixture-provider-key");
    };
    let task = services
        .operator(&[
            "task",
            "submit",
            "--tag",
            "mcp-reader",
            "--session",
            "oauth",
            "scoped-http-mcp",
        ])
        .await?;
    let task_id = task["task_id"].as_str().context("Task ID")?;
    let mut host = services.worker(
        "claude-code",
        &directory.join("oauth-host"),
        Path::new(&node),
        &entry,
    );
    configure(&mut host);
    success(host).await?;
    let completed = services.operator(&["get", "task", task_id]).await?;
    assert_eq!(completed["state"], "TASK_STATE_SUCCEEDED", "{completed}");
    // The fixture asserts each mirrored result, which echoes the refresh token, was withheld.
    assert_eq!(completed["result"], "fixture used one scoped MCP tool");
    let entries = std::fs::read_to_string(&journal)?
        .lines()
        .map(serde_json::from_str)
        .collect::<Result<Vec<Value>, _>>()?;
    let refreshes: Vec<_> = entries
        .iter()
        .filter(|entry| entry.get("token").is_some())
        .collect();
    assert_eq!(
        refreshes,
        [&serde_json::json!({"token":"refresh_token","refresh":"refresh-1"})],
        "{entries:?}"
    );
    assert_eq!(
        entries
            .iter()
            .filter(|entry| entry.get("refused").is_some())
            .count(),
        1,
        "only the stale token was refused: {entries:?}"
    );
    assert!(entries.iter().any(|entry| entry["tool"] == "list_docs"));
    let stored: Value = serde_json::from_slice(&std::fs::read(logins.join("catalog.json"))?)?;
    assert_eq!(stored["refreshToken"], "refresh-2");
    assert_eq!(stored["accessToken"], "access-1");

    // The authorization server now refuses the grant, and the access token has expired.
    std::fs::write(format!("{}.refuse", journal.display()), "")?;
    write_login(&logins, &login("refresh-2", "access-1", now - 1))?;
    let lapsing = services
        .operator(&[
            "task",
            "submit",
            "--tag",
            "mcp-reader",
            "--session",
            "lapsing",
            "scoped-http-mcp",
        ])
        .await?;
    let lapsing_id = lapsing["task_id"].as_str().context("Task ID")?;
    let mut serving = services.serving_worker(
        "claude-code",
        &directory.join("serving-host"),
        Path::new(&node),
        &entry,
    );
    configure(&mut serving);
    let mut serving = serving.stderr(Stdio::null()).spawn()?;
    let failed = super::wait_for_state(&services, lapsing_id, "TASK_STATE_FAILED").await?;
    assert!(
        failed["result"]
            .as_str()
            .is_some_and(|result| result.contains("supertag mcp login catalog")),
        "{failed}"
    );
    let lapsed: Value = serde_json::from_slice(&std::fs::read(logins.join("catalog.json"))?)?;
    assert!(lapsed["lapsedAt"].is_i64(), "{lapsed}");
    let mut list = command(&["mcp", "list", "--mcp-catalog"]);
    list.arg(&catalog)
        .env("SUPERTAG_STATE_DIR", &supertag_state);
    let listed = String::from_utf8(success(list).await?)?;
    assert!(
        listed.contains("login lapsed; run supertag mcp login catalog"),
        "{listed}"
    );

    // An Objective Task that needs the server waits on this host, and the Inbox says why.
    let objective = services
        .operator(&[
            "objective",
            "create",
            "docs",
            "--owner",
            "mcp-reader",
            "--operation-id",
            "create-docs",
            "Answer from the catalog",
        ])
        .await?;
    let held = objective["starting_task_id"]
        .as_str()
        .context("Objective Task")?
        .to_owned();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let item = loop {
        let inbox = services
            .operator(&["inbox", "list", "--kind", "mcp-login"])
            .await?;
        if let Some(item) = inbox["items"]
            .as_array()
            .and_then(|items| items.iter().find(|item| item["task_id"] == held.as_str()))
        {
            break item.clone();
        }
        ensure!(
            tokio::time::Instant::now() < deadline,
            "no mcp_login item: {inbox}"
        );
        tokio::time::sleep(Duration::from_millis(250)).await;
    };
    assert_eq!(item["kind"], "mcp_login");
    assert_eq!(item["objective_id"], "docs");
    assert!(
        item["reason"]
            .as_str()
            .is_some_and(|reason| reason.contains("supertag mcp login catalog")),
        "{item}"
    );
    let status = services.operator(&["get", "task", &held]).await?;
    assert_eq!(status["state"], "TASK_STATE_QUEUED", "{status}");

    // A new login, as `supertag mcp login catalog` writes, releases the Task on the same host.
    std::fs::remove_file(format!("{}.refuse", journal.display()))?;
    write_login(&logins, &login("relogin-1", "expired-access", now - 1))?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    loop {
        let status = services.operator(&["get", "task", &held]).await?;
        if status["state"] != "TASK_STATE_QUEUED" {
            break;
        }
        ensure!(
            tokio::time::Instant::now() < deadline,
            "the Task stayed held after a new login: {status}"
        );
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    let inbox = services
        .operator(&["inbox", "list", "--kind", "mcp-login"])
        .await?;
    assert!(
        inbox["items"].as_array().is_some_and(Vec::is_empty),
        "{inbox}"
    );
    serving.kill().await?;
    provider.kill().await?;
    services.stop().await
}
