//! Canonical, credential-free file Volume metadata.
use std::path::{Component, PathBuf};
use tonic::Status;
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
