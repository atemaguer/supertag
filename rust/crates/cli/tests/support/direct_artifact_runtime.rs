use super::*;
use std::os::unix::fs::PermissionsExt;
use supertag_protocol::{
    authenticated_request,
    v2::{
        BlobReference, WorkerArtifactDownloadRequest,
        worker_artifact_transfers_client::WorkerArtifactTransfersClient,
    },
};
use tonic::transport::{Certificate, ClientTlsConfig, Endpoint};

async fn enroll(
    credentials: &Credentials,
    gateway: &str,
    id: &str,
    directory: &Path,
) -> Result<()> {
    let issued = json(credentials.operator(
        &["auth-key", "create", id, "--host", id, "--tag", "builder"],
        gateway,
    ))
    .await?;
    let key_path = directory.with_extension("key");
    std::fs::write(&key_path, field(&issued, "auth_key")?)?;
    std::fs::set_permissions(&key_path, std::fs::Permissions::from_mode(0o600))?;
    let mut enroll = credentials.command(&["host", "enroll", id, "--gateway", gateway]);
    enroll
        .arg("--state-directory")
        .arg(directory)
        .arg("--auth-key")
        .arg(format!("file:{}", key_path.display()));
    assert_eq!(json(enroll).await?["host_id"], id);
    std::fs::remove_file(key_path)?;
    Ok(())
}

async fn peer_certificate(root: &Path) -> Result<(std::path::PathBuf, std::path::PathBuf)> {
    let config = root.join("peer-tls.cnf");
    let key = root.join("peer.key");
    let cert = root.join("peer.pem");
    std::fs::write(
        &config,
        "[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=127.0.0.1\n[ext]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\n",
    )?;
    let mut openssl = Command::new("openssl");
    openssl
        .args([
            "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-config",
        ])
        .arg(config)
        .arg("-keyout")
        .arg(&key)
        .arg("-out")
        .arg(&cert);
    success(openssl).await?;
    Ok((cert, key))
}

database_tests! {
    #[tokio::test]
    enrolled_worker_hosts_transfer_exact_artifacts_after_cas_loss_and_producer_restart;
}

async fn enrolled_worker_hosts_transfer_exact_artifacts_after_cas_loss_and_producer_restart(
    database: String,
) -> Result<()> {
    let temporary = tempfile::tempdir()?;
    let root = temporary.path().canonicalize()?;
    let repository = root.join("source");
    std::fs::create_dir(&repository)?;
    git(&repository, &["init", "--quiet"]).await?;
    std::fs::write(repository.join("workspace.txt"), "base\n")?;
    git(&repository, &["add", "workspace.txt"]).await?;
    git(&repository, &["commit", "--quiet", "-m", "base"]).await?;
    let base = git(&repository, &["rev-parse", "HEAD"]).await?;
    let credentials = Credentials::new();
    let mut control = credentials.command(&["control-plane"]);
    control.env("SUPERTAG_DATABASE_URL", &database);
    let (mut control, private) = service(control).await?;
    let cas = root.join("cas");
    let mut gateway = credentials.command(&["gateway", "--control-plane", &private]);
    gateway.arg("--checkpoint-directory").arg(&cas);
    let (mut gateway, public) = service(gateway).await?;
    json(credentials.operator(
        &[
            "tag",
            "put",
            "builder",
            "--instructions",
            "Produce and read exact evidence",
            "--allow",
            "files:read",
            "--allow",
            "files:write",
            "--workspace-id",
            "project",
            "--workspace-base",
            &base,
        ],
        &public,
    ))
    .await?;
    let producer_state = root.join("producer");
    let consumer_state = root.join("consumer");
    enroll(&credentials, &public, "direct-producer", &producer_state).await?;
    enroll(&credentials, &public, "direct-consumer", &consumer_state).await?;
    let storage = root.join("durable");
    std::fs::create_dir(&storage)?;
    std::fs::set_permissions(&storage, std::fs::Permissions::from_mode(0o700))?;
    let reserve = std::net::TcpListener::bind("127.0.0.1:0")?;
    let listen = reserve.local_addr()?.to_string();
    drop(reserve);
    let peer = format!("https://{listen}");
    let (cert, key) = peer_certificate(&root).await?;
    let producer = |once: bool| {
        let mut command =
            credentials.command(&["worker-host", "--gateway", &public, "--adapter", ADAPTER]);
        command
            .env_remove("SUPERTAG_HOST_TOKEN")
            .arg("--state-directory")
            .arg(&producer_state)
            .args(["--workspace-id", "project", "--workspace-source"])
            .arg(&repository)
            .arg("--adapter-arg=--artifact-acquisition-fixture")
            .args([
                "--artifact-transfer-listen",
                &listen,
                "--artifact-source-directory",
            ])
            .arg(&storage)
            .arg("--artifact-transfer-tls-cert")
            .arg(&cert)
            .arg("--artifact-transfer-tls-key")
            .arg(&key);
        if once {
            command.arg("--once");
        }
        command
    };
    let submit = |text| {
        credentials.operator(
            &[
                "task",
                "submit",
                "--tag",
                "builder",
                "--session",
                "evidence",
                text,
            ],
            &public,
        )
    };
    let submitted = json(submit("produce")).await?;
    success(producer(true)).await?;
    let task = json(credentials.operator(&["get", "task", field(&submitted, "task_id")?], &public))
        .await?;
    assert_eq!(task["state"], "TASK_STATE_SUCCEEDED", "{task}");
    let artifact = field(&task, "result")?
        .strip_prefix("artifact:")
        .context("producer receipt")?;
    let attempt = field(&task, "attempt_id")?;
    let bytes = b"immutable evidence\n";
    let digest = format!("{:x}", Sha256::digest(bytes));
    let direct_copy = storage
        .join(format!("attempt-{:x}", Sha256::digest(attempt.as_bytes())))
        .join(&digest);
    assert_eq!(std::fs::read(&direct_copy)?, bytes);
    let storage_id = std::fs::read_to_string(storage.join("storage-id"))?;
    let removed = cas.join(&digest);
    std::fs::remove_file(&removed)?;
    let private_digest = format!("{:x}", Sha256::digest(b"separate private file\n"));
    std::fs::remove_file(cas.join(private_digest))?;

    json(credentials.command(&["host", "--gateway", &public, "drain", "direct-producer"])).await?;
    let mut restarting = producer(false);
    restarting.stdout(Stdio::piped());
    let mut producer = restarting.spawn()?;
    let mut ready = BufReader::new(producer.stdout.take().context("source host stdout")?);
    let mut line = String::new();
    timeout(WAIT, ready.read_line(&mut line)).await??;
    assert_eq!(line.trim(), "ready");
    assert_eq!(
        std::fs::read_to_string(storage.join("storage-id"))?,
        storage_id
    );

    // The peer endpoint alone cannot authorize a read.
    let direct = Endpoint::from_shared(peer.clone())?
        .tls_config(
            ClientTlsConfig::new().ca_certificate(Certificate::from_pem(std::fs::read(&cert)?)),
        )?
        .connect()
        .await?;
    let mut direct = WorkerArtifactTransfersClient::new(direct);
    let refused = direct
        .download(authenticated_request(
            WorkerArtifactDownloadRequest {
                artifact_id: artifact.into(),
                path: "evidence.txt".into(),
                blob: Some(BlobReference {
                    sha256: digest.clone(),
                    byte_length: bytes.len() as u64,
                }),
            },
            &"0".repeat(64),
            None,
        )?)
        .await
        .unwrap_err();
    assert_eq!(refused.code(), tonic::Code::PermissionDenied);

    let submitted = json(submit("consume")).await?;
    let mut consumer = credentials.worker_with_mode(
        &public,
        &consumer_state,
        Some(&repository),
        "--artifact-acquisition-fixture",
    );
    consumer
        .env_remove("SUPERTAG_HOST_TOKEN")
        .arg("--artifact-peer")
        .arg(format!("direct-producer={peer}"))
        .arg("--artifact-peer-ca-file")
        .arg(&cert);
    success(consumer).await?;
    let task = json(credentials.operator(&["get", "task", field(&submitted, "task_id")?], &public))
        .await?;
    assert_eq!(task["state"], "TASK_STATE_SUCCEEDED", "{task}");
    let derived = field(&task, "result")?
        .strip_prefix("derived:")
        .context("consumer receipt")?;
    let metadata =
        json(credentials.command(&["get", "--gateway", &public, "artifact", derived])).await?;
    assert_eq!(
        metadata["inputs"],
        serde_json::json!([{"artifact_id":artifact,"paths":["evidence.txt"]}])
    );
    assert!(!removed.exists());
    assert_eq!(std::fs::read(&direct_copy)?, bytes);
    producer.kill().await?;
    gateway.kill().await?;
    control.kill().await?;
    Ok(())
}
