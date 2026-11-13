//! `supertag setup deployment`, `check deployment`, and `verify deployment` against the real
//! service processes, configured from the files setup writes: a public TLS Control Plane, a
//! Gateway that reaches it as a client, and two outbound Worker Hosts placed by label for a
//! two-manager organization applied through the Control Plane; and the Render, Cloudflare, and
//! Modal file sets with the Control Plane behind a platform-style edge that terminates TLS and
//! forwards only to the WebSocket tunnel listener.
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
    sync::Arc,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, ensure};
use serde_json::Value;
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
    process::{Child, Command},
    task::JoinHandle,
    time::{sleep, timeout},
};
use tokio_rustls::{
    TlsAcceptor, TlsConnector,
    rustls::{
        ClientConfig, RootCertStore, ServerConfig,
        pki_types::{CertificateDer, PrivateKeyDer, ServerName, pem::PemObject},
    },
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

/// The env file format setup writes: KEY=VALUE, optionally single-quoted.
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

    // The Control Plane's certificate comes from its own authority; another one does not vouch
    // for it.
    let public = Pki::authority(root, "public-ca").await?;
    let other = Pki::authority(root, "other-ca").await?;
    let control_leaf = public.leaf("control-plane", "serverAuth").await?;

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
    // A value Compose would change on the way to the container is refused before anything is
    // written, without echoing it.
    let refused = fail(setup(&[(
        "SUPERTAG_DATABASE_URL",
        "postgresql://supertag:quote'$HOME@db/supertag",
    )]))
    .await?;
    assert!(
        refused.contains("SUPERTAG_DATABASE_URL cannot be represented"),
        "{refused}"
    );
    assert!(!refused.contains("quote'"), "{refused}");
    assert!(!output.exists());
    let message = succeed(setup(&[])).await?;
    assert!(
        message.contains("Saved compose deployment configuration"),
        "{message}"
    );
    assert!(message.contains("https://control-plane:3434"), "{message}");
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
        &gateway_env["SUPERTAG_GATEWAY_CREDENTIAL"],
        &setup_database,
    ] {
        assert!(!message.contains(secret.as_str()), "setup printed a secret");
    }
    assert_eq!(control_env["SUPERTAG_DATABASE_URL"], setup_database);
    assert!(!gateway_env.contains_key("SUPERTAG_DATABASE_URL"));
    assert_eq!(
        control_env["SUPERTAG_OPERATOR_PRINCIPAL"],
        "operator:deploy"
    );
    assert_eq!(
        control_env["SUPERTAG_BOOTSTRAP_GATEWAY_CREDENTIAL"],
        gateway_env["SUPERTAG_GATEWAY_CREDENTIAL"]
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
    let state = root.join("control-state");
    std::fs::create_dir(&state)?;
    std::fs::set_permissions(&state, std::fs::Permissions::from_mode(0o700))?;
    let mut control = command(
        &home,
        &[
            "control-plane",
            "--listen",
            "127.0.0.1:0",
            "--transfer-directory",
            &path("control-state/transfers"),
        ],
        &[],
    );
    control.envs(&control_env);
    control
        .env("SUPERTAG_DATABASE_URL", &database)
        .env("SUPERTAG_STATE_DIR", &state)
        .envs(tls(
            &control_leaf,
            ["SUPERTAG_TLS_CERT_FILE", "SUPERTAG_TLS_KEY_FILE"],
        ))
        .env("SUPERTAG_SERVER_CA_FILE", public.ca());
    let (_control, control_address) = service(control, &root.join("control-plane.log")).await?;
    let public_url = format!("https://{control_address}");
    let public_ca = public.ca().to_string_lossy().into_owned();

    // The Control Plane's health probe trusts its server CA.
    let mut health = command(&home, &["health", "--endpoint", &public_url], &[]);
    health.env("SUPERTAG_SERVER_CA_FILE", public.ca());
    succeed(health).await?;

    // The Gateway connects to the public Control Plane as an ordinary client, gateway:local, and
    // holds no operator credential. Identity is in the bearer, so it needs no client
    // certificate. Its test notification asks the Control Plane whose token the operator
    // presented, and a token that resolves to no operator is refused.
    assert!(!gateway_env.contains_key("SUPERTAG_OPERATOR_TOKEN"));
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
            &public_url,
        ],
        &[],
    );
    gateway.envs(&gateway_env);
    gateway
        .env("SUPERTAG_STATE_DIR", &state)
        .env("SUPERTAG_SERVER_CA_FILE", public.ca());
    let (_gateway, gateway_address) = service(gateway, &root.join("gateway.log")).await?;
    let notify = |token: &str| {
        command(
            &home,
            &[
                "test",
                "notification",
                "--gateway",
                &format!("http://{gateway_address}"),
            ],
            &[("SUPERTAG_OPERATOR_TOKEN", token)],
        )
    };
    let sent = succeed(notify(&operator_token)).await?;
    assert!(sent.contains("not configured"), "{sent}");
    let refused = fail(notify(&"x".repeat(43))).await?;
    assert!(
        refused.contains("valid bearer credential required"),
        "{refused}"
    );

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
    assert!(
        refused.contains("must be an https:// or wss:// origin"),
        "{refused}"
    );
    let refused = fail(verify(&format!("{public_url}/path"), &trusted, &[])).await?;
    assert!(
        refused.contains("must be an https:// or wss:// origin"),
        "{refused}"
    );
    let refused = fail(verify(&public_url, &trusted, &[])).await?;
    assert!(
        refused.contains("SUPERTAG_OPERATOR_TOKEN is required"),
        "{refused}"
    );
    // Another CA does not vouch for the public endpoint.
    let wrong_ca = other.ca().to_string_lossy().into_owned();
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
        refused.contains("Control Plane operator authentication failed (Unauthenticated)"),
        "{refused}"
    );
    let report = succeed(verify(
        &public_url,
        &trusted,
        &["--env-file", operator_file],
    ))
    .await?;
    assert!(
        report.contains("operator authentication passed")
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

    // A two-manager organization through the public Control Plane, with outbound Worker Hosts.
    let operator_env = [
        ("SUPERTAG_SERVER_CA_FILE", public_ca.as_str()),
        ("SUPERTAG_OPERATOR_TOKEN", operator_token.as_str()),
    ];
    let operator = |args: &[&str]| {
        let mut args = args.to_vec();
        args.extend_from_slice(&["--control-plane", &public_url]);
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
                "auth-key", "create", host, "--role", "host", "--label", host, "--tag", tag,
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
                "host",
                "enroll",
                host,
                "--control-plane",
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
                "--control-plane",
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
                serde_json::from_str(&succeed(operator(&["get", "task", &task])).await?)?;
            Ok::<_, anyhow::Error>(task)
        }
    };
    let submit = |tag: &str, prompt: &str| {
        let args = [
            "task",
            "submit",
            "--tag",
            tag,
            "--session",
            "deployment",
            prompt,
        ];
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
    // Once the review host is idle, the builder's Task, submitted first, is still unclaimed:
    // no Attempt exists, so the host without the builder label never ran it.
    let grouped = |group: &str, args: &[&str]| {
        let mut all = vec![group, "--control-plane", public_url.as_str()];
        all.extend_from_slice(args);
        command(&home, &all, &operator_env)
    };
    let deadline = Instant::now() + WAIT;
    loop {
        let host: Value =
            serde_json::from_str(&succeed(grouped("get", &["host", "review-host"])).await?)?;
        if host["active_attempts"] == 0 && host["phase"] == "ready" {
            break;
        }
        ensure!(
            Instant::now() < deadline,
            "review host did not become idle: {host}"
        );
        sleep(Duration::from_millis(200)).await;
    }
    let waiting = task_state(&builder_task).await?;
    assert_eq!(waiting["state"], "TASK_STATE_QUEUED", "{waiting}");
    assert!(waiting["attempt_id"].is_null(), "{waiting}");
    // Only the builder host, still offline, may take it.
    let explained: Value =
        serde_json::from_str(&succeed(grouped("placement", &["explain", &builder_task])).await?)?;
    assert_eq!(
        explained["required_labels"],
        serde_json::json!(["builder-host"])
    );
    let eligible = explained["hosts"]
        .as_array()
        .context("placement hosts")?
        .iter()
        .filter(|host| host["eligible"] == true)
        .map(|host| host["host_id"].clone())
        .collect::<Vec<_>>();
    assert_eq!(eligible, ["builder-host"], "{explained}");
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
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    deploys_and_verifies_behind_an_http_only_edge;
}

/// What Render, Cloudflare, and Modal put in front of a service: their edge terminates TLS with
/// the platform's certificate and passes the decrypted HTTP/1.1 bytes to one container port,
/// here the Control Plane's tunnel listener. It forwards nothing else.
struct Edge {
    address: SocketAddr,
    task: JoinHandle<()>,
}

impl Edge {
    async fn start(backend: SocketAddr, leaf: &Leaf) -> Result<Self> {
        let config = ServerConfig::builder_with_provider(Arc::new(
            tokio_rustls::rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()?
        .with_no_client_auth()
        .with_single_cert(
            CertificateDer::pem_file_iter(&leaf.cert)?.collect::<Result<_, _>>()?,
            PrivateKeyDer::from_pem_file(&leaf.key)?,
        )?;
        let acceptor = TlsAcceptor::from(Arc::new(config));
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        let task = tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let acceptor = acceptor.clone();
                tokio::spawn(async move {
                    let Ok(mut downstream) = acceptor.accept(stream).await else {
                        return;
                    };
                    if let Ok(mut upstream) = TcpStream::connect(backend).await {
                        let _ = tokio::io::copy_bidirectional(&mut downstream, &mut upstream).await;
                    }
                });
            }
        });
        Ok(Self { address, task })
    }
}

impl Drop for Edge {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// A plain HTTPS `GET` through the edge, as a platform health check or a browser makes it.
async fn https_get(edge: SocketAddr, ca: &Path, path: &str, headers: &str) -> Result<String> {
    let mut roots = RootCertStore::empty();
    for certificate in CertificateDer::pem_file_iter(ca)? {
        roots.add(certificate?)?;
    }
    let config = ClientConfig::builder_with_provider(Arc::new(
        tokio_rustls::rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()?
    .with_root_certificates(roots)
    .with_no_client_auth();
    let stream = TcpStream::connect(edge).await?;
    let mut stream = TlsConnector::from(Arc::new(config))
        .connect(ServerName::try_from("localhost")?, stream)
        .await?;
    stream
        .write_all(format!("GET {path} HTTP/1.1\r\nHost: localhost\r\n{headers}\r\n").as_bytes())
        .await?;
    let mut response = Vec::new();
    // The listener closes the connection after its answer or its refusal.
    let _ = timeout(WAIT, stream.read_to_end(&mut response)).await?;
    Ok(String::from_utf8_lossy(&response).into_owned())
}

async fn deploys_and_verifies_behind_an_http_only_edge(database: String) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let root = directory.path();
    let home = root.join("home");
    std::fs::create_dir(&home)?;
    let pki = Pki::authority(root, "deployment-ca").await?;
    let control_leaf = pki.leaf("control-plane", "serverAuth").await?;
    // The platform edge's own certificate; clients trust it through the same CA here, as they
    // would trust a platform's public certificate through the system roots.
    let edge_leaf = pki.leaf("edge", "serverAuth").await?;
    let ca = pki.ca().to_string_lossy().into_owned();
    let setup_database = if database.starts_with("postgres") {
        database.clone()
    } else {
        "postgresql://supertag@127.0.0.1:1/unused".to_owned()
    };
    let setup = |platform: &str, output: &Path, env: &[(&str, &str)]| {
        command(
            &home,
            &[
                "setup",
                "deployment",
                platform,
                "--non-interactive",
                "--output",
                output.to_str().expect("utf-8 path"),
            ],
            env,
        )
    };
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

    // Render: the Blueprint's database supplies the URL, so setup refuses one and writes none.
    let render = root.join("render");
    let refused = fail(setup(
        "render",
        &render,
        &[("SUPERTAG_DATABASE_URL", setup_database.as_str())],
    ))
    .await?;
    assert!(
        refused.contains("Render's Blueprint sets SUPERTAG_DATABASE_URL"),
        "{refused}"
    );
    assert!(!refused.contains(&setup_database) && !render.exists());
    let message = succeed(setup("render", &render, &[])).await?;
    for expected in [
        "inside the WebSocket tunnel on container port 8080",
        "/healthz",
        "SUPERTAG_SERVER_CA_FILE",
        "wss://supertag-control-plane.onrender.com",
        "docs/guides/deploy-render.md",
        "dockerCommand",
    ] {
        assert!(message.contains(expected), "{expected}: {message}");
    }
    assert!(!env_file(&render.join("control-plane.env"))?.contains_key("SUPERTAG_DATABASE_URL"));
    succeed(check("render", &render)).await?;
    let refused = fail(check("fly", &render)).await?;
    assert!(
        refused.contains("Missing SUPERTAG_DATABASE_URL"),
        "{refused}"
    );

    // Cloudflare and Modal keep connector credentials in Vault: setup asks for it, and a file
    // set with the file vault is refused for them.
    let cloudflare = root.join("cloudflare");
    let database_env = [("SUPERTAG_DATABASE_URL", setup_database.as_str())];
    let refused = fail(setup("cloudflare", &cloudflare, &database_env)).await?;
    assert!(refused.contains("Missing VAULT_ADDR"), "{refused}");
    assert!(!cloudflare.exists());
    let message = succeed(setup(
        "cloudflare",
        &cloudflare,
        &[
            ("SUPERTAG_DATABASE_URL", setup_database.as_str()),
            ("VAULT_ADDR", "https://vault.example.com"),
            ("VAULT_TOKEN", "private-vault-token"),
        ],
    ))
    .await?;
    assert!(message.contains("https://127.0.0.1:3434"), "{message}");
    assert!(!message.contains("private-vault-token"), "{message}");
    succeed(check("cloudflare", &cloudflare)).await?;
    succeed(check("modal", &cloudflare)).await?;
    let fly = root.join("fly");
    succeed(setup("fly", &fly, &database_env)).await?;
    for platform in ["cloudflare", "modal"] {
        let refused = fail(check(platform, &fly)).await?;
        assert!(
            refused.contains("has no disk the file credential vault can rely on"),
            "{refused}"
        );
    }

    // The Control Plane from Cloudflare's file: native gRPC on loopback, and the tunnel
    // listener, which is all the edge reaches.
    let state = root.join("control-state");
    std::fs::create_dir(&state)?;
    std::fs::set_permissions(&state, std::fs::Permissions::from_mode(0o700))?;
    let mut control = command(
        &home,
        &[
            "control-plane",
            "--listen",
            "127.0.0.1:0",
            "--websocket-listen",
            "127.0.0.1:0",
            "--transfer-directory",
            state.join("transfers").to_str().expect("utf-8 path"),
        ],
        &[],
    );
    control
        .envs(&env_file(&cloudflare.join("control-plane.env"))?)
        .env("SUPERTAG_DATABASE_URL", &database)
        .env("SUPERTAG_STATE_DIR", &state)
        .env("SUPERTAG_TLS_CERT_FILE", &control_leaf.cert)
        .env("SUPERTAG_TLS_KEY_FILE", &control_leaf.key)
        .stdout(Stdio::piped())
        .stderr(std::fs::File::create(root.join("control-plane.log"))?);
    let mut control = control.spawn()?;
    let mut lines = BufReader::new(control.stdout.take().context("stdout")?).lines();
    let mut address = async || -> Result<SocketAddr> {
        let line = timeout(WAIT, lines.next_line())
            .await
            .with_context(|| {
                std::fs::read_to_string(root.join("control-plane.log")).unwrap_or_default()
            })??
            .context("the Control Plane exited")?;
        Ok(line.trim().parse()?)
    };
    let native = address().await?;
    let tunnel = address().await?;
    let edge = Edge::start(tunnel, &edge_leaf).await?;
    let public = format!("wss://localhost:{}", edge.address.port());

    // The platform health check: plain HTTP through the edge, without weakening the browser
    // rule.
    let healthy = https_get(edge.address, &pki.ca(), "/healthz", "").await?;
    assert!(healthy.starts_with("HTTP/1.1 200 OK"), "{healthy}");
    let browser = https_get(
        edge.address,
        &pki.ca(),
        "/healthz",
        "Origin: https://evil.example\r\n",
    )
    .await?;
    assert!(!browser.contains(" 200 "), "{browser}");

    let operator_file = cloudflare.join("operator.env");
    let operator_file = operator_file.to_str().expect("utf-8 path");
    let verify = |url: &str, env: &[(&str, &str)]| {
        command(
            &home,
            &["verify", "deployment", url, "--env-file", operator_file],
            env,
        )
    };
    let trusted = [("SUPERTAG_SERVER_CA_FILE", ca.as_str())];
    let report = succeed(verify(&public, &trusted)).await?;
    assert!(
        report.contains("operator authentication passed")
            && report.contains("Readiness: not ready"),
        "{report}"
    );
    // Native gRPC does not cross an edge that forwards only to the tunnel listener.
    fail(verify(
        &format!("https://localhost:{}", edge.address.port()),
        &trusted,
    ))
    .await?;
    // The platform hostname needs the deployment's own CA.
    let refused = fail(verify(&public, &[])).await?;
    assert!(refused.contains("SUPERTAG_SERVER_CA_FILE"), "{refused}");
    // The same Control Plane still answers native gRPC on its loopback listener.
    succeed(verify(
        &format!("https://localhost:{}", native.port()),
        &trusted,
    ))
    .await?;
    // A tunnel URL with a path is not an origin.
    let refused = fail(verify(&format!("{public}/tunnel"), &trusted)).await?;
    assert!(
        refused.contains("must be an https:// or wss:// origin"),
        "{refused}"
    );
    control.start_kill()?;
    Ok(())
}
