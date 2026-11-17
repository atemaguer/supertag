//! Network scopes: `web:fetch` grants narrowed to origins and methods, with credentials bound to
//! them, are validated when a Permission Set is put, composed when a Task is accepted, keep a Task
//! off a harness or host that cannot enforce them, and the owning host records the Attempt's
//! network log.

mod support;

use sqlx::{Connection, Executor};
use supertag_control_plane::{HostAuthority, Store};
use supertag_protocol::v2::*;
use uuid::Uuid;

const NOW: i64 = 1_800_000_000_000;
const OP: &str = "operator:alice";

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_owned()).collect()
}

fn fetch(hosts: &[&str], methods: &[&str], credential: &str) -> PolicyPermission {
    PolicyPermission {
        target: PolicyPermissionTarget::Runtime.into(),
        action: "web:fetch".into(),
        hosts: strings(hosts),
        methods: strings(methods),
        credential: credential.into(),
        ..Default::default()
    }
}

async fn put_set(
    store: &Store,
    id: &str,
    permissions: Vec<PolicyPermission>,
) -> Result<PermissionSet, String> {
    store
        .put_permission_set(
            OP,
            &PutPermissionSetRequest {
                operation_id: format!("{id}-{}", Uuid::new_v4()),
                permission_set: Some(PermissionSet {
                    set_id: id.into(),
                    name: id.into(),
                    permissions,
                    ..Default::default()
                }),
                ..Default::default()
            },
        )
        .await
        .map_err(|error| error.to_string())
}

async fn report(
    store: &Store,
    host: &HostAuthority,
    harness: HarnessKind,
    profile: HarnessExecutionProfile,
) {
    store
        .report_host(
            host,
            &ReportHostRequest {
                sequence: 1,
                capacity: 4,
                available_slots: 4,
                readiness: HostReadiness::Ready.into(),
                harness_kind: harness.into(),
                execution_profile: Some(profile),
                ..Default::default()
            },
        )
        .await
        .unwrap();
}

async fn task(store: &Store, tag: &str, harness: HarnessKind) -> String {
    store
        .put_tag_spec(PutTagRequest {
            tag_id: tag.into(),
            instructions: "Fetch packages".into(),
            allowed_actions: strings(&["files:read", "files:write", "commands:execute"]),
            harness_kind: harness.into(),
            ..Default::default()
        })
        .await
        .unwrap();
    store
        .assign_role(
            OP,
            &AssignRoleRequest {
                operation_id: format!("assign-{tag}"),
                role: "fetcher".into(),
                tag_id: tag.into(),
            },
        )
        .await
        .unwrap();
    store
        .submit_task(
            OP,
            &SubmitTaskRequest {
                tag_id: tag.into(),
                session_id: tag.into(),
                operation_id: tag.into(),
                prompt: "Fetch packages".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .task_id
}

async fn claim(
    store: &Store,
    host: &HostAuthority,
    harness: HarnessKind,
    profile: &HarnessExecutionProfile,
) -> Option<Assignment> {
    store
        .claim_task_with_profile(
            host,
            &Uuid::new_v4().to_string(),
            &[],
            harness,
            &[],
            Some(profile),
        )
        .await
        .unwrap()
}

async fn contract(url: &str) {
    let store = Store::open(url).await.unwrap().with_execution_clock(|| NOW);

    // Validation names what is wrong.
    for (permission, needle) in [
        (fetch(&["http://pypi.org"], &[], ""), "only https://"),
        (
            fetch(&["https://pypi.org/simple"], &[], ""),
            "without a path",
        ),
        (fetch(&["https://*.github.com"], &[], ""), "wildcard"),
        (fetch(&[], &["CONNECT"], ""), "is not one of"),
        (fetch(&[], &[], "github"), "needs hosts"),
        (
            PolicyPermission {
                action: "files:write".into(),
                ..fetch(&["https://pypi.org"], &[], "")
            },
            "takes no hosts",
        ),
        (
            PolicyPermission {
                target: PolicyPermissionTarget::Surface.into(),
                ..fetch(&["https://pypi.org"], &[], "")
            },
            "only runtime web:fetch permissions",
        ),
    ] {
        let error = put_set(&store, "invalid", vec![permission])
            .await
            .unwrap_err();
        assert!(error.contains(needle), "{error} lacks {needle}");
    }

    // Stored canonical; two grants of web:fetch with different scopes stay distinct.
    let set = put_set(
        &store,
        "fetch",
        vec![
            fetch(
                &["HTTPS://PyPI.org/", "https://files.pythonhosted.org:443"],
                &["head", "GET"],
                "",
            ),
            fetch(&["https://api.github.com"], &["GET"], "github"),
        ],
    )
    .await
    .unwrap();
    assert_eq!(set.permissions.len(), 2);
    assert!(set.permissions.iter().any(|p| p.hosts
        == strings(&["https://files.pythonhosted.org", "https://pypi.org"])
        && p.methods == strings(&["GET", "HEAD"])));
    store
        .put_role(
            OP,
            &PutRoleRequest {
                operation_id: "fetcher-role".into(),
                role: Some(Role {
                    role_id: "fetcher".into(),
                    name: "fetcher".into(),
                    purpose: "Fetch packages".into(),
                    permission_set_ids: strings(&["fetch"]),
                    status: RoleStatus::Active.into(),
                    ..Default::default()
                }),
                ..Default::default()
            },
        )
        .await
        .unwrap();

    // Claude Code cannot force its traffic through the egress proxy.
    let claude = support::register_host(&store, "claude").await;
    let unsandboxed = HarnessExecutionProfile {
        allow_unsandboxed_commands: true,
        network_credentials: strings(&["github"]),
        ..Default::default()
    };
    report(
        &store,
        &claude,
        HarnessKind::ClaudeCode,
        unsandboxed.clone(),
    )
    .await;
    let waiting = task(&store, "claude-tag", HarnessKind::ClaudeCode).await;
    assert!(
        claim(&store, &claude, HarnessKind::ClaudeCode, &unsandboxed)
            .await
            .is_none()
    );
    let diagnosis = store.diagnose_task_placement(&waiting).await.unwrap();
    assert_eq!(diagnosis.requirement, "network-scope");
    assert!(
        diagnosis
            .summary
            .contains("Claude Code cannot force web requests"),
        "{}",
        diagnosis.summary
    );

    // A Codex host without the credential waits; one with it claims the Task.
    let bare = support::register_host(&store, "codex-bare").await;
    let without = HarnessExecutionProfile::default();
    report(&store, &bare, HarnessKind::Codex, without.clone()).await;
    let scoped = task(&store, "codex-tag", HarnessKind::Codex).await;
    let accepted = store.get_task(&scoped).await.unwrap();
    assert!(accepted.allowed_actions.contains(&"web:fetch".to_owned()));
    let network = accepted
        .policy_snapshot
        .as_ref()
        .and_then(|snapshot| snapshot.runtime_authority.as_ref())
        .and_then(|authority| authority.network.clone())
        .unwrap();
    assert!(!network.any_origin);
    assert_eq!(network.rules.len(), 2);
    assert!(
        claim(&store, &bare, HarnessKind::Codex, &without)
            .await
            .is_none()
    );
    let diagnosis = store.diagnose_task_placement(&scoped).await.unwrap();
    assert_eq!(diagnosis.requirement, "network-scope");
    assert!(
        diagnosis.summary.contains("no network credential github"),
        "{}",
        diagnosis.summary
    );
    let codex = support::register_host(&store, "codex").await;
    let with = HarnessExecutionProfile {
        network_credentials: strings(&["github"]),
        ..Default::default()
    };
    report(&store, &codex, HarnessKind::Codex, with.clone()).await;
    let assignment = claim(&store, &codex, HarnessKind::Codex, &with)
        .await
        .unwrap();
    assert_eq!(assignment.task.as_ref().unwrap().task_id, scoped);

    // Only the owning host records the Attempt's network log; a later report replaces it.
    let request = |allowed: u64| ReportNetworkLogRequest {
        attempt: Some(InspectAttemptRequest {
            task_id: scoped.clone(),
            attempt_id: assignment.attempt_id.clone(),
            lease_token: assignment.lease_token.clone(),
        }),
        log: Some(NetworkLog {
            requests: vec![NetworkRequestRecord {
                at_ms: NOW,
                method: "GET".into(),
                origin: "https://api.github.com".into(),
                path: "/repos".into(),
                allowed: true,
                status: 200,
                credential: "github".into(),
                ..Default::default()
            }],
            allowed,
            ..Default::default()
        }),
    };
    assert!(store.report_network_log(&bare, &request(1)).await.is_err());
    let mut invalid = request(0);
    assert!(store.report_network_log(&codex, &invalid).await.is_err());
    invalid.log.as_mut().unwrap().allowed = 1;
    invalid.log.as_mut().unwrap().requests[0].path = "/a\nb".into();
    assert!(store.report_network_log(&codex, &invalid).await.is_err());
    store.report_network_log(&codex, &request(1)).await.unwrap();
    store.report_network_log(&codex, &request(7)).await.unwrap();
    let logs = store.get_task(&scoped).await.unwrap().network_logs;
    assert_eq!(logs.len(), 1);
    assert_eq!(logs[0].attempt_id, assignment.attempt_id);
    let log = logs[0].log.as_ref().unwrap();
    assert_eq!((log.allowed, log.requests.len()), (7, 1));
    assert_eq!(log.requests[0].credential, "github");

    // A Tag's own web:fetch allows every origin; only the credential binding stays.
    store
        .put_tag_spec(PutTagRequest {
            tag_id: "codex-open".into(),
            instructions: "Fetch".into(),
            allowed_actions: strings(&[
                "files:read",
                "files:write",
                "commands:execute",
                "web:fetch",
            ]),
            harness_kind: HarnessKind::Codex.into(),
            ..Default::default()
        })
        .await
        .unwrap();
    store
        .assign_role(
            OP,
            &AssignRoleRequest {
                operation_id: "assign-open".into(),
                role: "fetcher".into(),
                tag_id: "codex-open".into(),
            },
        )
        .await
        .unwrap();
    let open = store
        .submit_task(
            OP,
            &SubmitTaskRequest {
                tag_id: "codex-open".into(),
                session_id: "open".into(),
                operation_id: "open".into(),
                prompt: "Fetch".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let network = open
        .policy_snapshot
        .as_ref()
        .and_then(|snapshot| snapshot.runtime_authority.as_ref())
        .and_then(|authority| authority.network.clone())
        .unwrap();
    assert!(network.any_origin);
    assert_eq!(network.rules.len(), 1);
    assert_eq!(network.rules[0].credential, "github");
    store.close().await;
}

#[tokio::test]
async fn sqlite_network_scope_contract() {
    let directory = tempfile::tempdir().unwrap();
    contract(&format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("network.db").display()
    ))
    .await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_network_scope_contract() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("PostgreSQL test URL file required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let name = format!("supertag_network_scope_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await
        .unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    url.set_path(&name);
    let outcome = tokio::task::LocalSet::new()
        .run_until(async move {
            tokio::task::spawn_local(async move { contract(url.as_str()).await }).await
        })
        .await;
    admin
        .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
        .await
        .unwrap();
    admin.close().await.unwrap();
    outcome.expect("PostgreSQL network scope contract failed");
}
