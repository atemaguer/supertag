//! Delivered Workspace commits reach the operator's repository as one branch per Session:
//! `supertag fetch` imports them on demand, and the local supervisor imports them on its own.
#[path = "../../../test-support/prerequisites.rs"]
mod prerequisites;
#[macro_use]
#[path = "support/database.rs"]
mod database;

use std::{
    fs,
    io::{BufRead as _, BufReader as StdBufReader},
    net::SocketAddr,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use anyhow::{Context, Result, ensure};
use serde_json::Value;
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    time::{sleep, timeout},
};
use uuid::Uuid;

const BINARY: &str = env!("CARGO_BIN_EXE_supertag");
const ADAPTER: &str = env!("CARGO_BIN_EXE_supertag-fixture-adapter");
const WAIT: Duration = Duration::from_secs(30);

database_tests! {
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    fetch_imports_each_session_delivery_and_refuses_tampered_or_moved_branches;
}

struct Credentials {
    gateway: String,
    operator: String,
    host: String,
}

impl Credentials {
    fn new() -> Self {
        Self {
            gateway: Uuid::new_v4().to_string(),
            operator: Uuid::new_v4().to_string(),
            host: Uuid::new_v4().to_string(),
        }
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(BINARY);
        command
            .args(args)
            .env_clear()
            .env("SUPERTAG_GATEWAY_TOKEN", &self.gateway)
            .env("SUPERTAG_OPERATOR_TOKEN", &self.operator)
            .env("SUPERTAG_HOST_TOKEN", &self.host)
            .env("SUPERTAG_BOOTSTRAP_HOST_TOKEN", &self.host)
            .stdin(Stdio::null())
            .kill_on_drop(true);
        command
    }

    fn operator(&self, args: &[&str], public: &str) -> Command {
        let mut command = self.command(args);
        command.args(["--gateway", public]);
        command
    }

    /// A Worker Host on another machine: it has its own checkout of the repository.
    fn worker(&self, public: &str, state: &Path, checkout: &Path) -> Command {
        let mut command = self.command(&[
            "worker-host",
            "--gateway",
            public,
            "--adapter",
            ADAPTER,
            "--once",
            "--adapter-arg=--workspace-fixture",
        ]);
        command
            .arg("--state-directory")
            .arg(state)
            .args(["--workspace-id", "project", "--workspace-source"])
            .arg(checkout);
        command
    }
}

async fn fetch_imports_each_session_delivery_and_refuses_tampered_or_moved_branches(
    database: String,
) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let root = directory.path();
    let operator_repository = root.join("operator");
    fs::create_dir(&operator_repository)?;
    git(
        &operator_repository,
        &["init", "--quiet", "--initial-branch=main"],
    )
    .await?;
    fs::write(operator_repository.join("workspace.txt"), "base\n")?;
    git(&operator_repository, &["add", "workspace.txt"]).await?;
    git(&operator_repository, &["commit", "--quiet", "-m", "Base"]).await?;
    let base = git(&operator_repository, &["rev-parse", "HEAD"]).await?;
    // The remote Worker Host's own checkout of the same repository.
    let checkout = root.join("host-checkout");
    git(
        root,
        &[
            "clone",
            "--quiet",
            "--no-local",
            operator_repository.to_str().context("path")?,
            checkout.to_str().context("path")?,
        ],
    )
    .await?;
    fs::write(operator_repository.join("workspace.txt"), "operator edit\n")?;

    let credentials = Credentials::new();
    let mut plane = credentials.command(&["control-plane"]);
    plane.env("SUPERTAG_DATABASE_URL", &database);
    let (mut plane, private) = service(plane).await?;
    let blobs = root.join("gateway-artifacts");
    let mut gateway = credentials.command(&["gateway", "--control-plane", &private]);
    gateway.arg("--checkpoint-directory").arg(&blobs);
    let (mut gateway, public) = service(gateway).await?;
    json(credentials.operator(
        &[
            "tag",
            "put",
            "builder",
            "--instructions",
            "Improve the repository",
            "--allow",
            "file:write",
            "--workspace-id",
            "project",
            "--workspace-base",
            &base,
        ],
        &public,
    ))
    .await?;
    let branch = supertag_protocol::session_branch("builder", "feature");
    let mut hosts = 0;
    let mut run = async |tag: &str, prompt: &str| -> Result<Value> {
        let task = json(credentials.operator(
            &[
                "task",
                "submit",
                "--tag",
                tag,
                "--session",
                "feature",
                prompt,
            ],
            &public,
        ))
        .await?;
        let task_id = field(&task, "task_id")?.to_owned();
        hosts += 1;
        success(credentials.worker(&public, &root.join(format!("host-{hosts}")), &checkout))
            .await?;
        let task = json(credentials.operator(&["get", "task", &task_id], &public)).await?;
        ensure!(task["state"] == "TASK_STATE_SUCCEEDED", "{task}");
        Ok(task)
    };
    let fetch = |id: &str, extra: &[&str]| {
        let mut command = credentials.operator(&["fetch", id], &public);
        command
            .args(extra)
            .arg("--repository")
            .arg(&operator_repository);
        command
    };

    // The first Task of the Session creates its branch.
    let first = run("builder", "first").await?;
    let first_id = field(&first, "task_id")?;
    let first_head = field(&first["workspace_delivery"], "head_commit")?.to_owned();
    let imported = json(fetch(first_id, &[])).await?;
    assert_eq!(imported["result"], "created");
    assert_eq!(imported["branch"], branch.as_str());
    assert_eq!(imported["session_id"], "feature");
    assert_eq!(
        branch_head(&operator_repository, &branch).await?,
        Some(first_head.clone())
    );
    assert_eq!(json(fetch(first_id, &[])).await?["result"], "current");

    // The second Task continues it, imported by Session.
    let second = run("builder", "second").await?;
    let second_head = field(&second["workspace_delivery"], "head_commit")?.to_owned();
    let imported = json(fetch("feature", &["--tag", "builder"])).await?;
    assert_eq!(imported["result"], "advanced");
    assert_eq!(imported["task_id"], second["task_id"]);
    assert_eq!(
        branch_head(&operator_repository, &branch).await?,
        Some(second_head.clone())
    );
    assert_eq!(
        git(
            &operator_repository,
            &["rev-parse", &format!("{second_head}^")]
        )
        .await?,
        first_head
    );
    assert_eq!(
        git(
            &operator_repository,
            &["show", &format!("{branch}:workspace.txt")]
        )
        .await?,
        "base\nfirst\nsecond"
    );
    // One Tag has this Session, so the Tag is optional.
    assert_eq!(json(fetch("feature", &[])).await?["result"], "current");

    // A person moves the branch: the next delivery no longer continues it, so it stays put.
    let tree = git(
        &operator_repository,
        &["rev-parse", &format!("{base}^{{tree}}")],
    )
    .await?;
    let person = git(
        &operator_repository,
        &["commit-tree", &tree, "-p", &second_head, "-m", "Person"],
    )
    .await?;
    git(
        &operator_repository,
        &["update-ref", &format!("refs/heads/{branch}"), &person],
    )
    .await?;
    let third = run("builder", "third").await?;
    let third_id = field(&third, "task_id")?.to_owned();
    let refused = output(fetch(&third_id, &[])).await?;
    assert!(!refused.status.success());
    let message = String::from_utf8_lossy(&refused.stderr);
    assert!(message.contains("moved outside SuperTag"), "{message}");
    assert!(message.contains(&person), "{message}");
    assert_eq!(
        branch_head(&operator_repository, &branch).await?,
        Some(person.clone())
    );

    // A tampered bundle is refused before the repository receives anything.
    git(
        &operator_repository,
        &["update-ref", &format!("refs/heads/{branch}"), &second_head],
    )
    .await?;
    let fourth = run("builder", "fourth").await?;
    let fourth_head = field(&fourth["workspace_delivery"], "head_commit")?.to_owned();
    let digest = field(&fourth["workspace_delivery"]["bundle"], "sha256")?;
    let stored = find(&blobs, digest)?.context("stored bundle missing")?;
    let mut bytes = fs::read(&stored)?;
    let last = bytes.len() - 1;
    bytes[last] ^= 1;
    fs::write(&stored, bytes)?;
    let refused = output(fetch(field(&fourth, "task_id")?, &[])).await?;
    assert!(!refused.status.success());
    let message = String::from_utf8_lossy(&refused.stderr);
    assert!(message.contains("receipt"), "{message}");
    assert_eq!(
        branch_head(&operator_repository, &branch).await?,
        Some(second_head.clone())
    );
    let mut absent = Command::new("/usr/bin/git");
    absent
        .arg("-C")
        .arg(&operator_repository)
        .args(["cat-file", "-e", &fourth_head]);
    assert!(!output(absent).await?.status.success());

    // The operator's checkout, current branch, and uncommitted edit never changed.
    assert_eq!(
        git(&operator_repository, &["rev-parse", "HEAD"]).await?,
        base
    );
    assert_eq!(
        git(&operator_repository, &["branch", "--show-current"]).await?,
        "main"
    );
    assert_eq!(
        fs::read_to_string(operator_repository.join("workspace.txt"))?,
        "operator edit\n"
    );
    // Another Tag's Session with the same ID has its own branch, and the Session ID alone is
    // then ambiguous.
    json(credentials.operator(
        &[
            "tag",
            "put",
            "reviewer",
            "--instructions",
            "Review the repository",
            "--allow",
            "file:write",
            "--workspace-id",
            "project",
            "--workspace-base",
            &base,
        ],
        &public,
    ))
    .await?;
    let other = run("reviewer", "other").await?;
    let ambiguous = output(fetch("feature", &[])).await?;
    assert!(!ambiguous.status.success());
    let message = String::from_utf8_lossy(&ambiguous.stderr);
    assert!(message.contains("name the Tag"), "{message}");
    let imported = json(fetch("feature", &["--tag", "reviewer"])).await?;
    let other_branch = supertag_protocol::session_branch("reviewer", "feature");
    assert_ne!(other_branch, branch);
    assert_eq!(imported["branch"], other_branch.as_str());
    assert_eq!(imported["result"], "created");
    assert_eq!(
        branch_head(&operator_repository, &other_branch)
            .await?
            .as_deref(),
        Some(field(&other["workspace_delivery"], "head_commit")?)
    );
    assert_eq!(
        branch_head(&operator_repository, &branch).await?,
        Some(second_head.clone())
    );

    // An unknown ID names neither a Task nor a Session.
    let missing = output(fetch("no-such-id", &[])).await?;
    assert!(!missing.status.success());
    assert!(String::from_utf8_lossy(&missing.stderr).contains("no Task or Session"));

    gateway.kill().await?;
    plane.kill().await?;
    Ok(())
}

/// `supertag up` runs the Control Plane on SQLite, so this case has no PostgreSQL run.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn local_supervisor_advances_one_session_branch_for_each_task() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let root = directory.path();
    let source = root.join("source");
    fs::create_dir(&source)?;
    git(&source, &["init", "--quiet", "--initial-branch=main"]).await?;
    fs::write(source.join("workspace.txt"), "base\n")?;
    git(&source, &["add", "workspace.txt"]).await?;
    git(&source, &["commit", "--quiet", "-m", "Base"]).await?;
    let base = git(&source, &["rev-parse", "HEAD"]).await?;
    fs::write(source.join("notes.txt"), "uncommitted\n")?;
    let state = root.join("state");
    let file = root.join("supertag.yaml");
    fs::write(
        &file,
        serde_json::to_vec(&serde_json::json!({"version": 1, "services": {
            "control-plane": {"type": "control-plane", "ports": ["127.0.0.1:0"]},
            "laptop": {
                "type": "host",
                "adapter": ADAPTER,
                "adapter-args": ["--workspace-fixture"],
                "workspaces": {"project": "./source"},
            },
        }}))?,
    )?;
    let log = root.join("supervisor.log");
    let mut supervisor = std::process::Command::new(BINARY)
        .args(["up", "--foreground", "--state-directory"])
        .arg(&state)
        .arg("--file")
        .arg(&file)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(fs::File::create(&log)?)
        .spawn()?;
    let stdout = supervisor.stdout.take().context("stdout")?;
    let (sender, ready) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut read = StdBufReader::new(stdout);
        let mut line = String::new();
        let _ = read.read_line(&mut line);
        let _ = sender.send(line);
        let _ = std::io::copy(&mut read, &mut std::io::sink());
    });
    let ready = ready.recv_timeout(WAIT)?;
    let result = async {
        ensure!(
            !ready.trim().is_empty(),
            "supervisor: {}",
            fs::read_to_string(&log)?
        );
        let cli = |args: &[&str]| {
            let mut command = Command::new(BINARY);
            command
                .args(args)
                .arg("--state-directory")
                .arg(&state)
                .env_clear()
                .stdin(Stdio::null())
                .kill_on_drop(true);
            command
        };
        json(cli(&[
            "tag",
            "put",
            "builder",
            "--instructions",
            "Improve the repository",
            "--allow",
            "file:write",
            "--workspace-id",
            "project",
            "--workspace-base",
            &base,
        ]))
        .await?;
        let branch = supertag_protocol::session_branch("builder", "feature");
        let mut heads = Vec::new();
        for prompt in ["first", "second"] {
            let task = json(cli(&[
                "task",
                "submit",
                "--tag",
                "builder",
                "--session",
                "feature",
                prompt,
            ]))
            .await?;
            let task_id = field(&task, "task_id")?.to_owned();
            let head = timeout(WAIT, async {
                loop {
                    let task = json(cli(&["get", "task", &task_id])).await?;
                    ensure!(task["state"] != "TASK_STATE_FAILED", "{task}");
                    if task["state"] == "TASK_STATE_SUCCEEDED" {
                        return Ok::<_, anyhow::Error>(
                            field(&task["workspace_delivery"], "head_commit")?.to_owned(),
                        );
                    }
                    sleep(Duration::from_millis(50)).await;
                }
            })
            .await
            .context("Task did not finish")??;
            timeout(WAIT, async {
                while branch_head(&source, &branch).await? != Some(head.clone()) {
                    sleep(Duration::from_millis(50)).await;
                }
                Ok::<_, anyhow::Error>(())
            })
            .await
            .with_context(|| {
                format!(
                    "supervisor did not import the delivery: {}",
                    fs::read_to_string(&log).unwrap_or_default()
                )
            })??;
            heads.push(head);
        }
        assert_eq!(
            git(&source, &["rev-parse", &format!("{}^", heads[1])]).await?,
            heads[0]
        );
        assert_eq!(
            git(
                &source,
                &[
                    "for-each-ref",
                    "--format=%(refname:short)",
                    "refs/heads/supertag"
                ]
            )
            .await?,
            branch
        );
        // The operator's checkout never changed.
        assert_eq!(git(&source, &["rev-parse", "HEAD"]).await?, base);
        assert_eq!(git(&source, &["branch", "--show-current"]).await?, "main");
        assert_eq!(fs::read_to_string(source.join("workspace.txt"))?, "base\n");
        assert_eq!(
            fs::read_to_string(source.join("notes.txt"))?,
            "uncommitted\n"
        );
        Ok(())
    }
    .await;
    unsafe {
        libc::kill(supervisor.id() as i32, libc::SIGTERM);
    }
    let _ = timeout(WAIT, async {
        while supervisor.try_wait()?.is_none() {
            sleep(Duration::from_millis(50)).await;
        }
        Ok::<_, anyhow::Error>(())
    })
    .await;
    let _ = supervisor.kill();
    let _ = supervisor.wait();
    result
}

fn find(directory: &Path, name: &str) -> Result<Option<PathBuf>> {
    for entry in fs::read_dir(directory)? {
        let path = entry?.path();
        if path.is_dir() {
            if let Some(found) = find(&path, name)? {
                return Ok(Some(found));
            }
        } else if path.file_name().and_then(|value| value.to_str()) == Some(name) {
            return Ok(Some(path));
        }
    }
    Ok(None)
}

async fn branch_head(repository: &Path, branch: &str) -> Result<Option<String>> {
    let mut command = Command::new("/usr/bin/git");
    command
        .arg("-C")
        .arg(repository)
        .args([
            "rev-parse",
            "-q",
            "--verify",
            &format!("refs/heads/{branch}"),
        ])
        .env_clear()
        .env("PATH", "/usr/bin:/bin");
    let result = output(command).await?;
    Ok(result
        .status
        .success()
        .then(|| String::from_utf8_lossy(&result.stdout).trim().to_owned()))
}

async fn service(mut command: Command) -> Result<(Child, String)> {
    let mut child = command.stdout(Stdio::piped()).spawn()?;
    let mut stdout = BufReader::new(child.stdout.take().context("service stdout missing")?);
    let mut line = String::new();
    timeout(WAIT, stdout.read_line(&mut line))
        .await
        .context("service startup timed out")??;
    let address: SocketAddr = line.trim().parse().context("service endpoint missing")?;
    ensure!(address.ip().is_loopback() && address.port() != 0);
    Ok((child, format!("http://{address}")))
}

async fn output(mut command: Command) -> Result<std::process::Output> {
    Ok(timeout(WAIT, command.output())
        .await
        .context("CLI command timed out")??)
}

async fn success(command: Command) -> Result<std::process::Output> {
    let output = output(command).await?;
    ensure!(
        output.status.success(),
        "CLI failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(output)
}

async fn json(command: Command) -> Result<Value> {
    Ok(serde_json::from_slice(&success(command).await?.stdout)?)
}

fn field<'a>(value: &'a Value, name: &str) -> Result<&'a str> {
    value[name]
        .as_str()
        .with_context(|| format!("missing {name}: {value}"))
}

async fn git(directory: &Path, arguments: &[&str]) -> Result<String> {
    let mut command = Command::new("/usr/bin/git");
    command
        .arg("-C")
        .arg(directory)
        .args(arguments)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_AUTHOR_NAME", "Fixture")
        .env("GIT_AUTHOR_EMAIL", "fixture@example.invalid")
        .env("GIT_COMMITTER_NAME", "Fixture")
        .env("GIT_COMMITTER_EMAIL", "fixture@example.invalid");
    Ok(String::from_utf8(success(command).await?.stdout)?
        .trim()
        .into())
}
