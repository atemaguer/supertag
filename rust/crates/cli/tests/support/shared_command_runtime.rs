use std::os::unix::fs::PermissionsExt;

use super::*;

database_tests! {
    #[tokio::test]
    #[ignore = "requires isolated Linux root, util-linux setsid and SUPERTAG_RUST_TEST_SHARED_EXECUTION_BINARY"]
    cursor_shared_command_reaps_before_cancelled_task_cleanup_can_settle;
}

async fn cursor_shared_command_reaps_before_cancelled_task_cleanup_can_settle(
    database: String,
) -> Result<()> {
    const ENVIRONMENT: &str = "fixture-command-root";
    if crate::prerequisites::linux_root()?.is_none() {
        return Ok(());
    }
    let Some(binary) =
        crate::prerequisites::env("linux-root", "SUPERTAG_RUST_TEST_SHARED_EXECUTION_BINARY")?
    else {
        return Ok(());
    };
    let directory = tempfile::tempdir()?;
    let fixture = Fixture::prepare(directory.path()).await?;
    std::fs::set_permissions(&fixture.root, std::fs::Permissions::from_mode(0o711))?;
    let root = fixture.root.join("shared-root");
    let state = fixture.root.join("provider-state");
    std::fs::create_dir(&root)?;
    std::os::unix::fs::chown(&root, Some(65534), Some(65534))?;
    std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700))?;
    std::fs::write(root.join("workspace.txt"), "initial-content\n")?;
    let admin = Uuid::new_v4().to_string();
    let mut command = Command::new(binary);
    command
        .env_clear()
        .env("SUPERTAG_EXECUTION_ADMIN_TOKEN", &admin)
        .args([
            "--environment-id",
            ENVIRONMENT,
            "--process-uid",
            "65534",
            "--process-gid",
            "65534",
        ])
        .arg("--root")
        .arg(&root)
        .arg("--state-directory")
        .arg(&state)
        .kill_on_drop(true);
    let (mut provider, endpoint) = service(command).await?;
    let credentials = Credentials::new();
    let mut runtime = Runtime::start(&fixture.root, &credentials, &database).await?;
    runtime
        .operator
        .put_tag(credentials.request(PutTagRequest {
            tag_id: TAG.into(),
            instructions: "Use the lease-bound command fixture.".into(),
            allowed_actions: vec![
                "files:read".into(),
                "files:write".into(),
                "commands:execute".into(),
            ],
            harness_kind: HarnessKind::Cursor as i32,
            execution: Some(PolicyExecutionSettings {
                shared_execution_environment_id: Some(ENVIRONMENT.into()),
                ..Default::default()
            }),
            ..Default::default()
        })?)
        .await?;
    let task = runtime.submit(TAG, "shared-command").await?;
    let start_host = |runtime: &Runtime<'_>| {
        runtime
            .worker_command(&fixture, "shared-command")
            .arg("--shared-execution-endpoint")
            .arg(&endpoint)
            .arg("--shared-execution-environment")
            .arg(ENVIRONMENT)
            .arg("--shared-execution-commands")
            .env("SUPERTAG_EXECUTION_ADMIN_TOKEN", &admin)
            .spawn()
    };
    let worker = start_host(&runtime)?;
    let pid = timeout(WAIT, async {
        loop {
            if let Ok(file) = tokio::fs::read_to_string(root.join("lease.pid")).await
                && let Ok(pid) = file.trim().parse::<i32>()
            {
                break pid;
            }
            sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .with_context(|| format!("shared command did not start: {:?}", fixture.trace()))?;
    let provider_pid = i32::try_from(provider.id().context("provider PID missing")?)?;
    ensure!(unsafe { libc::kill(provider_pid, libc::SIGSTOP) } == 0);
    runtime
        .operator
        .cancel_task(credentials.request(CancelTaskRequest {
            task_id: task.task_id.clone(),
        })?)
        .await?;
    sqlx::any::install_default_drivers();
    let mut database = sqlx::AnyConnection::connect(&runtime.database).await?;
    assert!(cleanup_pending(&mut database, &task.task_id).await?);
    gone(pid).await?;
    let output = timeout(WAIT, worker.wait_with_output()).await??;
    assert!(!output.status.success());
    assert!(cleanup_pending(&mut database, &task.task_id).await?);
    assert_eq!(
        runtime.task(&task.task_id).await?.state(),
        TaskState::Cancelled
    );
    ensure!(unsafe { libc::kill(provider_pid, libc::SIGCONT) } == 0);
    let output = timeout(WAIT, start_host(&runtime)?.wait_with_output()).await??;
    ensure!(
        output.status.success(),
        "recover shared command cleanup: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!cleanup_pending(&mut database, &task.task_id).await?);
    assert_eq!(
        fixture
            .trace()?
            .iter()
            .filter(|event| event["type"] == "started" && event["mode"] == "shared-command")
            .count(),
        1,
    );
    provider.kill().await?;
    runtime.stop().await?;
    Ok(())
}

async fn cleanup_pending(database: &mut sqlx::AnyConnection, task_id: &str) -> Result<bool> {
    let pending: i64 =
        sqlx::query_scalar("SELECT cleanup_pending FROM supertag_v2_tasks WHERE task_id=$1")
            .bind(task_id)
            .fetch_one(database)
            .await?;
    Ok(pending != 0)
}
