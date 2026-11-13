mod gateway;

use std::path::PathBuf;

use gateway::{
    Conversation, Event, GatewayActivation, GatewayList, GatewayState, Message, Messages, Tag,
    WatchUpdate,
};
use tauri::{Manager, State, ipc::Channel, webview::PageLoadEvent};
use tauri_plugin_dialog::DialogExt;

fn gateway_store<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join("gateways.json"))
        .map_err(|_| "Could not locate your saved Gateway connections.".into())
}

#[tauri::command]
async fn list_gateways<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, GatewayState>,
) -> Result<GatewayList, String> {
    state.saved_gateways(&gateway_store(&app)?).await
}

#[tauri::command]
async fn save_gateway<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, GatewayState>,
    gateway: String,
    name: String,
    token: String,
) -> Result<GatewayActivation, String> {
    state
        .save_gateway(&gateway_store(&app)?, gateway, name, token)
        .await
}

#[tauri::command]
async fn select_gateway<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, GatewayState>,
    origin: String,
) -> Result<GatewayActivation, String> {
    state.select_gateway(&gateway_store(&app)?, origin).await
}

#[tauri::command]
async fn clear_gateway<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, GatewayState>,
    forget: Option<String>,
) -> Result<GatewayList, String> {
    state.clear_gateway(&gateway_store(&app)?, forget).await
}

#[tauri::command]
async fn start_gateway_watch(
    state: State<'_, GatewayState>,
    connection_id: String,
    watch_epoch: u64,
    on_update: Channel<WatchUpdate>,
) -> Result<String, String> {
    state
        .start_watch(&connection_id, watch_epoch, on_update)
        .await
}

#[tauri::command]
async fn stop_gateway_watch(
    state: State<'_, GatewayState>,
    watch_id: String,
) -> Result<(), String> {
    state.stop_watch(&watch_id).await;
    Ok(())
}

#[tauri::command]
async fn list_tags(
    state: State<'_, GatewayState>,
    connection_id: String,
) -> Result<Vec<Tag>, String> {
    state.tags(&connection_id).await
}

#[tauri::command]
async fn list_conversations(
    state: State<'_, GatewayState>,
    connection_id: String,
    tag_id: String,
) -> Result<Vec<Conversation>, String> {
    state.conversations(&connection_id, tag_id).await
}

#[tauri::command]
async fn list_messages(
    state: State<'_, GatewayState>,
    connection_id: String,
    tag_id: String,
    conversation: String,
    cursor: Option<String>,
) -> Result<Messages, String> {
    state
        .messages(&connection_id, tag_id, conversation, cursor)
        .await
}

#[tauri::command]
async fn send_message(
    state: State<'_, GatewayState>,
    connection_id: String,
    tag_id: String,
    conversation: String,
    text: String,
    operation_id: String,
) -> Result<Message, String> {
    state
        .send(&connection_id, tag_id, conversation, text, operation_id)
        .await
}

#[tauri::command]
async fn get_message(
    state: State<'_, GatewayState>,
    connection_id: String,
    tag_id: String,
    task_id: String,
) -> Result<Message, String> {
    state.message(&connection_id, tag_id, task_id).await
}

#[tauri::command]
async fn list_message_events(
    state: State<'_, GatewayState>,
    connection_id: String,
    tag_id: String,
    task_id: String,
    after_sequence: u64,
) -> Result<Vec<Event>, String> {
    state
        .events(&connection_id, tag_id, task_id, after_sequence)
        .await
}

#[tauri::command]
async fn save_result_artifact<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, GatewayState>,
    connection_id: String,
    artifact_id: String,
    path: String,
) -> Result<bool, String> {
    state
        .save_artifact(
            &connection_id,
            artifact_id,
            path,
            move |filename| async move {
                let (send, receive) = tokio::sync::oneshot::channel();
                app.dialog()
                    .file()
                    .set_file_name(filename)
                    .save_file(move |file| {
                        let _ = send.send(file);
                    });
                receive
                    .await
                    .map_err(|_| "Could not open the save dialog.".to_owned())?
                    .map(|file| {
                        file.into_path()
                            .map_err(|_| "Choose a local file location.".to_owned())
                    })
                    .transpose()
            },
        )
        .await
}

fn builder<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder
        .manage(GatewayState::default())
        .plugin(tauri_plugin_dialog::init())
        .on_page_load(|webview, payload| {
            if webview.label() == "main" && payload.event() == PageLoadEvent::Started {
                let app = webview.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    app.state::<GatewayState>().disconnect().await;
                });
            }
        })
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                let app = window.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    app.state::<GatewayState>().disconnect().await;
                });
            }
        })
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
            list_gateways,
            save_gateway,
            select_gateway,
            clear_gateway,
            start_gateway_watch,
            stop_gateway_watch,
            list_tags,
            list_conversations,
            list_messages,
            send_message,
            get_message,
            list_message_events,
            save_result_artifact
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
                "connectionId": "1", "tagId": "engineer", "conversation": "planning", "text": "hello", "operationId": "ipc-test"
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
        let watch = |url: &str| tauri::webview::InvokeRequest {
            cmd: "start_gateway_watch".into(),
            body: tauri::ipc::InvokeBody::Json(json!({
                "connectionId": "1", "watchEpoch": 1, "onUpdate": "__CHANNEL__:7"
            })),
            ..request(url)
        };
        let local = tauri::test::get_ipc_response(&main, watch("tauri://localhost"));
        assert_eq!(
            local.unwrap_err(),
            Value::String("The connection changed. Refresh this view.".into())
        );
        let remote = tauri::test::get_ipc_response(&main, watch("https://untrusted.example"));
        assert!(remote.unwrap_err().to_string().contains("not allowed"));
        let other = tauri::test::get_ipc_response(&secondary, watch("tauri://localhost"));
        assert!(other.unwrap_err().to_string().contains("not allowed"));
        let save = |url: &str| tauri::webview::InvokeRequest {
            cmd: "save_result_artifact".into(),
            body: tauri::ipc::InvokeBody::Json(json!({
                "connectionId": "1", "artifactId": "capture", "path": "outputs/report.txt"
            })),
            ..request(url)
        };
        let local = tauri::test::get_ipc_response(&main, save("tauri://localhost"));
        assert_eq!(
            local.unwrap_err(),
            Value::String("Connect to a Gateway first.".into())
        );
        let remote = tauri::test::get_ipc_response(&main, save("https://untrusted.example"));
        assert!(remote.unwrap_err().to_string().contains("not allowed"));
        let other = tauri::test::get_ipc_response(&secondary, save("tauri://localhost"));
        assert!(other.unwrap_err().to_string().contains("not allowed"));
    }
}
