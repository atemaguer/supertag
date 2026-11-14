//! The ordinary native `up -f` entry point owns every service and its private enrollment.
#[path = "support/database_password.rs"]
mod database_password;
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
const WAIT: Duration = Duration::from_secs(25);
struct Process {
    child: Child,
    ready: mpsc::Receiver<String>,
    log: PathBuf,
}
impl Process {
    fn spawn(state: &Path, file: Option<&Path>, env: &[(&str, &str)]) -> Result<Self> {
        let log = state.with_extension(format!("{}.log", Uuid::new_v4().simple()));
        let mut command = Command::new(BIN);
        command
            .args(["up", "--foreground", "--state-directory"])
            .arg(state)
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
    let rejected = Command::new(BIN)
        .args(["get", "task", "--state-directory"])
        .arg(&state)
        .arg("no-task")
        .env_clear()
        .output()?;
    assert!(!rejected.status.success());
    assert!(String::from_utf8_lossy(&rejected.stderr).contains("not running"));
    Ok(())
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
            {"apiVersion":"supertag/v1","kind":"Objective","metadata":{"name":"fixture-objective"},"spec":{"ownerTag":"engineer","ongoing":true,"outcome":"Read provisioned fixture evidence."}},
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
    assert_eq!(current, edited);
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
    fs::write(
        bin.join("codex"),
        "#!/bin/sh\nif [ \"$1\" = --version ]; then echo codex-cli 0.163.0; fi\n",
    )?;
    fs::set_permissions(bin.join("codex"), fs::Permissions::from_mode(0o700))?;
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
        roles.insert(role, process_environment(pid)?);
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
                "SUPERTAG_OPERATOR_TOKEN",
            ]
        } else {
            &[
                "SUPERTAG_BOOTSTRAP_GATEWAY_CREDENTIAL",
                "SUPERTAG_DATABASE_URL",
                "SUPERTAG_OPERATOR_TOKEN",
            ]
        })
    );
    if postgres {
        assert_eq!(roles["control-plane"]["PGPASSWORD"], password);
        assert_eq!(roles["control-plane"]["SUPERTAG_DATABASE_URL"], database);
    }
    // The Gateway holds no operator credential, only its own enrolled one.
    assert_eq!(
        names(&roles["gateway"]),
        expected(&["SUPERTAG_GATEWAY_CREDENTIAL"])
    );
    // The Codex Host gets only Codex credentials: the shell's value wins, env_file fills the gap.
    // Each lane presents its Host credential; the guardian never passes it to a harness.
    let codex = &roles["codex-host"];
    assert_eq!(
        names(codex),
        expected(&["CODEX_API_KEY", "OPENAI_API_KEY", "SUPERTAG_HOST_TOKEN"])
    );
    assert_eq!(codex["CODEX_API_KEY"], "shell-codex");
    assert_eq!(codex["OPENAI_API_KEY"], "file-openai");
    assert_eq!(
        names(&roles["reporter"]),
        expected(&["SUPERTAG_HOST_TOKEN"])
    );
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
    assert_eq!(
        reported,
        [
            "PATH",
            "SUPERTAG_ADAPTER_STATE_DIRECTORY",
            "SUPERTAG_WORKSPACE_DIRECTORY",
            "TMPDIR"
        ]
    );
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
        let mut plane = Command::new(BIN)
            .args(["control-plane", "--listen", "127.0.0.1:0"])
            .arg("--transfer-directory")
            .arg(checkpoints.path().join("checkpoints"))
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
    use sqlx::{Connection, Executor};
    if !postgres {
        let temp = tempfile::tempdir()?;
        let url = format!(
            "sqlite://{}?mode=rwc",
            temp.path().join("plane.db").display()
        );
        return contract(url).await;
    }
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .context("PostgreSQL URL file required")?;
    let admin_url = fs::read_to_string(path)?;
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await?;
    let name = format!("supertag_lanes_{}", Uuid::new_v4().simple());
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await?;
    let mut url = url::Url::parse(admin_url.trim())?;
    url.set_path(&name);
    let result = contract(url.to_string()).await;
    let cleanup = admin
        .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
        .await;
    admin.close().await?;
    cleanup?;
    result
}

/// A shared Host with a gated Codex lane group and a gated OpenAI Agents lane group.
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
        fs::write(
            bin.join("python3"),
            format!(
                "#!/bin/sh\ntest -z \"${{CODEX_API_KEY:-}}${{ANTHROPIC_API_KEY:-}}${{SUPERTAG_HOST_TOKEN:-}}\" || exit 3\n\
                 test \"${{OPENAI_API_KEY:-}}\" = fixture-openai || exit 4\n\
                 echo $$ > \"{gate_text}/started/agents-$$\"\n\
                 while [ ! -e \"{gate_text}/release\" ]; do sleep 0.05; done\nexec \"{ADAPTER}\"\n"
            ),
        )?;
        // Answer the version probe without starting Python, which is slow on a loaded machine.
        let server = temp.path().join("gated_codex_app_server.py");
        fs::write(
            &server,
            include_str!("fixtures/gated_codex_app_server.py").replace("@GATE@", gate_text),
        )?;
        fs::write(
            bin.join("codex"),
            format!(
                "#!/bin/sh\nif [ \"$*\" = --version ]; then echo codex-cli 0.163.0; exit 0; fi\n\
                 exec /usr/bin/python3 \"{}\" \"$@\"\n",
                server.display()
            ),
        )?;
        for name in ["python3", "codex"] {
            fs::set_permissions(bin.join(name), fs::Permissions::from_mode(0o700))?;
        }
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
        let output = Command::new(BIN)
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

    fn lanes(&self) -> Result<Vec<(i32, String)>> {
        Ok(children(self.supervisor.child.id())?
            .into_iter()
            .filter(|(_, command)| command.contains("/hosts/shared/lanes/"))
            .collect())
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
    let mut shared = SharedHost::start(&central, 2).await?;
    // One registration advertises both harnesses, each with its own slots.
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
            (HarnessKind::OpenaiAgents, 2, 2)
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
    // Each lane holds only its own harness's provider credentials.
    let lanes = shared.lanes()?;
    assert_eq!(lanes.len(), 4);
    for (pid, command) in &lanes {
        let environment = process_environment(*pid)?;
        let mut names = names(&environment);
        names.retain(|name| !["HOME", "PATH", "SUPERTAG_LOCAL_SERVICE_LIFELINE"].contains(name));
        if command.contains("/lanes/codex-") {
            assert_eq!(
                names,
                ["CODEX_API_KEY", "OPENAI_API_KEY", "SUPERTAG_HOST_TOKEN"]
            );
        } else {
            assert!(command.contains("/lanes/openai-agents-"), "{command}");
            assert_eq!(names, ["OPENAI_API_KEY", "SUPERTAG_HOST_TOKEN"]);
        }
    }

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
    // Two harnesses run at once, and each runs exactly its configured two Attempts.
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
    assert_eq!(queued, 1, "the third Codex Task must wait for a free slot");
    let busy = host_until(&mut operator, &token, |status| {
        status.phase() == HostPhase::Busy && status.active_attempts == 4
    })
    .await?;
    assert_eq!(busy.available_slots, 0);

    // One harness process crashes. Its Attempt fails; the sibling Attempts and lanes continue.
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
        shared
            .lanes()?
            .into_iter()
            .map(|(pid, _)| pid)
            .collect::<Vec<_>>(),
        lanes.iter().map(|(pid, _)| *pid).collect::<Vec<_>>(),
        "a harness crash must not restart any lane"
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
    assert_eq!(shared.lanes()?.len(), 4);
    shared.supervisor.stop().await?;
    Ok(())
}

async fn replaced_shared_host_fences_every_lane(database: String) -> Result<()> {
    let central = Central::start(&database)?;
    let token = central.operator.clone();
    let mut operator = client(&central.public).await?;
    // One busy and one idle lane per harness: idle lanes meet the fence in their claim loop.
    let mut shared = SharedHost::start(&central, 2).await?;
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
    let lanes = shared
        .lanes()?
        .into_iter()
        .map(|(pid, _)| pid)
        .collect::<Vec<_>>();
    // Another process presents this Host's credential with a different incarnation.
    let enrollment: Value = serde_json::from_slice(&fs::read(
        shared.state.join("hosts/shared/enrollment.json"),
    )?)?;
    let credential = enrollment["token"].as_str().context("host token")?;
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
    // Let the stale lanes' harnesses finish now, so the lanes try to complete their Attempts
    // under the replaced generation before anything stops them.
    fs::write(shared.gate.join("release"), "")?;
    assert!(replaced.generation > ready.generation);
    // Both lanes' Attempts belong to the replaced generation and are fenced together.
    for id in &ids {
        let fenced = task(&mut operator, &token, id).await?;
        assert_eq!(fenced.state(), TaskState::Uncertain);
    }
    // The stale registration can no longer report presence or run work: the supervisor stops.
    let status = timeout(WAIT, async {
        loop {
            if let Some(status) = shared.supervisor.child.try_wait()? {
                break Ok::<_, anyhow::Error>(status);
            }
            sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .context("supervisor kept a fenced Host running")??;
    assert!(!status.success());
    // The supervisor's own presence check names the fenced registration, whichever lane or
    // report noticed first.
    let log = fs::read_to_string(&shared.supervisor.log)?;
    assert!(log.contains("is no longer current"), "{log}");
    assert!(!log.contains("exited unexpectedly"), "{log}");
    gone(&lanes).await?;
    // No stale lane completed or renewed its Attempt under the old generation.
    for id in &ids {
        assert_eq!(
            task(&mut operator, &token, id).await?.state(),
            TaskState::Uncertain
        );
    }
    Ok(())
}

async fn shared_host_lanes_use_separate_workspace_checkouts(database: String) -> Result<()> {
    let central = Central::start(&database)?;
    let token = central.operator.clone();
    let mut operator = client(&central.public).await?;
    let shared = SharedHost::start_with(
        &central,
        serde_json::json!({"concurrency": 2, "workspaces": {"repo": "./source"}}),
    )
    .await?;
    let ready = host_until(&mut operator, &token, |status| {
        status.phase() == HostPhase::Ready && status.available_slots == 4
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
                    workspace_id: "repo".into(),
                    base_commit: base.clone(),
                    mounts: vec![],
                    github_source: None,
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
    // Both Attempts run at once from the one configured source, each in its own checkout.
    let started = shared.wait_started(2, 0).await?;
    let mut checkouts = Vec::new();
    for (_, pid) in &started {
        checkouts.push(shared.codex_start(*pid)?);
    }
    checkouts.sort();
    let lanes = shared.state.join("hosts/shared/lanes").canonicalize()?;
    let mut owners = Vec::new();
    for (marker, checkout) in &checkouts {
        let lane = checkout
            .strip_prefix(&lanes)
            .with_context(|| format!("{} is not in a lane", checkout.display()))?
            .components()
            .next()
            .context("lane directory")?
            .as_os_str()
            .to_string_lossy()
            .into_owned();
        assert!(lane.starts_with("codex-"), "{lane}");
        owners.push(lane);
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
    assert_ne!(owners[0], owners[1], "both Attempts ran in one lane");

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

async fn stranded_lane_attempts_are_fenced_on_restart(database: String) -> Result<()> {
    let central = Central::start(&database)?;
    let token = central.operator.clone();
    let mut operator = client(&central.public).await?;
    let mut shared = SharedHost::start(&central, 1).await?;
    host_until(&mut operator, &token, |status| {
        status.phase() == HostPhase::Ready && status.available_slots == 2
    })
    .await?;
    tag(&mut operator, &token, "coder", HarnessKind::Codex).await?;
    let id = submit(&mut operator, &token, "coder", "Task-c1").await?;
    settled(&mut operator, &token, &id, TaskState::Running).await?;
    let started = shared.wait_started(1, 0).await?;
    let generation = host(&mut operator, &token, "shared").await?.generation;
    // The machine stops abruptly: the Codex lane's journal still holds its running Attempt.
    let mut killed = shared
        .lanes()?
        .into_iter()
        .map(|(pid, _)| pid)
        .collect::<Vec<_>>();
    killed.extend(started.iter().map(|(_, pid)| *pid));
    killed.push(shared.supervisor.child.id() as i32);
    for pid in &killed {
        unsafe {
            libc::kill(*pid, libc::SIGKILL);
        }
    }
    let _ = shared.supervisor.child.wait();
    gone(&killed).await?;
    let lane = shared.state.join("hosts/shared/lanes/codex-0");
    assert!(lane.join("attempt.json").exists());
    assert_eq!(
        task(&mut operator, &token, &id).await?.state(),
        TaskState::Running
    );

    // The Host comes back without its Codex lane. No process will read that journal, so the
    // Host registers a new incarnation and its Attempt is fenced now, not at lease expiry.
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
                evidence: "the Codex lane was removed and its processes are gone".into(),
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
    assert!(!lane.exists());
    let retired = fs::read_dir(shared.state.join("hosts/shared/retired"))?
        .map(|entry| Ok(entry?.path().join("codex-0").join("attempt.json")))
        .collect::<Result<Vec<_>>>()?;
    assert_eq!(retired.len(), 1);
    assert!(retired[0].exists());

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
/// raises or lowers its lanes in place. Running work continues, the registration and its
/// generation stay, and a lowered lane finishes its Attempt before it stops.
async fn concurrency_changes_without_a_restart(database: String) -> Result<()> {
    let central = Central::start(&database)?;
    let token = central.operator.clone();
    let mut operator = client(&central.public).await?;
    let shared = SharedHost::start(&central, 1).await?;
    let ready = host_until(&mut operator, &token, |status| {
        status.phase() == HostPhase::Ready && status.capacity == 2
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
        "one Codex lane runs one Attempt"
    );
    let supervisor = shared.supervisor.child.id();

    // Raised: a second Codex lane starts under the same registration and takes the queued Task
    // while the first keeps running.
    let printed = shared.up(&serde_json::json!({"concurrency": 2}))?;
    ensure!(
        printed.contains(
            "Worker Host shared runs up to 2 Task Attempts per harness at once, changed from 1 without a restart."
        ),
        "{printed}"
    );
    settled(&mut operator, &token, &second, TaskState::Running).await?;
    shared.wait_started(2, 0).await?;
    let raised = host_until(&mut operator, &token, |status| status.capacity == 4).await?;
    assert_eq!(raised.generation, ready.generation);
    assert_eq!(
        task(&mut operator, &token, &first).await?.state(),
        TaskState::Running
    );
    // An unchanged file leaves everything alone.
    let printed = shared.up(&serde_json::json!({"concurrency": 2}))?;
    ensure!(printed.contains("left alone"), "{printed}");

    // Lowered: capacity drops at once, and the extra lane stops once its Attempt finished.
    let printed = shared.up(&serde_json::json!({"concurrency": 1}))?;
    ensure!(
        printed.contains("changed from 2 without a restart"),
        "{printed}"
    );
    host_until(&mut operator, &token, |status| status.capacity == 2).await?;
    assert_eq!(
        task(&mut operator, &token, &second).await?.state(),
        TaskState::Running,
        "a lowered lane keeps its running Attempt"
    );
    fs::write(shared.gate.join("release"), "")?;
    settled(&mut operator, &token, &first, TaskState::Succeeded).await?;
    settled(&mut operator, &token, &second, TaskState::Succeeded).await?;
    timeout(WAIT, async {
        loop {
            let codex = shared
                .lanes()?
                .into_iter()
                .filter(|(_, command)| command.contains("/lanes/codex-"))
                .count();
            if codex == 1 {
                break Ok::<_, anyhow::Error>(());
            }
            sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .context("the lowered Codex lane did not stop")??;
    assert!(
        !shared
            .state
            .join("hosts/shared/lanes/codex-1/attempt.json")
            .exists()
    );
    let third = submit(&mut operator, &token, "coder", "Task-c3").await?;
    settled(&mut operator, &token, &third, TaskState::Succeeded).await?;
    assert_eq!(shared.supervisor.child.id(), supervisor);
    let lowered = host(&mut operator, &token, "shared").await?;
    assert_eq!(lowered.generation, ready.generation);
    // The supervisor reports what it now runs.
    let status: Value = serde_json::from_slice(&fs::read(shared.state.join("supervisor.json"))?)?;
    assert_eq!(status["pid"], supervisor);
    assert_eq!(status["services"][0]["concurrency"], 1);

    // A raised lane that cannot start stays stopped; the supervisor and its lanes go on.
    let blocked = shared.state.join("hosts/shared/lanes/codex-2");
    fs::write(&blocked, "not a directory")?;
    let printed = shared.up(&serde_json::json!({"concurrency": 3}))?;
    ensure!(
        printed.contains("changed from 1 without a restart"),
        "{printed}"
    );
    assert_eq!(shared.supervisor.child.id(), supervisor);
    let log = fs::read_to_string(shared.state.join("logs/hosts/shared.log")).unwrap_or_default();
    ensure!(
        log.contains("codex-2 did not start and stays stopped"),
        "{log}"
    );
    let fourth = submit(&mut operator, &token, "coder", "Task-c4").await?;
    settled(&mut operator, &token, &fourth, TaskState::Succeeded).await?;
    assert_eq!(shared.supervisor.child.id(), supervisor);
    fs::remove_file(&blocked)?;
    // The lane that ran it clears its journal after the Task settles.
    timeout(WAIT, async {
        while ["codex-0", "codex-1"].iter().any(|lane| {
            shared
                .state
                .join(format!("hosts/shared/lanes/{lane}/attempt.json"))
                .exists()
        }) {
            sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .context("a lane kept its Attempt journal")?;

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
        status.phase() == HostPhase::Ready && status.capacity == 2
    })
    .await?;
    assert_eq!(again.generation, ready.generation);
    assert!(!shared.state.join("concurrency-request.json").exists());
    sleep(Duration::from_millis(500)).await;
    assert_eq!(host(&mut operator, &token, "shared").await?.capacity, 2);
    let status: Value = serde_json::from_slice(&fs::read(shared.state.join("supervisor.json"))?)?;
    assert_eq!(status["services"][0]["concurrency"], 1);
    assert_ne!(status["fingerprint"], "stale");
    shared.supervisor.stop().await?;
    Ok(())
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
async fn sqlite_shared_host_lanes_use_separate_workspace_checkouts() -> Result<()> {
    with_database(false, shared_host_lanes_use_separate_workspace_checkouts).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires an isolated PostgreSQL server via SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"]
async fn postgres_shared_host_lanes_use_separate_workspace_checkouts() -> Result<()> {
    with_database(true, shared_host_lanes_use_separate_workspace_checkouts).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sqlite_stranded_lane_attempts_are_fenced_on_restart() -> Result<()> {
    with_database(false, stranded_lane_attempts_are_fenced_on_restart).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires an isolated PostgreSQL server via SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"]
async fn postgres_stranded_lane_attempts_are_fenced_on_restart() -> Result<()> {
    with_database(true, stranded_lane_attempts_are_fenced_on_restart).await
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
async fn sqlite_replaced_shared_host_generation_fences_every_lane() -> Result<()> {
    with_database(false, replaced_shared_host_fences_every_lane).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires an isolated PostgreSQL server via SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"]
async fn postgres_replaced_shared_host_generation_fences_every_lane() -> Result<()> {
    with_database(true, replaced_shared_host_fences_every_lane).await
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
    let desktop = temp.path().join("desktop.log");
    let notifier = temp.path().join("desktop-notifier");
    fs::write(
        &notifier,
        format!(
            "#!/bin/sh\nprintf '%s|%s\\n--\\n' \"$1\" \"$2\" >> '{}'\n",
            desktop.display()
        ),
    )?;
    fs::set_permissions(&notifier, fs::Permissions::from_mode(0o700))?;
    yaml(
        &file,
        &serde_json::json!({"version":1,"services":{
            "control-plane":{"type":"control-plane","ports":["127.0.0.1:0"],
                "notify":[format!("webhook:{url}#hook-token"),"desktop"]},
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
    let output = Command::new(BIN)
        .args(["up", "--foreground", "--state-directory"])
        .arg(temp.path().join("invalid-state"))
        .arg("--file")
        .arg(&invalid)
        .env_clear()
        .output()?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    ensure!(!output.status.success() && stderr.contains("notify webhook must contain"));
    ensure!(!stderr.contains("private-token"), "{stderr}");

    let notifier_path = notifier.to_str().context("notifier path")?;
    let mut supervisor = Process::spawn(
        &state,
        Some(&file),
        &[
            ("FIXTURE_HOOK_SECRET", "synthetic-hook-secret"),
            ("SUPERTAG_TEST_NOTIFY_LOOPBACK_HTTP", "1"),
            ("SUPERTAG_TEST_DESKTOP_NOTIFIER", notifier_path),
        ]
        .into_iter()
        .chain(database_env(&database))
        .collect::<Vec<_>>(),
    )?;
    supervisor.ready()?;
    uses_database(&state, &database)?;
    let cli = |args: &[&str]| -> Result<String> {
        let output = Command::new(BIN)
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
    let output = Command::new(BIN)
        .args(["test", "notification", "--state-directory"])
        .arg(&state)
        .env_clear()
        .output()?;
    ensure!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        String::from_utf8(output.stdout)?,
        "webhook: delivered\ndesktop: delivered\n"
    );
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
            let lines = fs::read_to_string(&desktop).unwrap_or_default();
            if hooks.lock().await.len() == 2 && lines.matches("\n--\n").count() == 2 {
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
    assert!(
        fs::read_to_string(&desktop)?.ends_with(&format!("SuperTag needs you|{message}\n--\n"))
    );
    // The Inbox shows that the question reached the operator, and through what. Each
    // destination's message is settled after its send returns, so a destination this test saw
    // receive the message may not be recorded yet: wait for both settlements.
    let mut inbox = Value::Null;
    let settled = timeout(WAIT, async {
        loop {
            inbox = serde_json::from_str(&cli(&["get", "inbox-items", "--objective", "release"])?)?;
            let notification = &inbox["items"][0]["notification"];
            if notification["status"] == "delivered"
                && matches!(
                    notification["reason"].as_str(),
                    Some("via desktop,webhook" | "via webhook,desktop")
                )
            {
                return Ok::<_, anyhow::Error>(());
            }
            sleep(Duration::from_millis(50)).await;
        }
    })
    .await;
    match settled {
        Ok(result) => result?,
        Err(_) => anyhow::bail!("both deliveries were not recorded: {inbox}"),
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
    let output = Command::new(BIN)
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

// Each `supertag up` case runs with the local Control Plane on SQLite and on PostgreSQL.

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
