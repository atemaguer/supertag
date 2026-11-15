use super::*;
fn config() -> LarkConfig {
    LarkConfig {
        account_id: "lark/shared".into(),
        domain: LarkDomain::Lark,
        app_id: "cli_0123456789abcdef".into(),
        app_secret: "synthetic".into(),
        tenant_key: "tenant-one".into(),
        bot_open_id: "ou_bot".into(),
        chat_id: "oc_engineering".into(),
        tag_id: "builder".into(),
        allowed_users: vec!["ou_alice".into()],
        state_directory: PathBuf::new(),
    }
}
fn payload() -> Value {
    json!({"schema":"2.0","header":{"app_id":"cli_0123456789abcdef","tenant_key":"tenant-one","event_id":"event-one","event_type":"im.message.receive_v1"},"event":{"sender":{"sender_id":{"open_id":"ou_alice"},"sender_type":"user","tenant_key":"tenant-one"},"message":{"message_id":"om_root","chat_id":"oc_engineering","chat_type":"group","message_type":"text","content":"{\"text\":\"@_user_1 inspect this\"}","mentions":[{"key":"@_user_1","id":{"open_id":"ou_bot"}}]}}})
}
#[test]
fn native_envelope_mentions_and_thread_followups() {
    let config = config();
    let mut value = payload();
    let first = normalize(&config, &serde_json::to_vec(&value).unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(first.prompt, "inspect this");
    assert_eq!(first.mention_tag_id.as_deref(), Some("builder"));
    assert_eq!(first.root_message_id, "om_root");
    value["event"]["message"]["message_id"] = "om_follow".into();
    value["event"]["message"]["root_id"] = "om_root".into();
    value["event"]["message"]["mentions"] = json!([]);
    value["event"]["message"]["content"] = "{\"text\":\"continue\"}".into();
    let follow = normalize(&config, &serde_json::to_vec(&value).unwrap())
        .unwrap()
        .unwrap();
    assert!(follow.mention_tag_id.is_none());
    assert_eq!(follow.root_message_id, first.root_message_id);
}
#[test]
fn ignores_bots_unaddressed_groups_and_unconfigured_users() {
    let config = config();
    for (pointer, setting) in [
        ("/event/sender/sender_type", json!("app")),
        ("/event/sender/sender_id/open_id", json!("ou_other")),
        ("/event/message/chat_id", json!("oc_other")),
        ("/event/message/mentions", json!([])),
    ] {
        let mut value = payload();
        *value.pointer_mut(pointer).unwrap() = setting;
        assert!(
            normalize(&config, &serde_json::to_vec(&value).unwrap())
                .unwrap()
                .is_none(),
            "accepted {pointer}"
        );
    }
}
#[test]
fn app_tenant_binding_and_direct_conversation() {
    let config = config();
    for pointer in [
        "/header/app_id",
        "/header/tenant_key",
        "/event/sender/tenant_key",
    ] {
        let mut value = payload();
        *value.pointer_mut(pointer).unwrap() = json!("wrong");
        assert!(normalize(&config, &serde_json::to_vec(&value).unwrap()).is_err());
    }
    let mut value = payload();
    value["event"]["message"]["chat_type"] = "p2p".into();
    value["event"]["message"]["mentions"] = json!([]);
    let direct = normalize(&config, &serde_json::to_vec(&value).unwrap())
        .unwrap()
        .unwrap();
    assert!(direct.direct);
    assert_eq!(direct.mention_tag_id.as_deref(), Some("builder"));
}
