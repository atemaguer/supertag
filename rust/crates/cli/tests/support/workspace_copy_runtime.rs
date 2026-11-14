//! Workspace Volume copies for Cursor: a local Worker Host and the E2B and Modal
//! provider fixtures. The Worker Host stages each copy on the host, a remote
//! Workspace receives only its files, and read-write changes are written back.
use super::*;
use std::os::unix::fs::PermissionsExt;
use supertag_protocol::v2::{WorkspaceCopyMount, WorkspaceMountWriteStatus};

fn file_url(path: &Path) -> Result<String> {
    Ok(format!(
        "file://{}",
        path.to_str().context("fixture path is not UTF-8")?
    ))
}

async fn contract(provider: Option<RemoteWorkspace>, database: &str) -> Result<()> {
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
    let read_write = fixture.root.join("volume-rw");
    std::fs::create_dir_all(read_only.join("nested"))?;
    std::fs::create_dir_all(&read_write)?;
    std::fs::write(read_only.join("rows.csv"), "a,b\n1,2\n")?;
    std::fs::write(read_only.join("nested/notes.txt"), "notes\n")?;
    std::fs::write(read_write.join("rows.csv"), "x\n")?;
    std::fs::write(read_write.join("kept.txt"), "kept\n")?;
    let root = fixture.root.join("mount-root");
    std::fs::create_dir(&root)?;
    std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700))?;
    let mappings = fixture.root.join("mappings.json");
    std::fs::write(
        &mappings,
        serde_json::to_vec(&json!([
            {"volumeId": "data-ro", "source": file_url(&read_only)?, "destinationRoot": root},
            {"volumeId": "data-rw", "source": file_url(&read_write)?, "destinationRoot": root},
        ]))?,
    )?;

    let credentials = Credentials::new();
    let mut runtime = Runtime::start(&fixture.root, &credentials, database).await?;
    for (id, source) in [("data-ro", &read_only), ("data-rw", &read_write)] {
        let source = file_url(source)?;
        runtime
            .cli(&["workspace-volume", "put", id, "--source", &source])
            .await?;
    }
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
    let task = runtime.submit(TAG, mode).await?;
    let mut worker = runtime.worker_command(&fixture, mode);
    worker
        .arg("--workspace-id")
        .arg(WORKSPACE)
        .arg("--workspace-source")
        .arg(&fixture.source)
        .arg("--workspace-mount-mappings")
        .arg(&mappings);
    if let Some(provider) = provider {
        let (provider_flag, argument_flag) = match provider {
            RemoteWorkspace::E2b => ("--e2b-workspace-provider", "--e2b-workspace-provider-arg"),
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
    worker_finished(worker.spawn()?, &fixture)
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
    assert_eq!(
        std::fs::read_to_string(read_write.join("rows.csv"))?,
        "x\ny\n"
    );
    assert_eq!(
        std::fs::read_to_string(read_write.join("created/new.txt"))?,
        "created\n"
    );
    assert_eq!(
        std::fs::read_to_string(read_write.join("kept.txt"))?,
        "kept\n"
    );
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
                )
            })
            .collect();
        assert_eq!(
            staged,
            [
                (
                    Some("ro".into()),
                    Some(false),
                    json!(["nested/notes.txt", "rows.csv"])
                ),
                (
                    Some("rw".into()),
                    Some(true),
                    json!(["kept.txt", "rows.csv"])
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
        // The returned tree never carries a copy, and no Volume location or
        // credential reaches the provider.
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
        let serialized = serde_json::to_string(&trace)?;
        assert!(!serialized.contains(read_only.to_str().context("path")?));
        assert!(!serialized.contains(read_write.to_str().context("path")?));
        assert!(
            task.workspace_delivery
                .as_ref()
                .is_none_or(|delivery| delivery.changed_files == 0)
        );
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
}

async fn cursor_local_workspace_copies_are_read_and_written_back(database: String) -> Result<()> {
    Box::pin(contract(None, &database)).await
}

async fn cursor_e2b_workspace_copies_are_staged_and_written_back(database: String) -> Result<()> {
    Box::pin(contract(Some(RemoteWorkspace::E2b), &database)).await
}

async fn cursor_modal_workspace_copies_are_staged_and_written_back(database: String) -> Result<()> {
    Box::pin(contract(Some(RemoteWorkspace::Modal), &database)).await
}
