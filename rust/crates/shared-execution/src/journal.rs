use std::{
    fs::{self, File, OpenOptions},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, ensure};
use prost::Message;
use sqlx::{
    Row, SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
};
use uuid::Uuid;

use crate::{
    root::Root,
    v2::{
        AccessCommandMode, AccessReceipt, AccessState, OperationReceipt, OperationState,
        ProcessChunk,
    },
};

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS environment (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  schema_version INTEGER NOT NULL,
  environment_id TEXT NOT NULL,
  incarnation_id TEXT NOT NULL,
  root_identity TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS accesses (
  id TEXT PRIMARY KEY,
  token_hash BLOB NOT NULL UNIQUE,
  fingerprint BLOB NOT NULL,
  task_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL UNIQUE,
  tag_id TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  state INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS access_command_modes (
  access_id TEXT PRIMARY KEY REFERENCES accesses(id),
  mode INTEGER NOT NULL CHECK(mode IN (1,2))
);
CREATE TABLE IF NOT EXISTS operations (
  id TEXT PRIMARY KEY,
  access_id TEXT NOT NULL REFERENCES accesses(id),
  fingerprint BLOB NOT NULL,
  state INTEGER NOT NULL,
  process_id TEXT UNIQUE,
  proof_nonce TEXT,
  cleanup_verified INTEGER NOT NULL,
  receipt BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS operations_by_access ON operations(access_id, cleanup_verified);
CREATE TABLE IF NOT EXISTS output (
  process_id TEXT NOT NULL REFERENCES operations(process_id),
  sequence INTEGER NOT NULL,
  stream INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (process_id, sequence)
);
"#;

pub(crate) struct Journal {
    pub(crate) pool: SqlitePool,
    pub(crate) environment_id: String,
    pub(crate) incarnation_id: String,
    pub(crate) proofs: PathBuf,
    _lock: File,
}

pub(crate) struct Access {
    pub(crate) receipt: AccessReceipt,
    pub(crate) fingerprint: Vec<u8>,
    pub(crate) command_mode: AccessCommandMode,
}

pub(crate) struct Entry {
    pub(crate) access_id: String,
    pub(crate) fingerprint: Vec<u8>,
    pub(crate) receipt: OperationReceipt,
    pub(crate) proof_nonce: Option<String>,
}

impl Journal {
    pub(crate) async fn open(
        directory: &Path,
        environment_id: String,
        root: &Root,
    ) -> Result<Self> {
        let directory = private_directory(directory)?;
        ensure!(
            !directory.starts_with(&root.path) && !root.path.starts_with(&directory),
            "shared execution root and state directory must be separate"
        );
        let lock = private_file(&directory.join("owner.lock"))?;
        lock.try_lock()
            .context("shared execution journal already has an owner")?;
        let path = directory.join("state.sqlite");
        private_file(&path)?;
        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(&path)
                    .journal_mode(SqliteJournalMode::Wal)
                    .synchronous(SqliteSynchronous::Full)
                    .foreign_keys(true)
                    .busy_timeout(Duration::from_secs(3)),
            )
            .await?;
        sqlx::raw_sql(SCHEMA).execute(&pool).await?;
        let identity = format!("{}:{}", root.identity.0, root.identity.1);
        sqlx::query("INSERT OR IGNORE INTO environment VALUES (1, 1, ?, ?, ?)")
            .bind(&environment_id)
            .bind(Uuid::new_v4().to_string())
            .bind(&identity)
            .execute(&pool)
            .await?;
        let metadata = sqlx::query("SELECT schema_version,environment_id,incarnation_id,root_identity FROM environment WHERE singleton=1")
            .fetch_one(&pool).await?;
        ensure!(
            metadata.try_get::<i32, _>("schema_version")? == 1
                && metadata.try_get::<String, _>("environment_id")? == environment_id
                && metadata.try_get::<String, _>("root_identity")? == identity,
            "shared execution journal belongs to another root, environment, or version"
        );
        let journal = Self {
            pool,
            environment_id,
            incarnation_id: metadata.try_get("incarnation_id")?,
            proofs: private_directory(&directory.join("cleanup-proofs"))?,
            _lock: lock,
        };
        journal.mark_interrupted().await?;
        Ok(journal)
    }

    async fn mark_interrupted(&self) -> Result<()> {
        let rows = sqlx::query("SELECT receipt FROM operations WHERE state IN (?,?)")
            .bind(OperationState::Accepted as i32)
            .bind(OperationState::Running as i32)
            .fetch_all(&self.pool)
            .await?;
        for row in rows {
            let mut receipt =
                OperationReceipt::decode(row.try_get::<Vec<u8>, _>("receipt")?.as_slice())?;
            receipt.state = OperationState::Uncertain as i32;
            receipt.error = Some("Shared execution restarted before observing completion".into());
            // A file operation cannot have descendants. A reserved process must produce proof.
            receipt.cleanup_verified |= receipt.process_id.is_none();
            self.set_receipt(&receipt).await?;
        }
        Ok(())
    }

    pub(crate) async fn access(&self, id: &str) -> Result<Option<Access>> {
        let row = sqlx::query("SELECT a.*, COALESCE(m.mode,0) AS command_mode FROM accesses a LEFT JOIN access_command_modes m ON m.access_id=a.id WHERE a.id=?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?;
        row.map(|row| self.decode_access(row)).transpose()
    }

    pub(crate) async fn authenticate(&self, token_hash: &[u8]) -> Result<Option<Access>> {
        let row = sqlx::query("SELECT a.*, COALESCE(m.mode,0) AS command_mode FROM accesses a LEFT JOIN access_command_modes m ON m.access_id=a.id WHERE a.token_hash=?")
            .bind(token_hash)
            .fetch_optional(&self.pool)
            .await?;
        row.map(|row| self.decode_access(row)).transpose()
    }

    pub(crate) async fn attempt_assigned(&self, attempt: &str) -> Result<bool> {
        Ok(sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM accesses WHERE attempt_id=?)",
        )
        .bind(attempt)
        .fetch_one(&self.pool)
        .await?)
    }

    fn decode_access(&self, row: sqlx::sqlite::SqliteRow) -> Result<Access> {
        let state: i32 = row.try_get("state")?;
        Ok(Access {
            receipt: AccessReceipt {
                environment_id: self.environment_id.clone(),
                incarnation_id: self.incarnation_id.clone(),
                access_id: row.try_get("id")?,
                task_id: row.try_get("task_id")?,
                attempt_id: row.try_get("attempt_id")?,
                tag_id: row.try_get("tag_id")?,
                expires_at_ms: row.try_get("expires_at_ms")?,
                state,
                cleanup_verified: matches!(
                    AccessState::try_from(state),
                    Ok(AccessState::Released | AccessState::Revoked)
                ),
            },
            fingerprint: row.try_get("fingerprint")?,
            command_mode: AccessCommandMode::try_from(row.try_get::<i32, _>("command_mode")?)?,
        })
    }

    pub(crate) async fn insert_access(
        &self,
        access: &AccessReceipt,
        token_hash: &[u8],
        fingerprint: &[u8],
        command_mode: AccessCommandMode,
    ) -> Result<()> {
        let mut transaction = self.pool.begin().await?;
        sqlx::query("INSERT INTO accesses VALUES (?,?,?,?,?,?,?,?)")
            .bind(&access.access_id)
            .bind(token_hash)
            .bind(fingerprint)
            .bind(&access.task_id)
            .bind(&access.attempt_id)
            .bind(&access.tag_id)
            .bind(access.expires_at_ms)
            .bind(access.state)
            .execute(&mut *transaction)
            .await?;
        if command_mode != AccessCommandMode::Unspecified {
            sqlx::query("INSERT INTO access_command_modes VALUES (?,?)")
                .bind(&access.access_id)
                .bind(command_mode as i32)
                .execute(&mut *transaction)
                .await?;
        }
        transaction.commit().await?;
        Ok(())
    }

    pub(crate) async fn set_access(&self, access_id: &str, state: AccessState) -> Result<()> {
        sqlx::query("UPDATE accesses SET state=? WHERE id=?")
            .bind(state as i32)
            .bind(access_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub(crate) async fn entry(&self, id: &str) -> Result<Option<Entry>> {
        let row = sqlx::query("SELECT * FROM operations WHERE id=?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?;
        row.map(decode_entry).transpose()
    }

    pub(crate) async fn process(&self, id: &str) -> Result<Option<Entry>> {
        let row = sqlx::query("SELECT * FROM operations WHERE process_id=?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?;
        row.map(decode_entry).transpose()
    }

    pub(crate) async fn unverified(&self, access: &str) -> Result<Vec<Entry>> {
        sqlx::query(
            "SELECT * FROM operations WHERE access_id=? AND (cleanup_verified=0 OR state IN (?,?))",
        )
        .bind(access)
        .bind(OperationState::Accepted as i32)
        .bind(OperationState::Running as i32)
        .fetch_all(&self.pool)
        .await?
        .into_iter()
        .map(decode_entry)
        .collect()
    }

    pub(crate) async fn insert_entry(&self, entry: &Entry) -> Result<()> {
        sqlx::query("INSERT INTO operations VALUES (?,?,?,?,?,?,?,?)")
            .bind(&entry.receipt.operation_id)
            .bind(&entry.access_id)
            .bind(&entry.fingerprint)
            .bind(entry.receipt.state)
            .bind(&entry.receipt.process_id)
            .bind(&entry.proof_nonce)
            .bind(entry.receipt.cleanup_verified)
            .bind(entry.receipt.encode_to_vec())
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub(crate) async fn set_receipt(&self, receipt: &OperationReceipt) -> Result<()> {
        let changed =
            sqlx::query("UPDATE operations SET state=?, cleanup_verified=?, receipt=? WHERE id=?")
                .bind(receipt.state)
                .bind(receipt.cleanup_verified)
                .bind(receipt.encode_to_vec())
                .bind(&receipt.operation_id)
                .execute(&self.pool)
                .await?
                .rows_affected();
        ensure!(changed == 1, "operation receipt lost its durable identity");
        Ok(())
    }

    pub(crate) async fn append(&self, process: &str, chunk: &ProcessChunk) -> Result<()> {
        sqlx::query("INSERT INTO output VALUES (?,?,?,?)")
            .bind(process)
            .bind(i64::try_from(chunk.sequence)?)
            .bind(chunk.stream)
            .bind(&chunk.data)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub(crate) async fn latest(&self, process: &str) -> Result<u64> {
        let sequence: i64 =
            sqlx::query_scalar("SELECT COALESCE(MAX(sequence),0) FROM output WHERE process_id=?")
                .bind(process)
                .fetch_one(&self.pool)
                .await?;
        Ok(u64::try_from(sequence)?)
    }

    pub(crate) async fn page(
        &self,
        process: &str,
        after: u64,
        through: u64,
    ) -> Result<Vec<ProcessChunk>> {
        sqlx::query("SELECT sequence,stream,data FROM output WHERE process_id=? AND sequence>? AND sequence<=? ORDER BY sequence LIMIT 16")
            .bind(process).bind(i64::try_from(after)?).bind(i64::try_from(through)?)
            .fetch_all(&self.pool).await?.into_iter().map(|row| Ok(ProcessChunk {
                sequence:u64::try_from(row.try_get::<i64,_>("sequence")?)?, stream:row.try_get("stream")?, data:row.try_get("data")?,
            })).collect()
    }

    pub(crate) async fn unsettled_processes(&self) -> Result<Vec<Entry>> {
        sqlx::query("SELECT * FROM operations WHERE process_id IS NOT NULL AND cleanup_verified=0")
            .fetch_all(&self.pool)
            .await?
            .into_iter()
            .map(decode_entry)
            .collect()
    }
}

fn decode_entry(row: sqlx::sqlite::SqliteRow) -> Result<Entry> {
    Ok(Entry {
        access_id: row.try_get("access_id")?,
        fingerprint: row.try_get("fingerprint")?,
        receipt: OperationReceipt::decode(row.try_get::<Vec<u8>, _>("receipt")?.as_slice())?,
        proof_nonce: row.try_get("proof_nonce")?,
    })
}

pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock before Unix epoch")
        .as_millis() as i64
}

fn private_directory(path: &Path) -> Result<PathBuf> {
    match fs::DirBuilder::new().mode(0o700).create(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    let metadata = fs::symlink_metadata(path)?;
    // SAFETY: geteuid takes no parameters.
    let uid = unsafe { libc::geteuid() };
    ensure!(
        metadata.is_dir() && metadata.uid() == uid && metadata.mode() & 0o077 == 0,
        "shared execution state directory must be owner-only"
    );
    Ok(path.canonicalize()?)
}

fn private_file(path: &Path) -> Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path)?;
    let metadata = file.metadata()?;
    // SAFETY: geteuid takes no parameters.
    let uid = unsafe { libc::geteuid() };
    ensure!(
        metadata.is_file()
            && metadata.uid() == uid
            && metadata.nlink() == 1
            && metadata.mode() & 0o077 == 0,
        "shared execution journal files must be owner-only regular files"
    );
    Ok(file)
}
