//! `supertag __local-gateway`: the format the terminal UI's local discovery reads
//! (`apps/tui/local_gateway.go`).
#[path = "support/children.rs"]
mod children;
use children::reaped;
use std::{
    fs,
    os::unix::fs::{DirBuilderExt, PermissionsExt},
    path::Path,
    process::{Command, Stdio},
};

use serde_json::{Value, json};

fn discover(state: &Path) -> (bool, Value, String) {
    let output = reaped(Command::new(env!("CARGO_BIN_EXE_supertag")))
        .arg("__local-gateway")
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", state.parent().unwrap())
        .env("SUPERTAG_STATE_DIR", state)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    let value = serde_json::from_slice(&output.stdout).unwrap_or(Value::Null);
    (
        output.status.success(),
        value,
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

fn private_file(state: &Path, name: &str, contents: &str) {
    fs::write(state.join(name), contents).unwrap();
    fs::set_permissions(state.join(name), fs::Permissions::from_mode(0o600)).unwrap();
}

#[test]
fn prints_the_running_local_gateway_with_its_current_token() {
    let root = tempfile::tempdir().unwrap();
    let state = root.path().join("state");

    let (ok, value, _) = discover(&state);
    assert!(ok);
    assert_eq!(value["protocol"], "local-gateway.v1");
    assert_eq!(value["running"], false);
    // Nothing is set up there yet, so the message names supertag init.
    assert!(value["message"].as_str().unwrap().contains("supertag init"));
    assert!(value.get("token").is_none());

    fs::DirBuilder::new().mode(0o700).create(&state).unwrap();
    private_file(&state, "gateway-endpoint", "http://127.0.0.1:7001\n");
    let enrolled = || supertag_protocol::new_secret(supertag_protocol::CREDENTIAL_SECRET_PREFIX);
    let operator = "c".repeat(64);
    private_file(
        &state,
        "credentials.json",
        &json!({
            "gateway_credential": enrolled(),
            "operator_token": operator,
            "host_credential": enrolled(),
        })
        .to_string(),
    );
    // Stands in for the supervisor `supertag up` runs, which holds this lock.
    let lock = supertag_local_state::open_private_file(&state.join(".lock"), true).unwrap();
    lock.try_lock().unwrap();
    let (ok, value, _) = discover(&state);
    assert!(ok);
    assert_eq!(value["running"], true);
    assert_eq!(value["url"], "http://127.0.0.1:7001");
    assert_eq!(value["token"], operator);
    assert_eq!(
        Path::new(value["state_directory"].as_str().unwrap()),
        state.as_path()
    );

    drop(lock);
    assert_eq!(discover(&state).1["running"], false);

    // State another user could read is refused rather than trusted.
    fs::set_permissions(&state, fs::Permissions::from_mode(0o755)).unwrap();
    let (ok, _, error) = discover(&state);
    assert!(!ok);
    assert!(error.contains("private directory"), "{error}");
    assert!(!error.contains(&operator));
}
