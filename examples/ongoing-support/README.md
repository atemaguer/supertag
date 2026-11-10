# An ongoing support organization

This example maintains response policies as support incidents arrive. A **Tag** is a persistent AI
actor with its own responsibilities and permissions. Its **Role** describes its responsibility,
and a **Session** is one conversation it holds; a **Task** is one turn of a Session. A manager Tag
reviews proposals from an analyst Tag and applies them to a small external policy service.
Duplicate incident reports reuse the same work Session and provider operation.

The manager runs through Claude Code; the analyst runs through Codex. Each has a separate
**Worker Host** registration and a **Worklet**, which supervises execution. The initial layout
uses two processes on your computer, your existing CLI subscriptions, and local tool execution.
The **Control Plane** stores organizational state. A **Team** is a flat list of Tags that may give
each other work, and an **Objective** records the outcome they maintain. The Objective is the
manager's own conversation: incident observations arrive in it as operator messages, and the
manager gives each proposal to the analyst with `start_session`, naming the analyst Tag. That work
Session reports back as a later turn of the same conversation. Each proposal becomes an
**artifact**, an immutable capture of its output. The policy service records each applied change in
a durable receipt that can be inspected later.

```mermaid
sequenceDiagram
    participant User as Observer
    participant CP as Control Plane
    participant Manager as Claude manager / Host A
    participant Analyst as Codex analyst / Host B
    participant Policy as External policy service
    User->>CP: Message the Objective with incident observations
    CP->>Manager: Deliver the message as the next turn
    Manager->>CP: start_session for up to two proposals, then end the turn
    CP->>Analyst: Run the proposal work Session
    Analyst->>CP: Capture policy.json and reply
    CP->>Manager: Deliver the report as the next turn
    Manager->>CP: Read the exact artifact and review it
    Manager->>Policy: Inspect operation; apply at expected revision
    Policy--xManager: Commit receipt but lose response
    Manager->>Policy: Inspect the same operation ID
    Policy-->>Manager: Return durable receipt
    Manager->>CP: Record the receipt in its reply
```

## Run it

Install Node.js 20.18.1 or newer, sign in to Claude Code and Codex through their CLIs, and install
this example's dependencies. It requires a SuperTag build containing the current coordination
and resource APIs; see the contributor guide for testing an unreleased checkout.

```sh
npm install
npm run demo
```

The demo starts the Control Plane, policy service, and both Workers. After the manager's first turn
ends, it kills and restarts the Control Plane process, then sends five observations for three
incidents. The policy service deliberately drops its first successful write response. The verifier
checks the reported work Sessions, captured artifact bytes, provider receipts, and that the manager
ended its turn with nothing left to do.
The demo stops its processes and preserves private state and `verification.json` afterward.

State defaults to `~/.supertag/examples/ongoing-support`. Use a fresh directory for another demo:

```sh
export SUPPORT_STATE="$HOME/.supertag/examples/support-run-2"
npm run demo
```

For a persistent, interactive run, keep this command running in one terminal:

```sh
npm run start
```

In a second terminal with the same `SUPPORT_STATE`:

```sh
npm run observe -- ticket-42 report-1
npm run observe -- ticket-43 report-2
npm run status
npm run verify
```

Reuse the delivery ID when retrying an observation. A different delivery ID about the same incident
still reuses that incident's work Session. `verify` requires all observed incidents to have been applied;
`status` is useful while work is still pending. For a clean pause, wait until status shows the manager waiting, then stop the foreground process
with Ctrl-C. Start it again with the same state directory to reconnect Workers and resume that wait.
Stopping during active execution can leave interrupted work requiring inspection; shutdown does
not guarantee automatic replay of external actions. A leftover
`run.lock` after a supervisor crash must only be removed after confirming its processes have stopped.
Do not run multiple supervisors against the same directory.

`status` includes the existing Objective overview (its conversation, Sessions, execution, and
reported usage), provider receipts, and reviewed proposals still awaiting recorded application. A missing usage report
means unknown usage, not free execution. The verifier handles up to 99 observations; the manager
starts at most two proposal Sessions at a time. Extend the verifier and per-incident retention before using this
as a high-volume application.

## Adapt the behavior

Edit `roles/manager.md` and `roles/analyst.md` before creating a new organization.
`resources.mjs` creates the Roles, allowed runtime actions, Tags, host bindings, the Team, the
Mailbox grants, and the Objective through the public API. These are ordinary application choices, not special built-in
SuperTag roles. The example keeps one proposal per incident; conflicting external policy changes
require reassessment by an operator rather than automatic revision changes.

Native Attempts have a three-minute deadline; Claude also has a 32-turn bound. Set
`SUPPORT_CLAUDE_MODEL` or `SUPPORT_CODEX_MODEL` to select available models. The two-proposal limit is
Role policy in native mode, enforced by application code in reference mode; the Team's
`maxConcurrency` is separately enforced by SuperTag. Allocation units are not a provider spending limit. Subscription
quotas still apply. The demo stops waiting after ten minutes of backlog processing.

## What the external service guarantees

This sample service commits a policy and its operation receipt together. Repeating the same
operation ID and payload returns the receipt; using that ID for different content is rejected.
A stale expected revision is rejected. If the write response is lost, inspect the operation before
sending another write. A lookup error leaves the outcome unknown. On a storage failure, the service
stops serving state until restart rather than reporting uncommitted in-memory data as durable.

The service accepts a manager credential and gives the analyst only a read credential. Native
policy tools are exposed only to the manager. Calls must name the `support` collection so the
SuperTag MCP adapter can check the resource. The provider enforces writer authority and versions;
review-before-application remains application policy, not an independently enforced approval gate.
The verifier checks the applied bytes against the accepted Task after the run.

This is a trusted local demonstration, not process isolation between mutually untrusted users:
the processes share your OS user, and native workspace tools run locally. Credentials stay in
private files, process configuration, and MCP runtime bindings, never command arguments. Model
API-key variables are removed from Worker environments to preserve native subscription auth.
For separate machines, deploy reachable authenticated TLS endpoints and transfer only each host's
configuration through your secret-management system. Loopback HTTP is only for this local example.

These receipt guarantees belong to this sample provider. An arbitrary CRM or ticket service needs
its own version, idempotency, and reconciliation contract. The example does not make all external
writes exactly-once. See [reliable external actions](../../docs/reference/action-effects.md).
