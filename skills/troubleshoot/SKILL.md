---
name: troubleshoot
description: Diagnose a mention that produced no reply, or a Task that is stuck, pending, or failing. Read when SuperTag is configured but not behaving.
---

# Troubleshoot

Work down this list in order. Each step isolates one layer, so do not skip ahead; most reported
failures are resolved in the first three.

The human-facing version is the
[first-reply troubleshooting checklist](../../docs/guides/troubleshooting.md); point users there.
Operator commands use the local services unless they pass `--gateway NAME`. The examples
use the local services.

## 0. Reproduce precisely

Mentions start work only at an enabled surface location. These are ignored by design:

- a channel, repository, chat, or team with no Tag location;
- a message in an unrelated thread;
- a reply in a thread whose Session was never started by a mention.

Confirm you are mentioning `@SuperTag` in the exact scope you configured.

## 1. Are the services up?

```sh
supertag ps
supertag status
supertag version
```

`ps` should show `control-plane`, `gateway`, and each host `running`. If not, `supertag up`, then
`supertag logs control-plane` or `supertag logs gateway`. For a shared Control Plane,
`supertag verify deployment URL --env-file operator.env` checks health and the operator token.

- `no local Control Plane is running from DIR; start one with supertag up, or pass
  --gateway`: the command looked for local services in `DIR`. Run `supertag up` there, set
  `SUPERTAG_STATE_DIR` to the directory `up` uses, or pass `--gateway NAME`.
- `... speaks SuperTag protocol N, but the Control Plane at URL runs SuperTag X (protocol M)`: the
  client and the Control Plane come from releases with different protocol versions. Upgrade the
  side the message names; upgrade them together. After installing a new CLI, `supertag up`
  restarts this machine's services with it, and `supertag down` stops them whatever their release.
- `the database's schema version N is newer than this SuperTag release ... understands`: an older
  binary started against a database a newer release migrated. Run that release again, or restore
  the backup taken before the upgrade.

## 2. Is the collaboration surface enrolled and reachable?

```sh
supertag get surface-account
supertag logs gateway
```

No account means setup never completed, or completed against another state directory or Control
Plane. Then confirm events reach the Gateway:

- **Lark, and Slack in Socket Mode (the default)**: the Gateway log shows the outbound connection.
- **Webhooks (GitHub, Linear, Teams, and Slack with `--transport http`)**: the public HTTPS URL
  must forward to the Gateway's loopback listener and path. The provider's delivery log should
  show a 2xx. A signature or timestamp failure is refused before admission.

Also confirm the app or bot was **invited to the channel**. Enrollment alone is not membership.

## 3. Does the Tag have an enabled location at that exact scope?

```sh
supertag get surface-location
supertag describe tag lead
```

The location must name the Tag, the exact channel, repository, chat, or team ID, and be enabled.
`--allowed-user` restricts who may invoke it. Add one with `supertag tag update TAG
--add-location PROVIDER ...`.

## 4. Was a Task admitted?

Mention the Tag again while watching:

```sh
supertag watch task
supertag describe task TASK_ID
```

No Task means steps 2 and 3 failed. A refused Task's description names the missing permission
or setting. `supertag task submit` refuses an execution limit, such as `--max-reported-tokens`,
that the Tag's harness cannot enforce, and names the harness.

## 5. Can a Worker Host run it?

```sh
supertag placement explain TASK_ID
supertag get host
supertag metrics
```

`placement explain` names why a queued Task waits: no host may run the Tag, the eligible hosts
lack the Tag's `runsOn` labels or do not map its Workspace, none serves the harness or model, its
harness cannot run the Task's actions or load its Skills, the hosts are busy or draining, or an
uncertain Task Attempt keeps a host's only slot (it names the `supertag task resolve-attempt`
command that frees it). Fix
the binding (an Auth Key's `--tag`), the labels (`supertag placement runs-on`), or the host's
harnesses, models, and `workspaces`.

A host that stops with a sign-in error needs `supertag sign-in HARNESS` as the host's user.
Claude Code, Cursor, and OpenCode Tasks that may run commands wait for a host that runs them:
`sandbox-commands: [claude-code]` (Claude Code's own sandbox, which needs Claude Code 2.1.323 or
later; run `claude update`), `environment: local-vm`, or the harness in
`allow-unsandboxed-commands`. A Codex Task that may run commands but lacks `web:fetch` fails when
its turn starts, naming the model; see
[Codex commands and models](../../docs/operations/requirements.md#codex-commands-and-models).

## 6. Did it run but fail?

```sh
supertag task events TASK_ID
supertag get reply
supertag logs HOST_NAME
```

`task events` shows the run's progress and result. `logs HOST_NAME` shows why a Task failed: the
host logs the failure with the last lines the harness adapter wrote to standard error, redacted.
`get reply` shows whether the reply reached the surface. After checking the provider, resolve an `uncertain` reply with `supertag reply
resolve REPLY_ID --decision failed --evidence TEXT`, or `--decision delivered` with
`--provider-receipt` too; it never resends the reply.

## Uncertain Task Attempts

A host killed mid-run may leave a Task Attempt uncertain. It appears in the inbox as
`task-attention` and in `supertag metrics` under recovery. After checking what it did:

```sh
supertag task resolve-attempt TASK_ID ATTEMPT_ID --decision failed \
  --evidence "WHAT_YOU_CHECKED" --confirmed-stopped
```

`--decision retry` runs it again.

When the restarted host proves every process of the Task Attempt stopped, it reclaims it instead,
and the Control Plane redelivers the Task from a fresh checkout, up to three Task Attempts, unless
the lost run may have repeated an effect. A Task that was not redelivered failed with an unknown
outcome and shows as a `task-attention` item whose reason says why. Read `supertag task events
TASK_ID` before asking the Tag again. Rules: `docs/reference/scheduling-and-recovery.md#redelivery`.

## Cancelling

```sh
supertag task cancel TASK_ID
supertag objective cancel OBJECTIVE_ID --reason TEXT
```

## State and isolation gotchas

- Local state lives in `~/.supertag` or `SUPERTAG_STATE_DIR`. Two state directories are two
  separate organizations.
- A service unit does not inherit your shell. Put provider keys in `~/.supertag/.env`.

## Escalating

Collect `supertag version`, `supertag ps`, `supertag describe task TASK_ID`, and the relevant
`supertag logs` output. Remove secrets before sharing.
