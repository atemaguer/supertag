---
name: run-a-worker
description: Connect a machine as a Worker Host so Tags run on Codex, Claude Code, Cursor, OpenCode, or OpenAI Agents. Read when Tags need real execution capacity or another machine.
---

# Run a Worker Host

A Worker Host is the machine; its Worklet, `supertag worklet`, connects outbound to the
Control Plane and claims Tasks of the Tags the host may run. For each Task Attempt the Worklet
starts a Worker, a harness adapter and its harness, in a pinned checkout of the Tag's Workspace.
`supertag init` already connects the machine it runs on. The full guide is
[Run Worker Hosts](../../docs/guides/workers.md).

## Everyday path: a host service in supertag.yaml

```yaml
services:
  control-plane:
    type: control-plane
  studio:
    type: host
    harnesses: [codex, claude-code]
    models:
      codex: [gpt-6-sol]
    workspaces:
      app: ~/code/app
    concurrency: 2
```

```sh
supertag config        # every problem in the file, or the resolved file
supertag up            # starts changed services; waits for running Task Attempts
supertag ps
supertag logs -f studio
```

A host in the same file as its Control Plane joins on its own and may run every Tag. Keys:
`harnesses` (up to five of `codex`, `claude-code`, `cursor`, `opencode`, `openai-agents`), or
`adapter` and `adapter-args` for your own; `models` per harness, default first; `workspaces`, each
a path or `{ path, land: local|patch|{merge: BRANCH, push: REMOTE}, setup: COMMAND }`; `concurrency` 1 to 16 Task Attempts at once across the host's harnesses, and `harness-limits` to cap one harness within it;
`attempt-timeout-seconds`; `skills` (a catalog added to the user's and the repository's Skills,
which every host offers); `labels`; `sandbox-commands` for `claude-code`;
`allow-unsandboxed-commands` for `claude-code`, `cursor`, or `opencode`; `restart: unless-stopped`.
`sandbox-commands: [claude-code]` runs Claude Code's commands in its own operating-system sandbox
(Claude Code 2.1.323 or later; macOS, or Linux with bubblewrap and socat), and `supertag init` sets
it where that sandbox can start. Cursor and OpenCode run commands without a sandbox, so their
Tasks that may run commands (`commands:execute`) run only on a host with `environment: local-vm`
or the harness in `allow-unsandboxed-commands`; so do Claude Code's without `sandbox-commands`. Cursor and Claude Code on a host with an
E2B or Modal Workspace provider run commands in the Task's sandbox instead and need no opt-in.

## Join a shared Control Plane

An operator creates a host Auth Key:

```sh
supertag auth-key create laptop-2 --role host --tag lead --gateway team
```

The user saves it to a private file; never paste it into chat. The host service names the
Control Plane and the secret:

```yaml
services:
  laptop-2:
    type: host
    control-plane: https://supertag.example.com
    auth-key: laptop-2-key
    harnesses: [codex]
    workspaces: { app: ~/code/app }
secrets:
  laptop-2-key: { file: ~/laptop-2.key }
```

The first `supertag up` enrolls the host and stores its own credential; the key file can then be
deleted.

## Without supertag.yaml

For servers, CI, and containers:

```sh
supertag host enroll build-1 --control-plane https://supertag.example.com \
  --state-directory /var/lib/supertag-host --auth-key file:build-1.key
supertag worklet --control-plane https://supertag.example.com \
  --state-directory /var/lib/supertag-host --harness codex --label linux \
  --workspace-id app --workspace-source /srv/app
```

## Choose a harness

| Harness | Needs | Sign-in |
| --- | --- | --- |
| `codex` | `codex` on `PATH` | `CODEX_API_KEY`, `OPENAI_API_KEY`, or a sign-in file from `codex -c 'cli_auth_credentials_store="file"' login` |
| `claude-code` | Node.js; `claude` on `PATH` for `init` and `sign-in` (Tasks use the bundled Claude Code) | `ANTHROPIC_API_KEY` or the user's `claude` sign-in |
| `cursor` | Node.js | `CURSOR_API_KEY` |
| `opencode` | `opencode` on `PATH`, Node.js, a `provider/model` model | The provider's API key |
| `openai-agents` | Python with the `supertag` package | `OPENAI_API_KEY` |

```sh
supertag sign-in codex
```

A Codex Tag that should run commands also needs `web:fetch`: current Codex models run commands
only in Codex code mode, which SuperTag starts only for a Task that has `web:fetch`. See
[Codex commands and models](../../docs/operations/requirements.md#codex-commands-and-models).

Put provider keys in `~/.supertag/.env`, not the shell profile: a service unit does not inherit
the shell. Never handle the user's keys yourself.

## Place Tags on the right hosts

```sh
supertag placement runs-on builder gpu --gateway team
supertag placement explain TASK_ID --gateway team
```

A host carries labels from `--label`, its host service's `labels: [...]` in supertag.yaml, or its
Auth Key's `--label`. A Tag with `runsOn` labels runs only on hosts that carry all of them, and a
Tag bound to a Workspace runs only on hosts that map that Workspace. `supertag up` refuses invalid
or reserved labels before starting any service. `placement explain` names why a queued Task
waits.

## Verify

```sh
supertag get host
supertag task submit --tag lead --session host-check "Reply with hello."
supertag describe task TASK_ID
```

The host shows connected and ready with its harnesses. The Task completes with a reply. This uses
the configured model and may incur charges.

## Operate

```sh
supertag host drain build-1 --gateway team    # finish running work, claim nothing new
supertag host resume build-1 --gateway team
supertag host revoke build-1 --gateway team   # refuse its credential at once
```

`supertag down` drains this machine's hosts before stopping them.
