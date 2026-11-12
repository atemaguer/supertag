//! Transactional operator notices. Task events remain in their own replay log.
use std::{pin::Pin, time::Duration};

use sqlx::Row;
use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};
use tokio::time::Instant;
use tokio_stream::Stream;
use tokio_util::sync::CancellationToken;
use tonic::{Request, Response, Status};

use crate::{ControlPlane, Store, store::Result as StoreResult};

const PAGE_SIZE: i64 = 128;
const RETAINED: i64 = 10_000;
const POLL: Duration = Duration::from_millis(300);
const HEARTBEAT: Duration = Duration::from_secs(15);

type Updates = Pin<Box<dyn Stream<Item = Result<WatchEvent, Status>> + Send>>;

struct Notice {
    position: i64,
    owner: String,
    change: WatchChange,
}

struct Page {
    feed_id: String,
    head: i64,
    floor: i64,
    notices: Vec<Notice>,
}

impl Store {
    async fn watch_page(&self, after: i64) -> StoreResult<Page> {
        // A single read snapshot keeps retention boundaries and the page consistent.
        let rows = sqlx::query(
            "WITH page AS (
                SELECT * FROM supertag_v2_watch_notices
                WHERE position > $1 ORDER BY position LIMIT $2
             )
             SELECT state.feed_id,state.head,state.floor,page.*
             FROM supertag_v2_watch_state state LEFT JOIN page ON 1=1
             WHERE state.singleton=1 ORDER BY page.position",
        )
        .bind(after)
        .bind(PAGE_SIZE)
        .fetch_all(&self.pool)
        .await?;
        let first = rows.first().ok_or(sqlx::Error::RowNotFound)?;
        let mut page = Page {
            feed_id: first.try_get("feed_id")?,
            head: first.try_get("head")?,
            floor: first.try_get("floor")?,
            notices: Vec::with_capacity(rows.len()),
        };
        for row in rows {
            let Some(position) = row.try_get::<Option<i64>, _>("position")? else {
                continue;
            };
            page.notices.push(Notice {
                position,
                owner: row.try_get("owner")?,
                change: WatchChange {
                    kind: row.try_get::<i64, _>("kind")? as i32,
                    reason: row.try_get::<i64, _>("reason")? as i32,
                    id: row.try_get("resource_id")?,
                    tag_id: row.try_get("tag_id")?,
                    session_id: row.try_get("session_id")?,
                    objective_id: row.try_get("objective_id")?,
                    team_id: row.try_get("team_id")?,
                    conversation: row.try_get("conversation")?,
                    changed_at_ms: row.try_get("changed_at_ms")?,
                },
            });
        }
        Ok(page)
    }

    pub(crate) async fn prune_watch(&self) -> StoreResult<()> {
        self.retain_watch(RETAINED).await
    }

    async fn retain_watch(&self, count: i64) -> StoreResult<()> {
        let mut tx = self.pool.begin().await?;
        let floor: Option<i64> = sqlx::query_scalar(
            "UPDATE supertag_v2_watch_state SET floor=head-$1
             WHERE singleton=1 AND head-floor>$1 RETURNING floor",
        )
        .bind(count)
        .fetch_optional(&mut *tx)
        .await?;
        if let Some(floor) = floor {
            sqlx::query("DELETE FROM supertag_v2_watch_notices WHERE position <= $1")
                .bind(floor)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        Ok(())
    }
}

pub struct OperatorWatch {
    plane: ControlPlane,
    shutdown: CancellationToken,
}

impl ControlPlane {
    pub fn operator_events_service(
        &self,
        shutdown: CancellationToken,
    ) -> operator_events_server::OperatorEventsServer<OperatorWatch> {
        operator_events_server::OperatorEventsServer::new(OperatorWatch {
            plane: self.clone(),
            shutdown,
        })
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
}

struct Cursor<'a> {
    feed_id: &'a str,
    position: i64,
}

impl<'a> Cursor<'a> {
    fn parse(input: &'a str) -> Result<Option<Self>, Status> {
        if input.is_empty() {
            return Ok(None);
        }
        let invalid = || Status::invalid_argument("invalid Watch resume token");
        let (feed_id, position) = input
            .strip_prefix("v1.")
            .and_then(|suffix| suffix.split_once('.'))
            .ok_or_else(invalid)?;
        if feed_id.len() != 32
            || !feed_id.bytes().all(|b| b.is_ascii_hexdigit())
            || position.len() > 19
            || !position.bytes().all(|b| b.is_ascii_digit())
        {
            return Err(invalid());
        }
        let position = position.parse().map_err(|_| invalid())?;
        Ok(Some(Self { feed_id, position }))
    }
}

fn frame(feed_id: &str, position: i64, update: watch_event::Update) -> WatchEvent {
    WatchEvent {
        resume_token: format!("v1.{feed_id}.{position}"),
        update: Some(update),
    }
}

fn kinds(input: &[i32]) -> Result<u8, Status> {
    input.iter().try_fold(0, |mask, kind| {
        let kind = WatchKind::try_from(*kind)
            .ok()
            .filter(|kind| *kind != WatchKind::Unspecified)
            .ok_or_else(|| Status::invalid_argument("unknown Watch kind"))?;
        Ok(mask | (1 << kind as i32))
    })
}

fn draining() -> Status {
    Status::unavailable("Control Plane is draining")
}

#[tonic::async_trait]
impl operator_events_server::OperatorEvents for OperatorWatch {
    type WatchStream = Updates;

    async fn watch(
        &self,
        request: Request<WatchRequest>,
    ) -> Result<Response<Self::WatchStream>, Status> {
        use watch_event::Update;

        let principal = self.plane.principal(&request, "operator:")?;
        let input = request.into_inner();
        let mask = kinds(&input.kinds)?;
        let cursor = Cursor::parse(&input.resume_token)?;
        let store = self.plane.store.clone();
        let shutdown = self.shutdown.clone();
        let mut page = tokio::select! {
            _ = shutdown.cancelled() => return Err(draining()),
            result = store.watch_page(cursor.as_ref().map_or(i64::MAX, |cursor| cursor.position)) => result?,
        };
        let (mut position, initial) = match cursor {
            None => (page.head, Some(Update::Heartbeat(WatchHeartbeat {}))),
            Some(cursor) if cursor.feed_id != page.feed_id || cursor.position < page.floor => {
                (page.head, Some(Update::Resync(WatchResync {})))
            }
            Some(cursor) if cursor.position > page.head => {
                return Err(Status::invalid_argument(
                    "Watch resume token is ahead of the feed",
                ));
            }
            Some(cursor) => (cursor.position, None),
        };
        let feed_id = page.feed_id.clone();
        let output = async_stream::try_stream! {
            let mut last_emit = Instant::now();
            let mut established = false;
            if let Some(initial) = initial {
                established = true;
                yield frame(&feed_id, position, initial);
            }
            loop {
                if shutdown.is_cancelled() {
                    Err(draining())?;
                }
                if position < page.floor {
                    position = page.head;
                    established = true;
                    last_emit = Instant::now();
                    yield frame(&feed_id, position, Update::Resync(WatchResync {}));
                }
                for notice in std::mem::take(&mut page.notices) {
                    if notice.position <= position {
                        continue;
                    }
                    position = notice.position;
                    if (notice.owner.is_empty() || notice.owner == principal)
                        && (mask == 0 || mask & (1 << notice.change.kind) != 0)
                    {
                        if shutdown.is_cancelled() {
                            Err(draining())?;
                        }
                        established = true;
                        last_emit = Instant::now();
                        yield frame(&feed_id, position, Update::Change(notice.change));
                    }
                }
                if (!established && position >= page.head) || last_emit.elapsed() >= HEARTBEAT {
                    established = true;
                    last_emit = Instant::now();
                    yield frame(&feed_id, position, Update::Heartbeat(WatchHeartbeat {}));
                }
                if position >= page.head {
                    let waited = tokio::select! {
                        _ = shutdown.cancelled() => Err(draining()),
                        _ = tokio::time::sleep(POLL) => Ok(()),
                    };
                    waited?;
                }
                let read = tokio::select! {
                    _ = shutdown.cancelled() => Err(draining()),
                    result = store.watch_page(position) => result.map_err(Status::from),
                };
                page = read?;
            }
        };
        Ok(Response::new(Box::pin(output)))
    }
}

#[cfg(test)]
mod tests;
