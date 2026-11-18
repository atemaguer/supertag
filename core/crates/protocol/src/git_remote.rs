//! Remote Workspaces: which git remotes SuperTag reads and pushes, which refs git delivery may
//! change, and who authors the commits it makes. Shared by the Control Plane, git delivery, and
//! the CLI so all three refuse the same values.

use crate::{valid_git_branch, valid_workspace_id};

/// How git delivery reaches a remote.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RemoteTransport {
    /// `https://`, or `http://` to a loopback address for a git server on the same machine.
    Http,
    /// `ssh://` or the scp-style `user@host:path`.
    Ssh,
    /// `file:///absolute/path`: a bare repository on the machine that runs git delivery.
    File,
}

/// The longest remote URL accepted.
pub const MAX_REMOTE_BYTES: usize = 2048;

/// The address part of every commit author SuperTag names. It is reserved and never delivers
/// mail, so no reply reaches a person by mistake.
pub const NOREPLY_DOMAIN: &str = "noreply.supertag.invalid";

/// The transport a Workspace remote uses, or why it is refused. A remote never carries a
/// password or token (those belong in a Workspace Credential), never names a git transport
/// helper (`ext::`), and never starts with `-`.
pub fn remote_transport(remote: &str) -> Result<RemoteTransport, String> {
    if remote.is_empty() || remote.len() > MAX_REMOTE_BYTES {
        return Err(format!(
            "a Workspace remote is 1 to {MAX_REMOTE_BYTES} bytes"
        ));
    }
    if remote.starts_with('-')
        || remote.contains("::")
        || remote.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return Err("a Workspace remote must be a plain git URL".into());
    }
    if let Some((scheme, _)) = remote.split_once("://") {
        let url = url::Url::parse(remote).map_err(|_| "invalid Workspace remote URL".to_owned())?;
        if url.password().is_some() || url.query().is_some() || url.fragment().is_some() {
            return Err(
                "a Workspace remote never holds a password or token; store it as a Workspace Credential"
                    .into(),
            );
        }
        return match scheme {
            "https" | "http" => {
                if !url.username().is_empty() {
                    return Err(
                        "an HTTPS Workspace remote names no user; the Workspace Credential does"
                            .into(),
                    );
                }
                let host = url.host_str().unwrap_or_default();
                if host.is_empty() || url.path().len() <= 1 {
                    return Err("an HTTPS Workspace remote names a host and a repository".into());
                }
                if scheme == "http" && !matches!(host, "127.0.0.1" | "localhost" | "[::1]") {
                    return Err(
                        "an http:// Workspace remote must be on this machine; use https://".into(),
                    );
                }
                Ok(RemoteTransport::Http)
            }
            "ssh" => {
                if url.host_str().unwrap_or_default().is_empty() || url.path().len() <= 1 {
                    return Err("an SSH Workspace remote names a host and a repository".into());
                }
                Ok(RemoteTransport::Ssh)
            }
            "file" => {
                if url.host_str().is_some_and(|host| !host.is_empty())
                    || !url.path().starts_with('/')
                    || url.path().len() <= 1
                    || remote.split('/').any(|part| part == "..")
                {
                    return Err("a file:// Workspace remote names an absolute path".into());
                }
                Ok(RemoteTransport::File)
            }
            _ => Err(format!(
                "Workspace remotes use https://, ssh://, user@host:path, or file://, not {scheme}://"
            )),
        };
    }
    // scp-style `[user@]host:path`: a host without `/` before the first `:`.
    let Some((authority, path)) = remote.split_once(':') else {
        return Err(
            "Workspace remotes use https://, ssh://, user@host:path, or file://; a local path needs file://"
                .into(),
        );
    };
    let host = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host);
    if host.is_empty()
        || authority.contains('/')
        || path.is_empty()
        || !host
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
    {
        return Err("invalid scp-style Workspace remote; use user@host:path".into());
    }
    Ok(RemoteTransport::Ssh)
}

/// A Workspace Credential's name: the same characters as a Workspace ID.
pub fn valid_credential_name(name: &str) -> bool {
    valid_workspace_id(name)
}

/// The credential vault entry that holds a Workspace Credential's secret.
pub fn credential_vault_id(name: &str) -> String {
    format!("workspace-credential/{name}")
}

/// A merge target git delivery may move: a plain branch outside `supertag/`, which only Session
/// branches use.
pub fn valid_merge_target(branch: &str) -> bool {
    valid_git_branch(branch) && !branch.starts_with("supertag/") && branch != "supertag"
}

/// The ref allowlist: git delivery pushes only Session branches (`supertag/session/...`) and
/// the Workspace's own merge target, and only fast-forward.
pub fn may_push(branch: &str, merge_target: Option<&str>) -> bool {
    let session = branch
        .strip_prefix("supertag/session/")
        .is_some_and(|id| id.len() == 64 && id.bytes().all(|b| b.is_ascii_hexdigit()));
    session || merge_target.is_some_and(|target| target == branch && valid_merge_target(target))
}

/// The SuperTag no-reply address that authors a Tag's commits.
pub fn tag_author_email(tag_id: &str) -> String {
    format!("{}@{NOREPLY_DOMAIN}", email_local_part(tag_id))
}

/// The `Co-authored-by` value for the person who asked for the work, from their principal, such
/// as `operator:ada` or `user:slack/T1/U2`. Empty when no person asked.
pub fn requester_co_author(principal: &str) -> String {
    let name = principal
        .strip_prefix("operator:")
        .or_else(|| principal.strip_prefix("user:"))
        .or_else(|| principal.strip_prefix("client:"))
        .unwrap_or_default();
    if name.is_empty() {
        return String::new();
    }
    let display: String = name
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, '<' | '>'))
        .take(100)
        .collect();
    format!("{display} <{}@{NOREPLY_DOMAIN}>", email_local_part(name))
}

fn email_local_part(value: &str) -> String {
    let mut part: String = value
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '+') {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .take(64)
        .collect();
    part = part.trim_matches(|c| c == '.' || c == '-').to_owned();
    if part.is_empty() {
        "supertag".into()
    } else {
        part
    }
}

/// A commit author name: the Tag's display name or ID, without characters git refuses.
pub fn author_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, '<' | '>' | '\n'))
        .take(100)
        .collect();
    let cleaned = cleaned.trim();
    if cleaned.is_empty() {
        "SuperTag".into()
    } else {
        cleaned.to_owned()
    }
}

/// A GitHub repository a Workspace remote names, and where its forge answers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GithubRemote {
    /// The REST API root, ending in `/`: `https://api.github.com/` for github.com, else
    /// `/api/v3/` on the remote's host, as GitHub Enterprise Server serves it.
    pub api: String,
    /// The web origin pull request links use, without a trailing `/`.
    pub web: String,
    /// `OWNER/NAME`, lowercase.
    pub repository: String,
}

/// Whether a remote is on github.com, so its forge is inferred as GitHub.
pub fn on_github_com(remote: &str) -> bool {
    remote_parts(remote).is_some_and(|(_, host, _, _)| host.eq_ignore_ascii_case("github.com"))
}

/// The GitHub repository `remote` names: a host and a path of exactly `OWNER/NAME`, with an
/// optional `.git`. `None` for a `file://` remote or any other path shape.
pub fn github_remote(remote: &str) -> Option<GithubRemote> {
    let (scheme, host, port, path) = remote_parts(remote)?;
    let path = path.trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let parts: Vec<&str> = path.split('/').collect();
    let valid = parts.len() == 2
        && parts.iter().all(|part| {
            !part.is_empty()
                && part.len() <= 100
                && *part != "."
                && *part != ".."
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
        });
    if !valid {
        return None;
    }
    let repository = path.to_ascii_lowercase();
    let host = host.to_ascii_lowercase();
    if host == "github.com" {
        return Some(GithubRemote {
            api: "https://api.github.com/".into(),
            web: "https://github.com".into(),
            repository,
        });
    }
    // An SSH remote's forge answers over HTTPS on the same host.
    let origin = match (scheme, port) {
        ("http" | "https", Some(port)) => format!("{scheme}://{host}:{port}"),
        ("http" | "https", None) => format!("{scheme}://{host}"),
        _ => format!("https://{host}"),
    };
    Some(GithubRemote {
        api: format!("{origin}/api/v3/"),
        web: origin,
        repository,
    })
}

/// A remote's scheme (`ssh` for scp-style), host, port, and path.
fn remote_parts(remote: &str) -> Option<(&'static str, String, Option<u16>, String)> {
    match remote_transport(remote).ok()? {
        RemoteTransport::File => None,
        _ if remote.contains("://") => {
            let url = url::Url::parse(remote).ok()?;
            let scheme = match url.scheme() {
                "https" => "https",
                "http" => "http",
                _ => "ssh",
            };
            Some((
                scheme,
                url.host_str()?.to_owned(),
                url.port(),
                url.path().to_owned(),
            ))
        }
        _ => {
            let (authority, path) = remote.split_once(':')?;
            let host = authority
                .rsplit_once('@')
                .map_or(authority, |(_, host)| host);
            Some(("ssh", host.to_owned(), None, path.to_owned()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remotes_name_plain_git_transports_without_secrets() {
        for (remote, transport) in [
            ("https://github.com/acme/app.git", RemoteTransport::Http),
            ("http://127.0.0.1:9418/app.git", RemoteTransport::Http),
            (
                "ssh://git@git.acme.internal/handbook.git",
                RemoteTransport::Ssh,
            ),
            ("git@gitlab.com:acme/app.git", RemoteTransport::Ssh),
            ("file:///srv/git/app.git", RemoteTransport::File),
        ] {
            assert_eq!(remote_transport(remote), Ok(transport), "{remote}");
        }
        for remote in [
            "",
            "https://user:token@github.com/acme/app.git",
            "https://user@github.com/acme/app.git",
            "http://git.acme.com/app.git",
            "ext::sh -c touch% /tmp/pwned",
            "-uhttps://x",
            "/srv/git/app.git",
            "file://host/srv/app.git",
            "file:///srv/../etc",
            "git://example.com/app.git",
            "https://github.com/acme/app.git?x=1",
            "host/path:x",
        ] {
            assert!(remote_transport(remote).is_err(), "{remote}");
        }
    }

    #[test]
    fn delivery_pushes_only_session_branches_and_the_merge_target() {
        let session = crate::session_branch("tag", "session");
        assert!(may_push(&session, None));
        assert!(may_push("drafts", Some("drafts")));
        assert!(!may_push("main", Some("drafts")));
        assert!(!may_push("supertag/session/short", None));
        assert!(!may_push("supertag/x", Some("supertag/x")));
        assert!(!valid_merge_target("supertag/session/abc"));
    }

    #[test]
    fn github_remotes_name_their_api_and_repository() {
        let github = github_remote("https://github.com/Acme/App.git").unwrap();
        assert_eq!(github.api, "https://api.github.com/");
        assert_eq!(github.web, "https://github.com");
        assert_eq!(github.repository, "acme/app");
        assert_eq!(
            github_remote("git@github.com:acme/app.git")
                .unwrap()
                .repository,
            "acme/app"
        );
        let enterprise = github_remote("ssh://git@ghe.acme.internal/acme/app.git").unwrap();
        assert_eq!(enterprise.api, "https://ghe.acme.internal/api/v3/");
        let local = github_remote("http://127.0.0.1:8080/acme/app.git").unwrap();
        assert_eq!(local.api, "http://127.0.0.1:8080/api/v3/");
        assert_eq!(local.web, "http://127.0.0.1:8080");
        for remote in [
            "file:///srv/acme/app.git",
            "https://github.com/acme/app/extra.git",
            "https://github.com/acme",
            "https://gitlab.com/group/sub/app.git",
        ] {
            assert_eq!(github_remote(remote), None, "{remote}");
        }
        assert!(on_github_com("git@github.com:acme/app.git"));
        assert!(!on_github_com("https://ghe.acme.internal/acme/app.git"));
    }

    #[test]
    fn authors_use_the_no_reply_domain() {
        assert_eq!(
            tag_author_email("Docs Bot"),
            "docs-bot@noreply.supertag.invalid"
        );
        assert_eq!(
            requester_co_author("operator:ada"),
            "ada <ada@noreply.supertag.invalid>"
        );
        assert_eq!(requester_co_author("gateway:local"), "");
        assert_eq!(author_name(" <x>\n"), "x");
    }
}
