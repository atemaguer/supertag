use std::{os::unix::fs::PermissionsExt, path::Path};

use super::*;
use supertag_shared_execution::v2::{
    AccessCommandMode, PrepareCommandLeaseRequest, RenewCommandLeaseRequest, StartProcess,
    StopProcess, WatchProcessRequest,
};

async fn wait_pid(path: &Path) -> Result<u32> {
    time::timeout(WAIT, async {
        loop {
            if let Ok(value) = tokio::fs::read_to_string(path).await
                && let Ok(pid) = value.trim().parse()
            {
                break pid;
            }
            time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .context("detached workload did not publish its PID")
}

fn shell(script: &str) -> Operation {
    Operation::StartProcess(StartProcess {
        command: "/bin/sh".into(),
        args: vec!["-c".into(), script.into()],
        cwd: ".".into(),
        timeout_ms: 45_000,
        stdin: vec![],
    })
}

fn workload_fixture() -> Result<Fixture> {
    let fixture = Fixture::new()?;
    std::fs::set_permissions(
        fixture.directory.path(),
        std::fs::Permissions::from_mode(0o711),
    )?;
    std::os::unix::fs::chown(&fixture.root, Some(65534), Some(65534))?;
    std::fs::set_permissions(&fixture.root, std::fs::Permissions::from_mode(0o700))?;
    Ok(fixture)
}

#[tokio::test]
#[ignore = "requires isolated Linux root and util-linux setsid to launch a distinct workload UID"]
async fn expired_command_lease_reaps_detached_work_while_provider_is_stopped() -> Result<()> {
    if crate::prerequisites::linux_root()?.is_none() {
        return Ok(());
    }
    let fixture = workload_fixture()?;
    let mut running = fixture.start(true).await?;
    let token = "lease-fixture-private-access-token-0123456789";
    let mut access = issue("lease", token, "attempt-lease");
    access.get_mut().command_mode = AccessCommandMode::LeaseBound as i32;
    running.client.issue_access(access).await?;
    let command = || {
        execute(
            "lease-process",
            shell("/usr/bin/setsid /bin/sh -c 'echo $$ > lease.pid; exec /bin/sleep 30' & wait"),
            token,
        )
    };
    assert_eq!(
        running.client.execute(command()).await.unwrap_err().code(),
        Code::FailedPrecondition
    );
    let prepare = || {
        request(
            PrepareCommandLeaseRequest {
                access_id: "lease".into(),
            },
            token,
        )
    };
    let first = running
        .client
        .prepare_command_lease(prepare())
        .await?
        .into_inner();
    let renewal = |challenge_id: String, valid_for_ms| {
        request(
            RenewCommandLeaseRequest {
                access_id: "lease".into(),
                challenge_id,
                valid_for_ms,
            },
            token,
        )
    };
    running
        .client
        .renew_command_lease(renewal(first.challenge_id.clone(), 3_000))
        .await?;
    assert!(
        running
            .client
            .renew_command_lease(renewal(first.challenge_id, 5_000))
            .await
            .is_err()
    );
    let started = running.client.execute(command()).await?.into_inner();
    let pid = wait_pid(&fixture.root.join("lease.pid")).await?;
    let second = running
        .client
        .prepare_command_lease(prepare())
        .await?
        .into_inner();
    running
        .client
        .renew_command_lease(renewal(second.challenge_id, 5_000))
        .await?;
    time::sleep(Duration::from_millis(3_100)).await;
    assert!(
        Path::new(&format!("/proc/{pid}")).exists(),
        "command ignored renewal"
    );
    let owner = running.child.id().context("provider process ID")? as libc::pid_t;
    assert_eq!(unsafe { libc::kill(owner, libc::SIGSTOP) }, 0);
    let removed = time::timeout(WAIT, async {
        while Path::new(&format!("/proc/{pid}")).exists() {
            time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await;
    assert_eq!(unsafe { libc::kill(owner, libc::SIGCONT) }, 0);
    removed.context("detached command survived authority expiry while provider was stopped")?;
    let process_id = started.process_id.context("lease-bound process identity")?;
    let mut output = running
        .client
        .watch_process(request(
            WatchProcessRequest {
                process_id: process_id.clone(),
                after_sequence: 0,
            },
            token,
        ))
        .await?
        .into_inner();
    let receipt = loop {
        let page = output
            .message()
            .await?
            .context("lease-bound process ended before cleanup proof")?;
        if let Some(receipt) = page.terminal {
            break receipt;
        }
    };
    assert_eq!(receipt.process_id.as_deref(), Some(process_id.as_str()));
    assert!(receipt.cleanup_verified);
    assert_eq!(receipt.state(), OperationState::Failed);
    let revoked = running
        .client
        .revoke_access(request(
            EndAccessRequest {
                access_id: "lease".into(),
            },
            ADMIN,
        ))
        .await?
        .into_inner();
    assert!(revoked.cleanup_verified);
    assert_eq!(
        running
            .client
            .inspect_operation(inspect("lease-process", token))
            .await
            .unwrap_err()
            .code(),
        Code::Unauthenticated
    );
    running.child.kill().await?;
    Ok(())
}

#[tokio::test]
#[ignore = "requires isolated Linux root and util-linux setsid to launch a distinct workload UID"]
async fn resumes_owned_output_and_proves_detached_cleanup_after_owner_death() -> Result<()> {
    if crate::prerequisites::linux_root()?.is_none() {
        return Ok(());
    }
    let fixture = workload_fixture()?;
    let mut running = fixture.start(true).await?;
    let (one, _) = grant(&mut running.client, "one").await?;
    let (two, _) = grant(&mut running.client, "two").await?;
    let script = r#"test -z "${SUPERTAG_EXECUTION_ADMIN_TOKEN:-}${OUTSIDE_SERVICE_SECRET:-}" || exit 91
        printf first; until test -f proceed; do sleep .02; done; printf second"#;
    let process = running
        .client
        .execute(execute("stream", shell(script), &two))
        .await?
        .into_inner();
    let process_id = process.process_id.as_deref().context("stream process ID")?;
    let watch = |cursor| WatchProcessRequest {
        process_id: process_id.into(),
        after_sequence: cursor,
    };
    assert_eq!(
        running
            .client
            .watch_process(request(watch(0), &one))
            .await
            .unwrap_err()
            .code(),
        Code::PermissionDenied
    );
    assert_eq!(
        running
            .client
            .execute(execute(
                "steal",
                Operation::StopProcess(StopProcess {
                    process_id: process_id.into()
                }),
                &one
            ))
            .await
            .unwrap_err()
            .code(),
        Code::PermissionDenied
    );
    let mut stream = running
        .client
        .watch_process(request(watch(0), &two))
        .await?
        .into_inner();
    let first = stream
        .message()
        .await?
        .context("missing first process page")?;
    assert_eq!(first.chunks[0].data, b"first");
    drop(stream);

    let detached = running
        .client
        .execute(execute(
            "detach",
            shell("/usr/bin/setsid /bin/sh -c 'echo $$ > detached.pid; exec /bin/sleep 30' & wait"),
            &one,
        ))
        .await?
        .into_inner();
    assert!(detached.process_id.is_some());
    let pid = wait_pid(&fixture.root.join("detached.pid")).await?;
    let released = running
        .client
        .release_access(request(
            EndAccessRequest {
                access_id: "one".into(),
            },
            &one,
        ))
        .await?
        .into_inner();
    assert!(released.cleanup_verified);
    assert!(
        !Path::new(&format!("/proc/{pid}")).exists(),
        "released process survived: {pid}"
    );
    assert_eq!(
        running
            .client
            .inspect_operation(inspect("stream", &two))
            .await?
            .into_inner()
            .state(),
        OperationState::Running
    );
    running
        .client
        .execute(execute("continue", write("proceed", b"", false), &two))
        .await?;
    let mut resumed = running
        .client
        .watch_process(request(watch(first.next_cursor), &two))
        .await?
        .into_inner();
    let mut bytes = Vec::new();
    let mut cursor = first.next_cursor;
    let terminal = loop {
        let page = resumed
            .message()
            .await?
            .context("stream ended before terminal receipt")?;
        for chunk in page.chunks {
            cursor += 1;
            assert_eq!(chunk.sequence, cursor);
            bytes.extend(chunk.data);
        }
        assert_eq!(page.next_cursor, cursor);
        if let Some(terminal) = page.terminal {
            break terminal;
        }
    };
    assert_eq!(bytes, b"second");
    assert!(terminal.cleanup_verified);
    assert_eq!(
        running
            .client
            .watch_process(request(watch(cursor + 1), &two))
            .await
            .unwrap_err()
            .code(),
        Code::FailedPrecondition
    );

    let (crash, _) = grant(&mut running.client, "crash").await?;
    let start = || {
        execute(
            "crash-op",
            shell("/usr/bin/setsid /bin/sh -c 'echo $$ > crash.pid; exec /bin/sleep 30' & wait"),
            &crash,
        )
    };
    let started = running.client.execute(start()).await?.into_inner();
    let crashed_pid = wait_pid(&fixture.root.join("crash.pid")).await?;
    running.child.kill().await?;
    let mut replacement = fixture.start(true).await?;
    let uncertain = replacement.client.execute(start()).await?.into_inner();
    assert_eq!(uncertain.state(), OperationState::Uncertain);
    assert_eq!(uncertain.process_id, started.process_id);
    let revoked = replacement
        .client
        .revoke_access(request(
            EndAccessRequest {
                access_id: "crash".into(),
            },
            ADMIN,
        ))
        .await?
        .into_inner();
    assert!(revoked.cleanup_verified);
    assert!(
        !Path::new(&format!("/proc/{crashed_pid}")).exists(),
        "crashed process survived: {crashed_pid}"
    );
    replacement.child.kill().await?;
    Ok(())
}

#[tokio::test]
#[ignore = "requires isolated Linux root to launch a distinct workload UID"]
async fn refuses_to_acknowledge_revocation_when_owned_cleanup_proof_is_missing() -> Result<()> {
    if crate::prerequisites::linux_root()?.is_none() {
        return Ok(());
    }
    use prost::Message;
    use sqlx::{
        Connection,
        sqlite::{SqliteConnectOptions, SqliteConnection},
    };

    let fixture = workload_fixture()?;
    let mut running = fixture.start(true).await?;
    let (token, _) = grant(&mut running.client, "unknown").await?;
    let started = running
        .client
        .execute(execute("lost-proof", shell("exit 0"), &token))
        .await?
        .into_inner();
    let process_id = started.process_id.context("process identity")?;
    let mut watch = running
        .client
        .watch_process(request(
            WatchProcessRequest {
                process_id: process_id.clone(),
                after_sequence: 0,
            },
            &token,
        ))
        .await?
        .into_inner();
    let mut settled = watch
        .message()
        .await?
        .context("terminal page")?
        .terminal
        .context("terminal receipt")?;
    assert!(settled.cleanup_verified);
    running.child.kill().await?;
    std::fs::remove_file(fixture.state.join("cleanup-proofs").join(process_id))?;
    // Simulate the durable reservation left by an owner death before its guardian could prove cleanup.
    settled.state = OperationState::Running as i32;
    settled.cleanup_verified = false;
    settled.result = None;
    let mut journal = SqliteConnection::connect_with(
        &SqliteConnectOptions::new().filename(fixture.state.join("state.sqlite")),
    )
    .await?;
    sqlx::query(
        "UPDATE operations SET state=?, cleanup_verified=0, receipt=? WHERE id='lost-proof'",
    )
    .bind(settled.state)
    .bind(settled.encode_to_vec())
    .execute(&mut journal)
    .await?;
    journal.close().await?;

    let mut replacement = fixture.start(true).await?;
    let blocked = replacement
        .client
        .execute(execute(
            "new-operation",
            write("unsafe.txt", b"no", false),
            &token,
        ))
        .await
        .unwrap_err();
    assert_eq!(blocked.code(), Code::FailedPrecondition);
    assert!(!fixture.root.join("unsafe.txt").exists());
    let end = request(
        EndAccessRequest {
            access_id: "unknown".into(),
        },
        ADMIN,
    );
    assert_eq!(
        replacement
            .client
            .revoke_access(end)
            .await
            .unwrap_err()
            .code(),
        Code::FailedPrecondition
    );
    let pending = replacement
        .client
        .issue_access(issue("unknown", &token, "attempt-unknown"))
        .await?
        .into_inner();
    assert_eq!(pending.state(), AccessState::Revoking);
    assert!(!pending.cleanup_verified);
    replacement.child.kill().await?;
    Ok(())
}
