use crate::v2::{PermissionSet, PolicyPermission, PolicyPermissionTarget, Task};

/// The MCP grants frozen when the Control Plane accepted this Task.
pub fn grants(task: &Task) -> impl Iterator<Item = (&PermissionSet, &PolicyPermission)> {
    task.policy_snapshot
        .iter()
        .flat_map(|snapshot| &snapshot.permission_sets)
        .flat_map(|set| {
            set.permissions
                .iter()
                .map(move |permission| (set, permission))
        })
        .filter(|(_, permission)| permission.target() == PolicyPermissionTarget::Mcp)
}
