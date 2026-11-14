mod support;
use sqlx::{Connection, Executor};
use supertag_control_plane::{HostAuthority, Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;
const OP: &str = "operator:budget";
const NOW: i64 = 1_900_000_000_000;
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
    loop {
        let c = s
            .claim_task(h, &Uuid::new_v4().to_string())
            .await
            .unwrap()
            .unwrap();
        let task = c.task.unwrap();
        let a = InspectAttemptRequest {
            task_id: task.task_id.clone(),
            attempt_id: c.attempt_id,
            lease_token: c.lease_token,
        };
        s.start_task(
            h,
            &StartTaskRequest {
                task_id: a.task_id.clone(),
                attempt_id: a.attempt_id.clone(),
                lease_token: a.lease_token.clone(),
            },
        )
        .await
        .unwrap();
        if task.task_id == id {
            return a;
        }
        assert!(
            task.prompt.contains("Provider-reported spend reached"),
            "unexpected claim: {task:?}; wanted {id}"
        );
        finish(s, h, &a).await;
    }
}
async fn finish(s: &Store, h: &HostAuthority, a: &InspectAttemptRequest) {
    s.finish_task(
        h,
        &FinishTaskRequest {
            task_id: a.task_id.clone(),
            attempt_id: a.attempt_id.clone(),
            lease_token: a.lease_token.clone(),
            succeeded: true,
            result: "Done".into(),
            ..Default::default()
        },
    )
    .await
    .unwrap();
}
fn start(a: &InspectAttemptRequest, op: &str) -> StartWorkSessionRequest {
    StartWorkSessionRequest {
        attempt: Some(a.clone()),
        operation_id: op.into(),
        title: "Budget fixture".into(),
        instruction: "Read fixture".into(),
        ..Default::default()
    }
}
async fn usage(
    s: &Store,
    h: &HostAuthority,
    a: &InspectAttemptRequest,
    sequence: u64,
    tokens: u64,
    cost: Option<u64>,
) {
    s.report_attempt_usage(
        h,
        &ReportAttemptUsageRequest {
            attempt: Some(a.clone()),
            sequence,
            native_usage: Some(NativeTokenUsage {
                input_tokens: tokens / 2,
                cached_input_tokens: tokens / 8,
                output_tokens: tokens / 4,
                total_tokens: Some(tokens),
                ..Default::default()
            }),
            amount_minor: cost,
            currency: cost.map(|_| "USD".into()),
            estimated: false,
        },
    )
    .await
    .unwrap();
}
async fn task(s: &Store, id: &str) -> Task {
    s.get_task(id).await.unwrap()
}
async fn ordinary(url: &str) {
    let s = Store::open(url).await.unwrap().with_execution_clock(|| NOW);
    s.put_tag("lead", "Read fixture", vec!["files:read".into()])
        .await
        .unwrap();
    let h = support::register_host(&s, "budget").await;
    // Native-agent ceilings also bound SuperTag's parallel child tools.
    for maximum in [0, 1] {
        let p = s
            .submit_task(
                OP,
                &SubmitTaskRequest {
                    output_policy: None,
                    tag_id: "lead".into(),
                    session_id: format!("agents-{maximum}"),
                    operation_id: format!("agents-{maximum}"),
                    prompt: "Bound child work".into(),
                    execution_limits: Some(ExecutionLimits {
                        max_native_agents: Some(maximum),
                        ..Default::default()
                    }),
                    input_artifacts: vec![],
                },
            )
            .await
            .unwrap();
        let a = run(&s, &h, &p.task_id).await;
        let request = start(&a, "one");
        let child = if maximum == 1 {
            let child = s.start_work_session(&h, &request).await.unwrap();
            assert_eq!(s.start_work_session(&h, &request).await.unwrap(), child);
            Some(child)
        } else {
            None
        };
        assert!(matches!(
            s.start_work_session(&h, &start(&a, "excess")).await,
            Err(StoreError::FailedPrecondition(_))
        ));
        finish(&s, &h, &a).await;
        if let Some(child) = child {
            let a = run(&s, &h, &child.latest_task_id).await;
            finish(&s, &h, &a).await;
            let report = s
                .get_work_session(OP, &child.work_session_id)
                .await
                .unwrap()
                .report_task_id
                .unwrap();
            let a = run(&s, &h, &report).await;
            finish(&s, &h, &a).await;
        }
    }
    let req = SubmitTaskRequest {
        output_policy: None,
        tag_id: "lead".into(),
        session_id: "parent".into(),
        operation_id: "root".into(),
        prompt: "Coordinate fixture".into(),
        execution_limits: Some(limits(10_000, 500)),
        input_artifacts: vec![],
    };
    let p = s.submit_task(OP, &req).await.unwrap();
    let a = run(&s, &h, &p.task_id).await;
    usage(&s, &h, &a, 1, 1000, Some(50)).await;
    usage(&s, &h, &a, 2, 2000, None).await;
    let first_req = start(&a, "first");
    let one = s.start_work_session(&h, &first_req).await.unwrap();
    let two = s
        .start_work_session(&h, &start(&a, "second"))
        .await
        .unwrap();
    assert_eq!(
        task(&s, &one.latest_task_id).await.execution_limits,
        Some(limits(8000, 450))
    );
    assert_eq!(
        task(&s, &two.latest_task_id).await.execution_limits,
        Some(limits(8000, 450)),
        "running allocations reserve no budget"
    );
    usage(&s, &h, &a, 3, 2500, Some(100)).await;
    assert_eq!(
        s.start_work_session(&h, &first_req).await.unwrap(),
        one,
        "exact receipt is immutable after spend"
    );
    assert_eq!(
        s.submit_task(OP, &req).await.unwrap().execution_limits,
        Some(limits(10_000, 500))
    );
    let mut changed = req.clone();
    changed.execution_limits = Some(limits(9999, 500));
    assert!(matches!(
        s.submit_task(OP, &changed).await,
        Err(StoreError::Conflict(_))
    ));
    finish(&s, &h, &a).await;
    let c1 = run(&s, &h, &one.latest_task_id).await;
    usage(&s, &h, &c1, 1, 7000, Some(375)).await;
    finish(&s, &h, &c1).await;
    let c2 = run(&s, &h, &two.latest_task_id).await;
    finish(&s, &h, &c2).await;
    let report = s
        .get_work_session(OP, &one.work_session_id)
        .await
        .unwrap()
        .report_task_id
        .unwrap();
    assert_eq!(
        task(&s, &report).await.execution_limits,
        Some(limits(10_000, 500)),
        "conversation reports keep starter limits outside pool"
    );
    let r = run(&s, &h, &report).await;
    usage(&s, &h, &r, 1, 9000, Some(400)).await;
    finish(&s, &h, &r).await;
    let report2 = s
        .get_work_session(OP, &two.work_session_id)
        .await
        .unwrap()
        .report_task_id
        .unwrap();
    let r = run(&s, &h, &report2).await;
    finish(&s, &h, &r).await;
    let zero = s
        .submit_task(
            OP,
            &SubmitTaskRequest {
                operation_id: "no-children".into(),
                execution_limits: Some(ExecutionLimits {
                    max_native_agents: Some(0),
                    ..Default::default()
                }),
                ..req.clone()
            },
        )
        .await
        .unwrap();
    let zero = run(&s, &h, &zero.task_id).await;
    assert!(matches!(
        s.continue_work_session(
            &h,
            &ContinueWorkSessionRequest {
                attempt: Some(zero.clone()),
                operation_id: "deny-continuation".into(),
                work_session_id: one.work_session_id.clone(),
                message: "Cannot continue".into()
            }
        )
        .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    finish(&s, &h, &zero).await;
    let next = s
        .submit_task(
            OP,
            &SubmitTaskRequest {
                operation_id: "later".into(),
                execution_limits: Some(ExecutionLimits {
                    max_native_agents: Some(1),
                    ..limits(3000, 200)
                }),
                ..req
            },
        )
        .await
        .unwrap();
    let n = run(&s, &h, &next.task_id).await;
    usage(&s, &h, &n, 1, 500, Some(25)).await;
    let continued = s
        .continue_work_session(
            &h,
            &ContinueWorkSessionRequest {
                attempt: Some(n.clone()),
                operation_id: "answer".into(),
                work_session_id: one.work_session_id,
                message: "Continue with new allowance".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(
        task(&s, &continued.latest_task_id).await.execution_limits,
        Some(ExecutionLimits {
            max_native_agents: Some(1),
            ..limits(2500, 175)
        }),
        "manual continuation uses new parent pool"
    );
    assert!(
        matches!(
            s.start_work_session(&h, &start(&n, "over-one")).await,
            Err(StoreError::FailedPrecondition(_))
        ),
        "Start and Continue share the one-child bound"
    );
    finish(&s, &h, &n).await;
    let frozen = task(&s, &continued.latest_task_id).await;
    s.close().await;
    let reopened = Store::open(url).await.unwrap();
    assert_eq!(task(&reopened, &frozen.task_id).await, frozen);
    reopened.close().await;
}
async fn objective(url: &str) {
    let s = Store::open(url).await.unwrap().with_execution_clock(|| NOW);
    s.put_tag("owner", "Coordinate", vec!["files:read".into()])
        .await
        .unwrap();
    let h = support::register_host(&s, "objective-budget").await;
    // Finish the previous scenario's child and its report before claiming this Objective.
    while let Some(c) = s.claim_task(&h, &Uuid::new_v4().to_string()).await.unwrap() {
        let a = InspectAttemptRequest {
            task_id: c.task.unwrap().task_id,
            attempt_id: c.attempt_id,
            lease_token: c.lease_token,
        };
        s.start_task(
            &h,
            &StartTaskRequest {
                task_id: a.task_id.clone(),
                attempt_id: a.attempt_id.clone(),
                lease_token: a.lease_token.clone(),
            },
        )
        .await
        .unwrap();
        finish(&s, &h, &a).await;
    }
    let o = s
        .create_objective(
            OP,
            &CreateObjectiveRequest {
                operation_id: "goal".into(),
                objective_id: "pool".into(),
                owner_tag_id: "owner".into(),
                outcome: "Budgeted fixture".into(),
                ongoing: true,
                budget_limit_minor: Some(1000),
                budget_currency: Some("USD".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(
        task(&s, &o.starting_task_id)
            .await
            .execution_limits
            .as_ref()
            .unwrap()
            .max_reported_cost
            .as_ref()
            .unwrap()
            .amount_minor,
        1000
    );
    let a = run(&s, &h, &o.starting_task_id).await;
    let one = s.start_work_session(&h, &start(&a, "first")).await.unwrap();
    finish(&s, &h, &a).await;
    let c = run(&s, &h, &one.latest_task_id).await;
    usage(&s, &h, &c, 1, 10, Some(600)).await;
    finish(&s, &h, &c).await;
    let report = s
        .get_work_session(OP, &one.work_session_id)
        .await
        .unwrap()
        .report_task_id
        .unwrap();
    assert_eq!(
        task(&s, &report)
            .await
            .execution_limits
            .unwrap()
            .max_reported_cost
            .unwrap()
            .amount_minor,
        400
    );
    let r = run(&s, &h, &report).await;
    let two = s
        .start_work_session(&h, &start(&r, "second"))
        .await
        .unwrap();
    assert_eq!(
        task(&s, &two.latest_task_id)
            .await
            .execution_limits
            .unwrap()
            .max_reported_cost
            .unwrap()
            .amount_minor,
        400
    );
    finish(&s, &h, &r).await;
    let c = run(&s, &h, &two.latest_task_id).await;
    usage(&s, &h, &c, 1, 10, Some(380)).await;
    finish(&s, &h, &c).await;
    let report = s
        .get_work_session(OP, &two.work_session_id)
        .await
        .unwrap()
        .report_task_id
        .unwrap();
    assert_eq!(
        task(&s, &report)
            .await
            .execution_limits
            .unwrap()
            .max_reported_cost
            .unwrap()
            .amount_minor,
        20
    );
    let r = run(&s, &h, &report).await;
    assert!(matches!(
        s.start_work_session(&h, &start(&r, "too-small")).await,
        Err(StoreError::FailedPrecondition(_))
    ));
    usage(&s, &h, &r, 1, 10, Some(30)).await;
    finish(&s, &h, &r).await;
    assert!(matches!(
        s.submit_task(
            OP,
            &SubmitTaskRequest {
                tag_id: "owner".into(),
                session_id: o.session_id.clone(),
                operation_id: "too-small".into(),
                prompt: "New work".into(),
                ..Default::default()
            }
        )
        .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    s.set_objective_limits(
        OP,
        &SetObjectiveLimitsRequest {
            objective_id: o.objective_id.clone(),
            operation_id: "raise".into(),
            budget_limit_minor: Some(4000),
            budget_currency: Some("USD".into()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let next = s
        .submit_task(
            OP,
            &SubmitTaskRequest {
                tag_id: "owner".into(),
                session_id: o.session_id,
                operation_id: "allowed".into(),
                prompt: "New work".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(
        next.execution_limits
            .unwrap()
            .max_reported_cost
            .unwrap()
            .amount_minor,
        2990
    );
    s.close().await;
}
async fn contract(url: &str) {
    Box::pin(ordinary(url)).await;
    Box::pin(objective(url)).await;
}
#[tokio::test]
async fn sqlite_budget_pools() {
    let d = tempfile::tempdir().unwrap();
    contract(&format!(
        "sqlite://{}?mode=rwc",
        d.path().join("budget.db").display()
    ))
    .await;
}
#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"]
async fn postgres_budget_pools() {
    let a =
        std::fs::read_to_string(std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE").unwrap())
            .unwrap();
    let name = format!("supertag_budget_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(a.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await
        .unwrap();
    let mut u = url::Url::parse(a.trim()).unwrap();
    u.set_path(&name);
    let result = tokio::task::LocalSet::new()
        .run_until(async move {
            tokio::task::spawn_local(async move { contract(u.as_str()).await }).await
        })
        .await;
    admin
        .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
        .await
        .unwrap();
    admin.close().await.unwrap();
    result.unwrap();
}
