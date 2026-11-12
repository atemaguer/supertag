use crate::protocol::{Offer, Outcome};
use anyhow::{ensure, Context, Result};
use serde_json::{json, Value};
use std::{
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};
use tokio::process::Command;

pub struct LiveTask {
    pub offer: Offer,
    pub directory: PathBuf,
    pub codex_path: String,
    pub home: tempfile::TempDir,
    base_commit: String,
    language: &'static str,
}

pub struct ProcessGroup(pub u32);

impl ProcessGroup {
    pub fn terminate(&mut self) -> bool {
        if self.0 == 0 {
            return false;
        }
        let pid = self.0 as i32;
        self.0 = 0;
        // The child was launched with process_group(0), so this group belongs to this run.
        unsafe {
            let alive = libc::kill(-pid, 0) == 0;
            if alive {
                libc::kill(-pid, libc::SIGKILL);
            }
            alive
        }
    }
}

impl Drop for ProcessGroup {
    fn drop(&mut self) {
        self.terminate();
    }
}

#[cfg(test)]
mod process_group_tests {
    use super::ProcessGroup;
    use std::{os::unix::process::CommandExt, os::unix::process::ExitStatusExt, process::Command};

    #[test]
    fn reports_and_terminates_a_process_that_did_not_exit() {
        let mut child = Command::new("sleep")
            .arg("30")
            .process_group(0)
            .spawn()
            .expect("start process in its own group");
        let mut group = ProcessGroup(child.id());

        assert!(
            group.terminate(),
            "a running process must fail the leak check"
        );
        assert_eq!(
            child.wait().expect("reap process").signal(),
            Some(libc::SIGKILL)
        );
    }

    #[test]
    fn accepts_a_reaped_process_with_no_descendants() {
        let mut child = Command::new("true")
            .process_group(0)
            .spawn()
            .expect("start process in its own group");
        let mut group = ProcessGroup(child.id());

        assert!(child.wait().expect("reap process").success());
        assert!(
            !group.terminate(),
            "a reaped process must leave no group behind"
        );
    }
}

impl LiveTask {
    pub async fn prepare(root: &Path, output: &Path, language: &'static str) -> Result<Self> {
        let directory = output.join(language);
        std::fs::create_dir(&directory)
            .context("Live result directory already exists; choose a new output directory")?;
        let directory = directory.canonicalize()?;
        let home = tempfile::Builder::new()
            .prefix("st-codex-auth-")
            .tempdir_in("/tmp")?;
        let codex_home = home.path().join(".codex");
        std::fs::create_dir(&codex_home)?;
        std::fs::set_permissions(&codex_home, std::fs::Permissions::from_mode(0o700))?;
        let source_home = std::env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|path| PathBuf::from(path).join(".codex")))
            .context("Codex sign-in home is unavailable")?;
        let source = source_home.join("auth.json");
        // Copy only provider authentication, never user configuration, plugins or CP secrets.
        std::fs::copy(source, codex_home.join("auth.json"))
            .context("A file-backed Codex sign-in is required; run codex login first")?;
        std::fs::set_permissions(
            codex_home.join("auth.json"),
            std::fs::Permissions::from_mode(0o600),
        )?;
        let codex_path = if let Some(path) = std::env::var_os("SUPERTAG_SPIKE_CODEX") {
            PathBuf::from(path).canonicalize()?
        } else {
            std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
                .map(|path| path.join("codex"))
                .find(|path| path.is_file())
                .context("Install Codex CLI or set SUPERTAG_SPIKE_CODEX to its executable")?
                .canonicalize()?
        };
        let workspace = directory.join("workspace");
        let prepared = Command::new(root.join(".venv/bin/python"))
            .arg(root.join("live_project.py"))
            .arg("prepare")
            .arg(&workspace)
            .output()
            .await?;
        ensure!(
            prepared.status.success(),
            "Prepare live project: {}",
            String::from_utf8_lossy(&prepared.stderr)
        );
        let prepared: Value = serde_json::from_slice(&prepared.stdout)?;
        let offer = Offer {
            prompt: prepared["prompt"]
                .as_str()
                .context("Missing Task prompt")?
                .into(),
            scenario: "live".into(),
            workspace: workspace.to_string_lossy().into(),
            model: "gpt-6.1-sol".into(),
            reasoning_effort: "medium".into(),
            task_id: uuid::Uuid::new_v4().to_string(),
        };
        std::fs::write(
            directory.join("task.json"),
            serde_json::to_vec_pretty(&json!({
                "taskId": offer.task_id, "language": language, "model": offer.model,
                "reasoningEffort": offer.reasoning_effort, "prompt": offer.prompt,
                "workspace": offer.workspace, "baseCommit": prepared["baseCommit"]
            }))?,
        )?;
        Ok(Self {
            offer,
            directory,
            codex_path: codex_path.to_string_lossy().into(),
            home,
            base_commit: prepared["baseCommit"]
                .as_str()
                .context("Missing base commit")?
                .into(),
            language,
        })
    }

    pub async fn verify(&self, root: &Path, outcome: &Outcome) -> Result<Value> {
        let checked = Command::new(root.join(".venv/bin/python"))
            .arg(root.join("live_project.py"))
            .arg("verify")
            .arg(&self.offer.workspace)
            .arg(&self.base_commit)
            .arg(&outcome.commit)
            .output()
            .await?;
        ensure!(
            checked.status.success(),
            "Independent commit verification: {}",
            String::from_utf8_lossy(&checked.stderr)
        );
        let verification: Value = serde_json::from_slice(&checked.stdout)?;
        ensure!(
            verification["accepted"] == true,
            "Project verifier did not accept commit"
        );
        let native = native_evidence(
            &self.home.path().join(".codex/sessions"),
            &outcome.native_session_id,
        )?;
        ensure!(
            !native.is_empty(),
            "Native execution record did not confirm the selected model and effort"
        );
        for context in &native {
            ensure!(
                context["model"] == self.offer.model
                    && context["effort"] == self.offer.reasoning_effort,
                "Codex used a different model or reasoning effort: {context}"
            );
            ensure!(
                Path::new(context["cwd"].as_str().context("Native cwd missing")?).canonicalize()?
                    == Path::new(&self.offer.workspace).canonicalize()?,
                "Codex executed in a different workspace"
            );
        }
        let patch = Command::new("git")
            .current_dir(&self.offer.workspace)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .args(["format-patch", "--stdout", "-1", &outcome.commit])
            .output()
            .await?;
        ensure!(
            patch.status.success(),
            "Could not export the verified commit"
        );
        std::fs::write(self.directory.join("commit.patch"), patch.stdout)?;
        Ok(
            json!({"taskId": self.offer.task_id, "language": self.language, "harness": "codex",
            "nativeSessionId": outcome.native_session_id, "nativeExecution": native,
            "adapterReaped": true, "verification": verification}),
        )
    }
}

fn native_evidence(directory: &Path, thread_id: &str) -> Result<Vec<Value>> {
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let mut contexts = Vec::new();
    for entry in std::fs::read_dir(directory)? {
        let path = entry?.path();
        if path.is_dir() {
            contexts.extend(native_evidence(&path, thread_id)?);
        } else if path.extension().is_some_and(|value| value == "jsonl") {
            let text = std::fs::read_to_string(&path)?;
            let records: Vec<Value> = text
                .lines()
                .map(serde_json::from_str)
                .collect::<std::result::Result<_, _>>()?;
            if !records.iter().any(|record| {
                record["type"] == "session_meta" && record["payload"]["id"] == thread_id
            }) {
                continue;
            }
            for record in records
                .iter()
                .filter(|record| record["type"] == "turn_context")
            {
                let payload = &record["payload"];
                contexts.push(json!({"model": payload["model"], "effort": payload["effort"], "cwd": payload["cwd"]}));
            }
        }
    }
    Ok(contexts)
}
