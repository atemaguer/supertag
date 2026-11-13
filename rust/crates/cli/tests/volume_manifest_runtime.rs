//! Volume manifests, source settings, and location aliases through separate Control Plane and
//! Gateway processes and the operator CLI.
//!
//! A Volume source names a location only: a canonical `file:///absolute/path` or
//! `s3://bucket/prefix`. Unlike TypeScript, it carries no endpoint, region, path style, or
//! credential name; each Gateway maps a Volume ID to its storage endpoint and credentials. So
//! the CLI and the Control Plane refuse every setting in a source, and storage that two
//! endpoints could alias can only be reached through Gateway mappings, never through a Volume
//! that a Task mounts. A Workspace data Volume is a file Volume, or an S3 Volume that names the
//! credential its Worker Hosts map; a path alias, or an S3 bucket and prefix, of artifact storage
//! is refused in both directions.
#[path = "../../../test-support/prerequisites.rs"]
mod prerequisites;
#[macro_use]
#[path = "support/database.rs"]
mod database;
#[path = "support/operator_services.rs"]
mod operator_services;

use anyhow::Result;
use operator_services::OperatorServices;
use serde_json::Value;

const ORGANIZATION: &str = r#"apiVersion: supertag/v1
kind: Volume
metadata: {name: datasets}
spec: {source: "s3://acme-data/datasets/v3"}
---
apiVersion: supertag/v1
kind: Volume
metadata: {name: artifacts}
spec: {source: "file:///srv/supertag/artifacts"}
"#;

fn manifest(name: &str, spec: &str) -> String {
    format!("apiVersion: supertag/v1\nkind: Volume\nmetadata: {{name: {name}}}\nspec: {spec}\n")
}

async fn volume_ids(services: &OperatorServices) -> Result<Vec<String>> {
    let listed: Value = serde_json::from_str(&services.ok(&["get", "volumes"]).await?)?;
    Ok(listed["volumes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|volume| volume["volume_id"].as_str().map(str::to_owned))
        .collect())
}

/// The error names the problem and carries no terminal controls from the refused value.
fn assert_refused(error: &str, expected: &str) {
    assert!(error.contains(expected), "{error}");
    assert!(
        !error
            .chars()
            .any(|c| c != '\n' && (c.is_control() || matches!(c, '\u{202a}'..='\u{202e}'))),
        "{error:?}"
    );
}

database_tests! {
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    volume_manifests_apply_round_trip_and_refuse_source_settings;
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    workspace_data_volumes_cannot_alias_artifact_storage;
}

async fn volume_manifests_apply_round_trip_and_refuse_source_settings(
    database: String,
) -> Result<()> {
    let services = OperatorServices::start(&database).await?;
    let directory = tempfile::tempdir()?;
    let path = directory.path().join("organization.yaml");
    std::fs::write(&path, ORGANIZATION)?;
    let path = path.to_str().unwrap();

    // Resources of one kind apply in name order.
    let preview = services.ok(&["diff", "-f", path]).await?;
    assert_eq!(
        preview, "create Volume/artifacts\ncreate Volume/datasets\n",
        "{preview}"
    );
    let applied = services.ok(&["apply", "-f", path]).await?;
    assert_eq!(
        applied,
        "configured Volume/artifacts\nconfigured Volume/datasets\n"
    );
    assert_eq!(services.ok(&["diff", "-f", path]).await?, "No changes.\n");
    assert_eq!(services.ok(&["apply", "-f", path]).await?, "No changes.\n");
    let datasets: Value =
        serde_json::from_str(&services.ok(&["get", "volume", "datasets"]).await?)?;
    assert_eq!(datasets["source"], "s3://acme-data/datasets/v3");
    assert_eq!(datasets["revision"], 1);
    assert_eq!(volume_ids(&services).await?, ["artifacts", "datasets"]);
    let described = services.ok(&["describe", "volume", "datasets"]).await?;
    assert!(
        described.contains("s3://acme-data/datasets/v3"),
        "{described}"
    );

    // Retargeting a Volume is one revised write, shown before it is applied.
    let moved = path.replace("organization", "moved");
    std::fs::write(&moved, ORGANIZATION.replace("datasets/v3", "datasets/v4"))?;
    assert_eq!(
        services.ok(&["diff", "-f", &moved]).await?,
        "update Volume/datasets\n"
    );
    services.ok(&["apply", "-f", &moved]).await?;
    let datasets: Value =
        serde_json::from_str(&services.ok(&["get", "volume", "datasets"]).await?)?;
    assert_eq!(datasets["source"], "s3://acme-data/datasets/v4");
    assert_eq!(datasets["revision"], 2);

    // Connection settings, credentials, and other schemes are not part of a Volume source.
    let refused = directory.path().join("refused.yaml");
    let refused_path = refused.to_str().unwrap();
    for (spec, expected) in [
        (
            r#"{source: "azure://acme/x"}"#,
            "canonical absolute file URL",
        ),
        (
            r#"{source: "gs://datasets/train"}"#,
            "canonical absolute file URL",
        ),
        (
            r#"{source: "r2://bucket/data"}"#,
            "canonical absolute file URL",
        ),
        (
            r#"{source: "modal-volume://training/models"}"#,
            "canonical absolute file URL",
        ),
        (
            r#"{source: "s3://acme-data"}"#,
            "canonical s3://bucket/prefix",
        ),
        (
            r#"{source: "s3://acme-data/datasets/"}"#,
            "canonical s3://bucket/prefix",
        ),
        (
            r#"{source: "s3://acme-data/datasets?endpoint=https://storage.googleapis.com"}"#,
            "canonical s3://bucket/prefix",
        ),
        (
            r#"{source: "s3://acme-data/datasets?region=us-east-1&forcePathStyle=true"}"#,
            "canonical s3://bucket/prefix",
        ),
        (
            r#"{source: "s3://AKIAIOSFODNN7EXAMPLE:secret@acme-data/datasets"}"#,
            "canonical s3://bucket/prefix",
        ),
        (
            r#"{source: "file:///srv/data?region=us-east-1"}"#,
            "canonical absolute file URL",
        ),
        (
            r#"{source: "file:///srv/../etc"}"#,
            "canonical absolute file URL",
        ),
        (
            "{source: \"s3://acme-data/data\\u202e\\u009b2J\"}",
            "canonical s3://bucket/prefix",
        ),
        (
            r#"{source: "s3://acme-data/datasets", credential: acme-data}"#,
            // A field that is not part of the schema is never echoed: it could hold a secret.
            "invalid Volume spec",
        ),
    ] {
        std::fs::write(&refused, manifest("refused", spec))?;
        for command in ["diff", "apply"] {
            let error = services.fails(&[command, "-f", refused_path]).await?;
            assert_refused(&error, expected);
        }
    }
    // The Control Plane applies the same rule to a Volume registered without a manifest.
    for source in [
        "gs://datasets/train",
        "s3://acme-data/datasets?endpoint=https://storage.googleapis.com",
        "file:///srv/data?region=us-east-1",
    ] {
        let error = services
            .fails(&[
                "volume",
                "put",
                "refused",
                "--source",
                source,
                "--operation-id",
                "refused-volume",
            ])
            .await?;
        assert!(error.contains("canonical"), "{error}");
    }
    assert_eq!(volume_ids(&services).await?, ["artifacts", "datasets"]);
    services.stop().await
}

async fn workspace_data_volumes_cannot_alias_artifact_storage(database: String) -> Result<()> {
    let services = OperatorServices::start(&database).await?;
    let directory = tempfile::tempdir()?;
    let path = directory.path().join("organization.yaml");
    std::fs::write(&path, ORGANIZATION)?;
    services
        .ok(&["apply", "-f", path.to_str().unwrap()])
        .await?;

    let put = |id: &'static str, source: &'static str| {
        let services = &services;
        async move {
            services
                .run(&["workspace-volume", "put", id, "--source", source])
                .await
        }
    };
    // The artifact Volume itself, a directory inside it, and a directory that contains it.
    let mut aliases = vec![
        "file:///srv/supertag/artifacts",
        "file:///srv/supertag/artifacts/attempts",
        "file:///srv/supertag",
    ];
    if cfg!(target_os = "macos") {
        // The usual macOS filesystem folds case and Unicode normalization.
        aliases.extend([
            "file:///srv/supertag/ARTIFACTS",
            "file:///SRV/Supertag/Artifacts/attempts",
        ]);
    }
    for source in aliases {
        let output = put("data", source).await?;
        assert!(!output.success, "{source} was registered");
        assert!(
            output
                .stderr
                .contains("Workspace Volume overlaps artifact storage"),
            "{source}: {}",
            output.stderr
        );
    }
    // S3 Workspace data names a credential, and cannot reach S3 artifact
    // storage by bucket and prefix on any endpoint, since sources carry none.
    for (source, credential, reason) in [
        (
            "s3://acme-data/datasets/v3",
            "",
            "requires a credential name",
        ),
        (
            "s3://acme-data/datasets/v3",
            "acme",
            "Workspace Volume overlaps artifact storage",
        ),
        (
            "s3://acme-data/datasets",
            "acme",
            "Workspace Volume overlaps artifact storage",
        ),
        (
            "s3://zzz?endpoint=https://acme-data.s3.amazonaws.com",
            "acme",
            "canonical s3://bucket/prefix",
        ),
        (
            "gs://acme-data/datasets/v3",
            "",
            "canonical absolute file URL",
        ),
    ] {
        let mut args = vec!["workspace-volume", "put", "data", "--source", source];
        if !credential.is_empty() {
            args.extend(["--credential", credential]);
        }
        let output = services.run(&args).await?;
        assert!(!output.success, "{source} was registered");
        assert!(
            output.stderr.contains(reason),
            "{source}: {}",
            output.stderr
        );
    }

    let output = put("data", "file:///srv/supertag/data").await?;
    assert!(output.success, "{}", output.stderr);
    let data: Value = serde_json::from_str(&output.stdout)?;
    assert_eq!(data["source"], "file:///srv/supertag/data");

    // Artifact storage cannot later move inside, or around, Workspace data.
    for source in [
        "file:///srv/supertag/data/artifacts",
        "file:///srv/supertag",
    ] {
        let error = services
            .fails(&[
                "volume",
                "put",
                "late",
                "--source",
                source,
                "--operation-id",
                &format!("late-{}", source.len()),
            ])
            .await?;
        assert!(
            error.contains("artifact Volume overlaps a Workspace data Volume"),
            "{source}: {error}"
        );
    }

    if cfg!(target_os = "macos") {
        // The same name composed (NFC) and decomposed (NFD) names one macOS directory.
        let output = put("composed", "file:///srv/supertag/caf%C3%A9").await?;
        assert!(output.success, "{}", output.stderr);
        let error = services
            .fails(&[
                "volume",
                "put",
                "decomposed",
                "--source",
                "file:///srv/supertag/cafe%CC%81/artifacts",
                "--operation-id",
                "decomposed",
            ])
            .await?;
        assert!(
            error.contains("artifact Volume overlaps a Workspace data Volume"),
            "{error}"
        );
    }
    services.stop().await
}
