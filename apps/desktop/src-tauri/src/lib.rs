mod control_plane;

use std::path::PathBuf;

use control_plane::{
    ControlPlaneActivation, ControlPlaneList, ControlPlaneState, Conversation, Event, Message,
    Messages, NewTag, Tag, TagOptions, WatchUpdate,
};
use tauri::{Manager, State, ipc::Channel, webview::PageLoadEvent};
use tauri_plugin_dialog::DialogExt;

fn control_plane_store<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join("control-planes.json"))
        .map_err(|_| "Could not locate your saved Control Plane connections.".into())
}

/// Where recently opened conversations are cached, in the app's data directory.
fn conversation_cache<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join("conversations"))
        .map_err(|_| "Could not locate the conversation cache.".into())
}

/// Where `supertag up` keeps this user's local state: `SUPERTAG_STATE_DIR`, else `~/.supertag`.
#[cfg(unix)]
fn local_state_directory() -> Option<PathBuf> {
    supertag_local_state::state_directory(None).ok()
}

#[cfg(not(unix))]
fn local_state_directory() -> Option<PathBuf> {
    None
}

#[tauri::command]
async fn list_control_planes<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, ControlPlaneState>,
) -> Result<ControlPlaneList, String> {
    state
        .saved_control_planes(&control_plane_store(&app)?)
        .await
}

#[tauri::command]
async fn save_control_plane<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, ControlPlaneState>,
    control_plane: String,
    name: String,
    token: String,
) -> Result<ControlPlaneActivation, String> {
    state
        .save_control_plane(&control_plane_store(&app)?, control_plane, name, token)
        .await
}

#[tauri::command]
async fn connect_local_control_plane<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, ControlPlaneState>,
) -> Result<ControlPlaneActivation, String> {
    state
        .connect_local_control_plane(&control_plane_store(&app)?)
        .await
}

#[tauri::command]
async fn select_control_plane<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, ControlPlaneState>,
    origin: String,
) -> Result<ControlPlaneActivation, String> {
    state
        .select_control_plane(&control_plane_store(&app)?, origin)
        .await
}

#[tauri::command]
async fn clear_control_plane<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, ControlPlaneState>,
    forget: Option<String>,
) -> Result<ControlPlaneList, String> {
    let list = state
        .clear_control_plane(&control_plane_store(&app)?, forget.clone())
        .await?;
    if let (Some(origin), Ok(root)) = (forget, conversation_cache(&app)) {
        control_plane::cache::forget(&root, &origin);
    }
    Ok(list)
}

#[tauri::command]
async fn start_control_plane_watch(
    state: State<'_, ControlPlaneState>,
    connection_id: String,
    watch_epoch: u64,
    on_update: Channel<WatchUpdate>,
) -> Result<String, String> {
    state
        .start_watch(&connection_id, watch_epoch, on_update)
        .await
}

#[tauri::command]
async fn stop_control_plane_watch(
    state: State<'_, ControlPlaneState>,
    watch_id: String,
) -> Result<(), String> {
    state.stop_watch(&watch_id).await;
    Ok(())
}

#[tauri::command]
async fn list_tags(
    state: State<'_, ControlPlaneState>,
    connection_id: String,
) -> Result<Vec<Tag>, String> {
    state.tags(&connection_id).await
}

#[tauri::command]
async fn list_tag_options(
    state: State<'_, ControlPlaneState>,
    connection_id: String,
) -> Result<TagOptions, String> {
    state.tag_options(&connection_id).await
}

#[tauri::command]
async fn create_tag(
    state: State<'_, ControlPlaneState>,
    connection_id: String,
    tag: NewTag,
) -> Result<Tag, String> {
    state.create_tag(&connection_id, tag).await
}

#[tauri::command]
async fn list_conversations(
    state: State<'_, ControlPlaneState>,
    connection_id: String,
    tag_id: String,
) -> Result<Vec<Conversation>, String> {
    state.conversations(&connection_id, tag_id).await
}

#[tauri::command]
async fn list_messages(
    state: State<'_, ControlPlaneState>,
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
    state: State<'_, ControlPlaneState>,
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
    state: State<'_, ControlPlaneState>,
    connection_id: String,
    tag_id: String,
    task_id: String,
) -> Result<Message, String> {
    state.message(&connection_id, tag_id, task_id).await
}

#[tauri::command]
async fn list_task_events(
    state: State<'_, ControlPlaneState>,
    connection_id: String,
    task_id: String,
    after_sequence: u64,
) -> Result<Vec<Event>, String> {
    state.events(&connection_id, task_id, after_sequence).await
}

#[tauri::command]
async fn read_conversation_cache<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, ControlPlaneState>,
    connection_id: String,
    tag_id: String,
    conversation: String,
) -> Result<Option<serde_json::Value>, String> {
    state
        .cached_conversation(
            &connection_id,
            conversation_cache(&app)?,
            tag_id,
            conversation,
        )
        .await
}

#[tauri::command]
async fn write_conversation_cache<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, ControlPlaneState>,
    connection_id: String,
    tag_id: String,
    conversation: String,
    value: serde_json::Value,
) -> Result<(), String> {
    state
        .cache_conversation(
            &connection_id,
            conversation_cache(&app)?,
            tag_id,
            conversation,
            value,
        )
        .await
}

#[tauri::command]
async fn save_result_artifact<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, ControlPlaneState>,
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
        .manage(ControlPlaneState::new(local_state_directory()))
        .plugin(tauri_plugin_dialog::init())
        // Links in messages open in the system browser; the capability allows only http and https.
        .plugin(tauri_plugin_opener::init())
        .on_page_load(|webview, payload| {
            if webview.label() == "main" && payload.event() == PageLoadEvent::Started {
                let app = webview.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    app.state::<ControlPlaneState>().disconnect().await;
                });
            }
        })
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                let app = window.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    app.state::<ControlPlaneState>().disconnect().await;
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
            list_control_planes,
            save_control_plane,
            connect_local_control_plane,
            select_control_plane,
            clear_control_plane,
            start_control_plane_watch,
            stop_control_plane_watch,
            list_tags,
            list_tag_options,
            create_tag,
            list_conversations,
            list_messages,
            send_message,
            get_message,
            list_task_events,
            read_conversation_cache,
            write_conversation_cache,
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

    /// The window may open only web links, in the system browser, and may otherwise only drag
    /// and zoom itself.
    #[test]
    fn the_main_window_opens_only_web_links() {
        let capability: Value =
            serde_json::from_str(include_str!("../capabilities/main.json")).unwrap();
        assert_eq!(
            capability["permissions"],
            json!([
                "control-plane-client",
                "core:window:allow-start-dragging",
                "core:window:allow-internal-toggle-maximize",
                {
                    "identifier": "opener:allow-open-url",
                    "allow": [{ "url": "https://*" }, { "url": "http://*" }]
                }
            ])
        );
    }

    /// Tauri refuses a registered command the window's permission does not allow, so every
    /// handler must be listed in permissions/control-plane.toml and nothing else may be.
    #[test]
    fn the_main_window_may_call_exactly_the_registered_commands() {
        let source = include_str!("lib.rs");
        let handlers = source
            .split("generate_handler![")
            .nth(1)
            .and_then(|rest| rest.split(']').next())
            .unwrap();
        let mut registered: Vec<&str> = handlers
            .split(',')
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .collect();
        let permission = include_str!("../permissions/control-plane.toml");
        let allowed = permission
            .split("commands.allow = [")
            .nth(1)
            .and_then(|rest| rest.split(']').next())
            .unwrap();
        let mut allowed: Vec<&str> = allowed
            .split(',')
            .map(|name| name.trim().trim_matches('"'))
            .filter(|name| !name.is_empty())
            .collect();
        registered.sort_unstable();
        allowed.sort_unstable();
        assert!(registered.contains(&"connect_local_control_plane"));
        assert_eq!(registered, allowed);
    }

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
            Value::String("Connect to a Control Plane first.".into())
        );
        let remote = tauri::test::get_ipc_response(&main, request("https://untrusted.example"));
        assert!(remote.unwrap_err().to_string().contains("not allowed"));
        let other = tauri::test::get_ipc_response(&secondary, request("tauri://localhost"));
        assert!(other.unwrap_err().to_string().contains("not allowed"));
        let watch = |url: &str| tauri::webview::InvokeRequest {
            cmd: "start_control_plane_watch".into(),
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
            Value::String("Connect to a Control Plane first.".into())
        );
        let remote = tauri::test::get_ipc_response(&main, save("https://untrusted.example"));
        assert!(remote.unwrap_err().to_string().contains("not allowed"));
        let other = tauri::test::get_ipc_response(&secondary, save("tauri://localhost"));
        assert!(other.unwrap_err().to_string().contains("not allowed"));
    }
}
