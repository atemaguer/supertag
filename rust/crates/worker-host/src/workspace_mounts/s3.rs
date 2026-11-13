//! A minimal S3 client for Workspace Volume copies. The Worker Host owner
//! maps a Volume's credential name to an endpoint, a region and the names of
//! the environment variables that hold its keys. Keys never leave this
//! process: Tasks see only the staged copy.
use anyhow::{Context, Result, bail, ensure};
use aws_credential_types::Credentials;
use aws_sigv4::{
    http_request::{
        PayloadChecksumKind, PercentEncodingMode, SignableBody, SignableRequest, SigningSettings,
        UriPathNormalizationMode, sign,
    },
    sign::v4,
};
use reqwest::{Client, Method, RequestBuilder, StatusCode, Url, header};
use sha2::{Digest, Sha256};
use std::{io::Write, time::Duration, time::SystemTime};
use supertag_protocol::volumes::s3_volume_source;

const HTTP_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_LIST_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone)]
pub(super) struct S3Source {
    bucket: String,
    prefix: String,
    endpoint: Url,
    region: String,
    credentials: Credentials,
    client: Client,
}

pub(super) struct Listed {
    pub(super) key: String,
    pub(super) size: u64,
}

impl S3Source {
    pub(super) fn configure(
        source: &str,
        endpoint: &str,
        region: &str,
        credential_env_prefix: &str,
        variable: impl Fn(&str) -> Option<String>,
    ) -> Result<Self> {
        let (bucket, prefix) = s3_volume_source(source)?;
        ensure!(
            !region.is_empty()
                && region.len() <= 64
                && region
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'),
            "invalid S3 Workspace Volume region"
        );
        ensure!(
            !credential_env_prefix.is_empty()
                && credential_env_prefix.len() <= 64
                && credential_env_prefix.as_bytes()[0].is_ascii_uppercase()
                && credential_env_prefix
                    .bytes()
                    .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_'),
            "invalid S3 Workspace Volume credential environment prefix"
        );
        let env = |suffix: &str| variable(&format!("{credential_env_prefix}_{suffix}"));
        let key = env("ACCESS_KEY_ID").context("S3 Workspace Volume access key is missing")?;
        let secret =
            env("SECRET_ACCESS_KEY").context("S3 Workspace Volume secret key is missing")?;
        let token = env("SESSION_TOKEN");
        let secret_ok = |value: &str| {
            !value.is_empty() && value.len() <= 8192 && value.bytes().all(|b| b.is_ascii_graphic())
        };
        ensure!(
            !key.is_empty()
                && key.len() <= 128
                && key
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
                && secret_ok(&secret)
                && token.as_deref().is_none_or(secret_ok),
            "invalid S3 Workspace Volume credential"
        );
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .timeout(HTTP_TIMEOUT)
            .build()
            .map_err(|_| anyhow::anyhow!("could not initialize the S3 Workspace Volume client"))?;
        Ok(Self {
            bucket: bucket.into(),
            prefix: prefix.into(),
            endpoint: endpoint_url(endpoint)?,
            region: region.into(),
            credentials: Credentials::new(key, secret, token, None, "supertag-workspace-volume"),
            client,
        })
    }

    fn request(
        &self,
        method: Method,
        url: Url,
        payload_sha256: Option<(&str, u64)>,
    ) -> Result<RequestBuilder> {
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
        let length = payload_sha256.map(|(_, length)| length.to_string());
        let mut headers = vec![("accept-encoding", "identity")];
        if let Some(length) = &length {
            headers.push(("content-length", length));
        }
        let payload = match payload_sha256 {
            Some((sha256, _)) => SignableBody::Precomputed(sha256.into()),
            None => SignableBody::Bytes(&[]),
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

    fn object_url(&self, key: &str) -> Result<Url> {
        ensure!(
            object_key(key),
            "unsupported S3 Workspace Volume object key"
        );
        let mut url = self.endpoint.clone();
        url.set_path(&format!("/{}/{}/{key}", self.bucket, self.prefix));
        Ok(url)
    }

    /// Every object under the prefix, as keys relative to it. Listing stops
    /// with an error once more than `limit` objects are found.
    pub(super) async fn list(&self, limit: usize) -> Result<Vec<Listed>> {
        let mut objects = Vec::new();
        let mut continuation: Option<String> = None;
        let base = format!("{}/", self.prefix);
        loop {
            let mut url = self.endpoint.clone();
            url.set_path(&format!("/{}", self.bucket));
            {
                let mut query = url.query_pairs_mut();
                if let Some(token) = &continuation {
                    query.append_pair("continuation-token", token);
                }
                query.append_pair("list-type", "2");
                query.append_pair("prefix", &base);
            }
            let response = self
                .request(Method::GET, url, None)?
                .send()
                .await
                .map_err(|_| anyhow::anyhow!("S3 Workspace Volume listing failed"))?;
            ensure!(
                response.status() == StatusCode::OK,
                "S3 Workspace Volume listing was refused"
            );
            let body = bounded(response, MAX_LIST_BYTES).await?;
            let body = std::str::from_utf8(&body).context("invalid S3 listing")?;
            for contents in elements(body, "Contents") {
                let key = text(contents, "Key").context("invalid S3 listing")?;
                let size: u64 = text(contents, "Size")
                    .and_then(|size| size.parse().ok())
                    .context("invalid S3 listing")?;
                let relative = key
                    .strip_prefix(&base)
                    .context("S3 listing returned a key outside the Volume")?;
                // A zero-byte key ending in `/` is a console folder marker.
                if relative.is_empty() || (relative.ends_with('/') && size == 0) {
                    continue;
                }
                ensure!(
                    object_key(relative),
                    "S3 Workspace Volume holds an unsupported object key"
                );
                objects.push(Listed {
                    key: relative.into(),
                    size,
                });
                ensure!(
                    objects.len() <= limit,
                    "S3 Workspace Volume exceeds its entry limit"
                );
            }
            match text(body, "IsTruncated").as_deref() {
                Some("true") => {
                    let next = text(body, "NextContinuationToken")
                        .filter(|token| !token.is_empty() && token.len() <= 1024)
                        .context("invalid S3 listing continuation")?;
                    ensure!(
                        continuation.as_deref() != Some(&next),
                        "S3 listing did not advance"
                    );
                    continuation = Some(next);
                }
                Some("false") | None => break,
                Some(_) => bail!("invalid S3 listing"),
            }
        }
        objects.sort_unstable_by(|a, b| a.key.cmp(&b.key));
        Ok(objects)
    }

    /// Stream one object into `output`, refusing any length but `size`.
    /// Returns the SHA-256 of the bytes written.
    pub(super) async fn read(
        &self,
        key: &str,
        size: u64,
        output: &mut std::fs::File,
        cancel: &tokio_util::sync::CancellationToken,
    ) -> Result<String> {
        let mut response = self
            .request(Method::GET, self.object_url(key)?, None)?
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("S3 Workspace Volume read failed"))?;
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
                    .is_none_or(|length| length == size),
            "S3 Workspace Volume read did not return the listed object"
        );
        let mut hash = Sha256::new();
        let mut total = 0u64;
        while let Some(bytes) = response
            .chunk()
            .await
            .map_err(|_| anyhow::anyhow!("S3 Workspace Volume read failed"))?
        {
            ensure!(!cancel.is_cancelled(), "Workspace copy cancelled");
            total += bytes.len() as u64;
            ensure!(total <= size, "S3 Workspace Volume object changed");
            hash.update(&bytes);
            output.write_all(&bytes)?;
        }
        ensure!(total == size, "S3 Workspace Volume object changed");
        Ok(format!("{:x}", hash.finalize()))
    }

    /// Replace one object with `bytes`, whose SHA-256 the caller computed.
    pub(super) async fn write(&self, key: &str, bytes: Vec<u8>, sha256: &str) -> Result<()> {
        let length = bytes.len() as u64;
        let response = self
            .request(Method::PUT, self.object_url(key)?, Some((sha256, length)))?
            .body(bytes)
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("S3 Workspace Volume write failed"))?;
        ensure!(
            response.status() == StatusCode::OK,
            "S3 Workspace Volume write was refused"
        );
        Ok(())
    }
}

/// Object keys are copied to and written from local paths, so each part is
/// a plain name SigV4 and the filesystem agree on.
pub(super) fn object_key(key: &str) -> bool {
    supertag_protocol::workspace_mounts::volume_key(key)
        && key.split('/').all(|part| {
            part.bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~'))
        })
}

fn endpoint_url(value: &str) -> Result<Url> {
    let invalid =
        || anyhow::anyhow!("S3 Workspace Volume endpoint must be a canonical HTTPS origin");
    let parsed = Url::parse(value).map_err(|_| invalid())?;
    let loopback_http = cfg!(test)
        && parsed.scheme() == "http"
        && parsed.host_str().is_some_and(|host| {
            host.trim_matches(['[', ']'])
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
        });
    if !(parsed.scheme() == "https" || loopback_http)
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

async fn bounded(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>> {
    let mut body = Vec::new();
    while let Some(bytes) = response
        .chunk()
        .await
        .map_err(|_| anyhow::anyhow!("S3 Workspace Volume listing failed"))?
    {
        ensure!(body.len() + bytes.len() <= limit, "S3 listing is too large");
        body.extend_from_slice(&bytes);
    }
    Ok(body)
}

/// The bodies of every `<name>` element, outermost first.
fn elements<'a>(xml: &'a str, name: &str) -> Vec<&'a str> {
    let open = format!("<{name}>");
    let close = format!("</{name}>");
    let mut found = Vec::new();
    let mut rest = xml;
    while let Some(start) = rest.find(&open) {
        let after = &rest[start + open.len()..];
        let Some(end) = after.find(&close) else {
            break;
        };
        found.push(&after[..end]);
        rest = &after[end + close.len()..];
    }
    found
}

/// The unescaped text of the first `<name>` element.
fn text(xml: &str, name: &str) -> Option<String> {
    let raw = elements(xml, name).into_iter().next()?;
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(index) = rest.find('&') {
        out.push_str(&rest[..index]);
        let tail = &rest[index..];
        let (entity, length) = [
            ("&amp;", '&'),
            ("&lt;", '<'),
            ("&gt;", '>'),
            ("&quot;", '"'),
            ("&apos;", '\''),
        ]
        .into_iter()
        .find_map(|(entity, value)| tail.starts_with(entity).then_some((value, entity.len())))?;
        out.push(entity);
        rest = &tail[length..];
    }
    out.push_str(rest);
    Some(out)
}

fn signing_error() -> anyhow::Error {
    anyhow::anyhow!("S3 Workspace Volume request could not be signed")
}

#[cfg(test)]
pub(super) mod fake {
    //! A loopback S3 store that lists in pages of two, checks that requests
    //! are signed with the mapped key, and records writes.
    use axum::{
        Router,
        body::Bytes,
        extract::{Query, State},
        http::{HeaderMap, StatusCode, Uri},
        response::IntoResponse,
        routing::get,
    };
    use std::{
        collections::{BTreeMap, HashMap},
        sync::{Arc, Mutex},
    };

    #[derive(Clone, Default)]
    pub(crate) struct Store {
        pub(crate) objects: Arc<Mutex<BTreeMap<String, Vec<u8>>>>,
        pub(crate) fail_puts: Arc<Mutex<Vec<String>>>,
    }

    fn signed(headers: &HeaderMap) -> bool {
        headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| {
                value.starts_with("AWS4-HMAC-SHA256 Credential=FIXTUREKEY/")
                    && value.contains("/us-east-1/s3/aws4_request")
            })
    }

    async fn list(
        State(store): State<Store>,
        headers: HeaderMap,
        Query(query): Query<HashMap<String, String>>,
    ) -> impl IntoResponse {
        if !signed(&headers) || query.get("list-type").map(String::as_str) != Some("2") {
            return (StatusCode::FORBIDDEN, String::new());
        }
        let prefix = query.get("prefix").cloned().unwrap_or_default();
        let start: usize = query
            .get("continuation-token")
            .and_then(|token| token.strip_prefix("page-"))
            .and_then(|page| page.parse().ok())
            .unwrap_or(0);
        let objects = store.objects.lock().unwrap();
        let keys: Vec<_> = objects
            .iter()
            .filter(|(key, _)| key.starts_with(&format!("bucket-a/{prefix}")))
            .collect();
        let page: Vec<_> = keys.iter().skip(start).take(2).collect();
        let truncated = start + 2 < keys.len();
        let mut body = String::from("<ListBucketResult>");
        for (key, bytes) in page {
            body.push_str(&format!(
                "<Contents><Key>{}</Key><Size>{}</Size><ETag>&quot;x&quot;</ETag></Contents>",
                key.strip_prefix("bucket-a/").unwrap(),
                bytes.len()
            ));
        }
        body.push_str(&format!("<IsTruncated>{truncated}</IsTruncated>"));
        if truncated {
            body.push_str(&format!(
                "<NextContinuationToken>page-{}</NextContinuationToken>",
                start + 2
            ));
        }
        body.push_str("</ListBucketResult>");
        (StatusCode::OK, body)
    }

    async fn object(
        State(store): State<Store>,
        method: axum::http::Method,
        headers: HeaderMap,
        uri: Uri,
        body: Bytes,
    ) -> impl IntoResponse {
        if !signed(&headers) {
            return (StatusCode::FORBIDDEN, Vec::new());
        }
        let path = uri.path().trim_start_matches('/').to_owned();
        if method == axum::http::Method::PUT {
            use sha2::Digest;
            let declared = headers
                .get("x-amz-content-sha256")
                .and_then(|value| value.to_str().ok());
            if declared != Some(&format!("{:x}", sha2::Sha256::digest(&body))) {
                return (StatusCode::BAD_REQUEST, Vec::new());
            }
            if store.fail_puts.lock().unwrap().contains(&path) {
                return (StatusCode::INTERNAL_SERVER_ERROR, Vec::new());
            }
            store.objects.lock().unwrap().insert(path, body.to_vec());
            return (StatusCode::OK, Vec::new());
        }
        match store.objects.lock().unwrap().get(&path) {
            Some(bytes) => (StatusCode::OK, bytes.clone()),
            None => (StatusCode::NOT_FOUND, Vec::new()),
        }
    }

    pub(crate) async fn start(store: Store) -> String {
        let app = Router::new()
            .route("/bucket-a", get(list))
            .fallback(object)
            .with_state(store);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{address}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listing_text_is_unescaped_and_keys_are_plain() {
        assert_eq!(
            text("<a><Key>x&amp;y&lt;</Key></a>", "Key").as_deref(),
            Some("x&y<")
        );
        assert_eq!(text("<Key>a&bogus;</Key>", "Key"), None);
        assert_eq!(elements("<C>1</C><C>2</C>", "C"), ["1", "2"]);
        assert!(object_key("reports/2026/a.csv"));
        for key in ["a b", "a/../b", ".git/x", "a/.supertag-x", "a%2f", "é"] {
            assert!(!object_key(key), "{key}");
        }
    }

    #[test]
    fn mappings_need_an_https_origin_and_mapped_keys() {
        let env = |name: &str| match name {
            "DATA_ACCESS_KEY_ID" => Some("FIXTUREKEY".to_owned()),
            "DATA_SECRET_ACCESS_KEY" => Some("secret".to_owned()),
            _ => None,
        };
        let configure = |endpoint: &str, prefix: &str| {
            S3Source::configure("s3://bucket-a/data", endpoint, "us-east-1", prefix, env)
        };
        assert!(configure("https://s3.example.com", "DATA").is_ok());
        assert!(configure("http://127.0.0.1:9000", "DATA").is_ok());
        for endpoint in [
            "http://s3.example.com",
            "https://user@s3.example.com",
            "https://s3.example.com/path",
            "https://s3.example.com?x=1",
        ] {
            assert!(configure(endpoint, "DATA").is_err(), "{endpoint}");
        }
        assert!(configure("https://s3.example.com", "OTHER").is_err());
        assert!(configure("https://s3.example.com", "lower").is_err());
    }
}
