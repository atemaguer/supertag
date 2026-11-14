use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    path::Path,
    process::Stdio,
    time::Duration,
};

use anyhow::{Context, Result, ensure};
use serde_json::Value;
use tokio::{process::Command, time::timeout};

fn fixture(path: &Path, name: &str) -> Result<()> {
    fs::write(
        path,
        format!(
            "#!/bin/sh\nif [ \"$1\" = --version ]; then printf '%s\\n' '{}'; exit 0; fi\nprintf '%s\\n' '{name}'\nexec cat <&3\n",
            env!("CARGO_PKG_VERSION")
        ),
    )?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o755))?;
    Ok(())
}

async fn launch(
    cli: &Path,
    home: &Path,
    flag: Option<&Path>,
    environment: Option<&Path>,
    expected: &str,
) -> Result<()> {
    let mut command = Command::new(cli);
    command
        .args(["tui", "--control-plane", "http://127.0.0.1:9"])
        .current_dir(home)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", home)
        .env("SUPERTAG_OPERATOR_TOKEN", "synthetic-installed-tui-token")
        .stdin(Stdio::null())
        .kill_on_drop(true);
    if let Some(binary) = flag {
        command.arg("--binary").arg(binary);
    }
    if let Some(binary) = environment {
        command.env("SUPERTAG_TUI_BINARY", binary);
    }
    let output = timeout(Duration::from_secs(20), command.output())
        .await
        .with_context(|| format!("launch {expected} through installed command"))??;
    ensure!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let output = String::from_utf8(output.stdout)?;
    let (name, payload) = output.split_once('\n').expect("fixture received handover");
    assert_eq!(name, expected);
    let payload: Value = serde_json::from_str(payload)?;
    assert_eq!(payload["protocol"], "runtime.v2");
    assert_eq!(payload["contexts"][0]["url"], "http://127.0.0.1:9");
    assert_eq!(
        payload["contexts"][0]["token"],
        "synthetic-installed-tui-token"
    );
    Ok(())
}

#[tokio::test]
async fn installed_command_finds_real_sibling_and_preserves_explicit_overrides() -> Result<()> {
    let root = tempfile::tempdir()?;
    let release = root.path().join("versions/native-fixture");
    let bin = root.path().join("bin");
    fs::create_dir_all(&release)?;
    fs::create_dir(&bin)?;
    fs::copy(env!("CARGO_BIN_EXE_supertag"), release.join("supertag"))?;
    fixture(&release.join("supertag-tui"), "release-sibling")?;
    let cli = bin.join("supertag");
    symlink(release.join("supertag"), &cli)?;
    // There is deliberately no supertag-tui beside the installed command link.
    launch(&cli, root.path(), None, None, "release-sibling").await?;

    let from_env = root.path().join("env-tui");
    let from_flag = root.path().join("flag-tui");
    fixture(&from_env, "environment-override")?;
    fixture(&from_flag, "flag-override")?;
    launch(
        &cli,
        root.path(),
        None,
        Some(&from_env),
        "environment-override",
    )
    .await?;
    launch(
        &cli,
        root.path(),
        Some(&from_flag),
        Some(&from_env),
        "flag-override",
    )
    .await?;
    Ok(())
}
