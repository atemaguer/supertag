# Multiplayer continuity

SuperTag multiplayer means **people can safely continue shared work across assignments, channels,
and platforms under explicit rules**.

Multiplayer interaction lets several people direct the same **Tag** and continue its approved work
across the tools their team uses. A Tag is a persistent AI identity with its own responsibilities
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
- A **Worker Host** is a machine or sandbox that runs Tasks; a **Worker** is the code there that
  completes a Task.

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

## Across Sessions: one Tag, one memory

A Tag talks to people in many conversations: Slack threads, GitHub issues, Lark chats, and CLI
conversations. Each conversation is its own Session, and every Session belongs to the one Tag. The
Tag shares what it knows across them, the way a teammate remembers a conversation from another
channel:

- **Portfolio.** Every conversation turn sees the Tag's open Objectives, one line each, with
  status, deadline, and where each started. It also sees that conversation's work Sessions that
  are running, queued, or waiting on you. Ask "what are you working on?" in any thread and the
  Objectives are the same.
- **Other conversations, on request.** The Tag can list its other Sessions, search their completed
  requests and results, and read one Session's history. It does this only when a question needs
  it; other transcripts never load automatically.

Example:

1. Alice asks the Tag in Slack `#engineering` to investigate a slow query in `acme/api`. It replies
   with its findings.
2. Bob asks the same Tag in a GitHub issue, "Did anyone look into the slow query?"
3. The Tag searches its other Sessions, finds Alice's thread, and answers Bob with what it found
   there.

What the Tag reads from another Session is historical data. It carries no instructions and grants
no permissions: Bob's Task still has only the permissions of Bob's location.

A conversation, or an Objective's conversation, can also start work Sessions for longer work.
Each one has the starting Session's audience and permissions, and its result comes back there as
a report from the Tag.
A work Session is the exception to one memory: it sees only its own work. It gets no portfolio
and can't list, search, or read other Sessions. What one work Session learns reaches another only
through the conversation. See [Session](tasks.md#session).

### Shared and private Sessions

Every Session has an audience, decided by the conversation it comes from. Nobody configures it.

| Audience | Conversations | Who can see it from another Session |
| --- | --- | --- |
| shared | channels, threads, issues, pull requests, group chats | any Session of the same Tag |
| private | a Lark direct chat, a person's CLI conversation | only Sessions where that same person is asking |

An Objective started in a private conversation is private too. It doesn't appear in other people's
portfolios, and they can't read it. Its reports still go to the conversation it started in.

Shared Sessions can see each other across collaboration surfaces. If the Tag works in a private
Slack channel and a public GitHub repository, it could repeat something from the channel in a
public issue, as a teammate on both could. Choose a Tag's locations with that in mind, and use
separate Tags for audiences that must stay apart.

### Captured artifacts

To hand reusable work, such as a findings document, to another location's Tasks automatically, a
**Context Set** can select captured artifacts. Artifact selection rules name exact source
locations and destinations. The receiving Task gets bounded artifact summaries and IDs, and the
agent can inspect and retrieve those exact admitted artifacts. A Task's ordinary response does not
become a shared artifact automatically.

## Visible task lifecycle

The originating thread is also the shared place where people observe the work:

1. SuperTag accepts and stores the Task, then acknowledges it;
2. the execution system reports one quiet running update, including the selected workspace when available;
3. completion returns the useful outcome in the original conversation;
4. a final failure returns a concise error in the same thread.

SuperTag stores outgoing updates separately from the Worker run, so a long-running Task does not
block delivery. On tools that support message updates, SuperTag can replace the acknowledgement
with the result instead of adding another reply. Routine retries, tool events, and internal IDs stay
in the audit history instead of filling the conversation.

## Safety properties

- A Session reads only Sessions of its own Tag, and never a private Session of another person.
- Artifact sharing moves only in the configured direction, and names every source and
  destination explicitly.
- Artifacts selected by a Context Set must belong to the same Tag.
- Selection uses exact resource identity plus age and count limits.
- Shared knowledge, including another Session's history, does not grant permission to act on its
  source.
- Failed executions do not advance automatic same-Session continuity.

For retrieval limits and Runtime Input resolution details, see the [context resolution reference](../reference/context-resolution.md).
For the underlying lifecycle vocabulary, see [Tasks and Sessions](tasks.md).
