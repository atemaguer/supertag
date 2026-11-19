//! Where a client can read a Task's files itself (contributing/client-file-access-design.md,
//! slice 1). A Worker Host reports where a running Attempt's local checkout is; a client on the
//! same machine, proven by presenting the host's machine identifier, gets that directory and lists
//! and reads it itself. The Control Plane returns locations only, never file content.
use crate::AttemptAccess;
use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};
use tonic::{Request, Response, Status};

use crate::{
    ControlPlane, Store, StoreError,
    store::{Result, invalid, lease_is_live, owned, task_row},
};

const MAX_LOCAL_PATH: usize = 4096;

/// A machine identifier as hosts and clients keep it in `~/.supertag/machine-id`.
pub(crate) fn valid_machine_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

impl Store {
    /// Records where a running Attempt's local checkout is on its Worker Host.
    pub async fn report_task_files_location(
        &self,
        authority: &AttemptAccess,
        input: &ReportTaskFilesLocationRequest,
    ) -> Result<ReportTaskFilesLocationResponse> {
        let host = authority.host();
        let attempt = authority.lease();
        let path = &input.local_path;
        if !path.starts_with('/')
            || path.len() > MAX_LOCAL_PATH
            || path.chars().any(char::is_control)
        {
            return Err(invalid(
                "a Task files location must be an absolute path of at most 4,096 bytes",
            ));
        }
        let (mut tx, _) = self.write().await?;
        let now = self.execution_now_ms();
        let row = owned(
            &mut tx,
            host,
            &attempt.task_id,
            &attempt.attempt_id,
            &attempt.lease_token,
        )
        .await?;
        let task = task_row(&row)?;
        if task.state() != TaskState::Running || !lease_is_live(&row, now)? {
            return Err(StoreError::FailedPrecondition(
                "a Task files location requires a live running Attempt".into(),
            ));
        }
        sqlx::query("INSERT INTO supertag_v2_task_file_locations (attempt_id,task_id,host_id,local_path,reported_at_ms) VALUES ($1,$2,$3,$4,$5) ON CONFLICT(attempt_id) DO UPDATE SET local_path=excluded.local_path,reported_at_ms=excluded.reported_at_ms")
            .bind(&attempt.attempt_id).bind(&attempt.task_id).bind(host.id()).bind(path).bind(now)
            .execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(ReportTaskFilesLocationResponse {})
    }

    /// Where `principal` can read the Task's files itself: the running Attempt's checkout when
    /// the caller presents its Worker Host's machine identifier, else why it can't.
    pub async fn locate_task_files(
        &self,
        principal: &str,
        input: &LocateTaskFilesRequest,
    ) -> Result<TaskFileLocations> {
        crate::store::name("Task ID", &input.task_id)?;
        if !input.machine_id.is_empty() && !valid_machine_id(&input.machine_id) {
            return Err(invalid(
                "machine ID must be 32 lowercase hexadecimal digits",
            ));
        }
        let mut tx = self.pool.begin().await?;
        if !crate::conversations::task_access_in(&mut tx, principal, &input.task_id).await? {
            return Err(StoreError::NotFound("Task was not found".into()));
        }
        let task = crate::store::task_in(&mut tx, &input.task_id).await?;
        let running = matches!(task.state(), TaskState::Running);
        let attempt = task.attempt_id.clone().unwrap_or_default();
        let located: Option<(String, String, Option<String>)> = sqlx::query_as(
            "SELECT l.local_path,l.host_id,r.machine_id FROM supertag_v2_task_file_locations l
             LEFT JOIN supertag_v2_host_readiness r ON r.host_id=l.host_id
             WHERE l.attempt_id=$1 AND l.task_id=$2",
        )
        .bind(&attempt)
        .bind(&input.task_id)
        .fetch_optional(&mut *tx)
        .await?;
        tx.commit().await?;
        let mut location = TaskFileLocation {
            id: format!("attempt:{attempt}"),
            live: running,
            ..Default::default()
        };
        match located {
            _ if !running => {
                location.unavailable_reason =
                    "This Task isn't running, so it has no checkout to read. Its work is on its Session branch.".into();
            }
            None => {
                location.unavailable_reason =
                    "This Task's Worker Host hasn't said where its files are.".into();
            }
            Some((path, host, machine)) => {
                location.host_id = host.clone();
                if !input.machine_id.is_empty() && machine.as_deref() == Some(&input.machine_id) {
                    location.kind = Some(task_file_location::Kind::LocalPath(TaskFilesLocalPath {
                        path,
                    }));
                } else {
                    location.unavailable_reason =
                        format!("Files on Worker Host {host} are unreachable from here.");
                }
            }
        }
        Ok(TaskFileLocations {
            locations: vec![location],
        })
    }
}

impl ControlPlane {
    pub fn task_files_service(&self) -> task_files_server::TaskFilesServer<Self> {
        task_files_server::TaskFilesServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }

    pub fn attempt_task_files_service(
        &self,
    ) -> attempt_task_files_server::AttemptTaskFilesServer<Self> {
        attempt_task_files_server::AttemptTaskFilesServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
}

#[tonic::async_trait]
impl task_files_server::TaskFiles for ControlPlane {
    async fn locate(
        &self,
        request: Request<LocateTaskFilesRequest>,
    ) -> std::result::Result<Response<TaskFileLocations>, Status> {
        let principal = self.actor(&request)?;
        Ok(Response::new(
            self.store
                .locate_task_files(&principal, request.get_ref())
                .await?,
        ))
    }
}

#[tonic::async_trait]
impl attempt_task_files_server::AttemptTaskFiles for ControlPlane {
    async fn report_location(
        &self,
        request: Request<ReportTaskFilesLocationRequest>,
    ) -> std::result::Result<Response<ReportTaskFilesLocationResponse>, Status> {
        let host = self.attempt(&request).await?;
        Ok(Response::new(
            self.store
                .report_task_files_location(&host, request.get_ref())
                .await?,
        ))
    }
}
