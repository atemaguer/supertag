mod gateway;
mod local_start;
mod onboarding;

use std::path::PathBuf;

use gateway::{
    Conversation, Event, FollowUpdate, GatewayActivation, GatewayList, GatewayState, Message,
    Messages, NewTag, ReadMessages, Tag, TagOptions, WatchUpdate,
};
use tauri::{Manager, State, ipc::Channel, webview::PageLoadEvent};

fn gateway_store<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join("gateways.json"))
        .map_err(|_| "Could not locate your saved Gateway connections.".into())
}

/// Where the app caches what it shows on launch, in its data directory.
fn local_cache<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join("cache"))
        .map_err(|_| "Could not locate the app cache.".into())
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

/// Whether a local Gateway runs from `state` now.
#[cfg(unix)]
fn local_gateway_running(state: &std::path::Path) -> bool {
    matches!(supertag_local_state::gateway(state), Ok(Some(_)))
}

#[cfg(not(unix))]
fn local_gateway_running(_: &std::path::Path) -> bool {
    false
}

/// Whether this launch should start the local services: SuperTag is set up on this machine, but
/// they are stopped. The window shows "Starting SuperTag…" while `start_local_services` runs.
#[tauri::command]
fn local_start_needed() -> bool {
    let state = local_state_directory();
    let running = state.as_deref().is_some_and(local_gateway_running);
    local_start::should_start(state.as_deref(), running)
}

/// Starts the stopped local services with `supertag up`; false when there was nothing to start.
#[tauri::command]
async fn start_local_services() -> Result<bool, String> {
    let Some(state) = local_state_directory() else {
        return Ok(false);
    };
    if !local_start::should_start(Some(&state), local_gateway_running(&state)) {
        return Ok(false);
    }
    local_start::start(&state).await?;
    Ok(true)
}

/// What stops the app from running the `supertag` CLI: none installed, or another version than
/// the app's, with the command that installs the right one. `None` when it can run it.
#[tauri::command]
async fn local_cli_problem() -> Option<String> {
    local_start::usable_cli().await.err()
}

/// Whether SuperTag can be set up for a project folder, from `supertag init --check --json`.
#[tauri::command]
async fn check_setup(
    directory: Option<String>,
    harness: Option<String>,
) -> Result<serde_json::Value, String> {
    onboarding::check(directory, harness).await
}

/// Asks for the project folder with the system's folder picker.
#[tauri::command]
async fn choose_project_folder<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Choose your project folder")
        .pick_folder(move |folder| {
            let _ = sender.send(folder);
        });
    let folder = receiver
        .await
        .map_err(|_| "The folder picker closed.".to_owned())?;
    Ok(folder
        .and_then(|folder| folder.into_path().ok())
        .map(|path| path.display().to_string()))
}

/// Sets SuperTag up for the chosen project and harness, and starts it.
#[tauri::command]
async fn set_up_supertag(directory: String, harness: String) -> Result<serde_json::Value, String> {
    onboarding::set_up(directory, harness).await
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
async fn connect_local_gateway<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, GatewayState>,
) -> Result<GatewayActivation, String> {
    state.connect_local_gateway(&gateway_store(&app)?).await
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
    let list = state
        .clear_gateway(&gateway_store(&app)?, forget.clone())
        .await?;
    if let (Some(origin), Ok(root)) = (forget, local_cache(&app)) {
        gateway::cache::forget(&root, &origin);
    }
    Ok(list)
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
async fn list_notes(
    state: State<'_, GatewayState>,
    connection_id: String,
    tag_id: String,
) -> Result<Vec<gateway::memories::Note>, String> {
    state.notes(&connection_id, tag_id).await
}

#[tauri::command]
async fn tag_activity(
    state: State<'_, GatewayState>,
    connection_id: String,
    tag_id: String,
) -> Result<gateway::activity::TagActivity, String> {
    state.tag_activity(&connection_id, tag_id).await
}

#[tauri::command]
async fn locate_task_files(
    state: State<'_, GatewayState>,
    connection_id: String,
    task_id: String,
) -> Result<gateway::task_files::TaskFilesPlace, String> {
    state.locate_task_files(&connection_id, task_id).await
}

#[tauri::command]
async fn list_task_files(
    connection_id: String,
    task_id: String,
    path: String,
) -> Result<Vec<gateway::task_files::TaskFileEntry>, String> {
    tokio::task::spawn_blocking(move || gateway::task_files::list(&connection_id, &task_id, &path))
        .await
        .map_err(|_| "Listing the files failed.".to_owned())?
}

#[tauri::command]
async fn read_task_file(
    connection_id: String,
    task_id: String,
    path: String,
) -> Result<gateway::task_files::TaskFileText, String> {
    tokio::task::spawn_blocking(move || gateway::task_files::read(&connection_id, &task_id, &path))
        .await
        .map_err(|_| "Reading the file failed.".to_owned())?
}

#[tauri::command]
fn reveal_task_file(connection_id: String, task_id: String, path: String) -> Result<(), String> {
    let absolute = gateway::task_files::absolute(&connection_id, &task_id, &path)?;
    tauri_plugin_opener::reveal_item_in_dir(absolute)
        .map_err(|_| "Could not show the file in Finder.".to_owned())
}

#[tauri::command]
async fn list_network_logs(
    state: State<'_, GatewayState>,
    connection_id: String,
    tag_id: String,
) -> Result<Vec<gateway::network::NetworkLog>, String> {
    state.network_logs(&connection_id, tag_id).await
}

#[tauri::command]
async fn delete_note(
    state: State<'_, GatewayState>,
    connection_id: String,
    memory_id: String,
) -> Result<gateway::memories::Note, String> {
    state.delete_note(&connection_id, memory_id).await
}

#[tauri::command]
async fn list_schedules(
    state: State<'_, GatewayState>,
    connection_id: String,
    tag_id: String,
) -> Result<Vec<gateway::schedules::Schedule>, String> {
    state.schedules(&connection_id, tag_id).await
}

#[tauri::command]
async fn change_schedule(
    state: State<'_, GatewayState>,
    connection_id: String,
    schedule_id: String,
    action: String,
) -> Result<gateway::schedules::Schedule, String> {
    state
        .change_schedule(&connection_id, schedule_id, &action)
        .await
}

#[tauri::command]
async fn list_tag_options(
    state: State<'_, GatewayState>,
    connection_id: String,
) -> Result<TagOptions, String> {
    state.tag_options(&connection_id).await
}

#[tauri::command]
async fn create_tag(
    state: State<'_, GatewayState>,
    connection_id: String,
    tag: NewTag,
) -> Result<Tag, String> {
    state.create_tag(&connection_id, tag).await
}

#[tauri::command]
async fn list_conversations(
    state: State<'_, GatewayState>,
    connection_id: String,
) -> Result<Vec<Conversation>, String> {
    state.conversations(&connection_id).await
}

#[tauri::command]
async fn list_messages(
    state: State<'_, GatewayState>,
    connection_id: String,
    read: ReadMessages,
) -> Result<Messages, String> {
    state.messages(&connection_id, read).await
}

#[tauri::command]
async fn mark_conversation_read(
    state: State<'_, GatewayState>,
    connection_id: String,
    tag_id: String,
    order: u64,
) -> Result<Conversation, String> {
    state.mark_read(&connection_id, tag_id, order).await
}

#[tauri::command]
async fn send_message(
    state: State<'_, GatewayState>,
    connection_id: String,
    tag_id: String,
    text: String,
    operation_id: String,
) -> Result<Message, String> {
    state.send(&connection_id, tag_id, text, operation_id).await
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
async fn list_task_events(
    state: State<'_, GatewayState>,
    connection_id: String,
    task_id: String,
    after_sequence: u64,
) -> Result<Vec<Event>, String> {
    state.events(&connection_id, task_id, after_sequence).await
}

/// Pushes the changes of the caller's conversation with a Tag after the copy `read` describes,
/// until `stop_conversation_follow`.
#[tauri::command]
async fn start_conversation_follow(
    state: State<'_, GatewayState>,
    connection_id: String,
    read: ReadMessages,
    on_update: Channel<FollowUpdate>,
) -> Result<String, String> {
    state.start_follow(&connection_id, read, on_update).await
}

#[tauri::command]
async fn stop_conversation_follow(
    state: State<'_, GatewayState>,
    follow_id: String,
) -> Result<(), String> {
    state.stop_follow(&follow_id).await;
    Ok(())
}

/// An entry the app cached for the current connection: `roster`, `outbox`, or `tag:` and a Tag.
#[tauri::command]
async fn read_cache<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, GatewayState>,
    connection_id: String,
    key: String,
) -> Result<Option<serde_json::Value>, String> {
    state.cached(&connection_id, local_cache(&app)?, key).await
}

#[tauri::command]
async fn write_cache<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, GatewayState>,
    connection_id: String,
    key: String,
    value: serde_json::Value,
) -> Result<(), String> {
    state
        .cache(&connection_id, local_cache(&app)?, key, value)
        .await
}

fn builder<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder
        .manage(GatewayState::new(local_state_directory()))
        // A Tag's reply or question while its conversation is not in view; see notifications.ts.
        .plugin(tauri_plugin_notification::init())
        // Links in messages open in the system browser; the capability allows only http and https.
        .plugin(tauri_plugin_opener::init())
        // The project folder picker on first launch; only the app's own command opens it.
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
            connect_local_gateway,
            local_start_needed,
            start_local_services,
            local_cli_problem,
            select_gateway,
            clear_gateway,
            start_gateway_watch,
            stop_gateway_watch,
            list_tags,
            list_notes,
            delete_note,
            list_network_logs,
            locate_task_files,
            list_task_files,
            read_task_file,
            reveal_task_file,
            tag_activity,
            list_schedules,
            change_schedule,
            list_tag_options,
            create_tag,
            list_conversations,
            list_messages,
            send_message,
            get_message,
            list_task_events,
            start_conversation_follow,
            stop_conversation_follow,
            read_cache,
            write_cache,
            mark_conversation_read,
            check_setup,
            choose_project_folder,
            set_up_supertag
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

    /// The window may open only web links, in the system browser, show notifications and its
    /// Dock badge, and may otherwise only drag and zoom itself.
    #[test]
    fn the_main_window_opens_only_web_links() {
        let capability: Value =
            serde_json::from_str(include_str!("../capabilities/main.json")).unwrap();
        assert_eq!(
            capability["permissions"],
            json!([
                "gateway-client",
                "core:window:allow-start-dragging",
                "core:window:allow-internal-toggle-maximize",
                "core:window:allow-set-badge-count",
                "core:window:allow-set-focus",
                "notification:allow-is-permission-granted",
                "notification:allow-request-permission",
                "notification:allow-notify",
                "notification:allow-register-listener",
                "notification:allow-remove-listener",
                {
                    "identifier": "opener:allow-open-url",
                    "allow": [{ "url": "https://*" }, { "url": "http://*" }]
                }
            ])
        );
    }

    /// Tauri refuses a registered command the window's permission does not allow, so every
    /// handler must be listed in permissions/gateway.toml and nothing else may be.
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
        let permission = include_str!("../permissions/gateway.toml");
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
        assert!(registered.contains(&"connect_local_gateway"));
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
    }
}
