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
const PREFIX: &str = "/evidence-bucket/teams/core/tags/";

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

/// What an S3 test double keeps for a capture uploaded straight from a Worker Host.
#[derive(Default)]
struct Bucket {
    objects: std::collections::BTreeMap<String, (Vec<u8>, String)>,
    presigned_puts: usize,
    heads: usize,
    gets: usize,
    presigned_gets: usize,
    deletes: usize,
    refused: usize,
    /// Answer an upload with success but keep nothing, as a store that lost it.
    lose_uploads: bool,
}

/// RFC 3986 encoding, as SigV4 canonicalizes query values.
fn sigv4_encode(value: &str) -> String {
    value
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

fn sigv4_signature(date: &str, to_sign: &str) -> Option<String> {
    let mut key = format!("AWS4{SECRET}").into_bytes();
    for input in [date, "auto", "s3", "aws4_request", to_sign] {
        let mut mac = Hmac::<Sha256>::new_from_slice(&key).ok()?;
        mac.update(input.as_bytes());
        key = mac.finalize().into_bytes().to_vec();
    }
    Some(key.iter().map(|b| format!("{b:02x}")).collect())
}

/// A presigned PUT, checked as S3 checks it: the query signature over the signed headers with an
/// unsigned payload, then the body against the signed length and SHA-256 checksum.
fn presigned_put_is_valid(path: &str, query: &str, headers: &HeaderMap, body: &[u8]) -> bool {
    presigned_is_valid(Method::PUT, path, query, headers, body)
}

/// A presigned GET: the query signature over the host header, with an unsigned payload.
fn presigned_get_is_valid(path: &str, query: &str, headers: &HeaderMap) -> bool {
    presigned_is_valid(Method::GET, path, query, headers, &[])
}

fn presigned_is_valid(
    method: Method,
    path: &str,
    query: &str,
    headers: &HeaderMap,
    body: &[u8],
) -> bool {
    let put = method == Method::PUT;
    let check = || -> Option<bool> {
        let params: std::collections::BTreeMap<String, String> =
            url::form_urlencoded::parse(query.as_bytes())
                .map(|(k, v)| (k.into_owned(), v.into_owned()))
                .collect();
        let signed = params.get("X-Amz-SignedHeaders")?;
        let names: Vec<&str> = signed.split(';').collect();
        let required: &[&str] = if put {
            &[
                "content-length",
                "host",
                "if-none-match",
                "x-amz-checksum-sha256",
            ]
        } else {
            &["host"]
        };
        for required in required {
            if !names.contains(required) {
                return Some(false);
            }
        }
        let credential = params.get("X-Amz-Credential")?;
        let (access_key, scope) = credential.split_once('/')?;
        let date = scope.split('/').next()?;
        if access_key != KEY
            || params.get("X-Amz-Algorithm")? != "AWS4-HMAC-SHA256"
            || params.get("X-Amz-Security-Token")? != TOKEN
        {
            return Some(false);
        }
        let canonical_query = params
            .iter()
            .filter(|(k, _)| *k != "X-Amz-Signature")
            .map(|(k, v)| format!("{}={}", sigv4_encode(k), sigv4_encode(v)))
            .collect::<Vec<_>>()
            .join("&");
        let get = |name: &str| headers.get(name)?.to_str().ok();
        let mut canonical_headers = String::new();
        for name in &names {
            canonical_headers.push_str(&format!("{name}:{}\n", get(name)?.trim()));
        }
        let canonical = format!(
            "{method}\n{path}\n{canonical_query}\n{canonical_headers}\n{signed}\nUNSIGNED-PAYLOAD"
        );
        let to_sign = format!(
            "AWS4-HMAC-SHA256\n{}\n{scope}\n{:x}",
            params.get("X-Amz-Date")?,
            Sha256::digest(canonical)
        );
        let checksum = base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            Sha256::digest(body),
        );
        Some(
            params.get("X-Amz-Signature")? == &sigv4_signature(date, &to_sign)?
                && (!put
                    || (get("content-length")? == body.len().to_string()
                        && get("x-amz-checksum-sha256")? == checksum)),
        )
    };
    check().unwrap_or(false)
}

async fn bucket(
    State(state): State<Arc<Mutex<Bucket>>>,
    request: axum::http::Request<Body>,
) -> Response {
    let (request, body) = request.into_parts();
    let path = request.uri.path().to_owned();
    let Ok(bytes) = to_bytes(body, 1024 * 1024).await else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let mut bucket = state.lock().unwrap();
    if !path.starts_with(PREFIX) {
        bucket.refused += 1;
        return StatusCode::FORBIDDEN.into_response();
    }
    match (&request.method, request.uri.query()) {
        (&Method::PUT, Some(query)) => {
            if !presigned_put_is_valid(&path, query, &request.headers, &bytes) {
                bucket.refused += 1;
                return StatusCode::BAD_REQUEST.into_response();
            }
            bucket.presigned_puts += 1;
            if bucket.objects.contains_key(&path) {
                return StatusCode::PRECONDITION_FAILED.into_response();
            }
            if !bucket.lose_uploads {
                let checksum = request.headers["x-amz-checksum-sha256"]
                    .to_str()
                    .unwrap()
                    .to_owned();
                bucket.objects.insert(path, (bytes.to_vec(), checksum));
            }
            StatusCode::OK.into_response()
        }
        (&Method::GET, Some(query)) => {
            if !presigned_get_is_valid(&path, query, &request.headers) {
                bucket.refused += 1;
                return StatusCode::BAD_REQUEST.into_response();
            }
            bucket.presigned_gets += 1;
            match bucket.objects.get(&path) {
                Some((bytes, _)) => (StatusCode::OK, bytes.clone()).into_response(),
                None => StatusCode::NOT_FOUND.into_response(),
            }
        }
        (&Method::DELETE, None)
            if signature_is_valid(&request.method, &path, &request.headers, &[]) =>
        {
            bucket.deletes += 1;
            bucket.objects.remove(&path);
            StatusCode::NO_CONTENT.into_response()
        }
        (&Method::HEAD | &Method::GET, None)
            if signature_is_valid(&request.method, &path, &request.headers, &[])
                && (request.method == Method::GET
                    || request
                        .headers
                        .get("x-amz-checksum-mode")
                        .is_some_and(|mode| mode == "ENABLED")) =>
        {
            let head = request.method == Method::HEAD;
            if head {
                bucket.heads += 1;
            } else {
                bucket.gets += 1;
            }
            match bucket.objects.get(&path) {
                Some((bytes, checksum)) if head => (
                    StatusCode::OK,
                    [
                        ("content-length", bytes.len().to_string()),
                        ("x-amz-checksum-sha256", checksum.clone()),
                    ],
                )
                    .into_response(),
                Some((bytes, _)) => (StatusCode::OK, bytes.clone()).into_response(),
                None => StatusCode::NOT_FOUND.into_response(),
            }
        }
        _ => {
            bucket.refused += 1;
            StatusCode::FORBIDDEN.into_response()
        }
    }
}

database_tests! {
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    s3_capture_copy_is_uploaded_by_the_host_with_a_presigned_put;
}

/// Stores the S3 Volume's signing credential in the Control Plane's vault in `root`, as an
/// operator does with `supertag volume credential set`.
async fn store_credential(credentials: &Credentials, root: &Path, endpoint: &str) -> Result<()> {
    let mut command = credentials.command(&[
        "volume",
        "credential",
        "set",
        "object",
        "--endpoint",
        endpoint,
        "--region",
        "auto",
    ]);
    command
        .env("SUPERTAG_STATE_DIR", root)
        .env("SUPERTAG_VOLUME_ACCESS_KEY_ID", KEY)
        .env("SUPERTAG_VOLUME_SECRET_ACCESS_KEY", SECRET)
        .env("SUPERTAG_VOLUME_SESSION_TOKEN", TOKEN);
    let stored = json(command).await?;
    ensure!(stored["credential"] == "stored", "{stored}");
    Ok(())
}

async fn s3_capture_copy_is_uploaded_by_the_host_with_a_presigned_put(
    database: String,
) -> Result<()> {
    let state = Arc::new(Mutex::new(Bucket::default()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let endpoint = format!("http://{}", listener.local_addr()?);
    let server = tokio::spawn(
        axum::serve(
            listener,
            Router::new().fallback(bucket).with_state(state.clone()),
        )
        .into_future(),
    );
    let temporary = tempfile::tempdir()?;
    let root = temporary.path().canonicalize()?;
    let credentials = Credentials::new();
    store_credential(&credentials, &root, &endpoint).await?;
    let (mut control, public) = service(plane(&credentials, &root, &database)).await?;
    json(volume(
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
    // An S3 Volume needs no host mapping: the reservation carries a presigned PUT.
    let (artifact_id, bytes, _blob, mut held) =
        capture(&credentials, &public, Some("object"), None).await?;
    {
        let bucket = state.lock().unwrap();
        assert_eq!(bucket.objects.len(), 1);
        let (path, (stored, _)) = bucket.objects.iter().next().unwrap();
        assert_eq!(stored, &bytes);
        assert!(
            path.starts_with(&format!(
                "/evidence-bucket/teams/core/tags/{:x}/attempts/",
                Sha256::digest("writer")
            )),
            "{path}"
        );
        // The host uploaded once; the Control Plane checked with a HEAD and read no bytes.
        assert_eq!(
            (bucket.presigned_puts, bucket.gets, bucket.refused),
            (1, 0, 0)
        );
        assert!(bucket.heads >= 1);
    }
    held.disconnect();
    drop(held);
    after_the_producer(&credentials, &public, &state, &artifact_id, &bytes).await?;
    stop(&mut control).await?;

    // Without its credential in the vault the Control Plane cannot sign, and the capture fails.
    let unsigned_root = tempfile::tempdir()?;
    let unsigned_root = unsigned_root.path().canonicalize()?;
    let unsigned_database = format!(
        "sqlite://{}?mode=rwc",
        unsigned_root.join("store.db").display()
    );
    let (mut unsigned_plane, unsigned_public) =
        service(plane(&credentials, &unsigned_root, &unsigned_database)).await?;
    json(volume(
        &credentials,
        &unsigned_public,
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
    let unsigned = capture(&credentials, &unsigned_public, Some("object"), None)
        .await
        .err()
        .context("a capture committed without a signed copy")?;
    ensure!(
        format!("{unsigned:#}").contains("supertag volume credential set object"),
        "{unsigned:#}"
    );
    stop(&mut unsigned_plane).await?;

    // A store that loses the upload fails the capture at its commit.
    let other = tempfile::tempdir()?;
    let other_root = other.path().canonicalize()?;
    let other_database = format!(
        "sqlite://{}?mode=rwc",
        other_root.join("store.db").display()
    );
    {
        let mut bucket = state.lock().unwrap();
        bucket.objects.clear();
        bucket.lose_uploads = true;
    }
    store_credential(&credentials, &other_root, &endpoint).await?;
    let (mut lossy, lossy_public) =
        service(plane(&credentials, &other_root, &other_database)).await?;
    json(volume(
        &credentials,
        &lossy_public,
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
    let failed = capture(&credentials, &lossy_public, Some("object"), None)
        .await
        .err()
        .context("a capture whose upload was lost committed")?;
    ensure!(
        format!("{failed:#}").contains("does not hold the captured bytes"),
        "{failed:#}"
    );
    stop(&mut lossy).await?;
    server.abort();
    Ok(())
}

/// Sends a presigned S3 request exactly as granted.
async fn presigned(
    method: reqwest::Method,
    grant: &VolumeObjectGrant,
    body: Option<Vec<u8>>,
) -> Result<reqwest::Response> {
    let upload = grant
        .presigned
        .as_ref()
        .context("the grant is not presigned")?;
    let mut request = reqwest::Client::new().request(method, &upload.url);
    for header in &upload.headers {
        request = request.header(&header.name, &header.value);
    }
    if let Some(body) = body {
        request = request.body(body);
    }
    Ok(request.send().await?)
}

/// With the producing host gone, a later turn reads the capture back from the S3 Volume through a
/// presigned GET, keeps its Session checkpoint there through a presigned PUT, and once a turn
/// drops that checkpoint the Control Plane deletes its object.
async fn after_the_producer(
    credentials: &Credentials,
    public: &str,
    state: &Arc<Mutex<Bucket>>,
    artifact_id: &str,
    bytes: &[u8],
) -> Result<()> {
    let channel =
        protocol::negotiated(Channel::from_shared(public.to_owned())?.connect().await?).await?;
    let mut host = worker_host_client::WorkerHostClient::new(channel.clone());
    let mut artifacts = attempt_artifacts_client::AttemptArtifactsClient::new(channel.clone());
    let mut objects = volume_objects_client::VolumeObjectsClient::new(channel.clone());
    let generation = host
        .register_host(authenticated_request(
            RegisterHostRequest {
                incarnation_id: "volume-reader".into(),
            },
            &credentials.host,
            None,
        )?)
        .await?
        .into_inner()
        .generation;
    let reader = turn(credentials, &channel, generation, "read", None).await?;
    let acquisition = artifacts
        .acquire(credentials.host(
            AcquireArtifactRequest {
                attempt: Some(reader.clone()),
                operation_id: "acquire".into(),
                artifact_id: artifact_id.into(),
                paths: vec!["report.txt".into()],
                delivery: ArtifactDelivery::Read as i32,
                destination: None,
            },
            generation,
        ))
        .await?
        .into_inner();
    let file = objects
        .grant(credentials.host(
            VolumeObjectGrantRequest {
                attempt: Some(reader.clone()),
                purpose: VolumeObjectPurpose::AcquiredFile as i32,
                access: VolumeAccess::Read as i32,
                acquisition_id: acquisition.acquisition_id,
                path: "report.txt".into(),
                native_memory_blob: None,
            },
            generation,
        ))
        .await?
        .into_inner();
    let read = presigned(reqwest::Method::GET, &file, None).await?;
    ensure!(read.status().is_success(), "{}", read.status());
    ensure!(read.bytes().await? == bytes);

    // The turn keeps its checkpoint on the Volume.
    let payload = b"session checkpoint on the Volume".to_vec();
    let reference = CheckpointReference {
        harness: "codex".into(),
        format: "codex-session-v1".into(),
        byte_length: payload.len() as u64,
        sha256: format!("{:x}", Sha256::digest(&payload)),
    };
    let checkpoint = CommitCheckpointRequest {
        attempt: Some(reader.clone()),
        reference: Some(reference.clone()),
    };
    host.reserve_checkpoint(credentials.host(checkpoint.clone(), generation))
        .await?;
    let written = objects
        .grant(credentials.host(
            VolumeObjectGrantRequest {
                attempt: Some(reader.clone()),
                purpose: VolumeObjectPurpose::SessionCheckpoint as i32,
                access: VolumeAccess::Write as i32,
                ..Default::default()
            },
            generation,
        ))
        .await?
        .into_inner();
    let put = presigned(reqwest::Method::PUT, &written, Some(payload.clone())).await?;
    ensure!(put.status().is_success(), "{}", put.status());
    let object = format!("/evidence-bucket/teams/core/{}", written.key);
    ensure!(object.ends_with(&format!("/checkpoint/{}.bin", reference.sha256)));
    ensure!(state.lock().unwrap().objects.contains_key(&object));
    host.commit_checkpoint(credentials.host(checkpoint, generation))
        .await?;
    let finish = |attempt: &InspectAttemptRequest, checkpoint: Option<String>| {
        credentials.host(
            FinishTaskRequest {
                task_id: attempt.task_id.clone(),
                attempt_id: attempt.attempt_id.clone(),
                lease_token: attempt.lease_token.clone(),
                succeeded: true,
                result: "Done".into(),
                checkpoint_sha256: checkpoint,
                ..Default::default()
            },
            generation,
        )
    };
    host.finish_task(finish(&reader, Some(reference.sha256.clone())))
        .await?;

    // The next turn reads it back, then ends without one: the Session's checkpoint is dropped and
    // the Control Plane deletes its object.
    let next = turn(credentials, &channel, generation, "next", None).await?;
    let resumed = objects
        .grant(credentials.host(
            VolumeObjectGrantRequest {
                attempt: Some(next.clone()),
                purpose: VolumeObjectPurpose::SessionCheckpoint as i32,
                access: VolumeAccess::Read as i32,
                ..Default::default()
            },
            generation,
        ))
        .await?
        .into_inner();
    ensure!(resumed.key == written.key);
    let back = presigned(reqwest::Method::GET, &resumed, None).await?;
    ensure!(back.bytes().await? == payload);
    host.finish_task(finish(&next, None)).await?;
    let deadline = tokio::time::Instant::now() + WAIT;
    while state.lock().unwrap().objects.contains_key(&object) {
        ensure!(
            tokio::time::Instant::now() < deadline,
            "the dropped checkpoint's object was never deleted"
        );
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    let bucket = state.lock().unwrap();
    ensure!(bucket.deletes == 1 && bucket.presigned_gets == 2 && bucket.refused == 0);
    Ok(())
}
