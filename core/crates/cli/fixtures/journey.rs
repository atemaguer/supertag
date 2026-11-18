//! `--journey`: the turns scripts/test_e2e_journeys.py drives, chosen by a prompt line.
//!
//! - `start: TITLE | INSTRUCTION` starts one Work Session on this Tag with that instruction.
//! - `edit: LINE` appends LINE to `workspace.txt` in the Task's checkout, creating it.
//! - A merge follow-up, whose prompt lists files with conflict markers, keeps both sides of each
//!   conflict and removes the markers, as its prompt asks.
//! - Anything else, such as a Work Session's report, changes nothing.
//!
//! With `--journey-environment=DIR`, each turn first writes the environment it received to
//! `DIR/TASK_ID.env`, so the script can check that no Workspace credential reached the harness.
use anyhow::{Context, Result, ensure};
use supertag_protocol::{
    authenticated_request,
    v2::{
        AdapterBootstrap, HarnessRun, HarnessStartWorkSessionRequest, Task,
        harness_work_sessions_client::HarnessWorkSessionsClient,
    },
};

pub fn enabled() -> bool {
    std::env::args().any(|arg| arg == "--journey")
}

/// The first prompt line that starts with `marker`, without it: a Work Session's turn carries
/// its instruction inside SuperTag's own framing.
fn directive<'a>(prompt: &'a str, marker: &str) -> Option<&'a str> {
    prompt
        .lines()
        .find_map(|line| line.trim().strip_prefix(marker))
}

pub async fn exercise(
    bootstrap: &AdapterBootstrap,
    run: &HarnessRun,
    task: &Task,
) -> Result<String> {
    if let Some(directory) = std::env::args().find_map(|arg| {
        arg.strip_prefix("--journey-environment=")
            .map(std::path::PathBuf::from)
    }) {
        let received = std::env::vars_os()
            .map(|(name, value)| {
                format!("{}={}\n", name.to_string_lossy(), value.to_string_lossy())
            })
            .collect::<String>();
        std::fs::write(directory.join(format!("{}.env", task.task_id)), received)?;
    }
    if let Some(rest) = directive(&task.prompt, "start: ") {
        let (title, instruction) = rest
            .split_once(" | ")
            .context("start: TITLE | INSTRUCTION")?;
        ensure!(
            run.coordination
                .as_ref()
                .is_some_and(|scope| scope.may_start_work_session),
            "this turn may not start a Work Session"
        );
        let mut work = HarnessWorkSessionsClient::connect(bootstrap.endpoint.clone()).await?;
        let started = work
            .start(authenticated_request(
                HarnessStartWorkSessionRequest {
                    operation_id: format!("journey-{}", task.task_id),
                    title: title.trim().into(),
                    instruction: instruction.trim().into(),
                    workspace_id: None,
                    target_tag_id: None,
                    harness: None,
                },
                &bootstrap.token,
                None,
            )?)
            .await?
            .into_inner();
        return Ok(format!("Started {}", started.work_session_id));
    }
    if let Some(line) = directive(&task.prompt, "edit: ") {
        ensure!(task.workspace.is_some(), "an edit needs a bound Workspace");
        let workspace = std::env::var_os(supertag_worker_host::WORKSPACE_DIRECTORY)
            .map(std::path::PathBuf::from)
            .context("prepared workspace was not supplied")?;
        let path = workspace.join("workspace.txt");
        let before = match std::fs::read_to_string(&path) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(error) => return Err(error.into()),
        };
        std::fs::write(&path, format!("{before}{line}\n"))?;
        return Ok(format!("Change: {line}"));
    }
    if task.prompt.contains("These files have conflict markers:") {
        let workspace = std::env::var_os(supertag_worker_host::WORKSPACE_DIRECTORY)
            .map(std::path::PathBuf::from)
            .context("prepared workspace was not supplied")?;
        let mut resolved = Vec::new();
        for path in task
            .prompt
            .lines()
            .filter_map(|line| line.strip_prefix("- "))
        {
            ensure!(
                !path.starts_with('/') && !path.split('/').any(|part| part == ".."),
                "conflicting path {path} leaves the checkout"
            );
            let file = workspace.join(path);
            let text = std::fs::read_to_string(&file)?;
            let kept = text
                .lines()
                .filter(|line| {
                    !(line.starts_with("<<<<<<<")
                        || line.starts_with("=======")
                        || line.starts_with(">>>>>>>"))
                })
                .map(|line| format!("{line}\n"))
                .collect::<String>();
            ensure!(kept != text, "{path} has no conflict markers");
            std::fs::write(&file, kept)?;
            resolved.push(path.to_owned());
        }
        ensure!(!resolved.is_empty(), "the follow-up names no file");
        return Ok(format!(
            "Resolved {}, keeping both sides",
            resolved.join(", ")
        ));
    }
    Ok("Noted".into())
}
