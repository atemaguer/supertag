use super::*;
use crate::delivery_journal::{Claim, Entry, Outcome};
use axum::http::HeaderValue;
use std::path::Path;
use tonic::transport::Endpoint;
const WORKSPACE: &str = "11111111-1111-4111-8111-111111111111";
const TEAM: &str = "22222222-2222-4222-8222-222222222222";
const ISSUE: &str = "33333333-3333-4333-8333-333333333333";
const COMMENT: &str = "44444444-4444-4444-8444-444444444444";
const USER: &str = "55555555-5555-4555-8555-555555555555";
const NOW: u128 = 1_800_000_000_000;
fn config(directory: &Path) -> LinearConfig {
    LinearConfig {
        account_id: "shared".into(),
        workspace_id: WORKSPACE.into(),
        team_id: TEAM.into(),
        tag_id: "builder".into(),
        allowed_users: vec![USER.into()],
        webhook_secret: "synthetic-secret".into(),
        api_key: "synthetic-api-key".into(),
        state_directory: directory.join("linear"),
    }
}
fn connector(directory: &Path) -> Result<Linear> {
    Linear::new(
        config(directory),
        Endpoint::from_static("http://127.0.0.1:1").connect_lazy(),
        "private-token".into(),
    )
}
fn payload() -> Value {
    json!({"action":"create","actor":{"id":USER,"type":"user"},"type":"Issue","organizationId":WORKSPACE,"webhookTimestamp":NOW as u64,"data":{"id":ISSUE,"teamId":TEAM,"description":"Please @SuperTag, inspect"}})
}
fn signature(body: &[u8]) -> HeaderMap {
    let mut mac = Hmac::<Sha256>::new_from_slice(b"synthetic-secret").unwrap();
    mac.update(body);
    let mut headers = HeaderMap::new();
    headers.insert(
        "linear-signature",
        HeaderValue::from_str(&hex::encode(mac.finalize().into_bytes())).unwrap(),
    );
    headers
}
#[test]
fn verifies_raw_hmac_and_rejects_duplicate_signature() {
    let bytes = payload().to_string();
    let mut headers = signature(bytes.as_bytes());
    assert!(verify(&headers, bytes.as_bytes(), "synthetic-secret"));
    assert!(!verify(&headers, b"different body", "synthetic-secret"));
    headers.append("linear-signature", headers["linear-signature"].clone());
    assert!(!verify(&headers, bytes.as_bytes(), "synthetic-secret"));
}
#[test]
fn normalizes_issue_and_comment_with_fresh_timestamp_and_explicit_mentions() -> Result<()> {
    let config = config(Path::new("unused"));
    let mut value = payload();
    let candidate = normalize(
        &config,
        "delivery",
        "Issue",
        &serde_json::to_vec(&value)?,
        NOW,
    )
    .unwrap()
    .unwrap();
    assert_eq!(candidate.input.issue_id, ISSUE);
    assert_eq!(candidate.input.kind(), LinearEventKind::Issue);
    assert!(!candidate.lookup_issue);
    value["type"] = "Comment".into();
    value["action"] = "update".into();
    value["data"] = json!({"id":COMMENT,"issueId":ISSUE,"body":"@supertag do this"});
    let comment = normalize(
        &config,
        "delivery",
        "Comment",
        &serde_json::to_vec(&value)?,
        NOW,
    )
    .unwrap()
    .unwrap();
    assert!(comment.lookup_issue);
    assert_eq!(comment.input.source_id, COMMENT);
    assert_eq!(comment.input.action(), LinearEventAction::Update);
    Ok(())
}
#[test]
fn rejects_scope_mismatch_stale_or_future_events_and_ignores_nonusers() -> Result<()> {
    let config = config(Path::new("unused"));
    let body = serde_json::to_vec(&payload())?;
    for now in [NOW - 60_001, NOW + 60_001] {
        assert_eq!(
            normalize(&config, "delivery", "Issue", &body, now).err(),
            Some(StatusCode::UNAUTHORIZED)
        );
    }
    assert_eq!(
        normalize(&config, "delivery", "Comment", &body, NOW).err(),
        Some(StatusCode::BAD_REQUEST)
    );
    for (pointer, value) in [
        ("/organizationId", json!(TEAM)),
        ("/data/teamId", json!(WORKSPACE)),
    ] {
        let mut data = payload();
        *data.pointer_mut(pointer).unwrap() = value;
        assert_eq!(
            normalize(
                &config,
                "delivery",
                "Issue",
                &serde_json::to_vec(&data)?,
                NOW
            )
            .err(),
            Some(StatusCode::FORBIDDEN)
        );
    }
    for (pointer, value) in [
        ("/actor/type", json!("application")),
        ("/actor/id", json!(TEAM)),
        ("/data/description", json!("unmentioned")),
        ("/data/description", json!("@supertag-other")),
        ("/action", json!("remove")),
    ] {
        let mut data = payload();
        *data.pointer_mut(pointer).unwrap() = value;
        assert!(
            normalize(
                &config,
                "delivery",
                "Issue",
                &serde_json::to_vec(&data)?,
                NOW
            )
            .unwrap()
            .is_none()
        );
    }
    Ok(())
}
#[test]
fn parent_issue_resolution_must_match_signed_issue_and_configured_team() {
    assert_eq!(
        resolved_issue(
            &json!({"data":{"issue":{"id":ISSUE,"team":{"id":TEAM}}}}),
            ISSUE,
            TEAM
        )
        .unwrap(),
        TEAM
    );
    assert_eq!(
        resolved_issue(
            &json!({"data":{"issue":{"id":COMMENT,"team":{"id":TEAM}}}}),
            ISSUE,
            TEAM
        )
        .err(),
        Some(StatusCode::SERVICE_UNAVAILABLE)
    );
    assert_eq!(
        resolved_issue(
            &json!({"data":{"issue":{"id":ISSUE,"team":{"id":WORKSPACE}}}}),
            ISSUE,
            TEAM
        )
        .err(),
        Some(StatusCode::FORBIDDEN)
    );
}
#[tokio::test]
async fn namespace_isolated_and_recovered_sending_never_reposts() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let linear = connector(dir.path())?;
    assert_eq!(linear.0.config.account_id, "linear/shared");
    assert_eq!(linear.0.principal, "connector:linear/shared");
    linear.0.journal.save(&Entry::Sending {
        target: Claim {
            reply_id: "reply".into(),
            lease_token: "lease".into(),
        },
    })?;
    let path = linear.0.config.state_directory.clone();
    drop(linear);
    assert!(Journal::open(&path, "github/shared", "github").is_err());
    let recovered = connector(dir.path())?;
    assert!(recovered.0.advance_delivery("").await?);
    assert!(matches!(
        recovered.0.journal.load()?,
        Some(Entry::Settle {
            outcome: Outcome::Uncertain,
            ..
        })
    ));
    Ok(())
}

#[tokio::test]
async fn graphql_rejects_partial_errors_oversized_responses_and_redirects() -> Result<()> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    for (status, body, expected_rejected) in [
        ("200 OK",json!({"data":{"commentCreate":{"success":true}},"errors":[{"message":"echo synthetic-api-key"}]}).to_string(),false),
        ("200 OK","x".repeat(128*1024+1),false),
        ("200 OK","not json".into(),false),
        ("302 Found","{}".into(),false),
        ("401 Unauthorized","{}".into(),true),
    ] {
        let listener=TcpListener::bind("127.0.0.1:0").await?;let address=listener.local_addr()?;
        let server=tokio::spawn(async move {
            let (mut stream,_)=listener.accept().await?;
            let mut bytes=[0;4096];let _=stream.read(&mut bytes).await?;
            let header=format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nLocation: http://127.0.0.1:1/forbidden\r\nConnection: close\r\n\r\n",body.len());
            stream.write_all(header.as_bytes()).await?;
            // Bounded parsing may close before this deliberately oversized body ends.
            let _=stream.write_all(body.as_bytes()).await;
            Ok::<_,std::io::Error>(())
        });
        let directory=tempfile::tempdir()?;let mut linear=connector(directory.path())?;
        Arc::get_mut(&mut linear.0).unwrap().api_base=format!("http://{address}/graphql").parse()?;
        let result=linear.0.graphql("query Fixture { ignored }",json!({}),Duration::from_secs(2)).await;
        assert!(result.is_err());assert_eq!(matches!(result,Err(GraphqlFailure::Rejected)),expected_rejected);
        time::timeout(Duration::from_secs(3),server).await???;
    }
    Ok(())
}
