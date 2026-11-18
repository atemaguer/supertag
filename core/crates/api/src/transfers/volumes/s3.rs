use super::*;
use aws_credential_types::Credentials;
use aws_sigv4::{
    http_request::{
        PayloadChecksumKind, PercentEncodingMode, SignableBody, SignableRequest, SignatureLocation,
        SigningSettings, UriPathNormalizationMode, sign,
    },
    sign::v4,
};
use base64::Engine;
use reqwest::{Client, Method, RequestBuilder, StatusCode, Url, header};
use std::time::SystemTime;
use supertag_protocol::volumes::s3_volume_source;
use supertag_workspaces::artifact_volumes::key_parts;

const HTTP_TIMEOUT: Duration = Duration::from_secs(25);

#[derive(Clone)]
pub(super) struct S3Mapping {
    pub(super) source: String,
    endpoint: Url,
    region: String,
    credentials: Credentials,
    client: Client,
}

impl S3Mapping {
    /// A signer for the S3 Volume at `source` from its vault credential: `endpoint`, `region`,
    /// `access_key_id`, `secret_access_key`, and optionally `session_token`. The endpoint comes
    /// from the credential, chosen by the Control Plane's owner, never from the Volume.
    pub(super) fn from_vault(
        source: &str,
        value: &supertag_credential_vault::CredentialValue,
    ) -> Result<Self> {
        s3_volume_source(source)?;
        let field = |name: &str| value.get(name).map(String::as_str);
        let endpoint = endpoint(field("endpoint").context("S3 Volume endpoint is missing")?)?;
        let region = field("region").context("S3 Volume region is missing")?;
        ensure!(
            !region.is_empty()
                && region.len() <= 64
                && region
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'),
            "invalid S3 Volume region"
        );
        let key = field("access_key_id").context("S3 Volume access key is missing")?;
        let secret = field("secret_access_key").context("S3 Volume secret key is missing")?;
        let token = field("session_token").filter(|token| !token.is_empty());
        ensure!(
            !key.is_empty()
                && key.len() <= 128
                && key
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
                && valid_secret(secret)
                && token.is_none_or(valid_secret),
            "invalid S3 Volume credential"
        );
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .connect_timeout(Duration::from_secs(5))
            .timeout(HTTP_TIMEOUT)
            .build()
            .map_err(|_| anyhow::anyhow!("could not initialize S3 Volume HTTP client"))?;
        Ok(Self {
            source: source.to_owned(),
            endpoint,
            region: region.to_owned(),
            credentials: Credentials::new(
                key,
                secret,
                token.map(str::to_owned),
                None,
                "supertag-volume",
            ),
            client,
        })
    }
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
        if method == Method::HEAD {
            headers.push(("x-amz-checksum-mode", "ENABLED"));
        }
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
}

/// The base64 SHA-256 checksum S3 records and checks for an object, from a receipt's hex digest.
pub(super) fn checksum_sha256(blob: &BlobReference) -> Result<String> {
    ensure!(
        supertag_protocol::valid_sha256(&blob.sha256),
        "invalid artifact digest"
    );
    let raw = (0..32)
        .map(|index| u8::from_str_radix(&blob.sha256[index * 2..index * 2 + 2], 16))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(base64::engine::general_purpose::STANDARD.encode(raw))
}

impl S3Mapping {
    fn object_url(&self, storage_key: &str, blob: &BlobReference) -> Result<Url> {
        key_parts(storage_key, blob)?;
        let (bucket, prefix) = s3_volume_source(&self.source)?;
        let mut url = self.endpoint.clone();
        url.set_path(&format!("/{bucket}/{prefix}/{storage_key}"));
        Ok(url)
    }

    /// A presigned PUT of exactly this object: `content-length`, `x-amz-checksum-sha256`, and
    /// `if-none-match: *` are signed headers, so S3 refuses other bytes, another length, or an
    /// overwrite. The host sends the returned headers unchanged; it never holds credentials.
    pub(super) fn presign_put(
        &self,
        storage_key: &str,
        blob: &BlobReference,
        lifetime: Duration,
    ) -> Result<ArtifactVolumeUpload> {
        let length = blob.byte_length.to_string();
        let checksum = checksum_sha256(blob)?;
        self.presign(
            "PUT",
            storage_key,
            blob,
            lifetime,
            &[
                ("content-length", length.as_str()),
                ("if-none-match", "*"),
                ("x-amz-checksum-sha256", checksum.as_str()),
            ],
        )
    }

    /// A presigned GET of this object. A GET cannot bind a checksum, so the reader verifies the
    /// bytes' length and SHA-256 itself.
    pub(super) fn presign_get(
        &self,
        storage_key: &str,
        blob: &BlobReference,
        lifetime: Duration,
    ) -> Result<ArtifactVolumeUpload> {
        self.presign("GET", storage_key, blob, lifetime, &[])
    }

    fn presign(
        &self,
        method: &str,
        storage_key: &str,
        blob: &BlobReference,
        lifetime: Duration,
        headers: &[(&str, &str)],
    ) -> Result<ArtifactVolumeUpload> {
        let mut url = self.object_url(storage_key, blob)?;
        let identity = self.credentials.clone().into();
        let mut settings = SigningSettings::default();
        settings.percent_encoding_mode = PercentEncodingMode::Single;
        settings.uri_path_normalization_mode = UriPathNormalizationMode::Disabled;
        settings.signature_location = SignatureLocation::QueryParams;
        settings.expires_in = Some(lifetime);
        let now = SystemTime::now();
        let params = v4::SigningParams::builder()
            .identity(&identity)
            .region(&self.region)
            .name("s3")
            .time(now)
            .settings(settings)
            .build()
            .map_err(|_| signing_error())?
            .into();
        let signable = SignableRequest::new(
            method,
            url.as_str(),
            headers.iter().copied(),
            SignableBody::UnsignedPayload,
        )
        .map_err(|_| signing_error())?;
        let (signed, _) = tracing::dispatcher::with_default(&tracing::Dispatch::none(), || {
            sign(signable, &params)
        })
        .map_err(|_| signing_error())?
        .into_parts();
        {
            let mut query = url.query_pairs_mut();
            for (name, value) in signed.params() {
                query.append_pair(name, value);
            }
        }
        let expires = now
            .checked_add(lifetime)
            .and_then(|at| at.duration_since(SystemTime::UNIX_EPOCH).ok())
            .ok_or_else(signing_error)?;
        Ok(ArtifactVolumeUpload {
            url: url.into(),
            headers: headers
                .iter()
                .map(|(name, value)| ArtifactVolumeUploadHeader {
                    name: (*name).into(),
                    value: (*value).into(),
                })
                .collect(),
            expires_at_ms: expires.as_millis() as i64,
        })
    }

    /// Deletes the object at this key; one already gone counts as deleted.
    pub(super) async fn delete(&self, storage_key: &str, blob: &BlobReference) -> Result<()> {
        let response = self
            .request(Method::DELETE, storage_key, blob, false)?
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("S3 Volume delete failed"))?;
        ensure!(
            response.status().is_success() || response.status() == StatusCode::NOT_FOUND,
            "the S3 Volume refused the delete"
        );
        Ok(())
    }

    /// Checks that the object at this key is exactly the receipt's bytes from S3's own record: its
    /// length and the SHA-256 checksum S3 verified when it accepted the upload. No bytes are read.
    pub(super) async fn verify_head(&self, storage_key: &str, blob: &BlobReference) -> Result<()> {
        let response = self
            .request(Method::HEAD, storage_key, blob, false)?
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("S3 Volume check failed"))?;
        ensure!(
            response.status() == StatusCode::OK,
            "the object is not on the S3 Volume"
        );
        let header = |name: &str| {
            response
                .headers()
                .get(name)
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned)
        };
        ensure!(
            header("content-length").as_deref() == Some(blob.byte_length.to_string().as_str()),
            "the S3 Volume object has another length"
        );
        // A store that records no SHA-256 checksum cannot prove the bytes; the copy fails.
        ensure!(
            header("x-amz-checksum-sha256").as_deref() == Some(checksum_sha256(blob)?.as_str()),
            "the S3 Volume object has no matching SHA-256 checksum"
        );
        Ok(())
    }
}

fn signing_error() -> anyhow::Error {
    anyhow::anyhow!("could not sign S3 Volume request")
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
    fn a_vault_credential_needs_every_field_and_a_safe_endpoint() {
        let value = |endpoint: &str| {
            supertag_credential_vault::CredentialValue::from([
                ("endpoint".to_owned(), endpoint.to_owned()),
                ("region".to_owned(), "auto".to_owned()),
                ("access_key_id".to_owned(), "testKey".to_owned()),
                ("secret_access_key".to_owned(), "testSecret".to_owned()),
            ])
        };
        let source = "s3://evidence-bucket/a/b";
        assert!(S3Mapping::from_vault(source, &value("https://example.test")).is_ok());
        assert!(S3Mapping::from_vault(source, &value("https://example.test/path")).is_err());
        assert!(S3Mapping::from_vault("file:///srv/a", &value("https://example.test")).is_err());
        let mut missing = value("https://example.test");
        missing.remove("secret_access_key");
        assert!(S3Mapping::from_vault(source, &missing).is_err());
    }
}
