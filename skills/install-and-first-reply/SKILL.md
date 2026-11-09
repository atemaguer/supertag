---
name: install-and-first-reply
description: Install SuperTag, give a team of Tags its first Objective in a local repository, find the result, then add a chat channel. Read this before any other SuperTag setup task.
---

# Install SuperTag and run a first Objective

Goal: one Tag that takes an Objective in a real git repository and delivers the result as a
branch, followed by the same Tag answering in one chat channel. Do not configure more than one
collaboration surface on the first run.

Check [Requirements](../../docs/operations/requirements.md) for system tools, disk space,
and harness installation and sign-in before starting.
Before `supertag init`, sign in to each harness you will serve: run `codex login` for Codex or
`claude` and follow its prompt for Claude Code. For Cursor, the user generates an API key at
https://cursor.com/dashboard/api and adds `CURSOR_API_KEY=...` to `~/.supertag/.env` themselves; the
Cursor app login does not authenticate the SDK. Never ask for the key in chat or write it for them. For OpenCode, set the provider API-key environment
variable for the host service as [Requirements](../../docs/operations/requirements.md#choose-and-sign-in-to-a-harness)
explains. If port 3434 is busy, enter a different number at init's `Port` prompt.

## 1. Install

```sh
npm install -g supertag-ai
supertag --version
```

Follow [the installation guide](../../docs/operations/install.md)
for PATH setup and removal.

## 2. Set up the repository

```sh
cd ~/code/app
supertag init
```

`init` checks `claude`, `codex`, and `opencode` on PATH and Cursor through its SDK, then stops with install
guidance, changing nothing, when none is. It then asks a few questions with defaults in brackets
(Enter accepts; pass `--yes` to accept all, required without a terminal): Control Plane port and
database, harnesses, the directory to work in, the Workspace name (here `app`), delivery, and the
first Tag's name and access. It writes `~/.supertag/supertag.yaml` with a `control-plane` service and
a `host` service named after the machine, brings up the Control Plane in the background
(`supertag up`), creates the Workspace, Permission Set `local-tools`, Role `Lead`, and Tag `lead`
through the API, then brings up the host service and binds it to `lead`. Nothing is written to
the repository; all state lives in `~/.supertag/` (or `SUPERTAG_STATE_DIR`).
At `Harnesses this machine serves`, `init` labels installed harnesses `signed in` or
`not signed in`. OpenCode says `sign-in not checked (choose a model)` before model selection.
The defaults include only harnesses that pass the sign-in check. After selection, `init` prints
`not signed in (the credential check did not succeed)` for each failed check and its sign-in
instructions. If none pass, setup stops; sign in and rerun `supertag init`.

Every later `supertag` command uses the local Control Plane with this computer's local operator
credential unless another Control Plane is selected; no `connect control-plane` or token setup is
needed. Rerunning `init` in another repository adds it as another Workspace of the same host.

## 3. Create the first Objective

```sh
supertag create objective --owner lead --workspace app \
  --outcome 'The README explains local setup. Done when a new contributor can follow it.'
```

Stdout is a short summary: `objective/ID created`, the first Task of its conversation, and the
next two commands. Warnings (for example, no connected Worker Host) go to stderr with the fix. Add
`--output json` when a script needs the Objective record.

Creating the Objective starts its conversation with `lead`. The Tag plans, does the work itself
or starts a Session for it, and reviews what each Session reports.

## 4. Follow it and find the result

```sh
supertag watch objective ID       # one line per event; exits when the Objective closes
supertag describe objective ID    # status, owner, Delivered, Needs you, Tasks
```

`watch --output json` emits JSON lines. `describe ... --output json` is the full record.

Under **Delivered**, a branch delivery shows the checkout path and the commands to inspect it:

```text
Branch supertag/ID/TASK in Workspace app (/Users/you/code/app), 3 changed files
  Review:   git diff main...supertag/ID/TASK
  Check out: git switch supertag/ID/TASK
```

A patch delivery shows its `supertag download artifact ...` command; a pull-request delivery
shows the URL and state.

## 5. Answer, push back, or approve

In the terminal UI, answer questions under **Waiting on you**. To redirect work, select the
Objective, press `m`, type the follow-up, and press Enter. For automated replies, follow
[Operate SuperTag](../operate-supertag/SKILL.md#read-pending-questions-before-messaging).

```sh
supertag approve objective ID      # only when the Objective is ready_for_review
supertag approve request REQUEST_ID
```

`supertag ps` lists both services, `supertag logs -f` follows them, `supertag down` stops both, and
`supertag up` starts both again. `restart: unless-stopped` on both services in
`~/.supertag/supertag.yaml` keeps them running after restarts.

## 6. Next: add a chat channel

Slack Socket Mode is the shortest path because it needs no public Gateway URL.

1. Create the Slack app from [`docs/surfaces/slack-app-manifest.yaml`](../../docs/surfaces/slack-app-manifest.yaml)
   following [`docs/surfaces/slack.md`](../../docs/surfaces/slack.md). You need a bot token
   (`xoxb-…`) and an app-level token (`xapp-…`) with `connections:write`.
2. Enroll it. Setup prompts with masked input or reads `SLACK_BOT_TOKEN`
   and `SLACK_APP_TOKEN`; never pass tokens as flags.

   ```sh
   supertag setup surface slack
   ```

3. Invite the app to the channel and add the channel's stable ID (not its name) to the Tag in
   a manifest, such as `tag.yaml`. `workspaces` names the Workspaces that
   `@SuperTag objective ...` from that channel works in:

   ```yaml
   apiVersion: supertag/v1
   kind: Tag
   metadata:
     name: lead
   spec:
     roles: [Lead]
     locations:
       - provider: slack
         channelId: C0123456789
         workspaces: [app]
   ```

4. Apply it with `supertag apply -f tag.yaml`, then mention `@SuperTag` in the channel. `lead` replies in the
   thread; later replies in the thread continue the Session without another mention.

A location grants only the mention lifecycle: receive an invocation, read the originating thread,
reply there. Add channel history, repository access, or tools with
[configure-tags](../configure-tags/SKILL.md). Other surfaces are in
[connect-a-surface](../connect-a-surface/SKILL.md).

## Connectivity check after init

Keep the Control Plane and local Worker Host that `init` started running. This diagnostic
uses the Tag's real Worker and requires its harness to be signed in.

```sh
supertag status control-plane
supertag list worker-host
supertag describe tag lead
supertag list surface
```

Use your Tag's name if you chose something other than `lead`. The Control Plane should report
`accepting`. In the Tag description, check **Bound Worker Hosts** and follow its
`supertag describe worker-host HOST` command to inspect the local host's availability.
The Slack account should appear in the surface list, and the Tag's **Locations** should include
your channel. `init` binds the Tag to this computer's Worker Host; another host cannot run its
Tasks unless it is also bound.

In the configured Slack channel, send `@SuperTag Reply with hello.` A threaded reply checks
message delivery, Tag routing, Worker execution, and the return path together. This uses the
configured model and may incur usage charges.

If the reply does not arrive, inspect the Task and service logs:

```sh
supertag list task
supertag describe task ID
supertag logs
```

Replace `ID` with the Task for your mention. Its description explains execution status or why
it is waiting. If no Task appears, check the channel location and Slack app invitation from
step 6, then inspect the logs for connection errors.

For more diagnostics, see [troubleshoot](../troubleshoot/SKILL.md). For an always-on team
deployment, continue to [deploy-supertag](../deploy-supertag/SKILL.md).

## Verify the setup

| After step | Verify with |
| --- | --- |
| 1 | `supertag --version` prints a version |
| 2 | `supertag status control-plane` reports `accepting`; `supertag list worker-host` shows this computer |
| 3 | `supertag describe objective ID` shows `Runnable: yes` |
| 4 | `describe objective` lists a branch under **Delivered** |
| 6 | `supertag list surface` lists the Slack account, and a threaded reply appears |
