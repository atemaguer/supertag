//! `supertag setup deployment`, `check deployment`, and `verify deployment` against the real
//! service processes, configured from the files setup writes: a private Control Plane that
//! requires client certificates, a public TLS Gateway whose certificate comes from a separate
//! authority, and two outbound Worker Hosts placed by label for a two-manager organization
//! applied through the Gateway.
//!
//! Ports `tests/deployment-setup.test.ts` (setup, check, verify) and the deployed-organization
//! part of `tests/shared-organization-*.test.ts` without model calls.
#[path = "../../../test-support/prerequisites.rs"]
mod prerequisites;
#[macro_use]
#[path = "support/database.rs"]
mod database;

use std::{
    collections::BTreeMap,
    net::SocketAddr,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Stdio,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, ensure};
use serde_json::Value;
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    time::{sleep, timeout},
};

const BINARY: &str = env!("CARGO_BIN_EXE_supertag");
const ADAPTER: &str = env!("CARGO_BIN_EXE_supertag-fixture-adapter");
const WAIT: Duration = Duration::from_secs(30);

const ORGANIZATION: &str = r#"
apiVersion: supertag/v1
kind: PermissionSet
metadata: {name: shared-workspace}
spec:
  permissions:
    - {target: runtime, action: "files:read"}
---
apiVersion: supertag/v1
kind: Role
metadata: {name: Manager}
spec:
  purpose: Build and independently review a CSV utility in one shared workspace.
  permissionSets: [shared-workspace]
---
apiVersion: supertag/v1
kind: Tag
metadata: {name: builder-manager}
spec:
  roles: [Manager]
  instructions: "Build the CSV utility"
  acceptsMessagesFrom: [review-manager]
  runsOn: [builder-host]
---
apiVersion: supertag/v1
kind: Tag
metadata: {name: review-manager}
spec:
  roles: [Manager]
  instructions: "Review the CSV utility"
  acceptsMessagesFrom: [builder-manager]
  runsOn: [review-host]
---
apiVersion: supertag/v1
kind: Team
metadata: {name: csv}
spec: {members: [builder-manager, review-manager], maxConcurrency: 2}
"#;

struct Pki {
    directory: PathBuf,
}

struct Leaf {
    cert: PathBuf,
    key: PathBuf,
}

impl Pki {
    async fn openssl(&self, args: &[&str]) -> Result<()> {
        let output = Command::new("openssl")
            .args(args)
            .current_dir(&self.directory)
            .stdin(Stdio::null())
            .output()
            .await
            .context("openssl is required for TLS process tests")?;
        ensure!(
            output.status.success(),
            "openssl {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        Ok(())
    }

    async fn authority(root: &Path, name: &str) -> Result<Self> {
        let directory = root.join(name);
        std::fs::create_dir_all(&directory)?;
        let pki = Self { directory };
        pki.openssl(&[
            "req",
            "-x509",
            "-newkey",
            "ec",
            "-pkeyopt",
            "ec_paramgen_curve:prime256v1",
            "-nodes",
            "-days",
            "1",
            "-subj",
            &format!("/CN={name}"),
            "-addext",
            "basicConstraints=critical,CA:TRUE",
            "-addext",
            "keyUsage=critical,keyCertSign,cRLSign",
            "-keyout",
            "ca.key",
            "-out",
            "ca.pem",
        ])
        .await?;
        Ok(pki)
    }

    fn ca(&self) -> PathBuf {
        self.directory.join("ca.pem")
    }

    async fn leaf(&self, name: &str, usage: &str) -> Result<Leaf> {
        let extensions = format!("{name}.ext");
        std::fs::write(
            self.directory.join(&extensions),
            format!(
                "subjectAltName=IP:127.0.0.1,DNS:localhost\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage={usage}\n"
            ),
        )?;
        let (key, request, cert) = (
            format!("{name}.key"),
            format!("{name}.csr"),
            format!("{name}.pem"),
        );
        self.openssl(&[
            "req",
            "-newkey",
            "ec",
            "-pkeyopt",
            "ec_paramgen_curve:prime256v1",
            "-nodes",
            "-subj",
            &format!("/CN={name}"),
            "-keyout",
            &key,
            "-out",
            &request,
        ])
        .await?;
        self.openssl(&[
            "x509",
            "-req",
            "-in",
            &request,
            "-CA",
            "ca.pem",
            "-CAkey",
            "ca.key",
            "-CAcreateserial",
            "-days",
            "1",
            "-extfile",
            &extensions,
            "-out",
            &cert,
        ])
        .await?;
        Ok(Leaf {
            cert: self.directory.join(cert),
            key: self.directory.join(key),
        })
    }
}

fn command(home: &Path, args: &[&str], env: &[(&str, &str)]) -> Command {
    let mut command = Command::new(BINARY);
    // Never inherit an operator's credentials, TLS settings, or state location.
    command
        .args(args)
        .env_clear()
        .env("HOME", home)
        .envs(env.iter().copied())
        .stdin(Stdio::null())
        .kill_on_drop(true);
    command
}

/// Runs a command and returns (success, stdout, stderr).
async fn run(mut command: Command) -> Result<(bool, String, String)> {
    let output = timeout(WAIT, command.output())
        .await
        .context("SuperTag command did not exit")??;
    Ok((
        output.status.success(),
        String::from_utf8(output.stdout)?,
        String::from_utf8(output.stderr)?,
    ))
}

async fn succeed(command: Command) -> Result<String> {
    let (success, stdout, stderr) = run(command).await?;
    ensure!(success, "command failed: {stderr}");
    Ok(stdout)
}

async fn fail(command: Command) -> Result<String> {
    let (success, stdout, stderr) = run(command).await?;
    ensure!(!success, "command unexpectedly succeeded: {stdout}");
    Ok(stderr)
}

async fn service(mut command: Command, log: &Path) -> Result<(Child, SocketAddr)> {
    command
        .stdout(Stdio::piped())
        .stderr(std::fs::File::create(log)?);
    let mut child = command.spawn()?;
    let mut output = BufReader::new(child.stdout.take().context("missing service stdout")?);
    let mut ready = String::new();
    timeout(WAIT, output.read_line(&mut ready))
        .await
        .with_context(|| std::fs::read_to_string(log).unwrap_or_default())??;
    let address: SocketAddr = ready.trim().parse().with_context(|| {
        format!(
            "service did not report its bind address: {}",
            std::fs::read_to_string(log).unwrap_or_default()
        )
    })?;
    Ok((child, address))
}

/// The env file format setup writes: KEY=VALUE, optionally single- or double-quoted.
fn env_file(path: &Path) -> Result<BTreeMap<String, String>> {
    let mut values = BTreeMap::new();
    for line in std::fs::read_to_string(path)?.lines() {
        let (key, value) = line.split_once('=').context("KEY=VALUE")?;
        let value = value
            .strip_prefix('\'')
            .and_then(|value| value.strip_suffix('\''))
            .unwrap_or(value);
        values.insert(key.to_owned(), value.to_owned());
    }
    Ok(values)
}

fn mode(path: &Path) -> Result<u32> {
    Ok(std::fs::metadata(path)?.permissions().mode() & 0o777)
}

async fn deploys_and_verifies_split_roles(database: String) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let root = directory.path();
    let home = root.join("home");
    std::fs::create_dir(&home)?;
    let path = |name: &str| root.join(name).to_string_lossy().into_owned();

    // The private hop and the public endpoint use separate authorities.
    let private = Pki::authority(root, "private-ca").await?;
    let public = Pki::authority(root, "public-ca").await?;
    let control_leaf = private.leaf("control-plane", "serverAuth").await?;
    let client_leaf = private.leaf("gateway-client", "clientAuth").await?;
    let gateway_leaf = public.leaf("gateway", "serverAuth").await?;

    // Setup writes private per-role files; secrets come only from the environment.
    let output = root.join("deployment");
    let setup_database = if database.starts_with("postgres") {
        database.clone()
    } else {
        "postgresql://supertag@127.0.0.1:1/unused".to_owned()
    };
    let setup = |extra: &[(&str, &str)]| {
        let mut env = vec![
            ("SUPERTAG_DATABASE_URL", setup_database.as_str()),
            ("SUPERTAG_OPERATOR_PRINCIPAL", "operator:deploy"),
        ];
        env.extend_from_slice(extra);
        command(
            &home,
            &[
                "setup",
                "deployment",
                "compose",
                "--non-interactive",
                "--output",
                output.to_str().expect("utf-8 path"),
            ],
            &env,
        )
    };
    let message = succeed(setup(&[])).await?;
    assert!(
        message.contains("Saved compose deployment configuration"),
        "{message}"
    );
    assert!(message.contains("https://control-plane:3435"), "{message}");
    assert_eq!(mode(&output)?, 0o700);
    for name in ["control-plane.env", "gateway.env", "operator.env"] {
        assert_eq!(mode(&output.join(name))?, 0o600, "{name}");
    }
    assert!(!output.join("postgres.env").exists());
    let control_env = env_file(&output.join("control-plane.env"))?;
    let gateway_env = env_file(&output.join("gateway.env"))?;
    let operator_env = env_file(&output.join("operator.env"))?;
    let operator_token = operator_env["SUPERTAG_OPERATOR_TOKEN"].clone();
    for secret in [
        &operator_token,
        &gateway_env["SUPERTAG_GATEWAY_TOKEN"],
        &setup_database,
    ] {
        assert!(!message.contains(secret.as_str()), "setup printed a secret");
    }
    assert_eq!(control_env["SUPERTAG_DATABASE_URL"], setup_database);
    assert!(!gateway_env.contains_key("SUPERTAG_DATABASE_URL"));
    assert_eq!(
        gateway_env["SUPERTAG_OPERATOR_PRINCIPAL"],
        "operator:deploy"
    );
    // Setup never replaces an existing directory.
    let before = std::fs::read(output.join("gateway.env"))?;
    let refused = fail(setup(&[])).await?;
    assert!(
        refused.contains("never replaces an existing directory"),
        "{refused}"
    );
    assert_eq!(std::fs::read(output.join("gateway.env"))?, before);
    // Missing required values fail before anything is written.
    let hosted = root.join("hosted");
    let refused = fail(command(
        &home,
        &[
            "setup",
            "deployment",
            "fly",
            "--non-interactive",
            "--output",
            &path("hosted"),
        ],
        &[],
    ))
    .await?;
    assert!(
        refused.contains("Missing SUPERTAG_DATABASE_URL"),
        "{refused}"
    );
    assert!(!hosted.exists());

    // Check validates the same files without connecting.
    let check = |platform: &str, directory: &Path| {
        command(
            &home,
            &[
                "check",
                "deployment",
                platform,
                "--directory",
                directory.to_str().expect("utf-8 path"),
            ],
            &[],
        )
    };
    assert!(
        succeed(check("compose", &output))
            .await?
            .contains("is valid")
    );
    let refused = fail(check("fly", &output)).await?;
    assert!(
        refused.contains("set by the hosted entrypoint"),
        "{refused}"
    );
    let tampered = root.join("tampered");
    std::fs::create_dir(&tampered)?;
    std::fs::set_permissions(&tampered, std::fs::Permissions::from_mode(0o700))?;
    for name in ["control-plane.env", "gateway.env", "operator.env"] {
        std::fs::copy(output.join(name), tampered.join(name))?;
    }
    let mut text = std::fs::read_to_string(tampered.join("gateway.env"))?;
    text.push_str("UNKNOWN_KEY='secret'\n");
    std::fs::write(tampered.join("gateway.env"), text)?;
    let refused = fail(check("compose", &tampered)).await?;
    assert!(
        refused.contains("unknown deployment environment key UNKNOWN_KEY"),
        "{refused}"
    );
    assert!(!refused.contains("secret'"), "{refused}");
    std::fs::set_permissions(
        tampered.join("operator.env"),
        std::fs::Permissions::from_mode(0o644),
    )?;
    let refused = fail(check("compose", &tampered)).await?;
    assert!(
        refused.contains("must be a private regular file"),
        "{refused}"
    );

    // Start each role from its file. Only container paths and the SQLite case's database
    // differ from what setup wrote.
    fn tls(cert: &Leaf, key_names: [&'static str; 2]) -> [(&'static str, String); 2] {
        [
            (key_names[0], cert.cert.to_string_lossy().into_owned()),
            (key_names[1], cert.key.to_string_lossy().into_owned()),
        ]
    }
    let mut control = command(&home, &["control-plane", "--listen", "127.0.0.1:0"], &[]);
    control.envs(&control_env);
    control
        .env("SUPERTAG_DATABASE_URL", &database)
        .envs(tls(
            &control_leaf,
            ["SUPERTAG_TLS_CERT_FILE", "SUPERTAG_TLS_KEY_FILE"],
        ))
        .envs(tls(
            &client_leaf,
            ["SUPERTAG_CLIENT_CERT_FILE", "SUPERTAG_CLIENT_KEY_FILE"],
        ))
        .env("SUPERTAG_TLS_CLIENT_CA_FILE", private.ca())
        .env("SUPERTAG_SERVER_CA_FILE", private.ca());
    let (_control, control_address) = service(control, &root.join("control-plane.log")).await?;
    let private_url = format!("https://{control_address}");

    // The Control Plane's health probe identity works; a client without one is refused.
    let health = |identity: bool| {
        let mut health = command(&home, &["health", "--endpoint", &private_url], &[]);
        health.env("SUPERTAG_SERVER_CA_FILE", private.ca());
        if identity {
            health.envs(tls(
                &client_leaf,
                ["SUPERTAG_CLIENT_CERT_FILE", "SUPERTAG_CLIENT_KEY_FILE"],
            ));
        }
        health
    };
    succeed(health(true)).await?;
    fail(health(false)).await?;

    let state = root.join("gateway-state");
    std::fs::create_dir(&state)?;
    std::fs::set_permissions(&state, std::fs::Permissions::from_mode(0o700))?;
    let mut gateway = command(
        &home,
        &[
            "gateway",
            "--listen",
            "127.0.0.1:0",
            "--control-plane",
            &private_url,
            "--checkpoint-directory",
            &path("gateway-state/checkpoints"),
        ],
        &[],
    );
    gateway.envs(&gateway_env);
    gateway
        .env("SUPERTAG_STATE_DIR", &state)
        .envs(tls(
            &gateway_leaf,
            ["SUPERTAG_TLS_CERT_FILE", "SUPERTAG_TLS_KEY_FILE"],
        ))
        .envs(tls(
            &client_leaf,
            ["SUPERTAG_CLIENT_CERT_FILE", "SUPERTAG_CLIENT_KEY_FILE"],
        ))
        .env("SUPERTAG_SERVER_CA_FILE", private.ca());
    let (_gateway, gateway_address) = service(gateway, &root.join("gateway.log")).await?;
    let public_url = format!("https://{gateway_address}");
    let public_ca = public.ca().to_string_lossy().into_owned();

    // Verify the deployment through its public URL only.
    let verify = |url: &str, env: &[(&str, &str)], extra: &[&str]| {
        let mut args = vec!["verify", "deployment", url];
        args.extend_from_slice(extra);
        command(&home, &args, env)
    };
    let operator_file = output.join("operator.env");
    let operator_file = operator_file.to_str().expect("utf-8 path");
    let trusted = [("SUPERTAG_SERVER_CA_FILE", public_ca.as_str())];
    let refused = fail(verify(
        &public_url.replacen("https://", "http://", 1),
        &trusted,
        &["--env-file", operator_file],
    ))
    .await?;
    assert!(refused.contains("must be an HTTPS origin"), "{refused}");
    let refused = fail(verify(&format!("{public_url}/path"), &trusted, &[])).await?;
    assert!(refused.contains("must be an HTTPS origin"), "{refused}");
    let refused = fail(verify(&public_url, &trusted, &[])).await?;
    assert!(
        refused.contains("SUPERTAG_OPERATOR_TOKEN is required"),
        "{refused}"
    );
    // The private CA does not vouch for the public endpoint.
    let wrong_ca = private.ca().to_string_lossy().into_owned();
    fail(verify(
        &public_url,
        &[("SUPERTAG_SERVER_CA_FILE", wrong_ca.as_str())],
        &["--env-file", operator_file],
    ))
    .await?;
    let invalid = "e".repeat(64);
    let refused = fail(verify(
        &public_url,
        &[
            ("SUPERTAG_SERVER_CA_FILE", public_ca.as_str()),
            ("SUPERTAG_OPERATOR_TOKEN", invalid.as_str()),
        ],
        &[],
    ))
    .await?;
    assert!(
        refused
            .contains("operator authentication or Control Plane access failed (Unauthenticated)"),
        "{refused}"
    );
    let report = succeed(verify(
        &public_url,
        &trusted,
        &["--env-file", operator_file],
    ))
    .await?;
    assert!(
        report.contains("operator authentication through the Control Plane passed")
            && report.contains("Readiness: not ready"),
        "{report}"
    );
    let refused = fail(verify(
        &public_url,
        &trusted,
        &["--env-file", operator_file, "--require-ready"],
    ))
    .await?;
    assert!(refused.contains("no Worker Host is ready"), "{refused}");
    let refused = fail(verify(
        &public_url,
        &trusted,
        &["--env-file", &output.join("gateway.env").to_string_lossy()],
    ))
    .await?;
    assert!(
        refused.contains("Unknown key in the verification env file"),
        "{refused}"
    );

    // A two-manager organization through the public Gateway, with outbound Worker Hosts.
    let operator_env = [
        ("SUPERTAG_SERVER_CA_FILE", public_ca.as_str()),
        ("SUPERTAG_OPERATOR_TOKEN", operator_token.as_str()),
    ];
    let operator = |args: &[&str]| {
        let mut args = args.to_vec();
        args.extend_from_slice(&["--gateway", &public_url]);
        command(&home, &args, &operator_env)
    };
    let manifest = root.join("organization.yaml");
    std::fs::write(&manifest, ORGANIZATION)?;
    let applied = succeed(operator(&["apply", "-f", manifest.to_str().unwrap()])).await?;
    assert!(applied.contains("Team/csv"), "{applied}");
    let mut hosts = Vec::new();
    for (host, tag) in [
        ("review-host", "review-manager"),
        ("builder-host", "builder-manager"),
    ] {
        let issued: Value = serde_json::from_str(
            &succeed(operator(&[
                "create-auth-key",
                host,
                "--label",
                host,
                "--tag",
                tag,
            ]))
            .await?,
        )?;
        let key = root.join(format!("{host}.key"));
        std::fs::write(&key, issued["auth_key"].as_str().context("Auth Key")?)?;
        std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o600))?;
        let state = path(host);
        let mut enroll = command(
            &home,
            &[
                "enroll-host",
                host,
                "--gateway",
                &public_url,
                "--state-directory",
                &state,
                "--auth-key",
                &format!("file:{}", key.display()),
            ],
            &[("SUPERTAG_SERVER_CA_FILE", public_ca.as_str())],
        );
        enroll.current_dir(root);
        let enrolled: Value = serde_json::from_str(&succeed(enroll).await?)?;
        assert_eq!(enrolled["host_id"], host);
        hosts.push((host, state));
    }
    let start_host = |host: &str, state: &str| -> Result<Child> {
        let mut command = command(
            &home,
            &[
                "worker-host",
                "--gateway",
                &public_url,
                "--state-directory",
                state,
                "--adapter",
                ADAPTER,
            ],
            &[("SUPERTAG_SERVER_CA_FILE", public_ca.as_str())],
        );
        command
            .stdout(Stdio::null())
            .stderr(std::fs::File::create(root.join(format!("{host}.log")))?);
        Ok(command.spawn()?)
    };
    let task_state = |task: &str| {
        let task = task.to_owned();
        async move {
            let task: Value =
                serde_json::from_str(&succeed(operator(&["get-task", &task])).await?)?;
            Ok::<_, anyhow::Error>(task)
        }
    };
    let submit = |tag: &str, prompt: &str| {
        let args = ["submit", "--tag", tag, "--session", "deployment", prompt];
        let command = operator(&args);
        async move {
            let task: Value = serde_json::from_str(&succeed(command).await?)?;
            Ok::<_, anyhow::Error>(task["task_id"].as_str().context("task_id")?.to_owned())
        }
    };

    // Only the review host is connected: the builder's Task waits for its labeled host.
    let mut review = start_host(hosts[0].0, &hosts[0].1)?;
    let builder_task = submit("builder-manager", "Write the parser").await?;
    let review_task = submit("review-manager", "Review the parser").await?;
    let deadline = Instant::now() + WAIT;
    loop {
        let task = task_state(&review_task).await?;
        if task["state"] == "TASK_STATE_SUCCEEDED" {
            assert!(
                task["result"]
                    .as_str()
                    .unwrap_or_default()
                    .contains("Review the parser")
            );
            break;
        }
        ensure!(
            Instant::now() < deadline,
            "review Task did not finish: {task}"
        );
        sleep(Duration::from_millis(200)).await;
    }
    assert_ne!(
        task_state(&builder_task).await?["state"],
        "TASK_STATE_SUCCEEDED"
    );
    let mut builder = start_host(hosts[1].0, &hosts[1].1)?;
    let deadline = Instant::now() + WAIT;
    loop {
        let task = task_state(&builder_task).await?;
        if task["state"] == "TASK_STATE_SUCCEEDED" {
            assert!(
                task["result"]
                    .as_str()
                    .unwrap_or_default()
                    .contains("Write the parser")
            );
            break;
        }
        ensure!(
            Instant::now() < deadline,
            "builder Task did not finish: {task}"
        );
        sleep(Duration::from_millis(200)).await;
    }

    // With both hosts reporting, verification passes readiness.
    let deadline = Instant::now() + WAIT;
    loop {
        let (success, stdout, stderr) = run(verify(
            &public_url,
            &trusted,
            &["--env-file", operator_file, "--require-ready"],
        ))
        .await?;
        if success && stdout.contains("Readiness: ready (2 Worker Hosts)") {
            break;
        }
        ensure!(
            Instant::now() < deadline,
            "readiness never passed: {stdout}{stderr}"
        );
        sleep(Duration::from_millis(300)).await;
    }
    for child in [&mut review, &mut builder] {
        child.start_kill()?;
        child.wait().await?;
    }
    Ok(())
}

database_tests! {
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    deploys_and_verifies_split_roles;
}
