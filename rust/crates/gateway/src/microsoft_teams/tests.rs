use super::*;
use serde_json::json;
const APP: &str = "11111111-1111-4111-8111-111111111111";
const TENANT: &str = "22222222-2222-4222-8222-222222222222";
const TEAM: &str = "33333333-3333-4333-8333-333333333333";
const USER: &str = "44444444-4444-4444-8444-444444444444";
fn config() -> MicrosoftTeamsConfig {
    MicrosoftTeamsConfig {
        account_id: "teams/shared".into(),
        app_id: APP.into(),
        app_secret: "synthetic".into(),
        tenant_id: TENANT.into(),
        team_id: TEAM.into(),
        channel_id: "19:channel@thread.tacv2".into(),
        tag_id: "builder".into(),
        allowed_users: vec![USER.into()],
        state_directory: PathBuf::new(),
    }
}
fn payload() -> Value {
    json!({"type":"message","id":"1741000000001","replyToId":"1741000000000","serviceUrl":"https://smba.trafficmanager.net/amer/","channelId":"msteams","from":{"id":"29:alice","aadObjectId":USER},"recipient":{"id":format!("28:{APP}")},"conversation":{"id":"19:conversation@thread.tacv2","conversationType":"channel","tenantId":TENANT},"text":"<at>SuperTag</at> inspect","entities":[{"type":"mention","text":"<at>SuperTag</at>","mentioned":{"id":format!("28:{APP}")}}],"channelData":{"tenant":{"id":TENANT},"team":{"id":"19:internal-team","aadGroupId":TEAM},"channel":{"id":"19:channel@thread.tacv2"}}})
}
#[test]
fn configured_channel_mention_uses_stable_group_actor_and_thread() {
    let input = normalize(&config(), &payload()).unwrap().unwrap();
    assert_eq!(input.team_id, TEAM);
    assert_eq!(input.actor_id, USER);
    assert_eq!(input.root_activity_id, "1741000000000");
    assert_eq!(input.prompt, "inspect");
    assert_eq!(input.service_url, "https://smba.trafficmanager.net/amer/");
}
#[test]
fn ignores_unmentioned_bots_and_unconfigured_routes() {
    for (pointer, value) in [
        ("/entities", json!([])),
        ("/from/role", json!("bot")),
        ("/from/aadObjectId", json!(APP)),
        ("/channelData/team/aadGroupId", json!(TENANT)),
        ("/channelData/channel/id", json!("19:elsewhere")),
        ("/conversation/conversationType", json!("personal")),
    ] {
        let mut body = payload();
        if pointer == "/from/role" {
            body["from"]["role"] = value;
        } else {
            *body.pointer_mut(pointer).unwrap() = value;
        }
        assert!(normalize(&config(), &body).unwrap().is_none(), "{pointer}");
    }
}
#[test]
fn rejects_cross_tenant_and_wrong_recipient_even_with_mention_entity() {
    for pointer in [
        "/channelData/tenant/id",
        "/conversation/tenantId",
        "/recipient/id",
    ] {
        let mut body = payload();
        *body.pointer_mut(pointer).unwrap() = json!("wrong");
        assert!(normalize(&config(), &body).is_err(), "{pointer}");
    }
}

#[test]
fn already_threaded_conversation_cannot_redirect_the_root() {
    let mut body = payload();
    body["conversation"]["id"] = "19:conversation@thread.tacv2;messageid=1741000000000".into();
    assert_eq!(
        normalize(&config(), &body)
            .unwrap()
            .unwrap()
            .conversation_id,
        "19:conversation@thread.tacv2"
    );
    body["conversation"]["id"] = "19:conversation@thread.tacv2;messageid=1741000000009".into();
    assert!(normalize(&config(), &body).is_err());
}
