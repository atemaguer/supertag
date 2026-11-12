use prost::Message;
use tonic::Status;

use crate::{
    MAX_MESSAGE_BYTES,
    v2::{HarnessWorkspaceRequest, WorkspaceGrepMode, harness_workspace_request::Operation},
};

pub const MAX_WORKSPACE_TOOL_OUTPUT_BYTES: usize = 64 * 1024;
const MAX_PATH_BYTES: usize = 4096;
const MAX_TIMEOUT_MS: u32 = 120_000;

/// Validate the caller's operation before it reaches the sandbox provider.
/// The provider still confines physical paths to the prepared Workspace.
pub fn validate_workspace_operation(
    request: &HarnessWorkspaceRequest,
    actions: &[String],
) -> Result<(), Status> {
    if request.encoded_len() > MAX_MESSAGE_BYTES {
        return Err(Status::resource_exhausted(
            "workspace operation is oversized",
        ));
    }
    let operation = request
        .operation
        .as_ref()
        .ok_or_else(|| Status::invalid_argument("workspace operation is required"))?;
    let allowed = |required| actions.iter().any(|action| action == required);
    let authorized = match operation {
        Operation::Read(_) | Operation::List(_) | Operation::Glob(_) | Operation::Grep(_) => {
            allowed("files:read")
        }
        Operation::Write(_) | Operation::Edit(_) => allowed("files:write"),
        Operation::Command(_) => allowed("files:write") && allowed("commands:execute"),
    };
    if !authorized {
        return Err(Status::permission_denied(
            "workspace operation is not admitted",
        ));
    }
    let valid = match operation {
        Operation::Read(input) => {
            relative_path(&input.path, false) && positive(input.offset) && positive(input.limit)
        }
        Operation::Write(input) => relative_path(&input.path, false),
        Operation::Edit(input) => relative_path(&input.path, false) && !input.old_text.is_empty(),
        Operation::List(input) => search_path(input.path.as_deref()),
        Operation::Glob(input) => search_path(input.path.as_deref()) && !input.pattern.is_empty(),
        Operation::Grep(input) => {
            search_path(input.path.as_deref())
                && !input.pattern.is_empty()
                && WorkspaceGrepMode::try_from(input.mode).is_ok()
                && positive(input.head_limit)
        }
        Operation::Command(input) => {
            !input.command.trim().is_empty()
                && !input.command.contains('\0')
                && input
                    .timeout_ms
                    .is_none_or(|ms| (1..=MAX_TIMEOUT_MS).contains(&ms))
        }
    };
    if !valid {
        return Err(Status::invalid_argument(
            "invalid workspace operation input",
        ));
    }
    Ok(())
}

fn positive(value: Option<u32>) -> bool {
    value.is_none_or(|value| value > 0)
}

fn search_path(path: Option<&str>) -> bool {
    path.is_none_or(|path| relative_path(path, true))
}

fn relative_path(path: &str, allow_root: bool) -> bool {
    if path == "." {
        return allow_root;
    }
    !path.trim().is_empty()
        && path.len() <= MAX_PATH_BYTES
        && !path.contains('\\')
        && !path.chars().any(char::is_control)
        && path
            .split('/')
            .all(|part| !matches!(part, "" | "..") && !part.eq_ignore_ascii_case(".git"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::v2::{WorkspaceCommand, WorkspaceList, WorkspaceRead, WorkspaceWrite};
    use tonic::Code;

    fn validate(operation: Operation, actions: &[&str]) -> Result<(), Status> {
        validate_workspace_operation(
            &HarnessWorkspaceRequest {
                operation: Some(operation),
            },
            &actions
                .iter()
                .map(|action| (*action).to_owned())
                .collect::<Vec<_>>(),
        )
    }

    #[test]
    fn rejects_unadmitted_operations_before_sandbox_io() {
        let command = Operation::Command(WorkspaceCommand {
            command: "pwd".into(),
            timeout_ms: None,
        });
        for actions in [&[][..], &["commands:execute"][..], &["files:write"][..]] {
            assert_eq!(
                validate(command.clone(), actions).unwrap_err().code(),
                Code::PermissionDenied
            );
        }
        assert!(validate(command, &["files:write", "commands:execute"]).is_ok());
        assert_eq!(
            validate(
                Operation::List(WorkspaceList { path: None }),
                &["files:write"]
            )
            .unwrap_err()
            .code(),
            Code::PermissionDenied
        );
    }

    #[test]
    fn bounds_and_confines_relative_file_inputs() {
        for path in [
            "",
            "/etc/passwd",
            "../root",
            "src/../file",
            "src/.git/config",
            "src\nfile",
            ".",
        ] {
            let read = Operation::Read(WorkspaceRead {
                path: path.into(),
                offset: None,
                limit: None,
            });
            assert_eq!(
                validate(read, &["files:read"]).unwrap_err().code(),
                Code::InvalidArgument
            );
        }
        assert!(
            validate(
                Operation::List(WorkspaceList {
                    path: Some(".".into())
                }),
                &["files:read"]
            )
            .is_ok()
        );
        let write = Operation::Write(WorkspaceWrite {
            path: "./src/name.rs".into(),
            content: String::new(),
        });
        assert!(validate(write.clone(), &["files:write"]).is_ok());
        let Operation::Write(mut write) = write else {
            unreachable!()
        };
        write.content = "a".repeat(MAX_MESSAGE_BYTES);
        assert_eq!(
            validate(Operation::Write(write), &["files:write"])
                .unwrap_err()
                .code(),
            Code::ResourceExhausted
        );
    }
}
