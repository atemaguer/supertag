//! The hosted service image a deployment runs, always pinned by digest.
//!
//! A release publishes its image to the GitHub Container Registry and records the reference,
//! digest included, in the release asset `supertag-hosted-image.txt`, which the release's
//! `SHA256SUMS` lists. `version: X.Y.Z` in the configuration resolves to that reference, so
//! nobody builds or pushes an image to deploy a release. `image:` names any other build.
use anyhow::{Context, Result, bail, ensure};
use sha2::{Digest, Sha256};

use super::config;
use crate::{lifecycle, update};

/// The release asset that holds the image reference.
const ASSET: &str = "supertag-hosted-image.txt";
/// The only repository a release's reference may name.
const OFFICIAL: &str = "ghcr.io/atemaguer/supertag-hosted@sha256:";
const MAX_BYTES: usize = 64 * 1024;

/// The image `image` names, else the official image of release `version`, else of this CLI's
/// release.
pub(crate) async fn resolve(image: Option<&str>, version: Option<&str>) -> Result<String> {
    if let Some(image) = image {
        return Ok(image.to_owned());
    }
    let version = update::normalized(version.unwrap_or(env!("CARGO_PKG_VERSION")))?;
    let base = update::release_url(Some(&version))?;
    let client = update::client()?;
    let reference = fetch(&client, &format!("{base}/{ASSET}")).await?.with_context(|| {
        format!(
            "SuperTag release {version} publishes no hosted image ({base}/{ASSET} was not found). Name a release that does with `version:`, or build the image and name it with `image: REGISTRY/supertag-hosted@sha256:DIGEST`"
        )
    })?;
    let sums = fetch(&client, &format!("{base}/SHA256SUMS"))
        .await?
        .with_context(|| format!("SuperTag release {version} has no SHA256SUMS at {base}"))?;
    official(&reference, &sums)
        .with_context(|| format!("release {version}'s hosted image reference at {base}/{ASSET}"))
}

/// The reference in the asset's bytes, once `SHA256SUMS` lists those bytes and the reference
/// names the official repository by digest.
fn official(asset: &[u8], sums: &[u8]) -> Result<String> {
    let digest = lifecycle::hex(&Sha256::digest(asset));
    let sums = std::str::from_utf8(sums).context("SHA256SUMS is not text")?;
    let listed = sums.lines().any(|line| {
        let mut fields = line.split_whitespace();
        fields.next() == Some(digest.as_str())
            && fields.next().map(|name| name.trim_start_matches('*')) == Some(ASSET)
    });
    ensure!(
        listed,
        "does not match the release's SHA256SUMS; nothing was deployed"
    );
    let reference = std::str::from_utf8(asset).context("is not text")?.trim();
    ensure!(
        reference.starts_with(OFFICIAL) && config::pinned(reference),
        "is not {OFFICIAL}DIGEST; nothing was deployed"
    );
    Ok(reference.to_owned())
}

/// A small release asset's bytes, or `None` when the release has no such asset.
async fn fetch(client: &reqwest::Client, url: &str) -> Result<Option<Vec<u8>>> {
    let failed = || format!("could not download {url}; check your network connection");
    let mut response = client.get(url).send().await.with_context(failed)?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !response.status().is_success() {
        bail!("could not download {url}: HTTP {}", response.status());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.with_context(failed)? {
        bytes.extend_from_slice(&chunk);
        ensure!(bytes.len() <= MAX_BYTES, "{url} is larger than expected");
    }
    Ok(Some(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_release_reference_must_match_its_checksum_and_name_the_official_image() {
        let reference = format!("{OFFICIAL}{}\n", "a".repeat(64));
        let sums = |bytes: &[u8]| {
            format!(
                "{}  supertag-0.4.0-linux-amd64-complete.tar.gz\n{}  {ASSET}\n",
                "0".repeat(64),
                lifecycle::hex(&Sha256::digest(bytes))
            )
        };
        assert_eq!(
            official(reference.as_bytes(), sums(reference.as_bytes()).as_bytes()).unwrap(),
            reference.trim()
        );
        // Bytes the checksums do not list.
        let error = official(reference.as_bytes(), sums(b"other").as_bytes()).unwrap_err();
        assert!(error.to_string().contains("SHA256SUMS"), "{error}");
        // Listed bytes that name another repository, or no digest.
        for other in [
            format!(
                "ghcr.io/someone/supertag-hosted@sha256:{}\n",
                "a".repeat(64)
            ),
            "ghcr.io/atemaguer/supertag-hosted:0.4.0\n".to_owned(),
            format!("{OFFICIAL}short\n"),
        ] {
            let error = official(other.as_bytes(), sums(other.as_bytes()).as_bytes()).unwrap_err();
            assert!(
                error.to_string().contains("nothing was deployed"),
                "{error}"
            );
        }
    }
}
