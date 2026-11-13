#[path = "../../../test-support/prerequisites.rs"]
mod prerequisites;
#[path = "support/protocol.rs"]
mod protocol;
#[macro_use]
#[path = "support/database.rs"]
mod database;

use std::{path::Path, process::Stdio, time::Duration};

use anyhow::{Context, Result, ensure};
use serde_json::Value;
use supertag_protocol::{
    authenticated_request,
    v2::{
        ApplySetDeclaration, GetTagRequest, GetTaskRequest, ProvisionTag, ProvisionTagsRequest,
        PutTagRequest, ReconcileApplySetRequest,
        manifest_relationships_client::ManifestRelationshipsClient,
        operator_client::OperatorClient,
    },
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
    command(&gateway, &["get", "tag", "builder"], false).await?;
    command(
        &gateway,
        &["get", "permission-set", "engineering-read"],
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
    command(&gateway, &["get", "tag", "builder"], false).await?;
    command(&gateway, &["apply", "-f", path], true).await?;
    let objective: Value =
        serde_json::from_str(&command(&gateway, &["get", "objective", "release"], true).await?)?;
    assert_eq!(objective["owner_tag_id"], "builder");
    let task_id = objective["starting_task_id"]
        .as_str()
        .context("missing starting Task")?;
    let task = OperatorClient::new(protocol::dial(gateway.clone()).await?)
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

    let mut operator = OperatorClient::new(protocol::dial(gateway.clone()).await?);
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

    let external = root.join("external.yaml");
    std::fs::write(
        &external,
        r#"
apiVersion: supertag/v1
kind: Tag
metadata: {name: observer}
spec: {}
---
apiVersion: supertag/v1
kind: Role
metadata: {name: Observer}
spec: {purpose: Observe releases.}
"#,
    )?;
    command(&gateway, &["apply", "-f", external.to_str().unwrap()], true).await?;
    command(
        &gateway,
        &["mailbox-grant", "allow", "observer", "builder"],
        true,
    )
    .await?;
    command(
        &gateway,
        &["role-assignment", "create", "Observer", "builder"],
        true,
    )
    .await?;

    let empty = root.join("relationships.yaml");
    std::fs::write(
        &empty,
        "apiVersion: supertag/v1\nkind: Tag\nmetadata: {name: builder}\nspec: {}\n",
    )?;
    let empty = empty.to_str().unwrap();
    assert_eq!(
        command(&gateway, &["diff", "-f", empty, "--set", "other"], true)
            .await?
            .trim(),
        "No changes."
    );
    let preview = command(&gateway, &["diff", "-f", empty], true).await?;
    assert!(preview.contains("remove Role/"), "{preview}");
    assert!(
        preview.contains("revoke Mailbox access from Tag/reviewer to Tag/builder"),
        "{preview}"
    );
    command(&gateway, &["apply", "-f", empty], true).await?;
    assert_eq!(
        command(&gateway, &["diff", "-f", empty], true)
            .await?
            .trim(),
        "No changes."
    );
    let assignments: Value = serde_json::from_str(
        &command(
            &gateway,
            &["get", "role-assignments", "--tag", "builder", "--active"],
            true,
        )
        .await?,
    )?;
    assert_eq!(assignments["assignments"].as_array().unwrap().len(), 1);
    let observer: Value =
        serde_json::from_str(&command(&gateway, &["get", "role", "Observer"], true).await?)?;
    assert_eq!(
        assignments["assignments"][0]["role_id"],
        observer["role_id"]
    );
    let grants: Value = serde_json::from_str(
        &command(
            &gateway,
            &["get", "mailbox-grants", "--tag", "builder"],
            true,
        )
        .await?,
    )?;
    assert_eq!(grants["grants"].as_array().unwrap().len(), 1);
    assert_eq!(grants["grants"][0]["sender_tag_id"], "observer");

    let managed = root.join("managed.yaml");
    std::fs::write(
        &managed,
        "apiVersion: supertag/v1\nkind: Tag\nmetadata: {name: builder}\nspec: {acceptsMessagesFrom: [reviewer]}\n",
    )?;
    let managed = managed.to_str().unwrap();
    command(&gateway, &["apply", "-f", managed, "--set", "team-a"], true).await?;
    let adoption = command(&gateway, &["diff", "-f", managed, "--set", "team-b"], true).await?;
    assert!(
        adoption.contains("manage Tag/builder spec.acceptsMessagesFrom[reviewer]"),
        "{adoption}"
    );
    command(&gateway, &["apply", "-f", managed, "--set", "team-b"], true).await?;
    assert_eq!(
        command(&gateway, &["diff", "-f", empty, "--set", "team-a"], true)
            .await?
            .trim(),
        "No changes."
    );
    command(
        &gateway,
        &["mailbox-grant", "revoke", "reviewer", "builder"],
        true,
    )
    .await?;
    command(
        &gateway,
        &["mailbox-grant", "allow", "reviewer", "builder"],
        true,
    )
    .await?;
    assert_eq!(
        command(&gateway, &["diff", "-f", empty, "--set", "team-b"], true)
            .await?
            .trim(),
        "No changes."
    );

    let mut relationship_client =
        ManifestRelationshipsClient::new(protocol::dial(gateway.clone()).await?);
    let tags = |sender: &str| {
        vec![
            ProvisionTag {
                tag: Some(PutTagRequest {
                    tag_id: "bootstrap-a".into(),
                    ..Default::default()
                }),
                mailbox_senders: vec![sender.into()],
                ..Default::default()
            },
            ProvisionTag {
                tag: Some(PutTagRequest {
                    tag_id: "bootstrap-b".into(),
                    ..Default::default()
                }),
                mailbox_senders: vec!["bootstrap-a".into()],
                ..Default::default()
            },
        ]
    };
    let rejected = relationship_client
        .provision_tags(authenticated_request(
            ProvisionTagsRequest {
                tags: tags("missing"),
            },
            OPERATOR,
            None,
        )?)
        .await
        .unwrap_err();
    assert_eq!(rejected.code(), tonic::Code::NotFound);
    command(&gateway, &["get", "tag", "bootstrap-a"], false).await?;
    command(&gateway, &["get", "tag", "bootstrap-b"], false).await?;
    relationship_client
        .provision_tags(authenticated_request(
            ProvisionTagsRequest {
                tags: tags("bootstrap-b"),
            },
            OPERATOR,
            None,
        )?)
        .await?;
    let grants: Value = serde_json::from_str(
        &command(
            &gateway,
            &["get", "mailbox-grants", "--tag", "bootstrap-a"],
            true,
        )
        .await?,
    )?;
    assert_eq!(grants["grants"].as_array().unwrap().len(), 2);

    prune_apply_set(root, &gateway).await?;
    field_managers(root, &gateway).await?;
    resume_apply_set(root, &gateway).await?;

    gateway_process.kill().await?;
    plane.kill().await?;
    Ok(())
}

async fn volume_exists(gateway: &str, id: &str) -> Result<bool> {
    let output = timeout(
        Duration::from_secs(12),
        cli(&["get", "--gateway", gateway, "volume", id]).output(),
    )
    .await??;
    Ok(output.status.success())
}

/// An apply set still owns what a failed or interrupted apply created, and
/// rerunning the same apply finishes it.
async fn resume_apply_set(root: &Path, gateway: &str) -> Result<()> {
    let set = root.join("resume-set");
    std::fs::create_dir(&set)?;
    let path = set.to_str().context("resume set path")?;
    let resources = set.join("resources.yaml");
    // Only the Control Plane refuses to lower an Objective's budget, and an
    // Objective is written last: an apply that lowers it fails after creating
    // every other resource.
    let goal = |budget: u64| {
        format!(
            "apiVersion: supertag/v1\nkind: Objective\nmetadata: {{name: resume-goal}}\n\
             spec: {{ownerTag: builder, outcome: \"Finish.\", budgetLimitMinor: {budget}, budgetCurrency: USD}}\n"
        )
    };
    let existing = root.join("resume-goal.yaml");
    std::fs::write(&existing, goal(200))?;
    command(gateway, &["apply", "-f", existing.to_str().unwrap()], true).await?;
    let manifest = |budget: u64| {
        format!(
            r#"
apiVersion: supertag/v1
kind: Volume
metadata: {{name: resume-a}}
spec: {{source: "file:///srv/resume-a"}}
---
apiVersion: supertag/v1
kind: Volume
metadata: {{name: resume-crashed}}
spec: {{source: "file:///srv/resume-crashed"}}
---
apiVersion: supertag/v1
kind: ContextSet
metadata: {{name: resume-context}}
spec: {{items: []}}
---
apiVersion: supertag/v1
kind: Tag
metadata: {{name: resume-worker}}
spec: {{instructions: "Finish the work."}}
---
apiVersion: supertag/v1
kind: Team
metadata: {{name: resume-crew}}
spec: {{members: [resume-worker]}}
---
{}"#,
            goal(budget)
        )
    };

    // A previous run was interrupted after creating a Volume and before it
    // recorded membership: it had claimed the Volume first.
    let mut client = ManifestRelationshipsClient::new(protocol::dial(gateway.to_owned()).await?);
    client
        .reconcile_apply_set(authenticated_request(
            ReconcileApplySetRequest {
                apply_set: "resume".into(),
                declared: vec![ApplySetDeclaration {
                    kind: "Volume".into(),
                    name: "resume-crashed".into(),
                    revision: 0,
                    created: true,
                }],
                prune: false,
                preview: false,
            },
            OPERATOR,
            None,
        )?)
        .await?;
    command(
        gateway,
        &[
            "volume",
            "put",
            "resume-crashed",
            "--source",
            "file:///srv/resume-crashed",
            "--operation-id",
            "resume-crashed",
        ],
        true,
    )
    .await?;

    // This run creates every prunable resource, then fails.
    std::fs::write(&resources, manifest(100))?;
    let error = command(gateway, &["apply", "-f", path, "--set", "resume"], false).await?;
    assert!(error.contains("Objective/resume-goal"), "{error}");
    assert!(volume_exists(gateway, "resume-a").await?, "{error}");
    // It pruned nothing and still owns what it created.
    let partial = command(
        gateway,
        &["diff", "-f", path, "--set", "resume", "--prune"],
        true,
    )
    .await?;
    assert!(!partial.contains("delete "), "{partial}");

    // Rerunning the corrected input finishes the apply.
    std::fs::write(&resources, manifest(200))?;
    command(gateway, &["apply", "-f", path, "--set", "resume"], true).await?;

    // Every resource either run created belongs to the set.
    std::fs::write(
        &resources,
        "apiVersion: supertag/v1\nkind: Volume\nmetadata: {name: resume-keep}\nspec: {source: \"file:///srv/resume-keep\"}\n",
    )?;
    let expected = "delete Team/resume-crew\n\
         retire Tag/resume-worker\n\
         delete ContextSet/resume-context\n\
         delete Volume/resume-a\n\
         delete Volume/resume-crashed";
    let preview = command(
        gateway,
        &["diff", "-f", path, "--set", "resume", "--prune"],
        true,
    )
    .await?;
    assert_eq!(
        preview.trim(),
        format!("create Volume/resume-keep\n{expected}"),
        "{preview}"
    );
    let applied = command(
        gateway,
        &["apply", "-f", path, "--set", "resume", "--prune"],
        true,
    )
    .await?;
    assert_eq!(
        applied.trim(),
        format!(
            "configured Volume/resume-keep\n{}",
            expected
                .replace("delete ", "deleted ")
                .replace("retire ", "retired ")
        ),
        "{applied}"
    );
    for removed in ["resume-a", "resume-crashed"] {
        assert!(!volume_exists(gateway, removed).await?, "{removed}");
    }
    Ok(())
}

/// Each field a manifest sets belongs to the manager that applied it; another
/// manager's value, or one changed outside apply, conflicts until forced.
async fn field_managers(root: &Path, gateway: &str) -> Result<()> {
    let write = |name: &str, purpose: &str, instructions: &str| -> Result<String> {
        let path = root.join(name);
        std::fs::write(
            &path,
            format!(
                "apiVersion: supertag/v1\nkind: Role\nmetadata: {{name: Owner}}\nspec: {{purpose: \"{purpose}\"}}\n---\napiVersion: supertag/v1\nkind: Tag\nmetadata: {{name: field-tag}}\nspec: {{instructions: \"{instructions}\"}}\n"
            ),
        )?;
        Ok(path.to_str().context("manifest path")?.to_owned())
    };
    let first = write("fields-a.yaml", "Ship reviewed changes.", "One.")?;
    command(gateway, &["apply", "-f", &first, "--set", "team-a"], true).await?;

    // Two sets that disagree about a Role conflict on the field, naming the owning set.
    let quick = write("fields-b.yaml", "Ship quickly.", "One.")?;
    let preview = command(gateway, &["diff", "-f", &quick, "--set", "team-b"], true).await?;
    assert_eq!(
        preview.trim(),
        "update Role/Owner\nconflict Role/Owner: spec.purpose is owned by team-a  (use --force-conflicts)"
    );
    let refused = command(gateway, &["apply", "-f", &quick, "--set", "team-b"], false).await?;
    assert!(
        refused.contains("Nothing was applied. Role/Owner: spec.purpose is owned by team-a"),
        "{refused}"
    );
    assert_eq!(
        command(gateway, &["diff", "-f", &first, "--set", "team-a"], true)
            .await?
            .trim(),
        "No changes."
    );
    // The same value is not a conflict: ownership simply moves.
    command(gateway, &["apply", "-f", &first, "--set", "team-b"], true).await?;
    command(gateway, &["apply", "-f", &quick, "--set", "team-b"], true).await?;
    assert!(
        command(gateway, &["diff", "-f", &first, "--set", "team-a"], true)
            .await?
            .contains("spec.purpose is owned by team-b")
    );

    // A change outside apply belongs to cli until a forced apply takes it back.
    let mut operator = OperatorClient::new(protocol::dial(gateway.to_owned()).await?);
    let tag = operator
        .get_tag(authenticated_request(
            GetTagRequest {
                tag_id: "field-tag".into(),
            },
            OPERATOR,
            None,
        )?)
        .await?
        .into_inner();
    operator
        .put_tag(authenticated_request(
            PutTagRequest {
                tag_id: tag.tag_id,
                instructions: "Changed by hand.".into(),
                expected_revision: Some(tag.revision),
                ..Default::default()
            },
            OPERATOR,
            None,
        )?)
        .await?;
    let second = write("fields-c.yaml", "Ship quickly.", "Two.")?;
    let refused = command(gateway, &["apply", "-f", &second, "--set", "team-b"], false).await?;
    assert!(
        refused.contains("Tag/field-tag: spec.instructions is owned by cli"),
        "{refused}"
    );
    command(
        gateway,
        &[
            "apply",
            "-f",
            &second,
            "--set",
            "team-b",
            "--force-conflicts",
        ],
        true,
    )
    .await?;
    assert_eq!(
        command(gateway, &["diff", "-f", &second, "--set", "team-b"], true)
            .await?
            .trim(),
        "No changes."
    );
    Ok(())
}

async fn prune_apply_set(root: &Path, gateway: &str) -> Result<()> {
    let set = root.join("apply-set");
    std::fs::create_dir(&set)?;
    let volume = |name: &str, source: &str| {
        format!(
            "apiVersion: supertag/v1\nkind: Volume\nmetadata: {{name: {name}}}\nspec: {{source: \"{source}\"}}\n"
        )
    };
    std::fs::write(
        set.join("keep.yaml"),
        volume("set-keep", "file:///srv/keep"),
    )?;
    std::fs::write(set.join("a.yaml"), volume("set-a", "file:///srv/a"))?;
    std::fs::write(set.join("b.yaml"), volume("set-b", "file:///srv/b"))?;
    // `archive` already exists from an apply without a set: it is never adopted.
    std::fs::write(
        set.join("archive.yaml"),
        volume("archive", "file:///var/lib/supertag/archive"),
    )?;
    std::fs::write(
        set.join("crew.yaml"),
        r#"
apiVersion: supertag/v1
kind: Tag
metadata: {name: set-worker}
spec: {instructions: "Do the set's work."}
---
apiVersion: supertag/v1
kind: Team
metadata: {name: set-crew}
spec: {members: [set-worker]}
---
apiVersion: supertag/v1
kind: ContextSet
metadata: {name: set-context}
spec: {items: []}
"#,
    )?;
    let path = set.to_str().context("apply set path")?;
    let error = command(gateway, &["apply", "-f", path, "--prune"], false).await?;
    assert!(error.contains("--set"), "{error}");
    command(
        gateway,
        &["apply", "-f", path, "--set", "release", "--prune"],
        true,
    )
    .await?;
    assert_eq!(
        command(
            gateway,
            &["diff", "-f", path, "--set", "release", "--prune"],
            true
        )
        .await?
        .trim(),
        "No changes."
    );

    // An operator's imperative Volume and another writer's edit of a member.
    let outside = root.join("outside.yaml");
    std::fs::write(&outside, volume("set-b", "file:///srv/b-by-hand"))?;
    // The field belongs to the release set: a different value is a conflict until forced.
    let outside = outside.to_str().unwrap();
    let preview = command(gateway, &["diff", "-f", outside], true).await?;
    assert!(
        preview.contains(
            "conflict Volume/set-b: spec.source is owned by release  (use --force-conflicts)"
        ),
        "{preview}"
    );
    let refused = command(gateway, &["apply", "-f", outside], false).await?;
    assert!(
        refused.contains("Nothing was applied. Volume/set-b: spec.source is owned by release"),
        "{refused}"
    );
    command(
        gateway,
        &["apply", "-f", outside, "--force-conflicts"],
        true,
    )
    .await?;
    command(
        gateway,
        &[
            "volume",
            "put",
            "operator-volume",
            "--source",
            "file:///srv/operator",
            "--operation-id",
            "operator-volume",
        ],
        true,
    )
    .await?;

    for omitted in ["a.yaml", "b.yaml", "archive.yaml", "crew.yaml"] {
        std::fs::remove_file(set.join(omitted))?;
    }
    let preview = command(
        gateway,
        &["diff", "-f", path, "--set", "release", "--prune"],
        true,
    )
    .await?;
    assert_eq!(
        preview.trim(),
        "delete Team/set-crew\n\
         retire Tag/set-worker\n\
         delete ContextSet/set-context\n\
         delete Volume/set-a\n\
         release Volume/set-b: changed outside apply set release after it was applied",
        "{preview}"
    );
    // A diff changes nothing, and an apply without --prune removes nothing.
    command(gateway, &["get", "tag", "set-worker"], true).await?;
    assert_eq!(
        command(gateway, &["apply", "-f", path, "--set", "release"], true)
            .await?
            .trim(),
        "No changes."
    );
    assert!(volume_exists(gateway, "set-a").await?);

    let applied = command(
        gateway,
        &["apply", "-f", path, "--set", "release", "--prune"],
        true,
    )
    .await?;
    assert_eq!(
        applied.trim(),
        "deleted Team/set-crew\n\
         retired Tag/set-worker\n\
         deleted ContextSet/set-context\n\
         deleted Volume/set-a\n\
         released Volume/set-b: changed outside apply set release after it was applied",
        "{applied}"
    );
    let worker: Value =
        serde_json::from_str(&command(gateway, &["get", "tag", "set-worker"], true).await?)?;
    assert!(worker["retired_at_ms"].is_number(), "{worker}");
    assert!(!volume_exists(gateway, "set-a").await?);
    for kept in ["set-keep", "set-b", "archive", "operator-volume", "shared"] {
        assert!(volume_exists(gateway, kept).await?, "{kept}");
    }
    assert_eq!(
        command(
            gateway,
            &["diff", "-f", path, "--set", "release", "--prune"],
            true
        )
        .await?
        .trim(),
        "No changes."
    );
    Ok(())
}

database_tests! {
    #[tokio::test]
    applies_and_previews_a_multi_file_organization_through_split_services;
}

async fn applies_and_previews_a_multi_file_organization_through_split_services(
    database: String,
) -> Result<()> {
    let temp = tempfile::tempdir()?;
    exercise(temp.path(), &database).await
}
