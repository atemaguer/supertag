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
            "reader":{"type":"host","adapter":ADAPTER,"restart":"unless-stopped","concurrency":1},
            "writer":{"type":"host","adapter":ADAPTER,"concurrency":1}
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

#[tokio::test]
async fn env_file_credentials_reach_only_the_services_and_harnesses_that_need_them() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let state = temp.path().join("state");
    let home = temp.path().join("home");
    fs::create_dir(&home)?;
    let env_file = temp.path().join("services.env");
    fs::write(
        &env_file,
        "FIXTURE_PORT=0\nOPENAI_API_KEY=file-openai\nexport CODEX_API_KEY=file-codex\nCURSOR_API_KEY='file-cursor'\nSUPERTAG_GATEWAY_TOKEN=file-gateway-token\n",
    )?;
    fs::set_permissions(&env_file, fs::Permissions::from_mode(0o600))?;
    let file = temp.path().join("supertag.yaml");
    yaml(
        &file,
        &serde_json::json!({"env_file":"services.env","services":{
            "control-plane":{"type":"control-plane","ports":["127.0.0.1:${FIXTURE_PORT}"]},
            "codex-host":{"type":"host","harnesses":["codex"],"concurrency":1},
            "reporter":{"type":"host","adapter":ADAPTER,"adapter-args":["--report-environment"],"concurrency":1}
        }}),
    )?;
    let path = std::env::var("PATH")?;
    let home_value = home.to_str().context("UTF-8 home")?;
    let mut supervisor = Process::spawn(
        &state,
        Some(&file),
        &[
            ("PATH", &path),
            ("HOME", home_value),
            ("CODEX_API_KEY", "shell-codex"),
            ("ANTHROPIC_API_KEY", "shell-anthropic"),
            ("SUPERTAG_GITHUB_TOKEN", "shell-github"),
            ("FIXTURE_UNRELATED", "shell-unrelated"),
        ],
    )?;
    let endpoint = supervisor.ready()?;
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
    let base = ["HOME", "PATH", "SUPERTAG_LOCAL_SERVICE_LIFELINE"];
    let expected = |extra: &[&'static str]| {
        let mut names = base.iter().chain(extra).copied().collect::<Vec<_>>();
        names.sort_unstable();
        names
    };
    assert_eq!(
        names(&roles["control-plane"]),
        expected(&["SUPERTAG_DATABASE_URL", "SUPERTAG_GATEWAY_TOKEN"])
    );
    assert_eq!(
        names(&roles["gateway"]),
        expected(&["SUPERTAG_GATEWAY_TOKEN", "SUPERTAG_OPERATOR_TOKEN"])
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
    for environment in roles.values() {
        assert_eq!(environment["HOME"], home_value);
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
    ] {
        assert!(!log.contains(value));
    }
    supervisor.stop().await?;
    Ok(())
}

/// A Control Plane and Gateway outside the supervisor, so one Host test runs on either database.
struct Central {
    services: Vec<Child>,
    public: String,
    operator: String,
    _checkpoints: tempfile::TempDir,
}
impl Central {
    fn start(database: &str) -> Result<Self> {
        let checkpoints = tempfile::tempdir()?;
        let gateway_token = Uuid::new_v4().simple().to_string();
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
            .env_clear()
            .env("SUPERTAG_DATABASE_URL", database)
            .env("SUPERTAG_GATEWAY_TOKEN", &gateway_token)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .spawn()?;
        let private = listen(&mut plane)?;
        let mut services = vec![plane];
        let mut gateway = Command::new(BIN)
            .args([
                "gateway",
                "--control-plane",
                &private,
                "--listen",
                "127.0.0.1:0",
            ])
            .arg("--checkpoint-directory")
            .arg(checkpoints.path().join("checkpoints"))
            .env_clear()
            .env("SUPERTAG_GATEWAY_TOKEN", &gateway_token)
            .env("SUPERTAG_OPERATOR_TOKEN", &operator)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .spawn()?;
        let public = listen(&mut gateway);
        services.push(gateway);
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
    _temp: tempfile::TempDir,
    state: PathBuf,
    gate: PathBuf,
    supervisor: Process,
}
impl SharedHost {
    async fn start(central: &Central, concurrency: u32) -> Result<Self> {
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
        let key = Uuid::new_v4().to_string();
        operator
            .create_auth_key(authenticated_request(
                CreateAuthKeyRequest {
                    host_id: "shared".into(),
                    operation_id: Uuid::new_v4().to_string(),
                    key_digest: Sha256::digest(key.as_bytes()).to_vec(),
                    expires_in_ms: 600000,
                    all_tags: true,
                    allowed_tag_ids: vec![],
                },
                &central.operator,
                None,
            )?)
            .await?;
        let file = temp.path().join("supertag.yaml");
        yaml(
            &file,
            &serde_json::json!({"env_file":"services.env","services":{"shared":{
                "type":"host","control-plane":central.public,"auth-key":"join",
                "harnesses":["codex","openai-agents"],"concurrency":concurrency,
                "models":{"codex":["fixture-model"],"openai-agents":"fixture-model"}
            }},"secrets":{"join":{"environment":"FIXTURE_JOIN_KEY"}}}),
        )?;
        let state = temp.path().join("state");
        let path = format!("{}:/usr/bin:/bin", bin.display());
        let supervisor = Process::spawn(
            &state,
            Some(&file),
            &[
                ("PATH", &path),
                ("HOME", home.to_str().context("UTF-8 home")?),
                ("FIXTURE_JOIN_KEY", &key),
            ],
        )?;
        assert_eq!(supervisor.ready()?, "ready");
        Ok(Self {
            _temp: temp,
            state,
            gate,
            supervisor,
        })
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

async fn tag(
    operator: &mut operator_client::OperatorClient<Channel>,
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
    operator: &mut operator_client::OperatorClient<Channel>,
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
    operator: &mut operator_client::OperatorClient<Channel>,
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
    operator: &mut operator_client::OperatorClient<Channel>,
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
    operator: &mut operator_client::OperatorClient<Channel>,
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
    let mut shared = SharedHost::start(&central, 1).await?;
    let ready = host_until(&mut operator, &token, |status| {
        status.phase() == HostPhase::Ready && status.available_slots == 2
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
    let replaced = worker_host_client::WorkerHostClient::connect(central.public.clone())
        .await?
        .register_host(authenticated_request(
            RegisterHostRequest {
                incarnation_id: Uuid::new_v4().to_string(),
            },
            credential,
            None,
        )?)
        .await?
        .into_inner();
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
    let log = fs::read_to_string(&shared.supervisor.log)?;
    assert!(
        log.contains("no longer current") || log.contains("exited unexpectedly"),
        "{log}"
    );
    gone(&lanes).await?;
    fs::write(shared.gate.join("release"), "")?;
    for id in &ids {
        assert_eq!(
            task(&mut operator, &token, id).await?.state(),
            TaskState::Uncertain
        );
    }
    Ok(())
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
