use std::{fs::File, io::Read, path::Path};

use anyhow::{Context, Result, ensure};
use serde::Deserialize;
use supertag_protocol::{
    MAX_MESSAGE_BYTES,
    output_policy::normalize,
    v2::{OutputGitMode, OutputPathPatterns, TaskOutputPolicy},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PolicyFile {
    directory: Option<String>,
    #[serde(default)]
    required: Vec<String>,
    include: Option<Vec<String>>,
    #[serde(default)]
    exclude: Vec<String>,
    git: Option<GitMode>,
    max_files: Option<u32>,
    max_bytes: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum GitMode {
    Reference,
    Capture,
    Ignore,
}

pub(crate) fn read(path: &Path) -> Result<TaskOutputPolicy> {
    let mut bytes = Vec::new();
    File::open(path)
        .context("open Task output policy")?
        .take((MAX_MESSAGE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= MAX_MESSAGE_BYTES,
        "Task output policy is too large"
    );
    let input: PolicyFile = serde_json::from_slice(&bytes).context("parse Task output policy")?;
    let git = match input.git {
        None | Some(GitMode::Reference) => OutputGitMode::Reference,
        Some(GitMode::Capture) => OutputGitMode::Capture,
        Some(GitMode::Ignore) => OutputGitMode::Ignore,
    };
    normalize(Some(&TaskOutputPolicy {
        directory: input.directory,
        required: input.required,
        include: input
            .include
            .map(|patterns| OutputPathPatterns { patterns }),
        exclude: input.exclude,
        git: git as i32,
        max_files: input.max_files,
        max_bytes: input.max_bytes,
    }))?
    .context("Task output policy is missing")
}
