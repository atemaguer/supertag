//! The one message model under Tags' Mailbox and Workstream and people's conversations with Tags.
//!
//! A conversation is a direct conversation between two members, a Team's channel, or a thread
//! under a message. Each conversation numbers its own messages (`seq`) inside the inserting
//! transaction, so writers to different conversations never wait on a shared counter. Member rows
//! hold permission to read and the read and delivery positions; a Tag's undelivered direct
//! messages wait in its inbox Session's input queue ([`wakes`]), which records which Tag must take
//! a turn for which messages.
//!
//! "Mailbox" and "Workstream" stay the names users and Tags see: a direct conversation between
//! Tags is the Mailbox, and a Team's channel is its Workstream. "direct" and "channel" are storage
//! kinds only.

use sqlx::{Any, Row, Transaction, any::AnyRow};
use supertag_protocol::v2::MessageKind;
use uuid::Uuid;

use crate::{
    StoreError,
    store::{Result, invalid, name},
};

pub(crate) mod digest;
pub(crate) mod wakes;

/// A conversation member or a message's sender.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Member<'a> {
    Tag(&'a str),
    /// An operator or client principal, such as `operator:alice`.
    Principal(&'a str),
}

impl<'a> Member<'a> {
    pub(crate) fn kind(self) -> i64 {
        match self {
            Self::Tag(_) => 1,
            Self::Principal(_) => 2,
        }
    }

    pub(crate) fn id(self) -> &'a str {
        match self {
            Self::Tag(id) | Self::Principal(id) => id,
        }
    }

    fn key(self) -> String {
        match self {
            Self::Tag(id) => format!("t:{id}"),
            Self::Principal(id) => format!("p:{id}"),
        }
    }
}

/// Stored as `supertag_v2_conversations.kind`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(i64)]
pub(crate) enum ConversationKind {
    Direct = 1,
    Channel = 2,
    Thread = 3,
    /// Reserved for surface threads; no rows yet.
    Surface = 4,
}

impl ConversationKind {
    pub(crate) fn from_stored(value: i64) -> Result<Self> {
        Ok(match value {
            1 => Self::Direct,
            2 => Self::Channel,
            3 => Self::Thread,
            4 => Self::Surface,
            _ => return Err(corrupt("unknown conversation kind")),
        })
    }
}

fn corrupt(what: &str) -> StoreError {
    StoreError::Storage(sqlx::Error::Decode(what.to_owned().into()))
}

/// The stored value of a message kind; an unspecified kind is a note.
pub(crate) fn stored_kind(kind: MessageKind) -> i64 {
    match kind {
        MessageKind::Unspecified | MessageKind::Note => 1,
        other => other as i64,
    }
}

fn message_kind(value: i64) -> Result<MessageKind> {
    i32::try_from(value)
        .ok()
        .and_then(|value| MessageKind::try_from(value).ok())
        .filter(|kind| *kind != MessageKind::Unspecified)
        .ok_or_else(|| corrupt("unknown message kind"))
}

/// The direct-conversation key of two members: their keys, sorted, joined by a newline. Names
/// never contain control characters, so the key is unambiguous.
pub(crate) fn direct_key(a: Member<'_>, b: Member<'_>) -> String {
    let (a, b) = (a.key(), b.key());
    if a <= b {
        format!("{a}\n{b}")
    } else {
        format!("{b}\n{a}")
    }
}

pub(crate) struct NewMessage<'a> {
    pub conversation_id: &'a str,
    pub sender: Member<'a>,
    pub kind: MessageKind,
    /// Empty only for a person conversation's turn, whose content is its Task.
    pub text: &'a str,
    pub hops: i64,
    pub source_task_id: Option<&'a str>,
    /// The Task that started the chain this message continues.
    pub origin_task_id: Option<&'a str>,
    pub objective_id: Option<&'a str>,
    /// A person conversation's turn: the Task the message is.
    pub task_id: Option<&'a str>,
    pub effect_digest: Option<&'a str>,
    /// The Tags a Tag's message names. The sender and repeats are skipped.
    pub addressees: &'a [String],
    pub now: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Stored {
    pub message_id: String,
    pub seq: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct MessageRow {
    pub conversation_id: String,
    pub seq: i64,
    pub message_id: String,
    pub sender_kind: i64,
    pub sender_id: String,
    pub kind: MessageKind,
    pub text: String,
    pub hops: i64,
    pub source_task_id: Option<String>,
    pub origin_task_id: Option<String>,
    pub objective_id: Option<String>,
    pub task_id: Option<String>,
    pub effect_digest: Option<String>,
    pub created_at_ms: i64,
    /// Sorted.
    pub addressees: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct MemberRow {
    pub conversation_id: String,
    pub member_kind: i64,
    pub member_id: String,
    pub read_seq: i64,
    pub delivered_seq: i64,
    pub mention_count: i64,
    pub notify: i64,
    pub joined_at_ms: i64,
    pub read_at_ms: Option<i64>,
    pub left_at_ms: Option<i64>,
}

/// `supertag_v2_message_operations.scope`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(i64)]
pub(crate) enum OperationScope {
    /// A Task's Mailbox sends; the scope ID is the source Task.
    Mailbox = 1,
    /// A Task's Workstream posts; the scope ID is the source Task.
    Workstream = 2,
    /// A principal's conversation messages; the scope ID is the principal.
    Conversation = 3,
}

/// Gets or creates the direct conversation of two members and makes both members.
pub(crate) async fn direct_conversation_in(
    tx: &mut Transaction<'_, Any>,
    a: Member<'_>,
    b: Member<'_>,
    now: i64,
) -> Result<String> {
    if a == b {
        return Err(invalid("a direct conversation needs two members"));
    }
    name("member ID", a.id())?;
    name("member ID", b.id())?;
    let key = direct_key(a, b);
    // A concurrent writer may create it first; either way the row with this key is the one.
    sqlx::query(
        "INSERT INTO supertag_v2_conversations (conversation_id,kind,direct_key,created_at_ms)
         VALUES ($1,1,$2,$3) ON CONFLICT(direct_key) DO NOTHING",
    )
    .bind(format!("direct/{}", Uuid::new_v4().simple()))
    .bind(&key)
    .bind(now)
    .execute(&mut **tx)
    .await?;
    let id: String = sqlx::query_scalar(
        "SELECT conversation_id FROM supertag_v2_conversations WHERE direct_key=$1",
    )
    .bind(&key)
    .fetch_one(&mut **tx)
    .await?;
    for member in [a, b] {
        join_in(tx, &id, member, 0, now).await?;
    }
    Ok(id)
}

/// Gets or creates the conversation of an Objective with its Tag: a direct conversation keyed
/// `o:<objective>` whose one member is the Tag. The Objective's asks and its inbox Session's
/// answers are its messages (`crate::mailbox::objective_asks`).
pub(crate) async fn objective_conversation_in(
    tx: &mut Transaction<'_, Any>,
    tag_id: &str,
    objective_id: &str,
    now: i64,
) -> Result<String> {
    name("Objective ID", objective_id)?;
    let key = format!("o:{objective_id}");
    sqlx::query(
        "INSERT INTO supertag_v2_conversations (conversation_id,kind,direct_key,created_at_ms)
         VALUES ($1,1,$2,$3) ON CONFLICT(direct_key) DO NOTHING",
    )
    .bind(format!("direct/{}", Uuid::new_v4().simple()))
    .bind(&key)
    .bind(now)
    .execute(&mut **tx)
    .await?;
    let id: String = sqlx::query_scalar(
        "SELECT conversation_id FROM supertag_v2_conversations WHERE direct_key=$1",
    )
    .bind(&key)
    .fetch_one(&mut **tx)
    .await?;
    join_in(tx, &id, Member::Tag(tag_id), 0, now).await?;
    Ok(id)
}

/// The Objective whose conversation with its Tag this is, if it is one.
pub(crate) async fn conversation_objective_in(
    tx: &mut Transaction<'_, Any>,
    conversation_id: &str,
) -> Result<Option<String>> {
    let key: Option<Option<String>> = sqlx::query_scalar(
        "SELECT direct_key FROM supertag_v2_conversations WHERE conversation_id=$1",
    )
    .bind(conversation_id)
    .fetch_optional(&mut **tx)
    .await?;
    Ok(key
        .flatten()
        .and_then(|key| key.strip_prefix("o:").map(str::to_owned)))
}

async fn join_in(
    tx: &mut Transaction<'_, Any>,
    conversation_id: &str,
    member: Member<'_>,
    position: i64,
    now: i64,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO supertag_v2_conversation_members
            (conversation_id,member_kind,member_id,read_seq,delivered_seq,joined_at_ms)
         VALUES ($1,$2,$3,$4,$4,$5)
         ON CONFLICT(conversation_id,member_kind,member_id) DO NOTHING",
    )
    .bind(conversation_id)
    .bind(member.kind())
    .bind(member.id())
    .bind(position)
    .bind(now)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// The Team's channel: its Workstream.
pub(crate) async fn team_channel_in(
    tx: &mut Transaction<'_, Any>,
    team_id: &str,
) -> Result<Option<String>> {
    Ok(sqlx::query_scalar(
        "SELECT conversation_id FROM supertag_v2_conversations
         WHERE team_id=$1 AND kind=2 AND name IS NULL AND archived_at_ms IS NULL",
    )
    .bind(team_id)
    .fetch_optional(&mut **tx)
    .await?)
}

/// Creates a new Team's channel with its member Tags.
pub(crate) async fn create_team_channel_in(
    tx: &mut Transaction<'_, Any>,
    team_id: &str,
    members: &[String],
    now: i64,
) -> Result<String> {
    let id = format!("channel/{}", Uuid::new_v4().simple());
    sqlx::query(
        "INSERT INTO supertag_v2_conversations (conversation_id,kind,team_id,created_at_ms)
         VALUES ($1,2,$2,$3)",
    )
    .bind(&id)
    .bind(team_id)
    .bind(now)
    .execute(&mut **tx)
    .await?;
    for member in members {
        join_in(tx, &id, Member::Tag(member), 0, now).await?;
    }
    Ok(id)
}

/// Makes the channel's Tag members the Team's members. A new member starts at the channel's
/// latest message, so earlier posts do not flood its first digest; a removed member keeps its
/// cursor and is marked as left; a returning member is no longer marked.
pub(crate) async fn sync_channel_members_in(
    tx: &mut Transaction<'_, Any>,
    team_id: &str,
    members: &[String],
    now: i64,
) -> Result<()> {
    let Some(channel) = team_channel_in(tx, team_id).await? else {
        return Err(StoreError::NotFound("Team channel was not found".into()));
    };
    let latest: i64 = sqlx::query_scalar(
        "SELECT next_seq-1 FROM supertag_v2_conversations WHERE conversation_id=$1",
    )
    .bind(&channel)
    .fetch_one(&mut **tx)
    .await?;
    let current: Vec<(String, Option<i64>)> = sqlx::query(
        "SELECT member_id,left_at_ms FROM supertag_v2_conversation_members
         WHERE conversation_id=$1 AND member_kind=1",
    )
    .bind(&channel)
    .fetch_all(&mut **tx)
    .await?
    .iter()
    .map(|row| Ok((row.try_get("member_id")?, row.try_get("left_at_ms")?)))
    .collect::<Result<_>>()?;
    for member in members {
        match current.iter().find(|(id, _)| id == member) {
            None => join_in(tx, &channel, Member::Tag(member), latest, now).await?,
            Some((_, Some(_))) => {
                sqlx::query(
                    "UPDATE supertag_v2_conversation_members SET left_at_ms=NULL
                     WHERE conversation_id=$1 AND member_kind=1 AND member_id=$2",
                )
                .bind(&channel)
                .bind(member)
                .execute(&mut **tx)
                .await?;
            }
            Some((_, None)) => {}
        }
    }
    for (id, left) in &current {
        if left.is_none() && !members.contains(id) {
            sqlx::query(
                "UPDATE supertag_v2_conversation_members SET left_at_ms=$1
                 WHERE conversation_id=$2 AND member_kind=1 AND member_id=$3",
            )
            .bind(now)
            .bind(&channel)
            .bind(id)
            .execute(&mut **tx)
            .await?;
        }
    }
    Ok(())
}

/// Archives the Team's channel before the Team is deleted. The channel and its messages stay as a
/// record; deleting the Team clears its `team_id`.
pub(crate) async fn archive_team_channel_in(
    tx: &mut Transaction<'_, Any>,
    team_id: &str,
    now: i64,
) -> Result<()> {
    sqlx::query(
        "UPDATE supertag_v2_conversations SET archived_at_ms=$1
         WHERE team_id=$2 AND kind=2 AND archived_at_ms IS NULL",
    )
    .bind(now)
    .bind(team_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Inserts a message with the conversation's next seq, its addressees, and one more mention for
/// each addressee that is a member.
pub(crate) async fn insert_message_in(
    tx: &mut Transaction<'_, Any>,
    message: &NewMessage<'_>,
) -> Result<Stored> {
    if message.task_id.is_none() && message.text.is_empty() {
        return Err(invalid("a message needs text"));
    }
    if !(0..=4).contains(&message.hops) {
        return Err(invalid("a message continues at most four inboxes"));
    }
    let mut addressees: Vec<&str> = message
        .addressees
        .iter()
        .map(String::as_str)
        .filter(|id| *id != message.sender.id())
        .collect();
    addressees.sort_unstable();
    addressees.dedup();
    let sender_tag = match message.sender {
        Member::Tag(id) => Some(id),
        Member::Principal(_) => None,
    };
    if sender_tag.is_none() && !addressees.is_empty() {
        return Err(invalid("only a Tag's message names addressees"));
    }
    // Only writers to this conversation wait on this row.
    let seq: Option<i64> = sqlx::query_scalar(
        "UPDATE supertag_v2_conversations SET next_seq=next_seq+1
         WHERE conversation_id=$1 RETURNING next_seq-1",
    )
    .bind(message.conversation_id)
    .fetch_optional(&mut **tx)
    .await?;
    let seq = seq.ok_or_else(|| StoreError::NotFound("conversation was not found".into()))?;
    let message_id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO supertag_v2_messages
            (conversation_id,seq,message_id,sender_kind,sender_id,kind,text,hops,source_task_id,
             origin_task_id,objective_id,task_id,effect_digest,created_at_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)",
    )
    .bind(message.conversation_id)
    .bind(seq)
    .bind(&message_id)
    .bind(message.sender.kind())
    .bind(message.sender.id())
    .bind(stored_kind(message.kind))
    .bind(message.text)
    .bind(message.hops)
    .bind(message.source_task_id)
    .bind(message.origin_task_id)
    .bind(message.objective_id)
    .bind(message.task_id)
    .bind(message.effect_digest)
    .bind(message.now)
    .execute(&mut **tx)
    .await?;
    if let Some(sender) = sender_tag {
        for addressee in addressees {
            sqlx::query(
                "INSERT INTO supertag_v2_message_addressees
                    (conversation_id,seq,tag_id,sender_tag_id,created_at_ms)
                 VALUES ($1,$2,$3,$4,$5)",
            )
            .bind(message.conversation_id)
            .bind(seq)
            .bind(addressee)
            .bind(sender)
            .bind(message.now)
            .execute(&mut **tx)
            .await?;
            sqlx::query(
                "UPDATE supertag_v2_conversation_members SET mention_count=mention_count+1
                 WHERE conversation_id=$1 AND member_kind=1 AND member_id=$2",
            )
            .bind(message.conversation_id)
            .bind(addressee)
            .execute(&mut **tx)
            .await?;
        }
    }
    Ok(Stored { message_id, seq })
}

/// A recorded operation's request digest and message.
pub(crate) async fn operation_in(
    tx: &mut Transaction<'_, Any>,
    scope: OperationScope,
    scope_id: &str,
    operation_id: &str,
) -> Result<Option<(String, String)>> {
    let row = sqlx::query(
        "SELECT request_digest,message_id FROM supertag_v2_message_operations
         WHERE scope=$1 AND scope_id=$2 AND operation_id=$3",
    )
    .bind(scope as i64)
    .bind(scope_id)
    .bind(operation_id)
    .fetch_optional(&mut **tx)
    .await?;
    row.map(|row| Ok((row.try_get("request_digest")?, row.try_get("message_id")?)))
        .transpose()
}

pub(crate) async fn record_operation_in(
    tx: &mut Transaction<'_, Any>,
    scope: OperationScope,
    scope_id: &str,
    operation_id: &str,
    digest: &str,
    message_id: &str,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO supertag_v2_message_operations
            (scope,scope_id,operation_id,request_digest,message_id)
         VALUES ($1,$2,$3,$4,$5)",
    )
    .bind(scope as i64)
    .bind(scope_id)
    .bind(operation_id)
    .bind(digest)
    .bind(message_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

fn message_row(row: &AnyRow) -> Result<MessageRow> {
    Ok(MessageRow {
        conversation_id: row.try_get("conversation_id")?,
        seq: row.try_get("seq")?,
        message_id: row.try_get("message_id")?,
        sender_kind: row.try_get("sender_kind")?,
        sender_id: row.try_get("sender_id")?,
        kind: message_kind(row.try_get("kind")?)?,
        text: row.try_get("text")?,
        hops: row.try_get("hops")?,
        source_task_id: row.try_get("source_task_id")?,
        origin_task_id: row.try_get("origin_task_id")?,
        objective_id: row.try_get("objective_id")?,
        task_id: row.try_get("task_id")?,
        effect_digest: row.try_get("effect_digest")?,
        created_at_ms: row.try_get("created_at_ms")?,
        addressees: Vec::new(),
    })
}

/// Fills each message's addressees with one range read over the page's seqs.
async fn with_addressees(
    tx: &mut Transaction<'_, Any>,
    conversation_id: &str,
    messages: &mut [MessageRow],
) -> Result<()> {
    let (Some(first), Some(last)) = (
        messages.iter().map(|m| m.seq).min(),
        messages.iter().map(|m| m.seq).max(),
    ) else {
        return Ok(());
    };
    let rows = sqlx::query(
        "SELECT seq,tag_id FROM supertag_v2_message_addressees
         WHERE conversation_id=$1 AND seq BETWEEN $2 AND $3 ORDER BY seq,tag_id",
    )
    .bind(conversation_id)
    .bind(first)
    .bind(last)
    .fetch_all(&mut **tx)
    .await?;
    for row in rows {
        let seq: i64 = row.try_get("seq")?;
        if let Some(message) = messages.iter_mut().find(|m| m.seq == seq) {
            message.addressees.push(row.try_get("tag_id")?);
        }
    }
    Ok(())
}

pub(crate) async fn message_by_id_in(
    tx: &mut Transaction<'_, Any>,
    message_id: &str,
) -> Result<Option<MessageRow>> {
    let Some(row) = sqlx::query("SELECT * FROM supertag_v2_messages WHERE message_id=$1")
        .bind(message_id)
        .fetch_optional(&mut **tx)
        .await?
    else {
        return Ok(None);
    };
    let mut message = [message_row(&row)?];
    let conversation = message[0].conversation_id.clone();
    with_addressees(tx, &conversation, &mut message).await?;
    let [message] = message;
    Ok(Some(message))
}

/// One page of a conversation, in seq order. With `after`, the first `limit` messages after it;
/// without, the latest `limit`. `before` bounds either. Ask for one more than a page to learn
/// whether more follow.
pub(crate) async fn page_in(
    tx: &mut Transaction<'_, Any>,
    conversation_id: &str,
    after: Option<i64>,
    before: Option<i64>,
    limit: i64,
) -> Result<Vec<MessageRow>> {
    let before = before.unwrap_or(i64::MAX);
    let rows =
        match after {
            Some(after) => sqlx::query(
                "SELECT * FROM supertag_v2_messages WHERE conversation_id=$1 AND seq>$2 AND seq<$3
                 ORDER BY seq LIMIT $4",
            )
            .bind(conversation_id)
            .bind(after)
            .bind(before)
            .bind(limit)
            .fetch_all(&mut **tx)
            .await?,
            None => {
                let mut rows = sqlx::query(
                    "SELECT * FROM supertag_v2_messages WHERE conversation_id=$1 AND seq<$2
                 ORDER BY seq DESC LIMIT $3",
                )
                .bind(conversation_id)
                .bind(before)
                .bind(limit)
                .fetch_all(&mut **tx)
                .await?;
                rows.reverse();
                rows
            }
        };
    let mut messages: Vec<_> = rows.iter().map(message_row).collect::<Result<_>>()?;
    with_addressees(tx, conversation_id, &mut messages).await?;
    Ok(messages)
}

pub(crate) async fn member_in(
    tx: &mut Transaction<'_, Any>,
    conversation_id: &str,
    member: Member<'_>,
) -> Result<Option<MemberRow>> {
    let row = sqlx::query(
        "SELECT * FROM supertag_v2_conversation_members
         WHERE conversation_id=$1 AND member_kind=$2 AND member_id=$3",
    )
    .bind(conversation_id)
    .bind(member.kind())
    .bind(member.id())
    .fetch_optional(&mut **tx)
    .await?;
    row.map(|row| {
        Ok(MemberRow {
            conversation_id: row.try_get("conversation_id")?,
            member_kind: row.try_get("member_kind")?,
            member_id: row.try_get("member_id")?,
            read_seq: row.try_get("read_seq")?,
            delivered_seq: row.try_get("delivered_seq")?,
            mention_count: row.try_get("mention_count")?,
            notify: row.try_get("notify")?,
            joined_at_ms: row.try_get("joined_at_ms")?,
            read_at_ms: row.try_get("read_at_ms")?,
            left_at_ms: row.try_get("left_at_ms")?,
        })
    })
    .transpose()
}

/// Moves a member's read or delivery position forward, never back, and returns whether either
/// moved. A position past the conversation's latest message stops at it. A Tag's mention count
/// becomes the messages addressed to it after its new position; a person's resets.
pub(crate) async fn advance_in(
    tx: &mut Transaction<'_, Any>,
    conversation_id: &str,
    member: Member<'_>,
    read: Option<i64>,
    delivered: Option<i64>,
    now: i64,
) -> Result<bool> {
    let Some(current) = member_in(tx, conversation_id, member).await? else {
        return Err(StoreError::NotFound(
            "conversation member was not found".into(),
        ));
    };
    let latest: i64 = sqlx::query_scalar(
        "SELECT next_seq-1 FROM supertag_v2_conversations WHERE conversation_id=$1",
    )
    .bind(conversation_id)
    .fetch_one(&mut **tx)
    .await?;
    let forward = |position: Option<i64>, from: i64| {
        position.map_or(from, |position| position.min(latest).max(from))
    };
    let read_seq = forward(read, current.read_seq);
    let delivered_seq = forward(delivered, current.delivered_seq);
    if read_seq == current.read_seq && delivered_seq == current.delivered_seq {
        return Ok(false);
    }
    let mentions: i64 = match member {
        Member::Tag(id) => {
            sqlx::query_scalar(
                "SELECT COUNT(*) FROM supertag_v2_message_addressees
                 WHERE conversation_id=$1 AND seq>$2 AND tag_id=$3",
            )
            .bind(conversation_id)
            .bind(read_seq.max(delivered_seq))
            .bind(id)
            .fetch_one(&mut **tx)
            .await?
        }
        Member::Principal(_) => 0,
    };
    sqlx::query(
        "UPDATE supertag_v2_conversation_members
         SET read_seq=$1,delivered_seq=$2,mention_count=$3,
             read_at_ms=CASE WHEN $1>read_seq THEN $4 ELSE read_at_ms END
         WHERE conversation_id=$5 AND member_kind=$6 AND member_id=$7",
    )
    .bind(read_seq)
    .bind(delivered_seq)
    .bind(mentions)
    .bind(now)
    .bind(conversation_id)
    .bind(member.kind())
    .bind(member.id())
    .execute(&mut **tx)
    .await?;
    Ok(true)
}

/// Gives a message the conversation's next seq and returns it. For a person conversation's held
/// turn, which no reader saw at its old place: such a turn has no addressees or threads.
pub(crate) async fn move_to_end_in(
    tx: &mut Transaction<'_, Any>,
    conversation_id: &str,
    seq: i64,
) -> Result<i64> {
    let next: Option<i64> = sqlx::query_scalar(
        "UPDATE supertag_v2_conversations SET next_seq=next_seq+1
         WHERE conversation_id=$1 RETURNING next_seq-1",
    )
    .bind(conversation_id)
    .fetch_optional(&mut **tx)
    .await?;
    let next = next.ok_or_else(|| StoreError::NotFound("conversation was not found".into()))?;
    let moved =
        sqlx::query("UPDATE supertag_v2_messages SET seq=$1 WHERE conversation_id=$2 AND seq=$3")
            .bind(next)
            .bind(conversation_id)
            .bind(seq)
            .execute(&mut **tx)
            .await?;
    if moved.rows_affected() != 1 {
        return Err(StoreError::NotFound("message was not found".into()));
    }
    Ok(next)
}

#[cfg(test)]
mod tests;
