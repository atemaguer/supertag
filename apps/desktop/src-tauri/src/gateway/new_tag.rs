//! Creating a Tag from the desktop's New Tag form: what the connected Worker Hosts can run it on,
//! and the Tag itself.

use serde::{Deserialize, Serialize};
use supertag_protocol::v2;
use tonic::Code;

use super::{GatewayState, MAX_PAGES, Result, Session, Tag, harness_name, rpc_error};

/// The runtime actions `supertag init` gives its lead Tag through its Permission Set: read and
/// edit files in its Workspace, and schedule its own follow-ups. files:write does not imply
/// files:read: Claude Code's Read, Glob and Grep need it.
const NEW_TAG_ACTIONS: [&str; 3] = ["files:read", "files:write", "schedule:create"];

/// Running commands, which `supertag init` also gives a lead whose host can run them.
const COMMANDS: &str = "commands:execute";

/// What `supertag init` adds for a Codex lead: current Codex models run commands only in Codex
/// code mode, which SuperTag starts only for a Task that may also fetch from the web. Without it,
/// every Task of a new Codex Tag that runs a command fails.
const CODEX_ACTIONS: [&str; 1] = ["web:fetch"];

/// What a new Tag can run on: the harnesses and Workspaces the Gateway's Worker Hosts offer.
#[derive(Serialize, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TagOptions {
    pub harnesses: Vec<String>,
    pub workspaces: Vec<String>,
    /// Offered harnesses no host runs commands for: a Tag on one reads and edits files but runs
    /// no commands, as `supertag init` sets up such a lead.
    pub no_commands: Vec<String>,
}

/// Whether a host whose harness reports `profile` runs that harness's commands. Codex sandboxes
/// its own; Claude Code runs them in its own sandbox on a host with `command_sandbox`; Claude Code,
/// Cursor, and OpenCode otherwise need the host's opt-in to run them unsandboxed, a local-vm
/// container, or a remote sandbox. As the Control Plane places Tasks.
fn runs_commands(kind: v2::HarnessKind, profile: Option<&v2::HarnessExecutionProfile>) -> bool {
    match kind {
        v2::HarnessKind::ClaudeCode | v2::HarnessKind::Cursor | v2::HarnessKind::Opencode => {
            profile.is_some_and(|profile| {
                profile.allow_unsandboxed_commands
                    || (kind == v2::HarnessKind::ClaudeCode && profile.command_sandbox)
                    || profile.shared_execution.is_some()
                    || profile.remote_file_workspace
            })
        }
        _ => true,
    }
}

/// The options the current hosts offer: their harnesses, which of those none runs commands for,
/// and their Workspaces. A revoked, removed, or offline host offers nothing.
fn options_of(hosts: &[v2::WorkerHostStatus]) -> TagOptions {
    let mut options = TagOptions::default();
    let mut commands = Vec::new();
    for host in hosts {
        if host.revoked_at_ms.is_some()
            || host.removed_at_ms.is_some()
            || matches!(
                host.phase(),
                v2::HostPhase::Offline | v2::HostPhase::Revoked
            )
        {
            continue;
        }
        let kinds = host
            .harnesses
            .iter()
            .map(|harness| (harness.harness_kind(), harness.execution_profile.as_ref()))
            .chain([(host.harness_kind(), host.execution_profile.as_ref())])
            .filter(|(kind, _)| *kind != v2::HarnessKind::Unspecified);
        for (kind, profile) in kinds {
            options.harnesses.push(harness_name(kind));
            if runs_commands(kind, profile) {
                commands.push(harness_name(kind));
            }
        }
        options
            .workspaces
            .extend(host.workspace_ids.iter().cloned());
    }
    options.harnesses.sort();
    options.harnesses.dedup();
    options.no_commands = options
        .harnesses
        .iter()
        .filter(|harness| !commands.contains(harness))
        .cloned()
        .collect();
    options.workspaces.sort();
    options.workspaces.dedup();
    options
}

/// A new Tag: its permanent ID, an optional display name, its harness, and optionally the
/// Workspace its Sessions start in.
#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NewTag {
    pub tag_id: String,
    pub name: Option<String>,
    pub harness: String,
    pub workspace_id: Option<String>,
    /// The branch a local Workspace's Sessions start from, such as the one `supertag workspace
    /// add` read from a folder just added. Otherwise the branch its other Tags follow.
    #[serde(default)]
    pub workspace_ref: Option<String>,
    /// The commit they start from instead, for a folder whose HEAD is detached.
    #[serde(default)]
    pub workspace_commit: Option<String>,
    /// How many Work Sessions it may have open at once; the Gateway's default when unset.
    #[serde(default)]
    pub max_work_sessions: Option<u32>,
}

impl NewTag {
    /// The request that creates it. `commands` says whether it may run commands: false when its
    /// harness's hosts run none, so its Tasks do not wait for a host that would.
    fn request(self, commands: bool) -> Result<v2::PutTagRequest> {
        let harness = v2::HarnessKind::from_str_name(&format!(
            "HARNESS_KIND_{}",
            self.harness.to_ascii_uppercase()
        ))
        .filter(|kind| *kind != v2::HarnessKind::Unspecified)
        .ok_or("Choose a harness for the Tag.")?;
        let name = self
            .name
            .map(|name| name.trim().to_owned())
            .filter(|name| !name.is_empty() && *name != self.tag_id);
        Ok(v2::PutTagRequest {
            tag_id: self.tag_id,
            name,
            harness_kind: harness as i32,
            allowed_actions: commands
                .then_some(COMMANDS)
                .iter()
                .chain(NEW_TAG_ACTIONS.iter())
                .chain(if harness == v2::HarnessKind::Codex {
                    CODEX_ACTIONS.as_slice()
                } else {
                    &[]
                })
                .map(|action| (*action).to_owned())
                .collect(),
            workspace: self
                .workspace_id
                .filter(|workspace| !workspace.is_empty())
                .map(|workspace_id| v2::WorkspaceSpec {
                    workspace_id,
                    base_ref: self.workspace_ref.unwrap_or_default(),
                    base_commit: self.workspace_commit.unwrap_or_default(),
                    ..Default::default()
                }),
            max_work_sessions: self.max_work_sessions,
            // Zero creates a new Tag and never replaces an existing one.
            expected_revision: Some(0),
            ..Default::default()
        })
    }
}

/// The branch a new Tag on a local Workspace follows: the one the Workspace's other Tags follow,
/// such as the lead Tag `supertag init` created, preferring a lead. A local Workspace needs a
/// branch or a commit, and the desktop knows neither on its own.
fn branch_to_follow(tags: &[v2::Tag], workspace_id: &str) -> Option<String> {
    tags.iter()
        .filter_map(|tag| {
            let workspace = tag.workspace.as_ref()?;
            (workspace.workspace_id == workspace_id
                && workspace.remote.is_none()
                && !workspace.base_ref.is_empty())
            .then_some((tag.lead, &workspace.base_ref))
        })
        .max_by_key(|(lead, _)| *lead)
        .map(|(_, branch)| branch.clone())
}

impl Session {
    async fn followed_branch(&self, workspace_id: &str) -> Result<Option<String>> {
        let mut tags = Vec::new();
        let mut cursor = String::new();
        for _ in 0..MAX_PAGES {
            let page = self
                .operator()
                .list_tags(self.request(v2::ListTagsRequest {
                    limit: 100,
                    cursor: cursor.clone(),
                    include_retired: false,
                }))
                .await
                .map_err(rpc_error)?
                .into_inner();
            tags.extend(page.tags);
            if page.next_cursor.is_empty() || page.next_cursor == cursor {
                break;
            }
            cursor = page.next_cursor;
        }
        Ok(branch_to_follow(&tags, workspace_id))
    }

    async fn tag_options(&self) -> Result<TagOptions> {
        let mut hosts = Vec::new();
        let mut cursor = String::new();
        for _ in 0..MAX_PAGES {
            let page = self
                .operator()
                .list_hosts(self.request(v2::ListHostsRequest {
                    limit: 100,
                    cursor: cursor.clone(),
                }))
                .await
                .map_err(rpc_error)?
                .into_inner();
            hosts.extend(page.hosts);
            if page.next_cursor.is_empty() || page.next_cursor == cursor {
                break;
            }
            cursor = page.next_cursor;
        }
        Ok(options_of(&hosts))
    }
}

impl GatewayState {
    /// The harnesses and Workspaces of the Gateway's current Worker Hosts. Only an operator
    /// may list hosts, as only an operator may create a Tag.
    pub async fn tag_options(&self, connection_id: &str) -> Result<TagOptions> {
        let session = self.session(connection_id).await?;
        let options = session.tag_options().await?;
        self.current(&session, options).await
    }

    /// The state directory of the local services this connection reaches, where `supertag
    /// workspace add` adds a folder. Only the local Gateway has one: a folder of this Mac means
    /// nothing to another Gateway's hosts.
    pub async fn local_state_of(&self, connection_id: &str) -> Result<std::path::PathBuf> {
        self.session(connection_id).await?;
        let local = self.0.read().await.origin.as_deref() == Some(super::local::LOCAL);
        match (&self.2, local) {
            (Some(state), true) => Ok(state.clone()),
            _ => Err("Only the local Gateway can add a folder of this Mac as a Workspace.".into()),
        }
    }

    /// Creates a Tag, refusing an ID or name another Tag holds.
    pub async fn create_tag(&self, connection_id: &str, tag: NewTag) -> Result<Tag> {
        let session = self.session(connection_id).await?;
        // A harness its current hosts run no commands for gets none, as init's lead does. With
        // no host serving it yet, the host that will is not known, so it may run them.
        // When the hosts can't be listed, creating the Tag says why: only an operator may.
        let commands = session
            .tag_options()
            .await
            .map_or(true, |options| !options.no_commands.contains(&tag.harness));
        let mut request = tag.request(commands)?;
        if let Some(workspace) = request.workspace.as_mut()
            && workspace.base_ref.is_empty()
            && workspace.base_commit.is_empty()
            && let Some(branch) = session.followed_branch(&workspace.workspace_id).await?
        {
            workspace.base_ref = branch;
        }
        let tag = session
            .operator()
            .put_tag(session.request(request))
            .await
            .map_err(|status| match status.code() {
                Code::AlreadyExists => "A Tag with that ID or name already exists.".to_owned(),
                Code::PermissionDenied => "Only an operator can create Tags.".to_owned(),
                _ => rpc_error(status),
            })?
            .into_inner();
        self.current(&session, Tag::from(tag)).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_tag_follows_the_branch_its_workspace_s_lead_follows() {
        let tag = |tag_id: &str, lead: bool, workspace: &str, base_ref: &str| v2::Tag {
            tag_id: tag_id.into(),
            lead,
            workspace: Some(v2::WorkspaceSpec {
                workspace_id: workspace.into(),
                base_ref: base_ref.into(),
                ..Default::default()
            }),
            ..Default::default()
        };
        let tags = [
            tag("other", false, "demo", "feature"),
            tag("lead", true, "demo", "main"),
            tag("elsewhere", true, "site", "trunk"),
            tag("pinned", false, "pinned", ""),
        ];
        assert_eq!(branch_to_follow(&tags, "demo").as_deref(), Some("main"));
        assert_eq!(branch_to_follow(&tags, "site").as_deref(), Some("trunk"));
        assert_eq!(
            branch_to_follow(&tags[..1], "demo").as_deref(),
            Some("feature")
        );
        assert_eq!(branch_to_follow(&tags, "pinned"), None);
        assert_eq!(branch_to_follow(&tags, "unknown"), None);
    }

    fn new_tag(harness: &str, workspace_id: Option<&str>) -> NewTag {
        NewTag {
            tag_id: "lead".into(),
            name: None,
            harness: harness.into(),
            workspace_id: workspace_id.map(str::to_owned),
            workspace_ref: None,
            workspace_commit: None,
            max_work_sessions: None,
        }
    }

    #[test]
    fn a_new_tag_gets_the_lead_tag_defaults_and_never_replaces_another() {
        let request = NewTag {
            tag_id: "reviewer".into(),
            name: Some(" Reviewer ".into()),
            max_work_sessions: Some(3),
            ..new_tag("claude_code", Some("supertag"))
        }
        .request(true)
        .unwrap();
        assert_eq!(request.max_work_sessions, Some(3));
        assert_eq!(request.tag_id, "reviewer");
        assert_eq!(request.name.as_deref(), Some("Reviewer"));
        assert_eq!(request.harness_kind, v2::HarnessKind::ClaudeCode as i32);
        assert_eq!(
            request.allowed_actions,
            [
                "commands:execute",
                "files:read",
                "files:write",
                "schedule:create"
            ]
        );
        let workspace = request.workspace.unwrap();
        assert_eq!(workspace.workspace_id, "supertag");
        // Without a branch, create_tag looks up the one the Workspace's other Tags follow.
        assert_eq!(workspace.base_ref, "");
        assert_eq!(request.expected_revision, Some(0));

        let plain = NewTag {
            name: Some("lead".into()),
            ..new_tag("codex", Some(""))
        }
        .request(true)
        .unwrap();
        assert!(plain.name.is_none());
        assert_eq!(
            plain.allowed_actions,
            [
                "commands:execute",
                "files:read",
                "files:write",
                "schedule:create",
                "web:fetch"
            ]
        );
        assert!(plain.workspace.is_none());

        for harness in ["", "unspecified", "unknown"] {
            assert!(new_tag(harness, None).request(true).is_err());
        }
    }

    #[test]
    fn a_tag_whose_hosts_run_no_commands_gets_none() {
        let request = new_tag("claude_code", None).request(false).unwrap();
        assert_eq!(
            request.allowed_actions,
            ["files:read", "files:write", "schedule:create"]
        );
    }

    #[test]
    fn a_folder_just_added_names_where_sessions_start() {
        let branch = NewTag {
            workspace_ref: Some("trunk".into()),
            ..new_tag("codex", Some("site"))
        }
        .request(true)
        .unwrap()
        .workspace
        .unwrap();
        assert_eq!(
            (branch.workspace_id.as_str(), branch.base_ref.as_str()),
            ("site", "trunk")
        );
        let commit = NewTag {
            workspace_commit: Some("4f2c0d1e9b8a7c6d5e4f3a2b1c0d9e8f7a6b5c4d".into()),
            ..new_tag("codex", Some("site"))
        }
        .request(true)
        .unwrap()
        .workspace
        .unwrap();
        assert_eq!(
            commit.base_commit,
            "4f2c0d1e9b8a7c6d5e4f3a2b1c0d9e8f7a6b5c4d"
        );
    }

    #[test]
    fn every_ready_host_offers_its_harnesses_and_workspaces() {
        let slot = |kind: v2::HarnessKind, unsandboxed: bool| v2::HostHarnessCapacity {
            harness_kind: kind as i32,
            execution_profile: Some(v2::HarnessExecutionProfile {
                allow_unsandboxed_commands: unsandboxed,
                ..Default::default()
            }),
            ..Default::default()
        };
        let host = |phase: v2::HostPhase, harnesses, workspaces: &[&str]| v2::WorkerHostStatus {
            phase: phase as i32,
            harnesses,
            workspace_ids: workspaces.iter().map(|id| (*id).to_owned()).collect(),
            ..Default::default()
        };
        // The laptop init set up: a Codex lead, with Claude Code beside it, unsandboxed off.
        let laptop = host(
            v2::HostPhase::Ready,
            vec![
                slot(v2::HarnessKind::Codex, false),
                slot(v2::HarnessKind::ClaudeCode, false),
            ],
            &["supertag", "site"],
        );
        let options = options_of(std::slice::from_ref(&laptop));
        assert_eq!(options.harnesses, ["claude_code", "codex"]);
        assert_eq!(options.workspaces, ["site", "supertag"]);
        assert_eq!(options.no_commands, ["claude_code"]);

        // Another host that runs Claude Code's commands makes it run them; an offline one, or a
        // revoked one, offers nothing.
        let mut revoked = host(
            v2::HostPhase::Ready,
            vec![slot(v2::HarnessKind::Cursor, true)],
            &["revoked"],
        );
        revoked.revoked_at_ms = Some(1);
        let options = options_of(&[
            laptop,
            host(
                v2::HostPhase::Busy,
                vec![slot(v2::HarnessKind::ClaudeCode, true)],
                &[],
            ),
            host(
                v2::HostPhase::Offline,
                vec![slot(v2::HarnessKind::Opencode, false)],
                &["stale"],
            ),
            revoked,
        ]);
        assert_eq!(options.harnesses, ["claude_code", "codex"]);
        assert_eq!(options.workspaces, ["site", "supertag"]);
        assert!(options.no_commands.is_empty());
    }
}
