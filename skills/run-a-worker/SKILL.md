---
name: run-a-worker
description: Connect a machine as a Worker Host so Tags run on Codex, Claude Code, Cursor, OpenCode, or OpenAI Agents. Read when Tags need real execution capacity or another machine.
---

# Run a Worker Host

A Worker Host connects outbound to the Control Plane, claims Tasks of the Tags it may run, and
runs each Task Attempt through a harness adapter in a pinned checkout of the Tag's Workspace.
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
      codex: [gpt-5.5]
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
a path or `{ path, delivery: branch|patch, setup: COMMAND }`; `concurrency` 1 to 16 per harness;
`attempt-timeout-seconds`; `skills`; `allow-unsandboxed-commands` for `cursor` or `opencode`;
`restart: unless-stopped`.

## Join a shared Control Plane

An operator creates a host Auth Key:

```sh
supertag auth-key create laptop-2 --role host --tag lead --control-plane team
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
supertag worker-host --control-plane https://supertag.example.com \
  --state-directory /var/lib/supertag-host --harness codex --label linux \
  --workspace-id app --workspace-source /srv/app
```

## Choose a harness

| Harness | Needs | Sign-in |
| --- | --- | --- |
| `codex` | `codex` on `PATH` | `CODEX_API_KEY`, `OPENAI_API_KEY`, or file-backed `codex login` |
| `claude-code` | `claude` on `PATH`, Node.js | `ANTHROPIC_API_KEY` or the user's `claude` sign-in |
| `cursor` | Node.js | `CURSOR_API_KEY` |
| `opencode` | `opencode` on `PATH`, Node.js, a `provider/model` model | The provider's API key |
| `openai-agents` | Python with the `supertag` package | `OPENAI_API_KEY` |

```sh
supertag sign-in codex
```

Put provider keys in `~/.supertag/.env`, not the shell profile: a service unit does not inherit
the shell. Never handle the user's keys yourself.

## Place Tags on the right hosts

```sh
supertag placement runs-on builder gpu --control-plane team
supertag placement explain TASK_ID --control-plane team
```

A host carries labels from `--label` or its Auth Key's `--label`. A Tag with `runsOn` labels runs
only on hosts that carry all of them.

## Verify

```sh
supertag get host --state-directory ~/.supertag
supertag task submit --tag lead --session host-check "Reply with hello." --state-directory ~/.supertag
supertag describe task TASK_ID --state-directory ~/.supertag
```

The host shows connected and ready with its harnesses. The Task completes with a reply. This uses
the configured model and may incur charges.

## Operate

```sh
supertag host drain build-1 --control-plane team    # finish running work, claim nothing new
supertag host resume build-1 --control-plane team
supertag host revoke build-1 --control-plane team   # refuse its credential at once
```

`supertag down` drains this machine's hosts before stopping them.
