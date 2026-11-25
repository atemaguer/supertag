//! `supertag deploy` end to end, without a Modal account: a stand-in `modal` program on `PATH`
//! (`fixtures/fake_modal.sh`) keeps the secrets as files and records every invocation, and this
//! test plays the platform. For each rollout it starts the real Control Plane with exactly the
//! secrets and settings the rollout names, behind an edge that terminates TLS and forwards only
//! to the tunnel listener, as Modal's web endpoint does.
//!
//! So the secrets deploy generated, the certificate it issued, and the settings it derived are
//! the ones a real service starts with, and deploy's health wait and verification run against
//! that service.
#[path = "support/children.rs"]
mod children;
use children::reaped;
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
    sync::{Arc, Mutex},
    time::Duration,
};

use anyhow::{Context, Result, ensure};
use serde_json::Value;
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, Lines},
    net::{TcpListener, TcpStream},
    process::{Child, ChildStdout, Command},
    task::JoinHandle,
    time::{sleep, timeout},
};
use tokio_rustls::{
    TlsAcceptor,
    rustls::{
        ServerConfig,
        pki_types::{CertificateDer, PrivateKeyDer, pem::PemObject},
    },
};

const BINARY: &str = env!("CARGO_BIN_EXE_supertag");
const FAKE_MODAL: &str = include_str!("fixtures/fake_modal.sh");
/// The app definition the CLI must deploy: the one in the repository.
const APP: &str = include_str!("../../../../deploy/modal/app.py");
const WAIT: Duration = Duration::from_secs(120);
const IMAGE: &str = "registry.example.com/supertag-hosted@sha256:0000000000000000000000000000000000000000000000000000000000000000";

type Variables = BTreeMap<String, String>;

/// A platform edge: terminates TLS with the certificate the deployment was given and passes
/// the bytes to the tunnel listener of whichever Control Plane the last rollout started.
struct Edge {
    address: SocketAddr,
    route: Arc<Mutex<Option<(TlsAcceptor, SocketAddr)>>>,
    task: JoinHandle<()>,
}

impl Edge {
    async fn start() -> Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        let route: Arc<Mutex<Option<(TlsAcceptor, SocketAddr)>>> = Arc::default();
        let routes = route.clone();
        let task = tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let Some((acceptor, backend)) = routes.lock().expect("route").clone() else {
                    continue;
                };
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
        Ok(Self {
            address,
            route,
            task,
        })
    }

    fn serve(&self, certificate: &str, key: &str, backend: SocketAddr) -> Result<()> {
        let config = ServerConfig::builder_with_provider(Arc::new(
            tokio_rustls::rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()?
        .with_no_client_auth()
        .with_single_cert(
            CertificateDer::pem_slice_iter(certificate.as_bytes()).collect::<Result<_, _>>()?,
            PrivateKeyDer::from_pem_slice(key.as_bytes())?,
        )?;
        *self.route.lock().expect("route") = Some((TlsAcceptor::from(Arc::new(config)), backend));
        Ok(())
    }

    /// Keeps the edge's certificate and passes connections to another backend.
    fn forward_to(&self, backend: SocketAddr) {
        if let Some((_, current)) = self.route.lock().expect("route").as_mut() {
            *current = backend;
        }
    }
}

impl Drop for Edge {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// The pretend Modal workspace: the stand-in CLI's directory, and the deployment it "runs".
struct Workspace {
    root: PathBuf,
    fake: PathBuf,
    bin: PathBuf,
    edge: Edge,
    served: usize,
    control: Option<(Child, Lines<BufReader<ChildStdout>>)>,
    /// The host a rollout reports, when clients reach the edge through [`Proxy`] under the
    /// name Modal would give it, rather than as `localhost`.
    host: Option<String>,
    /// Keep the edge's certificate at the next rollout, as a platform edge whose certificate
    /// is its own would: the Control Plane behind it gets the rollout's.
    keep_edge_certificate: bool,
}

/// An HTTP proxy, as `HTTPS_PROXY` names one, that connects every `CONNECT` to the edge: so
/// the deployment answers under its Modal host name without that name resolving.
struct Proxy {
    url: String,
    task: JoinHandle<()>,
}

impl Proxy {
    async fn start(edge: SocketAddr) -> Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let url = format!("http://{}", listener.local_addr()?);
        let task = tokio::spawn(async move {
            while let Ok((mut client, _)) = listener.accept().await {
                tokio::spawn(async move {
                    // The request ends at the first empty line; nothing follows it until the
                    // proxy answers.
                    let mut head = Vec::new();
                    let mut byte = [0u8; 1];
                    while !head.ends_with(b"\r\n\r\n") {
                        match client.read(&mut byte).await {
                            Ok(1) if head.len() < 8192 => head.push(byte[0]),
                            _ => return,
                        }
                    }
                    if !head.starts_with(b"CONNECT ") {
                        return;
                    }
                    let Ok(mut upstream) = TcpStream::connect(edge).await else {
                        return;
                    };
                    if client
                        .write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
                        .await
                        .is_ok()
                    {
                        let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
                    }
                });
            }
        });
        Ok(Self { url, task })
    }
}

impl Drop for Proxy {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Workspace {
    async fn new(root: &Path) -> Result<Self> {
        let fake = root.join("modal");
        let bin = root.join("bin");
        std::fs::create_dir_all(fake.join("secrets"))?;
        std::fs::create_dir(&bin)?;
        std::fs::write(bin.join("modal"), FAKE_MODAL)?;
        std::fs::set_permissions(bin.join("modal"), std::fs::Permissions::from_mode(0o755))?;
        std::fs::write(fake.join("log"), "")?;
        let workspace = Self {
            root: root.to_owned(),
            fake,
            bin,
            edge: Edge::start().await?,
            served: 0,
            control: None,
            host: None,
            keep_edge_certificate: false,
        };
        workspace.sign_in("acme")?;
        Ok(workspace)
    }

    /// What `modal profile list --json` reports.
    fn sign_in(&self, workspace: &str) -> Result<()> {
        std::fs::write(
            self.fake.join("profiles"),
            format!(
                "[\n  {{\"name\": \"personal\", \"workspace\": \"someone\", \"active\": false}},\n  {{\"name\": \"work\", \"workspace\": \"{workspace}\", \"active\": true}}\n]\n"
            ),
        )?;
        Ok(())
    }

    fn url(&self) -> String {
        format!("wss://localhost:{}", self.edge.address.port())
    }

    fn secret(&self, name: &str) -> PathBuf {
        self.fake.join("secrets").join(format!("{name}.json"))
    }

    fn variables(&self, name: &str) -> Result<Variables> {
        let path = self.secret(name);
        serde_json::from_slice(&std::fs::read(&path).with_context(|| format!("{name} exists"))?)
            .with_context(|| format!("{name} is a JSON object of strings"))
    }

    fn secrets(&self) -> Result<Vec<String>> {
        let mut names: Vec<String> = std::fs::read_dir(self.fake.join("secrets"))?
            .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
            .filter_map(|name| name.strip_suffix(".json").map(str::to_owned))
            .collect();
        names.sort();
        Ok(names)
    }

    /// Every secret's bytes, to show that a run changed none.
    fn snapshot(&self) -> Result<Vec<(String, Vec<u8>)>> {
        self.secrets()?
            .into_iter()
            .map(|name| Ok((name.clone(), std::fs::read(self.secret(&name))?)))
            .collect()
    }

    /// The stand-in CLI's invocations since the log was last taken.
    fn take_log(&self) -> Result<Vec<String>> {
        let path = self.fake.join("log");
        let lines = std::fs::read_to_string(&path)?
            .lines()
            .map(str::to_owned)
            .collect();
        std::fs::write(path, "")?;
        Ok(lines)
    }

    /// The `SUPERTAG_MODAL_*` environment of rollout `number`.
    fn rollout(&self, number: usize) -> Result<Variables> {
        Ok(
            std::fs::read_to_string(self.fake.join(format!("deploy-{number}.env")))?
                .lines()
                .filter_map(|line| line.split_once('='))
                .map(|(key, value)| (key.to_owned(), value.to_owned()))
                .collect(),
        )
    }

    /// Plays the platform for one pending rollout, if `modal deploy` asked for one: starts the
    /// Control Plane with the rollout's secrets and settings, points the edge at it, and
    /// tells the stand-in CLI the endpoint's URL.
    async fn serve(&mut self) -> Result<()> {
        let number = self.served + 1;
        if !self.fake.join(format!("requested-{number}")).exists() {
            return Ok(());
        }
        self.served = number;
        let rollout = self.rollout(number)?;
        let mut environment: Variables = serde_json::from_str(&rollout["SUPERTAG_MODAL_SETTINGS"])?;
        for name in rollout["SUPERTAG_MODAL_SECRETS"].split(',') {
            environment.extend(self.variables(name)?);
        }
        // The image entrypoint writes each PEM value to a file.
        let tls = self.root.join(format!("tls-{number}"));
        std::fs::create_dir(&tls)?;
        let certificate = environment
            .remove("SUPERTAG_TLS_CERT_PEM")
            .context("certificate")?;
        let key = environment.remove("SUPERTAG_TLS_KEY_PEM").context("key")?;
        std::fs::write(tls.join("server.pem"), &certificate)?;
        std::fs::write(tls.join("server.key"), &key)?;
        std::fs::set_permissions(
            tls.join("server.key"),
            std::fs::Permissions::from_mode(0o600),
        )?;
        // The services' state directory is the container's; here, a directory of the test's.
        assert_eq!(environment["SUPERTAG_STATE_DIR"], "/var/lib/supertag");
        let state = self.root.join("state");
        if !state.exists() {
            std::fs::create_dir(&state)?;
            std::fs::set_permissions(&state, std::fs::Permissions::from_mode(0o700))?;
        }
        // The Control Plane's view, as the image's pair script gives it.
        environment.retain(|key, _| {
            !key.ends_with("_PEM") && !key.starts_with("SUPERTAG_GATEWAY_CREDENTIAL")
        });
        if let Some((mut previous, _)) = self.control.take() {
            previous.kill().await?;
        }
        let log = self.root.join(format!("control-plane-{number}.log"));
        let mut control = reaped(Command::new(BINARY));
        control
            .args([
                "control-plane",
                "--listen",
                "127.0.0.1:0",
                "--websocket-listen",
                "127.0.0.1:0",
            ])
            .env_clear()
            .env("HOME", self.root.join("service-home"))
            .envs(&environment)
            .env("SUPERTAG_STATE_DIR", &state)
            .env("SUPERTAG_TLS_CERT_FILE", tls.join("server.pem"))
            .env("SUPERTAG_TLS_KEY_FILE", tls.join("server.key"))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(std::fs::File::create(&log)?)
            .kill_on_drop(true);
        let mut control = control.spawn()?;
        let mut lines = BufReader::new(control.stdout.take().context("stdout")?).lines();
        let mut addresses = Vec::new();
        for _ in 0..2 {
            let line = timeout(WAIT, lines.next_line())
                .await
                .with_context(|| std::fs::read_to_string(&log).unwrap_or_default())??
                .with_context(|| {
                    format!(
                        "the Control Plane exited: {}",
                        std::fs::read_to_string(&log).unwrap_or_default()
                    )
                })?;
            addresses.push(line.trim().parse::<SocketAddr>()?);
        }
        self.control = Some((control, lines));
        if self.keep_edge_certificate {
            self.edge.forward_to(addresses[1]);
        } else {
            self.edge.serve(&certificate, &key, addresses[1])?;
        }
        // Written whole: the stand-in CLI reads it as soon as it exists.
        let ready = self.fake.join(format!("ready-{number}"));
        let pending = self.fake.join("pending");
        std::fs::write(
            &pending,
            match &self.host {
                Some(host) => format!("https://{host}"),
                None => format!("https://localhost:{}", self.edge.address.port()),
            },
        )?;
        std::fs::rename(pending, ready)?;
        Ok(())
    }

    fn command(
        &self,
        home: &Path,
        directory: &Path,
        args: &[&str],
        env: &[(&str, &str)],
    ) -> Command {
        let mut command = reaped(Command::new(BINARY));
        // Never inherit an operator's credentials, TLS settings, or Modal sign-in.
        command
            .args(args)
            .current_dir(directory)
            .env_clear()
            .env("HOME", home)
            .env("PATH", format!("{}:/usr/bin:/bin", self.bin.display()))
            .env("FAKE_MODAL", &self.fake)
            .envs(env.iter().copied())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        command
    }

    /// Runs a command to its end while playing the platform for the rollouts it asks for.
    /// Returns (success, stdout, stderr).
    async fn run(
        &mut self,
        mut command: Command,
        input: Option<&str>,
    ) -> Result<(bool, String, String)> {
        if input.is_some() {
            command.stdin(Stdio::piped());
        }
        let mut child = command.spawn()?;
        if let Some(input) = input {
            let mut stdin = child.stdin.take().context("stdin")?;
            stdin.write_all(input.as_bytes()).await?;
        }
        let output = child.wait_with_output();
        tokio::pin!(output);
        let deadline = tokio::time::Instant::now() + WAIT;
        let output = loop {
            tokio::select! {
                output = &mut output => break output?,
                () = sleep(Duration::from_millis(50)) => {
                    ensure!(tokio::time::Instant::now() < deadline, "the command did not exit");
                    self.serve().await?;
                }
            }
        };
        Ok((
            output.status.success(),
            String::from_utf8(output.stdout)?,
            String::from_utf8(output.stderr)?,
        ))
    }

    async fn succeed(&mut self, command: Command) -> Result<(String, String)> {
        let (success, stdout, stderr) = self.run(command, None).await?;
        ensure!(success, "command failed: {stderr}\n{stdout}");
        Ok((stdout, stderr))
    }

    async fn fail(&mut self, command: Command) -> Result<String> {
        let (success, stdout, stderr) = self.run(command, None).await?;
        ensure!(!success, "command unexpectedly succeeded: {stdout}");
        Ok(stderr)
    }
}

fn mode(path: &Path) -> Result<u32> {
    Ok(std::fs::metadata(path)?.permissions().mode() & 0o777)
}

/// The per-user configuration directory the CLI uses under `home`.
fn configuration(home: &Path) -> PathBuf {
    if cfg!(target_os = "macos") {
        home.join("Library/Application Support/supertag")
    } else {
        home.join(".config/supertag")
    }
}

fn count(log: &[String], prefix: &str) -> usize {
    log.iter().filter(|line| line.starts_with(prefix)).count()
}

database_tests! {
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    deploys_from_one_file_and_changes_no_secret_again;
}

async fn deploys_from_one_file_and_changes_no_secret_again(database: String) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let root = directory.path();
    let home = root.join("home");
    let repository = root.join("repository");
    for directory in [&home, &repository, &root.join("service-home")] {
        std::fs::create_dir(directory)?;
    }
    let mut modal = Workspace::new(root).await?;
    let postgres = database.starts_with("postgres");

    // init writes a file that parses, and never replaces one.
    let init = modal.command(&home, &repository, &["deploy", "init", "modal"], &[]);
    let (written, _) = modal.succeed(init).await?;
    assert!(written.contains("supertag-deploy.yaml"), "{written}");
    let scaffold = std::fs::read_to_string(repository.join("supertag-deploy.yaml"))?;
    assert!(scaffold.contains("target: modal"), "{scaffold}");
    let again = modal.command(&home, &repository, &["deploy", "init", "modal"], &[]);
    assert!(modal.fail(again).await?.contains("never replaces"));
    let unknown = modal.command(
        &home,
        &repository,
        &["deploy", "init", "elsewhere", "--config", "other.yaml"],
        &[],
    );
    assert!(
        modal
            .fail(unknown)
            .await?
            .contains("the targets are: modal")
    );

    let config = repository.join("supertag-deploy.yaml");
    let write_config = |extra: &str| {
        std::fs::write(
            &config,
            format!(
                "target: modal\nimage: {IMAGE}\nenv:\n  SUPERTAG_OPERATOR_PRINCIPAL: operator:deployer\nmodal:\n  app: tags\n  workspace: acme\n{extra}"
            ),
        )
    };
    let ca_file = repository.join("supertag-deploy-ca.pem");
    let deploy = |modal: &Workspace, home: &Path, flags: &[&str], env: &[(&str, &str)]| {
        let mut args = vec!["deploy", "--non-interactive"];
        args.extend(flags);
        modal.command(home, &repository, &args, env)
    };

    // A key the file does not have is refused, before the platform is touched.
    std::fs::write(&config, "target: modal\nplatfrom: modal\n")?;
    let refused = modal.fail(deploy(&modal, &home, &[], &[])).await?;
    assert!(refused.contains("platfrom"), "{refused}");
    assert!(modal.take_log()?.is_empty());

    // The CLI must be signed in to the workspace the file names.
    write_config("")?;
    modal.sign_in("another")?;
    let refused = modal.fail(deploy(&modal, &home, &[], &[])).await?;
    assert!(
        refused.contains("signed in to workspace another") && refused.contains("names acme"),
        "{refused}"
    );
    assert_eq!(count(&modal.take_log()?, "secret"), 0);
    modal.sign_in("acme")?;

    // Without the database URL and without a terminal, nothing is created.
    let refused = modal.fail(deploy(&modal, &home, &[], &[])).await?;
    assert!(
        refused.contains("supertag deploy secret set SUPERTAG_DATABASE_URL"),
        "{refused}"
    );
    assert!(modal.secrets()?.is_empty());
    assert!(!ca_file.exists());
    assert_eq!(count(&modal.take_log()?, "deploy"), 0);

    // `deploy check` says the same without deploying: what is missing and how to supply it,
    // and what deploy would generate. One line per problem, and a failing exit.
    let check = |modal: &Workspace, env: &[(&str, &str)]| {
        modal.command(&home, &repository, &["deploy", "check"], env)
    };
    let (passed, checked, problems) = modal.run(check(&modal, &[]), None).await?;
    assert!(!passed);
    for line in [
        "Check for the modal target",
        "target        ready",
        "secret store  Modal secrets in workspace acme",
        "configuration valid",
        "secret        create   SUPERTAG_OPERATOR_TOKEN (generated)",
        "secret        create   SUPERTAG_GATEWAY_CREDENTIAL (generated)",
        "secret        missing  SUPERTAG_DATABASE_URL",
        "secret        create   credentials (none until `supertag deploy secret push`)",
        "certificate   issue    for acme--tags.modal.run, 127.0.0.1; writes its public CA certificate to",
    ] {
        assert!(checked.contains(line), "{line}: {checked}");
    }
    assert!(
        !checked.contains("image") && !checked.contains("rollout"),
        "{checked}"
    );
    let problems: Vec<&str> = problems.lines().collect();
    assert_eq!(problems.len(), 2, "{problems:?}");
    assert!(
        problems[0].starts_with("problem: SUPERTAG_DATABASE_URL is not stored yet")
            && problems[0].contains("supertag deploy secret set SUPERTAG_DATABASE_URL"),
        "{problems:?}"
    );
    assert!(problems[1].contains("1 problem to fix before deploying; nothing was changed"));
    // Every problem is named at once: the workspace, here, stops the check before the rest.
    modal.sign_in("another")?;
    let (passed, checked, problems) = modal.run(check(&modal, &[]), None).await?;
    assert!(
        !passed && checked.contains("target        not ready"),
        "{checked}"
    );
    assert!(
        problems.contains("problem: the Modal CLI is signed in to workspace another"),
        "{problems}"
    );
    modal.sign_in("acme")?;
    // A Modal CLI older than the app definition is written for is a problem too.
    let (passed, _, problems) = modal
        .run(check(&modal, &[("FAKE_MODAL_VERSION", "0.73.4")]), None)
        .await?;
    assert!(
        !passed
            && problems.contains("problem: the Modal CLI is version 0.73.4, but this deploys with"),
        "{problems}"
    );
    assert!(modal.secrets()?.is_empty() && !ca_file.exists());
    let log = modal.take_log()?;
    assert_eq!(
        count(&log, "secret create") + count(&log, "deploy"),
        0,
        "{log:?}"
    );

    // The database URL: given in the environment for the first deploy, or already stored.
    let mut first_environment = Vec::new();
    if postgres {
        first_environment.push(("SUPERTAG_DATABASE_URL", database.as_str()));
        let refused = modal
            .fail(deploy(
                &modal,
                &home,
                &[],
                &[("SUPERTAG_DATABASE_URL", "sqlite:///tmp/x.db")],
            ))
            .await?;
        assert!(refused.contains("must be a PostgreSQL URL"), "{refused}");
        assert!(modal.secrets()?.is_empty());
    } else {
        // SQLite stands in for a database URL stored out of band.
        std::fs::write(
            modal.secret("tags-database-url"),
            serde_json::to_vec(&BTreeMap::from([("SUPERTAG_DATABASE_URL", &database)]))?,
        )?;
    }
    modal.take_log()?;

    // A dry run prints the plan a deploy would follow and creates nothing: the image by
    // digest, the endpoint, each secret and the certificate, and what rolls out.
    let seeded = modal.snapshot()?;
    let (plan, _) = modal
        .succeed(deploy(&modal, &home, &["--dry-run"], &first_environment))
        .await?;
    for line in [
        "Plan for the modal target".to_owned(),
        "secret        create   SUPERTAG_OPERATOR_TOKEN (generated)".to_owned(),
        if postgres {
            "secret        create   SUPERTAG_DATABASE_URL (from the environment)".to_owned()
        } else {
            "secret        keep     SUPERTAG_DATABASE_URL".to_owned()
        },
        "certificate   issue    for acme--tags.modal.run, 127.0.0.1".to_owned(),
        format!("image         {IMAGE}"),
        "endpoint      wss://acme--tags.modal.run".to_owned(),
        "rollout       the Control Plane\n".to_owned(),
        "setting       SUPERTAG_CREDENTIAL_VAULT=env".to_owned(),
        "setting       SUPERTAG_OPERATOR_PRINCIPAL=operator:deployer".to_owned(),
        "Dry run: nothing was created or rolled out.".to_owned(),
    ] {
        assert!(plan.contains(&line), "{line}: {plan}");
    }
    assert!(!plan.contains(database.as_str()), "{plan}");
    assert_eq!(modal.snapshot()?, seeded);
    assert!(!ca_file.exists());
    let log = modal.take_log()?;
    assert_eq!(
        count(&log, "secret create") + count(&log, "deploy"),
        0,
        "{log:?}"
    );

    // The first deploy prints the same plan before it acts.
    let (report, progress) = modal
        .succeed(deploy(&modal, &home, &[], &first_environment))
        .await?;
    assert!(
        progress.contains("Plan for the modal target")
            && progress.contains(&format!("image         {IMAGE}")),
        "{progress}"
    );
    let url = modal.url();
    assert!(
        report.contains(&format!("The Control Plane is at {url}")),
        "{report}"
    );
    assert!(
        report.contains("operator authentication passed")
            && report.contains("Readiness: not ready"),
        "{report}"
    );
    assert_eq!(
        modal.secrets()?,
        [
            "tags-credentials",
            "tags-database-url",
            "tags-gateway-credential",
            "tags-operator-token",
            "tags-tls"
        ]
    );
    let token = modal.variables("tags-operator-token")?["SUPERTAG_OPERATOR_TOKEN"].clone();
    assert!(token.len() >= 32);
    let gateway = modal.variables("tags-gateway-credential")?;
    assert!(gateway["SUPERTAG_GATEWAY_CREDENTIAL"].starts_with("stcr_"));
    assert_eq!(
        gateway["SUPERTAG_GATEWAY_CREDENTIAL"],
        gateway["SUPERTAG_BOOTSTRAP_GATEWAY_CREDENTIAL"]
    );
    let tls = modal.variables("tags-tls")?;
    assert_eq!(
        tls.keys().collect::<Vec<_>>(),
        [
            "SUPERTAG_SERVER_CA_PEM",
            "SUPERTAG_TLS_CERT_PEM",
            "SUPERTAG_TLS_KEY_PEM"
        ]
    );
    // No generated secret is printed, passed as an argument, or written to the repository.
    let log = modal.take_log()?;
    for secret in [
        token.as_str(),
        gateway["SUPERTAG_GATEWAY_CREDENTIAL"].as_str(),
        database.as_str(),
    ] {
        assert!(!report.contains(secret) && !progress.contains(secret));
        assert!(log.iter().all(|line| !line.contains(secret)), "{log:?}");
    }
    let mut files: Vec<_> = std::fs::read_dir(&repository)?
        .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
        .collect();
    files.sort();
    assert_eq!(files, ["supertag-deploy-ca.pem", "supertag-deploy.yaml"]);
    // The public CA certificate: beside the configuration, readable, and nothing but public.
    let ca = std::fs::read_to_string(&ca_file)?;
    assert_eq!(mode(&ca_file)?, 0o644);
    assert!(ca.contains("hosts: localhost 127.0.0.1"), "{ca}");
    assert!(ca.ends_with(&tls["SUPERTAG_SERVER_CA_PEM"]), "{ca}");
    assert_eq!(ca.matches("-----BEGIN").count(), 1);
    assert!(!ca.contains("PRIVATE KEY"));
    // Whoever ran the first deploy keeps the Operator Token outside the repository.
    let private = configuration(&home).join("deployments/tags");
    assert_eq!(mode(&private)?, 0o700);
    assert_eq!(mode(&private.join("operator.env"))?, 0o600);
    assert_eq!(
        std::fs::read_to_string(private.join("operator.env"))?,
        format!("SUPERTAG_OPERATOR_TOKEN={token}\n")
    );
    // The certificate first named the predicted Modal host. The rollout reported another, so
    // deploy issued it again for that host and rolled out once more.
    assert!(
        progress.contains("acme--tags.modal.run, 127.0.0.1"),
        "{progress}"
    );
    assert!(progress.contains("issuing it again"), "{progress}");
    assert_eq!(count(&log, "secret create tags-tls"), 2);
    assert_eq!(
        log.iter()
            .filter(|line| line.starts_with("secret create tags-tls ") && line.ends_with("--force"))
            .count(),
        1
    );
    assert_eq!(count(&log, "deploy"), 2);
    // The first rollout's container would hold the app's one place, so the second stops it.
    assert_eq!(
        log.iter()
            .filter(|line| line.starts_with("container stop "))
            .collect::<Vec<_>>(),
        ["container stop ta-1 --yes"],
        "{log:?}"
    );
    assert!(
        progress.contains("Stopping the previous rollout's container ta-1"),
        "{progress}"
    );
    for secret in [
        "tags-operator-token",
        "tags-gateway-credential",
        "tags-credentials",
    ] {
        assert_eq!(
            count(&log, &format!("secret create {secret} ")),
            1,
            "{log:?}"
        );
        assert!(
            log.iter()
                .all(|line| !(line.contains(secret) && line.contains("--force")))
        );
    }
    assert_eq!(
        count(&log, "secret create tags-database-url "),
        usize::from(postgres)
    );
    // What the rollout was given: the image by digest, the secrets by name, settings that hold
    // no secret, and the repository's own app definition.
    let rollout = modal.rollout(2)?;
    assert_eq!(rollout["SUPERTAG_MODAL_IMAGE"], IMAGE);
    assert_eq!(rollout["SUPERTAG_MODAL_APP"], "tags");
    assert_eq!(rollout["SUPERTAG_MODAL_LABEL"], "tags");
    assert_eq!(rollout["SUPERTAG_MODAL_GATEWAY"], "off");
    assert_eq!(rollout["SUPERTAG_MODAL_GATEWAY_FLAGS"], "");
    assert_eq!(
        rollout["SUPERTAG_MODAL_SECRETS"],
        "tags-credentials,tags-database-url,tags-gateway-credential,tags-operator-token,tags-tls"
    );
    assert!(!rollout.contains_key("SUPERTAG_MODAL_REGISTRY_SECRET"));
    let settings: Variables = serde_json::from_str(&rollout["SUPERTAG_MODAL_SETTINGS"])?;
    assert_eq!(
        settings,
        Variables::from([
            ("SUPERTAG_CREDENTIAL_VAULT".into(), "env".into()),
            (
                "SUPERTAG_OPERATOR_PRINCIPAL".into(),
                "operator:deployer".into()
            ),
            ("SUPERTAG_STATE_DIR".into(), "/var/lib/supertag".into()),
        ])
    );
    assert_eq!(std::fs::read_to_string(modal.fake.join("app-2.py"))?, APP);

    // The deployment is saved for this CLI as `supertag connect` saves one, CA file included.
    assert!(
        report.contains("supertag status --gateway tags"),
        "{report}"
    );
    assert!(
        report.contains(&format!(
            "supertag host enroll HOST --control-plane {url} --state-directory ~/.supertag-HOST --auth-key file:HOST.key"
        )) && report.contains("export SUPERTAG_SERVER_CA_FILE=/")
            && report.contains("/repository/supertag-deploy-ca.pem\n"),
        "{report}"
    );
    // A path with a space, as macOS's configuration directory has, is quoted.
    let credential_file = configuration(&home).join("deployments/tags/credentials.json");
    assert!(
        report.contains(&format!(
            "export SUPERTAG_CREDENTIAL_FILE={}\n",
            if cfg!(target_os = "macos") {
                format!("'{}'", credential_file.display())
            } else {
                credential_file.display().to_string()
            }
        )),
        "{report}"
    );
    let hosts = modal.command(
        &home,
        &repository,
        &["get", "hosts", "--gateway", "tags"],
        &[],
    );
    modal.succeed(hosts).await?;
    let key = modal.command(
        &home,
        &repository,
        &[
            "auth-key",
            "create",
            "build-1",
            "--role",
            "host",
            "--all-tags",
            "--gateway",
            "tags",
        ],
        &[],
    );
    let (issued, _) = modal.succeed(key).await?;
    let issued: Value = serde_json::from_str(&issued)?;
    // A Worker Host enrolls as the report says: the Auth Key in a private file, and the public
    // CA file, as deploy wrote it, in SUPERTAG_SERVER_CA_FILE.
    let key = root.join("build-1.key");
    std::fs::write(&key, issued["auth_key"].as_str().context("Auth Key")?)?;
    std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o600))?;
    let host_home = root.join("host-home");
    std::fs::create_dir(&host_home)?;
    let enroll = modal.command(
        &host_home,
        root,
        &[
            "host",
            "enroll",
            "build-1",
            "--control-plane",
            &url,
            "--state-directory",
            root.join("host-state").to_str().context("utf-8 path")?,
            "--auth-key",
            &format!("file:{}", key.display()),
        ],
        &[(
            "SUPERTAG_SERVER_CA_FILE",
            ca_file.to_str().context("utf-8 path")?,
        )],
    );
    let (enrolled, _) = modal.succeed(enroll).await?;
    let enrolled: Value = serde_json::from_str(&enrolled)?;
    assert_eq!(enrolled["host_id"], "build-1");

    // Once deployed, the check passes and the plan keeps everything.
    let (checked, _) = modal.succeed(check(&modal, &[])).await?;
    assert!(
        checked.contains("secret        keep     SUPERTAG_OPERATOR_TOKEN")
            && checked.contains("certificate   keep     for localhost, 127.0.0.1; ends in 18")
            && checked.contains("This machine can deploy. Nothing was changed.")
            && !checked.contains("create"),
        "{checked}"
    );

    // Deploying again with nothing changed writes no secret and rolls out once.
    let before = modal.snapshot()?;
    let ca_before = std::fs::read(&ca_file)?;
    let (report, _) = modal.succeed(deploy(&modal, &home, &[], &[])).await?;
    assert!(
        report.contains("operator authentication passed"),
        "{report}"
    );
    assert_eq!(modal.snapshot()?, before);
    assert_eq!(std::fs::read(&ca_file)?, ca_before);
    let log = modal.take_log()?;
    assert_eq!(count(&log, "secret create"), 0, "{log:?}");
    assert_eq!(count(&log, "secret delete"), 0, "{log:?}");
    assert_eq!(count(&log, "deploy"), 1, "{log:?}");

    // CI: a clean machine with the repository and the platform's own credentials. Without an
    // Operator Token only the checks that need none run; with one, all of them.
    let ci = root.join("ci-home");
    std::fs::create_dir(&ci)?;
    let (report, _) = modal.succeed(deploy(&modal, &ci, &[], &[])).await?;
    assert!(
        report.contains("Operator authentication and readiness were not checked"),
        "{report}"
    );
    assert!(
        report.contains(&format!(
            "supertag connect {url} --name tags --server-ca-file"
        )),
        "{report}"
    );
    let (report, _) = modal
        .succeed(deploy(
            &modal,
            &ci,
            &[],
            &[("SUPERTAG_OPERATOR_TOKEN", &token)],
        ))
        .await?;
    assert!(
        report.contains("operator authentication passed"),
        "{report}"
    );
    assert!(!report.contains(&token));
    assert!(!configuration(&ci).join("gateways.json").exists());
    let refused = modal
        .fail(deploy(
            &modal,
            &ci,
            &[],
            &[("SUPERTAG_OPERATOR_TOKEN", &"x".repeat(40))],
        ))
        .await?;
    assert!(
        refused.contains("SUPERTAG_OPERATOR_TOKEN in the environment")
            && refused.contains("operator authentication failed"),
        "{refused}"
    );
    assert_eq!(modal.snapshot()?, before);
    modal.take_log()?;

    // secret set: from standard input into the store, never printed or passed as an argument.
    let webhook = "bearer-value-that-must-stay-private";
    let set = modal.command(
        &home,
        &repository,
        &["deploy", "secret", "set", "SUPERTAG_NOTIFY_SECRET_OPS"],
        &[],
    );
    let (success, stdout, stderr) = modal.run(set, Some(&format!("{webhook}\n"))).await?;
    assert!(success, "{stderr}");
    assert!(stdout.contains("run `supertag deploy`"), "{stdout}");
    assert!(!stdout.contains(webhook) && !stderr.contains(webhook));
    assert_eq!(
        modal.variables("tags-env-supertag-notify-secret-ops")?,
        Variables::from([("SUPERTAG_NOTIFY_SECRET_OPS".into(), webhook.into())])
    );
    assert!(modal.take_log()?.iter().all(|line| !line.contains(webhook)));
    for (name, input, message) in [
        (
            "SUPERTAG_DATABASE_URL",
            "sqlite:///tmp/x.db",
            "must be a PostgreSQL URL",
        ),
        ("SUPERTAG_OPERATOR_TOKEN", "short", "at least 32 characters"),
        (
            "SUPERTAG_GATEWAY_CREDENTIAL",
            "x",
            "secret unset SUPERTAG_GATEWAY_CREDENTIAL",
        ),
        ("SUPERTAG_TLS_KEY_PEM", "x", "--renew-certificate"),
        ("SUPERTAG_GATEWAY_CREDENTIALS", "x", "secret push"),
        ("SUPERTAG_NOTIFY_SECRET_OPS", "", "must not be empty"),
    ] {
        let set = modal.command(&home, &repository, &["deploy", "secret", "set", name], &[]);
        let (success, _, stderr) = modal.run(set, Some(input)).await?;
        assert!(!success && stderr.contains(message), "{name}: {stderr}");
    }
    let list = modal.command(&home, &repository, &["deploy", "secret", "list"], &[]);
    let (listed, _) = modal.succeed(list).await?;
    let listed: Value = serde_json::from_str(&listed)?;
    assert_eq!(listed["store"], "Modal secrets in workspace acme");
    let names: Vec<&str> = listed["secrets"]
        .as_array()
        .context("secrets")?
        .iter()
        .filter_map(|secret| secret["name"].as_str())
        .collect();
    assert_eq!(
        names,
        [
            "SUPERTAG_DATABASE_URL",
            "SUPERTAG_GATEWAY_CREDENTIAL",
            "SUPERTAG_NOTIFY_SECRET_OPS",
            "SUPERTAG_OPERATOR_TOKEN",
            "certificate",
            "credentials"
        ]
    );
    for secret in [webhook, token.as_str()] {
        assert!(!listed.to_string().contains(secret));
    }

    // secret push: credentials stored on this machine reach the store as the two services'
    // documents, by the same rendering as `gateway credential export`.
    let credentials = private.join("credentials.json");
    let push =
        |modal: &Workspace| modal.command(&home, &repository, &["deploy", "secret", "push"], &[]);
    let refused = modal.fail(push(&modal)).await?;
    assert!(
        refused.contains("no credentials are stored at"),
        "{refused}"
    );
    let credentials_text = credentials.to_str().context("utf-8 path")?;
    for (id, value) in [
        (
            "surface/slack/acme",
            r#"{"botToken":"xoxb-private-bot-token"}"#,
        ),
        (
            "workspace-credential/app",
            r#"{"token":"private-git-token"}"#,
        ),
    ] {
        let store = modal.command(
            &home,
            &repository,
            &["gateway", "credential", "store", id],
            &[("SUPERTAG_CREDENTIAL_FILE", credentials_text)],
        );
        let (success, _, stderr) = modal.run(store, Some(value)).await?;
        assert!(success, "{stderr}");
    }
    let empty = modal.variables("tags-credentials")?;
    let (pushed, _) = modal.succeed(push(&modal)).await?;
    let pushed: Value = serde_json::from_str(&pushed)?;
    assert_eq!(
        pushed["credentials"]["gateway"],
        serde_json::json!(["surface/slack/acme"])
    );
    assert_eq!(
        pushed["credentials"]["control-plane"],
        serde_json::json!(["workspace-credential/app"])
    );
    assert!(
        pushed["next"]
            .as_str()
            .is_some_and(|next| next.contains("supertag deploy"))
    );
    assert!(!pushed.to_string().contains("private-"));
    let documents = modal.variables("tags-credentials")?;
    assert_eq!(
        documents.keys().collect::<Vec<_>>(),
        [
            "SUPERTAG_CONTROL_PLANE_CREDENTIALS",
            "SUPERTAG_GATEWAY_CREDENTIALS"
        ]
    );
    assert_ne!(documents, empty);
    assert!(
        modal
            .take_log()?
            .iter()
            .all(|line| !line.contains("private-"))
    );

    // The next deploy gives the services the new secret and the Gateway its connector flags;
    // the Control Plane starts with the pushed credentials.
    write_config("gateway:\n  flags: [--notify, 'webhook:https://hooks.example.com/x#ops']\n")?;
    let (report, _) = modal.succeed(deploy(&modal, &home, &[], &[])).await?;
    assert!(
        report.contains("operator authentication passed"),
        "{report}"
    );
    let rollout = modal.rollout(modal.served)?;
    assert_eq!(rollout["SUPERTAG_MODAL_GATEWAY"], "on");
    assert_eq!(
        rollout["SUPERTAG_MODAL_GATEWAY_FLAGS"],
        "--notify 'webhook:https://hooks.example.com/x#ops'"
    );
    assert!(
        rollout["SUPERTAG_MODAL_SECRETS"].contains("tags-env-supertag-notify-secret-ops"),
        "{rollout:?}"
    );
    let unset = modal.command(
        &home,
        &repository,
        &["deploy", "secret", "unset", "SUPERTAG_NOTIFY_SECRET_OPS"],
        &[],
    );
    let (removed, _) = modal.succeed(unset).await?;
    assert!(removed.contains("run `supertag deploy`"), "{removed}");
    assert!(!modal.secret("tags-env-supertag-notify-secret-ops").exists());
    write_config("")?;

    // The stored certificate needs its public CA file, and an existing file is never replaced
    // without being asked.
    let kept = root.join("kept-ca.pem");
    std::fs::rename(&ca_file, &kept)?;
    let refused = modal.fail(deploy(&modal, &home, &[], &[])).await?;
    assert!(
        refused.contains("is missing") && refused.contains("--renew-certificate"),
        "{refused}"
    );
    let (passed, _, problems) = modal.run(check(&modal, &[]), None).await?;
    assert!(
        !passed
            && problems.contains(
                "problem: the certificate is already stored, but its public CA certificate"
            ),
        "{problems}"
    );
    std::fs::rename(&kept, &ca_file)?;
    let stored_tls = std::fs::read(modal.secret("tags-tls"))?;
    std::fs::remove_file(modal.secret("tags-tls"))?;
    let refused = modal.fail(deploy(&modal, &home, &[], &[])).await?;
    assert!(refused.contains("holds no certificate for it"), "{refused}");
    assert_eq!(std::fs::read(&ca_file)?, ca_before);
    std::fs::write(modal.secret("tags-tls"), stored_tls)?;

    // A deployment whose endpoint the certificate does not name is refused with the remedy.
    std::fs::write(
        &ca_file,
        ca.replace(
            "hosts: localhost 127.0.0.1",
            "hosts: acme--old.modal.run 127.0.0.1",
        ),
    )?;
    let refused = modal.fail(deploy(&modal, &home, &[], &[])).await?;
    assert!(
        refused.contains("the endpoint is localhost") && refused.contains("--renew-certificate"),
        "{refused}"
    );
    std::fs::write(&ca_file, &ca)?;
    modal.take_log()?;

    // Renewing issues a new authority and certificate and changes no other secret.
    let (report, _) = modal
        .succeed(deploy(&modal, &home, &["--renew-certificate"], &[]))
        .await?;
    assert!(
        report.contains("operator authentication passed"),
        "{report}"
    );
    let renewed = std::fs::read_to_string(&ca_file)?;
    assert_ne!(renewed, ca);
    assert_ne!(modal.variables("tags-tls")?, tls);
    for (name, bytes) in &before {
        if name != "tags-tls" && name != "tags-credentials" {
            assert_eq!(&std::fs::read(modal.secret(name))?, bytes, "{name}");
        }
    }
    let log = modal.take_log()?;
    assert!(
        log.iter()
            .filter(|line| line.starts_with("secret create"))
            .all(|line| line.starts_with("secret create tags-tls ") && line.ends_with("--force")),
        "{log:?}"
    );
    // The saved Gateway follows the renewed CA file, which keeps its path.
    let hosts = modal.command(
        &home,
        &repository,
        &["get", "hosts", "--gateway", "tags"],
        &[],
    );
    modal.succeed(hosts).await?;

    // A rollout the platform refuses fails the deploy with the platform's own output.
    std::fs::write(modal.fake.join("fail-deploy"), "")?;
    let refused = modal.fail(deploy(&modal, &home, &[], &[])).await?;
    assert!(
        refused.contains("Secret 'missing' not found") && refused.contains("`modal deploy` failed"),
        "{refused}"
    );
    Ok(())
}

/// A deployment that never answers its health check fails within the wait, with where to look.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unhealthy_deployment_fails_with_where_to_look() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let root = directory.path();
    let home = root.join("home");
    let repository = root.join("repository");
    for directory in [&home, &repository] {
        std::fs::create_dir(directory)?;
    }
    let modal = Workspace::new(root).await?;
    std::fs::write(
        repository.join("supertag-deploy.yaml"),
        format!("target: modal\nimage: {IMAGE}\nmodal:\n  app: tags\n  environment: staging\n"),
    )?;
    // The stand-in reports an endpoint nothing listens on.
    let closed = TcpListener::bind("127.0.0.1:0").await?.local_addr()?.port();
    for number in 1..=2 {
        std::fs::write(
            modal.fake.join(format!("ready-{number}")),
            format!("https://localhost:{closed}"),
        )?;
    }
    let another = "t".repeat(40);
    let mut command = modal.command(
        &home,
        &repository,
        &["deploy", "--non-interactive", "--wait-seconds", "3"],
        &[
            (
                "SUPERTAG_DATABASE_URL",
                "postgresql://supertag@127.0.0.1:1/unused",
            ),
            // An Operator Token in the environment, as a shell that works with another
            // Control Plane has, is only ever used to verify.
            ("SUPERTAG_OPERATOR_TOKEN", &another),
        ],
    );
    let output = timeout(WAIT, command.output()).await??;
    let stderr = String::from_utf8(output.stderr)?;
    assert!(!output.status.success());
    assert!(
        stderr.contains("did not become healthy in time")
            && stderr.contains("modal app logs tags --env staging"),
        "{stderr}"
    );
    // The workspace came from the signed-in profile, and the certificate named both hosts a
    // named environment can give, so the stores and rollouts all named the environment.
    assert!(
        stderr.contains("acme--tags.modal.run, acme-staging--tags.modal.run, 127.0.0.1"),
        "{stderr}"
    );
    let environments = std::fs::read_to_string(modal.fake.join("environments"))?;
    assert!(
        !environments.is_empty() && environments.lines().all(|line| line == "staging"),
        "{environments}"
    );
    assert_eq!(
        modal.secrets()?,
        [
            "tags-credentials",
            "tags-database-url",
            "tags-gateway-credential",
            "tags-operator-token",
            "tags-tls"
        ]
    );
    let generated = modal.variables("tags-operator-token")?["SUPERTAG_OPERATOR_TOKEN"].clone();
    assert!(generated.len() >= 32 && generated != another);
    // The private directory is named for the app and its environment.
    assert!(
        configuration(&home)
            .join("deployments/tags-staging/operator.env")
            .exists()
    );
    Ok(())
}

/// `version:` resolves to the release's official image through the release's assets, checked
/// against its SHA256SUMS; a release without one says how to name an image.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_release_version_resolves_to_its_official_image_by_digest() -> Result<()> {
    use sha2::{Digest, Sha256};
    let directory = tempfile::tempdir()?;
    let root = directory.path();
    let home = root.join("home");
    let repository = root.join("repository");
    for directory in [&home, &repository] {
        std::fs::create_dir(directory)?;
    }
    let modal = Workspace::new(root).await?;
    let reference = format!(
        "ghcr.io/atemaguer/supertag-hosted@sha256:{}\n",
        "ab".repeat(32)
    );
    let digest: String = Sha256::digest(reference.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let sums = format!("{digest}  supertag-hosted-image.txt\n");
    let tampered = format!("{}  supertag-hosted-image.txt\n", "0".repeat(64));
    let asset = |body: String| axum::routing::get(move || async move { body });
    let releases = axum::Router::new()
        .route(
            "/download/v9.9.9/supertag-hosted-image.txt",
            asset(reference.clone()),
        )
        .route("/download/v9.9.9/SHA256SUMS", asset(sums))
        .route(
            "/download/v9.9.8/supertag-hosted-image.txt",
            asset(reference.clone()),
        )
        .route("/download/v9.9.8/SHA256SUMS", asset(tampered));
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let releases_url = format!("http://{}", listener.local_addr()?);
    let server = tokio::spawn(async move { axum::serve(listener, releases).await });
    let closed = TcpListener::bind("127.0.0.1:0").await?.local_addr()?.port();
    for number in 1..=2 {
        std::fs::write(
            modal.fake.join(format!("ready-{number}")),
            format!("https://localhost:{closed}"),
        )?;
    }
    let deploy = |version: &str| -> Result<Command> {
        std::fs::write(
            repository.join("supertag-deploy.yaml"),
            format!("target: modal\nversion: {version}\nmodal: {{app: tags}}\n"),
        )?;
        Ok(modal.command(
            &home,
            &repository,
            &["deploy", "--non-interactive", "--wait-seconds", "1"],
            &[
                ("SUPERTAG_RELEASES_URL", releases_url.as_str()),
                (
                    "SUPERTAG_DATABASE_URL",
                    "postgresql://supertag@127.0.0.1:1/unused",
                ),
            ],
        ))
    };
    let failure = async |mut command: Command| -> Result<String> {
        let output = timeout(WAIT, command.output()).await??;
        ensure!(!output.status.success(), "the deploy succeeded");
        Ok(String::from_utf8(output.stderr)?)
    };
    // A release that publishes no image, and one whose reference its checksums do not list:
    // nothing is created or rolled out.
    let missing = failure(deploy("9.9.7")?).await?;
    assert!(
        missing.contains("release 9.9.7 publishes no hosted image") && missing.contains("image:"),
        "{missing}"
    );
    let mismatch = failure(deploy("9.9.8")?).await?;
    assert!(
        mismatch.contains("does not match the release's SHA256SUMS"),
        "{mismatch}"
    );
    assert!(modal.secrets()?.is_empty());
    assert_eq!(count(&modal.take_log()?, "deploy"), 0);
    // A release that does: the rollout runs its image, by digest.
    let unhealthy = failure(deploy("v9.9.9")?).await?;
    assert!(
        unhealthy.contains("did not become healthy in time"),
        "{unhealthy}"
    );
    assert_eq!(modal.rollout(1)?["SUPERTAG_MODAL_IMAGE"], reference.trim());
    server.abort();
    Ok(())
}

database_tests! {
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    status_asks_the_target_what_it_runs;
}

/// `supertag deploy status` against a deployment that answers under its Modal host name, which
/// clients reach here through an HTTP proxy, as they would from behind one.
async fn status_asks_the_target_what_it_runs(database: String) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let root = directory.path();
    let home = root.join("home");
    let repository = root.join("repository");
    for directory in [&home, &repository, &root.join("service-home")] {
        std::fs::create_dir(directory)?;
    }
    let mut modal = Workspace::new(root).await?;
    modal.host = Some("acme--tags.modal.run".into());
    let proxy = Proxy::start(modal.edge.address).await?;
    let through_proxy = [("HTTPS_PROXY", proxy.url.as_str())];
    std::fs::write(
        repository.join("supertag-deploy.yaml"),
        format!("target: modal\nimage: {IMAGE}\nmodal:\n  app: tags\n  workspace: acme\n"),
    )?;
    std::fs::write(
        modal.secret("tags-database-url"),
        serde_json::to_vec(&BTreeMap::from([("SUPERTAG_DATABASE_URL", &database)]))?,
    )?;
    let ca_file = repository.join("supertag-deploy-ca.pem");
    let status = async |modal: &mut Workspace, home: &Path| -> Result<Value> {
        let command = modal.command(home, &repository, &["deploy", "status"], &through_proxy);
        let (status, _) = modal.succeed(command).await?;
        Ok(serde_json::from_str(&status)?)
    };

    // Nothing is deployed: the target says so, and the store holds one secret.
    let before = status(&mut modal, &home).await?;
    assert_eq!(before["target"], "modal");
    assert_eq!(before["deployed"], false);
    assert_eq!(before["state"], Value::Null);
    assert_eq!(before["healthy"], false);
    assert_eq!(before["endpoint"], "wss://acme--tags.modal.run");
    assert_eq!(
        before["secrets"],
        serde_json::json!(["SUPERTAG_DATABASE_URL"])
    );
    assert_eq!(before["certificate"]["ca_file_present"], false);
    assert_eq!(before["certificate"]["matches_deployment"], Value::Null);
    assert!(
        before["health"]
            .as_str()
            .is_some_and(|health| health.contains("/healthz gave")),
        "{before}"
    );
    assert!(modal.take_log()?.contains(&"app list --json".to_owned()));

    // The rollout reports the host deploy predicted, so the certificate is issued once and
    // nothing is rolled out twice. Health and verification go through the proxy.
    let deploy = modal.command(
        &home,
        &repository,
        &["deploy", "--non-interactive"],
        &through_proxy,
    );
    let (report, _) = modal.succeed(deploy).await?;
    assert!(
        report.contains("The Control Plane is at wss://acme--tags.modal.run")
            && report.contains("operator authentication passed"),
        "{report}"
    );
    let log = modal.take_log()?;
    assert_eq!(count(&log, "deploy"), 1, "{log:?}");
    assert_eq!(count(&log, "secret create tags-tls "), 1, "{log:?}");
    assert!(
        std::fs::read_to_string(&ca_file)?.contains("hosts: acme--tags.modal.run 127.0.0.1"),
        "the CA file names the Modal host"
    );

    // Deployed: the target, the endpoint, and the running Control Plane each answer.
    let after = status(&mut modal, &home).await?;
    assert_eq!(after["deployed"], true);
    assert_eq!(after["state"], "deployed");
    assert_eq!(after["healthy"], true);
    assert_eq!(after["endpoint"], "wss://acme--tags.modal.run");
    assert_eq!(after["version"], env!("CARGO_PKG_VERSION"));
    assert_eq!(after["secret_store"], "Modal secrets in workspace acme");
    assert_eq!(
        after["secrets"],
        serde_json::json!([
            "SUPERTAG_DATABASE_URL",
            "SUPERTAG_GATEWAY_CREDENTIAL",
            "SUPERTAG_OPERATOR_TOKEN",
            "certificate",
            "credentials"
        ])
    );
    assert_eq!(after["certificate"]["ca_file_present"], true);
    assert_eq!(after["certificate"]["matches_deployment"], true);
    assert!(
        after["certificate"]["ends_in_days"]
            .as_i64()
            .is_some_and(|days| (1820..=1825).contains(&days)),
        "{after}"
    );
    assert!(
        after["verification"]
            .as_str()
            .is_some_and(|passed| passed.contains("operator authentication passed")),
        "{after}"
    );
    assert!(after.get("health").is_none() && after.get("verification_failed").is_none());
    // Names only: no secret's value is in the report.
    let token = modal.variables("tags-operator-token")?["SUPERTAG_OPERATOR_TOKEN"].clone();
    assert!(!after.to_string().contains(&token));

    // Another machine with the repository and no Operator Token gets the same answer from
    // the target, with the checks that need no credential.
    let other = root.join("other-home");
    std::fs::create_dir(&other)?;
    let elsewhere = status(&mut modal, &other).await?;
    assert_eq!(elsewhere["deployed"], true);
    assert_eq!(elsewhere["certificate"]["matches_deployment"], true);
    assert!(
        elsewhere["verification"]
            .as_str()
            .is_some_and(|passed| passed.contains("were not checked")),
        "{elsewhere}"
    );

    // A CA file that does not belong to the deployed certificate is reported as such. The
    // edge keeps its own certificate here, as a platform's does, while the Control Plane
    // behind it gets a renewed one; this machine then has the CA file from before.
    let committed = std::fs::read_to_string(&ca_file)?;
    modal.keep_edge_certificate = true;
    let renew = modal.command(
        &home,
        &repository,
        &[
            "deploy",
            "--non-interactive",
            "--renew-certificate",
            "--wait-seconds",
            "2",
        ],
        &through_proxy,
    );
    // The renewing deploy trusts only its new authority, which this edge does not present.
    assert!(
        modal
            .fail(renew)
            .await?
            .contains("did not become healthy in time")
    );
    assert_ne!(std::fs::read_to_string(&ca_file)?, committed);
    std::fs::write(&ca_file, &committed)?;
    let stale = status(&mut modal, &home).await?;
    assert_eq!(stale["deployed"], true);
    assert_eq!(stale["healthy"], true);
    assert_eq!(stale["certificate"]["matches_deployment"], false);
    assert!(
        stale["certificate"]["error"]
            .as_str()
            .is_some_and(|error| error.to_lowercase().contains("certificate")),
        "{stale}"
    );
    assert!(stale.get("version").is_none() && stale.get("verification").is_none());

    // This machine's files are compared with the target, never trusted over it: without the
    // CA file, the deployment is still reported as the target has it, and a missing file is
    // not called a mismatch.
    std::fs::remove_file(&ca_file)?;
    let without = status(&mut modal, &home).await?;
    assert_eq!(without["deployed"], true);
    assert_eq!(without["state"], "deployed");
    assert_eq!(without["certificate"]["ca_file_present"], false);
    assert_eq!(without["certificate"]["matches_deployment"], Value::Null);
    assert_eq!(without["secrets"], after["secrets"]);
    Ok(())
}
