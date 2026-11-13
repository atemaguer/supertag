//! Canonical, credential-free Volume metadata.
use std::path::{Component, PathBuf};
use tonic::Status;

pub fn validate_volume_source(source: &str) -> Result<(), Status> {
    if source.starts_with("s3://") {
        s3_volume_source(source).map(|_| ())
    } else {
        file_volume_path(source).map(|_| ())
    }
}

/// S3 registration identifies only the bucket and prefix. The Gateway mapping
/// supplies the endpoint and credentials independently.
pub fn s3_volume_source(source: &str) -> Result<(&str, &str), Status> {
    let invalid = || Status::invalid_argument("S3 Volume requires a canonical s3://bucket/prefix");
    let (bucket, prefix) = source
        .strip_prefix("s3://")
        .and_then(|value| value.split_once('/'))
        .ok_or_else(invalid)?;
    if !(3..=63).contains(&bucket.len())
        || bucket.parse::<std::net::IpAddr>().is_ok()
        || bucket.contains("..")
        || !bucket.as_bytes()[0].is_ascii_alphanumeric()
        || !bucket.as_bytes()[bucket.len() - 1].is_ascii_alphanumeric()
        || !bucket.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'.')
        })
        || prefix.len() > 768
        || prefix.split('/').any(|part| {
            matches!(part, "" | "." | "..")
                || !part.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~')
                })
        })
    {
        return Err(invalid());
    }
    Ok((bucket, prefix))
}
pub fn file_volume_path(source: &str) -> Result<PathBuf, Status> {
    let invalid = || {
        Status::invalid_argument(
            "Volume source must be a canonical absolute file URL without credentials, query, or fragment",
        )
    };
    if source.len() > 4096 {
        return Err(invalid());
    }
    let url = url::Url::parse(source).map_err(|_| invalid())?;
    if url.scheme() != "file"
        || url.host_str().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid());
    }
    let path = url.to_file_path().map_err(|_| invalid())?;
    if path
        .to_str()
        .is_none_or(|value| value.chars().any(char::is_control))
        || !path.is_absolute()
        || path.components().count() < 2
        || path
            .components()
            .any(|c| !matches!(c, Component::RootDir | Component::Normal(_)))
    {
        return Err(invalid());
    }
    let normalized: PathBuf = path.components().collect();
    if url::Url::from_file_path(&normalized)
        .map_err(|_| invalid())?
        .as_str()
        != source
    {
        return Err(invalid());
    }
    Ok(normalized)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn s3_volume_source_is_exact_and_credential_free() {
        let source = "s3://artifacts.example/objectives/team-a_1";
        assert_eq!(
            s3_volume_source(source).unwrap(),
            ("artifacts.example", "objectives/team-a_1")
        );
        assert!(validate_volume_source(source).is_ok());
        for source in [
            "s3://artifacts.example",
            "s3://artifacts.example/",
            "s3://127.0.0.1/evidence",
            "s3://Artifacts/evidence",
            "s3://ar..tifacts/evidence",
            "s3://user:password@artifacts/evidence",
            "s3://artifacts/evidence?signature=abc",
            "s3://artifacts/evidence#fragment",
            "s3://artifacts/evidence/..",
            "s3://artifacts/evidence//extra",
            "s3://artifacts/evidence/%2e",
        ] {
            assert!(validate_volume_source(source).is_err(), "{source}");
        }
    }
}
