//! The ordinary native `up -f` entry point owns every service and its private enrollment.
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
            .args(["up", "--state-directory"])
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
async fn client(endpoint: &str) -> Result<operator_client::OperatorClient<Channel>> {
    Ok(operator_client::OperatorClient::connect(endpoint.to_owned()).await?)
}
async fn host(
    client: &mut operator_client::OperatorClient<Channel>,
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
    client: &mut operator_client::OperatorClient<Channel>,
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
#[tokio::test]
async fn configured_local_hosts_restart_and_reap_with_stable_private_state() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let state = temp.path().join("state");
    let file = temp.path().join("supertag.yaml");
    yaml(
        &file,
        &serde_json::json!({"version":1,"services":{
            "control-plane":{"type":"control-plane","ports":["127.0.0.1:0"]},
            "reader":{"type":"host","adapter":ADAPTER,"restart":"unless-stopped"},
            "writer":{"type":"host","adapter":ADAPTER}
        }}),
    )?;
    let mut supervisor = Process::spawn(&state, Some(&file), &[])?;
    let endpoint = supervisor.ready()?;
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
    // Discover the default file from state, and reuse exactly the enrolled Gateway origin.
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
        .args(["get-task", "--state-directory"])
        .arg(&state)
        .arg("no-task")
        .env_clear()
        .output()?;
    assert!(!rejected.status.success());
    assert!(String::from_utf8_lossy(&rejected.stderr).contains("not running"));
    Ok(())
}
#[tokio::test]
async fn remote_host_only_env_and_file_auth_keys_are_needed_only_for_first_join() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let central = temp.path().join("central");
    let central_file = temp.path().join("central.yaml");
    yaml(
        &central_file,
        &serde_json::json!({"services":{"control-plane":{"type":"control-plane","ports":["127.0.0.1:0"]}}}),
    )?;
    let mut server = Process::spawn(&central, Some(&central_file), &[])?;
    let endpoint = server.ready()?;
    let credential = token(&central)?;
    let mut operator = client(&endpoint).await?;
    let mut keys = Vec::new();
    for name in ["env-host", "file-host"] {
        let key = Uuid::new_v4().to_string();
        operator
            .create_auth_key(authenticated_request(
                CreateAuthKeyRequest {
                    host_id: name.into(),
                    operation_id: Uuid::new_v4().to_string(),
                    key_digest: Sha256::digest(key.as_bytes()).to_vec(),
                    expires_in_ms: 600000,
                    all_tags: true,
                    allowed_tag_ids: vec![],
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
        "env-host":{"type":"host","control-plane":endpoint,"adapter":ADAPTER,"auth-key":"env"},
        "file-host":{"type":"host","control-plane":endpoint,"adapter":ADAPTER,"auth-key":"file"}
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

#[tokio::test]
async fn local_provision_creates_ordered_resources_once_and_preserves_operator_edits() -> Result<()>
{
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
    let mut supervisor = Process::spawn(&state, Some(&file), &[])?;
    let endpoint = supervisor.ready()?;
    let credential = token(&state)?;
    let channel = Channel::from_shared(endpoint.clone())?.connect().await?;
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
    let mut restarted = Process::spawn(&state, Some(&file), &[])?;
    assert_eq!(restarted.ready()?, endpoint);
    let channel = Channel::from_shared(endpoint)?.connect().await?;
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

#[tokio::test]
async fn unsafe_provision_source_stops_before_hosts_start_and_reaps_services() -> Result<()> {
    for linked in [false, true] {
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
        let mut supervisor = Process::spawn(&state, Some(&file), &[])?;
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
        let address = fs::read_to_string(state.join("gateway-address"))?;
        assert!(
            tokio::net::TcpStream::connect(address.trim())
                .await
                .is_err()
        );
    }
    Ok(())
}
