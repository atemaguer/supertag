//! Ports `packages/runtime/sdk/devcontainer-subset.test.ts` against real Git repositories.
use std::{collections::BTreeMap, os::unix::fs::PermissionsExt as _, path::Path, process::Command};

use serde_json::json;
use supertag_workspaces::devcontainer::*;

fn git(repository: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(repository)
        .args(["-c", "user.name=Test", "-c", "user.email=test@example.com"])
        .args(args)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

fn repository() -> tempfile::TempDir {
    let directory = tempfile::tempdir().unwrap();
    git(directory.path(), &["init", "-q"]);
    directory
}

fn commit(repository: &Path, files: &[(&str, &str)]) -> String {
    for (path, content) in files {
        let path = repository.join(path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }
    git(repository, &["add", "-A"]);
    git(repository, &["commit", "-qm", "trusted"]);
    git(repository, &["rev-parse", "HEAD"])
}

fn error(result: anyhow::Result<impl std::fmt::Debug>) -> String {
    result.unwrap_err().to_string()
}

#[test]
fn accepts_only_the_listed_subset_all_lifecycle_forms_and_listed_ignored_properties() {
    let parsed = parse_devcontainer_subset(
        r#"{
        // A devcontainer file may contain comments and trailing commas.
        "image": "node:22", /* inline */
        "onCreateCommand": "npm ci",
        "updateContentCommand": ["npm", "run", "build"],
        "postCreateCommand": {"first": "echo one", "second": ["echo", "two"]},
        "containerEnv": {"MODE": "test"},
        "remoteEnv": {"EDITOR": "vim // not a comment"},
        "remoteUser": "node", "containerUser": "node",
        "workspaceFolder": "/work/app",
        "postStartCommand": "never run", "postAttachCommand": "never run",
        "forwardPorts": [3000], "customizations": {"vscode": {}},
      }"#,
    )
    .unwrap();
    assert_eq!(parsed.image.as_deref(), Some("node:22"));
    assert_eq!(
        parsed.on_create_command,
        Some(DevcontainerCommand::Shell("npm ci".into()))
    );
    assert_eq!(
        parsed.update_content_command,
        Some(DevcontainerCommand::Argv(vec![
            "npm".into(),
            "run".into(),
            "build".into()
        ]))
    );
    assert_eq!(
        parsed.post_create_command,
        Some(DevcontainerCommand::Named(BTreeMap::from([
            ("first".into(), CommandEntry::Shell("echo one".into())),
            (
                "second".into(),
                CommandEntry::Argv(vec!["echo".into(), "two".into()])
            ),
        ])))
    );
    assert_eq!(
        parsed.remote_env.as_ref().unwrap()["EDITOR"],
        "vim // not a comment"
    );
    assert_eq!(parsed.workspace_folder.as_deref(), Some("/work/app"));
    assert!(
        !serde_json::to_string(&parsed)
            .unwrap()
            .contains("never run")
    );
}

#[test]
fn refuses_out_of_subset_properties_by_name() {
    for property in [
        "features",
        "initializeCommand",
        "mounts",
        "dockerComposeFile",
        "unknownField",
    ] {
        let message = error(parse_devcontainer_subset(
            &json!({ property: {} }).to_string(),
        ));
        assert!(message.contains(property), "{message}");
    }
}

#[test]
fn refuses_host_environment_interpolation_and_malformed_nested_properties() {
    let local = format!("${{localEnv:{}}}", "AWS_SECRET_ACCESS_KEY");
    assert!(
        error(parse_devcontainer_subset(
            &json!({"remoteEnv": {"TOKEN": local}}).to_string()
        ))
        .contains("localEnv")
    );
    assert!(
        error(parse_devcontainer_subset(
            r#"{"build":{"dockerfile":"Dockerfile","target":"prod"}}"#
        ))
        .contains("build.target")
    );
    assert!(
        error(parse_devcontainer_subset(
            r#"{"image":"node:22","build":{"dockerfile":"Dockerfile"}}"#
        ))
        .contains("image and build")
    );
    for (source, message) in [
        (r#"{"image":"node 22"}"#, "image reference"),
        (
            r#"{"build":{"dockerfile":"/etc/passwd"}}"#,
            "relative repository path",
        ),
        (r#"{"remoteUser":"bad user"}"#, "user name or ID"),
        (
            r#"{"workspaceFolder":"/work/../app"}"#,
            "normalized absolute path",
        ),
        (r#"{"workspaceFolder":"/"}"#, "normalized absolute path"),
        (r#"{"onCreateCommand":[]}"#, "needs a command"),
        (r#"{"onCreateCommand":{"a":[]}}"#, "string or argv list"),
        (r#"{"containerEnv":{"1BAD":"x"}}"#, "invalid variable name"),
        (r#"{"image": /* open"#, "unclosed comment"),
        ("[]", "root must be an object"),
    ] {
        let found = error(parse_devcontainer_subset(source));
        assert!(found.contains(message), "{source}: {found}");
    }
}

#[test]
fn refuses_reserved_container_environment_names() {
    for name in [
        "ANTHROPIC_BASE_URL",
        "OPENAI_API_KEY",
        "HTTPS_PROXY",
        "NODE_OPTIONS",
        "PATH",
        "GIT_CONFIG_GLOBAL",
        "SUPERTAG_STATE_DIR",
        "LD_PRELOAD",
        "DYLD_INSERT_LIBRARIES",
        "modal_token_id",
    ] {
        for property in ["containerEnv", "remoteEnv"] {
            let message = error(parse_devcontainer_subset(
                &json!({ property: { name: "x" } }).to_string(),
            ));
            assert!(message.contains(&format!("{property}.{name}")), "{message}");
        }
    }
    // Build arguments are not container environment and may use these names.
    parse_devcontainer_subset(r#"{"build":{"dockerfile":"Dockerfile","args":{"PATH":"x"}}}"#)
        .unwrap();
}

#[test]
fn refuses_reserved_names_in_a_directly_supplied_provider_definition() {
    let definition = DevcontainerSubset {
        remote_env: Some(BTreeMap::from([("PATH".into(), "/tmp".into())])),
        ..Default::default()
    };
    assert!(
        error(resolved_devcontainer_env(Some(&definition), "/work/app")).contains("remoteEnv.PATH")
    );
}

#[test]
fn resolves_container_references_and_workspace_folder_without_host_variables() {
    let definition = parse_devcontainer_subset(
        r#"{
          "containerEnv": {"ROOT": "${workspaceFolder}/out", "BIN": "${containerEnv:ROOT}/bin", "EMPTY": "${}"},
          "remoteEnv": {"TOOLS": "${containerEnv:BIN}:/usr/bin"}
        }"#,
    )
    .unwrap();
    let resolved = resolved_devcontainer_env(Some(&definition), "/work/app").unwrap();
    assert_eq!(resolved["ROOT"], "/work/app/out");
    assert_eq!(resolved["BIN"], "/work/app/out/bin");
    assert_eq!(resolved["EMPTY"], "${}");
    assert_eq!(resolved["TOOLS"], "/work/app/out/bin:/usr/bin");
    for (source, message) in [
        (
            r#"{"containerEnv":{"A":"${containerEnv:B}","B":"${containerEnv:A}"}}"#,
            "cycle",
        ),
        (
            r#"{"remoteEnv":{"A":"${env:HOME}"}}"#,
            "unsupported reference ${env:HOME}",
        ),
        (
            r#"{"remoteEnv":{"A":"${containerEnv:MISSING}"}}"#,
            "unsupported reference",
        ),
    ] {
        let definition = parse_devcontainer_subset(source).unwrap();
        let found = error(resolved_devcontainer_env(Some(&definition), "/w"));
        assert!(found.contains(message), "{source}: {found}");
    }
}

#[test]
fn uses_an_explicit_dockerfile_instruction_allowlist() {
    for instruction in [
        "COPY x /x",
        "ADD x /x",
        "ONBUILD RUN echo x",
        "HEALTHCHECK NONE",
        "STOPSIGNAL SIGTERM",
    ] {
        let message = error(validated_devcontainer_dockerfile(
            &format!("FROM alpine\n{instruction}\n"),
            None,
        ));
        assert!(
            message.contains(instruction.split(' ').next().unwrap()),
            "{message}"
        );
    }
    assert!(
        error(validated_devcontainer_dockerfile(
            "FROM alpine\nR\u{1b}[31mUN echo x\n",
            None
        ))
        .contains("control character")
    );
    for (source, message) in [
        (
            "# syntax=docker/dockerfile:1\nFROM alpine\n",
            "parser directives",
        ),
        ("RUN echo x\nFROM alpine\n", "needs FROM before RUN"),
        ("FROM alpine\nFROM busybox\n", "multiple FROM"),
        ("ARG A=1\n", "needs FROM"),
    ] {
        let found = error(validated_devcontainer_dockerfile(source, None));
        assert!(found.contains(message), "{source}: {found}");
    }
    // Continuations join one logical instruction.
    validated_devcontainer_dockerfile("FROM alpine\nRUN echo a \\\n  && echo b\n", None).unwrap();
}

#[test]
fn applies_build_args_only_to_declared_arg_instructions() {
    let args = BTreeMap::from([("VERSION".to_owned(), "22".to_owned())]);
    assert_eq!(
        apply_devcontainer_build_args("ARG VERSION=20\nFROM node:${VERSION}\n", Some(&args))
            .unwrap(),
        "ARG VERSION=22\nFROM node:${VERSION}\n"
    );
    assert!(
        error(apply_devcontainer_build_args(
            "ARG VERSIONS\nFROM node\n",
            Some(&args)
        ))
        .contains("has no ARG")
    );
    let newline = BTreeMap::from([("VERSION".to_owned(), "1\nRUN evil".to_owned())]);
    assert!(
        error(apply_devcontainer_build_args(
            "ARG VERSION\nFROM x\n",
            Some(&newline)
        ))
        .contains("cannot contain a newline")
    );
}

#[test]
fn build_args_skip_multibyte_dockerfile_text_instead_of_panicking() {
    let args = BTreeMap::from([("VERSION".to_owned(), "22".to_owned())]);
    // An em dash covers bytes 2..5 and `é` covers 2..4: byte 3 is not a character boundary.
    let source = "# \u{2014} install deps\néé ARG\nARG \u{e9}\u{e9}\u{e9}\u{e9}\nARG VERSION=20\nFROM node:${VERSION}\n";
    assert_eq!(
        apply_devcontainer_build_args(source, Some(&args)).unwrap(),
        source.replace("VERSION=20", "VERSION=22")
    );
    assert!(
        validated_devcontainer_dockerfile(
            "# \u{2014} install deps\nARG VERSION=20\nFROM node:${VERSION}\n",
            Some(&args)
        )
        .unwrap()
        .contains("ARG VERSION=22")
    );
    assert!(
        error(apply_devcontainer_build_args(
            "# \u{2014}\nFROM x\n",
            Some(&args)
        ))
        .contains("has no ARG")
    );
}

#[test]
fn keeps_node_trailing_slash_semantics_for_paths() {
    // Node's `posix.normalize` keeps a trailing slash, so TS accepts this folder.
    let parsed = parse_devcontainer_subset(
        r#"{"workspaceFolder":"/workspaces/app/","build":{"dockerfile":"Dockerfile","context":"tools/"}}"#,
    )
    .unwrap();
    assert_eq!(parsed.workspace_folder.as_deref(), Some("/workspaces/app/"));
    // Repository paths drop the slash so the build-context prefix still matches files.
    assert_eq!(parsed.build.unwrap().context.as_deref(), Some("tools"));
    for folder in [
        "/workspaces//app/",
        "/workspaces/./app/",
        "/workspaces/x/../app/",
    ] {
        let source = format!(r#"{{"workspaceFolder":"{folder}"}}"#);
        assert!(
            error(parse_devcontainer_subset(&source)).contains("normalized absolute path"),
            "{folder}"
        );
    }
}

#[test]
fn translates_a_dockerfile_arg_used_by_a_registry_from() {
    let definition = DevcontainerSubset {
        build: Some(DevcontainerBuild {
            dockerfile: "Dockerfile".into(),
            dockerfile_digest: Some("a".repeat(64)),
            dockerfile_content: Some(
                "ARG VERSION=20\nFROM node:${VERSION}\nRUN node --version".into(),
            ),
            args: Some(BTreeMap::from([("VERSION".into(), "22".into())])),
            ..Default::default()
        }),
        ..Default::default()
    };
    assert_eq!(
        devcontainer_base(Some(&definition), "fallback").unwrap(),
        DevcontainerBase {
            image: "node:22".into(),
            commands: vec!["RUN node --version".into()]
        }
    );
    assert_eq!(
        devcontainer_base(None, "fallback").unwrap().image,
        "fallback"
    );
    let image = DevcontainerSubset {
        image: Some("python:3.13".into()),
        ..Default::default()
    };
    assert_eq!(
        devcontainer_base(Some(&image), "fallback").unwrap().image,
        "python:3.13"
    );
    let undefined = DevcontainerSubset {
        build: Some(DevcontainerBuild {
            dockerfile_content: Some("FROM node:$MISSING\n".into()),
            ..Default::default()
        }),
        ..Default::default()
    };
    assert!(
        error(devcontainer_base(Some(&undefined), "fallback"))
            .contains("undefined FROM argument MISSING")
    );
}

#[test]
fn chooses_the_declared_user_then_the_last_literal_dockerfile_user() {
    let build = |content: &str| DevcontainerSubset {
        build: Some(DevcontainerBuild {
            dockerfile_content: Some(content.into()),
            ..Default::default()
        }),
        ..Default::default()
    };
    assert_eq!(
        devcontainer_image_user(Some(&build("FROM x\nUSER root\nUSER node:staff\n"))).unwrap(),
        Some("node:staff".into())
    );
    let mut declared = build("FROM x\nUSER node\n");
    declared.container_user = Some("builder".into());
    assert_eq!(
        devcontainer_image_user(Some(&declared)).unwrap(),
        Some("builder".into())
    );
    declared.remote_user = Some("dev".into());
    assert_eq!(
        devcontainer_image_user(Some(&declared)).unwrap(),
        Some("dev".into())
    );
    assert!(
        error(devcontainer_image_user(Some(&build(
            "FROM x\nUSER $USER\n"
        ))))
        .contains("literal user")
    );
    assert_eq!(devcontainer_image_user(None).unwrap(), None);
}

#[test]
fn runs_only_update_content_command_on_warm_preparation() {
    let definition = parse_devcontainer_subset(
        &json!({
            "onCreateCommand": "echo create",
            "updateContentCommand": ["echo", "it's updated"],
            "postCreateCommand": "echo post",
            "containerEnv": {"MODE": "a'b"},
        })
        .to_string(),
    )
    .unwrap();
    let cold = devcontainer_commands(Some(&definition), false, "/work/app").unwrap();
    assert_eq!(
        cold,
        vec![
            "export MODE='a'\"'\"'b'".to_owned(),
            "sh -c 'echo create'".into(),
            "'echo' 'it'\"'\"'s updated'".into(),
            "sh -c 'echo post'".into(),
        ]
    );
    let warm = devcontainer_commands(Some(&definition), true, "/work/app")
        .unwrap()
        .join("\n");
    assert!(warm.contains("it'\"'\"'s updated"));
    assert!(!warm.contains("echo create") && !warm.contains("echo post"));
    assert!(devcontainer_commands(None, false, "/w").unwrap().is_empty());
}

#[test]
fn reads_the_trusted_commit_not_the_task_branch_or_working_tree() {
    let repository = repository();
    let path = repository.path();
    let trusted = commit(
        path,
        &[(".devcontainer/devcontainer.json", r#"{"image":"node:22"}"#)],
    );
    std::fs::write(
        path.join(".devcontainer/devcontainer.json"),
        r#"{"features":{"evil":{}}}"#,
    )
    .unwrap();
    let later = commit(path, &[]);
    assert_eq!(
        read_trusted_devcontainer(path, &trusted)
            .unwrap()
            .unwrap()
            .image
            .as_deref(),
        Some("node:22")
    );
    assert!(
        error(read_trusted_devcontainer(path, &later))
            .contains("Unsupported devcontainer property features")
    );
    // The root-level file is the fallback, and a missing file means the provider default.
    let other = repository_with(&[(".devcontainer.json", r#"{"image":"alpine"}"#)]);
    let head = git(other.path(), &["rev-parse", "HEAD"]);
    assert_eq!(
        read_trusted_devcontainer(other.path(), &head)
            .unwrap()
            .unwrap()
            .image
            .as_deref(),
        Some("alpine")
    );
    let empty = repository_with(&[("README.md", "none")]);
    let head = git(empty.path(), &["rev-parse", "HEAD"]);
    assert_eq!(
        read_trusted_devcontainer(empty.path(), &head).unwrap(),
        None
    );
    assert!(
        error(read_trusted_devcontainer(empty.path(), "HEAD")).contains("invalid trusted commit")
    );
}

fn repository_with(files: &[(&str, &str)]) -> tempfile::TempDir {
    let repository = repository();
    commit(repository.path(), files);
    repository
}

#[test]
fn reads_and_digests_the_named_dockerfile_and_refuses_escapes() {
    let dockerfile = "FROM node:22\nRUN echo secret-looking-value\n";
    let repository = repository_with(&[
        (
            ".devcontainer/devcontainer.json",
            r#"{"build":{"dockerfile":"Dockerfile","context":".."}}"#,
        ),
        (".devcontainer/Dockerfile", dockerfile),
    ]);
    let head = git(repository.path(), &["rev-parse", "HEAD"]);
    let build = read_trusted_devcontainer(repository.path(), &head)
        .unwrap()
        .unwrap()
        .build
        .unwrap();
    assert_eq!(
        build.dockerfile_path.as_deref(),
        Some(".devcontainer/Dockerfile")
    );
    assert_eq!(build.context.as_deref(), Some("."));
    assert_eq!(build.dockerfile_content.as_deref(), Some(dockerfile));
    use sha2::Digest as _;
    assert_eq!(
        build.dockerfile_digest.unwrap(),
        format!("{:x}", sha2::Sha256::digest(dockerfile.as_bytes()))
    );
    for (definition, message) in [
        (
            r#"{"build":{"dockerfile":"../../Dockerfile"}}"#,
            "build.dockerfile escapes",
        ),
        (
            r#"{"build":{"dockerfile":"Dockerfile","context":"../.."}}"#,
            "build.context escapes",
        ),
        (
            r#"{"build":{"dockerfile":"Missing"}}"#,
            "is missing at the trusted commit",
        ),
    ] {
        let repository = repository_with(&[
            (".devcontainer/devcontainer.json", definition),
            (".devcontainer/Dockerfile", dockerfile),
        ]);
        let head = git(repository.path(), &["rev-parse", "HEAD"]);
        let found = error(read_trusted_devcontainer(repository.path(), &head));
        assert!(found.contains(message), "{definition}: {found}");
    }
}

#[test]
fn materializes_only_tracked_regular_blobs_and_refuses_symlinks() {
    let repository = repository_with(&[
        ("context/run.sh", "#!/bin/sh\necho hi\n"),
        ("context/nested/data.txt", "data"),
        ("outside.txt", "not in context"),
    ]);
    let path = repository.path();
    let mut permissions = std::fs::metadata(path.join("context/run.sh"))
        .unwrap()
        .permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(path.join("context/run.sh"), permissions).unwrap();
    let head = commit(path, &[]);
    std::fs::write(path.join("context/untracked.txt"), "untracked").unwrap();
    let destination = tempfile::tempdir().unwrap();
    let output = destination.path().join("out");
    materialize_trusted_build_context(path, &head, "context", &output).unwrap();
    assert_eq!(
        std::fs::read_to_string(output.join("nested/data.txt")).unwrap(),
        "data"
    );
    assert_eq!(
        std::fs::metadata(output.join("run.sh"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    assert_eq!(
        std::fs::metadata(output.join("nested/data.txt"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    assert!(!output.join("untracked.txt").exists() && !output.join("outside.txt").exists());

    std::os::unix::fs::symlink("/private/host-secret", path.join("context/linked")).unwrap();
    let head = commit(path, &[]);
    let message = error(materialize_trusted_build_context(
        path,
        &head,
        "context",
        &destination.path().join("second"),
    ));
    assert!(message.contains("symlink context/linked"), "{message}");
    assert!(
        error(materialize_trusted_build_context(
            path,
            &head,
            "../context",
            &destination.path().join("third"),
        ))
        .contains("unsafe path")
    );
}
