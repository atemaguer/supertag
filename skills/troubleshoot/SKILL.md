---
name: troubleshoot
description: Diagnose a mention that produced no reply, or a Task that is stuck, pending, or failing. Read when SuperTag is configured but not behaving.
---

# Troubleshoot

Work down this list in order. Each step isolates one layer, so do not skip ahead — most reported
failures are resolved in the first three.

The human-facing version is the
[first-reply troubleshooting checklist](../../docs/guides/troubleshooting.md); point users there.
This skill adds the exact commands, expected output, and failure strings for an agent to act on.

## 0. Reproduce precisely

Mentions only start work at an enabled entry in **`Tag.status.locations`**. These are silently ignored by design, not bugs:

- a channel, repository, or team with no Tag added — fails before Task admission
- a message in an unrelated thread with no Session
- a reply in a thread whose Session was never started by a mention

Confirm you are mentioning `@SuperTag` in the exact scope you configured.

## 1. Is the Control Plane up and selected?

```sh
supertag status control-plane     # expect: URL  accepting  API v1
supertag get control-plane --current
supertag list control-plane
```

- `No Control Plane is available. Start one locally or run: supertag connect control-plane URL` — no
  Control Plane is running, or the CLI has none selected. Start one, or `supertag connect control-plane URL`.
- `ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND` — you ran the checkout shortcut outside a checkout. The
  installed command is `supertag`.
- Wrong Control Plane targeted — `supertag use control-plane NAME`, or `--control-plane NAME` for one command.

## 2. Is the collaboration surface enrolled?

```sh
supertag list surface
```

`No connected slack account exists. Run supertag setup surface slack.` means setup never completed, or
completed against a different Control Plane or `SUPERTAG_STATE_DIR`.

Then confirm ingress can actually reach the Control Plane's Gateway:

- **Socket Mode (Slack) / long connection (Lark)** — no inbound ingress needed. Check the
  Control Plane log for a connection, and that the app-level token has `connections:write`.
- **Webhooks (GitHub, Linear, Teams, Slack HTTP)** — the route must be publicly reachable over
  HTTPS. Verify the provider's delivery log shows a 2xx. A signature or timestamp failure is
  rejected before admission.

Also confirm the app or bot was **invited to the channel**. Enrollment alone is not membership.

## 3. Does the Tag have an enabled location at that exact scope?

```sh
supertag list tag                  # AVAILABLE_IN should be non-zero
supertag describe tag NAME         # status.locations, roles, permission sets, contexts
```

Use stable IDs, not display names. A scope holds at most one **enabled** Tag — if you added two,
one is disabled and routing goes to the other.

## 4. Was a Task admitted?

```sh
supertag list task
supertag get task TASK_ID
supertag events task TASK_ID
```

**No Task at all** → the problem is upstream, in steps 1–3. Ingress never reached admission.

**A Task exists but stays pending** → nothing is eligible to run it. Go to step 5.

**A Task failed** → read `supertag events task TASK_ID`. Common terminal causes:

- a required Runtime Input the harness does not support — fails *before* the harness starts, by
  design (fail-closed capability matching)
- a permission the Tag does not hold, or native provider access it lacks. Context, declared
  authority, and provider access must all agree
- the Worklet disconnected or stopped heartbeating, making its Worker Host unreachable and
  failing its active Task Attempt

## 5. Is a compatible Worker connected?

The single most common cause of a permanently pending Task.

```sh
supertag list worker-host
supertag describe worker-host HOST_ID     # Connected / Ready / Draining / Unreachable
supertag list worker-profile
supertag describe tag NAME                # check its bound Worker Hosts
```

The Control Plane schedules a Task only when a **Ready** host advertises the Task's **exact** Worker
Profile, including revision, and has capacity. Otherwise the Task waits without consuming a
Task Attempt — no error is raised.

Check, in order:

1. **The Task's selected profile and revision match a Worker on a bound host.** A Worker
   advertising `local-codex@1` cannot satisfy a Task selecting `local-codex@2`.
2. **Host is Ready, not Draining.** `supertag resume worker-host HOST_ID` if you drained it.
3. **Capacity remains** — compare active Task Attempts against advertised slots.
4. **Transport mode is right.** With `SUPERTAG_WORKLET_TRANSPORT=embedded` the Control Plane uses the
   smoke-test responder and no external Worklet attaches at all.
5. **Worker Host credential is valid.** Confirm the host is enrolled on this Control Plane and
   its stored credential has not been revoked. `connect worklet` uses a stored credential before
   an Auth Key. If that credential was revoked, remove its file before joining a new host with an
   Auth Key as described in [run-a-worker](../run-a-worker/SKILL.md#connect-the-worklet):
   `<state directory>/worker-hosts/HOST_ID.credential.json` for a host joined with
   `connect worklet`, or `<state directory>/hosts/SERVICE/credential.json` for a host service.
   The state directory is `SUPERTAG_STATE_DIR` when set, otherwise `~/.supertag`.
   Remove only the file for the revoked host. Use `wss://` outside loopback.
6. **Unsandboxed harness without opt-in.** An unmet requirement
   `allow-unsandboxed-commands:HOST` means the Task may run commands and the host's only matching
   harness (Claude Code or OpenCode) has no sandbox. Add the harness to
   `allow-unsandboxed-commands` in that host service and run `supertag up`, or route the Tag to a
   Codex Worker.

## 6. Are replies generic instead of real answers?

That is the built-in smoke-test responder, and it means the collaboration surface works. The Control Plane
defaults to `SUPERTAG_WORKLET_TRANSPORT=embedded`. Set it to `remote` and attach a Worklet — see
[run-a-worker](../run-a-worker/SKILL.md).

## 7. Health endpoints

| Symptom | Reading |
| --- | --- |
| `/healthz` fails | The process is down |
| `/readyz` fails, no Worklet connected | **Expected** in remote Worklet mode — not a fault |
| `/readyz` fails, Worklet connected | Profile or capability incompatibility; recheck step 5 |

Do not wire `/readyz` to a restart policy in remote Worklet mode.

## Cancelling

```sh
supertag cancel task TASK_ID
```

Cooperative: the Worker must honor its `AbortSignal` or equivalent. A custom Worker that ignores
it will not stop — see [build-a-custom-worker](../build-a-custom-worker/SKILL.md).

## State and isolation gotchas

Credentials and SQLite live in `~/.supertag` unless `SUPERTAG_STATE_DIR` is set. Setting it in
one shell and not another is a frequent cause of "my collaboration surface disappeared" — the CLI is reading
a different state directory. Same for `SUPERTAG_DATABASE_URL`: management commands must use the
same database as the running Control Plane.

For a local setup from `supertag init`, start with `supertag ps` (service state; for host services,
connected or not, Tags served, running Task Attempts) and `supertag logs -f SERVICE`. When
`supertag up` refuses to start, `supertag config` lists every problem in `supertag.yaml` with
file:line:column. Environment variables override the file. A service unit
(`restart: unless-stopped`) does not inherit the shell environment, so a service that works with
`supertag up --foreground` but not after login needs its variables in `~/.supertag/.env`. `up`
names them in a warning that starts `the service unit for SERVICE does not inherit this shell's
environment`.

## Escalating

Collect before filing an issue: `supertag --version`, `supertag status control-plane`, the output of
`supertag events task TASK_ID`, the transport mode, and the Control Plane log around the failure.
**Redact tokens** — they appear in some environment dumps.
