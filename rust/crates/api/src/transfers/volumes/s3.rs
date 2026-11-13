use super::*;
use aws_credential_types::Credentials;
use aws_sigv4::{
    http_request::{
        PayloadChecksumKind, PercentEncodingMode, SignableBody, SignableRequest, SigningSettings,
        UriPathNormalizationMode, sign,
    },
    sign::v4,
};
use reqwest::{Body, Client, Method, RequestBuilder, StatusCode, Url, header};
use serde::Deserialize;
use std::{io::SeekFrom, time::SystemTime};
use supertag_protocol::volumes::s3_volume_source;
use tokio::io::AsyncSeekExt;
use tokio_util::io::ReaderStream;

const MAX_CONFIG_BYTES: u64 = 64 * 1024;
const HTTP_TIMEOUT: Duration = Duration::from_secs(25);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Config {
    volume_id: String,
    source: String,
    endpoint: String,
    region: String,
    credential_env_prefix: String,
}

#[derive(Clone)]
pub(super) struct S3Mapping {
    pub(super) source: String,
    endpoint: Url,
    region: String,
    credentials: Credentials,
    client: Client,
}

pub(super) fn load(path: &Path) -> Result<BTreeMap<String, S3Mapping>> {
    let mut bytes = Vec::new();
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(path)
        .context("open S3 Volume configuration")?;
    ensure!(
        file.metadata()?.is_file(),
        "S3 Volume configuration must be a file"
    );
    file.take(MAX_CONFIG_BYTES + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= MAX_CONFIG_BYTES,
        "S3 Volume configuration is too large"
    );
    let entries: Vec<Config> = serde_json::from_slice(&bytes)
        .map_err(|_| anyhow::anyhow!("invalid S3 Volume configuration"))?;
    configure(entries, |name| match std::env::var(name) {
        Ok(value) => Ok(Some(value)),
        Err(std::env::VarError::NotPresent) => Ok(None),
        Err(_) => anyhow::bail!("invalid S3 Volume credential environment"),
    })
}

fn configure(
    entries: Vec<Config>,
    credential: impl Fn(&str) -> Result<Option<String>>,
) -> Result<BTreeMap<String, S3Mapping>> {
    ensure!(entries.len() <= 64, "too many S3 Volume mappings");
    let client = Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .connect_timeout(Duration::from_secs(5))
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|_| anyhow::anyhow!("could not initialize S3 Volume HTTP client"))?;
    let mut mappings: BTreeMap<String, S3Mapping> = BTreeMap::new();
    for entry in entries {
        ensure!(
            !entry.volume_id.is_empty()
                && entry.volume_id.len() <= 128
                && !entry.volume_id.chars().any(char::is_control)
                && !mappings.contains_key(&entry.volume_id),
            "invalid or duplicate S3 Volume mapping"
        );
        let (bucket, prefix) = s3_volume_source(&entry.source)?;
        let endpoint = endpoint(&entry.endpoint)?;
        ensure!(
            !entry.region.is_empty()
                && entry.region.len() <= 64
                && entry
                    .region
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'),
            "invalid S3 Volume region"
        );
        ensure!(
            !entry.credential_env_prefix.is_empty()
                && entry.credential_env_prefix.len() <= 64
                && entry.credential_env_prefix.as_bytes()[0].is_ascii_uppercase()
                && entry
                    .credential_env_prefix
                    .bytes()
                    .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_'),
            "invalid S3 Volume credential environment prefix"
        );
        for prior in mappings.values().filter(|prior| prior.endpoint == endpoint) {
            let (prior_bucket, prior_prefix) = s3_volume_source(&prior.source)?;
            ensure!(
                bucket != prior_bucket
                    || !(within(prefix, prior_prefix) || within(prior_prefix, prefix)),
                "S3 Volume mappings overlap"
            );
        }
        let env = |suffix| credential(&format!("{}_{suffix}", entry.credential_env_prefix));
        let key = env("ACCESS_KEY_ID")?.context("S3 Volume access key is missing")?;
        let secret = env("SECRET_ACCESS_KEY")?.context("S3 Volume secret key is missing")?;
        let token = env("SESSION_TOKEN")?;
        ensure!(
            !key.is_empty()
                && key.len() <= 128
                && key
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
                && valid_secret(&secret)
                && token.as_deref().is_none_or(valid_secret),
            "invalid S3 Volume credential"
        );
        mappings.insert(
            entry.volume_id,
            S3Mapping {
                source: entry.source,
                endpoint,
                region: entry.region,
                credentials: Credentials::new(key, secret, token, None, "supertag-artifact-volume"),
                client: client.clone(),
            },
        );
    }
    Ok(mappings)
}

fn within(path: &str, base: &str) -> bool {
    path == base
        || path
            .strip_prefix(base)
            .is_some_and(|tail| tail.starts_with('/'))
}

fn valid_secret(value: &str) -> bool {
    !value.is_empty() && value.len() <= 8192 && value.bytes().all(|b| b.is_ascii_graphic())
}

fn endpoint(value: &str) -> Result<Url> {
    let invalid = || anyhow::anyhow!("S3 Volume endpoint must be a canonical HTTPS origin");
    let parsed = Url::parse(value).map_err(|_| invalid())?;
    let allowed_http = cfg!(feature = "test-fixtures")
        && parsed.scheme() == "http"
        && parsed.host_str().is_some_and(|host| {
            host.trim_matches(['[', ']'])
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
        });
    if !(parsed.scheme() == "https" || allowed_http)
        || parsed.host().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || parsed.path() != "/"
        || (parsed.as_str() != value && parsed.as_str().strip_suffix('/') != Some(value))
    {
        return Err(invalid());
    }
    Ok(parsed)
}

impl S3Mapping {
    fn request(
        &self,
        method: Method,
        storage_key: &str,
        blob: &BlobReference,
        put: bool,
    ) -> Result<RequestBuilder> {
        key_parts(storage_key, blob)?;
        let (bucket, prefix) = s3_volume_source(&self.source)?;
        let mut url = self.endpoint.clone();
        url.set_path(&format!("/{bucket}/{prefix}/{storage_key}"));
        let identity = self.credentials.clone().into();
        let mut settings = SigningSettings::default();
        settings.percent_encoding_mode = PercentEncodingMode::Single;
        settings.uri_path_normalization_mode = UriPathNormalizationMode::Disabled;
        settings.payload_checksum_kind = PayloadChecksumKind::XAmzSha256;
        let params = v4::SigningParams::builder()
            .identity(&identity)
            .region(&self.region)
            .name("s3")
            .time(SystemTime::now())
            .settings(settings)
            .build()
            .map_err(|_| signing_error())?
            .into();
        let length = blob.byte_length.to_string();
        let mut headers = vec![("accept-encoding", "identity")];
        let payload = if put {
            headers.extend([("if-none-match", "*"), ("content-length", &length)]);
            SignableBody::Precomputed(blob.sha256.clone())
        } else {
            SignableBody::Bytes(&[])
        };
        let signable = SignableRequest::new(
            method.as_str(),
            url.as_str(),
            headers.iter().copied(),
            payload,
        )
        .map_err(|_| signing_error())?;
        // The SDK's signing trace can include the access key identifier.
        let (signed, _) = tracing::dispatcher::with_default(&tracing::Dispatch::none(), || {
            sign(signable, &params)
        })
        .map_err(|_| signing_error())?
        .into_parts();
        let mut request = self.client.request(method, url);
        for (name, value) in headers {
            request = request.header(name, value);
        }
        for (name, value) in signed.headers() {
            let mut value = header::HeaderValue::from_str(value).map_err(|_| signing_error())?;
            if name == "authorization" || name == "x-amz-security-token" {
                value.set_sensitive(true);
            }
            request = request.header(name, value);
        }
        Ok(request)
    }

    pub(super) async fn read(
        &self,
        directory: &Path,
        key: &str,
        blob: &BlobReference,
    ) -> Result<Option<tokio::fs::File>> {
        let mut response = self
            .request(Method::GET, key, blob, false)?
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("S3 Volume read failed"))?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        ensure!(
            response.status() == StatusCode::OK
                && !response.headers().contains_key(header::CONTENT_RANGE)
                && response
                    .headers()
                    .get_all(header::CONTENT_ENCODING)
                    .iter()
                    .all(|value| value == "identity")
                && response
                    .content_length()
                    .is_none_or(|length| length == blob.byte_length),
            "S3 Volume read did not return the exact object"
        );
        let mut staged = StagedBlob::new(directory, blob.clone())?;
        while let Some(bytes) = response
            .chunk()
            .await
            .map_err(|_| anyhow::anyhow!("S3 Volume object read failed"))?
        {
            for chunk in bytes.chunks(CHECKPOINT_CHUNK_BYTES) {
                staged.append(chunk).await?;
            }
        }
        Ok(Some(verified_file(staged).await?))
    }

    pub(super) async fn persist(&self, directory: &Path, copy: &ArtifactVolumeCopy) -> Result<()> {
        let blob = copy
            .file
            .as_ref()
            .and_then(|file| file.blob.as_ref())
            .context("copy has no blob")?;
        let key = &copy.storage_key;
        if self.read(directory, key, blob).await?.is_some() {
            return Ok(());
        }
        ensure!(
            copy.state() == ArtifactVolumeCopyState::Reserved,
            "verified artifact Volume copy is missing"
        );
        let mut source = open_blob(&directory.join(&blob.sha256)).await?;
        let mut staged = StagedBlob::new(directory, blob.clone())?;
        let mut buffer = vec![0; CHECKPOINT_CHUNK_BYTES];
        loop {
            let count = source.read(&mut buffer).await?;
            if count == 0 {
                break;
            }
            staged.append(&buffer[..count]).await?;
        }
        let file = verified_file(staged).await?;
        let body = if blob.byte_length == 0 {
            Body::from(Vec::new())
        } else {
            Body::wrap_stream(ReaderStream::with_capacity(file, CHECKPOINT_CHUNK_BYTES))
        };
        let result = self
            .request(Method::PUT, key, blob, true)?
            .body(body)
            .send()
            .await;
        match result {
            Ok(response)
                if !matches!(
                    response.status(),
                    StatusCode::OK | StatusCode::CONFLICT | StatusCode::PRECONDITION_FAILED
                ) && !response.status().is_server_error() =>
            {
                anyhow::bail!("S3 Volume conditional write was refused")
            }
            _ => {}
        }
        // A lost or contested write is successful only if independent readback proves exact bytes.
        ensure!(
            self.read(directory, key, blob).await?.is_some(),
            "S3 Volume object is missing after the conditional write"
        );
        Ok(())
    }
}

fn signing_error() -> anyhow::Error {
    anyhow::anyhow!("could not sign S3 Volume request")
}

async fn verified_file(mut staged: StagedBlob) -> Result<tokio::fs::File> {
    staged.verify().await?;
    staged.handle.seek(SeekFrom::Start(0)).await?;
    Ok(staged.handle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_cannot_supply_credentials_paths_or_redirect_aliases() {
        assert_eq!(
            endpoint("https://account.r2.cloudflarestorage.com")
                .unwrap()
                .path(),
            "/"
        );
        for url in [
            "https://user:secret@example.test",
            "https://example.test/path",
            "https://example.test/../",
            "https://example.test?secret=hidden",
            "https://example.test/#secret",
            "https://example.test:443",
            "https://EXAMPLE.test",
            "http://example.test",
            "http://localhost:9000",
        ] {
            assert!(endpoint(url).is_err(), "{url}");
        }
        assert_eq!(
            endpoint("http://127.0.0.1:9000").is_ok(),
            cfg!(feature = "test-fixtures")
        );
    }

    #[test]
    fn config_rejects_duplicates_overlap_and_invalid_credential_names() {
        fn config(id: &str, source: &str) -> Config {
            Config {
                volume_id: id.into(),
                source: source.into(),
                endpoint: "https://example.test".into(),
                region: "auto".into(),
                credential_env_prefix: "EXPLICIT".into(),
            }
        }
        fn credentials(name: &str) -> Result<Option<String>> {
            Ok(match name {
                "EXPLICIT_ACCESS_KEY_ID" => Some("testKey".into()),
                "EXPLICIT_SECRET_ACCESS_KEY" => Some("testSecret".into()),
                "EXPLICIT_SESSION_TOKEN" => None,
                _ => panic!("unexpected credential name"),
            })
        }
        let first = || config("first", "s3://evidence-bucket/a/b");
        assert!(
            configure(
                vec![first(), config("first", "s3://evidence-bucket/a/c")],
                credentials,
            )
            .is_err()
        );
        assert!(
            configure(
                vec![first(), config("second", "s3://evidence-bucket/a/b/child")],
                credentials,
            )
            .is_err()
        );
        assert!(
            configure(
                vec![
                    first(),
                    config("second", "s3://evidence-bucket/a/b-different")
                ],
                credentials,
            )
            .is_ok()
        );
        assert!(configure(vec![first()], |_| Ok(None)).is_err());
        let mut invalid = first();
        invalid.credential_env_prefix = "AWS=bad".into();
        assert!(configure(vec![invalid], |_| panic!("invalid env name was used")).is_err());
    }
}
