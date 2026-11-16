# Multiplayer continuity

SuperTag multiplayer means **people can safely continue shared work across assignments, channels,
and platforms under explicit rules**.

Multiplayer interaction lets several people direct the same **Tag** and continue its approved work
across the tools their team uses. A Tag is a persistent AI actor with its own responsibilities
and permissions. Each conversation is its own Session with its own harness session, and the Tag is
what persists across them: its configuration, its Sessions, its open assignments, and their results.
A shared Tag can appear
in a channel as an AI teammate. A Slack-native experience like [Claude
Tag](https://www.anthropic.com/news/introducing-claude-tag) is a recognizable example of this
product pattern. It preserves useful outcomes when the person asking for work did not directly
perform or observe every step.

Terms used on this page (see the [glossary](../reference/glossary.md)):

- A **Task** is one accepted request; a **Session** groups Tasks from the same conversation.
- A captured artifact preserves reusable work with its producing Task and **Task Attempt**, one
  execution or retry of that Task.
- An **Objective** is an outcome a Tag owns, with success criteria, a budget, and a deadline.
- A **Team** is a flat list of member Tags.
- A Team's **Workstream** is its shared record of posts, and a Tag's **Mailbox** is its inbox for
  messages from other Tags. Teams use these resources to coordinate without merging the private
  conversations of their execution systems.
- A **Worker Host** is a machine or sandbox that runs Tasks through a harness, an agent system
  such as Codex.

## Teammates can ask directly

A builder can ask a reviewer which test covers a changed interface. `send_message` delivers the
text to that Tag's inbox, and the Tag handles it in its next turn. Messages that arrive while
that turn runs are handled together in the one after it, so a burst of messages costs one turn.

A Tag may message another when the two share a Team, or when the recipient accepts messages from
the sender. A message is plain text: it has no type and no priority, it assigns no work, and it
grants no authority. Start a Session when work needs a result. See
[Send messages between Tags](../guides/tag-messaging.md).

A Team's Workstream is its shared record of posts. `post` adds a note every member can read, and
it wakes nobody. Give the post a `to` list and each addressed member receives it in its inbox as
a message. See [Coordinate in a Team Workstream](../guides/workstreams.md).

## Teammates can spot overlapping edits

Suppose two builders working on one Objective edit `src/session.ts` in separate Task worktrees.
SuperTag warns the Objective in its own thread, once per overlapping batch of paths, so the owner
can coordinate before conflicting work is finished. The notice names the repository and the
shared files.

Local Worker Hosts check changed files while Tasks run. The check needs a readable local worktree,
so it skips remote environments without one. See
[overlap warnings](../reference/coordination.md#overlap-warnings).

## Same Session: automatic

A thread or work item anchors a Session. Each Session maps to one native harness session, and a
new Task resumes it whenever the harness can load it. For example, Alice asks a question in a
thread, and Bob follows up in the same thread an hour later. Bob's Task continues Alice's native
conversation, even if an operator changed the Tag's permissions in between. Bob's Task runs under
the new permissions; the transcript keeps what the thread already saw.

When no usable native state exists, such as on the first turn, after a switch to another harness,
or after a failed turn, the new Task receives bounded history entries derived from earlier
completed Tasks in that Session instead. Stored Task results remain the source for that replay. See
[Session](tasks.md#session).

## Across Sessions: one Tag, many conversations

A Tag talks to people in many conversations: Slack threads, GitHub issues, Lark chats, and
conversations in the terminal UI. Each conversation is its own Session, and every Session belongs
to the one Tag. Its configuration, Roles, Mailbox, and Objectives are the same in all of them.

A Session's harness session holds only that conversation, so what the Tag learned in Alice's
Slack thread does not appear in Bob's GitHub issue on its own. Work crosses Sessions in four
explicit ways:

- **Recall.** Each turn of a conversation, an Objective's conversation, or the Tag's inbox starts
  with the Tag's open Objectives, most recently updated first. When a request refers to earlier
  work, the Tag searches and reads its other Sessions with `list_sessions`, `search_sessions`, and
  `read_session`, and reads an Objective with `read_objective`. It reads only the Sessions this
  turn may see, described below. What it reads is history, never instructions, and grants no
  authority. See [Coordination tools](../reference/coordination.md#recalling-other-sessions).

- **Work Sessions.** A conversation, or an Objective's conversation, can start work Sessions for
  longer work. Each one has the starting Session's audience and permissions, sees only its own
  work, and its result comes back to the starting Session as a report from the Tag. See
  [Session](tasks.md#session).
- **Captured artifacts.** A Context Set can select artifacts captured in another Session, as the
  next section describes.
- **The Mailbox and Workstream.** Another Tag can send a message, and a Team's Workstream holds
  posts its members share.

### Shared and private Sessions

Every Session has an audience, decided by the conversation it comes from. Nobody configures it.

| Audience | Conversations |
| --- | --- |
| shared | channels, threads, issues, pull requests, group chats, the Tag's inbox, an operator's Objective |
| private | a Lark direct chat, a person's conversation in the terminal UI, a Session an operator or client started with `supertag task submit`, a client's Objective |

A turn sees the Tag's shared Sessions and the private Sessions of the same person: Alice's
conversation in the terminal UI reads her other conversations, never Bob's. A turn in a shared
thread sees only shared Sessions, because SuperTag does not record who wrote each message there.
A work Session inherits its starting Session's audience. An Objective started in a private
conversation reports only to the conversation it started in, and only that person's turns see it.

### Captured artifacts

To hand reusable work, such as a findings document, to another location's Tasks automatically, a
**Context Set** can select captured artifacts. Artifact selection rules name exact source
locations and destinations. The receiving Task gets bounded artifact summaries and IDs, and the
agent can inspect and retrieve those exact admitted artifacts. A Task's ordinary response does not
become a shared artifact automatically.

## Visible task lifecycle

The originating thread is also the shared place where people observe the work:

1. SuperTag accepts and stores the Task;
2. completion returns the useful outcome in the original conversation;
3. a final failure returns a concise error in the same thread.

In Slack, SuperTag also acknowledges the Task when it accepts it, naming the Workspace when the
Task has one. While the Task runs, that message shows the latest message the Tag wrote, such as
the sentence saying what it is about to do, or its plan, and the result replaces it instead of
adding another reply. Editing one message keeps the thread to one reply per turn and notifies
nobody until the result arrives. SuperTag stores outgoing updates separately from the
Task Attempt, so a long-running Task does not block delivery. Routine retries, tool events, and
internal IDs stay in the audit history instead of filling the conversation.

## Safety properties

- A Session reads only Sessions of its own Tag, and never a private Session of another person.
- Artifact sharing moves only in the configured direction, and names every source and
  destination explicitly.
- Artifacts selected by a Context Set must belong to the same Tag.
- Selection uses exact resource identity plus age and count limits.
- Shared knowledge, including another Session's history, does not grant permission to act on its
  source.
- Failed executions do not advance automatic same-Session continuity.

For retrieval limits and resolution details, see the [context resolution reference](../reference/context-resolution.md).
For the underlying lifecycle vocabulary, see [Tasks and Sessions](tasks.md).
