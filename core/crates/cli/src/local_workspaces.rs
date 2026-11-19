//! `supertag workspace add`: makes a git repository on this machine a Workspace of the local
//! Worker Host. It adds the repository under the host's `workspaces` in supertag.yaml, then
//! applies the file to the running services as `supertag up` does.
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use clap::Args;
use serde_json::{Value, json};

use crate::{
    init::{self, Fixable, RepositoryProblem, Start},
    lifecycle, local_config,
};

#[derive(Args)]
pub struct AddArgs {
    /// The git repository to add, or a folder inside it. Default: the current directory.
    #[arg(value_name = "PATH")]
    path: Option<PathBuf>,
    /// The Workspace's name. Default: the repository folder's name, in lowercase letters, digits,
    /// and hyphens.
    #[arg(long)]
    name: Option<String>,
    /// The local host service in supertag.yaml to add it to, when there is more than one.
    #[arg(long)]
    host: Option<String>,
    /// Print the result as one JSON object, and progress on standard error.
    #[arg(long)]
    json: bool,
}

/// A Workspace `add` added, or found already there.
struct Added {
    workspace: String,
    host: String,
    root: PathBuf,
    start: Start,
    /// False when the host already mapped the repository.
    added: bool,
    /// Whether the running services now serve it; false when they are stopped.
    applied: bool,
}

impl Added {
    fn json(&self) -> Value {
        let mut value = json!({
            "version": 1,
            "workspace": self.workspace,
            "host": self.host,
            "path": self.root,
            "added": self.added,
            "applied": self.applied,
        });
        match &self.start {
            Start::Branch(branch) => value["ref"] = json!(branch),
            Start::Commit(commit) => value["baseCommit"] = json!(commit),
        }
        value
    }
}

pub async fn add(state_directory: Option<PathBuf>, args: AddArgs) -> Result<()> {
    if !args.json {
        let added = apply(state_directory, &args).await?;
        if !added.added {
            outln!(
                "{} is already Workspace {} of host {}.",
                added.root.display(),
                added.workspace,
                added.host
            );
        }
        let binding = match &added.start {
            Start::Branch(branch) => format!("--workspace-ref {branch}"),
            Start::Commit(commit) => format!("--workspace-base {commit}"),
        };
        outln!(
            "Create a Tag that works in it with the desktop app's New Tag form, or with supertag tag put TAG --instructions TEXT --harness HARNESS --workspace-id {} {binding}.",
            added.workspace
        );
        return Ok(());
    }
    // The app reading standard output gets one JSON object; progress goes to standard error.
    crate::terminal::progress_to_stderr();
    let result = apply(state_directory, &args).await;
    let value = match &result {
        Ok(added) => added.json(),
        Err(error) => init::failure(error),
    };
    crate::terminal::write_result(&format!("{}\n", serde_json::to_string(&value)?));
    result.map(drop)
}

async fn apply(state_directory: Option<PathBuf>, args: &AddArgs) -> Result<Added> {
    let repository = init::repository(args.path.as_deref()).map_err(|error| {
        let folder = args
            .path
            .clone()
            .or_else(|| std::env::current_dir().ok())
            .unwrap_or_default();
        match error.downcast_ref::<RepositoryProblem>() {
            Some(problem) => not_a_repository(problem, &folder).into(),
            None => error,
        }
    })?;
    let state = local_config::state_directory(state_directory)?;
    let path = state.join("supertag.yaml");
    if !path.is_file() {
        bail!(Fixable {
            error: format!("SuperTag is not set up in {}.", state.display()),
            fix: "Run supertag init in a git repository first; it adds that repository as the first Workspace.".into(),
            command: Some("supertag init"),
        });
    }
    // Refuse a file that does not load before changing anything.
    local_config::load(Some(path.clone()), &state)?.context("supertag.yaml disappeared")?;
    let text = std::fs::read_to_string(&path)?;
    let mut document = init::yaml_document(&text)?;
    let hosts = init::local_hosts(&document);
    let root = repository.root.clone();
    // A repository a local host already maps is not added twice.
    if let Some((host, workspace)) = hosts.iter().find_map(|host| {
        init::mapped_workspace(&document, std::slice::from_ref(host), &root)
            .map(|workspace| (host.clone(), workspace))
    }) {
        return Ok(Added {
            workspace,
            host,
            root,
            start: repository.start,
            added: false,
            applied: running(&state)?,
        });
    }
    let host = choose_host(&hosts, args.host.as_deref(), &path)?;
    let workspace = match &args.name {
        Some(name) => {
            if init::sanitize(name).as_deref() != Some(name.as_str()) {
                bail!(Fixable {
                    error: format!("{name} can't name a Workspace."),
                    fix: "Use lowercase letters, digits, and hyphens.".into(),
                    command: None,
                });
            }
            name.clone()
        }
        None => repository.name.clone(),
    };
    if let Some(other) = taken(&document, &workspace) {
        bail!(Fixable {
            error: format!("Workspace {workspace} already names {other}."),
            fix: "Choose another name with --name.".into(),
            command: None,
        });
    }
    if !init::rewritable(&text) {
        bail!(Fixable {
            error: "supertag.yaml has comments or variables that rewriting it would lose.".into(),
            fix: format!(
                "Add {workspace}: {} under host {host}'s workspaces in {} by hand, then run supertag up.",
                root.display(),
                path.display()
            ),
            command: None,
        });
    }
    document["services"][&host]["workspaces"][&workspace] = json!(root);
    init::rewrite(&path, &document)
        .context("adding this Workspace would make supertag.yaml invalid")?;
    outln!(
        "Added Workspace {workspace} ({}) to host {host} in {}.",
        root.display(),
        path.display()
    );
    // The running services serve it once `up` restarts the changed host; stopped ones, when
    // they next start.
    let applied = running(&state)?;
    if applied {
        let config =
            local_config::load(Some(path.clone()), &state)?.context("supertag.yaml disappeared")?;
        init::up(&state, config).await?;
    } else {
        outln!("SuperTag is stopped; supertag up starts it with this Workspace.");
    }
    Ok(Added {
        workspace,
        host,
        root,
        start: repository.start,
        added: true,
        applied,
    })
}

/// Whether this state directory's services run, or are starting.
fn running(state: &Path) -> Result<bool> {
    Ok(!matches!(
        lifecycle::inspect(state)?,
        lifecycle::Supervisor::Stopped
    ))
}

/// The local host to add the Workspace to: the one named, or the only one.
fn choose_host(hosts: &[String], named: Option<&str>, path: &Path) -> Result<String> {
    match (named, hosts) {
        (Some(named), _) if hosts.iter().any(|host| host == named) => Ok(named.to_owned()),
        (Some(named), _) => bail!(Fixable {
            error: format!("{} has no local host {named}.", path.display()),
            fix: format!("Choose one of: {}.", list(hosts)),
            command: None,
        }),
        (None, [host]) => Ok(host.clone()),
        (None, []) => bail!(Fixable {
            error: format!("{} has no local Worker Host.", path.display()),
            fix: "Run supertag init in a git repository to set one up.".into(),
            command: Some("supertag init"),
        }),
        (None, _) => bail!(Fixable {
            error: format!("{} has several local hosts.", path.display()),
            fix: format!("Choose one with --host: {}.", list(hosts)),
            command: None,
        }),
    }
}

fn list(hosts: &[String]) -> String {
    if hosts.is_empty() {
        "none".into()
    } else {
        hosts.join(", ")
    }
}

/// What another host's Workspace of this name maps, if one does: its path, or a remote
/// Workspace.
fn taken(document: &Value, workspace: &str) -> Option<String> {
    document["services"]
        .as_object()?
        .values()
        .find_map(|service| {
            let mapping = &service["workspaces"][workspace];
            if mapping.is_null() {
                return None;
            }
            Some(
                mapping
                    .as_str()
                    .or_else(|| mapping["path"].as_str())
                    .map_or_else(|| "a remote Workspace".to_owned(), str::to_owned),
            )
        })
}

/// Why `folder` can't be a Workspace, as one error with its fix.
fn not_a_repository(problem: &RepositoryProblem, folder: &Path) -> Fixable {
    match problem {
        RepositoryProblem::NoGit => Fixable {
            error: "Adding a Workspace needs git on PATH.".into(),
            fix: "Install git, then try again.".into(),
            command: None,
        },
        RepositoryProblem::NotRepository => Fixable {
            error: format!("{} is not in a git repository.", folder.display()),
            fix: "A Workspace is a git repository. Choose one, or run git init in it and make a first commit.".into(),
            command: Some("git init"),
        },
        RepositoryProblem::NoCommits(root) => Fixable {
            error: format!("{} has no commits yet.", root.display()),
            fix: "Tasks start from a commit, so make one, then try again.".into(),
            command: None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_workspace_name_is_taken_by_any_host_that_maps_it() {
        let document = json!({
            "services": {
                "control-plane": { "type": "control-plane" },
                "laptop": { "type": "host", "workspaces": { "app": "/work/app", "docs": { "path": "/work/docs" } } },
                "remote": { "type": "host", "control-plane": "https://p.example", "workspaces": { "handbook": { "remote": true } } },
            }
        });
        assert_eq!(taken(&document, "app").as_deref(), Some("/work/app"));
        assert_eq!(taken(&document, "docs").as_deref(), Some("/work/docs"));
        assert_eq!(
            taken(&document, "handbook").as_deref(),
            Some("a remote Workspace")
        );
        assert_eq!(taken(&document, "site"), None);
    }

    #[test]
    fn the_only_local_host_is_chosen_and_several_need_host() {
        let path = Path::new("/state/supertag.yaml");
        let one = ["laptop".to_owned()];
        let two = ["laptop".to_owned(), "spare".to_owned()];
        assert_eq!(choose_host(&one, None, path).unwrap(), "laptop");
        assert_eq!(choose_host(&two, Some("spare"), path).unwrap(), "spare");
        assert!(
            choose_host(&two, None, path)
                .unwrap_err()
                .to_string()
                .contains("--host: laptop, spare")
        );
        assert!(choose_host(&one, Some("other"), path).is_err());
        assert!(choose_host(&[], None, path).is_err());
    }

    #[test]
    fn the_json_result_names_where_sessions_start() {
        let added = |start| Added {
            workspace: "app".into(),
            host: "laptop".into(),
            root: PathBuf::from("/work/app"),
            start,
            added: true,
            applied: true,
        };
        let branch = added(Start::Branch("main".into())).json();
        assert_eq!(branch["ref"], "main");
        assert!(branch.get("baseCommit").is_none());
        assert_eq!(branch["workspace"], "app");
        let commit = added(Start::Commit("4f2c".into())).json();
        assert_eq!(commit["baseCommit"], "4f2c");
        assert!(commit.get("ref").is_none());
    }
}
