//! The Control Plane's certificate for `supertag deploy`, issued in this process.
//!
//! A platform host name such as `*.modal.run` cannot get a publicly trusted certificate for
//! SuperTag's own TLS, which runs end to end inside the platform's. So deploy issues a
//! certificate authority and one server certificate from it, gives the certificate and its key
//! to the target's secret store, and writes the authority's public certificate beside the
//! configuration, for every client's `SUPERTAG_SERVER_CA_FILE`.
//!
//! The authority's private key is dropped once the server certificate is signed. Nothing can
//! issue another certificate that clients would trust, and no secret store has to guard a key
//! whose only later use would be a renewal. The cost: renewing, or naming another host, issues a
//! new authority, and every client needs the new file. The certificate is therefore long-lived.
use std::{io::Write as _, os::unix::fs::OpenOptionsExt as _, path::Path};

use anyhow::{Context, Result, ensure};

/// How long a generated certificate and its authority are valid.
const VALID_DAYS: i64 = 5 * 365;
const HOSTS: &str = "hosts: ";
const EXPIRES: &str = "expires: ";
const BEGIN: &str = "-----BEGIN ";

/// A new authority's public certificate, and the server certificate and key it issued.
pub(crate) struct Issued {
    pub ca: String,
    pub certificate: String,
    pub key: String,
}

/// Issues an authority and a server certificate naming `names`: DNS names and IP addresses.
/// The authority's key does not leave this function.
pub(crate) fn issue(names: &[String]) -> Result<Issued> {
    ensure!(!names.is_empty(), "a certificate needs a host name");
    let now = time::OffsetDateTime::now_utc();
    let validity = |params: &mut rcgen::CertificateParams| {
        params.not_before = now - time::Duration::hours(1);
        params.not_after = now + time::Duration::days(VALID_DAYS);
    };
    let authority_key = rcgen::KeyPair::generate().context("generate the authority's key")?;
    let mut authority = rcgen::CertificateParams::default();
    authority.distinguished_name = rcgen::DistinguishedName::new();
    authority
        .distinguished_name
        .push(rcgen::DnType::CommonName, "SuperTag deployment CA");
    authority.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Constrained(0));
    authority.key_usages = vec![
        rcgen::KeyUsagePurpose::KeyCertSign,
        rcgen::KeyUsagePurpose::CrlSign,
    ];
    validity(&mut authority);
    let authority = authority
        .self_signed(&authority_key)
        .context("sign the authority's certificate")?;

    let key = rcgen::KeyPair::generate().context("generate the server key")?;
    let mut server = rcgen::CertificateParams::new(names.to_vec())
        .context("a host name cannot be written into a certificate")?;
    server.distinguished_name = rcgen::DistinguishedName::new();
    server
        .distinguished_name
        .push(rcgen::DnType::CommonName, "control-plane");
    server.extended_key_usages = vec![rcgen::ExtendedKeyUsagePurpose::ServerAuth];
    server.key_usages = vec![rcgen::KeyUsagePurpose::DigitalSignature];
    validity(&mut server);
    let server = server
        .signed_by(&key, &authority, &authority_key)
        .context("sign the server certificate")?;
    let expires = (now + time::Duration::days(VALID_DAYS)).date();
    Ok(Issued {
        // Text before a PEM block is ignored by every reader; it tells a person, and the next
        // deploy, which hosts the certificate names and when it ends.
        ca: format!(
            "SuperTag deployment certificate authority. Public: commit it, and give it to every\n\
             client and Worker Host as SUPERTAG_SERVER_CA_FILE.\n\
             {HOSTS}{}\n\
             {EXPIRES}{expires}\n\
             {}",
            names.join(" "),
            authority.pem()
        ),
        certificate: server.pem(),
        key: key.serialize_pem(),
    })
}

/// The PEM blocks of an authority file, without the text before them.
pub(crate) fn blocks(file: &str) -> &str {
    file.find(BEGIN).map_or("", |start| &file[start..])
}

/// The names a generated authority file says its certificate carries, or `None` for a file
/// deploy did not write.
pub(crate) fn names(file: &str) -> Option<Vec<String>> {
    header(file, HOSTS).map(|names| names.split_whitespace().map(str::to_owned).collect())
}

/// Days until a generated authority file says its certificate ends; negative once it has.
pub(crate) fn days_left(file: &str) -> Option<i64> {
    let mut fields = header(file, EXPIRES)?.splitn(3, '-');
    let mut field = || fields.next()?.parse::<u16>().ok();
    let (year, month, day) = (field()?, field()?, field()?);
    let month = time::Month::try_from(u8::try_from(month).ok()?).ok()?;
    let date =
        time::Date::from_calendar_date(i32::from(year), month, u8::try_from(day).ok()?).ok()?;
    Some((date - time::OffsetDateTime::now_utc().date()).whole_days())
}

fn header<'a>(file: &'a str, name: &str) -> Option<&'a str> {
    let end = file.find(BEGIN)?;
    file[..end]
        .lines()
        .find_map(|line| line.strip_prefix(name))
        .map(str::trim)
}

/// Writes the public authority file, readable by everyone, replacing one that exists.
pub(crate) fn write_public(path: &Path, text: &str) -> Result<()> {
    let directory = path.parent().context("the CA file has no directory")?;
    let mut temporary = tempfile::Builder::new()
        .prefix(".supertag-deploy-ca-")
        .tempfile_in(directory)
        .with_context(|| format!("write {}", path.display()))?;
    temporary.write_all(text.as_bytes())?;
    temporary.as_file().sync_all()?;
    std::fs::set_permissions(
        temporary.path(),
        std::os::unix::fs::PermissionsExt::from_mode(0o644),
    )?;
    temporary
        .persist(path)
        .map_err(|error| anyhow::anyhow!("write {}: {}", path.display(), error.error))?;
    Ok(())
}

/// Writes a file only its owner can read, replacing one that exists.
pub(crate) fn write_private(path: &Path, text: &str) -> Result<()> {
    let _ = std::fs::remove_file(path);
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .with_context(|| format!("write {}", path.display()))?;
    file.write_all(text.as_bytes())?;
    file.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_issued_certificate_names_its_hosts_and_the_authority_file_says_so() -> Result<()> {
        let names = [
            "acme--supertag.modal.run".to_owned(),
            "127.0.0.1".to_owned(),
        ];
        let issued = issue(&names)?;
        assert_eq!(super::names(&issued.ca).as_deref(), Some(names.as_slice()));
        let days = days_left(&issued.ca).expect("an expiry date");
        assert!((VALID_DAYS - 2..=VALID_DAYS).contains(&days), "{days}");
        assert!(blocks(&issued.ca).starts_with("-----BEGIN CERTIFICATE-----"));
        assert_eq!(issued.ca.matches(BEGIN).count(), 1);
        assert!(
            issued
                .certificate
                .starts_with("-----BEGIN CERTIFICATE-----")
        );
        assert!(issued.key.starts_with("-----BEGIN PRIVATE KEY-----"));
        // A second issue is a different authority and key: nothing is derived or reused.
        let again = issue(&names)?;
        assert_ne!(again.key, issued.key);
        assert_ne!(blocks(&again.ca), blocks(&issued.ca));
        // A file deploy did not write carries no header.
        assert_eq!(super::names(blocks(&issued.ca)), None);
        assert_eq!(days_left(blocks(&issued.ca)), None);
        assert!(issue(&[]).is_err());
        Ok(())
    }
}
