mod support;
use sqlx::{Connection, Executor};
use supertag_control_plane::{Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;
const OP: &str = "operator:opencode";
const NOW: i64 = 1_900_000_000_000;
async fn version32(url: &str) -> i64 {
    sqlx::any::install_default_drivers();
    let pool = sqlx::AnyPool::connect(url).await.unwrap();
    let backend = if url.starts_with("sqlite:") {
        "sqlite"
    } else {
        "postgresql"
    };
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("migrations")
        .join(backend);
    let mut paths: Vec<_> = std::fs::read_dir(root)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|p| {
            p.file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .get(..4)
                .and_then(|v| v.parse::<u32>().ok())
                .is_some_and(|v| v <= 32)
        })
        .collect();
    paths.sort();
    assert_eq!(paths.len(), 32);
    let mut tx = pool.begin().await.unwrap();
    for path in paths {
        sqlx::raw_sql(&std::fs::read_to_string(path).unwrap())
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    sqlx::raw_sql("INSERT INTO supertag_v2_tags (tag_id,instructions,allowed_actions,revision,harness_kind) VALUES ('existing','Frozen instructions','[]',1,1);
    INSERT INTO supertag_v2_tasks (task_id,tag_id,session_id,prompt,instructions,allowed_actions,tag_revision,state,accepted_order,harness_kind,result) VALUES ('existing-task','existing','old-session','Old prompt','Frozen instructions','[]',1,3,1,2,'Saved result');
    INSERT INTO supertag_v2_claims (principal,operation_id,task_id,attempt_id,lease_token,harness_kind) VALUES ('host:old-host','old-claim','existing-task','old-attempt','old-lease',3);
    INSERT INTO supertag_v2_hosts (host_id,token_digest,all_tags,generation,enrolled_at_ms) VALUES ('old-host','synthetic-digest',1,1,1900000000000);
    INSERT INTO supertag_v2_host_readiness (host_id,generation,sequence,request_digest,capacity,available_slots,readiness,reason,harness_kind,workspace_ids,last_seen_at_ms,presence_expires_at_ms) VALUES ('old-host',1,1,'old-report',1,1,1,0,1,'[]',1900000000000,1900000030000);
    UPDATE supertag_v2_write_order SET revision=1 WHERE singleton=1;").execute(&mut *tx).await.unwrap();
    let head = sqlx::query_scalar("SELECT head FROM supertag_v2_watch_state")
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    pool.close().await;
    head
}
async fn contract(url: &str) {
    let old_head = version32(url).await;
    let store = Store::open(url).await.unwrap().with_execution_clock(|| NOW);
    let mut connection = sqlx::AnyConnection::connect(url).await.unwrap();
    let version: i64 = sqlx::query_scalar("SELECT version FROM supertag_v2_schema")
        .fetch_one(&mut connection)
        .await
        .unwrap();
    assert!(version >= 33, "OpenCode harness migration was not applied");
    let head: i64 = sqlx::query_scalar("SELECT head FROM supertag_v2_watch_state")
        .fetch_one(&mut connection)
        .await
        .unwrap();
    assert_eq!(
        head, old_head,
        "enum upgrade must not manufacture Watch events"
    );
    for (table, column, id, kind) in [
        ("tags", "tag_id", "existing", 1_i64),
        ("tasks", "task_id", "existing-task", 2),
        ("claims", "operation_id", "old-claim", 3),
        ("host_readiness", "host_id", "old-host", 1),
    ] {
        let value: i64 = sqlx::query_scalar(&format!(
            "SELECT harness_kind FROM supertag_v2_{table} WHERE {column}=$1"
        ))
        .bind(id)
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(value, kind);
        assert!(
            sqlx::query(&format!(
                "UPDATE supertag_v2_{table} SET harness_kind=6 WHERE {column}=$1"
            ))
            .bind(id)
            .execute(&mut connection)
            .await
            .is_err(),
            "{table} accepted unknown kind"
        );
    }
    assert_eq!(
        store
            .get_task("existing-task")
            .await
            .unwrap()
            .result
            .as_deref(),
        Some("Saved result")
    );
    connection.close().await.unwrap();
    let host = support::register_host(&store, "opencode").await;
    let report = store
        .report_host(
            &host,
            &ReportHostRequest {
                sequence: 1,
                capacity: 1,
                available_slots: 1,
                readiness: HostReadiness::Ready.into(),
                harness_kind: HarnessKind::Opencode.into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(report.harness_kind, HarnessKind::Opencode as i32);
    store
        .put_tag_spec(PutTagRequest {
            tag_id: "direct".into(),
            instructions: "Direct OpenCode selection".into(),
            harness_kind: HarnessKind::Opencode.into(),
            ..Default::default()
        })
        .await
        .unwrap();
    store
        .put_tag("role-tag", "Role selection", vec![])
        .await
        .unwrap();
    store
        .put_role(
            OP,
            &PutRoleRequest {
                operation_id: "role".into(),
                role: Some(Role {
                    role_id: "opencode-role".into(),
                    name: "OpenCode".into(),
                    purpose: "Inspect fixture".into(),
                    execution: Some(PolicyExecutionSettings {
                        harness: Some("opencode".into()),
                        models: vec!["openai/fixture-model".into()],
                        ..Default::default()
                    }),
                    ..Default::default()
                }),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    store
        .assign_role(
            OP,
            &AssignRoleRequest {
                operation_id: "assign".into(),
                tag_id: "role-tag".into(),
                role: "opencode-role".into(),
            },
        )
        .await
        .unwrap();
    let mut blocked = vec![];
    for (name, limits) in [
        (
            "tokens",
            ExecutionLimits {
                max_reported_tokens: Some(100),
                ..Default::default()
            },
        ),
        (
            "cost",
            ExecutionLimits {
                max_reported_cost: Some(ReportedCostLimit {
                    currency: "USD".into(),
                    amount_minor: 10,
                }),
                ..Default::default()
            },
        ),
        (
            "agents",
            ExecutionLimits {
                max_native_agents: Some(0),
                ..Default::default()
            },
        ),
    ] {
        blocked.push(
            store
                .submit_task(
                    OP,
                    &SubmitTaskRequest {
                        tag_id: "direct".into(),
                        session_id: name.into(),
                        operation_id: name.into(),
                        prompt: "Keep unsupported limit queued".into(),
                        execution_limits: Some(limits),
                    },
                )
                .await
                .unwrap(),
        );
    }
    store
        .put_tag_spec(PutTagRequest {
            tag_id: "required-skill".into(),
            instructions: "Required Skill".into(),
            harness_kind: HarnessKind::Opencode.into(),
            ..Default::default()
        })
        .await
        .unwrap();
    store
        .put_context_set(
            OP,
            &PutContextSetRequest {
                operation_id: "skills".into(),
                context_set: Some(ContextSet {
                    set_id: "skills".into(),
                    name: "Skills".into(),
                    items: vec![PolicyContextItem {
                        item_key: "review".into(),
                        r#type: "supertag/skill".into(),
                        version: 1,
                        required: true,
                        config_json: "{\"reference\":\"review\"}".into(),
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
            OP,
            &PutRoleRequest {
                operation_id: "skill-role".into(),
                role: Some(Role {
                    role_id: "skill-role".into(),
                    name: "Skill Role".into(),
                    purpose: "Required context".into(),
                    context_set_ids: vec!["skills".into()],
                    ..Default::default()
                }),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    store
        .assign_role(
            OP,
            &AssignRoleRequest {
                operation_id: "assign-skill".into(),
                tag_id: "required-skill".into(),
                role: "skill-role".into(),
            },
        )
        .await
        .unwrap();
    blocked.push(
        store
            .submit_task(
                OP,
                &SubmitTaskRequest {
                    tag_id: "required-skill".into(),
                    session_id: "skill".into(),
                    operation_id: "skill".into(),
                    prompt: "Wait for capable host".into(),
                    ..Default::default()
                },
            )
            .await
            .unwrap(),
    );
    let ready = store
        .submit_task(
            OP,
            &SubmitTaskRequest {
                tag_id: "role-tag".into(),
                session_id: "ready".into(),
                operation_id: "ready".into(),
                prompt: "Inspect fixture".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(ready.harness_kind, HarnessKind::Opencode as i32);
    assert_eq!(
        ready
            .policy_snapshot
            .as_ref()
            .unwrap()
            .execution
            .as_ref()
            .unwrap()
            .models,
        ["openai/fixture-model"]
    );
    assert!(
        store
            .claim_task_for_host(&host, "wrong-kind", &[], HarnessKind::Codex)
            .await
            .unwrap()
            .is_none()
    );
    let contracts = [ContextContract {
        r#type: "supertag/skill".into(),
        version: 1,
    }];
    let profile = HarnessExecutionProfile {
        model_ids: vec!["openai/fixture-model".into()],
        default_model: Some("openai/fixture-model".into()),
        allow_unsandboxed_commands: false,
        remote_file_workspace: false,
        mcp_servers: vec![],
        shared_execution: None,
    };
    let claim = store
        .claim_task_with_profile(
            &host,
            "claim",
            &[],
            HarnessKind::Opencode,
            &contracts,
            Some(&profile),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(claim.task.as_ref().unwrap().task_id, ready.task_id);
    assert_eq!(
        store
            .claim_task_with_profile(
                &host,
                "claim",
                &[],
                HarnessKind::Opencode,
                &contracts,
                Some(&profile),
            )
            .await
            .unwrap(),
        Some(claim.clone())
    );
    assert!(matches!(
        store
            .claim_task_for_host(&host, "claim", &[], HarnessKind::Codex)
            .await,
        Err(StoreError::Conflict(_))
    ));
    for task in blocked {
        assert_eq!(
            store.get_task(&task.task_id).await.unwrap().state(),
            TaskState::Queued
        );
    }
    let task = store
        .start_task(
            &host,
            &StartTaskRequest {
                task_id: ready.task_id.clone(),
                attempt_id: claim.attempt_id.clone(),
                lease_token: claim.lease_token.clone(),
            },
        )
        .await
        .unwrap();
    assert_eq!(task.harness_kind, HarnessKind::Opencode as i32);
    store
        .finish_task(
            &host,
            &FinishTaskRequest {
                task_id: ready.task_id.clone(),
                attempt_id: claim.attempt_id,
                lease_token: claim.lease_token,
                succeeded: true,
                result: "Fixture complete".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    Box::pin(history_contract(&store, url, &host)).await;
    store.close().await;
    let store = Store::open(url).await.unwrap();
    assert_eq!(
        store.get_task(&ready.task_id).await.unwrap().harness_kind,
        HarnessKind::Opencode as i32
    );
    store.close().await;
}

async fn history_contract(store: &Store, url: &str, host: &supertag_control_plane::HostAuthority) {
    store
        .put_tag_spec(PutTagRequest {
            tag_id: "history".into(),
            instructions: "History fixture".into(),
            harness_kind: HarnessKind::Opencode as i32,
            ..Default::default()
        })
        .await
        .unwrap();
    let mut connection = sqlx::AnyConnection::connect(url).await.unwrap();
    let mut eligible = vec![];
    for index in 0..11 {
        let principal = if index == 7 { "operator:other" } else { OP };
        let conversation = if index == 8 { "different" } else { "history" };
        let prompt = if index == 6 {
            "😀".repeat(1_100)
        } else {
            format!("Prior intent {index}")
        };
        let task = store
            .send_message(
                principal,
                &SendMessageRequest {
                    tag_id: "history".into(),
                    conversation: conversation.into(),
                    text: prompt.clone(),
                    operation_id: format!("history-{index}"),
                    ..Default::default()
                },
            )
            .await
            .unwrap()
            .task
            .unwrap();
        let result = if index == 6 {
            "😀".repeat(2_100)
        } else {
            format!("Prior result {index}")
        };
        // Seed terminal evidence independently of the execution path under test.
        let state = match index {
            3 => TaskState::Failed,
            4 => TaskState::Cancelled,
            _ => TaskState::Succeeded,
        };
        sqlx::query("UPDATE supertag_v2_tasks SET state=$1,result=$2 WHERE task_id=$3")
            .bind(state as i64)
            .bind(&result)
            .bind(&task.task_id)
            .execute(&mut connection)
            .await
            .unwrap();
        if index <= 6 {
            eligible.push(task.task_id.clone());
        }
        if index == 9 {
            sqlx::query("UPDATE supertag_v2_tasks SET result=NULL WHERE task_id=$1")
                .bind(&task.task_id)
                .execute(&mut connection)
                .await
                .unwrap();
        }
        if index == 10 {
            // An orphaned private Task has no audience and cannot contribute history.
            sqlx::query("DELETE FROM supertag_v2_conversation_messages WHERE task_id=$1")
                .bind(&task.task_id)
                .execute(&mut connection)
                .await
                .unwrap();
        }
    }
    let current = store
        .send_message(
            OP,
            &SendMessageRequest {
                tag_id: "history".into(),
                conversation: "history".into(),
                text: "Current turn".into(),
                operation_id: "history-current".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .task
        .unwrap();
    let claim = store
        .claim_task_for_host(host, "history-current", &[], HarnessKind::Opencode)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(claim.task.as_ref().unwrap().task_id, current.task_id);
    let attempt = InspectAttemptRequest {
        task_id: current.task_id.clone(),
        attempt_id: claim.attempt_id,
        lease_token: claim.lease_token,
    };
    assert!(
        store.get_attempt_history(host, &attempt).await.is_err(),
        "claimed is not running"
    );
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
    let expected = eligible[2..].to_vec();
    let history = store.get_attempt_history(host, &attempt).await.unwrap();
    assert_eq!(
        history
            .entries
            .iter()
            .map(|entry| entry.task_id.clone())
            .collect::<Vec<_>>(),
        expected
    );
    assert_eq!(
        history.entries[1].result.as_deref(),
        Some("Prior result 3"),
        "settled failed result is history"
    );
    assert_eq!(
        history.entries[2].result.as_deref(),
        Some("Prior result 4"),
        "settled cancelled result is history"
    );
    assert_eq!(
        history.entries[4].prompt,
        format!("{}\n[truncated]", "😀".repeat(1_000))
    );
    assert_eq!(
        history.entries[4].result,
        Some(format!("{}\n[truncated]", "😀".repeat(2_000)))
    );
    let wrong_generation = supertag_control_plane::HostAuthority::new("host:opencode", 2).unwrap();
    assert!(
        store
            .get_attempt_history(&wrong_generation, &attempt)
            .await
            .is_err()
    );
    assert!(
        store
            .get_attempt_history(
                host,
                &InspectAttemptRequest {
                    lease_token: "wrong".into(),
                    ..attempt.clone()
                }
            )
            .await
            .is_err()
    );
    assert!(
        store
            .clone()
            .with_execution_clock(|| NOW + 60_000)
            .get_attempt_history(host, &attempt)
            .await
            .is_err()
    );
    let reopened = Store::open(url).await.unwrap().with_execution_clock(|| NOW);
    assert_eq!(
        reopened.get_attempt_history(host, &attempt).await.unwrap(),
        history
    );
    reopened.close().await;
    // Later results and unsettled cleanup cannot be retroactively supplied to this turn.
    let later = store
        .send_message(
            OP,
            &SendMessageRequest {
                tag_id: "history".into(),
                conversation: "history".into(),
                text: "Later turn".into(),
                operation_id: "history-later".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .task
        .unwrap();
    sqlx::query("UPDATE supertag_v2_tasks SET state=$1,result='Later result' WHERE task_id=$2")
        .bind(TaskState::Succeeded as i64)
        .bind(later.task_id)
        .execute(&mut connection)
        .await
        .unwrap();
    assert_eq!(
        store.get_attempt_history(host, &attempt).await.unwrap(),
        history
    );
    sqlx::query("UPDATE supertag_v2_tasks SET cleanup_pending=1 WHERE task_id=$1")
        .bind(&eligible[6])
        .execute(&mut connection)
        .await
        .unwrap();
    let filtered = store.get_attempt_history(host, &attempt).await.unwrap();
    assert_eq!(
        filtered
            .entries
            .iter()
            .map(|entry| entry.task_id.clone())
            .collect::<Vec<_>>(),
        eligible[1..6]
    );
    sqlx::query("UPDATE supertag_v2_tasks SET state=$1,cleanup_pending=0 WHERE task_id=$2")
        .bind(TaskState::Queued as i64)
        .bind(&eligible[6])
        .execute(&mut connection)
        .await
        .unwrap();
    assert_eq!(
        store.get_attempt_history(host, &attempt).await.unwrap(),
        filtered
    );
    sqlx::query("UPDATE supertag_v2_tasks SET state=$1 WHERE task_id=$2")
        .bind(TaskState::Succeeded as i64)
        .bind(&eligible[6])
        .execute(&mut connection)
        .await
        .unwrap();
    connection.close().await.unwrap();
    store
        .finish_task(
            host,
            &FinishTaskRequest {
                task_id: attempt.task_id.clone(),
                attempt_id: attempt.attempt_id.clone(),
                lease_token: attempt.lease_token.clone(),
                result: "Current done".into(),
                succeeded: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(
        store.get_attempt_history(host, &attempt).await.is_err(),
        "settled Attempt has no history authority"
    );
}
#[tokio::test]
async fn sqlite_opencode_upgrade_and_claims() {
    let d = tempfile::tempdir().unwrap();
    Box::pin(contract(&format!(
        "sqlite://{}?mode=rwc",
        d.path().join("opencode.db").display()
    )))
    .await;
}
#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"]
async fn postgres_opencode_upgrade_and_claims() {
    let a =
        std::fs::read_to_string(std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE").unwrap())
            .unwrap();
    let name = format!("supertag_opencode_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(a.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await
        .unwrap();
    let mut u = url::Url::parse(a.trim()).unwrap();
    u.set_path(&name);
    let result = tokio::task::LocalSet::new()
        .run_until(async move {
            tokio::task::spawn_local(async move { Box::pin(contract(u.as_str())).await }).await
        })
        .await;
    admin
        .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
        .await
        .unwrap();
    admin.close().await.unwrap();
    result.unwrap();
}
