//! Delivered Workspace commits reach a local Workspace's repository as one branch per Session,
//! written by the Worker Host that maps it as each Task delivers.
#[path = "support/children.rs"]
mod children;
use children::reaped;
#[path = "../../../test-support/prerequisites.rs"]
mod prerequisites;
#[macro_use]
#[path = "support/database.rs"]
mod database;
#[path = "support/database_password.rs"]
mod database_password;
#[path = "support/holding_host.rs"]
mod holding_host;

use std::{
    fs,
    io::{BufRead as _, BufReader as StdBufReader},
    net::SocketAddr,
    path::Path,
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
    the_host_writes_each_session_delivery_to_its_branch_and_leaves_moved_branches;
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    local_supervisor_advances_one_session_branch_for_each_task;
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    a_merge_follow_up_advances_its_session_branch_and_lands;
}

struct Credentials {
    gateway: String,
    operator: String,
    host: String,
}

impl Credentials {
    fn new() -> Self {
        Self {
            gateway: supertag_protocol::new_secret(supertag_protocol::CREDENTIAL_SECRET_PREFIX),
            operator: Uuid::new_v4().to_string(),
            host: supertag_protocol::new_secret(supertag_protocol::CREDENTIAL_SECRET_PREFIX),
        }
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut command = reaped(Command::new(BINARY));
        command
            .args(args)
            .env_clear()
            .env("SUPERTAG_BOOTSTRAP_GATEWAY_CREDENTIAL", &self.gateway)
            .env("SUPERTAG_GATEWAY_CREDENTIAL", &self.gateway)
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
        let mut command = self.holder(public, state, checkout);
        command.arg("--once");
        command
    }

    /// A Worker Host that keeps running, holding the deliveries of every host in the test: they
    /// share one artifact directory, as the processes of one Worker Host identity.
    fn holder(&self, public: &str, state: &Path, checkout: &Path) -> Command {
        let mut command = self.command(&[
            "worklet",
            "--control-plane",
            public,
            "--adapter",
            ADAPTER,
            "--adapter-arg=--workspace-fixture",
        ]);
        command
            .arg("--state-directory")
            .arg(state)
            .arg("--artifact-directory")
            .arg(holding_host::artifact_directory(
                state.parent().expect("state parent"),
            ))
            .args(["--workspace-id", "project", "--workspace-source"])
            .arg(checkout);
        command
    }
}

async fn the_host_writes_each_session_delivery_to_its_branch_and_leaves_moved_branches(
    database: String,
) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let root = directory.path();
    // The Worker Host's own repository, which it maps as the Workspace's source.
    let checkout = root.join("host-checkout");
    fs::create_dir(&checkout)?;
    git(&checkout, &["init", "--quiet", "--initial-branch=main"]).await?;
    fs::write(checkout.join("workspace.txt"), "base\n")?;
    git(&checkout, &["add", "workspace.txt"]).await?;
    git(&checkout, &["commit", "--quiet", "-m", "Base"]).await?;
    let base = git(&checkout, &["rev-parse", "HEAD"]).await?;
    fs::write(checkout.join("workspace.txt"), "operator edit\n")?;

    let credentials = Credentials::new();
    let mut plane = credentials.command(&["control-plane"]);
    plane.env("SUPERTAG_DATABASE_URL", &database);
    let (mut plane, public) = service(plane).await?;
    for tag in ["builder", "reviewer"] {
        json(credentials.operator(
            &[
                "tag",
                "put",
                tag,
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
    }
    let branch = supertag_protocol::session_branch("builder", "feature");
    let mut hosts = 0;
    let mut run = async |tag: &str, prompt: &str, extra: &[&str]| -> Result<Value> {
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
        let mut worker =
            credentials.worker(&public, &root.join(format!("host-{hosts}")), &checkout);
        worker.args(extra);
        success(worker).await?;
        let task = json(credentials.operator(&["get", "task", &task_id], &public)).await?;
        ensure!(task["state"] == "TASK_STATE_SUCCEEDED", "{task}");
        Ok(task)
    };

    // The first Task of the Session creates its branch, the second advances it.
    let first = run("builder", "first", &[]).await?;
    let first_head = field(&first["workspace_delivery"], "head_commit")?.to_owned();
    assert_eq!(
        branch_head(&checkout, &branch).await?,
        Some(first_head.clone())
    );
    let second = run("builder", "second", &[]).await?;
    let second_head = field(&second["workspace_delivery"], "head_commit")?.to_owned();
    assert_eq!(
        branch_head(&checkout, &branch).await?,
        Some(second_head.clone())
    );
    assert_eq!(
        git(&checkout, &["rev-parse", &format!("{second_head}^")]).await?,
        first_head
    );
    assert_eq!(
        git(&checkout, &["show", &format!("{branch}:workspace.txt")]).await?,
        "base\nfirst\nsecond"
    );

    // A person moves the branch: the next delivery no longer continues it, so it stays put, and
    // the Task still succeeds.
    let tree = git(&checkout, &["rev-parse", &format!("{base}^{{tree}}")]).await?;
    let person = git(
        &checkout,
        &["commit-tree", &tree, "-p", &second_head, "-m", "Person"],
    )
    .await?;
    git(
        &checkout,
        &["update-ref", &format!("refs/heads/{branch}"), &person],
    )
    .await?;
    run("builder", "third", &[]).await?;
    assert_eq!(branch_head(&checkout, &branch).await?, Some(person.clone()));

    // Another Tag's Session with the same ID has its own branch.
    let other = run("reviewer", "other", &[]).await?;
    let other_branch = supertag_protocol::session_branch("reviewer", "feature");
    assert_ne!(other_branch, branch);
    assert_eq!(
        branch_head(&checkout, &other_branch).await?.as_deref(),
        Some(field(&other["workspace_delivery"], "head_commit")?)
    );
    // A patch-only Workspace gets no branch.
    let patched = run("reviewer", "patched", &["--workspace-patch", "project"]).await?;
    assert_ne!(
        branch_head(&checkout, &other_branch).await?.as_deref(),
        Some(field(&patched["workspace_delivery"], "head_commit")?)
    );

    // The host's checkout, current branch, and uncommitted edit never changed.
    assert_eq!(git(&checkout, &["rev-parse", "HEAD"]).await?, base);
    assert_eq!(git(&checkout, &["branch", "--show-current"]).await?, "main");
    assert_eq!(
        fs::read_to_string(checkout.join("workspace.txt"))?,
        "operator edit\n"
    );
    plane.kill().await?;
    Ok(())
}

async fn local_supervisor_advances_one_session_branch_for_each_task(
    database: String,
) -> Result<()> {
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
    let supervisor = Supervisor::start(
        root,
        &database,
        &["--workspace-fixture"],
        serde_json::json!("./source"),
    )?;
    let result = async {
        let cli = |args: &[&str]| supervisor.cli(args);
        let logs = || supervisor.logs();
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
            .with_context(|| format!("supervisor did not import the delivery: {}", logs()))??;
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
    supervisor.stop().await;
    result
}

/// A Session whose work conflicts with the branch it merges into gets a merge follow-up Task.
/// Its delivery is a merge commit, which carries the target's new commits beside the Session's
/// own: the host writes it to the Session's branch like any other delivery, and the supervisor
/// then merges the Session into the target.
async fn a_merge_follow_up_advances_its_session_branch_and_lands(database: String) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let root = directory.path();
    let source = root.join("source");
    fs::create_dir(&source)?;
    git(&source, &["init", "--quiet", "--initial-branch=main"]).await?;
    fs::write(source.join("workspace.txt"), "base\n")?;
    git(&source, &["add", "workspace.txt"]).await?;
    git(&source, &["commit", "--quiet", "-m", "Base"]).await?;
    let base = git(&source, &["rev-parse", "HEAD"]).await?;
    let supervisor = Supervisor::start(
        root,
        &database,
        &["--journey"],
        serde_json::json!({"path": "./source", "land": {"merge": "agents"}}),
    )?;
    let result = async {
        let cli = |args: &[&str]| supervisor.cli(args);
        let logs = || supervisor.logs();
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
        let succeeded = async |task_id: &str| -> Result<Value> {
            timeout(WAIT, async {
                loop {
                    let task = json(cli(&["get", "task", task_id])).await?;
                    ensure!(task["state"] != "TASK_STATE_FAILED", "{task}");
                    if task["state"] == "TASK_STATE_SUCCEEDED" {
                        return Ok(task);
                    }
                    sleep(Duration::from_millis(50)).await;
                }
            })
            .await
            .with_context(|| format!("Task {task_id} did not finish: {}", logs()))?
        };
        // A Work Session's turn changes the file; its delivery creates the Session's branch.
        let parent = json(cli(&[
            "task",
            "submit",
            "--tag",
            "builder",
            "--session",
            "conversation",
            "start: Glossary | edit: session",
        ]))
        .await?;
        succeeded(field(&parent, "task_id")?).await?;
        let work = timeout(WAIT, async {
            loop {
                let listed = json(cli(&[
                    "get",
                    "sessions",
                    "--parent-tag",
                    "builder",
                    "--parent-session",
                    "conversation",
                ]))
                .await?;
                if let Some(work) = listed["work_sessions"].get(0) {
                    return Ok::<_, anyhow::Error>(work.clone());
                }
                sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .context("the Work Session did not start")??;
        let session = field(&work, "work_session_id")?.to_owned();
        let first_task = field(&work, "latest_task_id")?.to_owned();
        let first = succeeded(&first_task).await?;
        let first_head = field(&first["workspace_delivery"], "head_commit")?.to_owned();
        let branch = supertag_protocol::session_branch("builder", &session);
        let branch_reaches = async |head: &str, what: &str| -> Result<()> {
            timeout(WAIT, async {
                while branch_head(&source, &branch).await?.as_deref() != Some(head) {
                    sleep(Duration::from_millis(50)).await;
                }
                Ok::<_, anyhow::Error>(())
            })
            .await
            .with_context(|| format!("{what}: {}", logs()))?
        };
        branch_reaches(
            &first_head,
            "the first delivery did not reach the Session branch",
        )
        .await?;

        // The person's own branch moves ahead with a change to the same line.
        git(&source, &["checkout", "--quiet", "-b", "agents"]).await?;
        fs::write(source.join("workspace.txt"), "base\nperson\n")?;
        git(&source, &["commit", "--quiet", "-am", "Person"]).await?;
        let person = git(&source, &["rev-parse", "HEAD"]).await?;
        git(&source, &["checkout", "--quiet", "main"]).await?;

        // The Session's work is reported done: the merge conflicts, so it gets a follow-up Task
        // that merges the target into its work.
        success(cli(&["session", "close", &session])).await?;
        let follow_up = timeout(WAIT, async {
            loop {
                let work = json(cli(&["get", "session", &session])).await?;
                let latest = field(&work, "latest_task_id")?;
                if latest != first_task {
                    return Ok::<_, anyhow::Error>(latest.to_owned());
                }
                sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .with_context(|| format!("the Session got no merge follow-up: {}", logs()))??;
        let merged = succeeded(&follow_up).await?;
        assert_eq!(merged["workspace"]["merge_commit"], person.as_str());
        let delivery = &merged["workspace_delivery"];
        assert_eq!(delivery["start_commit"], first_head.as_str());
        let merged_head = field(delivery, "head_commit")?.to_owned();
        // The delivered commit merges the person's commit into the Session's work.
        branch_reaches(
            &merged_head,
            "the merge follow-up's delivery did not reach the Session branch",
        )
        .await?;
        assert_eq!(
            git(&source, &["rev-list", "--parents", "-n", "1", &merged_head]).await?,
            format!("{merged_head} {first_head} {person}")
        );

        // With the conflict resolved, the Session merges into the person's branch.
        timeout(WAIT, async {
            while git(&source, &["rev-parse", "agents"]).await? == person {
                sleep(Duration::from_millis(50)).await;
            }
            Ok::<_, anyhow::Error>(())
        })
        .await
        .with_context(|| format!("the resolved Session was not merged: {}", logs()))??;
        assert_eq!(
            git(&source, &["rev-list", "--parents", "-n", "1", "agents"])
                .await?
                .split(' ')
                .skip(1)
                .collect::<Vec<_>>(),
            [person.as_str(), merged_head.as_str()]
        );
        let text = git(&source, &["show", "agents:workspace.txt"]).await?;
        ensure!(
            text.contains("person") && text.contains("session") && !text.contains("<<<<<<<"),
            "{text}"
        );
        // The person's checkout never changed.
        assert_eq!(git(&source, &["branch", "--show-current"]).await?, "main");
        assert_eq!(fs::read_to_string(source.join("workspace.txt"))?, "base\n");
        Ok(())
    }
    .await;
    supervisor.stop().await;
    result
}

/// `supertag up --foreground` in `root/state`, with one Worker Host that runs the fixture adapter
/// and maps `root/source` as the Workspace `project`.
struct Supervisor {
    child: std::process::Child,
    state: std::path::PathBuf,
    log: std::path::PathBuf,
}

impl Supervisor {
    fn start(root: &Path, database: &str, adapter_args: &[&str], workspace: Value) -> Result<Self> {
        let state = root.join("state");
        let file = root.join("supertag.yaml");
        let (control_plane, secrets) = if database.starts_with("postgres") {
            let (section, secrets) = database_password::config(database, root)?;
            (
                serde_json::json!({"type": "control-plane", "ports": ["127.0.0.1:0"], "database": section}),
                secrets,
            )
        } else {
            (
                serde_json::json!({"type": "control-plane", "ports": ["127.0.0.1:0"]}),
                serde_json::json!({}),
            )
        };
        fs::write(
            &file,
            serde_json::to_vec(
                &serde_json::json!({"version": 1, "secrets": secrets, "services": {
                    "control-plane": control_plane,
                    "laptop": {
                        "type": "host",
                        "adapter": ADAPTER,
                        "adapter-args": adapter_args,
                        "workspaces": {"project": workspace},
                    },
                }}),
            )?,
        )?;
        let log = root.join("supervisor.log");
        let mut child = reaped(std::process::Command::new(BINARY))
            .args(["up", "--foreground", "--state-directory"])
            .arg(&state)
            .arg("--file")
            .arg(&file)
            .env_clear()
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(fs::File::create(&log)?)
            .spawn()?;
        let stdout = child.stdout.take().context("stdout")?;
        let (sender, ready) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut read = StdBufReader::new(stdout);
            let mut line = String::new();
            let _ = read.read_line(&mut line);
            let _ = sender.send(line);
            let _ = std::io::copy(&mut read, &mut std::io::sink());
        });
        let supervisor = Self { child, state, log };
        let ready = ready.recv_timeout(WAIT);
        if !ready.is_ok_and(|line| !line.trim().is_empty()) {
            let logs = supervisor.logs();
            supervisor.kill();
            anyhow::bail!("supervisor: {logs}");
        }
        Ok(supervisor)
    }

    fn cli(&self, args: &[&str]) -> Command {
        let mut command = reaped(Command::new(BINARY));
        command
            .args(args)
            .arg("--state-directory")
            .arg(&self.state)
            .env_clear()
            .stdin(Stdio::null())
            .kill_on_drop(true);
        command
    }

    /// The supervisor's own output and every log file under its state directory.
    fn logs(&self) -> String {
        let mut text = fs::read_to_string(&self.log).unwrap_or_default();
        let mut directories = vec![(self.state.clone(), 0)];
        while let Some((directory, depth)) = directories.pop() {
            for entry in fs::read_dir(&directory).into_iter().flatten().flatten() {
                let path = entry.path();
                if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                    if depth < 3 {
                        directories.push((path, depth + 1));
                    }
                } else if path.extension().is_some_and(|extension| extension == "log") {
                    text.push_str(&format!(
                        "\n--- {} ---\n{}",
                        path.display(),
                        fs::read_to_string(&path).unwrap_or_default()
                    ));
                }
            }
        }
        text
    }

    async fn stop(mut self) {
        unsafe {
            libc::kill(self.child.id() as i32, libc::SIGTERM);
        }
        let _ = timeout(WAIT, async {
            while self.child.try_wait()?.is_none() {
                sleep(Duration::from_millis(50)).await;
            }
            Ok::<_, anyhow::Error>(())
        })
        .await;
        self.kill();
    }

    fn kill(mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
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
