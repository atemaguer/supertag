//! Changed-path reports for overlap warnings, shared by Worker Hosts and the Control Plane.

/// The most changed paths one Attempt reports. More are reported as truncated.
pub const MAX_CHANGED_PATHS: usize = 500;

/// A Workspace-relative path that names no Git metadata. Same rule as the TypeScript `addPath`
/// in `apps/cli/src/worker-changed-paths.ts`.
pub fn reportable_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 4096
        && !path.starts_with('/')
        && !path.contains('\0')
        && path
            .split('/')
            .all(|part| !matches!(part, "" | "." | ".." | ".git"))
}

#[cfg(test)]
mod tests {
    use super::reportable_path;

    #[test]
    fn reports_only_workspace_relative_paths_outside_git_metadata() {
        for path in ["README.md", "src/a.ts", "a/.gitignore", "dir/.github/x"] {
            assert!(reportable_path(path), "{path}");
        }
        for path in [
            "",
            "/etc/passwd",
            "a//b",
            "./a",
            "a/../b",
            ".git/config",
            "x/.git/y",
        ] {
            assert!(!reportable_path(path), "{path}");
        }
        assert!(!reportable_path(&"a".repeat(4097)));
    }
}
