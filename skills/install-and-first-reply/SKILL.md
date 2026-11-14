---
name: install-and-first-reply
description: Install SuperTag, give a team of Tags its first Objective in a local repository, find the result, then add a chat channel. Read this before any other SuperTag setup task.
---

# Install SuperTag and run a first Objective

Goal: one Tag that takes an Objective in a real git repository and delivers the result as a
branch, followed by the same Tag answering in one chat channel. Do not configure more than one
collaboration surface on the first run.

Check [Requirements](../../docs/operations/requirements.md) for system tools and harness sign-in
before starting. Before `supertag init`, sign in to each harness you will serve: run
`codex -c 'cli_auth_credentials_store="file"' login` for Codex, or run `claude` and follow its
prompt for Claude Code. For Cursor, the user generates an API key at
https://cursor.com/dashboard/api and adds `CURSOR_API_KEY=...` to `~/.supertag/.env` themselves.
Never ask for a key in chat or write it for them. For OpenCode, set the provider's API-key
variable in `~/.supertag/.env`.

## 1. Install

If the machine ran the earlier TypeScript runtime, retire it before installing: stop its services
with its own CLI, archive and move aside its `~/.supertag`, as
[Retire the earlier TypeScript runtime](../../docs/operations/install.md#retire-the-earlier-typescript-runtime)
explains. The new installer replaces its `supertag` link, and there is no importer.

Follow [the installation guide](../../docs/operations/install.md). Until release archives are
published, it builds one from a checkout and installs it with
`rust/scripts/install_native_release.py`. Then:

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

`init` finds `claude`, `codex`, and `opencode` on `PATH`, and Cursor through `CURSOR_API_KEY`, and
stops without changing anything when none is available. It checks each harness's sign-in with
the credentials the Worker Host will have and labels it `signed in` or not, with sign-in
instructions. OpenCode prints `sign-in not checked (choose a model)` until you choose a model.
It then asks for the Control Plane port, the harness, and the Tag's name, with defaults in
brackets (`--yes` accepts every default and needs no terminal). It writes
`~/.supertag/supertag.yaml` and starts, in the background:

- a `control-plane` service, which creates the Permission Set `local-tools`, the Role `Lead`, and
  the Tag `lead`, bound to this repository's Workspace at the commit checked out when `init` ran;
- a Gateway; and
- a `host` service named after the machine, which maps this repository as a Workspace named
  after it.

Nothing is written to the repository; state lives in `~/.supertag/`. New Sessions of `lead` start
from the commit `init` recorded. To start them from a newer commit, apply a Tag manifest with a
new `workspace.baseCommit`, or with `workspace.ref: BRANCH` to follow a local branch; see [Workspaces](../../docs/guides/workspaces.md#2-bind-a-tag-to-the-workspace).

Operator commands use these local services without a flag; `--control-plane NAME` targets
another Control Plane.

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
owner, **Delivered**, **Needs you**, and each Session. When a Task changes the repository,
`supertag up` imports its commits as the branch `supertag/session/SESSION` in your checkout:

```sh
git branch --list 'supertag/session/*'
git diff main...supertag/session/SESSION
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
