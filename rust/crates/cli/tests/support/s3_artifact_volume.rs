use super::*;
use axum::{
    Router,
    body::{Body, to_bytes},
    extract::State,
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
};
use hmac::{Hmac, Mac};
use std::sync::{Arc, Mutex};

const KEY: &str = "testVolumeKey";
const SECRET: &str = "fixture-only-private-key";
const TOKEN: &str = "fixture-only-sts-token";
const SOURCE: &str = "s3://evidence-bucket/teams/core";
const PREFIX: &str = "/evidence-bucket/teams/core/attempts/";

#[derive(Default)]
struct Object {
    path: String,
    bytes: Option<Vec<u8>>,
    reads: usize,
    writes: usize,
    invalid_requests: usize,
    put_result: Option<StatusCode>,
    competing_write: Option<Vec<u8>>,
    redirect: Option<String>,
}

fn signature_is_valid(method: &Method, path: &str, headers: &HeaderMap, bytes: &[u8]) -> bool {
    let get = |name: &str| headers.get(name)?.to_str().ok();
    let verify = || -> Option<bool> {
        let signature = get("authorization")?.strip_prefix("AWS4-HMAC-SHA256 Credential=")?;
        let (credential, remainder) = signature.split_once(", SignedHeaders=")?;
        let (signed, signature) = remainder.split_once(", Signature=")?;
        let (access_key, scope) = credential.split_once('/')?;
        let (date, service_scope) = scope.split_once('/')?;
        let timestamp = get("x-amz-date")?;
        let payload = get("x-amz-content-sha256")?;
        if access_key != KEY
            || service_scope != "auto/s3/aws4_request"
            || !timestamp.starts_with(date)
            || payload != format!("{:x}", Sha256::digest(bytes))
            || get("x-amz-security-token")? != TOKEN
        {
            return Some(false);
        }
        let signed_names: Vec<_> = signed.split(';').collect();
        for required in ["host", "x-amz-date", "x-amz-security-token"] {
            if !signed_names.contains(&required) {
                return Some(false);
            }
        }
        if *method == Method::PUT
            && (!signed_names.contains(&"if-none-match") || get("if-none-match")? != "*")
        {
            return Some(false);
        }
        let mut canonical_headers = String::new();
        for name in signed_names {
            canonical_headers.push_str(&format!("{name}:{}\n", get(name)?.trim()));
        }
        let canonical = format!("{method}\n{path}\n\n{canonical_headers}\n{signed}\n{payload}");
        let to_sign = format!(
            "AWS4-HMAC-SHA256\n{timestamp}\n{scope}\n{:x}",
            Sha256::digest(canonical)
        );
        let mut key = format!("AWS4{SECRET}").into_bytes();
        for input in [date, "auto", "s3", "aws4_request", &to_sign] {
            let mut mac = Hmac::<Sha256>::new_from_slice(&key).ok()?;
            mac.update(input.as_bytes());
            key = mac.finalize().into_bytes().to_vec();
        }
        Some(signature == key.iter().map(|b| format!("{b:02x}")).collect::<String>())
    };
    verify().unwrap_or(false)
}

async fn object(
    State(state): State<Arc<Mutex<Object>>>,
    request: axum::http::Request<Body>,
) -> Response {
    let (request, body) = request.into_parts();
    let path = request.uri.path();
    let Ok(bytes) = to_bytes(body, 1024 * 1024).await else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let mut object = state.lock().unwrap();
    if request.uri.query().is_some()
        || !path.starts_with(PREFIX)
        || (!object.path.is_empty() && object.path != path)
        || !signature_is_valid(&request.method, path, &request.headers, &bytes)
    {
        object.invalid_requests += 1;
        return StatusCode::FORBIDDEN.into_response();
    }
    object.path = path.to_owned();
    match request.method {
        Method::GET => {
            object.reads += 1;
            if let Some(location) = &object.redirect {
                return (
                    StatusCode::TEMPORARY_REDIRECT,
                    [("location", location.clone())],
                )
                    .into_response();
            }
            match &object.bytes {
                Some(bytes) => (
                    StatusCode::OK,
                    [("etag", "\"not-a-sha256\"")],
                    bytes.clone(),
                )
                    .into_response(),
                None => StatusCode::NOT_FOUND.into_response(),
            }
        }
        Method::PUT => {
            object.writes += 1;
            if object.bytes.is_some() {
                return StatusCode::PRECONDITION_FAILED.into_response();
            }
            if let Some(other) = object.competing_write.take() {
                object.bytes = Some(other);
                return StatusCode::PRECONDITION_FAILED.into_response();
            }
            object.bytes = Some(bytes.to_vec());
            object.put_result.unwrap_or(StatusCode::OK).into_response()
        }
        _ => StatusCode::METHOD_NOT_ALLOWED.into_response(),
    }
}

fn mapped_gateway(
    credentials: &Credentials,
    root: &Path,
    private: &str,
    endpoint: &str,
    source: &str,
) -> Result<Command> {
    let config = root.join("s3-volumes.json");
    std::fs::write(
        &config,
        serde_json::to_vec(&serde_json::json!([{
            "volumeId": "object",
            "source": source,
            "endpoint": endpoint,
            "region": "auto",
            "credentialEnvPrefix": "VOLUME_TEST"
        }]))?,
    )?;
    let mut command = gateway(credentials, root, private, false);
    command
        .arg("--artifact-volume")
        .arg(format!("aaa-file={}", root.join("volume").display()))
        .arg("--artifact-s3-volumes")
        .arg(config)
        .env("VOLUME_TEST_ACCESS_KEY_ID", KEY)
        .env("VOLUME_TEST_SECRET_ACCESS_KEY", SECRET)
        .env("VOLUME_TEST_SESSION_TOKEN", TOKEN)
        .env("AWS_ACCESS_KEY_ID", "ignored-ambient-key")
        .env("AWS_SECRET_ACCESS_KEY", "ignored-ambient-secret");
    Ok(command)
}

async fn refused(mut command: Command, reason: &str) -> Result<()> {
    let result = timeout(WAIT, command.output()).await??;
    let error = String::from_utf8_lossy(&result.stderr);
    ensure!(
        !result.status.success() && error.contains(reason),
        "{error}"
    );
    for secret in [KEY, SECRET, TOKEN] {
        assert!(!error.contains(secret));
    }
    Ok(())
}

database_tests! {
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    s3_volume_copy_checks_mapping_sigv4_and_immutable_readback;
}

async fn s3_volume_copy_checks_mapping_sigv4_and_immutable_readback(
    database: String,
) -> Result<()> {
    let object_state = Arc::new(Mutex::new(Object {
        // A provider can persist the write and lose its successful response.
        put_result: Some(StatusCode::SERVICE_UNAVAILABLE),
        ..Default::default()
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let endpoint = format!("http://{}", listener.local_addr()?);
    let server = tokio::spawn(
        axum::serve(
            listener,
            Router::new()
                .fallback(object)
                .with_state(object_state.clone()),
        )
        .into_future(),
    );

    let temporary = tempfile::tempdir()?;
    let root = temporary.path().canonicalize()?;
    let volume_path = root.join("volume");
    std::fs::create_dir(&volume_path)?;
    std::fs::set_permissions(&volume_path, std::fs::Permissions::from_mode(0o700))?;
    let credentials = Credentials::new();
    let (mut control, private) = service(plane(&credentials, &database, "127.0.0.1:0")).await?;
    let (mut ingress, public) = service(mapped_gateway(
        &credentials,
        &root,
        &private,
        &endpoint,
        "s3://evidence-bucket/wrong-prefix",
    )?)
    .await?;
    let (artifact_id, bytes, blob) = capture(&credentials, &public).await?;
    let registered = json(volume(
        &credentials,
        &public,
        &[
            "put",
            "object",
            "--source",
            SOURCE,
            "--operation-id",
            "register-object",
        ],
    ))
    .await?;
    assert_eq!(registered["source"], SOURCE);
    let copy_args = [
        "copy",
        "object",
        &artifact_id,
        "--path",
        "report.txt",
        "--expected-revision",
        "1",
        "--operation-id",
        "copy-object",
    ];
    refused(volume(&credentials, &public, &copy_args), "consent").await?;
    assert_eq!(object_state.lock().unwrap().reads, 0);
    assert!(
        json(volume(&credentials, &public, &["copies"])).await?["copies"]
            .as_array()
            .unwrap()
            .is_empty()
    );

    stop(&mut ingress).await?;
    let (mut ingress, public) = service(mapped_gateway(
        &credentials,
        &root,
        &private,
        &endpoint,
        SOURCE,
    )?)
    .await?;
    let divergence = vec![b'x'; bytes.len()];
    object_state.lock().unwrap().competing_write = Some(divergence.clone());
    refused(volume(&credentials, &public, &copy_args), "verified").await?;
    let pending = json(volume(&credentials, &public, &["copies"])).await?;
    let pending = &pending["copies"][0];
    assert_eq!(pending["state"], "ARTIFACT_VOLUME_COPY_STATE_RESERVED");
    {
        let mut state = object_state.lock().unwrap();
        assert_eq!(state.bytes.as_ref(), Some(&divergence));
        state.bytes = None;
    }
    let receipt = json(volume(&credentials, &public, &copy_args)).await?;
    assert_eq!(receipt["copy_id"], pending["copy_id"]);
    assert_eq!(receipt["state"], "ARTIFACT_VOLUME_COPY_STATE_VERIFIED");
    {
        let state = object_state.lock().unwrap();
        assert_eq!(
            state.path,
            format!(
                "/evidence-bucket/teams/core/{}",
                receipt["storage_key"].as_str().unwrap()
            )
        );
        assert_eq!(state.bytes.as_ref(), Some(&bytes));
        assert_eq!(
            (state.reads, state.writes, state.invalid_requests),
            (4, 2, 0)
        );
    }

    json(volume(
        &credentials,
        &public,
        &[
            "put",
            "aaa-file",
            "--source",
            &format!("file://{}", volume_path.display()),
            "--operation-id",
            "register-file",
        ],
    ))
    .await?;
    let file_copy = json(volume(
        &credentials,
        &public,
        &[
            "copy",
            "aaa-file",
            &artifact_id,
            "--path",
            "report.txt",
            "--expected-revision",
            "1",
            "--operation-id",
            "copy-file",
        ],
    ))
    .await?;
    let file_path = volume_path.join(file_copy["storage_key"].as_str().unwrap());
    let output = root.join("downloaded.txt");
    json(capture_download(
        &credentials,
        &public,
        &artifact_id,
        &output,
    ))
    .await?;
    assert_eq!(std::fs::read(&output)?, bytes);
    std::fs::remove_file(&output)?;
    assert_eq!(object_state.lock().unwrap().reads, 4);
    // A bad first candidate cannot shadow the independently verified later copy.
    std::fs::write(&file_path, &divergence)?;
    stop(&mut ingress).await?;
    stop(&mut control).await?;
    std::fs::remove_file(root.join("cas").join(&blob.sha256))?;
    let (mut control, private) = service(plane(&credentials, &database, "127.0.0.1:0")).await?;
    let (mut ingress, public) = service(mapped_gateway(
        &credentials,
        &root,
        &private,
        &endpoint,
        SOURCE,
    )?)
    .await?;
    assert_eq!(
        json(volume(&credentials, &public, &copy_args)).await?,
        receipt
    );
    let copy_id = receipt["copy_id"].as_str().unwrap();
    let download = ["download", copy_id, "--output", output.to_str().unwrap()];
    let downloaded = json(volume(&credentials, &public, &download)).await?;
    assert_eq!(downloaded["sha256"], blob.sha256);
    assert_eq!(std::fs::read(&output)?, bytes);
    std::fs::remove_file(&output)?;

    json(capture_download(
        &credentials,
        &public,
        &artifact_id,
        &output,
    ))
    .await?;
    assert_eq!(std::fs::read(&output)?, bytes);
    std::fs::remove_file(&output)?;
    read_dynamic(&credentials, &public, &artifact_id, &bytes).await?;
    assert!(!root.join("cas").join(&blob.sha256).exists());
    assert_eq!(std::fs::read(&file_path)?, divergence);

    object_state.lock().unwrap().bytes = Some(vec![b'x'; bytes.len()]);
    refused(
        capture_download(&credentials, &public, &artifact_id, &output),
        "no usable verified Volume copy",
    )
    .await?;
    refused(volume(&credentials, &public, &download), "verified").await?;
    assert!(!output.exists());
    refused(volume(&credentials, &public, &copy_args), "verified").await?;
    object_state.lock().unwrap().bytes = None;
    refused(volume(&credentials, &public, &copy_args), "verified").await?;
    object_state.lock().unwrap().redirect = Some(format!("{endpoint}/outside"));
    refused(volume(&credentials, &public, &download), "verified").await?;
    {
        let state = object_state.lock().unwrap();
        assert_eq!((state.writes, state.invalid_requests), (2, 0));
    }
    stop(&mut ingress).await?;
    stop(&mut control).await?;
    server.abort();
    Ok(())
}
