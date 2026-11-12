mod support;

use sqlx::{Connection, Executor};
use supertag_control_plane::{Store, StoreError};
use supertag_protocol::v2::{
    surface_account_identity::Provider as Identity, surface_location_scope::Provider as Scope, *,
};
use uuid::Uuid;

const OPERATOR: &str = "operator:alice";

fn account(id: &str, team: &str) -> PutSurfaceAccountRequest {
    PutSurfaceAccountRequest {
        operation_id: format!("account-{id}"),
        account: Some(SurfaceAccount {
            account_id: id.into(),
            identity: Some(SurfaceAccountIdentity {
                provider: Some(surface_account_identity::Provider::Slack(
                    SlackSurfaceIdentity {
                        team_id: team.into(),
                    },
                )),
            }),
            enabled: true,
            ..Default::default()
        }),
        ..Default::default()
    }
}

fn location(id: &str, account: &str, alias: &str, channel: &str) -> PutSurfaceLocationRequest {
    PutSurfaceLocationRequest {
        operation_id: format!("location-{id}"),
        location: Some(SurfaceLocation {
            location_id: id.into(),
            account_id: account.into(),
            connector_account_id: alias.into(),
            scope: Some(SurfaceLocationScope {
                provider: Some(surface_location_scope::Provider::Slack(
                    SlackSurfaceChannel {
                        channel_id: channel.into(),
                    },
                )),
            }),
            tag_id: "engineer".into(),
            enabled: true,
            ..Default::default()
        }),
        ..Default::default()
    }
}

fn event(alias: &str, team: &str, channel: &str, sequence: u64) -> AcceptSlackEventRequest {
    AcceptSlackEventRequest {
        account_id: alias.into(),
        event_id: format!("delivery-{sequence}"),
        team_id: team.into(),
        channel_id: channel.into(),
        message_ts: format!("1721000000.{sequence:06}"),
        thread_ts: "1721000000.000001".into(),
        prompt: "Review the change".into(),
        mention_tag_id: Some("engineer".into()),
    }
}

async fn put_permission(store: &Store, id: &str, action: &str) {
    store
        .put_permission_set(
            OPERATOR,
            &PutPermissionSetRequest {
                operation_id: format!("set-{id}"),
                permission_set: Some(PermissionSet {
                    set_id: id.into(),
                    name: id.into(),
                    permissions: vec![PolicyPermission {
                        target: PolicyPermissionTarget::Runtime as i32,
                        action: action.into(),
                        ..Default::default()
                    }],
                    ..Default::default()
                }),
                ..Default::default()
            },
        )
        .await
        .unwrap();
}

async fn contract(url: &str) {
    let store = Store::open(url).await.unwrap();
    for id in ["engineer", "other"] {
        store.put_tag(id, "Review requests", vec![]).await.unwrap();
    }
    put_permission(&store, "shared-read", "files:read").await;
    put_permission(&store, "edit", "files:write").await;
    store
        .put_context_set(
            OPERATOR,
            &PutContextSetRequest {
                operation_id: "context".into(),
                context_set: Some(ContextSet {
                    set_id: "runbook".into(),
                    name: "Runbook".into(),
                    items: vec![PolicyContextItem {
                        item_key: "release".into(),
                        r#type: "example/runbook".into(),
                        version: 1,
                        config_json: "{}".into(),
                        ..Default::default()
                    }],
                    ..Default::default()
                }),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    store
        .put_role(
            OPERATOR,
            &PutRoleRequest {
                operation_id: "reviewer-role".into(),
                role: Some(Role {
                    role_id: "reviewer".into(),
                    name: "Reviewer".into(),
                    purpose: "Review engineering work.".into(),
                    permission_set_ids: vec!["shared-read".into()],
                    status: RoleStatus::Active as i32,
                    ..Default::default()
                }),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    store
        .assign_role(
            OPERATOR,
            &AssignRoleRequest {
                operation_id: "assign-role".into(),
                role: "reviewer".into(),
                tag_id: "engineer".into(),
            },
        )
        .await
        .unwrap();

    let primary = store
        .put_surface_account(OPERATOR, &account("primary", "T123"))
        .await
        .unwrap();
    assert_eq!(primary.revision, 1);
    assert!(matches!(
        store
            .put_surface_account(OPERATOR, &account("duplicate", "T123"))
            .await,
        Err(StoreError::Conflict(_))
    ));
    store
        .put_surface_account(OPERATOR, &account("secondary", "T999"))
        .await
        .unwrap();
    let mut put = location("editing", "primary", "editing", "C123");
    let editing = put.location.as_mut().unwrap();
    editing.permission_set_ids = vec!["shared-read".into(), "edit".into()];
    editing.context_set_ids = vec!["runbook".into()];
    let (bound, replay) = tokio::join!(
        store.put_surface_location(OPERATOR, &put),
        store.put_surface_location(OPERATOR, &put),
    );
    let bound = bound.unwrap();
    assert_eq!(bound, replay.unwrap());
    for conflict in [
        location("same-scope", "primary", "another-alias", "C123"),
        location("same-alias", "primary", "editing", "C777"),
    ] {
        assert!(matches!(
            store.put_surface_location(OPERATOR, &conflict).await,
            Err(StoreError::Conflict(_))
        ));
    }
    store
        .put_surface_location(OPERATOR, &location("plain", "secondary", "plain", "C123"))
        .await
        .unwrap();
    assert!(matches!(
        store
            .delete_permission_set(
                OPERATOR,
                &DeletePolicyResourceRequest {
                    operation_id: "delete-edit".into(),
                    reference: "edit".into(),
                    expected_revision: 1,
                }
            )
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));

    let first = event("editing", "T123", "C123", 1);
    let admitted = store
        .accept_slack_event("connector:editing", &first)
        .await
        .unwrap()
        .task
        .unwrap();
    assert_eq!(admitted.allowed_actions, ["files:read", "files:write"]);
    let snapshot = admitted.policy_snapshot.as_ref().unwrap();
    assert_eq!(snapshot.permission_sets.len(), 2);
    assert_eq!(snapshot.context_sets.len(), 1);
    assert_eq!(snapshot.origin.as_ref().unwrap().location_id, "editing");
    assert_eq!(snapshot.origin.as_ref().unwrap().scope, bound.scope);
    assert_eq!(
        snapshot.origin.as_ref().unwrap().origin_actions,
        ["event:receive", "thread:read", "thread:reply"]
    );

    let other = store
        .accept_slack_event("connector:plain", &event("plain", "T999", "C123", 1))
        .await
        .unwrap()
        .task
        .unwrap();
    assert_eq!(other.allowed_actions, ["files:read"]);
    assert!(other.policy_snapshot.unwrap().context_sets.is_empty());
    assert_ne!(other.session_id, admitted.session_id);
    let mut wrong_tag = event("editing", "T123", "C123", 2);
    wrong_tag.mention_tag_id = Some("other".into());
    for mismatched in [
        wrong_tag,
        event("editing", "T123", "C777", 2),
        event("editing", "T999", "C123", 2),
    ] {
        assert!(
            store
                .accept_slack_event("connector:editing", &mismatched)
                .await
                .is_err()
        );
    }

    let internal = store
        .submit_task(
            OPERATOR,
            &SubmitTaskRequest {
                tag_id: "engineer".into(),
                session_id: "ordinary".into(),
                operation_id: "ordinary".into(),
                prompt: "Review".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(internal.allowed_actions, ["files:read"]);
    assert!(internal.policy_snapshot.unwrap().origin.is_none());

    let mut disabled = bound.clone();
    disabled.enabled = false;
    let updated = store
        .put_surface_location(
            OPERATOR,
            &PutSurfaceLocationRequest {
                operation_id: "disable-location".into(),
                location: Some(disabled),
                expected_revision: Some(bound.revision),
            },
        )
        .await
        .unwrap();
    assert_eq!(
        store
            .accept_slack_event("connector:editing", &first)
            .await
            .unwrap()
            .task
            .unwrap(),
        admitted
    );
    assert!(
        store
            .accept_slack_event("connector:editing", &event("editing", "T123", "C123", 2))
            .await
            .unwrap()
            .task
            .is_none()
    );
    let mut logical_replay = first.clone();
    logical_replay.event_id = "same-slack-message".into();
    assert_eq!(
        store
            .accept_slack_event("connector:editing", &logical_replay)
            .await
            .unwrap()
            .task,
        Some(admitted.clone())
    );
    let mut generic = AcceptEventRequest {
        account_id: "editing".into(),
        event_id: first.event_id,
        tag_id: admitted.tag_id.clone(),
        session_id: admitted.session_id.clone(),
        prompt: admitted.prompt.clone(),
        destination: Some(ReplyDestination {
            conversation_id: "C123".into(),
            thread_id: Some(first.thread_ts),
        }),
    };
    assert_eq!(
        store
            .accept_event("connector:editing", &generic)
            .await
            .unwrap(),
        admitted
    );
    generic.event_id = "generic-bypass".into();
    assert!(matches!(
        store.accept_event("connector:editing", &generic).await,
        Err(StoreError::PermissionDenied)
    ));
    store
        .delete_surface_location(
            OPERATOR,
            &DeleteSurfaceLocationRequest {
                operation_id: "delete-location".into(),
                location_id: "editing".into(),
                expected_revision: updated.revision,
            },
        )
        .await
        .unwrap();
    assert!(matches!(
        store.accept_event("connector:editing", &generic).await,
        Err(StoreError::PermissionDenied)
    ));
    assert!(
        store
            .accept_slack_event("connector:editing", &event("editing", "T123", "C123", 2))
            .await
            .unwrap()
            .task
            .is_none()
    );
    store
        .delete_permission_set(
            OPERATOR,
            &DeletePolicyResourceRequest {
                operation_id: "delete-edit".into(),
                reference: "edit".into(),
                expected_revision: 1,
            },
        )
        .await
        .unwrap();
    store.close().await;

    let reopened = Store::open(url).await.unwrap();
    assert_eq!(
        reopened.get_task(&admitted.task_id).await.unwrap(),
        admitted
    );
    let host = support::register_host(&reopened, "surface-policy-worker").await;
    let assignment = reopened
        .claim_task(&host, "claim-surface-task")
        .await
        .unwrap()
        .unwrap();
    let claimed = assignment.task.unwrap();
    assert_eq!(claimed.task_id, admitted.task_id);
    assert_eq!(claimed.policy_snapshot, admitted.policy_snapshot);
    reopened
        .start_task(
            &host,
            &StartTaskRequest {
                task_id: admitted.task_id.clone(),
                attempt_id: assignment.attempt_id.clone(),
                lease_token: assignment.lease_token.clone(),
            },
        )
        .await
        .unwrap();
    reopened
        .finish_task(
            &host,
            &FinishTaskRequest {
                task_id: admitted.task_id.clone(),
                attempt_id: assignment.attempt_id,
                lease_token: assignment.lease_token,
                result: "Reviewed.".into(),
                succeeded: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(
        reopened
            .claim_reply("connector:plain", "other-reply-claim")
            .await
            .unwrap()
            .reply
            .is_none()
    );
    let reply = reopened
        .claim_reply("connector:editing", "original-reply-claim")
        .await
        .unwrap()
        .reply
        .unwrap();
    assert_eq!(reply.task_id, admitted.task_id);
    assert_eq!(reply.destination, generic.destination);

    let mut sessions = Vec::new();
    for alias in ["unmanaged-one", "unmanaged-two"] {
        let task = reopened
            .accept_slack_event(
                &format!("connector:{alias}"),
                &event(alias, "T321", "C321", 1),
            )
            .await
            .unwrap()
            .task
            .unwrap();
        sessions.push(task.session_id);
    }
    assert_ne!(sessions[0], sessions[1]);
    verify_other_providers(&reopened).await;
    reopened.close().await;
}

async fn bind_provider(store: &Store, alias: &str, identity: Identity, scope: Scope) {
    let id = alias.replace('/', "-");
    store
        .put_surface_account(
            OPERATOR,
            &PutSurfaceAccountRequest {
                operation_id: format!("account-{id}"),
                account: Some(SurfaceAccount {
                    account_id: id.clone(),
                    identity: Some(SurfaceAccountIdentity {
                        provider: Some(identity),
                    }),
                    enabled: true,
                    revision: 0,
                }),
                expected_revision: None,
            },
        )
        .await
        .unwrap();
    store
        .put_surface_location(
            OPERATOR,
            &PutSurfaceLocationRequest {
                operation_id: format!("location-{id}"),
                location: Some(SurfaceLocation {
                    location_id: id.clone(),
                    account_id: id,
                    connector_account_id: alias.into(),
                    scope: Some(SurfaceLocationScope {
                        provider: Some(scope),
                    }),
                    tag_id: "engineer".into(),
                    enabled: true,
                    context_set_ids: vec!["runbook".into()],
                    ..Default::default()
                }),
                expected_revision: None,
            },
        )
        .await
        .unwrap();
}

fn assert_origin(task: Option<Task>, alias: &str) {
    let policy = task.unwrap().policy_snapshot.unwrap();
    assert_eq!(policy.origin.unwrap().connector_account_id, alias);
    assert_eq!(policy.context_sets[0].set_id, "runbook");
}

async fn verify_other_providers(store: &Store) {
    let github = "github/surface";
    bind_provider(
        store,
        github,
        Identity::Github(GithubSurfaceIdentity {
            external_account_id: "installation-12".into(),
        }),
        Scope::Github(GithubSurfaceRepository { repository_id: 123 }),
    )
    .await;
    let mut issue = AcceptGithubEventRequest {
        account_id: github.into(),
        delivery_id: "delivery".into(),
        repository_id: 124,
        repository: "acme/project".into(),
        number: 7,
        source_id: 456,
        kind: GithubEventKind::IssueComment.into(),
        action: GithubEventAction::Created.into(),
        prompt: "Inspect the issue".into(),
        tag_id: "engineer".into(),
        is_pull_request: false,
    };
    assert!(matches!(
        store
            .accept_github_event("connector:github/surface", &issue)
            .await,
        Err(StoreError::PermissionDenied)
    ));
    issue.repository_id = 123;
    assert_origin(
        store
            .accept_github_event("connector:github/surface", &issue)
            .await
            .unwrap()
            .task,
        github,
    );

    const FIRST: &str = "11111111-1111-4111-8111-111111111111";
    const SECOND: &str = "22222222-2222-4222-8222-222222222222";
    const THIRD: &str = "33333333-3333-4333-8333-333333333333";
    const FOURTH: &str = "44444444-4444-4444-8444-444444444444";
    let linear = "linear/surface";
    bind_provider(
        store,
        linear,
        Identity::Linear(LinearSurfaceIdentity {
            workspace_id: FIRST.into(),
        }),
        Scope::Linear(LinearSurfaceTeam {
            team_id: SECOND.into(),
        }),
    )
    .await;
    let mut issue = AcceptLinearEventRequest {
        account_id: linear.into(),
        delivery_id: "delivery".into(),
        workspace_id: THIRD.into(),
        team_id: SECOND.into(),
        issue_id: THIRD.into(),
        source_id: FOURTH.into(),
        kind: LinearEventKind::IssueComment.into(),
        action: LinearEventAction::Create.into(),
        prompt: "Inspect the issue".into(),
        tag_id: "engineer".into(),
    };
    assert!(matches!(
        store
            .accept_linear_event("connector:linear/surface", &issue)
            .await,
        Err(StoreError::PermissionDenied)
    ));
    issue.workspace_id = FIRST.into();
    assert_origin(
        store
            .accept_linear_event("connector:linear/surface", &issue)
            .await
            .unwrap()
            .task,
        linear,
    );

    let lark = "lark/surface";
    let mut message = AcceptLarkEventRequest {
        account_id: lark.into(),
        domain: LarkDomain::Lark.into(),
        app_id: "cli_0123456789abcdef".into(),
        tenant_key: "tenant-one".into(),
        event_id: "delivery".into(),
        chat_id: "oc_engineering".into(),
        message_id: "om_message".into(),
        root_message_id: "om_root".into(),
        actor_id: "ou_alice".into(),
        prompt: "Inspect the issue".into(),
        mention_tag_id: Some("engineer".into()),
        direct: false,
    };
    bind_provider(
        store,
        lark,
        Identity::Lark(LarkSurfaceIdentity {
            feishu: true,
            app_id: message.app_id.clone(),
            tenant_key: message.tenant_key.clone(),
        }),
        Scope::Lark(LarkSurfaceChat {
            chat_id: message.chat_id.clone(),
        }),
    )
    .await;
    assert!(matches!(
        store
            .accept_lark_event("connector:lark/surface", &message)
            .await,
        Err(StoreError::PermissionDenied)
    ));
    message.domain = LarkDomain::Feishu.into();
    assert_origin(
        store
            .accept_lark_event("connector:lark/surface", &message)
            .await
            .unwrap()
            .task,
        lark,
    );

    let teams = "teams/surface";
    let mut activity = AcceptMicrosoftTeamsActivityRequest {
        account_id: teams.into(),
        app_id: FIRST.into(),
        tenant_id: SECOND.into(),
        team_id: FOURTH.into(),
        channel_id: "19:channel@thread.tacv2".into(),
        conversation_id: "19:conversation@thread.tacv2".into(),
        activity_id: "1741000000001".into(),
        root_activity_id: "1741000000000".into(),
        actor_id: FOURTH.into(),
        service_url: "https://smba.trafficmanager.net/amer/".into(),
        prompt: "Inspect the issue".into(),
        tag_id: "engineer".into(),
    };
    bind_provider(
        store,
        teams,
        Identity::MicrosoftTeams(MicrosoftTeamsSurfaceIdentity {
            app_id: FIRST.into(),
            tenant_id: SECOND.into(),
        }),
        Scope::MicrosoftTeams(MicrosoftTeamsSurfaceChannel {
            team_id: THIRD.into(),
            channel_id: activity.channel_id.clone(),
        }),
    )
    .await;
    assert!(matches!(
        store
            .accept_microsoft_teams_activity("connector:teams/surface", &activity)
            .await,
        Err(StoreError::PermissionDenied)
    ));
    activity.team_id = THIRD.into();
    assert_origin(
        store
            .accept_microsoft_teams_activity("connector:teams/surface", &activity)
            .await
            .unwrap()
            .task,
        teams,
    );
}

#[tokio::test]
async fn sqlite_surface_policy_admission() {
    let directory = tempfile::tempdir().unwrap();
    contract(&format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("surface.db").display()
    ))
    .await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_surface_policy_admission() {
    let path =
        std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE").expect("test PostgreSQL URL");
    let url = std::fs::read_to_string(path).unwrap();
    let database = format!("supertag_surface_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {database}").as_str())
        .await
        .unwrap();
    let mut test_url = url::Url::parse(url.trim()).unwrap();
    test_url.set_path(&database);
    let result = tokio::task::LocalSet::new()
        .run_until(async move {
            tokio::task::spawn_local(async move { contract(test_url.as_str()).await }).await
        })
        .await;
    admin
        .execute(format!("DROP DATABASE {database} WITH (FORCE)").as_str())
        .await
        .unwrap();
    admin.close().await.unwrap();
    result.unwrap();
}
