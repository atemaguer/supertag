//! Network scopes on a Task's `web:fetch` access.
//!
//! A Permission Set's runtime `web:fetch` permission may name `hosts` (HTTPS origins), `methods`,
//! and a `credential` the Worker Host injects. The Control Plane validates them here and composes
//! the accepted grants into one [`NetworkScope`] when it accepts a Task. The Worker Host's egress
//! proxy enforces that scope with [`Rules`], and placement uses [`reason`] to keep a Task off a
//! harness or host that cannot force its traffic through the proxy.
//!
//! Grants union: a request is allowed when any grant allows its origin and method, and a grant
//! with neither `hosts` nor `methods`, like a Tag's own `web:fetch`, allows every request. A
//! credential is injected only where a grant naming it matches.

use std::collections::BTreeSet;

use crate::v2::{HarnessExecutionProfile, HarnessKind, NetworkRule, NetworkScope, Task};

pub const WEB_FETCH: &str = "web:fetch";
/// Methods a permission may name.
pub const METHODS: &[&str] = &["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"];
/// Origins per permission.
pub const MAX_HOSTS: usize = 64;
const MAX_HOST_BYTES: usize = 253;
const MAX_CREDENTIAL_BYTES: usize = 63;

/// One permission's network fields, as a manifest names them.
pub struct PermissionNetwork<'a> {
    pub hosts: &'a mut Vec<String>,
    pub methods: &'a mut Vec<String>,
    pub credential: &'a mut String,
    /// URL path prefixes; on a web:fetch permission these are the permission's `paths`.
    pub paths: &'a mut Vec<String>,
}

/// URL path prefixes per permission.
pub const MAX_PATHS: usize = 64;
const MAX_PATH_BYTES: usize = 512;

/// Validate and canonicalize one runtime permission's network fields in place. The error names the
/// entry and how to fix it.
pub fn normalize_permission(action: &str, fields: PermissionNetwork<'_>) -> Result<(), String> {
    let PermissionNetwork {
        hosts,
        methods,
        credential,
        paths,
    } = fields;
    *credential = credential.trim().to_owned();
    if action != WEB_FETCH {
        // A file grant's `paths` are Workspace paths, checked by `file_scope`.
        if hosts.is_empty() && methods.is_empty() && credential.is_empty() {
            return Ok(());
        }
        return Err(format!(
            "{action} takes no hosts, methods, or credential: only runtime web:fetch permissions are network-scoped"
        ));
    }
    if hosts.is_empty() && methods.is_empty() && credential.is_empty() && paths.is_empty() {
        return Ok(());
    }
    if paths.len() > MAX_PATHS {
        return Err(format!(
            "web:fetch paths may list at most {MAX_PATHS} prefixes"
        ));
    }
    *paths = paths
        .iter()
        .map(|value| canonical_path(value))
        .collect::<Result<BTreeSet<_>, _>>()?
        .into_iter()
        .collect();
    if !paths.is_empty() && hosts.is_empty() {
        return Err(
            "web:fetch paths need hosts: name the origins whose paths they limit".to_owned(),
        );
    }
    if hosts.len() > MAX_HOSTS {
        return Err(format!(
            "web:fetch hosts may list at most {MAX_HOSTS} origins"
        ));
    }
    if methods.len() > METHODS.len() {
        return Err(format!(
            "web:fetch methods may list at most {} methods",
            METHODS.len()
        ));
    }
    *hosts = hosts
        .iter()
        .map(|value| canonical_origin(value))
        .collect::<Result<BTreeSet<_>, _>>()?
        .into_iter()
        .collect();
    *methods = methods
        .iter()
        .map(|value| {
            let method = value.trim().to_ascii_uppercase();
            if METHODS.contains(&method.as_str()) {
                Ok(method)
            } else {
                Err(format!(
                    "web:fetch method {value:?} is not one of {}",
                    METHODS.join(", ")
                ))
            }
        })
        .collect::<Result<BTreeSet<_>, _>>()?
        .into_iter()
        .collect();
    if !credential.is_empty() {
        validate_credential_name(credential)?;
        if hosts.is_empty() {
            return Err(format!(
                "web:fetch credential {credential:?} needs hosts, so the credential is sent only to the origins you name"
            ));
        }
    }
    Ok(())
}

/// A credential name: lowercase letters, digits, and `-`, starting with a letter.
pub fn validate_credential_name(name: &str) -> Result<(), String> {
    let valid = !name.is_empty()
        && name.len() <= MAX_CREDENTIAL_BYTES
        && name.starts_with(|c: char| c.is_ascii_lowercase())
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if valid {
        Ok(())
    } else {
        Err(format!(
            "credential name {name:?} must be lowercase letters, digits, and -, start with a letter, and be at most {MAX_CREDENTIAL_BYTES} characters"
        ))
    }
}

/// A URL path prefix: absolute, without a query, fragment, `.` or `..` segment, backslash,
/// percent-encoded dot or slash, or a trailing `/` (except `/` itself).
pub fn canonical_path(raw: &str) -> Result<String, String> {
    let value = raw.trim();
    let refuse = |why: &str| Err(format!("web:fetch path {raw:?} {why}"));
    if !value.starts_with('/') {
        return refuse("must start with /, such as /repos/acme/");
    }
    if value.len() > MAX_PATH_BYTES {
        return refuse("is longer than 512 bytes");
    }
    if value.contains(['?', '#', '\\', '*'])
        || value.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return refuse("must be a literal path without a query, fragment, wildcard, or spaces");
    }
    if !canonical_request_path(value) {
        return refuse("must not contain . or .. segments or percent-encoded dots or slashes");
    }
    let trimmed = value.trim_end_matches('/');
    Ok(if trimmed.is_empty() {
        "/".to_owned()
    } else {
        trimmed.to_owned()
    })
}

/// Whether a request path, without its query, can be compared with path prefixes: no `.` or `..`
/// segment, backslash, or percent-encoded dot, slash, or backslash, so two spellings of one
/// resource cannot pass different prefixes.
pub fn canonical_request_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    !path.contains('\\')
        && !["%2e", "%2f", "%5c", "%00"]
            .iter()
            .any(|encoded| lower.contains(encoded))
        && !path
            .split('/')
            .any(|segment| segment == "." || segment == "..")
}

/// Whether `path` lies under `prefix` at a `/` boundary.
pub fn path_matches(prefix: &str, path: &str) -> bool {
    prefix == "/"
        || path == prefix
        || path
            .strip_prefix(prefix)
            .is_some_and(|rest| rest.starts_with('/'))
}

/// `https://name` or `https://name:port`, lowercased, without the default port or a trailing `/`.
/// `https://*.name` names every subdomain of `name`, at any depth, but not `name` itself.
pub fn canonical_origin(raw: &str) -> Result<String, String> {
    let refuse = |why: &str| Err(format!("web:fetch host {raw:?} {why}"));
    let value = raw.trim();
    let Some(rest) = value
        .get(..8)
        .filter(|scheme| scheme.eq_ignore_ascii_case("https://"))
        .map(|_| &value[8..])
    else {
        if value
            .get(..7)
            .is_some_and(|scheme| scheme.eq_ignore_ascii_case("http://"))
        {
            return refuse(
                "uses http://; only https:// origins are supported, so a credential never travels in clear text",
            );
        }
        return refuse("must be an origin such as https://api.github.com");
    };
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    if rest.contains(['/', '?', '#']) {
        return refuse("must be an origin without a path, query, or fragment");
    }
    if rest.contains('@') {
        return refuse("must not contain user information");
    }
    if rest.starts_with('[') {
        return refuse("names an IP address; name the host instead");
    }
    let (host, port) = match rest.rsplit_once(':') {
        Some((host, port)) => {
            let port: u16 = port
                .parse()
                .ok()
                .filter(|port| *port != 0)
                .ok_or_else(|| format!("web:fetch host {raw:?} has an invalid port"))?;
            (host, Some(port))
        }
        None => (rest, None),
    };
    let host = host.to_ascii_lowercase();
    let (wildcard, host) = match host.strip_prefix("*.") {
        Some(rest) => (true, rest.to_owned()),
        None => (false, host),
    };
    if host.contains('*') {
        return refuse(
            "may hold a wildcard only as its first label, such as https://*.example.com",
        );
    }
    if host.len() > MAX_HOST_BYTES || !host.is_ascii() {
        return refuse("must be an ASCII host name of at most 253 characters");
    }
    let labels: Vec<&str> = host.split('.').collect();
    let valid_label = |label: &&str| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    };
    if !labels.iter().all(valid_label) {
        return refuse("is not a valid host name");
    }
    if labels.len() < 2 {
        return refuse("must be a fully qualified host name such as api.github.com");
    }
    if labels
        .last()
        .is_some_and(|label| label.chars().all(|c| c.is_ascii_digit()))
    {
        return refuse("names an IP address; name the host instead");
    }
    if labels.last() == Some(&"localhost") {
        return refuse("names this machine; a network scope reaches only the internet");
    }
    let host = if wildcard { format!("*.{host}") } else { host };
    Ok(match port {
        Some(port) if port != 443 => format!("https://{host}:{port}"),
        _ => format!("https://{host}"),
    })
}

/// One permission's network fields, read-only.
pub struct Grant<'a> {
    pub action: &'a str,
    pub hosts: &'a [String],
    pub methods: &'a [String],
    pub credential: &'a str,
    pub paths: &'a [String],
    /// Whether this grant's action is admitted. A gated grant adds nothing.
    pub admitted: bool,
}

/// Compose the accepted grants into a Task's network scope. `any_origin` is true when a grant with
/// no fields, such as a Tag's direct `web:fetch`, already allows every request. Returns `None` when
/// nothing narrows or binds a credential, which keeps today's unrestricted behaviour.
pub fn compose<'a>(
    grants: impl IntoIterator<Item = Grant<'a>>,
    any_origin: bool,
) -> Option<NetworkScope> {
    let mut any = any_origin;
    let mut rules = BTreeSet::new();
    for grant in grants {
        if grant.action != WEB_FETCH || !grant.admitted {
            continue;
        }
        if grant.hosts.is_empty()
            && grant.methods.is_empty()
            && grant.credential.is_empty()
            && grant.paths.is_empty()
        {
            any = true;
        } else {
            rules.insert((
                grant.hosts.to_vec(),
                grant.methods.to_vec(),
                grant.credential.to_owned(),
                grant.paths.to_vec(),
            ));
        }
    }
    let rules: Vec<NetworkRule> = rules
        .into_iter()
        // With every request allowed, a rule matters only for the credential it binds.
        .filter(|(_, _, credential, _)| !any || !credential.is_empty())
        .map(|(origins, methods, credential, paths)| NetworkRule {
            origins,
            methods,
            credential,
            paths,
        })
        .collect();
    (!rules.is_empty()).then_some(NetworkScope {
        any_origin: any,
        rules,
    })
}

/// The accepted Task's network scope, or `None` when it has none or no longer admits `web:fetch`.
pub fn of_task(task: &Task) -> Option<&NetworkScope> {
    if !task
        .allowed_actions
        .iter()
        .any(|action| action == WEB_FETCH)
    {
        return None;
    }
    task.policy_snapshot
        .as_ref()
        .and_then(|snapshot| snapshot.runtime_authority.as_ref())
        .and_then(|authority| authority.network.as_ref())
        .filter(|scope| !scope.rules.is_empty())
}

/// Whether the scope limits which origins or methods a request may use, as opposed to only binding
/// credentials.
pub fn narrows(scope: &NetworkScope) -> bool {
    !scope.any_origin
}

/// The credential names a scope binds.
pub fn credentials(scope: &NetworkScope) -> BTreeSet<&str> {
    scope
        .rules
        .iter()
        .map(|rule| rule.credential.as_str())
        .filter(|name| !name.is_empty())
        .collect()
}

/// Every host name a narrowed scope may reach, without ports, for a sandbox's domain list.
pub fn host_names(scope: &NetworkScope) -> BTreeSet<String> {
    scope
        .rules
        .iter()
        .flat_map(|rule| &rule.origins)
        .filter_map(|origin| origin.strip_prefix("https://"))
        .map(|rest| match rest.rsplit_once(':') {
            Some((host, _)) => host.to_owned(),
            None => rest.to_owned(),
        })
        .collect()
}

/// A scope's rules, for the egress proxy.
#[derive(Clone, Debug, Default)]
pub struct Rules {
    any_origin: bool,
    rules: Vec<CompiledRule>,
}

/// A rule's origins as `(host, port)` (a host starting `*.` names subdomains), its methods, its
/// credential, and its path prefixes.
type CompiledRule = (Vec<(String, u16)>, Vec<String>, String, Vec<String>);

fn origin_parts(origin: &str) -> Option<(String, u16)> {
    let rest = origin.strip_prefix("https://")?;
    Some(match rest.rsplit_once(':') {
        Some((host, port)) => (host.to_owned(), port.parse().ok()?),
        None => (rest.to_owned(), 443),
    })
}

impl From<&NetworkScope> for Rules {
    fn from(scope: &NetworkScope) -> Self {
        Self {
            any_origin: scope.any_origin,
            rules: scope
                .rules
                .iter()
                .map(|rule| {
                    (
                        rule.origins
                            .iter()
                            .filter_map(|origin| origin_parts(origin))
                            .collect(),
                        rule.methods.clone(),
                        rule.credential.clone(),
                        rule.paths.clone(),
                    )
                })
                .collect(),
        }
    }
}

impl Rules {
    fn origin_matches(origins: &[(String, u16)], host: &str, port: u16) -> bool {
        origins.is_empty()
            || origins.iter().any(|(name, number)| {
                *number == port
                    && match name.strip_prefix("*.") {
                        Some(parent) => {
                            host.len() > parent.len() + 1
                                && host[host.len() - parent.len()..].eq_ignore_ascii_case(parent)
                                && host.as_bytes()[host.len() - parent.len() - 1] == b'.'
                        }
                        None => name.eq_ignore_ascii_case(host),
                    }
            })
    }

    fn path_allowed(paths: &[String], path: &str) -> bool {
        paths.is_empty()
            || (canonical_request_path(path)
                && paths.iter().any(|prefix| path_matches(prefix, path)))
    }

    fn method_matches(methods: &[String], method: &str) -> bool {
        methods.is_empty() || methods.iter().any(|value| value == method)
    }

    /// Whether any request to `host:port` could be allowed, before its method is known.
    pub fn allows_origin(&self, host: &str, port: u16) -> bool {
        self.any_origin
            || self
                .rules
                .iter()
                .any(|(origins, _, _, _)| Self::origin_matches(origins, host, port))
    }

    /// Whether a request with `method` for `path` (without its query) to `host:port` is allowed.
    pub fn allows(&self, host: &str, port: u16, method: &str, path: &str) -> bool {
        self.any_origin
            || self.rules.iter().any(|(origins, methods, _, paths)| {
                Self::origin_matches(origins, host, port)
                    && Self::method_matches(methods, method)
                    && Self::path_allowed(paths, path)
            })
    }

    /// Whether `credential` may be injected into a request with `method` for `path` to
    /// `host:port`.
    pub fn binds(&self, credential: &str, host: &str, port: u16, method: &str, path: &str) -> bool {
        self.rules.iter().any(|(origins, methods, name, paths)| {
            name == credential
                && !origins.is_empty()
                && Self::origin_matches(origins, host, port)
                && Self::method_matches(methods, method)
                && Self::path_allowed(paths, path)
        })
    }
}

fn harness_name(harness: HarnessKind) -> &'static str {
    match harness {
        HarnessKind::Unspecified => "A custom harness",
        HarnessKind::Codex => "Codex",
        HarnessKind::ClaudeCode => "Claude Code",
        HarnessKind::OpenaiAgents => "OpenAI Agents",
        HarnessKind::Opencode => "OpenCode",
        HarnessKind::Cursor => "Cursor",
    }
}

/// Why `harness` can never apply this Task's network scope, whatever host runs it, or `None`.
///
/// Codex's sandbox forces every command connection through SuperTag's egress proxy, and so does
/// Claude Code's sandbox where the host can run it (see [`reason`]); Claude Code cannot carry
/// credentials. The other harnesses run commands unsandboxed or fetch from the harness process.
pub fn harness_reason(task: &Task, harness: HarnessKind) -> Option<String> {
    let scope = of_task(task)?;
    if harness == HarnessKind::Codex {
        return None;
    }
    let name = harness_name(harness);
    // Claude Code's sandbox reaches the egress proxy without its password, so it can apply the
    // allow-list but never carry a credential.
    if harness == HarnessKind::ClaudeCode {
        let bound = credentials(scope);
        return (!bound.is_empty()).then(|| {
            format!(
                "Claude Code's sandbox cannot authenticate to SuperTag's egress proxy, so it cannot carry network credentials ({}); run the Tag on Codex, or remove credential from its web:fetch grants",
                bound.into_iter().collect::<Vec<_>>().join(", ")
            )
        });
    }
    Some(if narrows(scope) {
        format!(
            "{name} cannot force web requests through SuperTag's egress proxy, so it cannot keep the Task to the origins its Permission Sets name ({}); run the Tag on Codex, or remove hosts and methods from its web:fetch grants",
            listed(
                &scope
                    .rules
                    .iter()
                    .flat_map(|rule| rule.origins.clone())
                    .collect::<BTreeSet<_>>()
            )
        )
    } else {
        format!(
            "{name} cannot inject network credentials ({}) through SuperTag's egress proxy; run the Tag on Codex",
            credentials(scope)
                .into_iter()
                .collect::<Vec<_>>()
                .join(", ")
        )
    })
}

fn listed(values: &BTreeSet<String>) -> String {
    let mut shown: Vec<&str> = values.iter().take(4).map(String::as_str).collect();
    if values.len() > shown.len() {
        shown.push("…");
    }
    if shown.is_empty() {
        "any origin, limited methods".to_owned()
    } else {
        shown.join(", ")
    }
}

/// Why a host lane with `profile` cannot apply this Task's network scope, or `None` when it can.
pub fn reason(
    task: &Task,
    harness: HarnessKind,
    profile: &HarnessExecutionProfile,
) -> Option<String> {
    if let Some(reason) = harness_reason(task, harness) {
        return Some(reason);
    }
    let scope = of_task(task)?;
    // Claude Code checks WebFetch in its tool hook; commands need its sandbox.
    if harness == HarnessKind::ClaudeCode
        && task
            .allowed_actions
            .iter()
            .any(|action| action == "commands:execute")
        && !profile.network_sandbox
    {
        return Some(
            "this Worker Host cannot run Claude Code's sandbox, which keeps commands to the Task's network scope; on Linux install bubblewrap and socat, or run the Tag on Codex".to_owned(),
        );
    }
    if profile.unverified_workspace_provider {
        return Some(
            "this Worker Host's own sandbox provider is not verified to keep a network scope; run the Tag on a local Codex Worker Host".to_owned(),
        );
    }
    if profile.remote_file_workspace || profile.shared_execution.is_some() {
        return Some(
            "a remote or shared execution environment cannot send its traffic through SuperTag's egress proxy yet; run the Tag on a local Codex Worker Host".to_owned(),
        );
    }
    let missing: Vec<&str> = credentials(scope)
        .into_iter()
        .filter(|name| {
            !profile
                .network_credentials
                .iter()
                .any(|offered| offered == name)
        })
        .collect();
    (!missing.is_empty()).then(|| {
        format!(
            "this Worker Host offers no network credential {}; configure it under network-credentials on a host that runs the Tag",
            missing.join(", ")
        )
    })
}

/// Whether a host lane with `profile` can apply this Task's network scope.
pub fn supports(task: &Task, harness: HarnessKind, profile: &HarnessExecutionProfile) -> bool {
    reason(task, harness, profile).is_none()
}

/// A short summary for `describe`: `Reaches https://pypi.org (GET, HEAD) · …`.
pub fn summary(scope: &NetworkScope) -> String {
    let rule = |rule: &NetworkRule| {
        let origins = if rule.origins.is_empty() {
            "any origin".to_owned()
        } else {
            rule.origins.join(", ")
        };
        let mut details = vec![];
        if !rule.methods.is_empty() {
            details.push(rule.methods.join(", "));
        }
        if !rule.paths.is_empty() {
            details.push(format!("paths {}", rule.paths.join(", ")));
        }
        if !rule.credential.is_empty() {
            details.push(format!("credential {}", rule.credential));
        }
        if details.is_empty() {
            origins
        } else {
            format!("{origins} ({})", details.join("; "))
        }
    };
    let rules: Vec<String> = scope.rules.iter().map(rule).collect();
    if scope.any_origin {
        format!("Reaches any origin · Injects {}", rules.join(" · "))
    } else {
        format!("Reaches {}", rules.join(" · "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unverified_sandbox_provider_never_gets_a_network_scope() {
        let task = Task {
            allowed_actions: strings(&["files:read", WEB_FETCH]),
            policy_snapshot: Some(crate::v2::TaskPolicySnapshot {
                runtime_authority: Some(crate::v2::TaskRuntimeAuthority {
                    network: Some(NetworkScope {
                        any_origin: false,
                        rules: vec![NetworkRule {
                            origins: strings(&["https://pypi.org"]),
                            ..Default::default()
                        }],
                    }),
                    ..Default::default()
                }),
                ..Default::default()
            }),
            ..Default::default()
        };
        let profile = HarnessExecutionProfile {
            remote_file_workspace: true,
            unverified_workspace_provider: true,
            ..Default::default()
        };
        let reason = reason(&task, HarnessKind::ClaudeCode, &profile).unwrap();
        assert!(reason.contains("not verified"), "{reason}");
        assert!(!supports(&task, HarnessKind::ClaudeCode, &profile));
    }

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    fn normalized(
        action: &str,
        hosts: &[&str],
        methods: &[&str],
        credential: &str,
    ) -> Result<(Vec<String>, Vec<String>, String), String> {
        let (mut hosts, mut methods, mut credential) =
            (strings(hosts), strings(methods), credential.to_owned());
        normalize_permission(
            action,
            PermissionNetwork {
                hosts: &mut hosts,
                methods: &mut methods,
                credential: &mut credential,
                paths: &mut vec![],
            },
        )?;
        Ok((hosts, methods, credential))
    }

    #[test]
    fn canonicalizes_origins_and_methods() {
        let (hosts, methods, credential) = normalized(
            WEB_FETCH,
            &[
                "HTTPS://PyPI.org/",
                "https://files.pythonhosted.org:443",
                "https://api.example.com:8443",
                " https://pypi.org ",
            ],
            &["head", "GET", "get"],
            " github ",
        )
        .unwrap();
        assert_eq!(
            hosts,
            strings(&[
                "https://api.example.com:8443",
                "https://files.pythonhosted.org",
                "https://pypi.org"
            ])
        );
        assert_eq!(methods, strings(&["GET", "HEAD"]));
        assert_eq!(credential, "github");
        assert_eq!(
            normalized("files:read", &[], &[], "").unwrap().0,
            Vec::<String>::new()
        );
    }

    #[test]
    fn refuses_invalid_fields_with_a_reason() {
        let refused =
            |action: &str, hosts: &[&str], methods: &[&str], credential: &str, needle: &str| {
                let error = normalized(action, hosts, methods, credential).unwrap_err();
                assert!(error.contains(needle), "{error} lacks {needle}");
            };
        refused(
            "files:write",
            &["https://pypi.org"],
            &[],
            "",
            "takes no hosts",
        );
        refused(WEB_FETCH, &["http://pypi.org"], &[], "", "only https://");
        refused(WEB_FETCH, &["pypi.org"], &[], "", "must be an origin");
        refused(
            WEB_FETCH,
            &["https://pypi.org/simple"],
            &[],
            "",
            "without a path",
        );
        refused(
            WEB_FETCH,
            &["https://pypi.org?x=1"],
            &[],
            "",
            "without a path",
        );
        refused(
            WEB_FETCH,
            &["https://user@pypi.org"],
            &[],
            "",
            "user information",
        );
        refused(WEB_FETCH, &["https://*.org"], &[], "", "fully qualified");
        refused(
            WEB_FETCH,
            &["https://api.*.pypi.org"],
            &[],
            "",
            "first label",
        );
        refused(WEB_FETCH, &["https://10.0.0.1"], &[], "", "IP address");
        refused(WEB_FETCH, &["https://[::1]"], &[], "", "IP address");
        refused(
            WEB_FETCH,
            &["https://localhost"],
            &[],
            "",
            "fully qualified",
        );
        refused(
            WEB_FETCH,
            &["https://app.localhost"],
            &[],
            "",
            "this machine",
        );
        refused(WEB_FETCH, &["https://pypi.org:0"], &[], "", "invalid port");
        refused(
            WEB_FETCH,
            &["https://pypi.org:99999"],
            &[],
            "",
            "invalid port",
        );
        refused(
            WEB_FETCH,
            &["https://-bad.org"],
            &[],
            "",
            "not a valid host",
        );
        refused(WEB_FETCH, &["https://exämple.org"], &[], "", "ASCII");
        refused(WEB_FETCH, &[], &["CONNECT"], "", "is not one of");
        refused(WEB_FETCH, &[], &["TRACE"], "", "is not one of");
        refused(WEB_FETCH, &[], &[], "github", "needs hosts");
        refused(
            WEB_FETCH,
            &["https://api.github.com"],
            &[],
            "GitHub",
            "credential name",
        );
        let many: Vec<String> = (0..=MAX_HOSTS)
            .map(|i| format!("https://h{i}.example.com"))
            .collect();
        let many: Vec<&str> = many.iter().map(String::as_str).collect();
        refused(WEB_FETCH, &many, &[], "", "at most 64");
    }

    fn grant<'a>(hosts: &'a [String], methods: &'a [String], credential: &'a str) -> Grant<'a> {
        Grant {
            action: WEB_FETCH,
            hosts,
            methods,
            credential,
            paths: &[],
            admitted: true,
        }
    }

    #[test]
    fn composes_a_union_and_keeps_only_credential_rules_beside_a_bare_grant() {
        let pypi = strings(&["https://pypi.org"]);
        let github = strings(&["https://api.github.com"]);
        let get = strings(&["GET"]);
        let none: Vec<String> = vec![];
        let scope = compose(
            [grant(&pypi, &get, ""), grant(&github, &get, "github")],
            false,
        )
        .unwrap();
        assert!(!scope.any_origin);
        assert_eq!(scope.rules.len(), 2);
        let rules = Rules::from(&scope);
        assert!(rules.allows("pypi.org", 443, "GET", "/"));
        assert!(rules.allows("PyPI.org", 443, "GET", "/"));
        assert!(!rules.allows("pypi.org", 443, "POST", "/"));
        assert!(!rules.allows("pypi.org", 8443, "GET", "/"));
        assert!(!rules.allows("www.pypi.org", 443, "GET", "/"));
        assert!(rules.allows_origin("api.github.com", 443));
        assert!(!rules.allows_origin("github.com", 443));
        assert!(rules.binds("github", "api.github.com", 443, "GET", "/"));
        assert!(!rules.binds("github", "api.github.com", 443, "POST", "/"));
        assert!(!rules.binds("github", "pypi.org", 443, "GET", "/"));
        assert_eq!(
            host_names(&scope),
            ["api.github.com", "pypi.org"].map(str::to_owned).into()
        );

        // A bare grant allows everything; only the credential rule survives.
        let scope = compose(
            [
                grant(&none, &none, ""),
                grant(&pypi, &get, ""),
                grant(&github, &get, "github"),
            ],
            false,
        )
        .unwrap();
        assert!(scope.any_origin);
        assert_eq!(scope.rules.len(), 1);
        assert!(Rules::from(&scope).allows("example.org", 443, "DELETE", "/"));
        assert!(!narrows(&scope));

        // A Tag's direct web:fetch has the same effect; with no credential nothing is scoped.
        assert!(compose([grant(&pypi, &get, "")], true).is_none());
        // Methods alone narrow every origin.
        let scope = compose([grant(&none, &get, "")], false).unwrap();
        let rules = Rules::from(&scope);
        assert!(rules.allows("example.org", 443, "GET", "/"));
        assert!(!rules.allows("example.org", 443, "POST", "/"));
        // A gated grant adds nothing.
        let mut gated = grant(&none, &none, "");
        gated.admitted = false;
        assert!(
            !compose([gated, grant(&pypi, &get, "")], false)
                .unwrap()
                .any_origin
        );
    }

    #[test]
    fn placement_refuses_harnesses_hosts_and_missing_credentials() {
        let github = strings(&["https://api.github.com"]);
        let get = strings(&["GET"]);
        let scope = compose([grant(&github, &get, "github")], false).unwrap();
        let mut task = Task {
            allowed_actions: strings(&["files:write", "commands:execute", WEB_FETCH]),
            policy_snapshot: Some(crate::v2::TaskPolicySnapshot {
                runtime_authority: Some(crate::v2::TaskRuntimeAuthority {
                    network: Some(scope),
                    ..Default::default()
                }),
                ..Default::default()
            }),
            ..Default::default()
        };
        let mut profile = HarnessExecutionProfile::default();
        assert!(harness_reason(&task, HarnessKind::Codex).is_none());
        assert!(
            harness_reason(&task, HarnessKind::Opencode)
                .unwrap()
                .contains("OpenCode cannot force web requests")
        );
        assert!(
            reason(&task, HarnessKind::Codex, &profile)
                .unwrap()
                .contains("no network credential github")
        );
        profile.network_credentials = strings(&["github"]);
        assert!(supports(&task, HarnessKind::Codex, &profile));
        profile.remote_file_workspace = true;
        assert!(!supports(&task, HarnessKind::Codex, &profile));
        // Without web:fetch the scope no longer applies.
        task.allowed_actions = strings(&["files:read"]);
        assert!(of_task(&task).is_none());
        assert!(supports(&task, HarnessKind::ClaudeCode, &profile));
    }

    #[test]
    fn wildcards_name_subdomains_and_paths_name_prefixes() {
        assert_eq!(
            canonical_origin("https://*.GitHubUserContent.com/").unwrap(),
            "https://*.githubusercontent.com"
        );
        let mut paths = strings(&["/repos/acme/", "/repos/acme", "/user"]);
        let mut hosts = strings(&["https://api.github.com"]);
        normalize_permission(
            WEB_FETCH,
            PermissionNetwork {
                hosts: &mut hosts,
                methods: &mut vec![],
                credential: &mut String::new(),
                paths: &mut paths,
            },
        )
        .unwrap();
        assert_eq!(paths, strings(&["/repos/acme", "/user"]));
        for (path, needle) in [
            ("repos", "start with /"),
            ("/a/../b", ". or .."),
            ("/a%2Fb", "percent"),
            ("/a?b", "query"),
        ] {
            let error = canonical_path(path).unwrap_err();
            assert!(error.contains(needle), "{error}");
        }
        let error = normalize_permission(
            WEB_FETCH,
            PermissionNetwork {
                hosts: &mut vec![],
                methods: &mut vec![],
                credential: &mut String::new(),
                paths: &mut strings(&["/x"]),
            },
        )
        .unwrap_err();
        assert!(error.contains("need hosts"), "{error}");

        let wild = strings(&["https://*.githubusercontent.com"]);
        let api = strings(&["https://api.github.com"]);
        let get = strings(&["GET"]);
        let prefixes = strings(&["/repos/acme"]);
        let mut scoped = grant(&api, &get, "github");
        scoped.paths = &prefixes;
        let scope = compose([grant(&wild, &get, ""), scoped], false).unwrap();
        let rules = Rules::from(&scope);
        assert!(rules.allows("raw.githubusercontent.com", 443, "GET", "/x"));
        assert!(rules.allows("a.b.githubusercontent.com", 443, "GET", "/x"));
        assert!(!rules.allows("githubusercontent.com", 443, "GET", "/x"));
        assert!(!rules.allows("evilgithubusercontent.com", 443, "GET", "/x"));
        assert!(rules.allows("api.github.com", 443, "GET", "/repos/acme"));
        assert!(rules.allows("api.github.com", 443, "GET", "/repos/acme/app/issues"));
        assert!(!rules.allows("api.github.com", 443, "GET", "/repos/acmex"));
        assert!(!rules.allows("api.github.com", 443, "GET", "/repos/other"));
        assert!(!rules.allows("api.github.com", 443, "GET", "/repos/acme/../other"));
        assert!(!rules.allows("api.github.com", 443, "GET", "/repos/acme/%2e%2e/other"));
        assert!(rules.allows_origin("api.github.com", 443));
        assert!(rules.binds("github", "api.github.com", 443, "GET", "/repos/acme/app"));
        assert!(!rules.binds("github", "api.github.com", 443, "GET", "/user"));
        assert_eq!(
            host_names(&scope),
            ["*.githubusercontent.com", "api.github.com"]
                .map(str::to_owned)
                .into()
        );
        assert!(
            summary(&scope)
                .contains("https://api.github.com (GET; paths /repos/acme; credential github)"),
            "{}",
            summary(&scope)
        );
    }

    #[test]
    fn claude_code_applies_scopes_without_credentials_where_its_sandbox_runs() {
        let pypi = strings(&["https://pypi.org"]);
        let github = strings(&["https://api.github.com"]);
        let get = strings(&["GET"]);
        let task = |scope: NetworkScope, actions: &[&str]| Task {
            allowed_actions: strings(actions),
            policy_snapshot: Some(crate::v2::TaskPolicySnapshot {
                runtime_authority: Some(crate::v2::TaskRuntimeAuthority {
                    network: Some(scope),
                    ..Default::default()
                }),
                ..Default::default()
            }),
            ..Default::default()
        };
        let plain = compose([grant(&pypi, &get, "")], false).unwrap();
        let commands = task(plain.clone(), &["commands:execute", WEB_FETCH]);
        let mut profile = HarnessExecutionProfile::default();
        assert!(harness_reason(&commands, HarnessKind::ClaudeCode).is_none());
        assert!(
            reason(&commands, HarnessKind::ClaudeCode, &profile)
                .unwrap()
                .contains("cannot run Claude Code's sandbox")
        );
        // WebFetch alone is checked by the tool hook.
        assert!(supports(
            &task(plain, &[WEB_FETCH]),
            HarnessKind::ClaudeCode,
            &profile
        ));
        profile.network_sandbox = true;
        assert!(supports(&commands, HarnessKind::ClaudeCode, &profile));
        let bound = task(
            compose([grant(&github, &get, "github")], false).unwrap(),
            &[WEB_FETCH],
        );
        assert!(
            harness_reason(&bound, HarnessKind::ClaudeCode)
                .unwrap()
                .contains("cannot carry network credentials (github)")
        );
    }

    #[test]
    fn summarizes_a_scope() {
        let pypi = strings(&["https://files.pythonhosted.org", "https://pypi.org"]);
        let github = strings(&["https://api.github.com"]);
        let read = strings(&["GET", "HEAD"]);
        let scope = compose(
            [grant(&pypi, &read, ""), grant(&github, &read, "github")],
            false,
        )
        .unwrap();
        assert_eq!(
            summary(&scope),
            "Reaches https://api.github.com (GET, HEAD; credential github) · https://files.pythonhosted.org, https://pypi.org (GET, HEAD)"
        );
    }
}
