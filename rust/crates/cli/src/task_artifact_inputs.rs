use anyhow::{Result, ensure};
use supertag_protocol::{artifacts::validate_artifact_path, v2::TaskArtifactInputSelection};

pub(crate) fn parse(arguments: Vec<String>) -> Result<Vec<TaskArtifactInputSelection>> {
    let mut selections = std::collections::BTreeMap::<String, Vec<String>>::new();
    for argument in arguments {
        let (id, path) = argument
            .split_once(':')
            .ok_or_else(|| anyhow::anyhow!("use --artifact-input ARTIFACT_ID:PATH"))?;
        ensure!(!id.is_empty(), "artifact ID is required");
        validate_artifact_path(path)?;
        selections
            .entry(id.to_owned())
            .or_default()
            .push(path.to_owned());
    }
    Ok(selections
        .into_iter()
        .map(|(artifact_id, paths)| TaskArtifactInputSelection {
            artifact_id,
            paths,
            require_accepted: false,
        })
        .collect())
}
