//! Workspace Volume copies for Cursor: a local Worker Host and the E2B and Modal
//! provider fixtures. The Worker Host stages each copy on the host, a remote
//! Workspace receives only its files through the provider SDK's own copy code,
//! and read-write changes are written back.
use super::*;
use axum::{
    Router,
    body::Bytes,
    extract::{Query, State},
    http::{HeaderMap, Method, StatusCode, Uri},
    response::IntoResponse,
};
use std::{
    collections::{BTreeMap, HashMap},
    os::unix::fs::PermissionsExt,
    sync::{Arc, Mutex},
};
use supertag_protocol::v2::{WorkspaceCopyMount, WorkspaceMountWriteStatus};

/// The read-write Volume's S3 keys, which only the Worker Host may hold.
const S3_ACCESS_KEY: &str = "FIXTURECOPYKEY";
const S3_SECRET: &str = "fixture-copy-secret-bytes";
const S3_TOKEN: &str = "fixture-copy-session-token";
const S3_SOURCE: &str = "s3://copy-bucket/team";

#[derive(Clone, Copy, PartialEq)]
enum ReadWrite {
    File,
    S3,
}

/// A loopback S3 store for the read-write Volume: it serves only requests
/// signed with the mapped key and session token.
#[derive(Clone, Default)]
struct Store(Arc<Mutex<BTreeMap<String, Vec<u8>>>>);

impl Store {
    fn get(&self, key: &str) -> Option<String> {
        let objects = self.0.lock().unwrap();
        String::from_utf8(objects.get(&format!("team/{key}"))?.clone()).ok()
    }
}

fn signed(headers: &HeaderMap) -> bool {
    let get = |name: &str| headers.get(name).and_then(|value| value.to_str().ok());
    get("authorization").is_some_and(|value| {
        value.starts_with(&format!("AWS4-HMAC-SHA256 Credential={S3_ACCESS_KEY}/"))
    }) && get("x-amz-security-token") == Some(S3_TOKEN)
}

async fn s3_list(
    State(store): State<Store>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    if !signed(&headers) || query.get("list-type").map(String::as_str) != Some("2") {
        return (StatusCode::FORBIDDEN, String::new());
    }
    let prefix = query.get("prefix").cloned().unwrap_or_default();
    let mut body = String::from("<ListBucketResult>");
    for (key, bytes) in store.0.lock().unwrap().iter() {
        if key.starts_with(&prefix) {
            body.push_str(&format!(
                "<Contents><Key>{key}</Key><Size>{}</Size></Contents>",
                bytes.len()
            ));
        }
    }
    body.push_str("<IsTruncated>false</IsTruncated></ListBucketResult>");
    (StatusCode::OK, body)
}

async fn s3_object(
    State(store): State<Store>,
    method: Method,
    headers: HeaderMap,
    uri: Uri,
    body: Bytes,
) -> impl IntoResponse {
    let Some(key) = uri.path().strip_prefix("/copy-bucket/") else {
        return (StatusCode::NOT_FOUND, Vec::new());
    };
    if !signed(&headers) || !key.bytes().all(|b| b.is_ascii_graphic()) || key.contains('%') {
        return (StatusCode::FORBIDDEN, Vec::new());
    }
    let mut objects = store.0.lock().unwrap();
    if method == Method::PUT {
        objects.insert(key.into(), body.to_vec());
        return (StatusCode::OK, Vec::new());
    }
    match objects.get(key) {
        Some(bytes) => (StatusCode::OK, bytes.clone()),
        None => (StatusCode::NOT_FOUND, Vec::new()),
    }
}

async fn start_s3(store: Store) -> Result<String> {
    let app = Router::new()
        .route("/copy-bucket", axum::routing::get(s3_list))
        .fallback(s3_object)
        .with_state(store);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    tokio::spawn(async move { axum::serve(listener, app).await });
    Ok(format!("http://{address}"))
}

fn file_url(path: &Path) -> Result<String> {
    Ok(format!(
        "file://{}",
        path.to_str().context("fixture path is not UTF-8")?
    ))
}

/// Every file a sandbox directory holds, made removable again: sealed
/// read-only copies keep their owner from deleting entries.
fn sandbox_files(root: &Path, files: &mut Vec<PathBuf>) -> Result<()> {
    if !root.exists() {
        return Ok(());
    }
    std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700))?;
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_dir() {
            sandbox_files(&entry.path(), files)?;
        } else if kind.is_file() {
            files.push(entry.path());
        }
    }
    Ok(())
}

async fn contract(
    provider: Option<RemoteWorkspace>,
    read_write: ReadWrite,
    database: &str,
) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let fixture = Fixture::prepare(directory.path()).await?;
    if let Some(provider) = provider {
        std::fs::write(
            fixture.root.join("provider-kind"),
            match provider {
                RemoteWorkspace::E2b => "e2b",
                RemoteWorkspace::Modal => "modal",
            },
        )?;
    }
    let read_only = fixture.root.join("volume-ro");
    let file_rw = fixture.root.join("volume-rw");
    std::fs::create_dir_all(read_only.join("nested"))?;
    std::fs::create_dir_all(read_only.join("empty"))?;
    std::fs::create_dir_all(&file_rw)?;
    std::fs::write(read_only.join("rows.csv"), "a,b\n1,2\n")?;
    std::fs::write(read_only.join("nested/notes.txt"), "notes\n")?;
    // A name a Volume key refuses, which a read-only copy still holds.
    std::fs::write(read_only.join("back\\slash.txt"), "odd\n")?;
    let store = Store::default();
    let root = fixture.root.join("mount-root");
    std::fs::create_dir(&root)?;
    std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700))?;
    let rw_mapping = match read_write {
        ReadWrite::File => {
            std::fs::write(file_rw.join("rows.csv"), "x\n")?;
            std::fs::write(file_rw.join("kept.txt"), "kept\n")?;
            json!({"volumeId": "data-rw", "source": file_url(&file_rw)?, "destinationRoot": root})
        }
        ReadWrite::S3 => {
            for (key, value) in [("team/rows.csv", "x\n"), ("team/kept.txt", "kept\n")] {
                store.0.lock().unwrap().insert(key.into(), value.into());
            }
            json!({
                "volumeId": "data-rw",
                "source": S3_SOURCE,
                "credential": "team-copies",
                "endpoint": start_s3(store.clone()).await?,
                "region": "us-east-1",
                "credentialEnvPrefix": "WSCOPY",
                "destinationRoot": root,
            })
        }
    };
    let mappings = fixture.root.join("mappings.json");
    std::fs::write(
        &mappings,
        serde_json::to_vec(&json!([
            {"volumeId": "data-ro", "source": file_url(&read_only)?, "destinationRoot": root},
            rw_mapping,
        ]))?,
    )?;

    let credentials = Credentials::new();
    let mut runtime = Runtime::start(&fixture.root, &credentials, database).await?;
    let read_only_source = file_url(&read_only)?;
    let read_write_source = match read_write {
        ReadWrite::File => file_url(&file_rw)?,
        ReadWrite::S3 => S3_SOURCE.into(),
    };
    runtime
        .cli(&[
            "workspace-volume",
            "put",
            "data-ro",
            "--source",
            &read_only_source,
        ])
        .await?;
    let mut put = vec![
        "workspace-volume",
        "put",
        "data-rw",
        "--source",
        &read_write_source,
    ];
    if read_write == ReadWrite::S3 {
        put.extend(["--credential", "team-copies"]);
    }
    runtime.cli(&put).await?;
    let mount = |id: &str, name: &str, read_write: bool| -> Result<WorkspaceCopyMount> {
        Ok(WorkspaceCopyMount {
            volume_id: id.into(),
            destination: root.join(name).to_str().context("path")?.into(),
            max_bytes: supertag_protocol::workspace_mounts::DEFAULT_WORKSPACE_MOUNT_BYTES,
            volume: None,
            read_write,
        })
    };
    runtime
        .operator
        .put_tag(credentials.request(PutTagRequest {
            tag_id: TAG.into(),
            instructions: "Follow the fixture Task with its admitted tools.".into(),
            allowed_actions: vec!["files:read".into(), "files:write".into()],
            workspace: Some(WorkspaceSpec {
                mcp_servers: vec![],
                mounts: vec![
                    mount("data-ro", "ro", false)?,
                    mount("data-rw", "rw", true)?,
                ],
                workspace_id: WORKSPACE.into(),
                base_commit: fixture.base.clone(),
                github_source: None,
            }),
            harness_kind: HarnessKind::Cursor as i32,
            ..Default::default()
        })?)
        .await?;
    let mode = if provider.is_some() {
        "remote-copy"
    } else {
        "copy"
    };
    let worker = |runtime: &Runtime, label: &str| {
        let mut worker = runtime.worker_command(&fixture, label);
        worker
            .arg("--workspace-id")
            .arg(WORKSPACE)
            .arg("--workspace-source")
            .arg(&fixture.source)
            .arg("--workspace-mount-mappings")
            .arg(&mappings)
            .env("WSCOPY_ACCESS_KEY_ID", S3_ACCESS_KEY)
            .env("WSCOPY_SECRET_ACCESS_KEY", S3_SECRET)
            .env("WSCOPY_SESSION_TOKEN", S3_TOKEN);
        if let Some(provider) = provider {
            let (provider_flag, argument_flag) = match provider {
                RemoteWorkspace::E2b => {
                    ("--e2b-workspace-provider", "--e2b-workspace-provider-arg")
                }
                RemoteWorkspace::Modal => (
                    "--modal-workspace-provider",
                    "--modal-workspace-provider-arg",
                ),
            };
            worker
                .arg(provider_flag)
                .arg(&fixture.node)
                .arg(argument_flag)
                .arg(fixture.root.join("remote-provider.mjs"))
                .env("E2B_API_KEY", "synthetic-e2b-provider-key")
                .env("E2B_DOMAIN", "fixture.e2b.invalid")
                .env("SUPERTAG_E2B_TEMPLATE", "fixture-template");
        }
        worker
    };
    let task = runtime.submit(TAG, mode).await?;
    worker_finished(worker(&runtime, mode).spawn()?, &fixture)
        .await
        .with_context(|| format!("provider: {:?}", fixture.provider_trace()))?;
    let task = runtime
        .assert_success(&task.task_id, mode)
        .await
        .with_context(|| {
            format!(
                "runner: {:?}; provider: {:?}",
                fixture.trace(),
                fixture.provider_trace()
            )
        })?;

    // The read-only copy was read and refused a write; the Volume is unchanged.
    ensure!(
        fixture
            .trace()?
            .iter()
            .any(|entry| entry["type"] == "copy" && entry["mode"] == mode)
    );
    assert!(!read_only.join("denied.txt").exists());
    assert_eq!(
        std::fs::read_to_string(read_only.join("rows.csv"))?,
        "a,b\n1,2\n"
    );
    // Changed and created files of the read-write copy reached its Volume.
    let volume = |key: &str| -> Option<String> {
        match read_write {
            ReadWrite::File => std::fs::read_to_string(file_rw.join(key)).ok(),
            ReadWrite::S3 => store.get(key),
        }
    };
    assert_eq!(volume("rows.csv").as_deref(), Some("x\ny\n"));
    assert_eq!(volume("created/new.txt").as_deref(), Some("created\n"));
    assert_eq!(volume("kept.txt").as_deref(), Some("kept\n"));
    let [attempt] = task.workspace_mount_writes.as_slice() else {
        anyhow::bail!("one Attempt's mount writes expected: {task:?}");
    };
    let [write] = attempt.writes.as_slice() else {
        anyhow::bail!("one read-write copy expected: {attempt:?}");
    };
    assert_eq!(write.volume_id, "data-rw");
    assert_eq!(write.status, WorkspaceMountWriteStatus::Complete as i32);
    let mut keys: Vec<_> = write.files.iter().map(|file| file.key.as_str()).collect();
    keys.sort_unstable();
    assert_eq!(keys, ["created/new.txt", "rows.csv"]);
    assert_eq!(write.skipped, 1, "kept.txt is unchanged");
    // The host copies are gone after the Attempt.
    assert_eq!(std::fs::read_dir(&root)?.count(), 0);

    if provider.is_some() {
        let trace = fixture.provider_trace()?;
        let staged: Vec<_> = trace
            .iter()
            .filter(|entry| entry["type"] == "stage-copy")
            .map(|entry| {
                (
                    entry["path"]
                        .as_str()
                        .unwrap_or_default()
                        .rsplit('/')
                        .next()
                        .map(str::to_owned),
                    entry["readWrite"].as_bool(),
                    entry["keys"].clone(),
                    entry["directories"].clone(),
                )
            })
            .collect();
        assert_eq!(
            staged,
            [
                (
                    Some("ro".into()),
                    Some(false),
                    json!(["back\\slash.txt", "nested/notes.txt", "rows.csv"]),
                    json!(["empty"]),
                ),
                (
                    Some("rw".into()),
                    Some(true),
                    json!(["kept.txt", "rows.csv"]),
                    json!([]),
                ),
            ],
            "{trace:?}"
        );
        let captured: Vec<_> = trace
            .iter()
            .filter(|entry| entry["type"] == "capture-copy")
            .collect();
        assert_eq!(captured.len(), 1, "only the read-write copy is captured");
        assert_eq!(captured[0]["keys"], json!(["created/new.txt", "rows.csv"]));
        assert_eq!(captured[0]["skipped"], "1");
        assert_eq!(
            captured[0]["maxBytes"],
            supertag_protocol::workspace_mounts::DEFAULT_WORKSPACE_MOUNT_BYTES.to_string()
        );
        // The sandbox's own copy holds the odd name and the empty directory.
        let sandboxes = fixture.root.join("remote-allocations");
        let allocations = std::fs::read_dir(&sandboxes)?.collect::<std::io::Result<Vec<_>>>()?;
        let [allocation] = allocations.as_slice() else {
            anyhow::bail!("one sandbox expected");
        };
        let copy_root = allocation.path().join("checkout").join(
            captured[0]["path"]
                .as_str()
                .context("copy path")?
                .rsplit_once('/')
                .context("copy root")?
                .0,
        );
        assert!(copy_root.join("ro/empty").is_dir());
        assert_eq!(
            std::fs::read_to_string(copy_root.join("ro/back\\slash.txt"))?,
            "odd\n"
        );
        // The returned tree never carries a copy.
        let capture = trace
            .iter()
            .find(|entry| entry["type"] == "capture")
            .context("capture missing")?;
        assert!(
            capture["paths"]
                .as_array()
                .context("paths")?
                .iter()
                .all(|path| !path.as_str().unwrap_or_default().starts_with("volumes/"))
        );
        // No Volume location or key reaches the provider, its environment, or
        // anything the sandbox holds.
        let mut files = vec![];
        sandbox_files(&sandboxes, &mut files)?;
        let mut seen = serde_json::to_string(&trace)?;
        for file in files {
            seen.push_str(&String::from_utf8_lossy(&std::fs::read(file)?));
        }
        for leaked in [
            read_only.to_str().context("path")?,
            file_rw.to_str().context("path")?,
            "copy-bucket",
            S3_ACCESS_KEY,
            S3_SECRET,
            S3_TOKEN,
            "WSCOPY",
        ] {
            assert!(!seen.contains(leaked), "{leaked} reached the provider");
        }
        assert!(
            task.workspace_delivery
                .as_ref()
                .is_none_or(|delivery| delivery.changed_files == 0)
        );

        // A provider that returns the copies in the tree fails the Attempt
        // before anything is written back.
        if read_write == ReadWrite::File {
            std::fs::write(fixture.root.join("return-copy"), b"fixture")?;
            std::fs::write(file_rw.join("rows.csv"), "x\n")?;
            std::fs::remove_dir_all(file_rw.join("created"))?;
            // A fresh Session, so the Harness starts as it did the first time.
            let leak = runtime
                .operator
                .submit_task(credentials.request(SubmitTaskRequest {
                    tag_id: TAG.into(),
                    session_id: "cursor-copy-leak".into(),
                    operation_id: Uuid::new_v4().to_string(),
                    prompt: format!("fixture:{mode}"),
                    ..Default::default()
                })?)
                .await?
                .into_inner();
            timeout(
                WAIT,
                worker(&runtime, "return-copy").spawn()?.wait_with_output(),
            )
            .await??;
            let leak = runtime.task(&leak.task_id).await?;
            assert_eq!(leak.state(), TaskState::Failed);
            assert!(
                leak.workspace_mount_writes
                    .iter()
                    .all(|attempt| attempt.writes.is_empty())
            );
            // The fixture did return the copies, and the Host never listed them.
            let trace = fixture.provider_trace()?;
            let returned = trace
                .iter()
                .rev()
                .find(|entry| entry["type"] == "capture")
                .context("capture missing")?;
            assert!(
                returned["paths"]
                    .as_array()
                    .context("paths")?
                    .iter()
                    .any(|path| path.as_str().unwrap_or_default().starts_with("volumes/")),
                "{trace:?}"
            );
            assert_eq!(
                trace
                    .iter()
                    .filter(|entry| entry["type"] == "capture-copy")
                    .count(),
                1
            );
            assert!(leak.workspace_delivery.is_none());
            assert_eq!(std::fs::read_to_string(file_rw.join("rows.csv"))?, "x\n");
            assert!(!file_rw.join("created").exists());
            assert_eq!(std::fs::read_dir(&root)?.count(), 0);
            sandbox_files(&sandboxes, &mut vec![])?;
        }
    }
    runtime.stop().await?;
    Ok(())
}

database_tests! {
    #[tokio::test]
    cursor_local_workspace_copies_are_read_and_written_back;
    #[tokio::test]
    cursor_e2b_workspace_copies_are_staged_and_written_back;
    #[tokio::test]
    cursor_modal_workspace_copies_are_staged_and_written_back;
    #[tokio::test]
    cursor_e2b_s3_workspace_copies_keep_their_keys_on_the_host;
}

async fn cursor_local_workspace_copies_are_read_and_written_back(database: String) -> Result<()> {
    Box::pin(contract(None, ReadWrite::File, &database)).await
}

async fn cursor_e2b_workspace_copies_are_staged_and_written_back(database: String) -> Result<()> {
    Box::pin(contract(
        Some(RemoteWorkspace::E2b),
        ReadWrite::File,
        &database,
    ))
    .await
}

async fn cursor_modal_workspace_copies_are_staged_and_written_back(database: String) -> Result<()> {
    Box::pin(contract(
        Some(RemoteWorkspace::Modal),
        ReadWrite::File,
        &database,
    ))
    .await
}

async fn cursor_e2b_s3_workspace_copies_keep_their_keys_on_the_host(
    database: String,
) -> Result<()> {
    Box::pin(contract(
        Some(RemoteWorkspace::E2b),
        ReadWrite::S3,
        &database,
    ))
    .await
}
