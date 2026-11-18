---
name: install-and-first-reply
description: Install SuperTag, give a team of Tags its first Objective in a local repository, find the result, then add a chat channel. Read this before any other SuperTag setup task.
---

# Install SuperTag and run a first Objective

Goal: one Tag that takes an Objective in a real git repository and delivers the result as a
branch, followed by the same Tag answering in one chat channel. Do not configure more than one
collaboration surface on the first run.

Use Codex or Claude Code for the first run. Check [Requirements](../../docs/operations/requirements.md)
for system tools, then sign in before `supertag init`: run
`codex -c 'cli_auth_credentials_store="file"' login` for Codex, or run `claude` and follow its
prompt for Claude Code. Cursor and OpenCode also work; their setup is under
[Other harnesses](#other-harnesses) below.

## 1. Install

Releases cover Linux on arm64 or amd64 and macOS on Apple silicon; on an Intel Mac, build the CLI
as [the installation guide](../../docs/operations/install.md#build-only-the-cli) shows. Otherwise:

```sh
curl -fsSL https://github.com/atemaguer/supertag/releases/latest/download/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
supertag --version
```

## 2. Set up the repository

```sh
cd ~/code/app
supertag init
```

`init` finds `claude` and `codex` on `PATH` (and `opencode`, or Cursor through `CURSOR_API_KEY`),
and stops without changing anything when none is available. It checks each harness's sign-in with
the credentials the Worker Host will have and labels it `signed in` or not, with sign-in
instructions. Asked in a terminal, OpenCode prints `sign-in not checked (choose a model)` until you choose a model.
Claude Code also needs Node.js 22.13.0 or later on `PATH`; without it, `init` says
so and doesn't offer Claude Code.
It then asks for the Control Plane port, the harness (and a `provider/model` for OpenCode), the
Workspace name, and the Tag's name, with defaults in brackets. Codex sandboxes its own commands.
For Claude Code, `init` asks how the lead may run commands and defaults to not at all: the lead
then reads and edits files and replies, but runs no commands. Keep that default for the first
run; [Let the lead run commands](../../docs/operations/cli.md#let-the-lead-run-commands) turns them
on later. `--yes` accepts every default and needs no terminal. It writes `~/.supertag/supertag.yaml` and starts, in the background:

- a `control-plane` service, which creates the Permission Set `local-tools` (`files:read` and
  `files:write`, and for Codex also `commands:execute` and `web:fetch`), the Role `Lead`, and the Tag `lead`, bound to this repository's Workspace and
  following the branch checked out when `init` ran;
- a Gateway; and
- a `host` service named after the machine, which maps this repository as the Workspace,
  named after the repository by default, and runs up to three Task Attempts at once
  (`concurrency: 3`).

Nothing is written to the repository; state lives in `~/.supertag/`. Running `init` again in
another repository offers to add it, with a Tag named after it that works there. Each new Session of `lead`
starts from the current commit of the branch `init` found (`workspace.ref`). When HEAD is
detached, `init` pins the checked-out commit (`workspace.baseCommit`) instead and says so in its
output. To follow another branch or pin a commit, apply a Tag manifest; see [Workspaces](../../docs/guides/workspaces.md#2-bind-a-tag-to-the-workspace).

Operator commands use these local services without a flag; `--gateway NAME` targets
another Control Plane.

If `lead` runs on Codex, `local-tools` also grants `web:fetch`, and `init` says so. Current Codex
models run commands only in Codex code mode, which SuperTag starts only for a Task that also has
`web:fetch`. `web:fetch` also opens the network to its commands; to keep them offline, remove it
from `supertag.yaml` and select a Codex model that is not code-mode-only. See
[Codex commands and models](../../docs/operations/requirements.md#codex-commands-and-models).

## 3. Create the first Objective

Choose an ID and state the outcome with evidence:

```sh
supertag objective create readme-setup \
  "The README explains local setup. Done when a new contributor can follow it." \
  --owner lead
```

It prints the Objective as JSON and queues `lead`'s first turn. The Tag plans, does the work
itself or starts work Sessions for it, and reviews what each reports.

## 4. Follow it and find the result

```sh
supertag watch objective readme-setup
supertag describe objective readme-setup
```

`watch objective` follows the Objective as a timeline until it closes. `describe` shows status,
owner, **Delivered**, **Needs you**, and each Session. When a Task changes the repository, the
Worker Host writes its commits into your repository as the branch `supertag/session/HASH`. It
never switches your checked-out branch or touches your working tree:

```sh
git branch --list 'supertag/session/*'
git diff main...supertag/session/HASH
```

## 5. Answer, push back, or approve

Plain `supertag` opens the terminal UI. Answer questions under **Waiting on you**; to redirect
work, select the Objective, press `m`, type the follow-up, and press Enter. For scripted answers,
follow [Operate SuperTag](../operate-supertag/SKILL.md#read-pending-questions-before-messaging).

```sh
supertag objective review readme-setup approve
supertag approval approve APPROVAL_ID
```

`supertag ps` lists the services, `supertag logs -f` follows them, `supertag down` stops them,
and `supertag up` starts them again. `restart: unless-stopped` on the services in
`~/.supertag/supertag.yaml` keeps them running after restarts.

## 6. Next: add a chat channel

Lark or Feishu and Slack need no public URL on a laptop: the Gateway connects outbound, to Slack
over Socket Mode. GitHub, Linear, and Microsoft Teams send webhooks, which need a public HTTPS URL
forwarded to the Gateway's loopback listener, such as a tunnel. For Slack:

1. Create the app from [`docs/surfaces/slack-app-manifest.yaml`](../../docs/surfaces/slack-app-manifest.yaml)
   following [`docs/surfaces/slack.md`](../../docs/surfaces/slack.md). You need its bot token
   (`xoxb-…`) and an app-level token (`xapp-…`) with `connections:write`.
2. Enroll it. Setup prompts with masked input or reads `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`;
   never pass secrets as flags.

   ```sh
   supertag setup surface slack
   ```

3. Invite the app to the channel and add the channel's stable ID, not its name, to the Tag:

   ```sh
   supertag tag update lead --add-location slack --channel-id C0123456789
   ```

4. Mention `@SuperTag` in the channel. `lead` replies in the thread; later replies in the thread
   continue the Session without another mention.

A location grants only the mention lifecycle: receive an invocation, read the originating thread,
reply there. Add tools and knowledge with [configure-tags](../configure-tags/SKILL.md). Other
surfaces are in [connect-a-surface](../connect-a-surface/SKILL.md).

## Connectivity check after init

```sh
supertag status
supertag get host
supertag describe tag lead
supertag get surface-location
```

`status` lists Worker Hosts, Tags, unfinished Objectives, and the inbox; the local host should
be connected. In the configured channel, send `@SuperTag Reply with hello.` A threaded reply checks
delivery, routing, execution, and the return path together. It uses the configured model and may
incur charges.

If the reply does not arrive:

```sh
supertag watch task
supertag describe task TASK_ID
supertag get reply
supertag logs gateway
```

Mention the Tag again while `watch task` runs to see the new Task's ID. `describe task` explains
a waiting Task, and `get reply` shows whether the reply was delivered. If no Task appears, check the location, the app
invitation, and the Gateway log. See [troubleshoot](../troubleshoot/SKILL.md). For an always-on
team deployment, continue to [deploy-supertag](../deploy-supertag/SKILL.md).

## Verify the setup

| After step | Verify with |
| --- | --- |
| 1 | `supertag --version` prints a version |
| 2 | `supertag ps` shows `control-plane`, `gateway`, and the host running |
| 3 | `supertag describe objective readme-setup` shows the owner's turn queued or running |
| 4 | `describe objective` lists a delivery, and `git branch` shows `supertag/session/...` |
| 6 | `supertag get surface-location` lists the channel, and a threaded reply appears |

## Other harnesses

For Cursor, the user generates an API key at https://cursor.com/dashboard/api and adds
`CURSOR_API_KEY=...` to `~/.supertag/.env` themselves; `init` detects Cursor only when
`CURSOR_API_KEY` is also set in the environment it runs in. Never ask for a key in chat or write
it for them. For OpenCode, set the provider's API-key variable in `~/.supertag/.env`; `init` then
asks for a `provider/model`. See [Requirements](../../docs/operations/requirements.md#choose-and-sign-in-to-a-harness).
