//! A surface message selects one of the GitHub Workspaces its Tag may read.
//!
//! TypeScript parity: `captureWorkspacePlan` in `packages/control-plane/src/index.ts` and
//! `packages/control-plane/src/repository-references.ts`. The choices are the cataloged GitHub
//! Workspaces whose repository the accepted policy grants `contents:read`, rather than the raw
//! permission entries, because a Rust Task can only run a cataloged Workspace.
use sqlx::{Any, Row, Transaction};
use supertag_protocol::v2::{GithubWorkspace, TaskPolicySnapshot, surface_location_scope};

use crate::{policy, store::Result};

/// The most cataloged GitHub Workspaces considered for one message.
const MAX_CHOICES_SCANNED: i64 = 1000;

pub(crate) const BY_REQUEST: &str = "request";
pub(crate) const BY_ORIGIN: &str = "origin";
pub(crate) const BY_DEFAULT: &str = "default";
/// The Task failed at admission: it named a repository while its Tag may use none.
pub(crate) const REFUSED: &str = "refused";
/// The Task runs without a Workspace and asks its requester to name one repository.
pub(crate) const REQUIRED: &str = "required";

pub(crate) enum Selection {
    /// No repository is involved; the Task runs without a Workspace.
    None,
    Selected {
        workspace_id: String,
        by: &'static str,
    },
    /// Several repositories qualify and the message names none of them.
    Required(String),
    /// The message names a repository while the Tag may use no GitHub Workspace.
    Refused(String),
}

/// `owner/repo` references, lowercased. The owner follows GitHub's owner rules (letters, digits,
/// and single inner hyphens), so paths such as `__pycache__/` or `./src` are not references.
/// Port of the TypeScript regular expression
/// `(?:^|[\s(`])(OWNER/[a-z0-9_.-]*[a-z0-9_-][a-z0-9_.-]*)(?=$|[\s),.:;!?`])`, flags `gi`.
pub(crate) fn repository_references(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut references = Vec::new();
    let mut position = 0;
    let mut start = 0;
    while start < chars.len() {
        let prefixed = (start == 0 && position == 0)
            || (start > position && {
                let before = chars[start - 1];
                before == '(' || before == '`' || before.is_whitespace()
            });
        if prefixed && let Some(end) = reference_at(&chars, start) {
            // Deliberate difference: TypeScript keeps a sentence's final dot (`acme/web.`), which
            // then names no repository. A reference never ends with a dot here.
            let mut last = end;
            while chars[last - 1] == '.' {
                last -= 1;
            }
            references.push(chars[start..last].iter().collect::<String>().to_lowercase());
            position = end;
            start = end;
            continue;
        }
        start += 1;
    }
    references
}

fn reference_at(chars: &[char], start: usize) -> Option<usize> {
    let alphanumeric = |index: usize| chars.get(index).is_some_and(char::is_ascii_alphanumeric);
    // Owner: one alphanumeric, then up to 38 alphanumerics or hyphens followed by one.
    if !alphanumeric(start) {
        return None;
    }
    let mut index = start + 1;
    while index - start < 39 {
        if alphanumeric(index) {
            index += 1;
        } else if chars.get(index) == Some(&'-') && alphanumeric(index + 1) {
            index += 2;
        } else {
            break;
        }
    }
    if index - start > 39 || chars.get(index) != Some(&'/') {
        return None;
    }
    let repository = index + 1;
    let mut run = repository;
    while chars
        .get(run)
        .is_some_and(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
    {
        run += 1;
    }
    let terminator = |index: usize| {
        chars
            .get(index)
            .is_none_or(|c| c.is_whitespace() || "),.:;!?`".contains(*c))
    };
    // The repository part needs one non-dot character and must end before a terminator. Within
    // the run only a dot terminates, so a shorter match always ends before a dot.
    (repository..=run)
        .rev()
        .filter(|end| *end == run || chars[*end] == '.')
        .find(|end| terminator(*end) && chars[repository..*end].iter().any(|c| *c != '.'))
}

/// A reference that must name a repository rather than a file: its repository part has no dot.
/// Only these refuse a request from a Tag that may use no GitHub repository.
pub(crate) fn unambiguous(reference: &str) -> bool {
    reference
        .split_once('/')
        .is_some_and(|(_, repository)| !repository.contains('.'))
}

/// The cataloged GitHub Workspaces the accepted policy may read, by repository then ID.
async fn choices_in(
    tx: &mut Transaction<'_, Any>,
    policy: &TaskPolicySnapshot,
) -> Result<Vec<GithubWorkspace>> {
    let rows = sqlx::query(
        "SELECT payload FROM supertag_v2_github_workspaces ORDER BY workspace_id LIMIT $1",
    )
    .bind(MAX_CHOICES_SCANNED)
    .fetch_all(&mut **tx)
    .await?;
    let mut choices = Vec::new();
    for row in rows {
        let value: GithubWorkspace = policy::decode(&row.try_get::<Vec<u8>, _>("payload")?)?;
        let Some(source) = value.source.as_ref() else {
            continue;
        };
        if super::require_read(policy, source).is_err()
            || super::require_account_in(tx, source).await.is_err()
            || (value.pull_request.is_some()
                && crate::external_effects::surface(
                    policy,
                    &source.account_id,
                    &format!("repository:{}", source.repository_id),
                    "pull-requests:create",
                )
                .is_err())
        {
            continue;
        }
        choices.push(value);
    }
    choices.sort_by(|a, b| {
        repository(a)
            .cmp(repository(b))
            .then(a.workspace_id.cmp(&b.workspace_id))
    });
    Ok(choices)
}

fn repository(value: &GithubWorkspace) -> &str {
    value
        .source
        .as_ref()
        .map_or("", |source| source.repository.as_str())
}

/// Chooses the Workspace for the first Task of a Session whose Tag configures none.
pub(crate) async fn select_in(
    tx: &mut Transaction<'_, Any>,
    tag_name: &str,
    policy: &TaskPolicySnapshot,
    prompt: &str,
) -> Result<Selection> {
    let choices = choices_in(tx, policy).await?;
    let mentioned = repository_references(prompt);
    if choices.is_empty() {
        // Only a reference that must be a repository refuses; a mentioned path is ordinary text.
        let requested: Vec<_> = mentioned.into_iter().filter(|r| unambiguous(r)).collect();
        return Ok(if requested.is_empty() {
            Selection::None
        } else {
            Selection::Refused(refusal(tag_name, &requested))
        });
    }
    // A GitHub message works in its own repository when the Tag may read it.
    let origin = policy.origin.as_ref().and_then(|origin| {
        match origin
            .scope
            .as_ref()
            .and_then(|scope| scope.provider.as_ref())
        {
            Some(surface_location_scope::Provider::Github(location)) => {
                Some((origin.account_id.as_str(), location.repository_id))
            }
            _ => None,
        }
    });
    if let Some((account, repository_id)) = origin
        && let Some(choice) = choices.iter().find(|choice| {
            choice.source.as_ref().is_some_and(|source| {
                source.account_id == account && source.repository_id == repository_id
            })
        })
    {
        return Ok(selected(choice, BY_ORIGIN));
    }
    // A request is a reference to one of the Tag's repositories, or one that must be a
    // repository; a mention that may be a path, such as src/index.ts, is ordinary text.
    let requested: Vec<_> = mentioned
        .into_iter()
        .filter(|reference| {
            unambiguous(reference) || choices.iter().any(|c| repository(c) == reference)
        })
        .collect();
    if !requested.is_empty() {
        if let Some(choice) = choices
            .iter()
            .find(|choice| requested.iter().any(|r| r == repository(choice)))
        {
            return Ok(selected(choice, BY_REQUEST));
        }
        // A named repository outside the Tag's choices does not refuse: the requester is asked to
        // choose one the Tag may read, as in TypeScript's `selection-required`.
        return Ok(required(&choices));
    }
    if let [only] = choices.as_slice() {
        return Ok(selected(only, BY_DEFAULT));
    }
    Ok(required(&choices))
}

fn required(choices: &[GithubWorkspace]) -> Selection {
    let mut names: Vec<_> = choices.iter().map(repository).collect();
    names.dedup();
    Selection::Required(format!(
        "\n\nThe request does not identify a GitHub repository. Ask the requester to name exactly one of: {}. Do not inspect or make claims about a repository until they do.",
        names.join(", ")
    ))
}

fn selected(choice: &GithubWorkspace, by: &'static str) -> Selection {
    Selection::Selected {
        workspace_id: choice.workspace_id.clone(),
        by,
    }
}

fn refusal(tag_name: &str, requested: &[String]) -> String {
    format!(
        "Tag {tag_name} is not allowed to use GitHub repository {}",
        requested.join(", ")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_owner_repo_references_but_not_paths() {
        assert_eq!(
            repository_references("In atemaguer/supertag, why does deploy fail?"),
            ["atemaguer/supertag"]
        );
        assert!(
            repository_references("Add a .gitignore that ignores __pycache__/. Thanks").is_empty()
        );
        assert!(repository_references("see ./src and ../lib").is_empty());
        assert_eq!(
            repository_references("open `acme/api` and socket/socket.io"),
            ["acme/api", "socket/socket.io"]
        );
        assert!(repository_references("look at src/lib/index.ts").is_empty());
        assert_eq!(
            repository_references("Compare Acme/API with acme/web."),
            ["acme/api", "acme/web"]
        );
        assert!(repository_references("bad--owner/x -lead/x trail-/x").is_empty());
        assert!(repository_references(&format!("{}/x", "a".repeat(40))).is_empty());
        assert_eq!(
            repository_references(&format!("{}/x", "a".repeat(39))),
            [format!("{}/x", "a".repeat(39))]
        );
    }

    #[test]
    fn treats_only_dotless_repository_parts_as_unambiguous() {
        assert!(unambiguous("atemaguer/supertag"));
        assert!(!unambiguous("src/index.ts"));
        assert!(!unambiguous("socket/socket.io"));
    }
}
