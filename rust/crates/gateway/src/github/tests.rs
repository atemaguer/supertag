use super::*;
use axum::http::HeaderValue;
use serde_json::{Value, json};
use std::path::Path;
use tonic::transport::Endpoint;

fn config(directory: &Path) -> GithubConfig {
    GithubConfig {
        account_id: "shared".into(),
        repository_id: 123,
        repository: "acme/project".into(),
        tag_id: "builder".into(),
        allowed_users: vec![42],
        webhook_secret: "fixture-secret".into(),
        token: "fixture-token".into(),
        state_directory: directory.join("github"),
    }
}
pub(super) fn connector(directory: &Path) -> Result<Github> {
    Github::new(
        config(directory),
        Endpoint::from_static("http://127.0.0.1:1").connect_lazy(),
        "fixture-private-token".into(),
    )
}
fn payload() -> Value {
    json!({"action":"created","sender":{"id":42,"type":"User"},"repository":{"id":123,"full_name":"acme/project"},"issue":{"number":7},"comment":{"id":456,"body":"@SuperTag, inspect the change"}})
}

#[test]
fn verifies_exact_github_signature_and_rejects_duplicate_headers() {
    let mut headers = HeaderMap::new();
    headers.insert(
        "x-hub-signature-256",
        HeaderValue::from_static(
            "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
        ),
    );
    assert!(verify(
        &headers,
        b"Hello, World!",
        "It's a Secret to Everybody"
    ));
    assert!(!verify(
        &headers,
        b"Hello, world!",
        "It's a Secret to Everybody"
    ));
    headers.append(
        "x-hub-signature-256",
        headers["x-hub-signature-256"].clone(),
    );
    assert!(!verify(
        &headers,
        b"Hello, World!",
        "It's a Secret to Everybody"
    ));
}

#[test]
fn normalizes_supported_explicit_human_mentions_and_immutable_coordinates() -> Result<()> {
    let config = config(Path::new("unused"));
    let mut value = payload();
    let input = normalize(
        &config,
        "delivery-1",
        "issue_comment",
        &serde_json::to_vec(&value)?,
    )
    .unwrap()
    .unwrap();
    assert_eq!(input.kind(), GithubEventKind::IssueComment);
    assert_eq!(input.action(), GithubEventAction::Created);
    assert_eq!(
        (input.repository_id, input.number, input.source_id),
        (123, 7, 456)
    );
    assert!(!input.is_pull_request);
    value["issue"]["pull_request"] = json!({"url":"https://untrusted.invalid/not-used"});
    assert!(
        normalize(
            &config,
            "delivery-2",
            "issue_comment",
            &serde_json::to_vec(&value)?
        )
        .unwrap()
        .unwrap()
        .is_pull_request
    );
    for event in ["issues", "pull_request"] {
        let mut object = payload();
        object["action"] = "opened".into();
        object[if event == "issues" {
            "issue"
        } else {
            "pull_request"
        }] = json!({"id":789,"number":8,"body":"Please @supertag!"});
        let accepted = normalize(&config, "delivery-3", event, &serde_json::to_vec(&object)?)
            .unwrap()
            .unwrap();
        assert_eq!(accepted.action(), GithubEventAction::Opened);
        assert_eq!(accepted.source_id, 789);
        assert_eq!(accepted.is_pull_request, event == "pull_request");
        object["action"] = "edited".into();
        assert_eq!(
            normalize(&config, "delivery-4", event, &serde_json::to_vec(&object)?)
                .unwrap()
                .unwrap()
                .action(),
            GithubEventAction::Edited
        );
    }
    Ok(())
}

#[test]
fn ignores_bots_unmentioned_events_and_unconfigured_users_and_rejects_wrong_repository()
-> Result<()> {
    let config = config(Path::new("unused"));
    for (pointer, value) in [
        ("/sender/type", json!("Bot")),
        ("/sender/id", json!(43)),
        ("/comment/body", json!("continue without a mention")),
        ("/comment/body", json!("@supertag-other do work")),
        ("/comment/body", Value::Null),
        ("/action", json!("deleted")),
    ] {
        let mut ignored = payload();
        *ignored.pointer_mut(pointer).unwrap() = value;
        assert!(
            normalize(
                &config,
                "delivery",
                "issue_comment",
                &serde_json::to_vec(&ignored)?
            )
            .unwrap()
            .is_none(),
            "accepted {pointer}"
        );
    }
    for (pointer, value) in [
        ("/repository/id", json!(124)),
        ("/repository/full_name", json!("acme/other")),
    ] {
        let mut wrong = payload();
        *wrong.pointer_mut(pointer).unwrap() = value;
        assert_eq!(
            normalize(
                &config,
                "delivery",
                "issue_comment",
                &serde_json::to_vec(&wrong)?
            )
            .err(),
            Some(StatusCode::FORBIDDEN)
        );
    }
    Ok(())
}

#[tokio::test]
async fn account_namespace_and_journal_binding_cannot_overlap_slack() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let github = connector(directory.path())?;
    assert_eq!(github.0.config.account_id, "github/shared");
    assert_eq!(github.0.principal, "connector:github/shared");
    let journal = &github.0.journal;
    journal.save(&crate::delivery_journal::Entry::Claim {
        operation_id: "one".into(),
    })?;
    let state = github.0.config.state_directory.clone();
    assert!(
        Journal::open(&state, "shared", "slack").is_err(),
        "another provider cannot share a live state directory"
    );
    drop(github);
    assert!(
        Journal::open(&state, "shared", "slack").is_err(),
        "saved journal is bound to provider and account"
    );
    Ok(())
}
