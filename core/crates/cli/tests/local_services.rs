//! The ordinary native `up -f` entry point owns every service and its private enrollment.
#[path = "support/children.rs"]
mod children;
#[path = "../../../test-support/executables.rs"]
mod executables;
use children::reaped;
#[path = "support/database.rs"]
mod database;
#[path = "support/database_password.rs"]
mod database_password;
#[path = "../../../test-support/prerequisites.rs"]
mod prerequisites;
#[path = "support/protocol.rs"]
mod protocol;
use anyhow::{Context, Result, ensure};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{BufRead, BufReader},
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::mpsc,
    time::Duration,
};
use supertag_protocol::negotiation::ProtocolChannel;
use supertag_protocol::{authenticated_request, v2::*};
use tokio::time::{sleep, timeout};
use tonic::transport::Channel;
use uuid::Uuid;
const BIN: &str = env!("CARGO_BIN_EXE_supertag");
const ADAPTER: &str = env!("CARGO_BIN_EXE_supertag-fixture-adapter");
/// Bounds one test wait for the supervisor, a service, or a Task. Only the test waits this long;
/// the product's own deadlines are unchanged. Parallel cases on a loaded machine have stretched
/// startup and Task settlement past 25 seconds.
const WAIT: Duration = Duration::from_secs(60);
struct Process {
    child: Child,
    ready: mpsc::Receiver<String>,
    log: PathBuf,
}
impl Process {
    fn spawn(state: &Path, file: Option<&Path>, env: &[(&str, &str)]) -> Result<Self> {
        Self::spawn_in(Some(state), state, file, env)
    }
    /// Starts `up` in `state`, naming it with `--state-directory` only when `explicit` is set;
    /// otherwise `up` finds it from `env` the way an operator's shell would.
    fn spawn_in(
        explicit: Option<&Path>,
        state: &Path,
        file: Option<&Path>,
        env: &[(&str, &str)],
    ) -> Result<Self> {
        let log = state.with_extension(format!("{}.log", Uuid::new_v4().simple()));
        let mut command = reaped(Command::new(BIN));
        command.args(["up", "--foreground"]);
        if let Some(explicit) = explicit {
            command.arg("--state-directory").arg(explicit);
        }
        command
            .env_clear()
            .envs(env.iter().copied())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(File::create(&log)?);
        if let Some(file) = file {
            command.arg("--file").arg(file);
        }
        let mut child = command.spawn()?;
        let stdout = child.stdout.take().context("stdout missing")?;
        let (sender, ready) = mpsc::channel();
        std::thread::spawn(move || {
            let mut read = BufReader::new(stdout);
            let mut line = String::new();
            let _ = read.read_line(&mut line);
            let _ = sender.send(line);
            let _ = std::io::copy(&mut read, &mut std::io::sink());
        });
        Ok(Self { child, ready, log })
    }
    fn ready(&self) -> Result<String> {
        let result = self.ready.recv_timeout(WAIT)?;
        ensure!(
            !result.trim().is_empty(),
            "supervisor startup failed: {}",
            fs::read_to_string(&self.log)?
        );
        Ok(result.trim().into())
    }
    async fn stop(&mut self) -> Result<()> {
        unsafe {
            libc::kill(self.child.id() as i32, libc::SIGTERM);
        }
        let status = timeout(WAIT, async {
            loop {
                if let Some(s) = self.child.try_wait()? {
                    break Ok::<_, std::io::Error>(s);
                }
                sleep(Duration::from_millis(50)).await;
            }
        })
        .await??;
        ensure!(
            status.success(),
            "supervisor failed: {}",
            fs::read_to_string(&self.log)?
        );
        Ok(())
    }
}
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
/// The supervisor environment that puts the local Control Plane on `database`: none for
/// SQLite, which `up` keeps in the state directory, and `SUPERTAG_DATABASE_URL` for PostgreSQL.
fn database_env(database: &str) -> Vec<(&'static str, &str)> {
    if database.starts_with("postgres") {
        vec![("SUPERTAG_DATABASE_URL", database)]
    } else {
        Vec::new()
    }
}
/// That the local Control Plane in `state` keeps its state in `database`: on PostgreSQL the
/// state directory has no SQLite file, so `up` cannot have fallen back to one.
fn uses_database(state: &Path, database: &str) -> Result<()> {
    ensure!(
        state.join("runtime.sqlite3").exists() != database.starts_with("postgres"),
        "the local Control Plane did not use {}",
        if database.starts_with("postgres") {
            "PostgreSQL"
        } else {
            "SQLite"
        }
    );
    Ok(())
}
fn yaml(path: &Path, value: &Value) -> Result<()> {
    fs::write(path, serde_json::to_vec(value)?)?;
    Ok(())
}
fn token(state: &Path) -> Result<String> {
    let data: Value = serde_json::from_slice(&fs::read(state.join("credentials.json"))?)?;
    Ok(data["operator_token"]
        .as_str()
        .context("operator token missing")?
        .into())
}
async fn client(endpoint: &str) -> Result<operator_client::OperatorClient<ProtocolChannel>> {
    Ok(operator_client::OperatorClient::new(
        protocol::dial(endpoint.to_owned()).await?,
    ))
}
async fn host(
    client: &mut operator_client::OperatorClient<ProtocolChannel>,
    token: &str,
    name: &str,
) -> Result<WorkerHostStatus> {
    Ok(client
        .get_host(authenticated_request(
            GetHostRequest {
                host_id: name.into(),
            },
            token,
            None,
        )?)
        .await?
        .into_inner())
}
fn children(pid: u32) -> Result<Vec<(i32, String)>> {
    let output = Command::new("ps")
        .args(["-axo", "pid=,ppid=,command="])
        .output()?;
    ensure!(output.status.success());
    Ok(String::from_utf8(output.stdout)?
        .lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let child = parts.next()?.parse().ok()?;
            let parent = parts.next()?.parse::<u32>().ok();
            if parent == Some(pid) {
                Some((child, line.to_owned()))
            } else {
                None
            }
        })
        .collect())
}
async fn gone(pids: &[i32]) -> Result<()> {
    timeout(WAIT, async {
        loop {
            if pids.iter().all(|pid| unsafe { libc::kill(*pid, 0) } != 0) {
                break;
            }
            sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .context("owned services survived shutdown")?;
    Ok(())
}
async fn run_work(
    client: &mut operator_client::OperatorClient<ProtocolChannel>,
    token: &str,
    session: &str,
) -> Result<()> {
    client
        .put_tag(authenticated_request(
            PutTagRequest {
                tag_id: "engineer".into(),
                instructions: "Local fixture".into(),
                ..Default::default()
            },
            token,
            None,
        )?)
        .await?;
    let task = client
        .submit_task(authenticated_request(
            SubmitTaskRequest {
                tag_id: "engineer".into(),
                session_id: session.into(),
                operation_id: Uuid::new_v4().to_string(),
                prompt: "Run configured worker".into(),
                ..Default::default()
            },
            token,
            None,
        )?)
        .await?
        .into_inner();
    timeout(WAIT, async {
        loop {
            let current = client
                .get_task(authenticated_request(
                    GetTaskRequest {
                        task_id: task.task_id.clone(),
                    },
                    token,
                    None,
                )?)
                .await?
                .into_inner();
            if current.state() == TaskState::Succeeded {
                ensure!(
                    current
                        .result
                        .as_deref()
                        .is_some_and(|r| r.contains("Run configured worker"))
                );
                break Ok::<_, anyhow::Error>(());
            }
            ensure!(
                current.state() != TaskState::Failed,
                "configured execution failed: {:?}",
                current.result
            );
            sleep(Duration::from_millis(50)).await;
        }
    })
    .await??;
    Ok(())
}
async fn configured_local_hosts_restart_and_reap_with_stable_private_state(
    database: String,
) -> Result<()> {
    let temp = tempfile::tempdir()?;
    let state = temp.path().join("state");
    let file = temp.path().join("supertag.yaml");
    let (section, secrets) = if database.starts_with("postgres") {
        database_password::config(&database, temp.path())?
    } else {
        (Value::Null, serde_json::json!({}))
    };
    yaml(
        &file,
        &serde_json::json!({"version":1,"secrets":secrets,"services":{
            "control-plane":{"type":"control-plane","ports":["127.0.0.1:0"],"database":section},
            "reader":{"type":"host","adapter":ADAPTER,"restart":"unless-stopped","concurrency":1},
            "writer":{"type":"host","adapter":ADAPTER,"concurrency":1}
        }}),
    )?;
    let mut supervisor = Process::spawn(&state, Some(&file), &[])?;
    let endpoint = supervisor.ready()?;
    // The configured PostgreSQL database replaces the state directory's SQLite file.
    uses_database(&state, &database)?;
    let credential = token(&state)?;
    let mut operator = client(&endpoint).await?;
    let reader = host(&mut operator, &credential, "reader").await?;
    let writer = host(&mut operator, &credential, "writer").await?;
    assert!(reader.generation > 0 && writer.generation > 0);
    run_work(&mut operator, &credential, "first").await?;
    // The Control Plane, the Gateway clients connect to, and the two hosts.
    let owned = children(supervisor.child.id())?;
    assert_eq!(owned.len(), 4);
    let reader_pid = owned
        .iter()
        .find(|(_, command)| command.contains("/hosts/reader"))
        .context("reader child missing")?
        .0;
    unsafe {
        libc::kill(reader_pid, libc::SIGKILL);
    }
    timeout(WAIT, async {
        loop {
            if children(supervisor.child.id())?
                .iter()
                .any(|(pid, command)| *pid != reader_pid && command.contains("/hosts/reader"))
            {
                break Ok::<_, anyhow::Error>(());
            }
            sleep(Duration::from_millis(50)).await;
        }
    })
    .await??;
    assert_eq!(
        host(&mut operator, &credential, "writer").await?.generation,
        writer.generation
    );
    // The same private journal replays its registered incarnation rather than fencing itself.
    assert_eq!(
        host(&mut operator, &credential, "reader").await?.generation,
        reader.generation
    );
    operator
        .set_host_draining(authenticated_request(
            SetHostDrainingRequest {
                host_id: "writer".into(),
                draining: true,
            },
            &credential,
            None,
        )?)
        .await?;
    run_work(&mut operator, &credential, "after-host-restart").await?;
    let owned = children(supervisor.child.id())?
        .into_iter()
        .map(|(id, _)| id)
        .collect::<Vec<_>>();
    supervisor.stop().await?;
    gone(&owned).await?;
    assert!(!state.join("endpoint").exists());
    for name in ["reader", "writer"] {
        let file = state.join("hosts").join(name).join("enrollment.json");
        assert_eq!(fs::metadata(file)?.permissions().mode() & 0o777, 0o600);
    }
    // Discover the default file from state, and reuse exactly the enrolled Control Plane origin.
    fs::copy(&file, state.join("supertag.yaml"))?;
    let mut restarted = Process::spawn(&state, None, &[])?;
    assert_eq!(restarted.ready()?, endpoint);
    let mut operator = client(&endpoint).await?;
    run_work(&mut operator, &credential, "after-restart").await?;
    let owned = children(restarted.child.id())?
        .into_iter()
        .map(|(id, _)| id)
        .collect::<Vec<_>>();
    restarted.child.kill()?;
    restarted.child.wait()?;
    gone(&owned).await?;
    // SIGKILL cannot remove the endpoint; the supervisor lock is still the liveness authority.
    assert!(state.join("endpoint").exists());
    let rejected = reaped(Command::new(BIN))
        .args(["get", "task", "--state-directory"])
        .arg(&state)
        .arg("no-task")
        .env_clear()
        .output()?;
    assert!(!rejected.status.success());
    assert!(String::from_utf8_lossy(&rejected.stderr).contains("not running"));
    Ok(())
}
/// With no flag, operator commands reach the Control Plane `supertag up` runs from
/// `~/.supertag`, or from `SUPERTAG_STATE_DIR`; `SUPERTAG_GATEWAY_URL` and the flags win.
async fn operator_commands_default_to_the_local_control_plane(database: String) -> Result<()> {
    let temp = tempfile::tempdir()?;
    let home = temp.path().join("home");
    let elsewhere = temp.path().join("elsewhere");
    fs::create_dir_all(&home)?;
    fs::create_dir_all(&elsewhere)?;
    let state = home.join(".supertag");
    let file = temp.path().join("supertag.yaml");
    let (section, secrets) = if database.starts_with("postgres") {
        database_password::config(&database, temp.path())?
    } else {
        (Value::Null, serde_json::json!({}))
    };
    yaml(
        &file,
        &serde_json::json!({"version":1,"secrets":secrets,"services":{
            "control-plane":{"type":"control-plane","ports":["127.0.0.1:0"],"database":section}
        }}),
    )?;
    let home_text = home.to_str().context("home path")?;
    let mut supervisor = Process::spawn_in(None, &state, Some(&file), &[("HOME", home_text)])?;
    supervisor.ready()?;
    uses_database(&state, &database)?;
    let get_tags = |env: &[(&str, &str)], extra: &[&std::ffi::OsStr]| {
        reaped(Command::new(BIN))
            .args(["get", "tags"])
            .args(extra)
            .env_clear()
            .envs(env.iter().copied())
            .output()
    };
    let elsewhere_text = elsewhere.to_str().context("elsewhere path")?;
    let state_text = state.to_str().context("state path")?;
    for env in [
        vec![("HOME", home_text)],
        vec![("HOME", elsewhere_text), ("SUPERTAG_STATE_DIR", state_text)],
    ] {
        let output = get_tags(&env, &[])?;
        ensure!(
            output.status.success(),
            "{env:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let output = get_tags(&[("HOME", elsewhere_text)], &[])?;
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    // Nothing is set up there, so the error names supertag init.
    assert!(
        stderr.contains(&format!(
            "SuperTag isn't set up on this machine yet (no supertag.yaml in {})",
            elsewhere.join(".supertag").display()
        )) && stderr.contains("supertag init"),
        "{stderr}"
    );
    let output = get_tags(
        &[("HOME", home_text)],
        &["--state-directory".as_ref(), elsewhere.as_os_str()],
    )?;
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains(&format!("no supertag.yaml in {}", elsewhere.display()))
    );
    // A selected Control Plane is never replaced by the local one.
    let output = get_tags(
        &[
            ("HOME", home_text),
            ("SUPERTAG_GATEWAY_URL", "http://127.0.0.1:9"),
            ("SUPERTAG_OPERATOR_TOKEN", "stop_unused"),
        ],
        &[],
    )?;
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(!stderr.contains("no local Control Plane"), "{stderr}");
    supervisor.stop().await
}
async fn remote_host_only_env_and_file_auth_keys_are_needed_only_for_first_join(
    database: String,
) -> Result<()> {
    let temp = tempfile::tempdir()?;
    let central = temp.path().join("central");
    let central_file = temp.path().join("central.yaml");
    yaml(
        &central_file,
        &serde_json::json!({"services":{"control-plane":{"type":"control-plane","ports":["127.0.0.1:0"]}}}),
    )?;
    let mut server = Process::spawn(&central, Some(&central_file), &database_env(&database))?;
    let endpoint = server.ready()?;
    uses_database(&central, &database)?;
    let credential = token(&central)?;
    let mut operator = client(&endpoint).await?;
    let mut keys = Vec::new();
    for name in ["env-host", "file-host"] {
        let key = supertag_protocol::new_secret(supertag_protocol::AUTH_KEY_SECRET_PREFIX);
        operator
            .create_auth_key(authenticated_request(
                CreateAuthKeyRequest {
                    name: name.into(),
                    role: supertag_protocol::v2::PrincipalRole::Host.into(),
                    operation_id: Uuid::new_v4().to_string(),
                    key_digest: Sha256::digest(key.as_bytes()).to_vec(),
                    expires_in_ms: 600000,
                    all_tags: true,
                    allowed_tag_ids: vec![],
                    ..Default::default()
                },
                &credential,
                None,
            )?)
            .await?;
        keys.push(key);
    }
    let key_path = temp.path().join("join.key");
    fs::write(&key_path, &keys[1])?;
    fs::set_permissions(&key_path, fs::Permissions::from_mode(0o600))?;
    let file = temp.path().join("remote.yaml");
    let state = temp.path().join("remote");
    yaml(
        &file,
        &serde_json::json!({"services":{
        "env-host":{"type":"host","control-plane":endpoint,"adapter":ADAPTER,"auth-key":"env","concurrency":1},
        "file-host":{"type":"host","control-plane":endpoint,"adapter":ADAPTER,"auth-key":"file","concurrency":1}
    },"secrets":{"env":{"environment":"FIXTURE_JOIN_KEY"},"file":{"file":key_path}}}),
    )?;
    let mut remote = Process::spawn(&state, Some(&file), &[("FIXTURE_JOIN_KEY", &keys[0])])?;
    assert_eq!(remote.ready()?, "ready");
    assert!(!state.join("credentials.json").exists());
    assert!(!state.join("endpoint").exists());
    assert_eq!(children(remote.child.id())?.len(), 2);
    run_work(&mut operator, &credential, "remote-first").await?;
    remote.stop().await?;
    fs::remove_file(key_path)?;
    let mut restarted = Process::spawn(&state, Some(&file), &[])?;
    assert_eq!(restarted.ready()?, "ready");
    run_work(&mut operator, &credential, "remote-restart").await?;
    assert!(!fs::read_to_string(&restarted.log)?.contains(&keys[0]));
    assert!(!fs::read_to_string(&restarted.log)?.contains(&keys[1]));
    restarted.stop().await?;
    server.stop().await?;
    Ok(())
}

async fn local_provision_creates_ordered_resources_once_and_preserves_operator_edits(
    database: String,
) -> Result<()> {
    let temp = tempfile::tempdir()?;
    let state = temp.path().join("provisioned");
    let file = temp.path().join("supertag.yaml");
    let resources = temp.path().join("resources");
    fs::create_dir(&resources)?;
    fs::write(
        resources.join("policy.yaml"),
        r#"apiVersion: supertag/v1
kind: Role
metadata: {name: engineer-role}
spec: {purpose: Read fixture evidence., permissionSets: [read-fixture]}
---
apiVersion: supertag/v1
kind: PermissionSet
metadata: {name: read-fixture}
spec: {permissions: [{target: runtime, action: 'files:read'}]}
"#,
    )?;
    let mut config = serde_json::json!({"services":{
        "control-plane":{"type":"control-plane","ports":["127.0.0.1:0"],"provision":[
            {"apiVersion":"supertag/v1","kind":"Objective","metadata":{"name":"fixture-objective"},"spec":{"ownerTagId":"engineer","ongoing":true,"outcome":"Read provisioned fixture evidence."}},
            "resources",
            {"apiVersion":"supertag/v1","kind":"Tag","metadata":{"name":"engineer"},"spec":{"instructions":"Initially provisioned","roles":["engineer-role"]}}
        ]},
        "worker":{"type":"host","adapter":ADAPTER}
    }});
    yaml(&file, &config)?;
    let mut supervisor = Process::spawn(&state, Some(&file), &database_env(&database))?;
    let endpoint = supervisor.ready()?;
    uses_database(&state, &database)?;
    let credential = token(&state)?;
    let channel =
        protocol::negotiated(Channel::from_shared(endpoint.clone())?.connect().await?).await?;
    let mut operator = operator_client::OperatorClient::new(channel.clone());
    let mut objectives = objectives_client::ObjectivesClient::new(channel.clone());
    let mut policy = policy_catalog_client::PolicyCatalogClient::new(channel);
    let objective = objectives
        .get_objective(authenticated_request(
            GetObjectiveRequest {
                objective_id: "fixture-objective".into(),
            },
            &credential,
            None,
        )?)
        .await?
        .into_inner();
    let task = operator
        .get_task(authenticated_request(
            GetTaskRequest {
                task_id: objective.starting_task_id.clone(),
            },
            &credential,
            None,
        )?)
        .await?
        .into_inner();
    assert!(task.allowed_actions.iter().any(|a| a == "files:read"));
    assert_eq!(
        task.policy_snapshot
            .as_ref()
            .context("initial policy snapshot missing")?
            .roles
            .len(),
        1
    );
    timeout(WAIT, async {
        loop {
            let current = operator
                .get_task(authenticated_request(
                    GetTaskRequest {
                        task_id: task.task_id.clone(),
                    },
                    &credential,
                    None,
                )?)
                .await?
                .into_inner();
            if current.state() == TaskState::Succeeded {
                break Ok::<_, anyhow::Error>(());
            }
            ensure!(current.state() != TaskState::Failed);
            sleep(Duration::from_millis(50)).await;
        }
    })
    .await??;
    let original = operator
        .get_tag(authenticated_request(
            GetTagRequest {
                tag_id: "engineer".into(),
            },
            &credential,
            None,
        )?)
        .await?
        .into_inner();
    let edited = operator
        .put_tag(authenticated_request(
            PutTagRequest {
                tag_id: original.tag_id,
                instructions: "Edited by operator".into(),
                expected_revision: Some(original.revision),
                ..Default::default()
            },
            &credential,
            None,
        )?)
        .await?
        .into_inner();
    let assignments = policy
        .list_role_assignments(authenticated_request(
            ListRoleAssignmentsRequest {
                tag_id: "engineer".into(),
                limit: 10,
                ..Default::default()
            },
            &credential,
            None,
        )?)
        .await?
        .into_inner();
    let assignment = assignments
        .assignments
        .first()
        .context("assignment missing")?;
    policy
        .deactivate_role_assignment(authenticated_request(
            DeactivateRoleAssignmentRequest {
                operation_id: Uuid::new_v4().to_string(),
                assignment_id: assignment.assignment_id.clone(),
                expected_revision: assignment.revision,
            },
            &credential,
            None,
        )?)
        .await?;
    supervisor.stop().await?;
    config["services"]["control-plane"]["provision"].as_array_mut().unwrap().push(serde_json::json!({"apiVersion":"supertag/v1","kind":"Tag","metadata":{"name":"later"},"spec":{"instructions":"Added later"}}));
    yaml(&file, &config)?;
    let mut restarted = Process::spawn(&state, Some(&file), &database_env(&database))?;
    assert_eq!(restarted.ready()?, endpoint);
    let channel = protocol::negotiated(Channel::from_shared(endpoint)?.connect().await?).await?;
    let mut operator = operator_client::OperatorClient::new(channel.clone());
    let current = operator
        .get_tag(authenticated_request(
            GetTagRequest {
                tag_id: "engineer".into(),
            },
            &credential,
            None,
        )?)
        .await?
        .into_inner();
    // Only GetTag reads how the Tag's messages landed.
    assert_eq!(
        Tag {
            attention: None,
            ..current
        },
        edited
    );
    assert_eq!(
        operator
            .get_tag(authenticated_request(
                GetTagRequest {
                    tag_id: "later".into()
                },
                &credential,
                None
            )?)
            .await?
            .into_inner()
            .instructions,
        "Added later"
    );
    let objective_again = objectives_client::ObjectivesClient::new(channel.clone())
        .get_objective(authenticated_request(
            GetObjectiveRequest {
                objective_id: "fixture-objective".into(),
            },
            &credential,
            None,
        )?)
        .await?
        .into_inner();
    assert_eq!(objective_again.starting_task_id, objective.starting_task_id);
    let assignments = policy_catalog_client::PolicyCatalogClient::new(channel)
        .list_role_assignments(authenticated_request(
            ListRoleAssignmentsRequest {
                tag_id: "engineer".into(),
                limit: 10,
                ..Default::default()
            },
            &credential,
            None,
        )?)
        .await?
        .into_inner();
    assert_eq!(assignments.assignments.len(), 1);
    assert_eq!(
        assignments.assignments[0].status(),
        RoleAssignmentStatus::Inactive
    );
    restarted.stop().await?;
    Ok(())
}

/// Each case gets its own database: a second local Control Plane on the first one's database
/// would find `gateway:local` enrolled with another credential and refuse to start.
async fn unsafe_provision_source_stops_before_hosts_start_and_reaps_services(
    postgres: bool,
) -> Result<()> {
    for linked in [false, true] {
        with_database(postgres, |database| unsafe_provision_case(database, linked)).await?;
    }
    Ok(())
}

async fn unsafe_provision_case(database: String, linked: bool) -> Result<()> {
    let temp = tempfile::tempdir()?;
    let state = temp.path().join("unsafe");
    let file = temp.path().join("supertag.yaml");
    let resource = temp.path().join("resource.yaml");
    fs::write(
        &resource,
        "apiVersion: supertag/v1\nkind: Tag\nmetadata: {name: unsafe}\nspec: {instructions: untrusted}\n",
    )?;
    let selection = if linked {
        let directory = temp.path().join("resources");
        fs::create_dir(&directory)?;
        std::os::unix::fs::symlink(&resource, directory.join("resource.yaml"))?;
        "resources"
    } else {
        fs::set_permissions(&resource, fs::Permissions::from_mode(0o666))?;
        "resource.yaml"
    };
    yaml(
        &file,
        &serde_json::json!({"services":{
            "control-plane":{"type":"control-plane","ports":["127.0.0.1:0"],"provision":[selection]},
            "worker":{"type":"host","adapter":ADAPTER}
        }}),
    )?;
    let mut supervisor = Process::spawn(&state, Some(&file), &database_env(&database))?;
    assert!(supervisor.ready().is_err());
    let status = timeout(WAIT, async {
        loop {
            if let Some(status) = supervisor.child.try_wait()? {
                break Ok::<_, std::io::Error>(status);
            }
            sleep(Duration::from_millis(50)).await;
        }
    })
    .await??;
    assert!(!status.success());
    assert!(!state.join("hosts").exists());
    assert!(!state.join("endpoint").exists());
    let address = fs::read_to_string(state.join("control-plane-address"))?;
    assert!(
        tokio::net::TcpStream::connect(address.trim())
            .await
            .is_err()
    );
    Ok(())
}

/// A Worker Host's environment, where its user can read it. A Linux Worker Host is non-dumpable,
/// so only root reads its `/proc/<pid>/environ`; that it is denied is the check there.
fn host_environment(pid: i32) -> Result<Option<std::collections::BTreeMap<String, String>>> {
    #[cfg(target_os = "linux")]
    // SAFETY: geteuid has no preconditions.
    if unsafe { libc::geteuid() } != 0 {
        let denied = fs::read(format!("/proc/{pid}/environ"))
            .expect_err("a non-dumpable Worker Host's environment is unreadable");
        ensure!(
            denied.kind() == std::io::ErrorKind::PermissionDenied,
            "{denied}"
        );
        return Ok(None);
    }
    process_environment(pid).map(Some)
}

/// The exact environment of a process this test owns.
fn process_environment(pid: i32) -> Result<std::collections::BTreeMap<String, String>> {
    #[cfg(target_os = "linux")]
    let bytes = fs::read(format!("/proc/{pid}/environ"))?;
    #[cfg(target_os = "macos")]
    let bytes = {
        let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
        let mut size = 0_usize;
        // SAFETY: the MIB is valid and a null buffer asks only for the size.
        ensure!(
            unsafe {
                libc::sysctl(
                    mib.as_mut_ptr(),
                    3,
                    std::ptr::null_mut(),
                    &mut size,
                    std::ptr::null_mut(),
                    0,
                )
            } == 0,
            "size process arguments"
        );
        let mut buffer = vec![0_u8; size];
        // SAFETY: the buffer holds `size` writable bytes.
        ensure!(
            unsafe {
                libc::sysctl(
                    mib.as_mut_ptr(),
                    3,
                    buffer.as_mut_ptr().cast(),
                    &mut size,
                    std::ptr::null_mut(),
                    0,
                )
            } == 0,
            "read process arguments"
        );
        buffer.truncate(size);
        // Layout: argc, executable path, NUL padding, argc arguments, then the environment.
        let argc = i32::from_ne_bytes(buffer.get(..4).context("argc")?.try_into()?) as usize;
        let mut rest = &buffer[4..];
        let path = rest.iter().position(|b| *b == 0).context("path")?;
        rest = &rest[path..];
        let start = rest.iter().position(|b| *b != 0).context("arguments")?;
        rest = &rest[start..];
        for _ in 0..argc {
            let end = rest.iter().position(|b| *b == 0).context("argument")?;
            rest = &rest[end + 1..];
        }
        let end = rest
            .windows(2)
            .position(|pair| pair == [0, 0])
            .map_or(rest.len(), |end| end + 1);
        rest[..end].to_vec()
    };
    Ok(bytes
        .split(|b| *b == 0)
        .filter(|entry| !entry.is_empty())
        .filter_map(|entry| {
            let entry = String::from_utf8_lossy(entry);
            let (name, value) = entry.split_once('=')?;
            Some((name.to_owned(), value.to_owned()))
        })
        .collect())
}

fn names(environment: &std::collections::BTreeMap<String, String>) -> Vec<&str> {
    environment.keys().map(String::as_str).collect()
}

async fn env_file_credentials_reach_only_the_services_and_harnesses_that_need_them(
    database: String,
) -> Result<()> {
    let postgres = database.starts_with("postgres");
    // A server that requires a password gets its real one through the same env_file secret.
    let (database, password) = database_password::split(&database)?;
    let password = password.unwrap_or_else(|| "file-db-password".into());
    let temp = tempfile::tempdir()?;
    let state = temp.path().join("state");
    let home = temp.path().join("home");
    fs::create_dir(&home)?;
    let env_file = temp.path().join("services.env");
    fs::write(
        &env_file,
        format!(
            "FIXTURE_PORT=0\nOPENAI_API_KEY=file-openai\nexport CODEX_API_KEY=file-codex\nCURSOR_API_KEY='file-cursor'\nSUPERTAG_GATEWAY_CREDENTIAL=file-gateway-token\nHTTPS_PROXY=https://proxy.invalid:443\nNO_PROXY=example.test\nLOCAL_DB_PASSWORD={password}\n"
        ),
    )?;
    fs::set_permissions(&env_file, fs::Permissions::from_mode(0o600))?;
    let file = temp.path().join("supertag.yaml");
    yaml(
        &file,
        // On PostgreSQL the configured database's password secret comes from env_file and
        // reaches the Control Plane, and only it, as PGPASSWORD.
        &serde_json::json!({"env_file":"services.env","secrets":{"db":{"environment":"LOCAL_DB_PASSWORD"}},"services":{
            "control-plane":{"type":"control-plane","ports":["127.0.0.1:${FIXTURE_PORT}"],
                "database":if postgres {
                    serde_json::json!({"url": database, "password": "db"})
                } else {
                    Value::Null
                }},
            "codex-host":{"type":"host","harnesses":["codex"],"concurrency":1},
            "reporter":{"type":"host","adapter":ADAPTER,"adapter-args":["--report-environment"],"concurrency":1}
        }}),
    )?;
    // The Codex host checks its CLI before it starts; this machine's own Codex is not used.
    let bin = temp.path().join("bin");
    fs::create_dir(&bin)?;
    executables::write_executable(
        &bin.join("codex"),
        "#!/bin/sh\nif [ \"$1\" = --version ]; then echo codex-cli 0.163.0; fi\n",
        0o700,
    )?;
    let path = format!("{}:{}", bin.display(), std::env::var("PATH")?);
    let home_value = home.to_str().context("UTF-8 home")?;
    let mut supervisor = Process::spawn(
        &state,
        Some(&file),
        &[
            ("PATH", path.as_str()),
            ("HOME", home_value),
            ("CODEX_API_KEY", "shell-codex"),
            ("ANTHROPIC_API_KEY", "shell-anthropic"),
            ("SUPERTAG_GITHUB_TOKEN", "shell-github"),
            ("FIXTURE_UNRELATED", "shell-unrelated"),
        ],
    )?;
    let endpoint = supervisor.ready()?;
    uses_database(&state, &database)?;
    let credential = token(&state)?;
    let mut roles = std::collections::BTreeMap::new();
    let mut commands = std::collections::BTreeMap::new();
    for (pid, command) in children(supervisor.child.id())? {
        let role = if command.contains("/hosts/codex-host") {
            "codex-host"
        } else if command.contains("/hosts/reporter") {
            "reporter"
        } else if command.contains(" gateway ") {
            "gateway"
        } else if command.contains(" control-plane ") {
            "control-plane"
        } else {
            anyhow::bail!("unexpected supervised child: {command}");
        };
        let environment = if role.ends_with("-host") || role == "reporter" {
            host_environment(pid)?
        } else {
            Some(process_environment(pid)?)
        };
        if let Some(environment) = environment {
            roles.insert(role, environment);
        }
        commands.insert(role, command);
    }
    // The env_file proxy reaches every service, so a service unit can use one. Its https://
    // URL is one SuperTag cannot use, which fails only connections that would go through it,
    // never these loopback ones.
    let base = [
        "HOME",
        "HTTPS_PROXY",
        "NO_PROXY",
        "PATH",
        "SUPERTAG_LOCAL_SERVICE_LIFELINE",
    ];
    let expected = |extra: &[&'static str]| {
        let mut names = base.iter().chain(extra).copied().collect::<Vec<_>>();
        names.sort_unstable();
        names
    };
    assert_eq!(
        names(&roles["control-plane"]),
        expected(if postgres {
            &[
                "PGPASSWORD",
                "SUPERTAG_BOOTSTRAP_GATEWAY_CREDENTIAL",
                "SUPERTAG_DATABASE_URL",
                // The local Gateway, which local Workers send their data calls through.
                "SUPERTAG_DATA_ENDPOINT",
                "SUPERTAG_OPERATOR_TOKEN",
                // Git delivery's state and the credential vault holding Workspace Credentials.
                "SUPERTAG_STATE_DIR",
            ]
        } else {
            &[
                "SUPERTAG_BOOTSTRAP_GATEWAY_CREDENTIAL",
                "SUPERTAG_DATABASE_URL",
                "SUPERTAG_DATA_ENDPOINT",
                "SUPERTAG_OPERATOR_TOKEN",
                "SUPERTAG_STATE_DIR",
            ]
        })
    );
    assert_eq!(
        roles["control-plane"]["SUPERTAG_DATA_ENDPOINT"],
        fs::read_to_string(state.join("gateway-endpoint"))?.trim()
    );
    if postgres {
        assert_eq!(roles["control-plane"]["PGPASSWORD"], password);
        assert_eq!(roles["control-plane"]["SUPERTAG_DATABASE_URL"], database);
    }
    // Even without a surface or notify destination, `up` runs the Gateway clients connect to,
    // with its own enrolled credential and nothing of the Control Plane's or the hosts'.
    assert_eq!(
        names(&roles["gateway"]),
        expected(&["SUPERTAG_GATEWAY_CREDENTIAL"])
    );
    // The Codex Host's Worklet gets only Codex credentials, and in a file it read and deleted,
    // never its environment. It reads its Host credential from its enrollment; neither the
    // environment nor its Workers ever hold it.
    if let Some(codex) = roles.get("codex-host") {
        assert_eq!(names(codex), expected(&[]));
    }
    let harness_set = |host: &str| -> Result<String> {
        Ok(fs::read_to_string(
            state.join("hosts").join(host).join("harness-set.json"),
        )?)
    };
    let codex_set: Value = serde_json::from_str(&harness_set("codex-host")?)?;
    let codex_args = codex_set["harnesses"][0]
        .as_array()
        .context("the Codex Host's harness arguments")?;
    let credentials = codex_args
        .iter()
        .skip_while(|argument| argument.as_str() != Some("--provider-credentials-file"))
        .nth(1)
        .and_then(Value::as_str)
        .context("the Codex Host is given a provider credentials file")?;
    assert!(
        !Path::new(credentials).exists(),
        "the Codex Host deleted its provider credentials file"
    );
    assert!(commands["codex-host"].contains("--harness-set"));
    assert!(!harness_set("reporter")?.contains("--provider-credentials-file"));
    if let Some(reporter) = roles.get("reporter") {
        assert_eq!(names(reporter), expected(&[]));
    }
    for (role, environment) in &roles {
        // The database password reaches the Control Plane alone, under any name.
        if *role != "control-plane" {
            assert!(environment.values().all(|value| *value != password));
        }
        assert_eq!(environment["HOME"], home_value);
        assert_eq!(environment["HTTPS_PROXY"], "https://proxy.invalid:443");
        assert_eq!(environment["NO_PROXY"], "example.test");
        assert!(
            environment
                .values()
                .all(|value| value != "file-gateway-token")
        );
    }
    // A harness child of the reporter sees no supervisor, service or provider credential.
    let mut operator = client(&endpoint).await?;
    operator
        .set_host_draining(authenticated_request(
            SetHostDrainingRequest {
                host_id: "codex-host".into(),
                draining: true,
            },
            &credential,
            None,
        )?)
        .await?;
    operator
        .put_tag(authenticated_request(
            PutTagRequest {
                tag_id: "engineer".into(),
                instructions: "Local fixture".into(),
                ..Default::default()
            },
            &credential,
            None,
        )?)
        .await?;
    let task = operator
        .submit_task(authenticated_request(
            SubmitTaskRequest {
                tag_id: "engineer".into(),
                session_id: "environment".into(),
                operation_id: Uuid::new_v4().to_string(),
                prompt: "Report environment".into(),
                ..Default::default()
            },
            &credential,
            None,
        )?)
        .await?
        .into_inner();
    let result = timeout(WAIT, async {
        loop {
            let current = operator
                .get_task(authenticated_request(
                    GetTaskRequest {
                        task_id: task.task_id.clone(),
                    },
                    &credential,
                    None,
                )?)
                .await?
                .into_inner();
            if current.state() == TaskState::Succeeded {
                break Ok::<_, anyhow::Error>(current.result.unwrap_or_default());
            }
            ensure!(
                current.state() != TaskState::Failed,
                "reporter Task failed: {:?}",
                current.result
            );
            sleep(Duration::from_millis(50)).await;
        }
    })
    .await??;
    // macOS CoreFoundation adds its text encoding variable inside the reporting process.
    let reported = result
        .strip_prefix("environment: ")
        .context("reporter result missing")?
        .split(',')
        .filter(|name| *name != "__CF_USER_TEXT_ENCODING")
        .collect::<Vec<_>>();
    // On Linux the guardian also names itself as the adapter's subreaper (a PID, no secret).
    let mut expected = vec!["PATH"];
    if cfg!(target_os = "linux") {
        expected.push("SUPERTAG_ADAPTER_REAPER");
    }
    expected.extend([
        "SUPERTAG_ADAPTER_STATE_DIRECTORY",
        "SUPERTAG_WORKSPACE_DIRECTORY",
        "TMPDIR",
    ]);
    assert_eq!(reported, expected);
    let log = fs::read_to_string(&supervisor.log)?;
    for value in [
        "file-openai",
        "file-codex",
        "file-cursor",
        "shell-codex",
        "file-gateway-token",
        password.as_str(),
    ] {
        assert!(!log.contains(value));
    }
    supervisor.stop().await?;
    Ok(())
}

/// A Control Plane outside the supervisor, so one Host test runs on either database.
struct Central {
    services: Vec<Child>,
    public: String,
    operator: String,
    _checkpoints: tempfile::TempDir,
}
impl Central {
    fn start(database: &str) -> Result<Self> {
        let checkpoints = tempfile::tempdir()?;
        let gateway_token =
            supertag_protocol::new_secret(supertag_protocol::CREDENTIAL_SECRET_PREFIX);
        let operator = Uuid::new_v4().simple().to_string();
        let listen = |child: &mut Child| -> Result<String> {
            let mut line = String::new();
            BufReader::new(child.stdout.take().context("service stdout missing")?)
                .read_line(&mut line)?;
            ensure!(!line.trim().is_empty(), "service did not bind");
            Ok(format!("http://{}", line.trim()))
        };
        let mut plane = reaped(Command::new(BIN))
            .args(["control-plane", "--listen", "127.0.0.1:0"])
            .env_clear()
            .env("SUPERTAG_DATABASE_URL", database)
            .env("SUPERTAG_BOOTSTRAP_GATEWAY_CREDENTIAL", &gateway_token)
            .env("SUPERTAG_GATEWAY_CREDENTIAL", &gateway_token)
            .env("SUPERTAG_OPERATOR_TOKEN", &operator)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .spawn()?;
        let public = listen(&mut plane);
        let services = vec![plane];
        let mut central = Self {
            services,
            public: String::new(),
            operator,
            _checkpoints: checkpoints,
        };
        central.public = public?;
        Ok(central)
    }
}
impl Drop for Central {
    fn drop(&mut self) {
        for child in &mut self.services {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// Runs a contract against a fresh SQLite file or a fresh PostgreSQL database.
async fn with_database<F, Fut>(postgres: bool, contract: F) -> Result<()>
where
    F: FnOnce(String) -> Fut,
    Fut: std::future::Future<Output = Result<()>>,
{
    use sqlx::Connection;
    // Each case starts from an already migrated store, so `up`'s Control Plane starts well
    // within its start timeout however loaded the machine is.
    if !postgres {
        let temp = tempfile::tempdir()?;
        let url = database::migrated_sqlite(temp.path(), "plane.db").await?;
        return contract(url).await;
    }
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .context("PostgreSQL URL file required")?;
    let admin_url = fs::read_to_string(path)?;
    let options =
        <sqlx::postgres::PgConnectOptions as std::str::FromStr>::from_str(admin_url.trim())?;
    let mut admin = sqlx::PgConnection::connect_with(&options).await?;
    let name = format!("supertag_slots_{}", Uuid::new_v4().simple());
    database::create_migrated_postgres(&mut admin, &options, &name).await?;
    let mut url = url::Url::parse(admin_url.trim())?;
    url.set_path(&name);
    let result = contract(url.to_string()).await;
    // A service the case left running may still hold connections.
    let cleanup = database::drop_database(&mut admin, &name).await;
    admin.close().await?;
    cleanup?;
    result
}

/// A shared Host whose Worklet runs gated Codex slots and gated OpenAI Agents slots.
struct SharedHost {
    temp: tempfile::TempDir,
    state: PathBuf,
    gate: PathBuf,
    supervisor: Process,
    control_plane: String,
    environment: Vec<(&'static str, String)>,
}
impl SharedHost {
    async fn start(central: &Central, concurrency: u32) -> Result<Self> {
        Self::start_with(central, serde_json::json!({ "concurrency": concurrency })).await
    }

    /// Start with `settings` replacing or adding entries of the Host's service definition.
    async fn start_with(central: &Central, settings: Value) -> Result<Self> {
        let temp = tempfile::tempdir()?;
        let gate = temp.path().join("gate");
        fs::create_dir_all(gate.join("started"))?;
        let bin = temp.path().join("bin");
        fs::create_dir(&bin)?;
        let gate_text = gate.to_str().context("UTF-8 gate")?;
        // OpenAI Agents runs `python3 -I -m ...`; this stand-in marks its start, waits at the
        // gate, then becomes the protocol fixture adapter.
        executables::write_executable(
            &bin.join("python3"),
            format!(
                "#!/bin/sh\ntest -z \"${{CODEX_API_KEY:-}}${{ANTHROPIC_API_KEY:-}}${{SUPERTAG_HOST_TOKEN:-}}\" || exit 3\n\
                 test \"${{OPENAI_API_KEY:-}}\" = fixture-openai || exit 4\n\
                 echo $$ > \"{gate_text}/started/agents-$$\"\n\
                 while [ ! -e \"{gate_text}/release\" ]; do sleep 0.05; done\n\
                 exec \"{ADAPTER}\" $(cat \"{gate_text}/adapter-args\" 2>/dev/null)\n"
            ),
            0o700,
        )?;
        // Answer the version probe without starting Python, which is slow on a loaded machine.
        let server = temp.path().join("gated_codex_app_server.py");
        fs::write(
            &server,
            include_str!("fixtures/gated_codex_app_server.py").replace("@GATE@", gate_text),
        )?;
        executables::write_executable(
            &bin.join("codex"),
            format!(
                "#!/bin/sh\nif [ \"$*\" = --version ]; then echo codex-cli 0.163.0; exit 0; fi\n\
                 exec /usr/bin/python3 \"{}\" \"$@\"\n",
                server.display()
            ),
            0o700,
        )?;
        // The first launch of a new executable can wait on macOS policy checks. Take that once
        // here, outside the adapter's bounded version probe.
        let probe = Command::new(bin.join("codex")).arg("--version").output()?;
        ensure!(probe.status.success() && probe.stdout.starts_with(b"codex-cli "));
        let home = temp.path().join("home");
        fs::create_dir(&home)?;
        let env_file = temp.path().join("services.env");
        fs::write(
            &env_file,
            "CODEX_API_KEY=fixture-codex\nOPENAI_API_KEY=fixture-openai\nANTHROPIC_API_KEY=fixture-anthropic\n",
        )?;
        fs::set_permissions(&env_file, fs::Permissions::from_mode(0o600))?;
        let mut operator = client(&central.public).await?;
        let key = supertag_protocol::new_secret(supertag_protocol::AUTH_KEY_SECRET_PREFIX);
        operator
            .create_auth_key(authenticated_request(
                CreateAuthKeyRequest {
                    name: "shared".into(),
                    role: supertag_protocol::v2::PrincipalRole::Host.into(),
                    operation_id: Uuid::new_v4().to_string(),
                    key_digest: Sha256::digest(key.as_bytes()).to_vec(),
                    expires_in_ms: 600000,
                    all_tags: true,
                    allowed_tag_ids: vec![],
                    ..Default::default()
                },
                &central.operator,
                None,
            )?)
            .await?;
        // A repository a `workspaces:` setting may map; nothing maps it unless asked.
        let source = temp.path().join("source");
        fs::create_dir(&source)?;
        git(&source, &["init", "--quiet", "--initial-branch=main"])?;
        fs::write(source.join("README.md"), "base\n")?;
        git(&source, &["add", "README.md"])?;
        git(&source, &["commit", "--quiet", "-m", "base"])?;
        let state = temp.path().join("state");
        let environment = vec![
            ("PATH", format!("{}:/usr/bin:/bin", bin.display())),
            ("HOME", home.to_str().context("UTF-8 home")?.to_owned()),
            ("FIXTURE_JOIN_KEY", key),
        ];
        let supervisor = launch(
            temp.path(),
            &state,
            &central.public,
            &settings,
            &environment,
        )?;
        Ok(Self {
            temp,
            state,
            gate,
            supervisor,
            control_plane: central.public.clone(),
            environment,
        })
    }

    /// Start a new supervisor on the same state with other Host settings.
    fn relaunch(&mut self, settings: &Value) -> Result<()> {
        self.supervisor = launch(
            self.temp.path(),
            &self.state,
            &self.control_plane,
            settings,
            &self.environment,
        )?;
        Ok(())
    }

    fn source(&self) -> PathBuf {
        self.temp.path().join("source")
    }

    /// Rewrite supertag.yaml with `settings` and run `supertag up` against the running
    /// supervisor; returns what it printed.
    fn up(&self, settings: &Value) -> Result<String> {
        let file = configure(self.temp.path(), &self.control_plane, settings)?;
        let output = reaped(Command::new(BIN))
            .args(["up", "--state-directory"])
            .arg(&self.state)
            .arg("--file")
            .arg(&file)
            .env_clear()
            .envs(self.environment.iter().map(|(name, value)| (*name, value)))
            .output()?;
        ensure!(
            output.status.success(),
            "supertag up failed: {}{}",
            String::from_utf8_lossy(&output.stderr),
            fs::read_to_string(&self.supervisor.log).unwrap_or_default()
        );
        Ok(String::from_utf8(output.stdout)?)
    }

    /// The marker and working directory a gated Codex harness process recorded.
    fn codex_start(&self, pid: i32) -> Result<(String, PathBuf)> {
        let text = fs::read_to_string(self.gate.join("started").join(format!("codex-{pid}")))?;
        let (marker, cwd) = text.split_once('\n').context("Codex start marker")?;
        Ok((marker.to_owned(), PathBuf::from(cwd)))
    }

    /// Start markers written by harness processes that reached the gate.
    fn started(&self) -> Result<Vec<(String, i32)>> {
        let mut started = Vec::new();
        for entry in fs::read_dir(self.gate.join("started"))? {
            let name = entry?.file_name().to_string_lossy().into_owned();
            let (harness, pid) = name.split_once('-').context("start marker")?;
            started.push((harness.to_owned(), pid.parse()?));
        }
        started.sort();
        Ok(started)
    }

    async fn wait_started(&self, codex: usize, agents: usize) -> Result<Vec<(String, i32)>> {
        timeout(WAIT, async {
            loop {
                let started = self.started()?;
                let count = |name| started.iter().filter(|(h, _)| h == name).count();
                if count("codex") == codex && count("agents") == agents {
                    break Ok::<_, anyhow::Error>(started);
                }
                ensure!(
                    count("codex") <= codex && count("agents") <= agents,
                    "more Attempts started than the Host's capacity allows: {started:?}"
                );
                sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .with_context(|| {
            format!(
                "gated harnesses did not start: {}",
                fs::read_to_string(&self.supervisor.log).unwrap_or_default()
            )
        })?
    }

    /// The shared Host's one Worklet process.
    fn worklet(&self) -> Result<(i32, String)> {
        let mut worklets = children(self.supervisor.child.id())?
            .into_iter()
            .filter(|(_, command)| {
                command.contains(" worklet ") && command.contains("/hosts/shared")
            })
            .collect::<Vec<_>>();
        ensure!(
            worklets.len() == 1,
            "the Host runs one Worklet: {worklets:?}"
        );
        Ok(worklets.remove(0))
    }

    /// The Worker processes the Worklet runs, one per running Task Attempt.
    fn workers(&self) -> Result<Vec<(i32, String)>> {
        let (worklet, _) = self.worklet()?;
        Ok(children(worklet as u32)?
            .into_iter()
            .filter(|(_, command)| command.contains(" __worker "))
            .collect())
    }

    /// What `supertag ps --output json` reports for the shared Host's state.
    fn ps(&self) -> Result<Value> {
        let output = reaped(Command::new(BIN))
            .args(["ps", "--output", "json", "--state-directory"])
            .arg(&self.state)
            .env_clear()
            .envs(self.environment.iter().map(|(name, value)| (*name, value)))
            .output()?;
        ensure!(
            output.status.success(),
            "supertag ps failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        Ok(serde_json::from_slice(&output.stdout)?)
    }

    /// The Host credential the Worklet enrolled with.
    fn credential(&self) -> Result<String> {
        let enrollment: Value =
            serde_json::from_slice(&fs::read(self.state.join("hosts/shared/enrollment.json"))?)?;
        Ok(enrollment["token"]
            .as_str()
            .context("host token")?
            .to_owned())
    }
}

fn launch(
    directory: &Path,
    state: &Path,
    control_plane: &str,
    settings: &Value,
    environment: &[(&'static str, String)],
) -> Result<Process> {
    let file = configure(directory, control_plane, settings)?;
    let environment = environment
        .iter()
        .map(|(name, value)| (*name, value.as_str()))
        .collect::<Vec<_>>();
    let supervisor = Process::spawn(state, Some(&file), &environment)?;
    assert_eq!(supervisor.ready()?, "ready");
    Ok(supervisor)
}

/// Write the shared Host's supertag.yaml with `settings` over its defaults.
fn configure(directory: &Path, control_plane: &str, settings: &Value) -> Result<PathBuf> {
    let mut host = serde_json::json!({
        "type":"host","control-plane":control_plane,"auth-key":"join",
        "harnesses":["codex","openai-agents"],"concurrency":1,
        "models":{"codex":["fixture-model"],"openai-agents":"fixture-model"}
    });
    for (name, value) in settings.as_object().context("Host settings")? {
        host[name] = value.clone();
    }
    let file = directory.join("supertag.yaml");
    yaml(
        &file,
        &serde_json::json!({"env_file":"services.env","services":{"shared":host},
            "secrets":{"join":{"environment":"FIXTURE_JOIN_KEY"}}}),
    )?;
    Ok(file)
}

fn git(directory: &Path, arguments: &[&str]) -> Result<String> {
    let output = Command::new("/usr/bin/git")
        .arg("-C")
        .arg(directory)
        .args([
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.com",
        ])
        .args(arguments)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .output()?;
    ensure!(
        output.status.success(),
        "git {arguments:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(String::from_utf8(output.stdout)?.trim().to_owned())
}

async fn tag(
    operator: &mut operator_client::OperatorClient<ProtocolChannel>,
    token: &str,
    id: &str,
    harness: HarnessKind,
) -> Result<()> {
    operator
        .put_tag(authenticated_request(
            PutTagRequest {
                tag_id: id.into(),
                instructions: "Shared Host fixture".into(),
                allowed_actions: vec!["files:read".into()],
                harness_kind: harness as i32,
                ..Default::default()
            },
            token,
            None,
        )?)
        .await?;
    Ok(())
}

async fn submit(
    operator: &mut operator_client::OperatorClient<ProtocolChannel>,
    token: &str,
    tag: &str,
    marker: &str,
) -> Result<String> {
    Ok(operator
        .submit_task(authenticated_request(
            SubmitTaskRequest {
                tag_id: tag.into(),
                session_id: marker.to_lowercase(),
                operation_id: Uuid::new_v4().to_string(),
                prompt: format!("Run {marker}"),
                ..Default::default()
            },
            token,
            None,
        )?)
        .await?
        .into_inner()
        .task_id)
}

async fn task(
    operator: &mut operator_client::OperatorClient<ProtocolChannel>,
    token: &str,
    id: &str,
) -> Result<Task> {
    Ok(operator
        .get_task(authenticated_request(
            GetTaskRequest { task_id: id.into() },
            token,
            None,
        )?)
        .await?
        .into_inner())
}

async fn settled(
    operator: &mut operator_client::OperatorClient<ProtocolChannel>,
    token: &str,
    id: &str,
    wanted: TaskState,
) -> Result<Task> {
    timeout(WAIT, async {
        loop {
            let current = task(operator, token, id).await?;
            if current.state() == wanted {
                break Ok::<_, anyhow::Error>(current);
            }
            ensure!(
                !matches!(
                    current.state(),
                    TaskState::Succeeded | TaskState::Failed | TaskState::Cancelled
                ),
                "Task {id} settled as {:?}: {:?}",
                current.state(),
                current.result
            );
            sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .with_context(|| format!("Task {id} did not reach {wanted:?}"))?
}

async fn host_until(
    operator: &mut operator_client::OperatorClient<ProtocolChannel>,
    token: &str,
    ready: impl Fn(&WorkerHostStatus) -> bool,
) -> Result<WorkerHostStatus> {
    timeout(WAIT, async {
        loop {
            let status = host(operator, token, "shared").await?;
            if ready(&status) {
                break Ok::<_, anyhow::Error>(status);
            }
            sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .context("shared Host did not report the expected presence")?
}

async fn shared_host_runs_harnesses_concurrently(database: String) -> Result<()> {
    let central = Central::start(&database)?;
    let token = central.operator.clone();
    let mut operator = client(&central.public).await?;
    // Four slots the two harnesses share, with Codex limited to two of them.
    let mut shared = SharedHost::start_with(
        &central,
        serde_json::json!({"concurrency": 4, "harness-limits": {"codex": 2}}),
    )
    .await?;
    // One registration advertises the pool and both harnesses within it.
    let ready = host_until(&mut operator, &token, |status| {
        status.phase() == HostPhase::Ready && status.available_slots == 4
    })
    .await?;
    let generation = ready.generation;
    assert_eq!(ready.capacity, 4);
    assert_eq!(ready.harness_kind(), HarnessKind::Unspecified);
    let advertised = ready
        .harnesses
        .iter()
        .map(|h| (h.harness_kind(), h.capacity, h.available_slots))
        .collect::<Vec<_>>();
    assert_eq!(
        advertised,
        [
            (HarnessKind::Codex, 2, 2),
            (HarnessKind::OpenaiAgents, 4, 4)
        ]
    );
    assert_eq!(
        ready.harnesses[0]
            .execution_profile
            .as_ref()
            .unwrap()
            .model_ids,
        ["fixture-model"]
    );
    // One Worklet runs both harnesses. It holds each harness's provider credentials from a file
    // it read and deleted, never its environment, and assigns each Worker only its own
    // harness's (the OpenAI Agents stand-in checks its own).
    let (worklet, command) = shared.worklet()?;
    if let Some(environment) = host_environment(worklet)? {
        let mut names = names(&environment);
        names.retain(|name| !["HOME", "PATH", "SUPERTAG_LOCAL_SERVICE_LIFELINE"].contains(name));
        assert_eq!(names, Vec::<&str>::new(), "{command}");
    }
    assert!(command.contains("--harness-set"), "{command}");
    assert!(shared.workers()?.is_empty(), "no Attempt runs yet");
    tag(&mut operator, &token, "coder", HarnessKind::Codex).await?;
    tag(&mut operator, &token, "agent", HarnessKind::OpenaiAgents).await?;
    let mut codex = Vec::new();
    for marker in ["Task-c1", "Task-c2", "Task-c3"] {
        codex.push(submit(&mut operator, &token, "coder", marker).await?);
    }
    let mut agents = Vec::new();
    for marker in ["Task-a1", "Task-a2"] {
        agents.push(submit(&mut operator, &token, "agent", marker).await?);
    }
    // Two harnesses run at once in the pool's four slots, and Codex runs only its limit of two.
    let started = match shared.wait_started(2, 2).await {
        Ok(started) => started,
        Err(error) => {
            let mut states = Vec::new();
            for id in codex.iter().chain(&agents) {
                let current = task(&mut operator, &token, id).await?;
                states.push(format!("{:?} {:?}", current.state(), current.result));
            }
            return Err(error.context(format!(
                "Task states: {states:?}; started: {:?}",
                shared.started()?
            )));
        }
    };
    sleep(Duration::from_secs(1)).await;
    assert_eq!(shared.started()?, started, "capacity was exceeded");
    let mut queued = 0;
    for id in &codex {
        if task(&mut operator, &token, id).await?.state() == TaskState::Queued {
            queued += 1;
        }
    }
    assert_eq!(
        queued, 1,
        "the third Codex Task must wait below the Codex limit"
    );
    let busy = host_until(&mut operator, &token, |status| {
        status.phase() == HostPhase::Busy && status.active_attempts == 4
    })
    .await?;
    assert_eq!(busy.available_slots, 0);
    // Each running Attempt has a Worker process of its own, which never holds the Host
    // credential: not in its arguments, and not in its environment, under any name.
    let credential = shared.credential()?;
    let workers = shared.workers()?;
    assert_eq!(workers.len(), 4, "{workers:?}");
    for (pid, command) in &workers {
        assert!(!command.contains(&credential), "{command}");
        if let Some(environment) = host_environment(*pid)? {
            assert!(
                !environment.contains_key("SUPERTAG_HOST_TOKEN"),
                "{command}"
            );
            assert!(
                environment
                    .values()
                    .all(|value| !value.contains(&credential)),
                "{command}"
            );
        }
    }

    // One harness process crashes. Its Attempt fails; the sibling Attempts, their Workers, and
    // the Worklet continue.
    let crashed = started
        .iter()
        .find(|(harness, _)| harness == "agents")
        .context("agents start marker")?
        .1;
    unsafe {
        libc::kill(crashed, libc::SIGKILL);
    }
    let mut failed = None;
    timeout(WAIT, async {
        loop {
            for id in &agents {
                if task(&mut operator, &token, id).await?.state() == TaskState::Failed {
                    failed = Some(id.clone());
                }
            }
            if failed.is_some() {
                break Ok::<_, anyhow::Error>(());
            }
            sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .with_context(|| {
        format!(
            "crashed Attempt did not fail: {}",
            fs::read_to_string(&shared.supervisor.log).unwrap_or_default()
        )
    })??;
    let failed = failed.expect("failed Attempt");
    for id in codex
        .iter()
        .take(2)
        .chain(agents.iter().filter(|id| **id != failed))
    {
        let current = task(&mut operator, &token, id).await?;
        assert!(
            matches!(current.state(), TaskState::Running | TaskState::Queued),
            "a sibling Attempt was disturbed: {:?}",
            current.state()
        );
    }
    assert_eq!(
        shared.worklet()?.0,
        worklet,
        "a harness crash must not restart the Worklet"
    );
    let siblings = shared
        .workers()?
        .into_iter()
        .map(|(pid, _)| pid)
        .collect::<Vec<_>>();
    assert_eq!(siblings.len(), 3, "the crashed Attempt's Worker exits");
    assert!(
        siblings
            .iter()
            .all(|pid| workers.iter().any(|(running, _)| running == pid)),
        "a harness crash must not restart a sibling Worker"
    );
    assert_eq!(
        host(&mut operator, &token, "shared").await?.generation,
        generation
    );

    fs::write(shared.gate.join("release"), "")?;
    for (id, marker) in codex.iter().zip(["Task-c1", "Task-c2", "Task-c3"]) {
        let done = settled(&mut operator, &token, id, TaskState::Succeeded).await?;
        assert_eq!(
            done.result.as_deref(),
            Some(format!("codex finished {marker}").as_str())
        );
    }
    for (id, marker) in agents.iter().zip(["Task-a1", "Task-a2"]) {
        if *id == failed {
            continue;
        }
        let done = settled(&mut operator, &token, id, TaskState::Succeeded).await?;
        assert!(done.result.unwrap_or_default().contains(marker));
    }
    let idle = host_until(&mut operator, &token, |status| {
        status.phase() == HostPhase::Ready && status.available_slots == 4
    })
    .await?;
    assert_eq!(idle.generation, generation);
    assert_eq!(shared.worklet()?.0, worklet);
    assert!(
        shared.workers()?.is_empty(),
        "each Worker exits with its Attempt"
    );
    shared.supervisor.stop().await?;
    Ok(())
}

/// A lead on OpenAI Agents starts a Work Session that names Codex: the Work Session runs as Codex
/// in the shared host's one slot, and its report returns to the lead's Session on OpenAI Agents.
async fn shared_host_runs_a_work_session_on_another_harness(database: String) -> Result<()> {
    let central = Central::start(&database)?;
    let token = central.operator.clone();
    let mut operator = client(&central.public).await?;
    // One slot, which the lead's harness and the Work Session's take in turn.
    let mut shared = SharedHost::start(&central, 1).await?;
    host_until(&mut operator, &token, |status| {
        status.phase() == HostPhase::Ready && status.available_slots == 1
    })
    .await?;
    fs::write(
        shared.gate.join("adapter-args"),
        "--work-session-harness=codex",
    )?;
    fs::write(shared.gate.join("release"), "")?;
    tag(&mut operator, &token, "lead", HarnessKind::OpenaiAgents).await?;
    let parent = submit(&mut operator, &token, "lead", "Task-a1").await?;
    let log = |shared: &SharedHost| fs::read_to_string(&shared.supervisor.log).unwrap_or_default();
    let done = settled(&mut operator, &token, &parent, TaskState::Succeeded)
        .await
        .with_context(|| format!("lead turn: {}", log(&shared)))?;
    assert_eq!(done.harness_kind(), HarnessKind::OpenaiAgents);
    let mut work = work_sessions_client::WorkSessionsClient::new(
        protocol::dial(central.public.clone()).await?,
    );
    let listed = work
        .list(authenticated_request(
            ListWorkSessionsRequest {
                parent_tag_id: "lead".into(),
                parent_session_id: "task-a1".into(),
                ..Default::default()
            },
            &token,
            None,
        )?)
        .await?
        .into_inner();
    ensure!(listed.work_sessions.len() == 1, "{listed:?}");
    let child = &listed.work_sessions[0].latest_task_id;
    let finished = settled(&mut operator, &token, child, TaskState::Succeeded)
        .await
        .with_context(|| format!("Work Session turn: {}", log(&shared)))?;
    assert_eq!(finished.harness_kind(), HarnessKind::Codex);
    assert_eq!(finished.tag_id, "lead");
    assert_eq!(
        finished.result.as_deref(),
        Some("codex finished Task-child")
    );
    let started = shared.started()?;
    ensure!(
        started.iter().any(|(harness, _)| harness == "codex"),
        "the Work Session did not run in a Codex slot: {started:?}"
    );
    shared.supervisor.stop().await?;
    Ok(())
}

async fn replaced_shared_host_fences_every_slot(database: String) -> Result<()> {
    let central = Central::start(&database)?;
    let token = central.operator.clone();
    let mut operator = client(&central.public).await?;
    // Two busy and two idle slots: idle slots meet the fence in their claim loop.
    let mut shared = SharedHost::start(&central, 4).await?;
    let ready = host_until(&mut operator, &token, |status| {
        status.phase() == HostPhase::Ready && status.available_slots == 4
    })
    .await?;
    tag(&mut operator, &token, "coder", HarnessKind::Codex).await?;
    tag(&mut operator, &token, "agent", HarnessKind::OpenaiAgents).await?;
    let ids = [
        submit(&mut operator, &token, "coder", "Task-c1").await?,
        submit(&mut operator, &token, "agent", "Task-a1").await?,
    ];
    for id in &ids {
        settled(&mut operator, &token, id, TaskState::Running).await?;
    }
    if let Err(error) = shared.wait_started(1, 1).await {
        let mut states = Vec::new();
        for id in &ids {
            let current = task(&mut operator, &token, id).await?;
            states.push(format!("{:?} {:?}", current.state(), current.result));
        }
        return Err(error.context(format!("Task states: {states:?}")));
    }
    let mut processes = shared
        .workers()?
        .into_iter()
        .map(|(pid, _)| pid)
        .collect::<Vec<_>>();
    processes.push(shared.worklet()?.0);
    // Another process presents this Host's credential with a different incarnation.
    let credential = shared.credential()?;
    let credential = credential.as_str();
    let replaced =
        worker_host_client::WorkerHostClient::new(protocol::dial(central.public.clone()).await?)
            .register_host(authenticated_request(
                RegisterHostRequest {
                    incarnation_id: Uuid::new_v4().to_string(),
                },
                credential,
                None,
            )?)
            .await?
            .into_inner();
    // Let the stale Workers' harnesses finish now, so they try to complete their Attempts under
    // the replaced generation before anything stops them.
    fs::write(shared.gate.join("release"), "")?;
    assert!(replaced.generation > ready.generation);
    // Both slots' Attempts belong to the replaced generation and are fenced together.
    for id in &ids {
        let fenced = task(&mut operator, &token, id).await?;
        assert_eq!(fenced.state(), TaskState::Uncertain);
    }
    // The stale registration can no longer report presence or run work: its Worklet stops, and
    // only it. The supervisor runs on and does not start it again, which would fence the
    // registration that replaced it in turn.
    gone(&processes).await?;
    let ps = timeout(WAIT, async {
        loop {
            let ps = shared.ps()?;
            if ps["services"][0]["state"] == "fenced" {
                break Ok::<_, anyhow::Error>(ps);
            }
            sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .with_context(|| {
        format!(
            "ps never showed the Host fenced: {}",
            fs::read_to_string(&shared.supervisor.log).unwrap_or_default()
        )
    })??;
    assert!(
        ps["services"][0]["fenced"]
            .as_str()
            .is_some_and(|reason| reason.contains("is no longer current")),
        "{ps}"
    );
    assert!(ps["services"][0].get("pid").is_none(), "{ps}");
    sleep(Duration::from_secs(2)).await;
    assert!(
        shared.supervisor.child.try_wait()?.is_none(),
        "a fenced Host took the supervisor down: {}",
        fs::read_to_string(&shared.supervisor.log)?
    );
    ensure!(
        shared.worklet().is_err(),
        "the supervisor started the fenced Host again"
    );
    // The Worklet's presence names the fenced registration, whichever slot or report noticed
    // first, and the supervisor reports that.
    let log = fs::read_to_string(&shared.supervisor.log)?;
    assert!(log.contains("is no longer current"), "{log}");
    assert!(
        log.contains("Another process registered this Worker Host"),
        "{log}"
    );
    assert!(!log.contains("exited unexpectedly"), "{log}");
    // No stale Worker completed or renewed its Attempt under the old generation.
    for id in &ids {
        assert_eq!(
            task(&mut operator, &token, id).await?.state(),
            TaskState::Uncertain
        );
    }
    // The supervisor still stops cleanly.
    shared.supervisor.stop().await?;
    Ok(())
}

async fn a_client_stream_through_the_gateway_does_not_hold_up_shutdown(
    database: String,
) -> Result<()> {
    let temp = tempfile::tempdir()?;
    let state = temp.path().join("state");
    let file = temp.path().join("supertag.yaml");
    yaml(
        &file,
        &serde_json::json!({"services":{"control-plane":{"type":"control-plane","ports":["127.0.0.1:0"]}}}),
    )?;
    let mut supervisor = Process::spawn(&state, Some(&file), &database_env(&database))?;
    supervisor.ready()?;
    uses_database(&state, &database)?;
    // A desktop app or TUI follows the operator's events through the Gateway, a stream that
    // never ends on its own.
    let gateway = fs::read_to_string(state.join("gateway-endpoint"))?;
    let mut events =
        operator_events_client::OperatorEventsClient::new(protocol::dial(gateway.trim()).await?);
    let mut watch = events
        .watch(authenticated_request(
            WatchRequest::default(),
            &token(&state)?,
            None,
        )?)
        .await?
        .into_inner();
    timeout(WAIT, watch.message())
        .await??
        .context("the Watch handshake")?;
    // The Gateway ends the stream and stops well within the twelve seconds the supervisor gives
    // it, so stopping succeeds and kills nothing.
    let started = std::time::Instant::now();
    supervisor.stop().await?;
    let took = started.elapsed();
    let log = fs::read_to_string(&supervisor.log)?;
    assert!(
        took < Duration::from_secs(6),
        "stopping took {took:?}: {log}"
    );
    assert!(!log.contains("did not stop"), "{log}");
    // The client sees UNAVAILABLE, or the connection closing, and reconnects.
    match timeout(WAIT, watch.message()).await? {
        Err(status) => assert_eq!(status.code(), tonic::Code::Unavailable, "{status}"),
        Ok(message) => panic!("the stream went on after the Gateway stopped: {message:?}"),
    }
    Ok(())
}

async fn a_host_that_cannot_record_presence_keeps_running_and_is_not_called_fenced(
    database: String,
) -> Result<()> {
    let central = Central::start(&database)?;
    let token = central.operator.clone();
    let mut operator = client(&central.public).await?;
    let mut shared = SharedHost::start(&central, 1).await?;
    host_until(&mut operator, &token, |status| {
        status.phase() == HostPhase::Ready
    })
    .await?;
    let (worklet, _) = shared.worklet()?;
    let host_log = shared.state.join("logs/hosts/shared.log");
    // The host's state directory takes no new files, as with a full disk: its presence
    // sequence can't be recorded.
    let directory = shared.state.join("hosts/shared");
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o500))?;
    let unrecorded = timeout(WAIT, async {
        loop {
            let log = fs::read_to_string(&host_log).unwrap_or_default();
            if log.contains("could not record its next presence report") {
                break Ok::<_, anyhow::Error>(log);
            }
            sleep(Duration::from_millis(100)).await;
        }
    })
    .await;
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?;
    let log = unrecorded.with_context(|| {
        format!(
            "the Worklet never said it could not record presence: {}",
            fs::read_to_string(&host_log).unwrap_or_default()
        )
    })??;
    assert!(!log.contains("is no longer current"), "{log}");
    // The Worklet kept running under the same registration and reports again.
    timeout(WAIT, async {
        loop {
            let log = fs::read_to_string(&host_log).unwrap_or_default();
            if log.contains("records its presence reports again") {
                break;
            }
            sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .context("the Worklet did not report again")?;
    assert_eq!(shared.worklet()?.0, worklet);
    assert!(shared.supervisor.child.try_wait()?.is_none());
    host_until(&mut operator, &token, |status| {
        status.phase() == HostPhase::Ready
    })
    .await?;
    let supervisor_log = fs::read_to_string(&shared.supervisor.log)?;
    assert!(
        !supervisor_log.contains("is no longer current"),
        "{supervisor_log}"
    );
    shared.supervisor.stop().await?;
    Ok(())
}

async fn shared_host_slots_use_separate_workspace_checkouts(database: String) -> Result<()> {
    let central = Central::start(&database)?;
    let token = central.operator.clone();
    let mut operator = client(&central.public).await?;
    let shared = SharedHost::start_with(
        &central,
        serde_json::json!({"concurrency": 2, "workspaces": {"repo": "./source"}}),
    )
    .await?;
    let ready = host_until(&mut operator, &token, |status| {
        status.phase() == HostPhase::Ready && status.available_slots == 2
    })
    .await?;
    assert_eq!(ready.workspace_ids, ["repo"]);
    let base = git(&shared.source(), &["rev-parse", "HEAD"])?;
    operator
        .put_tag(authenticated_request(
            PutTagRequest {
                tag_id: "coder".into(),
                instructions: "Shared Host Workspace fixture".into(),
                allowed_actions: vec!["files:read".into(), "files:write".into()],
                harness_kind: HarnessKind::Codex as i32,
                workspace: Some(WorkspaceSpec {
                    base_ref: String::new(),
                    workspace_id: "repo".into(),
                    base_commit: base.clone(),
                    mounts: vec![],
                    remote: None,
                    merge_commit: String::new(),
                    author_name: String::new(),
                    author_email: String::new(),
                    co_author: String::new(),
                    mcp_servers: vec![],
                }),
                ..Default::default()
            },
            &token,
            None,
        )?)
        .await?;
    let first = submit(&mut operator, &token, "coder", "Task-w1").await?;
    let second = submit(&mut operator, &token, "coder", "Task-w2").await?;
    // Both Attempts run at once from the one configured source, each in its own checkout: Codex
    // takes both slots of the pool while OpenAI Agents has no work.
    let started = shared.wait_started(2, 0).await?;
    let mut checkouts = Vec::new();
    for (_, pid) in &started {
        checkouts.push(shared.codex_start(*pid)?);
    }
    checkouts.sort();
    let slots = shared.state.join("hosts/shared/slots").canonicalize()?;
    let mut owners = Vec::new();
    for (marker, checkout) in &checkouts {
        let slot = checkout
            .strip_prefix(&slots)
            .with_context(|| format!("{} is not in a slot", checkout.display()))?
            .components()
            .next()
            .context("slot directory")?
            .as_os_str()
            .to_string_lossy()
            .into_owned();
        assert!(slot.parse::<u32>().is_ok(), "{slot}");
        assert_eq!(
            fs::read_to_string(slots.join(&slot).join("harness"))?,
            "codex"
        );
        owners.push(slot);
        assert_eq!(fs::read_to_string(checkout.join("README.md"))?, "base\n");
        let others = ["Task-w1", "Task-w2"]
            .into_iter()
            .filter(|other| other != marker)
            .collect::<Vec<_>>();
        assert!(checkout.join(format!("{marker}.txt")).exists());
        for other in others {
            assert!(
                !checkout.join(format!("{other}.txt")).exists(),
                "{marker}'s checkout saw {other}'s edit"
            );
        }
    }
    assert_ne!(owners[0], owners[1], "both Attempts ran in one slot");

    // The first Attempt delivers while its sibling still runs in the same Workspace.
    fs::write(shared.gate.join("release-Task-w1"), "")?;
    let done = settled(&mut operator, &token, &first, TaskState::Succeeded).await?;
    let delivery = done.workspace_delivery.context("first delivery")?;
    assert_eq!(
        (
            delivery.workspace_id.as_str(),
            delivery.base_commit.as_str()
        ),
        ("repo", base.as_str())
    );
    assert!(delivery.committed);
    assert_eq!(delivery.changed_files, 1);
    assert_eq!(
        task(&mut operator, &token, &second).await?.state(),
        TaskState::Running
    );
    assert!(checkouts[1].1.join("Task-w2.txt").exists());
    fs::write(shared.gate.join("release-Task-w2"), "")?;
    let done = settled(&mut operator, &token, &second, TaskState::Succeeded).await?;
    let sibling = done.workspace_delivery.context("second delivery")?;
    assert!(sibling.committed);
    assert_eq!(sibling.changed_files, 1);
    assert_eq!(sibling.start_commit, base);
    assert_ne!(sibling.head_commit, delivery.head_commit);
    // Delivery leaves the operator's source repository untouched.
    assert_eq!(git(&shared.source(), &["status", "--porcelain"])?, "");
    assert_eq!(git(&shared.source(), &["rev-parse", "HEAD"])?, base);
    let mut shared = shared;
    shared.supervisor.stop().await?;
    Ok(())
}

async fn stranded_slot_attempts_are_fenced_on_restart(database: String) -> Result<()> {
    let central = Central::start(&database)?;
    let token = central.operator.clone();
    let mut operator = client(&central.public).await?;
    let mut shared = SharedHost::start(&central, 1).await?;
    host_until(&mut operator, &token, |status| {
        status.phase() == HostPhase::Ready && status.available_slots == 1
    })
    .await?;
    tag(&mut operator, &token, "coder", HarnessKind::Codex).await?;
    let id = submit(&mut operator, &token, "coder", "Task-c1").await?;
    settled(&mut operator, &token, &id, TaskState::Running).await?;
    let started = shared.wait_started(1, 0).await?;
    let generation = host(&mut operator, &token, "shared").await?.generation;
    // The machine stops abruptly: the slot's journal entry still holds its running Codex Attempt.
    let mut killed = shared
        .workers()?
        .into_iter()
        .map(|(pid, _)| pid)
        .collect::<Vec<_>>();
    killed.push(shared.worklet()?.0);
    killed.extend(started.iter().map(|(_, pid)| *pid));
    killed.push(shared.supervisor.child.id() as i32);
    for pid in &killed {
        unsafe {
            libc::kill(*pid, libc::SIGKILL);
        }
    }
    let _ = shared.supervisor.child.wait();
    gone(&killed).await?;
    let slot = shared.state.join("hosts/shared/slots/0");
    assert!(slot.join("attempt.json").exists());
    assert_eq!(fs::read_to_string(slot.join("harness"))?, "codex");
    assert_eq!(
        task(&mut operator, &token, &id).await?.state(),
        TaskState::Running
    );

    // The Host comes back without Codex. No harness will read that entry, so the Worklet retires
    // it, registers a new incarnation, and its Attempt is fenced now, not at lease expiry.
    let agents_only = serde_json::json!({
        "harnesses": ["openai-agents"],
        "models": {"openai-agents": "fixture-model"},
    });
    shared.relaunch(&agents_only)?;
    let fenced = task(&mut operator, &token, &id).await?;
    assert_eq!(fenced.state(), TaskState::Uncertain);
    let replaced = host(&mut operator, &token, "shared").await?;
    assert!(replaced.generation > generation);
    // As for any Host whose journal is gone, the fenced Attempt holds a slot until the operator
    // confirms it stopped.
    host_until(&mut operator, &token, |status| {
        status.phase() == HostPhase::Busy && status.active_attempts == 1
    })
    .await?;
    operator
        .resolve_attempt(authenticated_request(
            ResolveAttemptRequest {
                task_id: id.clone(),
                attempt_id: fenced.attempt_id.clone().context("fenced Attempt")?,
                operation_id: Uuid::new_v4().to_string(),
                decision: AttemptDecision::Failed as i32,
                evidence: "the Codex harness was removed and its processes are gone".into(),
                confirmed_stopped: true,
            },
            &token,
            None,
        )?)
        .await?;
    host_until(&mut operator, &token, |status| {
        status.phase() == HostPhase::Ready && status.available_slots == 1
    })
    .await?;
    // The new pool's slot 0 started afresh, and the stranded one keeps its Codex entry.
    assert_ne!(
        fs::read_to_string(slot.join("harness")).ok().as_deref(),
        Some("codex")
    );
    let retired = fs::read_dir(shared.state.join("hosts/shared/retired"))?
        .map(|entry| Ok(entry?.path().join("0")))
        .collect::<Result<Vec<_>>>()?;
    assert_eq!(retired.len(), 1);
    assert!(retired[0].join("attempt.json").exists());
    assert_eq!(fs::read_to_string(retired[0].join("harness"))?, "codex");

    // With nothing stranded, a restart replays the incarnation and keeps the generation.
    shared.supervisor.stop().await?;
    shared.relaunch(&agents_only)?;
    let again = host_until(&mut operator, &token, |status| {
        status.phase() == HostPhase::Ready && status.available_slots == 1
    })
    .await?;
    assert_eq!(again.generation, replaced.generation);
    shared.supervisor.stop().await?;
    Ok(())
}

/// `tests/concurrency-request.test.ts`: `supertag up` with only a host's `concurrency` changed
/// resizes its Worklet's pool in place. Running work continues, the Worklet, the registration,
/// and its generation stay, and a lowered slot finishes its Attempt before it retires.
async fn concurrency_changes_without_a_restart(database: String) -> Result<()> {
    let central = Central::start(&database)?;
    let token = central.operator.clone();
    let mut operator = client(&central.public).await?;
    let shared = SharedHost::start(&central, 1).await?;
    let ready = host_until(&mut operator, &token, |status| {
        status.phase() == HostPhase::Ready && status.capacity == 1
    })
    .await?;
    tag(&mut operator, &token, "coder", HarnessKind::Codex).await?;
    let first = submit(&mut operator, &token, "coder", "Task-c1").await?;
    settled(&mut operator, &token, &first, TaskState::Running).await?;
    shared.wait_started(1, 0).await?;
    let second = submit(&mut operator, &token, "coder", "Task-c2").await?;
    sleep(Duration::from_millis(500)).await;
    assert_eq!(
        task(&mut operator, &token, &second).await?.state(),
        TaskState::Queued,
        "the pool's one slot runs one Attempt"
    );
    let supervisor = shared.supervisor.child.id();
    let (worklet, _) = shared.worklet()?;

    // Raised: a second slot starts under the same registration and takes the queued Task while
    // the first keeps running.
    let printed = shared.up(&serde_json::json!({"concurrency": 2}))?;
    ensure!(
        printed.contains(
            "Worker Host shared runs up to 2 Task Attempts at once, changed from 1 without a restart."
        ),
        "{printed}"
    );
    settled(&mut operator, &token, &second, TaskState::Running).await?;
    shared.wait_started(2, 0).await?;
    let raised = host_until(&mut operator, &token, |status| status.capacity == 2).await?;
    assert_eq!(raised.generation, ready.generation);
    assert_eq!(
        task(&mut operator, &token, &first).await?.state(),
        TaskState::Running
    );
    // An unchanged file leaves everything alone.
    let printed = shared.up(&serde_json::json!({"concurrency": 2}))?;
    ensure!(printed.contains("left alone"), "{printed}");

    // Lowered: capacity drops at once, and the extra slot retires once its Attempt finished.
    let printed = shared.up(&serde_json::json!({"concurrency": 1}))?;
    ensure!(
        printed.contains("changed from 2 without a restart"),
        "{printed}"
    );
    host_until(&mut operator, &token, |status| status.capacity == 1).await?;
    assert_eq!(
        task(&mut operator, &token, &second).await?.state(),
        TaskState::Running,
        "a lowered slot keeps its running Attempt"
    );
    fs::write(shared.gate.join("release"), "")?;
    settled(&mut operator, &token, &first, TaskState::Succeeded).await?;
    settled(&mut operator, &token, &second, TaskState::Succeeded).await?;
    timeout(WAIT, async {
        loop {
            let entry = ["attempt.json", "claim.json"].iter().any(|name| {
                shared
                    .state
                    .join("hosts/shared/slots/1")
                    .join(name)
                    .exists()
            });
            if !entry && shared.workers()?.is_empty() {
                break Ok::<_, anyhow::Error>(());
            }
            sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .context("the lowered slot did not retire")??;
    assert_eq!(shared.worklet()?.0, worklet, "a resize keeps the Worklet");
    let third = submit(&mut operator, &token, "coder", "Task-c3").await?;
    settled(&mut operator, &token, &third, TaskState::Succeeded).await?;
    assert_eq!(shared.supervisor.child.id(), supervisor);
    let lowered = host(&mut operator, &token, "shared").await?;
    assert_eq!(lowered.generation, ready.generation);
    // The supervisor reports what it now runs.
    let status: Value = serde_json::from_slice(&fs::read(shared.state.join("supervisor.json"))?)?;
    assert_eq!(status["pid"], supervisor);
    assert_eq!(status["services"][0]["concurrency"], 1);

    // A raised slot that cannot start stays stopped; the Worklet and its other slots go on.
    let blocked = shared.state.join("hosts/shared/slots/2");
    fs::write(&blocked, "not a directory")?;
    let printed = shared.up(&serde_json::json!({"concurrency": 3}))?;
    ensure!(
        printed.contains("changed from 1 without a restart"),
        "{printed}"
    );
    assert_eq!(shared.supervisor.child.id(), supervisor);
    // The Worklet resizes its pool when it reads the new size, just after `up` returns.
    let log = timeout(WAIT, async {
        loop {
            let log =
                fs::read_to_string(shared.state.join("logs/hosts/shared.log")).unwrap_or_default();
            if log.contains("slot 2 did not start and stays stopped") {
                break log;
            }
            sleep(Duration::from_millis(100)).await;
        }
    })
    .await;
    ensure!(
        log.is_ok(),
        "{}",
        fs::read_to_string(shared.state.join("logs/hosts/shared.log")).unwrap_or_default()
    );
    let fourth = submit(&mut operator, &token, "coder", "Task-c4").await?;
    settled(&mut operator, &token, &fourth, TaskState::Succeeded).await?;
    assert_eq!(shared.supervisor.child.id(), supervisor);
    fs::remove_file(&blocked)?;
    assert_eq!(shared.worklet()?.0, worklet);
    // The slot that ran it clears its journal entry after the Task settles.
    timeout(WAIT, async {
        while ["0", "1"].iter().any(|slot| {
            shared
                .state
                .join(format!("hosts/shared/slots/{slot}/attempt.json"))
                .exists()
        }) {
            sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .context("a slot kept its Attempt's journal entry")?;

    let mut shared = shared;
    shared.supervisor.stop().await?;
    // A request no supervisor applied does not resize the next one away from its file.
    fs::write(
        shared.state.join("concurrency-request.json"),
        serde_json::to_vec(&serde_json::json!({
            "fingerprint": "stale",
            "hosts": {"shared": 4}
        }))?,
    )?;
    // Nothing was stranded: a restart keeps the registration.
    shared.relaunch(&serde_json::json!({"concurrency": 1}))?;
    let again = host_until(&mut operator, &token, |status| {
        status.phase() == HostPhase::Ready && status.capacity == 1
    })
    .await?;
    assert_eq!(again.generation, ready.generation);
    assert!(!shared.state.join("concurrency-request.json").exists());
    sleep(Duration::from_millis(500)).await;
    assert_eq!(host(&mut operator, &token, "shared").await?.capacity, 1);
    let status: Value = serde_json::from_slice(&fs::read(shared.state.join("supervisor.json"))?)?;
    assert_eq!(status["services"][0]["concurrency"], 1);
    assert_ne!(status["fingerprint"], "stale");
    shared.supervisor.stop().await?;
    Ok(())
}

/// A host service maps a remote Workspace with `remote: true`: the host serves it beside a local
/// one, and `supertag up` says when its Control Plane does not define it yet.
async fn a_host_service_serves_a_remote_workspace(database: String) -> Result<()> {
    let temp = tempfile::tempdir()?;
    let state = temp.path().join("state");
    let file = temp.path().join("supertag.yaml");
    let source = temp.path().join("app");
    fs::create_dir(&source)?;
    let (section, secrets) = if database.starts_with("postgres") {
        database_password::config(&database, temp.path())?
    } else {
        (Value::Null, serde_json::json!({}))
    };
    yaml(
        &file,
        &serde_json::json!({"version":1,"secrets":secrets,"services":{
            "control-plane":{"type":"control-plane","ports":["127.0.0.1:0"],"database":section},
            "shared":{"type":"host","adapter":ADAPTER,"concurrency":1,
                "workspaces":{"app":source,"handbook":{"remote":true}}}
        }}),
    )?;
    let mut supervisor = Process::spawn(&state, Some(&file), &[])?;
    let endpoint = supervisor.ready()?;
    let credential = token(&state)?;
    let mut operator = client(&endpoint).await?;
    let ready = host_until(&mut operator, &credential, |status| {
        status.phase() == HostPhase::Ready && status.workspace_ids.len() == 2
    })
    .await?;
    let mut ids = ready.workspace_ids.clone();
    ids.sort();
    assert_eq!(ids, ["app", "handbook"]);
    let log = fs::read_to_string(&supervisor.log)?;
    assert!(
        log.contains("remote Workspace handbook is not defined on this Control Plane"),
        "{log}"
    );
    supervisor.stop().await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sqlite_a_host_service_serves_a_remote_workspace() -> Result<()> {
    with_database(false, a_host_service_serves_a_remote_workspace).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires an isolated PostgreSQL server via SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"]
async fn postgres_a_host_service_serves_a_remote_workspace() -> Result<()> {
    with_database(true, a_host_service_serves_a_remote_workspace).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sqlite_concurrency_changes_without_a_restart() -> Result<()> {
    with_database(false, concurrency_changes_without_a_restart).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires an isolated PostgreSQL server via SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"]
async fn postgres_concurrency_changes_without_a_restart() -> Result<()> {
    with_database(true, concurrency_changes_without_a_restart).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sqlite_shared_host_slots_use_separate_workspace_checkouts() -> Result<()> {
    with_database(false, shared_host_slots_use_separate_workspace_checkouts).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires an isolated PostgreSQL server via SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"]
async fn postgres_shared_host_slots_use_separate_workspace_checkouts() -> Result<()> {
    with_database(true, shared_host_slots_use_separate_workspace_checkouts).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sqlite_stranded_slot_attempts_are_fenced_on_restart() -> Result<()> {
    with_database(false, stranded_slot_attempts_are_fenced_on_restart).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires an isolated PostgreSQL server via SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"]
async fn postgres_stranded_slot_attempts_are_fenced_on_restart() -> Result<()> {
    with_database(true, stranded_slot_attempts_are_fenced_on_restart).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sqlite_shared_host_runs_two_harnesses_concurrently_within_capacity() -> Result<()> {
    with_database(false, shared_host_runs_harnesses_concurrently).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires an isolated PostgreSQL server via SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"]
async fn postgres_shared_host_runs_two_harnesses_concurrently_within_capacity() -> Result<()> {
    with_database(true, shared_host_runs_harnesses_concurrently).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sqlite_shared_host_runs_a_work_session_on_another_harness() -> Result<()> {
    with_database(false, shared_host_runs_a_work_session_on_another_harness).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires an isolated PostgreSQL server via SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"]
async fn postgres_shared_host_runs_a_work_session_on_another_harness() -> Result<()> {
    with_database(true, shared_host_runs_a_work_session_on_another_harness).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sqlite_replaced_shared_host_generation_fences_every_slot() -> Result<()> {
    with_database(false, replaced_shared_host_fences_every_slot).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires an isolated PostgreSQL server via SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"]
async fn postgres_replaced_shared_host_generation_fences_every_slot() -> Result<()> {
    with_database(true, replaced_shared_host_fences_every_slot).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sqlite_a_client_stream_through_the_gateway_does_not_hold_up_shutdown() -> Result<()> {
    with_database(
        false,
        a_client_stream_through_the_gateway_does_not_hold_up_shutdown,
    )
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires an isolated PostgreSQL server via SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"]
async fn postgres_a_client_stream_through_the_gateway_does_not_hold_up_shutdown() -> Result<()> {
    with_database(
        true,
        a_client_stream_through_the_gateway_does_not_hold_up_shutdown,
    )
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sqlite_a_host_that_cannot_record_presence_keeps_running() -> Result<()> {
    with_database(
        false,
        a_host_that_cannot_record_presence_keeps_running_and_is_not_called_fenced,
    )
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires an isolated PostgreSQL server via SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"]
async fn postgres_a_host_that_cannot_record_presence_keeps_running() -> Result<()> {
    with_database(
        true,
        a_host_that_cannot_record_presence_keeps_running_and_is_not_called_fenced,
    )
    .await
}

/// One recorded webhook POST: its Authorization header and JSON body.
async fn webhook_mock() -> Result<(
    String,
    std::sync::Arc<tokio::sync::Mutex<Vec<(String, Value)>>>,
)> {
    answering_mock(None).await
}

/// A loopback HTTP mock that records each request's authorization and JSON body, and answers
/// `200` with `body`, or `204` without one.
async fn answering_mock(
    body: Option<&'static str>,
) -> Result<(
    String,
    std::sync::Arc<tokio::sync::Mutex<Vec<(String, Value)>>>,
)> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}/hook", listener.local_addr()?);
    let requests = std::sync::Arc::new(tokio::sync::Mutex::new(Vec::new()));
    let recorded = requests.clone();
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            let mut bytes = Vec::new();
            let mut buffer = [0_u8; 4096];
            let parsed = loop {
                let Ok(count) = stream.read(&mut buffer).await else {
                    break None;
                };
                if count == 0 {
                    break None;
                }
                bytes.extend_from_slice(&buffer[..count]);
                let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") else {
                    continue;
                };
                let head = String::from_utf8_lossy(&bytes[..end]).to_string();
                let header = |name: &str| {
                    head.lines().find_map(|line| {
                        let (key, value) = line.split_once(':')?;
                        key.eq_ignore_ascii_case(name)
                            .then(|| value.trim().to_owned())
                    })
                };
                let length: usize = header("content-length")
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0);
                if bytes.len() >= end + 4 + length {
                    break Some((
                        header("authorization").unwrap_or_default(),
                        serde_json::from_slice(&bytes[end + 4..end + 4 + length])
                            .unwrap_or(Value::Null),
                    ));
                }
            };
            if let Some(request) = parsed {
                recorded.lock().await.push(request);
            }
            let response = match body {
                Some(body) => format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                ),
                None => "HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n".to_owned(),
            };
            let _ = stream.write_all(response.as_bytes()).await;
        }
    });
    Ok((url, requests))
}

/// TypeScript parity: `notify` on the Control Plane service of `supertag.yaml`
/// (`apps/cli/src/notification-command.ts`, `tests/operator-channel-runtime.test.ts`).
// The webhook mock must answer while this test blocks on CLI processes.
async fn configured_notify_destinations_tell_the_operator_about_a_question(
    database: String,
) -> Result<()> {
    let temp = tempfile::tempdir()?;
    let state = temp.path().join("state");
    let file = temp.path().join("supertag.yaml");
    let (url, hooks) = webhook_mock().await?;
    yaml(
        &file,
        &serde_json::json!({"version":1,"services":{
            "control-plane":{"type":"control-plane","ports":["127.0.0.1:0"],
                "notify":[format!("webhook:{url}#hook-token")]},
            "builder":{"type":"host","adapter":ADAPTER,"adapter-args":["--objective-question"],"concurrency":1}
        },"secrets":{"hook-token":{"environment":"FIXTURE_HOOK_SECRET"}}}),
    )?;
    // An invalid destination stops startup without echoing the webhook URL.
    let invalid = temp.path().join("invalid.yaml");
    yaml(
        &invalid,
        &serde_json::json!({"version":1,"services":{
            "control-plane":{"type":"control-plane","notify":"webhook:http://hooks.example/private-token"}
        }}),
    )?;
    let output = reaped(Command::new(BIN))
        .args(["up", "--foreground", "--state-directory"])
        .arg(temp.path().join("invalid-state"))
        .arg("--file")
        .arg(&invalid)
        .env_clear()
        .output()?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    ensure!(!output.status.success() && stderr.contains("notify webhook must contain"));
    ensure!(!stderr.contains("private-token"), "{stderr}");

    let mut supervisor = Process::spawn(
        &state,
        Some(&file),
        &[
            ("FIXTURE_HOOK_SECRET", "synthetic-hook-secret"),
            ("SUPERTAG_TEST_NOTIFY_LOOPBACK_HTTP", "1"),
        ]
        .into_iter()
        .chain(database_env(&database))
        .collect::<Vec<_>>(),
    )?;
    supervisor.ready()?;
    uses_database(&state, &database)?;
    let cli = |args: &[&str]| -> Result<String> {
        let output = reaped(Command::new(BIN))
            .arg(args[0])
            .arg("--state-directory")
            .arg(&state)
            .args(&args[1..])
            .env_clear()
            .output()?;
        ensure!(
            output.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        Ok(String::from_utf8(output.stdout)?)
    };
    // `test` takes the connection after its subcommand.
    let output = reaped(Command::new(BIN))
        .args(["test", "notification", "--state-directory"])
        .arg(&state)
        .env_clear()
        .output()?;
    ensure!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(String::from_utf8(output.stdout)?, "webhook: delivered\n");
    cli(&[
        "tag",
        "put",
        "engineer",
        "--instructions",
        "Release engineering",
    ])?;
    cli(&[
        "objective",
        "create",
        "release",
        "--owner",
        "engineer",
        "Ask which branch to release",
    ])?;
    let message = "Objective release needs you: Objective release waits on your answer\n`supertag describe objective release`";
    timeout(WAIT, async {
        loop {
            if hooks.lock().await.len() == 2 {
                break;
            }
            sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .context("configured destinations were not notified")?;
    let hooks = hooks.lock().await;
    assert!(
        hooks
            .iter()
            .all(|(auth, _)| auth == "Bearer synthetic-hook-secret")
    );
    assert_eq!(
        hooks[0].1["text"],
        "SuperTag test notification\n`supertag get inbox-items`"
    );
    assert_eq!(hooks[1].1["text"], message);
    assert_eq!(hooks[1].1["kinds"], serde_json::json!(["question"]));
    // The Inbox shows that the question reached the operator, and through what. The message is
    // settled after its send returns, so this test may see it before it is recorded: wait.
    let mut inbox = Value::Null;
    let settled = timeout(WAIT, async {
        loop {
            inbox = serde_json::from_str(&cli(&["get", "inbox-items", "--objective", "release"])?)?;
            let notification = &inbox["items"][0]["notification"];
            if notification["status"] == "delivered" && notification["reason"] == "via webhook" {
                return Ok::<_, anyhow::Error>(());
            }
            sleep(Duration::from_millis(50)).await;
        }
    })
    .await;
    match settled {
        Ok(result) => result?,
        Err(_) => anyhow::bail!("the delivery was not recorded: {inbox}"),
    }
    supervisor.stop().await
}

/// TypeScript parity: a Slack destination posts as the enrolled Slack Surface Account
/// (`createOperatorNotificationSender` in `apps/cli/src/gateway-surfaces.ts`). Under `supertag up`
/// a Slack surface without a location runs no connector, yet its bot token still posts.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn slack_notify_destination_posts_as_a_slack_surface_without_a_location() -> Result<()> {
    use supertag_credential_vault::{CredentialVault, FileCredentialVault};
    let temp = tempfile::tempdir()?;
    let state = temp.path().join("state");
    fs::create_dir_all(&state)?;
    fs::set_permissions(&state, fs::Permissions::from_mode(0o700))?;
    let file = temp.path().join("supertag.yaml");
    let (url, posts) = answering_mock(Some(r#"{"ok":true,"ts":"1.000"}"#)).await?;
    CredentialVault::File(FileCredentialVault::new(
        state.join("gateway-credentials.json"),
    ))
    .store(
        "surface/slack/ops",
        &[
            ("botToken".to_owned(), "xoxb-synthetic-ops".to_owned()),
            ("signingSecret".to_owned(), "synthetic-signing".to_owned()),
        ]
        .into(),
    )
    .await?;
    yaml(
        &file,
        &serde_json::json!({"version":1,"services":{
            "control-plane":{"type":"control-plane","ports":["127.0.0.1:0"],
                "notify":["slack:C0ALERTS"]}
        },"surfaces":{"ops":{"provider":"slack","account":"T0OPS"}}}),
    )?;
    let mut supervisor = Process::spawn(
        &state,
        Some(&file),
        &[("SUPERTAG_TEST_SLACK_API_URL", url.as_str())],
    )?;
    supervisor.ready()?;
    let output = reaped(Command::new(BIN))
        .args(["test", "notification", "--state-directory"])
        .arg(&state)
        .env_clear()
        .output()?;
    ensure!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(String::from_utf8(output.stdout)?, "slack: delivered\n");
    let posts = posts.lock().await;
    assert_eq!(posts.len(), 1);
    assert_eq!(posts[0].0, "Bearer xoxb-synthetic-ops");
    assert_eq!(posts[0].1["channel"], "C0ALERTS");
    drop(posts);
    supervisor.stop().await
}

/// Writes one of a Tag's harness memory stores as its Worker Host keeps it.
fn seed_store(host: &Path, tag: &str, harness: &str, files: &[(&str, &str)]) -> Result<PathBuf> {
    let store = host
        .join("artifacts/tags")
        .join(format!("{:x}", Sha256::digest(tag.as_bytes())))
        .join("native-memory")
        .join(harness)
        .join("shared");
    for (path, contents) in files {
        let path = store.join("current").join(path);
        fs::create_dir_all(path.parent().context("memory file parent")?)?;
        fs::write(path, contents)?;
    }
    fs::write(
        store.join("meta.json"),
        serde_json::json!({"revision": 1, "generation": 0, "tag": tag}).to_string(),
    )?;
    Ok(store)
}

/// A Tag's harness memory is listed, described and deleted through the CLI from the memory
/// endpoint of the Worker Host `up` runs here, never through the Control Plane; a reset drops the
/// copies here at once.
async fn local_hosts_serve_harness_memory_to_the_cli(database: String) -> Result<()> {
    let temp = tempfile::tempdir()?;
    let state = temp.path().join("state");
    let file = temp.path().join("supertag.yaml");
    let (section, secrets) = if database.starts_with("postgres") {
        database_password::config(&database, temp.path())?
    } else {
        (Value::Null, serde_json::json!({}))
    };
    yaml(
        &file,
        &serde_json::json!({"version":1,"secrets":secrets,"services":{
            "control-plane":{"type":"control-plane","ports":["127.0.0.1:0"],"database":section},
            "keeper":{"type":"host","adapter":ADAPTER,"concurrency":1}
        }}),
    )?;
    let mut supervisor = Process::spawn(&state, Some(&file), &[])?;
    let endpoint = supervisor.ready()?;
    uses_database(&state, &database)?;
    let credential = token(&state)?;
    let mut operator = client(&endpoint).await?;
    tag(&mut operator, &credential, "lead", HarnessKind::ClaudeCode).await?;
    let host = state.join("hosts/keeper");
    let socket = host.join("memory.sock");
    timeout(WAIT, async {
        while !socket.exists() {
            sleep(Duration::from_millis(50)).await;
        }
    })
    .await?;
    assert_eq!(fs::metadata(&socket)?.permissions().mode() & 0o777, 0o600);
    let claude = seed_store(
        &host,
        "lead",
        "claude-code",
        &[
            (
                "MEMORY.md",
                "- [Squash merges](feedback_squash.md) — how to merge\n",
            ),
            (
                "feedback_squash.md",
                "---\nname: Prefer squash merges\ndescription: how to merge\ntype: feedback\n---\nPrefer squash merges.\n",
            ),
        ],
    )?;
    let codex = seed_store(
        &host,
        "lead",
        "codex",
        &[
            (
                "extensions/ad_hoc/notes/2026-11-19-region.md",
                "Staging runs in eu-north-1.",
            ),
            (
                "memory_summary.md",
                "v1\n\n## User preferences\n\n- Prefers small pull requests.\n",
            ),
            ("MEMORY.md", "# Task Group: payments\n"),
        ],
    )?;
    let cli = |args: &[&str]| -> Result<Value> {
        let output = reaped(Command::new(BIN))
            .args(args)
            .arg("--state-directory")
            .arg(&state)
            .env_clear()
            .output()?;
        ensure!(
            output.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        Ok(serde_json::from_slice(&output.stdout)?)
    };
    let listed = cli(&["get", "memories", "--tag", "lead"])?;
    let memories = listed["memories"].as_array().context("memories")?;
    let mut found: Vec<(&str, &str)> = memories
        .iter()
        .map(|memory| {
            (
                memory["harness"].as_str().unwrap_or_default(),
                memory["kind"].as_str().unwrap_or_default(),
            )
        })
        .collect();
    found.sort();
    assert_eq!(
        found,
        [
            ("claude-code", "feedback"),
            ("codex", "fact"),
            ("codex", "preference")
        ],
        "{listed}"
    );
    for memory in memories {
        assert_eq!(memory["source"]["host_id"], "keeper", "{memory}");
        assert_eq!(memory["shared"], true, "{memory}");
        assert_eq!(memory["status"], "owned", "{memory}");
    }
    let squash = memories
        .iter()
        .find(|memory| memory["harness"] == "claude-code")
        .context("Claude Code memory")?;
    let id = squash["memory_id"].as_str().context("memory ID")?;
    assert!(id.starts_with("hmem_"), "{id}");
    let described = cli(&["describe", "memory", id, "--output", "json"])?;
    assert_eq!(described["title"], "Prefer squash merges", "{described}");
    assert_eq!(described["text"], "Prefer squash merges.", "{described}");
    let output = reaped(Command::new(BIN))
        .args(["describe", "memory", id, "--state-directory"])
        .arg(&state)
        .env_clear()
        .output()?;
    let text = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success() && text.contains("Prefer squash merges"),
        "{text}"
    );
    let all = cli(&["get", "memories"])?;
    assert_eq!(all["memories"].as_array().map(Vec::len), Some(3), "{all}");
    // The host's counters of each store reach `metrics` and `describe tag`, as numbers only.
    let metrics = cli(&["metrics", "--output", "json"])?;
    let stores = metrics["memory"].as_array().context("memory counters")?;
    let mut counted: Vec<(&str, u64)> = stores
        .iter()
        .map(|store| {
            (
                store["harness"].as_str().unwrap_or_default(),
                store["memories"].as_u64().unwrap_or_default(),
            )
        })
        .collect();
    counted.sort();
    assert_eq!(counted, [("claude-code", 1), ("codex", 2)], "{metrics}");
    assert!(
        stores
            .iter()
            .all(|store| store["host_id"] == "keeper" && store["shared"] == true)
    );
    assert!(!metrics.to_string().contains("squash"), "{metrics}");
    let described = cli(&["describe", "tag", "lead", "--output", "json"])?;
    assert_eq!(
        described["memory_use"].as_array().map(Vec::len),
        Some(2),
        "{described}"
    );
    assert_eq!(
        described["memory_use"][0]["loaded"]["lines"], 1,
        "{described}"
    );

    let deleted = cli(&["delete", "memory", id])?;
    assert_eq!(deleted["memory_id"], id, "{deleted}");
    assert!(!claude.join("current/feedback_squash.md").exists());
    assert!(!fs::read_to_string(claude.join("current/MEMORY.md"))?.contains("feedback_squash.md"));
    let output = reaped(Command::new(BIN))
        .args(["get", "memory", id, "--state-directory"])
        .arg(&state)
        .env_clear()
        .output()?;
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("was not found"),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );

    let reset = cli(&["delete", "memory", "--tag", "lead"])?;
    assert_eq!(reset["reset_generation"], 1, "{reset}");
    assert!(!codex.join("current").exists());
    let listed = cli(&["get", "memories", "--tag", "lead"])?;
    assert_eq!(listed["memories"], serde_json::json!([]), "{listed}");
    supervisor.stop().await?;
    assert!(
        !socket.exists(),
        "the Worklet removes its socket when it stops"
    );
    Ok(())
}

// Each `supertag up` case runs with the local Control Plane on SQLite and on PostgreSQL.

#[tokio::test]
async fn sqlite_local_hosts_serve_harness_memory_to_the_cli() -> Result<()> {
    with_database(false, local_hosts_serve_harness_memory_to_the_cli).await
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL server via SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"]
async fn postgres_local_hosts_serve_harness_memory_to_the_cli() -> Result<()> {
    with_database(true, local_hosts_serve_harness_memory_to_the_cli).await
}

#[tokio::test]
async fn sqlite_operator_commands_default_to_the_local_control_plane() -> Result<()> {
    with_database(false, operator_commands_default_to_the_local_control_plane).await
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL server via SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"]
async fn postgres_operator_commands_default_to_the_local_control_plane() -> Result<()> {
    with_database(true, operator_commands_default_to_the_local_control_plane).await
}

#[tokio::test]
async fn sqlite_configured_local_hosts_restart_and_reap_with_stable_private_state() -> Result<()> {
    with_database(
        false,
        configured_local_hosts_restart_and_reap_with_stable_private_state,
    )
    .await
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL server via SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"]
async fn postgres_configured_local_hosts_restart_and_reap_with_stable_private_state() -> Result<()>
{
    with_database(
        true,
        configured_local_hosts_restart_and_reap_with_stable_private_state,
    )
    .await
}

#[tokio::test]
async fn sqlite_remote_host_only_env_and_file_auth_keys_are_needed_only_for_first_join()
-> Result<()> {
    with_database(
        false,
        remote_host_only_env_and_file_auth_keys_are_needed_only_for_first_join,
    )
    .await
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL server via SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"]
async fn postgres_remote_host_only_env_and_file_auth_keys_are_needed_only_for_first_join()
-> Result<()> {
    with_database(
        true,
        remote_host_only_env_and_file_auth_keys_are_needed_only_for_first_join,
    )
    .await
}

/// A setup `supertag init` made before resource IDs were DNS labels declares the Role `Lead`.
/// `up` refuses that name and says to run `supertag init` again; once init renames it `lead`,
/// `up` creates Role `lead` beside the stored `Lead` and gives it to the existing Tag.
async fn init_role_renamed_to_follow_the_resource_id_rule(database: String) -> Result<()> {
    let temp = tempfile::tempdir()?;
    let state = temp.path().join("renamed");
    let file = temp.path().join("supertag.yaml");
    let services = |provision: Value| {
        serde_json::json!({"services":{
            "control-plane":{"type":"control-plane","ports":["127.0.0.1:0"],"provision":provision},
            "worker":{"type":"host","adapter":ADAPTER}
        }})
    };
    let permission = serde_json::json!({"apiVersion":"supertag/v1","kind":"PermissionSet","metadata":{"name":"local-tools"},"spec":{"permissions":[{"target":"runtime","action":"files:read"}]}});
    let provision = |role: &str| {
        serde_json::json!([
            permission,
            {"apiVersion":"supertag/v1","kind":"Role","metadata":{"name":role},"spec":{"purpose":"Own Objectives for this repository.","permissionSets":["local-tools"]}},
            {"apiVersion":"supertag/v1","kind":"Tag","metadata":{"name":"lead"},"spec":{"lead":true,"roles":[role]}}
        ])
    };

    // What provisioning that file used to store: the Role `Lead` under a generated ID, held by
    // the Tag `lead`. The current manifest path refuses the name, so the RPCs seed it.
    yaml(&file, &services(serde_json::json!([permission])))?;
    let mut seeding = Process::spawn(&state, Some(&file), &database_env(&database))?;
    let endpoint = seeding.ready()?;
    let credential = token(&state)?;
    let channel =
        protocol::negotiated(Channel::from_shared(endpoint.clone())?.connect().await?).await?;
    let mut operator = operator_client::OperatorClient::new(channel.clone());
    let mut policy = policy_catalog_client::PolicyCatalogClient::new(channel);
    let old = policy
        .put_role(authenticated_request(
            PutRoleRequest {
                operation_id: Uuid::new_v4().to_string(),
                role: Some(Role {
                    name: "Lead".into(),
                    purpose: "Own Objectives for this repository.".into(),
                    permission_set_ids: vec!["local-tools".into()],
                    ..Default::default()
                }),
                expected_revision: None,
            },
            &credential,
            None,
        )?)
        .await?
        .into_inner();
    assert_ne!(old.role_id, "Lead");
    operator
        .put_tag(authenticated_request(
            PutTagRequest {
                tag_id: "lead".into(),
                instructions: "Local fixture".into(),
                ..Default::default()
            },
            &credential,
            None,
        )?)
        .await?;
    policy
        .assign_role(authenticated_request(
            AssignRoleRequest {
                operation_id: Uuid::new_v4().to_string(),
                role: old.role_id.clone(),
                tag_id: "lead".into(),
            },
            &credential,
            None,
        )?)
        .await?;
    seeding.stop().await?;

    // The file as init wrote it: `up` refuses it, naming the Role, the rule, and the fix.
    yaml(&file, &services(provision("Lead")))?;
    let refused = Process::spawn(&state, Some(&file), &database_env(&database))?;
    let failure = refused.ready().unwrap_err().to_string();
    for expected in [
        "Role \"Lead\": metadata.name must be 1–63 lowercase letters, digits, and hyphens",
        "run supertag init again to rename it lead",
    ] {
        assert!(failure.contains(expected), "{failure}");
    }
    drop(refused);

    // The file after `supertag init` renamed the Role, as init's rename_role writes it.
    yaml(&file, &services(provision("lead")))?;
    let mut upgraded = Process::spawn(&state, Some(&file), &database_env(&database))?;
    assert_eq!(upgraded.ready()?, endpoint);
    let channel =
        protocol::negotiated(Channel::from_shared(endpoint.clone())?.connect().await?).await?;
    let mut operator = operator_client::OperatorClient::new(channel.clone());
    let mut policy = policy_catalog_client::PolicyCatalogClient::new(channel);
    let role = policy
        .get_role(authenticated_request(
            GetPolicyResourceRequest {
                reference: "lead".into(),
            },
            &credential,
            None,
        )?)
        .await?
        .into_inner();
    assert_eq!(
        (role.role_id.as_str(), role.name.as_str()),
        ("lead", "lead")
    );
    let assignments = policy
        .list_role_assignments(authenticated_request(
            ListRoleAssignmentsRequest {
                tag_id: "lead".into(),
                limit: 10,
                ..Default::default()
            },
            &credential,
            None,
        )?)
        .await?
        .into_inner();
    let mut held: Vec<_> = assignments
        .assignments
        .iter()
        .filter(|assignment| assignment.status == RoleAssignmentStatus::Active as i32)
        .map(|assignment| assignment.role_id.clone())
        .collect();
    held.sort();
    let mut expected = vec!["lead".to_owned(), old.role_id.clone()];
    expected.sort();
    assert_eq!(held, expected);
    let task = operator
        .submit_task(authenticated_request(
            SubmitTaskRequest {
                tag_id: "lead".into(),
                session_id: "renamed".into(),
                operation_id: Uuid::new_v4().to_string(),
                prompt: "Run configured worker".into(),
                ..Default::default()
            },
            &credential,
            None,
        )?)
        .await?
        .into_inner();
    let roles: Vec<_> = task
        .policy_snapshot
        .as_ref()
        .context("policy snapshot missing")?
        .roles
        .iter()
        .filter_map(|snapshot| snapshot.role.as_ref())
        .map(|role| role.role_id.clone())
        .collect();
    assert!(roles.iter().any(|id| id == "lead"), "{roles:?}");
    timeout(WAIT, async {
        loop {
            let current = operator
                .get_task(authenticated_request(
                    GetTaskRequest {
                        task_id: task.task_id.clone(),
                    },
                    &credential,
                    None,
                )?)
                .await?
                .into_inner();
            if current.state() == TaskState::Succeeded {
                break Ok::<_, anyhow::Error>(());
            }
            ensure!(current.state() != TaskState::Failed, "{:?}", current.result);
            sleep(Duration::from_millis(50)).await;
        }
    })
    .await??;
    upgraded.stop().await?;
    Ok(())
}

#[tokio::test]
async fn sqlite_init_role_renamed_to_follow_the_resource_id_rule() -> Result<()> {
    with_database(false, init_role_renamed_to_follow_the_resource_id_rule).await
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL server via SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"]
async fn postgres_init_role_renamed_to_follow_the_resource_id_rule() -> Result<()> {
    with_database(true, init_role_renamed_to_follow_the_resource_id_rule).await
}

/// A Role provisioning created earlier gains the Sets its manifest now lists, as when a later
/// `supertag init` adds the `skills` Context Set, and loses none. Accepted Tasks keep the policy
/// they were admitted with.
async fn provisioning_adds_listed_sets_to_an_existing_role(database: String) -> Result<()> {
    let temp = tempfile::tempdir()?;
    let state = temp.path().join("sets");
    let file = temp.path().join("supertag.yaml");
    let permission = serde_json::json!({"apiVersion":"supertag/v1","kind":"PermissionSet","metadata":{"name":"local-tools"},"spec":{"permissions":[{"target":"runtime","action":"files:read"}]}});
    let skills = serde_json::json!({"apiVersion":"supertag/v1","kind":"ContextSet","metadata":{"name":"skills"},"spec":{"items":[{"itemKey":"skills","type":"supertag/skill","version":1,"required":false,"config":{"reference":"*"}}]}});
    let config = |with_skills: bool| {
        let mut role = serde_json::json!({"apiVersion":"supertag/v1","kind":"Role","metadata":{"name":"lead"},"spec":{"purpose":"Own Objectives for this repository.","permissionSets":["local-tools"]}});
        let mut provision = vec![permission.clone()];
        if with_skills {
            role["spec"]["contextSets"] = serde_json::json!(["skills"]);
            provision.push(skills.clone());
        }
        provision.push(role);
        provision.push(serde_json::json!({"apiVersion":"supertag/v1","kind":"Tag","metadata":{"name":"lead"},"spec":{"lead":true,"roles":["lead"]}}));
        serde_json::json!({"services":{
            "control-plane":{"type":"control-plane","ports":["127.0.0.1:0"],"provision":provision},
            "worker":{"type":"host","adapter":ADAPTER}
        }})
    };
    let submit = |operator: &mut operator_client::OperatorClient<ProtocolChannel>,
                  credential: &str,
                  session: &str| {
        let request = authenticated_request(
            SubmitTaskRequest {
                tag_id: "lead".into(),
                session_id: session.into(),
                operation_id: Uuid::new_v4().to_string(),
                prompt: "Run configured worker".into(),
                ..Default::default()
            },
            credential,
            None,
        );
        let mut operator = operator.clone();
        async move { Ok::<_, anyhow::Error>(operator.submit_task(request?).await?.into_inner()) }
    };
    let context_sets = |task: &Task| -> Vec<String> {
        task.policy_snapshot
            .as_ref()
            .map(|snapshot| {
                snapshot
                    .context_sets
                    .iter()
                    .map(|set| set.set_id.clone())
                    .collect()
            })
            .unwrap_or_default()
    };
    let connect = |endpoint: String| async move {
        let channel =
            protocol::negotiated(Channel::from_shared(endpoint)?.connect().await?).await?;
        Ok::<_, anyhow::Error>((
            operator_client::OperatorClient::new(channel.clone()),
            policy_catalog_client::PolicyCatalogClient::new(channel),
        ))
    };
    let role = |policy: &mut policy_catalog_client::PolicyCatalogClient<ProtocolChannel>,
                credential: &str| {
        let request = authenticated_request(
            GetPolicyResourceRequest {
                reference: "lead".into(),
            },
            credential,
            None,
        );
        let mut policy = policy.clone();
        async move { Ok::<_, anyhow::Error>(policy.get_role(request?).await?.into_inner()) }
    };

    // A setup from before init gave its Role the skills Context Set.
    yaml(&file, &config(false))?;
    let mut first = Process::spawn(&state, Some(&file), &database_env(&database))?;
    let endpoint = first.ready()?;
    let credential = token(&state)?;
    let (mut operator, mut policy) = connect(endpoint.clone()).await?;
    let before = role(&mut policy, &credential).await?;
    assert!(before.context_set_ids.is_empty(), "{before:?}");
    let accepted = submit(&mut operator, &credential, "before").await?;
    assert!(context_sets(&accepted).is_empty());
    first.stop().await?;

    // supertag init added the Context Set and listed it on the Role.
    yaml(&file, &config(true))?;
    let mut upgraded = Process::spawn(&state, Some(&file), &database_env(&database))?;
    assert_eq!(upgraded.ready()?, endpoint);
    let (mut operator, mut policy) = connect(endpoint.clone()).await?;
    let after = role(&mut policy, &credential).await?;
    assert_eq!(after.context_set_ids, ["skills"]);
    assert_eq!(after.permission_set_ids, before.permission_set_ids);
    assert_eq!(
        (&after.purpose, &after.name, after.status),
        (&before.purpose, &before.name, before.status)
    );
    assert!(after.revision > before.revision);
    let task = submit(&mut operator, &credential, "after").await?;
    let snapshot = task.policy_snapshot.clone().context("policy snapshot")?;
    let set = snapshot
        .context_sets
        .iter()
        .find(|set| set.set_id == "skills")
        .context("skills Context Set missing from the new Task's policy")?;
    assert!(
        set.items
            .iter()
            .any(|item| item.r#type == "supertag/skill" && item.config_json.contains("\"*\"")),
        "{set:?}"
    );
    // The Task accepted earlier keeps the policy it was admitted with.
    let kept = operator
        .get_task(authenticated_request(
            GetTaskRequest {
                task_id: accepted.task_id.clone(),
            },
            &credential,
            None,
        )?)
        .await?
        .into_inner();
    assert!(context_sets(&kept).is_empty());

    // Removing the Set by hand lasts only until the next up: the file still declares it.
    let mut edited = after.clone();
    edited.context_set_ids.clear();
    let edited = policy
        .put_role(authenticated_request(
            PutRoleRequest {
                operation_id: Uuid::new_v4().to_string(),
                expected_revision: Some(after.revision),
                role: Some(edited),
            },
            &credential,
            None,
        )?)
        .await?
        .into_inner();
    upgraded.stop().await?;

    let mut again = Process::spawn(&state, Some(&file), &database_env(&database))?;
    assert_eq!(again.ready()?, endpoint);
    let (_, mut policy) = connect(endpoint.clone()).await?;
    let readded = role(&mut policy, &credential).await?;
    assert_eq!(readded.context_set_ids, ["skills"]);
    assert!(readded.revision > edited.revision);
    again.stop().await?;

    // An up whose file the Role already satisfies changes nothing.
    let mut settled = Process::spawn(&state, Some(&file), &database_env(&database))?;
    assert_eq!(settled.ready()?, endpoint);
    let (_, mut policy) = connect(endpoint).await?;
    assert_eq!(role(&mut policy, &credential).await?, readded);
    settled.stop().await?;
    Ok(())
}

#[tokio::test]
async fn sqlite_provisioning_adds_listed_sets_to_an_existing_role() -> Result<()> {
    with_database(false, provisioning_adds_listed_sets_to_an_existing_role).await
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL server via SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"]
async fn postgres_provisioning_adds_listed_sets_to_an_existing_role() -> Result<()> {
    with_database(true, provisioning_adds_listed_sets_to_an_existing_role).await
}

#[tokio::test]
async fn sqlite_local_provision_creates_ordered_resources_once_and_preserves_operator_edits()
-> Result<()> {
    with_database(
        false,
        local_provision_creates_ordered_resources_once_and_preserves_operator_edits,
    )
    .await
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL server via SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"]
async fn postgres_local_provision_creates_ordered_resources_once_and_preserves_operator_edits()
-> Result<()> {
    with_database(
        true,
        local_provision_creates_ordered_resources_once_and_preserves_operator_edits,
    )
    .await
}

#[tokio::test]
async fn sqlite_unsafe_provision_source_stops_before_hosts_start_and_reaps_services() -> Result<()>
{
    unsafe_provision_source_stops_before_hosts_start_and_reaps_services(false).await
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL server via SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"]
async fn postgres_unsafe_provision_source_stops_before_hosts_start_and_reaps_services() -> Result<()>
{
    unsafe_provision_source_stops_before_hosts_start_and_reaps_services(true).await
}

#[tokio::test]
async fn sqlite_env_file_credentials_reach_only_the_services_and_harnesses_that_need_them()
-> Result<()> {
    with_database(
        false,
        env_file_credentials_reach_only_the_services_and_harnesses_that_need_them,
    )
    .await
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL server via SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"]
async fn postgres_env_file_credentials_reach_only_the_services_and_harnesses_that_need_them()
-> Result<()> {
    with_database(
        true,
        env_file_credentials_reach_only_the_services_and_harnesses_that_need_them,
    )
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sqlite_configured_notify_destinations_tell_the_operator_about_a_question() -> Result<()> {
    with_database(
        false,
        configured_notify_destinations_tell_the_operator_about_a_question,
    )
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires an isolated PostgreSQL server via SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"]
async fn postgres_configured_notify_destinations_tell_the_operator_about_a_question() -> Result<()>
{
    with_database(
        true,
        configured_notify_destinations_tell_the_operator_about_a_question,
    )
    .await
}
