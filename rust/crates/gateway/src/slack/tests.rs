use std::path::Path;

use super::*;
use axum::http::HeaderValue;
use serde_json::Value;
use tonic::transport::Endpoint;

pub(super) fn config(directory: &Path) -> SlackConfig {
    SlackConfig {
        account_id: "slack-fixture".into(),
        team_id: "TTEAM1".into(),
        channel_id: "CCHANNEL1".into(),
        tag_id: "builder".into(),
        allowed_users: vec!["UALICE1".into()],
        events: SlackEvents::Http {
            signing_secret: "fixture-signing-key".into(),
        },
        bot_token: "fixture-bot-token".into(),
        state_directory: directory.into(),
    }
}

pub(super) fn connector(directory: &Path) -> Result<Slack> {
    Slack::new(
        config(directory),
        supertag_protocol::negotiation::bind_current(
            Endpoint::from_static("http://127.0.0.1:1").connect_lazy(),
        ),
        "fixture-gateway-token".into(),
    )
}

#[test]
fn verifies_exact_body_and_rejects_stale_and_duplicate_headers() {
    let body = br#"{ "type": "url_verification", "challenge": "sample" }"#;
    let mut mac = Hmac::<Sha256>::new_from_slice(b"fixture-signing-key").unwrap();
    mac.update(b"v0:1700000000:");
    mac.update(body);
    let signature = format!("v0={}", hex::encode(mac.finalize().into_bytes()));
    let mut headers = HeaderMap::new();
    headers.insert(
        "x-slack-request-timestamp",
        HeaderValue::from_static("1700000000"),
    );
    headers.insert(
        "x-slack-signature",
        HeaderValue::from_str(&signature).unwrap(),
    );
    assert!(verify_signature(
        &headers,
        body,
        "fixture-signing-key",
        1_700_000_300
    ));
    assert!(!verify_signature(
        &headers,
        body,
        "fixture-signing-key",
        1_700_000_301
    ));
    assert!(!verify_signature(
        &headers,
        &body[1..],
        "fixture-signing-key",
        1_700_000_000
    ));
    headers.append(
        "x-slack-signature",
        HeaderValue::from_str(&signature).unwrap(),
    );
    assert!(!verify_signature(
        &headers,
        body,
        "fixture-signing-key",
        1_700_000_000
    ));
}

#[test]
fn accepts_configured_human_mentions_and_thread_replies_for_durable_routing() -> Result<()> {
    let config = config(Path::new("unused"));
    let mut payload = json!({
        "type": "event_callback", "team_id": "TTEAM1", "event_id": "EvFIXTURE1",
        "event": {
            "type": "app_mention", "channel": "CCHANNEL1", "user": "UALICE1", "text": "Fix the café example",
            "ts": "1700000010.123456", "thread_ts": "1700000000.123456"
        }
    });
    let Ingress::Accept(accepted) = normalize(&config, &serde_json::to_vec(&payload)?).unwrap()
    else {
        panic!("expected a normalized Slack event");
    };
    assert_eq!(accepted.event_id, "EvFIXTURE1");
    assert_eq!(accepted.team_id, "TTEAM1");
    assert_eq!(accepted.channel_id, "CCHANNEL1");
    assert_eq!(accepted.thread_ts, "1700000000.123456");
    assert_eq!(accepted.mention_tag_id.as_deref(), Some("builder"));
    assert_eq!(accepted.actor_id, "UALICE1");
    assert_eq!(accepted.message_ts, "1700000010.123456");

    payload["event"]["type"] = json!("message");
    let Ingress::Accept(reply) = normalize(&config, &serde_json::to_vec(&payload)?).unwrap() else {
        panic!("expected a reply requiring Control Plane thread lookup");
    };
    assert_eq!(
        reply.mention_tag_id, None,
        "unmentioned replies cannot choose a Tag"
    );
    assert_eq!(reply.thread_ts, accepted.thread_ts);
    assert_eq!(
        reply.message_ts, accepted.message_ts,
        "the two Slack notification kinds identify the same logical message"
    );

    payload["event"]["user"] = json!("UMALLORY1");
    assert!(matches!(
        normalize(&config, &serde_json::to_vec(&payload)?).unwrap(),
        Ingress::Ignore
    ));
    payload["event"]["user"] = json!("UALICE1");
    payload["event"]["bot_id"] = json!("BBOT1");
    assert!(matches!(
        normalize(&config, &serde_json::to_vec(&payload)?).unwrap(),
        Ingress::Ignore
    ));
    payload["team_id"] = json!("TOTHER1");
    assert_eq!(
        normalize(&config, &serde_json::to_vec(&payload)?).err(),
        Some(StatusCode::FORBIDDEN)
    );
    Ok(())
}

#[test]
fn ignores_unthreaded_messages_bots_edits_and_unconfigured_channels() -> Result<()> {
    let config = config(Path::new("unused"));
    let valid = json!({"type":"event_callback","team_id":"TTEAM1","event_id":"EvHUMAN1","event":{"type":"message","channel":"CCHANNEL1","user":"UALICE1","text":"Continue","ts":"1700000010.123456","thread_ts":"1700000000.123456"}});
    for (field, value) in [
        ("thread_ts", Value::Null),
        ("bot_id", json!("BBOT1")),
        ("subtype", json!("message_changed")),
        ("channel", json!("COTHER1")),
        ("user", json!("UMALLORY1")),
        ("type", json!("reaction_added")),
    ] {
        let mut ignored = valid.clone();
        ignored["event"][field] = value;
        assert!(
            matches!(
                normalize(&config, &serde_json::to_vec(&ignored)?).unwrap(),
                Ingress::Ignore
            ),
            "accepted {field}"
        );
    }
    // A top-level mention still activates a new thread at its own timestamp.
    let mut mention = valid;
    mention["event"]["type"] = json!("app_mention");
    mention["event"]
        .as_object_mut()
        .unwrap()
        .remove("thread_ts");
    let Ingress::Accept(accepted) = normalize(&config, &serde_json::to_vec(&mention)?).unwrap()
    else {
        panic!("mention was ignored");
    };
    assert_eq!(accepted.thread_ts, accepted.message_ts);
    assert_eq!(accepted.mention_tag_id.as_deref(), Some("builder"));
    Ok(())
}
