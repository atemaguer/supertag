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
- An **Objective** is an outcome a Tag owns, with success criteria.
- A **Team** groups Tags under one lead and shared responsibility.
- Every Team has one channel, its **Workstream**, for shared posts, and a **Mailbox** delivers an
  internal message to one Tag. Teams use these resources to coordinate without merging the private
  conversations of their execution systems.
- A **Worker Host** is a machine or sandbox that runs Tasks; a **Worker** is the code there that
  completes a Task.

## Teammates can ask directly

A builder can ask an idle reviewer which test covers a changed interface. An addressed question
or blocker wakes that teammate with a **reply activation**, a budgeted run to answer. A blocker
without an addressee goes to the Team lead. Ask a question instead of guessing; post a blocker
instead of stalling.

Team channel posts and direct messages within the Team follow the same rules. Other types and
unaddressed questions do not trigger reply activations. Running teammates receive eligible items
live when their harness accepts input, or in the unread summary at their next activation.
Several qualifying items arriving within a short window share one activation.

Fixed limits prevent loops. A pair of Tags may wake each other 3 times per Task; further posts
between them only queue, and the lead receives a blocker naming the pair. Each Tag may receive
4 post wakes per hour per Objective. Identical posts from one sender are dropped.

A reply does not assign work or grant authority. Use a Task when work needs a result and
acceptance. The Objective overview shows each Team's open questions and blockers, with
post-triggered activation spend on its own line. See
[Coordinate in a Team channel](../guides/workstreams.md) for delivery details and cost inspection.

## Teammates can spot overlapping edits

Suppose two builders on one Team edit `src/session.ts` in separate Task worktrees. SuperTag warns
them and their lead in the Team channel, so they can coordinate before finishing conflicting work.
The warning is an `evidence` post that names the shared file. Running teammates can receive it
live, and the operator can see it in the Objective views. It does not wake an idle Tag.

Local Worker Hosts check changed files while Tasks run. The warning is sent once for each shared
file and pair of Task Attempts. The check needs a readable local worktree, so it skips remote
environments without one. See [overlap warning rules](../reference/mailbox.md#overlap-warnings).

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

A conversation can also start work Sessions for longer work. Each one has the conversation's
audience and permissions, and its result comes back to the conversation as a report from the Tag.
See [Session](tasks.md#session).

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
