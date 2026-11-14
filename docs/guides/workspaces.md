# Work in a repository with Workspaces

Let Tags change a repository without touching your checkout. A **Tag** is a persistent AI actor
with its own responsibilities and permissions. A **Workspace** is a named repository its Tasks
work in. Each **Task Attempt**, one execution of a Task, runs in its own checkout pinned to an
exact commit, on a **Worker Host**, the machine that runs the work. Its changes come back as a
branch you review. See the [glossary](../reference/glossary.md) for other terms.

## How it works

```text
Tag lead ── Workspace app (base commit 4f2c…) ── Task ── Worker Host
                                                         │ pinned checkout, harness runs
                                                         │ commits, verifies, bundles
                                                         v
your repository  <──  branch supertag/session/SESSION  <── delivery
```

1. A Worker Host maps the Workspace to a source: a local Git repository, or a GitHub repository
   the Control Plane holds.
2. A Tag is bound to the Workspace, or a message selects one.
3. Each Task Attempt gets a separate checkout at the pinned commit. Later Tasks of the same
   Session continue on the Session's own branch, on top of the earlier ones.
4. After the harness finishes, the host commits the changes, verifies them, and delivers a Git
   bundle and a patch. It never writes your repository.
5. Your machine imports the delivery as the branch `supertag/session/SESSION`, one branch per
   Session.

## Before you start

- SuperTag running from `supertag init`, which maps the repository it ran in as a Workspace of
  this machine's host and binds the `lead` Tag to it at the commit checked out when `init` ran.
- A Git repository with at least one commit.

## 1. Map the repository on a Worker Host

In `~/.supertag/supertag.yaml`, a host service maps Workspace names to repositories:

```yaml
services:
  studio:
    type: host
    harnesses: [codex]
    workspaces:
      app: ~/code/app
      api: { path: ~/code/api, delivery: patch, setup: npm ci }
```

A host without `supertag.yaml` uses `--workspace-id app --workspace-source /srv/app`, repeated for
each Workspace. Several hosts may map the same Workspace name to their own clones.

## 2. Bind a Tag to the Workspace

```sh
supertag tag put builder --instructions "Implement bounded changes with tests." \
  --workspace-id app --workspace-base "$(git -C ~/code/app rev-parse HEAD)" \
  --allow files:write --allow commands:execute --state-directory ~/.supertag
```

Or in a Tag manifest:

```yaml
apiVersion: supertag/v1
kind: Tag
metadata: { name: builder }
spec:
  roles: [Builder]
  workspace: { id: app, baseCommit: 4f2c0d1e9b8a7c6d5e4f3a2b1c0d9e8f7a6b5c4d }
```

A local Workspace needs a full base commit: new Sessions start from it. Move the Tag to a newer
commit by putting the binding again. The Tag's Tasks run only on hosts that map the Workspace.

### Prepare each checkout with setup

`setup` runs a shell command, such as `npm ci`, in each new checkout before the harness starts. It
runs on the host, outside any harness sandbox, with a 10-minute limit, and receives no provider
credentials. A failed setup fails the Task Attempt with the command's output.

## 3. See the branches appear

With `delivery: branch`, the default, `supertag up` imports each delivered Task into the mapped
repository:

```sh
git -C ~/code/app branch --list 'supertag/session/*'
git -C ~/code/app diff main...supertag/session/SESSION
```

Your checkout stays on its own branch; SuperTag never switches it or changes its files. To import
a delivery into another clone, or for a Workspace with `delivery: patch`:

```sh
supertag fetch TASK_ID --repository ~/code/app-review --state-directory ~/.supertag
supertag task download TASK_ID --kind patch --output change.patch --state-directory ~/.supertag
```

`fetch` also takes a Session ID, to import that Session's latest delivery. A Task with no
commits delivers nothing.

## Build on earlier work in the same Session

Every Task of a Session continues the Session's branch. Ask for a revision in the same
conversation, and the next Task starts from the earlier commits, even on another host. Start a
new conversation for independent work; it gets its own branch.

## Use a GitHub repository

A GitHub Workspace keeps its source on the Control Plane, so hosts need no local clone and no
GitHub credentials:

```sh
supertag workspace put api --account github --repository-id 123456789 --repository acme/api \
  --ref main --pull-request-base main --state-directory ~/.supertag
```

`--account` is a Surface Account from `supertag setup surface github`. A moving `--ref` is pinned
once per Session; `--commit` pins one commit for every Session. Worker Hosts serve it with
`--workspace-from-control-plane`. With `--pull-request-base`, verified results are published as a
draft pull request into that branch. `supertag get github-publication` lists publications, and
`supertag github-publication cancel ID --reason TEXT` stops further writes.

## Start from Slack or GitHub

A message from a collaboration surface can select a GitHub Workspace that the Tag's Permission
Sets allow, and later turns of the thread keep it. A mention on a GitHub issue or pull request
selects that repository's Workspace.

## Attach data outside the repository

A **Volume** registers a host directory or an S3 bucket and prefix of data. A Task receives it as
a fresh copy beside its checkout, never as a live mount. Three parties agree on each copy:

1. The operator registers the Volume. An `s3://` source names a credential label, never a secret:

   ```sh
   supertag workspace-volume put datasets --source file:///srv/data/datasets
   supertag workspace-volume put reports --source s3://acme-data/reports --credential team-data
   ```

2. Each Worker Host owner maps the Volume in a file passed to
   `supertag worker-host --workspace-mount-mappings FILE`. For `s3://`, only the host owner picks
   the endpoint, region, and the variables that hold the keys:

   ```json
   [
     { "volumeId": "datasets", "source": "file:///srv/data/datasets",
       "destinationRoot": "/srv/supertag-mounts" },
     { "volumeId": "reports", "source": "s3://acme-data/reports", "credential": "team-data",
       "endpoint": "https://s3.eu-west-2.amazonaws.com", "region": "eu-west-2",
       "credentialEnvPrefix": "REPORTS", "destinationRoot": "/srv/supertag-mounts" }
   ]
   ```

   The host reads `REPORTS_ACCESS_KEY_ID`, `REPORTS_SECRET_ACCESS_KEY`, and optionally
   `REPORTS_SESSION_TOKEN` from its own environment. `destinationRoot` must be an existing,
   owner-only directory.

3. The Tag declares its copies in a file passed to `supertag tag put TAG --workspace-mounts FILE`:

   ```json
   [
     { "volumeId": "datasets", "destination": "/srv/supertag-mounts/datasets" },
     { "volumeId": "reports", "destination": "/srv/supertag-mounts/reports",
       "maxBytes": 5368709120, "access": "read-write" }
   ]
   ```

Each destination sits directly in a mapped `destinationRoot`. `maxBytes` defaults to 1 GiB and may
be at most 20 GiB. Copies require the Tag's `files:read` action, and a `read-write` copy also needs
`files:write`. A Tag with copies may not run commands or fetch from the web. Codex, Claude Code,
Cursor, and OpenCode Tasks take copies. The Control Plane freezes each Volume's revision when it
accepts the Task; `supertag get workspace-volume datasets` shows the source and revision.

The Worker Host makes each copy after the checkout and `setup`, so prepared images and snapshots
never contain the data. The Volume credential never leaves the Worker Host process. A copy is
refused when it passes its `maxBytes`, when one Task Attempt's copies together pass 20 GiB, or when
it holds more than 10,000 files, symbolic links, or files with another hard link. A Cursor Task in
an E2B or Modal Workspace receives only the files, uploaded to `volumes/<digest>/<name>` inside
its checkout; the sandbox image needs `python3`.

After a successful Task Attempt, the Worker Host writes a read-write copy's changed and created
files back to the Volume, never deletions or links. A failed or cancelled Task Attempt writes
nothing. `supertag describe task ID` shows what was written: `complete`, `partial`, or `refused`.
A Workspace Volume must stay outside artifact storage. Read-only provider-native Modal Volume
mounts are on the backlog. See [Worker Host reference](../reference/worker.md#workspace-volumes).

## Select repository Skills and MCP servers

A Context Set can select **Skills**, reusable instruction packages, from the host's Skill
catalog. A Workspace's own `.mcp.json` servers run only when the Tag lists them:

```sh
supertag tag put builder --instructions "Implement bounded changes with tests." \
  --workspace-id app --workspace-base COMMIT --workspace-mcp docs-search --state-directory ~/.supertag
```

The host reads `.mcp.json` from the Task's base commit, not from a Task's changes.

## Run in E2B or Modal sandboxes

A host can keep Cursor Tasks' checkouts in an E2B or Modal sandbox while the harness stays on the
host. A repository's `.devcontainer` settings choose the sandbox's image and setup. See
[Run Cursor in a sandbox](workers.md#run-cursor-in-a-sandbox).

## Where files live

| What | Where |
| --- | --- |
| Your checkout | Untouched. Deliveries arrive only as `supertag/session/...` branches |
| Task checkouts | The Worker Host's state directory, one per Task Attempt |
| Deliveries | Bundles and patches, recorded with the Task and downloadable with `task download` |
| Captured artifacts | The Worker Host that captured them; see [Artifacts](../reference/artifacts.md) |

## Current limits

- A local Workspace's Tag binding pins one base commit; update it to move new Sessions forward.
- The host's own Git commands ignore repository hooks, filters, and configuration, and a Task
  Attempt fails when the repository's Git configuration changes while it runs.
- Workspace Volumes arrive as copies only; a Tag with copies may not run commands or fetch from
  the web.

## Next

- [Run Worker Hosts](workers.md)
- [Worker Host reference](../reference/worker.md#workspaces)
