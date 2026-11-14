---
name: troubleshoot
description: Diagnose a mention that produced no reply, or a Task that is stuck, pending, or failing. Read when SuperTag is configured but not behaving.
---

# Troubleshoot

Work down this list in order. Each step isolates one layer, so do not skip ahead; most reported
failures are resolved in the first three.

The human-facing version is the
[first-reply troubleshooting checklist](../../docs/guides/troubleshooting.md); point users there.
Every operator command names its Control Plane: `--state-directory ~/.supertag` for local
services, or `--control-plane NAME`. The examples use the local form.

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

- `pass --control-plane URL, --control-plane NAME of a saved Control Plane, or --state-directory`:
  the command needs a target. Add `--state-directory ~/.supertag` or `--control-plane NAME`.
- A protocol negotiation error: the CLI and the Control Plane share no protocol version. Upgrade
  them together.

## 2. Is the collaboration surface enrolled and reachable?

```sh
supertag get surface-account --state-directory ~/.supertag
supertag logs gateway
```

No account means setup never completed, or completed against another state directory or Control
Plane. Then confirm events reach the Gateway:

- **Lark**: the Gateway log shows the long connection.
- **Webhooks (Slack, GitHub, Linear, Teams)**: the public HTTPS URL must forward to the Gateway's
  loopback listener and path. The provider's delivery log should show a 2xx. A signature or
  timestamp failure is refused before admission.

Also confirm the app or bot was **invited to the channel**. Enrollment alone is not membership.

## 3. Does the Tag have an enabled location at that exact scope?

```sh
supertag get surface-location --state-directory ~/.supertag
supertag describe tag lead --state-directory ~/.supertag
```

The location must name the Tag, the exact channel, repository, chat, or team ID, and be enabled.
`--allowed-user` restricts who may invoke it. Add one with `supertag tag update TAG
--add-location PROVIDER ...`.

## 4. Was a Task admitted?

Mention the Tag again while watching:

```sh
supertag watch task --state-directory ~/.supertag
supertag describe task TASK_ID --state-directory ~/.supertag
```

No Task means steps 2 and 3 failed. A refused Task's description names the missing permission
or setting.

## 5. Can a Worker Host run it?

```sh
supertag placement explain TASK_ID --state-directory ~/.supertag
supertag get host --state-directory ~/.supertag
supertag metrics --state-directory ~/.supertag
```

`placement explain` names why a queued Task waits: no host may run the Tag, the eligible hosts
lack the Tag's `runsOn` labels, none serves the harness or model, or they are busy or draining.
Fix the binding (an Auth Key's `--tag`), the labels (`supertag placement runs-on`), or the host's
harnesses and models.

A host that stops with a sign-in error needs `supertag sign-in HARNESS` as the host's user.
Cursor and OpenCode Tasks that may run commands need `allow-unsandboxed-commands` on the host.

## 6. Did it run but fail?

```sh
supertag task events TASK_ID --state-directory ~/.supertag
supertag get reply --state-directory ~/.supertag
supertag logs HOST_NAME
```

`task events` shows the run's progress and result. `get reply` shows whether the reply reached
the surface; a `failed` or `uncertain` reply can be resolved with `supertag reply resolve`.

## Uncertain Task Attempts

A host killed mid-run may leave a Task Attempt uncertain. It appears in the inbox as
`task-attention` and in `supertag metrics` under recovery. After checking what it did:

```sh
supertag task resolve-attempt TASK_ID ATTEMPT_ID --decision failed \
  --evidence "WHAT_YOU_CHECKED" --confirmed-stopped --state-directory ~/.supertag
```

`--decision retry` runs it again.

## Cancelling

```sh
supertag task cancel TASK_ID --state-directory ~/.supertag
supertag objective cancel OBJECTIVE_ID --reason TEXT --state-directory ~/.supertag
```

## State and isolation gotchas

- Local state lives in `~/.supertag` or `SUPERTAG_STATE_DIR`. Two state directories are two
  separate organizations.
- A service unit does not inherit your shell. Put provider keys in `~/.supertag/.env`.
- A state directory from the earlier TypeScript runtime cannot be used; move it aside and run
  `supertag init`.

## Escalating

Collect `supertag version`, `supertag ps`, `supertag describe task TASK_ID`, and the relevant
`supertag logs` output. Remove secrets before sharing.
