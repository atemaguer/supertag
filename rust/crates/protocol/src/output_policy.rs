use std::collections::BTreeSet;

use regex::Regex;
use tonic::Status;

use crate::{
    artifacts::{MAX_ARTIFACT_BYTES, MAX_ARTIFACT_FILES, validate_artifact_path},
    v2::{
        HarnessExecutionProfile, HarnessKind, OutputGitMode, OutputPathPatterns, Task,
        TaskOutputPolicy,
    },
};

pub const REQUIRED_OUTPUT_MISSING: &str = "Required Task output is missing";

pub fn normalize(input: Option<&TaskOutputPolicy>) -> Result<Option<TaskOutputPolicy>, Status> {
    input.map(canonical_policy).transpose()
}

fn canonical_policy(input: &TaskOutputPolicy) -> Result<TaskOutputPolicy, Status> {
    let directory = input.directory.as_deref().unwrap_or("outputs");
    validate_artifact_path(directory)?;
    if directory.contains(['*', '?', '!', '{', '}', '[', ']']) || excluded(directory) {
        return Err(Status::invalid_argument("invalid Task output directory"));
    }
    let max_files = input.max_files.unwrap_or(MAX_ARTIFACT_FILES as u32);
    let max_bytes = input.max_bytes.unwrap_or(MAX_ARTIFACT_BYTES);
    if !(1..=MAX_ARTIFACT_FILES as u32).contains(&max_files)
        || !(1..=MAX_ARTIFACT_BYTES).contains(&max_bytes)
    {
        return Err(Status::invalid_argument(
            "invalid Task output file or byte limit",
        ));
    }
    let git = match OutputGitMode::try_from(input.git) {
        Ok(OutputGitMode::Unspecified) => OutputGitMode::Reference,
        Ok(mode) => mode,
        Err(_) => return Err(Status::invalid_argument("invalid Git output mode")),
    };
    let default_include = [format!("{directory}/**")];
    Ok(TaskOutputPolicy {
        directory: Some(directory.into()),
        required: canonical_patterns(&input.required)?,
        include: Some(OutputPathPatterns {
            patterns: canonical_patterns(
                input
                    .include
                    .as_ref()
                    .map_or(default_include.as_slice(), |patterns| {
                        patterns.patterns.as_slice()
                    }),
            )?,
        }),
        exclude: canonical_patterns(&input.exclude)?,
        git: git as i32,
        max_files: Some(max_files),
        max_bytes: Some(max_bytes),
    })
}

fn canonical_patterns(input: &[String]) -> Result<Vec<String>, Status> {
    if input.len() > MAX_ARTIFACT_FILES {
        return Err(Status::invalid_argument("too many Task output patterns"));
    }
    let mut unique = BTreeSet::new();
    for pattern in input {
        validate_artifact_path(pattern)?;
        if pattern.contains(['!', '{', '}', '[', ']']) {
            return Err(Status::invalid_argument(
                "Task output patterns support only *, **, and ?",
            ));
        }
        unique.insert(pattern.clone());
    }
    Ok(unique.into_iter().collect())
}

pub fn supports(task: &Task, harness: HarnessKind, profile: &HarnessExecutionProfile) -> bool {
    task.output_policy.is_none()
        || (profile.declared_task_outputs
            && !profile.remote_file_workspace
            && profile.shared_execution.is_none()
            && matches!(harness, HarnessKind::Codex | HarnessKind::ClaudeCode)
            && task.workspace.is_some()
            && task
                .allowed_actions
                .iter()
                .any(|action| action == "files:read"))
}

pub fn excluded(path: &str) -> bool {
    path.split('/').any(|part| {
        let name = part.to_ascii_lowercase();
        matches!(
            name.as_str(),
            ".git"
                | "node_modules"
                | ".venv"
                | "venv"
                | "__pycache__"
                | ".cache"
                | "inputs"
                | ".ssh"
                | ".aws"
                | ".gnupg"
                | ".supertag"
                | ".env"
        ) || name.starts_with(".env.")
            || [".pem", ".key", ".p12", ".pfx"]
                .iter()
                .any(|suffix| name.ends_with(suffix))
            || name
                .strip_prefix("artifact-")
                .is_some_and(|id| id.len() == 64 && id.bytes().all(|byte| byte.is_ascii_hexdigit()))
    })
}

pub struct OutputSelection {
    required: Vec<(String, Regex)>,
    include: Vec<(String, Regex)>,
    exclude: Vec<(String, Regex)>,
}

impl OutputSelection {
    pub fn new(policy: &TaskOutputPolicy) -> Result<Self, Status> {
        let policy = canonical_policy(policy)?;
        Ok(Self {
            required: compile(policy.required)?,
            include: compile(policy.include.expect("canonical include").patterns)?,
            exclude: compile(policy.exclude)?,
        })
    }

    pub fn roots(&self) -> Vec<String> {
        let roots: BTreeSet<_> = self
            .include
            .iter()
            .chain(&self.required)
            .map(|(pattern, _)| {
                pattern
                    .split('/')
                    .take_while(|part| !part.contains(['*', '?']))
                    .collect::<Vec<_>>()
                    .join("/")
            })
            .collect();
        roots
            .iter()
            .filter(|path| !roots.contains("") || path.is_empty())
            .filter(|path| {
                !path
                    .match_indices('/')
                    .any(|(index, _)| roots.contains(&path[..index]))
            })
            .cloned()
            .collect()
    }

    pub fn permits(&self, path: &str) -> bool {
        validate_artifact_path(path).is_ok()
            && !excluded(path)
            && (self.requires(path)
                || self
                    .include
                    .iter()
                    .any(|(_, pattern)| pattern.is_match(path)))
            && !self
                .exclude
                .iter()
                .any(|(_, pattern)| pattern.is_match(path))
    }

    pub fn requires(&self, path: &str) -> bool {
        self.required
            .iter()
            .any(|(_, pattern)| pattern.is_match(path))
    }

    pub fn validate(&self, paths: &[String]) -> Result<(), Status> {
        if paths.iter().any(|path| !self.permits(path)) {
            return Err(Status::invalid_argument(
                "file is outside the accepted Task output policy",
            ));
        }
        if self
            .required
            .iter()
            .any(|(_, pattern)| !paths.iter().any(|path| pattern.is_match(path)))
        {
            return Err(Status::failed_precondition(REQUIRED_OUTPUT_MISSING));
        }
        Ok(())
    }
}

fn compile(patterns: Vec<String>) -> Result<Vec<(String, Regex)>, Status> {
    patterns
        .into_iter()
        .map(|pattern| {
            let mut expression = String::from(r"\A");
            let mut chars = pattern.chars().peekable();
            while let Some(character) = chars.next() {
                match character {
                    '*' if chars.next_if_eq(&'*').is_some() => {
                        if chars.next_if_eq(&'/').is_some() {
                            expression.push_str("(?:.*/)?");
                        } else {
                            expression.push_str(".*");
                        }
                    }
                    '*' => expression.push_str("[^/]*"),
                    '?' => expression.push_str("[^/]"),
                    other => expression.push_str(&regex::escape(&other.to_string())),
                }
            }
            expression.push_str(r"\z");
            let regex = Regex::new(&expression)
                .map_err(|_| Status::invalid_argument("invalid Task output pattern"))?;
            Ok((pattern, regex))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn required_files_override_include_and_respect_exclusions() {
        let policy = TaskOutputPolicy {
            required: vec!["reports/**/*.md".into()],
            exclude: vec!["reports/private/**".into()],
            ..Default::default()
        };
        let rules = OutputSelection::new(&policy).unwrap();
        assert_eq!(rules.roots(), ["outputs", "reports"]);
        assert!(rules.permits("reports/report.md"));
        assert!(rules.permits("reports/week/report.md"));
        assert!(!rules.permits("reports/private/report.md"));
        assert!(!rules.permits("outputs/.env.production"));
        assert!(rules.validate(&["outputs/existing.txt".into()]).is_err());
        assert!(rules.validate(&["reports/report.md".into()]).is_ok());
    }

    #[test]
    fn include_presence_and_admission_defaults_are_canonical() {
        let empty = TaskOutputPolicy::default();
        let canonical = normalize(Some(&empty)).unwrap().unwrap();
        assert_eq!(normalize(Some(&canonical)).unwrap().unwrap(), canonical);
        let required_only = TaskOutputPolicy {
            include: Some(OutputPathPatterns::default()),
            required: vec!["reports/final.txt".into()],
            ..Default::default()
        };
        let rules = OutputSelection::new(&required_only).unwrap();
        assert_eq!(rules.roots(), ["reports/final.txt"]);
        assert!(!rules.permits("outputs/unrequested.txt"));
        assert!(rules.permits("reports/final.txt"));
        for invalid in ["../escape", "outputs/**", ".ssh"] {
            let policy = TaskOutputPolicy {
                directory: Some(invalid.into()),
                ..Default::default()
            };
            assert!(normalize(Some(&policy)).is_err());
        }
    }
}
