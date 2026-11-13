mod support;

use sha2::{Digest, Sha256};
use sqlx::{Connection, Executor};
use supertag_control_plane::{HostAuthority, Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;

const OPERATOR: &str = "operator:alice";
const OWNER_HARNESS: HarnessKind = HarnessKind::Codex;
const CHILD_HARNESS: HarnessKind = HarnessKind::ClaudeCode;

async fn tag(store: &Store, id: &str, instructions: &str, actions: &[&str], harness: HarnessKind) {
    store
        .put_tag_spec(PutTagRequest {
            tag_id: id.into(),
            instructions: instructions.into(),
            allowed_actions: actions.iter().map(|action| (*action).into()).collect(),
            harness_kind: harness.into(),
            ..Default::default()
        })
        .await
        .unwrap();
}

async fn enroll_scoped(store: &Store, host: &str, tag: &str) {
    let key = Sha256::digest(format!("delegation auth key: {host}")).to_vec();
    store
        .create_auth_key(
            OPERATOR,
            &CreateAuthKeyRequest {
                host_id: host.into(),
                operation_id: format!("issue-{host}"),
                key_digest: key.clone(),
                expires_in_ms: 30_000,
                allowed_tag_ids: vec![tag.into()],
                all_tags: false,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let result = store
        .enroll_host(
            &EnrollHostRequest {
                host_id: host.into(),
                operation_id: format!("enroll-{host}"),
                token_digest: Sha256::digest(format!("delegation credential: {host}")).to_vec(),
            },
            &key,
        )
        .await
        .unwrap();
    assert_eq!(result.generation, 0);
}

async fn register(store: &Store, host: &str) -> HostAuthority {
    let record = store
        .register_host(host, "delegation-incarnation")
        .await
        .unwrap();
    HostAuthority::new(format!("host:{host}"), record.generation).unwrap()
}

async fn run(
    store: &Store,
    host: &HostAuthority,
    task_id: &str,
    harness: HarnessKind,
    profile: Option<&HarnessExecutionProfile>,
) -> InspectAttemptRequest {
    let claim = store
        .claim_task_with_profile(
            host,
            &Uuid::new_v4().to_string(),
            &[],
            harness,
            &[],
            profile,
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(claim.task.unwrap().task_id, task_id);
    let attempt = InspectAttemptRequest {
        task_id: task_id.into(),
        attempt_id: claim.attempt_id,
        lease_token: claim.lease_token,
    };
    store
        .start_task(
            host,
            &StartTaskRequest {
                task_id: attempt.task_id.clone(),
                attempt_id: attempt.attempt_id.clone(),
                lease_token: attempt.lease_token.clone(),
            },
        )
        .await
        .unwrap();
    attempt
}

fn finish(attempt: &InspectAttemptRequest) -> FinishTaskRequest {
    FinishTaskRequest {
        task_id: attempt.task_id.clone(),
        attempt_id: attempt.attempt_id.clone(),
        lease_token: attempt.lease_token.clone(),
        result: "Verified result".into(),
        succeeded: true,
        ..Default::default()
    }
}

fn delegate(attempt: &InspectAttemptRequest, target: &str) -> StartWorkSessionRequest {
    StartWorkSessionRequest {
        attempt: Some(attempt.clone()),
        operation_id: format!("delegate-{target}"),
        title: "Verify the patch".into(),
        instruction: "Inspect the checkout".into(),
        target_tag_id: Some(target.into()),
        ..Default::default()
    }
}

async fn change_members(store: &Store, team: &Team, members: &[&str], operation: &str) -> Team {
    store
        .update_team(
            OPERATOR,
            &UpdateTeamRequest {
                operation_id: operation.into(),
                team: team.team_id.clone(),
                expected_revision: team.revision,
                members: Some(TeamMembers {
                    tag_ids: members.iter().map(|id| (*id).into()).collect(),
                }),
                ..Default::default()
            },
        )
        .await
        .unwrap()
}

async fn assign_gate(store: &Store, tag: &str, set_id: &str, action: &str, approvers: &[&str]) {
    store
        .put_permission_set(
            OPERATOR,
            &PutPermissionSetRequest {
                operation_id: format!("create-{set_id}"),
                permission_set: Some(PermissionSet {
                    set_id: set_id.into(),
                    name: set_id.into(),
                    approvers: approvers.iter().map(|id| (*id).into()).collect(),
                    permissions: vec![PolicyPermission {
                        target: PolicyPermissionTarget::Runtime.into(),
                        action: action.into(),
                        approval_required: true,
                        ..Default::default()
                    }],
                    ..Default::default()
                }),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let role_id = format!("role-{set_id}");
    store
        .put_role(
            OPERATOR,
            &PutRoleRequest {
                operation_id: format!("create-{role_id}"),
                role: Some(Role {
                    role_id: role_id.clone(),
                    name: role_id.clone(),
                    purpose: "Carry the required approval".into(),
                    permission_set_ids: vec![set_id.into()],
                    status: RoleStatus::Active.into(),
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
                operation_id: format!("assign-{role_id}"),
                role: role_id,
                tag_id: tag.into(),
            },
        )
        .await
        .unwrap();
}

async fn assert_delegated_gates(store: &Store, objective: &Objective, host: &HostAuthority) {
    assign_gate(
        store,
        "owner",
        "owner-gate",
        "files:delegate-write",
        &["operator:alice", "tag:outsider"],
    )
    .await;
    assign_gate(
        store,
        "builder",
        "member-gate",
        "files:write",
        &["operator:bob", "tag:owner"],
    )
    .await;
    let parent = store
        .submit_task(
            OPERATOR,
            &SubmitTaskRequest {
                output_policy: None,
                execution_limits: None,
                tag_id: objective.owner_tag_id.clone(),
                session_id: objective.session_id.clone(),
                operation_id: "delegate-gated-write".into(),
                prompt: "Review the approved write path".into(),
                input_artifacts: vec![],
            },
        )
        .await
        .unwrap();
    let parent = run(store, host, &parent.task_id, OWNER_HARNESS, None).await;
    let work = store
        .start_work_session(host, &delegate(&parent, "builder"))
        .await
        .unwrap();
    let task = store.get_task(&work.latest_task_id).await.unwrap();
    assert_eq!(task.allowed_actions, ["files:read"]);
    let authority = task.policy_snapshot.unwrap().runtime_authority.unwrap();
    assert!(
        authority
            .actions
            .iter()
            .any(|action| action == "files:write")
    );
    let write = authority
        .approvals
        .iter()
        .find(|requirement| requirement.action == "files:write")
        .unwrap();
    assert_eq!(write.permission_set_ids, ["member-gate", "owner-gate"]);
    assert_eq!(
        write.approvers,
        [
            "operator:alice",
            "operator:bob",
            "tag:outsider",
            "tag:owner"
        ]
    );
}

async fn contract(url: &str) {
    let store = Store::open(url).await.unwrap();
    let owner_actions = ["files:read", "files:delegate-write", "commands:execute"];
    let child_actions = ["files:read", "files:write", "workstream:post"];
    tag(
        &store,
        "owner",
        "Owner instructions",
        &owner_actions,
        OWNER_HARNESS,
    )
    .await;
    let original_model = "builder-original";
    let child_profile = HarnessExecutionProfile {
        model_ids: vec![original_model.into()],
        default_model: Some(original_model.into()),
        ..Default::default()
    };
    let mut builder = PutTagRequest {
        tag_id: "builder".into(),
        instructions: "Member instructions".into(),
        allowed_actions: child_actions
            .iter()
            .map(|action| (*action).into())
            .collect(),
        harness_kind: CHILD_HARNESS.into(),
        execution: Some(PolicyExecutionSettings {
            models: vec![original_model.into()],
            efforts: vec!["high".into()],
            ..Default::default()
        }),
        ..Default::default()
    };
    store.put_tag_spec(builder.clone()).await.unwrap();
    tag(&store, "outsider", "Outside the Team", &[], CHILD_HARNESS).await;
    let role = store
        .put_role(
            OPERATOR,
            &PutRoleRequest {
                operation_id: "create-builder-role".into(),
                role: Some(Role {
                    role_id: "builder-role".into(),
                    name: "Builder".into(),
                    purpose: "Make the proposed change".into(),
                    instructions: "Verify the patch before reporting.".into(),
                    status: RoleStatus::Active.into(),
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
                operation_id: "assign-builder-role".into(),
                role: role.role_id,
                tag_id: "builder".into(),
            },
        )
        .await
        .unwrap();
    enroll_scoped(&store, "owner-host", "owner").await;
    let owner_host = register(&store, "owner-host").await;
    enroll_scoped(&store, "builder-host", "builder").await;

    let ordinary = store
        .submit_task(
            OPERATOR,
            &SubmitTaskRequest {
                output_policy: None,
                execution_limits: None,
                tag_id: "owner".into(),
                session_id: "ordinary".into(),
                operation_id: "ordinary-turn".into(),
                prompt: "Review a regular request".into(),
                input_artifacts: vec![],
            },
        )
        .await
        .unwrap();
    let attempt = run(&store, &owner_host, &ordinary.task_id, OWNER_HARNESS, None).await;
    assert!(matches!(
        store
            .start_work_session(&owner_host, &delegate(&attempt, "builder"))
            .await,
        Err(StoreError::PermissionDenied)
    ));
    store
        .finish_task(&owner_host, &finish(&attempt))
        .await
        .unwrap();

    let team = store
        .create_team(
            OPERATOR,
            &CreateTeamRequest {
                operation_id: "create-team".into(),
                team_id: "engineering".into(),
                name: "Engineering".into(),
                member_tag_ids: vec!["owner".into(), "builder".into()],
                max_concurrency: Some(1),
            },
        )
        .await
        .unwrap();
    let objective = store
        .create_objective(
            OPERATOR,
            &CreateObjectiveRequest {
                operation_id: "create-objective".into(),
                objective_id: "verify-release".into(),
                owner_tag_id: "owner".into(),
                outcome: "Verify the release".into(),
                ongoing: true,
                team_id: Some(team.team_id.clone()),
                runtime_actions: Some(RuntimeActions {
                    actions: vec!["files:read".into(), "files:delegate-write".into()],
                }),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let owner = run(
        &store,
        &owner_host,
        &objective.starting_task_id,
        OWNER_HARNESS,
        None,
    )
    .await;
    assert!(matches!(
        store
            .start_work_session(&owner_host, &delegate(&owner, "outsider"))
            .await,
        Err(StoreError::PermissionDenied)
    ));
    let request = delegate(&owner, "builder");
    assert!(matches!(
        store.start_work_session(&owner_host, &request).await,
        Err(StoreError::FailedPrecondition(_))
    ));
    let builder_host = register(&store, "builder-host").await;
    let (work, replay) = tokio::join!(
        store.start_work_session(&owner_host, &request),
        store.start_work_session(&owner_host, &request),
    );
    let work = work.unwrap();
    assert_eq!(work, replay.unwrap());
    assert_eq!(work.tag_id, "builder");
    assert_eq!(work.parent_tag_id, "owner");
    assert_eq!(work.parent_session_id, objective.session_id);
    assert_eq!(
        work.objective_id.as_deref(),
        Some(objective.objective_id.as_str())
    );
    let task = store.get_task(&work.latest_task_id).await.unwrap();
    assert_eq!(task.harness_kind(), CHILD_HARNESS);
    let previous_execution = task.execution_selection.as_ref().unwrap().clone();
    assert_eq!(previous_execution.model.as_deref(), Some(original_model));
    assert_eq!(previous_execution.effort.as_deref(), Some("high"));
    assert!(task.instructions.contains("Member instructions"));
    assert!(
        task.instructions
            .contains("Verify the patch before reporting.")
    );
    assert!(!task.instructions.contains("Owner instructions"));
    assert_eq!(task.allowed_actions, ["files:read", "files:write"]);
    let authority = task.policy_snapshot.unwrap().runtime_authority.unwrap();
    assert_eq!(
        authority.actions,
        ["files:delegate-write", "files:read", "files:write"]
    );
    assert_eq!(
        authority.delegating_task_id.as_deref(),
        Some(owner.task_id.as_str())
    );
    assert_eq!(
        authority.objective_id.as_deref(),
        Some(objective.objective_id.as_str())
    );

    assert!(
        store
            .claim_task_with_profile(
                &builder_host,
                "team-capacity",
                &[],
                CHILD_HARNESS,
                &[],
                Some(&child_profile)
            )
            .await
            .unwrap()
            .is_none()
    );
    store
        .finish_task(&owner_host, &finish(&owner))
        .await
        .unwrap();
    assert!(
        store
            .claim_task_with_profile(
                &owner_host,
                "wrong-tag-host",
                &[],
                CHILD_HARNESS,
                &[],
                Some(&child_profile)
            )
            .await
            .unwrap()
            .is_none()
    );
    let child = run(
        &store,
        &builder_host,
        &work.latest_task_id,
        CHILD_HARNESS,
        Some(&child_profile),
    )
    .await;
    assert!(matches!(
        store
            .start_work_session(&builder_host, &delegate(&child, "owner"))
            .await,
        Err(StoreError::PermissionDenied)
    ));
    assert!(matches!(
        store
            .finish_task(
                &builder_host,
                &FinishTaskRequest {
                    objective_signal: ObjectiveSignal::Completed.into(),
                    ..finish(&child)
                }
            )
            .await,
        Err(StoreError::InvalidArgument(_))
    ));
    store
        .finish_task(&builder_host, &finish(&child))
        .await
        .unwrap();
    let first_report = store
        .get_work_session(OPERATOR, &work.work_session_id)
        .await
        .unwrap()
        .report_task_id
        .unwrap();
    let report = store.get_task(&first_report).await.unwrap();
    assert_eq!(report.tag_id, "owner");
    assert_eq!(report.session_id, objective.session_id);
    assert!(report.instructions.contains("Owner instructions"));
    let report_attempt = run(&store, &owner_host, &first_report, OWNER_HARNESS, None).await;
    let continuation = ContinueWorkSessionRequest {
        attempt: Some(report_attempt.clone()),
        operation_id: "continue-builder".into(),
        work_session_id: work.work_session_id.clone(),
        message: "Verify one more condition".into(),
    };

    let team = change_members(&store, &team, &["owner"], "remove-builder").await;
    assert!(matches!(
        store
            .continue_work_session(&owner_host, &continuation)
            .await,
        Err(StoreError::PermissionDenied)
    ));
    assert_eq!(
        store
            .start_work_session(&owner_host, &request)
            .await
            .unwrap()
            .latest_task_id,
        work.latest_task_id
    );
    change_members(&store, &team, &["owner", "builder"], "restore-builder").await;
    store.revoke_host("builder-host").await.unwrap();
    assert!(matches!(
        store
            .continue_work_session(&owner_host, &continuation)
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    let all_tags = support::register_host(&store, "all-tags-host").await;
    builder.instructions = "Member instructions changed".into();
    store
        .put_tag_spec(PutTagRequest {
            allowed_actions: vec!["files:read".into()],
            ..builder.clone()
        })
        .await
        .unwrap();
    assert!(matches!(
        store
            .continue_work_session(&owner_host, &continuation)
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    assert_eq!(
        store
            .get_work_session(OPERATOR, &work.work_session_id)
            .await
            .unwrap()
            .latest_task_id,
        work.latest_task_id
    );
    store.put_tag_spec(builder.clone()).await.unwrap();
    let execution = builder.execution.as_mut().unwrap();
    execution.models = vec!["builder-replacement".into()];
    execution.efforts = vec!["low".into()];
    store.put_tag_spec(builder).await.unwrap();
    let continued = store
        .continue_work_session(&owner_host, &continuation)
        .await
        .unwrap();
    assert_eq!(continued.tag_id, "builder");
    assert_eq!(continued.work_session_id, work.work_session_id);
    assert_eq!(continued.starter_task_id, first_report);
    assert_ne!(continued.latest_task_id, work.latest_task_id);
    let task = store.get_task(&continued.latest_task_id).await.unwrap();
    assert_eq!(task.allowed_actions, ["files:read", "files:write"]);
    assert_eq!(task.harness_kind(), CHILD_HARNESS);
    assert_eq!(task.execution_selection.as_ref(), Some(&previous_execution));
    assert_eq!(
        task.policy_snapshot
            .unwrap()
            .runtime_authority
            .unwrap()
            .delegating_task_id
            .as_deref(),
        Some(first_report.as_str())
    );
    assert!(task.instructions.contains("Member instructions changed"));
    store
        .finish_task(&owner_host, &finish(&report_attempt))
        .await
        .unwrap();
    let attempt = run(
        &store,
        &all_tags,
        &continued.latest_task_id,
        CHILD_HARNESS,
        Some(&child_profile),
    )
    .await;
    store
        .finish_task(&all_tags, &finish(&attempt))
        .await
        .unwrap();
    let next_report = store
        .get_work_session(OPERATOR, &work.work_session_id)
        .await
        .unwrap()
        .report_task_id
        .unwrap();
    assert_ne!(next_report, first_report);
    let report = store.get_task(&next_report).await.unwrap();
    assert_eq!(report.tag_id, "owner");
    assert_eq!(report.session_id, objective.session_id);
    assert_eq!(
        store
            .get_objective(&objective.objective_id)
            .await
            .unwrap()
            .status(),
        ObjectiveStatus::Working
    );
    let attempt = run(&store, &owner_host, &next_report, OWNER_HARNESS, None).await;
    store
        .finish_task(&owner_host, &finish(&attempt))
        .await
        .unwrap();
    assert_delegated_gates(&store, &objective, &owner_host).await;
    store.close().await;
}

#[tokio::test]
async fn sqlite_work_session_delegation() {
    let dir = tempfile::tempdir().unwrap();
    contract(&format!(
        "sqlite://{}?mode=rwc",
        dir.path().join("delegation.db").display()
    ))
    .await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_work_session_delegation() {
    let file = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE").expect("URL file");
    let admin_url = std::fs::read_to_string(file).unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    let database = format!("supertag_delegation_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {database}").as_str())
        .await
        .unwrap();
    url.set_path(&database);
    let result = tokio::task::LocalSet::new()
        .run_until(async move {
            tokio::task::spawn_local(async move { contract(url.as_str()).await }).await
        })
        .await;
    admin
        .execute(format!("DROP DATABASE {database} WITH (FORCE)").as_str())
        .await
        .unwrap();
    admin.close().await.unwrap();
    result.unwrap();
}
