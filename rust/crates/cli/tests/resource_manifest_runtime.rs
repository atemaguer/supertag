use std::{path::Path, process::Stdio, time::Duration};

use anyhow::{Context, Result, ensure};
use serde_json::Value;
use sqlx::{Connection, Executor};
use supertag_protocol::{
    authenticated_request,
    v2::{GetTagRequest, GetTaskRequest, PutTagRequest, operator_client::OperatorClient},
};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    time::timeout,
};

const CLI: &str = env!("CARGO_BIN_EXE_supertag");
const OPERATOR: &str = "fixture-operator-token";
const GATEWAY: &str = "fixture-private-gateway-token";

fn cli(args: &[&str]) -> Command {
    let mut command = Command::new(CLI);
    command
        .args(args)
        .env_clear()
        .env("SUPERTAG_GATEWAY_TOKEN", GATEWAY)
        .env("SUPERTAG_OPERATOR_TOKEN", OPERATOR)
        .stdin(Stdio::null())
        .kill_on_drop(true);
    command
}

async fn bind(mut command: Command) -> Result<(Child, String)> {
    let mut child = command.stdout(Stdio::piped()).spawn()?;
    let mut output = BufReader::new(child.stdout.take().context("missing endpoint")?);
    let mut endpoint = String::new();
    timeout(Duration::from_secs(10), output.read_line(&mut endpoint)).await??;
    ensure!(endpoint.starts_with("127.0.0.1:"));
    Ok((child, format!("http://{}", endpoint.trim())))
}

async fn command(gateway: &str, args: &[&str], success: bool) -> Result<String> {
    let (first, rest) = args.split_first().context("missing command")?;
    let output = timeout(
        Duration::from_secs(12),
        cli(&[first, "--gateway", gateway]).args(rest).output(),
    )
    .await??;
    let stderr = String::from_utf8(output.stderr)?;
    ensure!(output.status.success() == success, "{args:?}: {stderr}");
    Ok(if success {
        String::from_utf8(output.stdout)?
    } else {
        stderr
    })
}

async fn exercise(root: &Path, database_url: &str) -> Result<()> {
    let (mut plane, private) = bind({
        let mut command = cli(&["control-plane"]);
        command.env("SUPERTAG_DATABASE_URL", database_url);
        command
    })
    .await?;
    let (mut gateway_process, gateway) =
        bind(cli(&["gateway", "--control-plane", &private])).await?;
    let input = root.join("organization");
    std::fs::create_dir(&input)?;
    let yaml = input.join("z-resources.yaml");
    std::fs::write(
        &yaml,
        r#"
apiVersion: supertag/v1
kind: Objective
metadata: {name: release}
spec: {ownerTag: builder, outcome: "Prepare a release.", team: engineering}
---
apiVersion: supertag/v1
kind: Tag
metadata: {name: builder}
spec:
  roles: [Engineer]
  acceptsMessagesFrom: [reviewer]
  instructions: "Build the release."
---
apiVersion: supertag/v1
kind: Tag
metadata: {name: reviewer}
spec: {instructions: "Review the release."}
---
apiVersion: supertag/v1
kind: Role
metadata: {name: Engineer}
spec:
  purpose: Ship verified releases.
  permissionSets: [engineering-read]
  contextSets: [release-practice]
---
apiVersion: supertag/v1
kind: ContextSet
metadata: {name: release-practice}
spec:
  items:
    - itemKey: "skill:release"
      type: supertag/skill
      version: 1
      config: {reference: release-skill}
---
apiVersion: supertag/v1
kind: PermissionSet
metadata: {name: engineering-read}
spec:
  permissions:
    - {target: runtime, action: "files:read"}
"#,
    )?;
    std::fs::write(
        input.join("a-team.json"),
        r#"[
      {"apiVersion":"supertag/v1","kind":"Team","metadata":{"name":"engineering"},
       "spec":{"members":["builder","reviewer"],"maxConcurrency":2}}
    ]"#,
    )?;
    std::fs::write(
        input.join("b-volumes.yaml"),
        r#"
apiVersion: supertag/v1
kind: Volume
metadata: {name: shared}
spec: {source: "s3://fixture-bucket/release"}
---
apiVersion: supertag/v1
kind: Volume
metadata: {name: archive}
spec: {source: "file:///var/lib/supertag/archive"}
"#,
    )?;
    let path = input.to_str().context("manifest directory path")?;
    let unknown = root.join("invalid.yaml");
    std::fs::write(
        &unknown,
        "apiVersion: supertag/v1\nkind: Role\nmetadata: {name: invalid}\nspec: {purpose: Verify, permissionSets: [missing]}\n",
    )?;
    let error = command(
        &gateway,
        &["apply", "-f", path, "-f", unknown.to_str().unwrap()],
        false,
    )
    .await?;
    assert!(error.contains("missing PermissionSet/missing"), "{error}");
    command(&gateway, &["get-tag", "builder"], false).await?;
    command(
        &gateway,
        &["policy", "show", "permission-set", "engineering-read"],
        false,
    )
    .await?;

    let preview = command(&gateway, &["diff", "-f", path], true).await?;
    for expected in [
        "create Volume/shared",
        "create Volume/archive",
        "create ContextSet/release-practice",
        "create PermissionSet/engineering-read",
        "create Role/Engineer",
        "create Tag/builder",
        "create Team/engineering",
        "assign Role/Engineer to Tag/builder",
        "grant Mailbox access from Tag/reviewer to Tag/builder",
        "create Objective/release",
    ] {
        assert!(preview.contains(expected), "{preview}");
    }
    command(&gateway, &["get-tag", "builder"], false).await?;
    command(&gateway, &["apply", "-f", path], true).await?;
    let objective: Value =
        serde_json::from_str(&command(&gateway, &["objective", "get", "release"], true).await?)?;
    assert_eq!(objective["owner_tag_id"], "builder");
    let task_id = objective["starting_task_id"]
        .as_str()
        .context("missing starting Task")?;
    let task = OperatorClient::connect(gateway.clone())
        .await?
        .get_task(authenticated_request(
            GetTaskRequest {
                task_id: task_id.into(),
            },
            OPERATOR,
            None,
        )?)
        .await?
        .into_inner();
    assert!(
        task.allowed_actions
            .iter()
            .any(|action| action == "files:read"),
        "{task:?}"
    );
    assert_eq!(
        command(&gateway, &["diff", "-f", path], true).await?.trim(),
        "No changes."
    );
    assert_eq!(
        command(&gateway, &["apply", "-f", path], true)
            .await?
            .trim(),
        "No changes."
    );
    let revised = std::fs::read_to_string(&yaml)?
        .replace("Build the release.", "Verify release artifacts.")
        .replace(
            "team: engineering}",
            "team: engineering, budgetLimitMinor: 150, budgetCurrency: USD}",
        );
    std::fs::write(&yaml, revised)?;
    assert_eq!(
        command(&gateway, &["diff", "-f", path], true).await?.trim(),
        "update Tag/builder\nupdate Objective/release"
    );
    command(&gateway, &["apply", "-f", path], true).await?;
    assert_eq!(
        command(&gateway, &["diff", "-f", path], true).await?.trim(),
        "No changes."
    );

    let mut operator = OperatorClient::connect(gateway.clone()).await?;
    let before = operator
        .get_tag(authenticated_request(
            GetTagRequest {
                tag_id: "builder".into(),
            },
            OPERATOR,
            None,
        )?)
        .await?
        .into_inner();
    let stale = operator
        .put_tag(authenticated_request(
            PutTagRequest {
                tag_id: before.tag_id.clone(),
                instructions: "A stale preview would overwrite these instructions.".into(),
                expected_revision: Some(before.revision - 1),
                ..Default::default()
            },
            OPERATOR,
            None,
        )?)
        .await
        .unwrap_err();
    assert_eq!(stale.code(), tonic::Code::AlreadyExists);
    let after = operator
        .get_tag(authenticated_request(
            GetTagRequest {
                tag_id: before.tag_id.clone(),
            },
            OPERATOR,
            None,
        )?)
        .await?
        .into_inner();
    assert_eq!(before, after);

    gateway_process.kill().await?;
    plane.kill().await?;
    Ok(())
}

#[tokio::test]
async fn applies_and_previews_a_multi_file_organization_through_split_services() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let url = format!(
        "sqlite://{}?mode=rwc",
        temp.path().join("runtime.sqlite").display()
    );
    exercise(temp.path(), &url).await
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"]
async fn applies_organization_manifests_against_postgres() -> Result<()> {
    let temporary = tempfile::tempdir()?;
    let url_file = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .context("disposable PostgreSQL URL file required")?;
    let admin_url = std::fs::read_to_string(url_file)?;
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await?;
    let database = format!("supertag_manifest_{}", uuid::Uuid::new_v4().simple());
    let mut url = url::Url::parse(admin_url.trim())?;
    url.set_path(&database);
    admin
        .execute(format!("CREATE DATABASE {database}").as_str())
        .await?;
    let result = tokio::spawn(async move { exercise(temporary.path(), url.as_str()).await }).await;
    admin
        .execute(format!("DROP DATABASE {database} WITH (FORCE)").as_str())
        .await?;
    result?
}
