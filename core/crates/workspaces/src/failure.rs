//! Why a Workspace operation failed, in words that are safe to show the person who asked.
//!
//! An error's full chain goes to the Worker Host log. It can hold what Git printed about an
//! untrusted repository and the host's own paths, so a reply never carries it. What a reply may
//! say is the [`failure_cause`]: the messages this crate wrote, a failed Git command by its name
//! alone, and a [`Refusal`] in place of everything else when the repository is one SuperTag does
//! not support.
use std::fmt;

use crate::git::GitExit;

/// A repository or checkout SuperTag refuses, said plainly: what it is and what to do about it.
/// Its text names no host path and quotes no Git output.
#[derive(Debug)]
pub struct Refusal(pub String);

impl fmt::Display for Refusal {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for Refusal {}

/// A [`Refusal`] as an error.
#[cfg(test)]
pub(crate) fn refusal(text: impl Into<String>) -> anyhow::Error {
    Refusal(text.into()).into()
}

/// The longest cause shown.
const MAX_CAUSE_CHARS: usize = 400;

/// A short cause of `error` to show beside a fixed failure message. A [`Refusal`] anywhere in
/// the chain is the whole cause. Otherwise it is the chain's messages down to the first failed
/// Git command, which is named without its output; each message is one line, and an absolute
/// path in it is cut to its last component.
pub fn failure_cause(error: &anyhow::Error) -> String {
    // Found whether it is the error itself or a context added to one.
    if let Some(refusal) = error.downcast_ref::<Refusal>() {
        return bounded(&one_line(&refusal.0));
    }
    let mut parts: Vec<String> = Vec::new();
    for cause in error.chain() {
        if let Some(exit) = cause.downcast_ref::<GitExit>() {
            parts.push(exit.summary());
            break;
        }
        let part = without_host_paths(&one_line(&cause.to_string()));
        if !part.is_empty() && parts.last() != Some(&part) {
            parts.push(part);
        }
    }
    bounded(&parts.join(": "))
}

fn one_line(text: &str) -> String {
    text.split(|character: char| character.is_control())
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn bounded(text: &str) -> String {
    if text.chars().count() <= MAX_CAUSE_CHARS {
        return text.to_owned();
    }
    let cut: String = text.chars().take(MAX_CAUSE_CHARS - 1).collect();
    format!("{}…", cut.trim_end())
}

/// `text` with each absolute path of two or more components cut to its last one, so a message
/// that names a file under the host's state or the operator's home says which file, not where.
fn without_host_paths(text: &str) -> String {
    text.split(' ')
        .map(|word| {
            let start = word.find('/').filter(|at| {
                // Absolute: the slash starts the word or follows punctuation such as a quote.
                word[..*at]
                    .chars()
                    .all(|character| !character.is_alphanumeric() && character != '.')
            });
            match start {
                Some(at) if word[at + 1..].trim_end_matches('/').contains('/') => {
                    let path = word[at..].trim_end_matches('/');
                    let last = path.rsplit('/').next().unwrap_or_default();
                    format!("{}…/{last}", &word[..at])
                }
                _ => word.to_owned(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cause_names_a_failed_git_command_without_what_it_printed() {
        let error = anyhow::Error::from(GitExit::new(
            Some(128),
            "git index-pack",
            b"fatal: object 1234 in /Users/someone/private/repo is corrupt",
        ))
        .context("copy the commit's history from the source repository");
        assert_eq!(
            failure_cause(&error),
            "copy the commit's history from the source repository: `git index-pack` failed (exit 128)"
        );
    }

    #[test]
    fn a_refusal_is_the_whole_cause() {
        let error = refusal("the repository has Git submodules, which SuperTag does not support")
            .context("list the files")
            .context("prepare");
        assert_eq!(
            failure_cause(&error),
            "the repository has Git submodules, which SuperTag does not support"
        );
    }

    #[test]
    fn a_cause_is_one_bounded_line_without_host_paths() {
        let error = anyhow::anyhow!(
            "workspace directory is not a real directory: /Users/someone/.supertag/hosts/a/b\nsecond line"
        )
        .context("open \"/var/folders/x/y/state\"");
        assert_eq!(
            failure_cause(&error),
            "open \"…/state\": workspace directory is not a real directory: …/b second line"
        );
        // A repository's own relative paths and Git's names stay.
        let error = anyhow::anyhow!("`git ls-tree` output exceeds its 256 MiB size limit")
            .context("materialized file differs from its pinned tree: src/app/main.rs");
        assert_eq!(
            failure_cause(&error),
            "materialized file differs from its pinned tree: src/app/main.rs: `git ls-tree` output exceeds its 256 MiB size limit"
        );
        let long = anyhow::anyhow!("x".repeat(1000));
        assert_eq!(failure_cause(&long).chars().count(), MAX_CAUSE_CHARS);
    }
}
