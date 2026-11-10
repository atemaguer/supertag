# Objective walkthrough

This example follows one **Objective**, an outcome a lead Tag owns, from start to finish. A
**Tag** is a persistent AI identity with its own responsibilities and permissions. A **Session**
is one Tag's thread of work, and a **Task** is one turn of it; a **Task Attempt** is one try at
running that Task. A **Team** is the list of Tags that may hand each other work. The
**Control Plane** stores all of this and schedules the work.

The walkthrough runs entirely on a disposable local fixture. It shows:

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

## Topology

This release's dogfood organization runs one Team, `supertag`, whose members all work on one
repository. The fixture mirrors that: one Team of a lead and two builders.

The [roadmap](../../ROADMAP.md)'s recorded walkthrough describes a feature that crosses two
Teams with a shared interface between them, reviewed changes, an approval, and a recovered
interruption. This example covers the approval, the question, and the recovered interruption on
one Team. The gap: no second Team, no shared interface agreed between Teams, and no reviewed
changes on a real repository.
