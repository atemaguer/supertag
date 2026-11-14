//! Verified admitted Skills copied into the disposable native HOME only.
use anyhow::{Context, Result, ensure};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
};
use supertag_protocol::v2::{ResolvedSkill, Task};
use supertag_workspaces::packages;
use tokio_util::sync::CancellationToken;

pub(crate) struct Prepared {
    pub paths: BTreeSet<String>,
    pub manifest: String,
}
pub(crate) fn prepare(task: &Task, skills: &[ResolvedSkill], home: &Path) -> Result<Prepared> {
    let mut admitted = BTreeMap::new();
    if let Some(snapshot) = &task.policy_snapshot {
        for set in &snapshot.context_sets {
            for item in &set.items {
                admitted.insert((set.set_id.as_str(), item.item_id.as_str()), item);
            }
        }
    }
    let home = home.canonicalize()?;
    packages::open_directory(&home)?;
    let root = home.join("skills");
    std::fs::create_dir(&root)?;
    let cancel = CancellationToken::new();
    let mut seen = BTreeSet::new();
    let mut resolved = BTreeMap::new();
    let mut paths = BTreeSet::new();
    for skill in skills {
        let pin = skill
            .pin
            .as_ref()
            .context("resolved Skill is missing its accepted identity")?;
        let key = (pin.set_id.as_str(), pin.item_id.as_str());
        let item = admitted
            .get(&key)
            .context("resolved Skill is outside accepted context")?;
        ensure!(
            seen.insert(key)
                && item.r#type == "supertag/skill"
                && item.version == 1
                && item.item_key == pin.item_key,
            "resolved Skill differs from accepted context"
        );
        let config: Value = serde_json::from_str(&item.config_json)?;
        ensure!(
            config["reference"].as_str() == Some(pin.reference.as_str())
                && config
                    .get("version")
                    .and_then(Value::as_str)
                    .is_none_or(|v| v == pin.version)
                && config
                    .get("digest")
                    .and_then(Value::as_str)
                    .is_none_or(|v| v.trim().to_lowercase() == pin.digest),
            "resolved Skill differs from the accepted package pin"
        );
        let value = (pin.version.clone(), pin.digest.clone());
        if let Some(previous) = resolved.get(&pin.reference) {
            ensure!(
                previous == &value,
                "Skill reference has conflicting package pins"
            );
            continue;
        }
        let package = packages::capture(Path::new(&skill.local_path), &cancel)
            .context("resolved Skill package is unsafe or unavailable")?;
        ensure!(
            package.digest == pin.digest,
            "resolved Skill package changed before native delivery"
        );
        let name = format!("skill-{:x}", Sha256::digest(pin.reference.as_bytes()));
        let destination = root.join(name);
        packages::materialize(&package, &destination, &cancel)?;
        paths.insert(
            destination
                .join("SKILL.md")
                .to_str()
                .context("Skill path is not UTF-8")?
                .to_owned(),
        );
        resolved.insert(pin.reference.clone(), value);
    }
    ensure!(
        admitted
            .iter()
            .all(|(key, item)| !item.required || seen.contains(key)),
        "a required Context Item has no Codex delivery"
    );
    let manifest = if resolved.is_empty() {
        String::new()
    } else {
        format!("{:x}", Sha256::digest(serde_json::to_vec(&resolved)?))
    };
    Ok(Prepared { paths, manifest })
}

/// Native discovery includes built-in and repository Skills. Explicitly disable
/// all non-admitted entries before starting a turn, including when selection is empty.
pub(crate) fn inventory(value: &Value) -> Result<Vec<(String, bool)>> {
    let entries = value["data"]
        .as_array()
        .context("Codex returned no Skill inventory")?;
    ensure!(
        entries.len() == 1,
        "Codex Skill inventory does not match one workspace"
    );
    ensure!(
        entries[0]["errors"].as_array().is_some_and(Vec::is_empty),
        "Codex could not load a Skill package"
    );
    let skills = entries[0]["skills"]
        .as_array()
        .context("Codex returned invalid Skill inventory")?;
    ensure!(skills.len() <= 256, "Codex Skill inventory exceeds limit");
    let mut result = vec![];
    let mut seen = BTreeSet::new();
    for skill in skills {
        let path = skill["path"].as_str().context("Codex Skill has no path")?;
        let enabled = skill["enabled"]
            .as_bool()
            .context("Codex Skill has no enabled state")?;
        ensure!(
            PathBuf::from(path).is_absolute() && seen.insert(path),
            "Codex Skill inventory has invalid paths"
        );
        result.push((path.into(), enabled));
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use supertag_protocol::v2::{ContextPin, ContextSet, PolicyContextItem, TaskPolicySnapshot};
    #[test]
    fn delivery_verifies_digest_copies_privately_and_requires_every_required_item() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let root = temp.path().canonicalize()?;
        let source = root.join("source");
        std::fs::create_dir(&source)?;
        std::fs::write(
            source.join("SKILL.md"),
            "---\nname: review\ndescription: Review.\n---\nRead.\n",
        )?;
        let digest = packages::capture(&source, &CancellationToken::new())?.digest;
        let task = Task {
            policy_snapshot: Some(TaskPolicySnapshot {
                context_sets: vec![ContextSet {
                    set_id: "set".into(),
                    items: vec![PolicyContextItem {
                        artifact_snapshot: None,
                        item_id: "item".into(),
                        item_key: "review".into(),
                        r#type: "supertag/skill".into(),
                        version: 1,
                        required: true,
                        config_json: r#"{"reference":"review"}"#.into(),
                    }],
                    ..Default::default()
                }],
                ..Default::default()
            }),
            ..Default::default()
        };
        let home = root.join("home");
        std::fs::create_dir(&home)?;
        let missing = root.join("missing");
        std::fs::create_dir(&missing)?;
        assert!(prepare(&task, &[], &missing).is_err());
        let skill = ResolvedSkill {
            pin: Some(ContextPin {
                set_id: "set".into(),
                item_id: "item".into(),
                item_key: "review".into(),
                reference: "review".into(),
                digest,
                ..Default::default()
            }),
            local_path: source.to_str().unwrap().into(),
        };
        let delivered = prepare(&task, std::slice::from_ref(&skill), &home)?;
        assert_eq!(delivered.paths.len(), 1);
        assert!(!delivered.manifest.is_empty());
        let path = delivered.paths.first().unwrap();
        std::fs::write(source.join("SKILL.md"), "changed")?;
        assert!(std::fs::read_to_string(path)?.contains("name: review"));
        let another = root.join("another");
        std::fs::create_dir(&another)?;
        assert!(prepare(&task, &[skill], &another).is_err());
        Ok(())
    }
}
