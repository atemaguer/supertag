//! Creating a Tag from the desktop's New Tag form: what the connected Worker Hosts can run it on,
//! and the Tag itself.

use serde::{Deserialize, Serialize};
use supertag_protocol::v2;
use tonic::Code;

use super::{GatewayState, MAX_PAGES, Result, Session, Tag, harness_name, rpc_error};

/// The runtime actions `supertag init` gives its lead Tag through its Permission Set: edit files
/// and run commands in its Workspace, and schedule its own follow-ups.
const NEW_TAG_ACTIONS: [&str; 3] = ["commands:execute", "files:write", "schedule:create"];

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
    /// How many Work Sessions it may have open at once; the Gateway's default when unset.
    #[serde(default)]
    pub max_work_sessions: Option<u32>,
}

impl NewTag {
    fn request(self) -> Result<v2::PutTagRequest> {
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
            allowed_actions: NEW_TAG_ACTIONS
                .iter()
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
        let mut options = TagOptions::default();
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
            for host in page.hosts {
                if host.revoked_at_ms.is_some() || host.removed_at_ms.is_some() {
                    continue;
                }
                let kinds = host
                    .harnesses
                    .iter()
                    .map(|harness| harness.harness_kind())
                    .chain([host.harness_kind()]);
                options.harnesses.extend(
                    kinds
                        .filter(|kind| *kind != v2::HarnessKind::Unspecified)
                        .map(harness_name),
                );
                options.workspaces.extend(host.workspace_ids);
            }
            if page.next_cursor.is_empty() || page.next_cursor == cursor {
                break;
            }
            cursor = page.next_cursor;
        }
        options.harnesses.sort();
        options.harnesses.dedup();
        options.workspaces.sort();
        options.workspaces.dedup();
        Ok(options)
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

    /// Creates a Tag, refusing an ID or name another Tag holds.
    pub async fn create_tag(&self, connection_id: &str, tag: NewTag) -> Result<Tag> {
        let mut request = tag.request()?;
        let session = self.session(connection_id).await?;
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

    #[test]
    fn a_new_tag_gets_the_lead_tag_defaults_and_never_replaces_another() {
        let request = NewTag {
            tag_id: "reviewer".into(),
            name: Some(" Reviewer ".into()),
            harness: "claude_code".into(),
            workspace_id: Some("supertag".into()),
            max_work_sessions: Some(3),
        }
        .request()
        .unwrap();
        assert_eq!(request.max_work_sessions, Some(3));
        assert_eq!(request.tag_id, "reviewer");
        assert_eq!(request.name.as_deref(), Some("Reviewer"));
        assert_eq!(request.harness_kind, v2::HarnessKind::ClaudeCode as i32);
        assert_eq!(
            request.allowed_actions,
            ["commands:execute", "files:write", "schedule:create"]
        );
        assert_eq!(request.workspace.unwrap().workspace_id, "supertag");
        assert_eq!(request.expected_revision, Some(0));

        let plain = NewTag {
            tag_id: "lead".into(),
            name: Some("lead".into()),
            harness: "codex".into(),
            workspace_id: Some(String::new()),
            max_work_sessions: None,
        }
        .request()
        .unwrap();
        assert!(plain.name.is_none());
        assert_eq!(
            plain.allowed_actions,
            [
                "commands:execute",
                "files:write",
                "schedule:create",
                "web:fetch"
            ]
        );
        assert!(plain.workspace.is_none());

        for harness in ["", "unspecified", "unknown"] {
            assert!(
                NewTag {
                    tag_id: "lead".into(),
                    name: None,
                    harness: harness.into(),
                    workspace_id: None,
                    max_work_sessions: None,
                }
                .request()
                .is_err()
            );
        }
    }
}
