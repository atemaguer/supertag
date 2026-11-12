mod gateway;

use gateway::{Conversation, Event, GatewayState, Message, Messages, Tag};
use tauri::State;

#[tauri::command]
async fn connect_gateway(
    state: State<'_, GatewayState>,
    gateway: String,
    token: String,
) -> Result<(), String> {
    state.connect(gateway, token).await
}

#[tauri::command]
async fn disconnect_gateway(state: State<'_, GatewayState>) -> Result<(), String> {
    state.disconnect().await;
    Ok(())
}

#[tauri::command]
async fn list_tags(state: State<'_, GatewayState>) -> Result<Vec<Tag>, String> {
    state.tags().await
}

#[tauri::command]
async fn list_conversations(
    state: State<'_, GatewayState>,
    tag_id: String,
) -> Result<Vec<Conversation>, String> {
    state.conversations(tag_id).await
}

#[tauri::command]
async fn list_messages(
    state: State<'_, GatewayState>,
    tag_id: String,
    conversation: String,
    cursor: Option<String>,
) -> Result<Messages, String> {
    state.messages(tag_id, conversation, cursor).await
}

#[tauri::command]
async fn send_message(
    state: State<'_, GatewayState>,
    tag_id: String,
    conversation: String,
    text: String,
    operation_id: String,
) -> Result<Message, String> {
    state.send(tag_id, conversation, text, operation_id).await
}

#[tauri::command]
async fn get_message(
    state: State<'_, GatewayState>,
    tag_id: String,
    task_id: String,
) -> Result<Message, String> {
    state.message(tag_id, task_id).await
}

#[tauri::command]
async fn list_message_events(
    state: State<'_, GatewayState>,
    tag_id: String,
    task_id: String,
    after_sequence: u64,
) -> Result<Vec<Event>, String> {
    state.events(tag_id, task_id, after_sequence).await
}

fn builder<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder
        .manage(GatewayState::default())
        .plugin(
            tauri::plugin::Builder::<R>::new("local-navigation")
                .on_navigation(|_, url| {
                    (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
                        || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"))
                        || (cfg!(debug_assertions)
                            && url.scheme() == "http"
                            && url.host_str() == Some("127.0.0.1")
                            && url.port() == Some(1420))
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            connect_gateway,
            disconnect_gateway,
            list_tags,
            list_conversations,
            list_messages,
            send_message,
            get_message,
            list_message_events
        ])
}

fn context<R: tauri::Runtime>() -> tauri::Context<R> {
    tauri::generate_context!()
}

pub fn run() {
    builder(tauri::Builder::default())
        .run(context())
        .expect("SuperTag desktop could not start");
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    #[test]
    fn ipc_dispatch_uses_camel_case_and_only_the_local_main_window() {
        let app = builder(tauri::test::mock_builder())
            .build(context())
            .unwrap();
        let main = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        let secondary = tauri::WebviewWindowBuilder::new(&app, "secondary", Default::default())
            .build()
            .unwrap();
        let request = |url: &str| tauri::webview::InvokeRequest {
            cmd: "send_message".into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: url.parse().unwrap(),
            body: tauri::ipc::InvokeBody::Json(json!({
                "tagId": "engineer", "conversation": "planning", "text": "hello", "operationId": "ipc-test"
            })),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.to_string(),
        };
        let local = tauri::test::get_ipc_response(&main, request("tauri://localhost"));
        assert_eq!(
            local.unwrap_err(),
            Value::String("Connect to a Gateway first.".into())
        );
        let remote = tauri::test::get_ipc_response(&main, request("https://untrusted.example"));
        assert!(remote.unwrap_err().to_string().contains("not allowed"));
        let other = tauri::test::get_ipc_response(&secondary, request("tauri://localhost"));
        assert!(other.unwrap_err().to_string().contains("not allowed"));
    }
}
