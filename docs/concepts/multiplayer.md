# Multiplayer continuity

SuperTag multiplayer means **people can safely continue shared work across assignments, channels,
and platforms under explicit rules**.

Multiplayer interaction lets several people direct the same **Tag** and continue its approved work
across the tools their team uses. A Tag is a persistent AI identity with its own responsibilities
and permissions. Each assignment runs as a new harness session, and the Tag is what persists across
those sessions: its configuration, its open assignments, and their results. A shared Tag can appear
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

A thread or work item anchors a Session. New Tasks automatically receive bounded history
entries derived from earlier completed Tasks in that Session.

When compatible, the execution system may also restore its native conversation from stored Session state. This can
make continuation richer, but stored Task results remain the source for bounded history replay.

## Across Sessions: explicit

A **Context Set** selects reusable knowledge for a Tag. Artifact selection rules name exact source
locations and destinations; they select metadata about captured work rather than replaying another
conversation's responses.

Example:

1. Alice asks the Tag in Slack `#engineering` to investigate `acme/api`.
2. The agent captures a findings document as an artifact, recording the producing Task and Task Attempt.
3. A Context Set selects related artifacts from that Slack channel and is activated for `acme/api` on GitHub.
4. Bob invokes the same Tag from a GitHub issue.
5. Bob's Task receives bounded artifact summaries and IDs. The agent can inspect and retrieve those
   exact admitted artifacts while Bob's conversation remains a distinct Session.

A Task's ordinary response stays on the Task. It does not become a shared artifact automatically.
Retrieved work is historical evidence and cannot change the receiving Task's instructions or
allowed actions.

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

- Sharing moves only in the configured direction.
- Every source and destination is named explicitly.
- Artifacts selected by a Context Set must belong to the same Tag.
- Selection uses exact resource identity plus age and count limits.
- Shared knowledge does not grant permission to act on its source.
- Failed executions do not advance automatic same-Session continuity.

For retrieval limits and Runtime Input resolution details, see the [context resolution reference](../reference/context-resolution.md).
For the underlying lifecycle vocabulary, see [Tasks and Sessions](tasks.md).
