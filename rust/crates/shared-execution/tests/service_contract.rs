use std::{net::SocketAddr, path::PathBuf, process::Stdio, time::Duration};

use anyhow::{Context, Result, ensure};
use supertag_shared_execution::v2::{
    AccessReceipt, AccessState, DescribeEnvironmentRequest, EndAccessRequest, ExecuteRequest,
    InspectOperationRequest, IssueAccessRequest, OperationState, ReadFile, WriteFile,
    execute_request::Operation, operation_receipt::Result as Effect,
    shared_execution_client::SharedExecutionClient,
};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    time,
};
use tonic::{Code, Request, transport::Channel};

const BINARY: &str = env!("CARGO_BIN_EXE_supertag-shared-execution");
const ADMIN: &str = "fixture-shared-owner-admin-secret";
const ENVIRONMENT: &str = "fixture-fixed-root";
const WAIT: Duration = Duration::from_secs(15);

#[cfg(target_os = "linux")]
#[path = "support/process_contract.rs"]
mod process_contract;

struct Fixture {
    directory: tempfile::TempDir,
    root: PathBuf,
    state: PathBuf,
}

struct Running {
    child: Child,
    client: SharedExecutionClient<Channel>,
}

impl Fixture {
    fn new() -> Result<Self> {
        let directory = tempfile::tempdir()?;
        let root = directory.path().join("workspace");
        let state = directory.path().join("private-state");
        std::fs::create_dir(&root)?;
        Ok(Self {
            directory,
            root,
            state,
        })
    }

    async fn start(&self, processes: bool) -> Result<Running> {
        let mut command = Command::new(BINARY);
        command
            .env_clear()
            .env("SUPERTAG_EXECUTION_ADMIN_TOKEN", ADMIN)
            .env("OUTSIDE_SERVICE_SECRET", "must-stay-in-service")
            .args([
                "--listen",
                "127.0.0.1:0",
                "--environment-id",
                ENVIRONMENT,
                "--root",
            ])
            .arg(&self.root)
            .arg("--state-directory")
            .arg(&self.state)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .kill_on_drop(true);
        if processes {
            command.args(["--process-uid", "65534", "--process-gid", "65534"]);
        }
        let mut child = command.spawn()?;
        let mut stdout = BufReader::new(child.stdout.take().context("provider stdout missing")?);
        let mut line = String::new();
        time::timeout(WAIT, stdout.read_line(&mut line)).await??;
        let address: SocketAddr = line.trim().parse().context("provider failed to start")?;
        ensure!(address.ip().is_loopback() && address.port() != 0);
        let client = SharedExecutionClient::connect(format!("http://{address}")).await?;
        Ok(Running { child, client })
    }
}

fn request<T>(body: T, token: &str) -> Request<T> {
    let mut request = Request::new(body);
    request
        .metadata_mut()
        .insert("authorization", format!("Bearer {token}").parse().unwrap());
    request.set_timeout(WAIT);
    request
}

fn issue(id: &str, token: &str, attempt: &str) -> Request<IssueAccessRequest> {
    let mut request = request(
        IssueAccessRequest {
            environment_id: ENVIRONMENT.into(),
            access_id: id.into(),
            task_id: format!("task-{id}"),
            attempt_id: attempt.into(),
            tag_id: "fixture-tag".into(),
            ttl_ms: 60_000,
            expected_incarnation_id: None,
        },
        ADMIN,
    );
    request
        .metadata_mut()
        .insert("x-supertag-grant-token", token.parse().unwrap());
    request
}

async fn grant(
    client: &mut SharedExecutionClient<Channel>,
    id: &str,
) -> Result<(String, AccessReceipt)> {
    let token = format!("{id}-fixture-execution-access-token-0123456789");
    let receipt = client
        .issue_access(issue(id, &token, &format!("attempt-{id}")))
        .await?
        .into_inner();
    assert_eq!(receipt.state(), AccessState::Active);
    assert_eq!(receipt.environment_id, ENVIRONMENT);
    assert_eq!(receipt.access_id, id);
    Ok((token, receipt))
}

fn execute(id: &str, operation: Operation, token: &str) -> Request<ExecuteRequest> {
    request(
        ExecuteRequest {
            operation_id: id.into(),
            operation: Some(operation),
        },
        token,
    )
}

fn write(path: &str, data: &[u8], stage: bool) -> Operation {
    let write = WriteFile {
        path: path.into(),
        content: data.to_vec(),
        overwrite: false,
    };
    if stage {
        Operation::StageFile(write)
    } else {
        Operation::WriteFile(write)
    }
}

fn inspect(id: &str, token: &str) -> Request<InspectOperationRequest> {
    request(
        InspectOperationRequest {
            operation_id: id.into(),
        },
        token,
    )
}

#[tokio::test]
async fn fixed_root_access_preserves_exact_receipts_and_refuses_cross_access_or_symlinks()
-> Result<()> {
    let fixture = Fixture::new()?;
    let mut running = fixture.start(false).await?;
    assert!(
        fixture.start(false).await.is_err(),
        "a second owner acquired the root"
    );
    let mut describe = running.client.clone();
    assert_eq!(
        describe
            .describe(request(
                DescribeEnvironmentRequest {},
                "invalid-grant-credential"
            ))
            .await
            .unwrap_err()
            .code(),
        Code::Unauthenticated
    );
    let description = describe
        .describe(request(DescribeEnvironmentRequest {}, ADMIN))
        .await?
        .into_inner();
    assert_eq!(description.environment_id, ENVIRONMENT);
    assert!(description.file_read && description.file_write);
    let mut replaced = issue(
        "first",
        "would-have-minted-a-stale-access-token",
        "attempt-first",
    );
    replaced.get_mut().expected_incarnation_id = Some(uuid::Uuid::new_v4().to_string());
    assert_eq!(
        running
            .client
            .issue_access(replaced)
            .await
            .unwrap_err()
            .code(),
        Code::FailedPrecondition
    );
    let (token, first) = grant(&mut running.client, "first").await?;
    assert_eq!(first.incarnation_id, description.incarnation_id);
    let (other, _) = grant(&mut running.client, "other").await?;
    assert_eq!(
        running
            .client
            .issue_access(issue("first", &token, "attempt-first"))
            .await?
            .into_inner(),
        first
    );
    assert_eq!(
        running
            .client
            .issue_access(issue("first", &token, "forged"))
            .await
            .unwrap_err()
            .code(),
        Code::AlreadyExists
    );
    let write_request = || execute("write", write("sub/saved.txt", b"once", false), &token);
    let committed = running.client.execute(write_request()).await?.into_inner();
    assert_eq!(committed.state(), OperationState::Completed);
    assert_eq!(
        committed,
        running.client.execute(write_request()).await?.into_inner()
    );
    assert_eq!(
        running
            .client
            .execute(execute(
                "write",
                write("sub/saved.txt", b"change", false),
                &token
            ))
            .await
            .unwrap_err()
            .code(),
        Code::AlreadyExists
    );
    assert_eq!(
        running
            .client
            .execute(execute(
                "write",
                write("sub/saved.txt", b"once", false),
                &other
            ))
            .await
            .unwrap_err()
            .code(),
        Code::PermissionDenied
    );

    let read = running
        .client
        .execute(execute(
            "read",
            Operation::ReadFile(ReadFile {
                path: "sub/saved.txt".into(),
                maximum_bytes: 4,
            }),
            &other,
        ))
        .await?
        .into_inner();
    assert!(matches!(read.result, Some(Effect::FileContent(file)) if file.content == b"once"));
    let staged = running
        .client
        .execute(execute(
            "staged",
            write("sub/saved.txt", b"seed", true),
            &other,
        ))
        .await?
        .into_inner();
    assert!(
        matches!(staged.result, Some(Effect::FileWritten(file)) if !file.created && file.bytes == 0)
    );
    let outside = fixture.directory.path().join("outside");
    std::fs::create_dir(&outside)?;
    std::os::unix::fs::symlink(&outside, fixture.root.join("link"))?;
    for (id, path) in [
        ("parent", "../outside/escaped"),
        ("symlink", "link/escaped"),
    ] {
        match running
            .client
            .execute(execute(id, write(path, b"unsafe", false), &token))
            .await
        {
            Ok(response) => assert_eq!(response.into_inner().state(), OperationState::Failed),
            Err(error) => assert_eq!(error.code(), Code::InvalidArgument),
        }
    }
    assert!(!outside.join("escaped").exists());
    assert_eq!(std::fs::read(fixture.root.join("sub/saved.txt"))?, b"once");
    assert_eq!(
        running
            .client
            .inspect_operation(inspect("write", &other))
            .await
            .unwrap_err()
            .code(),
        Code::PermissionDenied
    );
    assert_eq!(
        running
            .client
            .inspect_operation(inspect("write", ADMIN))
            .await
            .unwrap_err()
            .code(),
        Code::Unauthenticated
    );

    running.child.kill().await?;
    let mut replacement = fixture.start(false).await?;
    assert_eq!(
        replacement
            .client
            .issue_access(issue("first", &token, "attempt-first"))
            .await?
            .into_inner(),
        first
    );
    assert_eq!(
        replacement
            .client
            .inspect_operation(inspect("write", &token))
            .await?
            .into_inner(),
        committed
    );
    let end = || {
        request(
            EndAccessRequest {
                access_id: "first".into(),
            },
            &token,
        )
    };
    let released = replacement.client.release_access(end()).await?.into_inner();
    assert_eq!(released.state(), AccessState::Released);
    assert!(released.cleanup_verified);
    assert_eq!(
        replacement.client.release_access(end()).await?.into_inner(),
        released
    );
    assert_eq!(
        replacement
            .client
            .execute(execute("later", write("late.txt", b"stale", false), &token))
            .await
            .unwrap_err()
            .code(),
        Code::Unauthenticated
    );
    replacement.child.kill().await?;
    Ok(())
}

#[tokio::test]
async fn interrupted_file_effect_is_not_repeated_after_restart() -> Result<()> {
    use prost::Message;
    use sqlx::{
        Connection, Row,
        sqlite::{SqliteConnectOptions, SqliteConnection},
    };
    use supertag_shared_execution::v2::OperationReceipt;

    let fixture = Fixture::new()?;
    let mut running = fixture.start(false).await?;
    let (token, _) = grant(&mut running.client, "writer").await?;
    let operation = || {
        execute(
            "uncertain",
            Operation::WriteFile(WriteFile {
                path: "shared.txt".into(),
                content: b"first write".to_vec(),
                overwrite: true,
            }),
            &token,
        )
    };
    assert_eq!(
        running
            .client
            .execute(operation())
            .await?
            .into_inner()
            .state(),
        OperationState::Completed
    );
    running.child.kill().await?;

    // Reconstruct the durable state left when the owner loses the file completion acknowledgement.
    let mut journal = SqliteConnection::connect_with(
        &SqliteConnectOptions::new().filename(fixture.state.join("state.sqlite")),
    )
    .await?;
    let row = sqlx::query("SELECT receipt FROM operations WHERE id='uncertain'")
        .fetch_one(&mut journal)
        .await?;
    let mut receipt = OperationReceipt::decode(row.try_get::<Vec<u8>, _>("receipt")?.as_slice())?;
    receipt.state = OperationState::Accepted as i32;
    receipt.result = None;
    receipt.cleanup_verified = false;
    sqlx::query("UPDATE operations SET state=?,cleanup_verified=0,receipt=? WHERE id='uncertain'")
        .bind(receipt.state)
        .bind(receipt.encode_to_vec())
        .execute(&mut journal)
        .await?;
    journal.close().await?;
    std::fs::write(fixture.root.join("shared.txt"), b"later shared change")?;

    let mut replacement = fixture.start(false).await?;
    let replay = replacement.client.execute(operation()).await?.into_inner();
    assert_eq!(replay.state(), OperationState::Uncertain);
    assert!(replay.cleanup_verified);
    assert_eq!(
        std::fs::read(fixture.root.join("shared.txt"))?,
        b"later shared change"
    );
    for name in ["state.sqlite", "state.sqlite-wal"] {
        let Ok(bytes) = std::fs::read(fixture.state.join(name)) else {
            continue;
        };
        assert!(
            !bytes
                .windows(token.len())
                .any(|window| window == token.as_bytes())
        );
        assert!(
            !bytes
                .windows(ADMIN.len())
                .any(|window| window == ADMIN.as_bytes())
        );
    }
    replacement.child.kill().await?;
    Ok(())
}
