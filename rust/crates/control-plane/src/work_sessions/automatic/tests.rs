use super::*;
use sqlx::{Connection, Executor};
const NOW: i64 = 1_900_000_000_000;
const OP: &str = "operator:budget";
fn limits(tokens: u64, cost: u64) -> ExecutionLimits {
    ExecutionLimits {
        max_reported_tokens: Some(tokens),
        max_reported_cost: Some(ReportedCostLimit {
            currency: "USD".into(),
            amount_minor: cost,
        }),
        max_native_agents: Some(2),
    }
}
async fn run(s: &Store, h: &HostAuthority, id: &str) -> InspectAttemptRequest {
    let claim = s
        .claim_task(h, &Uuid::new_v4().to_string())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(claim.task.unwrap().task_id, id);
    let a = InspectAttemptRequest {
        task_id: id.into(),
        attempt_id: claim.attempt_id,
        lease_token: claim.lease_token,
    };
    s.start_task(
        h,
        &StartTaskRequest {
            task_id: id.into(),
            attempt_id: a.attempt_id.clone(),
            lease_token: a.lease_token.clone(),
        },
    )
    .await
    .unwrap();
    a
}
async fn finish(s: &Store, h: &HostAuthority, a: &InspectAttemptRequest, wait: Vec<String>) {
    s.finish_task(
        h,
        &FinishTaskRequest {
            task_id: a.task_id.clone(),
            attempt_id: a.attempt_id.clone(),
            lease_token: a.lease_token.clone(),
            succeeded: true,
            result: "Waiting for approval".into(),
            waiting_approval_ids: wait,
            ..Default::default()
        },
    )
    .await
    .unwrap();
}
async fn contract(url: &str) {
    let mut s = Store::open(url).await.unwrap().with_execution_clock(|| NOW);
    s.seed_host("budget-auto", &Sha256::digest(b"automatic budget fixture"))
        .await
        .unwrap();
    let reg = s.register_host("budget-auto", "one").await.unwrap();
    let h = HostAuthority::new("host:budget-auto", reg.generation).unwrap();
    for scenario in ["allowed", "budget", "permissions"] {
        s.put_tag_spec(PutTagRequest {
            tag_id: "lead".into(),
            instructions: "Coordinate".into(),
            allowed_actions: vec!["mailbox:send".into()],
            approval_rules: vec![ApprovalRule {
                action: "mailbox:send".into(),
                operator_ids: vec!["budget".into()],
            }],
            ..Default::default()
        })
        .await
        .unwrap();
        let parent = s
            .submit_task(
                OP,
                &SubmitTaskRequest {
                    output_policy: None,
                    tag_id: "lead".into(),
                    session_id: scenario.into(),
                    operation_id: scenario.into(),
                    prompt: "Coordinate".into(),
                    execution_limits: Some(limits(10_000, 500)),
                    input_artifacts: vec![],
                },
            )
            .await
            .unwrap();
        let pa = run(&s, &h, &parent.task_id).await;
        s.report_attempt_usage(
            &h,
            &ReportAttemptUsageRequest {
                attempt: Some(pa.clone()),
                sequence: 1,
                native_usage: Some(NativeTokenUsage {
                    input_tokens: 1500,
                    output_tokens: 500,
                    total_tokens: Some(2000),
                    ..Default::default()
                }),
                amount_minor: Some(100),
                currency: Some("USD".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let work = s
            .start_work_session(
                &h,
                &StartWorkSessionRequest {
                    attempt: Some(pa.clone()),
                    operation_id: "child".into(),
                    title: "Review".into(),
                    instruction: "Review fixture".into(),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        finish(&s, &h, &pa, vec![]).await;
        let ca = run(&s, &h, &work.latest_task_id).await;
        let spent = if scenario == "budget" { 7501 } else { 3000 };
        s.report_attempt_usage(
            &h,
            &ReportAttemptUsageRequest {
                attempt: Some(ca.clone()),
                sequence: 1,
                native_usage: Some(NativeTokenUsage {
                    input_tokens: spent,
                    output_tokens: 0,
                    total_tokens: Some(spent),
                    ..Default::default()
                }),
                amount_minor: Some(150),
                currency: Some("USD".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        // Exercise the real internal effect gate. Native child effects remain
        // separately scoped; this contract does not introduce a public grant RPC.
        let (mut tx, order) = s.write().await.unwrap();
        let approval = crate::approvals::gate_in(
            &mut tx,
            &h,
            &RequestApprovalRequest {
                attempt: Some(ca.clone()),
                operation_id: "effect".into(),
                action: "mailbox:send".into(),
                resource: "tag:reviewer".into(),
                arguments_json: "{\"text\":\"fixture\"}".into(),
                summary: "Send reviewed fixture".into(),
            },
            NOW,
            order,
        )
        .await
        .unwrap()
        .approval
        .unwrap();
        tx.commit().await.unwrap();
        finish(&s, &h, &ca, vec![approval.approval_id.clone()]).await;
        if scenario == "permissions" {
            s.put_tag("lead", "Revoked", vec![]).await.unwrap();
        }
        s.close().await;
        s = Store::open(url).await.unwrap().with_execution_clock(|| NOW);
        let request = DecideApprovalRequest {
            approval_id: approval.approval_id.clone(),
            operation_id: format!("decide:{scenario}"),
            approve: true,
            scope: ApprovalScope::Once.into(),
            reason: "Checked".into(),
            ..Default::default()
        };
        let (one, two) = tokio::join!(
            s.decide_approval(OP, &request),
            s.decide_approval(OP, &request)
        );
        one.unwrap();
        two.unwrap();
        s.sweep_approvals().await.unwrap();
        let latest = s.get_work_session(OP, &work.work_session_id).await.unwrap();
        let previous_report = {
            let mut tx = s.pool.begin().await.unwrap();
            let id:String=sqlx::query_scalar("SELECT report_task_id FROM supertag_v2_work_session_reports WHERE child_task_id=$1").bind(&ca.task_id).fetch_one(&mut *tx).await.unwrap();
            tx.commit().await.unwrap();
            id
        };
        let r = run(&s, &h, &previous_report).await;
        finish(&s, &h, &r, vec![]).await;
        if scenario == "allowed" {
            assert_ne!(latest.latest_task_id, ca.task_id);
            let next = s.get_task(&latest.latest_task_id).await.unwrap();
            assert_eq!(next.execution_limits, Some(limits(5000, 250)));
            assert_eq!(next.allowed_actions, parent.allowed_actions);
            assert_eq!(next.approval_rules, parent.approval_rules);
            let mut tx = s.pool.begin().await.unwrap();
            let starter: String = sqlx::query_scalar(
                "SELECT starter_task_id FROM supertag_v2_work_session_tasks WHERE task_id=$1",
            )
            .bind(&next.task_id)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
            assert_eq!(starter, parent.task_id);
            assert_eq!(
                task_scope_in(&mut tx, &next.task_id)
                    .await
                    .unwrap()
                    .unwrap()
                    .task_id,
                next.task_id
            );
            tx.commit().await.unwrap();
            let a = run(&s, &h, &next.task_id).await;
            finish(&s, &h, &a, vec![]).await;
            let report = s
                .get_work_session(OP, &work.work_session_id)
                .await
                .unwrap()
                .report_task_id
                .unwrap();
            let a = run(&s, &h, &report).await;
            finish(&s, &h, &a, vec![]).await;
        } else {
            assert_eq!(latest.latest_task_id, ca.task_id);
            let mut tx = s.pool.begin().await.unwrap();
            let stop=sqlx::query("SELECT reason,notice_task_id FROM supertag_v2_approval_continuation_stops WHERE task_id=$1").bind(&ca.task_id).fetch_one(&mut *tx).await.unwrap();
            assert_eq!(stop.get::<String, _>("reason"), scenario);
            let notice: String = stop.get("notice_task_id");
            assert!(
                !crate::approvals::task_waits_in(&mut tx, &ca.task_id)
                    .await
                    .unwrap()
            );
            tx.commit().await.unwrap();
            s.close().await;
            s = Store::open(url).await.unwrap().with_execution_clock(|| NOW);
            s.sweep_approvals().await.unwrap();
            s.decide_approval(OP, &request).await.unwrap();
            let a = run(&s, &h, &notice).await;
            finish(&s, &h, &a, vec![]).await;
        }
        assert!(
            s.claim_task(&h, &Uuid::new_v4().to_string())
                .await
                .unwrap()
                .is_none()
        );
    }
    Box::pin(delegated_membership(&s, &h)).await;
    s.close().await;
}
async fn delegated_membership(s: &Store, h: &HostAuthority) {
    for id in ["owner", "member"] {
        s.put_tag_spec(PutTagRequest {
            tag_id: id.into(),
            instructions: "Coordinate".into(),
            allowed_actions: vec!["files:read".into(), "mailbox:send".into()],
            approval_rules: vec![ApprovalRule {
                action: "mailbox:send".into(),
                operator_ids: vec!["budget".into()],
            }],
            ..Default::default()
        })
        .await
        .unwrap();
    }
    let team = s
        .create_team(
            OP,
            &CreateTeamRequest {
                operation_id: "team".into(),
                team_id: "team".into(),
                name: "Fixture".into(),
                member_tag_ids: vec!["owner".into(), "member".into()],
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let objective = s
        .create_objective(
            OP,
            &CreateObjectiveRequest {
                operation_id: "delegated".into(),
                objective_id: "delegated".into(),
                owner_tag_id: "owner".into(),
                outcome: "Check membership".into(),
                team_id: Some(team.team_id.clone()),
                ongoing: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let a = run(s, h, &objective.starting_task_id).await;
    let work = s
        .start_work_session(
            h,
            &StartWorkSessionRequest {
                attempt: Some(a.clone()),
                operation_id: "delegate".into(),
                title: "Delegated fixture".into(),
                instruction: "Review".into(),
                target_tag_id: Some("member".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    finish(s, h, &a, vec![]).await;
    let child = run(s, h, &work.latest_task_id).await;
    let (mut tx, order) = s.write().await.unwrap();
    let approval = crate::approvals::gate_in(
        &mut tx,
        h,
        &RequestApprovalRequest {
            attempt: Some(child.clone()),
            operation_id: "effect".into(),
            action: "mailbox:send".into(),
            resource: "tag:owner".into(),
            arguments_json: "{}".into(),
            summary: "Review effect".into(),
        },
        NOW,
        order,
    )
    .await
    .unwrap()
    .approval
    .unwrap();
    tx.commit().await.unwrap();
    finish(s, h, &child, vec![approval.approval_id.clone()]).await;
    s.update_team(
        OP,
        &UpdateTeamRequest {
            operation_id: "remove-member".into(),
            team: team.team_id,
            expected_revision: team.revision,
            members: Some(TeamMembers {
                tag_ids: vec!["owner".into()],
            }),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    s.decide_approval(
        OP,
        &DecideApprovalRequest {
            approval_id: approval.approval_id,
            operation_id: "approve-delegated".into(),
            approve: true,
            scope: ApprovalScope::Once.into(),
            reason: "Checked".into(),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let mut tx = s.pool.begin().await.unwrap();
    let reason: String = sqlx::query_scalar(
        "SELECT reason FROM supertag_v2_approval_continuation_stops WHERE task_id=$1",
    )
    .bind(&child.task_id)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    assert_eq!(reason, "permissions");
    tx.commit().await.unwrap();
    assert_eq!(
        s.get_work_session(OP, &work.work_session_id)
            .await
            .unwrap()
            .latest_task_id,
        child.task_id
    );
}

#[tokio::test]
async fn sqlite_approval_uses_original_pool_and_stops_once() {
    let d = tempfile::tempdir().unwrap();
    Box::pin(contract(&format!(
        "sqlite://{}?mode=rwc",
        d.path().join("auto.db").display()
    )))
    .await;
}
#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"]
async fn postgres_approval_uses_original_pool_and_stops_once() {
    let a =
        std::fs::read_to_string(std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE").unwrap())
            .unwrap();
    let name = format!("supertag_budget_auto_{}", Uuid::new_v4().simple());
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
