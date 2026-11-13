//! Operator notifications: a durable outbox that tells a Gateway's configured destinations about
//! new Inbox items.
//!
//! TypeScript parity: `packages/control-plane/src/operator-channel.ts` (`OperatorChannelNotifications`)
//! and `packages/store/src/operator-notification-store.ts`. Each Inbox item occurrence reaches a
//! destination at most once. Messages per Objective per destination are batched to one per window,
//! except a pending approval that running work waits on; later items wait for the next window and
//! are summarized as "more". Desktop messages and items without an Objective are not batched per
//! Objective. A message whose items were all resolved before delivery is settled unsent. Failed
//! deliveries are retried with exponential backoff until the message's last attempt.
//!
//! Differences: reconciliation runs inside each Gateway claim instead of a separate Control Plane
//! loop, because only the Gateway knows its destinations; the Control Plane stores destination
//! keys, never webhook URLs. Activity is checked against the Inbox read by the same claim. Each
//! operator principal has its own outbox, because several Gateways acting for different
//! operators can share one Control Plane and name the same destination key (`desktop` on
//! every machine, or one Slack channel): an operator's messages, rendered from that operator's
//! Inbox, are only recorded, claimed, and settled by a Gateway acting for that operator.
//! TypeScript reads one admin Inbox in one process and has no such case. A message whose lease
//! lapses on its last attempt fails instead of being claimed again.
use std::collections::{BTreeMap, BTreeSet, HashMap};

use sqlx::{Any, Row, Transaction, any::AnyRow};
use supertag_protocol::v2::*;
use uuid::Uuid;

use crate::{
    Store, StoreError,
    store::{Result, invalid, name, next_order},
};

/// At most one message per Objective per destination in this window, except blocking approvals.
pub const WINDOW_MS: i64 = 60_000;
/// A claimed message not settled within this time is claimed again.
pub const LEASE_MS: i64 = 60_000;
/// The first retry delay; each later attempt doubles it.
pub const RETRY_BASE_MS: i64 = 5_000;
const MAX_RETRY_DELAY_MS: i64 = 15 * 60_000;
const INBOX_PAGES: usize = 20;
const INBOX_PAGE: u32 = 100;
const ITEMS_SHOWN: usize = 5;
const MAX_DESTINATIONS: usize = 16;
const KEY_BATCH: usize = 200;
const MAX_ERROR_CHARS: usize = 2_000;
const MAX_CLAIM_SCAN: usize = 32;

const PENDING: i64 = 1;
const DELIVERING: i64 = 2;
const DELIVERED: i64 = 3;
const FAILED: i64 = 4;
/// Why a message whose lease lapsed on its last attempt failed.
const LEASE_LAPSED: &str =
    "the Gateway did not settle the last delivery attempt before its lease expired";

/// One Inbox item as the outbox sees it.
struct Item {
    /// The ledger key: one per item occurrence.
    key: String,
    objective_id: Option<String>,
    headline: String,
    command: Option<String>,
    blocking_approval: bool,
    /// The Objective's own collaboration surface thread already carries it, so Slack skips it.
    carried: bool,
}

impl Store {
    /// Records new Inbox item occurrences for these destinations, then leases the next due
    /// message among them. The caller is the operator whose Inbox is read.
    pub async fn claim_operator_notification(
        &self,
        principal: &str,
        input: &ClaimOperatorNotificationRequest,
    ) -> Result<ClaimOperatorNotificationResponse> {
        let destinations = destinations(&input.destinations)?;
        if destinations.is_empty() {
            return Ok(ClaimOperatorNotificationResponse::default());
        }
        let (inbox, complete) = self.inbox_for_notifications(principal).await?;
        let (mut tx, _) = self.write().await?;
        let now = self.execution_now_ms();
        let items = items_in(&mut tx, inbox).await?;
        record_in(&mut tx, principal, &destinations, &items, now).await?;
        // A lease that lapsed on the last attempt is never claimed again.
        sqlx::query("UPDATE supertag_v2_operator_notifications SET status=$1,failed_at_ms=$2,last_error=$3,lease_token=NULL,lease_expires_at_ms=NULL WHERE principal=$4 AND status=$5 AND lease_expires_at_ms<=$2 AND attempt_count>=max_attempts")
            .bind(FAILED).bind(now).bind(LEASE_LAPSED).bind(principal).bind(DELIVERING)
            .execute(&mut *tx).await?;
        let keys: Vec<&str> = destinations.iter().map(|(key, _)| key.as_str()).collect();
        let by_key: HashMap<&str, &Item> =
            items.iter().map(|item| (item.key.as_str(), item)).collect();
        for _ in 0..MAX_CLAIM_SCAN {
            let Some(row) = due_in(&mut tx, principal, &keys, now).await? else {
                break;
            };
            let id: String = row.try_get("notification_id")?;
            let stored: Vec<String> =
                serde_json::from_str(&row.try_get::<String, _>("item_keys")?)?;
            // A complete Inbox read proves which items still wait. A truncated one cannot.
            let active: Vec<&Item> = stored
                .iter()
                .filter_map(|key| by_key.get(key.as_str()).copied())
                .collect();
            if complete && active.is_empty() {
                sqlx::query("UPDATE supertag_v2_operator_notifications SET status=$1,delivered_at_ms=$2,lease_token=NULL,lease_expires_at_ms=NULL WHERE notification_id=$3")
                    .bind(DELIVERED).bind(now).bind(&id).execute(&mut *tx).await?;
                continue;
            }
            let objective: String = row.try_get("objective_id")?;
            let more = row.try_get::<i64, _>("more")? == 1;
            let text = if complete {
                render(&objective, &active, more)
            } else {
                row.try_get("text")?
            };
            let active_keys: Vec<String> = if complete {
                active.iter().map(|item| item.key.clone()).collect()
            } else {
                stored
            };
            let lease = Uuid::new_v4().to_string();
            sqlx::query("UPDATE supertag_v2_operator_notifications SET status=$1,attempt_count=attempt_count+1,lease_token=$2,lease_expires_at_ms=$3,text=$4 WHERE notification_id=$5")
                .bind(DELIVERING).bind(&lease).bind(now.saturating_add(LEASE_MS)).bind(&text).bind(&id)
                .execute(&mut *tx).await?;
            let mut notification = notification_in(&mut tx, &id).await?;
            notification.item_keys = active_keys;
            notification.kinds = kinds(&notification.item_keys);
            tx.commit().await?;
            return Ok(ClaimOperatorNotificationResponse {
                notification: Some(notification),
                lease_token: lease,
            });
        }
        tx.commit().await?;
        Ok(ClaimOperatorNotificationResponse::default())
    }

    /// Records a leased delivery. A failure is retried with backoff until the last attempt.
    pub async fn settle_operator_notification(
        &self,
        principal: &str,
        input: &SettleOperatorNotificationRequest,
    ) -> Result<OperatorNotification> {
        operator(principal)?;
        name("notification ID", &input.notification_id)?;
        name("lease token", &input.lease_token)?;
        if let Some(id) = &input.external_message_id {
            name("external message ID", id)?;
        }
        if input.delivered != input.error.is_empty() {
            return Err(invalid(
                "a delivered notification has no error and a failed one names it",
            ));
        }
        let (mut tx, _) = self.write().await?;
        let now = self.execution_now_ms();
        let row = sqlx::query(
            "SELECT * FROM supertag_v2_operator_notifications WHERE notification_id=$1",
        )
        .bind(&input.notification_id)
        .fetch_optional(&mut *tx)
        .await?
        .filter(|row| {
            row.try_get::<String, _>("principal")
                .is_ok_and(|p| p == principal)
        })
        .ok_or_else(|| StoreError::NotFound("operator notification was not found".into()))?;
        if row.try_get::<i64, _>("status")? != DELIVERING
            || row.try_get::<Option<String>, _>("lease_token")?.as_deref()
                != Some(input.lease_token.as_str())
        {
            return Err(StoreError::FailedPrecondition(
                "the notification lease is no longer owned".into(),
            ));
        }
        if input.delivered {
            sqlx::query("UPDATE supertag_v2_operator_notifications SET status=$1,delivered_at_ms=$2,external_message_id=$3,last_error=NULL,failed_at_ms=NULL,lease_token=NULL,lease_expires_at_ms=NULL WHERE notification_id=$4")
                .bind(DELIVERED).bind(now).bind(&input.external_message_id).bind(&input.notification_id)
                .execute(&mut *tx).await?;
        } else {
            let attempts: i64 = row.try_get("attempt_count")?;
            let failed = attempts >= row.try_get::<i64, _>("max_attempts")?;
            let delay = RETRY_BASE_MS
                .saturating_mul(1_i64 << (attempts - 1).clamp(0, 20))
                .min(MAX_RETRY_DELAY_MS);
            let error: String = redact_urls(&input.error)
                .chars()
                .take(MAX_ERROR_CHARS)
                .collect();
            sqlx::query("UPDATE supertag_v2_operator_notifications SET status=$1,available_at_ms=$2,last_error=$3,failed_at_ms=$4,lease_token=NULL,lease_expires_at_ms=NULL WHERE notification_id=$5")
                .bind(if failed { FAILED } else { PENDING })
                .bind(now.saturating_add(delay))
                .bind(error)
                .bind(failed.then_some(now))
                .bind(&input.notification_id)
                .execute(&mut *tx).await?;
        }
        let notification = notification_in(&mut tx, &input.notification_id).await?;
        tx.commit().await?;
        Ok(notification)
    }

    /// One operator's newest message for one destination and Objective (`*` when not batched).
    pub async fn latest_operator_notification(
        &self,
        principal: &str,
        destination_key: &str,
        objective_id: &str,
    ) -> Result<Option<OperatorNotification>> {
        let mut connection = self.pool.acquire().await?;
        let id: Option<String> = sqlx::query_scalar("SELECT notification_id FROM supertag_v2_operator_notifications WHERE principal=$1 AND destination_key=$2 AND objective_id=$3 ORDER BY created_order DESC LIMIT 1")
            .bind(principal).bind(destination_key).bind(objective_id).fetch_optional(&mut *connection).await?;
        drop(connection);
        let Some(id) = id else { return Ok(None) };
        let mut tx = self.pool.begin().await?;
        let notification = notification_in(&mut tx, &id).await?;
        tx.rollback().await?;
        Ok(Some(notification))
    }

    /// Every Inbox item this operator sees. False when the read stopped at its page bound.
    async fn inbox_for_notifications(&self, principal: &str) -> Result<(Vec<InboxItem>, bool)> {
        operator(principal)?;
        let mut items = Vec::new();
        let mut cursor = String::new();
        for _ in 0..INBOX_PAGES {
            let page = self
                .list_inbox_items(
                    principal,
                    &ListInboxItemsRequest {
                        objective_id: String::new(),
                        kind: InboxItemKind::Unspecified as i32,
                        page_size: INBOX_PAGE,
                        cursor,
                    },
                )
                .await?;
            items.extend(page.items);
            if page.next_cursor.is_empty() {
                return Ok((items, page.truncated_kinds.is_empty()));
            }
            cursor = page.next_cursor;
        }
        Ok((items, false))
    }
}

fn operator(principal: &str) -> Result<()> {
    if principal
        .strip_prefix("operator:")
        .is_none_or(str::is_empty)
    {
        return Err(StoreError::PermissionDenied);
    }
    name("operator principal", principal)
}

/// Validated, de-duplicated destinations: key and provider.
fn destinations(input: &[NotificationDestination]) -> Result<Vec<(String, NotificationProvider)>> {
    if input.len() > MAX_DESTINATIONS {
        return Err(invalid("configure at most 16 notification destinations"));
    }
    let mut unique = BTreeMap::new();
    for destination in input {
        let provider = NotificationProvider::try_from(destination.provider)
            .map_err(|_| invalid("unknown notification provider"))?;
        if !valid_key(&destination.key, provider) {
            return Err(invalid("invalid notification destination key"));
        }
        unique.insert(destination.key.clone(), provider);
    }
    Ok(unique.into_iter().collect())
}

fn valid_key(key: &str, provider: NotificationProvider) -> bool {
    match provider {
        NotificationProvider::Desktop => key == "desktop",
        NotificationProvider::Webhook => key.strip_prefix("webhook:").is_some_and(|digest| {
            digest.len() == 64
                && digest
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        }),
        NotificationProvider::Slack => key.strip_prefix("slack:").is_some_and(|rest| {
            let (workspace, target) = rest.split_once('/').unwrap_or(("", rest));
            let upper = |s: &str| {
                s.bytes()
                    .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
            };
            (workspace.is_empty() || (upper(workspace) && workspace.len() <= 32))
                && target.len() >= 3
                && target.len() <= 32
                && upper(target)
                && matches!(target.as_bytes()[0], b'C' | b'G' | b'D' | b'U' | b'W')
        }),
        NotificationProvider::Unspecified => false,
    }
}

/// Inbox items with what the outbox needs: a ledger key, a headline, and whether an approval
/// blocks work. As in TypeScript, every approval the Inbox lists blocks: the Inbox lists one only
/// while a Session waits on it, either running or ended waiting as the Session's latest Task.
async fn items_in(tx: &mut Transaction<'_, Any>, inbox: Vec<InboxItem>) -> Result<Vec<Item>> {
    let mut items = Vec::with_capacity(inbox.len());
    for item in inbox {
        let kind = InboxItemKind::try_from(item.kind).unwrap_or(InboxItemKind::Unspecified);
        let objective_id = (!item.objective_id.is_empty()).then(|| item.objective_id.clone());
        let blocking_approval = kind == InboxItemKind::Approval;
        let carried = matches!(
            kind,
            InboxItemKind::Question
                | InboxItemKind::ObjectiveBudget
                | InboxItemKind::ObjectiveLimit
                | InboxItemKind::Approval
        ) && match &objective_id {
            Some(objective) => sqlx::query_scalar::<_, String>(
                "SELECT objective_id FROM supertag_v2_surface_objectives WHERE objective_id=$1",
            )
            .bind(objective)
            .fetch_optional(&mut **tx)
            .await?
            .is_some(),
            None => false,
        };
        let key = if item.occurrence == item.key
            || item.occurrence.starts_with(&format!("{}:", item.key))
        {
            item.occurrence.clone()
        } else {
            item.key.clone()
        };
        let (headline, command) = headline(kind, &item, blocking_approval);
        items.push(Item {
            key,
            objective_id,
            headline,
            command,
            blocking_approval,
            carried,
        });
    }
    Ok(items)
}

async fn record_in(
    tx: &mut Transaction<'_, Any>,
    principal: &str,
    destinations: &[(String, NotificationProvider)],
    items: &[Item],
    now: i64,
) -> Result<()> {
    let mut groups: BTreeMap<(String, String), (NotificationProvider, Vec<&Item>)> =
        BTreeMap::new();
    for item in items {
        for (key, provider) in destinations {
            // The Objective's own collaboration surface thread already carries this item.
            if item.carried && *provider == NotificationProvider::Slack {
                continue;
            }
            let objective = match (&item.objective_id, provider) {
                (Some(objective), p) if *p != NotificationProvider::Desktop => objective.clone(),
                _ => "*".to_owned(),
            };
            groups
                .entry((key.clone(), objective))
                .or_insert_with(|| (*provider, Vec::new()))
                .1
                .push(item);
        }
    }
    for ((destination, objective), (provider, group)) in groups {
        let keys: Vec<&str> = group.iter().map(|item| item.key.as_str()).collect();
        let notified = notified_in(tx, principal, &destination, &keys).await?;
        let fresh: Vec<&Item> = group
            .into_iter()
            .filter(|item| !notified.contains(item.key.as_str()))
            .collect();
        if fresh.is_empty() {
            continue;
        }
        let immediate = fresh.iter().any(|item| item.blocking_approval);
        let previous: Option<i64> = sqlx::query_scalar("SELECT MAX(created_at_ms) FROM supertag_v2_operator_notifications WHERE principal=$1 AND destination_key=$2 AND objective_id=$3")
            .bind(principal).bind(&destination).bind(&objective).fetch_one(&mut **tx).await?;
        if !immediate && previous.is_some_and(|at| at > now - WINDOW_MS) {
            continue;
        }
        let more = !immediate && previous.is_some_and(|at| now - at < 2 * WINDOW_MS);
        let item_keys: Vec<&str> = fresh.iter().map(|item| item.key.as_str()).collect();
        let id = Uuid::new_v4().to_string();
        let order = next_order(tx).await?;
        sqlx::query("INSERT INTO supertag_v2_operator_notifications (notification_id,destination_key,provider,objective_id,item_keys,text,more,immediate,status,attempt_count,max_attempts,available_at_ms,created_at_ms,created_order,principal) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,$10,$11,$11,$12,$13)")
            .bind(&id)
            .bind(&destination)
            .bind(provider as i64)
            .bind(&objective)
            .bind(serde_json::to_string(&item_keys)?)
            .bind(render(&objective, &fresh, more))
            .bind(i64::from(more))
            .bind(i64::from(immediate))
            .bind(PENDING)
            .bind(if provider == NotificationProvider::Desktop { 3_i64 } else { 5 })
            .bind(now)
            .bind(order)
            .bind(principal)
            .execute(&mut **tx)
            .await?;
        for key in item_keys {
            sqlx::query("INSERT INTO supertag_v2_operator_notification_items (principal,destination_key,item_key,notification_id) VALUES ($1,$2,$3,$4)")
                .bind(principal).bind(&destination).bind(key).bind(&id).execute(&mut **tx).await?;
        }
    }
    Ok(())
}

async fn notified_in(
    tx: &mut Transaction<'_, Any>,
    principal: &str,
    destination: &str,
    keys: &[&str],
) -> Result<BTreeSet<String>> {
    let mut found = BTreeSet::new();
    for chunk in keys.chunks(KEY_BATCH) {
        let placeholders: Vec<String> = (0..chunk.len()).map(|i| format!("${}", i + 3)).collect();
        let sql = format!(
            "SELECT item_key FROM supertag_v2_operator_notification_items WHERE principal=$1 AND destination_key=$2 AND item_key IN ({})",
            placeholders.join(",")
        );
        let mut query = sqlx::query_scalar::<_, String>(&sql)
            .bind(principal)
            .bind(destination);
        for key in chunk {
            query = query.bind(*key);
        }
        found.extend(query.fetch_all(&mut **tx).await?);
    }
    Ok(found)
}

async fn due_in(
    tx: &mut Transaction<'_, Any>,
    principal: &str,
    destinations: &[&str],
    now: i64,
) -> Result<Option<AnyRow>> {
    let placeholders: Vec<String> = (0..destinations.len())
        .map(|i| format!("${}", i + 5))
        .collect();
    let sql = format!(
        "SELECT * FROM supertag_v2_operator_notifications WHERE principal=$4 AND destination_key IN ({}) AND attempt_count<max_attempts AND ((status=$1 AND available_at_ms<=$3) OR (status=$2 AND lease_expires_at_ms<=$3)) ORDER BY available_at_ms,created_order LIMIT 1",
        placeholders.join(",")
    );
    let mut query = sqlx::query(&sql)
        .bind(PENDING)
        .bind(DELIVERING)
        .bind(now)
        .bind(principal);
    for destination in destinations {
        query = query.bind(*destination);
    }
    Ok(query.fetch_optional(&mut **tx).await?)
}

async fn notification_in(tx: &mut Transaction<'_, Any>, id: &str) -> Result<OperatorNotification> {
    let row =
        sqlx::query("SELECT * FROM supertag_v2_operator_notifications WHERE notification_id=$1")
            .bind(id)
            .fetch_one(&mut **tx)
            .await?;
    let item_keys: Vec<String> = serde_json::from_str(&row.try_get::<String, _>("item_keys")?)?;
    let text: String = row.try_get("text")?;
    let status = match row.try_get::<i64, _>("status")? {
        PENDING => OperatorNotificationStatus::Pending,
        DELIVERING => OperatorNotificationStatus::Delivering,
        DELIVERED => OperatorNotificationStatus::Delivered,
        FAILED => OperatorNotificationStatus::Failed,
        _ => return Err(invalid("invalid operator notification status")),
    };
    let count = |column: &str| -> Result<u32> {
        u32::try_from(row.try_get::<i64, _>(column)?)
            .map_err(|_| invalid("invalid operator notification attempt count"))
    };
    Ok(OperatorNotification {
        notification_id: row.try_get("notification_id")?,
        destination_key: row.try_get("destination_key")?,
        objective_id: row.try_get("objective_id")?,
        command: command_of(&text),
        kinds: kinds(&item_keys),
        item_keys,
        text,
        status: status as i32,
        attempt_count: count("attempt_count")?,
        max_attempts: count("max_attempts")?,
        last_error: row.try_get("last_error")?,
        external_message_id: row.try_get("external_message_id")?,
    })
}

fn kinds(keys: &[String]) -> Vec<String> {
    let mut kinds: Vec<String> = Vec::new();
    for key in keys {
        let kind = key.split(':').next().unwrap_or_default().to_owned();
        if !kinds.contains(&kind) {
            kinds.push(kind);
        }
    }
    kinds
}

/// The last line's command, as TypeScript's webhook payload reads it.
fn command_of(text: &str) -> String {
    text.lines()
        .last()
        .and_then(|line| line.strip_prefix('`')?.strip_suffix('`'))
        .filter(|command| command.starts_with("supertag "))
        .unwrap_or("supertag get inbox-items")
        .to_owned()
}

/// A short, metadata-only sentence for one item, and the command that acts on it.
fn headline(kind: InboxItemKind, item: &InboxItem, blocking: bool) -> (String, Option<String>) {
    let objective = &item.objective_id;
    match kind {
        InboxItemKind::Approval => match &item.approval {
            Some(approval) => (
                format!(
                    "Approval {}{}: {} (requested by Tag {})",
                    approval.approval_id,
                    if blocking { " (work is waiting)" } else { "" },
                    summary(&approval.summary),
                    approval.tag_id
                ),
                Some(format!("supertag get approval {}", approval.approval_id)),
            ),
            None => ("An approval request waits for a decision".into(), None),
        },
        InboxItemKind::Question => (
            format!("Objective {objective} waits on your answer"),
            Some(format!("supertag get question {}", item.task_id)),
        ),
        InboxItemKind::ObjectiveBudget => (
            "The Objective budget is used up".into(),
            Some(format!("supertag describe objective {objective}")),
        ),
        InboxItemKind::ObjectiveLimit => (
            summary(&item.reason),
            Some(format!("supertag describe objective {objective}")),
        ),
        InboxItemKind::TaskAttention => {
            let attempt = item.attempt_id.as_deref().unwrap_or("?");
            (
                format!(
                    "Task {} is uncertain: Attempt {attempt} may have executed, and only an operator on its Worker Host can recover it",
                    item.task_id
                ),
                Some(format!(
                    "supertag task resolve-attempt {} {attempt} --decision retry --evidence TEXT --confirmed-stopped",
                    item.task_id
                )),
            )
        }
        InboxItemKind::McpLogin => {
            let server = item.key.rsplit(':').next().unwrap_or("?");
            (
                format!(
                    "Task {} is held until MCP server {server} is logged in",
                    item.task_id
                ),
                Some(format!("supertag mcp login {server}")),
            )
        }
        InboxItemKind::Unspecified => ("An item waits for you".into(), None),
    }
}

fn summary(text: &str) -> String {
    let mut clean = String::new();
    let mut gap = false;
    for c in text.chars() {
        if c.is_control() || format_character(c) {
            gap = true;
            continue;
        }
        if gap {
            clean.push(' ');
            gap = false;
        }
        clean.push(c);
    }
    let clean = clean.trim();
    if clean.chars().count() > 160 {
        let mut short: String = clean.chars().take(159).collect();
        short.push('…');
        short
    } else {
        clean.to_owned()
    }
}

/// Unicode general category Cf (format characters), as TypeScript's `\p{Cf}` matches them:
/// soft hyphens, bidirectional controls and isolates, zero-width characters, and tags.
fn format_character(c: char) -> bool {
    matches!(
        c,
        '\u{ad}'
            | '\u{600}'..='\u{605}'
            | '\u{61c}'
            | '\u{6dd}'
            | '\u{70f}'
            | '\u{890}'..='\u{891}'
            | '\u{8e2}'
            | '\u{180e}'
            | '\u{200b}'..='\u{200f}'
            | '\u{202a}'..='\u{202e}'
            | '\u{2060}'..='\u{2064}'
            | '\u{2066}'..='\u{206f}'
            | '\u{feff}'
            | '\u{fff9}'..='\u{fffb}'
            | '\u{110bd}'
            | '\u{110cd}'
            | '\u{13430}'..='\u{1343f}'
            | '\u{1bca0}'..='\u{1bca3}'
            | '\u{1d173}'..='\u{1d17a}'
            | '\u{e0001}'
            | '\u{e0020}'..='\u{e007f}'
    )
}

fn render(objective: &str, items: &[&Item], more: bool) -> String {
    let text = if objective == "*" {
        desktop_text(items, more)
    } else {
        objective_text(objective, items, more)
    };
    redact_urls(&text)
}

/// A short message: what needs the operator, then the command to act.
fn objective_text(objective: &str, items: &[&Item], more: bool) -> String {
    if let [only] = items
        && !more
    {
        return format!(
            "Objective {objective} needs you: {}\n`supertag describe objective {objective}`",
            only.headline
        );
    }
    let mut lines = vec![format!(
        "Objective {objective} has {} {} {} you:",
        items.len(),
        if more { "more" } else { "new" },
        if items.len() == 1 {
            "item that needs"
        } else {
            "items that need"
        }
    )];
    for item in items.iter().take(ITEMS_SHOWN) {
        lines.push(match &item.command {
            Some(command) => format!("- {}: `{command}`", item.headline),
            None => format!("- {}", item.headline),
        });
    }
    if items.len() > ITEMS_SHOWN {
        lines.push(format!("- …and {} more", items.len() - ITEMS_SHOWN));
    }
    lines.push(format!(
        "`supertag get inbox-items --objective {objective}`"
    ));
    lines.join("\n")
}

fn desktop_text(items: &[&Item], more: bool) -> String {
    let objectives: BTreeSet<Option<&str>> = items
        .iter()
        .map(|item| item.objective_id.as_deref())
        .collect();
    if objectives.len() == 1
        && let Some(Some(objective)) = objectives.iter().next()
    {
        return objective_text(objective, items, more);
    }
    if let [only] = items
        && !more
    {
        return match &only.command {
            Some(command) => format!("SuperTag needs you: {}\n`{command}`", only.headline),
            None => format!("SuperTag needs you: {}", only.headline),
        };
    }
    let adjective = if more { "more" } else { "new" };
    if objectives.contains(&None) {
        format!(
            "SuperTag has {} {adjective} items that need you.\n`supertag get inbox-items`",
            items.len()
        )
    } else {
        format!(
            "SuperTag has {} {adjective} items across {} Objectives.\n`supertag get inbox-items`",
            items.len(),
            objectives.len()
        )
    }
}

/// Removes URLs, which can carry webhook secrets, from operator-visible text.
pub(crate) fn redact_urls(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    loop {
        let lower = rest.to_ascii_lowercase();
        let start = [lower.find("http://"), lower.find("https://")]
            .into_iter()
            .flatten()
            .min();
        let Some(start) = start else {
            out.push_str(rest);
            return out;
        };
        out.push_str(&rest[..start]);
        let tail = &rest[start..];
        let end = tail
            .find(|c: char| c.is_whitespace() || c == ')' || c == '`')
            .unwrap_or(tail.len());
        out.push_str("<redacted URL>");
        rest = &tail[end..];
    }
}

impl crate::ControlPlane {
    pub fn operator_notifications_service(
        &self,
    ) -> operator_notifications_server::OperatorNotificationsServer<Self> {
        operator_notifications_server::OperatorNotificationsServer::new(self.clone())
            .max_decoding_message_size(supertag_protocol::MAX_MESSAGE_BYTES)
            .max_encoding_message_size(supertag_protocol::MAX_MESSAGE_BYTES)
    }
}

#[tonic::async_trait]
impl operator_notifications_server::OperatorNotifications for crate::ControlPlane {
    async fn claim(
        &self,
        request: tonic::Request<ClaimOperatorNotificationRequest>,
    ) -> std::result::Result<tonic::Response<ClaimOperatorNotificationResponse>, tonic::Status>
    {
        let principal = self.principal(&request, "operator:")?;
        Ok(tonic::Response::new(
            self.store
                .claim_operator_notification(&principal, request.get_ref())
                .await?,
        ))
    }

    async fn settle(
        &self,
        request: tonic::Request<SettleOperatorNotificationRequest>,
    ) -> std::result::Result<tonic::Response<OperatorNotification>, tonic::Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(tonic::Response::new(
            self.store
                .settle_operator_notification(&principal, request.get_ref())
                .await?,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(key: &str, objective: Option<&str>, headline: &str) -> Item {
        Item {
            key: key.into(),
            objective_id: objective.map(Into::into),
            headline: headline.into(),
            command: Some(format!("supertag get question {key}")),
            blocking_approval: false,
            carried: false,
        }
    }

    #[test]
    fn messages_match_the_typescript_format() {
        let first = item("q1", Some("obj"), "Objective obj waits on your answer");
        assert_eq!(
            render("obj", &[&first], false),
            "Objective obj needs you: Objective obj waits on your answer\n`supertag describe objective obj`"
        );
        let many: Vec<Item> = (0..7)
            .map(|i| item(&format!("q{i}"), Some("obj"), &format!("item {i}")))
            .collect();
        let refs: Vec<&Item> = many.iter().collect();
        let text = render("obj", &refs, true);
        assert!(text.starts_with(
            "Objective obj has 7 more items that need you:\n- item 0: `supertag get question q0`"
        ));
        assert!(text.contains("\n- …and 2 more\n"));
        assert!(text.ends_with("\n`supertag get inbox-items --objective obj`"));
        assert_eq!(
            command_of(&text),
            "supertag get inbox-items --objective obj"
        );
        let other = item("q9", Some("other"), "other item");
        assert_eq!(
            render("*", &[&first, &other], false),
            "SuperTag has 2 new items across 2 Objectives.\n`supertag get inbox-items`"
        );
        let unscoped = item("a1", None, "Approval a1: merge (requested by Tag t)");
        assert_eq!(
            render("*", &[&unscoped], false),
            "SuperTag needs you: Approval a1: merge (requested by Tag t)\n`supertag get question a1`"
        );
    }

    #[test]
    fn urls_and_control_characters_never_reach_the_message() {
        assert_eq!(
            redact_urls("failed at https://hooks.example/x?token=private (HTTP://A.b/c)"),
            "failed at <redacted URL> (<redacted URL>)"
        );
        assert_eq!(summary("  merge\u{0}\u{200b}now  "), "merge now");
        // Every format character, including bidirectional isolates, as `\p{Cf}` matches.
        for format in [
            '\u{61c}',
            '\u{180e}',
            '\u{2066}',
            '\u{2067}',
            '\u{2068}',
            '\u{2069}',
            '\u{206a}',
            '\u{600}',
            '\u{fff9}',
            '\u{e0001}',
            '\u{e0041}',
            '\u{1d173}',
        ] {
            assert_eq!(summary(&format!("deploy{format}main")), "deploy main");
        }
        assert_eq!(summary("caf\u{e9} \u{5d0}"), "caf\u{e9} \u{5d0}");
        assert_eq!(summary(&"x".repeat(200)).chars().count(), 160);
    }

    #[test]
    fn destination_keys_never_carry_webhook_urls() {
        assert!(valid_key("desktop", NotificationProvider::Desktop));
        assert!(valid_key("slack:C123", NotificationProvider::Slack));
        assert!(valid_key("slack:T1/U123", NotificationProvider::Slack));
        assert!(!valid_key("slack:X123", NotificationProvider::Slack));
        assert!(valid_key(
            &format!("webhook:{}", "a".repeat(64)),
            NotificationProvider::Webhook
        ));
        assert!(!valid_key(
            "webhook:https://hooks.example/x",
            NotificationProvider::Webhook
        ));
    }
}
