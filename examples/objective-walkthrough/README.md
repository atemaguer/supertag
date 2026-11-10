# Objective walkthroughs

This example follows one **Objective**, an outcome a lead Tag owns, from start to finish. A
**Tag** is a persistent AI actor with its own responsibilities and permissions. A **Session**
is one Tag's thread of work, and a **Task** is one turn of it; a **Task Attempt** is one try at
running that Task. A **Team** is the list of Tags that may hand each other work. The
**Control Plane** stores all of this and schedules the work.

## Live walkthrough with two Teams

The delivery Team's lead owns an Objective to change a small shell command. The command's
two-line output is the contract shared with a separate review Team. The builder can edit the
repository. The reviewer can inspect Git and run read-only checks. The lead delegates both
the inventory and the implementation, then asks the reviewer to inspect the exact delivered
commit.

Install SuperTag and a full, signed-in Codex CLI that can use `gpt-6.1-sol`. Run from this
checkout on macOS or Linux with Node.js 22.13 or later and Git.

```sh
node examples/objective-walkthrough/live-walkthrough.mjs
```

The script starts a loopback Control Plane and two Worklets, the processes that connect each
Worker Host to it. Both hosts use a new, disposable Git repository and state directory. It
runs real Codex Tasks at medium effort, with a one-day Objective deadline and no USD ceiling.
Review the statement and limits at the prompt before typing `start`.

At the checkpoint, the script stops the builder's Worklet. Type `continue` to answer the lead's
question. The script checks that a new Task queues in the existing implementation Session
while the Worklet is down, then restarts it and checks that Task Attempt starts. This is a
controlled outage between Tasks in the same Session.

The review Tag sends its verdict back through the lead's Mailbox, where Tags send each other
messages. The script checks the verdict against the exact commit, checks the change and its
output in Git, and relays the evidence into the Objective. Read the diff and type `accept`
to complete the Objective. The repository's main branch stays at its original commit.

Compare the `LIVE` lines on stdout to [the expected transcript](expected-live-transcript.txt).
Prompts and the diff appear on stderr. The script stops its services on exit and prints the
disposable directory for inspection if a check fails. Set `SUPERTAG_WALKTHROUGH_CLI` to an
absolute path to try a specific SuperTag build.

## Scripted walkthrough with one Team

The scripted walkthrough runs entirely on a disposable local fixture. It shows:

- the lead splitting the Objective's outcome into two work Sessions for two builders;
- an injected interruption: the scripted Worker throws an injected error during one builder's
  first Task Attempt, which fails; the lead resumes that same work Session, which then completes;
- a question the lead asks a person, surfaced in the coordination inbox and answered;
- an approval the lead needs before a merge, surfaced, approved, and the retried merge granted.

Every event the script prints starts with `FIXTURE`.

## What the fixture is

The script uses the repository's test helpers (`tests/support/objective-session.ts`): a real
Control Plane and coordination endpoint, a scripted Worker in place of a model, a temporary
SQLite state directory, and a simulated GitHub account with no credential. Tags (`lead`,
`builder-a`, `builder-b`), the repository `fixture/app`, and pull request `#42` are made up.
It never contacts a live Control Plane, a Worker Host, or their state files, and refuses to run
when `SUPERTAG_URL`, `SUPERTAG_CONTROL_PLANE_URL`, or `SUPERTAG_TOKEN` is set. The temporary
state is deleted when the script ends.

## Run it

From a SuperTag checkout after `pnpm install`:

```sh
pnpm exec tsx --conditions=development examples/objective-walkthrough/walkthrough.ts
```

The output should match [`expected-transcript.txt`](expected-transcript.txt).
`tests/objective-walkthrough.test.ts` runs the script and compares its output to that file, with
ids and timestamps normalized.

### Limits of the fixture

- The interruption is an error the scripted Worker throws during the first Task Attempt; no
  process is stopped. The Control Plane
  does not retry it on its own; the lead resumes the work Session with `continue_session` on its
  next turn, after an operator message. A killed Worker Host process and a Control Plane restart
  are not shown.
- The question and approval are answered through the Control Plane's operator calls, not
  through a surface such as Slack or the TUI.
- The fixture runs one Team. See [Topology](#topology).

## Live dogfood events

These are real events from SuperTag's own dogfood organization (Objective
`dogfood-objective-walkthrough`, Team `supertag`), not fixture output, in order:

1. The `builder-opus` and `builder-5` Tasks stayed queued: their Codex harness cannot enforce the
   Objective's USD budget. The operator cancelled them and reassigned the work to the Claude Code
   Tags `lead`, `verifier`, and `security-reviewer`.
2. `lead` implemented the inbox fixes (commit `65b806d`, work Session `5d85449e`) and this
   walkthrough (commit `5bfe117`, work Session `5cc49754`).
3. `verifier` verified the walkthrough (work Session `d52e86ac`): two byte-identical runs matching
   `expected-transcript.txt`, the transcript test passed, the guard refused `SUPERTAG_URL`; no high
   or medium findings.
4. `security-reviewer` work Session `b8fea521` (Task `5ae66d76`) reviewed and tested `65b806d` and
   found one medium issue: a stale failed action note stopped the inbox pane from following.
   Its delivery then failed, because it had checked out `65b806d` detached inside its managed
   worktree.
5. The `security-reviewer` retry `d925a823` (Task `35577f57`) failed the same way: its worktree was
   not on its Session branch.
6. The lead asked the operator. The operator kept the live worktrees untouched, found the finding
   in the CLI Task events, confirmed it independently, and chose `verifier` for a read-only review
   of the fix.
7. The fix: commit `e12db40` (lead work Session `273075d6`). Verifier result: `verifier` work Session `4d84e02a`, a read-only review on an extracted copy, found no high, medium or low findings; it showed the new test fails without the fix.

Integration record:

- Walkthrough commit: `5bfe117`, integrated in `80b7f3a`.
- Verifier result (`verifier`, work Session `d52e86ac`, on `5bfe117`): two runs byte-identical
  to `expected-transcript.txt`, transcript test passed, guard refused `SUPERTAG_URL`; no high or
  medium findings.
- Security review result: one medium finding (a stale failed action note suppressed following in
  the inbox pane), fixed in commit `e12db40`.
